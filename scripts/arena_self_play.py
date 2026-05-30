"""Run sanma model-vs-model arena via libriichi.arena.OneVsTwo.

Sanma analog of mahjong-trainer/scripts/arena_self_play.py.

The sanma OneVsTwo PyClass produces 3 hanchans per seed (challenger rotates
through seats 0/1/2). Returns rankings as `[wins_1st, wins_2nd, wins_3rd]`.

Usage:
    python scripts/arena_self_play.py \
        --challenger checkpoints/sanma-main-best.pth \
        --champion   checkpoints/sanma-main-best.pth \
        --seed-base  10000 \
        --seeds      5 \
        --log-dir    arena_runs/smoke

If `--challenger` and `--champion` point at the same file, this becomes a
sanity-check self-play (you'd expect the rankings to be roughly uniform).
"""

from __future__ import annotations

import argparse
import secrets
import sys
import types
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parent.parent

# Sanma flat layout: `mortal/` IS the package (has engine.py, model.py at top).
# Yonma layout has `mortal/mortal/`. Support both like mortal_bot_server.py does.
_yonma_path = ROOT / "mortal" / "mortal"
sys.path.insert(0, str(_yonma_path if _yonma_path.is_dir() else ROOT / "mortal"))

# `model.py` does `from config import config` at import time on yonma; sanma
# tree may also touch it. Pre-stub to avoid forcing a config.toml on disk.
_stub = types.ModuleType("config")
_stub.config = {}
sys.modules["config"] = _stub

from engine import MortalEngine  # noqa: E402
from libriichi.arena import OneVsTwo  # noqa: E402
from model import Brain, DQN  # noqa: E402


def _checkpoint_meta(state: dict) -> tuple[int, int, int]:
    """Return (version, conv_channels, num_blocks) regardless of yonma vs sanma format.

    yonma stores under state["config"]["control"|"resnet"]; sanma's training
    script (scripts/train_main.py) stores a flat dict under state["hyperparams"].
    """
    if "config" in state:
        cfg = state["config"]
        return (
            int(cfg["control"].get("version", 1)),
            int(cfg["resnet"]["conv_channels"]),
            int(cfg["resnet"]["num_blocks"]),
        )
    if "hyperparams" in state:
        hp = state["hyperparams"]
        return (
            int(hp.get("version", 1)),
            int(hp["conv_channels"]),
            int(hp["num_blocks"]),
        )
    raise KeyError(
        "checkpoint has neither 'config' nor 'hyperparams' — cannot infer "
        "model shape (keys: " + ", ".join(repr(k) for k in state) + ")"
    )


def build_engine(state_path: Path, name: str, device: torch.device) -> MortalEngine:
    state = torch.load(state_path, map_location="cpu", weights_only=False)
    version, conv_channels, num_blocks = _checkpoint_meta(state)
    brain = Brain(
        version=version,
        conv_channels=conv_channels,
        num_blocks=num_blocks,
    ).eval()
    dqn = DQN(version=version).eval()
    brain.load_state_dict(state["mortal"])
    dqn.load_state_dict(state["current_dqn"])
    return MortalEngine(
        brain,
        dqn,
        is_oracle=False,
        version=version,
        device=device,
        enable_amp=False,
        enable_quick_eval=False,
        enable_rule_based_agari_guard=False,
        name=name,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--challenger", type=Path, required=True,
                        help="Path to challenger checkpoint .pth")
    parser.add_argument("--champion", type=Path, required=True,
                        help="Path to champion checkpoint .pth")
    parser.add_argument("--challenger-name", default="challenger")
    parser.add_argument("--champion-name", default="champion")
    parser.add_argument("--challenger-device", default="cpu")
    parser.add_argument("--champion-device", default="cpu")
    parser.add_argument("--seed-base", type=int, default=10000,
                        help="Starting seed (first axis of (seed, key) pair)")
    parser.add_argument("--seed-key", type=int, default=-1,
                        help="(seed, key) tuple's key. -1 = random.")
    parser.add_argument("--seeds", type=int, default=4,
                        help="Number of seeds; total hanchans = seeds * 3.")
    parser.add_argument("--log-dir", type=Path, default=None,
                        help="If set, OneVsTwo writes per-game .json.gz logs here.")
    parser.add_argument("--disable-progress-bar", action="store_true")
    args = parser.parse_args()

    if args.seed_key < 0:
        key = secrets.randbits(64)
    else:
        key = args.seed_key

    chal_engine = build_engine(args.challenger, args.challenger_name,
                               torch.device(args.challenger_device))
    cham_engine = build_engine(args.champion, args.champion_name,
                               torch.device(args.champion_device))

    print(f"challenger: {args.challenger} (v{chal_engine.version}, {chal_engine.device})")
    print(f"champion:   {args.champion} (v{cham_engine.version}, {cham_engine.device})")
    print(f"seeds: [{args.seed_base}, {args.seed_base + args.seeds}) "
          f"key=0x{key:016x}, hanchans={args.seeds * 3}")

    log_dir = str(args.log_dir.resolve()) if args.log_dir is not None else None
    env = OneVsTwo(
        disable_progress_bar=args.disable_progress_bar,
        log_dir=log_dir,
    )
    rankings = env.py_vs_py(
        challenger=chal_engine,
        champion=cham_engine,
        seed_start=(args.seed_base, key),
        seed_count=args.seeds,
    )
    rankings = np.asarray(rankings)
    total = int(rankings.sum())
    if total == 0:
        print("no games completed", file=sys.stderr)
        sys.exit(1)
    avg_rank = float(rankings @ np.arange(1, 4)) / total
    # Sanma 1/2/3 ranking points (Tenhou-style approximation; tweak later if
    # we have a fixed point table for the rule we want).
    pt_table = np.array([60, 0, -60])
    avg_pt = float(rankings @ pt_table) / total

    print("=" * 56)
    print(f"challenger rankings: {rankings.tolist()} "
          f"(avg_rank={avg_rank:.4f}, avg_pt={avg_pt:.2f})")
    if log_dir is not None:
        print(f"per-game logs: {log_dir}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
