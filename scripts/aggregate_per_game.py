"""Aggregate per-game stats and rankings across an arena directory.

Reads each `<seed>_<key>_<split>.json.gz` produced by arena_self_play.py,
runs per_game_stats.parse_mjai_path to get per-seat kyoku/hora/riichi/houjuu
counts, and aggregates by model.

For vs-old runs (fresh = challenger rotating through seats a/b/c = seats 0/1/2),
attribute each seat to fresh or old and report rates per model.

Read-only.
"""
from __future__ import annotations

import argparse
import gzip
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from per_game_stats import parse_mjai_path  # noqa: E402

SUFFIX_TO_FRESH_SEAT = {"a": 0, "b": 1, "c": 2}


def fresh_seat_for_file(path: Path) -> int | None:
    name = path.name
    stem = name[:-len(".json.gz")] if name.endswith(".json.gz") else name[:-len(".json")]
    parts = stem.split("_")
    if not parts:
        return None
    return SUFFIX_TO_FRESH_SEAT.get(parts[-1])


def read_rankings_and_scores(path: Path) -> tuple[list[int] | None, list[int] | None]:
    """Return (ranks1[3], scores[3]) computed by replaying score deltas.

    end_game has no scores in this format. We take the LAST start_kyoku.scores
    (which already reflects all prior reach deposits / kyotaku carry) and
    apply deltas from hora and ryukyoku events forward.
    """
    opener = gzip.open if path.suffix == ".gz" else open
    last_start_scores: list[int] | None = None
    events_after: list[dict] = []
    saw_start = False
    with opener(path, "rt") as f:
        for line in f:
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if not isinstance(ev, dict):
                continue
            t = ev.get("type")
            if t == "start_kyoku":
                last_start_scores = list(ev.get("scores", []))
                events_after = []
                saw_start = True
                continue
            if saw_start:
                events_after.append(ev)

    if not last_start_scores or len(last_start_scores) != 3:
        return None, None
    scores = list(last_start_scores)
    for ev in events_after:
        t = ev.get("type")
        if t in ("hora", "ryukyoku"):
            deltas = ev.get("deltas")
            if isinstance(deltas, list) and len(deltas) == 3:
                for i in range(3):
                    scores[i] += int(deltas[i])

    order = sorted(range(3), key=lambda i: (-scores[i], i))
    ranks = [0, 0, 0]
    for place, seat in enumerate(order):
        ranks[seat] = place + 1
    return ranks, scores


