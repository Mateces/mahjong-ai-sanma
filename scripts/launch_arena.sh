#!/usr/bin/env bash
# Launch the d-vs-e sanma arena: 6 workers across mac (×2) and stallion (×4),
# split into table A (1×d + 2×e) and table B (1×e + 2×d). Run from the repo
# root on whichever host you're starting (the script just prints the right
# command — wrap in tmux/nohup yourself).
#
# Each worker uses --workers 3 because the 6 are split evenly across the two
# independent tables (3 per table, with disjoint stripes via worker_id).

set -euo pipefail

if [[ -z "${RPC_TOKEN:-}" ]]; then
  echo "set RPC_TOKEN env var first" >&2
  exit 1
fi

# Repo paths — override with env vars if needed.
SANMA_DIR="${SANMA_DIR:-$HOME/mahjong-ai-sanma}"
VENV_PY="${VENV_PY:-$HOME/mahjong-trainer/.venv/bin/python}"

CKPT_D="$SANMA_DIR/checkpoints/sanma-main-best.pth.d"
CKPT_E="$SANMA_DIR/checkpoints/sanma-main-best.pth"

DATE_TAG="${DATE_TAG:-20260531}"
RUN_A="d-vs-e-A-$DATE_TAG"
RUN_B="d-vs-e-B-$DATE_TAG"

SEED_BASE_A="0xA00000"
SEED_BASE_B="0xB00000"
SEED_KEY="0xC0FFEE"
BATCH_SEEDS="${BATCH_SEEDS:-10}"
RPC_URL="${RPC_URL:-https://rpc.moki.cat}"

print_cmd() {
  local host_label=$1 device=$2 table=$3 worker_id=$4 chal_model=$5 cham_model=$6 \
        chal_ckpt=$7 cham_ckpt=$8 run_id=$9 seed_base="${10}"

  cat <<EOF
# --- $host_label : table $table worker $worker_id ($chal_model vs 2×$cham_model on device=$device) ---
$VENV_PY $SANMA_DIR/scripts/arena_battle.py \\
    --challenger $chal_ckpt \\
    --champion $cham_ckpt \\
    --challenger-model $chal_model \\
    --champion-model $cham_model \\
    --challenger-name $chal_model \\
    --champion-name $cham_model \\
    --table $table \\
    --challenger-device $device \\
    --champion-device $device \\
    --run-id $run_id \\
    --workers 3 --worker-id $worker_id \\
    --batch-seeds $BATCH_SEEDS \\
    --seed-base $seed_base \\
    --seed-key $SEED_KEY \\
    --rpc-url $RPC_URL \\
    --rpc-token "\$RPC_TOKEN" \\
    --log-dir $SANMA_DIR/arena_runs/$run_id/mjai \\
    --disable-progress-bar
EOF
  echo
}

echo "# 6-worker launch plan for d-vs-e sanma arena."
echo "# Each command runs forever; SIGTERM to stop. Wrap in tmux/nohup as you like."
echo "# Two tables, three workers per table; stripes are independent."
echo
echo "# ===== local mac (CPU, 2 workers) ====="
print_cmd "mac"      cpu      A 0 d e "$CKPT_D" "$CKPT_E" "$RUN_A" "$SEED_BASE_A"
print_cmd "mac"      cpu      B 0 e d "$CKPT_E" "$CKPT_D" "$RUN_B" "$SEED_BASE_B"

echo "# ===== stallion (GPU, 4 workers, two GPUs each used twice) ====="
print_cmd "stallion" cuda:0   A 1 d e "$CKPT_D" "$CKPT_E" "$RUN_A" "$SEED_BASE_A"
print_cmd "stallion" cuda:2   A 2 d e "$CKPT_D" "$CKPT_E" "$RUN_A" "$SEED_BASE_A"
print_cmd "stallion" cuda:0   B 1 e d "$CKPT_E" "$CKPT_D" "$RUN_B" "$SEED_BASE_B"
print_cmd "stallion" cuda:2   B 2 e d "$CKPT_E" "$CKPT_D" "$RUN_B" "$SEED_BASE_B"
