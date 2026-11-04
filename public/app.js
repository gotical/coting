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

  function userMsg(text) {
    hideWelcome();
    const div = document.createElement('div');
    div.className = 'msg user';
    div.innerHTML = esc(text).replace(/\n/g, '<br>');
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
    av.textContent = '🐱';
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
    head.innerHTML = `<span class="t-name">🐾 ${esc(name)}</span><span class="t-arg">${esc(toolLabel(name, input))}</span><span class="t-status run">…</span>`;
    const body = document.createElement('div');
    body.className = 'tool-body';
    body.innerHTML = '<pre>' + esc(JSON.stringify(input, null, 2).slice(0, 4000)) + '</pre>';
    head.addEventListener('click', () => t.classList.toggle('open'));
    t.appendChild(head);
    t.appendChild(body);
    return { el: t, statusEl: head.querySelector('.t-status'), bodyEl: body.querySelector('pre'), input, name };
  }

  // ---------------- чат: отправка и стрим ----------------
  function setGenerating(on) {
    state.generating = on;
    sendBtn.hidden = on;
    stopBtn.hidden = !on;
  }

  async function send() {
    const text = inputEl.value.trim();
    if (!text || state.generating) return;
    inputEl.value = '';
    autoResize();
    userMsg(text);
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
        case 'tool_start': {
          finalizeSegment();
          working.remove();
          const tb = toolCard(ev.name, ev.input);
          col.appendChild(tb.el);
          toolBlocks.set(ev.id, tb);
          scrollBottom();
          break;
        }
        case 'tool_end': {
          const tb = toolBlocks.get(ev.id);
          if (!tb) break;
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
          a.innerHTML = `<div>🐾 Кот просит выполнить команду:</div><div class="cmd">${esc(ev.input?.command || JSON.stringify(ev.input))}</div>`;
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
    div.textContent = '😿 ' + msg;
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
    for (const id of ['model-sheet', 'sessions-sheet', 'settings-sheet']) $(id).hidden = true;
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
  $('model-chip').addEventListener('click', () => { closeAll(); openModelSheet(); });

  async function openSessions() {
    const box = $('sessions-list');
    box.innerHTML = '<div class="provider-label">загрузка…</div>';
    $('sessions-sheet').hidden = false;
    try {
      const r = await fetch('/api/sessions');
      const { sessions } = await r.json();
      box.innerHTML = '';
      if (!sessions.length) {
        box.innerHTML = '<div class="provider-label">пока пусто — кот ждёт первую задачу 🐾</div>';
        return;
      }
      for (const s of sessions) {
        const d = new Date(s.updated);
        const item = document.createElement('div');
        item.className = 'session-item' + (s.id === state.sessionId ? ' selected' : '');
        item.innerHTML = `<span class="s-title">${esc(s.title)}</span><span class="s-meta">${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span><button class="s-del" title="Удалить">✕</button>`;
        item.querySelector('.s-title').addEventListener('click', () => openSession(s.id));
        item.querySelector('.s-meta').addEventListener('click', () => openSession(s.id));
        item.querySelector('.s-del').addEventListener('click', async ev => {
          ev.stopPropagation();
          await fetch('/api/sessions/' + s.id, { method: 'DELETE' });
          if (s.id === state.sessionId) {
            state.sessionId = null;
            localStorage.removeItem('coting.sid');
          }
          openSessions();
          toast('чат удалён');
        });
        box.appendChild(item);
      }
    } catch {
      box.innerHTML = '<div class="provider-label">ошибка загрузки</div>';
    }
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

      for (const m of s.messages) {
        if (typeof m.content === 'string') {
          if (m.role === 'user') { userMsg(m.content); col = null; }
          else textSegment(ensureCol(), md(m.content));
          continue;
        }
        for (const b of m.content) {
          if (b.type === 'text' && b.text) {
            textSegment(ensureCol(), md(b.text));
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
    $('np-eye').textContent = k.type === 'password' ? '👁' : '🙈';
  });

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
