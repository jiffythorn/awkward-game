<?php
/**
 * The Awkward Game — shared backend library
 * ==========================================
 * Room state lives in rooms/data/<CODE>.json. All endpoints validate the acting
 * player against the room's turn/phase; deck order never leaves the server.
 *
 * Turn semantics mirror game.js:
 *   await-roll -> moving -> resolving [cards] -> await-vote? -> next await-roll
 */

declare(strict_types=1);
require_once __DIR__ . '/botlib.php';

const BOARD_SIZE = 54;
const LAP_BONUS_AP = 2;
const SCENARIO_REFUSE_SP = 1;
const CHOICE_REFUSE_SP = 3;
const RISK_CHICKEN_SP = 1;
const SABOTAGE_SKIP_AP = 1;
const FINAL_COMBO_BONUS_AP = 10;

/** Board tile types by index (mirrors data/board.js). */
function awkward_board_types(): array {
  static $types = null;
  if ($types === null) {
    $raw = [
      'safe','scenario','choice','risk','safe','scenario','choice','sabotage',
      'risk','scenario','vote','safe','choice','scenario','risk','chaos',
      'scenario','sabotage','choice','safe','vote','scenario','risk','scenario',
      'double','choice','sabotage','safe','scenario','risk','chaos','vote',
      'choice','scenario','safe','sabotage','risk','scenario','choice','vote',
      'chaos','scenario','sabotage','choice','risk','safe','scenario','vote',
      'double','choice','scenario','sabotage','risk','final',
    ];
    $types = $raw;
  }
  return $types;
}

/** Card definitions the server needs to apply effects (subset: effects only). */
function awkward_cards(): array {
  static $cards = null;
  if ($cards !== null) return $cards;
  $cards = [];
  // Cards are loaded from the shared JSON export generated from data/cards.js.
  $file = __DIR__ . '/../data/cards.json';
  if (is_readable($file)) {
    $all = json_decode((string)file_get_contents($file), true);
    if (is_array($all)) {
      foreach ($all as $c) {
        $cards[(string)($c['id'] ?? '')] = $c;
      }
    }
  }
  return $cards;
}

/* ============================ storage ============================ */

/** Writable state dir (room JSON files live here as <CODE>.json).
 *  Override with AWKWARD_DATA_DIR when the app bundle itself is read-only,
 *  e.g. when running from a mounted AppImage — state then goes to ~/.local/share. */
function awkward_data_dir(): string {
  $env = getenv('AWKWARD_DATA_DIR');
  $dir = (is_string($env) && $env !== '') ? $env : __DIR__ . '/data';
  if (!is_dir($dir)) @mkdir($dir, 0775, true);
  return $dir;
}

/** Path of the auto-managed AI/admin config file (rooms/config.php, or inside AWKWARD_DATA_DIR). */
function awkward_config_path(): string {
  $env = getenv('AWKWARD_DATA_DIR');
  if (is_string($env) && $env !== '') return $env . '/config.php';
  return __DIR__ . '/config.php';
}

function awkward_room_path(string $code): string {
  return awkward_data_dir() . '/' . preg_replace('/[^A-Z0-9]/', '', $code) . '.json';
}

function awkward_room_exists(string $code): bool {
  return is_file(awkward_room_path($code));
}

function awkward_load_room(string $code): ?array {
  $path = awkward_room_path($code);
  if (!is_file($path)) return null;
  $fp = fopen($path, 'r');
  if (!$fp) return null;
  flock($fp, LOCK_SH);
  $raw = stream_get_contents($fp);
  flock($fp, LOCK_UN);
  fclose($fp);
  $state = json_decode((string)$raw, true);
  return is_array($state) ? $state : null;
}

function awkward_save_room(string $code, array $state): bool {
  $path = awkward_room_path($code);
  $fp = fopen($path, 'c+');
  if (!$fp) return false;
  $ok = false;
  if (flock($fp, LOCK_EX)) {
    ftruncate($fp, 0);
    rewind($fp);
    $ok = fwrite($fp, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)) !== false;
    fflush($fp);
    flock($fp, LOCK_UN);
  }
  fclose($fp);
  return $ok;
}

function awkward_new_code(): string {
  $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for ($attempt = 0; $attempt < 50; $attempt++) {
    $code = '';
    for ($i = 0; $i < 6; $i++) {
      $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    }
    if (!awkward_room_exists($code)) return $code;
  }
  throw new RuntimeException('could not allocate room code');
}

/* ============================ request helpers ============================ */