def aggregate(arena_dir: Path, *, selfplay: bool) -> dict:
    files = sorted(arena_dir.glob("*.json.gz")) + sorted(arena_dir.glob("*.json"))
    if not files:
        raise SystemExit(f"no files in {arena_dir}")

    # tallies
    per_model_seat_stats = defaultdict(lambda: {
        "hanchans": 0, "kyoku": 0,
        "agari_kyoku": 0, "tsumo_agari_kyoku": 0, "ron_agari_kyoku": 0,
        "riichi_kyoku": 0, "fuuro_kyoku": 0, "houjuu_kyoku": 0,
        "ryukyoku_kyoku": 0,
        "ranks": Counter(),
        "scores": [],
    })
    ranks_by_model = defaultdict(Counter)
    head_to_head = {"fresh_wins": 0, "fresh_losses": 0}

    for fp in files:
        fresh_seat = None if selfplay else fresh_seat_for_file(fp)
        try:
            stats = parse_mjai_path(fp)
        except Exception as e:
            print(f"WARN: parse_mjai_path failed on {fp}: {e}", file=sys.stderr)
            continue
        ranks, scores = read_rankings_and_scores(fp)

        for seat in range(3):
            s = stats[seat]
            if selfplay:
                model = "fresh"
            else:
                model = "fresh" if seat == fresh_seat else "old"
            key = (model, seat)
            ms = per_model_seat_stats[key]
            ms["hanchans"] += 1
            ms["kyoku"] += s["kyoku_count"]
            ms["agari_kyoku"] += s["agari_kyoku"]
            ms["tsumo_agari_kyoku"] += s["tsumo_agari_kyoku"]
            ms["ron_agari_kyoku"] += s["ron_agari_kyoku"]
            ms["riichi_kyoku"] += s["riichi_kyoku"]
            ms["fuuro_kyoku"] += s["fuuro_kyoku"]
            ms["houjuu_kyoku"] += s["houjuu_kyoku"]
            ms["ryukyoku_kyoku"] += s["ryukyoku_kyoku"]
            if ranks:
                ms["ranks"][ranks[seat]] += 1
                ranks_by_model[model][ranks[seat]] += 1
            if scores:
                ms["scores"].append(scores[seat])

        # Head-to-head: fresh rank vs old ranks.
        if not selfplay and ranks and scores:
            fresh_rank = ranks[fresh_seat]
            old_ranks = [ranks[s] for s in range(3) if s != fresh_seat]
            # fresh wins = number of olds ranked worse than fresh
            for orank in old_ranks:
                if fresh_rank < orank:
                    head_to_head["fresh_wins"] += 1
                else:
                    head_to_head["fresh_losses"] += 1

    # Compute summary per model (collapsing seats).
    summary = {}
    for model in ("fresh", "old"):
        agg = {
            "hanchans": 0, "kyoku": 0,
            "agari_kyoku": 0, "tsumo_agari_kyoku": 0, "ron_agari_kyoku": 0,
            "riichi_kyoku": 0, "fuuro_kyoku": 0, "houjuu_kyoku": 0,
            "ryukyoku_kyoku": 0,
            "ranks": Counter(),
        }
        for (m, seat), ms in per_model_seat_stats.items():
            if m != model:
                continue
            for k in agg:
                if isinstance(agg[k], Counter):
                    agg[k] += ms[k]
                else:
                    agg[k] += ms[k]
        if agg["hanchans"] == 0:
            continue
        ar = agg["agari_kyoku"] / agg["kyoku"] if agg["kyoku"] else float("nan")
        tr = agg["tsumo_agari_kyoku"] / agg["agari_kyoku"] if agg["agari_kyoku"] else float("nan")
        rr = agg["ron_agari_kyoku"] / agg["agari_kyoku"] if agg["agari_kyoku"] else float("nan")
        hr = agg["houjuu_kyoku"] / agg["kyoku"] if agg["kyoku"] else float("nan")
        rrate = agg["riichi_kyoku"] / agg["kyoku"] if agg["kyoku"] else float("nan")
        avg_rank = (sum(r * c for r, c in agg["ranks"].items()) /
                    sum(agg["ranks"].values())) if sum(agg["ranks"].values()) else float("nan")
        summary[model] = {
            "hanchans": agg["hanchans"],
            "kyoku": agg["kyoku"],
            "agari_kyoku": agg["agari_kyoku"],
            "tsumo_agari_kyoku": agg["tsumo_agari_kyoku"],
            "ron_agari_kyoku": agg["ron_agari_kyoku"],
            "riichi_kyoku": agg["riichi_kyoku"],
            "fuuro_kyoku": agg["fuuro_kyoku"],
            "houjuu_kyoku": agg["houjuu_kyoku"],
            "ryukyoku_kyoku": agg["ryukyoku_kyoku"],
            "ranks": dict(agg["ranks"]),
            "agari_rate_per_kyoku": ar,
            "tsumo_frac_of_agari": tr,
            "ron_frac_of_agari": rr,
            "houjuu_rate_per_kyoku": hr,
            "riichi_rate_per_kyoku": rrate,
            "avg_rank": avg_rank,
        }

    return {
        "arena_dir": str(arena_dir),
        "selfplay": selfplay,
        "n_files": len(files),
        "per_model_summary": summary,
        "per_model_per_seat": {
            f"{m}_seat{se}": {k: (dict(v) if isinstance(v, Counter) else v)
                              for k, v in ms.items()}
            for (m, se), ms in sorted(per_model_seat_stats.items())
        },
        "head_to_head": head_to_head if not selfplay else None,
    }


