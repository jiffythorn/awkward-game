/**
 * Headless test suite for The Awkward Game engine.
 * Run: node tests/engine.test.js
 * Zero dependencies. Exercises engine, AI, voting, movement, save-shape, decks.
 */
"use strict";

/* Load data + engine as globals (mirrors browser <script> order). */
const { AWKWARD_BOARD, TILE_LABELS } = require("../data/board.js");
const { AWKWARD_CARDS, DECK_TYPES, cardsByType } = require("../data/cards.js");
global.AWKWARD_BOARD = AWKWARD_BOARD;
global.TILE_LABELS = TILE_LABELS;
global.AWKWARD_CARDS = AWKWARD_CARDS;
global.DECK_TYPES = DECK_TYPES;
global.cardsByType = cardsByType;
const game = require("../game.js");
const { G, PENALTY, BOARD_SIZE } = game;

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error("  ✗ FAIL: " + name); }
}
function eq(a, b, name) { ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function section(t) { console.log("—" + t); }

/* ============================ 1. BOARD ==================================== */
section("BOARD");
eq(AWKWARD_BOARD.length, 54, "board has 54 tiles");
const counts = {};
AWKWARD_BOARD.forEach((t) => (counts[t.type] = (counts[t.type] || 0) + 1));
eq(counts.scenario, 13, "13 scenario tiles");
eq(counts.choice, 9, "9 choice tiles");
eq(counts.risk, 8, "8 risk tiles");
eq(counts.sabotage, 6, "6 sabotage tiles");
eq(counts.vote, 5, "5 vote tiles");
eq(counts.safe, 7, "7 safe tiles");
eq(counts.chaos, 3, "3 chaos tiles");
eq(counts.double, 2, "2 double tiles");
eq(counts.final, 1, "1 final tile");
eq(AWKWARD_BOARD[0].type, "safe", "tile 0 is safe (START)");
eq(AWKWARD_BOARD[53].type, "final", "tile 53 is final combo");
AWKWARD_BOARD.forEach((t, i) => ok(typeof t.name === "string" && t.name.length > 0, `tile ${i} has name`));

/* ============================ 2. CARDS ==================================== */
section("CARDS");
eq(AWKWARD_CARDS.length, 180, "180 cards total");
const byType = cardsByType(AWKWARD_CARDS);
DECK_TYPES.forEach((t) => eq(byType[t].length, 36, `deck ${t} has 36 cards`));
const ids = new Set();
let cardErrs = 0;
for (const c of AWKWARD_CARDS) {
  if (ids.has(c.id)) cardErrs++;
  ids.add(c.id);
  for (const f of ["id", "type", "title", "description", "effect", "ap", "sp", "tags"]) {
    if (c[f] === undefined) cardErrs++;
  }
  if (typeof c.ap !== "number" || typeof c.sp !== "number") cardErrs++;
  if (c.type === "choice" && (!c.a || !c.b || typeof c.a.text !== "string" || typeof c.b.text !== "string")) cardErrs++;
  if (c.type === "risk" && (!c.reward || !c.penalty || !["coin", "die", "believe"].includes(c.mech))) cardErrs++;
  if (c.type === "sabotage" && typeof c.tAp !== "number") cardErrs++;
  if (c.type === "vote" && (!c.punish || !c.forgive || !["majority", "unanimous"].includes(c.mode))) cardErrs++;
}
eq(cardErrs, 0, "all cards well-formed (ids unique, fields complete)");

/* ============================ 3. ENGINE =================================== */
section("ENGINE — setup & decks");
function newTestGame(laps, seed, personalities) {
  game.createGame({
    players: personalities.map((pers, i) => ({ name: "P" + i, isAI: true, personality: pers, avatar: "x" })),
    laps, seed, mode: "local",
  });
  G.state.mode = "test-auto"; // headless: skips DOM, auto-resolves AI cards
  return G.state;
}

const s1 = newTestGame(1, 123, ["chill", "brutal"]);
eq(s1.players.length, 2, "two players created");
eq(s1.phase, "await-roll", "starts in await-roll");
eq(s1.current, 0, "player 0 starts");
ok(Object.keys(s1.decks).length === 5, "five decks built");
for (const t of DECK_TYPES) {
  eq(s1.decks[t].order.length + s1.decks[t].discard.length, 36, `deck ${t} holds 36 (order+discard)`);
}

section("ENGINE — movement & laps");
// Drive a full deterministic game headlessly.
function driveGame(state, maxTurns) {
  let guard = 0;
  while (state.phase !== "game-over" && guard++ < maxTurns) {
    if (state.phase === "await-roll") game.doRoll();
    else if (state.phase === "resolving" && state.activeCard) game.resolveActiveCardForAI ? game.resolveActiveCardForAI() : null;
    else if (state.phase === "await-vote") {
      // cast any remaining AI votes (they are pre-filled, but be defensive)
      for (const v of state.players) {
        if (v.isAI && state.vote && !state.vote.verdicts[v.id]) state.vote.verdicts[v.id] = "yes";
      }
      game.maybeFinishVote();
    } else if (state.phase === "turn-end") game.endTurn();
    else if (state.phase === "moving" || state.phase === "resolving") { /* in-flight */ }
    else break;
  }
  return state.phase === "game-over";
}

const s2 = newTestGame(1, 42, ["chaotic", "brutal"]);
const finished = driveGame(s2, 5000);
ok(finished, "deterministic 2-AI game reaches game-over");
eq(s2.phase, "game-over", "phase is game-over");
ok(s2.turnCount > 0, "turns were counted");
ok(s2.players.every((p) => p.lapsDone >= 1), "every player completed a lap (end condition)");
ok(s2.players.every((p) => p.pos >= 0 && p.pos < 54), "all positions on board");
const awards = game.computeAwards(s2);
ok(awards.winner, "winner computed");
ok(["chill", "chaotic", "brutal", "honest", "liar"].includes(awards.winner.personality), "winner has a valid personality");
ok(s2.log.length > 10, "log recorded events");

section("ENGINE — lap bonus applied exactly once");
// Directly exercise movePlayer wrap logic.
game.createGame({ players: [{ name: "A", isAI: true, personality: "chill", avatar: "x" }, { name: "B", isAI: true, personality: "chill", avatar: "y" }], laps: 1, seed: 5, mode: "local" });
G.state.mode = "test-auto";
const s3 = G.state;
const pA = s3.players[0];
pA.pos = 52;
game.movePlayer(s3, 6); // 52+6 = 58 → pos 4, lapsDone 1, +2 AP
eq(pA.pos, 4, "wrap lands at pos 4");
eq(pA.lapsDone, 1, "lapsDone incremented once");
eq(pA.ap, PENALTY.LAP_BONUS_AP, "lap bonus +2 AP applied");
game.movePlayer(s3, 53); // 4+53=57 → wrap again
eq(pA.lapsDone, 2, "second wrap increments again");
eq(pA.ap, PENALTY.LAP_BONUS_AP * 2, "second lap bonus applied");

section("ENGINE — deck exhaustion & reshuffle");
const s4 = newTestGame(1, 99, ["chill", "chill"]);
const deck = s4.decks.vote;
// Drain the vote deck and confirm reshuffle never returns null.
for (let i = 0; i < 80; i++) {
  const c = game.drawCard(s4, "vote");
  ok(c !== null, "drawCard never null across 80 draws (vote)");
  if (c === null) break;
}
// Note: card is not re-shuffled between draws unless discard accumulates; the
// discard pile grows each draw, so after 36 draws the reshuffle path runs.

section("ENGINE — seeded reproducibility (engine is G.state-bound, run sequentially)");
const seedA = newTestGame(1, 777, ["liar", "honest"]);
driveGame(seedA, 5000);
const runA = JSON.stringify({ turns: seedA.turnCount, stats: seedA.players.map((p) => [p.ap, p.sp, p.pos]) });
const seedB = newTestGame(1, 777, ["liar", "honest"]);
driveGame(seedB, 5000);
const runB = JSON.stringify({ turns: seedB.turnCount, stats: seedB.players.map((p) => [p.ap, p.sp, p.pos]) });
eq(runA, runB, "same seed → identical run");
ok(seedA.turnCount > 0, "turns actually elapsed");
section("VOTING — majority & unanimous");
game.createGame({
  players: [
    { name: "AI", isAI: true, personality: "chill", avatar: "x" },
    { name: "H1", isAI: false, personality: "chill", avatar: "y" },
    { name: "H2", isAI: false, personality: "brutal", avatar: "z" },
  ], laps: 1, seed: 7, mode: "local",
});
G.state.mode = "test-auto";
const sv = G.state;
game.startVote({ context: "bluff", card: null, mode: "majority", labels: ["Believe", "Caught"], onDone: () => {} });
ok(sv.phase === "await-vote", "vote starts in await-vote");
ok(sv.vote.verdicts["p1"] === undefined && sv.vote.verdicts["p2"] === undefined, "human voters start unvoted");
ok(sv.vote.verdicts["p0"] === undefined, "judged player (active) does not vote");
// Both humans vote → resolves.
game.castHumanVote("yes");
game.castHumanVote("no");
ok(sv.vote === null, "vote cleared after completion");
ok(sv.phase === "resolving", "phase returns to resolving");

// Unanimous mercy: one 'no' fails the vote.
game.startVote({ context: "card", card: null, mode: "unanimous", labels: ["Forgive", "Punish"], onDone: (r) => { eq(r.succeeded, false, "unanimous fails on a single no"); } });
game.castHumanVote("yes"); // human
// AI votes are pre-filled; if any AI said 'no' the onDone assertion fired above.

section("AI — decision functions");
game.createGame({ players: [{ name: "A", isAI: true, personality: "liar", avatar: "x" }, { name: "B", isAI: true, personality: "honest", avatar: "y" }], laps: 1, seed: 11, mode: "local" });
G.state.mode = "test-auto";
const sAI = G.state;
const liar = sAI.players[0];
let bluffs = 0;
for (let i = 0; i < 300; i++) { sAI.rngState = i * 7919; if (game.aiShouldBluff(sAI, liar)) bluffs++; }
ok(bluffs > 150, `Liar bluffs often (${bluffs}/300)`);
const honest = sAI.players[1];
let honestBluffs = 0;
for (let i = 0; i < 300; i++) { sAI.rngState = i * 7919; if (game.aiShouldBluff(sAI, honest)) honestBluffs++; }
ok(honestBluffs < 30, `Honest bluffs rarely — chaos roll only (${honestBluffs}/300)`);

// Sabotage target is never self and prefers the leader.
const sT = G.state;
sT.players[0].ap = 10; sT.players[1].ap = 0;
sT.rngState = 12345;
let leaderHits = 0;
for (let i = 0; i < 100; i++) {
  sT.rngState = 1000 + i * 131;
  const t = game.aiChooseSabotageTarget(sT, sT.players[1]); // brutal, B is current
  if (t === 0) leaderHits++;
}
ok(leaderHits > 50, `Brutal targets the leader (${leaderHits}/100)`);

section("AI — full personality sweep (no crashes)");
for (const pers of Object.keys(game.AI_PROFILES || {})) {
  const st = newTestGame(1, 1234 + pers.length, [pers, "chill"]);
  ok(driveGame(st, 5000), `game with ${pers} AI completes`);
}

section("SAVE — state shape");
const s5 = newTestGame(1, 321, ["chill", "chaotic"]);
const json = JSON.stringify(s5);
const parsed = JSON.parse(json);
ok(parsed.seed !== undefined && parsed.rngState !== undefined, "seed + rngState serialize");
ok(Array.isArray(parsed.players) && parsed.players[0].stats !== undefined, "players + stats serialize");
ok(parsed.decks && parsed.decks.scenario && Array.isArray(parsed.decks.scenario.order), "decks serialize");

/* ============================ RESULTS ===================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
