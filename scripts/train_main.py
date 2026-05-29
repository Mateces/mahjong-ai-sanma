"""Train Mortal's main model (Brain + DQN + AuxNet) from MJAI logs.

Replaces Mortal's `mortal/train.py`. Differences:

* Skips `test_play` (which requires a baseline weights file we don't have).
  Uses a held-out val set instead, evaluated by the same DQN+CQL+aux loss the
  training step uses.
* Saves both rolling and best (lowest val loss) checkpoints — safe to stop
  any time and use `-best.pth`.
* `--patience N` triggers early stopping after N saves without improvement.
* Schema-compatible with Mortal's `mortal.py` (saved keys: `mortal`,
  `current_dqn`, `aux_net`, `optimizer`, `scheduler`, `scaler`, ...).

Single-GPU usage:
    python scripts/train_main.py \\
        --grp checkpoints/grp-best.pth \\
        --train-glob 'data/200?/*.mjson' --train-glob 'data/201?/*.mjson' \\
        --val-glob 'data/2025/*.mjson' \\
        --save checkpoints/main.pth \\
        --tensorboard runs/main \\
        --device cuda

Multi-GPU (DDP) usage:
    torchrun --standalone --nproc_per_node=2 scripts/train_main.py \\
        --grp checkpoints/grp-best.pth ...

Each rank gets a disjoint shard of the training files (deterministic). Per-step
batch_size stays the same on each rank, so effective global batch = N_GPU * BS.
Checkpoints are saved by rank 0 only; the on-disk format is identical to the
single-GPU script (no DDP "module." prefix), so existing tooling/bot_server.py
loads them unchanged.
"""

from __future__ import annotations

import argparse
import logging
import os
import random
import shutil
import socket
import sys
import time
from datetime import datetime
from glob import glob
from itertools import chain
from pathlib import Path

import numpy as np
import torch
import torch.distributed as dist
from torch import nn, optim
from torch.nn.parallel import DistributedDataParallel as DDP
from torch.utils.data import DataLoader
from torch.utils.tensorboard import SummaryWriter

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "mortal"))

# Pre-stub `config` so Mortal's `dataloader.py`/`config.py` top-level imports
# don't try to read a non-existent config.toml. We rewrite `config.config`
# again inside `build_iter()` once we know the actual GRP path.
import types  # noqa: E402
_stub = types.ModuleType("config")
_stub.config = {"grp": {"state_file": "", "network": {"hidden_size": 64, "num_layers": 2}}}
sys.modules["config"] = _stub

# Mortal modules (must come after sys.path + config stub)
from dataloader import FileDatasetsIter  # noqa: E402
from lr_scheduler import LinearWarmUpCosineAnnealingLR  # noqa: E402
from model import Brain, DQN, AuxNet  # noqa: E402

# Reporter is local to scripts/. Best-effort, swallows all errors.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import reporter  # noqa: E402


# ---------- score-prediction auxiliary head ----------
#
# Forces phi to encode current 4-player scores. Motivation: the policy is
# observed to be insensitive to score state (e.g. attempting reach below 1000
# points). The DQN/aux losses don't directly reward score-awareness because
# (a) GRP-based reward is near-zero when rank is already determined by score
# alone, and (b) extreme-score samples are rare in top-player data, so
# gradients for score channels get drowned out. An auxiliary regression task
# requiring phi to reconstruct scores adds a direct, dense supervisory signal
# on every sample and makes the score channels gradient-relevant.
#
# Output is 3 scalars: predicted scores in [self, +1, +2] order, scaled
# by 1/SCORE_SCALE so the regression target sits roughly in [0, 1].
SCORE_SCALE = 100000.0  # 25000 → 0.25, 1000 → 0.01, 100000 → 1.0


class ScoreHead(nn.Module):
    """Predict current 3-player scores from phi (auxiliary task)."""

    def __init__(self, phi_dim: int = 1024):
        super().__init__()
        # Match Mortal's AuxNet sizing roughly: small MLP, no dropout
        # (training stability over capacity).
        self.fc = nn.Sequential(
            nn.Linear(phi_dim, 256),
            nn.ReLU(inplace=True),
            nn.Linear(256, 3),  # 3 players
        )

    def forward(self, phi: torch.Tensor) -> torch.Tensor:
        return self.fc(phi)


