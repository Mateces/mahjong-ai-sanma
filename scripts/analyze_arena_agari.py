"""Analyze agari behavior in sanma arena mjai logs.

Walks a directory of `<seed>_<key>_<split>.json.gz` files produced by
arena_self_play.py and reports:

  * agari-eligible decision points (mask bit 41 set)
  * missed-agari rate (agari valid but model picked something else)
  * average q gap (q[chosen] - q[agari]) when agari was valid
  * actual agari rate (hora events per hanchan, per model)
  * sample decisions dumping q_values[41] vs q_values[chosen]

For vs-old arenas, the challenger (fresh) rotates through seats 0/1/2 in
splits a/b/c respectively. Each event's `actor` is matched against the
fresh seat for that file to attribute decisions to fresh vs old.

Usage:
    python3 analyze_arena_agari.py <arena_dir> [--name fresh] [--max-samples 5]

Read-only: does not modify any logs or checkpoints.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

AGARI_ACTION = 41
AGARI_BIT = 1 << AGARI_ACTION
ACTION_SPACE = 44

# Special-action indices in the sanma v5 layout (mirrors _diag_utils.py).
SPECIAL_LABELS = {
    37: "riichi",
    38: "nukidora",
    39: "pon",
    40: "kan",
    41: "agari",
    42: "ryukyoku",
    43: "pass",
}

# 34-tile plain names; used only for labeling discard actions.
TILE_NAMES = (
    [f"{n}m" for n in "123456789"]
    + [f"{n}p" for n in "123456789"]
    + [f"{n}s" for n in "123456789"]
    + list("ESWNPFC")
)


def action_label(idx: int) -> str:
    if 0 <= idx < 34:
        return f"discard {TILE_NAMES[idx]}"
    if 34 <= idx < 37:
        return f"discard_aka slot {idx}"
    return SPECIAL_LABELS.get(idx, f"action_{idx}")


def mask_bits_to_indices(mask_bits: int) -> list[int]:
    return [i for i in range(ACTION_SPACE) if mask_bits & (1 << i)]


def split_to_fresh_seat(suffix: str) -> int:
    """In arena_self_play OneVsTwo, challenger rotates through seats 0/1/2
    across splits a/b/c."""
    return {"a": 0, "b": 1, "c": 2}[suffix]


def parse_file(path: Path, fresh_seat: int | None):
    """Yield per-event decision records from one mjai file.

    Returns dict with:
      decisions : list of dicts (one per agari-eligible decision point)
      hora_by_actor : Counter {actor: count}
      hanchans : 1 if start_game seen
      all_meta_events : int (events with meta)
    """
    opener = gzip.open if path.suffix == ".gz" else open
    out = {
        "decisions": [],
        "hora_by_actor": Counter(),
        "hanchans": 0,
        "all_meta_events": 0,
        "agari_eligible_by_actor": Counter(),
        "missed_by_actor": Counter(),
    }
    try:
        with opener(path, "rt") as f:
            events = [json.loads(line) for line in f if line.strip()]
    except Exception as e:
        print(f"WARN: failed to parse {path}: {e}", file=sys.stderr)
        return out

    for ev in events:
        if not isinstance(ev, dict):
            continue
        t = ev.get("type")
        if t == "start_game":
            out["hanchans"] += 1
            continue
        if t == "hora":
            actor = int(ev.get("actor", -1))
            if actor >= 0:
                out["hora_by_actor"][actor] += 1
            # hora events themselves don't carry the decision-time meta in
            # the same way (they ARE the agari action); skip meta processing.
            continue

        meta = ev.get("meta")
        if not meta:
            continue
        out["all_meta_events"] += 1

        mb = int(meta.get("mask_bits", 0))
        q_values = list(meta.get("q_values", []))
        if not q_values:
            continue

        valid_indices = mask_bits_to_indices(mb)
        if len(valid_indices) != len(q_values):
            # Mismatch — shouldn't happen but skip defensively.
            continue

        actor = int(ev.get("actor", -1))
        if not (mb & AGARI_BIT):
            continue  # agari not eligible at this decision point

        out["agari_eligible_by_actor"][actor] += 1

        # argmax of q_values = chosen action (is_greedy: true means engine
        # picked the highest-q valid action).
        chosen_pos = int(max(range(len(q_values)), key=lambda i: q_values[i]))
        chosen_action = valid_indices[chosen_pos]
        q_chosen = float(q_values[chosen_pos])

        agari_pos = valid_indices.index(AGARI_ACTION)
        q_agari = float(q_values[agari_pos])
        gap = q_chosen - q_agari  # positive => agari loses

        is_missed = (chosen_action != AGARI_ACTION)
        if is_missed:
            out["missed_by_actor"][actor] += 1

        out["decisions"].append({
            "file": path.name,
            "event_index_in_file": events.index(ev) if False else None,  # noqa
            "actor": actor,
            "fresh_seat": fresh_seat,
            "is_fresh": (fresh_seat is None) or (actor == fresh_seat),
            "event_type": t,
            "pai": ev.get("pai"),
            "mask_bits": mb,
            "valid_indices": valid_indices,
            "q_values": q_values,
            "chosen_action": chosen_action,
            "chosen_label": action_label(chosen_action),
            "q_chosen": q_chosen,
            "q_agari": q_agari,
            "gap_q_chosen_minus_q_agari": gap,
            "is_missed_agari": is_missed,
            "shanten": int(meta.get("shanten", -1)),
            "at_furiten": bool(meta.get("at_furiten", False)),
        })
    return out


def analyze_arena(arena_dir: Path, fresh_name: str = "fresh"):
    files = sorted(arena_dir.glob("*.json.gz")) + sorted(arena_dir.glob("*.json"))
    if not files:
        print(f"ERROR: no .json.gz files in {arena_dir}", file=sys.stderr)
        return None

    all_decisions = []
    hora_by_seat = Counter()  # (file_split, actor) -> count, then aggregated
    total_hanchans = 0
    total_meta_events = 0
    # Distinguish fresh vs old (for vs-old arenas). For self-play, fresh_only=True
    # and everything goes in the fresh bucket.
    is_selfplay = True
    fresh_hanchans = 0
    old_hanchans = 0
    fresh_horas = 0
    old_horas = 0
    fresh_agari_eligible = 0
    fresh_missed = 0
    old_agari_eligible = 0
    old_missed = 0
    fresh_q_gaps = []
    old_q_gaps = []
    # Per-actor raw (collapses over hanchans; useful for self-play where all
    # three actors are the same model).
    raw_horas = Counter()
    raw_agari_eligible = Counter()
    raw_missed = Counter()

    for fp in files:
        # filename is <seed>_<key>_<split>.json.gz — strip BOTH extensions.
        # Path.stem only strips the last (.gz), leaving <seed>_<key>_<split>.json.
        stem_no_ext = fp.name
        if stem_no_ext.endswith(".json.gz"):
            stem_no_ext = stem_no_ext[: -len(".json.gz")]
        elif stem_no_ext.endswith(".json"):
            stem_no_ext = stem_no_ext[: -len(".json")]
        suffix = stem_no_ext.split("_")[-1] if "_" in stem_no_ext else None
        fresh_seat = None
        if suffix in ("a", "b", "c"):
            fresh_seat = split_to_fresh_seat(suffix)
            is_selfplay = False  # we have split info → may be a vs-old run
        # If names array shows all identical, treat as selfplay anyway.
        per = parse_file(fp, fresh_seat)
        total_hanchans += per["hanchans"]
        total_meta_events += per["all_meta_events"]
        for actor, c in per["hora_by_actor"].items():
            raw_horas[actor] += c
        for actor, c in per["agari_eligible_by_actor"].items():
            raw_agari_eligible[actor] += c
        for actor, c in per["missed_by_actor"].items():
            raw_missed[actor] += c
        all_decisions.extend(per["decisions"])

    # Detect self-play by checking the names array of the first file.
    # We re-open just to read start_game; if all three names match, fresh_seat
    # becomes irrelevant and we treat every decision as belonging to the
    # single model.
    actually_selfplay = False
    try:
        first = files[0]
        opener = gzip.open if first.suffix == ".gz" else open
        with opener(first, "rt") as f:
            for line in f:
                ev = json.loads(line)
                if ev.get("type") == "start_game":
                    names = ev.get("names", [])
                    if names and len(set(names)) == 1:
                        actually_selfplay = True
                    break
    except Exception:
        pass

    if actually_selfplay:
        # Every decision / hora belongs to the one model.
        fresh_hanchans = total_hanchans * 3  # 3 seats per hanchan
        old_hanchans = 0
        fresh_horas = sum(raw_horas.values())
        old_horas = 0
        fresh_agari_eligible = sum(raw_agari_eligible.values())
        fresh_missed = sum(raw_missed.values())
        old_agari_eligible = 0
        old_missed = 0
        for d in all_decisions:
            fresh_q_gaps.append(d["gap_q_chosen_minus_q_agari"])
    else:
        # vs-old: split by is_fresh flag.
        for d in all_decisions:
            if d["is_fresh"]:
                fresh_q_gaps.append(d["gap_q_chosen_minus_q_agari"])
            else:
                old_q_gaps.append(d["gap_q_chosen_minus_q_agari"])
        # Per-file attribution of horas & hanchans to fresh vs old.
        # Re-walk files for clean attribution (cheaper than caching).
        for fp in files:
            stem_no_ext = fp.name
            if stem_no_ext.endswith(".json.gz"):
                stem_no_ext = stem_no_ext[: -len(".json.gz")]
            elif stem_no_ext.endswith(".json"):
                stem_no_ext = stem_no_ext[: -len(".json")]
            suffix = stem_no_ext.split("_")[-1]
            if suffix not in ("a", "b", "c"):
                continue
            fresh_seat = split_to_fresh_seat(suffix)
            per = parse_file(fp, fresh_seat)
            if per["hanchans"] == 0:
                continue
            fresh_hanchans += per["hanchans"]
            old_hanchans += per["hanchans"] * 2
            for actor, c in per["hora_by_actor"].items():
                if actor == fresh_seat:
                    fresh_horas += c
                else:
                    old_horas += c
            for actor, c in per["agari_eligible_by_actor"].items():
                if actor == fresh_seat:
                    fresh_agari_eligible += c
                else:
                    old_agari_eligible += c
            for actor, c in per["missed_by_actor"].items():
                if actor == fresh_seat:
                    fresh_missed += c
                else:
                    old_missed += c

    return {
        "arena_dir": str(arena_dir),
        "is_selfplay": actually_selfplay,
        "n_files": len(files),
        "total_hanchans": total_hanchans,
        "total_meta_events": total_meta_events,
        "fresh": {
            "hanchans": fresh_hanchans,
            "agari_eligible": fresh_agari_eligible,
            "missed": fresh_missed,
            "miss_rate": (fresh_missed / fresh_agari_eligible) if fresh_agari_eligible else float("nan"),
            "agari_rate_per_hanchan": (fresh_horas / fresh_hanchans) if fresh_hanchans else float("nan"),
            "total_horas": fresh_horas,
            "q_gaps_count": len(fresh_q_gaps),
            "q_gap_mean": statistics.fmean(fresh_q_gaps) if fresh_q_gaps else float("nan"),
            "q_gap_median": statistics.median(fresh_q_gaps) if fresh_q_gaps else float("nan"),
            "q_gap_positive_frac": (sum(1 for g in fresh_q_gaps if g > 0) / len(fresh_q_gaps)) if fresh_q_gaps else float("nan"),
        },
        "old": {
            "hanchans": old_hanchans,
            "agari_eligible": old_agari_eligible,
            "missed": old_missed,
            "miss_rate": (old_missed / old_agari_eligible) if old_agari_eligible else float("nan"),
            "agari_rate_per_hanchan": (old_horas / old_hanchans) if old_hanchans else float("nan"),
            "total_horas": old_horas,
            "q_gaps_count": len(old_q_gaps),
            "q_gap_mean": statistics.fmean(old_q_gaps) if old_q_gaps else float("nan"),
            "q_gap_median": statistics.median(old_q_gaps) if old_q_gaps else float("nan"),
            "q_gap_positive_frac": (sum(1 for g in old_q_gaps if g > 0) / len(old_q_gaps)) if old_q_gaps else float("nan"),
        },
        "decisions": all_decisions,
    }


def fmt_pct(x: float) -> str:
    if math.isnan(x):
        return "  n/a"
    return f"{x * 100:6.2f}%"


def fmt_float(x: float, w: int = 8, p: int = 4) -> str:
    if math.isnan(x):
        return " " * w
    return f"{x:>{w}.{p}f}"


def print_report(rep, max_samples: int = 5, fresh_name: str = "fresh"):
    sep = "─" * 78
    print()
    print("=" * 78)
    print("ARENA AGARI ANALYSIS")
    print("=" * 78)
    print(f"arena_dir   : {rep['arena_dir']}")
    print(f"is_selfplay : {rep['is_selfplay']}")
    print(f"files       : {rep['n_files']}")
    print(f"hanchans    : {rep['total_hanchans']}")
    print(f"meta events : {rep['total_meta_events']} (decision points with q_values)")

    def _bucket(label, b):
        print()
        print(f"  [{label}]")
        print(f"    hanchans (player-games)      : {b['hanchans']}")
        print(f"    agari-eligible decisions     : {b['agari_eligible']}")
        print(f"    missed-agari count           : {b['missed']}")
        print(f"    miss rate                    : {fmt_pct(b['miss_rate'])}")
        print(f"    horas (total)                : {b['total_horas']}")
        print(f"    agari rate (per hanchan)     : {fmt_float(b['agari_rate_per_hanchan'])}")
        print(f"    q gap (q[chosen] - q[agari]) :")
        print(f"        n                        : {b['q_gaps_count']}")
        print(f"        mean                     : {fmt_float(b['q_gap_mean'])}")
        print(f"        median                   : {fmt_float(b['q_gap_median'])}")
        print(f"        fraction gap > 0         : {fmt_pct(b['q_gap_positive_frac'])}")

    _bucket(fresh_name, rep["fresh"])
    if not rep["is_selfplay"]:
        _bucket("old", rep["old"])

    # Sample decisions
    decisions = rep["decisions"]
    fresh_decs = [d for d in decisions if d["is_fresh"]] if not rep["is_selfplay"] else decisions
    if fresh_decs:
        # Sort: show a mix — first a few missed, then a few successful agari picks.
        missed = [d for d in fresh_decs if d["is_missed_agari"]]
        picked = [d for d in fresh_decs if not d["is_missed_agari"]]
        # Sort missed by descending gap (worst misses first)
        missed.sort(key=lambda d: -d["gap_q_chosen_minus_q_agari"])
        # Sort picked by ascending gap (closest calls first — most informative)
        picked.sort(key=lambda d: d["gap_q_chosen_minus_q_agari"])
        n_each = max(1, max_samples // 2) if max_samples >= 2 else 0
        sample = missed[:n_each] + picked[:n_each]
        sample = sample[:max_samples]

        print()
        print("=" * 78)
        print(f"SAMPLE DECISIONS ({fresh_name}, agari-eligible)")
        print("=" * 78)
        hdr = (
            f"  {'file':<32} {'actor':>5} {'shnten':>6} {'furi':>5} "
            f"{'chosen':<22} {'q[chosen]':>10} {'q[agari]':>10} {'gap':>8} {'miss?':>6}"
        )
        print(hdr)
        print("  " + sep[:76])
        for d in sample:
            furi = "Y" if d["at_furiten"] else "n"
            miss = "YES" if d["is_missed_agari"] else "no"
            fname = d["file"][:30]
            print(
                f"  {fname:<32} {d['actor']:>5} {d['shanten']:>6} {furi:>5} "
                f"{d['chosen_label'][:22]:<22} {d['q_chosen']:>10.4f} "
                f"{d['q_agari']:>10.4f} {d['gap_q_chosen_minus_q_agari']:>8.4f} {miss:>6}"
            )
        print()
        print("  Reading: gap > 0 means model valued the chosen action HIGHER than agari.")
        print("  miss?=YES means model did NOT pick agari despite it being a valid action.")


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    p.add_argument("arena_dir", type=Path)
    p.add_argument("--name", default="fresh", help="Display name for the model under analysis")
    p.add_argument("--max-samples", type=int, default=6)
    p.add_argument("--json-out", type=Path, default=None,
                   help="Optional: write full report (including all decisions) as JSON")
    args = p.parse_args()

    rep = analyze_arena(args.arena_dir, fresh_name=args.name)
    if rep is None:
        sys.exit(2)
    print_report(rep, max_samples=args.max_samples, fresh_name=args.name)

    if args.json_out:
        # Strip the heavy decisions list to keep file size reasonable.
        slim = {k: v for k, v in rep.items() if k != "decisions"}
        slim["decisions_count"] = len(rep["decisions"])
        slim["decisions_sample"] = rep["decisions"][:50]
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        with open(args.json_out, "w") as f:
            json.dump(slim, f, indent=2, default=str)
        print(f"\nJSON report: {args.json_out}")


if __name__ == "__main__":
    main()
