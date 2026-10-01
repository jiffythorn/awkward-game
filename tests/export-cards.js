/** Exports data/cards.js to data/cards.json for the PHP backend. Run: node tests/export-cards.js */
"use strict";
const fs = require("fs");
const { AWKWARD_CARDS } = require("../data/cards.js");
fs.writeFileSync(
  __dirname + "/../data/cards.json",
  JSON.stringify(AWKWARD_CARDS, null, 1)
);
console.log("Wrote data/cards.json with " + AWKWARD_CARDS.length + " cards.");
