"""Find positions where OLD model missed agari, and check what FRESH does on them.

Stream-replays arena logs, finds decision points where:
  - actor was old-model (not fresh)
  - mask had bit 41 (agari eligible)
  - actual action in game was NOT hora (old missed)

Then runs BOTH fresh and old models on those positions to compare q values
and choices. This is the cleanest "does the fix work" test: on the exact
positions where old failed, does fresh succeed?
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


def mask_array_to_bits(mask) -> int:
    bits = 0
    for i, v in enumerate(mask):
        if v:
            bits |= 1 << i
    return bits


def load_model(path: str, device):
    state = torch.load(path, map_location="cpu", weights_only=False)
    hp = state["hyperparams"]
    version = int(hp.get("version", 1))
    cc = int(hp["conv_channels"])
    nb = int(hp["num_blocks"])
    brain = Brain(version=version, conv_channels=cc, num_blocks=nb).to(device).eval()
    dqn = DQN(version=version).to(device).eval()
    brain.load_state_dict(state["mortal"])
    dqn.load_state_dict(state["current_dqn"])
    return brain, dqn


def model_q(brain, dqn, obs_np, mask_np, device):
    obs = torch.from_numpy(obs_np).unsqueeze(0).to(device).float()
    mask = torch.from_numpy(mask_np).unsqueeze(0).to(device)
    with torch.inference_mode():
        phi = brain(obs)
        q = dqn(phi, mask)
    return q[0].cpu().numpy()


def find_old_misses(arena_dir: Path, max_n: int):
    files = sorted(arena_dir.glob("*.json.gz"))
    misses = []
    for fp in files:
        with gzip.open(fp, "rt") as f:
            events = [json.loads(line) for line in f if line.strip()]
        pss = [libriichi.state.PlayerState(i) for i in range(3)]
        name = fp.name
        stem = name[:-len(".json.gz")]
        suffix = stem.split("_")[-1]
        fresh_seat = SUFFIX_TO_FRESH_SEAT.get(suffix)

        current_oya = -1
        for i, ev in enumerate(events):
            if not isinstance(ev, dict): continue
            t = ev.get("type")
            if t == "start_kyoku":
                current_oya = int(ev.get("oya", -1))
            actor = ev.get("actor")
            if (actor is not None and t in _DECISION_TYPES and 0 <= int(actor) < 3):
                actor = int(actor)
                # only consider OLD actor positions
                if actor == fresh_seat:
                    pass
                else:
                    try:
                        obs, mask = pss[actor].encode_obs(VERSION, False)
                    except Exception:
                        obs = None
                    if obs is not None:
                        mbits = mask_array_to_bits(mask)
                        if mbits & AGARI_BIT:
                            picked_hora = (t == "hora")
                            if not picked_hora:
                                misses.append({
                                    "file": fp.name,
                                    "event_idx": i,
                                    "actor": actor,
                                    "is_oya": (actor == current_oya),
                                    "event_type": t,
                                    "pai": ev.get("pai"),
                                    "obs": np.ascontiguousarray(np.asarray(obs, dtype=np.float32)),
                                    "mask": np.ascontiguousarray(np.asarray(mask, dtype=bool)),
                                })
                                if len(misses) >= max_n:
                                    return misses
            ev_str = json.dumps(ev, ensure_ascii=False)
            for ps in pss:
                try: ps.update(ev_str)
                except Exception: pass
    return misses


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--arena-dir", type=Path, required=True)
    p.add_argument("--fresh", type=Path, required=True)
    p.add_argument("--old", type=Path, required=True)
    p.add_argument("--max-n", type=int, default=50)
    p.add_argument("--device", default="cpu")
    args = p.parse_args()

    device = torch.device(args.device)
    print(f"Loading fresh: {args.fresh}", file=sys.stderr)
    fb, fd = load_model(str(args.fresh), device)
    print(f"Loading old:   {args.old}", file=sys.stderr)
    ob_, od = load_model(str(args.old), device)

    print(f"\nFinding old-missed-agari positions in {args.arena_dir}...",
          file=sys.stderr)
    misses = find_old_misses(args.arena_dir, args.max_n)
    print(f"  found {len(misses)} old-miss cases", file=sys.stderr)
    if not misses:
        print("No old-miss cases — old model picked agari every time it was eligible.")
        return

    print()
    print("=" * 110)
    print("OLD-MISSED AGARI POSITIONS — FRESH vs OLD model choices")
    print("=" * 110)
    print(f"{'#':>2} {'file':<34} {'ev':>5} {'act':>3} {'oya?':>5} {'ev_type':<7} "
          f"{'pai':<5} | {'FRESH chose':<14} {'q[aga]':>8} {'q[ch]':>8} {'gap':>7}  | "
          f"{'OLD chose':<14} {'q[aga]':>8} {'q[ch]':>8} {'gap':>7}")
    print("-" * 110)

    fresh_pick_agari = 0
    old_pick_agari = 0
    fresh_gaps = []
    old_gaps = []
    for i, pos in enumerate(misses):
        fq = model_q(fb, fd, pos["obs"], pos["mask"], device)
        oq = model_q(ob_, od, pos["obs"], pos["mask"], device)
        fq_m = np.where(pos["mask"], fq, -np.inf)
        oq_m = np.where(pos["mask"], oq, -np.inf)
        fc = int(np.argmax(fq_m))
        oc = int(np.argmax(oq_m))
        f_qa = float(fq[AGARI_ACTION]); f_qc = float(fq[fc])
        o_qa = float(oq[AGARI_ACTION]); o_qc = float(oq[oc])
        f_gap = f_qc - f_qa
        o_gap = o_qc - o_qa
        fresh_gaps.append(f_gap); old_gaps.append(o_gap)
        if fc == AGARI_ACTION: fresh_pick_agari += 1
        if oc == AGARI_ACTION: old_pick_agari += 1

        fname = pos["file"][:34]
        print(f"{i+1:>2} {fname:<34} {pos['event_idx']:>5} {pos['actor']:>3} "
              f"{'Y' if pos['is_oya'] else 'n':>5} {pos['event_type']:<7} "
              f"{str(pos['pai']):<5} | "
              f"{action_label(fc)[:14]:<14} {f_qa:>8.3f} {f_qc:>8.3f} {f_gap:>+7.3f}  | "
              f"{action_label(oc)[:14]:<14} {o_qa:>8.3f} {o_qc:>8.3f} {o_gap:>+7.3f}")

    print()
    print(f"On {len(misses)} positions where OLD (in-game) missed agari:")
    print(f"  FRESH would pick agari: {fresh_pick_agari}/{len(misses)} "
          f"= {fresh_pick_agari/len(misses)*100:.1f}%")
    print(f"  OLD   would pick agari: {old_pick_agari}/{len(misses)} "
          f"= {old_pick_agari/len(misses)*100:.1f}%")
    print(f"  FRESH q-gap mean (q[chosen]-q[agari]): {np.mean(fresh_gaps):+.4f}  "
          f"(neg ⇒ agari preferred)")
    print(f"  OLD   q-gap mean (q[chosen]-q[agari]): {np.mean(old_gaps):+.4f}")
    print(f"  FRESH q-gap < 0 (agari ranked higher) frac: "
          f"{sum(1 for g in fresh_gaps if g < 0)/len(fresh_gaps)*100:.1f}%")
    print(f"  OLD   q-gap < 0 (agari ranked higher) frac: "
          f"{sum(1 for g in old_gaps if g < 0)/len(old_gaps)*100:.1f}%")


if __name__ == "__main__":
    main()
