"""3-way sanma arena: 3 different sanma models, random seating, via ThreeWay.

Each game has exactly 1 seat per model; seating randomly shuffled per game.
All 3 models must be sanma checkpoints loadable by the project Brain/DQN.

Output: games.jsonl + mjai/ + summary.json.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import types
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parent.parent
_yonma_path = ROOT / "mortal" / "mortal"
sys.path.insert(0, str(_yonma_path if _yonma_path.is_dir() else ROOT / "mortal"))
_stub = types.ModuleType("config")
_stub.config = {}
sys.modules["config"] = _stub

from engine import MortalEngine  # noqa: E402
from libriichi.arena import ThreeWay  # noqa: E402
from model import Brain, DQN  # noqa: E402


def _checkpoint_meta(state: dict) -> tuple[int, int, int]:
    if "config" in state:
        cfg = state["config"]
        return (int(cfg["control"].get("version", 1)),
                int(cfg["resnet"]["conv_channels"]),
                int(cfg["resnet"]["num_blocks"]))
    if "hyperparams" in state:
        hp = state["hyperparams"]
        return (int(hp.get("version", 1)), int(hp["conv_channels"]), int(hp["num_blocks"]))
    raise KeyError("checkpoint missing both 'config' and 'hyperparams'")


def build_engine(state_path: Path, name: str, device: torch.device) -> MortalEngine:
    state = torch.load(state_path, map_location="cpu", weights_only=False)
    version, conv_channels, num_blocks = _checkpoint_meta(state)
    brain = Brain(version=version, conv_channels=conv_channels, num_blocks=num_blocks).eval()
    dqn = DQN(version=version).eval()
    brain.load_state_dict(state["mortal"])
    dqn.load_state_dict(state["current_dqn"])
    return MortalEngine(brain, dqn, is_oracle=False, version=version, device=device,
                        enable_amp=False, enable_quick_eval=False,
                        enable_rule_based_agari_guard=False, name=name)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    p.add_argument("--model0", type=Path, required=True)
    p.add_argument("--model1", type=Path, required=True)
    p.add_argument("--model2", type=Path, required=True)
    p.add_argument("--name0", default="model0")
    p.add_argument("--name1", default="model1")
    p.add_argument("--name2", default="model2")
    p.add_argument("--device", default="cuda")
    p.add_argument("--seeds", type=int, default=1000)
    p.add_argument("--batch", type=int, default=100)
    p.add_argument("--seed-base", type=lambda s: int(s, 0), default=0x300000)
    p.add_argument("--seed-key", type=lambda s: int(s, 0), default=0xC0FFEE)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--disable-progress-bar", action="store_true")
    args = p.parse_args()

    out = args.output.resolve()
    mjai_dir = out / "mjai"
    out.mkdir(parents=True, exist_ok=True)
    mjai_dir.mkdir(parents=True, exist_ok=True)

    device = torch.device(args.device)
    models = [(args.model0, args.name0), (args.model1, args.name1), (args.model2, args.name2)]
    engines = []
    print(f"loading 3 models onto {device}...", flush=True)
    for path, name in models:
        eng = build_engine(path, name, device)
        engines.append(eng)
        print(f"  {name}: v{eng.version} <- {path}", flush=True)

    env = ThreeWay(disable_progress_bar=args.disable_progress_bar, log_dir=str(mjai_dir))
    names = [args.name0, args.name1, args.name2]

    all_records = []
    t0 = time.time()
    print(f"running {args.seeds} 3-way games in batches of {args.batch} "
          f"(seed_base=0x{args.seed_base:x} key=0x{args.seed_key:x})...", flush=True)

    for off in range(0, args.seeds, args.batch):
        n = min(args.batch, args.seeds - off)
        sb = args.seed_base + off
        t1 = time.time()
        recs = env.py_vs_py_vs_py(engines[0], engines[1], engines[2], (sb, args.seed_key), n)
        dt1 = time.time() - t1
        all_records.extend(recs)
        print(f"  batch [{sb:#x}, {sb + n:#x}): +{len(recs)} games "
              f"({dt1:.1f}s, total {len(all_records)}/{args.seeds})", flush=True)

    dt = time.time() - t0

    games_path = out / "games.jsonl"
    with open(games_path, "w", encoding="utf-8") as f:
        for (seed, key, gnames, scores, ranks, seat_to_engine) in all_records:
            f.write(json.dumps({
                "seed": int(seed), "key": int(key),
                "names_by_seat": list(gnames),
                "scores_by_seat": [int(s) for s in scores],
                "ranks_by_seat": [int(r) + 1 for r in ranks],
                "seat_to_engine": [int(x) for x in seat_to_engine],
                "engine_names": names,
            }, ensure_ascii=False) + "\n")

    rank_counts = {n: [0, 0, 0] for n in names}
    score_sums = {n: 0 for n in names}
    game_count = len(all_records)
    for (_, _, _, scores, ranks, seat_to_engine) in all_records:
        for seat in range(3):
            nm = names[int(seat_to_engine[seat])]
            rank_counts[nm][int(ranks[seat])] += 1
            score_sums[nm] += int(scores[seat])

    summary = {
        "games": game_count,
        "elapsed_seconds": round(dt, 1),
        "seconds_per_game": round(dt / max(game_count, 1), 3),
        "models": names,
        "seed_base": int(args.seed_base),
        "seed_key": int(args.seed_key),
        "rank_counts": {n: {"1st": rc[0], "2nd": rc[1], "3rd": rc[2]} for n, rc in rank_counts.items()},
        "avg_score": {n: round(score_sums[n] / max(game_count, 1), 1) for n in names},
    }
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n" + json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    print(f"\ndone: {game_count} games in {dt:.1f}s", flush=True)
    print(f"records: {games_path}", flush=True)
    print(f"mjai logs: {mjai_dir} ({len(list(mjai_dir.glob('*.json.gz')))} files)", flush=True)


if __name__ == "__main__":
    main()
