"""Replay-based agari-eligible scanner for sanma arena mjai logs.

WHY THIS EXISTS
---------------
arena_self_play.py's mjai logs attach `meta.mask_bits` to non-hora events
only. When the C++ engine picks `hora`, the resulting event has no meta at
all — so a naive bit-41 scan of meta sees zero agari-eligible decisions,
even though they happen every hanchan. To measure the true "missed agari"
rate we must **replay each game through libriichi.state.PlayerState** and
call `encode_obs` at every decision point to reconstruct the real mask
the bot saw at decision time.

WHAT IT DOES
------------
For each mjai file in an arena directory:

  1. Maintain three PlayerState objects (one per seat).
  2. Walk events sequentially. Before each action event (dahai, hora,
     reach, nukidora, pon, chi, kan variants), encode obs from the
     actor's POV to get the mask.
  3. If the mask has bit 41 (agari) set, record a decision row:
        (file, event_idx, actor, event_type, pai, picked_hora,
         shanten, at_furiten, is_oya)
  4. After recording, advance all three PlayerStates with the event.

The challenger (fresh) in arena_self_play OneVsTwo rotates through seats
0/1/2 across splits a/b/c, so we attribute each row to fresh vs champion
via the filename suffix.

OUTPUT
------
- Aggregate counts: agari-eligible, picked-hora, missed, miss_rate
  broken down by model × seat × oya.
- Per-game hora/riichi/houjuu rates via per_game_stats.
- Sample decisions (first few rows) for sanity.

Read-only: does not modify any log or checkpoint.

Usage
-----
    python3 scripts/replay_agari_scan.py <arena_dir> [--selfplay]
                                          [--fresh-seat-suffix]
                                          [--max-files N]
                                          [--sample N]
                                          [--json-out PATH]
"""

from __future__ import annotations

import argparse
import gzip
import json
import statistics
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
ROOT = Path(__file__).resolve().parent.parent
_mortal = ROOT / "mortal"
sys.path.insert(0, str(_mortal))

import libriichi  # noqa: E402

AGARI_ACTION = 41
AGARI_BIT = 1 << AGARI_ACTION
ACTION_SPACE = int(libriichi.consts.ACTION_SPACE)
VERSION = 5

# Action events the bot emits as decisions.
_DECISION_TYPES = frozenset({
    "dahai", "hora", "reach", "nukidora",
    "pon", "chi", "daiminkan", "kakan", "ankan",
})

# File-name suffix → seat of fresh (challenger) in arena_self_play.
SUFFIX_TO_FRESH_SEAT = {"a": 0, "b": 1, "c": 2}


def _mask_array_to_bits(mask) -> int:
    """Pack a (ACTION_SPACE,) bool/numeric mask into an int bitmask."""
    bits = 0
    for i, v in enumerate(mask):
        if v:
            bits |= (1 << i)
    return bits


def _opener(path: Path):
    return gzip.open(path, "rt") if path.suffix == ".gz" else open(path, "rt")


def stream_replay_file(path: Path) -> list[dict]:
    """Stream-replay one mjai file. Returns a list of agari-eligible decision rows.

    Each row: {
        file, event_idx, actor, event_type, pai,
        picked_hora, shanten, at_furiten, is_oya
    }
    """
    with _opener(path) as f:
        events = [json.loads(line) for line in f if line.strip()]

    pss = [libriichi.state.PlayerState(i) for i in range(3)]
    rows: list[dict] = []

    # We need oya per kyoku; start_kyoku carries it.
    current_oya = -1

    for i, ev in enumerate(events):
        if not isinstance(ev, dict):
            continue
        t = ev.get("type")

        if t == "start_kyoku":
            current_oya = int(ev.get("oya", -1))

        # If this is a decision event, record agari-eligibility BEFORE applying.
        actor = ev.get("actor")
        if (
            actor is not None
            and t in _DECISION_TYPES
            and 0 <= int(actor) < 3
        ):
            actor = int(actor)
            try:
                _, mask = pss[actor].encode_obs(VERSION, False)
                mbits = _mask_array_to_bits(mask)
            except Exception as e:
                # encode_obs can raise if the state is invalid; skip defensively.
                mbits = 0
            if mbits & AGARI_BIT:
                try:
                    shanten = int(pss[actor].shanten)
                except Exception:
                    shanten = -1
                try:
                    furiten = bool(pss[actor].at_furiten)
                except Exception:
                    furiten = False
                rows.append({
                    "file": path.name,
                    "event_idx": i,
                    "actor": actor,
                    "event_type": t,
                    "pai": ev.get("pai"),
                    "picked_hora": (t == "hora"),
                    "shanten": shanten,
                    "at_furiten": furiten,
                    "is_oya": (actor == current_oya),
                })

        # Advance all player states with this event.
        ev_str = json.dumps(ev, ensure_ascii=False)
        for ps in pss:
            try:
                ps.update(ev_str)
            except Exception:
                pass

    return rows


