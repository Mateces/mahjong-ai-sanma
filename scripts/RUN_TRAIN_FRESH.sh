#!/usr/bin/env bash
# Stage 2: from-scratch main model training on v2 data.
#
# GPUs:     ONLY GPU 0 + GPU 2 (both RTX 3090 24GB). P40s (GPU 1, 3) excluded
#           via CUDA_VISIBLE_DEVICES=0,2 so PyTorch sees exactly 2 devices.
# Data:     /home/aruix/sanma-mjson-top250.v2/  (698,940 gzipped mjson)
#             train: 2009-2024, 2026  (626,920 files)
#             val:   2025             (72,020 files)
# GRP:      existing grp-best.pth (v2 is a format-conversion fix of the same
#           source games; GRP rank-predictor is stable, no retrain needed).
# Save:     sanma-main-fresh.pth  (NEW name — does NOT overwrite sanma-main.pth)
# TB:       runs/sanma-main-fresh/
#
# Hyperparameters match e1 (defaults in train_main.py): batch 256/GPU
# (global 512), max-steps 200000, save-every 200, patience 20, lr 1e-4 -> 1e-5
# cosine, warmup 200, conv 192, blocks 40, min-q 5.0, score/rank/gap aux heads.
#
# Launch (background, survives SSH disconnect):
#   nohup bash /home/aruix/mahjong-ai-sanma/scripts/RUN_TRAIN_FRESH.sh \
#       > /home/aruix/sanma-train-fresh.log 2>&1 </dev/null &
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
    --tensorboard /home/aruix/mahjong-ai-sanma/runs/sanma-main-fresh \
    --batch-size 256 \
    --max-steps 200000 \
    --save-every 200 \
    --val-steps 50 \
    --patience 20 \
    --warmup-steps 200 \
    "$@"
