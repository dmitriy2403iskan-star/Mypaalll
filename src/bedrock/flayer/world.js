// Мир Bedrock: чанки (полные и по запросу subchunk), обновления блоков, blockAt().
// Блоки разбираются prismarine-chunk / prismarine-registry — так же, как Mineflayer делает это для Java.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const ver = (v) => v.split('.').map(Number);
const atLeast = (v, min) => { const a = ver(v); const b = ver(min); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); } return true; };

const PASSABLE = /air|water|lava|grass(?!_block)|fern|flower|tulip|dandelion|poppy|orchid|allium|bluet|daisy|cornflower|lily_of_the_valley|torch|sapling|vine|snow_layer|carpet|button|lever|pressure_plate|rail|sign|banner|tallgrass|deadbush|dead_bush|wheat|carrots|potatoes|beetroot|sugar_cane|reeds|seagrass|kelp|bush|cobweb|web|structure_void|light_block|ladder|redstone_wire|tripwire/;

export class BedrockWorld extends EventEmitter {
  constructor(client, version) {
    super();
    this.client = client;
    this.version = version;
    this.registry = require('prismarine-registry')(`bedrock_${version}`);
    const impl = atLeast(version, '1.18.0') ? '1.18' : '1.3';
    this.Column = require(`prismarine-chunk/src/bedrock/${impl}/chunk`)(this.registry);
    this.Block = require('prismarine-block')(this.registry);
    this.modern = impl === '1.18';
    this.columns = new Map();
    // диагностика: как приходит мир и были ли ошибки разбора
    this.stats = { full: 0, request: 0, subRequested: 0, subSuccess: 0, subAir: 0, subOther: {}, errors: 0, lastError: null, counts: {} };
    this.dimension = 0;
    this.ready = false;

    const fail = (e) => { this.stats.errors++; this.stats.lastError = String(e?.stack || e).slice(0, 400); this.emit('error', e); };
    client.on('level_chunk', (p) => this.onLevelChunk(p).catch(fail));
    client.on('subchunk', (p) => this.onSubChunk(p).catch(fail));
    client.on('update_block', (p) => this.onUpdateBlock(p));
    client.on('update_block_synced', (p) => this.onUpdateBlock(p));
    // большие изменения (/fill, взрывы) в новых версиях приходят пачкой по подчанку
    client.on('update_subchunk_blocks', (p) => {
      for (const b of p.blocks || []) this.onUpdateBlock({ position: b.position, block_runtime_id: b.runtime_id, layer: 0 });
    });
    client.on('change_dimension', () => this.columns.clear());
  }

