// Веб-панель MyPal (без фреймворков).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const toast = (e) => alert(e.message || e);

const state = { pals: [], states: {}, settings: null, editingPal: null };
const pref = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* */ } } };

// ------------------------------------------------------------- вкладки
function showTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  pref.set('tab', name);
  ({ memory: loadMemory, tasks: loadTasks, settings: loadSettings, chat: loadChat })[name]?.();
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ------------------------------------------------------------- pals
async function loadPals() {
  state.pals = await api('/api/pals');
  for (const p of state.pals) state.states[p.id] = p.state;
  for (const sel of $$('.palSelect')) {
    const cur = sel.value || pref.get('pal', '');
    sel.innerHTML = state.pals.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if (state.pals.some((p) => String(p.id) === cur)) sel.value = cur;
  }
  renderCards();
  renderPalList();
}
$$('.palSelect').forEach((s) => s.addEventListener('change', () => {
  pref.set('pal', s.value);
  $$('.palSelect').forEach((o) => { o.value = s.value; });
  loadMemory(); loadTasks(); loadChat();
}));
const selectedPal = () => Number($('#chatPal').value);

function renderCards() {
  $('#palCards').innerHTML = state.pals.map((p) => {
    const st = state.states[p.id] || { status: 'offline' };
    const w = st.world;
    const inv = w ? Object.entries(w.inventory).map(([k, v]) => `${k}×${v}`).join(', ') || 'пусто' : '';
    const task = st.task;
    return `<div class="card">
      <div class="row" style="justify-content:space-between;margin-top:0">
        <h3 style="margin:0">${esc(p.name)}</h3>
        <span class="pill status-${st.status}">● ${st.status}${st.busy ? ' · думает' : ''}</span>
      </div>
      <div class="hint">${esc((p.personality || '').slice(0, 90))}</div>
      ${w ? `
        <div class="kv" style="margin-top:8px">
          <span>Здоровье</span><span><div class="bar hp"><div style="width:${w.health * 5}%"></div></div></span>
          <span>Еда</span><span><div class="bar food"><div style="width:${w.food * 5}%"></div></div></span>
          <span>Позиция</span><span>${w.position.x} ${w.position.y} ${w.position.z} · ${esc(w.dimension)}</span>
          <span>Время</span><span>${esc(w.time)}</span>
          <span>Режим</span><span>${st.mode ? `${esc(st.mode.type)} → ${esc(st.mode.player)}` : '—'}</span>
          <span>Действие</span><span>${esc(st.currentAction || '—')}</span>
          <span>Задача</span><span>${task ? esc(task.goal) : '—'}</span>
        </div>
        <div class="inv">🎒 ${esc(inv)}</div>` : ''}
      <div class="row">
        ${st.status === 'offline'
    ? `<button data-act="connect" data-id="${p.id}">Подключить</button>`
    : `<button class="secondary" data-act="disconnect" data-id="${p.id}">Отключить</button><button class="danger" data-act="stop" data-id="${p.id}">Стоп</button>`}
        <button class="secondary" data-act="chat" data-id="${p.id}">Чат</button>
      </div>
    </div>`;
  }).join('');
}
$('#palCards').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const { act, id } = b.dataset;
  if (act === 'chat') { $$('.palSelect').forEach((s) => { s.value = id; }); pref.set('pal', id); return showTab('chat'); }
  try { await api(`/api/pals/${id}/${act}`, { method: 'POST' }); } catch (err) { toast(err); }
});

