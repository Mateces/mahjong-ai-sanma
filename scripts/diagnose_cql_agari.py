"""Diagnose the 100% missed-agari bug in the sanma main model.

Four experiments, run on real missed-agari cases discovered in
`arena_runs/main-vs-best/mjai/`. The script is **read-only** — it does not
modify the checkpoint, the training code, or `mortal/model.py`.

Experiments
-----------
A. Baseline reproduce:
    Re-run the model on each case and confirm q[chosen] > q[agari].
    Dumps the full 44-d q vector.

B. Dueling dissect:
    Split DQN's flat `nn.Linear(1024, 45)` into v (1) and a (44), and
    report raw `v`, raw `a[agari]`, raw `a[chosen]`, and `a_mean`. The
    point: confirm whether v is dominating the Q magnitude (it isn't, by
    construction — see "math Aside" below) and how big the raw advantage
    gap is.

C. Mean-subtraction ablation:
    Recompute q three ways from the same (v, a, mask) and check whether
    the chosen-vs-agari ordering flips:
      C1  q = (v + a).masked_fill(~mask, -inf)      # no a_mean subtract
      C2  q = a.masked_fill(~mask, -inf)            # pure advantage
      C3  q = v + a                                  # no subtract, no mask
    Math Aside: for two *valid* actions i, j, all of {baseline, C1, C2}
    give q[i] - q[j] = a[i] - a[j] (v and a_mean cancel). C3 differs
    only on invalid actions, which can't be picked anyway. So no flip
    is *expected*; the experiment exists to PROVE that empirically and
    rule dueling out as the culprit.

D. CQL gradient simulation:
    CQL loss = q.logsumexp(-1).mean() - q.mean()  (q = chosen-action q).
    For batch=1: L_cql = logsumexp_a(q[a]) - q[chosen].
    Per-action gradient: dL/dq[i] = softmax(q_valid)[i] - δ(i==chosen).
    One gradient-descent step with rate η on min_q_weight·L_cql:
      Δq[i] = -η · min_q_weight · (softmax[i] - δ(i==chosen))
    This PUSHES q[chosen] UP and every other valid action (including
    agari) DOWN. We quantify how strongly this fights against the
    agari-chosen gap, and simulate N steps of CQL-only descent to see
    whether the gap can fully reverse from CQL alone.

Run
---
    cd /Users/cat/mahjong-ai-sanma
    uv run --no-project --with torch --with numpy \\
        python3.12 scripts/diagnose_cql_agari.py

Outputs
-------
* A structured markdown report on stdout.
* A full dump at `arena_runs/cql_diag_<timestamp>.json` for later analysis.
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
import torch

# Make scripts/ importable so we can use _diag_utils.
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from _diag_utils import (  # noqa: E402
    ACTION_SPACE,
    AGARI_ACTION,
    AGARI_BIT,
    ModelHandle,
    MissedAgariCase,
    ReplayResult,
    action_label,
    load_model,
    mask_bits_to_indices,
    replay_to_obs,
    scan_missed_agari,
    to_torch,
)

# ---- config ----------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
CKPT = ROOT / "checkpoints" / "sanma-main.pth"
ARENA_DIR = ROOT / "arena_runs" / "main-vs-best" / "mjai"
KNOWN_CASE = ("200007_12648430_c.json.gz", 341)   # the case the user flagged
N_EXTRA_CASES = 4                                  # pick this many MORE cases
OUT_DIR = ROOT / "arena_runs"

# For experiment D's 1-step simulation. From the checkpoint hyperparams:
#   lr_peak = 1e-4, lr_final = 1e-5, max_steps = 200000
# At step 142000 (current checkpoint), cosine annealing puts lr around
# ~3-5e-5. We use 5e-5 as the canonical "current training lr" and also try
# a higher lr to show what aggressive CQL would do.
DEFAULT_LR = 5e-5
DEFAULT_MIN_Q_WEIGHT = 5.0  # from the training hyperparams
CQL_SIM_STEPS = 1000         # N steps of CQL-only descent in experiment D


# ---- per-case data containers ----------------------------------------------


@dataclass
class CaseReport:
    label: str
    file: str
    ev_index: int
    actor: int
    event_type: str
    pai: str
    shanten: int
    at_furiten: bool
    mask_indices: list[int]
    chosen_action: int
    log_q_compact: list[float]   # straight from arena meta
    baseline: dict               # experiment A
    dueling: dict                # experiment B
    ablation: dict               # experiment C
    cql_analysis: dict           # experiment D


# ---- experiments -----------------------------------------------------------


def _dqn_split_v5(dqn, phi, mask):
    """Run version-5 DQN forward but expose internals.

    Returns (v, a, a_mean, q) where:
        v       shape (B, 1)
        a       shape (B, 44)         (raw, before mask)
        a_mean  shape (B, 1)          (mean over valid actions)
        q       shape (B, 44)         (with -inf on invalid)

    Replicates `mortal/model.py:225-235` exactly — no behavior change.
    """
    if dqn.version not in (4, 5):
        raise NotImplementedError(
            f"this script only supports version 4/5 dueling (single Linear); "
            f"got version={dqn.version}. The v1/v2/v3 split-head path would "
            "need a separate implementation."
        )
    v, a = dqn.net(phi).split((1, ACTION_SPACE), dim=-1)
    a_sum = a.masked_fill(~mask, 0.).sum(-1, keepdim=True)
    mask_sum = mask.sum(-1, keepdim=True)
    a_mean = a_sum / mask_sum
    q = (v + a - a_mean).masked_fill(~mask, -torch.inf)
    return v, a, a_mean, q


def run_experiments(mh: ModelHandle, rr: ReplayResult, case: MissedAgariCase | None) -> CaseReport:
    device = next(mh.brain.parameters()).device
    obs_t, mask_t = to_torch(rr.obs, rr.mask, str(device))

    with torch.inference_mode():
        phi = mh.brain(obs_t)
        v, a, a_mean, q = _dqn_split_v5(mh.dqn, phi, mask_t)
        mask = mask_t  # short alias used by the C-experiment formulas below

        # --- Experiment A: baseline reproduce ---
        q_vec = q[0].float().cpu().numpy()           # (44,)
        q_valid_indices = np.where(rr.mask)[0]
        q_valid = q_vec[q_valid_indices]
        chosen = q_vec.argmax()
        q_agari = float(q_vec[AGARI_ACTION])
        q_chosen = float(q_vec[chosen]) if chosen >= 0 else float("nan")
        gap = q_chosen - q_agari   # positive => agari loses
        is_miss = (chosen != AGARI_ACTION) and rr.mask[AGARI_ACTION]

        # --- Experiment B: dueling dissect ---
        v_scalar = float(v[0, 0].item())
        a_vec = a[0].float().cpu().numpy()           # raw (44,)
        a_mean_scalar = float(a_mean[0, 0].item())
        # spread of a over valid actions
        a_valid = a_vec[q_valid_indices]
        a_agari_raw = float(a_vec[AGARI_ACTION])
        a_chosen_raw = float(a_vec[chosen]) if chosen >= 0 else float("nan")
        a_valid_spread = float(a_valid.max() - a_valid.min())
        # Does v dominate? |v| vs the per-action advantage gap that matters.
        # Since v cancels in q[i]-q[j], the relevant magnitude is |a[i]-a[j]|.
        per_action_gap = abs(a_agari_raw - a_chosen_raw)
        v_dominates = abs(v_scalar) > 5.0 * per_action_gap   # crude flag

        # --- Experiment C: mean-subtraction ablation ---
        # C1: q = (v + a).masked_fill(~mask, -inf)
        q_c1 = (v + a).masked_fill(~mask, -torch.inf)
        # C2: q = a.masked_fill(~mask, -inf)
        q_c2 = a.masked_fill(~mask, -torch.inf)
        # C3: q = v + a   (no mask — invalid actions stay in the running)
        q_c3 = v + a

        def _pick(t):
            return int(t[0].argmax().item())

        c1_pick = _pick(q_c1)
        c2_pick = _pick(q_c2)
        c3_pick = _pick(q_c3)
        c1_q_agari = float(q_c1[0, AGARI_ACTION].item())
        c1_q_chosen = float(q_c1[0, int(chosen)].item())
        c2_q_agari = float(q_c2[0, AGARI_ACTION].item())
        c2_q_chosen = float(q_c2[0, int(chosen)].item())
        c3_q_agari = float(q_c3[0, AGARI_ACTION].item())
        c3_q_chosen = float(q_c3[0, int(chosen)].item())

        # --- Experiment D: CQL gradient simulation ---
        # softmax over valid q values (matching how CQL logsumexp sees them)
        # invalid actions contribute 0 to softmax because they are -inf.
        # Use float64 for numerical stability.
        q_for_softmax = np.where(rr.mask, q_vec, -np.inf).astype(np.float64)
        # subtract max for stability
        m = q_for_softmax.max()
        exps = np.exp(q_for_softmax - m)
        exps[~rr.mask] = 0.0
        Z = exps.sum()
        sm = exps / Z
        sm_agari = float(sm[AGARI_ACTION])
        sm_chosen = float(sm[int(chosen)]) if chosen >= 0 else float("nan")

        # 1-step CQL gradient on q[i]:
        #   d(min_q_weight * L_cql)/dq[i] = min_q_weight * (sm[i] - δ(i==chosen))
        # gradient descent with rate η:
        #   Δq[i] = -η * min_q_weight * (sm[i] - δ(i==chosen))
        lr = DEFAULT_LR
        w = DEFAULT_MIN_Q_WEIGHT
        delta_q_agari_1step = -lr * w * sm_agari                          # negative => DOWN
        delta_q_chosen_1step = -lr * w * (sm_chosen - 1.0)                # positive => UP

        # Multi-step simulation: hold (v, a) fixed is wrong — CQL updates the
        # underlying network, not q directly. But as a *loss-formula*
        # diagnostic, evolving q directly shows the asymptote CQL drives
        # toward. We cap steps so the chosen action doesn't get pushed to
        # absurd values; we recompute softmax each step.
        q_sim = q_for_softmax.copy()
        sim_trace = []
        for step in range(CQL_SIM_STEPS):
            m = q_sim.max()
            ex = np.exp(q_sim - m); ex[~rr.mask] = 0
            sm_step = ex / ex.sum()
            grad = sm_step.copy()
            grad[int(chosen)] -= 1.0
            q_sim = q_sim - lr * w * grad   # gradient descent on q directly
            if step in (0, 9, 99, 499, CQL_SIM_STEPS - 1):
                sim_trace.append({
                    "step": step + 1,
                    "q_agari": float(q_sim[AGARI_ACTION]),
                    "q_chosen": float(q_sim[int(chosen)]),
                    "gap": float(q_sim[int(chosen)] - q_sim[AGARI_ACTION]),
                    "sm_agari": float(sm_step[AGARI_ACTION]),
                })

        baseline = {
            "q_full": [float(x) for x in q_vec.tolist()],
            "q_valid_indices": [int(x) for x in q_valid_indices.tolist()],
            "q_valid_values": [float(x) for x in q_valid.tolist()],
            "chosen_action": int(chosen),
            "chosen_label": action_label(int(chosen)),
            "q_agari": q_agari,
            "q_chosen": q_chosen,
            "gap_q_chosen_minus_q_agari": gap,
            "is_missed_agari": bool(is_miss),
        }
        dueling = {
            "v": v_scalar,
            "a_mean": a_mean_scalar,
            "a_agari_raw": a_agari_raw,
            "a_chosen_raw": a_chosen_raw,
            "a_valid_spread": a_valid_spread,
            "per_action_advantage_gap_abs": per_action_gap,
            "v_dominates_5x": bool(v_dominates),
            # Invariant check (chosen != agari): q[chosen] - q[agari] should
            # equal a[chosen] - a[agari] because v and a_mean cancel.
            "invariant_q_diff_eq_a_diff": bool(
                abs(gap - (a_chosen_raw - a_agari_raw)) < 1e-5
            ),
            "a_full": [float(x) for x in a_vec.tolist()],
        }
        ablation = {
            "C1_no_mean_subtract": {
                "pick": c1_pick, "pick_label": action_label(c1_pick),
                "q_agari": c1_q_agari, "q_chosen": c1_q_chosen,
                "flipped_to_agari": c1_pick == AGARI_ACTION,
            },
            "C2_pure_advantage": {
                "pick": c2_pick, "pick_label": action_label(c2_pick),
                "q_agari": c2_q_agari, "q_chosen": c2_q_chosen,
                "flipped_to_agari": c2_pick == AGARI_ACTION,
            },
            "C3_no_mean_no_mask": {
                "pick": c3_pick, "pick_label": action_label(c3_pick),
                "q_agari": c3_q_agari, "q_chosen": c3_q_chosen,
                "flipped_to_agari": c3_pick == AGARI_ACTION,
            },
        }
        cql_analysis = {
            "softmax_agari": sm_agari,
            "softmax_chosen": sm_chosen,
            "softmax_full": [float(x) for x in sm.tolist()],
            "lr_used": lr,
            "min_q_weight_used": w,
            "delta_q_agari_1step": delta_q_agari_1step,
            "delta_q_chosen_1step": delta_q_chosen_1step,
            # Δgap = Δq_chosen - Δq_agari (positive => CQL widens discard-over-agari)
            "delta_gap_1step": float(delta_q_chosen_1step - delta_q_agari_1step),
            "cql_pushes_agari_down": bool(delta_q_agari_1step < 0),
            "cql_pushes_chosen_up": bool(delta_q_chosen_1step > 0),
            "cql_widens_gap_against_agari": bool(
                (delta_q_chosen_1step - delta_q_agari_1step) > 0
            ),
            "sim_steps": CQL_SIM_STEPS,
            "sim_trace": sim_trace,
            "sim_final_q_agari": float(q_sim[AGARI_ACTION]),
            "sim_final_q_chosen": float(q_sim[int(chosen)]),
            "sim_final_gap": float(q_sim[int(chosen)] - q_sim[AGARI_ACTION]),
        }

    return CaseReport(
        label=f"{Path(case.path).name if case else '?'}@ev{rr.event_index}",
        file=str(Path(case.path).name) if case else "?",
        ev_index=rr.event_index,
        actor=rr.actor,
        event_type=rr.event.get("type") if isinstance(rr.event, dict) else "?",
        pai=str(rr.event.get("pai", "")),
        shanten=int(rr.state.shanten),
        at_furiten=bool(rr.state.at_furiten),
        mask_indices=mask_bits_to_indices(case.mask_bits) if case else [],
        chosen_action=case.chosen_action if case else int(q_vec.argmax()),
        log_q_compact=list(case.q_values) if case else [],
        baseline=baseline,
        dueling=dueling,
        ablation=ablation,
        cql_analysis=cql_analysis,
    )


# ---- reporting -------------------------------------------------------------


def _fmt(v, w=8, p=4):
    if v is None:
        return " " * w
    if isinstance(v, bool):
        return ("✓" if v else "✗").rjust(w)
    return f"{v:> {w}.{p}f}"


def print_report(cases: list[CaseReport], mh: ModelHandle):
    sep = "─" * 100
    print()
    print("=" * 100)
    print("CQL / AGARI DIAGNOSTIC REPORT")
    print("=" * 100)
    print(f"checkpoint : {CKPT}")
    print(f"version    : {mh.version}   conv_channels={mh.conv_channels}   "
          f"num_blocks={mh.num_blocks}")
    print(f"min_q_weight (training): {mh.min_q_weight}")
    print(f"cases      : {len(cases)} missed-agari events")

    print()
    print("CASE INDEX")
    print(sep)
    for i, c in enumerate(cases):
        chosen_lbl = action_label(c.baseline["chosen_action"]) if c.baseline["chosen_action"] >= 0 else "?"
        print(
            f"  [{i}] {c.label}  actor={c.actor}  pai={c.pai}  "
            f"shanten={c.shanten}  furiten={c.at_furiten}  "
            f"chosen={chosen_lbl}  q[agari]={c.baseline['q_agari']:.4f}  "
            f"q[chosen]={c.baseline['q_chosen']:.4f}"
        )

    # ---- Experiment A ----
    print()
    print("=" * 100)
    print("EXPERIMENT A — baseline forward reproduction")
    print("=" * 100)
    print("Goal: confirm the model reproduces the logged q_values AND consistently")
    print("      picks a non-agari action when agari is in the mask.")
    print()
    headers = ["case", "chosen", "q[agari]", "q[chosen]", "gap", "miss?", "log_q[agari]", "log_q[chosen]"]
    print("  " + "  ".join(h.rjust(12 if i in (3, 4, 5, 6, 7) else 38 if i == 0 else 14) for i, h in enumerate(headers)))
    print("  " + sep[:96])
    for i, c in enumerate(cases):
        log_idx_map = mask_bits_to_indices(int(c.mask_indices and sum(1 << b for b in c.mask_indices) or 0)) if c.mask_indices else []
        # find log_q[agari] and log_q[chosen] from the compact log_q list
        log_q_agari = log_q_chosen = None
        if c.log_q_compact and c.mask_indices:
            try:
                log_q_agari = c.log_q_compact[c.mask_indices.index(AGARI_ACTION)]
            except ValueError:
                log_q_agari = None
            try:
                log_q_chosen = c.log_q_compact[c.mask_indices.index(c.chosen_action)]
            except ValueError:
                log_q_chosen = None
        chosen_lbl = action_label(c.baseline["chosen_action"])
        miss = "✓" if c.baseline["is_missed_agari"] else "✗"
        print(
            f"  [{i}]".ljust(6)
            + chosen_lbl[:24].ljust(24)
            + f"{c.baseline['q_agari']:>10.4f}"
            + f"{c.baseline['q_chosen']:>12.4f}"
            + f"{c.baseline['gap_q_chosen_minus_q_agari']:>10.4f}"
            + f"{miss:>6}"
            + (f"{log_q_agari:>12.4f}" if log_q_agari is not None else " " * 12)
            + (f"{log_q_chosen:>14.4f}" if log_q_chosen is not None else " " * 14)
        )
    print()
    print("  miss?=✓ means model picked a non-agari action despite agari being valid.")
    print("  log_q_* are straight from the arena meta; if they match q_* we know the")
    print("  replay→forward pipeline is faithful (cross-check).")

    # ---- Experiment B ----
    print()
    print("=" * 100)
    print("EXPERIMENT B — dueling dissect (v / a / a_mean)")
    print("=" * 100)
    print("Per case, expose the raw v scalar, raw a (before a_mean subtraction),")
    print("and the per-action advantage gap. Note the math invariant:")
    print("    q[chosen] - q[agari] == a[chosen] - a[agari]")
    print("(v and a_mean cancel for valid-vs-valid comparisons).")
    print()
    print("  case          v        a_mean   a[agari] a[chosen] | qgap   agap   match?")
    print("  " + sep[:96])
    for i, c in enumerate(cases):
        d = c.dueling
        match = "✓" if d["invariant_q_diff_eq_a_diff"] else "✗ MISMATCH"
        print(
            f"  [{i}]".ljust(6)
            + f"{d['v']:>10.4f}"
            + f"{d['a_mean']:>10.4f}"
            + f"{d['a_agari_raw']:>10.4f}"
            + f"{d['a_chosen_raw']:>11.4f}"
            + "  | "
            + f"{c.baseline['gap_q_chosen_minus_q_agari']:>7.4f}"
            + f"{d['a_chosen_raw'] - d['a_agari_raw']:>7.4f}"
            + f"   {match}"
        )
    print()
    print("  Reading: |v| being large does NOT make v dominate the agari-vs-chosen")
    print("  decision, because v cancels in the difference. What matters is the raw")
    print("  advantage gap (a[chosen]-a[agari]). If that's positive, the model has")
    print("  learned a real preference for the discard.")

    # ---- Experiment C ----
    print()
    print("=" * 100)
    print("EXPERIMENT C — dueling mean-subtraction ablation")
    print("=" * 100)
    print("Re-pick the argmax with three perturbations of the dueling formula.")
    print("By math, none of these can flip the chosen-vs-agari ordering for valid")
    print("actions — they differ only on invalid actions (C3) or no-op (C1, C2).")
    print("We run them anyway to make the proof visible.")
    print()
    print("  case   baseline   C1 no-μ    C2 pure-a  C3 no-μ-no-mask    any flip?")
    print("  " + sep[:96])
    for i, c in enumerate(cases):
        b = action_label(c.baseline["chosen_action"])[:14]
        c1 = action_label(c.ablation["C1_no_mean_subtract"]["pick"])[:14]
        c2 = action_label(c.ablation["C2_pure_advantage"]["pick"])[:14]
        c3 = action_label(c.ablation["C3_no_mean_no_mask"]["pick"])[:14]
        any_flip = (
            c.ablation["C1_no_mean_subtract"]["flipped_to_agari"]
            or c.ablation["C2_pure_advantage"]["flipped_to_agari"]
            or c.ablation["C3_no_mean_no_mask"]["flipped_to_agari"]
        )
        flip_str = "YES (suspicious)" if any_flip else "no"
        print(f"  [{i}]".ljust(6) + f"{b:<14}{c1:<14}{c2:<14}{c3:<18}{flip_str}")
    print()
    print("  If 'any flip?' is 'no' across the board, dueling's mean-subtraction is")
    print("  NOT the culprit — the cause is downstream (training signal).")

    # ---- Experiment D ----
    print()
    print("=" * 100)
    print("EXPERIMENT D — CQL gradient simulation")
    print("=" * 100)
    print(f"CQL loss = logsumexp_a(q[a]) - q[chosen]   (per-sample, batch=1)")
    print(f"  gradient  dL/dq[i] = softmax(q_valid)[i] - δ(i==chosen)")
    print(f"  1-step Δq[i]       = -η·w·(softmax[i] - δ(i==chosen))")
    print(f"  η (lr) = {DEFAULT_LR},  w (min_q_weight) = {DEFAULT_MIN_Q_WEIGHT}")
    print()
    print("  case   sm[agari]  sm[chosen]  Δq[agari]₁  Δq[chosen]₁  Δgap₁     direction")
    print("  " + sep[:96])
    for i, c in enumerate(cases):
        d = c.cql_analysis
        direction = "CQL WIDENS gap (pushes discard over agari)" if d["cql_widens_gap_against_agari"] else "CQL NARROWS gap"
        print(
            f"  [{i}]".ljust(6)
            + f"{d['softmax_agari']:>10.4f}"
            + f"{d['softmax_chosen']:>12.4f}"
            + f"{d['delta_q_agari_1step']:>12.2e}"
            + f"{d['delta_q_chosen_1step']:>13.2e}"
            + f"{d['delta_gap_1step']:>10.2e}"
            + f"   {direction}"
        )
    print()
    print(f"Multi-step CQL-only simulation ({CQL_SIM_STEPS} steps, q evolved directly):")
    for i, c in enumerate(cases):
        d = c.cql_analysis
        print(
            f"  [{i}] start: q[agari]={c.baseline['q_agari']:.4f}, "
            f"q[chosen]={c.baseline['q_chosen']:.4f}, gap={c.baseline['gap_q_chosen_minus_q_agari']:.4f}  "
            f"→ after {CQL_SIM_STEPS} CQL steps: "
            f"q[agari]={d['sim_final_q_agari']:.4f}, "
            f"q[chosen]={d['sim_final_q_chosen']:.4f}, "
            f"gap={d['sim_final_gap']:.4f}"
        )

    # ---- Conclusions ----
    print()
    print("=" * 100)
    print("CONCLUSIONS")
    print("=" * 100)
    all_a_miss = all(c.baseline["is_missed_agari"] for c in cases)
    all_inv = all(c.dueling["invariant_q_diff_eq_a_diff"] for c in cases)
    any_flip = any(
        c.ablation["C1_no_mean_subtract"]["flipped_to_agari"]
        or c.ablation["C2_pure_advantage"]["flipped_to_agari"]
        or c.ablation["C3_no_mean_no_mask"]["flipped_to_agari"]
        for c in cases
    )
    all_cql_widens = all(c.cql_analysis["cql_widens_gap_against_agari"] for c in cases)
    print(f"  A. baseline reproduction: all cases miss agari = {all_a_miss}")
    print(f"  B. q[i]-q[j]==a[i]-a[j] invariant holds = {all_inv}  → v / a_mean NOT the cause")
    print(f"  C. dueling mean-subtraction flip seen = {any_flip}      → dueling NOT the cause")
    print(f"  D. CQL pushes discard-over-agari in every case = {all_cql_widens}")

    print()
    print("INTERPRETATION")
    print("  - Dueling architecture (v, a_mean) is exonerated: the gap between two")
    print("    valid actions is set purely by the raw advantage head a[..].")
    print("  - CQL gradient on the *bug* scenarios (chosen=discard) DOES push q[discard]")
    print("    UP and q[agari] DOWN — but only because in the training data the chosen")
    print("    action was a discard. If the training data had chosen=agari in identical")
    print("    states, CQL would push the OTHER way. So the bug is upstream of CQL:")
    print("    either (a) the training data labels discard-when-agari-available, or")
    print("    (b) the reward / target construction makes agari's MC-return not stand out")
    print("    enough to dominate the per-action advantage learned by the network.")
    print()
    print("NEXT STEPS (recommended order):")
    print("  1. Tier-2 — training data audit: in the .mjson training corpus, count")
    print("     states where mask bit 41 was set AND the recorded action was NOT hora.")
    print("     If non-zero and frequent, the data is teaching the model to skip agari.")
    print("  2. Tier-2 — reward audit: for a sample of agari-eligible training states,")
    print("     dump gamma**steps_to_done * kyoku_rewards for both (i) the actual agari")
    print("     action and (ii) the recorded discard. If agari's q-target isn't clearly")
    print("     larger, the reward shaping (score_alpha/gap1/gap2 betas) may be washing")
    print("     out the win signal.")
    print("  3. Tier-3 — if (1) and (2) come back clean: try lowering min_q_weight")
    print("     from 5.0 → 1.0 and re-training for a short stretch to see if the")
    print("     agari rate recovers. CQL with too-high weight can suppress rare-action")
    print("     q-values even when the targets are correct.")


# ---- main ------------------------------------------------------------------


def pick_cases(all_cases: list[MissedAgariCase]) -> list[MissedAgariCase]:
    """Pick the known case + a diverse set of extras."""
    selected: list[MissedAgariCase] = []
    # known case first
    for c in all_cases:
        if c.path.name == KNOWN_CASE[0] and c.event_index == KNOWN_CASE[1]:
            selected.append(c)
            break
    # extras: pick from different files to keep them diverse
    seen_files = {c.path.name for c in selected}
    for c in all_cases:
        if len(selected) >= 1 + N_EXTRA_CASES:
            break
        if c.path.name in seen_files:
            continue
        # avoid the same actor+discard-pattern as already selected
        if c.chosen_action in {s.chosen_action for s in selected}:
            continue
        selected.append(c)
        seen_files.add(c.path.name)
    # backfill if not enough
    if len(selected) < 1 + N_EXTRA_CASES:
        for c in all_cases:
            if c in selected:
                continue
            selected.append(c)
            if len(selected) >= 1 + N_EXTRA_CASES:
                break
    return selected


def main():
    t0 = time.perf_counter()

    print("Loading model…")
    mh = load_model(CKPT)

    print(f"Scanning {ARENA_DIR} for missed-agari cases…")
    all_cases = scan_missed_agari(ARENA_DIR)
    print(f"  found {len(all_cases)} total missed-agari events "
          f"(mask_bits & (1<<41) set, action != hora)")
    if not all_cases:
        print("ERROR: no missed-agari cases found in arena logs. Aborting.")
        sys.exit(2)

    selected = pick_cases(all_cases)
    print(f"  selected {len(selected)} for detailed analysis:")
    for c in selected:
        print(f"    {c.path.name} ev{c.event_index}  actor={c.actor} "
              f"type={c.event_type} pai={c.pai} chosen={action_label(c.chosen_action)}")

    case_reports: list[CaseReport] = []
    for c in selected:
        print(f"\nReplaying {c.path.name} up to ev{c.event_index}…")
        rr = replay_to_obs(c.path, c.event_index, version=mh.version)
        # sanity: mask must contain agari bit
        if not rr.mask[AGARI_ACTION]:
            print(f"  WARN: reconstructed mask does NOT contain agari bit "
                  f"(set bits = {list(np.where(rr.mask)[0])}); "
                  "case will likely show no miss. Investigate replay.")
        cr = run_experiments(mh, rr, c)
        case_reports.append(cr)

    print_report(case_reports, mh)

    # dump
    ts = time.strftime("%Y%m%d_%H%M%S")
    out_path = OUT_DIR / f"cql_diag_{ts}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "checkpoint": str(CKPT),
        "version": mh.version,
        "min_q_weight": mh.min_q_weight,
        "conv_channels": mh.conv_channels,
        "num_blocks": mh.num_blocks,
        "n_total_missed_agari_in_arena": len(all_cases),
        "n_selected_for_analysis": len(selected),
        "config": {
            "DEFAULT_LR": DEFAULT_LR,
            "DEFAULT_MIN_Q_WEIGHT": DEFAULT_MIN_Q_WEIGHT,
            "CQL_SIM_STEPS": CQL_SIM_STEPS,
        },
        "cases": [asdict(c) for c in case_reports],
        "elapsed_seconds": time.perf_counter() - t0,
    }
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2, default=str)
    print(f"\nFull dump: {out_path}")


if __name__ == "__main__":
    main()