  /** Вызывается с пакетом start_game: сетевые id блоков (по порядку или хэши) и измерение. */
  handleStartGame(p) {
    try { this.registry.handleStartGame({ ...p, itemstates: p.itemstates || [] }); } catch (e) { this.emit('error', e); }
    // неизвестный сетевой id блока (новые/кастомные блоки) — считаем камнем, чтобы не терять весь подчанок
    const map = this.registry.blocksByRuntimeId || {};
    this.rawRuntime = map;
    this.stateToRuntime = null;
    const stone = this.registry.blocksByName?.stone;
    const fallback = stone ? { stateId: stone.defaultState ?? stone.minStateId, ...stone } : null;
    if (fallback) {
      this.registry.blocksByRuntimeId = new Proxy(map, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /^-?\d+$/.test(k) ? fallback : undefined)) });
    }
    this.dimension = typeof p.dimension === 'number' ? p.dimension : ({ overworld: 0, nether: 1, the_end: 2 }[p.dimension] ?? 0);
  }

  /** Сетевой id блока в позиции: точный из update_block, если блок с тех пор не менялся. */
  runtimeIdAt(pos, stateId) {
    const e = this.exactRuntime?.get(`${pos.x},${pos.y},${pos.z}`);
    if (e && e.stateId === stateId) return e.rid;
    return this.runtimeIdOfState(stateId);
  }

  /** stateId → сетевой id блока (для транзакций: клик по блоку, ломание). */
  runtimeIdOfState(stateId) {
    if (!this.stateToRuntime) {
      this.stateToRuntime = new Map();
      for (const [rid, v] of Object.entries(this.rawRuntime || {})) if (!this.stateToRuntime.has(v.stateId)) this.stateToRuntime.set(v.stateId, Number(rid));
    }
    return this.stateToRuntime.get(stateId) ?? 0;
  }

  key(cx, cz) { return `${cx},${cz}`; }

  newColumn(x, z) {
    const c = new this.Column({ x, z });
    return c;
  }

  async onLevelChunk(p) {
    const col = this.newColumn(p.x, p.z);
    // sub_chunk_count: -1/-2 (как беззнаковое 2^32-1/2^32-2) — режим запроса подчанков
    let count = p.sub_chunk_count;
    if (count > 0x7fffffff) count -= 0x100000000;
    this.stats.counts[count] = (this.stats.counts[count] || 0) + 1;
    // режим запроса подчанков: раньше -1/-2 в sub_chunk_count, с 1.26.40 — 0 (+ highest_subchunk_count, если ограничен)
    const pollingNew = atLeast(this.version, '1.26.40') && count === 0;
    if (count === -1 || count === -2 || pollingNew) {
      if (this.modern) { try { col.networkDecodeNoCache(p.payload, -1); } catch { /* биомы не обязательны */ } }
      this.columns.set(this.key(p.x, p.z), col);
      const limited = (count === -2 || pollingNew) && typeof p.highest_subchunk_count === 'number';
      // highest_subchunk_count — индекс верхнего подчанка ВКЛЮЧИТЕЛЬНО; берём с запасом (лишнее сервер отклонит)
      const top = limited ? Math.min(p.highest_subchunk_count + 2, col.maxCY - col.minCY) : (col.maxCY - col.minCY);
      const requests = [];
      for (let i = 0; i < top; i++) requests.push({ x: 0, y: col.minCY + i, z: 0 });
      this.stats.request++;
      this.stats.subRequested += requests.length;
      this.client.queue('subchunk_request', this.subchunkRequest(p.x, p.z, requests));
      return;
    }
    this.stats.full++;
    this.decodeFull(col, p.payload, count);
    this.columns.set(this.key(p.x, p.z), col);
    this.ready = true;
    this.emit('chunk', p.x, p.z);
  }

  subchunkRequest(cx, cz, requests) {
    // формат менялся: в новых версиях origin + смещения, в первых 1.18 — список координат
    return { dimension: this.dimension, origin: { x: cx, y: 0, z: cz }, requests, x: cx, y: 0, z: cz };
  }

  /** Полный чанк: секции идут подряд; индекс высоты берём из самой секции (v9), иначе от minCY. */
  decodeFull(col, payload, count) {
    const Stream = require('prismarine-chunk/src/bedrock/common/Stream');
    const { StorageType } = require('prismarine-chunk/src/bedrock/common/constants');
    const stream = new Stream(payload);
    for (let i = 0; i < count; i++) {
      const y = (this.modern ? col.minCY : 0) + i;
      const section = new col.Section(this.registry, this.Block, { y, subChunkVersion: col.subChunkVersion });
      section.decode(StorageType.Runtime, stream);
      // в v9 индекс высоты записан байтом со знаком (-4 = 252), prismarine-chunk читает его без знака
      let sy = y;
      if (typeof section.y === 'number' && section.subChunkVersion === 9) sy = section.y > 127 ? section.y - 256 : section.y;
      section.y = sy;
      col.setSection(sy, section);
    }
  }

  async onSubChunk(p) {
    const origin = p.origin || { x: p.x, y: p.y, z: p.z };
    const entries = Array.isArray(p.entries) ? p.entries : [p];
    for (const e of entries) {
      const cx = origin.x + (e.dx || 0);
      const cz = origin.z + (e.dz || 0);
      const cy = origin.y + (e.dy || 0);
      let col = this.columns.get(this.key(cx, cz));
      if (!col) { col = this.newColumn(cx, cz); this.columns.set(this.key(cx, cz), col); }
      if (e.result === 'success' && e.payload) {
        this.stats.subSuccess++;
        await col.networkDecodeSubChunkNoCache(cy, e.payload);
      } else if (e.result === 'success_all_air') {
        this.stats.subAir++;
        col.setSection(cy, undefined);
      } else {
        this.stats.subOther[e.result] = (this.stats.subOther[e.result] || 0) + 1;
      }
    }
    this.ready = true;
    this.emit('chunk', origin.x, origin.z);
  }

  onUpdateBlock(p) {
    if (p.layer && p.layer !== 0) return;
    const pos = p.position;
    const col = this.columns.get(this.key(pos.x >> 4, pos.z >> 4));
    if (!col) return;
    const info = this.registry.blocksByRuntimeId?.[p.block_runtime_id];
    if (!info) return;
    // точный сетевой id от сервера (у блоков с поворотом обратное отображение stateId → id неоднозначно)
    (this.exactRuntime ||= new Map()).set(`${pos.x},${pos.y},${pos.z}`, { rid: p.block_runtime_id, stateId: info.stateId });
    if (this.exactRuntime.size > 4096) this.exactRuntime.delete(this.exactRuntime.keys().next().value);
    try {
      col.setBlock({ x: pos.x & 15, y: pos.y, z: pos.z & 15, l: 0 }, this.Block.fromStateId(info.stateId, 0));
      this.emit('blockUpdate', pos);
    } catch { /* за пределами высоты */ }
  }

  /** Блок в мировых координатах или null, если чанк не загружен. */
  blockAt(x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    const col = this.columns.get(this.key(x >> 4, z >> 4));
    if (!col) return null;
    if (y < col.minY || y >= col.maxY) return { name: 'air', solid: false };
    try {
      const b = col.getBlock({ x: x & 15, y, z: z & 15, l: 0 }, false);
      return { name: b.name, stateId: b.stateId, solid: isSolid(this.registry, b.name) };
    } catch {
      return null;
    }
  }

  loaded(x, z) { return this.columns.has(this.key(Math.floor(x) >> 4, Math.floor(z) >> 4)); }
}

export function isSolid(registry, name) {
  if (!name) return false;
  // главный источник — boundingBox из данных версии (в старых версиях "grass" — это блок травы, он твёрдый)
  const bb = registry.blocksByName?.[name]?.boundingBox;
  if (bb) return bb === 'block';
  return !PASSABLE.test(name);
}
