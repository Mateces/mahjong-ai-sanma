"""Multi-worker sanma model-vs-model battle with RPC reporting.

Splits a total seed range across N workers (one process each). Each worker
runs OneVsTwo for its slice and reports per-hanchan results to the report
center in batches.

Each seed yields 3 hanchans (challenger rotates seats 0/1/2 — uniform
rotation, statistically equivalent to random seat assignment).

Usage:
    python scripts/arena_battle.py \\
        --challenger checkpoints/sanma-main.pth \\
        --champion   checkpoints/sanma-main-best.pth \\
        --challenger-name main \\
        --champion-name  best \\
        --run-id 3k-main-vs-best-2026-05-30 \\
        --total-seeds 1000 \\
        --worker-id 0 --workers 6 \\
        --seed-base 100000 --seed-key 0xC0FFEE \\
        --rpc-url https://rpc.moki.cat \\
        --rpc-token "$RPC_TOKEN" \\
        --batch-size 50 \\
        --log-dir arena_runs/3k-main-vs-best/w0
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import types
import urllib.error
import urllib.request
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parent.parent
_yonma_path = ROOT / "mortal" / "mortal"
sys.path.insert(0, str(_yonma_path if _yonma_path.is_dir() else ROOT / "mortal"))

_stub = types.ModuleType("config")
_stub.config = {}
sys.modules["config"] = _stub

from engine import MortalEngine  # noqa: E402
from libriichi.arena import OneVsTwo  # noqa: E402
from model import Brain, DQN  # noqa: E402

USER_AGENT = "sanma-arena-battle/0.1"


def _checkpoint_meta(state: dict) -> tuple[int, int, int]:
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
    raise KeyError("checkpoint missing both 'config' and 'hyperparams'")


def build_engine(state_path: Path, name: str, device: torch.device) -> MortalEngine:
    state = torch.load(state_path, map_location="cpu", weights_only=False)
    version, conv_channels, num_blocks = _checkpoint_meta(state)
    brain = Brain(version=version, conv_channels=conv_channels, num_blocks=num_blocks).eval()
    dqn = DQN(version=version).eval()
    brain.load_state_dict(state["mortal"])
    dqn.load_state_dict(state["current_dqn"])
    return MortalEngine(
        brain, dqn,
        is_oracle=False,
        version=version,
        device=device,
        enable_amp=False,
        enable_quick_eval=False,
        enable_rule_based_agari_guard=False,
        name=name,
    )


def split_seed_range(total: int, workers: int, worker_id: int) -> tuple[int, int]:
    base = total // workers
    extra = total % workers
    start = worker_id * base + min(worker_id, extra)
    count = base + (1 if worker_id < extra else 0)
    return start, count


def rpc_post(url: str, token: str, path: str, payload, timeout: float = 30.0):
    full = url.rstrip("/") + path
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        full, data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def rpc_send_with_retry(url, token, path, payload, *, attempts=5, base_delay=2.0):
    last_err = None
    for i in range(attempts):
        try:
            return rpc_post(url, token, path, payload)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            last_err = e
            wait = base_delay * (2 ** i)
            print(f"[rpc] attempt {i + 1}/{attempts} failed: {e}; sleep {wait:.1f}s",
                  file=sys.stderr, flush=True)
            time.sleep(wait)
    raise RuntimeError(f"rpc_post failed after {attempts} attempts: {last_err}")


def make_event(source: str, record: tuple, run_id: str, worker_id: int,
               challenger_name: str, champion_name: str) -> dict:
    seed, key, split_idx, names, scores, ranks, challenger_seat = record
    # PyO3 serializes `[u8; 3]` as bytes; index/iterate gives ints either way.
    challenger_score = int(scores[challenger_seat])
    challenger_rank = int(ranks[challenger_seat]) + 1  # 1-indexed for humans
    return {
        "source": source,
        "type": "arena.hanchan",
        "status": "success",
        "severity": "info",
        "message": f"seed={seed} split={split_idx} chal_seat={challenger_seat} "
                   f"score={challenger_score} rank={challenger_rank}",
        "data": {
            "run_id": run_id,
            "worker_id": worker_id,
            "seed": int(seed),
            "key": int(key),
            "split": int(split_idx),
            "challenger_seat": int(challenger_seat),
            "names": list(names),
            "scores": [int(s) for s in scores],
            "ranks": [int(r) + 1 for r in ranks],
            "challenger_name": challenger_name,
            "champion_name": champion_name,
        },
        "timeout_ms": 600000,
        "skip_notify": True,
    }


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    p.add_argument("--challenger", type=Path, required=True)
    p.add_argument("--champion", type=Path, required=True)
    p.add_argument("--challenger-name", default="challenger")
    p.add_argument("--champion-name", default="champion")
    p.add_argument("--challenger-device", default="cpu")
    p.add_argument("--champion-device", default="cpu")
    p.add_argument("--run-id", required=True,
                   help="Logical run identifier (becomes part of source name).")
    p.add_argument("--total-seeds", type=int, required=True,
                   help="Total seeds across all workers; total hanchans = total_seeds*3.")
    p.add_argument("--workers", type=int, required=True)
    p.add_argument("--worker-id", type=int, required=True)
    p.add_argument("--seed-base", type=int, default=100000)
    p.add_argument("--seed-key", type=lambda s: int(s, 0), default=0,
                   help="(seed, key)'s key — accepts 0xHEX too.")
    p.add_argument("--rpc-url", default="https://rpc.moki.cat")
    p.add_argument("--rpc-token", required=True,
                   help="RPC bearer token (or pass via env RPC_TOKEN).")
    p.add_argument("--source-suffix", default="",
                   help="Append to source name (e.g. '-test' for testing).")
    p.add_argument("--batch-size", type=int, default=50,
                   help="Events per /api/events/batch POST (max 100).")
    p.add_argument("--disable-progress-bar", action="store_true")
    p.add_argument("--log-dir", type=Path, default=None,
                   help="Optional per-game mjai log directory for this worker.")
    p.add_argument("--no-rpc", action="store_true",
                   help="Skip RPC; print payloads to stdout (debug).")
    args = p.parse_args()

    if args.workers <= 0 or not (0 <= args.worker_id < args.workers):
        sys.exit(f"bad worker config: id={args.worker_id} workers={args.workers}")
    if not 1 <= args.batch_size <= 100:
        sys.exit("--batch-size must be in [1, 100]")

    seed_offset, seed_count = split_seed_range(args.total_seeds, args.workers, args.worker_id)
    seed_start = args.seed_base + seed_offset
    if seed_count == 0:
        print(f"worker {args.worker_id}: no seeds assigned, exiting")
        return

    source = f"sanma-arena-{args.run_id}-w{args.worker_id}{args.source_suffix}"
    print(f"worker {args.worker_id}/{args.workers}: source={source}")
    print(f"  seeds [{seed_start}, {seed_start + seed_count}) "
          f"key=0x{args.seed_key:016x}, hanchans={seed_count * 3}")

    chal_engine = build_engine(args.challenger, args.challenger_name,
                               torch.device(args.challenger_device))
    cham_engine = build_engine(args.champion, args.champion_name,
                               torch.device(args.champion_device))

    log_dir = str(args.log_dir.resolve()) if args.log_dir is not None else None
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)

    env = OneVsTwo(disable_progress_bar=args.disable_progress_bar, log_dir=log_dir)

    if not args.no_rpc:
        rpc_send_with_retry(args.rpc_url, args.rpc_token, "/api/events", {
            "source": source,
            "type": "worker.start",
            "status": "running",
            "severity": "info",
            "message": f"worker {args.worker_id}/{args.workers} starting "
                       f"{seed_count} seeds = {seed_count * 3} hanchans",
            "data": {
                "run_id": args.run_id,
                "worker_id": args.worker_id,
                "workers": args.workers,
                "seed_start": int(seed_start),
                "seed_count": int(seed_count),
                "seed_key": int(args.seed_key),
                "challenger": str(args.challenger),
                "champion": str(args.champion),
                "challenger_name": args.challenger_name,
                "champion_name": args.champion_name,
            },
            "timeout_ms": 3600000,
        })

    t0 = time.time()
    try:
        records = env.py_vs_py_detailed(
            challenger=chal_engine,
            champion=cham_engine,
            seed_start=(seed_start, args.seed_key),
            seed_count=seed_count,
        )
    except BaseException as e:
        if not args.no_rpc:
            try:
                rpc_send_with_retry(args.rpc_url, args.rpc_token,
                                    f"/api/sources/{source}/fail",
                                    {"reason": f"{type(e).__name__}: {e}"})
            except Exception as rpc_e:
                print(f"[rpc] fail-mark failed: {rpc_e}", file=sys.stderr)
        raise

    dt = time.time() - t0
    print(f"  arena finished: {len(records)} hanchans in {dt:.1f}s "
          f"({dt / max(len(records), 1):.2f}s/hanchan)")

    # Aggregate from challenger seat perspective.
    chal_ranks = [0, 0, 0]
    chal_score_total = 0
    for _, _, split_idx, _, scores, ranks, challenger_seat in records:
        chal_ranks[ranks[challenger_seat]] += 1
        chal_score_total += int(scores[challenger_seat])
    avg_rank = (sum((i + 1) * c for i, c in enumerate(chal_ranks))
                / max(sum(chal_ranks), 1))
    avg_score = chal_score_total / max(sum(chal_ranks), 1)

    print(f"  challenger rankings={chal_ranks} avg_rank={avg_rank:.4f} "
          f"avg_score={avg_score:.0f}")

    if args.no_rpc:
        for r in records[:3]:
            print("debug record:", r)
        print(f"(would post {len(records)} events to {args.rpc_url})")
        return

    sent = 0
    while sent < len(records):
        batch = records[sent:sent + args.batch_size]
        payload = [make_event(source, r, args.run_id, args.worker_id,
                              args.challenger_name, args.champion_name)
                   for r in batch]
        rpc_send_with_retry(args.rpc_url, args.rpc_token, "/api/events/batch", payload)
        sent += len(batch)
        print(f"  rpc batch posted: {sent}/{len(records)}", flush=True)

    rpc_send_with_retry(args.rpc_url, args.rpc_token, f"/api/sources/{source}/complete", {
        "message": f"completed {len(records)} hanchans, "
                   f"chal_ranks={chal_ranks}, avg_rank={avg_rank:.4f}",
    })
    print(f"  source marked complete: {source}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
