'use strict';
/*
 * server.js — Гефест: HTTP-сервер кодинг-агента (127.0.0.1:8395).
 *
 *   GET  /                    — статика public/ (русский чат)
 *   GET  /api/health          — живость
 *   GET  /api/providers       — провайдеры+модели БЕЗ ключей
 *   GET  /api/sessions        — список сессий
 *   POST /api/sessions        — создать {cwd?, provider?, model?}
 *   GET  /api/sessions/:id    — сессия с сообщениями
 *   DELETE /api/sessions/:id  — удалить
 *   POST /api/chat            — {sessionId, message, provider, model} → SSE-стрим
 *   POST /api/chat/cancel     — {runId} прервать генерацию
 *   POST /api/approve         — {runId, allow} решение по shell-команде
 *
 * Стрим: POST + SSE-события (fetch + ReadableStream на клиенте, EventSource
 * не умеет POST). События: delta, text, tool_start, tool_end, approval,
 * done, error. Сессии — JSON-файлы в sessions/.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { publicList, upsertCustom, deleteCustom, testProvider, getProvider } = require('./config');
const servers = require('./servers');
const { agentRun } = require('./engine');

const PORT = 8395;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SESSIONS_DIR = path.join(ROOT, 'sessions');
const MAX_BODY = 20 * 1024 * 1024;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ---------------- сессии ----------------
const sessionFile = id => path.join(SESSIONS_DIR, id + '.json');

function safeId(id) {
  return /^[\w-]+$/.test(String(id)) ? String(id) : null;
}

function newSession(opts = {}) {
  const id = Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const s = {
    id,
    title: 'Новый чат',
    cwd: opts.cwd || null,
    provider: opts.provider || null,
    model: opts.model || null,
    approveCommands: !!opts.approveCommands,
    messages: [],
    created: Date.now(),
    updated: Date.now(),
  };
  fs.writeFileSync(sessionFile(id), JSON.stringify(s));
  return s;
}

function loadSession(id) {
  const sid = safeId(id);
  if (!sid) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionFile(sid), 'utf8'));
  } catch {
    return null;
  }
}

function saveSession(s) {
  s.updated = Date.now();
  fs.writeFileSync(sessionFile(s.id), JSON.stringify(s));
}

function listSessions() {
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      out.push({ id: s.id, title: s.title, provider: s.provider, model: s.model, cwd: s.cwd, updated: s.updated });
    } catch {}
  }
  out.sort((a, b) => b.updated - a.updated);
  return out;
}

function deleteSession(id) {
  const sid = safeId(id);
  if (!sid) return false;
  try {
    fs.unlinkSync(sessionFile(sid));
    return true;
  } catch {
    return false;
  }
}

// ---------------- активные запуски ----------------
// runId → {abort: AbortController, resolveApproval: fn|null, approved: bool}
const runs = new Map();

function runDone(runId) {
  const r = runs.get(runId);
  if (r) {
    if (r.resolveApproval) { r.resolveApproval(false); r.resolveApproval = null; }
    runs.delete(runId);
  }
}

// ---------------- мелочи HTTP ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, res) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('тело запроса слишком большое'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('невалидный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sseWrite(res, obj) {
  if (!res.writableEnded) res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA-fallback не нужен: приложение одностраничное, 404 честный.
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('не найдено: ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------- /api/chat: главный маршрут ----------------
async function handleChat(req, res, body) {
  const { sessionId, message, provider, model, approveCommands } = body || {};
  const session = loadSession(sessionId);
  if (!session) return sendJson(res, 404, { error: 'сессия не найдена' });
  const text = String(message ?? '').trim();
  if (!text) return sendJson(res, 400, { error: 'пустое сообщение' });

  // выбор модели: приоритет — запрос, потом сессия, потом дефолт zcode
  const provId = provider || session.provider || publicList().defaults.providerId;
  session.provider = provId;
  session.model = model || session.model || publicList().defaults.modelId;
  if (typeof approveCommands === 'boolean') session.approveCommands = approveCommands;
  if (body.cwd !== undefined) session.cwd = body.cwd ? String(body.cwd) : null;

  // user-сообщение в сессию
  session.messages.push({ role: 'user', content: text });
  if (session.title === 'Новый чат') {
    session.title = text.slice(0, 60) + (text.length > 60 ? '…' : '');
  }
  saveSession(session);

  // SSE-ответ
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const runId = crypto.randomBytes(8).toString('hex');
  sseWrite(res, { type: 'start', runId, sessionId: session.id, provider: provId, model: session.model });

  const abort = new AbortController();
  const run = { abort, resolveApproval: null, res };
  runs.set(runId, run);
  // клиент закрыл соединение (уход со страницы) → останавливаем генерацию
  res.on('close', () => { if (!res.writableEnded) { abort.abort(); runDone(runId); } });

  // agentRun получает всю историю включая только что добавленное user-сообщение;
  // возвращает ПОЛНУЮ историю (assistant tool_use + user tool_result парами),
  // которую мы целиком и сохраняем в сессию.
  const history = session.messages.map(m => ({ role: m.role, content: m.content }));

  try {
    const result = await agentRun({
      providerId: provId,
      model: session.model,
      messages: history,
      cwd: session.cwd || undefined,
      approveCommands: session.approveCommands,
      signal: abort.signal,
      onEvent: sseWrite.bind(null, res),
      onApproval: ({ name, input }) => new Promise(resolve => {
        run.resolveApproval = allow => { run.resolveApproval = null; resolve(allow); };
        sseWrite(res, { type: 'approval', name, input });
        setTimeout(() => {
          if (run.resolveApproval) {
            sseWrite(res, { type: 'approval_timeout' });
            run.resolveApproval(false);
          }
        }, APPROVAL_TIMEOUT_MS);
      }),
    });

    session.messages = result.messages;
    saveSession(session);
    sseWrite(res, {
      type: 'done',
      text: result.text,
      usage: result.usage,
      model: result.model,
      steps: result.steps,
      done: !!result.done,
      aborted: !!result.aborted,
    });
  } catch (e) {
    const aborted = e.name === 'AbortError';
    sseWrite(res, { type: 'error', message: aborted ? 'Остановлено пользователем' : (e.message || 'ошибка движка'), aborted });
    saveSession(session);
  } finally {
    runDone(runId);
    res.end();
  }
}

// ---------------- роутер ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  try {
    if (p === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, name: 'coting', runs: runs.size });
    }

    if (p === '/api/providers' && req.method === 'GET') {
      return sendJson(res, 200, publicList());
    }

    // добавление/обновление кастомного провайдера
    if (p === '/api/providers' && req.method === 'POST') {
      const body = await readBody(req, res);
      try {
        const item = upsertCustom(body);
        return sendJson(res, 200, { ok: true, provider: { id: item.id, name: item.name, source: 'custom', api: item.api, models: item.models } });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // проверка провайдера: либо сохранённого по id, либо черновика из формы
    if (p === '/api/providers/test' && req.method === 'POST') {
      const body = await readBody(req, res);
      try {
        const target = body.id
          ? (getProvider(body.id) || (body.baseUrl && body.apiKey ? body : null))
          : (body.baseUrl && body.apiKey ? body : null);
        if (!target) return sendJson(res, 404, { error: 'провайдер не найден' });
        if (!target.models?.length && target.id) {
          const full = getProvider(target.id);
          if (full) target.models = full.models;
        }
        const r = await testProvider(target);
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e.message });
      }
    }

    let pm;
    if ((pm = p.match(/^\/api\/providers\/([\w-]+)$/)) && req.method === 'DELETE') {
      // удалять можно только кастомные
      if (deleteCustom(pm[1])) return sendJson(res, 200, { ok: true });
      return sendJson(res, 400, { error: 'нет такого кастомного провайдера' });
    }

    if (p === '/api/sessions' && req.method === 'GET') {
      return sendJson(res, 200, { sessions: listSessions() });
    }

    // поиск по содержимому чатов: title + все текстовые части сообщений
    if (p === '/api/search' && req.method === 'GET') {
      const q = (u.searchParams.get('q') || '').trim().toLowerCase();
      if (!q) return sendJson(res, 200, { results: [] });
      const results = [];
      for (const meta of listSessions()) {
        const s = loadSession(meta.id);
        if (!s) continue;
        let snippet = null;
        if (s.title.toLowerCase().includes(q)) snippet = s.title;
        for (const m of s.messages) {
          if (snippet) break;
          const texts = typeof m.content === 'string' ? [m.content]
            : Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text) : [];
          for (const t of texts) {
            const idx = t.toLowerCase().indexOf(q);
            if (idx >= 0) {
              const start = Math.max(0, idx - 60);
              snippet = (start > 0 ? '…' : '') + t.slice(start, idx + q.length + 80).replace(/\s+/g, ' ') + '…';
              break;
            }
          }
        }
        if (snippet) results.push({ ...meta, snippet });
        if (results.length >= 30) break;
      }
      return sendJson(res, 200, { results });
    }

    // ---- серверы и хостинги (ssh/sftp/ftp) ----
    if (p === '/api/servers' && req.method === 'GET') {
      return sendJson(res, 200, { servers: servers.publicList() });
    }
    if (p === '/api/servers' && req.method === 'POST') {
      const body = await readBody(req, res);
      try {
        const item = servers.upsert(body);
        return sendJson(res, 200, { ok: true, server: { id: item.id, name: item.name, type: item.type, host: item.host, port: item.port, user: item.user, auth: item.auth } });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (p === '/api/servers/test' && req.method === 'POST') {
      const body = await readBody(req, res);
      try {
        const r = servers.testConn(String(body.id || ''));
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 200, { ok: false, output: e.message });
      }
    }
    let sm;
    if ((sm = p.match(/^\/api\/servers\/([\w-]+)$/)) && req.method === 'DELETE') {
      if (servers.del(sm[1])) return sendJson(res, 200, { ok: true });
      return sendJson(res, 400, { error: 'нет такого сервера' });
    }

    if (p === '/api/sessions' && req.method === 'POST') {
      const body = await readBody(req, res);
      const s = newSession(body);
      return sendJson(res, 200, s);
    }

    let m;
    if ((m = p.match(/^\/api\/sessions\/([\w-]+)$/))) {
      if (req.method === 'GET') {
        const s = loadSession(m[1]);
        if (!s) return sendJson(res, 404, { error: 'сессия не найдена' });
        return sendJson(res, 200, s);
      }
      if (req.method === 'DELETE') {
        return sendJson(res, 200, { ok: deleteSession(m[1]) });
      }
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req, res);
      return await handleChat(req, res, body);
    }

    if (p === '/api/chat/cancel' && req.method === 'POST') {
      const body = await readBody(req, res);
      const r = runs.get(String(body.runId || ''));
      if (!r) return sendJson(res, 404, { error: 'запуск не найден (уже завершён?)' });
      r.abort.abort();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/approve' && req.method === 'POST') {
      const body = await readBody(req, res);
      const r = runs.get(String(body.runId || ''));
      if (!r || !r.resolveApproval) return sendJson(res, 404, { error: 'нет активного подтверждения' });
      r.resolveApproval(!!body.allow);
      return sendJson(res, 200, { ok: true });
    }

    if (p.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'нет такого API: ' + p });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, p);
    }

    res.writeHead(405); res.end();
  } catch (e) {
    if (!res.writableEnded) sendJson(res, e.message?.includes('JSON') ? 400 : 500, { error: e.message });
  }
});

// если клиент оборвал соединение — отменяем запуск, привязанный к этому res
// (отслеживается в handleChat через res.on('close'))

server.listen(PORT, HOST, () => {
  console.log(`[coting] © RybinskLab — https://rybinsklab.ru`);
  console.log(`[coting] слушаю http://${HOST}:${PORT} · ${new Date().toLocaleString('ru-RU')}`);
});
