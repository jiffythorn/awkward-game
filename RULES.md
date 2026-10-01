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
| Group Vote | 5 | The group votes on your fate per the card (punish or forgive; a few cards also reward the majority). |
| Safe | 7 | Nothing happens. Take a breath. |
| Chaos | 3 | Draw a card from a random deck and resolve it, no matter how weird. +1 Sabotage Token. |
| Double Trouble | 2 | Draw **two** cards (Scenario + Choice) and survive both. +1 Sabotage Token. |
| Final Combo | 1 | The last tile before START. Draw one card from **each** of Scenario, Choice, and Risk. Survive all three for **+10 AP**; each one you fluff costs SP. |

(Low-liquidity decks — Choice, Risk, Vote, Sabotage — reshuffle their discards whenever empty, so the game can never stall.)

## 6. The card system

180 cards, 36 per deck. Every card has an **ID**, **type**, **title**, **description**, **effect text**, an AP delta, an SP delta, and optional **tags** (social, work, relationship, dark humor, party, cringe...).

### Scenario cards (36)
Pure awkward situations. Usually worth AP for surviving them ("recount the worst date to the group"), SP for refusing. Tags keep them humane-ish.

### Choice cards (36)
Two options, both bad. E.g. *"Text your ex 'we need to talk' (3 AP) **OR** admit your real age on your CV out loud (1 AP, 1 SP)"*. Refusal = **3 SP**.

### Risk cards (36)
A gamble with a stated **reward** and **penalty**. The player declares "I take the risk" or "I chicken out" (chickening out costs a small SP toll, typically 1–2). Some risks need a coin flip / die roll; others are decided by whether the group believes you'll do it.

### Sabotage cards (36)
Played **only** by spending a Sabotage Token. Target any player (AI prefers the leader, with some chaos). Effects shift AP/SP between players ("Steal 3 AP", "Dump 2 SP", "Force a re-roll next turn"). The target may get a say on some cards.

### Group Vote cards (36)
The table judges you. Each player (and AI) votes **PUNISH** or **FORGIVE**; the majority decides, and a tie forgives (mercy by default). Punish outcomes apply the card's SP penalty (and sometimes an AP hit); forgive outcomes often grant a small AP bonus for being believed. Two sub-modes exist on some cards: **majority rules** (default) and **unanimous mercy** (all must forgive to spare you).

### Bluffing (the spice)
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

AI decision functions (see `game.js`): `aiShouldBluff`, `aiTakeRisk`, `aiChooseSabotageTarget`, `aiVoteOnPlayer`. All are deterministic given the RNG seed + personality + game state, so a game can be replayed.

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