function awkward_json_body(): array {
  $raw = file_get_contents('php://input');
  $data = json_decode((string)$raw, true);
  return is_array($data) ? $data : [];
}

function awkward_respond(array $payload, int $status = 200): never {
  http_response_code($status);
  header('Content-Type: application/json');
  echo json_encode($payload, JSON_UNESCAPED_UNICODE);
  exit;
}

function awkward_fail(string $msg, int $status = 400): never {
  awkward_respond(['error' => $msg], $status);
}

function awkward_player(array $state, string $playerId): ?array {
  foreach ($state['players'] as $p) {
    if (($p['id'] ?? null) === $playerId) return $p;
  }
  return null;
}

function awkward_player_index(array $state, string $playerId): int {
  foreach ($state['players'] as $i => $p) {
    if (($p['id'] ?? null) === $playerId) return (int)$i;
  }
  return -1;
}

/** Require that the acting player exists and it is their turn. */
function awkward_require_current(array $state, string $playerId): int {
  $idx = awkward_player_index($state, $playerId);
  if ($idx < 0) awkward_fail('unknown player', 403);
  if ($idx !== (int)($state['current'] ?? -1)) awkward_fail('not your turn', 403);
  return $idx;
}

/** Advance the room's seq so clients know state changed. */
function awkward_bump(array &$state): void {
  $state['seq'] = (int)($state['seq'] ?? 0) + 1;
}

/* ============================ game construction ============================ */

function awkward_log(array &$state, string $msg, string $cls = ''): void {
  $state['log'][] = ['t' => round(microtime(true) * 1000), 'msg' => $msg, 'cls' => $cls];
  if (count($state['log']) > 200) {
    $state['log'] = array_slice($state['log'], -200);
  }
}

function awkward_build_decks(array &$state): void {
  $byType = [];
  foreach (awkward_cards() as $c) {
    $byType[(string)$c['type']][] = (string)$c['id'];
  }
  $state['decks'] = [];
  foreach (['scenario', 'choice', 'risk', 'sabotage', 'vote'] as $t) {
    $order = $byType[$t] ?? [];
    awkward_shuffle($order, $state);
    $state['decks'][$t] = ['order' => $order, 'discard' => []];
  }
}

/** Deterministic shuffle using the room's RNG (mt_rand seeded per room). */
function awkward_shuffle(array &$arr, array &$state): void {
  for ($i = count($arr) - 1; $i > 0; $i--) {
    $j = awkward_rand($state, $i + 1);
    [$arr[$i], $arr[$j]] = [$arr[$j], $arr[$i]];
  }
}

function awkward_rand(array &$state, int $n): int {
  // Simple LCG over the room seed, so replays from the seed match.
  $state['rngState'] = ((int)$state['rngState'] * 1103515245 + 12345) & 0x7fffffff;
  return $state['rngState'] % $n;
}

function awkward_make_player(string $id, string $name, string $avatar, bool $isAI, string $personality): array {
  return [
    'id' => $id, 'name' => $name, 'avatar' => $avatar, 'isAI' => $isAI,
    'personality' => $personality,
    'pos' => 0, 'ap' => 0, 'sp' => 0, 'tokens' => 2, 'lapsDone' => 0,
    'stats' => [
      'bluffsBelieved' => 0, 'bluffsCaught' => 0, 'confessions' => 0,
      'timesSabotaged' => 0, 'chaosTriggered' => 0, 'risksTaken' => 0, 'risksWon' => 0,
    ],
  ];
}

/* ============================ tile resolution ============================ */

function awkward_tile_type(array $state, int $pos): string {
  $types = awkward_board_types();
  return $types[$pos % BOARD_SIZE] ?? 'safe';
}

function awkward_cards_for_tile(string $type): array {
  switch ($type) {
    case 'scenario': return ['scenario'];
    case 'choice':   return ['choice'];
    case 'risk':     return ['risk'];
    case 'sabotage': return ['sabotage'];
    case 'vote':     return ['vote'];
    case 'double':   return ['scenario', 'choice'];
    case 'final':    return ['scenario', 'choice', 'risk'];
    default:         return [];
  }
}

function awkward_draw_card(array &$state, string $type): ?array {
  if (!isset($state['decks'][$type])) return null;
  $d = &$state['decks'][$type];
  if (count($d['order']) === 0) {
    $d['order'] = $d['discard'];
    $d['discard'] = [];
    awkward_shuffle($d['order'], $state);
  }
  if (count($d['order']) === 0) return null;
  $id = array_shift($d['order']);
  $d['discard'][] = $id;
  $cards = awkward_cards();
  return $cards[$id] ?? null;
}

