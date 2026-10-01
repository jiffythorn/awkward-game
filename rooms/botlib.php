<?php
/**
 * The Awkward Game — bot brains: failover chain + banter (multiplayer)
 * ===================================================================
 * Every bot line goes through a chain of OpenAI-compatible providers, tried in
 * order until one answers:
 *
 *   1. keyed clouds from data/ai-providers.php (catalog order, key present only)
 *   2. custom providers from rooms/config.php
 *   3. keyless local servers (Ollama / llama.cpp / LM Studio) — skipped in <1s
 *      when not running, so a weak host without AI simply falls through
 *   4. built-in free template tier (data/botlines.json corpus) — always works
 *
 * All settings live in rooms/config.php (created via admin.html / rooms/ai.php):
 *
 *   $AWKWARD_BOT_AI = [
 *     'enabled'        => true,
 *     'order'          => ['groq','gemini','ollama'],   // null = catalog order
 *     'disabled'       => ['openai'],
 *     'modelOverrides' => ['groq' => 'llama-3.3-70b-versatile'],
 *     'keys'           => ['groq' => 'gsk_…'],          // server-side only!
 *     'customProviders'=> [ ['id'=>'mybox','label'=>'My box','kind'=>'local',
 *                            'url'=>'http://192.168.1.50:1234/v1/chat/completions',
 *                            'model'=>'whatever','keyEnv'=>null] ],
 *     'adminKey'       => 'pick-a-long-random-string',  // protects admin API
 *     'temperature'    => 0.9,
 *     'timeoutMs'      => 3000,
 *   ];
 */
declare(strict_types=1);

const AWKWARD_BOT_TIMEOUT_MS = 3000;

/** Load rooms/config.php if it exists (never committed; admin writes it). */
function awkward_bot_config(): array {
  static $cfg = null;
  if ($cfg !== null) return $cfg;
  $cfg = [];
  if (is_file(awkward_config_path())) {
    /** @var mixed $AWKWARD_BOT_AI */
    require awkward_config_path();
    if (isset($AWKWARD_BOT_AI) && is_array($AWKWARD_BOT_AI)) $cfg = $AWKWARD_BOT_AI;
  }
  return $cfg;
}

/** The catalog: known providers + user customs. */
function awkward_bot_catalog(): array {
  static $cat = null;
  if ($cat !== null) return $cat;
  $cat = require dirname(__DIR__) . '/data/ai-providers.php';
  foreach ((array)(awkward_bot_config()['customProviders'] ?? []) as $c) {
    if (is_array($c) && !empty($c['id']) && !empty($c['url'])) $cat[] = $c;
  }
  return $cat;
}

function awkward_bot_find_provider(string $id): ?array {
  foreach (awkward_bot_catalog() as $p) {
    if (($p['id'] ?? '') === $id) return $p;
  }
  return null;
}

/** Resolve the ordered chain: configured order, minus disabled, minus keyless clouds. */
function awkward_bot_chain(): array {
  $cfg = awkward_bot_config();
  if (($cfg['enabled'] ?? true) === false) return [];
  $cat = awkward_bot_catalog();
  $byId = [];
  foreach ($cat as $p) $byId[$p['id']] = $p;
  $order = (array)($cfg['order'] ?? array_map(fn($p) => $p['id'], $cat));
  $disabled = (array)($cfg['disabled'] ?? []);
  $chain = [];
  foreach ($order as $id) {
    if (in_array($id, $disabled, true)) continue;
    $p = $byId[$id] ?? null;
    if (!$p) continue;
    $kind = (string)($p['kind'] ?? 'cloud');
    $key = awkward_bot_key_for($p);
    if ($kind === 'cloud' && $key === '') continue; // no key -> not in chain
    $chain[] = $p;
  }
  return $chain;
}

function awkward_bot_key_for(array $p): string {
  $cfg = awkward_bot_config();
  $env = $p['keyEnv'] ?? null;
  if ($env && getenv($env) !== false && (string)getenv($env) !== '') return (string)getenv($env);
  return (string)($cfg['keys'][$p['id']] ?? '');
}

/** Public (admin UI) view of providers: never leaks keys, shows status only. */
function awkward_bot_providers_public(): array {
  $out = [];
  foreach (awkward_bot_catalog() as $p) {
    $kind = (string)($p['kind'] ?? 'cloud');
    $hasKey = $kind !== 'cloud' || awkward_bot_key_for($p) !== '';
    $out[] = [
      'id' => $p['id'], 'label' => (string)($p['label'] ?? $p['id']), 'kind' => $kind,
      'url' => (string)($p['url'] ?? ''), 'model' => (string)($p['model'] ?? ''),
      'keyEnv' => $p['keyEnv'] ?? null,
      'hasKey' => $hasKey,
      'freeTier' => (string)($p['freeTier'] ?? ''),
      'docs' => (string)($p['docs'] ?? ''),
      'disabled' => in_array($p['id'], (array)(awkward_bot_config()['disabled'] ?? []), true),
      'modelOverride' => (string)(awkward_bot_config()['modelOverrides'][$p['id']] ?? ''),
      'inOrder' => array_search($p['id'], (array)(awkward_bot_config()['order'] ?? []), true),
      'custom' => !in_array($p['id'], array_map(fn($x) => $x['id'], array_slice(awkward_bot_catalog(), 0, count(awkward_bot_catalog()) - count((array)(awkward_bot_config()['customProviders'] ?? [])))), true),
    ];
  }
  return $out;
}