function renderPalList() {
  $('#palList').innerHTML = state.pals.map((p) => `<div class="item ${state.editingPal === p.id ? 'selected' : ''}" data-id="${p.id}" style="cursor:pointer">
    <div><b>${esc(p.name)}</b><div class="hint">${esc(p.provider || 'глобальный LLM')} · хозяин: ${esc(p.owner || '—')}</div></div></div>`).join('');
}
$('#palList').addEventListener('click', (e) => {
  const it = e.target.closest('.item');
  if (it) editPal(Number(it.dataset.id));
});
function editPal(id) {
  state.editingPal = id;
  const p = state.pals.find((x) => x.id === id) || { name: '', owner: '', personality: '', traits: { humor: 0.5, helpfulness: 1, verbosity: 0.3, bravery: 0.5 }, provider: '' };
  const f = $('#palForm');
  f.id.value = p.id || '';
  f.name.value = p.name; f.owner.value = p.owner || ''; f.personality.value = p.personality || '';
  for (const t of ['humor', 'helpfulness', 'verbosity', 'bravery']) f[t].value = p.traits?.[t] ?? 0.5;
  f.provider.value = p.provider || '';
  $('#palFormTitle').textContent = p.id ? `Редактировать ${p.name}` : 'Новый Pal';
  $('#deletePal').style.display = p.id ? '' : 'none';
  renderPalList();
}
$('#newPal').addEventListener('click', () => editPal(null));
$('#palForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value.trim(), owner: f.owner.value.trim(), personality: f.personality.value, provider: f.provider.value,
    traits: Object.fromEntries(['humor', 'helpfulness', 'verbosity', 'bravery'].map((t) => [t, Number(f[t].value)])),
  };
  try {
    const saved = f.id.value ? await api(`/api/pals/${f.id.value}`, { method: 'PUT', body }) : await api('/api/pals', { body });
    await loadPals();
    editPal(saved.id);
  } catch (err) { toast(err); }
});
$('#deletePal').addEventListener('click', async () => {
  const id = $('#palForm').id.value;
  if (!id || !confirm('Удалить этого Pal вместе с памятью?')) return;
  await api(`/api/pals/${id}`, { method: 'DELETE' });
  state.editingPal = null;
  await loadPals();
  editPal(null);
});

// ------------------------------------------------------------- журнал и чат
function addLog(e) {
  const box = $('#log');
  const div = document.createElement('div');
  div.className = `t-${e.type}`;
  div.textContent = `${new Date(e.time).toLocaleTimeString()} [${e.pal}] ${e.type}: ${e.text}`;
  box.appendChild(div);
  while (box.children.length > 400) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
  if (e.palId === selectedPal()) {
    if (e.type === 'say') { addMsg('pal', e.pal, e.text); speak(e.text); }
    if (e.type === 'action' || e.type === 'action_error' || e.type === 'reflex') addMsg('meta', '', `${e.type === 'reflex' ? '⚡' : '⚙'} ${e.text}`);
  }
}
function addMsg(kind, who, text) {
  const box = $('#chatBox');
  const d = document.createElement('div');
  d.className = `msg ${kind}`;
  d.innerHTML = who ? `<b>${esc(who)}</b>${esc(text)}` : esc(text);
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}
async function loadChat() {
  if (!selectedPal()) return;
  $('#chatBox').innerHTML = '';
  const pal = state.pals.find((p) => p.id === selectedPal());
  if (!$('#chatFrom').value) $('#chatFrom').value = pref.get('from', pal?.owner || '');
  try {
    const convo = await api(`/api/pals/${selectedPal()}/conversation`);
    for (const m of convo.slice(-40)) {
      if (m.speaker === '_actions') addMsg('meta', '', `⚙ ${m.message.slice(0, 160)}`);
      else addMsg(m.speaker === pal?.name ? 'pal' : 'me', m.speaker, m.message);
    }
  } catch { /* */ }
}
$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  const from = $('#chatFrom').value.trim() || 'Игрок';
  pref.set('from', from);
  addMsg('me', from, text);
  $('#chatInput').value = '';
  try { await api(`/api/pals/${selectedPal()}/chat`, { body: { text, from } }); } catch (err) { addMsg('meta', '', `Ошибка: ${err.message}`); }
});
$('#stopBtn').addEventListener('click', () => api(`/api/pals/${selectedPal()}/stop`, { method: 'POST' }).catch(toast));