function awkward_apply_deltas(array &$state, int $idx, int $ap, int $sp, string $why = ''): void {
  if ($idx < 0 || $idx >= count($state['players'])) return;
  $p = &$state['players'][$idx];
  $p['ap'] += $ap;
  $p['sp'] += $sp;
  $bits = [];
  if ($ap) $bits[] = ($ap > 0 ? '+' : '') . $ap . ' AP';
  if ($sp) $bits[] = ($sp > 0 ? '+' : '') . $sp . ' SP';
  if ($bits) {
    awkward_log($state, $p['avatar'] . ' ' . $p['name'] . ': ' . implode(', ', $bits) . ' ' . $why,
                ($ap < 0 || $sp > 0) ? 'bad' : 'good');
  }
}

/** Deal cards for the tile the current player landed on. */
function awkward_resolve_tile(array &$state): void {
  $p = &$state['players'][$state['current']];
  $type = awkward_tile_type($state, (int)$p['pos']);

  if ($type === 'chaos') {
    $p['tokens']++;
    $p['stats']['chaosTriggered']++;
    $types = ['scenario', 'choice', 'risk', 'sabotage', 'vote'];
    $deck = $types[awkward_rand($state, 5)];
    awkward_log($state, '🌀 ' . $p['name'] . " hit the Chaos tile! A wild {$deck} card appears…");
    if (!empty($p['isAI'])) awkward_bot_say($state, 'chaos', $p, awkward_bot_ctx($state), false);
    $card = awkward_draw_card($state, $deck);
    $state['pending'] = $card ? [$card['id']] : [];
    $state['phase'] = 'resolving';
    return;
  }

  if ($type === 'safe') {
    awkward_log($state, '🛋️ ' . $p['name'] . ' rests. Nothing happens. Bliss.');
    if (!empty($p['isAI'])) awkward_bot_say($state, 'safe', $p, awkward_bot_ctx($state), false);
    awkward_end_turn($state);
    return;
  }

  if ($type === 'double') {
    $p['tokens']++;
    awkward_log($state, '🎟️ ' . $p['name'] . ' gains +1 Sabotage Token (Double Trouble).');
    if (!empty($p['isAI'])) awkward_bot_say($state, 'double', $p, awkward_bot_ctx($state), false);
  }

  $types = awkward_cards_for_tile($type);
  $pending = [];
  foreach ($types as $t) {
    $card = awkward_draw_card($state, $t);
    if ($card) $pending[] = $card['id'];
  }
  $state['pending'] = $pending;
  $state['activeCard'] = null;
  $state['comboEligible'] = ($type === 'final');
  $state['phase'] = 'resolving';
  if (count($pending) === 0) {
    awkward_end_turn($state);
  }
}

/** Pop the next pending card into activeCard. */
function awkward_resolve_next(array &$state): void {
  if (($state['phase'] ?? '') === 'game-over') return;
  $id = array_shift($state['pending']);
  if (!$id) {
    awkward_finish_tile($state);
    return;
  }
  $state['activeCard'] = $id;
  $state['phase'] = 'resolving';
}

function awkward_finish_tile(array &$state, bool $completed = true): void {
  $p = &$state['players'][$state['current']];
  if ($completed && !empty($state['comboEligible'])) {
    $p['ap'] += FINAL_COMBO_BONUS_AP;
    awkward_log($state, '🏆 ' . $p['name'] . " survived the FINAL COMBO! +" . FINAL_COMBO_BONUS_AP . ' AP.');
  }
  $state['activeCard'] = null;
  $state['comboEligible'] = false;
  awkward_end_turn($state);
}

function awkward_end_turn(array &$state): void {
  $state['turnCount'] = (int)($state['turnCount'] ?? 0) + 1;
  $done = true;
  foreach ($state['players'] as $p) {
    if ($p['lapsDone'] < $state['laps']) { $done = false; break; }
    if ((int)$state['laps'] === 0) { $done = false; break; } // endless
  }
  if ($done && (int)$state['laps'] !== 0) {
    $state['phase'] = 'game-over';
    awkward_log($state, '🎬 The game is over.');
    $winner = $state['players'][0];
    foreach ($state['players'] as $q) { if ($q['ap'] > $winner['ap']) $winner = $q; }
    if (!empty($winner['isAI'])) {
      // Template-only: the ending request is usually a human's, keep it snappy.
      awkward_bot_say($state, 'win', $winner, awkward_bot_ctx($state, ['ap' => (string)$winner['ap']]), false);
    }
    return;
  }
  $state['current'] = ((int)$state['current'] + 1) % count($state['players']);
  $state['phase'] = 'await-roll';
  $state['die'] = null;
}

