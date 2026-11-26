// Локальный backend: REST API + WebSocket для живых логов/статуса + раздача веб-панели.
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { settings } from '../config.js';
import { pals as palsDb } from '../db.js';
import { manager } from '../agent/manager.js';
import { testProvider } from '../llm/router.js';
import { ACTIONS, runAction } from '../actions/index.js';
import { usage } from '../llm/usage.js';
import { supportedVersions } from '../versions.js';

export function startServer({ port = 3000, host = '127.0.0.1' } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Пароль панели (обязателен, если панель открыта в сеть: HOST=0.0.0.0, чтобы зайти с телефона)
  const password = process.env.PANEL_PASSWORD || '';
  const token = password ? crypto.createHash('sha256').update(`mypal:${password}`).digest('hex') : '';
  const authed = (req) => !password || parseCookies(req.headers.cookie).mypal_auth === token;
  app.get('/login', (req, res) => res.type('html').send(loginPage(req.query.e)));
  app.post('/login', (req, res) => {
    if (password && req.body.password === password) {
      res.setHeader('Set-Cookie', `mypal_auth=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 365}`);
      return res.redirect('/');
    }
    res.redirect('/login?e=1');
  });
  app.use((req, res, next) => {
    if (authed(req) || req.path === '/manifest.webmanifest' || req.path === '/icon.svg') return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Нужен вход' });
    res.redirect('/login');
  });
  app.use(express.static(path.resolve('public')));

  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req, res)); } catch (e) { res.status(400).json({ error: e.message }); }
  };
  const palOf = (req) => {
    const p = palsDb.get(Number(req.params.id));
    if (!p) throw new Error('Pal не найден');
    return manager.get(p.id);
  };

  // ---------- настройки и ключи ----------
  app.get('/api/settings', wrap(() => settings.public()));
  app.put('/api/settings', wrap((req) => { settings.update(req.body); return settings.public(); }));
  app.post('/api/providers/:id/test', wrap((req) => testProvider(req.params.id)));

  // ---------- pals ----------
  app.get('/api/pals', wrap(() => palsDb.list().map((p) => ({ ...p, state: manager.get(p.id).state() }))));
  app.post('/api/pals', wrap((req) => {
    if (!req.body?.name || !/^[A-Za-z0-9_]{3,16}$/.test(req.body.name)) throw new Error('Имя: 3-16 символов, латиница/цифры/_ (ограничение Minecraft)');
    return palsDb.create(req.body);
  }));
  app.put('/api/pals/:id', wrap((req) => {
    if (req.body.name && !/^[A-Za-z0-9_]{3,16}$/.test(req.body.name)) throw new Error('Имя: 3-16 символов, латиница/цифры/_');
    const p = palsDb.update(Number(req.params.id), req.body);
    manager.refresh(req.params.id);
    return p;
  }));
  app.delete('/api/pals/:id', wrap((req) => { manager.remove(req.params.id); palsDb.remove(Number(req.params.id)); return { ok: true }; }));

  app.post('/api/pals/:id/connect', wrap((req) => { palOf(req).connect(); return { ok: true }; }));
  app.post('/api/pals/:id/disconnect', wrap((req) => { palOf(req).disconnect(); return { ok: true }; }));
  app.post('/api/pals/:id/stop', wrap((req) => { palOf(req).stopAll(); return { ok: true }; }));
  app.post('/api/pals/:id/chat', wrap((req) => {
    const pal = palOf(req);
    if (!pal.bot) throw new Error('Pal не подключён к Minecraft');
    pal.handleMessage(req.body.from || pal.profile.owner || 'Панель', String(req.body.text || ''));
    return { ok: true };
  }));
  // прямой вызов действия без LLM (удобно для отладки)
  app.post('/api/pals/:id/action', wrap(async (req) => {
    const pal = palOf(req);
    if (!pal.bot) throw new Error('Pal не подключён');
    return runAction(pal, req.body.name, req.body.args || {});
  }));

  // ---------- память ----------
  app.get('/api/pals/:id/memories', wrap((req) => palOf(req).memory.list()));
  app.post('/api/pals/:id/memories', wrap((req) => ({ id: palOf(req).memory.add(req.body.kind || 'semantic', req.body.content, req.body.importance || 3) })));
  app.delete('/api/pals/:id/memories/:mid', wrap((req) => { palOf(req).memory.remove(Number(req.params.mid)); return { ok: true }; }));
  app.get('/api/pals/:id/locations', wrap((req) => palOf(req).memory.locations()));
  app.delete('/api/pals/:id/locations/:name', wrap((req) => { palOf(req).memory.removeLocation(req.params.name); return { ok: true }; }));
  app.get('/api/pals/:id/conversation', wrap((req) => palOf(req).memory.recent(100)));

  // ---------- задачи ----------
  app.get('/api/pals/:id/tasks', wrap((req) => palOf(req).tasks.list()));
  app.post('/api/pals/:id/tasks/:tid/status', wrap((req) => palOf(req).tasks.setStatus(Number(req.params.tid), req.body.status)));

  // ---------- поддерживаемые версии Minecraft ----------
  app.get('/api/versions', wrap(() => supportedVersions()));

  // ---------- лимиты и расход ----------
  app.get('/api/usage', wrap(() => usage.summary()));
  // проверить, как выглядит предупреждение в игре (ничего не тратит)
  app.post('/api/usage/test-alert', wrap((req) => {
    const provider = req.body.provider || settings.get().llm.activeProvider;
    const level = req.body.level === 'exhausted' ? 'exhausted' : 'warning';
    delete usage.alerted[provider];
    usage.alert(provider, level, { percent: level === 'warning' ? 7 : 0, reason: 'тестовое предупреждение' });
    return { ok: true };
  }));

  app.get('/api/actions', wrap(() => ACTIONS.map(({ name, description, parameters }) => ({ name, description, parameters }))));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => authed(req) });
  const broadcast = (type, data) => {
    const msg = JSON.stringify({ type, data });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  };
  for (const ev of ['log', 'chat', 'status', 'tasks', 'limit']) manager.on(ev, (d) => broadcast(ev, d));
  wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'states', data: manager.states() })));
  // периодически шлём состояние онлайн-pal'ов (здоровье, позиция, инвентарь)
  setInterval(() => {
    for (const pal of manager.running.values()) if (pal.status === 'online') broadcast('status', pal.state());
  }, 2000).unref();

  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter((kv) => kv.length === 2));
}

function loginPage(error) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MyPal — вход</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#12151a;color:#e6e9ee;font:16px system-ui,sans-serif;padding:16px}
form{background:#1b2027;border:1px solid #2e3640;border-radius:12px;padding:24px;width:100%;max-width:340px;display:grid;gap:12px}
input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #2e3640}input{background:#232a33;color:inherit}
button{background:#5fbf6a;border:0;font-weight:700}.e{color:#d9534f}</style></head><body>
<form method="post" action="/login"><b>⛏ MyPal</b><input type="password" name="password" placeholder="Пароль панели" autofocus>
${error ? '<div class="e">Неверный пароль</div>' : ''}<button>Войти</button></form></body></html>`;
}
