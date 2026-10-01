/**
 * The Awkward Game — core engine + UI glue + AI + save/load + multiplayer client
 * ==============================================================================
 * Sections:
 *   1. Utilities (RNG, DOM, sound)
 *   2. Constants
 *   3. State
 *   4. Deck management
 *   5. Engine (create / roll / move / tile resolution)
 *   6. Voting
 *   7. AI
 *   8. Turn orchestration (human + AI turns, local vs room)
 *   9. Save / Load (LocalStorage)
 *  10. Multiplayer client (rooms/*.php)
 *  11. Rendering (board, tokens, scoreboard, log)
 *  12. Modals & interactions
 *  13. Setup screen & init
 *
 * Requires data/board.js and data/cards.js to be loaded first (plain globals).
 * The engine functions are deliberately UI-free so Node tests can exercise them.
 */
"use strict";

/* ============================================================================
 * 1. UTILITIES
 * ========================================================================= */

/** Deterministic PRNG (mulberry32). State lives in state.rngState so games
 *  are reproducible from a seed and survive save/load. */
function rngNext(state) {
  let t = (state.rngState = (state.rngState + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rngInt(state, n) { return Math.floor(rngNext(state) * n); }
function rngChoice(state, arr) { return arr[rngInt(state, arr.length)]; }
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const HAS_DOM = typeof document !== "undefined";
/** Bot pacing (seconds) for solo play: admin-area value if set, else 2.5s. */
function aiStepSeconds() {
  try {
    const v = parseFloat(localStorage.getItem("awkward-ai-step"));
    if (!isNaN(v)) return Math.max(0, Math.min(600, v)); // same clamp the admin area enforces server-side
  } catch (e) {}
  return 2.5;
}

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* --- Tiny synth SFX (muted by default) --- */
const SFX = {
  ctx: null,
  play(kind) {
    if (!HAS_DOM || !G.settings.sound) return;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      const now = this.ctx.currentTime;
      const conf = {
        dice: [[440, 0, 0.06], [330, 0.07, 0.08]],
        card: [[523, 0, 0.09]],
        vote: [[392, 0, 0.08], [494, 0.09, 0.08], [587, 0.18, 0.12]],
        bad: [[196, 0, 0.2]],
        good: [[523, 0, 0.08], [659, 0.08, 0.08], [784, 0.16, 0.14]],
      }[kind] || [[440, 0, 0.1]];
      conf.forEach(([f, t0, dur], i) => {
        o.frequency.setValueAtTime(f, now + t0);
        g.gain.setValueAtTime(0.08, now + t0);
        g.gain.exponentialRampToValueAtTime(0.0001, now + t0 + dur);
        if (i === conf.length - 1) { o.connect(g); g.connect(this.ctx.destination); o.start(now); o.stop(now + 0.4); }
      });
    } catch (e) { /* audio unavailable — ignore */ }
  },
};

/* ============================================================================
 * 2. CONSTANTS
 * ========================================================================= */

const SAVE_KEY = "awkward-game-save-v1";
const BOARD_SIZE = 54;
const THEMES = ["neon", "corporate", "dark", "love", "chaos"];
const THEME_NAMES = {
  neon: "Neon Party", corporate: "Corporate", dark: "Dark Humor",
  love: "Relationship Edition", chaos: "Chaos Mode",
};
const AVATARS = ["🦆", "🐙", "🦝", "🐸", "🦄", "🐧", "🦉", "🐷", "👽", "🤖", "🐹", "🦖"];

/** Refusal / chicken-out penalties (documented in RULES.md §4–6). */
const PENALTY = {
  SCENARIO_REFUSE_SP: 1,
  CHOICE_REFUSE_SP: 3,
  RISK_CHICKEN_SP: 1,
  SABOTAGE_SKIP_AP: 1,
  LAP_BONUS_AP: 2,
  FINAL_COMBO_BONUS_AP: 10,
};

const AI_PROFILES = {
  chill:   { label: "Chill",   bluff: 0.10, risk: 0.30, sabotage: 0.20, punish: 0.20, chaos: 0.05 },
  chaotic: { label: "Chaotic", bluff: 0.50, risk: 0.70, sabotage: 0.60, punish: 0.50, chaos: 0.25 },
  brutal:  { label: "Brutal",  bluff: 0.20, risk: 0.60, sabotage: 0.85, punish: 0.75, chaos: 0.10 },
  honest:  { label: "Honest",  bluff: 0.00, risk: 0.20, sabotage: 0.10, punish: 0.30, chaos: 0.05 },
  liar:    { label: "Liar",    bluff: 0.80, risk: 0.50, sabotage: 0.40, punish: 0.60, chaos: 0.15 },
};

/* ============================================================================
 * 3. STATE
 * ========================================================================= */

/** Global game object. `G.state` is the serialized game; G holds UI-only bits. */
const G = {
  state: null,
  settings: { theme: "neon", sound: false },
  turnToken: 0,       // incremented to cancel stale timers (movement, AI pauses)
  tilePos: [],        // tile index -> {row, col}
  mpTimer: null,      // multiplayer poll timer
  lastRenderedSeq: -1,
  shownCardKey: null, // which card modal instance is open (room sync)
  mpPollMs: null,     // current multiplayer poll interval
};

function freshState(seed) {
  return {
    v: 1,
    seed: seed >>> 0,
    rngState: seed >>> 0,
    phase: "setup",            // setup | await-roll | moving | resolving | await-vote | game-over
    mode: "local",             // local | room
    room: null,                // client-side: {code, playerId}
    players: [],
    current: 0,
    lap: 1,
    laps: 3,                   // 0 = endless
    turnCount: 0,
    die: null,
    decks: {},
    pending: [],               // card ids queued for the current tile
    activeCard: null,          // id of the card being resolved
    comboEligible: false,      // final-combo survival tracker
    vote: null,                // active vote (see startVote)
    voteSeq: 0,
    log: [],
    seq: 0,                    // state version, bumped on every mutation
  };
}

function newPlayer(id, name, avatar, isAI, personality) {
  return {
    id, name, avatar, isAI, personality: personality || "chill",
    pos: 0, ap: 0, sp: 0, tokens: 2, lapsDone: 0,
    stats: { bluffsBelieved: 0, bluffsCaught: 0, confessions: 0, timesSabotaged: 0, chaosTriggered: 0, risksTaken: 0, risksWon: 0 },
  };
}

function log(msg, cls) {
  if (!G.state) return;
  G.state.log.push({ t: Date.now(), msg, cls: cls || "" });
  if (G.state.log.length > 200) G.state.log.splice(0, G.state.log.length - 200);
  if (HAS_DOM) renderLog();
}
function bump() { if (G.state) G.state.seq++; }

const cur = () => G.state.players[G.state.current];
/** In room mode, true when the current player is this browser's human. */
function isMyLocalTurn() {
  if (!G.state || G.state.mode !== "room") return true;
  return G.state.room && G.state.room.playerId === cur().id;
}

/* ============================================================================
 * 4. DECK MANAGEMENT
 * ========================================================================= */

function buildDecks(state) {
  const byType = cardsByType(AWKWARD_CARDS);
  for (const t of DECK_TYPES) {
    const order = byType[t].map((c) => c.id);
    shuffleArr(order, state);
    state.decks[t] = { order, discard: [] };
  }
}
/** Fisher–Yates using the game's seeded RNG. */
function shuffleArr(arr, state) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rngInt(state, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
const CARD_BY_ID = {};
AWKWARD_CARDS.forEach((c) => (CARD_BY_ID[c.id] = c));

/** Draw one card of `type`; reshuffles the discard pile when the deck is dry. */
function drawCard(state, type) {
  const d = state.decks[type];
  if (!d) return null;
  if (d.order.length === 0) {
    d.order = d.discard.splice(0);
    shuffleArr(d.order, state);
  }
  if (d.order.length === 0) return null;
  const id = d.order.shift();
  d.discard.push(id);
  return CARD_BY_ID[id];
}

/* ============================================================================
 * 5. ENGINE
 * ========================================================================= */

function createGame(config) {
  const seed = config.seed !== undefined ? config.seed >>> 0 : (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  const s = freshState(seed);
  s.mode = config.mode || "local";
  s.laps = config.laps;
  s.players = config.players.map((p, i) => newPlayer("p" + i, p.name, p.avatar, p.isAI, p.personality));
  buildDecks(s);
  s.phase = "await-roll";
  G.state = s;
  log(`🎲 A new game begins — ${s.players.length} players, ${s.laps === 0 ? "endless" : s.laps + " lap(s)"}.`);
  if (HAS_DOM) renderAll();
}

function rollDie(state) {
  return 1 + rngInt(state, 6);
}

/** Synchronous movement (used by tests + PHP semantics): advance and wrap. */
function movePlayer(state, steps) {
  const p = state.players[state.current];
  const dest = p.pos + steps;
  p.pos = dest % BOARD_SIZE;
  if (dest >= BOARD_SIZE) {
    p.lapsDone++;
    p.ap += PENALTY.LAP_BONUS_AP;
    state.lap = Math.max(state.lap, p.lapsDone);
  }
  return p.pos;
}

/** Which decks does this tile type draw from? */
function cardsForTile(tileType) {
  switch (tileType) {
    case "scenario": return ["scenario"];
    case "choice":   return ["choice"];
    case "risk":     return ["risk"];
    case "sabotage": return ["sabotage"];
    case "vote":     return ["vote"];
    case "double":   return ["scenario", "choice"];
    case "final":    return ["scenario", "choice", "risk"];
    default: return [];
  }
}

/** Apply AP/SP deltas to a player and log them. */
function applyDeltas(state, playerIdx, ap, sp, why) {
  const p = state.players[playerIdx];
  if (!p) return;
  if (ap) p.ap += ap;
  if (sp) p.sp += sp;
  const bits = [];
  if (ap) bits.push(`${ap > 0 ? "+" : ""}${ap} AP`);
  if (sp) bits.push(`${sp > 0 ? "+" : ""}${sp} SP`);
  if (bits.length) log(`${p.avatar} ${p.name}: ${bits.join(", ")} ${why || ""}`, ap < 0 || sp > 0 ? "bad" : "good");
  if (HAS_DOM) renderScoreboard();
}

/** Entry point after movement: resolve the landed tile (deals cards). */
function resolveTile() {
  const s = G.state;
  const p = cur();
  const tile = AWKWARD_BOARD[p.pos];

  if (tile.type === "chaos") {
    p.tokens++;
    p.stats.chaosTriggered++;
    const t = rngChoice(s, DECK_TYPES);
    log(`🌀 ${p.name} hit the ${tile.name}! +1 Sabotage Token. A wild ${t} card appears…`);
    const card = drawCard(s, t);
    s.pending = card ? [card.id] : [];
    s.activeCard = null;
    s.comboEligible = false;
    s.phase = "resolving";
    bump();
    resolveNext();
    return;
  }

  if (tile.type === "safe") {
    log(`🛋️ ${p.name} rests at the ${tile.name}. Nothing happens. Bliss.`);
    finishTile(false);
    return;
  }

  // Double Trouble grants a bonus token (RULES.md §5).
  if (tile.type === "double") {
    p.tokens++;
    log(`🎟️ ${p.name} gains +1 Sabotage Token (Double Trouble).`);
  }

  const types = cardsForTile(tile.type);
  s.pending = types.map((t) => drawCard(s, t)).filter(Boolean).map((c) => c.id);
  s.comboEligible = tile.type === "final";
  s.activeCard = null;
  s.phase = "resolving";
  bump();
  if (s.pending.length === 0) { log("The deck offers nothing. Moving on."); finishTile(false); return; }
  resolveNext();
}

/** Resolve the next pending card (or finish the tile if none left). */
function resolveNext() {
  const s = G.state;
  if (s.phase === "game-over") return;
  const id = s.pending.shift();
  if (!id) { finishTile(true); return; }
  s.activeCard = id;
  bump();
  if (HAS_DOM) showCard(CARD_BY_ID[id]);
  else if (s.mode === "test-auto") resolveActiveCardForAI(); // headless test hook
}

/** Called after every card on the tile is dealt with. combo counts on final. */
function finishTile(tileCompleted) {
  const s = G.state;
  const p = cur();
  if (tileCompleted && s.comboEligible && p) {
    p.ap += PENALTY.FINAL_COMBO_BONUS_AP;
    log(`🏆 ${p.name} survived the FINAL COMBO! +${PENALTY.FINAL_COMBO_BONUS_AP} AP. Legendary.`);
    if (HAS_DOM) renderScoreboard();
  }
  s.activeCard = null;
  s.comboEligible = false;
  s.phase = "turn-end";
  bump();
  endTurn();
}

/* ============================================================================
 * 6. VOTING
 * ========================================================================= */

/**
 * Start a vote among all players except the active one.
 * opts: { context:'bluff'|'believe'|'card', card, mode:'majority'|'unanimous',
 *         labels:[positive,negative], onDone(result) }
 * result = { yes, no, tally, succeeded, votes:[{name,avatar,verdict}] }
 * onDone is UI-local (not serialized); the PHP backend applies its own effects.
 */
function startVote(opts) {
  const s = G.state;
  const voters = s.players.filter((_, i) => i !== s.current);
  s.vote = {
    seq: ++s.voteSeq,
    context: opts.context,
    cardId: opts.card ? opts.card.id : null,
    mode: opts.mode || "majority",
    labels: opts.labels,
    verdicts: {},               // playerId -> 'yes' | 'no'
    onDone: opts.onDone,        // local UI only
  };
  s.phase = "await-vote";
  bump();
  const judged = cur();
  for (const v of voters) {
    if (v.isAI) {
      s.vote.verdicts[v.id] = aiVoteOnPlayer(s, v, s.current, opts.context);
      botBanter("judge", v, { target: judged.name });
    }
  }
  if (HAS_DOM) openVoteModal();
  maybeFinishVote();
}

/** True when every voter has weighed in. */
function voteComplete(state) {
  if (!state.vote) return true;
  const voters = state.players.filter((_, i) => i !== state.current);
  return voters.every((v) => state.vote.verdicts[v.id] === "yes" || state.vote.verdicts[v.id] === "no");
}

/** Tally + finish the vote when complete. */
function maybeFinishVote() {
  const s = G.state;
  if (!s.vote || !voteComplete(s)) { if (HAS_DOM) renderVoteModal(); return; }
  const votes = s.players
    .filter((_, i) => i !== s.current)
    .map((v) => ({ name: v.name, avatar: v.avatar, verdict: s.vote.verdicts[v.id] || "abstain" }));
  const yes = votes.filter((v) => v.verdict === "yes").length;
  const no = votes.filter((v) => v.verdict === "no").length;
  const succeeded = s.vote.mode === "unanimous" ? no === 0 && yes > 0 : yes >= no;
  // Bots announce their verdicts (targeted at whoever is being judged).
  s.players.forEach((v, i) => {
    if (!v.isAI || i === s.current) return;
    const vd = votes.find((x) => x.name === v.name);
    if (vd && (vd.verdict === "yes" || vd.verdict === "no")) {
      botBanter(vd.verdict === "yes" ? "voteYes" : "voteNo", v, { target: cur().name });
    }
  });
  const result = { yes, no, tally: `${yes}–${no}`, succeeded, votes, context: s.vote.context, labels: s.vote.labels };
  const done = s.vote.onDone;
  s.vote = null;
  s.phase = "resolving";
  bump();
  if (HAS_DOM) showVoteResults(result, done);
  else done && done(result);
}

/** Human vote submission (local/hotseat mode). */
function castHumanVote(verdict) {
  const s = G.state;
  if (!s.vote || s.phase !== "await-vote") return;
  if (verdict !== "yes" && verdict !== "no") return;
  const pendingHuman = s.players.find(
    (v) => !v.isAI && v.id !== cur().id && !s.vote.verdicts[v.id]
  );
  if (!pendingHuman) return;
  s.vote.verdicts[pendingHuman.id] = verdict;
  SFX.play("vote");
  bump();
  maybeFinishVote();
}

/* ============================================================================
 * 7. AI — decision functions (pure; exported for tests)
 * ========================================================================= */

function isLeader(state, playerIdx) {
  let best = 0;
  state.players.forEach((p, i) => { if (p.ap > state.players[best].ap) best = i; });
  return best === playerIdx;
}

/** Should this AI bluff the current scenario? */
function aiShouldBluff(state, ai) {
  const prof = AI_PROFILES[ai.personality] || AI_PROFILES.chill;
  if (rngNext(state) < prof.chaos) return true;
  let p = prof.bluff;
  if (ai.sp >= 6) p *= 0.5;                     // already ashamed — plays safer
  if (isLeader(state, state.current)) p *= 0.7; // leaders have more to lose
  return rngNext(state) < p;
}

/** Should this AI take the risk? */
function aiTakeRisk(state, ai) {
  const prof = AI_PROFILES[ai.personality] || AI_PROFILES.chill;
  if (rngNext(state) < prof.chaos) return true;
  let p = prof.risk;
  if (ai.sp >= 7) p *= 0.6;   // can't afford more shame
  if (ai.ap <= 2) p *= 1.3;   // losing — gamble for a comeback
  return rngNext(state) < p;
}

/** Whom should this AI sabotage? Returns a player index (never itself).
 *  Self is derived from the `ai` argument, so the call is safe even off-turn. */
function aiChooseSabotageTarget(state, ai) {
  const selfIdx = state.players.indexOf(ai);
  const others = state.players
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i !== selfIdx);
  if (others.length === 0) return selfIdx;
  const prof = AI_PROFILES[ai.personality] || AI_PROFILES.chill;
  if (rngNext(state) < prof.chaos) return rngChoice(state, others).i;
  others.sort((a, b) => (b.p.ap - a.p.ap) || (b.p.pos - a.p.pos)); // leader first
  if (prof.sabotage > 0.6 && rngNext(state) < 0.7) return others[0].i;
  const half = others.slice(0, Math.max(1, Math.ceil(others.length / 2)));
  return rngChoice(state, half).i;
}

/** How does this AI vote on target? 'yes' = forgive/believe, 'no' = punish/doubt. */
function aiVoteOnPlayer(state, ai, targetIdx, context) {
  const prof = AI_PROFILES[ai.personality] || AI_PROFILES.chill;
  const target = state.players[targetIdx];
  let pYes = 1 - prof.punish;
  if (isLeader(state, targetIdx)) pYes -= 0.2;
  if (target && target.sp >= 7) pYes += 0.15;
  if (context === "bluff" && ai.personality === "liar") pYes += 0.15;
  if (rngNext(state) < prof.chaos) return rngNext(state) < 0.5 ? "yes" : "no";
  return rngNext(state) < Math.max(0.05, Math.min(0.95, pYes)) ? "yes" : "no";
}

/** What does the current AI do with the active card? */
function aiRespondToCard(state, card) {
  const p = state.players[state.current];
  switch (card.type) {
    case "scenario":
      return { kind: aiShouldBluff(state, p) ? "bluff" : "do" };
    case "choice":
      return { kind: "choice", side: rngNext(state) < (p.personality === "liar" ? 0.6 : 0.5) ? "b" : "a" };
    case "risk":
      return { kind: aiTakeRisk(state, p) ? "risk-take" : "risk-chicken" };
    case "sabotage":
      if (p.tokens > 0 && rngNext(state) < (AI_PROFILES[p.personality] || AI_PROFILES.chill).sabotage) {
        return { kind: "sabotage", target: aiChooseSabotageTarget(state, p) };
      }
      return { kind: "sabotage-skip" };
    default:
      return { kind: "none" }; // vote cards run themselves
  }
}

/* ============================================================================
 * 8. TURN ORCHESTRATION
 * ========================================================================= */

/** Advance to the next player; check end-of-game. */
function endTurn() {
  const s = G.state;
  if (s.phase === "game-over") return;
  s.turnCount++;
  // Game over once EVERY player has completed the required laps.
  if (s.laps > 0 && s.players.every((p) => p.lapsDone >= s.laps)) { gameOver(); return; }
  s.current = (s.current + 1) % s.players.length;
  s.phase = "await-roll";
  s.die = null;
  bump();
  if (HAS_DOM) { renderAll(); scheduleAiTurnIfNeeded(); }
  // In headless test mode the driver loop rolls again when it sees await-roll.
}

function gameOver() {
  const s = G.state;
  s.phase = "game-over";
  bump();
  log("🎬 The game is over. Computing the damage…");
  // Winning bot takes a victory lap in chat.
  if (HAS_DOM && s.mode === "local") {
    const winner = ranking(s)[0];
    if (winner && winner.isAI) {
      BotChat.say("win", winner, { ap: String(winner.ap) });
    }
  }
  if (HAS_DOM) showGameOverModal();
}

/** Rank players: AP desc, then SP asc, then name. */
function ranking(state) {
  return state.players
    .map((p, i) => ({ ...p, idx: i }))
    .sort((a, b) => (b.ap - a.ap) || (a.sp - b.sp) || a.name.localeCompare(b.name));
}

/** End-of-game awards. */
function computeAwards(state) {
  const rank = ranking(state);
  const most = (key) => {
    let best = null;
    for (const p of state.players) if (!best || p.stats[key] > best.stats[key]) best = p;
    return best && best.stats[key] > 0 ? best : null;
  };
  return {
    winner: rank[0],
    bestLiar: most("bluffsBelieved"),
    mostHonest: most("confessions"),
    mostSabotaged: most("timesSabotaged"),
    chaosGremlin: most("chaosTriggered"),
  };
}

/* ---- Rolling (routes local vs room) ---- */
function humanRoll() {
  const s = G.state;
  if (!s || s.phase !== "await-roll" || !isMyLocalTurn()) return;
  if (s.mode === "room") { MP.action({ type: "roll" }); return; }
  doRoll();
}

function doRoll() {
  const s = G.state;
  if (s.phase !== "await-roll") return;
  const n = rollDie(s);
  s.die = n;
  s.phase = "moving";
  bump();
  SFX.play("dice");
  if (HAS_DOM) {
    renderDice(n, true);
    log(`🎲 ${cur().name} rolls a ${n}.`);
    animateMove(n, resolveTile);
  } else {
    movePlayer(s, n);
    resolveTile();
  }
}

/** Step-by-step movement animation. Applies the lap bonus exactly once when
 *  the walk crosses START, before handing control to the tile resolver. */
function animateMove(steps, done) {
  const s = G.state;
  const p = cur();
  const token = ++G.turnToken;
  let remaining = steps;
  let lapped = false;
  const step = () => {
    if (token !== G.turnToken || G.state !== s) return; // stale timer
    if (remaining <= 0) {
      if (lapped) {
        p.lapsDone++;
        p.ap += PENALTY.LAP_BONUS_AP;
        s.lap = Math.max(s.lap, p.lapsDone);
        log(`🔁 ${p.name} completed a lap! +${PENALTY.LAP_BONUS_AP} AP lap bonus.`);
        renderScoreboard();
      }
      done();
      return;
    }
    p.pos = (p.pos + 1) % BOARD_SIZE;
    if (p.pos === 0) lapped = true;
    remaining--;
    renderTokens();
    setTimeout(step, moveStepMs());
  };
  step();
}

/** Milliseconds per tile in the walk animation. 130ms at the default pacing,
 *  growing with the admin setting but capped at 5s/tile so huge values make
 *  the walk deliberate instead of glacial. */
function moveStepMs() {
  return Math.max(130, Math.min(5000, aiStepSeconds() * 1000 * 0.05));
}

/* ---- Card responses (shared by human buttons, AI, tests) ---- */

/**
 * Route a player's response. Local mode applies immediately; room mode sends
 * it to the server which validates + applies it authoritatively.
 */
function submitResponse(resp, said) {
  const s = G.state;
  if (s.mode === "room") { MP.action({ type: "respond", response: resp, said: said || "" }); return; }
  if (said) { addChatMessage(cur().name, said); botBanterReact(said); }
  applyResponse(resp);
}

/** Other players react briefly to a human's spoken answer (solo mode). */
function botBanterReact(said) {
  if (!G.state || G.state.mode !== "local") return;
  const others = G.state.players.filter((p) => p.isAI);
  if (!others.length) return;
  const reactor = others[Math.floor(Math.random() * others.length)];
  const quips = [
    `"${said.slice(0, 60)}" — bold.`,
    `Okay, "${said.slice(0, 50)}" was NOT on my bingo card.`,
    `Respect for actually saying it out loud.`,
    `I'm saving that answer for the vote.`,
    `Absolutely unhinged. Carry on.`,
  ];
  setTimeout(() => addChatMessage(reactor.name, quips[Math.floor(Math.random() * quips.length)]), 900);
}

/** Show a bot's answer on the open card (local mode): called right after the
 *  bot's response resolves so humans read it before the game advances. */
function showLocalBotAnswer(bot, label) {
  const rv = $("#card-reveal");
  if (rv) { rv.innerHTML = `<b>${esc(bot.name)}</b> ${esc(label)}`; rv.hidden = false; }
  log(`💬 ${bot.name} ${label}`);
}

/** Bot speaks about the event it just caused or reacted to (local mode only). */
function botBanter(event, bot, ctx) {
  if (!HAS_DOM || !G.state || G.state.mode !== "local" || !bot || !bot.isAI) return;
  BotChat.say(event, bot, ctx || {});
}

/** Human-readable label for a bot's response, shown on the card. */
function answerLabelFor(resp, card) {
  switch (resp.kind) {
    case "do": return "does it. Bravely. In public.";
    case "bluff": return "BLUFFS: “I totally did it.”";
    case "refuse": return "refuses. Hard pass.";
    case "choice": {
      const opt = card[resp.side];
      return `picks ${resp.side.toUpperCase()}: “${opt ? opt.text.slice(0, 46) : "…"}”`;
    }
    case "risk-take": return "TAKES the risk. Legendary.";
    case "risk-chicken": return "chickens out. Wisely?";
    case "sabotage": {
      const t = G.state.players[resp.target];
      return `sabotages ${t ? t.name : "someone"} with “${card.title}”!`;
    }
    case "sabotage-skip": return "hoards the sabotage token.";
    default: return "hands it to the group…";
  }
}

/** Apply a response to the active card (LOCAL authoritative path).
 *  For the local AI actor, the bot's answer is displayed on the card and the
 *  advance is delayed a beat so humans can read it. */
function applyResponse(resp) {
  const s = G.state;
  const card = CARD_BY_ID[s.activeCard];
  if (!card) { resolveNext(); return; }
  const actor = cur();
  const isBotTurn = actor.isAI && s.mode === "local" && HAS_DOM && s.mode !== "test-auto";
  if (isBotTurn) {
    // Keep the card up; show the answer; advance after a readable beat.
    showLocalBotAnswer(actor, answerLabelFor(resp, card));
    setTimeout(() => { applyResponseInner(resp, card); }, Math.max(700, aiStepSeconds() * 1000 * 0.6));
    return;
  }
  applyResponseInner(resp, card);
}

function applyResponseInner(resp, card) {
  const s = G.state;
  closeModal("#card-modal");
  switch (resp.kind) {
    case "do": {
      cur().stats.confessions++;
      applyDeltas(s, s.current, card.ap, card.sp, "(did it)");
      botBanter("scenarioDo", cur(), { card: card.title });
      resolveNext();
      break;
    }
    case "bluff": {
      botBanter("scenarioBluff", cur(), { card: card.title });
      startVote({
        context: "bluff", card, mode: "majority", labels: ["Believe", "Caught"],
        onDone: (r) => {
          const p = cur();
          if (r.succeeded) {
            p.stats.bluffsBelieved++;
            applyDeltas(s, s.current, card.ap + 1, card.sp, `(bluff believed ${r.tally}, +1 style)`);
          } else {
            p.stats.bluffsCaught++;
            applyDeltas(s, s.current, -card.ap, card.ap, `(CAUGHT lying ${r.tally})`);
          }
          botBanter(r.succeeded ? "bluffBelieved" : "bluffCaught", p, { tally: r.tally });
          resolveNext();
        },
      });
      break;
    }
    case "refuse": {
      const cost = card.type === "choice" ? PENALTY.CHOICE_REFUSE_SP : PENALTY.SCENARIO_REFUSE_SP;
      applyDeltas(s, s.current, 0, cost, "(refused)");
      botBanter("refuse", cur(), { card: card.title });
      resolveNext();
      break;
    }
    case "choice": {
      const opt = card[resp.side];
      if (!opt) { resolveNext(); break; }
      applyDeltas(s, s.current, opt.ap, opt.sp, `(${resp.side.toUpperCase()})`);
      botBanter("choice", cur(), { opt: (opt.text || "").slice(0, 40) });
      resolveNext();
      break;
    }
    case "risk-chicken": {
      applyDeltas(s, s.current, 0, PENALTY.RISK_CHICKEN_SP, "(chickened out)");
      botBanter("riskChickened", cur(), { card: card.title });
      resolveNext();
      break;
    }
    case "risk-take": {
      cur().stats.risksTaken++;
      botBanter("riskTake", cur(), { card: card.title });
      if (card.mech === "coin") {
        const flip = rngNext(s) < 0.5;
        log(`🪙 The coin spins… ${flip ? "HEADS" : "TAILS"}!`);
        riskOutcome(card, flip);
      } else if (card.mech === "die") {
        const r = rollDie(s);
        log(`🎲 Fate rolls a ${r} (needs 4+).`);
        riskOutcome(card, r >= 4);
      } else { // believe
        startVote({
          context: "believe", card, mode: "majority", labels: ["Believe", "Doubt"],
          onDone: (r) => {
            log(`🗣️ The group votes ${r.tally} — ${r.succeeded ? "they believe you!" : "they are NOT convinced."}`);
            riskOutcome(card, r.succeeded);
          },
        });
      }
      break;
    }
    case "sabotage": {
      const p = cur();
      const tIdx = resp.target;
      if (tIdx === null || tIdx === undefined || tIdx === s.current || !s.players[tIdx] || p.tokens <= 0) {
        applyDeltas(s, s.current, PENALTY.SABOTAGE_SKIP_AP, 0, "(skipped sabotage)");
        resolveNext();
        break;
      }
      p.tokens--;
      const t = s.players[tIdx];
      t.stats.timesSabotaged++;
      log(`🗡️ ${p.name} sabotages ${t.name} with “${card.title}”!`);
      if (card.stealToken && t.tokens > 0) { t.tokens--; p.tokens++; log("🎟️ A Sabotage Token was stolen too!"); }
      applyDeltas(s, tIdx, card.tAp, card.tSp, `(sabotaged by ${p.name})`);
      applyDeltas(s, s.current, card.uAp, card.uSp, "");
      botBanter("sabotageUsed", p, { target: t.name, card: card.title });
      botBanter("sabotageVictim", t, { target: t.name });
      resolveNext();
      break;
    }
    case "sabotage-skip": {
      applyDeltas(s, s.current, PENALTY.SABOTAGE_SKIP_AP, 0, "(skipped sabotage)");
      resolveNext();
      break;
    }
    case "none":
    default: {
      // Vote cards resolve via the group; anything else just moves on.
      if (card.type === "vote") startCardVote(card);
      else resolveNext();
      break;
    }
  }
}

/** Group vote triggered by a vote card (local path; server mirrors this). */
function startCardVote(card) {
  startVote({
    context: "card", card, mode: card.mode || "majority", labels: ["Forgive", "Punish"],
    onDone: (r) => {
      if (r.succeeded) applyDeltas(G.state, G.state.current, card.forgive.ap, card.forgive.sp, `(forgiven ${r.tally})`);
      else applyDeltas(G.state, G.state.current, card.punish.ap, card.punish.sp, `(punished ${r.tally})`);
      resolveNext();
    },
  });
}

function riskOutcome(card, success) {
  const s = G.state;
  const p = cur();
  if (success) {
    p.stats.risksWon++;
    SFX.play("good");
    applyDeltas(s, s.current, card.reward.ap, card.reward.sp, "(risk paid off!)");
  } else {
    SFX.play("bad");
    applyDeltas(s, s.current, card.penalty.ap, card.penalty.sp, "(risk failed…)");
  }
  botBanter(success ? "riskWin" : "riskLose", p, { card: card.title });
  resolveNext();
}

/** AI resolves the active card after a short dramatic pause (local mode).
 *  Humans watch the full flow: card -> think (2.2s) -> answer banner + effects
 *  -> beat (1.4s) -> next. Room mode gets the same rhythm from the server. */
function resolveActiveCardForAI() {
  const s = G.state;
  const card = CARD_BY_ID[s.activeCard];
  if (!card) { resolveNext(); return; }
  // Headless/test mode: no timers, resolve synchronously so driver loops work.
  if (s.mode === "test-auto" || !HAS_DOM) {
    applyResponse(aiRespondToCard(s, card));
    return;
  }
  const token = ++G.turnToken;
  setTimeout(() => {
    if (token !== G.turnToken || !G.state || G.state.phase !== "resolving" || G.state.activeCard !== card.id) return;
    const resp = aiRespondToCard(s, card);
    applyResponse(resp);                       // effects land; banner via hooks below
  }, aiStepSeconds() * 1000);
}

/* ============================================================================
 * 9. SAVE / LOAD
 * ========================================================================= */

function saveGame() {
  const s = G.state;
  if (!s) return;
  if (s.phase === "resolving" || s.phase === "await-vote" || s.phase === "moving") {
    toast("Save is only available between turns.");
    return;
  }
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(s));
    toast("Game saved.");
  } catch (e) {
    toast("Could not save (storage unavailable).");
  }
}

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) { toast("No saved game found."); return false; }
    const s = JSON.parse(raw);
    if (!s || s.v !== 1 || !Array.isArray(s.players) || s.players.length < 2) {
      toast("Save is corrupt.");
      return false;
    }
    G.state = s;
    G.turnToken++;      // cancel stray timers
    G.shownCardKey = null;
    if (HAS_DOM) {
      log("💾 Game loaded.");
      renderAll();
      if (s.phase === "await-vote" && s.vote) openVoteModal();
    }
    return true;
  } catch (e) {
    toast("Could not load save.");
    return false;
  }
}

