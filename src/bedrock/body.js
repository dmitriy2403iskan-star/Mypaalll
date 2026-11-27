// «Тело» для Minecraft Bedrock (телефон, Windows, консоли, BDS, Realms) поверх bedrock-protocol.
// Mineflayer поддерживает только Java, поэтому в Bedrock бот действует КОМАНДАМИ (/tp, /setblock, /fill, /give…):
// нужен мир с включёнными читами, а боту — права оператора.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadBedrockProtocol } from './protocol.js';
import { DATA_DIR } from '../config.js';

const require = createRequire(import.meta.url);
const round = (v) => Math.round(v);

/** Тип поля version в command_request зависит от версии Bedrock: до 1.21.130 — число, потом — строка. */
function commandVersionFor(mcVersion) {
  try {
    const d = require('minecraft-data')(`bedrock_${mcVersion}`);
    const field = d.protocol.types.packet_command_request[1].find((x) => x.name === 'version');
    return field.type === 'string' ? 'latest' : 52;
  } catch {
    return 'latest';
  }
}
const EYE = 1.62;

export class BedrockBody extends EventEmitter {
  constructor(opts) {
    super();
    this.edition = 'bedrock';
    this.opts = opts;
    this.username = opts.username;
    this.players = new Map();   // name → { runtimeId, position }
    this.byRuntime = new Map(); // runtimeId → name
    this.entity = null;         // { position } — как у mineflayer, чтобы общий код работал
    this.health = 20;
    this.food = 20;
    this.dimension = 'overworld';
    this.gameMode = 'survival';
    this.version = null;
    this.pending = new Map();   // uuid команды → { resolve, timer }
    this.ended = false;
    this.connect();
  }

  connect() {
    const { createClient } = loadBedrockProtocol();
    const o = this.opts;
    const options = {
      host: o.host,
      port: Number(o.port) || 19132,
      username: o.username,
      offline: o.auth !== 'microsoft',
      profilesFolder: path.join(DATA_DIR, 'auth'),
      // вход через Microsoft: код и ссылка показываются в панели и в консоли
      onMsaCode: (data) => this.emit('msaCode', data),
      conLog: () => {},
    };
    if (o.version) options.version = o.version;
    if (o.realm) { options.realms = { realmName: o.realm }; delete options.host; delete options.port; }
    if (o.transport === 'nethernet') options.transport = 'nethernet';

    const c = createClient(options);
    this.client = c;

    c.on('start_game', (p) => {
      this.runtimeId = p.runtime_entity_id;
      this.uniqueId = p.entity_id;
      this.entity = { position: feet(p.player_position) };
      this.dimension = p.dimension || 'overworld';
      this.version = c.options?.version;
      // fallback = режим мира по умолчанию
      this.worldGameMode = p.world_gamemode;
      this.setGameMode(p.player_gamemode === 'fallback' ? p.world_gamemode : p.player_gamemode);
    });
    c.on('set_player_game_type', (p) => this.setGameMode(p.gamemode === 'fallback' ? this.worldGameMode : p.gamemode));
    c.on('spawn', () => this.emit('spawn'));
    c.on('text', (p) => this.onText(p));
    c.on('move_player', (p) => this.onMove(p.runtime_id, p.position));
    c.on('add_player', (p) => {
      this.byRuntime.set(p.runtime_id, p.username);
      this.players.set(p.username, { runtimeId: p.runtime_id, position: feet(p.position) });
    });
    c.on('remove_entity', (p) => {
      for (const [rid, name] of this.byRuntime) {
        if (String(rid) === String(p.entity_id_self)) { this.players.delete(name); this.byRuntime.delete(rid); }
      }
    });
    c.on('player_list', (p) => {
      if (p.records?.type === 'add') {
        for (const r of p.records.records || []) if (r.username && !this.players.has(r.username)) this.players.set(r.username, { position: null });
      }
    });
    c.on('update_attributes', (p) => {
      if (String(p.runtime_entity_id) !== String(this.runtimeId)) return;
      for (const a of p.attributes || []) {
        if (a.name === 'minecraft:health') this.health = a.current;
        if (a.name === 'minecraft:player.hunger') this.food = a.current;
      }
      if (this.health <= 0) this.emit('death');
    });
    c.on('command_output', (p) => {
      const req = this.pending.get(p.origin?.uuid);
      if (!req) return;
      clearTimeout(req.timer);
      this.pending.delete(p.origin.uuid);
      req.resolve({
        success: (p.success_count ?? 0) > 0 || (p.output || []).some((m) => m.success),
        output: (p.output || []).map((m) => [m.message_id, ...(m.parameters || [])].join(' ')).join('; '),
      });
    });
    c.on('disconnect', (p) => this.emit('kicked', p?.message || p?.reason || 'disconnect'));
    c.on('error', (e) => this.emit('error', e));
    c.on('close', () => this.end('closed'));
  }

