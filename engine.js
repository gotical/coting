'use strict';
/*
 * engine.js — движок Coting. Форк ~/bin/agent-core.js с тремя отличиями:
 *   1) стриминг: stream:true к провайдеру + SSE-парсер, текст летит в UI дельтами;
 *   2) мульти-провайдер: baseUrl/apiKey берутся из providers.js (provider_config.json),
 *      ротация Antigravity-профилей не нужна — у каждого провайдера свой ключ;
 *   3) cwd сессии: инструменты работают в папке проекта, а опциональное
 *      подтверждение команд (approve) идёт через колбэк наружу, в server.js.
 *
 * Инструменты и анти-зацикливание перенесены из agent-core без изменений по сути.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getProvider } = require('./config');
const servers = require('./servers');

const HOME = os.homedir();

// ---------------- инструменты (наследие agent-core) ----------------
const MAX_OUT = 24000;

const TOOLS = [
  {
    name: 'run_command',
    description: 'Выполнить shell-команду в Termux (Android). Возвращает stdout, stderr и код выхода. Используй для осмотра окружения, запуска программ, проверки результата.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Команда для запуска в shell' },
        cwd: { type: 'string', description: 'Рабочая директория (по умолчанию — рабочая папка проекта)' },
        timeout: { type: 'integer', description: 'Таймаут в секундах, по умолчанию 60, максимум 300' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Прочитать файл (или его часть). Для больших файлов указывай offset и limit.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу' },
        offset: { type: 'integer', description: 'С какой строки начать (с 1)' },
        limit: { type: 'integer', description: 'Сколько строк прочитать (по умолчанию 400)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Записать текст в файл (перезаписывает). Создаёт файл, если его нет.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу' },
        content: { type: 'string', description: 'Содержимое' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Заменить точный фрагмент в файле. old_string должен встречаться в файле ровно один раз.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу' },
        old_string: { type: 'string', description: 'Что заменить' },
        new_string: { type: 'string', description: 'На что заменить' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_dir',
    description: 'Показать содержимое директории.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Путь к директории' } },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Поиск по содержимому файлов (ripgrep) по шаблону. Используй, чтобы найти, где лежит нужный код.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Регулярное выражение или строка поиска' },
        path: { type: 'string', description: 'Где искать (по умолчанию рабочая папка проекта)' },
        glob: { type: 'string', description: 'Фильтр по расширению, например *.js' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Скачать страницу или API-ответ из интернета. Ходит под видом мобильного Яндекс.Браузера (User-Agent YaBrowser Mobile). Для HTML вернёт исходник — ищи нужное в тексте; script/style вырезаны.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Полный URL (http/https)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'android_device',
    description: 'Управление этим телефоном через APK-мост Coting (локальный :8396). Действия: status (что включено), tap (тап по координатам), swipe, text (текст активного окна с координатами), screenshot (PNG сохраняется в файл), back/home/recents/notifications (системные кнопки), lock (заблокировать экран). Тап/свайп/текст/скриншот требуют включённого accessibility в приложении Coting; lock — прав администратора. Координаты бери из /text — там они в квадратных скобках.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'tap', 'swipe', 'text', 'screenshot', 'back', 'home', 'recents', 'notifications', 'lock'],
          description: 'Что сделать',
        },
        x: { type: 'integer', description: 'для tap: координата X' },
        y: { type: 'integer', description: 'для tap: координата Y' },
        long: { type: 'boolean', description: 'для tap: долгое нажатие' },
        x1: { type: 'integer', description: 'для swipe: начало X' },
        y1: { type: 'integer', description: 'для swipe: начало Y' },
        x2: { type: 'integer', description: 'для swipe: конец X' },
        y2: { type: 'integer', description: 'для swipe: конец Y' },
        ms: { type: 'integer', description: 'для swipe: длительность мс (по умолчанию 300)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'remote_server',
    description: 'Работа с серверами и хостингами пользователя (аккаунты заданы в настройках Coting). Действия: list (список серверов), test (проверка связи), exec (выполнить shell-команду по ssh), put (загрузить файл на сервер), get (скачать файл с сервера). Для ftp доступен только put/get (листинг через test). Вызывай, когда пользователь просит что-то сделать на его сервере/хостинге.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'test', 'exec', 'put', 'get'], description: 'Что сделать' },
        id: { type: 'string', description: 'id сервера (из list)' },
        command: { type: 'string', description: 'для exec: shell-команда на сервере' },
        remote: { type: 'string', description: 'для put/get: путь на сервере' },
        local: { type: 'string', description: 'для put/get: локальный путь в Termux' },
        timeout: { type: 'integer', description: 'для exec: таймаут сек (по умолчанию 60, макс 300)' },
      },
      required: ['action'],
    },
  },
];

// Маскировка под мобильный Яндекс.Браузер на Android (Poco F5 Pro)
const MOBILE_YA_UA = 'Mozilla/5.0 (Linux; Android 15; 23049PCD8G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 YaBrowser/25.10.6.109.00 Mobile Safari/537.36';

async function webFetch(url) {
  try {
    let u;
    try { u = new URL(String(url || '')); } catch { return { ok: false, output: 'невалидный URL: ' + url }; }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, output: 'поддерживаю только http/https' };
    const r = await fetch(u.href, {
      headers: {
        'user-agent': MOBILE_YA_UA,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    let body = buf.subarray(0, 200000).toString('utf8');
    const ctype = r.headers.get('content-type') || '';
    if (ctype.includes('text/html')) {
      // лёгкая зачистка: script/style/комментарии, чтобы не жечь контекст
      body = body
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
    }
    const head = `HTTP ${r.status} ${r.statusText || ''}\nfinal-url: ${r.url}\ncontent-type: ${ctype}\n\n`;
    return { ok: r.ok, output: trunc(head + body) };
  } catch (e) {
    return { ok: false, output: 'ошибка web_fetch: ' + e.message };
  }
}

// Мост к APK Coting: локальный HTTP 127.0.0.1:8396 (см. ~/coting-app BridgeServer).
const BRIDGE = 'http://127.0.0.1:8396';

async function androidDevice(input) {
  const a = String(input?.action || 'status');
  try {
    let method = 'POST', path = '/' + a, body = {};
    if (a === 'status') { method = 'GET'; path = '/status'; }
    else if (a === 'text') { method = 'GET'; path = '/text'; }
    else if (a === 'screenshot') { method = 'GET'; path = '/screenshot'; }
    else if (a === 'tap') body = { x: input.x | 0, y: input.y | 0, long: !!input.long };
    else if (a === 'swipe') body = { x1: input.x1 | 0, y1: input.y1 | 0, x2: input.x2 | 0, y2: input.y2 | 0, ms: input.ms | 0 };
    else if (['back', 'home', 'recents', 'notifications', 'lock'].includes(a)) body = { name: a };
    else return { ok: false, output: 'неизвестное действие: ' + a };

    const r = await fetch(BRIDGE + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({ ok: false, error: 'нет ответа моста' }));

    if (a === 'status') {
      return {
        ok: true,
        output: 'мост Coting: ' + JSON.stringify(j) + '\n'
          + 'Если a11y:false — открой приложение Coting → «Настроить управление телефоном» и включи сервис. lock требует «прав администратора» (кнопка 🔒 там же).',
      };
    }
    if (!j.ok) return { ok: false, output: j.error || 'мост вернул ошибку' };

    if (a === 'text') return { ok: true, output: String(j.text || '(пусто)') };

    if (a === 'screenshot') {
      // base64 → файл: модели текстовой проще вернуться к пути, а юзер откроет картинку
      const dir = path.join(HOME, 'coting', 'screens');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'screen_' + Date.now() + '.png');
      fs.writeFileSync(f, Buffer.from(j.png_base64, 'base64'));
      return { ok: true, output: `скриншот сохранён: ${f} (${fs.statSync(f).size} байт). Дай путь пользователю или посмотри через read_file (это бинарный PNG).` };
    }

    return { ok: true, output: JSON.stringify(j) };
  } catch (e) {
    return { ok: false, output: 'мост недоступен (:8396). Открой приложение Coting — сервер поднимется при старте. Ошибка: ' + e.message };
  }
}

function trunc(s, n = MAX_OUT) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n… [обрезано, всего ${s.length} символов]` : s;
}

/**
 * Выполнение инструмента.
 * @param cwd дефолтная рабочая директория сессии
 */