/* ============================================================================
 * 10. MULTIPLAYER CLIENT
 * ========================================================================= */

const MP = {
  async api(endpoint, body) {
    const res = await fetch("rooms/" + endpoint, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error("API " + endpoint + " failed: " + res.status);
    return res.json();
  },
  async create(name, avatar) {
    const r = await this.api("create.php", { name, avatar });
    sessionStorage.setItem("awkward-room", JSON.stringify({ code: r.code, playerId: r.playerId }));
    return r;
  },
  async join(code, name, avatar) {
    const r = await this.api("join.php", { code, name, avatar });
    sessionStorage.setItem("awkward-room", JSON.stringify({ code: r.code, playerId: r.playerId }));
    return r;
  },
  startPolling() {
    clearInterval(G.mpTimer);
    this.setPollRate(1500);
    this.poll();
  },
  /** Poll fast while a bot turn is in progress (watchable pacing), slower
   *  while waiting on humans. Falls back to 1.5s when the server is old. */
  setPollRate(ms) {
    clearInterval(G.mpTimer);
    G.mpTimer = setInterval(() => this.poll(), ms);
  },
  stopPolling() { clearInterval(G.mpTimer); G.mpTimer = null; },
  async poll() {
    if (!G.state || !G.state.room) return;
    try {
      const r = await this.api(`state.php?code=${encodeURIComponent(G.state.room.code)}`);
      if (r.error) return;
      if (r.chat) renderChat(r.chat);
      if (r.state && r.state.seq !== G.lastRenderedSeq) {
        G.lastRenderedSeq = r.state.seq;
        const room = G.state.room;
        const prev = G.state;
        G.state = Object.assign(G.state, r.state, { room, mode: "room" });
        G.turnToken++;
        // Bot just announced its answer: show it ON the card + mirror to log.
        if (G.state.reveal && G.state.reveal.label
            && (!prev.reveal || prev.reveal.label !== G.state.reveal.label)) {
          const who = G.state.players[G.state.current];
          const label = `${who ? who.avatar + " " : ""}${who ? who.name : "Bot"} ${G.state.reveal.label}`;
          log("💬 " + label);
          const rv = $("#card-reveal");
          if (rv && G.state.activeCard === G.state.reveal.card) {
            rv.innerHTML = `<b>${esc(who ? who.name : "Bot")}</b> ${esc(G.state.reveal.label)}`;
            rv.hidden = false;
          }
        }
        // Keep the card modal pinned while the bot works through its turn.
        if (G.state.phase === "resolving" && G.state.activeCard
            && G.shownCardKey !== G.state.activeCard + "@ai") {
          G.shownCardKey = G.state.activeCard + "@ai";
          showCard(CARD_BY_ID[G.state.activeCard]);
        }
        renderAll();
        syncUIFromState();
      }
      // Adapt polling: bots act on a timer, so poll at half that period.
      const s = G.state;
      const botActing = s.players && s.players[s.current] && s.players[s.current].isAI
        && (s.phase === "resolving" || s.phase === "await-roll" || s.phase === "await-vote");
      const wanted = botActing ? Math.max(400, Math.min(1200, ((s.aiStep || 2.5) * 1000) / 2)) : 1500;
      if (!G.mpPollMs || G.mpPollMs !== wanted) { G.mpPollMs = wanted; this.setPollRate(wanted); }
    } catch (e) { /* server unreachable; retry next tick */ }
  },
  async action(payload) {
    if (!G.state || !G.state.room) return;
    try {
      const r = await this.api("update.php", {
        code: G.state.room.code, playerId: G.state.room.playerId, ...payload,
      });
      if (r.error) { toast(r.error); return; }
      if (r.state) {
        G.lastRenderedSeq = r.state.seq;
        const room = G.state.room;
        G.state = Object.assign(G.state, r.state, { room, mode: "room" });
        G.turnToken++;
        renderAll();
        syncUIFromState();
      }
    } catch (e) { toast("Action failed: " + e.message); }
  },
  async sendVote(verdict) {
    if (!G.state || G.state.mode !== "room") { castHumanVote(verdict); return; }
    await this.action({ type: "vote", verdict });
  },
  async sendChat(text) {
    if (!G.state || !G.state.room) return;
    try {
      await this.api("chat.php", { code: G.state.room.code, playerId: G.state.room.playerId, text });
    } catch (e) { toast("Chat failed."); }
  },
};

/** Reconcile modals with authoritative room state after each poll. */
function syncUIFromState() {
  const s = G.state;
  if (!s || s.mode !== "room") return;

  // Card modal
  if (s.phase === "resolving" && s.activeCard) {
    const key = s.activeCard + "@" + s.seq;
    if (G.shownCardKey !== key) {
      G.shownCardKey = key;
      showCard(CARD_BY_ID[s.activeCard]);
    }
  } else if (s.phase !== "await-vote" && $("#card-modal").classList.contains("open")) {
    closeModal("#card-modal");
    G.shownCardKey = null;
  }

  // Vote modal
  if (s.phase === "await-vote" && s.vote) openVoteModal();
  else if (s.phase !== "await-vote" && $("#vote-modal").classList.contains("open")) closeModal("#vote-modal");

  // Game over
  if (s.phase === "game-over") showGameOverModal();
}

/* ============================================================================
 * 11. RENDERING
 * ========================================================================= */

/** Grid positions: 16×13 perimeter = 54 tiles, clockwise from top-left. */
(function computeTilePos() {
  const W = 16, H = 13;
  const pos = [];
  for (let c = 0; c < W; c++) pos.push({ row: 0, col: c });          // top →
  for (let r = 1; r < H; r++) pos.push({ row: r, col: W - 1 });      // right ↓
  for (let c = W - 2; c >= 0; c--) pos.push({ row: H - 1, col: c }); // bottom ←
  for (let r = H - 2; r >= 1; r--) pos.push({ row: r, col: 0 });     // left ↑
  G.tilePos = pos; // 16 + 12 + 15 + 11 = 54
})();

function renderBoard() {
  const board = $("#board");
  board.style.setProperty("--cols", 16);
  board.style.setProperty("--rows", 13);
  board.innerHTML = "";
  AWKWARD_BOARD.forEach((tile, i) => {
    const { row, col } = G.tilePos[i];
    const d = el("div", `tile tile-${tile.type} shape-${i % 4 === 0 ? 0 : i % 3 === 0 ? 2 : i % 2 === 0 ? 1 : 3}`);
    d.style.gridRow = row + 1;
    d.style.gridColumn = col + 1;
    d.dataset.index = i;
    d.title = `#${i} ${tile.name} — ${tile.type}`;
    d.appendChild(el("span", "tile-num", String(i)));
    d.appendChild(el("span", "tile-label", TILE_LABELS[tile.type]));
    if (tile.type === "final") d.appendChild(el("span", "tile-star", "★"));
    board.appendChild(d);
  });
}

function renderTokens() {
  const s = G.state;
  if (!s) return;
  document.querySelectorAll(".token").forEach((t) => t.remove());
  const board = $("#board");
  const occupancy = {};
  s.players.forEach((p) => {
    const n = occupancy[p.pos] || 0;
    occupancy[p.pos] = n + 1;
    const { row, col } = G.tilePos[p.pos];
    const t = el("div", "token token-p" + s.players.indexOf(p));
    t.textContent = p.avatar;
    t.title = p.name;
    t.style.left = `calc(${(col + 0.5) * (100 / 16)}% + ${(n % 3) * 12 - 12}px)`;
    t.style.top = `calc(${(row + 0.5) * (100 / 13)}% + ${Math.floor(n / 3) * 14 - 7}px)`;
    if (s.players[s.current] === p && s.phase !== "game-over") t.classList.add("token-active");
    board.appendChild(t);
  });
}

function renderScoreboard() {
  const s = G.state;
  if (!s) return;
  const box = $("#scoreboard");
  box.innerHTML = "";
  s.players.forEach((p, i) => {
    const row = el("div", "score-row" + (i === s.current && s.phase !== "game-over" ? " score-current" : ""));
    row.appendChild(el("span", "score-avatar", p.avatar));
    row.appendChild(el("span", "score-name", `${p.name}${p.isAI ? " (" + (AI_PROFILES[p.personality] || AI_PROFILES.chill).label + " AI)" : ""}`));
    row.appendChild(el("span", "score-ap", p.ap + " AP"));
    row.appendChild(el("span", "score-sp", p.sp + " SP"));
    row.appendChild(el("span", "score-tokens", p.tokens > 0 ? "🎟️".repeat(p.tokens) : "—"));
    box.appendChild(row);
  });
  $("#lap-indicator").textContent =
    s.laps === 0 ? `Lap ${s.lap} · Endless` : `Lap ${Math.min(s.lap, s.laps)} / ${s.laps}`;
}

function renderLog() {
  const box = $("#log");
  if (!box || !G.state) return;
  box.innerHTML = "";
  G.state.log.slice(-40).forEach((entry) => {
    box.appendChild(el("div", "log-line " + entry.cls, entry.msg));
  });
  box.scrollTop = box.scrollHeight;
}

function renderDice(n, rolling) {
  const box = $("#dice");
  box.classList.toggle("rolling", !!rolling);
  box.textContent = n ? String(n) : "•";
  if (rolling) setTimeout(() => box.classList.remove("rolling"), 600);
}

function renderChat(messages) {
  const box = $("#chat");
  if (!box) return;
  box.innerHTML = "";
  (messages || []).slice(-30).forEach((m) => {
    box.appendChild(el("div", "chat-line"));
    box.lastChild.innerHTML = `<b>${esc(m.name)}:</b> ${esc(m.text)}`;
  });
  box.scrollTop = box.scrollHeight;
}

/** Append one chat line to the UI. Used by BotChat (single-player) and the
 *  multiplayer chat panel; falls back to the event log when no chat box exists. */
function addChatMessage(name, text) {
  const box = $("#chat");
  if (box) {
    box.appendChild(el("div", "chat-line"));
    box.lastChild.innerHTML = `<b>${esc(name)}:</b> ${esc(text)}`;
    box.scrollTop = box.scrollHeight;
  } else {
    log(`💬 ${name}: ${text}`);
  }
}
if (typeof window !== "undefined") window.addChatMessage = addChatMessage;

function renderAll() {
  const s = G.state;
  if (!s) return;
  renderScoreboard();
  renderLog();
  renderTokens();
  renderDice(s.die, false);
  const myTurn = isMyLocalTurn();
  $("#btn-roll").disabled = !(s.phase === "await-roll" && myTurn);
  $("#btn-save").disabled = s.mode !== "local" || s.phase !== "await-roll";
  $("#turn-banner").textContent =
    s.phase === "game-over" ? "Game over — check the awards!"
      : `${cur().avatar} ${cur().name}'s turn${s.mode === "room" && !myTurn ? " (waiting…)" : ""}`;
}

/* ============================================================================
 * 12. MODALS & INTERACTIONS
 * ========================================================================= */

function toast(msg) {
  if (!HAS_DOM) return;
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2200);
}

