"""Pre-cache GRP training samples to disk.

Mortal's `Grp.load_gz_log_files` is a Rust function that parses MJAI logs and
replays each game to produce (feature, rank_by_player) pairs. Calling it once
per epoch is the dominant bottleneck on Pascal-era GPUs — the GPU spends >95%
of time idle waiting for CPU/Rust to feed it data.

This script runs the Rust pipeline once, stores per-game (feature, rank) pairs
as a single torch tensor file, and lets `scripts/train_grp.py` iterate them
without ever touching Rust again.

Per-game size: ~600 bytes (avg 10 kyoku × 7 floats × 8 bytes + 4 bytes rank).
Full Tenhou houou (~3M games): ~1.8 GB. Stays in RAM easily.

Usage:
    python scripts/cache_grp_data.py \\
        --pattern 'data/2009/*.mjson' --pattern 'data/2026/*.mjson' \\
        --out cache/grp.pt
"""

from __future__ import annotations

import argparse
import sys
import time
from glob import glob
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "mortal"))

import libriichi; from libriichi import dataset; Grp = dataset.Grp  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--pattern",
        action="append",
        required=True,
        help="Glob pattern for .mjson files (gzipped). May be repeated.",
    )
    parser.add_argument(
        "--out",
        required=True,
        help="Output .pt path. Parent dir will be created.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=200,
        help="Files passed to Grp.load_gz_log_files at once.",
    )
    args = parser.parse_args()

    files: list[str] = []
    for pat in args.pattern:
        files.extend(sorted(glob(pat)))
    files = sorted(set(files))
    if not files:
        print("No files matched")
        sys.exit(1)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"caching {len(files):,} files → {out_path}")
    games: list[tuple[np.ndarray, np.ndarray]] = []
    t0 = time.perf_counter()

    for start in range(0, len(files), args.chunk_size):
        chunk = files[start : start + args.chunk_size]
        data = Grp.load_gz_log_files(chunk)
        for game in data:
            feat = game.take_feature()
            rank = np.frombuffer(game.take_rank_by_player(), dtype=np.uint8).copy()
            games.append((feat.astype(np.float32), rank))
        if start % (args.chunk_size * 5) == 0:
            dt = time.perf_counter() - t0
            rate = len(games) / max(dt, 0.001)
            print(
                f"  {start + len(chunk):>6,}/{len(files):,} files "
                f"({len(games):,} games, {rate:.0f} games/s, "
                f"elapsed {dt:.1f}s)"
            )

    dt = time.perf_counter() - t0
    print(f"done: {len(games):,} games in {dt:.1f}s")

    payload = {
        "version": 1,
        "n_games": len(games),
        "features": [g[0] for g in games],
        "ranks": np.stack([g[1] for g in games]),
    }
    torch.save(payload, out_path)
    size_mb = out_path.stat().st_size / 1e6
    print(f"saved {size_mb:.1f} MB → {out_path}")


if __name__ == "__main__":
    main()