# ---------- rank-prediction auxiliary head ----------
#
# Predicts the rank (0=highest score, 3=lowest) of each of the four players,
# in [self, +1, +2, +3] order. obs (v4) already encodes self.rank as a 4-way
# one-hot, but does NOT encode opponents' ranks — the model must infer those
# from raw score channels via 1D conv, which is unfriendly (CNN doesn't
# naturally do argsort). This head forces phi to internalize the full rank
# tableau, which matters for terminal-game decisions ("am I leading by
# 30k?", "is the 4th-place player still threatening me?").
#
# Output: (B, 4, 4) logits — for each player, distribution over 4 ranks.
# Target: scores reordered to [self,+1,+2,+3]; rank target is computed at
# loss time as scores.argsort(descending).argsort. Cross-entropy.

class RankHead(nn.Module):
    """Predict 3-way rank distribution for each of 3 players."""

    def __init__(self, phi_dim: int = 1024):
        super().__init__()
        self.fc = nn.Sequential(
            nn.Linear(phi_dim, 256),
            nn.ReLU(inplace=True),
            nn.Linear(256, 9),  # 3 players × 3 rank classes
        )

    def forward(self, phi: torch.Tensor) -> torch.Tensor:
        # Returns (B, 4, 4): [batch, player, rank-class].
        return self.fc(phi).reshape(*phi.shape[:-1], 3, 3)


# ---------- gap-prediction auxiliary head ----------
#
# Predicts the score gap (in log scale) between self and the top/bottom
# scorer. Complements RankHead: rank says "I'm 2nd", gap says "I'm 2nd by
# 800 points (close fight)" vs "I'm 2nd by 30000 points (already won)".
# Crucial for terminal-kyoku decisions where the obs's score channel is
# saturated for >30k scores (see obs_repr.rs:159 — clamp(0, 30000) means
# the model can't tell 30k from 80k from raw obs alone).
#
# Output: (B, 2) — [log(1 + abs(self - top)), log(1 + abs(self - bottom))].
# Both are non-negative; "self" sits between top and bottom (or equals one
# of them when self is top/bottom). Huber regression loss.

class GapHead(nn.Module):
    """Predict log-scale score gaps to top and bottom scorers."""

    def __init__(self, phi_dim: int = 1024):
        super().__init__()
        self.fc = nn.Sequential(
            nn.Linear(phi_dim, 128),
            nn.ReLU(inplace=True),
            nn.Linear(128, 2),
        )

    def forward(self, phi: torch.Tensor) -> torch.Tensor:
        return self.fc(phi)


# Shared scale for gap log-targets: 100k is a typical "max possible" gap
# (e.g. dealer mangan vs flown player). log(1 + 100000) ≈ 11.5; we divide
# the log target by this to keep it in [0, 1] roughly.
GAP_LOG_SCALE = 12.0


# ---------- distributed helpers ----------

def _world() -> int:
    return int(os.environ.get("WORLD_SIZE", "1"))


def _rank() -> int:
    return int(os.environ.get("RANK", "0"))


def _local_rank() -> int:
    return int(os.environ.get("LOCAL_RANK", "0"))


def _is_dist() -> bool:
    return _world() > 1


def _setup_dist() -> None:
    if _is_dist() and not dist.is_initialized():
        dist.init_process_group(backend="nccl")
        torch.cuda.set_device(_local_rank())


def _cleanup_dist() -> None:
    if dist.is_initialized():
        dist.destroy_process_group()


def _state_dict_of(m: nn.Module) -> dict:
    """Strip the DDP wrapper when saving so checkpoints match single-GPU format."""
    return m.module.state_dict() if isinstance(m, DDP) else m.state_dict()


def _load_state_into(m: nn.Module, sd: dict) -> None:
    target = m.module if isinstance(m, DDP) else m
    target.load_state_dict(sd)


def _all_reduce_mean(value: float, device: torch.device) -> float:
    if not _is_dist():
        return value
    t = torch.tensor(value, device=device, dtype=torch.float64)
    dist.all_reduce(t, op=dist.ReduceOp.SUM)
    return (t / _world()).item()


# ---------- data / model plumbing ----------

def build_iter(
    file_list: list[str],
    *,
    version: int,
    pts: list[float],
    grp_state_file: str,
    grp_hidden: int,
    grp_layers: int,
    file_batch_size: int,
    reserve_ratio: float,
    player_names: list[str] | None = None,
):
    """Construct FileDatasetsIter. Mutates Mortal's globally imported config dict.

    Mortal's modules do `from config import config` at import time, capturing a
    *reference* to the dict object. Mutating in place propagates; reassigning
    `_cfg_mod.config = {...}` does not. We mutate.
    """
    import config as _cfg_mod  # already stubbed in sys.modules at top of file

    _cfg_mod.config.clear()
    _cfg_mod.config["grp"] = {
        "state_file": grp_state_file,
        "network": {"hidden_size": grp_hidden, "num_layers": grp_layers},
    }
    return FileDatasetsIter(
        version=version,
        file_list=file_list,
        pts=pts,
        oracle=False,
        file_batch_size=file_batch_size,
        reserve_ratio=reserve_ratio,
        # empty list = accept all seats; a non-empty list filters by player name
        # (only train on seats whose name appears in this list).
        player_names=list(player_names or []),
        excludes=None,
        num_epochs=1,
        enable_augmentation=False,
        augmented_first=False,
    )


