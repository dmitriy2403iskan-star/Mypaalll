// Крафт в Bedrock без команд — как bot.craft в Mineflayer.
// Рецепты присылает сам сервер (crafting_data); крафт — запрос item_stack_request с craft_recipe_auto
// (так делает книга рецептов настоящего клиента): сервер сам забирает ингредиенты из инвентаря.
// 2x2 — прямо в инвентаре, 3x3 — у открытого верстака. Форматы пакетов сильно меняются между версиями,
// поэтому поля действий заполняются по схеме протокола текущей версии.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => String(s || '').replace(/^minecraft:/, '');
const ANY_META = (m) => m === undefined || m === null || m === 32767 || m === -1 || m === 65535;
const WOODS = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak)_/;
const CREATED_OUTPUT_SLOT = 50;

// старые номера действий/дескрипторов (1.21) — в 1.26 их дублируют полями legacy_*
const LEGACY_ACTION = { take: 0, place: 1, swap: 2, drop: 3, destroy: 4, consume: 5, create: 6, craft_recipe: 12, craft_recipe_auto: 13, craft_creative: 14, results_deprecated: 19 };
const LEGACY_DESCRIPTOR = { int_id_meta: 1, molang: 2, item_tag: 3, name: 4, string_id_meta: 4, complex_alias: 5 };

/** Совпадение имени предмета с тегом рецепта (minecraft:planks, minecraft:logs…). */
export function tagMatch(tag, name) {
  const t = strip(tag);
  const n = strip(name);
  switch (t) {
    case 'planks': return /planks$/.test(n);
    case 'logs': case 'logs_that_burn': return /(^log2?$|_log$|_wood$|_stem$|_hyphae$)/.test(n) && !(t === 'logs_that_burn' && /crimson|warped/.test(n));
    case 'wooden_slabs': return /_slab$/.test(n) && (WOODS.test(n) || n === 'wooden_slab');
    case 'stone_tool_materials': case 'stone_crafting_materials': return /^(cobblestone|blackstone|cobbled_deepslate)$/.test(n);
    case 'coals': return /^(coal|charcoal)$/.test(n);
    case 'wool': return /wool$/.test(n);
    case 'sand': return /^(red_)?sand$/.test(n);
    case 'soul_fire_base_blocks': return /^soul_(sand|soil)$/.test(n);
    default: { const base = t.replace(/s$/, ''); return n === base || n.endsWith(`_${base}`); }
  }
}

/** Ингредиент любой версии → { kind, id, name, tag, meta, count, raw }. */
function normIngredient(raw) {
  if (!raw) return { kind: 'empty' };
  const count = raw.count ?? 1;
  // 1.16–1.19: { network_id, network_data, count }
  if (raw.type === undefined) {
    if (!raw.network_id) return { kind: 'empty' };
    return { kind: 'id', id: raw.network_id, meta: raw.network_data, count, raw };
  }
  // 1.26+: { type: 'valid', descriptor_type: 'name'|'item_tag'|'molang'|'empty' }
  const t = raw.type === 'valid' ? raw.descriptor_type : raw.type;
  if (t === 'invalid' || t === 'empty' || !t) return { kind: 'empty' };
  if (t === 'int_id_meta') return raw.network_id ? { kind: 'id', id: raw.network_id, meta: raw.metadata, count, raw } : { kind: 'empty' };
  if (t === 'item_tag') return { kind: 'tag', tag: raw.tag, count, raw };
  if (t === 'name' || t === 'string_id_meta' || t === 'complex_alias' || t === 'deferred') return { kind: 'name', name: strip(raw.name), meta: raw.metadata, count, raw };
  return { kind: 'other', count, raw };
}

