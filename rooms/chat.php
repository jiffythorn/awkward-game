<?php
/**
 * POST /rooms/chat.php  { code, playerId, text }
 * Appends a chat message to the room (max 200 chars, rate-limited crudely).
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

$body = awkward_json_body();
$code = strtoupper(trim((string)($body['code'] ?? '')));
$playerId = (string)($body['playerId'] ?? '');
$text = trim((string)($body['text'] ?? ''));
if (!preg_match('/^[A-Z0-9]{6}$/', $code)) awkward_fail('invalid room code');
if ($text === '' || mb_strlen($text) > 200) awkward_fail('text must be 1-200 characters');

$state = awkward_load_room($code);
if (!$state) awkward_fail('room not found', 404);
$me = awkward_player($state, $playerId);
if (!$me) awkward_fail('unknown player', 403);

awkward_chat_append($state, $me['name'], $text);
awkward_bump($state);
awkward_save_room($code, $state);
awkward_respond(['ok' => true]);
