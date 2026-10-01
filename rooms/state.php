<?php
/**
 * GET /rooms/state.php?code=XXXXXX
 * Returns { state, chat } for polling clients. The deck ORDER is withheld —
 * clients receive only remaining/discard counts.
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

$code = strtoupper(trim((string)($_GET['code'] ?? '')));
if (!preg_match('/^[A-Z0-9]{6}$/', $code)) awkward_fail('invalid room code');
if (!awkward_room_exists($code)) awkward_fail('room not found', 404);

$state = awkward_load_room($code);
if (!$state) awkward_fail('room not found', 404);

// The AI clock runs on ANY poll: whoever requests state first after a bot's
// due time advances the room one visible step (think -> answer -> next).
if (awkward_ai_tick($state)) {
    awkward_bump($state);
    awkward_save_room($code, $state);
}

awkward_respond([
    'state' => awkward_public_state($state, null),
    'chat' => array_slice($state['chat'] ?? [], -30),
]);