export class Crafting {
  constructor(body) {
    this.body = body;
    this.recipes = []; // { networkId, shape: 'shaped'|'shapeless', width, height, input: [...], output: [...], block }
    this.requestId = -1;
    this.waiters = new Map();
    this.window = null; // открытый контейнер (верстак)
    const c = body.client;
    c.on('crafting_data', (p) => { try { this.onCraftingData(p); } catch (e) { body.emit('flayerError', e); } });
    c.on('item_stack_response', (p) => {
      for (const r of p.responses || []) {
        const w = this.waiters.get(r.request_id);
        if (w) { this.waiters.delete(r.request_id); w(r); }
      }
    });
    c.on('container_open', (p) => { this.window = { id: p.window_id, type: p.window_type, at: p.coordinates }; body.emit('containerOpen', this.window); });
    c.on('container_close', (p) => { if (this.window && String(this.window.id) === String(p.window_id)) this.window = null; });
  }

  get md() { return (this._md ||= require('minecraft-data')(`bedrock_${this.body.version || this.body.client.options?.version}`)); }
  get types() { return this.md.protocol.types; }

  onCraftingData(p) {
    const add = (shape, r) => {
      if (!r || r.network_id === undefined) return;
      const flat = Array.isArray(r.input) ? r.input.flat(2) : [];
      this.recipes.push({ networkId: r.network_id, shape, width: r.width || 0, height: r.height || 0, input: flat.map(normIngredient), output: r.output || [], block: r.block, id: r.recipe_id });
    };
    if (p.clear_recipes || p.is_clean) this.recipes = [];
    if (Array.isArray(p.recipes)) { // до 1.26: общий список с полем type
      for (const e of p.recipes) {
        if (e.type === 'shaped' || e.type === 'shaped_chemistry') add('shaped', e.recipe);
        else if (e.type === 'shapeless' || e.type === 'shapeless_chemistry' || e.type === 'shulker_box') add('shapeless', e.recipe);
      }
    } else { // 1.26+: отдельные массивы
      for (const r of p.shaped_recipes || []) add('shaped', r);
      for (const r of p.shapeless_recipes || []) add('shapeless', r);
    }
    this.body.emit('recipes', this.recipes.length);
  }

  /** Нужен ли верстак (рецепт больше 2x2). */
  needsTable(r) {
    if (r.shape === 'shaped') return r.width > 2 || r.height > 2;
    return r.input.filter((i) => i.kind !== 'empty').length > 4;
  }

  outputName(r) { return this.body.inventory.nameOf(r.output[0]); }

  matches(ing, item) {
    if (!item || !item.network_id) return false;
    const name = this.body.inventory.nameOf(item);
    if (ing.kind === 'id') return item.network_id === ing.id && (ANY_META(ing.meta) || item.metadata === ing.meta);
    if (ing.kind === 'name') return name === ing.name && (ANY_META(ing.meta) || item.metadata === ing.meta);
    if (ing.kind === 'tag') return tagMatch(ing.tag, name);
    return false;
  }

  /** Рецепты, дающие предмет (с учётом старых имён: planks/log с метаданными). */
  recipesFor(itemName) {
    const want = strip(itemName);
    let list = this.recipes.filter((r) => r.output[0] && this.outputName(r) === want && /crafting_table|deprecated/.test(r.block || 'crafting_table'));
    if (!list.length && WOODS.test(want)) {
      const base = want.replace(WOODS, '');
      list = this.recipes.filter((r) => r.output[0] && this.outputName(r) === base && /crafting_table/.test(r.block || 'crafting_table'));
    }
    return list;
  }

  /** План списания: какие слоты сколько отдают на `times` крафтов; null — не хватает. */
  plan(r, times = 1) {
    const slots = this.body.inventory.slots;
    const left = slots.map((it) => (it?.count || 0));
    const use = new Map();
    for (const ing of r.input) {
      if (ing.kind === 'empty') continue;
      let need = (ing.count || 1) * times;
      for (let i = 0; i < 36 && need > 0; i++) {
        if (!left[i] || !this.matches(ing, slots[i])) continue;
        const take = Math.min(left[i], need);
        left[i] -= take; need -= take; use.set(i, (use.get(i) || 0) + take);
      }
      if (need > 0) return null;
    }
    return use;
  }

