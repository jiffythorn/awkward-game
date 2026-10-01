#!/usr/bin/env bash
# Starts the PHP built-in server, runs the API smoke test, then stops the server.
set -u
PORT=8137
cd "$(dirname "$0")/.."

# Don't stomp an existing listener.
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/index.html"; then
  echo "PHP server already running on :$PORT"
  BASE="http://127.0.0.1:$PORT" node tests/api.smoke.js
  exit $?
fi

# AWKWARD_AI_STEP=0: bots act instantly (one step per poll) so the smoke test
# can drive a full multiplayer game quickly while still exercising the tick.
export AWKWARD_AI_STEP=0
setsid nohup php -S 127.0.0.1:$PORT >/tmp/awkward-php.log 2>&1 &
SRV=$!
trap 'kill -- -'$SRV' 2>/dev/null' EXIT
for i in $(seq 1 20); do
  curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/index.html" && break
  sleep 0.25
done

BASE="http://127.0.0.1:$PORT" node tests/api.smoke.js
STATUS=$?
exit $STATUS
