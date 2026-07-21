"""Shared utilities for the CQL/agari diagnostic scripts.

Kept in a separate module so `diagnose_cql_agari.py` stays readable and so
future Tier-2/3 diagnostics can reuse the same plumbing.

Three concerns, three helpers:

  * `load_model`           — build Brain + DQN from a sanma checkpoint.
  * `replay_to_obs`        — replay an mjai log through libriichi's
                             `PlayerState` to reconstruct the (obs, mask)
                             that the model saw at event `ev_idx`.
  * `scan_missed_agari`    — walk an arena `mjai/` directory and return
                             events where the mask contained the agari
                             bit but the model did not pick `hora`.

The forward pass itself is intentionally NOT hidden behind a helper — every
experiment needs slightly different access to the internals (raw v, raw a,
masked q, softmax, ...), so we keep that code inline in the diagnostic
scripts.

Run via the project's uv env:

    uv run --no-project --with torch --with numpy \\
        python3.12 scripts/diagnose_cql_agari.py
"""

from __future__ import annotations

import gzip
import json
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

import numpy as np

# ---- libriichi + mortal bootstrap ------------------------------------------

# `model.py` does a top-level `from libriichi import consts`. We need both
# the rust ext (libriichi.so) and the python source on sys.path. Both live
# under mortal/.
_MORTAL_DIR = Path(__file__).resolve().parent.parent / "mortal"
if str(_MORTAL_DIR) not in sys.path:
    sys.path.insert(0, str(_MORTAL_DIR))

# `model.py` also imports `config` on yonma; sanma tree doesn't, but
# pre-stub so a transitive import doesn't blow up looking for config.toml.
if "config" not in sys.modules:
    _stub = types.ModuleType("config")
    _stub.config = {}
    sys.modules["config"] = _stub

import libriichi  # noqa: E402  (after sys.path setup above)
import torch  # noqa: E402

# Action layout (sanma v5, from libriichi/src/consts.rs):
#   0..36 = discard (34 plain + aka slots, mirroring yonma layout)
#   37    = riichi
#   38    = nukidora
#   39    = pon
#   40    = kan (decide)
#   41    = agari (ron or tsumo)
#   42    = ryukyoku
#   43    = pass
ACTION_SPACE = libriichi.consts.ACTION_SPACE  # 44
AGARI_ACTION = 41
AGARI_BIT = 1 << AGARI_ACTION

# 34-tile index → string (1m=0 .. 9m=8, 1p=9 .. 9p=17, 1s=18 .. 9s=26,
# E/S/W/N=27..30, P/F/C=31..33). Useful for readable reports.
_TILE_NAMES = (
    [f"{n}{m}" for m in "mps" for n in "123456789"][:27]
    + ["1s", "2s", "3s", "4s", "5s", "6s", "7s", "8s", "9s"]
)[:34]
# Build it properly: indices 0..8 = 1m..9m, 9..17 = 1p..9p, 18..26 = 1s..9s,
# 27..33 = E,S,W,N,P,F,C (白/發/中 in Mortal notation use P=white, F=green,
# C=red — matching the arena-log "P","F","C" usage).
_TILE_NAMES = (
    [f"{n}m" for n in "123456789"]
    + [f"{n}p" for n in "123456789"]
    + [f"{n}s" for n in "123456789"]
    + list("ESWNPFC")
)


def action_label(idx: int) -> str:
    """Human-readable label for an action index."""
    if idx < 34:
        return f"discard {_TILE_NAMES[idx]}"
    if idx < 37:
        return f"discard_aka slot {idx}"
    return {
        37: "riichi",
        38: "nukidora",
        39: "pon",
        40: "kan",
        41: "agari",
        42: "ryukyoku",
        43: "pass",
    }.get(idx, f"action_{idx}")


# ---- model loading ---------------------------------------------------------


@dataclass
class ModelHandle:
    brain: "torch.nn.Module"
    dqn: "torch.nn.Module"
    version: int
    conv_channels: int
    num_blocks: int
    min_q_weight: float
    hyperparams: dict