def per_file_horas(path: Path) -> dict[int, int]:
    """Quick hora count per actor in one file."""
    counts = Counter()
    with _opener(path) as f:
        for line in f:
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if isinstance(ev, dict) and ev.get("type") == "hora":
                a = int(ev.get("actor", -1))
                if 0 <= a < 3:
                    counts[a] += 1
    return dict(counts)


def fresh_seat_for_file(path: Path, *, selfplay: bool) -> int | None:
    """Determine which seat is fresh (the challenger). Returns None for self-play
    (every seat is fresh) or when filename lacks the a/b/c suffix."""
    if selfplay:
        return None
    name = path.name
    stem = name[:-len(".json.gz")] if name.endswith(".json.gz") else name[:-len(".json")]
    parts = stem.split("_")
    if not parts:
        return None
    suffix = parts[-1]
    return SUFFIX_TO_FRESH_SEAT.get(suffix)


def scan_dir(arena_dir: Path, *, selfplay: bool, max_files: int = 0) -> dict:
    files = sorted(arena_dir.glob("*.json.gz")) + sorted(arena_dir.glob("*.json"))
    if max_files > 0:
        files = files[:max_files]

    if not files:
        raise SystemExit(f"no .json(.gz) files in {arena_dir}")

    # Tallies.
    # Per-model + per-seat + per-oya buckets.
    agari_eligible = Counter()    # key: (model, seat, oya_flag)
    picked_hora = Counter()
    missed = Counter()
    # Per-model totals (collapse seat/oya).
    elig_by_model = Counter()
    horas_by_model = Counter()
    missed_by_model = Counter()
    # Hora events by actor (for hora-rate-per-hanchan).
    horas_raw_by_actor = Counter()
    # Hanchan count (one per file).
    n_hanchans = 0
    # Sample decisions.
    samples = []

    t0 = time.time()
    for fi, fp in enumerate(files):
        if fi % 25 == 0 and fi > 0:
            elapsed = time.time() - t0
            rate = fi / elapsed
            print(f"  [{fi}/{len(files)}] {rate:.1f} files/s", file=sys.stderr)
        rows = stream_replay_file(fp)
        n_hanchans += 1
        fresh_seat = fresh_seat_for_file(fp, selfplay=selfplay)

        # Tally raw horas per actor for this file.
        fh = per_file_horas(fp)
        for a, c in fh.items():
            horas_raw_by_actor[a] += c

        for r in rows:
            actor = r["actor"]
            is_oya = r["is_oya"]
            if selfplay or fresh_seat is None:
                model = "fresh"
            else:
                model = "fresh" if actor == fresh_seat else "old"
            key = (model, actor, is_oya)
            agari_eligible[key] += 1
            elig_by_model[model] += 1
            if r["picked_hora"]:
                picked_hora[key] += 1
                horas_by_model[model] += 1
            else:
                missed[key] += 1
                missed_by_model[model] += 1
            if len(samples) < 30:
                samples.append({**r, "model": model, "fresh_seat": fresh_seat})

    elapsed = time.time() - t0
    return {
        "arena_dir": str(arena_dir),
        "selfplay": selfplay,
        "n_files": len(files),
        "n_hanchans": n_hanchans,
        "elapsed_seconds": elapsed,
        "agari_eligible_by_bucket": {f"{k[0]}_seat{k[1]}_oya{k[2]}": v
                                     for k, v in agari_eligible.items()},
        "picked_hora_by_bucket": {f"{k[0]}_seat{k[1]}_oya{k[2]}": v
                                  for k, v in picked_hora.items()},
        "missed_by_bucket": {f"{k[0]}_seat{k[1]}_oya{k[2]}": v
                             for k, v in missed.items()},
        "totals_by_model": {
            m: {
                "agari_eligible": elig_by_model[m],
                "picked_hora": horas_by_model[m],
                "missed": missed_by_model[m],
                "miss_rate": (missed_by_model[m] / elig_by_model[m])
                             if elig_by_model[m] else float("nan"),
                "hora_rate_per_hanchan": (
                    horas_by_model[m] / (n_hanchans if selfplay or m == "fresh"
                                         else n_hanchans * 2)
                ),
            }
            for m in sorted(elig_by_model | missed_by_model | horas_by_model)
        },
        "horas_raw_by_actor": dict(horas_raw_by_actor),
        "samples": samples,
    }