def compute_loss(
    mortal: nn.Module,
    dqn: nn.Module,
    aux_net: nn.Module,
    score_head: nn.Module,
    rank_head: nn.Module,
    gap_head: nn.Module,
    batch: tuple,
    device: torch.device,
    gamma: float,
    min_q_weight: float,
    next_rank_weight: float,
    score_weight: float,
    rank_weight: float,
    gap_weight: float,
    mse: nn.MSELoss,
    ce: nn.CrossEntropyLoss,
):
    # Backward-compatible unpack: old patched dataloader emits 6 tensors,
    # new patch emits 7 (extra: scores). We require the 7-tensor form when
    # any of the score-derived auxiliary losses is enabled.
    needs_scores = score_weight > 0 or rank_weight > 0 or gap_weight > 0
    if len(batch) == 7:
        obs, actions, masks, steps_to_done, kyoku_rewards, player_ranks, scores = batch
    elif len(batch) == 6:
        obs, actions, masks, steps_to_done, kyoku_rewards, player_ranks = batch
        scores = None
        if needs_scores:
            raise RuntimeError(
                "score/rank/gap weight > 0 but dataloader emits 6 fields. "
                "Run scripts/apply_patches.py to enable Patch 3."
            )
    else:
        raise ValueError(f"unexpected batch arity: {len(batch)}")

    bs = obs.shape[0]
    obs = obs.to(dtype=torch.float32, device=device, non_blocking=True)
    actions = actions.to(dtype=torch.int64, device=device, non_blocking=True)
    masks = masks.to(dtype=torch.bool, device=device, non_blocking=True)
    steps_to_done = steps_to_done.to(dtype=torch.int64, device=device, non_blocking=True)
    kyoku_rewards = kyoku_rewards.to(dtype=torch.float32, device=device, non_blocking=True)
    player_ranks = player_ranks.to(dtype=torch.int64, device=device, non_blocking=True)

    q_target_mc = gamma ** steps_to_done * kyoku_rewards

    phi = mortal(obs)
    q_out = dqn(phi, masks)
    q = q_out[range(bs), actions]
    dqn_loss = 0.5 * mse(q, q_target_mc)
    cql_loss = q_out.logsumexp(-1).mean() - q.mean()
    next_rank_logits, = aux_net(phi)
    aux_loss = ce(next_rank_logits, player_ranks)

    if scores is not None and needs_scores:
        scores = scores.to(dtype=torch.float32, device=device, non_blocking=True)
    else:
        scores = None  # block downstream use

    # Score-prediction loss (regress to scores / SCORE_SCALE)
    if scores is not None and score_weight > 0:
        score_pred = score_head(phi)
        score_target = scores / SCORE_SCALE
        score_loss = mse(score_pred, score_target)
    else:
        score_loss = torch.zeros((), device=device, dtype=torch.float32)

    # Rank-prediction loss: each player's rank (0=highest, 2=lowest).
    # rank_target[b, p] = how many players have a strictly higher score than p
    # (ties broken by player index to give a deterministic target).
    if scores is not None and rank_weight > 0:
        # argsort descending → indices sorted by score; argsort that → ranks.
        # Stable sort (default in torch) means ties resolve by original order.
        rank_target = scores.argsort(dim=-1, descending=True).argsort(dim=-1)
        rank_logits = rank_head(phi)  # (B, 3, 3)
        # CrossEntropy expects (B, C, ...) — so transpose to (B, 3 classes, 3 players)
        rank_loss = ce(rank_logits.transpose(-2, -1), rank_target)
    else:
        rank_loss = torch.zeros((), device=device, dtype=torch.float32)

    # Gap-prediction loss: signed log-distance to top and bottom scorers.
    # We use abs(diff) so it's always non-negative and the loss is symmetric.
    if scores is not None and gap_weight > 0:
        self_score = scores[:, 0]
        top_score = scores.max(dim=-1).values
        bot_score = scores.min(dim=-1).values
        gap_target = torch.stack([
            torch.log1p((top_score - self_score).abs()) / GAP_LOG_SCALE,
            torch.log1p((self_score - bot_score).abs()) / GAP_LOG_SCALE,
        ], dim=-1)  # (B, 2)
        gap_pred = gap_head(phi)
        gap_loss = mse(gap_pred, gap_target)
    else:
        gap_loss = torch.zeros((), device=device, dtype=torch.float32)

    loss = (
        dqn_loss
        + cql_loss * min_q_weight
        + aux_loss * next_rank_weight
        + score_loss * score_weight
        + rank_loss * rank_weight
        + gap_loss * gap_weight
    )
    return (
        loss,
        dqn_loss.detach(),
        cql_loss.detach(),
        aux_loss.detach(),
        score_loss.detach(),
        rank_loss.detach(),
        gap_loss.detach(),
    )