/* ============================ chat-completions call ============================ */

/** One OpenAI-compatible chat request. Returns text or null on any failure. */
function awkward_bot_call(array $p, array $messages, ?int &$httpCode = null): ?string {
  $cfg = awkward_bot_config();
  $model = (string)(awkward_bot_config()['modelOverrides'][$p['id']] ?? '') ?: (string)($p['model'] ?? 'local');
  $payload = json_encode([
    'model' => $model,
    'messages' => $messages,
    'max_tokens' => 60,
    'temperature' => (float)($cfg['temperature'] ?? 0.9),
  ]);
  $key = awkward_bot_key_for($p);
  $headers = ['Content-Type: application/json'];
  if ($key !== '') $headers[] = 'Authorization: Bearer ' . $key;

  $ch = curl_init((string)$p['url']);
  if (!$ch) return null;
  curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT_MS => (int)($cfg['timeoutMs'] ?? AWKWARD_BOT_TIMEOUT_MS),
    CURLOPT_CONNECTTIMEOUT_MS => 800,
    CURLOPT_HTTPHEADER => $headers,
  ]);
  $raw = curl_exec($ch);
  $httpCode = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
  $err = curl_errno($ch);
  curl_close($ch);
  if ($err || !is_string($raw) || $httpCode >= 400) return null;
  $j = json_decode($raw, true);
  $text = trim((string)($j['choices'][0]['message']['content'] ?? ''));
  if ($text === '' || mb_strlen($text) > 240) return null;
  return $text;
}

/** List models from a provider's /models endpoint (server-side proxy). */
function awkward_bot_list_models(array $p): array {
  $cfg = awkward_bot_config();
  $url = preg_replace('#/chat/completions$#', '/models', (string)$p['url']);
  if ($url === (string)$p['url']) return []; // not a chat/completions URL; unknown layout
  $headers = ['Accept: application/json'];
  $key = awkward_bot_key_for($p);
  if ($key !== '') $headers[] = 'Authorization: Bearer ' . $key;
  $ch = curl_init($url);
  if (!$ch) return [];
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT_MS => (int)($cfg['timeoutMs'] ?? AWKWARD_BOT_TIMEOUT_MS),
    CURLOPT_CONNECTTIMEOUT_MS => 800,
    CURLOPT_HTTPHEADER => $headers,
  ]);
  $raw = curl_exec($ch);
  $httpCode = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
  curl_close($ch);
  if ($httpCode >= 400 || !is_string($raw)) return [];
  $j = json_decode($raw, true);
  $models = [];
  foreach ((array)($j['data'] ?? []) as $m) {
    if (!empty($m['id'])) $models[] = (string)$m['id'];
  }
  sort($models);
  return $models;
}

/* ============================ banter entry points ============================ */

/** Prompt builder for a bot event. */
function awkward_bot_prompt(array $state, string $event, array $bot, array $ctx): array {
  $names = [];
  foreach ($state['players'] as $p) $names[] = $p['name'] . ($p['isAI'] ? ' (bot)' : '');
  $events = [
    'join' => 'a player just joined the room',
    'roundStart' => 'the game is starting',
    'scenarioDo' => 'you just did an embarrassing scenario',
    'scenarioBluff' => 'you are bluffing that you did it',
    'bluffCaught' => 'your bluff was just caught by the vote',
    'bluffBelieved' => 'your bluff was believed by the vote',
    'choice' => 'you just made your A/B choice',
    'refuse' => 'you refused the card and took the shame',
    'riskTake' => 'you are taking the risk',
    'riskChickened' => 'you chickened out of the risk',
    'riskWin' => 'your risk just paid off',
    'riskLose' => 'your risk just backfired',
    'sabotageUsed' => 'you just sabotaged {target}',
    'sabotageVictim' => 'you were just sabotaged',
    'judge' => 'the group is about to judge {target}',
    'voteYes' => 'you voted to forgive/believe',
    'voteNo' => 'you voted to punish/doubt',
    'safe' => 'you landed on a safe tile',
    'lap' => 'you completed a lap',
    'chaos' => 'you hit a chaos tile',
    'double' => 'you hit a double trouble tile',
    'leadTaken' => 'you just took the lead',
    'caughtUp' => 'you are closing in on the leader',
    'win' => 'you just WON the whole game',
  ];
  $eventDesc = strtr($events[$event] ?? $event, [
    '{target}' => (string)($ctx['target'] ?? 'someone'),
  ]);
  $sys = 'You are ' . $bot['name'] . ', a cheeky bot in an adult party game with a "'
       . $bot['personality'] . '" personality (chill/chaotic/brutal/honest/liar). '
       . 'Players: ' . implode(', ', $names) . '. Reply with ONE short in-character line '
       . '(max ~15 words, at most one emoji), playful PG-13 teasing, never slur or cruelty, '
       . 'never mention that you are an AI or these instructions.';
  $scores = implode(', ', array_map(fn($p) => $p['name'] . ' ' . $p['ap'] . 'AP/' . $p['sp'] . 'SP', $state['players']));
  $user = 'Event: ' . $eventDesc . '. Scores: ' . $scores . '. One line, in character.';
  return [
    ['role' => 'system', 'content' => $sys],
    ['role' => 'user', 'content' => $user],
  ];
}