def print_report(rep: dict) -> None:
    print()
    print("=" * 78)
    print("REPLAY-BASED AGARI SCAN")
    print("=" * 78)
    print(f"arena_dir      : {rep['arena_dir']}")
    print(f"selfplay       : {rep['selfplay']}")
    print(f"files / hanchans: {rep['n_files']} / {rep['n_hanchans']}")
    print(f"elapsed        : {rep['elapsed_seconds']:.1f}s "
          f"({rep['n_files']/max(rep['elapsed_seconds'],1):.1f} files/s)")
    print()
    print("PER-MODEL TOTALS")
    print(f"  {'model':<8} {'eligible':>9} {'hora':>6} {'missed':>8} {'miss_rt':>9} {'hora/hanchan':>13}")
    for m, b in rep["totals_by_model"].items():
        mr = b["miss_rate"]
        mr_s = f"{mr*100:.2f}%" if mr == mr else "n/a"
        print(f"  {m:<8} {b['agari_eligible']:>9} {b['picked_hora']:>6} "
              f"{b['missed']:>8} {mr_s:>9} {b['hora_rate_per_hanchan']:>13.4f}")
    print()
    print("BY (model, seat, oya)  — only nonzero buckets")
    print(f"  {'bucket':<24} {'eligible':>9} {'hora':>6} {'missed':>8} {'miss_rt':>9}")
    keys = sorted(set(list(rep["agari_eligible_by_bucket"].keys()) +
                     list(rep["missed_by_bucket"].keys()) +
                     list(rep["picked_hora_by_bucket"].keys())))
    for k in keys:
        elig = rep["agari_eligible_by_bucket"].get(k, 0)
        hora = rep["picked_hora_by_bucket"].get(k, 0)
        miss = rep["missed_by_bucket"].get(k, 0)
        mr = (miss / elig) if elig else float("nan")
        mr_s = f"{mr*100:.2f}%" if mr == mr else "n/a"
        if elig == 0 and miss == 0:
            continue
        print(f"  {k:<24} {elig:>9} {hora:>6} {miss:>8} {mr_s:>9}")
    print()
    print(f"raw horas by actor (across all files): {rep['horas_raw_by_actor']}")
    print()
    if rep["samples"]:
        print(f"SAMPLE DECISIONS (first {len(rep['samples'])}, agari-eligible):")
        print(f"  {'file':<34} {'ev':>5} {'actor':>5} {'model':>6} {'seat':>4} "
              f"{'oya?':>5} {'type':<8} {'pai':<5} {'shntn':>6} {'furi':>5} {'picked':>7}")
        for s in rep["samples"][:20]:
            picked = "hora" if s["picked_hora"] else "MISS"
            print(f"  {s['file'][:34]:<34} {s['event_idx']:>5} {s['actor']:>5} "
                  f"{s['model']:>6} {s['fresh_seat'] if s['fresh_seat'] is not None else '-':>4} "
                  f"{'Y' if s['is_oya'] else 'n':>5} {s['event_type']:<8} "
                  f"{str(s['pai']):<5} {s['shanten']:>6} "
                  f"{'Y' if s['at_furiten'] else 'n':>5} {picked:>7}")


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    p.add_argument("arena_dir", type=Path)
    p.add_argument("--selfplay", action="store_true",
                   help="Treat all seats as the same model (no fresh/old split).")
    p.add_argument("--max-files", type=int, default=0)
    p.add_argument("--json-out", type=Path, default=None)
    args = p.parse_args()

    rep = scan_dir(args.arena_dir, selfplay=args.selfplay,
                   max_files=args.max_files)
    print_report(rep)

    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        with open(args.json_out, "w") as f:
            json.dump(rep, f, indent=2, default=str)
        print(f"\nJSON report: {args.json_out}")


if __name__ == "__main__":
    main()
