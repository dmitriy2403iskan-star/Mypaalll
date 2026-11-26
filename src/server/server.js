// Локальный backend: REST API + WebSocket для живых логов/статуса + раздача веб-панели.
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { settings } from '../config.js';
import { pals as palsDb } from '../db.js';
import { manager } from '../agent/manager.js';
import { testProvider } from '../llm/router.js';
import { ACTIONS, runAction } from '../actions/index.js';
import { usage } from '../llm/usage.js';

export function startServer({ port = 3000, host = '127.0.0.1' } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
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
  const wss = new WebSocketServer({ server, path: '/ws' });
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