function closeModal(sel) {
  if (!HAS_DOM) return;
  $(sel).classList.remove("open");
}

function showCard(card) {
  if (!card) return;
  const modal = $("#card-modal");
  $("#card-inner").className = "card-face card-" + card.type;
  $("#card-title").textContent = card.title;
  $("#card-type").textContent = card.type.toUpperCase() + " · " + card.id;
  $("#card-desc").textContent = card.description;
  $("#card-effect").textContent = card.effect;
  const actions = $("#card-actions");
  actions.innerHTML = "";

  const s = G.state;
  const p = cur();
  const human = isMyLocalTurn() && !p.isAI;

  const addBtn = (label, cls, fn) => {
    const b = el("button", "btn " + cls, label);
    b.onclick = fn;
    actions.appendChild(b);
    return b;
  };

  // Spoken-answer box: what you say/do out loud goes to the table (chat).
  const answerBox = () => {
    const wrap = el("div", "answer-box");
    const inp = el("input", "answer-input");
    inp.type = "text";
    inp.maxLength = 200;
    inp.placeholder = "Your answer out loud (optional)…";
    wrap.appendChild(inp);
    actions.appendChild(wrap);
    return inp;
  };

  if (human) {
    if (card.type === "scenario") {
      const said = answerBox();
      addBtn("✔ Do it (truth)", "btn-good", () => submitResponse({ kind: "do" }, said.value.trim()));
      addBtn("🎭 Bluff it", "btn-warn", () => submitResponse({ kind: "bluff" }, said.value.trim()));
      addBtn(`✖ Refuse (+${PENALTY.SCENARIO_REFUSE_SP} SP)`, "btn-bad", () => submitResponse({ kind: "refuse" }));
    } else if (card.type === "choice") {
      const said = answerBox();
      addBtn(`A: ${card.a.text} (${fmtDeltas(card.a)})`, "btn-good", () => submitResponse({ kind: "choice", side: "a" }, said.value.trim()));
      addBtn(`B: ${card.b.text} (${fmtDeltas(card.b)})`, "btn-good", () => submitResponse({ kind: "choice", side: "b" }, said.value.trim()));
      addBtn(`✖ Refuse (+${PENALTY.CHOICE_REFUSE_SP} SP)`, "btn-bad", () => submitResponse({ kind: "refuse" }));
    } else if (card.type === "risk") {
      const mechLabel = card.mech === "coin" ? "coin flip" : card.mech === "die" ? "roll 4+" : "the group believes you";
      const said = answerBox();
      addBtn(`🔥 Take the risk — reward ${fmtDeltas(card.reward)} / penalty ${fmtDeltas(card.penalty)} (${mechLabel})`, "btn-warn", () => submitResponse({ kind: "risk-take" }, said.value.trim()));
      addBtn(`🐔 Chicken out (+${PENALTY.RISK_CHICKEN_SP} SP)`, "btn-bad", () => submitResponse({ kind: "risk-chicken" }));
    } else if (card.type === "sabotage") {
      if (p.tokens > 0) addBtn("🎯 Choose a target", "btn-warn", () => openTargetPicker(card));
      else addBtn("(no tokens left — skip)", "btn", () => submitResponse({ kind: "sabotage-skip" }));
      addBtn(`✖ Skip (+${PENALTY.SABOTAGE_SKIP_AP} AP)`, "btn-good", () => submitResponse({ kind: "sabotage-skip" }));
    } else if (card.type === "vote") {
      // The card wants a group decision: say your piece, then face the group.
      const said = answerBox();
      addBtn("🗣️ Face the group", "btn-warn", () => submitResponse({ kind: "none" }, said.value.trim()));
    }
  } else {
    const waitLabel = s.mode === "room" ? "waiting…" : "thinking…";
    actions.appendChild(el("div", "ai-thinking", `${p.avatar} ${p.name} is ${waitLabel}`));
  }

  // Clear any previous bot-answer banner, then show the current one if the
  // server has already queued/announced this bot's answer.
  const revealBox = $("#card-reveal");
  if (revealBox) {
    revealBox.hidden = true;
    const thinkLabel = actions.querySelector(".ai-thinking");
    if (thinkLabel) thinkLabel.remove(); // answer is in: replace "thinking…" with the reveal
    revealBox.innerHTML = "";
    if (!human && s.mode === "room") {
      const label = s.reveal && s.reveal.card === card.id ? s.reveal.label : (s.aiAnswer && s.aiAnswerCard === card.id ? "🤔 thinking…" : null);
      if (label) {
        revealBox.innerHTML = `<b>${esc(cur().name)}</b> ${esc(label)}`;
        revealBox.hidden = false;
      }
    }
  }

  modal.classList.add("open");
  SFX.play("card");

  // Local AI turns resolve automatically; room mode is driven by the server.
  if (!human && s.mode === "local") {
    const token = ++G.turnToken;
    setTimeout(() => {
      if (token !== G.turnToken || G.state !== s) return;
      resolveActiveCardForAI();
    }, Math.max(500, aiStepSeconds() * 1000 * 0.4)); // read-the-card beat before the bot "thinks" (was hardcoded 900ms)
  }
}