  /** Что не хватает для рецепта (для сообщения нейросети). */
  missingFor(r, times = 1) {
    const out = {};
    const inv = this.body.inventory;
    const tally = new Map();
    for (const ing of r.input) {
      if (ing.kind === 'empty') continue;
      const key = ing.kind === 'tag' ? strip(ing.tag) : ing.kind === 'name' ? ing.name : inv.names.get(ing.id) || `id:${ing.id}`;
      tally.set(key, { ing, n: (tally.get(key)?.n || 0) + (ing.count || 1) * times });
    }
    for (const [key, { ing, n }] of tally) {
      const have = inv.slots.reduce((s, it) => s + (this.matches(ing, it) ? it.count : 0), 0);
      if (have < n) out[key] = n - have;
    }
    return out;
  }

  // ------------------------------------------------------------ сборка пакета под версию
  actionSchema(kind) {
    const isr = this.types.ItemStackRequest[1].find((f) => f.name === 'actions').type[1].type[1];
    const sw = isr.find((f) => f.anon)?.type?.[1]?.fields || {};
    const fields = sw[kind];
    return Array.isArray(fields) ? fields[1] : [];
  }

  slotInfo(slotType, slot, stackId) {
    const t = this.types.StackRequestSlotInfo[1].find((f) => f.name === 'slot_type').type;
    const st = t === 'FullContainerName' ? { container_id: slotType, dynamic_container_id: undefined } : slotType;
    return { slot_type: st, slot, stack_id: stackId ?? 0 };
  }

  invSlotType(i, style) {
    if (style === 'combined') return 'hotbar_and_inventory';
    return i < 9 ? 'hotbar' : 'inventory';
  }

  /** Ингредиент рецепта → формат поля ingredients в craft_recipe_auto этой версии. */
  autoIngredients(r, times) {
    const field = this.actionSchema('craft_recipe_auto').find((f) => f.name === 'ingredients');
    if (!field) return undefined;
    const target = field.type?.[1]?.type;
    const list = r.input.filter((i) => i.kind !== 'empty');
    if (this.autoIngredientsMode === 'none') return [];
    if (target === 'RecipeIngredient2') {
      return list.map((i) => {
        const count = (i.count || 1) * times;
        if (i.kind === 'tag') return { type: 'item_tag', legacy_type: LEGACY_DESCRIPTOR.item_tag, tag: i.tag, count };
        const name = i.kind === 'name' ? i.name : this.body.inventory.names.get(i.id);
        return { type: 'name', legacy_type: LEGACY_DESCRIPTOR.name, name: `minecraft:${name}`, metadata: ANY_META(i.meta) ? 32767 : i.meta, count };
      });
    }
    return list.map((i) => i.raw);
  }

  resultItems(r, times) {
    const field = this.actionSchema('results_deprecated').find((f) => f.name === 'result_items');
    const t = field?.type?.[1]?.type;
    if (t === 'ItemStackRequestInstanceDescriptor') {
      return r.output.map((o) => ({
        type: 'name', legacy_type: LEGACY_DESCRIPTOR.name, name: `minecraft:${this.body.inventory.nameOf(o)}`, metadata: o.metadata || 0,
        count: (o.count || 1) * times, block_runtime_id: o.block_runtime_id || 0, extra: o.extra || { has_nbt: 0, can_place_on: [], can_destroy: [] },
      }));
    }
    return r.output.map((o) => ({ ...o, count: (o.count || 1) * times }));
  }

  /** results_deprecated: старый клиент его шлёт; в 1.26.60+ формат описания предмета другой — по умолчанию не шлём. */
  resultsAction(r, times) {
    const field = this.actionSchema('results_deprecated').find((f) => f.name === 'result_items');
    const modern = field?.type?.[1]?.type === 'ItemStackRequestInstanceDescriptor';
    const mode = this.resultsMode || (modern ? 'none' : 'full');
    if (mode === 'none') return null;
    return this.action('results_deprecated', { result_items: mode === 'empty' ? [] : this.resultItems(r, times), times });
  }

  action(kind, values) {
    const out = { type_id: kind };
    for (const f of this.actionSchema(kind)) {
      if (f.name in values) out[f.name] = values[f.name];
      else if (f.name === 'times_crafted' || f.name === 'times_crafted_2') out[f.name] = values.times ?? 1;
      else if (f.name === 'randomly') out[f.name] = false;
    }
    if (this.types.ItemStackRequest[1].find((f) => f.name === 'actions').type[1].type[1].some((f) => f.name === 'legacy_type_id')) out.legacy_type_id = LEGACY_ACTION[kind] ?? 0;
    return out;
  }

