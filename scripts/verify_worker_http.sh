#!/usr/bin/env bash
# verify_worker_http.sh — claims and runs verify batches from HTTP coordinator.
#
# All errors are surfaced (no silent failures). All output goes to both
# stdout and a log file (set LOG_FILE to override default).
set -eo pipefail

COORDINATOR="${COORDINATOR:?set COORDINATOR=https://host}"
TOKEN="${TOKEN:-}"
WORKER_NAME="${WORKER_NAME:-$(hostname)}"
WORKERS="${WORKERS:-4}"
MODELS_DIR="${MODELS_DIR:-$HOME/mahjong-models}"
DEVICE_MAP="${DEVICE_MAP:-cpu,cpu,cpu,cpu}"
MAHJONG_DIR="${MAHJONG_DIR:-$HOME/mahjong}"
MORTAL_PYTHON="${MORTAL_PYTHON:-python3}"
MORTAL_SERVER="${MORTAL_SERVER:-$HOME/mahjong-trainer/scripts/mortal_bot_server.py}"
LOG_FILE="${LOG_FILE:-$HOME/verify-worker-${WORKER_NAME}.log}"

# Tee all output to log file from the start
exec > >(tee -a "$LOG_FILE") 2>&1

log() { echo "[$(date '+%H:%M:%S')] [$WORKER_NAME] $*"; }

log "===== worker start ====="
log "coordinator=$COORDINATOR workers=$WORKERS log=$LOG_FILE"
log "models_dir=$MODELS_DIR device_map=$DEVICE_MAP"
log "mahjong_dir=$MAHJONG_DIR mortal_server=$MORTAL_SERVER"

# Auth header
AUTH_HEADER=""
[ -n "$TOKEN" ] && AUTH_HEADER="Authorization: Bearer $TOKEN"

# Build local strategies: prepend MODELS_DIR, append @device
build_strategies() {
    local server_strategies="$1"
    local IFS=','
    read -ra STRATS <<< "$server_strategies"
    read -ra DEVICES <<< "$DEVICE_MAP"
    local result=""
    local i=0
    for s in "${STRATS[@]}"; do
        local prefix="${s%%:*}"
        local fname="${s#*:}"
        local dev="${DEVICES[$i]:-cpu}"
        local full="${prefix}:${MODELS_DIR}/${fname}@${dev}"
        [ -n "$result" ] && result="${result},"
        result="${result}${full}"
        i=$((i + 1))
    done
    echo "$result"
}

# HTTP helpers — show errors, never silent
http_post() {
    local url="$1"
    local body="$2"
    local resp
    local code
    local out
    out=$(curl -sS -X POST "$url" \
        -H "Content-Type: application/json" \
        -H "$AUTH_HEADER" \
        -d "$body" \
        -w "\n__HTTP_CODE__:%{http_code}")
    code=$(echo "$out" | tail -1 | sed 's/__HTTP_CODE__://')
    resp=$(echo "$out" | sed '$d')
    # Log to stderr so caller's stdout capture stays clean
    log "  POST $url → HTTP $code" >&2
    log "  body: $(echo "$resp" | head -c 200)" >&2
    if [ "$code" -ge 400 ]; then
        log "  ERROR: HTTP $code from $url" >&2
        return 1
    fi
    echo "$resp"
}

