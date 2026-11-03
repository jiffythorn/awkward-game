# The Awkward Game — Rules

An adult party game about surviving society's most uncomfortable moments with your dignity (mostly) intact.

**Core loop:** roll, move, land on a tile, face the scenario, suffer the consequences, watch the group judge you.

---

## 1. Overview

2–8 players (humans and/or AI). Everyone races around a 54-tile board collecting **Awkward Points** (good!) while trying to avoid **Shame Points** (bad). A game is **3 laps** around the board by default (configurable 1–5, or "Endless" — end whenever the pizza arrives).

**Two victory tracks:**

- **Awkward Points (AP)** — earned by embracing awkwardness. Higher is better.
- **Shame Points (SP)** — earned by being caught lying, chickening out, or being judged by the group. Lower is better.

**Winner** = highest AP. **Tiebreaker** = lowest SP. Still tied = shared shame, nobody wins, everyone remembers.

## 2. What you need

- The board (54 tiles, see §5).
- Five decks: **Scenario**, **Choice**, **Risk**, **Sabotage**, **Group Vote**.
- One token per player.
- **Sabotage Tokens:** each player starts with 2. Spend one to play a Sabotage card against any player. You get them back from certain tiles (Chaos, Double Trouble, Safe +2).
- A timer is optional but encouraged for Risk decisions (30 seconds, use your phone).

## 3. Players

Each player has:

| Attribute | Meaning |
|---|---|
| Name | Whatever the group agrees to call you. |
| Token/Avatar | Your piece on the board. |
| Board position | Tile index 0–53; tile 0 is START. |
| Awkward Points (AP) | The good stuff. |
| Shame Points (SP) | The bad stuff. |
| Sabotage Tokens | Ammunition. Start with 2. |

## 4. Turn flow

1. **Roll** — roll the die (1–6).
2. **Move** — advance your token that many tiles. Board is a loop; passing START earns a **+2 AP Lap Bonus**.
3. **Resolve the tile** — the tile type tells you which deck to draw from (see §5).
4. **Respond** — answer truthfully, bluff, choose, risk, or sabotage as the card demands.
5. **Judge** — for Bluff/Confess and Group Vote tiles, the other players vote. AI players vote with their own personalities.
6. **Apply effects** — move your AP/SP trackers. Some cards move you extra tiles, grant Sabotage Tokens, or force re-rolls.
7. **End turn** — play passes clockwise. Landing on another player's token does nothing (you are roommates, not enemies... yet).

**Turn timing:** voting windows are 30 seconds in multiplayer; if a human doesn't vote in time, their vote is discarded. AI votes resolve instantly.

## 5. The 54 tiles

Tiles repeat in a deliberate rhythm so players can feel the pressure coming. Final composition:

| Tile type | Count | Effect |
|---|---|---|
| Scenario | 13 | Draw a Scenario card. Pure awkward theatre — act it out or answer. |
| Choice | 9 | Draw a Choice card. Two awful options; you **must** pick one. Refusing costs 3 SP. |
| Risk | 8 | Draw a Risk card. Accept the gamble (success reward / failure penalty) or decline for a small cost. |
| Sabotage | 6 | You **may** spend a Sabotage Token to strike another player. Or skip and take +1 AP. |
| Group Vote | 3 | The group votes on your fate per the card (dilemmas pay for a close split). |
| Duel | 2 | Everyone writes an answer; answers are paired and the table votes head-to-head. |
| Safe | 7 | Nothing happens. Take a breath. |
| Chaos | 3 | Draw a card from a random deck and resolve it, no matter how weird. +1 Sabotage Token. |
| Double Trouble | 2 | Draw **two** cards (Scenario + Choice) and survive both. +1 Sabotage Token. |
| Final Combo | 1 | The last tile before START. Draw one card from **each** of Scenario, Choice, and Risk. Survive all three for **+10 AP**; each one you fluff costs SP. |

(Low-liquidity decks — Choice, Risk, Vote, Sabotage — reshuffle their discards whenever empty, so the game can never stall.)

## 6. The card system

202 cards: 36 each in Scenario, Choice, Risk and Sabotage, 48 Group Vote cards (36 verdicts + 12 dilemmas), and 10 Duels. Every card has an **ID**, **type**, **title**, **description**, **effect text**, an AP delta, an SP delta, and optional **tags** (social, work, relationship, dark humor, party, cringe...).

### Scenario cards (36)
Pure awkward situations. Usually worth AP for surviving them ("recount the worst date to the group"), SP for refusing. Tags keep them humane-ish.

### Choice cards (36)
Two options, both bad. E.g. *"Text your ex 'we need to talk' (3 AP) **OR** admit your real age on your CV out loud (1 AP, 1 SP)"*. Refusal = **3 SP**.

### Risk cards (36)
A gamble with a stated **reward** and **penalty**. The player declares "I take the risk" or "I chicken out" (chickening out costs a small SP toll, typically 1–2). Some risks need a coin flip / die roll; others are decided by whether the group believes you'll do it.

