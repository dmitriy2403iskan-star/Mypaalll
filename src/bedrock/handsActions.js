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
    const me = body.movement.position;
    const bx = Math.floor(me.x); const by = Math.floor(me.y); const bz = Math.floor(me.z);
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [1, 2], [-2, -1], [-1, -2]]) {
      const c = { x: bx + dx, y: by, z: bz + dz };
      const here = body.blockAt(c.x, c.y, c.z); const down = body.blockAt(c.x, c.y - 1, c.z);
      if (here && AIR.test(here.name) && down?.solid) {
        try { if (await body.placeBlock(c, 'crafting_table')) { table = c; break; } } catch { /* следующая клетка */ }
      }
    }
    if (!table) throw new ActionError('Не получилось поставить верстак рядом');
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
