// Действия Bedrock-бота руками (без команд) — для выживания, как в Java-версии.
import { ActionError } from '../actions/util.js';
import { house, simple, custom, billOfMaterials } from '../building/blueprints.js';
import { fmt } from '../building/executor.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const handsReady = (pal) => Boolean(pal.bot?.hands && pal.bot?.nativeReady);
const AIR = /^(air|cave_air|void_air)$/;

/** Ближайшие блоки по имени (или его части) в загруженном мире вокруг бота. */
export function findBlocksNear(body, name, radius = 16, max = 16) {
  const p = body.movement.position;
  const cx = Math.floor(p.x); const cy = Math.floor(p.y); const cz = Math.floor(p.z);
  const found = [];
  const match = (n) => n === name || n.includes(name);
  for (let r = 0; r <= radius && found.length < max; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (let dy = -8; dy <= 8; dy++) {
          const b = body.blockAt(cx + dx, cy + dy, cz + dz);
          if (b && match(b.name)) found.push({ x: cx + dx, y: cy + dy, z: cz + dz, name: b.name });
        }
      }
    }
  }
  return found.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z) - Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z)).slice(0, max);
}

/** Лучший инструмент из хотбара под блок. */
function equipBestTool(body, blockName) {
  const material = body.world.registry.blocksByName?.[blockName]?.material || '';
  const kind = /rock|stone|metal|ore/.test(material) ? 'pickaxe' : /wood/.test(material) ? '_axe' : /dirt|sand|gravel|grass|snow|clay/.test(material) ? 'shovel' : null;
  if (!kind) return;
  const order = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
  for (const tier of order) {
    const slot = body.inventory.findSlot((n) => n.startsWith(tier) && n.includes(kind), true);
    if (slot >= 0) { body.inventory.select(slot); return; }
  }
}

async function approach(pal, pos, range = 3.5) {
  const body = pal.bot;
  if (body.hands.inReach(pos, range + 0.5)) return;
  await body.goto({ x: pos.x + 0.5, y: pos.y, z: pos.z + 0.5 }, range, 30000).catch((e) => { throw new ActionError(`Не могу подойти: ${e.message}`); });
}

export async function collectBlocks(pal, blockName, count) {
  const body = pal.bot;
  count = Math.min(Math.max(1, Math.round(count || 1)), 64);
  let mined = 0; let lastError = '';
  for (let i = 0; i < count && !pal.interrupted; i++) {
    const target = findBlocksNear(body, blockName, 24, 1)[0];
    if (!target) { lastError = `рядом нет «${blockName}» (радиус 24)`; break; }
    try {
      await approach(pal, target);
      equipBestTool(body, target.name);
      const ok = await body.dig(target);
      if (!ok) { lastError = 'сервер не подтвердил ломание'; continue; }
      mined++;
      await pickupDrops(pal, target);
    } catch (e) { lastError = e.message; if (pal.interrupted) break; }
  }
  if (!mined) throw new ActionError(`Не удалось добыть ${blockName}: ${lastError}`);
  return `Добыл ${mined}/${count} ${blockName} руками.${lastError ? ` Проблема: ${lastError}.` : ''} Инвентарь: ${fmt(body.inventory.summary())}`;
}

/** Подобрать выпавшие предметы рядом (подойти вплотную — сервер сам кладёт их в инвентарь). */
export async function pickupDrops(pal, near) {
  const body = pal.bot;
  await sleep(600); // предмет появляется не сразу и подбирается после короткой задержки
  for (let i = 0; i < 4 && !pal.interrupted; i++) {
    const drop = body.inventory.nearbyDrops(near, 6)[0];
    const to = drop ? drop.position : { x: near.x + 0.5, y: near.y, z: near.z + 0.5 };
    await body.goto({ x: to.x, y: to.y, z: to.z }, 0.4, 5000).catch(() => {});
    await sleep(500);
    if (!body.inventory.nearbyDrops(near, 6).length) break;
  }
}

export async function placeOne(pal, item, pos) {
  await approach(pal, pos, 4);
  const ok = await pal.bot.placeBlock(pos, item);
  if (!ok) throw new ActionError('Сервер не подтвердил установку');
  return `Поставил ${item}.`;
}

