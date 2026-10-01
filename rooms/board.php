<?php
/**
 * GET /rooms/board.php
 * Serves the 54-tile board definition as JSON (names + types + labels).
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

$names = [
    'START — Small Talk Roundabout', 'Elevator Silence', 'Two Doors, Both Wrong',
    'The Bet', 'Breather Bench', 'Wrong Name at a Party', 'The Group Chat Dilemma',
    'Sabotage Alley', 'High Wire Act', 'The Awkward Hug', 'The Tribunal',
    'Water Cooler', 'Fork in the Road', 'Confession Wall', 'Double or Nothing',
    'Chaos Vortex', 'Compliment Combat', 'Backstab Boulevard', "Devil's Deal",
    'Neutral Corner', 'Court of Public Opinion', 'Reply-All Regret', 'The Long Con',
    'Karaoke Nightmares', 'Double Trouble', 'Rock and a Hard Place', 'Knife Drawer',
    'Smoke Break', 'Text to the Wrong Person', 'All-In', 'Chaos Portal',
    'Jury of Peers', 'Between a Rock and a Boss', 'Small Talk Speedrun', 'Safe House',
    'Trap Door', 'Leap of Faith', 'The Wedding Toast', 'Lesser Evil Lotto',
    'The Referendum', 'Chaos Storm', 'The Group Photo', 'Sabotage Junction',
    'No Good Options', 'The Gamble', 'Zen Garden', 'Family Dinner', 'Final Judgement',
    'Double Trouble II', 'The Last Straw', 'The Exit Line', 'Ambush Corner',
    'One Last Bet', 'FINAL COMBO — Survive All Three',
];
$labels = [
    'safe' => 'SAFE', 'scenario' => 'SCEN', 'choice' => 'CHCE', 'risk' => 'RISK',
    'sabotage' => 'SABO', 'vote' => 'VOTE', 'chaos' => 'CHOS', 'double' => 'DBLE',
    'final' => 'FINL',
];

$types = awkward_board_types();
$tiles = [];
foreach ($types as $i => $t) {
    $tiles[] = ['index' => $i, 'type' => $t, 'name' => $names[$i] ?? ('Tile ' . $i), 'label' => $labels[$t] ?? strtoupper($t)];
}

awkward_respond(['size' => count($tiles), 'tiles' => $tiles]);
