"""Dump q_values at agari-eligible decision points for two models side-by-side.

Replays new arena mjai logs, finds agari-eligible decision points via
PlayerState.encode_obs, and runs BOTH fresh and old models to dump their
q_values for agari (action 41) vs their chosen action.

This is the only way to get q[agari] vs q[chosen] because arena logs don't
attach meta to hora events.

Usage:
    python3 scripts/dump_agari_q_compare.py \
        --arena-dir arena_runs/fresh-best-vs-old \
        --fresh /home/aruix/mortal-sanma/checkpoints/sanma-main-fresh-best.pth \
        --old   /home/aruix/mortal-sanma/checkpoints/sanma-main-best.pth \
        --n 8
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
import types
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "mortal"))

# config stub (yonma model.py imports it transitively)
if "config" not in sys.modules:
    _stub = types.ModuleType("config")
    _stub.config = {}
    sys.modules["config"] = _stub

import libriichi  # noqa: E402
from model import Brain, DQN  # noqa: E402

AGARI_ACTION = 41
AGARI_BIT = 1 << AGARI_ACTION
ACTION_SPACE = int(libriichi.consts.ACTION_SPACE)
VERSION = 5

_DECISION_TYPES = frozenset({
    "dahai", "hora", "reach", "nukidora",
    "pon", "chi", "daiminkan", "kakan", "ankan",
})

SUFFIX_TO_FRESH_SEAT = {"a": 0, "b": 1, "c": 2}

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
    return {37: "riichi", 38: "nukidora", 39: "pon", 40: "kan",
            41: "agari", 42: "ryukyoku", 43: "pass"}.get(idx, f"action_{idx}")


def mask_to_indices(mask_bits: int) -> list[int]:
    return [i for i in range(ACTION_SPACE) if mask_bits & (1 << i)]


def load_model(path: str, device: torch.device):
    state = torch.load(path, map_location="cpu", weights_only=False)
    hp = state["hyperparams"]
    version = int(hp.get("version", 1))
    cc = int(hp["conv_channels"])
    nb = int(hp["num_blocks"])
    brain = Brain(version=version, conv_channels=cc, num_blocks=nb).to(device).eval()
    dqn = DQN(version=version).to(device).eval()
    brain.load_state_dict(state["mortal"])
    dqn.load_state_dict(state["current_dqn"])
    return brain, dqn, version


def model_q_for_obs(brain, dqn, obs_np, mask_np, device):
    obs = torch.from_numpy(obs_np).unsqueeze(0).to(device).float()
    mask = torch.from_numpy(mask_np).unsqueeze(0).to(device)
    with torch.inference_mode():
        phi = brain(obs)
        q = dqn(phi, mask)
    return q[0].cpu().numpy()


def mask_array_to_bits(mask) -> int:
    bits = 0
    for i, v in enumerate(mask):
        if v:
            bits |= 1 << i
    return bits


def collect_agari_eligible_positions(arena_dir: Path, *, fresh_only: bool,
                                     n: int, selfplay: bool):
    """Stream-replay files. Yield (file, event_idx, actor, model_label,
    is_oya, event_type, pai, obs_np, mask_np) for the first n agari-eligible
    decision points found."""
    files = sorted(arena_dir.glob("*.json.gz"))
    found = 0
    for fp in files:
        with gzip.open(fp, "rt") as f:
            events = [json.loads(line) for line in f if line.strip()]
        pss = [libriichi.state.PlayerState(i) for i in range(3)]
        name = fp.name
        stem = name[:-len(".json.gz")]
        suffix = stem.split("_")[-1]
        fresh_seat = None if selfplay else SUFFIX_TO_FRESH_SEAT.get(suffix)

        current_oya = -1
        for i, ev in enumerate(events):
            if not isinstance(ev, dict):
                continue
            t = ev.get("type")
            if t == "start_kyoku":
                current_oya = int(ev.get("oya", -1))
            actor = ev.get("actor")
            if (actor is not None and t in _DECISION_TYPES and 0 <= int(actor) < 3):
                actor = int(actor)
                try:
                    obs, mask = pss[actor].encode_obs(VERSION, False)
                except Exception:
                    obs = None
                if obs is not None:
                    mbits = mask_array_to_bits(mask)
                    if mbits & AGARI_BIT:
                        model_label = (
                            "fresh" if selfplay or actor == fresh_seat else "old"
                        )
                        if fresh_only and model_label != "fresh":
                            pass
                        else:
                            yield {
                                "file": fp.name,
                                "event_idx": i,
                                "actor": actor,
                                "model_in_game": model_label,
                                "is_oya": (actor == current_oya),
                                "event_type": t,
                                "pai": ev.get("pai"),
                                "obs": np.ascontiguousarray(np.asarray(obs, dtype=np.float32)),
                                "mask": np.ascontiguousarray(np.asarray(mask, dtype=bool)),
                            }
                            found += 1
                            if found >= n:
                                return
            ev_str = json.dumps(ev, ensure_ascii=False)
            for ps in pss:
                try:
                    ps.update(ev_str)
                except Exception:
                    pass


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    p.add_argument("--arena-dir", type=Path, required=True)
    p.add_argument("--fresh", type=Path, required=True)
    p.add_argument("--old", type=Path, required=True)
    p.add_argument("--n", type=int, default=8)
    p.add_argument("--fresh-only", action="store_true",
                   help="Only sample decision points where the in-game actor was fresh.")
    p.add_argument("--selfplay", action="store_true")
    p.add_argument("--device", default="cpu")
    args = p.parse_args()

    device = torch.device(args.device)
    print(f"Loading fresh: {args.fresh}", file=sys.stderr)
    fb, fd, fv = load_model(str(args.fresh), device)
    print(f"Loading old:   {args.old}", file=sys.stderr)
    ob_, od, ov = load_model(str(args.old), device)

    print(f"\nSampling {args.n} agari-eligible positions from {args.arena_dir}...",
          file=sys.stderr)
    positions = list(collect_agari_eligible_positions(
        args.arena_dir, fresh_only=args.fresh_only, n=args.n, selfplay=args.selfplay))
    print(f"  got {len(positions)}", file=sys.stderr)

    if not positions:
        print("no positions found")
        return

    print()
    print("=" * 100)
    print("AGARI-ELIGIBLE Q-VALUE COMPARISON (fresh vs old)")
    print("=" * 100)
    hdr = (f"{'#':>2} {'file':<34} {'ev':>5} {'act':>3} {'m_in_g':>6} {'oya?':>5} "
           f"{'ev_type':<7} {'pai':<5} | {'FRESH chosen':<14} {'q[agari]':>9} "
           f"{'q[chosen]':>10} {'gap':>7} | {'OLD chosen':<14} {'q[agari]':>9} "
           f"{'q[chosen]':>10} {'gap':>7}")
    print(hdr)
    print("-" * 100)

    fresh_picks = 0
    old_picks = 0
    fresh_gaps = []
    old_gaps = []
    for i, pos in enumerate(positions):
        mask_bits = mask_array_to_bits(pos["mask"])
        valid = mask_to_indices(mask_bits)
        # q from each model
        fq = model_q_for_obs(fb, fd, pos["obs"], pos["mask"], device)
        oq = model_q_for_obs(ob_, od, pos["obs"], pos["mask"], device)
        # map full q (44-d) to compact q (masked-only)
        # NB: dqn returns full 44-d when fed a mask. argmax over masked q.
        fq_masked = np.where(pos["mask"], fq, -np.inf)
        oq_masked = np.where(pos["mask"], oq, -np.inf)
        f_choice = int(np.argmax(fq_masked))
        o_choice = int(np.argmax(oq_masked))
        f_qagari = float(fq[AGARI_ACTION])
        f_qchosen = float(fq[f_choice])
        o_qagari = float(oq[AGARI_ACTION])
        o_qchosen = float(oq[o_choice])
        f_gap = f_qchosen - f_qagari  # positive = chose non-agari over agari
        o_gap = o_qchosen - o_qagari
        fresh_gaps.append(f_gap)
        old_gaps.append(o_gap)
        if f_choice == AGARI_ACTION: fresh_picks += 1
        if o_choice == AGARI_ACTION: old_picks += 1

        fname = pos["file"][:34]
        print(f"{i+1:>2} {fname:<34} {pos['event_idx']:>5} {pos['actor']:>3} "
              f"{pos['model_in_game']:>6} {'Y' if pos['is_oya'] else 'n':>5} "
              f"{pos['event_type']:<7} {str(pos['pai']):<5} | "
              f"{action_label(f_choice)[:14]:<14} {f_qagari:>9.3f} {f_qchosen:>10.3f} "
              f"{f_gap:>+7.3f} | "
              f"{action_label(o_choice)[:14]:<14} {o_qagari:>9.3f} {o_qchosen:>10.3f} "
              f"{o_gap:>+7.3f}")

    print()
    print(f"fresh picked agari: {fresh_picks}/{len(positions)}")
    print(f"old   picked agari: {old_picks}/{len(positions)}")
    print(f"fresh gap (q[chosen]-q[agari]) mean: {np.mean(fresh_gaps):+.4f}  "
          f"(negative ⇒ agari ranked higher)")
    print(f"old   gap (q[chosen]-q[agari]) mean: {np.mean(old_gaps):+.4f}")
    print(f"fresh gap < 0 fraction (agari preferred): "
          f"{sum(1 for g in fresh_gaps if g < 0)/len(fresh_gaps)*100:.1f}%")
    print(f"old   gap < 0 fraction (agari preferred): "
          f"{sum(1 for g in old_gaps if g < 0)/len(old_gaps)*100:.1f}%")


if __name__ == "__main__":
    main()