/* ============================ votes ============================ */

/** Start a vote: fills AI verdicts immediately, humans submit via vote.php. */
function awkward_start_vote(array &$state, string $context, ?string $cardId, string $mode, array $labels): void {
  $state['vote'] = [
    'context' => $context, 'cardId' => $cardId, 'mode' => $mode,
    'labels' => $labels, 'verdicts' => [], 'startedAt' => time(),
  ];
  $state['phase'] = 'await-vote';
  $hasHumanVoter = false;
  foreach ($state['players'] as $i => $v) {
    if ($i === (int)$state['current']) continue;
    if (!empty($v['isAI'])) {
      $state['vote']['verdicts'][$v['id']] = awkward_ai_vote($state, (int)$i, $context);
    } else {
      $hasHumanVoter = true;
    }
  }
  // All-AI voters (e.g. solo player being judged): nobody would ever call
  // vote.php and the room would hang — let the AI tick tally it on a timer.
  if (!$hasHumanVoter) awkward_ai_pace($state);
}

function awkward_vote_complete(array $state): bool {
  if (empty($state['vote'])) return true;
  foreach ($state['players'] as $i => $v) {
    if ($i === (int)$state['current']) continue;
    $verdict = $state['vote']['verdicts'][$v['id']] ?? null;
    if ($verdict !== 'yes' && $verdict !== 'no') return false;
    }
  return true;
}

/** Tally and finish the vote if everyone has voted; applies card/bluff effects. */
function awkward_maybe_finish_vote(array &$state): void {
  if (empty($state['vote']) || !awkward_vote_complete($state)) return;
  $vote = $state['vote'];
  $yes = 0; $no = 0;
  $votes = [];
  $judged = $state['players'][(int)$state['current']];
  foreach ($state['players'] as $i => $v) {
    if ($i === (int)$state['current']) continue;
    $verdict = $vote['verdicts'][$v['id']] ?? 'abstain';
    $votes[] = ['name' => $v['name'], 'avatar' => $v['avatar'], 'verdict' => $verdict];
    // Bots announce their verdict as it lands (template-only: humans are waiting).
    if (!empty($v['isAI']) && ($verdict === 'yes' || $verdict === 'no')) {
      awkward_bot_say($state, $verdict === 'yes' ? 'voteYes' : 'voteNo', $v,
                      awkward_bot_ctx($state, ['target' => (string)$judged['name']]), false);
    }
    if ($verdict === 'yes') $yes++;
    if ($verdict === 'no') $no++;
  }
  $succeeded = ($vote['mode'] === 'unanimous') ? ($no === 0 && $yes > 0) : ($yes >= $no);
  $state['vote'] = null;
  $state['phase'] = 'resolving';

  $card = $vote['cardId'] ? (awkward_cards()[$vote['cardId']] ?? null) : null;
  if ($vote['context'] === 'bluff') {
    if (!$card) { awkward_resolve_next($state); return; } // no card context: nothing to apply
    $p = &$state['players'][$state['current']];
    if ($succeeded) {
      $p['stats']['bluffsBelieved']++;
      awkward_apply_deltas($state, (int)$state['current'], $card['ap'] + 1, $card['sp'], "(bluff believed {$yes}-{$no})");
    } else {
      $p['stats']['bluffsCaught']++;
      awkward_apply_deltas($state, (int)$state['current'], -$card['ap'], $card['ap'], "(CAUGHT lying {$yes}-{$no})");
    }
    if (!empty($p['isAI'])) {
      awkward_bot_say($state, $succeeded ? 'bluffBelieved' : 'bluffCaught', $p,
                      awkward_bot_ctx($state, ['tally' => $yes . '-' . $no]), false);
    }
    awkward_resolve_next($state);
  } elseif ($vote['context'] === 'card') {
    if (!$card) { awkward_resolve_next($state); return; }
    if ($succeeded) {
      awkward_apply_deltas($state, (int)$state['current'], (int)$card['forgive']['ap'], (int)$card['forgive']['sp'], "(forgiven {$yes}-{$no})");
    } else {
      awkward_apply_deltas($state, (int)$state['current'], (int)$card['punish']['ap'], (int)$card['punish']['sp'], "(punished {$yes}-{$no})");
    }
    awkward_resolve_next($state);
  } elseif ($vote['context'] === 'believe') {
    // Risk decided by the group.
    awkward_resolve_risk($state, $succeeded);
  }
  awkward_bump($state);
}