  send(actions) {
    const id = this.requestId;
    this.requestId -= 2;
    const req = { request_id: id, actions, custom_names: [] };
    if (this.types.ItemStackRequest[1].some((f) => f.name === 'cause')) req.cause = 'chat_public';
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(id); resolve({ status: 'timeout', request_id: id }); }, 3000);
      this.waiters.set(id, (r) => { clearTimeout(timer); resolve(r); });
      try { this.body.client.queue('item_stack_request', { requests: [req] }); } catch (e) { clearTimeout(timer); this.waiters.delete(id); resolve({ status: 'error', error: e.message }); }
    }).then((r) => ({ ...r, request_id: r.request_id ?? id }));
  }

  /** Применить ответ сервера к нашему инвентарю (новые количества и stack_id). Возвращает { контейнер: { слот: stack_id } }. */
  applyResponse(resp, placed) {
    const inv = this.body.inventory;
    const seen = {};
    for (const cont of resp.containers || []) {
      const type = String(cont.slot_type?.container_id ?? cont.slot_type);
      for (const s of cont.slots || []) (seen[type] ||= {})[s.slot] = s.item_stack_id;
      if (!/hotbar|inventory/.test(type)) continue;
      for (const s of cont.slots || []) {
        const i = s.slot;
        if (i < 0 || i >= 36) continue;
        if (!s.count) { inv.slots[i] = null; continue; }
        const base = inv.slots[i] || (placed && placed.slot === i ? placed.item : null);
        if (!base) continue;
        inv.slots[i] = { ...base, count: s.count, stack_id: s.item_stack_id ?? base.stack_id, has_stack_id: 1 };
      }
    }
    return seen;
  }

  /** Слот для готового предмета: стопка того же предмета или пустой. */
  destSlot(item, count) {
    const inv = this.body.inventory;
    for (let i = 0; i < 36; i++) { const s = inv.slots[i]; if (s && s.network_id === item.network_id && (s.metadata || 0) === (item.metadata || 0) && s.count + count <= 64) return i; }
    for (let i = 0; i < 36; i++) if (!inv.slots[i]?.network_id) return i;
    return -1;
  }

  /** Один крафт по рецепту (times раз): сначала через книгу рецептов, затем «руками» через сетку. */
  async craftOnce(r, times = 1, { table = false } = {}) {
    if (!this.plan(r, times)) return { ok: false, error: 'не хватает ингредиентов' };
    // до 1.17 у craft_recipe_auto другой формат — сервер рвёт соединение, поэтому только «руками» через сетку
    const [maj, min] = String(this.body.version).split('.').map(Number);
    const all = maj === 1 && min < 17 ? ['grid'] : ['auto', 'grid'];
    const methods = this.goodMethod ? [this.goodMethod, ...all.filter((m) => m !== this.goodMethod)] : all;
    const errors = [];
    for (const m of methods) {
      const res = m === 'auto' ? await this.craftAuto(r, times) : await this.craftGrid(r, table);
      if (res.ok) { this.goodMethod = m; return res; }
      errors.push(`${m}: ${res.error}`);
      if (!this.plan(r, times)) break; // часть ингредиентов застряла в сетке — вернутся при закрытии окна
    }
    return { ok: false, error: errors.join('; ') };
  }

  async craftAuto(r, times = 1) {
    const use = this.plan(r, times);
    const out = r.output[0];
    const outCount = (out.count || 1) * times;
    const dest = this.destSlot(out, outCount);
    if (dest < 0) return { ok: false, error: 'инвентарь полон' };
    const inv = this.body.inventory;
    const styles = this.goodStyle ? [this.goodStyle] : ['split', 'combined'];
    let last = null;
    for (const style of styles) {
      const id = this.requestId;
      const actions = [
        this.action('craft_recipe_auto', { recipe_network_id: r.networkId, times, ingredients: this.autoIngredients(r, times) }),
      ];
      const rd = this.resultsAction(r, times); if (rd) actions.push(rd);
      for (const [slot, n] of use) actions.push(this.action('consume', { count: n, source: this.slotInfo(this.invSlotType(slot, style), slot, inv.slots[slot]?.stack_id) }));
      const destStack = inv.slots[dest]?.stack_id ?? 0;
      actions.push(this.action('place', { count: outCount, source: this.slotInfo('creative_output', CREATED_OUTPUT_SLOT, id), destination: this.slotInfo(this.invSlotType(dest, style), dest, destStack) }));
      const resp = await this.send(actions);
      last = resp;
      if (resp.status === 'ok') {
        this.goodStyle = style;
        // сначала сами считаем результат (сервер перечисляет не все изменённые слоты), затем уточняем по ответу
        for (const [slot, n] of use) { const it = inv.slots[slot]; inv.slots[slot] = it && it.count > n ? { ...it, count: it.count - n } : null; }
        this.addOutput(dest, out, outCount);
        this.applyResponse(resp);
        return { ok: true };
      }
      if (resp.status === 'timeout') break;
    }
    return { ok: false, error: `сервер отклонил (${last?.status ?? '?'})` };
  }

  /** Раскладка рецепта по клеткам сетки: [{ cell, ing }]. 2x2 — слоты 28–31, 3x3 — 32–40. */
  layout(r, table) {
    const gw = table ? 3 : 2;
    const base = table ? 32 : 28;
    const cells = [];
    if (r.shape === 'shaped') {
      r.input.forEach((ing, k) => { if (ing.kind !== 'empty') cells.push({ cell: base + Math.floor(k / r.width) * gw + (k % r.width), ing }); });
    } else {
      let k = 0;
      for (const ing of r.input) if (ing.kind !== 'empty') for (let n = 0; n < (ing.count || 1); n++) cells.push({ cell: base + k++, ing });
    }
    return cells;
  }

  /** Как игрок: открыть инвентарь (или верстак), разложить по одному предмету в сетку, забрать результат. */
  async craftGrid(r, table) {
    const inv = this.body.inventory;
    const style = this.goodStyle || 'split';
    if (!table) await this.openInventory();
    const cells = this.layout(r, table);
    const grid = new Map(); // клетка → stack_id
    for (const { cell, ing } of cells) {
      let src = -1;
      for (let i = 0; i < 36; i++) if (inv.slots[i]?.count && this.matches(ing, inv.slots[i])) { src = i; break; }
      if (src < 0) return { ok: false, error: 'не хватает ингредиентов' };
      const item = inv.slots[src];
      const resp = await this.send([this.action('place', { count: 1, source: this.slotInfo(this.invSlotType(src, style), src, item.stack_id), destination: this.slotInfo('crafting_input', cell, 0) })]);
      if (resp.status !== 'ok') return { ok: false, error: `не положил в сетку (${resp.status})` };
      inv.slots[src] = item.count > 1 ? { ...item, count: item.count - 1 } : null;
      const got = this.applyResponse(resp);
      grid.set(cell, got.crafting_input?.[cell] ?? resp.request_id);
    }
    const out = r.output[0];
    const outCount = out.count || 1;
    const dest = this.destSlot(out, outCount);
    if (dest < 0) return { ok: false, error: 'инвентарь полон' };
    const id = this.requestId;
    const actions = [
      this.action('craft_recipe', { recipe_network_id: r.networkId, times: 1 }),
    ];
    const rd = this.resultsAction(r, 1); if (rd) actions.push(rd);
    for (const [cell, sid] of grid) actions.push(this.action('consume', { count: 1, source: this.slotInfo('crafting_input', cell, sid) }));
    actions.push(this.action('place', { count: outCount, source: this.slotInfo('creative_output', CREATED_OUTPUT_SLOT, id), destination: this.slotInfo(this.invSlotType(dest, style), dest, inv.slots[dest]?.stack_id ?? 0) }));
    const resp = await this.send(actions);
    if (resp.status !== 'ok') return { ok: false, error: `сервер отклонил (${resp.status})` };
    this.addOutput(dest, out, outCount);
    this.applyResponse(resp);
    return { ok: true };
  }

  addOutput(dest, out, n) {
    const inv = this.body.inventory;
    const cur = inv.slots[dest];
    inv.slots[dest] = cur?.network_id ? { ...cur, count: cur.count + n } : { ...out, count: n, has_stack_id: 1, stack_id: 0 };
  }

  /** Открыть свой инвентарь (как кнопка E) — некоторые сервера крафтят 2x2 только при открытом экране. */
  async openInventory() {
    if (this.window) return true;
    const opened = new Promise((resolve) => {
      const t = setTimeout(() => { this.body.off('containerOpen', on); resolve(false); }, 1200);
      const on = () => { clearTimeout(t); resolve(true); };
      this.body.once('containerOpen', on);
    });
    const data = { action_id: 'open_inventory', target_entity_id: this.body.runtimeId };
    if (this.types.packet_interact[1].some((f) => f.name === 'has_position')) data.has_position = false;
    try { this.body.client.queue('interact', data); } catch { return false; }
    return opened;
  }

  /** Переложить предмет из рюкзака в свободный слот хотбара (как перетаскивание мышью). */
  async toHotbar(name) {
    const inv = this.body.inventory;
    const from = inv.findSlot(name);
    if (from < 0) return -1;
    if (from < 9) return from;
    let to = -1;
    for (let i = 0; i < 9; i++) if (!inv.slots[i]?.network_id) { to = i; break; }
    const styles = this.goodStyle ? [this.goodStyle] : ['split', 'combined'];
    for (const style of styles) {
      const item = inv.slots[from];
      const act = to >= 0
        ? this.action('place', { count: item.count, source: this.slotInfo(this.invSlotType(from, style), from, item.stack_id), destination: this.slotInfo(this.invSlotType(to, style), to, 0) })
        : this.action('swap', { source: this.slotInfo(this.invSlotType(from, style), from, item.stack_id), destination: this.slotInfo(this.invSlotType(inv.selected, style), inv.selected, inv.slots[inv.selected]?.stack_id ?? 0) });
      const resp = await this.send([act]);
      if (resp.status === 'ok') {
        this.goodStyle = style;
        const dst = to >= 0 ? to : inv.selected;
        const moved = inv.slots[from]; const old = inv.slots[dst];
        inv.slots[dst] = moved; inv.slots[from] = to >= 0 ? null : old;
        this.applyResponse(resp);
        return dst;
      }
      if (resp.status === 'timeout') break;
    }
    return -1;
  }

  // ------------------------------------------------------------ верстак
  async openTable(pos) {
    const hands = this.body.hands;
    if (this.window && /workbench|crafting/.test(String(this.window.type))) return true;
    const face = hands.faceToward(pos);
    this.body.movement.lookAt({ x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 });
    await sleep(120);
    const opened = new Promise((resolve) => {
      const t = setTimeout(() => { this.body.off('containerOpen', on); resolve(false); }, 2500);
      const on = () => { clearTimeout(t); resolve(true); };
      this.body.once('containerOpen', on);
    });
    for (const viaAuth of [hands.viaAuthInput(), !hands.viaAuthInput()]) {
      if (hands.itemUseActions && viaAuth) {
        this.body.movement.blockActions.push({ action: 'start_item_use_on', position: { ...pos }, face });
        setTimeout(() => this.body.movement.blockActions.push({ action: 'stop_item_use_on', position: { ...pos }, face }), 100);
      }
      hands.useItem({ action_type: 'click_block', block_position: pos, face, click_pos: { x: 0.5, y: 0.5, z: 0.5 }, block_runtime_id: hands.runtimeIdOf(pos) }, viaAuth);
      hands.swing();
      const ok = await Promise.race([opened, sleep(1200).then(() => false)]);
      if (ok) return true;
    }
    return opened;
  }

  closeWindow() {
    if (!this.window) return;
    const w = this.window;
    this.window = null;
    const data = { window_id: w.id, server: false };
    if (this.types.packet_container_close[1].some((f) => f.name === 'window_type')) data.window_type = w.type;
    try { this.body.client.queue('container_close', data); } catch { /* */ }
  }
}
