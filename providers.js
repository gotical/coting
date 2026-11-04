'use strict';
/*
 * providers.js — мульти-провайдер Гефеста.
 *
 * Единственный источник правды — ~/.zcode/v2/provider_config.json, тот же,
 * которым пользуется сам zcode. Ключи читаются оттуда на каждый вызов
 * (конфиг может меняться) и НИКОГДА не отдаются в UI — наружу идёт только
 * список {id, name, models[]}.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CFG_FILE = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Список провайдеров с ключами (для движка). Не логировать, не сериализовать в API!
function listProviders() {
  const raw = readConfig();
  const rules = raw?.config?.providerConfigRules?.providerRules || [];
  return rules
    .filter(r => r.providerId && r.config?.access?.apiKey && r.config?.api?.baseUrl)
    .map(r => ({
      id: r.providerId,
      name: r.providerName || r.providerId,
      baseUrl: String(r.config.api.baseUrl).replace(/\/+$/, ''),
      apiKey: r.config.access.apiKey,
      models: r.config.modelOrder?.length ? r.config.modelOrder : (r.config.personalModelIds || []),
    }));
}

function getProvider(id) {
  return listProviders().find(p => p.id === id) || null;
}

// Что показывать клиенту: без ключей и baseUrl.
function publicList() {
  const dflt = defaults();
  return {
    providers: listProviders().map(p => ({ id: p.id, name: p.name, models: p.models })),
    defaults: dflt,
  };
}

// Выбор по умолчанию из самого zcode-конфига.
function defaults() {
  const raw = readConfig();
  const d = raw?.config?.defaultModelSelection || {};
  return { providerId: d.providerId || 'zai', modelId: d.modelId || 'glm-5.3-flash' };
}

module.exports = { listProviders, getProvider, publicList, defaults };
