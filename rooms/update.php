<?php
/**
 * POST /rooms/update.php  { code, playerId, type: roll|respond|start|advance-vote, ... }
 * The authoritative mutation endpoint. Validates that the acting player is the
 * current player (except lobby start / vote advancement), applies the action,
 * then drives all AI turns until a human must act.
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

$body = awkward_json_body();
$code = strtoupper(trim((string)($body['code'] ?? '')));
$playerId = (string)($body['playerId'] ?? '');
$type = (string)($body['type'] ?? '');
if (!preg_match('/^[A-Z0-9]{6}$/', $code)) awkward_fail('invalid room code');
if (!awkward_room_exists($code)) awkward_fail('room not found', 404);

$state = awkward_load_room($code);
if (!$state) awkward_fail('room not found', 404);
$me = awkward_player($state, $playerId);
if (!$me) awkward_fail('unknown player', 403);

/* ---------------- lobby start (any player) ---------------- */
if ($type === 'start') {
    if (($state['phase'] ?? '') !== 'lobby') awkward_fail('game already started', 409);
    if (count($state['players']) < 2) awkward_fail('need at least 2 players', 409);
    $state['laps'] = max(1, min(5, (int)($body['laps'] ?? 3)));
    awkward_build_decks($state);
    $state['phase'] = 'await-roll';
    awkward_log($state, '🎲 ' . $me['name'] . ' started the game (' . $state['laps'] . ' laps).');
    // Bots greet the table (template-only: instant).
    foreach ($state['players'] as $bp) {
      if (!empty($bp['isAI'])) awkward_bot_say($state, 'roundStart', $bp, awkward_bot_ctx($state), false);
    }
    awkward_bump($state);
    awkward_drive_ai($state);
    awkward_save_room($code, $state);
    awkward_respond(['ok' => true, 'state' => awkward_public_state($state, $playerId)]);
}

/* ---------------- all other actions require being the current player -------- */
$idx = awkward_require_current($state, $playerId);
$p = &$state['players'][$idx];

switch ($type) {
    case 'roll': {
        if (($state['phase'] ?? '') !== 'await-roll') awkward_fail('cannot roll now', 409);
        $die = awkward_rand($state, 6) + 1;
        $state['die'] = $die;
        awkward_log($state, '🎲 ' . $p['name'] . ' rolls a ' . $die . '.');
        $dest = (int)$p['pos'] + $die;
        $p['pos'] = $dest % BOARD_SIZE;
        if ($dest >= BOARD_SIZE) {
            $p['lapsDone']++;
            $p['ap'] += LAP_BONUS_AP;
            awkward_log($state, '🔁 ' . $p['name'] . ' completed a lap! +' . LAP_BONUS_AP . ' AP.');
        }
        $state['phase'] = 'resolving';
        awkward_bump($state);
        awkward_resolve_tile($state);
        // Vote-type tiles open a group vote straight away (no player response needed).
        if (($state['phase'] ?? '') === 'resolving' && empty($state['activeCard']) && !empty($state['pending'])) {
            awkward_resolve_next($state);
        }
        awkward_drive_ai($state);
        break;
    }

    case 'respond': {
        $resp = $body['response'] ?? null;
        if (!is_array($resp)) awkward_fail('missing response');
        // Optional spoken answer (what the player says/does) -> room chat, so
        // everyone hears the human's answer just like the bots' lines.
        $said = trim((string)($body['said'] ?? ''));
        if ($said !== '') {
            if (mb_strlen($said) > 200) $said = mb_substr($said, 0, 200);
            awkward_chat_append($state, $p['name'], $said);
        }
        if (!awkward_apply_response($state, $playerId, $resp)) awkward_fail('cannot respond now', 409);
        awkward_bump($state);
        awkward_drive_ai($state);
        break;
    }

    case 'advance-vote': {
        // Any non-active player may push the vote along; server validates tally.
        $verdict = (string)($body['verdict'] ?? '');
        if ($verdict !== 'yes' && $verdict !== 'no') awkward_fail('verdict must be yes|no');
        if (($state['phase'] ?? '') !== 'await-vote' || empty($state['vote'])) awkward_fail('no vote in progress', 409);
        if (awkward_vote_complete($state)) { awkward_maybe_finish_vote($state); break; }
        if ((int)$state['current'] === $idx) awkward_fail('the judged player cannot vote', 403);
        $state['vote']['verdicts'][$playerId] = $verdict;
        if (awkward_vote_complete($state)) awkward_maybe_finish_vote($state);
        awkward_bump($state);
        awkward_drive_ai($state);
        break;
    }

    default:
        awkward_fail('unknown action type', 400);
}

awkward_save_room($code, $state);
awkward_respond(['ok' => true, 'state' => awkward_public_state($state, $playerId)]);