// ------------------------------------------------------------- голос (Web Speech API, без ключей)
$('#ttsOn').checked = pref.get('tts', '0') === '1';
$('#ttsOn').addEventListener('change', () => pref.set('tts', $('#ttsOn').checked ? '1' : '0'));
function speak(text) {
  if (!$('#ttsOn').checked || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = state.settings?.agent?.language === 'en' ? 'en-US' : 'ru-RU';
  speechSynthesis.speak(u);
}
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
$('#micBtn').addEventListener('click', () => {
  if (!SR) return toast(new Error('Браузер не поддерживает распознавание речи (попробуй Chrome/Edge).'));
  if (rec) { rec.stop(); return; }
  rec = new SR();
  rec.lang = state.settings?.agent?.language === 'en' ? 'en-US' : 'ru-RU';
  rec.interimResults = true;
  rec.onresult = (ev) => {
    const r = ev.results[ev.results.length - 1];
    $('#chatInput').value = r[0].transcript;
    if (r.isFinal) $('#chatForm').requestSubmit();
  };
  rec.onend = () => { rec = null; $('#micBtn').classList.remove('rec'); };
  rec.start();
  $('#micBtn').classList.add('rec');
});

// ------------------------------------------------------------- память
async function loadMemory() {
  const id = Number($('#memPal').value);
  if (!id) return;
  const [mems, locs, convo] = await Promise.all([
    api(`/api/pals/${id}/memories`), api(`/api/pals/${id}/locations`), api(`/api/pals/${id}/conversation`),
  ]);
  $('#memList').innerHTML = mems.map((m) => `<div class="item"><div><span class="pill">${m.kind === 'semantic' ? 'факт' : 'событие'} · ${m.importance}</span> ${esc(m.content)}<div class="hint">${esc(m.created_at)}</div></div><button class="x" data-mem="${m.id}">✕</button></div>`).join('') || '<div class="hint">Пока пусто</div>';
  $('#locList').innerHTML = locs.map((l) => `<div class="item"><div><b>${esc(l.name)}</b> <span class="hint">${l.x} ${l.y} ${l.z} · ${esc(l.dimension)}</span></div><button class="x" data-loc="${esc(l.name)}">✕</button></div>`).join('') || '<div class="hint">Скажи pal\'у «запомни, это наш дом»</div>';
  $('#convo').innerHTML = convo.map((m) => `<div><b>${esc(m.speaker)}:</b> ${esc(m.message)}</div>`).join('');
}
$('#memList').addEventListener('click', async (e) => {
  const id = e.target.dataset.mem;
  if (id) { await api(`/api/pals/${$('#memPal').value}/memories/${id}`, { method: 'DELETE' }); loadMemory(); }
});
$('#locList').addEventListener('click', async (e) => {
  const n = e.target.dataset.loc;
  if (n) { await api(`/api/pals/${$('#memPal').value}/locations/${encodeURIComponent(n)}`, { method: 'DELETE' }); loadMemory(); }
});
$('#memForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api(`/api/pals/${$('#memPal').value}/memories`, { body: { kind: e.target.kind.value, content: e.target.content.value, importance: 4 } });
  e.target.content.value = '';
  loadMemory();
});

// ------------------------------------------------------------- задачи
async function loadTasks() {
  const id = Number($('#taskPal').value);
  if (!id) return;
  const tasks = await api(`/api/pals/${id}/tasks`);
  $('#taskList').innerHTML = tasks.map((t) => `<div class="card">
    <div class="row" style="justify-content:space-between;margin:0"><b>#${t.id} ${esc(t.goal)}</b><span class="pill s-${t.status}">${t.status}</span></div>
    <ol class="steps" start="0">${t.steps.map((s) => `<li class="s-${s.status}">${esc(s.name)}${s.note ? ` <span class="hint">— ${esc(s.note)}</span>` : ''}</li>`).join('')}</ol>
    ${['RUNNING', 'PAUSED', 'PENDING'].includes(t.status) ? `<div class="row">
      ${t.status !== 'RUNNING' ? `<button class="secondary" data-task="${t.id}" data-st="RUNNING">Возобновить</button>` : `<button class="secondary" data-task="${t.id}" data-st="PAUSED">Пауза</button>`}
      <button class="danger" data-task="${t.id}" data-st="CANCELLED">Отменить</button></div>` : ''}
    <div class="hint">${esc(t.updated_at)}</div></div>`).join('') || '<div class="hint">Задач пока нет. Попроси pal\'а сделать что-то сложное — он составит план.</div>';
}
$('#taskList').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-task]');
  if (!b) return;
  await api(`/api/pals/${$('#taskPal').value}/tasks/${b.dataset.task}/status`, { body: { status: b.dataset.st } }).catch(toast);
  loadTasks();
});

// ------------------------------------------------------------- настройки
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
function setPath(o, p, v) { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; }

