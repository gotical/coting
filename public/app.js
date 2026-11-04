'use strict';
/*
 * app.js — клиент Coting (стиль ChatGPT Android + котики).
 * Транспорт: POST /api/chat + SSE через ReadableStream (EventSource не умеет POST).
 * События сервера: start, delta, text, tool_start, tool_end, approval,
 * approval_timeout, done, error.
 */
(() => {
  const $ = id => document.getElementById(id);
  const messagesEl = $('messages'), inputEl = $('input'), sendBtn = $('send-btn'), stopBtn = $('stop-btn');

  const state = {
    sessionId: localStorage.getItem('coting.sid') || null,
    providerId: localStorage.getItem('coting.provider') || null,
    model: localStorage.getItem('coting.model') || null,
    cwd: localStorage.getItem('coting.cwd') || '',
    approve: localStorage.getItem('coting.approve') === '1',
    providers: [],
    generating: false,
    runId: null,
    abortCtl: null,
  };


  // ---------------- SVG-иконки (Feather-стиль) ----------------
  const svgWrap = (inner, fill) =>
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="' + (fill ? 'currentColor' : 'none') +
    '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';

  const I = {
    menu:   '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    plus:   '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    clock:  '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    gear:   '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    x:      '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    eye:    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><line x1="3" y1="3" x2="21" y2="21"/>',
    chev:   '<polyline points="6 9 12 15 18 9"/>',
    up:     '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
    stop:   '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    edit:   '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    terminal:'<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    file:   '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    globe:  '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    phone:  '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
    server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
    link:   '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    trash:  '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    alert:  '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    lock:   '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    cat:    '<path d="M5.5 10.5 L5.5 4.5 L10 7.5 A7 7 0 0 1 14 7.5 L18.5 4.5 L18.5 10.5 A6.5 6.5 0 1 1 5.5 10.5 Z"/><line x1="9.2" y1="12.5" x2="9.2" y2="12.6"/><line x1="14.8" y1="12.5" x2="14.8" y2="12.6"/><path d="M10.5 16.5 q1.5 1.2 3 0"/>',
    clip:   '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    catFill:'<path fill="currentColor" stroke="none" d="M5 10 L5 4 L10.2 7.2 A7 7 0 0 1 13.8 7.2 L19 4 L19 10 A7 7 0 1 1 5 10 Z"/>',
  };
  const ic = (name, size) => {
    const s = size || 18;
    return svgWrap(I[name], name === 'catFill').replace('width="18" height="18"', 'width="' + s + '" height="' + s + '"');
  };
  const toolIcon = name => ({
    run_command: 'terminal', read_file: 'file', write_file: 'edit', edit_file: 'edit',
    list_dir: 'folder', search_files: 'search', web_fetch: 'globe',
    android_device: 'phone', remote_server: 'server',
  }[name] || 'terminal');

  // расстановка иконок в статике
  const setIcon = (id, name, size) => { const el = $(id); if (el) el.innerHTML = ic(name, size); };
  setIcon('menu-btn', 'menu', 22);
  setIcon('attach-btn', 'clip', 20);
  setIcon('new-chat-btn', 'edit', 20);
  setIcon('send-btn', 'up', 20);
  setIcon('stop-btn', 'stop', 18);
  document.querySelectorAll('.drawer .iconbtn, .sheet .iconbtn').forEach(b => { b.innerHTML = ic('x', 20); });
  const drawerBtns = [
    ['new-chat', 'plus', 'Новый чат'],
    ['open-sessions', 'clock', 'История чатов'],
    ['open-settings', 'gear', 'Настройки'],
    ['open-providers', 'link', 'Провайдеры и аккаунты'],
    ['open-servers', 'server', 'Серверы и хостинги (SSH/FTP)'],
  ];
  for (const [id, icon, label] of drawerBtns) {
    const b = $(id);
    if (b) b.innerHTML = ic(icon, 18) + '<span>' + label + '</span>';
  }
  const chev = document.querySelector('.brand-select .chev');
  if (chev) chev.innerHTML = ic('chev', 14);
  const wc = document.querySelector('.welcome-cat');
  if (wc) wc.innerHTML = ic('catFill', 64);
  const si = document.querySelector('.search-wrap input');
  if (si) si.placeholder = 'Поиск по всем чатам…';

  // ---------------- утилиты ----------------
  let toastTimer = null;
  function toast(text, ms = 2600) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function md(text) {
    try {
      const html = marked.parse(text, { gfm: true, breaks: true, mangle: false, headerIds: false });
      return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
    } catch {
      return '<p>' + esc(text) + '</p>';
    }
  }

  function highlight(el) {
    el.querySelectorAll('pre code').forEach(b => {
      if (b.dataset.hl) return;
      try { hljs.highlightElement(b); b.dataset.hl = '1'; } catch {}
    });
  }

  function addCopyButtons(container) {
    container.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('.code-copy')) return;
      const btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.textContent = 'копировать';
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(pre.querySelector('code')?.textContent || pre.textContent)
          .then(() => { btn.textContent = '✓'; setTimeout(() => { btn.textContent = 'копировать'; }, 1200); })
          .catch(() => toast('не удалось скопировать'));
      });
      pre.appendChild(btn);
    });
  }

  function userMsg(text, atts) {
    hideWelcome();
    const div = document.createElement('div');
    div.className = 'msg user';
    let html = '';
    if (atts) {
      for (const a of atts) {
        if (a.type === 'image') html += `<img src="data:${a.mediaType};base64,${a.base64}" class="u-img" alt="">`;
        else html += `<span class="u-file">${esc(a.name || 'файл')}</span> `;
      }
    }
    if (text) html += esc(text).replace(/\n/g, '<br>');
    div.innerHTML = html;
    messagesEl.appendChild(div);
    return div;
  }

  // группа ответа: аватар-котик слева + колонка контента
  function assistantGroup() {
    hideWelcome();
    const g = document.createElement('div');
    g.className = 'assistant-group';
    const av = document.createElement('div');
    av.className = 'cat-avatar';
    av.innerHTML = ic('catFill', 17);
    const col = document.createElement('div');
    col.className = 'assistant-col';
    g.appendChild(av);
    g.appendChild(col);
    messagesEl.appendChild(g);
    return col;
  }

  function textSegment(col, html) {
    const div = document.createElement('div');
    div.className = 'msg-content';
    div.innerHTML = html;
    col.appendChild(div);
    highlight(div);
    addCopyButtons(div);
    return div;
  }

  function hideWelcome() { const w = $('welcome'); if (w) w.remove(); }

  // клик по любой картинке в чате → сохранить в Download телефона
  messagesEl.addEventListener('click', async ev => {
    const img = ev.target.closest('img');
    if (!img || !img.src || state.generating) return;
    try {
      const r = await fetch('/api/save_image', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: img.src }),
      });
      const j = await r.json();
      toast(j.ok ? '✓ сохранено: ' + j.file.replace(/^.*\/storage\//, 'Download/') : '✗ ' + j.error);
    } catch { toast('не удалось сохранить'); }
  });

  let stickBottom = true;
  messagesEl.addEventListener('scroll', () => {
    stickBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
  });
  function scrollBottom(force) {
    if (force || stickBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  const toolLabel = (name, input) => {
    const i = input || {};
    if (name === 'run_command') return i.command || '';
    if (name === 'read_file' || name === 'write_file' || name === 'edit_file') return i.path || '';
    if (name === 'list_dir') return i.path || '.';
    if (name === 'search_files') return i.pattern || '';
    return JSON.stringify(i).slice(0, 80);
  };

  function toolCard(name, input) {
    const t = document.createElement('div');
    t.className = 'tool open';
    const head = document.createElement('div');
    head.className = 'tool-head';
    head.innerHTML = `<span class="t-ic">${ic(toolIcon(name), 14)}</span><span class="t-name">${esc(name)}</span><span class="t-arg">${esc(toolLabel(name, input))}</span><span class="t-status run">…</span>`;
    const body = document.createElement('div');
    body.className = 'tool-body';
    body.innerHTML = '<pre>' + esc(JSON.stringify(input, null, 2).slice(0, 4000)) + '</pre>';
    head.addEventListener('click', () => t.classList.toggle('open'));
    t.appendChild(head);
    t.appendChild(body);
    return { el: t, statusEl: head.querySelector('.t-status'), bodyEl: body.querySelector('pre'), input, name };
  }

  // ---------------- вложения (картинки и файлы) ----------------
  const pending = []; // {type:'image', mediaType, base64, name} | {type:'text', text, name}

  function renderChips() {
    const box = $('attach-chips');
    box.innerHTML = '';
    box.hidden = !pending.length;
    for (const [i, a] of pending.entries()) {
      const chip = document.createElement('div');
      chip.className = 'chip-a';
      if (a.type === 'image') {
        chip.innerHTML = `<img src="data:${a.mediaType};base64,${a.base64}" alt="">`;
      } else {
        chip.innerHTML = `<span class="c-name">${esc(a.name || 'файл')}</span>`;
      }
      const del = document.createElement('button');
      del.className = 'c-del'; del.textContent = '×';
      del.addEventListener('click', () => { pending.splice(i, 1); renderChips(); });
      chip.appendChild(del);
      box.appendChild(chip);
    }
  }

  $('attach-btn').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', () => {
    for (const f of $('file-input').files) {
      if (f.type.startsWith('image/')) {
        const r = new FileReader();
        r.onload = () => {
          pending.push({ type: 'image', mediaType: f.type, base64: String(r.result).slice(String(r.result).indexOf(',') + 1), name: f.name });
          renderChips();
        };
        r.readAsDataURL(f);
      } else if (f.size <= 300 * 1024) {
        const r = new FileReader();
        r.onload = () => { pending.push({ type: 'text', text: String(r.result).slice(0, 80000), name: f.name }); renderChips(); };
        r.readAsText(f);
      } else {
        toast(f.name + ': файл > 300 КБ — прикрепи текстом покороче');
      }
    }
    $('file-input').value = '';
  });

  // ---------------- чат: отправка и стрим ----------------
  function setGenerating(on) {
    state.generating = on;
    sendBtn.hidden = on;
    stopBtn.hidden = !on;
    if (!on) setWork(null);
  }

  // статус действий как у «больших» агентов: что кот делает прямо сейчас
  function humanTool(name, input) {
    const i = input || {};
    const host = (() => { try { return new URL(i.url).hostname; } catch { return i.url || ''; } })();
    switch (name) {
      case 'run_command': return 'выполняет: ' + (i.command || '').slice(0, 60);
      case 'read_file': return 'читает ' + (i.path || '').split('/').pop();
      case 'write_file': return 'создаёт ' + (i.path || '').split('/').pop();
      case 'edit_file': return 'правит ' + (i.path || '').split('/').pop();
      case 'list_dir': return 'смотрит папку ' + (i.path || '.').split('/').pop();
      case 'search_files': return 'ищет: ' + (i.pattern || '');
      case 'web_fetch': return 'лазает по интернету: ' + host;
      case 'android_device': return 'управляет телефоном: ' + (i.action || '');
      case 'remote_server': return 'сервер ' + (i.id || '') + ': ' + (i.action || '');
      default: return name;
    }
  }
  function setWork(text) {
    const w = $('workline');
    if (!w) return;
    if (!text) { w.hidden = true; return; }
    w.innerHTML = ic('chev', 12) + ' ' + esc(text);
    w.hidden = false;
  }

  async function send() {
    const text = inputEl.value.trim();
    if (!text || state.generating) return;
    inputEl.value = '';
    autoResize();
    userMsg(text, pending.slice());
    scrollBottom(true);

    if (!state.sessionId) {
      try {
        const r = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd: state.cwd || null, provider: state.providerId, model: state.model, approveCommands: state.approve }),
        });
        const s = await r.json();
        state.sessionId = s.id;
        localStorage.setItem('coting.sid', s.id);
      } catch {
        messagesEl.appendChild(errBox('не удалось создать сессию'));
        return;
      }
    }

    const col = assistantGroup();
    const working = document.createElement('div');
    working.className = 'working';
    working.innerHTML = '<span class="dots"><span></span><span></span><span></span></span> кот думает…';
    col.appendChild(working);
    scrollBottom(true);

    let curTextEl = null, curText = '', renderTimer = null;

    const finalizeSegment = () => {
      clearTimeout(renderTimer);
      renderTimer = null;
      if (curTextEl) { highlight(curTextEl); addCopyButtons(curTextEl); curTextEl = null; curText = ''; }
    };

    const ensureTextEl = () => {
      if (!curTextEl) {
        working.remove();
        curTextEl = document.createElement('div');
        curTextEl.className = 'msg-content';
        curText = '';
        col.appendChild(curTextEl);
      }
    };

    const scheduleRender = () => {
      if (renderTimer) return;
      renderTimer = setTimeout(() => {
        renderTimer = null;
        if (curTextEl) {
          curTextEl.innerHTML = md(curText);
          scrollBottom();
        }
      }, 90);
    };

    const toolBlocks = new Map();
    let thinkEl = null, thinkBody = null, thinkLen = 0;

    const ensureThinking = () => {
      if (thinkEl) return;
      working.remove();
      thinkEl = document.createElement('div');
      thinkEl.className = 'thinking';
      const head = document.createElement('div');
      head.className = 'th-head';
      head.innerHTML = ic('chev', 12) + '<span>Размышления</span><span class="th-len"></span>';
      head.addEventListener('click', () => thinkEl.classList.toggle('open'));
      thinkBody = document.createElement('pre');
      thinkBody.className = 'th-body';
      thinkEl.appendChild(head); thinkEl.appendChild(thinkBody);
      col.appendChild(thinkEl);
    };
    const addThinking = t => {
      ensureThinking();
      thinkLen += t.length;
      thinkBody.textContent += t;
      thinkEl.querySelector('.th-len').textContent = '· ' + thinkLen + ' симв.';
      scrollBottom();
    };

    const onEvent = ev => {
      switch (ev.type) {
        case 'start':
          state.runId = ev.runId;
          break;
        case 'delta':
          ensureTextEl();
          curText += ev.text;
          scheduleRender();
          break;
        case 'thinking_delta':
          addThinking(ev.text);
          break;
        case 'tool_start': {
          finalizeSegment();
          working.remove();
          setWork(humanTool(ev.name, ev.input));
          const tb = toolCard(ev.name, ev.input);
          col.appendChild(tb.el);
          toolBlocks.set(ev.id, tb);
          scrollBottom();
          break;
        }
        case 'tool_end': {
          setWork(null);
          const tb = toolBlocks.get(ev.id);
          if (!tb) break;
          // diff для правок: что удалил и что добавил
          if (tb.name === 'edit_file' && tb.input && typeof tb.input.old_string === 'string') {
            const rows = [];
            for (const l of tb.input.old_string.split('\n')) rows.push('<span class="d-del">− ' + esc(l) + '</span>');
            for (const l of String(tb.input.new_string ?? '').split('\n')) rows.push('<span class="d-add">+ ' + esc(l) + '</span>');
            tb.bodyEl.innerHTML = rows.join('\n');
            scrollBottom();
            break;
          }
          if (ev.denied) {
            tb.statusEl.textContent = 'отклонено';
            tb.statusEl.className = 't-status fail';
          } else {
            tb.statusEl.textContent = ev.ok ? '✓' : '✗';
            tb.statusEl.className = 't-status ' + (ev.ok ? 'ok' : 'fail');
            if (typeof ev.output === 'string') {
              tb.bodyEl.textContent = JSON.stringify(tb.input, null, 2).slice(0, 2000) + '\n─── вывод ───\n' + ev.output;
            }
            tb.el.classList.remove('open');
          }
          scrollBottom();
          break;
        }
        case 'approval': {
          finalizeSegment();
          working.remove();
          const a = document.createElement('div');
          a.className = 'approval';
          a.innerHTML = `<div>${ic('shield', 15)} Кот просит выполнить команду:</div><div class="cmd">${esc(ev.input?.command || JSON.stringify(ev.input))}</div>`;
          const actions = document.createElement('div');
          actions.className = 'actions';
          const allow = document.createElement('button');
          allow.className = 'allow'; allow.textContent = 'Разрешить';
          const deny = document.createElement('button');
          deny.className = 'deny'; deny.textContent = 'Отклонить';
          const decide = ok => {
            allow.disabled = deny.disabled = true;
            a.style.opacity = '0.6';
            fetch('/api/approve', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ runId: state.runId, allow: ok }),
            }).catch(() => {});
          };
          allow.addEventListener('click', () => decide(true));
          deny.addEventListener('click', () => decide(false));
          actions.appendChild(allow); actions.appendChild(deny);
          a.appendChild(actions);
          col.appendChild(a);
          scrollBottom(true);
          break;
        }
        case 'done':
          finalizeSegment();
          working.remove();
          if (!curTextEl && !toolBlocks.size && ev.text) textSegment(col, md(ev.text));
          break;
        case 'error': {
          finalizeSegment();
          working.remove();
          col.appendChild(errBox(ev.message || 'ошибка'));
          break;
        }
      }
    };

    setGenerating(true);
    state.abortCtl = new AbortController();
    let streamError = null;

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.sessionId,
          message: text,
          attachments: pending.slice(),
          provider: state.providerId,
          model: state.model,
          approveCommands: state.approve,
          cwd: state.cwd || null,
        }),
        signal: state.abortCtl.signal,
      });

      if (!resp.ok || !resp.body) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || 'HTTP ' + resp.status);
      }
      pending.length = 0;
      renderChips();

      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try { onEvent(JSON.parse(line.slice(5).trim())); } catch {}
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        finalizeSegment();
        streamError = null; // «Остановлено» не рисуем — юзер сам нажал
      } else {
        streamError = e.message || 'сетевая ошибка';
      }
    }

    finalizeSegment();
    working.remove();
    if (streamError) col.appendChild(errBox(streamError));
    if (!col.children.length) textSegment(col, '<span style="color:var(--text-muted)">(пустой ответ)</span>');
    setGenerating(false);
    state.runId = null;
    state.abortCtl = null;
    scrollBottom();
    refreshChip();
  }

  function errBox(msg) {
    const div = document.createElement('div');
    div.className = 'msg error';
    div.innerHTML = ic('alert', 15) + ' ' + esc(msg);
    return div;
  }

  function stop() {
    if (!state.generating) return;
    if (state.runId) {
      fetch('/api/chat/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: state.runId }),
      }).catch(() => {});
    }
    state.abortCtl?.abort();
  }

  // ---------------- панели ----------------
  function closeAll() {
    $('drawer').classList.remove('open');
    for (const id of ['model-sheet', 'sessions-sheet', 'settings-sheet', 'providers-sheet', 'servers-sheet']) $(id).hidden = true;
  }

  $('menu-btn').addEventListener('click', () => {
    $('drawer-info').textContent = `папка: ${state.cwd || 'домашняя'}\nподтверждение команд: ${state.approve ? 'вкл' : 'выкл'}`;
    $('drawer').classList.add('open');
  });
  $('drawer-close').addEventListener('click', closeAll);
  $('sheet-close').addEventListener('click', closeAll);
  $('sessions-close').addEventListener('click', closeAll);
  $('settings-close').addEventListener('click', closeAll);

  function newChat() {
    state.sessionId = null;
    localStorage.removeItem('coting.sid');
    closeAll();
    messagesEl.innerHTML = `<div id="welcome" class="welcome">
      <div class="welcome-cat">🐱</div><h1>Coting</h1>
      <p class="tagline">Кодинг-кот в Termux. Мяу!</p>
      <p class="hint">Новый чат готов. Опиши задачу.</p></div>`;
  }

  $('new-chat').addEventListener('click', newChat);
  $('new-chat-btn').addEventListener('click', newChat);
  $('open-sessions').addEventListener('click', () => { closeAll(); openSessions(); });
  $('open-settings').addEventListener('click', () => { closeAll(); $('settings-sheet').hidden = false; });
  $('open-providers').addEventListener('click', () => { closeAll(); openProviders(); });
  $('providers-close').addEventListener('click', closeAll);
  $('open-servers').addEventListener('click', () => { closeAll(); openServers(); });
  $('zip-project').addEventListener('click', async () => {
    closeAll();
    const dir = state.cwd || '/data/data/com.termux/files/home';
    toast('архивирую ' + dir.split('/').pop() + '…');
    try {
      const r = await fetch('/api/zip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: dir }),
      });
      const j = await r.json();
      if (j.ok) toast('📦 готово: Download/' + j.file.split('/').pop() + ' (' + Math.round(j.bytes / 1024) + ' КБ)', 5000);
      else toast('✗ ' + j.error);
    } catch { toast('ошибка архивации'); }
  });
  $('servers-close').addEventListener('click', closeAll);
  $('ns-eye').addEventListener('click', () => {
    const k = $('ns-secret');
    k.type = k.type === 'password' ? 'text' : 'password';
    $('ns-eye').innerHTML = ic(k.type === 'password' ? 'eye' : 'eyeOff', 16);
  });
  setIcon('ns-eye', 'eye', 16);
  $('model-chip').addEventListener('click', () => { closeAll(); openModelSheet(); });

  async function openSessions() {
    $('sessions-sheet').hidden = false;
    $('search-input').value = '';
    renderSessions(null);
  }

  async function renderSessions(filter) {
    const box = $('sessions-list');
    box.innerHTML = '<div class="provider-label">загрузка…</div>';
    try {
      let sessions;
      if (filter && filter.trim()) {
        const r = await fetch('/api/search?q=' + encodeURIComponent(filter.trim()));
        const { results } = await r.json();
        sessions = results;
        box.innerHTML = '';
        if (!sessions.length) {
          box.innerHTML = '<div class="provider-label">ничего не найдено</div>';
          return;
        }
        for (const s of sessions) {
          const item = sessionItem(s, s.snippet);
          box.appendChild(item);
        }
        return;
      }
      const r = await fetch('/api/sessions');
      const { sessions: list } = await r.json();
      sessions = list;
      box.innerHTML = '';
      if (!sessions.length) {
        box.innerHTML = '<div class="provider-label">пока пусто — кот ждёт первую задачу 🐾</div>';
        return;
      }
      for (const s of sessions) box.appendChild(sessionItem(s, null));
    } catch {
      box.innerHTML = '<div class="provider-label">ошибка загрузки</div>';
    }
  }

  function sessionItem(s, snippet) {
    const d = new Date(s.updated);
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === state.sessionId ? ' selected' : '');
    item.innerHTML = `<div style="flex:1;min-width:0"><span class="s-title">${esc(s.title)}</span>` +
      (snippet ? `<div class="s-snippet">${esc(snippet)}</div>` : '') +
      `</div><span class="s-meta">${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span><button class="s-del" title="Удалить">${ic('trash', 15)}</button>`;
    item.querySelector('.s-title').addEventListener('click', () => openSession(s.id));
    if (snippet) item.querySelector('.s-snippet').addEventListener('click', () => openSession(s.id));
    item.querySelector('.s-meta').addEventListener('click', () => openSession(s.id));
    item.querySelector('.s-del').addEventListener('click', async ev => {
      ev.stopPropagation();
      await fetch('/api/sessions/' + s.id, { method: 'DELETE' });
      if (s.id === state.sessionId) {
        state.sessionId = null;
        localStorage.removeItem('coting.sid');
      }
      renderSessions($('search-input').value);
      toast('чат удалён');
    });
    return item;
  }

  async function openSession(id) {
    try {
      const r = await fetch('/api/sessions/' + id);
      if (!r.ok) throw new Error();
      const s = await r.json();
      state.sessionId = s.id;
      localStorage.setItem('coting.sid', s.id);
      state.cwd = s.cwd || '';
      state.approve = !!s.approveCommands;
      localStorage.setItem('coting.cwd', state.cwd);
      localStorage.setItem('coting.approve', state.approve ? '1' : '0');
      $('cwd-input').value = state.cwd;
      $('approve-toggle').checked = state.approve;
      if (s.provider) { state.providerId = s.provider; localStorage.setItem('coting.provider', s.provider); }
      if (s.model) { state.model = s.model; localStorage.setItem('coting.model', s.model); }

      closeAll();
      messagesEl.innerHTML = '';

      // выводы инструментов лежат в user-сообщениях (tool_result) — собираем map
      const outputs = new Map();
      for (const m of s.messages) {
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b.type === 'tool_result') outputs.set(b.tool_use_id, String(b.content || ''));
          }
        }
      }

      let col = null;
      const ensureCol = () => { if (!col) col = assistantGroup(); return col; };

      const renderImage = src => {
        const img = document.createElement('img');
        img.src = src;
        img.className = 'c-img';
        img.title = 'нажми — сохранить в Download';
        ensureCol().appendChild(img);
      };
      for (const m of s.messages) {
        if (typeof m.content === 'string') {
          if (m.role === 'user') { userMsg(m.content); col = null; }
          else textSegment(ensureCol(), md(m.content));
          continue;
        }
        for (const b of m.content) {
          if (b.type === 'text' && b.text) {
            textSegment(ensureCol(), md(b.text));
          } else if (b.type === 'image' && b.source?.data) {
            renderImage('data:' + (b.source.media_type || 'image/png') + ';base64,' + b.source.data);
          } else if (b.type === 'thinking' && b.thinking) {
            const t = document.createElement('div');
            t.className = 'thinking';
            t.innerHTML = `<div class="th-head">${ic('chev', 12)}<span>Размышления</span><span class="th-len">· ${b.thinking.length} симв.</span></div><pre class="th-body"></pre>`;
            t.querySelector('.th-body').textContent = b.thinking;
            t.querySelector('.th-head').addEventListener('click', () => t.classList.toggle('open'));
            ensureCol().appendChild(t);
          } else if (b.type === 'tool_use') {
            const tb = toolCard(b.name, b.input);
            const out = outputs.get(b.id);
            tb.statusEl.textContent = out == null ? '?' : '✓';
            tb.statusEl.className = 't-status ' + (out == null ? 'fail' : 'ok');
            if (out != null) {
              tb.bodyEl.textContent = JSON.stringify(b.input, null, 2).slice(0, 2000) + '\n─── вывод ───\n' + out;
            }
            tb.el.classList.remove('open');
            ensureCol().appendChild(tb.el);
          }
        }
        // assistant-блоки кончились — следующее user-сообщение начнёт новую группу
        if (m.role === 'assistant') col = null;
      }
      refreshChip();
      scrollBottom(true);
    } catch {
      toast('не удалось открыть чат');
    }
  }

  // ---------------- серверы и хостинги ----------------
  async function openServers() {
    $('servers-sheet').hidden = false;
    await renderServers();
  }

  async function renderServers() {
    const box = $('servers-list');
    box.innerHTML = '<div class="provider-label">загрузка…</div>';
    try {
      const r = await fetch('/api/servers');
      const { servers } = await r.json();
      box.innerHTML = '';
      if (!servers.length) {
        box.innerHTML = '<div class="provider-label">пока пусто — добавь VPS/хостинг ниже</div>';
        return;
      }
      for (const sv of servers) {
        const item = document.createElement('div');
        item.className = 'provider-item';
        item.innerHTML =
          `<div class="pi-row"><span class="pi-name">${esc(sv.name)}</span><span class="pi-badge custom">${sv.type}</span></div>` +
          `<div class="pi-meta">${sv.user}@${esc(sv.host)}:${sv.port} · ${sv.secretMask}</div>`;
        const actions = document.createElement('div');
        actions.className = 'pi-actions';
        const test = document.createElement('button');
        test.className = 'btn-ghost'; test.textContent = 'Проверить';
        test.addEventListener('click', async () => {
          test.disabled = true; test.textContent = '…';
          try {
            const rr = await fetch('/api/servers/test', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: sv.id }),
            });
            const j = await rr.json();
            toast((j.ok ? '✓ связь есть' : '✗ ' + (j.output || 'ошибка')).slice(0, 80));
          } catch { toast('ошибка проверки'); }
          test.disabled = false; test.textContent = 'Проверить';
        });
        const del = document.createElement('button');
        del.className = 'btn-ghost danger'; del.textContent = 'Удалить';
        del.addEventListener('click', async () => {
          await fetch('/api/servers/' + sv.id, { method: 'DELETE' });
          toast('сервер удалён');
          renderServers();
        });
        actions.appendChild(test); actions.appendChild(del);
        item.appendChild(actions);
        box.appendChild(item);
      }
    } catch {
      box.innerHTML = '<div class="provider-label">ошибка загрузки</div>';
    }
  }

  function serverPayload() {
    return {
      id: $('ns-name').value.trim().toLowerCase().replace(/[^\w-]+/g, '-') || undefined,
      name: $('ns-name').value.trim() || $('ns-host').value.trim() || 'сервер',
      type: $('ns-type').value,
      host: $('ns-host').value.trim(),
      port: $('ns-port').value.trim() || undefined,
      user: $('ns-user').value.trim() || 'root',
      auth: $('ns-secret').value.trim().startsWith('/') ? 'key' : 'password',
      secret: $('ns-secret').value.trim(),
    };
  }

  $('ns-test').addEventListener('click', async () => {
    const st = $('ns-status');
    st.hidden = false; st.className = 'np-status'; st.textContent = 'сохраняю и проверяю…';
    try {
      // сначала сохранить (тест идёт по id)
      const r = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(serverPayload()),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'ошибка сохранения');
      const rr = await fetch('/api/servers/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: j.server.id }),
      });
      const res = await rr.json();
      st.textContent = res.ok ? '✓ связь есть: ' + String(res.output).split('\n').slice(0, 2).join(' · ') : '✗ ' + (res.output || 'нет связи');
      st.classList.add(res.ok ? 'ok' : 'fail');
      renderServers();
    } catch (e) {
      st.textContent = '✗ ' + e.message;
      st.classList.add('fail');
    }
  });

  $('ns-save').addEventListener('click', async () => {
    const st = $('ns-status');
    st.hidden = false; st.className = 'np-status';
    try {
      const r = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(serverPayload()),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'ошибка сохранения');
      st.textContent = '✓ сохранён: ' + j.server.id;
      st.classList.add('ok');
      $('ns-secret').value = '';
      await renderServers();
      toast('сервер добавлен: ' + j.server.id);
    } catch (e) {
      st.textContent = '✗ ' + e.message;
      st.classList.add('fail');
    }
  });

  // ---------------- выбор модели ----------------
  function refreshChip() {
    const p = state.providers.find(p => p.id === state.providerId);
    document.querySelector('.brand-select .chev').title = (p?.name || '—') + ' · ' + (state.model || '—');
  }

  async function reloadProviders() {
    try {
      const r = await fetch('/api/providers');
      const d = await r.json();
      state.providers = d.providers;
      if (!state.providers.find(p => p.id === state.providerId)) {
        state.providerId = d.defaults.providerId;
        state.model = d.defaults.modelId;
      }
      refreshChip();
    } catch {}
  }

  function openModelSheet() {
    const box = $('model-list');
    box.innerHTML = '';
    for (const p of state.providers) {
      const lbl = document.createElement('div');
      lbl.className = 'provider-label';
      lbl.textContent = p.name + (p.source === 'custom' ? ' · свой' : '') + ' (' + p.api + ')';
      box.appendChild(lbl);
      for (const m of p.models) {
        const item = document.createElement('div');
        item.className = 'model-item' + (p.id === state.providerId && m === state.model ? ' selected' : '');
        item.textContent = m;
        item.addEventListener('click', () => {
          state.providerId = p.id;
          state.model = m;
          localStorage.setItem('coting.provider', p.id);
          localStorage.setItem('coting.model', m);
          refreshChip();
          closeAll();
          toast(p.name + ' · ' + m);
        });
        box.appendChild(item);
      }
    }
    $('model-sheet').hidden = false;
  }

  // ---------------- провайдеры и аккаунты ----------------
  async function openProviders() {
    $('providers-sheet').hidden = false;
    await renderProviders();
  }

  async function renderProviders() {
    const box = $('providers-list');
    box.innerHTML = '<div class="provider-label">загрузка…</div>';
    try {
      const r = await fetch('/api/providers');
      const d = await r.json();
      state.providers = d.providers;
      box.innerHTML = '';
      for (const p of d.providers) {
        const item = document.createElement('div');
        item.className = 'provider-item';
        const badge = p.source === 'custom' ? 'свой' : 'zcode';
        item.innerHTML =
          `<div class="pi-row"><span class="pi-name">${esc(p.name)}</span><span class="pi-badge ${p.source}">${badge}</span></div>` +
          `<div class="pi-meta">${p.id} · ${p.api} · ${p.keyMask || 'нет ключа'} · моделей: ${p.models.length}</div>`;
        if (p.source === 'custom') {
          const actions = document.createElement('div');
          actions.className = 'pi-actions';
          const test = document.createElement('button');
          test.className = 'btn-ghost'; test.textContent = 'Проверить';
          test.addEventListener('click', () => runProviderTest({ id: p.id }, test));
          const del = document.createElement('button');
          del.className = 'btn-ghost danger'; del.textContent = 'Удалить';
          del.addEventListener('click', async () => {
            await fetch('/api/providers/' + p.id, { method: 'DELETE' });
            toast('провайдер удалён');
            renderProviders();
          });
          actions.appendChild(test); actions.appendChild(del);
          item.appendChild(actions);
        }
        box.appendChild(item);
      }
    } catch {
      box.innerHTML = '<div class="provider-label">ошибка загрузки</div>';
    }
  }

  async function runProviderTest(payload, btn) {
    const st = $('np-status');
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    st.hidden = false;
    st.textContent = 'проверяю…';
    st.className = 'np-status';
    try {
      const r = await fetch('/api/providers/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j.ok) {
        st.textContent = `✓ отвечает, ${j.ms} мс — «${j.sample || '…'}»`;
        st.classList.add('ok');
      } else {
        st.textContent = '✗ ' + (j.error || 'не отвечает');
        st.classList.add('fail');
      }
    } catch (e) {
      st.textContent = '✗ ' + e.message;
      st.classList.add('fail');
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Проверить'; }
  }

  function formPayload() {
    return {
      id: $('np-name').value.trim().toLowerCase().replace(/[^\w-]+/g, '-') || undefined,
      name: $('np-name').value.trim() || 'свой провайдер',
      api: $('np-api').value,
      baseUrl: $('np-url').value.trim(),
      apiKey: $('np-key').value.trim(),
      models: $('np-models').value,
    };
  }

  $('np-test').addEventListener('click', () => runProviderTest(formPayload(), $('np-test')));
  $('np-save').addEventListener('click', async () => {
    const pl = formPayload();
    const st = $('np-status');
    st.hidden = false; st.className = 'np-status';
    try {
      const r = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pl),
      });
      const j = await r.json();
      if (!j.ok && j.error) throw new Error(j.error);
      if (!j.provider) throw new Error('ошибка сохранения');
      st.textContent = '✓ сохранён: ' + j.provider.id;
      st.classList.add('ok');
      $('np-key').value = '';
      await renderProviders();
      toast('провайдер добавлен: ' + j.provider.id);
    } catch (e) {
      st.textContent = '✗ ' + e.message;
      st.classList.add('fail');
    }
  });

  let searchTimer = null;
  $('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderSessions($('search-input').value), 300);
  });

  // ---------------- ввод ----------------
  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
  }
  inputEl.addEventListener('input', autoResize);
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', stop);

  // настройки
  $('cwd-input').addEventListener('change', () => {
    state.cwd = $('cwd-input').value.trim();
    localStorage.setItem('coting.cwd', state.cwd);
    toast('папка: ' + (state.cwd || 'домашняя'));
  });
  $('approve-toggle').addEventListener('change', () => {
    state.approve = $('approve-toggle').checked;
    localStorage.setItem('coting.approve', state.approve ? '1' : '0');
  });

  $('light-toggle').addEventListener('change', () => {
    localStorage.setItem('coting.light', $('light-toggle').checked ? '1' : '0');
    applyTheme();
  });

  $('np-eye').addEventListener('click', () => {
    const k = $('np-key');
    k.type = k.type === 'password' ? 'text' : 'password';
    $('np-eye').innerHTML = ic(k.type === 'password' ? 'eye' : 'eyeOff', 16);
  });
  setIcon('np-eye', 'eye', 16);

  // ---------------- тема ----------------
  function applyTheme() {
    const light = localStorage.getItem('coting.light') === '1';
    if (light) document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', light ? '#FFFFFF' : '#212121');
    const t = $('light-toggle');
    if (t) t.checked = light;
  }

  // ---------------- старт ----------------
  async function init() {
    applyTheme();
    try {
      const r = await fetch('/api/providers');
      const d = await r.json();
      state.providers = d.providers;
      if (!state.providerId || !state.providers.find(p => p.id === state.providerId)) state.providerId = d.defaults.providerId;
      if (!state.model) state.model = d.defaults.modelId;
    } catch {
      toast('сервер недоступен');
    }
    $('cwd-input').value = state.cwd;
    $('approve-toggle').checked = state.approve;
    refreshChip();
    if (state.sessionId) openSession(state.sessionId);
  }

  init();
})();