/* ============================ card responses ============================ */

function awkward_resolve_risk(array &$state, bool $success): void {
  $card = awkward_cards()[$state['activeCard']] ?? null;
  if (!$card) { awkward_resolve_next($state); return; }
  $p = &$state['players'][$state['current']];
  $allowChain = !empty($p['isAI']);
  if ($success) {
    $p['stats']['risksWon']++;
    awkward_apply_deltas($state, (int)$state['current'], (int)$card['reward']['ap'], (int)$card['reward']['sp'], '(risk paid off!)');
  } else {
    awkward_apply_deltas($state, (int)$state['current'], (int)$card['penalty']['ap'], (int)$card['penalty']['sp'], '(risk failed…)');
  }
  awkward_bot_say($state, $success ? 'riskWin' : 'riskLose', $p,
                  awkward_bot_ctx($state, ['card' => (string)$card['title']]), $allowChain);
  awkward_resolve_next($state);
}

/** Apply a validated response to the room's active card. */
function awkward_apply_response(array &$state, string $playerId, array $resp): bool {
  if (($state['phase'] ?? '') !== 'resolving' || empty($state['activeCard'])) return false;
  $idx = awkward_require_current($state, $playerId);
  $card = awkward_cards()[$state['activeCard']] ?? null;
  if (!$card) { awkward_resolve_next($state); return true; }
  $kind = (string)($resp['kind'] ?? '');
  $p = &$state['players'][$idx];
  // Chain (LLM) only when a bot is acting; template-only when a human is the
  // actor so their HTTP request never waits on an AI provider.
  $allowChain = !empty($p['isAI']);
  $bctx = fn(array $extra = []) => awkward_bot_ctx($state, $extra);
  // Bots: keep the answer visible on the card for a beat before advancing.
  // (aiHold marks the tick to resolve_next after the reveal window instead.)
  $defer = function () use (&$state, $p): void {
    if (!empty($p['isAI'])) $state['aiHold'] = true;
  };

  switch ($kind) {
    case 'do':
      $p['stats']['confessions']++;
      awkward_apply_deltas($state, $idx, (int)$card['ap'], (int)$card['sp'], '(did it)');
      if ($allowChain) awkward_bot_say($state, 'scenarioDo', $p, $bctx(['card' => (string)$card['title']]), $allowChain);
      $defer();
      if (!$state['aiHold']) awkward_resolve_next($state);
      break;

    case 'bluff':
      if ($allowChain) awkward_bot_say($state, 'scenarioBluff', $p, $bctx(['card' => (string)$card['title']]), $allowChain);
      awkward_start_vote($state, 'bluff', $card['id'], 'majority', ['Believe', 'Caught']);
      break;

    case 'refuse':
      $cost = ($card['type'] === 'choice') ? CHOICE_REFUSE_SP : SCENARIO_REFUSE_SP;
      awkward_apply_deltas($state, $idx, 0, $cost, '(refused)');
      if ($allowChain) awkward_bot_say($state, 'refuse', $p, $bctx(['card' => (string)$card['title']]), $allowChain);
      $defer();
      if (!$state['aiHold']) awkward_resolve_next($state);
      break;

    case 'choice': {
      $side = ($resp['side'] ?? '') === 'b' ? 'b' : 'a';
      $opt = $card[$side];
      awkward_apply_deltas($state, $idx, (int)$opt['ap'], (int)$opt['sp'], '(' . strtoupper($side) . ')');
      if ($allowChain) awkward_bot_say($state, 'choice', $p, $bctx(['opt' => mb_substr((string)$opt['text'], 0, 40)]), $allowChain);
      $defer();
      if (!$state['aiHold']) awkward_resolve_next($state);
      break;
    }
    case 'risk-chicken':
      awkward_apply_deltas($state, $idx, 0, RISK_CHICKEN_SP, '(chickened out)');
      if ($allowChain) awkward_bot_say($state, 'riskChickened', $p, $bctx(['card' => (string)$card['title']]), $allowChain);
      $defer();
      if (!$state['aiHold']) awkward_resolve_next($state);
      break;

    case 'risk-take':
      $p['stats']['risksTaken']++;
      if ($allowChain) awkward_bot_say($state, 'riskTake', $p, $bctx(['card' => (string)$card['title']]), $allowChain);
      $mech = (string)($card['mech'] ?? 'coin');
      if ($mech === 'coin') {
        awkward_resolve_risk($state, awkward_rand($state, 2) === 1);
      } elseif ($mech === 'die') {
        awkward_resolve_risk($state, awkward_rand($state, 6) >= 3); // needs 4+ (0..5 → 3,4,5)
      } else { // believe
        awkward_start_vote($state, 'believe', $card['id'], 'majority', ['Believe', 'Doubt']);
      }
      break;

    case 'sabotage': {
      $tIdx = (int)($resp['target'] ?? -1);
      if ($tIdx < 0 || $tIdx >= count($state['players']) || $tIdx === $idx || (int)$p['tokens'] <= 0) {
        awkward_apply_deltas($state, $idx, SABOTAGE_SKIP_AP, 0, '(skipped sabotage)');
        awkward_resolve_next($state);
        break;
      }
      $p['tokens']--;
      $t = &$state['players'][$tIdx];
      $t['stats']['timesSabotaged']++;
      awkward_log($state, '🗡️ ' . $p['name'] . ' sabotages ' . $t['name'] . ' with "' . $card['title'] . '"!');
      if ($allowChain) awkward_bot_say($state, 'sabotageUsed', $p, $bctx(['target' => (string)$t['name'], 'card' => (string)$card['title']]), $allowChain);
      if (!empty($t['isAI'])) awkward_bot_say($state, 'sabotageVictim', $t, $bctx(['target' => (string)$t['name']]), false);
      if (!empty($card['stealToken']) && (int)$t['tokens'] > 0) {
        $t['tokens']--; $p['tokens']++;
      }
      awkward_apply_deltas($state, $tIdx, (int)$card['tAp'], (int)$card['tSp'], '(sabotaged by ' . $p['name'] . ')');
      awkward_apply_deltas($state, $idx, (int)$card['uAp'], (int)$card['uSp'], '');
      $defer();
      if (!$state['aiHold']) awkward_resolve_next($state);
      break;
    }
    case 'sabotage-skip':
      awkward_apply_deltas($state, $idx, SABOTAGE_SKIP_AP, 0, '(skipped sabotage)');
      $defer();
      if (!$state['aiHold']) awkward_resolve_next($state);
      break;

    case 'none':
    default:
      if (($card['type'] ?? '') === 'vote') {
        $mode = ($card['mode'] ?? 'majority') === 'unanimous' ? 'unanimous' : 'majority';
        awkward_start_vote($state, 'card', $card['id'], $mode, ['Forgive', 'Punish']);
      } else {
        awkward_resolve_next($state);
      }
      break;
  }
  return true;
}

