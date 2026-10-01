<?php
/**
 * POST /rooms/botline.php — one bot line for SINGLE-PLAYER banter.
 * Body: { event, personality, name, ctx? }
 * Runs the same failover chain as rooms (cloud -> custom -> local) with the
 * template pack as fallback, and returns { text, source }.
 * Rate limited per IP (30/hour) because it triggers real provider calls.
 * Works only when served by the PHP server; file:// users never reach it and
 * game.js silently uses the local template pack instead.
 */
declare(strict_types=1);
require_once __DIR__ . '/lib.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') awkward_fail('POST only');
$body = awkward_json_body();
$event = (string)($body['event'] ?? '');
$pers = (string)($body['personality'] ?? 'chill');
$name = trim((string)($body['name'] ?? 'Bot'));
$ctxIn = (array)($body['ctx'] ?? []);
if (!preg_match('/^[a-zA-Z]{3,20}$/', $event)) awkward_fail('bad event');
if (!in_array($pers, ['chill', 'chaotic', 'brutal', 'honest', 'liar'], true)) $pers = 'chill';
if ($name === '' || mb_strlen($name) > 20) $name = 'Bot';

// --- crude per-IP rate limit: 30 lines/hour, file-based ----------------------
$ip = (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
$stampFile = awkward_data_dir() . '/_rl_' . preg_replace('/[^0-9a-f:]/', '', strtolower($ip)) . '.json';
$now = time();
$stamps = [];
if (is_file($stampFile)) { $stamps = json_decode((string)file_get_contents($stampFile), true) ?: []; }
$stamps = array_values(array_filter((array)$stamps, fn($t) => $t > $now - 3600));
if (count($stamps) >= 30) awkward_fail('rate limited, try again later', 429);
$stamps[] = $now;
@file_put_contents($stampFile, json_encode($stamps), LOCK_EX);

// --- fake minimal state for the bot functions --------------------------------
$state = [
  'lap' => 1, 'laps' => 3, 'rngState' => random_int(1, 0x7fffffff),
  'players' => [
    ['name' => $name, 'isAI' => true, 'personality' => $pers, 'ap' => (int)($ctxIn['ap'] ?? 0), 'sp' => 0],
  ],
  'chat' => [],
];
foreach ($ctxIn as $k => $v) { if (!is_string($v)) unset($ctxIn[$k]); }
$ctxIn['me'] = $name;
$ctx = awkward_bot_ctx($state, $ctxIn);

[$text, $source] = awkward_bot_chain_once($state, $event, $state['players'][0], $ctx);
if ($text === null) {
  $text = awkward_bot_template($state, $event, $state['players'][0], $ctx);
  $source = $text !== null ? 'template' : null;
}
awkward_respond(['ok' => $text !== null, 'text' => $text, 'source' => $source]);
