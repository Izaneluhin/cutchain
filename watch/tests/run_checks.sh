#!/usr/bin/env bash
# Reproduces tests/live_run.txt and tests/replay_run.txt.
#
#   bash watch/tests/run_checks.sh            # live run against real Twitch
#   MOCK=1 bash watch/tests/run_checks.sh     # live run against tests/mock_irc.py
#
# Run from the repository root. Needs: pip install -r watch/requirements.txt
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=watch/tests
PORT=${PORT:-8787}
CHANNELS=${CHANNELS:-kaicenat,xqc,jynxzi,caseoh_}
DURATION=${DURATION:-45}

python3 -m watch.tests.test_watch
rm -f watch/data/moments.jsonl watch/data/watch.db watch/data/chat.log

# ---------------------------------------------------------------- live -----
LIVE_ARGS=(--twitch "$CHANNELS" --kick adinross --record data/chat.log --port "$PORT")
MOCK_PID=""
if [[ "${MOCK:-0}" == "1" ]]; then
  python3 watch/tests/mock_irc.py --port 6667 --rates kaicenat=30,xqc=20,jynxzi=12,caseoh_=6 --drop-after 20 \
    > "$OUT/mock_irc_run.txt" 2>&1 &
  MOCK_PID=$!
  sleep 1
  LIVE_ARGS+=(--twitch-irc-url ws://127.0.0.1:6667)
fi
python3 -m watch "${LIVE_ARGS[@]}" > "$OUT/live_run.txt" 2>&1 &
BOT=$!
sleep "$DURATION"
LIVE_JSON=$(curl -s "localhost:$PORT/api/live")
HEALTH_JSON=$(curl -s "localhost:$PORT/api/health")
kill -INT "$BOT"; wait "$BOT" || true          # Ctrl+C equivalent: graceful shutdown
[[ -n "$MOCK_PID" ]] && { kill -TERM "$MOCK_PID"; wait "$MOCK_PID" || true; }
{
  echo; echo "--- GET /api/live (captured at t+${DURATION}s)"; echo "$LIVE_JSON"
  echo "--- GET /api/health"; echo "$HEALTH_JSON"
  echo "--- recorded $(wc -l < watch/data/chat.log) messages to watch/data/chat.log"
} >> "$OUT/live_run.txt"

# -------------------------------------------------------------- replay -----
rm -f watch/data/moments.jsonl watch/data/watch.db
python3 -m watch --replay data/demo_chat.log --speed 10 --port "$PORT" > "$OUT/replay_run.txt" 2>&1 &
BOT=$!
sleep 22                                        # 177 s of log at 10x, plus tail
MOMENTS_JSON=$(curl -s "localhost:$PORT/api/moments?limit=50")
HEALTH_JSON=$(curl -s "localhost:$PORT/api/health")
kill -INT "$BOT"; wait "$BOT" || true
{
  echo; echo "--- GET /api/moments?limit=50 (captured after replay, API still up)"; echo "$MOMENTS_JSON"
  echo "--- GET /api/health"; echo "$HEALTH_JSON"
  echo "--- watch/data/moments.jsonl ($(wc -l < watch/data/moments.jsonl) line(s)):"; cat watch/data/moments.jsonl
  echo "--- sqlite: $(python3 -c "import sqlite3;print(sqlite3.connect('watch/data/watch.db').execute('select count(*) from moments').fetchone()[0])") row(s) in moments"
} >> "$OUT/replay_run.txt"
echo "wrote $OUT/live_run.txt and $OUT/replay_run.txt"
