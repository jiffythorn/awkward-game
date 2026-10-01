<?php
/**
 * GET/POST /rooms/ai.php — bot-brain admin API (used by admin.html)
 * ==================================================================
 * GET  { action: "catalog" }                       -> providers (no keys!) + chain + enabled
 * GET  { action: "models", provider: "groq" }      -> live model list (server-side proxy)
 * POST { action: "save", patch: {...} }            -> merge settings into rooms/config.php
 * POST { action: "test", provider: "groq" }        -> one real call through the chain member
 * POST { action: "testAll" }                       -> probe every chain member
 *
 * If config.php defines 'adminKey', every request must send header
 * X-Admin-Key: <key>. Without an adminKey configured, allowed on localhost only
 * (remote callers get 403) so a fresh install is usable but never wide open.
 */
declare(strict_types=1);
require_once __DIR__ . '/lib.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body = [];
if ($method === 'POST') $body = awkward_json_body();
$action = (string)($body['action'] ?? ($_GET['action'] ?? ''));

$cfg = awkward_bot_config();
$adminKey = (string)($cfg['adminKey'] ?? '');
if ($adminKey !== '') {
  $given = (string)($_SERVER['HTTP_X_ADMIN_KEY'] ?? $body['adminKey'] ?? '');
  if (!hash_equals($adminKey, $given)) awkward_fail('invalid admin key', 403);
} else {
  $ip = (string)($_SERVER['REMOTE_ADDR'] ?? '');
  if (!in_array($ip, ['127.0.0.1', '::1'], true)) awkward_fail('set adminKey in rooms/config.php to manage AI settings remotely', 403);
}

/** Persist a settings patch by rewriting rooms/config.php. */
function awkward_ai_save_config(array $patch): array {
  $cfg = awkward_bot_config();
  // Keys merge; everything else in the patch replaces.
  if (array_key_exists('keys', $patch)) {
    $patch['keys'] = array_filter(array_merge((array)($cfg['keys'] ?? []), (array)$patch['keys']),
      fn($v) => $v !== '' && $v !== null); // empty string = "remove key"
  }
  $cfg = array_merge($cfg, $patch);
  $export = var_export($cfg, true);
  $php = "<?php\n/** AUTO-MANAGED via admin UI (rooms/ai.php). Edit with care. */\n\$AWKWARD_BOT_AI = {$export};\n";
  if (@file_put_contents(awkward_config_path(), $php, LOCK_EX) === false) {
    awkward_fail('cannot write AI config (permissions?)', 500);
  }
  return $cfg;
}

switch ($action) {
  case 'catalog': {
    awkward_respond([
      'providers' => awkward_bot_providers_public(),
      'chain' => array_map(fn($p) => $p['id'], awkward_bot_chain()),
      'enabled' => (bool)(awkward_bot_config()['enabled'] ?? true),
      'settings' => [
        'temperature' => (float)(awkward_bot_config()['temperature'] ?? 0.9),
        'timeoutMs' => (int)(awkward_bot_config()['timeoutMs'] ?? AWKWARD_BOT_TIMEOUT_MS),
        'adminKeySet' => $adminKey !== '',
        'aiStep' => awkward_ai_step(),
      ],
    ]);
    break;
  }

  case 'models': {
    $p = awkward_bot_find_provider((string)($_GET['provider'] ?? $body['provider'] ?? ''));
    if (!$p) awkward_fail('unknown provider', 404);
    awkward_respond(['provider' => $p['id'], 'models' => awkward_bot_list_models($p)]);
    break;
  }

  case 'save': {
    $patch = (array)($body['patch'] ?? []);
    $allowed = ['enabled', 'order', 'disabled', 'modelOverrides', 'keys', 'customProviders', 'adminKey', 'temperature', 'timeoutMs', 'aiStep'];
    $patch = array_intersect_key($patch, array_flip($allowed));
    if (isset($patch['aiStep'])) {
      $patch['aiStep'] = max(0.0, min(600.0, (float)$patch['aiStep'])); // 0–600s; guards against fat-finger values
    }
    if (isset($patch['customProviders']) && !is_array($patch['customProviders'])) awkward_fail('customProviders must be an array');
    if (isset($patch['customProviders'])) {
      // minimal shape validation, stable ids
      $clean = [];
      foreach ((array)$patch['customProviders'] as $i => $c) {
        if (!is_array($c) || empty($c['url'])) continue;
        $clean[] = [
          'id' => preg_replace('/[^a-z0-9_]/', '', strtolower((string)($c['id'] ?? ''))) ?: ('custom' . ($i + 1)),
          'label' => (string)($c['label'] ?? 'Custom provider'),
          'kind' => in_array($c['kind'] ?? 'custom', ['cloud', 'local', 'custom'], true) ? $c['kind'] : 'custom',
          'url' => (string)$c['url'],
          'model' => (string)($c['model'] ?? ''),
          'keyEnv' => !empty($c['keyEnv']) ? (string)$c['keyEnv'] : null,
          'freeTier' => (string)($c['freeTier'] ?? 'your own endpoint'),
          'docs' => (string)($c['docs'] ?? ''),
        ];
      }
      $patch['customProviders'] = $clean;
    }
    awkward_ai_save_config($patch);
    awkward_respond(['ok' => true]);
    break;
  }

  case 'test': {
    $p = awkward_bot_find_provider((string)($body['provider'] ?? ''));
    if (!$p) awkward_fail('unknown provider', 404);
    $msgs = [['role' => 'user', 'content' => 'Reply with the single word: pong']];
    $t0 = microtime(true);
    $text = awkward_bot_call($p, $msgs, $httpCode);
    awkward_respond([
      'ok' => $text !== null,
      'provider' => $p['id'],
      'httpCode' => $httpCode ?? 0,
      'ms' => (int)((microtime(true) - $t0) * 1000),
      'reply' => $text,
    ]);
    break;
  }

  case 'testAll': {
    $results = [];
    foreach (awkward_bot_chain() as $p) {
      $t0 = microtime(true);
      $text = awkward_bot_call($p, [['role' => 'user', 'content' => 'Reply with the single word: pong']], $httpCode);
      $results[] = ['provider' => $p['id'], 'ok' => $text !== null, 'httpCode' => $httpCode ?? 0,
                    'ms' => (int)((microtime(true) - $t0) * 1000)];
    }
    awkward_respond(['chain' => array_map(fn($p) => $p['id'], awkward_bot_chain()), 'results' => $results]);
    break;
  }

  default:
    awkward_fail('unknown action', 400);
}
