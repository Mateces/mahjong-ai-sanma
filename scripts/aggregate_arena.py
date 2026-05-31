"""Aggregate arena.hanchan events from rpc.moki.cat into per-model rates.

Pulls all events for the two source IDs (table A and table B), buckets per
model identifier (the `seats[i].model` field, e.g. "d" / "e"), and computes:

  - kyoku-level rates: agari, riichi, fuuro, houjuu, ryukyoku
    (numerator = sum of *_kyoku, denominator = sum of kyoku_count)
  - hanchan-level: 1st / 2nd / 3rd rate
    (numerator = count of seats with that rank, denominator = total seats reported)

Each rate is reported with 95% Wilson confidence interval.

Usage:
    python scripts/aggregate_arena.py \\
        --source sanma-arena-d-vs-e-A-20260531 \\
        --source sanma-arena-d-vs-e-B-20260531 \\
        [--rpc-url https://rpc.moki.cat]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from typing import Iterable

USER_AGENT = "sanma-arena-aggregate/0.1"


def fetch_all(url: str, source: str, *, page_size: int = 500) -> list[dict]:
    """Page through GET /api/events?source=... until exhausted."""
    out = []
    cursor = None
    while True:
        q = f"source={source}&limit={page_size}&type=arena.hanchan"
        if cursor:
            q += f"&cursor={cursor}"
        full = f"{url.rstrip('/')}/api/events?{q}"
        req = urllib.request.Request(full, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            page = json.loads(resp.read().decode("utf-8"))
        events = page.get("events", [])
        out.extend(events)
        new_cursor = page.get("cursor")
        if not new_cursor or new_cursor == cursor or not events:
            break
        cursor = new_cursor
    return out


def wilson_ci(k: int, n: int, z: float = 1.96) -> tuple[float, float, float]:
    """Return (point, lo, hi) for the Wilson 95% CI of k/n."""
    if n == 0:
        return (float("nan"), float("nan"), float("nan"))
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return p, centre - half, centre + half


def aggregate(events: Iterable[dict]) -> dict:
    """Bucket events by model and compute aggregate counters."""
    # per-model accumulators
    counts = defaultdict(lambda: {
        "kyoku_count": 0,
        "agari_kyoku": 0, "tsumo_agari_kyoku": 0, "ron_agari_kyoku": 0,
        "riichi_kyoku": 0, "fuuro_kyoku": 0, "houjuu_kyoku": 0, "ryukyoku_kyoku": 0,
        "rank1": 0, "rank2": 0, "rank3": 0, "seat_count": 0,
    })
    hanchan_count = 0
    for ev in events:
        # /api/events returns data as a JSON string (per the report-center
        # smoke we saw earlier).
        raw = ev.get("data")
        if isinstance(raw, str):
            data = json.loads(raw)
        else:
            data = raw or {}
        seats = data.get("seats")
        if not seats:
            continue
        hanchan_count += 1
        for s in seats:
            model = s.get("model") or "?"
            c = counts[model]
            c["kyoku_count"] += s["kyoku_count"]
            c["agari_kyoku"] += s["agari_kyoku"]
            c["tsumo_agari_kyoku"] += s["tsumo_agari_kyoku"]
            c["ron_agari_kyoku"] += s["ron_agari_kyoku"]
            c["riichi_kyoku"] += s["riichi_kyoku"]
            c["fuuro_kyoku"] += s["fuuro_kyoku"]
            c["houjuu_kyoku"] += s["houjuu_kyoku"]
            c["ryukyoku_kyoku"] += s["ryukyoku_kyoku"]
            r = s["rank"]
            if r == 1:
                c["rank1"] += 1
            elif r == 2:
                c["rank2"] += 1
            elif r == 3:
                c["rank3"] += 1
            else:
                raise ValueError(f"unexpected rank {r!r}")
            c["seat_count"] += 1
    return {"hanchans": hanchan_count, "by_model": dict(counts)}


def fmt_rate(name: str, k: int, n: int) -> str:
    p, lo, hi = wilson_ci(k, n)
    if math.isnan(p):
        return f"  {name:18s}  n=0"
    return (f"  {name:18s}  {p*100:6.2f}%  "
            f"[{lo*100:5.2f}, {hi*100:5.2f}]  ({k}/{n})")


def report(agg: dict) -> None:
    print(f"hanchans collected: {agg['hanchans']}")
    print()
    for model in sorted(agg["by_model"]):
        c = agg["by_model"][model]
        print(f"=== model={model} (seats={c['seat_count']}) ===")
        n_kyoku = c["kyoku_count"]
        n_seat = c["seat_count"]
        print(fmt_rate("和牌率",     c["agari_kyoku"],         n_kyoku))
        print(fmt_rate("  tsumo和",  c["tsumo_agari_kyoku"],   n_kyoku))
        print(fmt_rate("  ron和",    c["ron_agari_kyoku"],     n_kyoku))
        print(fmt_rate("立直率",     c["riichi_kyoku"],        n_kyoku))
        print(fmt_rate("副露率",     c["fuuro_kyoku"],         n_kyoku))
        print(fmt_rate("放铳率",     c["houjuu_kyoku"],        n_kyoku))
        print(fmt_rate("流局率",     c["ryukyoku_kyoku"],      n_kyoku))
        print(fmt_rate("一位率",     c["rank1"],               n_seat))
        print(fmt_rate("二位率",     c["rank2"],               n_seat))
        print(fmt_rate("三位率",     c["rank3"],               n_seat))
        print()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    p.add_argument("--source", action="append", required=True,
                   help="report-center source id; repeat to merge multiple "
                        "(e.g. --source sanma-arena-...A --source sanma-arena-...B).")
    p.add_argument("--rpc-url", default="https://rpc.moki.cat")
    p.add_argument("--save-events", default=None,
                   help="optional path: dump fetched events as a jsonl for offline use.")
    args = p.parse_args()

    all_events: list[dict] = []
    for src in args.source:
        evs = fetch_all(args.rpc_url, src)
        print(f"source={src}: {len(evs)} arena.hanchan events", file=sys.stderr)
        all_events.extend(evs)

    if args.save_events:
        with open(args.save_events, "w", encoding="utf-8") as fh:
            for ev in all_events:
                fh.write(json.dumps(ev, ensure_ascii=False) + "\n")

    if not all_events:
        sys.exit("no events collected")

    agg = aggregate(all_events)
    report(agg)


if __name__ == "__main__":
    main()
