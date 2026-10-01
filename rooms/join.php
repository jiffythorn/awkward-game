<?php
/**
 * POST /rooms/join.php  { code, name, avatar }
 * Adds a player to a lobby, or re-admits a known name to a running game.
 * Returns { code, playerId }.
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

$body = awkward_json_body();
$code = strtoupper(trim((string)($body['code'] ?? '')));
$name = trim((string)($body['name'] ?? ''));
if ($name === '' || mb_strlen($name) > 20) awkward_fail('name must be 1-20 characters');
$avatar = (string)($body['avatar'] ?? '🐸');
if (mb_strlen($avatar) > 16) $avatar = '🐸';
if (!preg_match('/^[A-Z0-9]{6}$/', $code)) awkward_fail('invalid room code');
if (!awkward_room_exists($code)) awkward_fail('room not found', 404);

$state = awkward_load_room($code);
if (!$state) awkward_fail('room not found', 404);
if (count($state['players']) >= 8) awkward_fail('room is full', 409);

// Rejoin: a known name in an in-game room resumes as that player.
if (($state['phase'] ?? '') !== 'lobby') {
    foreach ($state['players'] as $p) {
        if (!$p['isAI'] && strcasecmp($p['name'], $name) === 0) {
            awkward_respond(['code' => $code, 'playerId' => $p['id'], 'rejoined' => true]);
        }
    }
    awkward_fail('game already in progress', 409);
}

// Fresh lobby: fresh id, no name collisions.
foreach ($state['players'] as $p) {
    if (strcasecmp($p['name'], $name) === 0) awkward_fail('name already taken in this room', 409);
}
$ids = array_map(fn($p) => (int)substr($p['id'], 1), $state['players']);
$newId = 'p' . (max($ids) + 1);
$state['players'][] = awkward_make_player($newId, $name, $avatar, false, 'chill');
awkward_log($state, '👋 ' . $name . ' joined the room.');
// Bots greet the newcomer (template-only, instant).
foreach ($state['players'] as $bp) {
  if (!empty($bp['isAI'])) {
    awkward_bot_say($state, 'join', $bp, awkward_bot_ctx($state, ['me' => (string)$bp['name'], 'target' => $name]), false);
  }
}
awkward_bump($state);
awkward_save_room($code, $state);

awkward_respond(['code' => $code, 'playerId' => $newId]);
