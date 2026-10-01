<?php
/**
 * GET /rooms/cards.php[?type=scenario]
 * Lists public card metadata (id, type, title, tags). Deltas and effects are
 * withheld so clients can't compute outcomes ahead of the server.
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

$typeFilter = (string)($_GET['type'] ?? '');
$allowed = ['scenario', 'choice', 'risk', 'sabotage', 'vote'];
if ($typeFilter !== '' && !in_array($typeFilter, $allowed, true)) awkward_fail('unknown deck type');

$out = [];
foreach (awkward_cards() as $c) {
    if ($typeFilter !== '' && $c['type'] !== $typeFilter) continue;
    $out[] = [
        'id' => $c['id'],
        'type' => $c['type'],
        'title' => $c['title'],
        'tags' => $c['tags'] ?? [],
    ];
}
awkward_respond(['count' => count($out), 'cards' => $out]);