export async function breakOne(pal, pos) {
  const b = pal.bot.blockAt(pos.x, pos.y, pos.z);
  if (!b || AIR.test(b.name)) return 'Там пусто.';
  await approach(pal, pos);
  equipBestTool(pal.bot, b.name);
  const ok = await pal.bot.dig(pos);
  if (!ok) throw new ActionError('Сервер не подтвердил ломание');
  return `Сломал ${b.name}.`;
}

/** Стройка руками по чертежу (выживание): копаем, затем ставим снизу вверх. */
export async function buildByHands(pal, plan, origin, title, { dryRun = false } = {}) {
  const body = pal.bot;
  const abs = plan.ops.map((op) => ({ ...op, x: origin.x + op.x, y: origin.y + op.y, z: origin.z + op.z }));
  const todo = abs.filter((op) => { const b = body.blockAt(op.x, op.y, op.z); return op.dig ? b && !AIR.test(b.name) : !b || b.name !== op.block; });
  const bill = billOfMaterials(todo.filter((o) => o.block));
  const missing = {};
  for (const [item, n] of Object.entries(bill)) { const have = body.inventory.count(item); if (have < n) missing[item] = n - have; }
  if (dryRun) return `${title}: ${plan.summary}. Угол ${origin.x} ${origin.y} ${origin.z}. Нужно: ${fmt(bill)}. ${Object.keys(missing).length ? `Не хватает: ${fmt(missing)} — добудь или скрафти.` : 'Всего хватает.'} Строю руками.`;
  if (Object.keys(missing).length) throw new ActionError(`Не хватает материалов: ${fmt(missing)}. Нужно всего: ${fmt(bill)}.`);
  let dug = 0; let placed = 0; const failed = [];
  for (const op of todo.filter((o) => o.dig).sort((a, b) => b.y - a.y)) {
    if (pal.interrupted) break;
    try { await breakOne(pal, op); dug++; } catch (e) { failed.push(`копать ${op.x} ${op.y} ${op.z}: ${e.message}`); }
  }
  const places = todo.filter((o) => o.block).sort((a, b) => a.y - b.y || Boolean(a.attach) - Boolean(b.attach));
  for (let pass = 0; pass < 2 && !pal.interrupted; pass++) {
    for (const op of places) {
      if (pal.interrupted) break;
      const cur = body.blockAt(op.x, op.y, op.z);
      if (cur?.name === op.block) continue;
      if (op.optional && !body.inventory.count(op.block)) continue;
      try { await placeOne(pal, op.block, op); placed++; } catch (e) { if (pass === 1) failed.push(`${op.block} ${op.x} ${op.y} ${op.z}: ${e.message}`); }
    }
  }
  pal.memory.add('episodic', `Построил руками ${plan.summary} в ${origin.x} ${origin.y} ${origin.z}`, 3);
  return `${title} — готово руками: ${plan.summary}. Поставлено ${placed}, выкопано ${dug}.${failed.length ? ` Не вышло ${failed.length}: ${failed.slice(0, 2).join('; ')}` : ''}`;
}

/** Верстак рядом: найти, иначе поставить из инвентаря, иначе скрафтить из досок (как craft_item в Java). */
async function ensureTable(pal) {
  const body = pal.bot;
  let table = findBlocksNear(body, 'crafting_table', 24, 1)[0];
  if (!table) {
    if (!body.inventory.count('crafting_table')) await craftItem(pal, 'crafting_table', 1, { noTable: true });
    body.crafting.closeWindow();
    let why = '';
    const me = body.movement.position;
    const bx = Math.floor(me.x); const by = Math.floor(me.y); const bz = Math.floor(me.z);
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [1, 2], [-2, -1], [-1, -2]]) {
      const c = { x: bx + dx, y: by, z: bz + dz };
      const here = body.blockAt(c.x, c.y, c.z); const down = body.blockAt(c.x, c.y - 1, c.z);
      if (here && AIR.test(here.name) && down?.solid) {
        try { if (await body.placeBlock(c, 'crafting_table')) { table = c; break; } why = 'сервер не подтвердил'; } catch (e) { why = e.message; }
      }
    }
    if (!table) throw new ActionError(`Не получилось поставить верстак рядом${why ? `: ${why}` : ''}`);
  }
  await approach(pal, table, 3);
  if (!(await body.crafting.openTable(table))) throw new ActionError('Верстак не открылся');
  return table;
}

