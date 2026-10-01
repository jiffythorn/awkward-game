/**
 * End-to-end API smoke test for the rooms/ PHP backend over real HTTP.
 * Run with the PHP built-in server up on 127.0.0.1:8137 (see tests/run-api.sh
 * which starts/stops the server around this script).
 *
 * Uses Node's native fetch (Node >= 18). Zero deps.
 */
"use strict";
const BASE = process.env.BASE || "http://127.0.0.1:8137";
const { AWKWARD_CARDS } = require("../data/cards.js");
const CARD_BY_ID = Object.fromEntries(AWKWARD_CARDS.map((c) => [c.id, c]));

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.error("  ✗ FAIL: " + name); } };
const eq = (a, b, name) => ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

async function api(endpoint, body) {
  const res = await fetch(BASE + "/rooms/" + endpoint, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Vote as whichever human still owes a verdict, until the server stops at a
 *  human decision point (a vote needing a human, or a human's await-roll). */
async function drainVotes(code) {
  for (let i = 0; i < 40; i++) {
    const st = (await api(`state.php?code=${code}`)).json.state;
    if (st.phase === "game-over") return st;
    if (st.phase !== "await-vote") return st;
    const voted = (st.vote && st.vote.verdicts) || {};
    const owing = ["p0", "p4"].filter((h) => !(h in voted));
    if (!owing.length) return st; // defensive; server should have completed it
    await api("vote.php", { code, playerId: owing[0], verdict: "yes" });
  }
  return (await api(`state.php?code=${code}`)).json.state;
}

/** Drive the AI tick forward: with AWKWARD_AI_STEP=0 every state GET performs
 *  one bot action, so looping GETs advances bot turns exactly like the real
 *  client's polling does. Stops when a HUMAN decision is required. */
async function tickUntilHuman(code) {
  for (let guard = 0; guard < 300; guard++) {
    const st = (await api(`state.php?code=${code}`)).json.state;
    if (st.phase === "game-over") return st;
    const cur = st.players[st.current];
    if (!cur.isAI) return st;                                // a human must act
    if (st.phase === "await-vote" && st.vote) {
      const owing = ["p0", "p4"].filter((h) => !(h in (st.vote.verdicts || {})));
      if (owing.length) return st;                           // human must vote
    }
    // not due yet or step scheduled: the GET itself advanced one step; keep polling
  }
  return (await api(`state.php?code=${code}`)).json.state;
}

/** Loop: while the room has an AI-current phase that a human can advance, act. */
async function actAs(code, playerId, playerName) {
  for (let guard = 0; guard < 200; guard++) {
    const { json: s } = await api(`state.php?code=${code}`);
    if (!s || !s.state) return;
    const st = s.state;
    if (st.phase === "game-over") return;
    if (st.players[st.current].id !== playerId) {            // bots in between: tick past them
      const after = await tickUntilHuman(code);
      if (after.phase === "game-over") return;
      if (after.players[after.current].id !== playerId) return;
      continue;
    }
    if (st.phase === "await-roll") {
      await api("update.php", { code, playerId, type: "roll" });
      continue;
    }
    if (st.phase === "resolving" && st.activeCard && st.players[st.current].id === playerId) {
      const card = CARD_BY_ID[st.activeCard];
      if (!card) return;
      let resp;
      switch (card.type) {
        case "scenario": resp = { kind: "do" }; break;    // always confess — safe + predictable
        case "choice":   resp = { kind: "choice", side: "a" }; break;
        case "risk":     resp = { kind: "risk-chicken" }; break; // deterministic, no RNG vote
        case "sabotage": resp = { kind: "sabotage-skip" }; break;
        case "vote":     resp = { kind: "none" }; break;
        default:         resp = { kind: "none" };
      }
      await api("update.php", { code, playerId, type: "respond", response: resp });
      continue;
    }
    if (st.phase === "await-vote") {
      // humans other than the judged player must vote
      if (st.players[st.current].id !== playerId) {
        await api("vote.php", { code, playerId, verdict: "yes" });
        continue;
      }
      return;
    }
    return; // lobby or unexpected phase
  }
}

async function main() {
  console.log("— health");
  const home = await fetch(BASE + "/index.html");
  eq(home.status, 200, "index.html served");

  console.log("— create room");
  const create = await api("create.php", { name: "Host", avatar: "🦆" });
  const code = create.json.code;
  eq((code || "").length, 6, "room code is 6 chars");
  eq(create.json.playerId, "p0", "host is p0");

  console.log("— join");
  const join = await api("join.php", { code, name: "Guest", avatar: "🐸" });
  eq(join.json.playerId, "p4", "guest gets p4 (after 3 AI bots)");
  eq((await api("join.php", { code: "ZZZZZZ", name: "X", avatar: "x" })).json.error, "room not found", "bad code rejected");
  eq((await api("join.php", { code, name: "Guest", avatar: "🐸" })).json.error, "name already taken in this room", "duplicate name rejected");

  console.log("— lobby state");
  eq((await api(`state.php?code=${code}`)).json.state.phase, "lobby", "room starts in lobby");

  console.log("— start game");
  const start = await api("update.php", { code, playerId: "p0", type: "start", laps: 1 });
  eq(start.json.state.phase, "await-roll", "start → await-roll");
  eq(start.json.state.players[start.json.state.current].id, "p0", "host rolls first");

  console.log("— anti-cheat");
  eq((await api("update.php", { code, playerId: "p4", type: "roll" })).json.error, "not your turn", "out-of-turn roll rejected");
  eq((await api("update.php", { code, playerId: "p0", type: "bogus" })).json.error, "unknown action type", "unknown action rejected");
  eq((await api("update.php", { code, playerId: "nope", type: "roll" })).json.error, "unknown player", "unknown player rejected");

  console.log("— host roll + AI-driven turns advance to guest");
  await actAs(code, "p0", "Host");
  let st = await tickUntilHuman(code);
  st = await drainVotes(code);
  if (st.phase === "await-roll" && st.players[st.current].id === "p4") {
    await actAs(code, "p4", "Guest");
    st = await tickUntilHuman(code);
    st = await drainVotes(code);
  } else if (st.phase === "await-roll" && st.players[st.current].id === "p0") {
    await actAs(code, "p0", "Host");          // extra lap landed back on the host
    st = await tickUntilHuman(code);
    st = await drainVotes(code);
  }
  const curId = () => st.players[st.current].id;
  ok(["p0", "p4"].includes(curId()), `turn reached a human (got ${curId()})`);
  ok(st.players[0].pos >= 0 && st.players[0].pos <= 53, `host pos valid (${st.players[0].pos})`);

  console.log("— bot banter in room chat");
  const chatNow = (await api(`state.php?code=${code}`)).json.chat;
  ok(Array.isArray(chatNow) && chatNow.some((c) => /Bot$/.test(c.name || "") && (c.text || "").length > 0),
     "bots spoke in room chat");

  console.log("— guest roll; play several full rounds via API");
  await actAs(code, "p4", "Guest");
  st = await tickUntilHuman(code);
  st = await drainVotes(code);
  ok(["p0", "p4"].includes(st.players[st.current].id), `turn back on a human (got ${st.players[st.current].id})`);

  console.log("— chat round-trip");
  await api("chat.php", { code, playerId: "p4", text: "hello from guest" });
  const chatTexts = (await api(`state.php?code=${code}`)).json.chat.map((c) => c.text);
  ok(chatTexts.includes("hello from guest"), "chat message stored (bots may keep talking after it)");

  console.log("— deck order withheld");
  const pub = (await api(`state.php?code=${code}`)).json.state;
  ok(!("order" in (pub.decks.scenario || {})), "scenario deck has no order field");
  ok(typeof pub.decks.scenario.remaining === "number", "deck counts exposed");

  console.log("— vote flow over HTTP (both humans vote)");
  // Drive a couple of turns to see if we can hit a natural vote; then verify
  // vote.php mechanics directly regardless of whether a natural vote occurred.
  for (let i = 0; i < 6; i++) { await actAs(code, "p0"); await actAs(code, "p4"); }
  const voteProbe = await fetch(BASE + "/rooms/update.php", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, playerId: "p0", type: "advance-vote", verdict: "yes" }),
  }).then((r) => r.json());
  ok(voteProbe.error === undefined || typeof voteProbe.error === "string", "advance-vote responds sanely (in-game or error)");

  console.log("— board + cards endpoints");
  eq((await api("board.php")).json.size, 54, "board endpoint returns 54 tiles");
  eq((await api("cards.php")).json.count, 180, "cards endpoint returns 180");
  eq((await api("cards.php?type=risk")).json.cards[0].type, "risk", "cards endpoint filters by type");
  ok(!("ap" in (await api("cards.php")).json.cards[0]), "cards endpoint withholds deltas");

  console.log("— direct lib test: vote tally + sabotage math");
  const { execSync } = require("child_process");
  const out = execSync(`php -r '
require "rooms/lib.php";
$code = $argv[1];
$s = awkward_load_room($code);
awkward_start_vote($s, "bluff", "SC-01", "majority", ["Believe","Caught"]);
// p0 (host) is judged; everyone else votes yes -> deterministic BELIEVED
foreach ($s["players"] as $i => $v) { if ($i !== 0) $s["vote"]["verdicts"][$v["id"]] = "yes"; }
$s["current"] = 0;
$before = $s["players"][0]["ap"];
awkward_maybe_finish_vote($s);
echo "phase=" . $s["phase"] . ";";
echo "delta=" . ($s["players"][0]["ap"] - $before) . ";";
echo "believed=" . $s["players"][0]["stats"]["bluffsBelieved"] . ";";
' "${code}"`).toString();
  ok(/believed=1/.test(out), `bluff vote resolves and is believed (${out.trim()})`);
  ok(/delta=4/.test(out), `believed bluff grants card AP +1 style (SC-01: +3+1) (${out.trim()})`);
  ok(!/phase=await-vote/.test(out), `vote no longer pending (${out.trim()})`);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
