"""MJAI bot server for the Akagi sanma baseline (`bot_3p.zip` / `bot_3p_0.1.1.zip`).

Same wire protocol as `mortal_bot_server.py` — first line is `{"type":"setup",
"player_id":0..2, "akagi_pkg":"/path/to/extracted/bot_3p"}`, subsequent lines
are MJAI events. We translate sanma (3-seat) MJAI <-> Akagi's quirky 4-seat
MJAI on the fly: Akagi keeps a yonma-shaped envelope (`names` length 4,
`scores` length 4, `tehais` length 4) but the model + state machine are
genuine sanma (ACTION_SPACE=44 with nukidora at 38, obs v4 = 775ch).

We do NOT swallow any exceptions silently — full tracebacks go to stderr
and the line `{"type":"error","msg":...,"event":...}` is emitted on stdout
so the caller has a definite signal we choked on something.

Usage (manual debug):
    python scripts/akagi_bot_server.py
    > {"type":"setup","player_id":0,"akagi_pkg":"/tmp/sanma-bot-test/bot_big"}
    < {"type":"ready"}
    > {"type":"start_game","names":["A","B","C"]}
    < {"type":"none"}
    ...
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import platform
import sys
import traceback
import types
from pathlib import Path


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def err(msg, event=None):
    payload = {"type": "error", "msg": msg}
    if event is not None:
        payload["event"] = event
    emit(payload)


def _pick_so(pkg_dir: Path) -> tuple[Path, str]:
    """Pick the right .so for this Python+arch and return (path, module_name)."""
    py = sys.version_info
    if py < (3, 10) or py >= (3, 13):
        raise RuntimeError(
            f"Akagi bundle ships only py3.10–3.12; this is {py.major}.{py.minor}"
        )
    sys_name = platform.system()
    if sys_name == "Darwin":
        triple = "aarch64-apple-darwin" if platform.machine() in ("arm64", "aarch64") else "x86_64-apple-darwin"
        ext = "so"
    elif sys_name == "Linux":
        triple = "x86_64-unknown-linux-gnu"
        ext = "so"
    elif sys_name == "Windows":
        triple = "x86_64-pc-windows-msvc"
        ext = "pyd"
    else:
        raise RuntimeError(f"unsupported platform {sys_name}")

    # Big bundle uses prefix `libriichi-`, small bundle uses `libriichi3p-`.
    for stem, mod in (("libriichi", "libriichi"), ("libriichi3p", "libriichi3p")):
        candidate = pkg_dir / f"{stem}-{py.major}.{py.minor}-{triple}.{ext}"
        if candidate.is_file():
            return candidate, mod
    raise FileNotFoundError(
        f"no Akagi .so found in {pkg_dir} for py{py.major}.{py.minor}/{triple}"
    )


def _load_libriichi(pkg_dir: Path):
    """Load the bundled .so as a top-level module and alias it to `libriichi`."""
    so_path, mod_name = _pick_so(pkg_dir)
    spec = importlib.util.spec_from_file_location(mod_name, so_path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)

    # Expose under `libriichi` so Akagi's model.py relative imports work after
    # we rewrite them to absolute.
    sys.modules["libriichi"] = mod
    for sub in ("mjai", "consts", "state", "arena", "dataset", "stat"):
        s = getattr(mod, sub, None)
        if s is not None:
            sys.modules[f"libriichi.{sub}"] = s
    return mod


def _load_akagi_model(pkg_dir: Path) -> types.ModuleType:
    """Load Akagi's `model.py` after rewriting `from .libriichi` -> `from libriichi`."""
    src = (pkg_dir / "model.py").read_text().replace("from .libriichi", "from libriichi")
    mod = types.ModuleType("akagi_model")
    exec(compile(src, str(pkg_dir / "model.py"), "exec"), mod.__dict__)
    sys.modules["akagi_model"] = mod
    return mod


