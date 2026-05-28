"""Train Mortal's GRP (Game Result Predictor) from a cached dataset.

Replaces Mortal's `mortal/train_grp.py`. Differences:

* Reads pre-cached `(feature, rank)` pairs (see `scripts/cache_grp_data.py`).
  Eliminates the dominant Rust-replay bottleneck per epoch.
* Saves both a rolling `.pth` (latest) and a `-best.pth` (lowest val loss
  seen). Safe to stop at any point — the best checkpoint is always on disk.
* Optional `--patience` for early stopping when val loss plateaus.
* Writes the same `{'model': state_dict, ...}` schema Mortal's downstream
  trainer expects.

Usage:
    python scripts/train_grp.py \\
        --cache cache/grp.pt \\
        --val-frac 0.1 \\
        --batch-size 512 \\
        --device cuda \\
        --save checkpoints/grp.pth \\
        --tensorboard runs/grp \\
        --patience 20
"""

from __future__ import annotations

import argparse
import logging
import random
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import torch
from torch import optim
from torch.nn import functional as F
from torch.nn.utils.rnn import pack_padded_sequence, pad_sequence
from torch.utils.tensorboard import SummaryWriter

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "mortal"))

from model import GRP  # noqa: E402


def split_train_val(
    n: int, val_frac: float, seed: int = 0
) -> tuple[np.ndarray, np.ndarray]:
    """Deterministic per-game train/val split (so resumes match)."""
    rng = np.random.default_rng(seed)
    idx = rng.permutation(n)
    n_val = max(1, int(n * val_frac))
    return idx[n_val:], idx[:n_val]


def sample_one(
    features: list[np.ndarray], ranks: np.ndarray, game_idx: int
) -> tuple[torch.Tensor, torch.Tensor]:
    """Pick a random kyoku prefix from game game_idx."""
    feat = features[game_idx]
    k = random.randint(1, feat.shape[0])  # prefix length 1..n_kyoku
    return (
        torch.from_numpy(feat[:k]).to(torch.float64),
        torch.from_numpy(ranks[game_idx]).to(torch.int64),
    )


def make_batch(
    features: list[np.ndarray],
    ranks: np.ndarray,
    indices: list[int],
):
    pairs = [sample_one(features, ranks, i) for i in indices]
    seqs = [p[0] for p in pairs]
    lengths = torch.tensor([len(s) for s in seqs])
    padded = pad_sequence(seqs, batch_first=True)
    packed = pack_padded_sequence(
        padded, lengths, batch_first=True, enforce_sorted=False
    )
    rank_batch = torch.stack([p[1] for p in pairs])
    return packed, rank_batch