# ---------- main ----------

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--grp", required=True, help="Pre-trained GRP .pth (use -best)")
    parser.add_argument("--train-glob", action="append", required=True)
    parser.add_argument("--val-glob", action="append", required=True)
    parser.add_argument("--save", required=True)
    parser.add_argument("--best-save", default=None)
    parser.add_argument("--tensorboard", required=True)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--version", type=int, default=5)  # sanma obs/action layout
    parser.add_argument("--conv-channels", type=int, default=192)
    parser.add_argument("--num-blocks", type=int, default=40)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr-peak", type=float, default=1e-4)
    parser.add_argument("--lr-final", type=float, default=1e-5)
    parser.add_argument("--warmup-steps", type=int, default=200)
    parser.add_argument("--max-steps", type=int, default=200000)
    parser.add_argument("--weight-decay", type=float, default=0.1)
    parser.add_argument("--max-grad-norm", type=float, default=0.0)
    parser.add_argument("--gamma", type=float, default=1.0)
    parser.add_argument("--min-q-weight", type=float, default=5.0)
    parser.add_argument("--next-rank-weight", type=float, default=0.2)
    parser.add_argument(
        "--score-weight",
        type=float,
        default=1.0,
        help="weight on score-prediction auxiliary loss (set 0 to disable; "
        "requires Patch 3 in apply_patches.py for dataloader to emit scores)",
    )
    parser.add_argument(
        "--rank-weight",
        type=float,
        default=0.5,
        help="weight on rank-prediction auxiliary loss (predicts each "
        "player's rank from phi; requires the same scores patch)",
    )
    parser.add_argument(
        "--gap-weight",
        type=float,
        default=0.3,
        help="weight on gap-prediction auxiliary loss (predicts log-scale "
        "distance from self to top and bottom scorers)",
    )
    parser.add_argument("--pts", default="3,0,-3", help="ranking points (sanma: 3 values; yonma: 4 values). Default 3,0,-3 matches yonma's [6,4,2,0] in dynamic range so dqn loss stays in the same order of magnitude.")
    parser.add_argument("--save-every", type=int, default=200)
    parser.add_argument("--val-steps", type=int, default=50)
    parser.add_argument("--patience", type=int, default=20)
    parser.add_argument("--file-batch-size", type=int, default=15)
    parser.add_argument("--reserve-ratio", type=float, default=0.0)
    parser.add_argument("--grp-hidden", type=int, default=64)
    parser.add_argument("--grp-layers", type=int, default=2)
    parser.add_argument(
        "--player-names-file",
        action="append",
        default=[],
        help="path to a file with one player name per line; only train on "
        "seats whose names match. Multiple files are unioned. Empty = all seats.",
    )
    args = parser.parse_args()

    _setup_dist()
    rank = _rank()
    local_rank = _local_rank()
    world = _world()
    is_rank0 = (rank == 0)

    logging.basicConfig(
        level=logging.INFO if is_rank0 else logging.WARNING,
        format=f"%(asctime)s %(levelname)8s [r{rank}] %(message)s",
    )

    pts = [float(x) for x in args.pts.split(",")]
    if len(pts) not in (3, 4):
        raise ValueError(f"--pts needs 3 (sanma) or 4 (yonma) values, got {pts}")

    save_path = Path(args.save)
    if is_rank0:
        save_path.parent.mkdir(parents=True, exist_ok=True)
    best_path = Path(args.best_save) if args.best_save else save_path.with_name(
        save_path.stem + "-best.pth"
    )

    # cuda:LOCAL_RANK under DDP, otherwise honor --device
    if _is_dist():
        device = torch.device(f"cuda:{local_rank}")
    else:
        device = torch.device(args.device)
    if is_rank0:
        logging.info(f"device={device} world={world}")

    # ----- build models (unwrapped — for param-group construction) -----
    mortal_raw = Brain(
        version=args.version,
        conv_channels=args.conv_channels,
        num_blocks=args.num_blocks,
    ).to(device)
    dqn_raw = DQN(version=args.version).to(device)
    aux_net_raw = AuxNet((3,)).to(device)
    # Score-prediction auxiliary head. phi_dim must match Brain's output.
    # Mortal's Brain emits phi of size 1024 by convention; we read it from a
    # zero-pass to stay robust to architecture tweaks.
    with torch.no_grad():
        from libriichi import consts as _consts
        _obs_channels = _consts.obs_shape(args.version)[0]
        _dummy_obs = torch.zeros(1, _obs_channels, 34, device=device)
        _phi_dim = mortal_raw(_dummy_obs).shape[-1]
    score_head_raw = ScoreHead(phi_dim=_phi_dim).to(device)
    rank_head_raw = RankHead(phi_dim=_phi_dim).to(device)
    gap_head_raw = GapHead(phi_dim=_phi_dim).to(device)
    raw_models = (
        mortal_raw, dqn_raw, aux_net_raw,
        score_head_raw, rank_head_raw, gap_head_raw,
    )

    n_params = sum(sum(p.numel() for p in m.parameters()) for m in raw_models)
    if is_rank0:
        logging.info(f"total params: {n_params:,}")
        reporter.event(
            "train.start",
            status="running",
            severity="info",
            message=f"sanma train start (world={world}, params={n_params:,}, max_steps={args.max_steps})",
            data={
                "world": world,
                "device": str(device),
                "version": args.version,
                "n_params": n_params,
                "batch_size": args.batch_size,
                "max_steps": args.max_steps,
                "warmup_steps": args.warmup_steps,
                "save_every": args.save_every,
                "val_steps": args.val_steps,
                "lr_peak": args.lr_peak,
                "lr_final": args.lr_final,
                "num_blocks": args.num_blocks,
                "conv_channels": args.conv_channels,
                "weight_decay": args.weight_decay,
                "min_q_weight": args.min_q_weight,
                "score_weight": args.score_weight,
                "rank_weight": args.rank_weight,
                "gap_weight": args.gap_weight,
                "save_path": str(save_path),
                "best_path": str(best_path),
                "train_globs": args.train_glob,
                "val_globs": args.val_glob,
                "host": socket.gethostname(),
                "pid": os.getpid(),
            },
            timeout_ms=24 * 60 * 60 * 1000,
        )

    # AdamW with decay only on conv/linear weights (mirrors Mortal). Build the
    # param groups from the unwrapped models — Optimizer holds Parameter refs
    # which DDP shares with its wrapped module, so this stays correct after wrap.
    decay_params, no_decay_params = [], []
    for model in raw_models:
        seen = set()
        for mod_name, mod in model.named_modules():
            for name, p in mod.named_parameters(prefix=mod_name, recurse=False):
                if name in seen:
                    continue
                seen.add(name)
                if isinstance(mod, (nn.Linear, nn.Conv1d)) and name.endswith("weight"):
                    decay_params.append(p)
                else:
                    no_decay_params.append(p)
    optimizer = optim.AdamW(
        [
            {"params": decay_params, "weight_decay": args.weight_decay},
            {"params": no_decay_params, "weight_decay": 0.0},
        ],
        lr=1.0,
    )
    scheduler = LinearWarmUpCosineAnnealingLR(
        optimizer,
        peak=args.lr_peak,
        final=args.lr_final,
        warm_up_steps=args.warmup_steps,
        max_steps=args.max_steps,
    )

    # Wrap in DDP after param-group setup. Single-GPU runs use the raw model
    # so behavior matches the pre-DDP script exactly.
    if _is_dist():
        mortal = DDP(mortal_raw, device_ids=[local_rank])
        dqn = DDP(dqn_raw, device_ids=[local_rank])
        aux_net = DDP(aux_net_raw, device_ids=[local_rank])
        score_head = DDP(score_head_raw, device_ids=[local_rank])
        rank_head = DDP(rank_head_raw, device_ids=[local_rank])
        gap_head = DDP(gap_head_raw, device_ids=[local_rank])
    else:
        mortal, dqn, aux_net = mortal_raw, dqn_raw, aux_net_raw
        score_head, rank_head, gap_head = (
            score_head_raw, rank_head_raw, gap_head_raw,
        )
    all_models = (mortal, dqn, aux_net, score_head, rank_head, gap_head)

    # ----- resume -----
    steps = 0
    best_val_loss = float("inf")
    cycles_since_best = 0

    if save_path.exists():
        state = torch.load(save_path, weights_only=False, map_location=device)
        _load_state_into(mortal, state["mortal"])
        _load_state_into(dqn, state["current_dqn"])
        _load_state_into(aux_net, state["aux_net"])
        # score_head is new — older checkpoints don't have it. Don't fail; just
        # leave the score head at its random init so it learns from scratch
        # while the rest of the network resumes.
        if "score_head" in state:
            _load_state_into(score_head, state["score_head"])
        elif is_rank0:
            logging.info("checkpoint has no score_head; using fresh init")
        # rank_head and gap_head: same story, accept missing for older
        # checkpoints (or when fine-tuning from a score-only run).
        if "rank_head" in state:
            _load_state_into(rank_head, state["rank_head"])
        elif is_rank0:
            logging.info("checkpoint has no rank_head; using fresh init")
        if "gap_head" in state:
            _load_state_into(gap_head, state["gap_head"])
        elif is_rank0:
            logging.info("checkpoint has no gap_head; using fresh init")
        # Optional fields: optimizer/scheduler may be absent when starting a
        # fresh training run from a model exported as weights-only (e.g. for
        # curriculum fine-tune from an SL checkpoint with steps reset).
        if "optimizer" in state and "scheduler" in state:
            try:
                optimizer.load_state_dict(state["optimizer"])
                scheduler.load_state_dict(state["scheduler"])
            except (ValueError, RuntimeError) as e:
                if is_rank0:
                    logging.warning(f"optimizer/scheduler state not loaded: {e}")
        elif is_rank0:
            logging.info("no optimizer/scheduler in checkpoint, using fresh state")
        steps = state.get("steps", 0)
        best_val_loss = state.get("best_val_loss", float("inf"))
        cycles_since_best = state.get("cycles_since_best", 0)
        if is_rank0:
            ts_val = state.get("timestamp")
            ts = (datetime.fromtimestamp(ts_val).strftime("%Y-%m-%d %H:%M:%S")
                  if ts_val else "<no timestamp>")
            logging.info(f"resumed from {ts} at step {steps}, best_val={best_val_loss:.4f}")

    writer = SummaryWriter(args.tensorboard) if is_rank0 else None
    mse = nn.MSELoss()
    ce = nn.CrossEntropyLoss()

    # Read player names from --player-names-file files (union all entries).
    player_names_set: set[str] = set()
    for fpath in args.player_names_file:
        with open(fpath, encoding="utf-8") as f:
            for line in f:
                name = line.strip()
                if name and not name.startswith("#"):
                    player_names_set.add(name)
    if is_rank0 and player_names_set:
        logging.info(f"loaded {len(player_names_set):,} player names from "
                     f"{len(args.player_names_file)} file(s)")

    iter_kwargs = dict(
        version=args.version,
        pts=pts,
        grp_state_file=args.grp,
        grp_hidden=args.grp_hidden,
        grp_layers=args.grp_layers,
        file_batch_size=args.file_batch_size,
        reserve_ratio=args.reserve_ratio,
        player_names=sorted(player_names_set),
    )

    def shard_files(files: list[str]) -> list[str]:
        """Stride-slice the file list per rank. All ranks see the same shuffle
        (seeded), then take their slice — guarantees disjoint shards with no
        coordination at runtime."""
        if not _is_dist():
            random.shuffle(files)
            return files
        rng = random.Random(0xDEADBEEF + steps)  # vary seed per re-epoch via outer `steps`
        rng.shuffle(files)
        return files[rank::world]

    def make_train_loader():
        files = []
        for p in args.train_glob:
            files.extend(glob(p, recursive=True))
        files = sorted(set(files))
        if not files:
            raise ValueError(f"no train files: {args.train_glob}")
        files = shard_files(files)
        if is_rank0:
            logging.info(f"train files (per rank): {len(files):,}")
        ds = build_iter(files, **iter_kwargs)
        return DataLoader(
            dataset=ds, batch_size=args.batch_size, drop_last=True,
            num_workers=0, pin_memory=True,
        )

    def make_val_loader():
        files = []
        for p in args.val_glob:
            files.extend(glob(p, recursive=True))
        files = sorted(set(files))
        if not files:
            raise ValueError(f"no val files: {args.val_glob}")
        files = shard_files(files)
        if is_rank0:
            logging.info(f"val files (per rank): {len(files):,}")
        ds = build_iter(files, **iter_kwargs)
        return DataLoader(
            dataset=ds, batch_size=args.batch_size, drop_last=True,
            num_workers=0, pin_memory=True,
        )

    train_loader = iter(make_train_loader())
    val_loader_iter = iter(make_val_loader())

    def next_train_batch():
        nonlocal train_loader
        try:
            return next(train_loader)
        except StopIteration:
            if is_rank0:
                logging.info("train epoch finished, restarting")
            train_loader = iter(make_train_loader())
            return next(train_loader)

    def next_val_batch():
        nonlocal val_loader_iter
        try:
            return next(val_loader_iter)
        except StopIteration:
            val_loader_iter = iter(make_val_loader())
            return next(val_loader_iter)

    def run_val():
        for m in all_models:
            m.eval()
        total = {"loss": 0.0, "dqn": 0.0, "cql": 0.0, "aux": 0.0,
                 "score": 0.0, "rank": 0.0, "gap": 0.0}
        n = 0
        with torch.inference_mode():
            for _ in range(args.val_steps):
                batch = next_val_batch()
                loss, dqn_l, cql_l, aux_l, score_l, rank_l, gap_l = compute_loss(
                    mortal, dqn, aux_net, score_head, rank_head, gap_head,
                    batch, device,
                    args.gamma, args.min_q_weight, args.next_rank_weight,
                    args.score_weight, args.rank_weight, args.gap_weight,
                    mse, ce,
                )
                total["loss"] += loss.item()
                total["dqn"] += dqn_l.item()
                total["cql"] += cql_l.item()
                total["aux"] += aux_l.item()
                total["score"] += score_l.item()
                total["rank"] += rank_l.item()
                total["gap"] += gap_l.item()
                n += 1
        for m in all_models:
            m.train()
        # Average per-rank, then average across ranks.
        return {k: _all_reduce_mean(v / max(n, 1), device) for k, v in total.items()}

    # ----- training loop -----
    stats = {"loss": 0.0, "dqn": 0.0, "cql": 0.0, "aux": 0.0,
             "score": 0.0, "rank": 0.0, "gap": 0.0}
    optimizer.zero_grad(set_to_none=True)
    t_start = time.perf_counter()

    while steps < args.max_steps:
        batch = next_train_batch()
        loss, dqn_l, cql_l, aux_l, score_l, rank_l, gap_l = compute_loss(
            mortal, dqn, aux_net, score_head, rank_head, gap_head,
            batch, device,
            args.gamma, args.min_q_weight, args.next_rank_weight,
            args.score_weight, args.rank_weight, args.gap_weight,
            mse, ce,
        )
        loss.backward()  # DDP auto-syncs gradients via allreduce

        if args.max_grad_norm > 0:
            params = chain.from_iterable(g["params"] for g in optimizer.param_groups)
            torch.nn.utils.clip_grad_norm_(params, args.max_grad_norm)

        optimizer.step()
        optimizer.zero_grad(set_to_none=True)
        scheduler.step()

        with torch.inference_mode():
            stats["loss"] += loss.item()
            stats["dqn"] += dqn_l.item()
            stats["cql"] += cql_l.item()
            stats["aux"] += aux_l.item()
            stats["score"] += score_l.item()
            stats["rank"] += rank_l.item()
            stats["gap"] += gap_l.item()

        steps += 1

        if steps % args.save_every == 0:
            train_avg = {
                k: _all_reduce_mean(v / args.save_every, device)
                for k, v in stats.items()
            }
            val_avg = run_val()
            improved = val_avg["loss"] < best_val_loss
            if improved:
                best_val_loss = val_avg["loss"]
                cycles_since_best = 0
            else:
                cycles_since_best += 1

            elapsed = time.perf_counter() - t_start
            rate = args.save_every / elapsed
            t_start = time.perf_counter()

            if is_rank0:
                logging.info(
                    f"step {steps:>6}  "
                    f"train_loss={train_avg['loss']:.4f} val_loss={val_avg['loss']:.4f} "
                    f"dqn={val_avg['dqn']:.4f} cql={val_avg['cql']:.4f} aux={val_avg['aux']:.4f} "
                    f"score={val_avg['score']:.4f} rank={val_avg['rank']:.4f} "
                    f"gap={val_avg['gap']:.4f}  "
                    f"{rate:.1f} step/s  "
                    f"best={best_val_loss:.4f}{'  *NEW BEST*' if improved else ''}  "
                    f"cycles_since_best={cycles_since_best}"
                )
                writer.add_scalars("loss", {"train": train_avg["loss"], "val": val_avg["loss"]}, steps)
                writer.add_scalars("dqn", {"train": train_avg["dqn"], "val": val_avg["dqn"]}, steps)
                writer.add_scalars("cql", {"train": train_avg["cql"], "val": val_avg["cql"]}, steps)
                writer.add_scalars("aux", {"train": train_avg["aux"], "val": val_avg["aux"]}, steps)
                writer.add_scalars("score", {"train": train_avg["score"], "val": val_avg["score"]}, steps)
                writer.add_scalars("rank", {"train": train_avg["rank"], "val": val_avg["rank"]}, steps)
                writer.add_scalars("gap", {"train": train_avg["gap"], "val": val_avg["gap"]}, steps)
                writer.add_scalar("best_val_loss", best_val_loss, steps)
                writer.add_scalar("lr", scheduler.get_last_lr()[0], steps)
                writer.add_scalar("step_per_sec", rate, steps)
                writer.flush()

                report_data = {
                    "step": steps,
                    "max_steps": args.max_steps,
                    "progress": steps / max(args.max_steps, 1),
                    "train_loss": float(train_avg["loss"]),
                    "val_loss": float(val_avg["loss"]),
                    "dqn": float(val_avg["dqn"]),
                    "cql": float(val_avg["cql"]),
                    "aux": float(val_avg["aux"]),
                    "score": float(val_avg["score"]),
                    "rank": float(val_avg["rank"]),
                    "gap": float(val_avg["gap"]),
                    "best_val_loss": float(best_val_loss),
                    "improved": bool(improved),
                    "cycles_since_best": cycles_since_best,
                    "lr": float(scheduler.get_last_lr()[0]),
                    "step_per_sec": float(rate),
                    "world": world,
                }
                reporter.event(
                    "train.step",
                    status="running",
                    severity="info",
                    message=(
                        f"step {steps}/{args.max_steps} "
                        f"train={train_avg['loss']:.4f} val={val_avg['loss']:.4f} "
                        f"best={best_val_loss:.4f} {rate:.1f} step/s"
                        + ("  *NEW BEST*" if improved else "")
                    ),
                    data=report_data,
                    skip_notify=True,
                    timeout_ms=24 * 60 * 60 * 1000,
                )
                if improved:
                    reporter.event(
                        "train.best",
                        status="success",
                        severity="info",
                        message=f"new best val_loss={best_val_loss:.4f} @ step {steps}",
                        data=report_data,
                    )

            stats = {k: 0.0 for k in stats}

            if is_rank0:
                state = {
                    "mortal": _state_dict_of(mortal),
                    "current_dqn": _state_dict_of(dqn),
                    "aux_net": _state_dict_of(aux_net),
                    "score_head": _state_dict_of(score_head),
                    "rank_head": _state_dict_of(rank_head),
                    "gap_head": _state_dict_of(gap_head),
                    "optimizer": optimizer.state_dict(),
                    "scheduler": scheduler.state_dict(),
                    "scaler": {},  # unused; AMP disabled
                    "steps": steps,
                    "best_val_loss": best_val_loss,
                    "cycles_since_best": cycles_since_best,
                    "timestamp": datetime.now().timestamp(),
                    "hyperparams": vars(args),
                }
                torch.save(state, save_path)
                if improved:
                    shutil.copy(save_path, best_path)

            # All ranks share the same val_avg so they reach the same decision,
            # but broadcast anyway to make the contract explicit.
            should_stop = bool(args.patience and cycles_since_best >= args.patience)
            if _is_dist():
                flag = torch.tensor(1 if should_stop else 0, device=device, dtype=torch.int32)
                dist.broadcast(flag, src=0)
                should_stop = (flag.item() == 1)
            if should_stop:
                if is_rank0:
                    logging.info(f"no val improvement for {args.patience} saves → stopping")
                    reporter.event(
                        "train.end",
                        status="success",
                        severity="info",
                        message=f"early stop (patience): step {steps}, best_val={best_val_loss:.4f}",
                        data={
                            "reason": "patience",
                            "step": steps,
                            "max_steps": args.max_steps,
                            "best_val_loss": float(best_val_loss),
                            "cycles_since_best": cycles_since_best,
                        },
                    )
                break

    _cleanup_dist()
    if is_rank0 and steps >= args.max_steps:
        reporter.event(
            "train.end",
            status="success",
            severity="info",
            message=f"max_steps reached: step {steps}, best_val={best_val_loss:.4f}",
            data={
                "reason": "max_steps",
                "step": steps,
                "max_steps": args.max_steps,
                "best_val_loss": float(best_val_loss),
                "cycles_since_best": cycles_since_best,
            },
        )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ninterrupted; latest + best checkpoints are on disk")
        if _rank() == 0:
            reporter.event(
                "train.end",
                status="warning",
                severity="warning",
                message="interrupted by user (KeyboardInterrupt)",
                data={"reason": "interrupt"},
            )
        _cleanup_dist()
    except Exception as e:
        if _rank() == 0:
            import traceback
            tb = traceback.format_exc()
            reporter.event(
                "train.error",
                status="failed",
                severity="error",
                message=f"{type(e).__name__}: {e}",
                data={"traceback": tb[-2000:]},
            )
        _cleanup_dist()
        raise
