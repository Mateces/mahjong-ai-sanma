#!/usr/bin/env bash
# Stage 2 RESUME: continue fresh main-model training after fixing the
# patience misconfiguration that caused a spurious early stop.
#
# ROOT CAUSE (do not repeat):
#   RUN_TRAIN_FRESH.sh launched with --patience 20. e1/v3 both use 100.
#   At step 24600 cycles_since_best hit 20 == patience and training halted,
#   even though the model was still healthy (val_loss 3.5425, on par with e1
#   at the same step). The model was NOT converged — it was murdered by a
#   typo. This script uses --patience 100.
#
# WARM-START STRATEGY:
#   train_main.py has no --resume flag; resuming is IMPLICIT: if the file at
#   --save exists, full state (weights + optimizer + scheduler + steps +
#   best_val_loss + cycles_since_best) is loaded from it.
#   - sanma-main-fresh.pth      (the --save target) was the LAST ckpt at
#                                step 24600 with cycles_since_best=20.
#                                Resuming from it would re-trigger early stop
#                                immediately. So BEFORE launch we copied
#                                sanma-main-fresh-best.pth over it.
#   - sanma-main-fresh-best.pth (step 20600, val 3.5425, cycles_since_best=0)
#                                is the clean warm-start source. It is NEVER
#                                written by this run, only read/copied from.
#   Net effect: resume loads step=20600, best_val=3.5425, cycles_since_best=0
#   and continues with patience=100. Optimizer + cosine LR scheduler state
#   are restored from step 20600, so LR continues smoothly (no warmup reset,
#   no instability).
#
# GPUs:     ONLY GPU 0 + GPU 2 (both RTX 3090 24GB). P40s (GPU 1, 3) excluded.
# Data:     /home/aruix/sanma-mjson-top250.v2/  (train 2009-2024,2026; val 2025)
# Save:     sanma-main-fresh.pth       (rolling, overwritten every save-every)
# Best:     sanma-main-fresh-best.pth  (auto-derived from --save stem; only
#                                       copied when val_loss improves)
# TB:       runs/sanma-main-fresh/     (SAME dir as before — continues curve)
#
# Launch (background, survives SSH disconnect; APPEND to keep 0..24600 history):
#   nohup bash /home/aruix/mahjong-ai-sanma/scripts/RUN_TRAIN_FRESH_RESUME.sh \
#       >> /home/aruix/sanma-train-fresh.log 2>&1 </dev/null &
set -euo pipefail

# CUDA_DEVICE_ORDER=PCI_BUS_ID is REQUIRED: without it CUDA defaults to
# FASTEST_FIRST, which reorders devices as [3090,3090,P40,P40]. That makes
# CUDA_VISIBLE_DEVICES=0,2 pick cuda:0(3090)+cuda:2(P40) — exactly the
# accidental-P40 bug that bit the first launch of this run. With PCI_BUS_ID
# the indices match nvidia-smi (0,2 = both RTX 3090s).
export CUDA_DEVICE_ORDER=PCI_BUS_ID
export CUDA_VISIBLE_DEVICES=0,2
export OMP_NUM_THREADS=1

TORCHRUN=/home/aruix/mahjong-trainer/.venv/bin/torchrun
SCRIPT=/home/aruix/mahjong-ai-sanma/scripts/train_main.py

cd /home/aruix/mahjong-ai-sanma

exec "$TORCHRUN" \
    --standalone \
    --nproc_per_node=2 \
    "$SCRIPT" \
    --grp /home/aruix/mortal-sanma/checkpoints/grp-best.pth \
    --train-glob "/home/aruix/sanma-mjson-top250.v2/200*.mjson" \
    --train-glob "/home/aruix/sanma-mjson-top250.v2/201*.mjson" \
    --train-glob "/home/aruix/sanma-mjson-top250.v2/202[0-46]*.mjson" \
    --val-glob "/home/aruix/sanma-mjson-top250.v2/2025*.mjson" \
    --save /home/aruix/mortal-sanma/checkpoints/sanma-main-fresh.pth \
    --best-save /home/aruix/mortal-sanma/checkpoints/sanma-main-fresh-best.pth \
    --tensorboard /home/aruix/mahjong-ai-sanma/runs/sanma-main-fresh \
    --batch-size 256 \
    --max-steps 200000 \
    --save-every 200 \
    --val-steps 50 \
    --patience 100 \
    --warmup-steps 200 \
    "$@"