  setGameMode(raw) {
    const m = String(raw ?? 'survival');
    const norm = m.includes('spectator') ? 'spectator' : m.startsWith('creative') ? 'creative' : m.startsWith('adventure') ? 'adventure' : 'survival';
    if (norm === this.gameMode) return;
    this.gameMode = norm;
    this.emit('game');
  }

  end(reason) {
    if (this.ended) return;
    this.ended = true;
    for (const { resolve, timer } of this.pending.values()) { clearTimeout(timer); resolve({ success: false, output: 'disconnected' }); }
    this.pending.clear();
    this.emit('end', reason);
  }

  onText(p) {
    const name = p.source_name;
    if (!name || name === this.username) return;
    if (p.type === 'chat') this.emit('chat', name, p.message);
    if (p.type === 'whisper') this.emit('whisper', name, p.message);
  }

  onMove(runtimeId, pos) {
    if (String(runtimeId) === String(this.runtimeId)) {
      this.entity = { position: feet(pos) };
      return;
    }
    const name = this.byRuntime.get(runtimeId) ?? [...this.byRuntime].find(([k]) => String(k) === String(runtimeId))?.[1];
    if (name && this.players.has(name)) this.players.get(name).position = feet(pos);
  }

  // ----------------------------------------------------------- API, похожее на mineflayer
  chat(message) {
    if (this.ended) return;
    const base = {
      needs_translation: false, category: 'authored', type: 'chat', source_name: this.username, message,
      xuid: '', platform_chat_id: '', has_filtered_message: false, filtered_message: '',
    };
    this.client.queue('text', base);
  }

  quit() {
    try { this.client.disconnect('bye'); } catch { /* */ }
    this.end('quit');
  }

  /** Выполнить команду от имени бота. Возвращает { success, output }. */
  command(cmd, timeoutMs = 4000) {
    if (this.ended) return Promise.resolve({ success: false, output: 'нет соединения' });
    const command = cmd.startsWith('/') ? cmd : `/${cmd}`;
    const uuid = crypto.randomUUID();
    const packet = {
      command,
      origin: { type: 'player', uuid, request_id: '', player_entity_id: 0n },
      internal: false,
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(uuid);
        // сервер не всегда присылает ответ (например, у плагинов) — считаем, что команда ушла
        resolve({ success: true, output: '(без ответа сервера)' });
      }, timeoutMs);
      this.pending.set(uuid, { resolve, timer });
      try {
        this.cmdVersion ??= commandVersionFor(this.client.options?.version);
        this.client.write('command_request', { ...packet, version: this.cmdVersion });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(uuid);
        resolve({ success: false, output: e.message });
      }
    });
  }

  findPlayer(name) {
    if (!name) return null;
    const lower = name.toLowerCase();
    for (const [n, p] of this.players) if (n.toLowerCase() === lower) return { name: n, ...p };
    for (const [n, p] of this.players) if (n.toLowerCase().includes(lower)) return { name: n, ...p };
    return null;
  }

  snapshot() {
    const me = this.entity?.position;
    const dist = (p) => (me && p ? Math.round(Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z) * 10) / 10 : null);
    return {
      edition: 'bedrock',
      position: me ? { x: round(me.x), y: round(me.y), z: round(me.z) } : null,
      health: Math.round(this.health),
      food: Math.round(this.food),
      dimension: this.dimension,
      gameMode: this.gameMode,
      time: '—',
      heldItem: null,
      inventory: {},
      nearbyEntities: [...this.players].filter(([n]) => n !== this.username)
        .map(([name, p]) => ({ name, type: 'player', distance: dist(p.position) }))
        .sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9)),
      nearbyBlocks: [],
    };
  }
}

function feet(p) {
  if (!p) return null;
  return { x: p.x, y: p.y - EYE, z: p.z };
}