function runTool(name, input, cwd) {
  const i = input || {};
  const baseCwd = cwd && fs.existsSync(cwd) ? cwd : HOME;
  try {
    if (name === 'run_command') {
      const cmd = String(i.command || '');
      if (!cmd.trim()) return { ok: false, output: 'пустая команда' };
      const t = Math.min(Math.max(parseInt(i.timeout, 10) || 60, 5), 300);
      const dir = i.cwd ? path.resolve(String(i.cwd)) : baseCwd;
      if (!fs.existsSync(dir)) return { ok: false, output: `нет такой директории: ${dir}` };
      const r = spawnSync('bash', ['-lc', cmd], { cwd: dir, encoding: 'utf8', timeout: t * 1000, maxBuffer: 16 * 1024 * 1024 });
      const out = [
        r.stdout ? `$ ${cmd}\n${trunc(r.stdout)}` : `$ ${cmd}\n(пустой stdout)`,
        r.stderr ? `\n[stderr]\n${trunc(r.stderr, 8000)}` : '',
        `\n[exit ${r.status === null ? 'timeout/signal ' + r.signal : r.status}]`,
      ].join('');
      return { ok: r.status === 0, output: trunc(out) };
    }

    if (name === 'read_file') {
      const p = path.resolve(String(i.path || ''));
      if (!fs.existsSync(p)) return { ok: false, output: `файл не найден: ${p}` };
      const st = fs.statSync(p);
      if (st.isDirectory()) return { ok: false, output: `это директория, а не файл: ${p}` };
      const offset = Math.max(parseInt(i.offset, 10) || 1, 1);
      const limit = Math.min(parseInt(i.limit, 10) || 400, 5000);
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      const part = lines.slice(offset - 1, offset - 1 + limit);
      return { ok: true, output: trunc(`${p} (строк всего ${lines.length})\n` + part.map((l, k) => `${offset + k}: ${l}`).join('\n')) };
    }

    if (name === 'write_file') {
      const p = path.resolve(String(i.path || ''));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(i.content ?? ''), 'utf8');
      return { ok: true, output: `записано ${String(i.content ?? '').length} символов → ${p}` };
    }

    if (name === 'edit_file') {
      const p = path.resolve(String(i.path || ''));
      if (!fs.existsSync(p)) return { ok: false, output: `файл не найден: ${p}` };
      const src = fs.readFileSync(p, 'utf8');
      const oldS = String(i.old_string ?? '');
      const count = src.split(oldS).length - 1;
      if (count === 0) return { ok: false, output: `фрагмент не найден в ${p}` };
      if (count > 1) return { ok: false, output: `фрагмент встречается ${count} раз — уточни и замени` };
      fs.writeFileSync(p, src.replace(oldS, String(i.new_string ?? '')), 'utf8');
      return { ok: true, output: `заменено в ${p}` };
    }

    if (name === 'list_dir') {
      const p = path.resolve(String(i.path || '') || baseCwd);
      if (!fs.existsSync(p)) return { ok: false, output: `нет такой директории: ${p}` };
      const st = fs.statSync(p);
      if (!st.isDirectory()) return { ok: false, output: `не директория: ${p}` };
      const items = fs.readdirSync(p, { withFileTypes: true })
        .map(d => `${d.isDirectory() ? 'd' : '-'} ${d.name}`).sort();
      return { ok: true, output: trunc(`${p}/\n` + items.join('\n')) };
    }

    if (name === 'search_files') {
      const pattern = String(i.pattern || '');
      const where = path.resolve(String(i.path || '') || baseCwd);
      const args = ['-n', '--no-heading', '--color', 'never'];
      if (i.glob) args.push('--glob', String(i.glob));
      args.push(pattern, where);
      const r = spawnSync('rg', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      if (r.error) return { ok: false, output: 'rg недоступен: ' + r.error.message };
      return { ok: true, output: trunc((r.stdout || '(совпадений нет)') + (r.stderr ? `\n[stderr] ${r.stderr}` : '')) };
    }

    return { ok: false, output: `неизвестный инструмент: ${name}` };
  } catch (e) {
    return { ok: false, output: 'ошибка инструмента: ' + e.message };
  }
}