function fmtDeltas(d) {
  const bits = [];
  if (d.ap) bits.push(`${d.ap > 0 ? "+" : ""}${d.ap} AP`);
  if (d.sp) bits.push(`${d.sp > 0 ? "+" : ""}${d.sp} SP`);
  return bits.length ? bits.join(" ") : "0";
}

function openTargetPicker() {
  const modal = $("#target-modal");
  const list = $("#target-list");
  list.innerHTML = "";
  G.state.players.forEach((p, i) => {
    if (i === G.state.current) return;
    const b = el("button", "btn btn-target", `${p.avatar} ${p.name} — ${p.ap} AP, ${p.sp} SP`);
    b.onclick = () => { closeModal("#target-modal"); submitResponse({ kind: "sabotage", target: i }); };
    list.appendChild(b);
  });
  modal.classList.add("open");
}

/* ---- Vote modal ---- */
function openVoteModal() {
  if (!G.state.vote) return;
  renderVoteModal();
  $("#vote-modal").classList.add("open");
  // Bots are deciding (pre-filled verdicts + timer): show a thinking state.
  const s = G.state;
  if (s.aiActAt !== undefined && s.vote.verdicts && Object.keys(s.vote.verdicts).length > 0
      && !s.players.find((v) => !v.isAI && v.id !== cur().id && !s.vote.verdicts[v.id])) {
    const st = $("#vote-status");
    if (st && !st.innerHTML) st.innerHTML = el("div", "ai-thinking", "🤖 The bots are deliberating…").outerHTML;
  }
}

