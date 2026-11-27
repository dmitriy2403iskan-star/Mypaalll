// «Руки» Bedrock-бота: инвентарь, ломание и установка блоков без команд (как bot.dig / bot.placeBlock в Mineflayer).
import { createRequire } from 'node:module';
import vec3pkg from 'vec3';

const require = createRequire(import.meta.url);
const Vec3 = vec3pkg.Vec3 || vec3pkg;
const EYE = 1.62;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// грани: 0 низ, 1 верх, 2 север(-z), 3 юг(+z), 4 запад(-x), 5 восток(+x)
const FACE_VEC = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

// ---------------------------------------------------------------- инвентарь
export class Inventory {
  constructor(body) {
    this.body = body;
    this.slots = new Array(36).fill(null);
    this.selected = 0;
    this.names = new Map(); // network_id → имя
    const c = body.client;
    const loadStates = (states) => { for (const s of states || []) this.names.set(s.runtime_id, String(s.name).replace(/^minecraft:/, '')); };
    c.on('start_game', (p) => loadStates(p.itemstates));
    c.on('item_registry', (p) => loadStates(p.itemstates));
    const isInv = (w) => w === 'inventory' || w === 0;
    const isHotbar = (w) => w === 'hotbar' || w === 122;
    c.on('inventory_content', (p) => {
      if (isInv(p.window_id)) (p.input || []).forEach((it, i) => { if (i < 36) this.slots[i] = it; });
      else if (isHotbar(p.window_id)) (p.input || []).forEach((it, i) => { if (i < 9) this.slots[i] = it; });
      this.body.emit('inventoryChanged');
    });
    c.on('inventory_slot', (p) => {
      if ((isInv(p.window_id) && p.slot < 36) || (isHotbar(p.window_id) && p.slot < 9)) { this.slots[p.slot] = p.item; this.body.emit('inventoryChanged'); }
    });
    c.on('mob_equipment', (p) => { if (String(p.runtime_entity_id) === String(body.runtimeId)) this.selected = p.selected_slot ?? p.slot ?? this.selected; });
    // предметы, лежащие на земле (дроп после ломания) — чтобы подойти и подобрать
    this.drops = new Map();
    c.on('add_item_entity', (p) => this.drops.set(String(p.runtime_entity_id), { name: this.nameOf(p.item), position: p.position, at: Date.now() }));
    c.on('remove_entity', (p) => { for (const k of this.drops.keys()) if (k === String(p.entity_id_self) || k === String(p.runtime_entity_id)) this.drops.delete(k); });
    c.on('take_item_entity', (p) => {
      this.drops.delete(String(p.runtime_entity_id));
      // сервер BDS не присылает слоты при подборе — просим полный инвентарь (как клиент при рассинхроне)
      if (String(p.target ?? p.target_runtime_entity_id) === String(body.runtimeId)) this.resyncSoon();
    });
    c.on('move_entity', (p) => { const d = this.drops.get(String(p.runtime_entity_id)); if (d) d.position = p.position; });
  }

  /** Попросить сервер прислать весь инвентарь заново (inventory_transaction inventory_mismatch). */
  resync(timeoutMs = 1500) {
    return new Promise((resolve) => {
      const c = this.body.client;
      let done = false;
      const on = (p) => { if (p.window_id === 'inventory' || p.window_id === 0) finish(true); };
      const finish = (v) => { if (done) return; done = true; clearTimeout(t); c.off('inventory_content', on); resolve(v); };
      const t = setTimeout(() => finish(false), timeoutMs);
      c.on('inventory_content', on);
      try {
        c.queue('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'inventory_mismatch', actions: [] } });
      } catch (e) { this.body.emit('flayerError', e); finish(false); }
    });
  }

  resyncSoon(ms = 400) {
    clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => { this.resync().catch(() => {}); }, ms);
  }

  /** Ближайшие лежащие предметы. */
  nearbyDrops(pos, radius = 8) {
    return [...this.drops.values()].filter((d) => d.position && Math.hypot(d.position.x - pos.x, d.position.z - pos.z) <= radius)
      .sort((a, b) => Math.hypot(a.position.x - pos.x, a.position.z - pos.z) - Math.hypot(b.position.x - pos.x, b.position.z - pos.z));
  }

  nameOf(item) {
    if (!item || !item.network_id) return null;
    return this.names.get(item.network_id) || `id:${item.network_id}`;
  }