/** Запасной крафт для серверов без серверного инвентаря: /clear ингредиентов и /give результата. */
async function craftByCommands(pal, r) {
  const body = pal.bot; const cr = body.crafting; const inv = body.inventory;
  const use = cr.plan(r, 1);
  if (!use) return { ok: false, error: 'не хватает ингредиентов' };
  const who = body.username;
  for (const [slot, n] of use) {
    const it = inv.slots[slot];
    const res = await body.command(`clear ${who} ${inv.nameOf(it)} ${it.metadata || 0} ${n}`, 4000);
    if (!res.success) return { ok: false, error: `сервер не принимает крафт из инвентаря, а команды недоступны (${res.output})` };
    inv.slots[slot] = it.count > n ? { ...it, count: it.count - n } : null;
  }
  const out = r.output[0];
  const g = await body.command(`give ${who} ${inv.nameOf(out)} ${out.count || 1} ${out.metadata || 0}`, 4000);
  if (!g.success) return { ok: false, error: `не выдался результат (${g.output})` };
  const dest = cr.destSlot(out, out.count || 1);
  if (dest >= 0) cr.addOutput(dest, out, out.count || 1);
  return { ok: true, viaCommands: true };
}

/** Скрафтить предмет руками (2x2 в инвентаре, 3x3 — у верстака). */
export async function craftItem(pal, item, count = 1, { noTable = false } = {}) {
  const body = pal.bot;
  const cr = body.crafting;
  const name = String(item).replace(/^minecraft:/, '');
  if (!cr?.recipes.length) throw new ActionError('Сервер ещё не прислал рецепты — подожди пару секунд.');
  const list = cr.recipesFor(name);
  if (!list.length) throw new ActionError(`Для «${name}» нет рецепта крафта на этом сервере.`);
  count = Math.min(Math.max(1, Math.round(count || 1)), 256);
  const before = body.inventory.count(cr.outputName(list[0]));
  let made = 0; let usedTable = false;
  try {
    while (made < count && !pal.interrupted) {
      const r = list.find((x) => cr.plan(x, 1) && !(noTable && cr.needsTable(x)));
      if (!r) {
        if (made) break;
        const cands = list.filter((x) => !(noTable && cr.needsTable(x)));
        const total = (x) => Object.values(cr.missingFor(x)).reduce((a, b) => a + b, 0);
        const best = (cands.length ? cands : list).sort((a, b) => total(a) - total(b))[0];
        throw new ActionError(`Не хватает материалов для ${name}: ${fmt(cr.missingFor(best))}. Инвентарь: ${fmt(body.inventory.summary())}`);
      }
      if (cr.needsTable(r) && !usedTable) { await ensureTable(pal); usedTable = true; }
      let res = cr.silent ? { ok: false, error: 'timeout' } : await cr.craftOnce(r, 1, { table: cr.needsTable(r) });
      // старые сервера (1.16) молчат на запросы инвентаря — крафтим командами, если у бота есть права
      if (!res.ok && /timeout/.test(res.error) && !/ok/.test(res.error)) { cr.silent = true; res = await craftByCommands(pal, r); }
      if (!res.ok) { if (made) break; throw new ActionError(`Крафт ${name} не удался: ${res.error}`); }
      made += r.output[0].count || 1;
      await sleep(80);
    }
  } finally {
    cr.closeWindow(); // закрыть верстак/инвентарь: всё, что осталось в сетке, вернётся в инвентарь
  }
  const outName = cr.outputName(list[0]);
  return `Скрафтил ${made} ${outName}${made < count ? ` (на ${count} не хватило материалов)` : ''}. Теперь в инвентаре: ${body.inventory.count(outName) || before + made}.`;
}

export { house, simple, custom };

// ====================================================================== как в Java: бой, еда, предметы, контейнеры
import { isHostileType } from './flayer/entities.js';

const FOOD_PRIORITY = ['golden_carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_salmon', 'cooked_chicken', 'cooked_cod',
  'baked_potato', 'bread', 'cooked_rabbit', 'pumpkin_pie', 'apple', 'carrot', 'beef', 'porkchop', 'mutton', 'chicken', 'potato', 'sweet_berries',
  'melon_slice', 'cookie', 'beetroot', 'dried_kelp', 'cod', 'salmon', 'rabbit', 'golden_apple'];
const WEAPON_ORDER = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Взять предмет в руку (из рюкзака переложить в хотбар). */
export async function holdItem(body, name) {
  let slot = body.inventory.findSlot(name, true);
  if (slot < 0 && body.inventory.count(name)) slot = await body.crafting.toHotbar(name);
  if (slot < 0) return false;
  body.inventory.select(slot);
  await sleep(120);
  return true;
}