function renderVoteModal() {
  const s = G.state;
  if (!s.vote) return;
  const card = s.vote.cardId ? CARD_BY_ID[s.vote.cardId] : null;
  $("#vote-title").textContent = card ? card.title : "The Group Decides";
  $("#vote-desc").textContent = card ? card.description : "Cast your verdict.";
  $("#vote-mode").textContent = s.vote.mode === "unanimous"
    ? "UNANIMOUS MERCY — one punish dooms you"
    : "MAJORITY RULES — tie forgives";
  const box = $("#vote-buttons");
  box.innerHTML = "";
  const pendingHuman = s.players.find((v) => !v.isAI && v.id !== cur().id && !s.vote.verdicts[v.id]);
  const status = $("#vote-status");
  status.innerHTML = "";
  s.players.filter((_, i) => i !== s.current).forEach((v) => {
    const line = el("div", "vote-line");
    line.appendChild(el("span", "vote-who", `${v.avatar} ${v.name}`));
    const verdict = s.vote.verdicts[v.id];
    line.appendChild(el("span", "vote-verdict", verdict ? (verdict === "yes" ? "✅ " + s.vote.labels[0] : "❌ " + s.vote.labels[1]) : "…"));
    status.appendChild(line);
  });
  if (pendingHuman) {
    box.appendChild(el("div", "vote-prompt", `${pendingHuman.avatar} ${pendingHuman.name}, your verdict:`));
    const y = el("button", "btn btn-good", s.vote.labels[0]);
    y.onclick = () => MP.sendVote("yes");
    const n = el("button", "btn btn-bad", s.vote.labels[1]);
    n.onclick = () => MP.sendVote("no");
    box.appendChild(y); box.appendChild(n);
  } else {
    box.appendChild(el("div", "ai-thinking", "Resolving…"));
  }
}

