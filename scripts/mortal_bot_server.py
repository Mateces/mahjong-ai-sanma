"""MJAI-protocol bot server for our trained main model.

Used by the TS engine's MortalBridge Strategy: stdin = MJAI events (one JSON
per line), stdout = bot reactions (one JSON per line). Same shape as Mortal's
`mortal/mortal/mortal.py` but loads our checkpoint format and doesn't depend
on a config.toml on disk.

Protocol:
    First line (handshake): {"type": "setup", "player_id": 0..3,
                             "checkpoint": "/abs/path/to/main-best.pth"}
    Subsequent lines: MJAI events. The bot consumes each and emits its action
    when its turn comes; otherwise emits {"type": "none"} so the TS side has
    a definite signal that we processed the event.

Usage (manual debug):
    python scripts/mortal_bot_server.py
    > {"type":"setup","player_id":0,"checkpoint":"checkpoints/main-best.pth"}
    < {"type":"ready"}
    > {"type":"start_game","names":["p0","p1","p2","p3"]}
    < {"type":"none"}
    ...
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parent.parent
# In yonma layout, mortal package lives at mortal/mortal/. In sanma layout
# (this repo), it's flattened to mortal/. Support both.
_yonma_path = ROOT / "mortal" / "mortal"
sys.path.insert(0, str(_yonma_path if _yonma_path.is_dir() else ROOT / "mortal"))

_stub = types.ModuleType("config")
_stub.config = {}
sys.modules["config"] = _stub

from engine import MortalEngine  # noqa: E402
from libriichi.mjai import Bot  # noqa: E402
from model import Brain, DQN  # noqa: E402


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> None:
    # Handshake
    first = sys.stdin.readline().strip()
    setup = json.loads(first)
    if setup.get("type") != "setup":
        emit({"type": "error", "msg": f"expected setup, got {setup}"})
        sys.exit(1)
    player_id = int(setup["player_id"])
    ckpt_path = setup["checkpoint"]
    device_name = setup.get("device", "cpu")

    state = torch.load(ckpt_path, weights_only=False, map_location="cpu")
    hp = state.get("hyperparams", {})
    # Support both hyperparams (train_main.py) and config (mortal/train.py) formats
    if not hp and "config" in state:
        cfg = state["config"]
        hp = {
            "version": cfg.get("control", {}).get("version", 4),
            "conv_channels": cfg.get("resnet", {}).get("conv_channels", 192),
            "num_blocks": cfg.get("resnet", {}).get("num_blocks", 40),
        }
    version = hp.get("version", 4)
    conv = hp.get("conv_channels", 128)
    blocks = hp.get("num_blocks", 20)

    device = torch.device(device_name)
    brain = Brain(version=version, conv_channels=conv, num_blocks=blocks).eval()
    dqn = DQN(version=version).eval()
    brain.load_state_dict(state["mortal"])
    dqn.load_state_dict(state["current_dqn"])

    engine = MortalEngine(
        brain, dqn,
        is_oracle=False,
        version=version,
        device=device,
        enable_amp=False,
        # quick_eval triggers libriichi's candidate-tile EV table at
        # obs_repr.rs:595 which panics on `.unwrap()` for certain hand
        # configurations encountered through our state-diff event stream.
        # Disable for stability; we lose a small inference speedup.
        enable_quick_eval=False,
        enable_rule_based_agari_guard=True,
        name="mortal",
    )
    bot = Bot(engine, player_id)
    emit({"type": "ready"})

    # Event loop
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        # Handle seat reassignment (SHUFFLE_SEATS support)
        if '"re_setup"' in line:
            msg = json.loads(line)
            if msg.get("type") == "re_setup":
                bot = Bot(engine, int(msg["player_id"]))
                emit({"type": "ready"})
                continue
        try:
            reaction = bot.react(line)
        except BaseException as e:  # noqa: BLE001 -- pyo3 PanicException
            # pyo3's PanicException inherits from BaseException, not Exception,
            # so we have to use BaseException to catch Rust-side panics. After
            # a panic the libriichi state is corrupted; we report the error
            # and return a no-op so the game loop can continue. The bridge
            # logs the error and proceeds with a default fallback action.
            emit({"type": "error", "msg": f"{type(e).__name__}: {e}", "event": line})
            continue
        if reaction:
            # `reaction` is already a JSON string
            sys.stdout.write(reaction + "\n")
            sys.stdout.flush()
        else:
            emit({"type": "none"})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
