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
eq(counts.vote, 3, "3 vote tiles");
eq(counts.duel, 2, "2 duel tiles");
eq(counts.safe, 7, "7 safe tiles");
eq(counts.chaos, 3, "3 chaos tiles");
eq(counts.double, 2, "2 double tiles");
eq(counts.final, 1, "1 final tile");
eq(AWKWARD_BOARD[0].type, "safe", "tile 0 is safe (START)");
eq(AWKWARD_BOARD[53].type, "final", "tile 53 is final combo");
AWKWARD_BOARD.forEach((t, i) => ok(typeof t.name === "string" && t.name.length > 0, `tile ${i} has name`));

/* ============================ 2. CARDS ==================================== */
section("CARDS");
eq(AWKWARD_CARDS.length, 202, "202 cards total");
const DECK_SIZE = { scenario: 36, choice: 36, risk: 36, sabotage: 36, vote: 48, duel: 10 };
const byType = cardsByType(AWKWARD_CARDS);
DECK_TYPES.forEach((t) => eq(byType[t].length, DECK_SIZE[t], `deck ${t} has ${DECK_SIZE[t]} cards`));
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
  if (c.type === "vote" && !["majority", "unanimous", "split"].includes(c.mode)) cardErrs++;
  if (c.type === "vote" && c.mode === "split" && typeof c.splitAp !== "number") cardErrs++;
  if (c.type === "vote" && c.mode !== "split" && (!c.punish || !c.forgive)) cardErrs++;
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
ok(Object.keys(s1.decks).length === 6, "six decks built");
for (const t of DECK_TYPES) {
  eq(s1.decks[t].order.length + s1.decks[t].discard.length, DECK_SIZE[t], `deck ${t} holds ${DECK_SIZE[t]} (order+discard)`);
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

section("SCORING — split dilemmas & lap escalation");
const splitCard = AWKWARD_CARDS.find((c) => c.mode === "split");
ok(!!splitCard, "a split dilemma card exists");
eq(game.splitScore(splitCard, 2, 2).pct, 100, "even split is 100% divisive");
eq(game.splitScore(splitCard, 4, 0).pct, 0, "unanimous split is 0% divisive");
ok(game.splitScore(splitCard, 2, 2).ap > game.splitScore(splitCard, 4, 0).ap, "divisive pays more than unanimous");
ok(game.splitScore(splitCard, 4, 0).unanimous, "unanimous with 3+ voters is flagged");
ok(!game.splitScore(splitCard, 1, 0).unanimous, "2-player unanimity is not punished");

const sl = newTestGame(1, 555, ["chill", "chill"]);
eq(game.lapMultiplier(sl, 0), 1, "lap 1 is ×1");
sl.players[0].lapsDone = 1;
eq(game.lapMultiplier(sl, 0), 2, "lap 2 is ×2");
sl.players[0].lapsDone = 2;
eq(game.cardRewardAp(sl, 0, 3), 9, "lap 3 triples card AP");
eq(game.cardRewardAp(sl, 0, -3), -3, "penalties are never scaled");
sl.players[0].lapsDone = 7;
eq(game.lapMultiplier(sl, 0), 3, "lap multiplier caps at ×3");

section("ENGINE — a dilemma card resolves and scores");
game.createGame({
  players: [
    { name: "H1", isAI: false, personality: "chill", avatar: "x" },
    { name: "H2", isAI: false, personality: "chill", avatar: "y" },
    { name: "H3", isAI: false, personality: "chill", avatar: "z" },
  ], laps: 1, seed: 19, mode: "local",
});
G.state.mode = "test-auto";
const sd = G.state;
sd.current = 0; sd.phase = "resolving"; sd.activeCard = splitCard.id; sd.pending = [];
const apBefore = sd.players[0].ap;
game.startCardVote(splitCard);
ok(sd.phase === "await-vote", "dilemma opens a vote");
eq(sd.vote.labels[0], "Yes", "dilemma uses Yes/No labels");
game.castHumanVote("yes");
game.castHumanVote("no");
eq(sd.players[0].stats.dilemmas, 1, "dilemma counted in stats");
eq(sd.players[0].stats.bestSplit, 100, "even split recorded as 100%");
eq(sd.players[0].sp, 0, "an even split avoids the boring-table SP");
eq(sd.players[0].ap - apBefore, game.splitScore(splitCard, 1, 1).ap, "dilemma pays the split score");

section("DUELS — vote-share scoring");
const ds = game.duelShare(2, 2);
eq(ds.winner, "tie", "2-2 is a tie");
eq(ds.apA, 3, "a tie still pays share + 1");
eq(game.duelShare(3, 0).apA, 8, "unanimous sweep pays share + sweep bonus");
eq(game.duelShare(3, 0).apB, 0, "a swept duelist earns nothing");
eq(game.duelShare(2, 1).apA, 5, "majority win pays share + win bonus");
eq(game.duelShare(2, 1).apB, 1, "the loser still earns their share");
ok(game.duelShare(3, 0).sweep, "sweep flagged");
eq(game.duelShare(0, 0).apA, 2, "no jury → flat 2 AP");

section("DUELS — duplicate cancellation & safe answers");
eq(game.normDuelAnswer("  My Answer!! "), "my answer", "answers normalise for duplicate checks");
eq(game.duelSafetyAp(8, true), 4, "a safe answer only earns half");
eq(game.duelSafetyAp(7, true), 3, "half credit rounds down");
eq(game.duelSafetyAp(8, false), 8, "a real answer keeps full credit");

game.createGame({
  players: ["A", "B", "C", "D"].map((n) => ({ name: n, isAI: false, personality: "chill", avatar: "x" })),
  laps: 1, seed: 31, mode: "local",
});
G.state.mode = "test-auto";
const sdup = G.state;
sdup.current = 0; sdup.phase = "await-duel";
sdup.duel = {
  cardId: AWKWARD_CARDS.find((c) => c.type === "duel").id,
  answers: { 0: "Same Thing", 1: "same thing!!", 2: "Unique answer", 3: "Another one" },
  safety: {}, duplicates: {}, pairs: [], pair: 0, results: [],
};
sdup.duel.duplicates = game.findDuelDuplicates(sdup);
eq(Object.keys(sdup.duel.duplicates).length, 2, "both matching answers are cancelled");
sdup.duel.safety[1] = true;
eq(Object.keys(game.findDuelDuplicates(sdup)).length, 0, "a safe answer never cancels anyone");
sdup.duel.safety = {};
sdup.duel.duplicates = game.findDuelDuplicates(sdup);
sdup.duel.pairs = [[0, 2]];
sdup.duel.pair = 0;
const apDupA = sdup.players[0].ap;
const apClean = sdup.players[2].ap;
game.startDuelVote();
eq(sdup.players[0].ap - apDupA, 0, "the duplicate author scores nothing");
eq(sdup.players[2].ap - apClean, 2, "the original answer wins the pairing by default");
ok(sdup.duel === null, "a cancelled pairing skips the vote and finishes");
ok(sdup.log.some((e) => /duplicate answer, cancelled/.test(e.msg)), "cancellation is logged");

section("DUELS — safe answers earn half in a real vote");
game.createGame({
  players: [
    { name: "Safe", isAI: false, personality: "chill", avatar: "x" },
    { name: "H1", isAI: false, personality: "chill", avatar: "y" },
    { name: "Clean", isAI: false, personality: "chill", avatar: "z" },
    { name: "Bot", isAI: true, personality: "chill", avatar: "w" },
  ], laps: 1, seed: 88, mode: "local",
});
G.state.mode = "test-auto";
const ssafe = G.state;
ssafe.current = 0; ssafe.phase = "await-duel";
ssafe.duel = {
  cardId: AWKWARD_CARDS.find((c) => c.type === "duel").id,
  answers: { 0: "(said nothing, stared into the middle distance)", 1: "beta", 2: "gamma", 3: "delta" },
  safety: { 0: true }, duplicates: {}, pairs: [[0, 2]], pair: 0, results: [],
};
const apSafe = ssafe.players[0].ap;
game.finishDuelPair(0, 2, 2, 0); // 2-0 sweep: share 4 + win 4 = 8, halved by the Safety Quip
eq(ssafe.players[0].ap - apSafe, 4, "a safe answer gets half of the 8 AP sweep");
eq(ssafe.players[2].ap, 0, "the clean answer earned nothing from a 0-vote share");
ok(ssafe.log.some((e) => /safe ×½/.test(e.msg)), "the half-credit is visible in the log");

section("DUELS — a full round resolves headlessly");
const duelCard = AWKWARD_CARDS.find((c) => c.type === "duel");
ok(!!duelCard && Array.isArray(duelCard.answers) && duelCard.answers.length >= 4, "duel cards ship canned bot answers");
game.createGame({
  players: [
    { name: "A", isAI: true, personality: "liar", avatar: "x" },
    { name: "B", isAI: true, personality: "chill", avatar: "y" },
    { name: "C", isAI: true, personality: "brutal", avatar: "z" },
  ], laps: 1, seed: 4242, mode: "local",
});
G.state.mode = "test-auto";
const sdu = G.state;
sdu.current = 0; sdu.phase = "resolving"; sdu.activeCard = duelCard.id; sdu.pending = [];
const apStart = sdu.players.map((p) => p.ap);
game.startDuel(duelCard);
ok(sdu.duel === null, "duel finished and cleared");
ok(["resolving", "await-roll", "game-over"].includes(sdu.phase), `control returns to the tile flow (${sdu.phase})`);
const gained = sdu.players.map((p, i) => p.ap - apStart[i]);
ok(gained.some((g) => g > 0), `duelists were paid by vote share (${gained.join("/")})`);
ok(gained.every((g) => g >= 0), "duels never take AP away");
ok(sdu.players.reduce((n, p) => n + p.stats.duelsWon, 0) >= 1, "a duel winner was recorded");
ok(sdu.log.some((e) => /⚔️/.test(e.msg)), "the duel is logged");

section("DUELS — answers & pairing bookkeeping");
game.createGame({
  players: [
    { name: "H1", isAI: false, personality: "chill", avatar: "x" },
    { name: "H2", isAI: false, personality: "chill", avatar: "y" },
    { name: "Bot1", isAI: true, personality: "chill", avatar: "z" },
    { name: "Bot2", isAI: true, personality: "chill", avatar: "w" },
  ], laps: 1, seed: 77, mode: "local",
});
G.state.mode = "test-auto";
const sdh = G.state;
sdh.duel = { cardId: duelCard.id, answers: {}, pairs: [], pair: 0, results: [] };
sdh.phase = "await-duel";
eq(game.duelPendingHumans(sdh).length, 2, "two humans owe answers");
sdh.duel.answers[0] = "my terrible answer";
eq(game.duelAnswered(sdh).length, 1, "answered ids are tracked");
eq(game.duelPendingHumans(sdh).length, 1, "one human still owes an answer");
const botAnswer = game.aiDuelAnswer(sdh, duelCard, 2);
ok(duelCard.answers.includes(botAnswer), "AI answers come from the card pool");
sdh.duel.answers[2] = botAnswer;
sdh.duel.answers[3] = game.aiDuelAnswer(sdh, duelCard, 3);
game.submitDuelAnswer("second human answer");
ok(sdh.duel && sdh.duel.pairs.length === 2, "all answers in → pairings drawn");
eq(sdh.phase, "await-vote", "the first head-to-head vote opens");
for (let i = 0; i < 12 && sdh.duel; i++) game.castHumanVote("yes");
ok(sdh.duel === null, "the duel resolves to the end");
ok(sdh.log.some((e) => e.msg.includes("second human answer")), "the write-in is revealed in the duel log");
ok(sdh.log.some((e) => e.msg.includes("my terrible answer")), "every answer goes on the record");

section("DUELS — voters can be scoped to the table");
game.createGame({ players: [{ name: "H1", isAI: false, personality: "chill", avatar: "x" }, { name: "H2", isAI: false, personality: "chill", avatar: "y" }, { name: "Bot", isAI: true, personality: "chill", avatar: "z" }], laps: 1, seed: 5, mode: "local" });
G.state.mode = "test-auto";
const svs = G.state;
game.startVote({ context: "duel", card: null, mode: "majority", labels: ["A", "B"], texts: ["one", "two"], voters: [0, 2], quiet: true, onDone: () => {} });
eq(svs.phase, "await-vote", "duel vote waits for its scoped human voter");
ok(svs.vote.verdicts["p2"] !== undefined, "the scoped AI voter decides immediately");
ok(svs.vote.verdicts["p1"] === undefined, "players outside the pairing do not vote");
game.castHumanVote("no");
eq(svs.vote, null, "the scoped human vote completes the pairing");

section("WAGER — double or nothing");
const wagerGame = (ap) => {
  game.createGame({ players: [
    { name: "H", isAI: false, personality: "chill", avatar: "x" },
    { name: "Bot", isAI: true, personality: "chill", avatar: "y" },
  ], laps: 1, seed: 9, mode: "local" });
  G.state.mode = "test-auto";
  G.state.phase = "resolving";
  G.state.current = 0;
  G.state.players[0].ap = ap;
  return G.state;
};
const wCard = AWKWARD_CARDS.find((c) => c.type === "scenario");
ok(game.wagerEligible(wCard), "scenario cards can be wagered on");
ok(!game.wagerEligible(duelCard), "duel cards cannot (the whole table is the bet)");
ok(game.wagerEligible(AWKWARD_CARDS.find((c) => c.type === "sabotage")), "sabotage cards can be wagered on");

const sw1 = wagerGame(5);
ok(game.canWager(sw1, 0), "a fresh lap allows a wager");
ok(game.takeWager(sw1, 0), "the wager is accepted");
ok(!game.canWager(sw1, 0), "only one wager on the table at a time");
game.applyDeltas(sw1, 0, 3, 0, "(card)");
eq(sw1.players[0].ap, 8, "the card pays before settlement");
const rW1 = game.settleWager(sw1, 0);
eq(rW1.hit, true, "a positive card swing wins the wager");
eq(sw1.players[0].ap, 11, "winnings are doubled (8 + 3)");
eq(sw1.players[0].stats.wagersWon, 1, "wager wins are recorded");
ok(!game.wagerOpen(sw1.players[0]), "the settled wager closes");

const sw2 = wagerGame(5);
game.takeWager(sw2, 0);
game.applyDeltas(sw2, 0, 0, 2, "(refused)");
const rW2 = game.settleWager(sw2, 0);
eq(rW2.hit, false, "a card with no AP gain busts the wager");
eq(sw2.players[0].ap, 3, "the 2 AP stake is lost");
eq(sw2.players[0].stats.wagersLost, 1, "wager losses are recorded");

const sw3 = wagerGame(5);
game.takeWager(sw3, 0);
game.settleWager(sw3, 0);
ok(!game.canWager(sw3, 0), "one wager per lap (same lap is blocked)");
sw3.players[0].lapsDone = 1;
ok(game.canWager(sw3, 0), "the next lap restores the wager");

const sw4 = wagerGame(0);
sw4.activeCard = wCard.id;
sw4.pending = [];
game.takeWager(sw4, 0);
game.applyDeltas(sw4, 0, 2, 0, "(card)");
game.resolveNext();
eq(sw4.players[0].ap, 4, "resolveNext settles the wager automatically");
ok(!game.wagerOpen(sw4.players[0]), "the wager does not leak past the card");

const sw5 = wagerGame(1);
sw5.players[0].isAI = true;
sw5.players[1].ap = 9;
let aiWagers = 0;
for (let i = 0; i < 60; i++) {
  sw5.players[0].wagerApAt = null;
  sw5.players[0].wagerLap = null;
  sw5.rngState = 100 + i * 37;
  if (game.aiMaybeWager(sw5, wCard)) aiWagers++;
}
ok(aiWagers > 15, `trailing bots gamble (${aiWagers}/60)`);

section("RISK — bullseye bands");
const riskDie = AWKWARD_CARDS.find((c) => c.type === "risk" && c.mech === "die");
const riskCoin = AWKWARD_CARDS.find((c) => c.type === "risk" && c.mech === "coin");
const riskVote = AWKWARD_CARDS.find((c) => c.type === "risk" && c.mech === "believe");
ok(!!riskDie && !!riskCoin && !!riskVote, "all three risk mechanics exist in the deck");
eq(game.riskBand(riskDie, { roll: 6 }), "bullseye", "a 6 is a bullseye");
eq(game.riskBand(riskDie, { roll: 5 }), "good", "a 5 is good");
eq(game.riskBand(riskDie, { roll: 4 }), "near", "a 4 is only a near miss now");
eq(game.riskBand(riskDie, { roll: 3 }), "miss", "3 and under miss");
eq(game.riskBand(riskCoin, { heads: true }), "good", "the coin has no middle: heads is good");
eq(game.riskBand(riskCoin, { heads: false }), "miss", "…and tails misses");
eq(game.riskBand(riskVote, { yes: 3, no: 0 }), "bullseye", "a unanimous table is a bullseye");
eq(game.riskBand(riskVote, { yes: 2, no: 1 }), "good", "a believing majority is good");
eq(game.riskBand(riskVote, { yes: 1, no: 1 }), "near", "a tie only half-counts");
eq(game.riskBand(riskVote, { yes: 0, no: 2 }), "miss", "a disbelieving table misses");

const riskGame = () => {
  game.createGame({ players: [
    { name: "H", isAI: false, personality: "chill", avatar: "x" },
    { name: "Bot", isAI: true, personality: "chill", avatar: "y" },
  ], laps: 1, seed: 33, mode: "local" });
  G.state.mode = "test-auto";
  G.state.phase = "resolving";
  G.state.current = 0;
  G.state.activeCard = riskDie.id;
  G.state.pending = [];
  return G.state;
};
const rkPay = riskGame();
const payBull = game.riskPayout(riskDie, "bullseye", rkPay, 0);
const payGood = game.riskPayout(riskDie, "good", rkPay, 0);
const payNear = game.riskPayout(riskDie, "near", rkPay, 0);
const payMiss = game.riskPayout(riskDie, "miss", rkPay, 0);
eq(payBull.ap, riskDie.reward.ap * 2, "a bullseye doubles the card's reward");
eq(payGood.ap, riskDie.reward.ap, "good pays the card as written");
eq(payNear.ap, Math.max(1, Math.round(riskDie.reward.ap / 2)), "near pays half");
eq(payNear.sp, 0, "a near miss costs no shame");
eq(payMiss.ap, riskDie.penalty.ap, "a miss takes the card's penalty");
eq(payMiss.sp, (riskDie.penalty.sp || 0) + 1, "…plus a shame point");

const rkBehind = riskGame();
rkBehind.players[0].ap = 2;
rkBehind.players[1].ap = 9;
game.riskOutcome(riskDie, { roll: 6 });
eq(rkBehind.players[0].ap, 2 + riskDie.reward.ap * 2, "the bullseye payout lands on the scoreboard");
eq(rkBehind.players[0].stats.bullseyes, 1, "bullseyes are recorded");
eq(rkBehind.phase, "await-roll", "a bullseye from behind reopens the roll phase (bonus roll)");
eq(rkBehind.current, 0, "the bonus roll goes to the same player");
ok(rkBehind.log.some((e) => e.msg.includes("bonus roll")), "the bonus roll is announced in the log");

const rkAhead = riskGame();
rkAhead.players[0].ap = 20;
rkAhead.players[1].ap = 1;
game.riskOutcome(riskDie, { roll: 6 });
eq(rkAhead.current, 1, "leaders get the bullseye payout but no bonus roll");
eq(rkAhead.phase, "await-roll", "the turn simply passes");
eq(rkAhead.extraRollFor, null, "no stale extra-roll flag is left behind");

const rkMiss = riskGame();
rkMiss.players[0].ap = 5;
game.riskOutcome(riskDie, { roll: 2 });
eq(rkMiss.players[0].ap, 5 + riskDie.penalty.ap, "a miss applies the card penalty");
eq(rkMiss.players[0].sp, (riskDie.penalty.sp || 0) + 1, "a miss also costs a shame point");
eq(rkMiss.players[0].stats.risksLost, 1, "misses are recorded");

section("SCREW — rush a rival's answer");
const screwGame = (curIdx, ap0, ap1) => {
  game.createGame({ players: [
    { name: "H", isAI: false, personality: "chill", avatar: "x" },
    { name: "Bot", isAI: true, personality: "chill", avatar: "y" },
  ], laps: 1, seed: 21, mode: "local" });
  G.state.mode = "test-auto";
  G.state.phase = "resolving";
  G.state.current = curIdx;
  G.state.activeCard = wCard.id;
  G.state.pending = [];
  G.state.screw = null;
  G.state.players[0].ap = ap0;
  G.state.players[1].ap = ap1;
  return G.state;
};
ok(game.screwEligible(wCard), "scenario cards can be screwed");
ok(!game.screwEligible(duelCard), "duels cannot (nobody answers alone)");

const ssc1 = screwGame(1, 6, 4);
ok(game.canScrew(ssc1, 0), "a rival's open card can be screwed");
ok(!game.canScrew(ssc1, 1), "you cannot screw your own card");
ok(game.takeScrew(ssc1, 0), "the token is spent");
ok(!game.canScrew(ssc1, 0), "one screw on the table at a time");
ok(game.screwOpen(ssc1) !== null, "the screw is on the clock");
ok(game.screwTargetedAt(ssc1, 1), "the target is under the gun");
game.applyDeltas(ssc1, 1, 3, 0, "(card)");
const rS1 = game.settleScrew(ssc1);
eq(rS1.won, false, "a target who still scores backfires the screw");
eq(ssc1.players[0].ap, 4, "the attacker loses 2 AP when it backfires");
eq(ssc1.players[1].ap, 7, "the target keeps its card score");
eq(ssc1.players[0].stats.screwsBackfired, 1, "backfires are recorded");
ok(game.screwOpen(ssc1) === null, "the screw closes once settled");

const ssc2 = screwGame(1, 6, 4);
game.takeScrew(ssc2, 0);
const rS2 = game.settleScrew(ssc2);
eq(rS2.won, true, "a target who fumbles pays for it");
eq(ssc2.players[1].ap, 2, "the target loses 2 AP");
eq(ssc2.players[1].sp, 1, "the target takes +1 SP");
eq(ssc2.players[0].ap, 8, "the attacker banks 2 AP");
eq(ssc2.players[0].stats.screwsLanded, 1, "landed screws are recorded");

const ssc3 = screwGame(1, 6, 4);
game.takeScrew(ssc3, 0);
game.settleScrew(ssc3);
ok(!game.canScrew(ssc3, 0), "one screw per lap");
ssc3.players[0].lapsDone = 1;
ok(game.canScrew(ssc3, 0), "the next lap restores the token");

const ssc4 = screwGame(1, 6, 4);
game.takeScrew(ssc4, 0);
game.resolveNext();
eq(ssc4.players[1].ap, 2, "resolveNext settles the screw with its card");
ok(ssc4.screw === null, "no screw leaks past its card");

const ssc5 = screwGame(1, 6, 4);
let panics = 0;
for (let i = 0; i < 200; i++) {
  ssc5.rngState = 9000 + i * 137;
  if (game.screwRushResponse(ssc5, wCard).kind === "refuse") panics++;
}
ok(panics > 50 && panics < 190, `a rushed bot panics some of the time (${panics}/200)`);

const ssc6 = screwGame(0, 6, 4);
let botScrews = 0;
for (let i = 0; i < 40; i++) {
  ssc6.screw = null;
  ssc6.players[1].screwLap = null;
  ssc6.rngState = 500 + i * 211;
  if (game.aiMaybeScrew(ssc6)) botScrews++;
}
ok(botScrews > 0 && botScrews < 40, `bots rush humans now and then (${botScrews}/40)`);
const ssc7 = screwGame(1, 6, 4);
ok(!game.aiMaybeScrew(ssc7), "bots never bother rushing a bot");

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
