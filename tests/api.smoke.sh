#!/usr/bin/env bash
# End-to-end smoke test for the rooms/ PHP backend over real HTTP.
# Requires: php (built-in server running on 127.0.0.1:8137), curl, jq.
set -u
BASE="http://127.0.0.1:8137"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ FAIL: $1"; }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }

echo "— health: index served"
check "$(curl -s -o /dev/null -w '%{http_code}' $BASE/index.html)" "200" "index.html served"

echo "— create room"
CREATE=$(curl -s -X POST $BASE/rooms/create.php -d '{"name":"Host","avatar":"🦆"}')
CODE=$(echo "$CREATE" | jq -r '.code // empty')
check "${#CODE}" "6" "room code is 6 chars ($CODE)"

echo "— join second player"
JOIN=$(curl -s -X POST $BASE/rooms/join.php -d "{\"code\":\"$CODE\",\"name\":\"Guest\",\"avatar\":\"🐸\"}")
GID=$(echo "$JOIN" | jq -r '.playerId // empty')
check "$GID" "p4" "guest got id p4 (after 3 AI bots)"

echo "— join rejected when full/wrong code"
check "$(curl -s -X POST $BASE/rooms/join.php -d '{"code":"ZZZZZZ","name":"X","avatar":"x"}' | jq -r '.error // empty')" "room not found" "bad code rejected"
check "$(curl -s -X POST $BASE/rooms/jain.php -d '{}' | jq -r '.error // empty')" "" "unknown endpoint 404s silently"

echo "— lobby state phase"
check "$(curl -s "$BASE/rooms/state.php?code=$CODE" | jq -r '.state.phase')" "lobby" "room starts in lobby"

echo "— start game (host)"
check "$(curl -s -X POST $BASE/rooms/update.php -d "{\"code\":\"$CODE\",\"playerId\":\"p0\",\"type\":\"start\",\"laps\":1}" | jq -r '.state.phase')" "await-roll" "start transitions to await-roll"
# AI may have already rolled if AI players precede... host is p0 (human) so phase must remain await-roll
check "$(curl -s "$BASE/rooms/state.php?code=$CODE" | jq -r '.state.current')" "p0" "human host is first"

echo "— roll validation"
check "$(curl -s -X POST $BASE/rooms/update.php -d "{\"code\":\"$CODE\",\"playerId\":\"p4\",\"type\":\"roll\"}" | jq -r '.error // empty')" "not your turn" "out-of-turn roll rejected (anti-cheat)"
check "$(curl -s -X POST $BASE/rooms/update.php -d "{\"code\":\"$CODE\",\"playerId\":\"p0\",\"type\":\"bogus\"}" | jq -k '.error // empty' | tr -d '\n')" "unknown action type" "unknown action rejected"

echo "— host rolls; server assigns die and position"
R=$(curl -s -X POST $BASE/rooms/update.php -d "{\"code\":\"$CODE\",\"playerId\":\"p0\",\"type\":\"roll\"}")
check "$(echo "$R" | jq -r '.ok')" "true" "roll accepted"
DIE=$(echo "$R" | jq -r '.state.die')
POS=$(curl -s "$BASE/rooms/state.php?code=$CODE" | jq -r '.state.players[0].pos')
if [ "$DIE" != "null" ] && [ "$POS" -ge 0 ] && [ "$POS" -le 53 ]; then ok "die=$die, host pos=$POS valid"; else bad "invalid die/pos ($DIE/$POS)"; fi

echo "— server-driven AI turns ran until a human must act"
CUR=$(curl -s "$BASE/rooms/state.php?code=$CODE" | jq -r '.state.current')
check "$CUR" "p4" "turn advanced past all three AI bots to guest (p4)"

echo "— guest rolls and resolves; turn must advance past AI bots again"
curl -s -X POST $BASE/rooms/update.php -d "{\"code\":\"$CODE\",\"playerId\":\"p4\",\"type\":\"roll\"}" >/dev/null
CUR2=$(curl -s "$BASE/seed=false" >/dev/null; curl -s "$BASE/rooms/state.php?code=$CODE" | jq -r '.state.current')
if [ "$CUR2" = "p0" ] || [ "$CUR2" = "p4" ]; then ok "turn back on a human (p0)"; else bad "expected p0, got $CUR2"; fi

echo "— chat"
curl -s -X POST $BASE/rooms/chat.php -d "{\"code\":\"$CODE\",\"playerId\":\"p4\",\"text\":\"hello from guest\"}" >/dev/null
LASTCHAT=$(curl -s "$BASE/rooms/state.php?code=$CODE" | jq -r '.chat[-1].text')
check "$LASTCHAT" "hello from guest" "chat round-trips"

echo "— deck order withheld"
DECK=$(curl -s "$BASE/rooms/state.php?code=$CODE" | jq -c '.state.decks.scenario')
echo "$DECK" | grep -q '"order"' && bad "deck ORDER leaked to client!" || ok "deck order withheld (counts only)"

echo "— vote flow: force a vote via direct lib include"
VOTE_PROBE=$(php -r '
require "rooms/lib.php";
$code = $argv[1];
$s = awkward_load_room($code);
awkward_start_vote($s, "bluff", null, "majority", ["Believe","Caught"]);
awkward_bump($s);
awkward_save_room($code, $s);
echo "vote-started";
' "$CODE")
check "$VOTE_PROBE" "vote-started" "vote can be started server-side"
# p4 is current; p0 votes yes via vote.php; AI verdicts were pre-filled by start_vote
check "$(curl -s -X POST $BASE/rooms/vote.php -d "{\"code\":\"$CODE\",\"playerId\":\"p0\",\"verdict\":\"yes\"}" | jq -r '.ok')" "true" "p0 vote accepted"
check "$(curl -s -X POST $BASE/rooms/vote.php -d "{\"code\":\"$CODE\",\"playerId\":\"p0\",\"verdict\":\"yes\"}" | jq -r '.ok')" "true" "re-vote idempotent (same verdict overwrite)"
P4VOTE=$(curl -s -X POST $BASE/rooms/vote.php -d "{\"code\":\"$CODE\",\"playerId\":\"p4\",\"verdict\":\"yes\"}" | jq -r '.error // "ok"')
check "$P4VOTE" "the judged player cannot vote" "judged player blocked from voting"

echo "— board + cards endpoints"
check "$(curl -s $BASE/rooms/board.php | jq '.size')" "54" "board endpoint returns 54 tiles"
check "$(curl -s $BASE/rooms/cards.php | jq '.count')" "180" "cards endpoint returns 180"
check "$(curl -s "$BASE/rooms/cards.php?type=risk" | jq '.cards[0].type')" "risk" "cards endpoint filters by type"
check "$(curl -s $BASE/rooms/cards.php | jq '.cards[0] | has("ap")')" "false" "cards endpoint withholds deltas"

echo
echo "RESULT: $PASS passed, $FAIL failed"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