// ---------------- обращение к провайдеру (стрим) ----------------
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Один запрос к провайдеру со стримом. Возвращает собранный content-массив
 * в формате Anthropic (text / thinking / tool_use) и usage — независимо от
 * протокола провайдера (anthropic или openai, сессии всегда anthropic-формат).
 * @param opts {provider, model, system, messages, maxTokens, signal, onDelta}
 */
async function streamMessage(opts) {
  const { provider } = opts;
  if (provider.api === 'openai') return openaiStream(opts);
  return anthropicStream(opts);
}

// ---------- Anthropic Messages (встроенные провайдеры zcode) ----------
async function anthropicStream(opts) {
  const { provider, model, system, messages, maxTokens = 8192, signal, onDelta = () => {} } = opts;
  const resp = await fetch(provider.baseUrl + '/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': provider.apiKey,
      'authorization': 'Bearer ' + provider.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, tools: TOOLS, stream: true }),
    signal,
  });

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    let msg = text.slice(0, 400);
    try { msg = JSON.parse(text)?.error?.message || msg; } catch {}
    const e = new Error(`провайдер ${provider.id}: ${msg || 'HTTP ' + resp.status}`);
    e.status = resp.status;
    throw e;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const blocks = [];
  let usage = null;
  let stopReason = null;

  const handleEvent = ev => {
    switch (ev.type) {
      case 'message_start':
        usage = ev.message?.usage || usage;
        break;
      case 'content_block_start':
        blocks[ev.index] = { ...(ev.content_block || {}) };
        if (blocks[ev.index].type === 'text') blocks[ev.index].text = '';
        break;
      case 'content_block_delta': {
        const b = blocks[ev.index];
        if (!b) break;
        const d = ev.delta || {};
        if (d.type === 'text_delta') {
          b.text = (b.text || '') + (d.text || '');
          onDelta(d.text || '');
        } else if (d.type === 'thinking_delta') {
          b.thinking = (b.thinking || '') + (d.thinking || '');
          onDelta({ thinking: d.thinking || '' });
        } else if (d.type === 'input_json_delta') {
          b._json = (b._json || '') + (d.partial_json || '');
        }
        break;
      }
      case 'message_delta':
        if (ev.usage) usage = { ...(usage || {}), ...ev.usage };
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        break;
      case 'error':
        throw new Error(ev.error?.message || 'ошибка стрима провайдера');
    }
  };

  // Разбор SSE: строки "data: {...}", пустые строки и "event: ..." пропускаем.
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      handleEvent(ev);
    }
  }

  const content = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'tool_use') {
      let input = {};
      try { input = JSON.parse(b._json || '{}'); } catch {}
      content.push({ type: 'tool_use', id: b.id, name: b.name, input });
    } else if (b.type === 'thinking') {
      content.push({ type: 'thinking', thinking: b.thinking || '' });
    } else if (b.type === 'text') {
      if (b.text) content.push({ type: 'text', text: b.text });
    }
  }
  return { content, usage: usage || {}, stopReason: stopReason || 'end_turn' };
}