  /** { имя: количество } — как inventory в снимке Java-бота. */
  summary() {
    const out = {};
    for (const it of this.slots) { const n = this.nameOf(it); if (n) out[n] = (out[n] || 0) + (it.count || 0); }
    return out;
  }

  count(name) { return this.slots.reduce((s, it) => s + (this.nameOf(it) === name ? it.count || 0 : 0), 0); }

  findSlot(nameOrTest, hotbarOnly = false) {
    const test = typeof nameOrTest === 'function' ? nameOrTest : (n) => n === nameOrTest;
    for (let i = 0; i < (hotbarOnly ? 9 : 36); i++) { const n = this.nameOf(this.slots[i]); if (n && test(n)) return i; }
    return -1;
  }

  held() { return this.slots[this.selected] || null; }

  /** Взять слот хотбара в руку. */
  select(slot) {
    if (slot < 0 || slot > 8) throw new Error('Предмет не в хотбаре');
    this.selected = slot;
    const item = this.slots[slot];
    if (!item) return;
    try {
      this.body.client.queue('mob_equipment', { runtime_entity_id: this.body.runtimeId, item, slot, selected_slot: slot, window_id: 'inventory' });
    } catch (e) { this.body.emit('flayerError', e); }
  }
}

// ---------------------------------------------------------------- время ломания
const TIERS = { wooden: 2, stone: 4, iron: 6, diamond: 8, netherite: 9, golden: 12 };
function toolFor(material = '') {
  if (/rock|stone|metal|iron|ore|anvil/.test(material)) return 'pickaxe';
  if (/wood|plant/.test(material)) return 'axe';
  if (/dirt|sand|gravel|grass|snow|clay|soul/.test(material)) return 'shovel';
  if (/leaves|web|wool/.test(material)) return 'shears';
  return null;
}

export function breakTime(registry, blockName, heldName, creative) {
  if (creative) return 0;
  const info = registry.blocksByName?.[blockName] || {};
  const hardness = info.hardness ?? 1;
  if (hardness < 0) return Infinity; // бедрок
  if (hardness === 0) return 0;
  const need = toolFor(info.material);
  let speed = 1;
  let canHarvest = !info.harvestTools || Object.keys(info.harvestTools).length === 0;
  if (heldName) {
    const m = heldName.match(/^(wooden|stone|iron|diamond|netherite|golden)_(pickaxe|axe|shovel|hoe|sword)$/);
    if (m && need && m[2] === need) speed = TIERS[m[1]];
    if (info.harvestTools && registry.itemsByName?.[heldName] && info.harvestTools[registry.itemsByName[heldName].id]) canHarvest = true;
    if (m && need === 'pickaxe' && m[2] === 'pickaxe') canHarvest = true;
  }
  const seconds = (hardness * (canHarvest ? 1.5 : 5)) / speed;
  return Math.ceil(seconds * 1000);
}

// ---------------------------------------------------------------- руки
export class Hands {
  constructor(body, world, movement, inventory, startGame) {
    this.body = body;
    this.world = world;
    this.movement = movement;
    this.inv = inventory;
    this.serverAuthBreaking = Boolean(startGame?.server_authoritative_block_breaking);
    this.md = require('minecraft-data')(`bedrock_${body.version}`);
    // 1.19+: настоящий клиент сообщает начало/конец использования предмета на блоке — без этого сервер не ставит блок
    // в 1.26.60+ (новый формат block_action без switch по действию) сервер рвёт соединение на start_item_use_on,
    // а ставит блок и без него — проверено зондом на настоящем BDS
    const ba = this.md.protocol.types.packet_player_auth_input?.[1]?.find((f) => f.name === 'block_action');
    const newLayout = /"option"/.test(JSON.stringify(ba?.type?.[0] ?? '')) || (ba && !JSON.stringify(ba).includes('"switch"'));
    this.itemUseActions = !newLayout && Object.values(this.md.protocol.types.Action?.[1]?.mappings || {}).includes('start_item_use_on');
  }

  eye() { const p = this.movement.position; return new Vec3(p.x, p.y + EYE, p.z); }