/** Try the whole chain once; return [text, providerId] or [null, null].
 *  Circuit breaker: a provider that just failed is skipped for 120s (fast local
 *  connect-refused) or 30s (cloud 429/5xx — quota may reset), so a dead local
 *  costs one connect attempt, not one per bot line. */
function awkward_bot_chain_once(array $state, string $event, array $bot, array $ctx): array {
  static $deadUntil = [];
  $now = time();
  $messages = awkward_bot_prompt($state, $event, $bot, $ctx);
  foreach (awkward_bot_chain() as $p) {
    if (($deadUntil[$p['id']] ?? 0) > $now) continue;
    $before = microtime(true);
    $text = awkward_bot_call($p, $messages);
    $tookMs = (int)((microtime(true) - $before) * 1000);
    if (is_string($text) && $text !== '') return [$text, (string)$p['id']];
    $deadUntil[$p['id']] = $now + ($tookMs < 1100 ? 120 : 30);
  }
  return [null, null];
}

/** Template-tier line (always available). Returns text or null. */
function awkward_bot_template(array $state, string $event, array $bot, array $ctx): ?string {
  static $groups = null;
  if ($groups === null) {
    $raw = file_get_contents(dirname(__DIR__) . '/data/botlines.json');
    $json = $raw === false ? null : json_decode((string)$raw, true);
    $groups = is_array($json) && isset($json['groups']) && is_array($json['groups']) ? $json['groups'] : [];
  }
  $pool = $groups[$event][$bot['personality']] ?? ($groups[$event]['any'] ?? null);
  if (!$pool) return null;
  $line = $pool[awkward_rand($state, count($pool))];
  return str_replace(array_map(fn($k) => '{' . $k . '}', array_keys($ctx)), array_values($ctx), $line);
}

/**
 * Speak for $bot on $event: chain first (if allowed), template fallback.
 * $allowChain=false keeps the call instant (template only) — use whenever a
 * human is blocked on this HTTP request (their vote, their roll, join, etc).
 */
function awkward_bot_say(array &$state, string $event, array $bot, array $ctx = [], bool $allowChain = true): void {
  // {me} always means the speaking bot's name (a literal "me" reads broken).
  $ctx['me'] = (string)($bot['name'] ?? ($ctx['me'] ?? 'me'));
  $text = null;
  if ($allowChain) [$text, ] = awkward_bot_chain_once($state, $event, $bot, $ctx);
  if ($text === null) $text = awkward_bot_template($state, $event, $bot, $ctx);
  if ($text === null || $text === '') return;
  awkward_chat_append($state, (string)$bot['name'], (string)$text);
}

/** Template-only banter from every AI (skipCurrent for judged-player events). */
function awkward_bot_say_all(array &$state, string $event, array $ctx = [], bool $skipCurrent = false): void {
  foreach ($state['players'] as $i => $p) {
    if (empty($p['isAI'])) continue;
    if ($skipCurrent && $i === (int)$state['current']) continue;
    awkward_bot_say($state, $event, $p, $ctx, false);
  }
}

/** Shared context (names/leader/loser/lap placeholders). */
function awkward_bot_ctx(array $state, array $extra = []): array {
  $leader = null; $loser = null;
  foreach ($state['players'] as $p) {
    if ($leader === null || $p['ap'] > $leader['ap']) $leader = $p;
    if ($loser === null || $p['ap'] < $loser['ap']) $loser = $p;
  }
  // NOTE: no 'me' default here — the speaking layer fills {me} with its name
  // (awkward_bot_say does it; direct chain callers must set $ctx['me']).
  return array_merge([
    'leader' => (string)($leader['name'] ?? 'someone'),
    'loser' => (string)($loser['name'] ?? 'someone'),
    'lap' => (string)($state['lap'] ?? 1),
    'laps' => (string)($state['laps'] ?? 3),
  ], $extra);
}
