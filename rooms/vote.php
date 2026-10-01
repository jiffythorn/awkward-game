<?php
/**
 * POST /rooms/vote.php  { code, playerId, verdict: yes|no }
 * Submits a vote for the room's active vote. Thin wrapper over the same logic
 * as update.php's advance-vote action.
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

$body = awkward_json_body();
$code = strtoupper(trim((string)($body['code'] ?? '')));
$playerId = (string)($body['playerId'] ?? '');
$verdict = (string)($body['verdict'] ?? '');
if (!preg_match('/^[A-Z0-9]{6}$/', $code)) awkward_fail('invalid room code');
if (!awkward_room_exists($code)) awkward_fail('room not found', 404);
if ($verdict !== 'yes' && $verdict !== 'no') awkward_fail('verdict must be yes|no');

$state = awkward_load_room($code);
if (!$state) awkward_fail('room not found', 404);
if (($state['phase'] ?? '') !== 'await-vote' || empty($state['vote'])) awkward_fail('no vote in progress', 409);

$idx = awkward_player_index($state, $playerId);
if ($idx < 0) awkward_fail('unknown player', 403);
if ($idx === (int)$state['current']) awkward_fail('the judged player cannot vote', 403);

$state['vote']['verdicts'][$playerId] = $verdict;
if (awkward_vote_complete($state)) {
    awkward_maybe_finish_vote($state);
    awkward_drive_ai($state);
}
awkward_bump($state);
awkward_save_room($code, $state);
awkward_respond(['ok' => true, 'state' => awkward_public_state($state, $playerId)]);
