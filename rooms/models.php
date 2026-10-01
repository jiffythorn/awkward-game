<?php
/**
 * GET /rooms/models.php?provider=groq — live model list for the admin dropdown.
 * Server-side proxy so the API key never reaches the browser. Requires admin
 * access under the same rules as rooms/ai.php. Returns { models: [...] } — an
 * empty list means the provider's /models listing failed (use the free-text box).
 */
declare(strict_types=1);
require_once __DIR__ . '/lib.php';

$cfg = awkward_bot_config();
$adminKey = (string)($cfg['adminKey'] ?? '');
if ($adminKey !== '') {
  $given = (string)($_SERVER['HTTP_X_ADMIN_KEY'] ?? $_GET['adminKey'] ?? '');
  if (!hash_equals($adminKey, $given)) awkward_fail('invalid admin key', 403);
} else {
  $ip = (string)($_SERVER['REMOTE_ADDR'] ?? '');
  if (!in_array($ip, ['127.0.0.1', '::1'], true)) awkward_fail('set adminKey to manage AI settings remotely', 403);
}

$p = awkward_bot_find_provider((string)($_GET['provider'] ?? ''));
if (!$p) awkward_fail('unknown provider', 404);
$models = awkward_bot_list_models($p);
awkward_respond(['provider' => $p['id'], 'count' => count($models), 'models' => $models]);