**Risks are graded, not binary** — every outcome lands in a band, priced off the card's own reward:

| Band | How you get it | Pays |
|---|---|---|
| **Bullseye** 🎯 | die = 6, or a unanimous 2+ voter table believes you | **double reward** (+ a bonus roll if you were behind the leader) |
| **Good** | die = 5, or a believing majority, or coin heads | the card's reward as written |
| **Near** | die = 4, or a tied vote | **half** the reward, no penalty, no shame |
| **Miss** | die ≤ 3, or the table doubts you, or coin tails | the card's penalty **+1 SP** |

The coin has no middle — it stays a coin. **Bullseye from behind:** if a player who is *not* leading nails a bullseye, they take an **immediate extra roll** instead of passing the turn, which is the cheapest comeback in the game and the reason late laps get loud.

### Wager to play — double or nothing
Before answering a **Scenario, Choice, Risk, Sabotage or Group Vote** card you may wager **2 AP** on yourself — **once per lap**, with one wager on the table at a time. The wager settles when the card does:

- **You come out ahead on AP** → your winnings are **doubled** (+3 becomes +6) and the stake stays in your pocket.
- **You come out even or behind** (no AP gain, or the card costs you AP/SP) → the **2 AP stake is gone**, on top of the card's own punishment.
- **Duels are off the table.** They pay the whole table by vote share, so there is no single outcome to bet on.

Trailing players are expected to gamble: doubling a ×2 late-lap reward is the cheapest comeback in the game, and busting costs less than one bad Risk card. The card banner shows a live wager while it rides, and every settlement is logged.

### Screw token — answer now (once per lap)
While **another player** has a card on the table you may spend your **Screw token** to rush them: they get **10 seconds** to commit. Run out the clock and the card answers for you with its pass line (refuse / chicken out / skip). A bot forced to rush keeps its head part of the time and panics the rest.

- **The screw lands** (the target gains no AP on the card) → target **−2 AP, +1 SP**, attacker **+2 AP**.
- **It backfires** (the target still comes out ahead) → **attacker −2 AP**, and the target keeps everything.
- **One screw per lap**, one on the clock at a time. Duels, Safe and Chaos are immune — there is no single answer to rush.

Why it works: sabotage *with a cost* is a decision, not a free action, so target choice becomes a social signal — screwing the leader is noble, screwing last place is villainous.

### Sabotage cards (36)
Played **only** by spending a Sabotage Token. Target any player (AI prefers the leader, with some chaos). Effects shift AP/SP between players ("Steal 3 AP", "Dump 2 SP", "Force a re-roll next turn"). The target may get a say on some cards.

### Group Vote cards (36)
The table judges you. Each player (and AI) votes **PUNISH** or **FORGIVE**; the majority decides, and a tie forgives (mercy by default). Punish outcomes apply the card's SP penalty (and sometimes an AP hit); forgive outcomes often grant a small AP bonus for being believed. Two sub-modes exist on some cards: **majority rules** (default) and **unanimous mercy** (all must forgive to spare you).

### Dilemmas — Split the Room (12 cards)
Some Group Vote cards are **dilemmas**: the table votes **YES** or **NO** on a deliberately divisive question (pineapple on pizza, reclining your seat, reply-all). The player who raised it is not on trial — the *table's taste* is.

- **Scoring:** you earn `1 + round(splitAp × closeness)` AP, where `closeness = 1 − |yes − no| ÷ voters`. A perfect 50/50 split pays the full 4–6 AP bonus; a lopsided result pays almost nothing.
- **Boring tables get called out:** if 3 or more players vote and the result is unanimous, you also take **+1 SP**. Nobody argued. That's the real shame.
- **Everyone has a stake:** the dilemma is a free read on the table's fault lines, and it gives non-active players a vote every time, which keeps downtime down.
- **Most Divisive award:** the player with the single most evenly-split dilemma takes it at the ceremony.

### Duels — Head to Head (10 cards)
A duel turns the whole table into a writing room, then a comedy bracket.

1. **Everyone writes.** Each player submits one answer to the prompt (90 characters max). AI players answer instantly from the card's own pool.
2. **Pairings are drawn** at random. An odd table gives one player a **bye** (+2 AP, lap-scaled).
3. **Anonymous votes.** For each pairing, everyone *except those two players* votes **A** or **B** — without seeing who wrote what.
4. **Payout is vote share:** `round(4 × votes ÷ voters)` AP, plus **+2** for winning the pairing, or **+4** on a unanimous sweep. A tie pays both duelists their share **+1**. With no jury at all (a two-player table) both take a flat **2 AP**.
5. **Duplicates are cancelled** before any vote, and **blank answers earn half** (see below).

**Duplicates cancel.** Two players who write the same answer (ignoring case and punctuation) cancel each other out: no vote is held for that pairing, the duplicate authors score **0**, and a clean answer wins the pairing by default (**+2 AP**). If both sides duplicated, nobody scores. Unoriginality is the one thing the table can't reward.

