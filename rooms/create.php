<?php
/**
 * POST /rooms/create.php  { name, avatar, aiPersonalities? }
 * Creates a room with the host as player 0 and three AI fill-ins (so a room is
 * instantly playable). Returns { code, playerId }.
 */
declare(strict_types=1);
require __DIR__ . '/lib.php';

$body = awkward_json_body();
$name = trim((string)($body['name'] ?? ''));
if ($name === '' || mb_strlen($name) > 20) awkward_fail('name must be 1-20 characters');
$avatar = (string)($body['avatar'] ?? '🦆');
if (mb_strlen($avatar) > 16) $avatar = '🦆';

$code = awkward_new_code();
$state = [
    'v' => 1,
    'seed' => random_int(1, 0x7fffffff),
    'rngState' => 0,
    'phase' => 'lobby',
    'mode' => 'room',
    'players' => [],
    'current' => 0,
    'lap' => 1,
    'laps' => 3,
    'turnCount' => 0,
    'die' => null,
    'decks' => [],
    'pending' => [],
    'activeCard' => null,
    'comboEligible' => false,
    'vote' => null,
    'log' => [],
    'chat' => [],
    'seq' => 0,
    'createdAt' => time(),
];
$state['rngState'] = $state['seed'];

$state['players'][] = awkward_make_player('p0', $name, $avatar, false, 'chill');
$aiPers = ['chill', 'chaotic', 'liar'];
foreach ($aiPers as $i => $pers) {
    $state['players'][] = awkward_make_player('p' . ($i + 1), ucfirst($pers) . ' Bot', '🤖', true, $pers);
}
build: awkward_log($state, '🏠 Room ' . $code . ' created by ' . $name . '.');
awkward_bump($state);
awkward_save_room($code, $state);

awkward_respond(['code' => $code, 'playerId' => 'p0']);