async function equipWeapon(body) {
  for (const w of WEAPON_ORDER) if (body.inventory.count(w)) { await holdItem(body, w); return w; }
  return null;
}

/** Найти существо по имени/типу или 'hostile'. */
export function findEntity(body, target, radius = 32) {
  const t = String(target || '').toLowerCase().replace(/^minecraft:/, '');
  return body.entities.nearest(body.movement.position, (e) => {
    if (String(e.id) === String(body.runtimeId)) return false;
    if (t === 'hostile') return isHostileType(e.type);
    return e.type === t || (e.name && e.name.toLowerCase() === t);
  }, radius);
}

/** Бой до победы (как bot.pvp.attack): подходить, бить с кулдауном, следить за смертью цели. */
export async function fight(pal, entity, { timeoutMs = 30000 } = {}) {
  const body = pal.bot;
  await equipWeapon(body);
  const t0 = Date.now();
  let hits = 0;
  while (Date.now() - t0 < timeoutMs && !pal.interrupted && !body.ended) {
    const e = body.entities.get(String(entity.id));
    if (!e || !e.alive) return { won: true, hits };
    const me = body.movement.position;
    if (dist(me, e.position) > 3) {
      await body.goto({ x: e.position.x, y: e.position.y, z: e.position.z }, 2.2, 2500).catch(() => {});
      continue;
    }
    body.hands.attack(e);
    hits++;
    await sleep(650); // кулдаун удара оружием
  }
  const e = body.entities.get(String(entity.id));
  return { won: !e || !e.alive, hits };
}

export async function attackTarget(pal, target) {
  const body = pal.bot;
  const e = findEntity(body, target);
  if (!e) throw new ActionError(`Рядом нет ${target}.`);
  if (e.type === 'player' && e.name === pal.owner?.()) throw new ActionError('Я не буду атаковать своего напарника.');
  const { won, hits } = await fight(pal, e);
  return won ? `Победил ${e.name || e.type} (ударов: ${hits}).` : `Бой с ${e.name || e.type} прерван (ударов: ${hits}).`;
}

/** Съесть лучшую еду (как eatBest в Java). */
export async function eatBest(pal) {
  const body = pal.bot;
  const have = FOOD_PRIORITY.filter((f) => body.inventory.count(f));
  if (!have.length) return null;
  const food = have[0];
  if (!(await holdItem(body, food))) return null;
  const ok = await body.hands.eat(body.inventory.selected);
  return ok ? food : null;
}

/** Отдать игроку: подойти, посмотреть на него и выбросить (как bot.toss). */
export async function giveTo(pal, player, item, count) {
  const body = pal.bot;
  const name = String(item).replace(/^minecraft:/, '');
  const have = body.inventory.count(name);
  if (!have) throw new ActionError(`Нет ${name} в инвентаре. Есть: ${fmt(body.inventory.summary())}`);
  if (player) {
    const p = body.findPlayer(player)?.position;
    if (!p) throw new ActionError(`Не вижу ${player}.`);
    await body.goto(p, 2, 30000).catch((e) => { throw new ActionError(`Не дошёл до ${player}: ${e.message}`); });
    body.movement.lookAt({ x: p.x, y: p.y + 1.2, z: p.z });
    await sleep(150);
  }
  let left = Math.min(count ?? have, have);
  let dropped = 0;
  while (left > 0) {
    const slot = await body.crafting.toHotbar(name);
    if (slot < 0) break;
    const n = Math.min(left, body.inventory.slots[slot]?.count || 0);
    const r = await body.crafting.drop(slot, n);
    if (!r.ok) { if (!dropped) throw new ActionError(`Не получилось выбросить: ${r.error}`); break; }
    dropped += n; left -= n;
  }
  return dropped;
}

/** Надеть броню или взять в руку. */
export async function equipItem(pal, item, where) {
  const body = pal.bot;
  const name = String(item).replace(/^minecraft:/, '');
  if (!body.inventory.count(name)) throw new ActionError(`Нет ${name}.`);
  const auto = /helmet|_head$|skull|carved_pumpkin/.test(name) ? 'head' : /chestplate|elytra/.test(name) ? 'torso' : /leggings/.test(name) ? 'legs' : /boots/.test(name) ? 'feet' : name === 'shield' || name === 'totem_of_undying' ? 'off-hand' : 'hand';
  const slotName = where || auto;
  if (slotName === 'hand') { await holdItem(body, name); return `Взял ${name} в руку.`; }
  const slot = body.inventory.findSlot(name);
  const r = await body.crafting.wear(slot, slotName);
  if (!r.ok) throw new ActionError(`Не получилось надеть ${name}: ${r.error}`);
  return `Экипировал ${name} (${slotName}).`;
}