def load_model(ckpt_path: Path | str, device: str = "cpu") -> ModelHandle:
    """Build Brain + DQN from a sanma checkpoint and load weights.

    Mirrors the loader in arena_self_play.py: hyperparams come from
    `state["hyperparams"]` (sanma) and the dqn uses version 5's flat
    `nn.Linear(1024, 1 + ACTION_SPACE)` layout.
    """
    ckpt_path = Path(ckpt_path)
    state = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    if "hyperparams" not in state:
        raise KeyError(
            f"checkpoint {ckpt_path} has no 'hyperparams' — sanma training "
            "script always writes this; refusing to guess model shape"
        )
    hp = state["hyperparams"]
    version = int(hp.get("version", 1))
    conv_channels = int(hp["conv_channels"])
    num_blocks = int(hp["num_blocks"])

    # Import here so sys.path / config stub above is in effect.
    from model import Brain, DQN

    brain = Brain(
        version=version,
        conv_channels=conv_channels,
        num_blocks=num_blocks,
    ).to(device).eval()
    dqn = DQN(version=version).to(device).eval()
    brain.load_state_dict(state["mortal"])
    dqn.load_state_dict(state["current_dqn"])

    # Brain uses BatchNorm1d; in eval mode it uses running stats, so we don't
    # need to freeze anything explicitly. But make sure we ARE in eval mode.
    brain.eval()
    dqn.eval()

    return ModelHandle(
        brain=brain,
        dqn=dqn,
        version=version,
        conv_channels=conv_channels,
        num_blocks=num_blocks,
        min_q_weight=float(hp.get("min_q_weight", 5.0)),
        hyperparams=hp,
    )


# ---- obs reconstruction ----------------------------------------------------


@dataclass
class ReplayResult:
    obs: np.ndarray      # (C, 34) float32
    mask: np.ndarray     # (ACTION_SPACE,) bool
    state: object        # libriichi.state.PlayerState (for shanten etc.)
    event: dict          # the target mjai event
    actor: int           # player id of the actor
    event_index: int


def replay_to_obs(
    mjai_path: Path | str,
    ev_idx: int,
    version: int = 5,
) -> ReplayResult:
    """Replay `mjai_path` up to (but not including) event `ev_idx`, then
    encode_obs() to get the (obs, mask) the model saw when picking that
    event's action.

    The event at `ev_idx` is the model's action (dahai/reach/hora/etc.).
    All events before it must be the cause (tsumo, opponent dahai, ...).
    The actor for the target event is taken from event['actor'].
    """
    mjai_path = Path(mjai_path)
    if mjai_path.suffix == ".gz":
        opener = lambda p: gzip.open(p, "rt")
    else:
        opener = lambda p: open(p, "rt")
    with opener(mjai_path) as f:
        events = [json.loads(line) for line in f if line.strip()]

    if ev_idx >= len(events):
        raise IndexError(f"ev_idx {ev_idx} out of range (file has {len(events)} events)")

    target = events[ev_idx]
    if "actor" not in target:
        raise ValueError(
            f"event {ev_idx} has no 'actor' field (type={target.get('type')}); "
            "cannot determine which player's POV to replay from"
        )
    actor = int(target["actor"])

    ps = libriichi.state.PlayerState(actor)
    for ev in events[:ev_idx]:
        ps.update(json.dumps(ev, ensure_ascii=False))

    obs, mask = ps.encode_obs(version, False)
    obs = np.ascontiguousarray(np.asarray(obs, dtype=np.float32))
    mask = np.ascontiguousarray(np.asarray(mask, dtype=bool))
    return ReplayResult(
        obs=obs,
        mask=mask,
        state=ps,
        event=target,
        actor=actor,
        event_index=ev_idx,
    )


# ---- missed-agari scanner --------------------------------------------------


@dataclass
class MissedAgariCase:
    path: Path
    event_index: int
    event_type: str
    actor: int
    pai: Optional[str]
    mask_bits: int
    q_values: list  # the q_values logged in meta, in compact (masked-only) order
    chosen_action: int  # decoded action index (e.g. discard 9s = 26)


