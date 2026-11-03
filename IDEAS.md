# The Awkward Game — Expansion Ideas

Research notes and a roadmap for growing the game, drawn from modern social/party games
(Jackbox Quiplash / Fibbage / Split the Room / Monster Seeking Monster / Drawful / You Don't
Know Jack, Cards Against Humanity, Snake Oil, Wavelength, Monikers, Codenames, Just One,
One Night Ultimate Werewolf).

**Shipped so far:** Dilemmas (Split the Room scoring), Lap escalation (×1/×2/×3), the Most Divisive
award, Quiplash-style **head-to-head duels** with vote-share scoring, **wager to play** (double or
nothing), the **Screw token** (rush a rival's answer), and **risk bands** (bullseye + bonus roll).
Everything below is not yet built — ordered by *fun per unit of work*.

---

## What just landed

| Mechanic | Where it came from | Why it fits this game |
|---|---|---|
| **Dilemmas** — 12 new Group Vote cards where the table votes Yes/No and the author earns AP for a close split | Split the Room | Rewards *controversy* instead of consensus, gives every idle player a vote, and turns the existing vote engine into a comedy engine. |
| **Lap escalation** — card AP ×1, ×2, ×3 by lap | Quiplash's ×1/×2/×3 round multipliers | Late laps now swing harder, so a quiet first lap is not a lost game and the table stays engaged to the end. |
| **Most Divisive award** | Split the Room / Drawful's "Bonus Likes" | A status currency that is not the win condition, so a player having a bad game still has something to chase. |
| **Duels** — 10 new Duel cards on 2 board tiles: everyone writes, answers are paired anonymously, the table votes | Quiplash's 1v1 write-then-vote rounds | Turns the whole table into writers and judges, and pays by **vote share** so a funny loser still scores. |
| **Wager to play** — stake 2 AP before a card for doubled winnings or a lost stake, once per lap | Cards Against Humanity's gambling rule | Converts a safe table into a scoring table: trailing players *must* gamble, and 2 AP is cheap enough to chase a comeback. |
| **Screw token** — once per lap, rush a rival's answer with a 10-second clock; −2 AP if they still score | You Don't Know Jack's screw | Sabotage with a cost: target choice becomes a social signal, and rushing the leader is a legitimate play. |
| **Risk bands** — bullseye / good / near / miss, with a bonus roll for a bullseye from behind | Wavelength's graded guesses | Kills the pass/fail shrug: every risk has a reason to swing big, and the catch-up roll keeps hope alive. |

---

## Tier 1 — cheap, high payoff (reuse existing machinery)

### 1. The Screw token (You Don't Know Jack) — ✅ shipped

**Shipped:** once per lap, during a rival's card, spend the token to put them on a 10-second clock.
No AP gain → target −2 AP / +1 SP, attacker +2 AP. Target still scores → attacker −2 AP. Rushed bots
answer cold part of the time; a human who freezes gets the card's pass line. Mirrored in `game.js`
and `rooms/lib.php`, with a `screw` server action.

Original spec: a once-per-lap action that forces a rival to answer *immediately*, with real downside
for the attacker.
- Attacker spends the token; the target has **10 seconds** to commit.
- Target succeeds → attacker takes **−2 AP** (petty and wrong).
- Target fails/passes → target takes **−2 AP**, attacker takes **+2 AP**; the target also takes **+1 SP**.

Why it works: sabotage *with a cost* is a decision, not a free action, so target choice becomes a
social signal ("screwing the leader is noble, screwing last place is villainous").
**Effort:** medium — needs a timer phase in `game.js` and a `screw` action in `rooms/update.php`.

### 2. Wager to play (Cards Against Humanity's gambling rule) — ✅ shipped

**Shipped:** 2 AP stake taken before answering (Scenario/Choice/Risk/Sabotage/Vote), settled with the
card — positive AP swing doubles and the stake rides, otherwise the stake is lost. Once per lap, bots
gamble harder when behind, mirrored in `game.js` and `rooms/lib.php`.
Before seeing a card's options, a player may wager **1 AP** for a doubled reward — or a doubled penalty.
- Win → regain the wager **and** the reward (a +3 swing at 1 AP).
- Lose → lose the wager **and** the penalty (a −2 swing).
- Cap: one wager per lap.

Why it works: trailing players *must* gamble; it converts a safe table into a scoring table and makes
comebacks possible without free points. **Effort:** small-to-medium (state flag + UI toggle + PHP mirror).

### 3. Bullseye catch-up (Wavelength's "4 while behind → extra turn") — ✅ shipped

**Shipped:** risks are graded instead of binary — die 6/5/4/≤3 and the believe-vote margin map to
bullseye / good / near / miss, priced off each card's own reward (×2 / ×1 / ×½ / penalty +1 SP). A
bullseye while behind the leader books an extra roll through `finishTile` (JS) and `awkward_end_turn`
(PHP). The coin stays binary; it has no middle. Original spec: bullseye +6 / good +3 / near +1 /
miss −2 AP +2 SP with an immediate extra roll when behind.

### 4. Judge rotation with cancellation (Just One + CAH's Card Czar)
- Each lap one player is **The One Who Decides**; their verdict card vote counts twice, and they name
  one answer they "hate but respect" for **+2 AP**.
- **Duplicate-answer cancellation:** identical spoken answers in a vote cancel each other (both take
  +1 SP for lacking nerve).

Why it works: cancellation is the cheapest way to force originality, and a rotating judge makes the
"everyone votes for their friend" problem self-correcting. **Effort:** small for the judge tiebreak;
medium for cancellation (needs normalized answer text, already collected by the optional answer box).

---

## Tier 2 — the Jackbox core: player-authored rounds

### 5. Head-to-head duels (Quiplash) — ✅ shipped
Pair players so each prompt is a **1v1 comparison** rather than judging 8 answers.
- Each duel: everyone writes one answer, answers are paired at random, and the rest of the table votes
  **A** or **B** without seeing authors.
- Score = **vote share**: `AP = round(4 × votes_for_you / voters)`, plus **+2** for winning the pairing,
  **+4** on a unanimous sweep; a tie pays both +1; an odd table gives one bye (+2 AP).
- AI answers come from each card's own pool; AI votes favour the longer answer with a chaos roll.

Built into both engines (`startDuel`/`duelShare` in `game.js`, `awkward_start_duel`/`awkward_duel_share`
in `rooms/lib.php`), with per-player privacy on the server: clients only receive who has answered and
the two answers currently on the block. Duel wins feed the **Duel Champion** award.

Also in: **duplicate-answer cancellation** (matching answers score 0 and skip the vote) and Quiplash's **Safety Quip** half-credit for blank answers.

### 6. Reputation bonus / "about you" rounds (Fibbage: Enough About You)
One player is the **Subject**; everyone else writes a fake answer about them; the table picks the truth.
- Correct picker: **+3 AP**.
- Each person fooled by your lie: **+2 AP**.
- Subject earns **+1 AP per player who guessed correctly about them** (being legible is a skill).

Why it works: the subject rotates, so everyone is the topic once per lap — maximum awkwardness with
zero extra writing burden. **Effort:** large (same infrastructure as duels).

### 7. Player-authored decks at setup (Monikers' recursive deck)
At setup, each player contributes 2 awkward prompts; those feed the Scenario deck, and are **reused**
under tightening constraints later: lap 1 full story, lap 2 one sentence, lap 3 mime / three words.
- Callback bonus: referencing an earlier failed bluff earns **+2 AP** once per lap.

Why it works: setup labor becomes content, and "the first round is free training data" — the table
builds its own private vocabulary that later laps cash in. **Effort:** medium (setup UI + deck seeding;
MP needs a lobby-phase card submission endpoint).

### 8. Secret agendas / hidden roles (Monster Seeking Monster)
Deal each player a hidden objective worth bonus AP at the end, revealed **staggered** (one per lap),
not all at once:
- "Get caught lying twice" (+5 AP), "finish with the most confessions" (+5), "be forgiven by a
  unanimous vote" (+6), "never spend a Sabotage token" (+4).

Why it works: it gives every player a secret motive and makes social reading pay off; staggered
reveals let the table counter-play instead of shrugging at the end.
**Effort:** medium in local play; **hard in multiplayer** — the room JSON is public to clients, so
agendas must be per-player filtered server-side in `awkward_public_state()` or they leak.

---

## Tier 3 — bigger structural bets

### 9. Audience / spectator mode
Players beyond the seat cap join as an audience that votes on cards, awards "likes" (a second,
non-winning currency) and can be rotated into seats between laps. Jackbox's documented pattern for
8+ groups; also the cleanest fix for party downtime.
**Effort:** large (new role, chat/vote endpoints, polling).

### 10. Category decks and themed nights
Split existing tags into selectable packs (Work, Dating, Family, Travel, Dark) and let the setup screen
deal from 2–3 chosen packs. Pure data plus a setup control — no engine change.
**Effort:** small, and it makes the 202 cards feel like a lot more.

### 11. Sudden-death finale in the last lap
When the final lap begins, flip the board to a short "lightning loop": every tile is a Risk or a
Dilemma, AP is doubled on top of the lap multiplier, and the first player to cross START wins outright.
**Effort:** medium (board variant + end condition).

---

## Guardrails from the research

- **Runaway leader:** prefer ramps (lap multipliers) and hidden objectives over punishing the leader.
  The "blue shell" pattern (attack whoever is first) makes leading a disadvantage and feels unfair.
- **Kingmaking:** a losing player deciding the winner is only fun if the table consented to a backstabbing
  game. The sabotage system already leans this way — say so in the rules, and keep the "attack the leader"
  incentive soft (the current AI preference, not a hard rule).
- **Downtime:** every non-active player should always have an action. Votes do this today; dilemmas make
  it happen more often. Any new mechanic should keep that invariant.
- **Keep SP spendable:** shame that can be *spent* (skip a card, buy a re-roll, bribe the judge) is funnier
  than shame that only subtracts. This is the single biggest untapped lever in the current design.
- **Escalation beats length:** a 3-lap game with ×1/×2/×3 outscores a 5-lap game with flat scoring for
  the same session length.

---

## Where each change would live

| File | Role |
|---|---|
| `data/cards.js` → `data/cards.json` | Card content; export with `node tests/export-cards.js` |
| `data/board.js` | 54-tile loop; tile composition is asserted in `tests/engine.test.js` |
| `game.js` | Local engine, AI, UI. Scoring helpers live next to `applyDeltas()` |
| `rooms/lib.php` | Server-authoritative mirror of every rule — **any scoring change needs both** |
| `rooms/update.php` | New player actions (e.g. `screw`, `wager`, `answer`) |
| `tests/engine.test.js`, `tests/api.smoke.js` | Engine assertions and end-to-end HTTP checks |
