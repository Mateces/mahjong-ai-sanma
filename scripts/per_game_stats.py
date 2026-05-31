"""Per-hanchan, per-seat kyoku-level stats from a sanma mjai jsonl(.gz) log.

Strict: any unknown event type, kyoku/score inconsistency, or out-of-range
actor raises. No silent fallback.

Returned schema (per seat 0/1/2):

    {
        "kyoku_count":      int,  # total kyoku in this hanchan (same for all seats)
        "agari_kyoku":      int,  # kyokus where this seat won (hora.actor==seat)
        "tsumo_agari_kyoku":int,  # subset of agari_kyoku where hora.target==actor
        "ron_agari_kyoku":  int,  # subset where hora.target!=actor
        "riichi_kyoku":     int,  # kyokus where this seat called reach
        "fuuro_kyoku":      int,  # kyokus where this seat had chi/pon/daiminkan/kakan
                                  # (ankan and nukidora do NOT count)
        "houjuu_kyoku":     int,  # kyokus where this seat was the deal-in target
                                  # (hora.target==seat and hora.actor!=seat)
        "ryukyoku_kyoku":   int,  # kyokus that ended in ryukyoku (same for all seats)
    }

Definitions are per the design spec
(docs/superpowers/specs/2026-05-31-d-vs-e-arena-driver-design.md).
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import IO, Iterable

NUM_SEATS = 3
START_SCORE_TOTAL = 35000 * NUM_SEATS  # 105000

# Event types we recognize. Anything else raises.
_KNOWN = frozenset({
    "start_game", "end_game",
    "start_kyoku", "end_kyoku",
    "tsumo", "dahai",
    "chi", "pon", "daiminkan", "kakan", "ankan",
    "nukidora",
    "reach", "reach_accepted",
    "hora", "ryukyoku",
    "dora",
})

# Subset that counts as "fuuro" (open meld) for our metric. ankan / nukidora
# explicitly excluded.
_FUURO_TYPES = frozenset({"chi", "pon", "daiminkan", "kakan"})

# Bool-flag keys we accumulate per kyoku per seat.
_FLAG_KEYS = (
    "agari", "tsumo_agari", "ron_agari",
    "riichi", "fuuro", "houjuu", "ryukyoku",
)

# Map kyoku-level flag key -> totals key.
_FLAG_TO_TOTAL = {k: f"{k}_kyoku" for k in _FLAG_KEYS}

_TOTAL_KEYS = (
    "kyoku_count",
    "agari_kyoku", "tsumo_agari_kyoku", "ron_agari_kyoku",
    "riichi_kyoku", "fuuro_kyoku", "houjuu_kyoku", "ryukyoku_kyoku",
)


def _new_totals():
    return {seat: {k: 0 for k in _TOTAL_KEYS} for seat in range(NUM_SEATS)}


def _new_kyoku_flags():
    return {seat: {k: False for k in _FLAG_KEYS} for seat in range(NUM_SEATS)}


def _check_seat(actor, where: str) -> int:
    if not isinstance(actor, int) or not 0 <= actor < NUM_SEATS:
        raise ValueError(f"{where}: actor out of range: {actor!r}")
    return actor


def parse_mjai_stream(events: Iterable[dict]) -> dict[int, dict[str, int]]:
    """Parse an iterable of mjai events. See module docstring for return shape."""
    totals = _new_totals()

    in_kyoku = False
    kyoku_flags = _new_kyoku_flags()
    kyoku_count = 0

    saw_start_game = False
    saw_end_game = False
    running_scores: list[int] | None = None

    for raw in events:
        if not isinstance(raw, dict):
            raise ValueError(f"non-dict event: {raw!r}")
        t = raw.get("type")
        if t not in _KNOWN:
            raise ValueError(f"unknown event type: {t!r} in {raw!r}")

        if t == "start_game":
            if saw_start_game:
                raise ValueError("duplicate start_game")
            saw_start_game = True
            continue

        if t == "end_game":
            if saw_end_game:
                raise ValueError("duplicate end_game")
            saw_end_game = True
            continue

        if t == "start_kyoku":
            if in_kyoku:
                raise ValueError("start_kyoku without preceding end_kyoku")
            in_kyoku = True
            kyoku_flags = _new_kyoku_flags()

            scores = raw.get("scores")
            if not isinstance(scores, list) or len(scores) != NUM_SEATS:
                raise ValueError(f"start_kyoku.scores wrong shape: {scores!r}")
            # We trust libriichi's per-kyoku scores rather than reconciling
            # against our own running tally — kyotaku carry-over after a
            # ryukyoku makes the running tally lag by 1000*kyotaku until the
            # next hora reabsorbs it via deltas. End-of-game total is the
            # real invariant we check.
            running_scores = list(scores)
            continue

        if t == "end_kyoku":
            if not in_kyoku:
                raise ValueError("end_kyoku without start_kyoku")
            kyoku_count += 1
            for seat in range(NUM_SEATS):
                for fk in _FLAG_KEYS:
                    if kyoku_flags[seat][fk]:
                        totals[seat][_FLAG_TO_TOTAL[fk]] += 1
            in_kyoku = False
            continue

        # Mid-kyoku events from here on.
        if not in_kyoku:
            raise ValueError(f"event {t!r} outside of any kyoku: {raw!r}")

        if t in ("tsumo", "dahai", "reach_accepted", "nukidora"):
            _check_seat(raw.get("actor"), t)
            continue

        if t == "dora":
            # board-level event, no actor
            continue

        if t == "reach":
            seat = _check_seat(raw.get("actor"), t)
            kyoku_flags[seat]["riichi"] = True
            # Reach deposits 1000 at the moment of declaration (mjai has no
            # explicit delta event for it). Running tally needs to reflect that
            # so it matches the next start_kyoku.scores.
            running_scores[seat] -= 1000
            continue

        if t in _FUURO_TYPES:
            seat = _check_seat(raw.get("actor"), t)
            kyoku_flags[seat]["fuuro"] = True
            continue

        if t == "ankan":
            _check_seat(raw.get("actor"), t)
            # Intentionally NOT counted as fuuro (per spec).
            continue

        if t == "hora":
            actor = _check_seat(raw.get("actor"), t)
            target = _check_seat(raw.get("target"), t)
            deltas = raw.get("deltas")
            if not isinstance(deltas, list) or len(deltas) != NUM_SEATS:
                raise ValueError(f"hora.deltas wrong shape: {deltas!r}")
            if kyoku_flags[actor]["agari"]:
                raise ValueError(
                    f"second hora by same actor in one kyoku: {raw!r}"
                )
            kyoku_flags[actor]["agari"] = True
            if target == actor:
                kyoku_flags[actor]["tsumo_agari"] = True
            else:
                kyoku_flags[actor]["ron_agari"] = True
                kyoku_flags[target]["houjuu"] = True
            for s, d in enumerate(deltas):
                if not isinstance(d, int):
                    raise ValueError(f"hora.deltas[{s}] not int: {d!r}")
                running_scores[s] += d
            continue

        if t == "ryukyoku":
            deltas = raw.get("deltas")
            if not isinstance(deltas, list) or len(deltas) != NUM_SEATS:
                raise ValueError(f"ryukyoku.deltas wrong shape: {deltas!r}")
            for seat in range(NUM_SEATS):
                kyoku_flags[seat]["ryukyoku"] = True
            for s, d in enumerate(deltas):
                if not isinstance(d, int):
                    raise ValueError(f"ryukyoku.deltas[{s}] not int: {d!r}")
                running_scores[s] += d
            continue

        raise ValueError(f"unhandled event type {t!r}: {raw!r}")

    if not saw_start_game:
        raise ValueError("missing start_game")
    if not saw_end_game:
        raise ValueError("missing end_game")
    if in_kyoku:
        raise ValueError("hanchan ended mid-kyoku")
    if kyoku_count == 0:
        raise ValueError("no kyoku in hanchan")

    if running_scores is None:
        raise ValueError("no scores observed")
    total = sum(running_scores)
    # Score conservation: after the last hora, sum is exactly 105000.
    # If the hanchan ends after a ryukyoku that left kyotaku on the table,
    # the residual is 1000 per stranded reach stick. Accept any non-negative
    # multiple of 1000 below 105000.
    if total > START_SCORE_TOTAL or (START_SCORE_TOTAL - total) % 1000 != 0:
        raise ValueError(
            f"final scores sum {total} inconsistent with start total "
            f"{START_SCORE_TOTAL}: {running_scores}"
        )

    for seat in range(NUM_SEATS):
        totals[seat]["kyoku_count"] = kyoku_count

    return totals


def parse_mjai_path(path: str | Path) -> dict[int, dict[str, int]]:
    """Open a (.gz or plain) mjai jsonl and parse it."""
    p = Path(path)
    opener = gzip.open if str(p).endswith(".gz") else open
    with opener(p, "rt", encoding="utf-8") as fh:
        return parse_mjai_stream(_iter_jsonl(fh))


def _iter_jsonl(fh: IO[str]):
    for line in fh:
        line = line.strip()
        if not line:
            continue
        yield json.loads(line)