/* ============================ AI (server-side, rooms only) ============================ */

function awkward_ai_vote(array $state, int $voterIdx, string $context): string {
  $profiles = [
    'chill'   => ['punish' => 0.20, 'chaos' => 0.05],
    'chaotic' => ['punish' => 0.50, 'chaos' => 0.25],
    'brutal'  => ['punish' => 0.75, 'chaos' => 0.10],
    'honest'  => ['punish' => 0.30, 'chaos' => 0.05],
    'liar'    => ['punish' => 0.60, 'chaos' => 0.15],
  ];
  $voter = $state['players'][$voterIdx];
  $prof = $profiles[$voter['personality']] ?? $profiles['chill'];
  $target = $state['players'][$state['current']];
  $pYes = 1 - $prof['punish'];
  // hunt the leader
  $best = 0;
  foreach ($state['players'] as $i => $p) {
    if ($p['ap'] > $state['players'][$best]['ap']) $best = $i;
  }
  if ($best === (int)$state['current']) $pYes -= 0.2;
  if ((int)$target['sp'] >= 7) $pYes += 0.15;
  if ($context === 'bluff' && $voter['personality'] === 'liar') $pYes += 0.15;
  if (awkward_rand($state, 100) < $prof['chaos'] * 100) {
    return awkward_rand($state, 2) === 1 ? 'yes' : 'no';
  }
  $clamped = max(0.05, min(0.95, $pYes));
  return (awkward_rand($state, 100) < $clamped * 100) ? 'yes' : 'no';
}

/** Decide the current AI's response WITHOUT applying it. Returns
 *  ['resp' => response-array, 'label' => human-readable answer]. Consumes RNG
 *  at the same point the old responder did, so seeded games stay reproducible. */