// ---------- OpenAI-совместимые провайдеры (кастомные) ----------
// История у нас всегда в Anthropic-формате; конвертируем на лету туда и обратно.

function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const calls = m.content.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      if (text || calls.length) out.push(msg);
      continue;
    }
    // user: текст, картинки и/или tool_result-блоки
    const oaParts = [];
    const textParts = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (textParts) oaParts.push({ type: 'text', text: textParts });
    for (const b of m.content) {
      if (b.type === 'image' && b.source?.type === 'base64') {
        oaParts.push({ type: 'image_url', image_url: { url: 'data:' + b.source.media_type + ';base64,' + b.source.data } });
      }
    }
    if (oaParts.length) out.push({ role: 'user', content: oaParts.length === 1 && oaParts[0].type === 'text' ? oaParts[0].text : oaParts });
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content ?? '') });
      }
    }
  }
  return out;
}

const OPENAI_TOOLS = TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

async function openaiStream(opts) {
  const { provider, model, system, messages, maxTokens = 8192, signal, onDelta = () => {} } = opts;
  const resp = await fetch(provider.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + provider.apiKey,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: toOpenAIMessages(system, messages),
      tools: OPENAI_TOOLS,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  });

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '');
    let msg = text.slice(0, 400);
    try { msg = JSON.parse(text)?.error?.message || msg; } catch {}
    const e = new Error(`провайдер ${provider.id}: ${msg || 'HTTP ' + resp.status}`);
    e.status = resp.status;
    throw e;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  const calls = new Map(); // index → {id, name, args}
  let usage = null;
  let stopReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.usage) usage = ev.usage;
      const ch = ev.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) stopReason = ch.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
      const d = ch.delta || {};
      if (d.reasoning_content) onDelta({ thinking: d.reasoning_content });
      if (d.content) {
        text += d.content;
        onDelta(d.content);
      }
      for (const tc of d.tool_calls || []) {
        const c = calls.get(tc.index) || { id: null, name: '', args: '' };
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
        calls.set(tc.index, c);
      }
    }
  }

  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    let input = {};
    try { input = JSON.parse(c.args || '{}'); } catch {}
    content.push({ type: 'tool_use', id: c.id || ('call_' + Math.random().toString(36).slice(2, 10)), name: c.name, input });
  }
  return {
    content,
    usage: { input_tokens: usage?.prompt_tokens || 0, output_tokens: usage?.completion_tokens || 0 },
    stopReason: stopReason || (calls.size ? 'tool_use' : 'end_turn'),
  };
}