def run_val(
    grp: GRP,
    features: list[np.ndarray],
    ranks: np.ndarray,
    val_idx: np.ndarray,
    batch_size: int,
    val_steps: int,
    device: torch.device,
) -> tuple[float, float]:
    grp.eval()
    total_loss = 0.0
    total_acc = 0.0
    n = 0
    with torch.inference_mode():
        for _ in range(val_steps):
            batch_idx = np.random.choice(val_idx, size=batch_size, replace=False)
            packed, rank_b = make_batch(features, ranks, batch_idx.tolist())
            packed = packed.to(device)
            rank_b = rank_b.to(device)
            logits = grp.forward_packed(packed)
            labels = grp.get_label(rank_b)
            total_loss += F.cross_entropy(logits, labels).item()
            total_acc += (logits.argmax(-1) == labels).float().mean().item()
            n += 1
    grp.train()
    return total_loss / max(n, 1), total_acc / max(n, 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", required=True, help="Path from cache_grp_data.py")
    parser.add_argument("--save", required=True, help="Latest checkpoint .pth path")
    parser.add_argument(
        "--best-save",
        default=None,
        help="Best-by-val-loss checkpoint path (default: <save>-best.pth)",
    )
    parser.add_argument("--tensorboard", required=True)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--batch-size", type=int, default=512)
    parser.add_argument("--lr", type=float, default=1e-5)
    parser.add_argument("--val-frac", type=float, default=0.1)
    parser.add_argument("--val-steps", type=int, default=50)
    parser.add_argument("--save-every", type=int, default=500)
    parser.add_argument("--max-steps", type=int, default=0, help="0 = unlimited")
    parser.add_argument(
        "--patience",
        type=int,
        default=0,
        help="Stop if no val_loss improvement after N save cycles (0 = off)",
    )
    parser.add_argument("--hidden-size", type=int, default=64)
    parser.add_argument("--num-layers", type=int, default=2)
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)8s %(message)s"
    )

    save_path = Path(args.save)
    save_path.parent.mkdir(parents=True, exist_ok=True)
    best_path = Path(args.best_save) if args.best_save else save_path.with_name(
        save_path.stem + "-best.pth"
    )

    device = torch.device(args.device)
    logging.info(f"loading cache: {args.cache}")
    payload = torch.load(args.cache, weights_only=False)
    features: list[np.ndarray] = payload["features"]
    ranks: np.ndarray = payload["ranks"]
    n_games = len(features)
    train_idx, val_idx = split_train_val(n_games, args.val_frac)
    logging.info(f"games: {n_games:,}  train: {len(train_idx):,}  val: {len(val_idx):,}")

    grp = GRP(hidden_size=args.hidden_size, num_layers=args.num_layers).to(device)
    optimizer = optim.AdamW(grp.parameters(), lr=args.lr)

    steps = 0
    best_val_loss = float("inf")
    cycles_since_best = 0

    if save_path.exists():
        state = torch.load(save_path, weights_only=False, map_location=device)
        grp.load_state_dict(state["model"])
        optimizer.load_state_dict(state["optimizer"])
        steps = state.get("steps", 0)
        best_val_loss = state.get("best_val_loss", float("inf"))
        cycles_since_best = state.get("cycles_since_best", 0)
        ts = datetime.fromtimestamp(state["timestamp"]).strftime("%Y-%m-%d %H:%M:%S")
        logging.info(f"resumed from {ts} at step {steps}, best_val={best_val_loss:.4f}")

    writer = SummaryWriter(args.tensorboard)
    train_idx_list = train_idx.tolist()

    stats = {"train_loss": 0.0, "train_acc": 0.0}
    t_start = time.perf_counter()

    while True:
        if args.max_steps and steps >= args.max_steps:
            logging.info(f"reached max-steps {args.max_steps}")
            break

        batch_idx = random.sample(train_idx_list, args.batch_size)
        packed, rank_b = make_batch(features, ranks, batch_idx)
        packed = packed.to(device)
        rank_b = rank_b.to(device)

        logits = grp.forward_packed(packed)
        labels = grp.get_label(rank_b)
        loss = F.cross_entropy(logits, labels)

        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()

        with torch.inference_mode():
            stats["train_loss"] += loss.item()
            stats["train_acc"] += (logits.argmax(-1) == labels).float().mean().item()

        steps += 1

        if steps % args.save_every == 0:
            train_loss = stats["train_loss"] / args.save_every
            train_acc = stats["train_acc"] / args.save_every
            val_loss, val_acc = run_val(
                grp, features, ranks, val_idx,
                args.batch_size, args.val_steps, device,
            )

            improved = val_loss < best_val_loss
            if improved:
                best_val_loss = val_loss
                cycles_since_best = 0
            else:
                cycles_since_best += 1

            elapsed = time.perf_counter() - t_start
            rate = args.save_every / elapsed
            t_start = time.perf_counter()

            logging.info(
                f"step {steps:>6}  "
                f"train_loss={train_loss:.4f} val_loss={val_loss:.4f} "
                f"train_acc={train_acc*100:.2f}% val_acc={val_acc*100:.2f}% "
                f"{rate:.0f} step/s  "
                f"best={best_val_loss:.4f}{'  *NEW BEST*' if improved else ''}  "
                f"cycles_since_best={cycles_since_best}"
            )

            writer.add_scalars("loss", {"train": train_loss, "val": val_loss}, steps)
            writer.add_scalars("acc", {"train": train_acc, "val": val_acc}, steps)
            writer.add_scalar("best_val_loss", best_val_loss, steps)
            writer.add_scalar("step_per_sec", rate, steps)
            writer.flush()

            stats = {"train_loss": 0.0, "train_acc": 0.0}

            state = {
                "model": grp.state_dict(),
                "optimizer": optimizer.state_dict(),
                "steps": steps,
                "best_val_loss": best_val_loss,
                "cycles_since_best": cycles_since_best,
                "timestamp": datetime.now().timestamp(),
                "hyperparams": {
                    "hidden_size": args.hidden_size,
                    "num_layers": args.num_layers,
                    "batch_size": args.batch_size,
                    "lr": args.lr,
                },
            }
            torch.save(state, save_path)
            if improved:
                shutil.copy(save_path, best_path)

            if args.patience and cycles_since_best >= args.patience:
                logging.info(
                    f"no val improvement for {args.patience} save cycles → stopping"
                )
                break


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ninterrupted; latest + best checkpoints are on disk")