function awkward_ai_decide(array &$state): array {
  $idx = (int)$state['current'];
  $p = $state['players'][$idx];
  $profiles = [
    'chill'   => ['bluff' => 0.10, 'risk' => 0.30, 'sabotage' => 0.20, 'chaos' => 0.05],
    'chaotic' => ['bluff' => 0.50, 'risk' => 0.70, 'sabotage' => 0.60, 'chaos' => 0.25],
    'brutal'  => ['bluff' => 0.20, 'risk' => 0.60, 'sabotage' => 0.85, 'chaos' => 0.10],
    'honest'  => ['bluff' => 0.00, 'risk' => 0.20, 'sabotage' => 0.10, 'chaos' => 0.05],
    'liar'    => ['bluff' => 0.80, 'risk' => 0.50, 'sabotage' => 0.40, 'chaos' => 0.15],
  ];
  $prof = $profiles[$p['personality']] ?? $profiles['chill'];
  $card = awkward_cards()[$state['activeCard']] ?? null;
  if (!$card) return ['resp' => null, 'label' => ''];
  $chaos = awkward_rand($state, 100) < $prof['chaos'] * 100;

  switch ($card['type']) {
    case 'scenario':
      $bluff = $chaos ? true : (awkward_rand($state, 100) < $prof['bluff'] * 100);
      return $bluff
        ? ['resp' => ['kind' => 'bluff'], 'label' => 'BLUFFS: "I totally did it."']
        : ['resp' => ['kind' => 'do'], 'label' => 'does it. In public. Bravely.'];
    case 'choice':
      $side = awkward_rand($state, 2) === 1 ? 'a' : 'b';
      $opt = $card[$side];
      return ['resp' => ['kind' => 'choice', 'side' => $side],
              'label' => 'picks ' . strtoupper($side) . ': "' . mb_substr((string)$opt['text'], 0, 46) . '…"'];
    case 'risk':
      $take = $chaos ? true : (awkward_rand($state, 100) < $prof['risk'] * 100);
      return $take
        ? ['resp' => ['kind' => 'risk-take'], 'label' => 'TAKES the risk. Legendary.']
        : ['resp' => ['kind' => 'risk-chicken'], 'label' => 'chickens out. Wisely?'];
    case 'sabotage':
      if ((int)$p['tokens'] > 0 && ($chaos || awkward_rand($state, 100) < $prof['sabotage'] * 100)) {
        // target the leader (or random under chaos)
        $best = -1; $bestAp = -1;
        foreach ($state['players'] as $i => $q) {
          if ($i === $idx) continue;
          if ($q['ap'] > $bestAp) { $bestAp = $q['ap']; $best = $i; }
        }
        $tname = $best >= 0 ? (string)$state['players'][$best]['name'] : '?';
        return ['resp' => ['kind' => 'sabotage', 'target' => $best],
                'label' => 'sabotages ' . $tname . ' with "' . $card['title'] . '"!'];
      }
      return ['resp' => ['kind' => 'sabotage-skip'], 'label' => 'hoards the sabotage token.'];
    default:
      return ['resp' => ['kind' => 'none'], 'label' => 'hands it to the group…'];
  }
}

/** How long a bot "thinks" before answering, and how long its answer stays up.
 *  Priority: env AWKWARD_AI_STEP (tests) > config 'aiStep' (admin area) > 2.5s.
 *  0 = instant (old burst mode). */
function awkward_ai_step(): float {
  $s = getenv('AWKWARD_AI_STEP');
  if ($s !== false && $s !== '') return max(0.0, (float)$s);
  $cfg = awkward_bot_config();
  if (isset($cfg['aiStep'])) return max(0.0, (float)$cfg['aiStep']);
  return 2.5;
}

/** Schedule the current AI's next action. $cardId + $answerLabel mark that a
 *  two-phase reveal is pending (think -> announce answer -> advance);
 *  without a label the next due action simply advances the flow. */
function awkward_ai_pace(array &$state, ?string $cardId = null, ?string $answerLabel = null): void {
  $state['aiActAt'] = round(microtime(true) + awkward_ai_step(), 3);
  if ($cardId !== null && $answerLabel !== null) {
    $state['aiAnswerCard'] = $cardId;
    $state['aiAnswer'] = $answerLabel;
  }
}

/** One bot action per due time, so humans watch every move. Returns true if
 *  the room state changed. Call from ANY request (state polls included):
 *    think window -> announce answer (reveal) -> advance one step -> stop.
 *  Clients see the card, the pause, the answer, then the next move — exactly
 *  like a human player's turn, just on a timer. */