/** Лечь в ближайшую кровать. */
export async function sleepInBed(pal) {
  const body = pal.bot;
  const bed = findBlocksNear(body, 'bed', 32, 1)[0];
  if (!bed) throw new ActionError('Рядом нет кровати.');
  await approach(pal, bed, 2.5);
  const before = body.movement.position;
  await body.hands.useBlock(bed);
  await sleep(1500);
  const after = body.movement.position;
  return dist(before, after) > 0.3 || body.sleeping ? 'Лёг спать. Проснусь утром.' : 'Нажал на кровать (спать можно только ночью или в грозу, и рядом не должно быть монстров).';
}

async function openNearest(pal, what) {
  const body = pal.bot;
  const block = findBlocksNear(body, what, 32, 1)[0];
  if (!block) return null;
  await approach(pal, block, 3);
  if (!(await body.crafting.openBlock(block))) throw new ActionError(`${block.name} не открылся.`);
  return block;
}

const KEEP = /pickaxe|_axe|sword|shovel|hoe|helmet|chestplate|leggings|boots|shield/;

export async function storeInChest(pal, item, count) {
  const body = pal.bot; const cr = body.crafting; const inv = body.inventory;
  const chest = await openNearest(pal, 'chest') || await openNearest(pal, 'barrel');
  if (!chest) throw new ActionError('Рядом нет сундука.');
  const stored = {};
  try {
    const want = item === 'all' ? null : String(item).replace(/^minecraft:/, '');
    let left = count ?? Infinity;
    for (let i = 0; i < 36 && left > 0; i++) {
      const it = inv.slots[i]; const name = inv.nameOf(it);
      if (!name || (want ? name !== want : KEEP.test(name) || FOOD_PRIORITY.includes(name))) continue;
      const n = Math.min(it.count, left);
      const cont = cr.containers.get(String(cr.window?.id)) || [];
      const size = Math.max(27, cont.length);
      let dest = -1;
      for (let k = 0; k < size; k++) { const c = cont[k]; if (c?.network_id === it.network_id && c.count + n <= 64) { dest = k; break; } }
      if (dest < 0) for (let k = 0; k < size; k++) if (!cont[k]?.network_id) { dest = k; break; }
      if (dest < 0) break;
      const r = await cr.transfer('in', i, dest, n);
      if (!r.ok) { if (!Object.keys(stored).length) throw new ActionError(`Не получилось положить: ${r.error}`); break; }
      stored[name] = (stored[name] || 0) + n; left -= n;
    }
  } finally { cr.closeWindow(); }
  if (!Object.keys(stored).length) throw new ActionError(`Нет ${item} для хранения.`);
  return `Положил в сундук: ${fmt(stored)}.`;
}

export async function takeFromChest(pal, item, count = 1) {
  const body = pal.bot; const cr = body.crafting; const inv = body.inventory;
  const chest = await openNearest(pal, 'chest') || await openNearest(pal, 'barrel');
  if (!chest) throw new ActionError('Рядом нет сундука.');
  try {
    const items = cr.containerItems();
    const contents = {};
    for (const i of items) contents[i.name] = (contents[i.name] || 0) + i.count;
    if (!item) return `В сундуке: ${fmt(contents) || 'пусто'}`;
    const name = String(item).replace(/^minecraft:/, '');
    if (!contents[name]) throw new ActionError(`В сундуке нет ${name}. Есть: ${fmt(contents) || 'пусто'}`);
    let left = Math.min(count, contents[name]); let took = 0;
    for (const it of items.filter((x) => x.name === name)) {
      if (left <= 0) break;
      const n = Math.min(left, it.count);
      const dest = cr.destSlot(it.item, n);
      if (dest < 0) break;
      const r = await cr.transfer('out', dest, it.slot, n);
      if (!r.ok) { if (!took) throw new ActionError(`Не получилось взять: ${r.error}`); break; }
      took += n; left -= n;
    }
    return `Взял ${took} ${name}.`;
  } finally { cr.closeWindow(); }
}