def _decode_action_from_event(ev: dict) -> Optional[int]:
    """Best-effort: turn an mjai action event into the 44-d action index
    that produced it. Used so we can label `chosen_action` for cases
    discovered by the scanner. Returns None if not decodable here."""
    t = ev.get("type")
    if t == "dahai":
        pai = ev.get("pai")
        idx = _pai_to_discard_idx(pai)
        return idx
    if t == "hora":
        return AGARI_ACTION
    if t == "reach":
        return 37
    if t == "nukidora":
        return 38
    if t == "pon":
        return 39
    if t == "none":
        return 43
    return None


# 34-tile plain-name → index. Note: arena logs sometimes use "5sr"/"5pr" for
# red dors; for discard indices 34/35/36 we'd need aka info. For diagnostic
# labeling we fall back to the plain 0..33 mapping and only use it for the
# chosen_action field.
_PAI_TO_IDX = {}
for _i, _n in enumerate(_TILE_NAMES):
    _PAI_TO_IDX[_n] = _i


def _pai_to_discard_idx(pai: Optional[str]) -> Optional[int]:
    if pai is None:
        return None
    # strip red-dora suffix
    plain = pai.rstrip("rR")
    return _PAI_TO_IDX.get(plain)


def scan_missed_agari(
    arena_dir: Path | str,
    *,
    require_meta: bool = True,
) -> list[MissedAgariCase]:
    """Walk an arena `mjai/` directory and return every event whose mask
    contained the agari bit (1 << 41) but whose action was not `hora`.

    `require_meta=True` only returns events with a populated `meta` (so we
    have the q_values the model produced at decision time). Set False to
    also pick up events whose mask we'd need to recompute by replay.
    """
    arena_dir = Path(arena_dir)
    files = sorted(arena_dir.glob("*.json.gz")) + sorted(arena_dir.glob("*.json"))
    out: list[MissedAgariCase] = []
    for fp in files:
        opener = gzip.open if fp.suffix == ".gz" else open
        try:
            with opener(fp, "rt") as f:
                events = [json.loads(line) for line in f if line.strip()]
        except Exception:
            continue
        for i, ev in enumerate(events):
            if not isinstance(ev, dict):
                continue
            meta = ev.get("meta")
            if require_meta and not meta:
                continue
            if not meta:
                # without meta we cannot know the mask without replaying —
                # skip; if you need this case, call replay_to_obs yourself.
                continue
            mb = int(meta.get("mask_bits", 0))
            if not (mb & AGARI_BIT):
                continue
            if ev.get("type") == "hora":
                continue  # agari picked, not a miss
            out.append(MissedAgariCase(
                path=fp,
                event_index=i,
                event_type=ev.get("type"),
                actor=int(ev.get("actor", -1)),
                pai=ev.get("pai"),
                mask_bits=mb,
                q_values=list(meta.get("q_values", [])),
                chosen_action=_decode_action_from_event(ev) or -1,
            ))
    return out


def mask_bits_to_indices(mask_bits: int) -> list[int]:
    """Decode the packed bitmask the arena stores in `meta.mask_bits` into
    a list of action indices."""
    return [i for i in range(ACTION_SPACE) if mask_bits & (1 << i)]


# ---- torch forward helpers -------------------------------------------------


def to_torch(obs: np.ndarray, mask: np.ndarray, device: str = "cpu"):
    """Convert (C,34) obs + (ACTION_SPACE,) mask to batched torch tensors."""
    obs_t = torch.from_numpy(obs).unsqueeze(0).to(device).float()
    mask_t = torch.from_numpy(mask).unsqueeze(0).to(device)
    return obs_t, mask_t


__all__ = [
    "ACTION_SPACE",
    "AGARI_ACTION",
    "AGARI_BIT",
    "ModelHandle",
    "ReplayResult",
    "MissedAgariCase",
    "action_label",
    "load_model",
    "replay_to_obs",
    "scan_missed_agari",
    "mask_bits_to_indices",
    "to_torch",
]
