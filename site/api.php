<?php
/*
 * api.php — счётчик скачиваний Coting APK.
 *   ?a=get → {"ok":true,"count":N}
 *   ?a=dl  → +1 (t=apk|github|ghrel — для статистики по каналам)
 * Хранилище: data/count.json (chmod, доступ только числам).
 * © 2026 RybinskLab
 */
header('content-type: application/json; charset=utf-8');
header('cache-control: no-store');

$dir = __DIR__ . '/data'; // закрыт nginx (location deny)
$file = $dir . '/count.json';
if (!is_dir($dir)) { @mkdir($dir, 0755, true); }

$data = ['count' => 0, 'by' => [], 'updated' => 0];
if (is_readable($file)) {
    $j = json_decode(file_get_contents($file), true);
    if (is_array($j)) { $data = $j; }
}

$a = isset($_GET['a']) ? preg_replace('/\W/', '', $_GET['a']) : 'get';

if ($a === 'dl') {
    $t = isset($_GET['t']) ? preg_replace('/\W/', '', $_GET['t']) : 'other';
    if (strlen($t) > 20) { $t = 'other'; }
    $data['count'] = intval($data['count']) + 1;
    if (!isset($data['by'][$t])) { $data['by'][$t] = 0; }
    $data['by'][$t]++;
    $data['updated'] = time();
    file_put_contents($file, json_encode($data), LOCK_EX);
    clearstatcache(true, $file);
}

echo json_encode(['ok' => true, 'count' => intval($data['count']), 'by' => $data['by']]);