const FUELS = [['coal', 8], ['charcoal', 8], ['coal_block', 80], ['blaze_rod', 12], ['lava_bucket', 100], ['_log', 1.5], ['_planks', 1.5], ['log', 1.5], ['planks', 1.5], ['stick', 0.5]];

/** Переплавить в печке (как smelt_item в Java). */
export async function smeltItem(pal, item, count = 1) {
  const body = pal.bot; const cr = body.crafting; const inv = body.inventory;
  const name = String(item).replace(/^minecraft:/, '');
  const have = inv.count(name);
  if (!have) throw new ActionError(`Нет ${name} для переплавки.`);
  count = Math.min(count, have, 64);
  let furnace = findBlocksNear(body, 'furnace', 24, 1)[0];
  if (!furnace) {
    if (!inv.count('furnace')) await craftItem(pal, 'furnace', 1);
    const me = body.movement.position;
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [1, 2]]) {
      const c = { x: Math.floor(me.x) + dx, y: Math.floor(me.y), z: Math.floor(me.z) + dz };
      const here = body.blockAt(c.x, c.y, c.z); const down = body.blockAt(c.x, c.y - 1, c.z);
      if (here && AIR.test(here.name) && down?.solid) { try { if (await body.placeBlock(c, 'furnace')) { furnace = c; break; } } catch { /* следующая */ } }
    }
    if (!furnace) throw new ActionError('Не получилось поставить печь.');
  }
  await approach(pal, furnace, 3);
  if (!(await cr.openBlock(furnace))) throw new ActionError('Печь не открылась.');
  try {
    const slotsNow = () => cr.containers.get(String(cr.window?.id)) || [];
    // топливо
    const fuelSlot0 = slotsNow()[1];
    if (!fuelSlot0?.network_id) {
      let fuel = null;
      for (const [f, per] of FUELS) {
        const slot = inv.findSlot((n) => (f.startsWith('_') ? n.endsWith(f) : n === f) && n !== name);
        if (slot >= 0) { fuel = { slot, per }; break; }
      }
      if (!fuel) throw new ActionError('Нет топлива (уголь, доски, брёвна).');
      const need = Math.min(inv.slots[fuel.slot].count, Math.ceil(count / fuel.per));
      const r = await cr.transfer('in', fuel.slot, 1, need);
      if (!r.ok) throw new ActionError(`Не положил топливо: ${r.error}`);
    }
    const src = inv.findSlot(name);
    const r = await cr.transfer('in', src, 0, count);
    if (!r.ok) throw new ActionError(`Не положил ${name} в печь: ${r.error}`);
    // ждём результат: 10 с на предмет
    const deadline = Date.now() + count * 10500 + 3000;
    let out = 0;
    while (Date.now() < deadline && !pal.interrupted) {
      await sleep(1000);
      out = slotsNow()[2]?.count || 0;
      const inLeft = slotsNow()[0]?.count || 0;
      if (out >= count || (!inLeft && out)) break;
    }
    const outItem = slotsNow()[2];
    if (!outItem?.network_id) throw new ActionError('Печь ничего не выдала (кончилось топливо?).');
    const outName = inv.nameOf(outItem);
    const dest = cr.destSlot(outItem, outItem.count);
    const t = await cr.transfer('out', dest, 2, outItem.count);
    if (!t.ok) throw new ActionError(`Не забрал ${outName}: ${t.error}`);
    return `Переплавил: получил ${outItem.count} ${outName}.`;
  } finally { cr.closeWindow(); }
}

/** Подобрать лежащие предметы вокруг. */
export async function pickupItems(pal, radius = 16) {
  const body = pal.bot;
  const before = { ...body.inventory.summary() };
  for (let i = 0; i < 20 && !pal.interrupted; i++) {
    const drop = body.inventory.nearbyDrops(body.movement.position, radius)[0];
    if (!drop) break;
    await body.goto({ x: drop.position.x, y: drop.position.y, z: drop.position.z }, 0.5, 8000).catch(() => {});
    await sleep(400);
    if (body.inventory.nearbyDrops(drop.position, 0.8).length) body.inventory.drops.forEach((d, k) => { if (d === drop) body.inventory.drops.delete(k); });
  }
  const after = body.inventory.summary(); const got = {};
  for (const [k, v] of Object.entries(after)) if (v > (before[k] || 0)) got[k] = v - (before[k] || 0);
  return Object.keys(got).length ? `Подобрал: ${fmt(got)}.` : 'Рядом нечего подбирать.';
}