function showVoteResults(result, done) {
  const box = $("#vote-buttons");
  box.innerHTML = "";
  const outcome = result.succeeded
    ? (result.labels ? result.labels[0].toUpperCase() : "PASSED")
    : (result.labels ? result.labels[1].toUpperCase() : "FAILED");
  box.appendChild(el("div", "vote-result-head", `Result: ${result.tally} — ${outcome}`));
  const list = el("div", "vote-lines");
  result.votes.forEach((v) => {
    list.appendChild(el("div", "vote-line", `${v.avatar} ${v.name}: ${v.verdict === "yes" ? "✅" : v.verdict === "no" ? "❌" : "➖"}`));
  });
  box.appendChild(list);
  const ok = el("button", "btn btn-primary", "Continue");
  ok.onclick = () => {
    closeModal("#vote-modal");
    if (done) done(result);
  };
  box.appendChild(ok);
  SFX.play("vote");
}

/* ---- Game over modal ---- */
function showGameOverModal() {
  const s = G.state;
  if (!s) return;
  const a = computeAwards(s);
  const box = $("#awards");
  box.innerHTML = "";
  const add = (label, p) => {
    if (!p) return;
    box.appendChild(el("div", "award-line", `${label}: ${p.avatar} ${p.name} (${p.ap} AP, ${p.sp} SP)`));
  };
  add("🏆 Winner", a.winner);
  add("🤥 Best Liar", a.bestLiar);
  add("😇 Most Honest", a.mostHonest);
  add("🎯 Most Sabotaged", a.mostSabotaged);
  add("🔥 Chaos Gremlin", a.chaosGremlin);
  $("#gameover-modal").classList.add("open");
}