// ---------------- remote_server (ssh/sftp/ftp через servers.js) ----------------
function remoteServer(i) {
  try {
    switch (String(i.action || '')) {
      case 'list': {
        const all = servers.list();
        if (!all.length) return { ok: true, output: 'серверов пока нет — добавь в настройках Coting («🖥 Серверы») или скажи пользователю, что нужно добавить аккаунт: host, user, пароль/ключ, тип ssh/sftp/ftp.' };
        return { ok: true, output: all.map(x => `${x.id}  ${x.type}  ${x.user}@${x.host}:${x.port}  ${x.name}`).join('\n') };
      }
      case 'test': {
        if (!i.id) return { ok: false, output: 'укажи id (сначала list)' };
        return servers.testConn(String(i.id));
      }
      case 'exec': {
        if (!i.id || !i.command) return { ok: false, output: 'нужны id и command' };
        return servers.exec(String(i.id), String(i.command), parseInt(i.timeout, 10) || 60);
      }
      case 'put':
      case 'get': {
        if (!i.id || !i.remote || !i.local) return { ok: false, output: 'нужны id, remote и local' };
        return servers.transfer(String(i.id), String(i.action), String(i.remote), String(i.local));
      }
      default:
        return { ok: false, output: 'неизвестное действие: ' + i.action };
    }
  } catch (e) {
    return { ok: false, output: 'remote_server: ' + e.message };
  }
}

// ---------------- системный промпт ----------------
function systemPrompt(cwd) {
  const uname = spawnSync('uname', ['-a'], { encoding: 'utf8' });
  return [
    'Ты — Coting (Котинк), автономный кодинг-агент, работающий в Termux на Android. У тебя есть инструменты: run_command, read_file, write_file, edit_file, list_dir, search_files, web_fetch, android_device, remote_server.',
    'Правила: (1) Не выдумывай содержимое файлов и результаты команд — проверяй инструментами. (2) Действуй сам: выполняй команды, читай и правь файлы, не проси пользователя сделать это за тебя. (3) Отвечай по-русски; код, команды, пути и технические термины — латиницей без перевода. (4) Перед деструктивными действиями (удаление файлов, изменение системных настроек) сделай бэкап затронутого. (5) Пиши кратко и по делу, без воды. Тон дружелюбный, лёгкая кошачья нотка уместна, но код и факты — строго по существу.',
    'Серверы: remote_server подключается к аккаунтам ssh/sftp/ftp пользователя (список — action list, детали в настройках Coting) — выполняй там команды и гоняй файлы, когда он просит что-то настроить на своём сервере/хостинге.'
    + 'Телефон: android_device тапает/свайпает/читает экран/делает скриншоты через приложение Coting — используй его, когда пользователь просит управлять телефоном. Сначала вызови status, чтобы узнать, включены ли accessibility и admin.'
    + 'Интернет: для страниц и API используй web_fetch — он сам ходит под видом мобильного Яндекс.Браузера. Если делаешь сетевые запросы через shell (curl/wget) — ВСЕГДА ставь тот же User-Agent: "' + MOBILE_YA_UA + '" и заголовок Accept-Language: ru-RU,ru;q=0.9.',
    'Окружение:',
    `cwd: ${cwd || HOME}`,
    `home: ${HOME}`,
    `os: Android (Termux), ядро: ${(uname.stdout || '').trim().slice(0, 120)}`,
    `node: ${process.version}`,
    'доступны команды: rg, grep, sed, awk, curl, python3, node, git, bash',
  ].join('\n');
}

