"""Re-POST events that arena_battle.py spooled to a missed.jsonl file.

Each line is `{"path": "/api/events" or "/api/events/batch", "payload": ...}`.
We POST them in order. On any failure we print to stderr but continue;
re-run the script if you want to retry only the still-failing tail.

Usage:
    python scripts/replay_missed.py <missed.jsonl> [<missed.jsonl> ...] \\
        --rpc-url https://rpc.moki.cat \\
        --rpc-token "$RPC_TOKEN"

WARNING: this is NOT idempotent. The report center accepts every POST. Run
only against missed files from workers that have already exited, or you will
duplicate events.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

USER_AGENT = "sanma-arena-replay/0.1"


def post(url: str, token: str, path: str, payload, timeout: float = 30.0) -> None:
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
        resp.read()


def replay_one(file: Path, url: str, token: str, *, attempts: int, base_delay: float):
    sent = failed = 0
    with open(file, "r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception as e:
                print(f"[{file}:{line_no}] parse error: {e}", file=sys.stderr)
                failed += 1
                continue
            path = rec.get("path")
            payload = rec.get("payload")
            if not path or payload is None:
                print(f"[{file}:{line_no}] malformed: missing path/payload",
                      file=sys.stderr)
                failed += 1
                continue
            ok = False
            for i in range(attempts):
                try:
                    post(url, token, path, payload)
                    ok = True
                    break
                except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
                    wait = base_delay * (2 ** i)
                    print(f"[{file}:{line_no}] attempt {i+1}/{attempts} failed: {e}; "
                          f"sleep {wait:.1f}s", file=sys.stderr)
                    time.sleep(wait)
            if ok:
                sent += 1
            else:
                failed += 1
                print(f"[{file}:{line_no}] giving up", file=sys.stderr)
    return sent, failed


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    p.add_argument("files", type=Path, nargs="+")
    p.add_argument("--rpc-url", default="https://rpc.moki.cat")
    p.add_argument("--rpc-token", required=True)
    p.add_argument("--attempts", type=int, default=5)
    p.add_argument("--base-delay", type=float, default=2.0)
    args = p.parse_args()

    grand_sent = grand_failed = 0
    for f in args.files:
        if not f.is_file():
            print(f"[skip] {f} not a file", file=sys.stderr)
            continue
        sent, failed = replay_one(f, args.rpc_url, args.rpc_token,
                                  attempts=args.attempts, base_delay=args.base_delay)
        print(f"{f}: sent={sent} failed={failed}")
        grand_sent += sent
        grand_failed += failed
    print(f"--- total: sent={grand_sent} failed={grand_failed}")
    sys.exit(0 if grand_failed == 0 else 1)


if __name__ == "__main__":
    main()