/* ---- Theme & misc UI ---- */
function setTheme(theme) {
  if (!HAS_DOM) return;
  if (!THEMES.includes(theme)) theme = "neon";
  document.body.dataset.theme = theme;
  G.settings.theme = theme;
  try { localStorage.setItem("awkward-theme", theme); } catch (e) {}
}

/* ============================================================================
 * 13. SETUP SCREEN & INIT
 * ========================================================================= */

function addSetupRow(name, isAI, personality) {
  const list = $("#setup-players");
  const row = el("div", "setup-row");
  const avatar = el("select", "setup-avatar");
  AVATARS.forEach((a) => { const o = el("option", "", a); o.value = a; avatar.appendChild(o); });
  const nameInput = el("input", "setup-name");
  nameInput.placeholder = "Name";
  nameInput.value = name || "";
  nameInput.maxLength = 20;
  const kind = el("select", "setup-kind");
  [["", "Human"], ["ai", "AI"]].forEach(([v, l]) => { const o = el("option", "", l); o.value = v; kind.appendChild(o); });
  if (isAI) kind.value = "ai";
  const pers = el("select", "setup-personality");
  Object.entries(AI_PROFILES).forEach(([k, v]) => { const o = el("option", "", v.label); o.value = k; pers.appendChild(o); });
  pers.value = personality || "chill";
  const del = el("button", "btn btn-bad btn-small", "✕");
  del.onclick = () => row.remove();
  row.append(avatar, nameInput, kind, pers, del);
  list.appendChild(row);
}