// ---------------- основной цикл агента ----------------
/**
 * @param o {providerId, model, messages, cwd, maxSteps, approveCommands, signal,
 *           onEvent, onApproval}
 * onApproval({name, input}) → Promise<boolean>; ждёт решения UI, таймаут снаружи.
 */
async function agentRun(o) {
  const {
    providerId, model, messages, cwd,
    maxSteps = 24,
    approveCommands = false,
    signal,
    onEvent = () => {},
    onApproval = null,
  } = o;

  const provider = getProvider(providerId);
  if (!provider) throw new Error(`провайдер не найден: ${providerId}`);

  const msgs = messages.map(m => ({ role: m.role, content: m.content }));
  const system = systemPrompt(cwd);
  const usageTotal = { input_tokens: 0, output_tokens: 0 };
  const seen = new Set();
  let stepsUsed = 0;

  for (let step = 1; step <= maxSteps; step++) {
    stepsUsed = step;
    let stepRes;
    try {
      stepRes = await streamMessage({
        provider, model, system, messages: msgs, signal,
        onDelta: d => typeof d === 'string'
          ? onEvent({ type: 'delta', text: d })
          : onEvent({ type: 'thinking_delta', text: d.thinking }),
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        return { text: null, messages: msgs, usage: usageTotal, model, steps: stepsUsed, done: false, aborted: true };
      }
      throw e;
    }
    const { content, usage, stopReason } = stepRes;
    usageTotal.input_tokens += usage.input_tokens || 0;
    usageTotal.output_tokens += usage.output_tokens || 0;

    const textParts = content.filter(b => b.type === 'text');
    const text = textParts.map(b => b.text).join('\n');
    const toolUses = content.filter(b => b.type === 'tool_use');

    if (!toolUses.length) {
      if (text) {
        // финальный ответ — в историю, иначе сессия сохранится без ответа ассистента
        msgs.push({ role: 'assistant', content: [{ type: 'text', text }] });
        onEvent({ type: 'text', text });
      }
      return { text: text || '(пустой ответ)', messages: msgs, usage: usageTotal, model, steps: stepsUsed, done: true, stopReason };
    }
    if (text) onEvent({ type: 'text', text });

    msgs.push({ role: 'assistant', content });

    const results = [];
    for (const tu of toolUses) {
      // анти-зацикливание: тот же вызов с теми же аргументами → встречная команда
      const key = tu.name + ':' + JSON.stringify(tu.input || {});
      if (seen.has(key) && seen.size > 4) {
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: 'Этот вызов уже повторялся без изменений — прекрати повтор и ответь по имеющимся данным.',
        });
        continue;
      }
      seen.add(key);
      onEvent({ type: 'tool_start', id: tu.id, name: tu.name, input: tu.input });

      // подтверждение shell-команд пользователем (если включено в UI)
      let allowed = true;
      if (approveCommands && tu.name === 'run_command' && onApproval) {
        allowed = await onApproval({ name: tu.name, input: tu.input });
        if (signal?.aborted) break;
        if (!allowed) {
          onEvent({ type: 'tool_end', id: tu.id, name: tu.name, ok: false, denied: true });
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Команда отклонена пользователем. Продолжай без неё или предложи другой путь.' });
          continue;
        }
      }

      let res;
      if (tu.name === 'web_fetch') res = await webFetch(String(tu.input?.url || ''));
      else if (tu.name === 'android_device') res = await androidDevice(tu.input || {});
      else if (tu.name === 'remote_server') res = remoteServer(tu.input || {});
      else res = runTool(tu.name, tu.input, cwd);
      onEvent({ type: 'tool_end', id: tu.id, name: tu.name, ok: res.ok, output: res.output });
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: (res.ok ? '' : 'ОШИБКА: ') + res.output,
      });
    }
    // tool_result-сообщение пушим всегда: протокол требует пары
    // assistant(tool_use) → user(tool_result), иначе следующий запрос упадёт.
    msgs.push({ role: 'user', content: results });
    if (signal?.aborted) {
      return { text: null, messages: msgs, usage: usageTotal, model, steps: stepsUsed, done: false, aborted: true };
    }
  }

  return {
    text: `Достигнут лимит шагов (${maxSteps}) — остановлен.`,
    messages: msgs, usage: usageTotal, model, steps: stepsUsed, done: false,
  };
}

module.exports = { TOOLS, runTool, streamMessage, agentRun, systemPrompt };