  /** Грань блока, обращённая к боту. */
  faceToward(pos) {
    const e = this.eye();
    const d = e.minus(new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5));
    const ax = Math.abs(d.x); const ay = Math.abs(d.y); const az = Math.abs(d.z);
    if (ay >= ax && ay >= az) return d.y > 0 ? 1 : 0;
    if (ax >= az) return d.x > 0 ? 5 : 4;
    return d.z > 0 ? 3 : 2;
  }

  inReach(pos, reach = 5) { return this.eye().distanceTo(new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)) <= reach; }

  swing() {
    try { this.body.client.queue('animate', { action_id: 'swing_arm', runtime_entity_id: this.body.runtimeId, data: 0, swing_source: 'build' }); } catch { /* */ }
  }

  /** Сетевой id блока (обратное отображение для транзакций). */
  runtimeIdOf(pos) {
    const b = this.world.blockAt(pos.x, pos.y, pos.z);
    if (!b || b.stateId === undefined) return 0;
    return this.world.runtimeIdAt ? this.world.runtimeIdAt(pos, b.stateId) : this.world.runtimeIdOfState(b.stateId);
  }

  waitBlock(pos, test, timeoutMs) {
    return new Promise((resolve) => {
      const check = () => { const b = this.world.blockAt(pos.x, pos.y, pos.z); if (b && test(b)) { cleanup(); resolve(true); } };
      const onUpd = (p) => { if (p.x === pos.x && p.y === pos.y && p.z === pos.z) check(); };
      const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.world.off('blockUpdate', onUpd); };
      this.world.on('blockUpdate', onUpd);
      check();
    });
  }

  /** Сломать блок (бот должен стоять рядом). Возвращает true, если сервер подтвердил. */
  async dig(pos) {
    pos = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    const block = this.world.blockAt(pos.x, pos.y, pos.z);
    if (!block || /^air$|cave_air|void_air/.test(block.name)) return true;
    if (!this.inReach(pos, 5.5)) throw new Error('Слишком далеко, подойди ближе');
    const face = this.faceToward(pos);
    this.movement.lookAt({ x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 });
    const creative = this.body.gameMode === 'creative';
    const ms = breakTime(this.world.registry, block.name, this.inv.nameOf(this.inv.held()), creative);
    if (!Number.isFinite(ms)) throw new Error(`${block.name} не ломается`);
    const p = { x: pos.x, y: pos.y, z: pos.z };

    if (this.serverAuthBreaking) {
      // сервер сам считает время: шлём действия внутри player_auth_input
      this.movement.blockActions.push({ action: creative ? 'creative_player_destroy_block' : 'start_break', position: p, face });
      const ticks = Math.ceil(ms / 50) + 2;
      for (let t = 0; t < ticks; t++) {
        await sleep(50);
        this.movement.blockActions.push({ action: 'continue_break', position: p, face });
        if (t % 5 === 0) this.swing();
      }
      this.movement.blockActions.push({ action: 'predict_break', position: p, face }, { action: 'stop_break', position: p, face });
    } else {
      const pa = (action) => this.body.client.queue('player_action', { runtime_entity_id: this.body.runtimeId, action, position: p, result_position: p, face });
      pa('start_break');
      const end = Date.now() + ms + 100;
      while (Date.now() < end) { await sleep(250); pa('crack_break'); this.swing(); }
      pa('stop_break');
      this.useItem({ action_type: 'break_block', block_position: p, face, block_runtime_id: this.runtimeIdOf(p) });
    }
    return this.waitBlock(pos, (b) => /air/.test(b.name), 3000);
  }

  /** Поставить блок из хотбара/инвентаря рядом с опорным блоком. target — куда ставим. */
  async place(target, itemName) {
    target = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) };
    let slot = this.inv.findSlot(itemName, true);
    // предмет в рюкзаке — переложить в хотбар, как сделал бы игрок
    if (slot < 0 && this.inv.count(itemName) && this.body.crafting) slot = await this.body.crafting.toHotbar(itemName);
    if (slot < 0) throw new Error(this.inv.count(itemName) ? `${itemName} не в хотбаре` : `Нет ${itemName}`);
    // опора: соседний твёрдый блок; кликаем по его грани, обращённой к цели
    let ref = null; let face = 1;
    for (let f = 0; f < 6; f++) {
      const [dx, dy, dz] = FACE_VEC[f];
      const n = { x: target.x - dx, y: target.y - dy, z: target.z - dz };
      const b = this.world.blockAt(n.x, n.y, n.z);
      if (b && b.solid) { ref = n; face = f; break; }
    }
    if (!ref) throw new Error('Не к чему прикрепить блок');
    // в клетке стоит игрок (или сам бот) — сервер такую установку отклонит
    const blocked = [...(this.body.players?.values?.() || [])].some((pl) => pl.position && Math.abs(pl.position.x - (target.x + 0.5)) < 0.8 && Math.abs(pl.position.z - (target.z + 0.5)) < 0.8 && pl.position.y > target.y - 1.8 && pl.position.y < target.y + 1)
      || (Math.abs(this.movement.position.x - (target.x + 0.5)) < 0.8 && Math.abs(this.movement.position.z - (target.z + 0.5)) < 0.8 && this.movement.position.y > target.y - 1.8 && this.movement.position.y < target.y + 1);
    if (blocked) throw new Error('В этой клетке стоит игрок — отойди или выбери другое место');
    if (!this.inReach(target, 5.5)) throw new Error('Слишком далеко, подойди ближе');
    this.inv.select(slot);
    await sleep(60);
    const [fx, fy, fz] = FACE_VEC[face];
    const click = { x: 0.5 + fx * 0.5, y: 0.5 + fy * 0.5, z: 0.5 + fz * 0.5 };
    const facePoint = { x: ref.x + click.x, y: ref.y + click.y, z: ref.z + click.z };
    const center = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 };
    // варианты, которые принимают разные версии серверов; удачный запоминаем и пробуем первым
    const modern = this.viaAuthInput();
    const all = modern
      ? [['auth', 'face'], ['auth', 'center'], ['tx', 'face'], ['tx', 'center']]
      : [['tx', 'center'], ['tx', 'face']];
    const variants = all.map(([via, look]) => ({ key: `${via}:${look}`, auth: via === 'auth', look: look === 'face' ? facePoint : center }));
    const goodIdx = variants.findIndex((v) => v.key === this.goodVariant);
    if (goodIdx > 0) variants.unshift(variants.splice(goodIdx, 1)[0]);
    for (const v of variants) {
      this.movement.lookAt(v.look);
      await sleep(120); // сервер должен получить новый поворот головы до клика
      if (this.itemUseActions && v.auth) {
        this.movement.blockActions.push({ action: 'start_item_use_on', position: { ...ref }, face });
        setTimeout(() => this.movement.blockActions.push({ action: 'stop_item_use_on', position: { ...ref }, face }), 100);
      }
      this.useItem({ action_type: 'click_block', block_position: ref, face, click_pos: click, block_runtime_id: this.runtimeIdOf(ref) }, v.auth);
      this.swing();
      const ok = await this.waitBlock(target, (b) => b.name !== 'air' && !/water/.test(b.name), 1500);
      if (ok) { this.goodVariant = v.key; return true; }
      if (!this.inv.count(itemName)) break;
    }
    return false;
  }

  /** Ударить существо (как bot.attack): inventory_transaction item_use_on_entity. */
  attack(entity) {
    const pos = entity.position;
    this.movement.lookAt({ x: pos.x, y: pos.y + 0.9, z: pos.z });
    this.swing();
    const e = this.eye();
    const data = {
      entity_runtime_id: entity.id, action_type: 'attack', hotbar_slot: this.inv.selected, hand: 'main_hand',
      held_item: this.inv.held() || this.airItem(), player_pos: { x: e.x, y: e.y, z: e.z }, click_pos: { x: 0, y: 0, z: 0 },
    };
    const tr = this.md.protocol.types.Transaction[1].find((f) => f.name === 'transaction_data').type[1].fields.item_use_on_entity;
    const fields = new Set(tr[1].map((f) => f.name));
    for (const k of Object.keys(data)) if (!fields.has(k)) delete data[k];
    try {
      this.body.client.queue('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'item_use_on_entity', actions: [], transaction_data: data } });
    } catch (err) { this.body.emit('flayerError', err); }
  }

  /** Пустая рука в формате версии. */
  airItem() {
    const t = this.md.protocol.types;
    if (t.ItemV4) return { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } };
    return { network_id: 0 };
  }

  /** Использовать предмет в воздух (еда, зелье): click_air. */
  useInAir(viaAuth) {
    const faceType = this.md.protocol.types.TransactionUseItem[1].find((f) => f.name === 'face')?.type;
    this.useItem({ action_type: 'click_air', block_position: { x: 0, y: 0, z: 0 }, face: faceType === 'u8' ? 255 : -1, click_pos: { x: 0, y: 0, z: 0 } }, viaAuth);
  }

  /** Отпустить предмет (доесть/выстрелить): inventory_transaction item_release. */
  release(action = 'consume') {
    const e = this.eye();
    const data = { action_type: action, hotbar_slot: this.inv.selected, held_item: this.inv.held() || this.airItem(), head_pos: { x: e.x, y: e.y, z: e.z }, hand: 'main_hand' };
    const tr = this.md.protocol.types.Transaction[1].find((f) => f.name === 'transaction_data').type[1].fields.item_release;
    const fields = new Set(tr[1].map((f) => f.name));
    for (const k of Object.keys(data)) if (!fields.has(k)) delete data[k];
    try {
      this.body.client.queue('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'item_release', actions: [], transaction_data: data } });
    } catch (err) { this.body.emit('flayerError', err); }
  }

  /** Съесть предмет из хотбара. Возвращает true, если сытость выросла. */
  async eat(slot) {
    this.inv.select(slot);
    await sleep(150);
    const before = this.body.food;
    const name = this.inv.nameOf(this.inv.held());
    // настоящий клиент: начать использование, держать ~1.6 с, затем сервер засчитывает
    for (const viaAuth of [this.viaAuthInput(), !this.viaAuthInput()]) {
      this.useInAir(viaAuth);
      await sleep(1800);
      if (this.body.food > before || this.inv.nameOf(this.inv.held()) !== name || (this.inv.held()?.count || 0) < (this.inv.slots[slot]?.count || 0)) return true;
      this.useInAir(viaAuth); // повторный клик после длительности — так завершают еду некоторые сервера
      await sleep(300);
      this.release('consume');
      await sleep(700);
      if (this.body.food > before) return true;
    }
    return this.body.food > before;
  }

  /** Нажать на блок (кровать, сундук, печь, рычаг, дверь) пустым кликом. */
  async useBlock(pos) {
    const face = this.faceToward(pos);
    this.movement.lookAt({ x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 });
    await sleep(120);
    const [fx, fy, fz] = FACE_VEC[face];
    const click = { x: 0.5 + fx * 0.5, y: 0.5 + fy * 0.5, z: 0.5 + fz * 0.5 };
    if (this.itemUseActions && this.viaAuthInput()) {
      this.movement.blockActions.push({ action: 'start_item_use_on', position: { ...pos }, face });
      setTimeout(() => this.movement.blockActions.push({ action: 'stop_item_use_on', position: { ...pos }, face }), 100);
    }
    this.useItem({ action_type: 'click_block', block_position: pos, face, click_pos: click, block_runtime_id: this.runtimeIdOf(pos) });
    this.swing();
  }

  viaAuthInput() {
    if (this.movement.authority === 'client') return false;
    const [a, b] = String(this.body.version).split('.').map(Number);
    return a > 1 || b >= 19;
  }

  /** inventory_transaction item_use с полями под версию. */
  useItem(d, viaAuth) {
    const e = this.eye();
    const data = {
      action_type: d.action_type, trigger_type: 'player_input', block_position: d.block_position, face: d.face,
      hotbar_slot: this.inv.selected, hand: 'main_hand', held_item: this.inv.held() || this.airItem(),
      player_pos: { x: e.x, y: e.y, z: e.z }, click_pos: d.click_pos || { x: 0.5, y: 0.5, z: 0.5 },
      block_runtime_id: d.block_runtime_id || 0, client_prediction: 'success', client_cooldown_state: 'off',
    };
    const fields = new Set(this.md.protocol.types.TransactionUseItem[1].map((f) => f.name));
    for (const k of Object.keys(data)) if (!fields.has(k)) delete data[k];
    // 1.19+ с серверной проверкой движения: использование предмета обычно принимается внутри player_auth_input
    if (viaAuth ?? this.viaAuthInput()) {
      this.movement.itemInteract = { legacy: { legacy_request_id: 0 }, actions: [], data };
      return;
    }
    try {
      this.body.client.queue('inventory_transaction', {
        transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'item_use', actions: [], transaction_data: data },
      });
    } catch (err) { this.body.emit('flayerError', err); }
  }
}
