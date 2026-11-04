'use strict';
/*
 * servers.js — SSH/FTP-аккаунты Coting («Серверы и хостинги»).
 *
 * Хранилище: ~/.config/coting/servers.json (chmod 600), ключи/пароли не
 * покидают устройство. Агенту отдаётся инструмент remote_server:
 *   - exec: ssh (sshpass для пароля, ключ для key-auth)
 *   - put/get: sftp/ftp через curl
 *   - test: ping-команда/листинг
 *
 * Известные хосты держим в ~/.ssh/known_hosts как есть (StrictHostKeyChecking
 * accept-new: первый коннект добавляет, дальше строгий).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const FILE = path.join(os.homedir(), '.config', 'coting', 'servers.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { servers: [] }; }
}

function write(cfg) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch {}
}

function normalize(p) {
  return {
    id: String(p.id || '').trim(),
    name: String(p.name || p.host || 'сервер'),
    type: ['ssh', 'sftp', 'ftp'].includes(p.type) ? p.type : 'ssh',
    host: String(p.host || '').trim(),
    port: parseInt(p.port, 10) || (p.type === 'ftp' ? 21 : p.type === 'sftp' ? 22 : 22),
    user: String(p.user || 'root'),
    auth: p.auth === 'key' ? 'key' : 'password',
    secret: String(p.secret || ''),   // пароль ИЛИ путь к ключу
  };
}

function list() {
  return (read().servers || []).map(normalize);
}

function get(id) {
  return list().find(s => s.id === id) || null;
}

function upsert(p) {
  const item = normalize(p);
  if (!item.host) throw new Error('нужен host');
  if (!item.id) item.id = 'srv-' + Date.now().toString(36);
  const cfg = read();
  const arr = cfg.servers || [];
  const i = arr.findIndex(x => x.id === item.id);
  if (i >= 0) arr[i] = item; else arr.push(item);
  write({ servers: arr });
  return item;
}

function del(id) {
  const cfg = read();
  const arr = cfg.servers || [];
  const next = arr.filter(x => x.id !== id);
  if (next.length === arr.length) return false;
  write({ servers: next });
  return true;
}

// наружу без секретов
function publicList() {
  return list().map(s => ({
    id: s.id, name: s.name, type: s.type, host: s.host, port: s.port,
    user: s.user, auth: s.auth,
    secretMask: s.auth === 'key' ? 'ключ: ' + (s.secret || '~/.ssh/id_rsa') : '•••' + s.secret.slice(-2),
  }));
}

// ---------- выполнение ----------
function trunc(s, n = 20000) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n… [обрезано, всего ${s.length} символов]` : s;
}

function sshArgs(s, cmd) {
  const args = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=12',
    '-p', String(s.port), `${s.user}@${s.host}`];
  return { args, cmd };
}

function exec(srvId, cmd, timeoutSec = 60) {
  const s = get(srvId);
  if (!s) throw new Error('сервер не найден: ' + srvId);
  if (s.type !== 'ssh' && s.type !== 'sftp') throw new Error('exec только для ssh/sftp');
  const t = Math.min(Math.max(timeoutSec, 5), 300) * 1000;
  const { args, cmd: c } = sshArgs(s, cmd);
  let r;
  if (s.auth === 'key') {
    const key = s.secret || path.join(os.homedir(), '.ssh', 'id_rsa');
    r = spawnSync('ssh', ['-i', key, ...args, c], { encoding: 'utf8', timeout: t, maxBuffer: 16 * 1024 * 1024 });
  } else {
    r = spawnSync('sshpass', ['-p', s.secret, 'ssh', ...args, c], { encoding: 'utf8', timeout: t, maxBuffer: 16 * 1024 * 1024 });
  }
  const out = [
    `$ ${cmd}`,
    r.stdout || '(пустой stdout)',
    r.stderr ? `[stderr]\n${r.stderr}` : '',
    `\n[exit ${r.status === null ? 'timeout/signal ' + r.signal : r.status}]`,
  ].join('\n');
  return { ok: r.status === 0, output: trunc(out) };
}

// put/get через curl (sftp:// и ftp://)
function transfer(srvId, direction, remotePath, localPath) {
  const s = get(srvId);
  if (!s) throw new Error('сервер не найден: ' + srvId);
  const proto = s.type === 'ftp' ? 'ftp' : 'sftp';
  const url = `${proto}://${s.host}:${s.port}${remotePath}`;
  const args = ['--connect-timeout', '15', '-sS'];
  if (s.auth === 'key') {
    // curl sftp с ключом
    const key = s.secret || path.join(os.homedir(), '.ssh', 'id_rsa');
    args.push('--user', `${s.user}:`, '--key', key);
  } else {
    args.push('--user', `${s.user}:${s.secret}`);
  }
  let r;
  if (direction === 'put') {
    if (!fs.existsSync(localPath)) return { ok: false, output: 'локальный файл не найден: ' + localPath };
    r = spawnSync('curl', [...args, '-T', localPath, url], { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  } else {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    r = spawnSync('curl', [...args, url, '-o', localPath], { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  }
  const okk = r.status === 0;
  return { ok: okk, output: trunc(okk
    ? `${direction === 'put' ? 'загружено' : 'скачано'}: ${remotePath} ${direction === 'put' ? '← ' : '→ '}${localPath}`
    : `ошибка: ${r.stderr || r.stdout || r.status}`) };
}

function testConn(srvId) {
  const s = get(srvId);
  if (!s) throw new Error('сервер не найден: ' + srvId);
  if (s.type === 'ftp') {
    const r = transfer(s.id, 'get', '/', '/dev/null');
    // листинг корня curl'ом: -o /dev/null вернёт ошибку файла; делаем явный LIST
    const args = ['--connect-timeout', '15', '-sS', '--user', `${s.user}:${s.secret}`, `ftp://${s.host}:${s.port}/`];
    const rr = spawnSync('curl', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    return { ok: rr.status === 0, output: trunc((rr.stdout || rr.stderr || '').slice(0, 800)) };
  }
  return exec(s.id, 'echo ok && hostname && uname -a', 20);
}

module.exports = { list, get, upsert, del, publicList, exec, transfer, testConn };