def _build_engine(pkg_dir: Path, akagi_model: types.ModuleType, device_name: str):
    import torch

    state = torch.load(pkg_dir / "mortal.pth", map_location="cpu", weights_only=False)
    cfg = state["config"]
    version = cfg["control"]["version"]

    brain = akagi_model.Brain(
        version=version,
        conv_channels=cfg["resnet"]["conv_channels"],
        num_blocks=cfg["resnet"]["num_blocks"],
    ).eval()
    dqn = akagi_model.DQN(version=version).eval()
    brain.load_state_dict(state["mortal"])
    dqn.load_state_dict(state["current_dqn"])

    device = torch.device(device_name)
    return akagi_model.MortalEngine(
        brain, dqn,
        is_oracle=False,
        version=version,
        device=device,
        enable_amp=False,
        enable_quick_eval=False,
        enable_rule_based_agari_guard=True,
        name="akagi",
    )


# ---- 3-seat <-> 4-seat MJAI translation ------------------------------------

def _to_yonma(event: dict) -> dict:
    """Pad a sanma MJAI event into Akagi's yonma-shaped envelope."""
    et = event.get("type")
    if et == "start_game":
        names = list(event.get("names", []))
        while len(names) < 4:
            names.append(f"dummy_{len(names)}")
        event = {**event, "names": names[:4]}
    elif et == "start_kyoku":
        scores = list(event.get("scores", []))
        while len(scores) < 4:
            scores.append(0)
        tehais = [list(h) for h in event.get("tehais", [])]
        while len(tehais) < 4:
            tehais.append(["?"] * 13)
        event = {**event, "scores": scores[:4], "tehais": tehais[:4]}
    return event


def _to_sanma(reaction_str: str) -> str:
    """Akagi already emits sanma-legal reactions; nothing to strip."""
    return reaction_str


# ---- Main loop --------------------------------------------------------------

def main() -> None:
    first = sys.stdin.readline().strip()
    if not first:
        err("empty stdin before setup")
        sys.exit(1)
    try:
        setup = json.loads(first)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        err(f"setup parse: {type(e).__name__}: {e}", event=first)
        sys.exit(1)
    if setup.get("type") != "setup":
        err(f"expected setup, got {setup}")
        sys.exit(1)

    player_id = int(setup["player_id"])
    pkg_dir = Path(setup["akagi_pkg"]).expanduser().resolve()
    device_name = setup.get("device", "cpu")
    if not pkg_dir.is_dir():
        err(f"akagi_pkg not a directory: {pkg_dir}")
        sys.exit(1)

    try:
        _load_libriichi(pkg_dir)
        akagi_model = _load_akagi_model(pkg_dir)
        engine = _build_engine(pkg_dir, akagi_model, device_name)
        import libriichi  # alias from _load_libriichi
        bot = libriichi.mjai.Bot(engine, player_id)
    except BaseException as e:  # incl. pyo3 panics
        traceback.print_exc(file=sys.stderr)
        err(f"bootstrap: {type(e).__name__}: {e}")
        sys.exit(1)

    emit({"type": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        # Hot-swap seat (mirrors mortal_bot_server.py).
        if '"re_setup"' in line:
            try:
                msg = json.loads(line)
            except Exception as e:
                traceback.print_exc(file=sys.stderr)
                err(f"re_setup parse: {type(e).__name__}: {e}", event=line)
                continue
            if msg.get("type") == "re_setup":
                try:
                    bot = libriichi.mjai.Bot(engine, int(msg["player_id"]))
                except BaseException as e:
                    traceback.print_exc(file=sys.stderr)
                    err(f"re_setup: {type(e).__name__}: {e}", event=line)
                    continue
                emit({"type": "ready"})
                continue

        try:
            ev = json.loads(line)
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            err(f"event parse: {type(e).__name__}: {e}", event=line)
            continue

        try:
            padded = _to_yonma(ev)
            reaction = bot.react(json.dumps(padded, separators=(",", ":")))
        except BaseException as e:
            traceback.print_exc(file=sys.stderr)
            err(f"react: {type(e).__name__}: {e}", event=line)
            continue

        if reaction:
            sys.stdout.write(_to_sanma(reaction) + "\n")
            sys.stdout.flush()
        else:
            emit({"type": "none"})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except BaseException as e:
        traceback.print_exc(file=sys.stderr)
        err(f"fatal: {type(e).__name__}: {e}")
        sys.exit(1)
