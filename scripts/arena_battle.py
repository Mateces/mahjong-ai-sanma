"""Multi-worker sanma model-vs-model battle: open-ended worker mode.

Each worker loops, running OneVsTwo for `--batch-seeds` seeds at a time,
writing per-hanchan mjai logs to disk and posting per-hanchan event records
to a single shared RPC source. Workers run until killed by the operator
(SIGINT / SIGTERM). Total volume is whatever the workers managed to finish.

Seed scheduling avoids overlap: round N, worker w runs seeds in
  [seed_base + (N * workers + w) * batch_seeds,
   seed_base + (N * workers + w + 1) * batch_seeds)
so every worker has a disjoint stripe across rounds.

All workers post to the same source so results aggregate cleanly. The source
is created lazily by whichever worker reports first; a separate
`worker.online` event tracks each worker's startup.

Usage:
    python scripts/arena_battle.py \\
        --challenger checkpoints/sanma-main.pth \\
        --champion   checkpoints/sanma-main-best.pth \\
        --challenger-name main --champion-name best \\
        --run-id 3k-main-vs-best-2026-05-30 \\
        --workers 6 --worker-id 0 \\
        --batch-seeds 10 \\
        --seed-base 100000 --seed-key 0xC0FFEE \\
        --rpc-token "$RPC_TOKEN" \\
        --log-dir arena_runs/main-vs-best/mjai

Stop a worker: SIGINT or SIGTERM. The script reports `worker.stopped`
before exit. The shared RPC source is NEVER auto-completed (operator must
mark complete manually when satisfied).
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import sys
import time
import traceback
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

USER_AGENT = "sanma-arena-battle/0.2"

_stop_requested = False


def _on_signal(signum, frame):
    global _stop_requested
    _stop_requested = True
    print(f"[signal] received {signum}, will exit after current batch", flush=True)


signal.signal(signal.SIGINT, _on_signal)
signal.signal(signal.SIGTERM, _on_signal)


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


def make_hanchan_event(source: str, record, run_id: str, worker_id: int,
                       host: str, challenger_name: str, champion_name: str) -> dict:
    seed, key, split_idx, names, scores, ranks, challenger_seat = record
    challenger_score = int(scores[challenger_seat])
    challenger_rank = int(ranks[challenger_seat]) + 1
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
            "host": host,
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
                   help="Logical run identifier — becomes the shared source name "
                        "(prefixed with sanma-arena-).")
    p.add_argument("--workers", type=int, required=True,
                   help="Total worker count across all hosts; must match what every "
                        "other worker is using so seed stripes don't collide.")
    p.add_argument("--worker-id", type=int, required=True,
                   help="This worker's index in [0, workers).")
    p.add_argument("--batch-seeds", type=int, default=10,
                   help="Seeds per batch (each seed = 3 hanchans).")
    p.add_argument("--seed-base", type=int, default=100000)
    p.add_argument("--seed-key", type=lambda s: int(s, 0), default=0)
    p.add_argument("--rpc-url", default="https://rpc.moki.cat")
    p.add_argument("--rpc-token", required=True)
    p.add_argument("--source-suffix", default="")
    p.add_argument("--rpc-batch-size", type=int, default=50,
                   help="Events per /api/events/batch POST (max 100).")
    p.add_argument("--disable-progress-bar", action="store_true")
    p.add_argument("--log-dir", type=Path, required=True,
                   help="mjai .json.gz output directory (per-host, shared between "
                        "this host's workers; OneVsTwo names files by seed_split).")
    p.add_argument("--max-rounds", type=int, default=0,
                   help="If > 0, stop after this many batches (debug). 0 = run forever.")
    args = p.parse_args()

    if args.workers <= 0 or not (0 <= args.worker_id < args.workers):
        sys.exit(f"bad worker config: id={args.worker_id} workers={args.workers}")
    if not 1 <= args.rpc_batch_size <= 100:
        sys.exit("--rpc-batch-size must be in [1, 100]")
    if args.batch_seeds < 1:
        sys.exit("--batch-seeds must be >= 1")

    source = f"sanma-arena-{args.run_id}{args.source_suffix}"
    host = socket.gethostname()
    log_dir = str(args.log_dir.resolve())
    os.makedirs(log_dir, exist_ok=True)
    print(f"worker {args.worker_id}/{args.workers} on {host}: source={source}")
    print(f"  log_dir={log_dir}")
    print(f"  challenger={args.challenger} champion={args.champion}")
    print(f"  seed_base={args.seed_base} key=0x{args.seed_key:016x} batch_seeds={args.batch_seeds}")

    chal_engine = build_engine(args.challenger, args.challenger_name,
                               torch.device(args.challenger_device))
    cham_engine = build_engine(args.champion, args.champion_name,
                               torch.device(args.champion_device))
    env = OneVsTwo(disable_progress_bar=args.disable_progress_bar, log_dir=log_dir)

    rpc_send_with_retry(args.rpc_url, args.rpc_token, "/api/events", {
        "source": source,
        "type": "worker.online",
        "status": "running",
        "severity": "info",
        "message": f"worker {args.worker_id}/{args.workers} on {host} starting",
        "data": {
            "run_id": args.run_id,
            "worker_id": args.worker_id,
            "workers": args.workers,
            "host": host,
            "challenger": str(args.challenger),
            "champion": str(args.champion),
            "challenger_name": args.challenger_name,
            "champion_name": args.champion_name,
            "log_dir": log_dir,
            "seed_base": int(args.seed_base),
            "seed_key": int(args.seed_key),
            "batch_seeds": int(args.batch_seeds),
        },
        "timeout_ms": 3600000,
        "skip_notify": True,
    })

    round_idx = 0
    total_hanchans = 0
    chal_ranks_total = [0, 0, 0]
    t_start = time.time()

    try:
        while not _stop_requested:
            if args.max_rounds and round_idx >= args.max_rounds:
                break

            stripe = round_idx * args.workers + args.worker_id
            seed_start = args.seed_base + stripe * args.batch_seeds
            seed_count = args.batch_seeds

            t0 = time.time()
            try:
                records = env.py_vs_py_detailed(
                    challenger=chal_engine,
                    champion=cham_engine,
                    seed_start=(seed_start, args.seed_key),
                    seed_count=seed_count,
                )
            except BaseException as e:
                err_text = "".join(traceback.format_exception(type(e), e, e.__traceback__))
                print(err_text, file=sys.stderr, flush=True)
                try:
                    rpc_send_with_retry(args.rpc_url, args.rpc_token, "/api/events", {
                        "source": source,
                        "type": "worker.error",
                        "status": "error",
                        "severity": "error",
                        "message": f"worker {args.worker_id} ({host}) round {round_idx} "
                                   f"seed_start={seed_start}: {type(e).__name__}: {e}",
                        "data": {
                            "run_id": args.run_id,
                            "worker_id": args.worker_id,
                            "host": host,
                            "round": round_idx,
                            "seed_start": int(seed_start),
                            "seed_count": int(seed_count),
                            "exception_type": type(e).__name__,
                            "exception_str": str(e),
                            "traceback": err_text[-4000:],
                        },
                        "timeout_ms": 3600000,
                    })
                except Exception as rpc_e:
                    print(f"[rpc] error-event post failed: {rpc_e}",
                          file=sys.stderr, flush=True)
                raise

            dt = time.time() - t0

            ranks_this = [0, 0, 0]
            for r in records:
                _, _, _, _, _, ranks, challenger_seat = r
                ranks_this[ranks[challenger_seat]] += 1
            for i, c in enumerate(ranks_this):
                chal_ranks_total[i] += c
            total_hanchans += len(records)

            print(f"  round {round_idx} stripe={stripe} "
                  f"seeds=[{seed_start},{seed_start + seed_count}) "
                  f"hanchans={len(records)} dt={dt:.1f}s "
                  f"chal_ranks_round={ranks_this} total={total_hanchans} "
                  f"chal_total={chal_ranks_total}", flush=True)

            sent = 0
            while sent < len(records):
                slab = records[sent:sent + args.rpc_batch_size]
                payload = [
                    make_hanchan_event(source, rec, args.run_id, args.worker_id,
                                       host, args.challenger_name, args.champion_name)
                    for rec in slab
                ]
                rpc_send_with_retry(args.rpc_url, args.rpc_token,
                                    "/api/events/batch", payload)
                sent += len(slab)

            rpc_send_with_retry(args.rpc_url, args.rpc_token, "/api/events", {
                "source": source,
                "type": "worker.heartbeat",
                "status": "running",
                "severity": "info",
                "message": f"w{args.worker_id}@{host} round {round_idx} "
                           f"+{len(records)} (own total {total_hanchans})",
                "data": {
                    "run_id": args.run_id,
                    "worker_id": args.worker_id,
                    "host": host,
                    "round": round_idx,
                    "round_hanchans": len(records),
                    "round_chal_ranks": ranks_this,
                    "round_seconds": round(dt, 2),
                    "own_total_hanchans": total_hanchans,
                    "own_chal_ranks_total": chal_ranks_total,
                },
                "timeout_ms": 3600000,
                "skip_notify": True,
            })

            round_idx += 1
    finally:
        elapsed = time.time() - t_start
        try:
            rpc_send_with_retry(args.rpc_url, args.rpc_token, "/api/events", {
                "source": source,
                "type": "worker.stopped",
                "status": "ok" if not _stop_requested else "warning",
                "severity": "info",
                "message": f"w{args.worker_id}@{host} stopped after {round_idx} rounds, "
                           f"{total_hanchans} hanchans, {elapsed:.0f}s",
                "data": {
                    "run_id": args.run_id,
                    "worker_id": args.worker_id,
                    "host": host,
                    "rounds_completed": round_idx,
                    "own_total_hanchans": total_hanchans,
                    "own_chal_ranks_total": chal_ranks_total,
                    "elapsed_seconds": round(elapsed, 1),
                    "stop_requested": _stop_requested,
                },
                "timeout_ms": 3600000,
                "skip_notify": True,
            })
        except Exception as e:
            print(f"[rpc] stopped-event post failed: {e}", file=sys.stderr, flush=True)
        print(f"worker {args.worker_id} finished: rounds={round_idx} "
              f"hanchans={total_hanchans} elapsed={elapsed:.0f}s", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