while true; do
    log "claim attempt..."
    if ! RESP=$(http_post "$COORDINATOR/claim" "{\"worker\": \"$WORKER_NAME\"}"); then
        log "claim failed, sleeping 30s before retry"
        sleep 30
        continue
    fi

    # Check done
    if echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('done') else 1)"; then
        log "no more batches. Done."
        break
    fi

    BATCH_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['batch_id'])")
    BATCH_SIZE=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['batch_size'])")
    SERVER_STRATEGIES=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['strategies'])")
    DIFFICULTIES=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['difficulties'])")
    END_ROUND=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['end_round'])")

    LOCAL_STRATEGIES=$(build_strategies "$SERVER_STRATEGIES")

    log "claimed batch $BATCH_ID ($BATCH_SIZE hanchans)"
    log "strategies: $LOCAL_STRATEGIES"

    # Run verify.ts — full output to log, not just tail
    OUTFILE="/tmp/verify-batch-${WORKER_NAME}-${BATCH_ID}.json"
    rm -f "$OUTFILE"
    SECONDS=0
    log "running verify.ts ${BATCH_SIZE} hanchans..."
    cd "$MAHJONG_DIR"
    set +e
    # Pick whichever tsx variant exists; fall back to npx tsx
    TSX_BIN=""
    if [ -f "$MAHJONG_DIR/node_modules/tsx/dist/cli.mjs" ] && grep -q "^#!" "$MAHJONG_DIR/node_modules/tsx/dist/cli.mjs" 2>/dev/null; then
        TSX_BIN="$MAHJONG_DIR/node_modules/tsx/dist/cli.mjs"
    elif [ -f "$MAHJONG_DIR/node_modules/tsx/dist/cli.cjs" ]; then
        TSX_BIN="node $MAHJONG_DIR/node_modules/tsx/dist/cli.cjs"
    else
        TSX_BIN="npx tsx"
    fi
    SHUFFLE_SEATS=1 \
    WORKERS="$WORKERS" \
    MORTAL_PYTHON="$MORTAL_PYTHON" \
    MORTAL_SERVER="$MORTAL_SERVER" \
    RAW_OUTPUT="$OUTFILE" \
    $TSX_BIN scripts/verify.ts \
        "$BATCH_SIZE" "$DIFFICULTIES" "$END_ROUND" \
        "--strategies=$LOCAL_STRATEGIES" </dev/null &
    VERIFY_PID=$!

    # Wait for OUTFILE to appear (verify completed) or VERIFY_PID to die
    while kill -0 $VERIFY_PID 2>/dev/null; do
        sleep 2
        if [ -f "$OUTFILE" ]; then
            # Give it 3 more seconds to flush
            sleep 3
            log "verify produced output, killing remaining processes"
            # Only kill our own descendants — pkill -P walks the tree
            CHILDREN=$(pgrep -P $VERIFY_PID 2>/dev/null || true)
            for c in $CHILDREN; do
                pkill -9 -P $c 2>/dev/null || true
                kill -9 $c 2>/dev/null || true
            done
            kill -9 $VERIFY_PID 2>/dev/null || true
            break
        fi
    done
    wait $VERIFY_PID 2>/dev/null
    VERIFY_RC=$?
    set -e
    BATCH_ELAPSED=$SECONDS
    log "verify.ts done after ${BATCH_ELAPSED}s (rc=$VERIFY_RC)"

    if [ ! -f "$OUTFILE" ]; then
        log "ERROR: $OUTFILE not produced. Skipping report."
        continue
    fi

    HANCHANS=$(python3 -c "import json; print(len(json.load(open('$OUTFILE'))))")
    log "verify produced $HANCHANS hanchans in $OUTFILE"

    # Report
    PAYLOAD=$(python3 -c "
import json, sys
with open('$OUTFILE') as f:
    raw = json.load(f)
n = 4
pp = [{'wins':0,'deal_ins':0,'riichi':0,'fuuro':0,'rank_sum':0,'rank_dist':[0]*n} for _ in range(n)]
for h in raw:
    for r in h['results']:
        pp[r['strategy']]['rank_sum'] += r['rank']
        pp[r['strategy']]['rank_dist'][r['rank']-1] += 1
print(json.dumps({
    'batch_id': $BATCH_ID,
    'worker': '$WORKER_NAME',
    'elapsed_seconds': $BATCH_ELAPSED,
    'results': {'per_player': pp, 'total_rounds': 0, 'hanchans_completed': len(raw)}
}))
")
    log "reporting batch $BATCH_ID..."
    if http_post "$COORDINATOR/report" "$PAYLOAD" >/dev/null; then
        log "batch $BATCH_ID reported successfully (${BATCH_ELAPSED}s)"
        rm -f "$OUTFILE"
    else
        log "ERROR: batch $BATCH_ID report failed; keeping $OUTFILE for retry"
    fi
done

log "===== worker finished ====="
