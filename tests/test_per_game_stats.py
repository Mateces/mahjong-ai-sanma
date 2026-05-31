"""Tests for per_game_stats.parse_mjai_stream.

Run with: python -m pytest tests/test_per_game_stats.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from per_game_stats import parse_mjai_stream  # noqa: E402


def _start():
    return [
        {"type": "start_game", "names": ["x", "x", "x"], "seed": [1, 2]},
    ]


def _end():
    return [{"type": "end_game"}]


def _kyoku(events: list[dict], scores=None) -> list[dict]:
    """Wrap mid-kyoku events with start_kyoku / end_kyoku.

    Caller passes `scores` only on the first kyoku; later kyoku scores must
    match the running tally (we just echo the previous kyoku's tally).
    """
    if scores is None:
        scores = [35000, 35000, 35000]
    return [
        {"type": "start_kyoku", "bakaze": "E", "dora_marker": "9p",
         "kyoku": 1, "honba": 0, "kyotaku": 0, "oya": 0,
         "scores": list(scores), "tehais": [["?"]*13]*3},
        *events,
        {"type": "end_kyoku"},
    ]


def _hanchan(*kyoku_blocks: list[dict]) -> list[dict]:
    out = list(_start())
    for b in kyoku_blocks:
        out.extend(b)
    out.extend(_end())
    return out


# --- 1. tsumo agari ---------------------------------------------------------


def test_tsumo_agari():
    """Seat 0 self-draw wins for 12000 points (oya)."""
    events = _hanchan(
        _kyoku(
            [
                {"type": "tsumo", "actor": 0, "pai": "1m"},
                {"type": "hora", "actor": 0, "target": 0,
                 "deltas": [12000, -6000, -6000]},
            ],
        ),
    )
    out = parse_mjai_stream(iter(events))
    assert out[0]["agari_kyoku"] == 1
    assert out[0]["tsumo_agari_kyoku"] == 1
    assert out[0]["ron_agari_kyoku"] == 0
    assert out[0]["houjuu_kyoku"] == 0
    assert out[1]["agari_kyoku"] == 0
    assert out[1]["houjuu_kyoku"] == 0
    assert out[2]["agari_kyoku"] == 0
    assert out[2]["houjuu_kyoku"] == 0
    assert out[0]["kyoku_count"] == 1


# --- 2. ron agari -----------------------------------------------------------


def test_ron_agari():
    """Seat 2 wins by ron, dealing in from seat 0."""
    events = _hanchan(
        _kyoku(
            [
                {"type": "dahai", "actor": 0, "pai": "5m", "tsumogiri": False},
                {"type": "hora", "actor": 2, "target": 0,
                 "deltas": [-8000, 0, 8000]},
            ],
        ),
    )
    out = parse_mjai_stream(iter(events))
    assert out[2]["agari_kyoku"] == 1
    assert out[2]["ron_agari_kyoku"] == 1
    assert out[2]["tsumo_agari_kyoku"] == 0
    assert out[0]["houjuu_kyoku"] == 1
    assert out[1]["houjuu_kyoku"] == 0
    assert out[1]["agari_kyoku"] == 0


# --- 3. ryukyoku ------------------------------------------------------------


def test_ryukyoku():
    """Single ryukyoku, all 3 seats counted."""
    events = _hanchan(
        _kyoku(
            [
                {"type": "ryukyoku", "deltas": [1000, -500, -500]},
            ],
        ),
    )
    out = parse_mjai_stream(iter(events))
    for seat in range(3):
        assert out[seat]["ryukyoku_kyoku"] == 1
        assert out[seat]["agari_kyoku"] == 0
        assert out[seat]["houjuu_kyoku"] == 0


# --- 4a. fuuro positive (chi/pon/daiminkan/kakan all count) -----------------


@pytest.mark.parametrize("ev_type", ["chi", "pon", "daiminkan", "kakan"])
def test_fuuro_positive(ev_type):
    extra = {}
    if ev_type in ("chi", "pon", "daiminkan"):
        extra = {"target": 0, "pai": "5m", "consumed": ["5m", "5m"]}
    elif ev_type == "kakan":
        extra = {"pai": "5m", "consumed": ["5m", "5m", "5m"]}
    events = _hanchan(
        _kyoku(
            [
                {"type": ev_type, "actor": 1, **extra},
                {"type": "ryukyoku", "deltas": [0, 0, 0]},
            ],
        ),
    )
    out = parse_mjai_stream(iter(events))
    assert out[1]["fuuro_kyoku"] == 1, f"{ev_type} should count as fuuro"
    assert out[0]["fuuro_kyoku"] == 0
    assert out[2]["fuuro_kyoku"] == 0


# --- 4b. fuuro negative: ankan and nukidora must NOT count ------------------


def test_ankan_and_nukidora_not_fuuro():
    events = _hanchan(
        _kyoku(
            [
                {"type": "ankan", "actor": 1,
                 "consumed": ["9p", "9p", "9p", "9p"]},
                {"type": "nukidora", "actor": 1, "pai": "N"},
                {"type": "ryukyoku", "deltas": [0, 0, 0]},
            ],
        ),
    )
    out = parse_mjai_stream(iter(events))
    assert out[1]["fuuro_kyoku"] == 0, "ankan + nukidora alone is NOT fuuro"


# --- 5. multi-kyoku accumulation --------------------------------------------


def test_multi_kyoku_accumulation():
    """Hanchan with 3 kyoku. seat 0: kyoku 1 reach, kyoku 3 hora; seat 1: kyoku 2 fuuro."""
    events = list(_start())
    events += _kyoku(
        [
            {"type": "reach", "actor": 0},
            {"type": "reach_accepted", "actor": 0},
            {"type": "ryukyoku", "deltas": [0, 0, 0]},
        ],
    )
    events += _kyoku(
        [
            {"type": "pon", "actor": 1, "target": 0, "pai": "5m",
             "consumed": ["5m", "5m"]},
            {"type": "ryukyoku", "deltas": [0, 0, 0]},
        ],
    )
    events += _kyoku(
        [
            {"type": "hora", "actor": 0, "target": 2,
             "deltas": [8000, 0, -8000]},
        ],
    )
    events += _end()
    out = parse_mjai_stream(iter(events))
    assert out[0]["kyoku_count"] == 3
    assert out[0]["riichi_kyoku"] == 1
    assert out[0]["agari_kyoku"] == 1
    assert out[0]["ron_agari_kyoku"] == 1
    assert out[0]["fuuro_kyoku"] == 0
    assert out[0]["ryukyoku_kyoku"] == 2
    assert out[1]["fuuro_kyoku"] == 1
    assert out[1]["ryukyoku_kyoku"] == 2
    assert out[1]["agari_kyoku"] == 0
    assert out[2]["houjuu_kyoku"] == 1
    assert out[2]["ryukyoku_kyoku"] == 2


# --- 6. unknown event type → raise ------------------------------------------


def test_unknown_event_raises():
    events = list(_start())
    events += _kyoku(
        [
            {"type": "weird_unknown", "actor": 0},
        ],
    )
    events += _end()
    with pytest.raises(ValueError, match="unknown event type"):
        parse_mjai_stream(iter(events))


# --- 7. score conservation --------------------------------------------------


def test_score_conservation_violation_raises():
    """Final scores summing to ≠ 105000 (and not a multiple-of-1000 deficit
    consistent with stranded reach sticks) must raise."""
    events = _hanchan(
        _kyoku(
            [
                # deltas off by 250 — not a kyotaku-carry pattern
                {"type": "hora", "actor": 0, "target": 0,
                 "deltas": [4250, -1000, -3000]},
            ],
        ),
    )
    with pytest.raises(ValueError, match="inconsistent"):
        parse_mjai_stream(iter(events))


def test_score_above_total_raises():
    """Sum > 105000 must raise even if it's a multiple of 1000."""
    events = _hanchan(
        _kyoku(
            [
                {"type": "hora", "actor": 0, "target": 0,
                 "deltas": [10000, -3000, -3000]},  # sums to +4000
            ],
        ),
    )
    with pytest.raises(ValueError, match="inconsistent"):
        parse_mjai_stream(iter(events))


# --- 8. double agari by same actor in one kyoku → raise ---------------------


def test_double_agari_same_actor_raises():
    events = _hanchan(
        _kyoku(
            [
                {"type": "hora", "actor": 0, "target": 1,
                 "deltas": [4000, -4000, 0]},
                {"type": "hora", "actor": 0, "target": 2,
                 "deltas": [4000, 0, -4000]},
            ],
        ),
    )
    with pytest.raises(ValueError, match="second hora by same actor"):
        parse_mjai_stream(iter(events))


# --- 9. hora outside kyoku → raise ------------------------------------------


def test_event_outside_kyoku_raises():
    events = list(_start())
    events += [
        {"type": "hora", "actor": 0, "target": 0,
         "deltas": [12000, -6000, -6000]},
    ]
    events += _end()
    with pytest.raises(ValueError, match="outside of any kyoku"):
        parse_mjai_stream(iter(events))


# --- 10. hanchan with no kyoku → raise --------------------------------------


def test_no_kyoku_raises():
    events = list(_start()) + list(_end())
    with pytest.raises(ValueError, match="no kyoku"):
        parse_mjai_stream(iter(events))


# --- 11. mid-kyoku end_game → raise -----------------------------------------


def test_end_game_mid_kyoku_raises():
    events = list(_start())
    events += [
        {"type": "start_kyoku", "bakaze": "E", "dora_marker": "9p",
         "kyoku": 1, "honba": 0, "kyotaku": 0, "oya": 0,
         "scores": [35000, 35000, 35000], "tehais": [["?"]*13]*3},
    ]
    events += list(_end())
    with pytest.raises(ValueError, match="ended mid-kyoku"):
        parse_mjai_stream(iter(events))
