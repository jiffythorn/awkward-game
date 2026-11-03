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

/** Wager to Play ("double or nothing"), documented in RULES.md §6. */
const WAGER = { STAKE_AP: 2 };

/** Screw token: rush a rival's answer, documented in RULES.md §6. */
const SCREW = { SECONDS: 10, ATTACKER_AP: 2, TARGET_AP: 2, TARGET_SP: 1, RUSH_SUCCESS: 0.45 };

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
    wagerApAt: null,           // AP at the moment the open wager was placed (null = no wager)
    wagerLap: null,            // lap of the last wager (one per lap)
    stats: { bluffsBelieved: 0, bluffsCaught: 0, confessions: 0, timesSabotaged: 0, chaosTriggered: 0, risksTaken: 0, risksWon: 0, dilemmas: 0, bestSplit: 0, duelsWon: 0, wagersWon: 0, wagersLost: 0 },
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
  s.players.forEach((pl) => { if (pl.screwLap === undefined) pl.screwLap = null; });
  if (s.extraRollFor === undefined) s.extraRollFor = null;
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
    case "duel":     return ["duel"];
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

/* ---- Card reward scaling (mirrored in rooms/lib.php) ---- */

/** Card rewards escalate with the acting player's lap: ×1, ×2, ×3 (capped), so
 *  a slow start is never a lost game. See RULES.md §6 (Lap escalation). */
function lapMultiplier(state, playerIdx) {
  const p = state && state.players ? state.players[playerIdx] : null;
  return Math.min(3, Math.max(1, ((p && p.lapsDone) || 0) + 1));
}

/** Positive AP earned from a card, scaled by lap. Penalties are never scaled. */
function cardRewardAp(state, playerIdx, ap) {
  if (!(ap > 0)) return ap;
  const m = lapMultiplier(state, playerIdx);
  return m > 1 ? Math.round(ap * m) : ap;
}

/** Log suffix that shows the lap multiplier when one applies. */
function lapNote(state, playerIdx, why) {
  const m = lapMultiplier(state, playerIdx);
  return m > 1 ? `${why} [lap ${m} ×${m}]` : why;
}

/* ---- Wager to Play: double or nothing (RULES.md §6) ---- */

/** Is this player's wager still on the table? Rooms expose the flag only. */
function wagerOpen(p) {
  if (!p) return false;
  return p.wagerOpen === true || (p.wagerApAt !== null && p.wagerApAt !== undefined);
}

/** Cards you may wager on: the ones you answer yourself. Duels belong to the
 *  whole table, so there is no single outcome to bet on. */
function wagerEligible(card) {
  return !!card && ["scenario", "choice", "risk", "sabotage", "vote"].includes(card.type);
}

/** A new wager needs a free table slot and a fresh lap. */
function canWager(state, playerIdx) {
  const p = state && state.players ? state.players[playerIdx] : null;
  if (!p) return false;
  if (wagerOpen(p)) return false;
  if (p.wagerLap !== null && p.wagerLap !== undefined && p.wagerLap === p.lapsDone) return false;
  return true;
}

/** Put the stake on the table. The card's own AP swing decides the payout. */
function takeWager(state, playerIdx) {
  const p = state.players[playerIdx];
  if (!canWager(state, playerIdx)) return false;
  p.wagerApAt = p.ap;
  p.wagerLap = p.lapsDone;
  log(`💸 ${p.name} wagers ${WAGER.STAKE_AP} AP — double or nothing.`, "warn");
  if (HAS_DOM) renderScoreboard();
  return true;
}

/** Settle the open wager once the card has paid out: a gain doubles and the
 *  stake rides; no gain (or a loss) forfeits the stake. */
function settleWager(state, playerIdx) {
  const p = state && state.players ? state.players[playerIdx] : null;
  if (!p || !wagerOpen(p) || p.wagerApAt === null || p.wagerApAt === undefined) return null;
  const gain = p.ap - p.wagerApAt;
  p.wagerApAt = null;
  if (p.wagerOpen !== undefined) p.wagerOpen = false;
  if (gain > 0) {
    p.stats.wagersWon = (p.stats.wagersWon || 0) + 1;
    applyDeltas(state, playerIdx, gain, 0, "(wager won — doubled)");
    return { hit: true, gain };
  }
  p.stats.wagersLost = (p.stats.wagersLost || 0) + 1;
  applyDeltas(state, playerIdx, -WAGER.STAKE_AP, 0, "(wager lost)");
  return { hit: false, gain };
}

/** Bots gamble when they are behind: trailing bots wager often, leaders rarely. */
function aiMaybeWager(state, card) {
  const p = cur();
  if (!p || !p.isAI || !wagerEligible(card) || !canWager(state, state.current)) return false;
  const leader = Math.max(...state.players.map((x) => x.ap));
  const chance = p.ap < leader ? 0.45 : 0.12;
  if (rngNext(state) >= chance) return false;
  return takeWager(state, state.current);
}

/* ---- Screw token: rush a rival's answer (RULES.md §6) ---- */

/** Cards a screw can land on: one player answers, so one player can be rushed. */
function screwEligible(card) {
  return !!card && ["scenario", "choice", "risk", "sabotage", "vote"].includes(card.type);
}

/** The screw currently on the clock, if any (rooms send it as remaining ms). */
function screwOpen(state) {
  const sc = state && state.screw;
  if (!sc) return null;
  if (sc.deadline === undefined && sc.ms !== undefined) sc.deadline = Date.now() + sc.ms;
  return sc;
}

/** A screw needs a rival's card on the table, a free token, and a clear table. */
function canScrew(state, atkIdx) {
  const p = state && state.players ? state.players[atkIdx] : null;
  if (!p) return false;
  if (state.phase !== "resolving" || !state.activeCard) return false;
  if (atkIdx === state.current) return false;            // never your own card
  if (screwOpen(state)) return false;                    // one at a time
  if (p.screwLap !== null && p.screwLap !== undefined && p.screwLap === p.lapsDone) return false;
  return screwEligible(CARD_BY_ID[state.activeCard]);
}

