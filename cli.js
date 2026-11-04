#!/usr/bin/env node
'use strict';
/*
 * cli.js — управление Coting из терминала:
 *   coting provider list                  — все провайдеры (без ключей)
 *   coting provider add <id> <baseUrl> <api> <apiKey> <модели через запятую> [имя]
 *   coting provider del <id>              — удалить кастомный
 *   coting provider test <id>             — мини-запрос к провайдеру
 *
 * api: anthropic | openai
 */
const { allProviders, upsertCustom, deleteCustom, testProvider, getProvider } = require('./config');

const [,, cmd, sub, ...args] = process.argv;

async function main() {
  if (cmd === 'provider' && sub === 'list') {
    const list = allProviders();
    for (const p of list) {
      console.log(`${p.source === 'custom' ? '*' : ' '} ${p.id.padEnd(12)} ${p.api.padEnd(9)} ${String(p.models.length).padStart(2)} модел.  ${p.baseUrl}  ключ …${p.apiKey.slice(-4)}`);
    }
    console.log(`\nвсего: ${list.length} (* = свой)`);
    return;
  }

  if (cmd === 'provider' && sub === 'add') {
    const [id, baseUrl, api, apiKey, models, name] = args;
    if (!id || !baseUrl || !api || !apiKey || !models) {
      console.log('использование: coting provider add <id> <baseUrl> <anthropic|openai> <apiKey> <model1,model2> [имя]');
      process.exit(1);
    }
    const item = upsertCustom({ id, baseUrl, api, apiKey, models, name: name || id });
    console.log('✓ сохранён:', item.id, `(${item.api})`, 'моделей:', item.models.length);
    console.log('  файл: ~/.config/coting/config.json (права 600)');
    return;
  }

  if (cmd === 'provider' && sub === 'del') {
    const [id] = args;
    if (!id) { console.log('использование: coting provider del <id>'); process.exit(1); }
    if (deleteCustom(id)) console.log('✓ удалён:', id);
    else { console.log('✗ нет такого кастомного провайдера:', id); process.exit(1); }
    return;
  }

  if (cmd === 'provider' && sub === 'test') {
    const [id] = args;
    const p = getProvider(id || '');
    if (!p) { console.log('✗ провайдер не найден:', id); process.exit(1); }
    console.log(`тест ${p.id} (${p.api}) модель ${p.models[0]}…`);
    try {
      const r = await testProvider(p);
      console.log(`✓ ${r.ms} мс, ответ: «${r.sample}»`);
    } catch (e) {
      console.log('✗', e.message);
      process.exit(1);
    }
    return;
  }

  console.log([
    'Coting — открытый кодинг-агент для Termux/смартфонов',
    '© 2026 RybinskLab (ИП Усачёв Д.Е.) — https://rybinsklab.ru',
    '',
    'использование:',
    '  coting                      — статус/управление сервером (start|stop|restart|status|log)',
    '  coting provider list        — список провайдеров',
    '  coting provider add <id> <baseUrl> <anthropic|openai> <apiKey> <model1,model2> [имя]',
    '  coting provider del <id>',
    '  coting provider test <id>',
  ].join('\n'));
}

main().catch(e => { console.error('ошибка:', e.message); process.exit(1); });
