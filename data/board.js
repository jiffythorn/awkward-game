/**
 * The Awkward Game — Board definition
 * =====================================
 * 54 tiles in a loop. Index 0 is START (safe). The composition and rhythm of
 * tile types are documented in RULES.md §5:
 *   Scenario 13, Choice 9, Risk 8, Sabotage 6, Vote 5, Safe 7, Chaos 3,
 *   Double Trouble 2, Final Combo 1  =  54 tiles.
 *
 * Tile shape (square/circle/diamond/pill) is derived from the tile index by
 * the renderer, so tiles carry no shape field here.
 */

/* @type-start */
const AWKWARD_BOARD = [
  /*  0 */ { type: "safe",      name: "START — Small Talk Roundabout" },
  /*  1 */ { type: "scenario",  name: "Elevator Silence" },
  /*  2 */ { type: "choice",    name: "Two Doors, Both Wrong" },
  /*  3 */ { type: "risk",      name: "The Bet" },
  /*  4 */ { type: "safe",      name: "Breather Bench" },
  /*  5 */ { type: "scenario",  name: "Wrong Name at a Party" },
  /*  6 */ { type: "choice",    name: "The Group Chat Dilemma" },
  /*  7 */ { type: "sabotage",  name: "Sabotage Alley" },
  /*  8 */ { type: "risk",      name: "High Wire Act" },
  /*  9 */ { type: "scenario",  name: "The Awkward Hug" },
  /* 10 */ { type: "vote",      name: "The Tribunal" },
  /* 11 */ { type: "safe",      name: "Water Cooler" },
  /* 12 */ { type: "choice",    name: "Fork in the Road" },
  /* 13 */ { type: "scenario",  name: "Confession Wall" },
  /* 14 */ { type: "risk",      name: "Double or Nothing" },
  /* 15 */ { type: "chaos",     name: "Chaos Vortex" },
  /* 16 */ { type: "scenario",  name: "Compliment Combat" },
  /* 17 */ { type: "sabotage",  name: "Backstab Boulevard" },
  /* 18 */ { type: "choice",    name: "Devil's Deal" },
  /* 19 */ { type: "safe",      name: "Neutral Corner" },
  /* 20 */ { type: "vote",      name: "Court of Public Opinion" },
  /* 21 */ { type: "scenario",  name: "Reply-All Regret" },
  /* 22 */ { type: "risk",      name: "The Long Con" },
  /* 23 */ { type: "scenario",  name: "Karaoke Nightmares" },
  /* 24 */ { type: "double",    name: "Double Trouble" },
  /* 25 */ { type: "choice",    name: "Rock and a Hard Place" },
  /* 26 */ { type: "sabotage",  name: "Knife Drawer" },
  /* 27 */ { type: "safe",      name: "Smoke Break" },
  /* 28 */ { type: "scenario",  name: "Text to the Wrong Person" },
  /* 29 */ { type: "risk",      name: "All-In" },
  /* 30 */ { type: "chaos",     name: "Chaos Portal" },
  /* 31 */ { type: "vote",      name: "Jury of Peers" },
  /* 32 */ { type: "choice",    name: "Between a Rock and a Boss" },
  /* 33 */ { type: "scenario",  name: "Small Talk Speedrun" },
  /* 34 */ { type: "safe",      name: "Safe House" },
  /* 35 */ { type: "sabotage",  name: "Trap Door" },
  /* 36 */ { type: "risk",      name: "Leap of Faith" },
  /* 37 */ { type: "scenario",  name: "The Wedding Toast" },
  /* 38 */ { type: "choice",    name: "Lesser Evil Lotto" },
  /* 39 */ { type: "vote",      name: "The Referendum" },
  /* 40 */ { type: "chaos",     name: "Chaos Storm" },
  /* 41 */ { type: "scenario",  name: "The Group Photo" },
  /* 42 */ { type: "sabotage",  name: "Sabotage Junction" },
  /* 43 */ { type: "choice",    name: "No Good Options" },
  /* 44 */ { type: "risk",      name: "The Gamble" },
  /* 45 */ { type: "safe",      name: "Zen Garden" },
  /* 46 */ { type: "scenario",  name: "Family Dinner" },
  /* 47 */ { type: "vote",      name: "Final Judgement" },
  /* 48 */ { type: "double",    name: "Double Trouble II" },
  /* 49 */ { type: "choice",    name: "The Last Straw" },
  /* 50 */ { type: "scenario",  name: "The Exit Line" },
  /* 51 */ { type: "sabotage",  name: "Ambush Corner" },
  /* 52 */ { type: "risk",      name: "One Last Bet" },
  /* 53 */ { type: "final",     name: "FINAL COMBO — Survive All Three" }
];
/* @type-end */

/** Short labels used on the rendered tiles. */
const TILE_LABELS = {
  safe:     "SAFE",
  scenario: "SCEN",
  choice:   "CHCE",
  risk:     "RISK",
  sabotage: "SABO",
  vote:     "VOTE",
  chaos:    "CHOS",
  double:   "DBLE",
  final:    "FINL"
};

/* Export for Node (tests) and browser (window globals). */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { AWKWARD_BOARD, TILE_LABELS };
}