**Safe answers (Safety Quip).** Submit nothing and you get the auto-fill *"said nothing, stared into the middle distance"*, worth only **half AP** (rounded down). Safe answers never count as duplicates, so a table of cowards can't cancel itself out of the round.

Why share instead of winner-takes-all: the funniest loser still scores, one pairing with different taste can't sink a game, and a unanimous sweep is worth chasing. Duel AP is card AP, so the lap multiplier applies per duelist. Winning the most pairings earns the **🎤 Duel Champion** award.

### Lap escalation (late laps pay more)
AP earned **from cards** scales with the acting player's lap: **×1 on lap 1, ×2 on lap 2, ×3 on lap 3** (capped at ×3, including Endless mode). Penalties, sabotage damage, lap bonuses and the Final Combo bonus are **never** scaled.

- The log shows the multiplier: `+6 AP (risk paid off!) [lap 2 ×2]`.
- Why: a slow start should not be a lost game. Late laps swing harder, so trailing players always have a live comeback path, and a leader can still be caught by one big lap-3 card.
- Quick maths: a 3 AP scenario in lap 3 pays 9 AP; a 6 AP risk in lap 3 pays 18. Save your nerve for the last lap.

On Bluff-type Scenario/Choice moments, a player may **bluff** — claim they did the thing. The group votes **BELIEVE / CAUGHT**.
- Believed: full card reward.
- Caught: the card reward flips to an SP penalty and you gain the **"Caught Liar"** tag for the log.
- **Confessing** instead of bluffing gives you the card's AP but a small honesty tax... unless you have no Shame to lose, in which case honesty is free. The Honest AI always confesses. The Liar AI bluffs 80% of the time. Watch them.

## 7. AI opponents

Five personalities, each with different probability sliders:

| Personality | Bluff | Risk | Sabotage | Vote punish | Notes |
|---|---|---|---|---|---|
| Chill | 10% | 30% | 20% | 20% | Friendly, forgives a lot. |
| Chaotic | 50% | 70% | 60% | 50% | High chaos roll — sometimes does something brilliant. |
| Brutal | 20% | 60% | 85% | 75% | Hunts the leader, punishes hard. |
| Honest | 0% | 20% | 10% | 30% | Always confesses, hates voting to punish. |
| Liar | 80% | 50% | 40% | 60% | Bluffs constantly, gets caught constantly. |

AI decision functions (see `game.js`): `aiShouldBluff`, `aiTakeRisk`, `aiChooseSabotageTarget`, `aiVoteOnPlayer`, `aiDuelAnswer` (which canned line an AI writes) and `aiVoteOnDuel` (which answer an AI votes for). All are deterministic given the RNG seed + personality + game state, so a game can be replayed.

AI also evaluates board position: a player 3+ tiles ahead of the AI becomes a preferred sabotage target; a player on the Final Combo tile becomes a priority target ("stop them surviving the combo").

## 8. Multiplayer (PHP backend)

Host creates a room (`create.php`), gets a 6-character code, and shares it. Others `join.php` with the code. The room stores full game state as a JSON file per room on the server. Clients **poll** `state.php` every ~1.5s during a game (1s in lobby).

- Only the **current player** may roll, resolve, or spend tokens — the server validates every action against the turn index and phase, and rejects stale/expired sessions.
- Dice rolls are **server-side**. The client never decides movement.
- The card order lives server-side only; the client receives cards the server deals to it, never the deck order.
- Votes are submitted per-player and resolved once everyone votes or the 30s window expires.

## 9. Persistence

- **Single-player:** LocalStorage key `awkward-game-save-v1` stores players, board index, deck cursors, turn, phase, and log. "Continue" on the menu resumes.
- **Multiplayer:** the same state JSON lives in `rooms/<id>.json` on the server. `update.php` and `vote.php` mutate it with a file lock so two players can't corrupt it.

## 10. Awards (end-of-game ceremony)

- 🏆 **Winner** — highest AP (tiebreak: lowest SP).
- 🤥 **Best Liar** — most successful bluffs.
- 😇 **Most Honest** — most confessions.
- 🎯 **Most Sabotaged** — most times targeted.
- 🔥 **Chaos Gremlin** — most Chaos tiles triggered.
- 🪓 **Most Divisive** — the most evenly-split dilemma (the table argued, and that was the point).
- 🎤 **Duel Champion** — the most head-to-head pairings won.

## 11. Themes

Switch from the header selector. Themes restyle everything via CSS custom properties on `<body data-theme="...">`:

- **Neon Party** — dark + glow. The default.
- **Corporate** — beige, serif headings, HR-compliant misery.
- **Dark Humor** — black/red, high contrast.
- **Relationship Edition** — warm pinks (for couples who play to lose).
- **Chaos Mode** — animated gradients, rotating tiles. I'm sorry.

## 12. Etiquette & safety

This is a comedy game. Every card is written so the **player** chooses what they're comfortable doing — the game rewards *playing along with the bit*, not actual distress. Skip anything, eat the SP, keep the group laughing. House rule: anyone can call "safe word" and skip a card for 1 SP, no questions asked.

---

*Now shuffle up and get awkward.*
