// «Тело» для Minecraft Bedrock (телефон, Windows, консоли, BDS, Realms) поверх bedrock-protocol.
// Mineflayer поддерживает только Java, поэтому в Bedrock бот действует КОМАНДАМИ (/tp, /setblock, /fill, /give…):
// нужен мир с включёнными читами, а боту — права оператора.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadBedrockProtocol } from './protocol.js';
import { attachFlayer } from './flayer/index.js';
import { pickFriendWorld } from './friends.js';
import { findLanWorld } from './lan.js';
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
    const o = this.opts;
    if (o.transport !== 'nethernet' || o.realm) { this.open(); return; }
    // поиск по локальной сети: сначала находим, на каком адресе отвечает мир, потом подключаемся
    const { ping } = loadBedrockProtocol();
    // асинхронно, чтобы подписчики событий успели подключиться после конструктора
    Promise.resolve()
      .then(() => {
        this.emit('netlog', 'ищу мир в локальной сети (до 10 с)...');
        return findLanWorld({ ping, host: o.host, port: Number(o.port) || 19132 });
      })
      .then((found) => {
        if (this.ended) return; // пока искали, нажали «Отключить»
        this.emit('netlog', `мир ответил: адрес ${found.host}, способ ${found.ad.transport}`);
        this.open(found);
      })
      .catch((e) => {
        if (this.ended) return;
        this.emit('error', e);
        this.end('closed');
      });
  }

  open(found) {
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
      // ход поиска мира и подключения — в журнал панели (иначе причину тайм-аута не видно)
      conLog: (...args) => this.emit('netlog', args.join(' ')),
      // телефону нужно больше времени, особенно когда игра в плавающем окне:
      // поиск мира (по умолчанию библиотека ждёт 1 с) и само соединение (по умолчанию 9 с)
      pingTimeout: 10_000,
      connectTimeout: 30_000,
      // RakNet в основном потоке: в worker-потоке не действует заплатка протокола (см. protocol.js),
      // и на телефоне лишний поток только тратит память
      useRaknetWorkers: false,
      viewDistance: 6, // чанков вокруг — достаточно для поиска пути, бережём память телефона
    };
    if (o.version) options.version = o.version;
    if (o.realm) { options.realms = { realmName: o.realm }; delete options.host; delete options.port; }
    if (found) {
      options.host = found.host;
      options.transport = found.ad.transport;
      if (found.ad.networkId != null && found.ad.transport === 'nethernet') options.nethernet = { networkId: found.ad.networkId };
    }
    if (o.transport === 'friends' && !o.realm) {
      options.offline = false; // список друзей есть только у аккаунта Microsoft
      delete options.host;
      delete options.port;
      options.world = {
        pickSession: async (sessions) => {
          const world = pickFriendWorld(sessions, o.friend);
          const p = world.customProperties || {};
          // версию берём из описания мира, если не задана вручную; библиотека читает options.version после выбора
          const { Versions } = require('bedrock-protocol/src/options.js');
          const version = Object.keys(Versions).find((v) => Versions[v] === Number(p.protocol));
          if (!options.version && version) options.version = version;
          this.emit('netlog', `нашёл мир друга ${p.hostName || ''} «${p.worldName || ''}», версия ${options.version || p.version || '?'}`);
          return world;
        },
      };
    }

    const c = createClient(options);
    this.client = c;

    c.on('start_game', (p) => {
      this.runtimeId = p.runtime_entity_id;
      this.uniqueId = p.entity_id;
      const pos = feet(p.player_position);
      this.entity = pos ? { position: pos } : { position: { x: p.player_position.x, y: 64, z: p.player_position.z }, unknownY: true };
      this.dimension = p.dimension || 'overworld';
      this.version = c.options?.version;
      // false — сервер не принимает item_stack_request (старые сервера): крафт идёт через inventory_transaction
      this.serverAuthInventory = p.server_authoritative_inventory;
      // fallback = режим мира по умолчанию
      this.worldGameMode = p.world_gamemode;
      this.setGameMode(p.player_gamemode === 'fallback' ? p.world_gamemode : p.player_gamemode);
    });
    c.on('set_player_game_type', (p) => this.setGameMode(p.gamemode === 'fallback' ? this.worldGameMode : p.gamemode));
    c.on('spawn', () => this.emit('spawn'));
    c.on('text', (p) => this.onText(p));
    c.on('move_player', (p) => this.onMove(p.runtime_id, p.position));
    c.on('add_player', (p) => {
      // в старых версиях поле называется runtime_entity_id, в новых — runtime_id
      const rid = p.runtime_id ?? p.runtime_entity_id;
      this.byRuntime.set(rid, p.username);
      this.players.set(p.username, { runtimeId: rid, position: feet(p.position) });
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
    // сервер сообщает, какой наш пакет он не смог разобрать — полезно при новых версиях протокола
    c.on('packet_violation_warning', (p) => {
      this.lastViolation = JSON.stringify(p, (k, x) => (typeof x === 'bigint' ? String(x) : x));
      this.emit('flayerError', new Error(`сервер отклонил пакет: ${this.lastViolation}`));
    });
    c.on('error', (e) => this.emit('error', e));
    c.on('close', () => this.end('closed'));
    // собственное «тело» без команд: мир, физика, поиск пути (можно выключить: nativeMovement=false)
    if (o.nativeMovement !== false) attachFlayer(this);
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
    this.movement?.stop();
    for (const { resolve, timer } of this.pending.values()) { clearTimeout(timer); resolve({ success: false, output: 'disconnected' }); }
    this.pending.clear();
    this.emit('end', reason);
  }

  onText(p) {
    let name = p.source_name;
    let msg = p.message;
    let whisper = p.type === 'whisper';
    // настоящий BDS часто шлёт чат как перевод: chat.type.text [ник, текст], личные — commands.message.display.incoming
    if (p.type === 'translation' && Array.isArray(p.parameters)) {
      if (/^chat\.type\.(text|announcement)$/.test(p.message)) { name = p.parameters[0]; msg = p.parameters[1]; }
      else if (/^commands\.message\.display\.incoming$/.test(p.message)) { name = p.parameters[0]; msg = p.parameters[1]; whisper = true; }
      else return;
    } else if (p.type !== 'chat' && p.type !== 'whisper') return;
    if (!name || name === this.username || msg === undefined) return;
    name = String(name).replace(/§./g, '');
    this.emit(whisper ? 'whisper' : 'chat', name, String(msg));
  }

  onMove(runtimeId, pos) {
    if (String(runtimeId) === String(this.runtimeId)) {
      const f = feet(pos);
      if (f) this.entity = { position: f };
      return;
    }
    const name = this.byRuntime.get(runtimeId) ?? [...this.byRuntime].find(([k]) => String(k) === String(runtimeId))?.[1];
    if (name && this.players.has(name)) this.players.get(name).position = feet(pos) || this.players.get(name).position;
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

  /** Типы блоков вокруг (как в Java-снимке) — для контекста нейросети. */
  nearbyBlockTypes() {
    if (!this.world || !this.movement) return [];
    const p = this.movement.position; const seen = new Map();
    for (let dx = -8; dx <= 8; dx += 2) for (let dy = -3; dy <= 4; dy++) for (let dz = -8; dz <= 8; dz += 2) {
      const b = this.world.blockAt(p.x + dx, p.y + dy, p.z + dz);
      if (b && !/^(air|cave_air|void_air)$/.test(b.name)) seen.set(b.name, (seen.get(b.name) || 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([n]) => n);
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
      heldItem: this.inventory ? this.inventory.nameOf(this.inventory.held()) : null,
      inventory: this.inventory ? this.inventory.summary() : {},
      nearbyEntities: this.entities && this.movement
        ? [...[...this.players].filter(([n]) => n !== this.username).map(([name, p]) => ({ name, type: 'player', distance: dist(p.position) })),
          ...this.entities.list(this.movement.position).filter((e) => e.type !== 'player')]
          .sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9)).slice(0, 15)
        : [...this.players].filter(([n]) => n !== this.username)
          .map(([name, p]) => ({ name, type: 'player', distance: dist(p.position) }))
          .sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9)),
      nearbyBlocks: this.nearbyBlockTypes(),
    };
  }
}

function feet(p) {
  if (!p) return null;
  // y=32768 — «позиция ещё неизвестна» (сервер пришлёт настоящую после загрузки чанков)
  if (p.y > 30000) return null;
  return { x: p.x, y: p.y - EYE, z: p.z };
}
