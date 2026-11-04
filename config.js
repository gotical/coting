'use strict';
/*
 * config.js — провайдеры Coting.
 *
 * Два источника:
 *   1) встроенные — читаются из ~/.zcode/v2/provider_config.json (zai/alibaba/
 *      gemini/tokenwave, ключи уже там), read-only;
 *   2) кастомные — ~/coting/config.json (chmod 600), управляются через UI
 *      и CLI (`coting provider ...`). Поддерживают два протокола:
 *      api: "anthropic" | "openai".
 *
 * Ключи НИКОГДА не уходят в UI: наружу только маска (последние 4 символа).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CFG_DIR = path.join(os.homedir(), '.config', 'coting');
const CUSTOM_FILE = path.join(CFG_DIR, 'config.json');
const ZCODE_FILE = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');

function readCustom() {
  try {
    return JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8'));
  } catch {
    return { providers: [] };
  }
}

function writeCustom(cfg) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  const tmp = CUSTOM_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CUSTOM_FILE);
  try { fs.chmodSync(CUSTOM_FILE, 0o600); } catch {}
}

// ---------- встроенные (из zcode) ----------
function builtinList() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(ZCODE_FILE, 'utf8')); } catch { return []; }
  const rules = raw?.config?.providerConfigRules?.providerRules || [];
  return rules
    .filter(r => r.providerId && r.config?.access?.apiKey && r.config?.api?.baseUrl)
    .map(r => ({
      id: r.providerId,
      name: r.providerName || r.providerId,
      source: 'builtin',
      api: 'anthropic',
      baseUrl: String(r.config.api.baseUrl).replace(/\/+$/, ''),
      apiKey: r.config.access.apiKey,
      models: r.config.modelOrder?.length ? r.config.modelOrder : (r.config.personalModelIds || []),
    }));
}

// ---------- кастомные ----------
function customList() {
  return (readCustom().providers || []).map((p, k) => ({
    id: p.id || ('custom-' + k),
    name: p.name || p.id,
    source: 'custom',
    api: p.api === 'openai' ? 'openai' : 'anthropic',
    baseUrl: String(p.baseUrl || '').replace(/\/+$/, ''),
    apiKey: p.apiKey || '',
    models: Array.isArray(p.models) ? p.models : [],
  }));
}

function allProviders() {
  const builtins = builtinList();
  const customs = customList().filter(c => c.baseUrl && c.apiKey);
  // кастомный провайдер с тем же id перекрывает встроенный (для смены ключа)
  const byId = new Map();
  for (const p of builtins) byId.set(p.id, p);
  for (const c of customs) byId.set(c.id, { ...byId.get(c.id), ...c, source: c.source });
  return [...byId.values()];
}

function getProvider(id) {
  return allProviders().find(p => p.id === id) || null;
}

function upsertCustom(p) {
  const cfg = readCustom();
  const list = cfg.providers || [];
  const item = {
    id: String(p.id || '').trim() || ('custom-' + Date.now().toString(36)),
    name: String(p.name || p.id || 'свой провайдер'),
    api: p.api === 'openai' ? 'openai' : 'anthropic',
    baseUrl: String(p.baseUrl || '').trim(),
    apiKey: String(p.apiKey || '').trim(),
    models: (Array.isArray(p.models) ? p.models : String(p.models || '').split(','))
      .map(m => String(m).trim()).filter(Boolean),
  };
  if (!item.baseUrl || !item.apiKey || !item.models.length) {
    throw new Error('нужны baseUrl, apiKey и хотя бы одна модель');
  }
  const i = list.findIndex(x => x.id === item.id);
  if (i >= 0) list[i] = item; else list.push(item);
  writeCustom({ providers: list });
  return item;
}

function deleteCustom(id) {
  const cfg = readCustom();
  const list = cfg.providers || [];
  const next = list.filter(x => x.id !== id);
  if (next.length === list.length) return false;
  writeCustom({ providers: next });
  return true;
}

// ---------- наружу (без ключей) ----------
function publicList() {
  let dflt = {};
  try {
    const raw = JSON.parse(fs.readFileSync(ZCODE_FILE, 'utf8'));
    dflt = raw?.config?.defaultModelSelection || {};
  } catch {}
  return {
    providers: allProviders().map(p => ({
      id: p.id,
      name: p.name,
      source: p.source,
      api: p.api,
      models: p.models,
      keyMask: p.apiKey ? '•••' + p.apiKey.slice(-4) : null,
    })),
    defaults: {
      providerId: dflt.providerId || 'zai',
      modelId: dflt.modelId || 'glm-5.3-flash',
    },
  };
}

// ---------- быстрый тест провайдера (мини-запрос) ----------
async function testProvider(p) {
  const isBuiltinLike = !!p.apiKey && !!p.baseUrl;
  if (!isBuiltinLike) {
    const full = getProvider(p.id);
    if (!full) throw new Error('провайдер не найден: ' + p.id);
    p = full;
  }
  const ua = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/141.0.0.0 Mobile Safari/537.36';
  const t0 = Date.now();
  let r, body;
  if (p.api === 'openai') {
    r = await fetch(p.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + p.apiKey, 'user-agent': ua },
      body: JSON.stringify({ model: p.models[0], max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    body = j?.choices?.[0]?.message?.content;
  } else {
    r = await fetch(p.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': p.apiKey,
        'authorization': 'Bearer ' + p.apiKey,
        'anthropic-version': '2023-06-01',
        'user-agent': ua,
      },
      body: JSON.stringify({ model: p.models[0], max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    body = Array.isArray(j?.content) ? j.content.filter(b => b.type === 'text').map(b => b.text).join('') : null;
  }
  const ms = Date.now() - t0;
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200) || r.statusText}`);
  }
  return { ok: true, ms, sample: String(body || '').slice(0, 60) };
}

module.exports = { allProviders, getProvider, upsertCustom, deleteCustom, publicList, testProvider, builtinList, customList, CUSTOM_FILE };