def print_report(rep: dict) -> None:
    print()
    print("=" * 78)
    print("ARENA PER-GAME STATS SUMMARY")
    print("=" * 78)
    print(f"arena_dir : {rep['arena_dir']}")
    print(f"selfplay  : {rep['selfplay']}")
    print(f"n_files   : {rep['n_files']}")
    print()
    s = rep["per_model_summary"]
    models = sorted(s.keys())
    print(f"  {'metric':<28} " + " ".join(f"{m:>14}" for m in models))
    rows = [
        ("hanchans",                "hanchans",           "d"),
        ("kyoku (total)",           "kyoku",              "d"),
        ("agari kyoku",             "agari_kyoku",        "d"),
        ("  tsumo",                 "tsumo_agari_kyoku",  "d"),
        ("  ron",                   "ron_agari_kyoku",    "d"),
        ("riichi kyoku",            "riichi_kyoku",       "d"),
        ("fuuro kyoku",             "fuuro_kyoku",        "d"),
        ("houjuu kyoku",            "houjuu_kyoku",       "d"),
        ("ryukyoku kyoku",          "ryukyoku_kyoku",     "d"),
        ("agari rate / kyoku",      "agari_rate_per_kyoku", "pct"),
        ("tsumo frac of agari",     "tsumo_frac_of_agari", "pct"),
        ("ron frac of agari",       "ron_frac_of_agari",   "pct"),
        ("houjuu rate / kyoku",     "houjuu_rate_per_kyoku","pct"),
        ("riichi rate / kyoku",     "riichi_rate_per_kyoku","pct"),
        ("avg rank (1=best)",       "avg_rank",            "f4"),
        ("rank distribution",       "ranks",               "dict"),
    ]
    for label, key, fmt in rows:
        cells = []
        for m in models:
            v = s[m].get(key)
            if fmt == "d":
                cells.append(f"{v:>14d}" if v is not None else f"{'':>14}")
            elif fmt == "pct":
                cells.append(f"{(v*100):>13.2f}%" if v == v else f"{'':>14}")
            elif fmt == "f4":
                cells.append(f"{v:>14.4f}" if v == v else f"{'':>14}")
            elif fmt == "dict":
                cells.append(f"{str(v):>14}")
            else:
                cells.append(f"{str(v):>14}")
        print(f"  {label:<28} " + " ".join(cells))

    if not rep["selfplay"] and rep["head_to_head"]:
        hh = rep["head_to_head"]
        total = hh["fresh_wins"] + hh["fresh_losses"]
        wr = hh["fresh_wins"] / total if total else float("nan")
        print()
        print(f"  HEAD-TO-HEAD (fresh vs old, per matchup):")
        print(f"    fresh wins  : {hh['fresh_wins']}")
        print(f"    fresh losses: {hh['fresh_losses']}")
        print(f"    win rate    : {wr*100:.2f}%   (threshold >55% = PASS)")

    print()
    print("  PER-SEAT BREAKDOWN")
    pms = rep["per_model_per_seat"]
    print(f"    {'bucket':<18} {'hanchans':>9} {'kyoku':>6} {'agari':>6} "
          f"{'tsumo':>6} {'ron':>5} {'houjuu':>7} {'riichi':>7} "
          f"{'agari%':>7} {'houjuu%':>8}")
    keys = sorted(pms.keys())
    for k in keys:
        b = pms[k]
        ar = b["agari_kyoku"] / b["kyoku"] * 100 if b["kyoku"] else float("nan")
        hr = b["houjuu_kyoku"] / b["kyoku"] * 100 if b["kyoku"] else float("nan")
        print(f"    {k:<18} {b['hanchans']:>9} {b['kyoku']:>6} {b['agari_kyoku']:>6} "
              f"{b['tsumo_agari_kyoku']:>6} {b['ron_agari_kyoku']:>5} "
              f"{b['houjuu_kyoku']:>7} {b['riichi_kyoku']:>7} "
              f"{ar:>6.2f}% {hr:>7.2f}%")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("arena_dir", type=Path)
    p.add_argument("--selfplay", action="store_true")
    p.add_argument("--json-out", type=Path, default=None)
    args = p.parse_args()

    rep = aggregate(args.arena_dir, selfplay=args.selfplay)
    print_report(rep)
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        with open(args.json_out, "w") as f:
            json.dump(rep, f, indent=2, default=str)
        print(f"\nJSON report: {args.json_out}")


if __name__ == "__main__":
    main()