/** Spend the token: the target has SCREW.SECONDS to commit. */
function takeScrew(state, atkIdx) {
  if (!canScrew(state, atkIdx)) return false;
  const atk = state.players[atkIdx];
  const target = state.players[state.current];
  atk.screwLap = atk.lapsDone;
  atk.stats.screwsUsed = (atk.stats.screwsUsed || 0) + 1;
  state.screw = { by: atkIdx, target: state.current, cardId: state.activeCard, apAt: target.ap, deadline: Date.now() + SCREW.SECONDS * 1000 };
  log(`😈 ${atk.name} SCREWS ${target.name} — ${SCREW.SECONDS} seconds to answer.`, "warn");
  return true;
}

/** Settle the screw once its card has paid out. The attacker eats
 *  SCREW.ATTACKER_AP when the target still comes out ahead. */
function settleScrew(state) {
  const sc = state && state.screw;
  if (!sc) return null;
  if (sc.cardId !== state.activeCard) return null;
  state.screw = null;
  const atk = state.players[sc.by], target = state.players[sc.target];
  if (!atk || !target) return null;
  const gain = target.ap - sc.apAt;
  if (gain > 0) {
    atk.stats.screwsBackfired = (atk.stats.screwsBackfired || 0) + 1;
    applyDeltas(state, sc.by, -SCREW.ATTACKER_AP, 0, "(screw backfired — they still scored)");
    return { won: false, gain };
  }
  atk.stats.screwsLanded = (atk.stats.screwsLanded || 0) + 1;
  applyDeltas(state, sc.target, -SCREW.TARGET_AP, SCREW.TARGET_SP, "(screwed — answered cold)");
  applyDeltas(state, sc.by, SCREW.ATTACKER_AP, 0, "(screw paid off)");
  return { won: true, gain };
}

/** The panicked answer when the clock runs out (or a rushed bot loses its head). */
function screwPassResponse(card) {
  switch (card && card.type) {
    case "scenario":
    case "choice": return { kind: "refuse" };
    case "risk": return { kind: "risk-chicken" };
    case "sabotage": return { kind: "sabotage-skip" };
    default: return { kind: "none" };
  }
}

/** A rushed bot keeps its head part of the time; otherwise it panics and passes. */
function screwRushResponse(state, card) {
  if (rngNext(state) < SCREW.RUSH_SUCCESS) return aiRespondToCard(state, card);
  return screwPassResponse(card);
}

/** Is this player the one under the gun? */
function screwTargetedAt(state, idx) {
  const sc = screwOpen(state);
  return !!sc && sc.target === idx;
}

/** Bots only rush humans — a bot forced to "answer immediately" is just a bot. */
function aiMaybeScrew(state) {
  const target = cur();
  if (!target || target.isAI || !screwEligible(CARD_BY_ID[state.activeCard])) return false;
  const cands = state.players
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => i !== state.current && p.isAI && canScrew(state, i));
  if (!cands.length) return false;
  const atk = cands.reduce((a, b) => (b.p.ap > a.p.ap ? b : a));
  if (rngNext(state) >= 0.18) return false;
  return takeScrew(state, atk.i);
}

/** Which seat (if any) may spend a screw token right now. */
function localScrewActor(state) {
  if (!state || !state.players) return -1;
  if (state.mode === "room") {
    const me = (state.room && state.room.playerId) || (typeof MP !== "undefined" && MP.playerId) || null;
    if (!me) return -1;
    const i = state.players.findIndex((p) => p.id === me);
    return i >= 0 && canScrew(state, i) ? i : -1;
  }
  for (let i = 0; i < state.players.length; i++) {
    if (!state.players[i].isAI && canScrew(state, i)) return i;
  }
  return -1;
}

let screwTick = null;
function clearScrewTimer() { if (screwTick) { clearInterval(screwTick); screwTick = null; } }

/** Count the clock down on the card and answer for a human who freezes. */
function armScrewTimer(state) {
  clearScrewTimer();
  if (!HAS_DOM || !state) return;
  const sc = screwOpen(state);
  if (!sc || sc.target !== state.current) return;
  const box = $("card-screw");
  const deadline = sc.deadline;
  screwTick = setInterval(() => {
    const s = G.state;
    if (!s || !screwOpen(s) || s.screw.deadline !== deadline) { clearScrewTimer(); return; }
    const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (box) box.textContent = `⏱️ SCREWED — answer NOW. ${secs}s before the card answers for you.`;
    if (secs <= 0) {
      clearScrewTimer();
      const card = CARD_BY_ID[s.activeCard];
      if (card) submitResponse(screwPassResponse(card));
    }
  }, 250);
}

/** Split-the-Room scoring: closeness to a 50/50 table is the reward.
 *  Unanimous with 3+ voters means nobody argued, which is its own shame. */
function splitScore(card, yes, no) {
  const n = yes + no;
  const closeness = n ? 1 - Math.abs(yes - no) / n : 0;
  return {
    ap: 1 + Math.round((card.splitAp || 4) * closeness),
    pct: Math.round(closeness * 100),
    unanimous: n >= 3 && (yes === 0 || no === 0),
  };
}