function readSetupRows() {
  return [...document.querySelectorAll("#setup-players .setup-row")].map((row, i) => ({
    name: row.querySelector(".setup-name").value.trim().slice(0, 20) || "Player " + (i + 1),
    isAI: row.querySelector(".setup-kind").value === "ai",
    personality: row.querySelector(".setup-personality").value,
    avatar: row.querySelector(".setup-avatar").value,
  }));
}

function startLocalGame() {
  const players = readSetupRows();
  if (players.length < 2 || players.length > 8) { toast("You need between 2 and 8 players."); return; }
  const laps = parseInt($("#setup-laps").value, 10) || 3;
  const seedStr = $("#setup-seed").value.trim();
  G.turnToken++;
  createGame({ players, laps, seed: seedStr ? hashSeed(seedStr) : undefined, mode: "local" });
  closeModal("#setup-screen");
  closeModal("#gameover-modal");
  scheduleAiTurnIfNeeded();
}

function startDailyChallenge() {
  const d = new Date();
  const key = `daily-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const pers = ["chill", "chaotic", "brutal", "liar"];
  G.turnToken++;
  createGame({
    players: [
      { name: "You", isAI: false, personality: "chill", avatar: "🦆" },
      ...pers.map((p, i) => ({ name: (AI_PROFILES[p].label) + " Bot", isAI: true, personality: p, avatar: AVATARS[i + 2] })),
    ],
    laps: 2,
    seed: hashSeed(key),
    mode: "local",
  });
  closeModal("#setup-screen");
  closeModal("#gameover-modal");
  toast("Daily Challenge: beat today's bots!");
  scheduleAiTurnIfNeeded();
}

/* ---- AI turn scheduling (local mode) ---- */
function scheduleAiTurnIfNeeded() {
  const s = G.state;
  if (!s || s.mode !== "local" || s.phase !== "await-roll") return;
  if (!cur().isAI) return;
  // Headless/test mode: roll synchronously so driver loops advance.
  if (s.mode === "test-auto" || !HAS_DOM) { doRoll(); return; }
  const token = ++G.turnToken;
  setTimeout(() => {
    if (token !== G.turnToken || !G.state || G.state.phase !== "await-roll") return;
    doRoll();
  }, aiStepSeconds() * 1000); // bot pause before its roll follows the admin pacing setting (was hardcoded 800ms)
}

/* ---- Multiplayer UI ---- */
async function mpCreateRoom() {
  const name = $("#mp-name").value.trim().slice(0, 20) || "Host";
  const avatar = $("#mp-avatar").value;
  try {
    const r = await MP.create(name, avatar);
    enterRoom(r.code, r.playerId);
  } catch (e) { toast("Could not create room — is the PHP server running?"); }
}
async function mpJoinRoom() {
  const code = $("#mp-code").value.trim().toUpperCase();
  const name = $("#mp-name").value.trim().slice(0, 20) || "Guest";
  const avatar = $("#mp-avatar").value;
  if (!code) { toast("Enter a room code."); return; }
  try {
    const r = await MP.join(code, name, avatar);
    enterRoom(r.code, r.playerId);
  } catch (e) { toast("Could not join room: " + e.message); }
}
function enterRoom(code, playerId) {
  G.turnToken++;
  MP.stopPolling();
  G.state = freshState(1);
  G.state.mode = "room";
  G.state.room = { code, playerId };
  closeModal("#setup-screen");
  $("#mp-panel").classList.add("open");
  $("#room-code").textContent = code;
  MP.startPolling();
  toast(`Room ${code} joined — share the code with friends!`);
}

/* ---- Wire-up ---- */
function init() {
  try { G.settings.theme = localStorage.getItem("awkward-theme") || "neon"; } catch (e) {}
  setTheme(G.settings.theme);

  const themeSel = $("#theme-select");
  THEMES.forEach((t) => { const o = el("option", "", THEME_NAMES[t]); o.value = t; themeSel.appendChild(o); });
  themeSel.value = G.settings.theme;
  themeSel.onchange = () => setTheme(themeSel.value);

  $("#btn-sound").onclick = () => {
    G.settings.sound = !G.settings.sound;
    $("#btn-sound").textContent = G.settings.sound ? "🔊" : "🔇";
  };
  $("#btn-rules").onclick = () => window.open("rules.html", "_blank");
  $("#btn-new").onclick = () => {
    G.turnToken++;
    MP.stopPolling();
    closeModal("#gameover-modal");
    $("#setup-screen").classList.add("open");
  };
  $("#btn-save").onclick = saveGame;
  $("#btn-load").onclick = loadGame;
  $("#btn-roll").onclick = humanRoll;
  $("#btn-start").onclick = startLocalGame;
  $("#btn-daily").onclick = startDailyChallenge;
  $("#btn-add-player").onclick = () => addSetupRow();
  $("#btn-mp-create").onclick = mpCreateRoom;
  $("#btn-mp-join").onclick = mpJoinRoom;
  $("#btn-chat-send").onclick = () => {
    const input = $("#chat-input");
    const text = input.value.trim().slice(0, 200);
    if (text) { MP.sendChat(text); input.value = ""; }
  };
  document.querySelectorAll("[data-close]").forEach((b) => {
    b.onclick = () => closeModal("#" + b.dataset.close);
  });

  addSetupRow("You", false, "chill");
  addSetupRow("Chill Bot", true, "chill");

  renderBoard();
  G.state = freshState(1);
  G.state.players = [newPlayer("p0", "You", "🦆", false, "chill")];
  renderAll();
  $("#setup-screen").classList.add("open");
}

if (HAS_DOM) document.addEventListener("DOMContentLoaded", init);

/* Node export for tests (UI functions are DOM-guarded). */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    rngNext, rngInt, rngChoice, hashSeed, freshState, newPlayer, createGame,
    rollDie, movePlayer, drawCard, buildDecks, shuffleArr, resolveTile, resolveNext,
    applyResponse, applyDeltas, startVote, maybeFinishVote, castHumanVote,
    aiShouldBluff, aiTakeRisk, aiChooseSabotageTarget, aiVoteOnPlayer, aiRespondToCard,
    ranking, computeAwards, endTurn, finishTile, doRoll, resolveActiveCardForAI,
    G, PENALTY, CARD_BY_ID, AI_PROFILES, BOARD_SIZE,
  };
}
