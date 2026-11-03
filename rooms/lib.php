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
const WAGER_STAKE_AP = 2;

/** Board tile types by index (mirrors data/board.js). */
function awkward_board_types(): array {
  static $types = null;
  if ($types === null) {
    $raw = [
      'safe','scenario','choice','risk','safe','scenario','choice','sabotage',
      'risk','scenario','duel','safe','choice','scenario','risk','chaos',
      'scenario','sabotage','choice','safe','vote','scenario','risk','scenario',
      'double','choice','sabotage','safe','scenario','risk','chaos','duel',
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
  foreach (['scenario', 'choice', 'risk', 'sabotage', 'vote', 'duel'] as $t) {
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
    'wagerApAt' => null, 'wagerLap' => null,
    'stats' => [
      'bluffsBelieved' => 0, 'bluffsCaught' => 0, 'confessions' => 0,
      'timesSabotaged' => 0, 'chaosTriggered' => 0, 'risksTaken' => 0, 'risksWon' => 0,
      'dilemmas' => 0, 'bestSplit' => 0, 'duelsWon' => 0,
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
    case 'duel':     return ['duel'];
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

/* ---- Card reward scaling (mirrors lapMultiplier/cardRewardAp in game.js) ---- */

/** Card rewards escalate with the acting player's lap: ×1, ×2, ×3 (capped). */
function awkward_lap_multiplier(array $state, int $idx): int {
  $p = $state['players'][$idx] ?? null;
  return max(1, min(3, ((int)($p['lapsDone'] ?? 0)) + 1));
}

/** Positive AP earned from a card, scaled by lap. Penalties are never scaled. */
function awkward_card_reward(array $state, int $idx, int $ap): int {
  if ($ap <= 0) return $ap;
  $m = awkward_lap_multiplier($state, $idx);
  return $m > 1 ? (int)round($ap * $m) : $ap;
}

/** Log suffix that shows the lap multiplier when one applies. */
function awkward_lap_note(array $state, int $idx, string $why): string {
  $m = awkward_lap_multiplier($state, $idx);
  return $m > 1 ? $why . " [lap {$m} ×{$m}]" : $why;
}

/* ---- Wager to Play: double or nothing (mirrors game.js, RULES.md §6) ---- */

/** Cards a player may wager on: the ones they answer themselves (duels sit out). */
function awkward_wager_eligible(?array $card): bool {
  return $card !== null
    && in_array((string)($card['type'] ?? ''), ['scenario', 'choice', 'risk', 'sabotage', 'vote'], true);
}

function awkward_can_wager(array $state, int $idx): bool {
  $p = $state['players'][$idx] ?? null;
  if (!$p) return false;
  if (($p['wagerApAt'] ?? null) !== null) return false;
  if (($p['wagerLap'] ?? null) !== null && (int)$p['wagerLap'] === (int)($p['lapsDone'] ?? 0)) return false;
  return true;
}

/** Put WAGER_STAKE_AP on the table; the card's own AP swing decides the payout. */
function awkward_take_wager(array &$state, int $idx): bool {
  if (!awkward_can_wager($state, $idx)) return false;
  $p = &$state['players'][$idx];
  $p['wagerApAt'] = (int)$p['ap'];
  $p['wagerLap'] = (int)($p['lapsDone'] ?? 0);
  awkward_log($state, '💸 ' . $p['name'] . ' wagers ' . WAGER_STAKE_AP . ' AP — double or nothing.', 'warn');
  return true;
}

/** Settle an open wager once the card has paid out. Returns [hit, gain] or null. */
function awkward_settle_wager(array &$state, int $idx): ?array {
  if (!isset($state['players'][$idx])) return null;
  $p = &$state['players'][$idx];
  if (($p['wagerApAt'] ?? null) === null) return null;
  $gain = (int)$p['ap'] - (int)$p['wagerApAt'];
  $p['wagerApAt'] = null;
  if ($gain > 0) {
    $p['stats']['wagersWon'] = (int)($p['stats']['wagersWon'] ?? 0) + 1;
    awkward_apply_deltas($state, $idx, $gain, 0, '(wager won — doubled)');
    return ['hit' => true, 'gain' => $gain];
  }
  $p['stats']['wagersLost'] = (int)($p['stats']['wagersLost'] ?? 0) + 1;
  awkward_apply_deltas($state, $idx, -WAGER_STAKE_AP, 0, '(wager lost)');
  return ['hit' => false, 'gain' => $gain];
}

/** Bots gamble when behind: trailing bots wager often, leaders rarely. */
function awkward_maybe_ai_wager(array &$state): bool {
  $idx = (int)$state['current'];
  $p = $state['players'][$idx] ?? null;
  if (!$p || empty($p['isAI']) || !awkward_can_wager($state, $idx)) return false;
  $card = awkward_cards()[$state['activeCard']] ?? null;
  if (!awkward_wager_eligible($card)) return false;
  $leader = 0;
  foreach ($state['players'] as $q) $leader = max($leader, (int)$q['ap']);
  $chance = ((int)$p['ap'] < $leader) ? 0.45 : 0.12;
  if (awkward_rand($state, 1000) / 1000 >= $chance) return false;
  return awkward_take_wager($state, $idx);
}

/* ---- Screw token: rush a rival's answer (mirrors game.js, RULES.md §6) ---- */

const SCREW_SECONDS = 10;
const SCREW_ATTACKER_AP = 2;
const SCREW_TARGET_AP = 2;
const SCREW_TARGET_SP = 1;
const SCREW_RUSH_SUCCESS = 0.45;   // chance a rushed bot keeps its head

/** Cards a screw can land on: one player answers, so one player can be rushed. */
function awkward_screw_eligible(?array $card): bool {
  return $card !== null
    && in_array((string)($card['type'] ?? ''), ['scenario', 'choice', 'risk', 'sabotage', 'vote'], true);
}

/** The screw currently on the clock, if any. */
function awkward_screw_open(array $state): ?array {
  return isset($state['screw']) && is_array($state['screw']) ? $state['screw'] : null;
}

/** A screw needs a rival's card on the table, a free token, and no screw running. */
function awkward_can_screw(array $state, int $idx): bool {
  $p = $state['players'][$idx] ?? null;
  if (!$p) return false;
  if (($state['phase'] ?? '') !== 'resolving' || empty($state['activeCard'])) return false;
  if ((int)($state['current'] ?? -1) === $idx) return false;
  if (awkward_screw_open($state) !== null) return false;
  if (($p['screwLap'] ?? null) !== null && (int)$p['screwLap'] === (int)($p['lapsDone'] ?? 0)) return false;
  return awkward_screw_eligible(awkward_cards()[(string)$state['activeCard']] ?? null);
}

/** Spend the token: the target has SCREW_SECONDS to commit. */
function awkward_take_screw(array &$state, int $idx): bool {
  if (!awkward_can_screw($state, $idx)) return false;
  $target = (int)$state['current'];
  $atk = &$state['players'][$idx];
  $atk['screwLap'] = (int)($atk['lapsDone'] ?? 0);
  $atk['stats']['screwsUsed'] = (int)($atk['stats']['screwsUsed'] ?? 0) + 1;
  $state['screw'] = [
    'by' => $idx,
    'target' => $target,
    'cardId' => (string)$state['activeCard'],
    'apAt' => (int)$state['players'][$target]['ap'],
    'deadline' => round(microtime(true) + SCREW_SECONDS, 3),
  ];
  awkward_log($state, '😈 ' . $atk['name'] . ' SCREWS ' . $state['players'][$target]['name']
    . ' — ' . SCREW_SECONDS . ' seconds to answer.', 'warn');
  return true;
}

/** Settle the screw once its card has paid out: the attacker eats
 *  SCREW_ATTACKER_AP if the target still comes out ahead. */
function awkward_settle_screw(array &$state): ?array {
  $sc = awkward_screw_open($state);
  if ($sc === null) return null;
  if ((string)($state['activeCard'] ?? '') !== (string)($sc['cardId'] ?? '')) return null;
  $state['screw'] = null;
  $by = (int)($sc['by'] ?? -1);
  $target = (int)($sc['target'] ?? -1);
  if (!isset($state['players'][$by], $state['players'][$target])) return null;
  $gain = (int)$state['players'][$target]['ap'] - (int)($sc['apAt'] ?? 0);
  if ($gain > 0) {
    $state['players'][$by]['stats']['screwsBackfired'] = (int)($state['players'][$by]['stats']['screwsBackfired'] ?? 0) + 1;
    awkward_apply_deltas($state, $by, -SCREW_ATTACKER_AP, 0, '(screw backfired — they still scored)');
    return ['won' => false, 'gain' => $gain];
  }
  $state['players'][$by]['stats']['screwsLanded'] = (int)($state['players'][$by]['stats']['screwsLanded'] ?? 0) + 1;
  awkward_apply_deltas($state, $target, -SCREW_TARGET_AP, SCREW_TARGET_SP, '(screwed — answered cold)');
  awkward_apply_deltas($state, $by, SCREW_ATTACKER_AP, 0, '(screw paid off)');
  return ['won' => true, 'gain' => $gain];
}

/** The panicked answer when the clock runs out (or a rushed bot loses its head). */
function awkward_screw_pass_response(?array $card): array {
  switch ((string)($card['type'] ?? '')) {
    case 'scenario':
    case 'choice': return ['kind' => 'refuse'];
    case 'risk': return ['kind' => 'risk-chicken'];
    case 'sabotage': return ['kind' => 'sabotage-skip'];
    default: return ['kind' => 'none'];
  }
}

/** Is this player the one under the gun? */
function awkward_screw_targeted(array $state, int $idx): bool {
  $sc = awkward_screw_open($state);
  return $sc !== null && (int)($sc['target'] ?? -1) === $idx;
}

/** Bots only rush humans — a bot forced to "answer immediately" is just a bot. */
function awkward_maybe_ai_screw(array &$state): bool {
  $idx = (int)($state['current'] ?? -1);
  $target = $state['players'][$idx] ?? null;
  if (!$target || !empty($target['isAI'])) return false;   // humans only
  $card = awkward_cards()[(string)($state['activeCard'] ?? '')] ?? null;
  if (!awkward_screw_eligible($card)) return false;
  $atkIdx = -1;
  $bestAp = -1;
  foreach ($state['players'] as $i => $q) {
    if ((int)$i === $idx || empty($q['isAI'])) continue;
    if (!awkward_can_screw($state, (int)$i)) continue;
    if ((int)$q['ap'] > $bestAp) { $bestAp = (int)$q['ap']; $atkIdx = (int)$i; }
  }
  if ($atkIdx < 0) return false;
  if (awkward_rand($state, 1000) / 1000 >= 0.18) return false;
  return awkward_take_screw($state, $atkIdx);
}

/** Deadline enforcement: a human who never commits eats the pass/fail line. */
function awkward_expire_screw(array &$state): bool {
  $sc = awkward_screw_open($state);
  if ($sc === null) return false;
  if (($state['phase'] ?? '') !== 'resolving') return false;
  if (microtime(true) < (float)($sc['deadline'] ?? 0)) return false;
  if ((string)($state['activeCard'] ?? '') !== (string)($sc['cardId'] ?? '')) { $state['screw'] = null; return true; }
  $target = (int)($sc['target'] ?? -1);
  if (!isset($state['players'][$target])) { $state['screw'] = null; return true; }
  $card = awkward_cards()[(string)$state['activeCard']] ?? null;
  awkward_log($state, '⏱️ ' . $state['players'][$target]['name'] . ' ran out the screw clock — the card answers for them.');
  awkward_apply_response($state, (string)$state['players'][$target]['id'], awkward_screw_pass_response($card));
  return true;
}

/** Split-the-Room scoring, mirrored from splitScore() in game.js. */
function awkward_split_score(array $card, int $yes, int $no): array {
  $n = $yes + $no;
  $closeness = $n > 0 ? 1 - abs($yes - $no) / $n : 0;
  return [
    'ap' => 1 + (int)round(((int)($card['splitAp'] ?? 4)) * $closeness),
    'pct' => (int)round($closeness * 100),
    'unanimous' => $n >= 3 && ($yes === 0 || $no === 0),
  ];
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
  awkward_settle_wager($state, (int)$state['current']); // the wager settles with its card
  awkward_settle_screw($state);                          // so does an open screw
  $id = array_shift($state['pending']);
  if (!$id) {
    awkward_finish_tile($state);
    return;
  }
  $state['activeCard'] = $id;
  $state['phase'] = 'resolving';
}

function awkward_finish_tile(array &$state, bool $completed = true): void {
  awkward_settle_wager($state, (int)$state['current']);
  awkward_settle_screw($state);
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
  // Bullseye from behind the leader: this player rolls again before the turn passes.
  if (isset($state['extraRollFor']) && (int)$state['extraRollFor'] === (int)$state['current']) {
    unset($state['extraRollFor']);
    $state['phase'] = 'await-roll';
    $state['die'] = null;
    awkward_log($state, '🎯 ' . $state['players'][(int)$state['current']]['name'] . ' takes the bonus roll!', 'good');
    return;
  }
  unset($state['extraRollFor']);
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

/** Start a vote: fills AI verdicts immediately, humans submit via vote.php.
 *  $voters scopes who may vote (duels exclude the two duelists); $texts carries
 *  the two anonymous answers for a head-to-head pairing. */
function awkward_start_vote(array &$state, string $context, ?string $cardId, string $mode, array $labels, ?array $voters = null, ?array $texts = null): void {
  if ($voters === null) {
    $voters = [];
    foreach ($state['players'] as $i => $_) {
      if ((int)$i !== (int)$state['current']) $voters[] = (int)$i;
    }
  }
  $state['vote'] = [
    'context' => $context, 'cardId' => $cardId, 'mode' => $mode,
    'labels' => $labels, 'texts' => $texts, 'voters' => array_values($voters),
    'verdicts' => [], 'startedAt' => time(),
  ];
  $state['phase'] = 'await-vote';
  $hasHumanVoter = false;
  foreach ($voters as $i) {
    $v = $state['players'][$i] ?? null;
    if (!$v) continue;
    if (!empty($v['isAI'])) {
      $state['vote']['verdicts'][$v['id']] = $context === 'duel'
        ? awkward_ai_duel_vote($state, $texts ?? [])
        : awkward_ai_vote($state, (int)$i, $context);
    } else {
      $hasHumanVoter = true;
    }
  }
  // All-AI voters (e.g. solo player being judged): nobody would ever call
  // vote.php and the room would hang — let the AI tick tally it on a timer.
  if (!$hasHumanVoter) awkward_ai_pace($state);
}

/** Player indices allowed to vote in the active vote (duels scope this). */
function awkward_vote_voters(array $state): array {
  $vote = $state['vote'] ?? [];
  if (isset($vote['voters']) && is_array($vote['voters'])) return array_values($vote['voters']);
  $out = [];
  foreach ($state['players'] as $i => $_) {
    if ((int)$i !== (int)$state['current']) $out[] = (int)$i;
  }
  return $out;
}

function awkward_vote_complete(array $state): bool {
  if (empty($state['vote'])) return true;
  foreach (awkward_vote_voters($state) as $i) {
    $v = $state['players'][$i] ?? null;
    if (!$v) continue;
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
  foreach (awkward_vote_voters($state) as $i) {
    $v = $state['players'][$i] ?? null;
    if (!$v) continue;
    $verdict = $vote['verdicts'][$v['id']] ?? 'abstain';
    $votes[] = ['name' => $v['name'], 'avatar' => $v['avatar'], 'verdict' => $verdict];
    // Bots announce their verdict as it lands (template-only: humans are waiting).
    if ($vote['context'] !== 'duel' && !empty($v['isAI']) && ($verdict === 'yes' || $verdict === 'no')) {
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
      awkward_apply_deltas($state, (int)$state['current'],
        awkward_card_reward($state, (int)$state['current'], (int)$card['ap'] + 1),
        (int)$card['sp'],
        awkward_lap_note($state, (int)$state['current'], "(bluff believed {$yes}-{$no})"));
    } else {
      $p['stats']['bluffsCaught']++;
      awkward_apply_deltas($state, (int)$state['current'], -$card['ap'], $card['ap'], "(CAUGHT lying {$yes}-{$no})");
    }
    if (!empty($p['isAI'])) {
      awkward_bot_say($state, $succeeded ? 'bluffBelieved' : 'bluffCaught', $p,
                      awkward_bot_ctx($state, ['tally' => $yes . '-' . $no]), false);
    }
    awkward_resolve_next($state);
  } elseif ($vote['context'] === 'duel') {
    awkward_finish_duel_pair($state, $yes, $no);
    return;
  } elseif ($vote['context'] === 'card') {
    if (!$card) { awkward_resolve_next($state); return; }
    if (($vote['mode'] ?? '') === 'split') {
      // Dilemma: pay for how evenly the table divided.
      $res = awkward_split_score($card, $yes, $no);
      $p = &$state['players'][$state['current']];
      $p['stats']['dilemmas'] = ((int)($p['stats']['dilemmas'] ?? 0)) + 1;
      $p['stats']['bestSplit'] = max((int)($p['stats']['bestSplit'] ?? 0), $res['pct']);
      awkward_log($state, '🪓 The table split ' . $yes . '-' . $no . ' — ' . $res['pct'] . '% divisive.');
      awkward_apply_deltas($state, (int)$state['current'],
        awkward_card_reward($state, (int)$state['current'], (int)$res['ap']),
        $res['unanimous'] ? 1 : 0,
        awkward_lap_note($state, (int)$state['current'],
          $res['unanimous'] ? '(unanimous — how boring)' : '(divisive dilemma)'));
    } elseif ($succeeded) {
      awkward_apply_deltas($state, (int)$state['current'],
        awkward_card_reward($state, (int)$state['current'], (int)$card['forgive']['ap']),
        (int)$card['forgive']['sp'],
        awkward_lap_note($state, (int)$state['current'], "(forgiven {$yes}-{$no})"));
    } else {
      awkward_apply_deltas($state, (int)$state['current'], (int)$card['punish']['ap'], (int)$card['punish']['sp'], "(punished {$yes}-{$no})");
    }
    awkward_resolve_next($state);
  } elseif ($vote['context'] === 'believe') {
    // Risk decided by the group.
    awkward_resolve_risk($state, ['yes' => (int)$yes, 'no' => (int)$no]);
  }
  awkward_bump($state);
}

/* ============================ duels (head-to-head rounds) ============================ */
/* Mirrors the duel block in game.js: every player writes an answer, answers are
 * paired anonymously, and AP is paid by vote share. */

const DUEL_SHARE_AP = 4;
const DUEL_WIN_BONUS = 2;
const DUEL_SWEEP_BONUS = 4;
const DUEL_BYE_AP = 2;
const DUEL_BLANK_ANSWER = '(said nothing, stared into the middle distance)';

/** Head-to-head payoff: vote share plus a winner bonus (sweeps pay more). */
function awkward_duel_share(int $aVotes, int $bVotes): array {
  $n = $aVotes + $bVotes;
  if ($n === 0) {
    return ['apA' => DUEL_BYE_AP, 'apB' => DUEL_BYE_AP, 'winner' => 'tie', 'sweep' => false, 'pctA' => 50, 'pctB' => 50];
  }
  $sweep = ($aVotes === 0 || $bVotes === 0);
  $pctA = (int)round(100 * $aVotes / $n);
  if ($aVotes === $bVotes) {
    $ap = (int)round(DUEL_SHARE_AP * $aVotes / $n) + 1;
    return ['apA' => $ap, 'apB' => $ap, 'winner' => 'tie', 'sweep' => false, 'pctA' => $pctA, 'pctB' => 100 - $pctA];
  }
  $bonus = $sweep ? DUEL_SWEEP_BONUS : DUEL_WIN_BONUS;
  return [
    'apA' => (int)round(DUEL_SHARE_AP * $aVotes / $n) + ($aVotes > $bVotes ? $bonus : 0),
    'apB' => (int)round(DUEL_SHARE_AP * $bVotes / $n) + ($bVotes > $aVotes ? $bonus : 0),
    'winner' => $aVotes > $bVotes ? 'a' : 'b',
    'sweep' => $sweep, 'pctA' => $pctA, 'pctB' => 100 - $pctA,
  ];
}

/** Canned answer for an AI duelist, avoiding answers already at the table. */
function awkward_ai_duel_answer(array &$state, array $card, int $idx): string {
  $selfId = (string)($state['players'][$idx]['id'] ?? '');
  $used = [];
  foreach (($state['duel']['answers'] ?? []) as $pid => $text) {
    if ((string)$pid !== $selfId) $used[] = $text;
  }
  $pool = [];
  foreach (($card['answers'] ?? []) as $a) {
    if (!in_array($a, $used, true)) $pool[] = (string)$a;
  }
  if (!$pool) return DUEL_BLANK_ANSWER;
  return $pool[awkward_rand($state, count($pool))];
}

/** AI preference in a duel: longer answers read as more effort, plus chaos. */
function awkward_ai_duel_vote(array &$state, array $texts): string {
  $a = (string)($texts[0] ?? '');
  $b = (string)($texts[1] ?? '');
  $longerA = mb_strlen($a) >= mb_strlen($b);
  if (awkward_rand($state, 100) < 65) return $longerA ? 'yes' : 'no';
  return awkward_rand($state, 2) === 1 ? 'yes' : 'no';
}

/** Normalise answer text for duplicate detection (case/punctuation blind). */
function awkward_duel_norm(string $text): string {
  $t = function_exists('mb_strtolower') ? mb_strtolower($text, 'UTF-8') : strtolower($text);
  $t = preg_replace('/[^\p{L}\p{N}\s]+/u', ' ', $t) ?? $t;
  $t = preg_replace('/\s+/u', ' ', $t) ?? $t;
  return trim($t);
}

/** Player ids whose answer duplicates another player's (cancelled answers).
 *  Safe answers (submitted blank) never cancel and are never cancelled. */
function awkward_duel_duplicates(array $state): array {
  $answers = $state['duel']['answers'] ?? [];
  $safety = $state['duel']['safety'] ?? [];
  $blank = awkward_duel_norm(DUEL_BLANK_ANSWER);
  $groups = [];
  foreach ($answers as $pid => $text) {
    if (!empty($safety[$pid])) continue;
    $n = awkward_duel_norm((string)$text);
    if ($n === '' || $n === $blank) continue;
    $groups[$n][] = (string)$pid;
  }
  $out = [];
  foreach ($groups as $list) {
    if (count($list) > 1) foreach ($list as $pid) $out[] = $pid;
  }
  return $out;
}

/** Safety Quip: a blank / auto-filled answer only earns half its AP. */
function awkward_duel_safety_ap(int $ap, bool $safety): int {
  return $safety ? intdiv(max(0, $ap), 2) : $ap;
}

/** Human players who still owe a duel answer. */
function awkward_duel_pending(array $state): array {
  $out = [];
  foreach (($state['players'] ?? []) as $p) {
    if (!empty($p['isAI'])) continue;
    if (!isset($state['duel']['answers'][(string)$p['id']])) $out[] = (string)$p['id'];
  }
  return $out;
}

function awkward_start_duel(array &$state, array $card): void {
  $state['duel'] = [
    'cardId' => (string)$card['id'], 'answers' => [],
    'safety' => [], 'duplicates' => [],
    'pairs' => [], 'pair' => 0, 'results' => [],
  ];
  $state['phase'] = 'await-duel';
  awkward_bump($state);
  awkward_log($state, '⚔️ DUEL: "' . $card['title'] . '" — everyone writes an answer.');
  foreach ($state['players'] as $i => $p) {
    if (!empty($p['isAI'])) {
      $state['duel']['answers'][(string)$p['id']] = awkward_ai_duel_answer($state, $card, (int)$i);
    }
  }
  if (count(awkward_duel_pending($state)) === 0) awkward_duel_begin_pairs($state);
}

/** Store a duel answer; returns false when the player already answered. */
function awkward_duel_answer(array &$state, string $playerId, string $text): bool {
  if (($state['phase'] ?? '') !== 'await-duel' || empty($state['duel'])) return false;
  if (array_key_exists($playerId, $state['duel']['answers'])) return false;
  $clean = trim($text);
  if (mb_strlen($clean) > 90) $clean = mb_substr($clean, 0, 90);
  if ($clean === '') $state['duel']['safety'][$playerId] = true;
  else unset($state['duel']['safety'][$playerId]);
  $state['duel']['answers'][$playerId] = $clean !== '' ? $clean : DUEL_BLANK_ANSWER;
  if (count(awkward_duel_pending($state)) === 0) awkward_duel_begin_pairs($state);
  return true;
}

/** Shuffle the table into anonymous pairs; an odd player out gets a bye. */
function awkward_duel_begin_pairs(array &$state): void {
  $order = array_keys($state['players']);
  awkward_shuffle($order, $state);
  $pairs = [];
  for ($i = 0; $i < count($order); $i += 2) {
    $pairs[] = [$order[$i], $order[$i + 1] ?? -1];
  }
  $state['duel']['pairs'] = $pairs;
  $state['duel']['pair'] = 0;
  $state['duel']['duplicates'] = awkward_duel_duplicates($state);
  $bouts = 0;
  foreach ($pairs as $p) if ($p[1] >= 0) $bouts++;
  awkward_log($state, '⚔️ The duel draws ' . $bouts . ' pairing(s).');
  $dupes = count($state['duel']['duplicates']);
  if ($dupes > 0) awkward_log($state, '🚫 ' . $dupes . ' duplicate answer(s) cancelled — no points for unoriginality.');
  awkward_bump($state);
  awkward_start_duel_vote($state);
}

/** Start the current pairing's vote (or pay a bye / no-jury pairing). */
function awkward_start_duel_vote(array &$state): void {
  if (empty($state['duel'])) { awkward_resolve_next($state); return; }
  $pair = $state['duel']['pairs'][$state['duel']['pair']] ?? null;
  if ($pair === null) { awkward_finish_duel($state); return; }
  $ai = (int)$pair[0];
  $bi = (int)($pair[1] ?? -1);
  if ($bi < 0) {
    $p = $state['players'][$ai];
    $safe = !empty($state['duel']['safety'][(string)$p['id']]);
    $ap = awkward_duel_safety_ap(awkward_card_reward($state, $ai, DUEL_BYE_AP), $safe);
    $state['duel']['results'][] = ['aName' => $p['name'], 'bName' => '—', 'aVotes' => 0, 'bVotes' => 0, 'apA' => $ap, 'apB' => 0, 'winner' => 'bye', 'safetyA' => $safe];
    awkward_apply_deltas($state, $ai, $ap, 0, awkward_lap_note($state, $ai, $safe ? '(duel bye — safe answer ×½)' : '(duel bye — no opponent)'));
    awkward_next_duel_pair($state);
    return;
  }
  $aId = (string)$state['players'][$ai]['id'];
  $bId = (string)$state['players'][$bi]['id'];
  $texts = [(string)($state['duel']['answers'][$aId] ?? ''), (string)($state['duel']['answers'][$bId] ?? '')];

  // Duplicate cancellation: matching answers score nothing and skip the vote.
  $dupes = $state['duel']['duplicates'] ?? [];
  $dupA = in_array($aId, $dupes, true);
  $dupB = in_array($bId, $dupes, true);
  if ($dupA || $dupB) {
    $apA = $dupA ? 0 : awkward_card_reward($state, $ai, DUEL_WIN_BONUS);
    $apB = $dupB ? 0 : awkward_card_reward($state, $bi, DUEL_WIN_BONUS);
    $winner = ($dupA && $dupB) ? 'tie' : ($dupA ? 'b' : 'a');
    $state['duel']['results'][] = [
      'aName' => $state['players'][$ai]['name'], 'bName' => $state['players'][$bi]['name'],
      'aVotes' => 0, 'bVotes' => 0, 'apA' => $apA, 'apB' => $apB,
      'winner' => $winner, 'cancelled' => true,
    ];
    awkward_log($state, '🚫 "' . $texts[0] . '" vs "' . $texts[1] . '" — duplicate answer, cancelled.');
    if (!$dupA) awkward_apply_deltas($state, $ai, $apA, 0, awkward_lap_note($state, $ai, '(pairing won by default)'));
    if (!$dupB) awkward_apply_deltas($state, $bi, $apB, 0, awkward_lap_note($state, $bi, '(pairing won by default)'));
    awkward_next_duel_pair($state);
    return;
  }

  $voters = [];
  foreach ($state['players'] as $i => $_) {
    if ((int)$i !== $ai && (int)$i !== $bi) $voters[] = (int)$i;
  }
  if (!$voters) {
    $safeA = !empty($state['duel']['safety'][$aId]);
    $safeB = !empty($state['duel']['safety'][$bId]);
    $apA = awkward_duel_safety_ap(awkward_card_reward($state, $ai, DUEL_BYE_AP), $safeA);
    $apB = awkward_duel_safety_ap(awkward_card_reward($state, $bi, DUEL_BYE_AP), $safeB);
    $state['duel']['results'][] = ['aName' => $state['players'][$ai]['name'], 'bName' => $state['players'][$bi]['name'], 'aVotes' => 0, 'bVotes' => 0, 'apA' => $apA, 'apB' => $apB, 'winner' => 'tie', 'safetyA' => $safeA, 'safetyB' => $safeB];
    awkward_log($state, '⚔️ ' . $state['players'][$ai]['name'] . ' vs ' . $state['players'][$bi]['name'] . ' — no jury, both take ' . DUEL_BYE_AP . ' AP.');
    awkward_apply_deltas($state, $ai, $apA, 0, awkward_lap_note($state, $ai, $safeA ? '(duel — no jury, safe ×½)' : '(duel — no jury)'));
    awkward_apply_deltas($state, $bi, $apB, 0, awkward_lap_note($state, $bi, $safeB ? '(duel — no jury, safe ×½)' : '(duel — no jury)'));
    awkward_next_duel_pair($state);
    return;
  }
  $card = awkward_cards()[$state['duel']['cardId']] ?? null;
  awkward_start_vote($state, 'duel', $card ? (string)$card['id'] : null, 'majority', ['Answer A', 'Answer B'], $voters, $texts);
}

/** Pay one pairing by vote share, then move on. */
function awkward_finish_duel_pair(array &$state, int $yes, int $no): void {
  if (empty($state['duel'])) return;
  $pair = $state['duel']['pairs'][$state['duel']['pair']] ?? null;
  if (!$pair) { awkward_finish_duel($state); return; }
  $ai = (int)$pair[0];
  $bi = (int)($pair[1] ?? -1);
  if ($bi < 0) { awkward_next_duel_pair($state); return; }
  $sh = awkward_duel_share($yes, $no);
  $a = $state['players'][$ai];
  $b = $state['players'][$bi];
  $aText = (string)($state['duel']['answers'][(string)$a['id']] ?? '');
  $bText = (string)($state['duel']['answers'][(string)$b['id']] ?? '');
  $safeA = !empty($state['duel']['safety'][(string)$a['id']]);
  $safeB = !empty($state['duel']['safety'][(string)$b['id']]);
  $apA = awkward_duel_safety_ap(awkward_card_reward($state, $ai, (int)$sh['apA']), $safeA);
  $apB = awkward_duel_safety_ap(awkward_card_reward($state, $bi, (int)$sh['apB']), $safeB);
  $state['duel']['results'][] = [
    'aName' => $a['name'], 'bName' => $b['name'], 'aVotes' => $yes, 'bVotes' => $no,
    'apA' => $apA, 'apB' => $apB, 'winner' => $sh['winner'], 'sweep' => $sh['sweep'],
    'safetyA' => $safeA, 'safetyB' => $safeB,
  ];
  awkward_log($state, '⚔️ ' . $a['name'] . ' ' . $yes . '–' . $no . ' ' . $b['name'] . ' — "' . $aText . '" vs "' . $bText . '"');
  awkward_apply_deltas($state, $ai, $apA, 0, awkward_lap_note($state, $ai, $safeA ? '(duel share ' . $sh['pctA'] . '%, safe ×½)' : '(duel share ' . $sh['pctA'] . '%)'));
  awkward_apply_deltas($state, $bi, $apB, 0, awkward_lap_note($state, $bi, $safeB ? '(duel share ' . $sh['pctB'] . '%, safe ×½)' : '(duel share ' . $sh['pctB'] . '%)'));
  if ($sh['winner'] === 'a') $state['players'][$ai]['stats']['duelsWon']++;
  if ($sh['winner'] === 'b') $state['players'][$bi]['stats']['duelsWon']++;
  awkward_next_duel_pair($state);
}

function awkward_next_duel_pair(array &$state): void {
  if (empty($state['duel'])) return;
  $state['duel']['pair']++;
  awkward_bump($state);
  if ($state['duel']['pair'] < count($state['duel']['pairs'])) awkward_start_duel_vote($state);
  else awkward_finish_duel($state);
}

function awkward_finish_duel(array &$state): void {
  unset($state['duel']);
  $state['phase'] = 'resolving';
  awkward_bump($state);
  awkward_resolve_next($state);
}

/* ============================ card responses ============================ */

/* ---- Risk bands: bullseye instead of pass/fail (mirrors riskBand in game.js) ---- */

const RISK_BULLSEYE_MUL = 2;
const RISK_NEAR_MUL = 0.5;
const RISK_MISS_EXTRA_SP = 1;

/** Grade a risk from the mechanic's own margin (coin stays binary). */
function awkward_risk_band(array $card, array $outcome): string {
  $mech = (string)($card['mech'] ?? 'believe');
  if ($mech === 'die') {
    $r = (int)($outcome['roll'] ?? 0);
    if ($r >= 6) return 'bullseye';
    if ($r >= 5) return 'good';
    if ($r >= 4) return 'near';
    return 'miss';
  }
  if ($mech === 'believe') {
    $yes = (int)($outcome['yes'] ?? 0);
    $no = (int)($outcome['no'] ?? 0);
    if ($yes + $no === 0) return 'near';
    if ($no === 0 && $yes >= 2) return 'bullseye';
    if ($yes > $no) return 'good';
    if ($yes === $no) return 'near';
    return 'miss';
  }
  return !empty($outcome['heads']) ? 'good' : 'miss';
}

/** AP/SP a band pays, using the card's own reward and penalty. */
function awkward_risk_payout(array $card, string $band, array $state, int $idx): array {
  $reward = $card['reward'] ?? ['ap' => 0, 'sp' => 0];
  $penalty = $card['penalty'] ?? ['ap' => 0, 'sp' => 0];
  $base = awkward_card_reward($state, $idx, (int)($reward['ap'] ?? 0));
  if ($band === 'miss') return ['ap' => (int)($penalty['ap'] ?? 0), 'sp' => (int)($penalty['sp'] ?? 0) + RISK_MISS_EXTRA_SP];
  if ($band === 'bullseye') return ['ap' => (int)round($base * RISK_BULLSEYE_MUL), 'sp' => (int)($reward['sp'] ?? 0)];
  if ($band === 'near') return ['ap' => max(1, (int)round($base * RISK_NEAR_MUL)), 'sp' => 0];
  return ['ap' => $base, 'sp' => (int)($reward['sp'] ?? 0)];
}

function awkward_resolve_risk(array &$state, array $outcome): void {
  $card = awkward_cards()[$state['activeCard']] ?? null;
  if (!$card) { awkward_resolve_next($state); return; }
  $idx = (int)$state['current'];
  $p = &$state['players'][$idx];
  $allowChain = !empty($p['isAI']);
  $band = awkward_risk_band($card, $outcome);
  $leader = 0;
  foreach ($state['players'] as $q) $leader = max($leader, (int)$q['ap']);
  $wasBehind = (int)$p['ap'] < $leader;
  $pay = awkward_risk_payout($card, $band, $state, $idx);
  if ($band === 'miss') {
    $p['stats']['risksLost'] = (int)($p['stats']['risksLost'] ?? 0) + 1;
    awkward_apply_deltas($state, $idx, $pay['ap'], $pay['sp'], '(risk missed…)');
  } else {
    $p['stats']['risksWon'] = (int)($p['stats']['risksWon'] ?? 0) + 1;
    $label = $band === 'bullseye' ? '(BULLSEYE!)' : ($band === 'near' ? '(near miss — half)' : '(risk paid off!)');
    awkward_apply_deltas($state, $idx, $pay['ap'], $pay['sp'], awkward_lap_note($state, $idx, $label));
    if ($band === 'bullseye') {
      $p['stats']['bullseyes'] = (int)($p['stats']['bullseyes'] ?? 0) + 1;
      awkward_log($state, '🎯 BULLSEYE!', 'good');
      if ($wasBehind) {
        $state['extraRollFor'] = $idx;
        awkward_log($state, '🎯 ' . $p['name'] . ' nailed it from behind — bonus roll incoming!', 'good');
      }
    }
  }
  awkward_bot_say($state, $band === 'miss' ? 'riskLose' : 'riskWin', $p,
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
      awkward_apply_deltas($state, $idx, awkward_card_reward($state, $idx, (int)$card['ap']), (int)$card['sp'], awkward_lap_note($state, $idx, '(did it)'));
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
      awkward_apply_deltas($state, $idx, awkward_card_reward($state, $idx, (int)$opt['ap']), (int)$opt['sp'], awkward_lap_note($state, $idx, '(' . strtoupper($side) . ')'));
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
        awkward_resolve_risk($state, ['heads' => awkward_rand($state, 2) === 1]);
      } elseif ($mech === 'die') {
        awkward_resolve_risk($state, ['roll' => awkward_rand($state, 6) + 1]); // 6 bullseye, 5 good, 4 near
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
      if (($card['type'] ?? '') === 'duel') {
        awkward_start_duel($state, $card);
      } elseif (($card['type'] ?? '') === 'vote') {
        $mode = (string)($card['mode'] ?? 'majority');
        if (!in_array($mode, ['majority', 'unanimous', 'split'], true)) $mode = 'majority';
        $labels = $mode === 'split' ? ['Yes', 'No'] : ['Forgive', 'Punish'];
        awkward_start_vote($state, 'card', $card['id'], $mode, $labels);
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
      if (($card['type'] ?? '') === 'duel') {
        return ['resp' => ['kind' => 'none'], 'label' => 'kicks off a duel!'];
      }
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

  // A screw is on the clock: a human who never commits eats the pass line.
  if (awkward_expire_screw($state)) return true;

  // Duel writing phase: bots already answered, so pair up once humans do.
  if ($phase === 'await-duel' && !empty($state['duel'])) {
    if (awkward_duel_pending($state)) return false;
    awkward_duel_begin_pairs($state);
    return true;
  }

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

  if ($curAI === false) {
    // Bots may spend a screw token to rush a human's card.
    if ($phase === 'resolving' && !empty($state['activeCard']) && awkward_maybe_ai_screw($state)) return true;
    return false;   // human turn / lobby / over
  }

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
  // A screwed bot loses its head: it rushes the pass/refuse line.
  if ($dec['resp'] !== null && awkward_screw_targeted($state, (int)$state['current'])) {
    if (awkward_rand($state, 1000) / 1000 >= SCREW_RUSH_SUCCESS) {
      $dec['resp'] = awkward_screw_pass_response(awkward_cards()[(string)$state['activeCard']] ?? null);
    }
  }
  if ($dec['resp'] === null) { awkward_resolve_next($state); return true; }
  unset($state['aiHold']);
  awkward_maybe_ai_wager($state); // bots may put a stake down before they answer
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
  // Duel answers stay anonymous until their pairing is voted on: clients get
  // who-has-answered plus the two answers currently on the block.
  if (!empty($state['duel'])) {
    $d = $state['duel'];
    $answered = [];
    foreach (($d['answers'] ?? []) as $pid => $_) $answered[(string)$pid] = true;
    $texts = null;
    $pair = $d['pairs'][(int)($d['pair'] ?? 0)] ?? null;
    if ($pair && ($state['vote']['context'] ?? '') === 'duel') {
      $aId = (string)($state['players'][(int)$pair[0]]['id'] ?? '');
      $bIdx = (int)($pair[1] ?? -1);
      $bId = $bIdx >= 0 ? (string)($state['players'][$bIdx]['id'] ?? '') : '';
      $texts = [(string)($d['answers'][$aId] ?? ''), (string)($d['answers'][$bId] ?? '')];
    }
    $public['duel'] = [
      'cardId' => $d['cardId'] ?? null,
      'answered' => $answered,
      'pair' => (int)($d['pair'] ?? 0),
      'pairs' => count($d['pairs'] ?? []),
      'texts' => $texts,
      'results' => array_values($d['results'] ?? []),
    ];
  } else {
    $public['duel'] = null;
  }
  // Wagers are public information, but clients only need whether one is open.
  foreach ($public['players'] as $i => $pl) {
    $public['players'][$i]['wagerOpen'] = ($pl['wagerApAt'] ?? null) !== null;
    unset($public['players'][$i]['wagerApAt']);
  }
  // An open screw is public: everyone watches the clock run down.
  if (isset($state['screw']) && is_array($state['screw'])) {
    $sc = $state['screw'];
    $public['screw'] = [
      'by' => (int)($sc['by'] ?? -1),
      'target' => (int)($sc['target'] ?? -1),
      'cardId' => $sc['cardId'] ?? null,
      'ms' => max(0, (int)round(((float)($sc['deadline'] ?? 0) - microtime(true)) * 1000)),
    ];
  } else {
    $public['screw'] = null;
  }
  return $public;
}

function awkward_chat_append(array &$state, string $name, string $text): void {
  $state['chat'][] = ['name' => $name, 'text' => $text, 't' => round(microtime(true) * 1000)];
  if (count($state['chat']) > 100) $state['chat'] = array_slice($state['chat'], -100);
}