/** Apply a dilemma's payoff to the player who raised it. */
function applySplitResult(card, result) {
  const s = G.state;
  const p = cur();
  const res = splitScore(card, result.yes, result.no);
  p.stats.dilemmas = (p.stats.dilemmas || 0) + 1;
  p.stats.bestSplit = Math.max(p.stats.bestSplit || 0, res.pct);
  log(`🪓 The table split ${result.tally} — ${res.pct}% divisive.`);
  applyDeltas(s, s.current, cardRewardAp(s, s.current, res.ap), res.unanimous ? 1 : 0,
    lapNote(s, s.current, res.unanimous ? "(unanimous — how boring)" : "(divisive dilemma)"));
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
  settleWager(s, s.current); // an open wager settles with the card that carried it
  settleScrew(s);            // so does an open screw
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
  settleWager(s, s.current);
  settleScrew(s);
  const p = cur();
  if (tileCompleted && s.comboEligible && p) {
    p.ap += PENALTY.FINAL_COMBO_BONUS_AP;
    log(`🏆 ${p.name} survived the FINAL COMBO! +${PENALTY.FINAL_COMBO_BONUS_AP} AP. Legendary.`);
    if (HAS_DOM) renderScoreboard();
  }
  // Bullseye from behind the leader: roll again instead of ending the turn.
  if (p && s.extraRollFor !== null && s.extraRollFor !== undefined && s.extraRollFor === s.current) {
    s.extraRollFor = null;
    s.activeCard = null;
    s.comboEligible = false;
    s.die = null;
    s.phase = "await-roll";
    bump();
    log(`🎯 ${p.name} takes the bonus roll!`, "good");
    if (HAS_DOM) { renderAll(); scheduleAiTurnIfNeeded(); }
    return;
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
  const voters = opts.voters
    ? opts.voters.slice()
    : s.players.map((_, i) => i).filter((i) => i !== s.current);
  s.vote = {
    seq: ++s.voteSeq,
    context: opts.context,
    cardId: opts.card ? opts.card.id : null,
    mode: opts.mode || "majority",
    labels: opts.labels,
    texts: opts.texts || null,  // duel: the two anonymous answers on the block
    voters,                     // player indices allowed to vote
    verdicts: {},               // playerId -> 'yes' | 'no'
    quiet: !!opts.quiet,        // duel: keep the result inline, not full-screen
    onDone: opts.onDone,        // local UI only
  };
  s.phase = "await-vote";
  bump();
  const judged = cur();
  for (const vi of voters) {
    const v = s.players[vi];
    if (!v || !v.isAI) continue;
    s.vote.verdicts[v.id] = opts.context === "duel"
      ? aiVoteOnDuel(s, v, opts.texts || [])
      : aiVoteOnPlayer(s, v, s.current, opts.context);
    if (opts.context !== "duel") botBanter("judge", v, { target: judged.name });
  }
  if (HAS_DOM) { if (opts.context === "duel") renderDuelModal(); else openVoteModal(); }
  maybeFinishVote();
}

/** True when every voter has weighed in. */
function voteComplete(state) {
  if (!state.vote) return true;
  const voters = state.vote.voters
    ? state.vote.voters.map((i) => state.players[i]).filter(Boolean)
    : state.players.filter((_, i) => i !== state.current);
  return voters.every((v) => state.vote.verdicts[v.id] === "yes" || state.vote.verdicts[v.id] === "no");
}

/** Tally + finish the vote when complete. */
function maybeFinishVote() {
  const s = G.state;
  if (!s.vote || !voteComplete(s)) {
    if (HAS_DOM) { if (s.vote && s.vote.context === "duel") renderDuelModal(); else renderVoteModal(); }
    return;
  }
  const voterList = s.vote.voters
    ? s.vote.voters.map((i) => s.players[i]).filter(Boolean)
    : s.players.filter((_, i) => i !== s.current);
  const votes = voterList.map((v) => ({ name: v.name, avatar: v.avatar, verdict: s.vote.verdicts[v.id] || "abstain" }));
  const yes = votes.filter((v) => v.verdict === "yes").length;
  const no = votes.filter((v) => v.verdict === "no").length;
  const succeeded = s.vote.mode === "unanimous" ? no === 0 && yes > 0 : yes >= no;
  // Bots announce their verdicts (targeted at whoever is being judged).
  if (s.vote.context !== "duel") {
    s.players.forEach((v, i) => {
      if (!v.isAI || i === s.current) return;
      const vd = votes.find((x) => x.name === v.name);
      if (vd && (vd.verdict === "yes" || vd.verdict === "no")) {
        botBanter(vd.verdict === "yes" ? "voteYes" : "voteNo", v, { target: cur().name });
      }
    });
  }
  const splitPct = s.vote.mode === "split"
    ? Math.round(100 * (1 - Math.abs(yes - no) / Math.max(1, yes + no)))
    : null;
  const result = { yes, no, tally: `${yes}–${no}`, succeeded, votes, context: s.vote.context, labels: s.vote.labels, mode: s.vote.mode, splitPct, texts: s.vote.texts || null };
  const done = s.vote.onDone;
  const quiet = s.vote.quiet;
  s.vote = null;
  s.phase = "resolving";
  bump();
  if (HAS_DOM && !quiet) showVoteResults(result, done);
  else done && done(result);
}

/** Human vote submission (local/hotseat mode). */
function castHumanVote(verdict) {
  const s = G.state;
  if (!s.vote || s.phase !== "await-vote") return;
  if (verdict !== "yes" && verdict !== "no") return;
  const voterList = s.vote.voters
    ? s.vote.voters.map((i) => s.players[i]).filter(Boolean)
    : s.players.filter((_, i) => i !== s.current);
  const pendingHuman = voterList.find((v) => !v.isAI && !s.vote.verdicts[v.id]);
  if (!pendingHuman) return;
  s.vote.verdicts[pendingHuman.id] = verdict;
  SFX.play("vote");
  bump();
  maybeFinishVote();
}

/* ---- Duel rounds (Quiplash-style head-to-heads) ----------------------------
 * A duel card stops the normal card flow: every player writes one answer, the
 * answers are shuffled into anonymous pairs, and the rest of the table votes on
 * each pair. AP is paid by vote share, so a funny loser still scores. */

const DUEL_SHARE_AP = 4;      // max AP from vote share alone
const DUEL_WIN_BONUS = 2;     // winning a pairing
const DUEL_SWEEP_BONUS = 4;   // winning every vote
const DUEL_BYE_AP = 2;        // odd player out
const DUEL_BLANK_ANSWER = "(said nothing, stared into the middle distance)";

/** Head-to-head payoff. AP is paid by vote share, plus a bonus for winning; a
 *  unanimous sweep pays more, and a tie pays both duelists +1. */
function duelShare(aVotes, bVotes) {
  const n = aVotes + bVotes;
  if (!n) return { apA: DUEL_BYE_AP, apB: DUEL_BYE_AP, winner: "tie", sweep: false, pctA: 50, pctB: 50 };
  const sweep = aVotes === 0 || bVotes === 0;
  const pctA = Math.round((100 * aVotes) / n);
  if (aVotes === bVotes) {
    const ap = Math.round((DUEL_SHARE_AP * aVotes) / n) + 1;
    return { apA: ap, apB: ap, winner: "tie", sweep: false, pctA, pctB: 100 - pctA };
  }
  const bonus = sweep ? DUEL_SWEEP_BONUS : DUEL_WIN_BONUS;
  const apA = Math.round((DUEL_SHARE_AP * aVotes) / n) + (aVotes > bVotes ? bonus : 0);
  const apB = Math.round((DUEL_SHARE_AP * bVotes) / n) + (bVotes > aVotes ? bonus : 0);
  return { apA, apB, winner: aVotes > bVotes ? "a" : "b", sweep, pctA, pctB: 100 - pctA };
}

/** Pick an unused canned answer for an AI duelist. */
function aiDuelAnswer(state, card, playerIdx) {
  const answers = (state.duel && state.duel.answers) || {};
  const used = Object.keys(answers).filter((k) => Number(k) !== playerIdx).map((k) => answers[k]);
  const pool = ((card && card.answers) || []).filter((a) => !used.includes(a));
  if (!pool.length) return DUEL_BLANK_ANSWER;
  return pool[rngInt(state, pool.length)];
}

/** Which AI answer does this voter prefer? Longer answers read as more effort,
 *  with a chaos roll for unpredictability. */
function aiVoteOnDuel(state, ai, texts) {
  const prof = AI_PROFILES[ai.personality] || AI_PROFILES.chill;
  if (rngNext(state) < prof.chaos) return rngNext(state) < 0.5 ? "yes" : "no";
  const a = String((texts && texts[0]) || "");
  const b = String((texts && texts[1]) || "");
  const longerPicksA = a.length >= b.length;
  if (rngNext(state) < 0.65) return longerPicksA ? "yes" : "no";
  return rngNext(state) < 0.5 ? "yes" : "no";
}

/** Normalise answer text for duplicate detection: case- and punctuation-blind. */
function normDuelAnswer(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Matching answers cancel each other (index -> true). A safe answer (submitted
 *  blank) never cancels anyone and is never cancelled itself. */
function findDuelDuplicates(state) {
  const duel = (state && state.duel) || {};
  const answers = duel.answers || {};
  const safety = duel.safety || {};
  const blank = normDuelAnswer(DUEL_BLANK_ANSWER);
  const groups = new Map();
  Object.keys(answers).forEach((k) => {
    const i = Number(k);
    if (safety[i]) return;
    const n = normDuelAnswer(answers[k]);
    if (!n || n === blank) return;
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(i);
  });
  const dupes = {};
  groups.forEach((list) => { if (list.length > 1) list.forEach((i) => { dupes[i] = true; }); });
  return dupes;
}

/** Safety Quip: a blank / auto-filled answer only earns half its AP. */
function duelSafetyAp(ap, safety) {
  return safety ? Math.floor(ap / 2) : ap;
}

/** Player ids who have already written an answer (local or room state). */
function duelAnswered(state) {
  const d = (state && state.duel) || {};
  if (d.answered && typeof d.answered === "object") {
    return Object.keys(d.answered).filter((id) => d.answered[id]);
  }
  return Object.keys(d.answers || {})
    .map((k) => state.players[Number(k)])
    .filter(Boolean)
    .map((p) => p.id);
}

/** Human indices still owing an answer. */
function duelPendingHumans(state) {
  if (!state || !state.duel) return [];
  const answered = duelAnswered(state);
  return state.players
    .map((_, i) => i)
    .filter((i) => !state.players[i].isAI && !answered.includes(state.players[i].id));
}

/** Open a duel: everybody writes, AI answers land immediately. */
function startDuel(card) {
  const s = G.state;
  if (!card || card.type !== "duel") { resolveNext(); return; }
  s.duel = { cardId: card.id, answers: {}, safety: {}, duplicates: {}, pairs: [], pair: 0, results: [] };
  s.phase = "await-duel";
  bump();
  log(`⚔️ DUEL: “${card.title}” — everyone writes an answer.`);
  for (let i = 0; i < s.players.length; i++) {
    if (s.players[i].isAI) s.duel.answers[i] = aiDuelAnswer(s, card, i);
  }
  // Headless runs (tests, solo bot games) cannot type: fill the humans in.
  if (!HAS_DOM || s.mode === "test-auto") {
    for (let i = 0; i < s.players.length; i++) {
      if (s.duel.answers[i] === undefined) {
        s.duel.answers[i] = DUEL_BLANK_ANSWER;
        s.duel.safety[i] = true; // Safety Quip: half credit, never a duplicate
      }
    }
  }
  if (HAS_DOM) renderDuelModal();
  maybeFinishDuelAnswers();
}

/** Submit the local human's duel answer (hotseat: one at a time). */
function submitDuelAnswer(text) {
  const s = G.state;
  if (!s || !s.duel || s.phase !== "await-duel") return;
  const clean = String(text || "").trim().slice(0, 90);
  if (s.mode === "room") { MP.action({ type: "duel-answer", text: clean }); return; }
  const pending = duelPendingHumans(s);
  if (!pending.length) return;
  s.duel.answers[pending[0]] = clean || DUEL_BLANK_ANSWER;
  if (!s.duel.safety) s.duel.safety = {};
  if (clean) delete s.duel.safety[pending[0]];
  else s.duel.safety[pending[0]] = true;
  bump();
  if (HAS_DOM) renderDuelModal();
  maybeFinishDuelAnswers();
}

/** Pair every duelist; an odd player out takes a bye. */
function pairDuelists(s) {
  const order = s.players.map((_, i) => i);
  shuffleArr(order, s);
  s.duel.pairs = [];
  for (let i = 0; i < order.length; i += 2) {
    s.duel.pairs.push([order[i], order[i + 1] === undefined ? -1 : order[i + 1]]);
  }
  s.duel.pair = 0;
  s.duel.duplicates = findDuelDuplicates(s);
  const bouts = s.duel.pairs.filter((p) => p[1] >= 0).length;
  log(`⚔️ The duel draws ${bouts} pairing${bouts === 1 ? "" : "s"}. First up…`);
  const dupes = Object.keys(s.duel.duplicates).length;
  if (dupes) log(`🚫 ${dupes} duplicate answer${dupes === 1 ? "" : "s"} cancelled — no points for unoriginality.`);
  bump();
}

/** All answers in: pair the table and start the first head-to-head vote. */
function maybeFinishDuelAnswers() {
  const s = G.state;
  if (!s.duel || s.phase !== "await-duel") return;
  if (s.players.some((_, i) => s.duel.answers[i] === undefined)) {
    if (HAS_DOM) renderDuelModal();
    return;
  }
  pairDuelists(s);
  startDuelVote();
}

/** Start the current pairing's vote (or resolve a bye / no-jury pairing). */
function startDuelVote() {
  const s = G.state;
  if (!s.duel) { resolveNext(); return; }
  const pair = s.duel.pairs[s.duel.pair];
  if (!pair) { finishDuel(); return; }
  const [ai, bi] = pair;
  const safety = s.duel.safety || {};
  if (bi < 0) {
    const safe = !!safety[ai];
    const ap = duelSafetyAp(cardRewardAp(s, ai, DUEL_BYE_AP), safe);
    s.duel.results.push({ aIdx: ai, bIdx: -1, aName: s.players[ai].name, bName: "—", aVotes: 0, bVotes: 0, apA: ap, apB: 0, winner: "bye", safetyA: safe });
    applyDeltas(s, ai, ap, 0, lapNote(s, ai, safe ? "(duel bye — safe answer ×½)" : "(duel bye — no opponent)"));
    nextDuelPair();
    return;
  }
  const texts = [s.duel.answers[ai], s.duel.answers[bi]];

  // Duplicate cancellation: matching answers score nothing and skip the vote.
  const dupes = s.duel.duplicates || {};
  const dupA = !!dupes[ai];
  const dupB = !!dupes[bi];
  if (dupA || dupB) {
    const apA = dupA ? 0 : cardRewardAp(s, ai, DUEL_WIN_BONUS);
    const apB = dupB ? 0 : cardRewardAp(s, bi, DUEL_WIN_BONUS);
    const winner = dupA && dupB ? "tie" : dupA ? "b" : "a";
    s.duel.results.push({
      aIdx: ai, bIdx: bi, aName: s.players[ai].name, bName: s.players[bi].name,
      aVotes: 0, bVotes: 0, apA, apB, winner, cancelled: true,
    });
    log(`🚫 “${texts[0]}” vs “${texts[1]}” — duplicate answer, cancelled.`);
    if (!dupA) applyDeltas(s, ai, apA, 0, lapNote(s, ai, "(pairing won by default)"));
    if (!dupB) applyDeltas(s, bi, apB, 0, lapNote(s, bi, "(pairing won by default)"));
    nextDuelPair();
    return;
  }

  const voters = s.players.map((_, i) => i).filter((i) => i !== ai && i !== bi);
  if (!voters.length) {
    // Two-player table (or a pair with no jury): both take a flat 2 AP.
    const safeA = !!safety[ai];
    const safeB = !!safety[bi];
    const apA = duelSafetyAp(cardRewardAp(s, ai, DUEL_BYE_AP), safeA);
    const apB = duelSafetyAp(cardRewardAp(s, bi, DUEL_BYE_AP), safeB);
    s.duel.results.push({ aIdx: ai, bIdx: bi, aName: s.players[ai].name, bName: s.players[bi].name, aVotes: 0, bVotes: 0, apA, apB, winner: "tie", safetyA: safeA, safetyB: safeB });
    log(`⚔️ ${s.players[ai].name} vs ${s.players[bi].name} — no jury, both take ${DUEL_BYE_AP} AP.`);
    applyDeltas(s, ai, apA, 0, lapNote(s, ai, safeA ? "(duel — no jury, safe ×½)" : "(duel — no jury)"));
    applyDeltas(s, bi, apB, 0, lapNote(s, bi, safeB ? "(duel — no jury, safe ×½)" : "(duel — no jury)"));
    nextDuelPair();
    return;
  }
  startVote({
    context: "duel", card: CARD_BY_ID[s.duel.cardId], mode: "majority",
    labels: ["Answer A", "Answer B"], texts, voters, quiet: true,
    onDone: (r) => finishDuelPair(ai, bi, r.yes, r.no),
  });
}

/** Pay a pairing's result and move to the next one. */
function finishDuelPair(ai, bi, aVotes, bVotes) {
  const s = G.state;
  if (!s.duel) return;
  const sh = duelShare(aVotes, bVotes);
  const a = s.players[ai], b = s.players[bi];
  const safety = s.duel.safety || {};
  const safeA = !!safety[ai];
  const safeB = !!safety[bi];
  const apA = duelSafetyAp(cardRewardAp(s, ai, sh.apA), safeA);
  const apB = duelSafetyAp(cardRewardAp(s, bi, sh.apB), safeB);
  s.duel.results.push({
    aIdx: ai, bIdx: bi, aName: a.name, bName: b.name,
    aVotes, bVotes, apA, apB, winner: sh.winner, sweep: sh.sweep,
    safetyA: safeA, safetyB: safeB,
  });
  log(`⚔️ ${a.name} ${aVotes}–${bVotes} ${b.name} — “${s.duel.answers[ai]}” vs “${s.duel.answers[bi]}”`);
  applyDeltas(s, ai, apA, 0, lapNote(s, ai, safeA ? `(duel share ${sh.pctA}%, safe ×½)` : `(duel share ${sh.pctA}%)`));
  applyDeltas(s, bi, apB, 0, lapNote(s, bi, safeB ? `(duel share ${sh.pctB}%, safe ×½)` : `(duel share ${sh.pctB}%)`));
  if (sh.winner === "a") a.stats.duelsWon++;
  else if (sh.winner === "b") b.stats.duelsWon++;
  if (sh.sweep) log(`🧹 A unanimous sweep! “${sh.winner === "a" ? s.duel.answers[ai] : s.duel.answers[bi]}” takes it all.`);
  nextDuelPair();
}

function nextDuelPair() {
  const s = G.state;
  if (!s.duel) return;
  s.duel.pair++;
  bump();
  if (s.duel.pair < s.duel.pairs.length) startDuelVote();
  else finishDuel();
}

/** Every pairing is done: show the summary (local) and hand the turn back. */
function finishDuel() {
  const s = G.state;
  if (!s.duel) { resolveNext(); return; }
  if (HAS_DOM && s.mode === "local") {
    s.duel.done = true;
    bump();
    renderDuelModal();
    return;
  }
  endDuel();
}

function endDuel() {
  const s = G.state;
  s.duel = null;
  s.phase = "resolving";
  if (HAS_DOM) { closeModal("#duel-modal"); }
  bump();
  resolveNext();
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
    for (const p of state.players) if (!best || (p.stats[key] || 0) > (best.stats[key] || 0)) best = p;
    return best && (best.stats[key] || 0) > 0 ? best : null;
  };
  return {
    winner: rank[0],
    bestLiar: most("bluffsBelieved"),
    mostHonest: most("confessions"),
    mostSabotaged: most("timesSabotaged"),
    chaosGremlin: most("chaosTriggered"),
    mostDivisive: most("bestSplit"),
    duelChampion: most("duelsWon"),
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

/** Wager button: local mode applies it now, room mode asks the server. */
function submitWager() {
  const s = G.state;
  if (!s) return;
  if (s.mode === "room") { MP.action({ type: "wager" }); return; }
  if (!takeWager(s, s.current)) return;
  if (HAS_DOM && s.activeCard) showCard(CARD_BY_ID[s.activeCard]);
}

/** Screw button: local mode spends the token now, room mode asks the server. */
function submitScrew(atkIdx) {
  const s = G.state;
  if (!s) return;
  if (s.mode === "room") { MP.action({ type: "screw" }); return; }
  const actor = atkIdx === undefined ? localScrewActor(s) : atkIdx;
  if (actor < 0 || !takeScrew(s, actor)) return;
  if (HAS_DOM && s.activeCard) showCard(CARD_BY_ID[s.activeCard]);
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
      applyDeltas(s, s.current, cardRewardAp(s, s.current, card.ap), card.sp, lapNote(s, s.current, "(did it)"));
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
            applyDeltas(s, s.current, cardRewardAp(s, s.current, card.ap + 1), card.sp, lapNote(s, s.current, `(bluff believed ${r.tally}, +1 style)`));
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
      applyDeltas(s, s.current, cardRewardAp(s, s.current, opt.ap), opt.sp, lapNote(s, s.current, `(${resp.side.toUpperCase()})`));
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
        riskOutcome(card, { heads: flip });
      } else if (card.mech === "die") {
        const r = rollDie(s);
        log(`🎲 Fate rolls a ${r} — bullseye on a 6.`);
        riskOutcome(card, { roll: r });
      } else { // believe
        startVote({
          context: "believe", card, mode: "majority", labels: ["Believe", "Doubt"],
          onDone: (r) => {
            log(`🗣️ The group votes ${r.tally} — ${r.yes}/${r.no}.`);
            riskOutcome(card, { yes: r.yes, no: r.no });
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
      // Vote cards resolve via the group, duels pull in the whole table,
      // anything else just moves on.
      if (card.type === "vote") startCardVote(card);
      else if (card.type === "duel") startDuel(card);
      else resolveNext();
      break;
    }
  }
}

/** Group vote triggered by a vote card (local path; server mirrors this).
 *  Verdict cards ask Forgive/Punish; dilemma cards ask Yes/No and pay for
 *  how evenly the table splits (Split the Room). */
function startCardVote(card) {
  const split = card.mode === "split";
  startVote({
    context: "card", card, mode: card.mode || "majority",
    labels: split ? ["Yes", "No"] : ["Forgive", "Punish"],
    onDone: (r) => {
      const s = G.state;
      if (split) {
        applySplitResult(card, r);
        resolveNext();
        return;
      }
      if (r.succeeded) {
        applyDeltas(s, s.current, cardRewardAp(s, s.current, card.forgive.ap), card.forgive.sp,
          lapNote(s, s.current, `(forgiven ${r.tally})`));
      } else {
        applyDeltas(s, s.current, card.punish.ap, card.punish.sp, `(punished ${r.tally})`);
      }
      resolveNext();
    },
  });
}

/* ---- Risk bands: bullseye instead of pass/fail (RULES.md §6) ---- */

/** Band table. Payouts scale the card's own reward so the deck stays balanced:
 *  a bullseye doubles it, good pays it, near pays half, a miss takes the
 *  penalty plus a shame point. Mirrored in rooms/lib.php. */
const RISK_BANDS = {
  bullseye: { mul: 2, label: "BULLSEYE!" },
  good:     { mul: 1, label: "risk paid off!" },
  near:     { mul: 0.5, label: "near miss — half" },
  miss:     { mul: 0, label: "risk missed…" },
};

/** Grade a risk from the mechanic's own margin. A coin has no middle, so it
 *  stays binary; dice and group votes get all four bands. */
function riskBand(card, outcome) {
  const mech = (card && card.mech) || "believe";
  if (mech === "die") {
    const r = (outcome && outcome.roll) || 0;
    if (r >= 6) return "bullseye";
    if (r >= 5) return "good";
    if (r >= 4) return "near";
    return "miss";
  }
  if (mech === "believe") {
    const yes = (outcome && outcome.yes) || 0;
    const no = (outcome && outcome.no) || 0;
    if (yes + no === 0) return "near";
    if (no === 0 && yes >= 2) return "bullseye";
    if (yes > no) return "good";
    if (yes === no) return "near";
    return "miss";
  }
  return outcome && outcome.heads ? "good" : "miss";
}

/** AP/SP a band pays, using the card's own reward and penalty. */
function riskPayout(card, band, state, playerIdx) {
  const reward = (card && card.reward) || { ap: 0, sp: 0 };
  const penalty = (card && card.penalty) || { ap: 0, sp: 0 };
  const base = cardRewardAp(state, playerIdx, reward.ap || 0);
  if (band === "miss") return { ap: penalty.ap || 0, sp: (penalty.sp || 0) + 1 };
  if (band === "bullseye") return { ap: base * RISK_BANDS.bullseye.mul, sp: reward.sp || 0 };
  if (band === "near") return { ap: Math.max(1, Math.round(base * RISK_BANDS.near.mul)), sp: 0 };
  return { ap: base, sp: reward.sp || 0 };
}

function riskOutcome(card, outcome) {
  const s = G.state;
  const p = cur();
  const band = riskBand(card, outcome);
  // "Behind the leader" is judged on the score BEFORE the card pays out.
  const wasBehind = s.players.some((x) => x !== p && x.ap > p.ap);
  const pay = riskPayout(card, band, s, s.current);
  if (band === "miss") {
    p.stats.risksLost = (p.stats.risksLost || 0) + 1;
    SFX.play("bad");
  } else {
    p.stats.risksWon = (p.stats.risksWon || 0) + 1;
    SFX.play("good");
  }
  applyDeltas(s, s.current, pay.ap, pay.sp, lapNote(s, s.current, `(${RISK_BANDS[band].label})`));
  if (band === "bullseye") {
    p.stats.bullseyes = (p.stats.bullseyes || 0) + 1;
    log("🎯 BULLSEYE!", "good");
    if (wasBehind) {
      s.extraRollFor = s.current;
      log(`🎯 ${p.name} nailed it from behind — bonus roll incoming!`, "good");
    }
  }
  botBanter(band === "miss" ? "riskLose" : "riskWin", p, { card: card.title });
  resolveNext();
}

/** AI resolves the active card after a short dramatic pause (local mode).
 *  Humans watch the full flow: card -> think (2.2s) -> answer banner + effects
 *  -> beat (1.4s) -> next. Room mode gets the same rhythm from the server. */
function resolveActiveCardForAI() {
  const s = G.state;
  const card = CARD_BY_ID[s.activeCard];
  if (!card) { resolveNext(); return; }
  aiMaybeWager(s, card);
  // Headless/test mode: no timers, resolve synchronously so driver loops work.
  if (s.mode === "test-auto" || !HAS_DOM) {
    applyResponse(screwTargetedAt(s, s.current) ? screwRushResponse(s, card) : aiRespondToCard(s, card));
    return;
  }
  const token = ++G.turnToken;
  setTimeout(() => {
    if (token !== G.turnToken || !G.state || G.state.phase !== "resolving" || G.state.activeCard !== card.id) return;
    // A screwed bot loses its head: it may rush the pass/refuse line.
    const resp = screwTargetedAt(s, s.current) ? screwRushResponse(s, card) : aiRespondToCard(s, card);
    applyResponse(resp);                       // effects land; banner via hooks below
  }, aiStepSeconds() * 1000);
}

/* ============================================================================
 * 9. SAVE / LOAD
 * ========================================================================= */

function saveGame() {
  const s = G.state;
  if (!s) return;
  if (s.phase === "resolving" || s.phase === "await-vote" || s.phase === "await-duel" || s.phase === "moving") {
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
      if (s.phase === "await-vote" && s.vote) {
        if (s.vote.context === "duel") renderDuelModal(); else openVoteModal();
      }
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

  // Duel modal (writing phase, head-to-head vote, or the final summary)
  const inDuel = s.duel && (s.phase === "await-duel" || s.duel.done
    || (s.phase === "await-vote" && s.vote && s.vote.context === "duel"));
  if (inDuel) renderDuelModal();
  else if ($("#duel-modal").classList.contains("open")) closeModal("#duel-modal");

  // Vote modal
  if (s.phase === "await-vote" && s.vote && s.vote.context !== "duel") openVoteModal();
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
  const onTheTable = wagerOpen(p);

  // Bots spend their screw token to rush a human's card (local mode only).
  if (human && s.mode !== "room" && !screwOpen(s)) aiMaybeScrew(s);

  // Wager banner: a live wager rides the card; otherwise the offer is explained.
  const wagerBox = $("card-wager");
  if (wagerBox) {
    wagerBox.hidden = !(human && wagerEligible(card) && (onTheTable || canWager(s, s.current)));
    wagerBox.textContent = onTheTable
      ? `💸 WAGER LIVE — ${WAGER.STAKE_AP} AP riding on this card. Win: doubled. Lose: the stake is gone.`
      : `💸 Double or nothing — stake ${WAGER.STAKE_AP} AP to double this card's reward. Come out even or behind and the stake is gone. One wager per lap.`;
  }

  // Screw banner: a rival's token is running down someone's clock.
  const screwNow = screwOpen(s);
  const screwBox = $("card-screw");
  if (screwBox) {
    const secs = screwNow ? Math.max(0, Math.ceil((screwNow.deadline - Date.now()) / 1000)) : 0;
    const atkName = screwNow ? ((s.players[screwNow.by] || {}).name || "Someone") : "";
    const victim = screwNow ? ((s.players[screwNow.target] || {}).name || "someone") : "";
    screwBox.hidden = !screwNow;
    screwBox.classList.toggle("hot", !!screwNow);
    if (screwNow) {
      screwBox.textContent = (human && screwNow.target === s.current)
        ? `⏱️ SCREWED by ${atkName} — answer NOW. ${secs}s before the card answers for you.`
        : `😈 ${atkName} screwed ${victim} — ${secs}s on the clock.`;
    }
  }

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
    if (wagerEligible(card) && !onTheTable && canWager(s, s.current)) {
      addBtn(`💸 Wager ${WAGER.STAKE_AP} AP (double or nothing)`, "btn-wager", () => submitWager());
    }
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
    } else if (card.type === "duel") {
      // Duel: everyone writes, so the card only opens the round.
      addBtn("✍️ Everyone answers", "btn-warn", () => submitResponse({ kind: "none" }));
    }
  } else {
    const waitLabel = s.mode === "room" ? "waiting…" : "thinking…";
    actions.appendChild(el("div", "ai-thinking", `${p.avatar} ${p.name} is ${waitLabel}`));
  }

  // Screw: spend the token to rush whoever is on the card.
  const screwActor = (human && s.mode !== "room") ? -1 : localScrewActor(s);
  if (screwActor >= 0 && !screwNow) {
    addBtn(`😈 Screw ${p.name} (${SCREW.SECONDS}s to answer)`, "btn-screw", () => submitScrew(screwActor));
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

  armScrewTimer(s);
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

/* ---- Duel modal (write phase + head-to-head votes) ---- */
function renderDuelModal() {
  if (!HAS_DOM) return;
  const s = G.state;
  const modal = $("#duel-modal");
  if (!modal) return;
  if (!s || !s.duel) { modal.classList.remove("open"); return; }
  const card = CARD_BY_ID[s.duel.cardId];
  $("#duel-badge").textContent = "DUEL" + (card ? " · " + card.id : "");
  $("#duel-title").textContent = card ? card.title : "Head to Head";
  $("#duel-prompt").textContent = card ? card.description : "";
  const body = $("#duel-body"), status = $("#duel-status"), actions = $("#duel-actions");
  body.innerHTML = ""; status.innerHTML = ""; actions.innerHTML = "";
  const answered = duelAnswered(s);

  (s.duel.results || []).forEach((r) => {
    const tags = [];
    if (r.cancelled) tags.push("duplicate — cancelled");
    if (r.safetyA) tags.push("A safe ×½");
    if (r.safetyB) tags.push("B safe ×½");
    const suffix = tags.length ? ` · ${tags.join(" · ")}` : "";
    body.appendChild(el("div", "duel-feed",
      (r.bIdx === undefined || r.bIdx < 0)
        ? `⚔️ ${r.aName} — bye (+${r.apA} AP)${suffix}`
        : `⚔️ ${r.aName} ${r.aVotes}–${r.bVotes} ${r.bName} → +${r.apA} / +${r.apB} AP${suffix}`));
  });

  if (s.duel.done) {
    body.appendChild(el("div", "duel-done", "That was the table's taste. Paid, logged, never mentioned again."));
    const go = el("button", "btn btn-primary", "Continue");
    go.onclick = () => endDuel();
    actions.appendChild(go);
    modal.classList.add("open");
    return;
  }

  if (s.phase === "await-vote" && s.vote && s.vote.context === "duel") {
    const texts = s.vote.texts || ["…", "…"];
    const opts = el("div", "duel-options");
    ["A", "B"].forEach((tag, i) => {
      const o = el("div", "duel-option");
      o.appendChild(el("span", "duel-option-tag", tag));
      o.appendChild(el("span", "duel-option-text", texts[i] || "…"));
      opts.appendChild(o);
    });
    body.appendChild(opts);
    const voterList = (s.vote.voters || []).map((i) => s.players[i]).filter(Boolean);
    voterList.forEach((v) => {
      const vd = s.vote.verdicts[v.id];
      const line = el("div", "vote-line");
      line.appendChild(el("span", "vote-who", `${v.avatar} ${v.name}`));
      line.appendChild(el("span", "vote-verdict", vd === "yes" ? "✅ A" : vd === "no" ? "❌ B" : "…"));
      status.appendChild(line);
    });
    const me = voterList.find((v) => !v.isAI && !s.vote.verdicts[v.id]);
    if (me) {
      const a = el("button", "btn btn-good", "Vote A");
      a.onclick = () => MP.sendVote("yes");
      const b = el("button", "btn btn-bad", "Vote B");
      b.onclick = () => MP.sendVote("no");
      actions.appendChild(a);
      actions.appendChild(b);
    } else {
      actions.appendChild(el("div", "ai-thinking", "Tallying…"));
    }
  } else if (s.phase === "await-duel") {
    s.players.forEach((p) => {
      const line = el("div", "vote-line");
      line.appendChild(el("span", "vote-who", `${p.avatar} ${p.name}`));
      line.appendChild(el("span", "vote-verdict", answered.includes(p.id) ? "✍️ in" : "…"));
      status.appendChild(line);
    });
    const pending = duelPendingHumans(s);
    const myId = s.mode === "room" && s.room ? s.room.playerId : null;
    const iOwe = myId ? pending.some((i) => s.players[i].id === myId) : pending.length > 0;
    if (iOwe) {
      const who = myId ? s.players.find((p) => p.id === myId) : s.players[pending[0]];
      body.appendChild(el("div", "duel-prompt", `${who.avatar} ${who.name} — your answer:`));
      const inp = el("input", "answer-input");
      inp.type = "text";
      inp.maxLength = 90;
      inp.placeholder = "Worst possible answer…";
      body.appendChild(inp);
      const go = el("button", "btn btn-primary", "Lock it in");
      go.onclick = () => submitDuelAnswer(inp.value);
      inp.onkeydown = (e) => { if (e.key === "Enter") submitDuelAnswer(inp.value); };
      actions.appendChild(go);
      setTimeout(() => inp.focus(), 40);
    } else {
      body.appendChild(el("div", "ai-thinking", "Waiting for the rest of the table…"));
    }
  }
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
  $("#vote-mode").textContent = s.vote.context === "duel"
    ? "HEAD TO HEAD — vote with your laugh, AP is paid by share"
    : s.vote.mode === "unanimous"
      ? "UNANIMOUS MERCY — one punish dooms you"
      : s.vote.mode === "split"
        ? "SPLIT DECISION — the closer to 50/50, the more AP"
        : "MAJORITY RULES — tie forgives";
  const box = $("#vote-buttons");
  box.innerHTML = "";
  const voterList = s.vote.voters
    ? s.vote.voters.map((i) => s.players[i]).filter(Boolean)
    : s.players.filter((_, i) => i !== s.current);
  const pendingHuman = voterList.find((v) => !v.isAI && !s.vote.verdicts[v.id]);
  const status = $("#vote-status");
  status.innerHTML = "";
  voterList.forEach((v) => {
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
  const outcome = result.mode === "split"
    ? `${result.splitPct}% DIVISIVE`
    : result.succeeded
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
  if (a.mostDivisive) add(`🪓 Most Divisive (${a.mostDivisive.stats.bestSplit}% split)`, a.mostDivisive);
  if (a.duelChampion) add(`🎤 Duel Champion (${a.duelChampion.stats.duelsWon} won)`, a.duelChampion);
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
    startCardVote, splitScore, applySplitResult, lapMultiplier, cardRewardAp, lapNote,
    WAGER, wagerEligible, wagerOpen, canWager, takeWager, settleWager, aiMaybeWager, submitWager,
    RISK_BANDS, riskBand, riskPayout, riskOutcome,
    SCREW, screwEligible, screwOpen, canScrew, takeScrew, settleScrew, screwPassResponse,
    screwRushResponse, screwTargetedAt, aiMaybeScrew, localScrewActor, submitScrew,
    aiShouldBluff, aiTakeRisk, aiChooseSabotageTarget, aiVoteOnPlayer, aiRespondToCard,
    aiVoteOnDuel, aiDuelAnswer, duelShare, normDuelAnswer, findDuelDuplicates, duelSafetyAp,
    startDuel, submitDuelAnswer, maybeFinishDuelAnswers, finishDuelPair, startDuelVote,
    endDuel, duelAnswered, duelPendingHumans, renderDuelModal,
    ranking, computeAwards, endTurn, finishTile, doRoll, resolveActiveCardForAI,
    G, PENALTY, CARD_BY_ID, AI_PROFILES, BOARD_SIZE,
  };
}