async function loadSettings() {
  state.settings = await api('/api/settings');
  const s = state.settings;
  const ids = Object.keys(s.llm.providers);
  for (const sel of $$('.providerSelect')) {
    const keepEmpty = sel.querySelector('option[value=""]');
    sel.innerHTML = (keepEmpty ? keepEmpty.outerHTML : '') + ids.map((id) => `<option value="${id}">${id}${s.llm.providers[id].hasKey || s.llm.providers[id].type === 'openai' && /localhost|127\.0\.0\.1/.test(s.llm.providers[id].baseUrl) ? '' : ' (нет ключа)'}</option>`).join('');
  }
  $('#providerRows').innerHTML = ids.map((id) => {
    const p = s.llm.providers[id];
    return `<tr data-prov="${id}" class="${id === s.llm.activeProvider ? 'active' : ''}">
      <td>${id}</td>
      <td><select data-f="type">${['openai', 'anthropic', 'gemini'].map((t) => `<option ${t === p.type ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
      <td><input data-f="baseUrl" value="${esc(p.baseUrl)}" placeholder="по умолчанию"></td>
      <td><input data-f="model" value="${esc(p.model)}"></td>
      <td><input data-f="apiKey" type="password" placeholder="${p.hasKey ? esc(p.apiKey) : 'вставь ключ'}" autocomplete="off"></td>
      <td><button type="button" class="secondary" data-test="${id}">Проверить</button></td>
    </tr>`;
  }).join('');
  for (const el of $$('#settingsForm [name]')) {
    const v = getPath(s, el.name);
    if (el.type === 'checkbox') el.checked = Boolean(v); else el.value = v === false || v === undefined || v === null ? '' : v;
  }
  // селекты pal-формы тоже обновим
  if (state.editingPal !== undefined) $('#palForm').provider.value = state.pals.find((p) => p.id === state.editingPal)?.provider || '';
}

$('#providerRows').addEventListener('click', async (e) => {
  const id = e.target.dataset.test;
  if (!id) return;
  e.target.disabled = true; e.target.textContent = '…';
  await saveSettings(false);
  try {
    const r = await api(`/api/providers/${id}/test`, { method: 'POST' });
    e.target.textContent = `✓ ${r.ms} мс`;
  } catch (err) {
    e.target.textContent = '✕ ошибка';
    toast(err);
  } finally { e.target.disabled = false; }
});

$('#addProv').addEventListener('click', async () => {
  const id = $('#newProvId').value.trim().replace(/[^a-z0-9_-]/gi, '');
  if (!id) return;
  await api('/api/settings', { method: 'PUT', body: { llm: { providers: { [id]: { type: 'openai', baseUrl: $('#newProvUrl').value.trim(), model: $('#newProvModel').value.trim(), apiKey: '' } } } } });
  loadSettings();
});

async function saveSettings(reload = true) {
  const patch = {};
  for (const el of $$('#settingsForm [name]')) {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number') v = Number(v);
    if (el.name === 'minecraft.version' && !v) v = false;
    setPath(patch, el.name, v);
  }
  for (const tr of $$('#providerRows tr')) {
    const p = {};
    for (const inp of $$('[data-f]', tr)) if (inp.dataset.f !== 'apiKey' || inp.value) p[inp.dataset.f] = inp.value;
    setPath(patch, `llm.providers.${tr.dataset.prov}`, p);
  }
  await api('/api/settings', { method: 'PUT', body: patch });
  $('#settingsMsg').textContent = `Сохранено ${new Date().toLocaleTimeString()}`;
  if (reload) loadSettings();
}
$('#settingsForm').addEventListener('submit', (e) => { e.preventDefault(); saveSettings().catch(toast); });

// ------------------------------------------------------------- WebSocket
function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { $('#conn').className = 'pill status-online'; $('#conn').textContent = '● сервер'; };
  ws.onclose = () => { $('#conn').className = 'pill status-offline'; $('#conn').textContent = '● нет связи'; setTimeout(connectWs, 2000); };
  ws.onmessage = (ev) => {
    const { type, data } = JSON.parse(ev.data);
    if (type === 'log') addLog(data);
    if (type === 'status') { state.states[data.id] = data; renderCards(); }
    if (type === 'states') { for (const s of data) state.states[s.id] = s; renderCards(); }
    if (type === 'tasks' && data.palId === Number($('#taskPal').value) && $('#tab-tasks').classList.contains('active')) loadTasks();
    if (type === 'chat' && data.palId === selectedPal() && data.from !== $('#chatFrom').value) addMsg('me', data.from, data.message);
  };
}

// ------------------------------------------------------------- старт
await loadSettings();
await loadPals();
editPal(state.pals[0]?.id ?? null);
connectWs();
showTab(pref.get('tab', 'dashboard'));