function awkward_ai_tick(array &$state): bool {
  $now = microtime(true);
  $phase = (string)($state['phase'] ?? '');
  $curAI = !empty($state['players'][$state['current']]['isAI']);

  // A vote exists: pre-filled AI verdicts "decide" on a timer, humans block it.
  if ($phase === 'await-vote' && !empty($state['vote'])) {
    if (!awkward_vote_complete($state)) return false;            // humans still owe votes
    if (isset($state['aiActAt'])) {
      if ($now < (float)$state['aiActAt']) return false;         // AIs still deciding
      unset($state['aiActAt']);                                   // announce + tally now
      if (isset($state['reveal'])) unset($state['reveal']);
      awkward_maybe_finish_vote($state);
      return true;
    }
    awkward_ai_pace($state);                                      // start the deciding window
    return true;
  }

  if ($curAI === false) return false;   // human turn / lobby / over

  // Bot's turn to roll: schedule it, then move + deal when due.
  if ($phase === 'await-roll') {
    if (!isset($state['aiActAt'])) { awkward_ai_pace($state); return true; }
    if ($now < (float)$state['aiActAt']) return false;
    unset($state['aiActAt']);
    $state['die'] = awkward_rand($state, 6) + 1;
    $p = &$state['players'][(int)$state['current']];
    $dest = (int)$p['pos'] + (int)$state['die'];
    $p['pos'] = $dest % BOARD_SIZE;
    if ($dest >= BOARD_SIZE) {
      $p['lapsDone']++;
      $p['ap'] += LAP_BONUS_AP;
      awkward_log($state, '🔁 ' . $p['name'] . ' completed a lap! +' . LAP_BONUS_AP . ' AP.');
      if (!empty($p['isAI'])) awkward_bot_say($state, 'lap', $p, awkward_bot_ctx($state), false);
    }
    awkward_log($state, '🎲 ' . $p['name'] . ' rolls a ' . $state['die'] . '.');
    $state['phase'] = 'resolving';
    awkward_bump($state);
    awkward_resolve_tile($state);
    return true;
  }

  if ($phase !== 'resolving') return false;

  if (empty($state['activeCard'])) {
    if (!empty($state['pending'])) { awkward_resolve_next($state); return true; }
    return false;
  }

  // Phase 2: an answer is queued — announce it when due.
  if (isset($state['aiAnswer'])) {
    if ($now < (float)$state['aiActAt']) return false;
    $state['reveal'] = ['card' => (string)$state['aiAnswerCard'], 'label' => (string)$state['aiAnswer']];
    unset($state['aiAnswer'], $state['aiAnswerCard']);
    $state['aiActAt'] = round(microtime(true) + awkward_ai_step(), 3);
    return true;
  }

  // Phase 3: the answer banner has been visible for a beat — advance one step.
  if (isset($state['aiActAt'])) {
    if ($now < (float)$state['aiActAt']) return false;
    unset($state['aiActAt']);
    if (isset($state['reveal'])) unset($state['reveal']);
    if (!empty($state['aiHold'])) {
      unset($state['aiHold']);
      awkward_resolve_next($state);
      return true;
    }
    if (!empty($state['pending'])) { awkward_resolve_next($state); return true; }
    return false;
  }

  // Phase 1: the bot studies its card and decides. The decision is APPLIED
  // now (scores/effects land once); aiHold defers the advance so every human
  // sees the answer + consequences on the card for a full beat first.
  $dec = awkward_ai_decide($state);
  if ($dec['resp'] === null) { awkward_resolve_next($state); return true; }
  unset($state['aiHold']);
  awkward_apply_response($state, (string)$state['players'][(int)$state['current']]['id'], $dec['resp']);
  // The response is on the table (and aiHold set): schedule the reveal beat,
  // after which Phase 3 advances. Vote-type responses (bluff/card vote) pace
  // themselves via awkward_start_vote instead.
  if (!empty($state['aiHold']) && ($state['phase'] ?? '') === 'resolving') {
    awkward_ai_pace($state);
  }
  return true;
}

/** Compatibility shim: older call sites drive at most one bot action. */
function awkward_drive_ai(array &$state): void {
  awkward_ai_tick($state);
}

/* ============================ misc ============================ */

function awkward_public_state(array $state, ?string $forPlayerId): array {
  // The deck order never leaves the server; clients get counts only.
  $public = $state;
  $public['decks'] = [];
  $public['aiStep'] = awkward_ai_step();   // clients pace animations to match
  foreach ($state['decks'] ?? [] as $type => $d) {
    $public['decks'][$type] = ['remaining' => count($d['order']), 'discard' => count($d['discard'])];
  }
  return $public;
}

function awkward_chat_append(array &$state, string $name, string $text): void {
  $state['chat'][] = ['name' => $name, 'text' => $text, 't' => round(microtime(true) * 1000)];
  if (count($state['chat']) > 100) $state['chat'] = array_slice($state['chat'], -100);
}
