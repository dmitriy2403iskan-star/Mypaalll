// Исполнитель чертежей: проверяет материалы → копает → ставит снизу вверх. Возвращает подробный отчёт.
import { ActionError, countItem, placeAt, gotoPos, Vec3, isAir } from '../actions/util.js';
import { billOfMaterials } from './blueprints.js';

const SOFT = new Set(['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'dead_bush', 'water', 'dandelion', 'poppy', 'vine']);
const PROTECTED = /chest|shulker|furnace|crafting_table|bed$|spawner|bedrock|barrier|end_portal|command/;
const isFree = (b) => !b || isAir(b) || SOFT.has(b.name);

/** Уровень земли: первая свободная клетка над твёрдым блоком около высоты y. */
export function surfaceY(bot, x, z, y) {
  for (let yy = y + 5; yy >= y - 8; yy--) {
    const here = bot.blockAt(new Vec3(x, yy, z));
    const below = bot.blockAt(new Vec3(x, yy - 1, z));
    if (isFree(here) && below?.boundingBox === 'block' && !SOFT.has(below.name)) return yy;
  }
  return y;
}

/** Угол постройки: по координатам или перед ботом так, чтобы бот оказался перед дверью (z=0). */
export function resolveOrigin(bot, args, size) {
  if (args.x !== undefined && args.z !== undefined) {
    const x = Math.round(args.x); const z = Math.round(args.z);
    return new Vec3(x, args.y !== undefined ? Math.round(args.y) : surfaceY(bot, x, z, Math.floor(bot.entity.position.y)), z);
  }
  const p = bot.entity.position.floored();
  const yaw = bot.entity.yaw;
  const fx = Math.round(-Math.sin(yaw)); const fz = Math.round(-Math.cos(yaw));
  const dist = 3;
  const cx = p.x + fx * (dist + Math.ceil(size.w / 2)); const cz = p.z + fz * (dist + Math.ceil(size.l / 2));
  const x = cx - Math.floor(size.w / 2); const z = cz - Math.floor(size.l / 2);
  // уровень земли берём по центру будущей постройки
  return new Vec3(x, surfaceY(bot, cx, cz, p.y), z);
}

function absolute(origin, ops) {
  return ops.map((op) => ({ ...op, pos: origin.offset(op.x, op.y, op.z) }));
}

/** Что нужно сделать (без учёта уже стоящих правильных блоков) и чего не хватает. */
export function analyze(bot, origin, ops) {
  const abs = absolute(origin, ops);
  const todo = abs.filter((op) => {
    const b = bot.blockAt(op.pos);
    if (op.dig) return b && !isFree(b);
    return !b || b.name !== op.block;
  });
  const bill = billOfMaterials(todo.filter((o) => o.block));
  const missing = {};
  for (const [item, n] of Object.entries(bill)) {
    const have = countItem(bot, item);
    if (have < n) missing[item] = n - have;
  }
  return { todo, bill, missing, digs: todo.filter((o) => o.dig || (o.replace && !isFree(bot.blockAt(o.pos)))).length };
}

export async function execute(pal, origin, ops, { allowPartial = false } = {}) {
  const { bot } = pal;
  const { todo, bill, missing } = analyze(bot, origin, ops);
  if (!todo.length) return { placed: 0, dug: 0, failed: [], skipped: [], bill, note: 'Постройка уже завершена.' };
  if (Object.keys(missing).length && !allowPartial) {
    throw new ActionError(`Не хватает материалов: ${fmt(missing)}. Нужно всего: ${fmt(bill)}. Собери/скрафти недостающее или вызови с allow_partial=true.`);
  }
  const total = { placed: 0, dug: 0, failed: [], skipped: [], bill };
  // Несколько циклов: pathfinder иногда подставляет блоки-подпорки (землю) внутрь постройки —
  // после основного прохода перепроверяем чертёж и убираем/доставляем расхождения.
  let prevLeft = Infinity;
  for (let cycle = 0; cycle < 3 && !pal.interrupted; cycle++) {
    const cur = analyze(bot, origin, ops).todo;
    if (!cur.length || cur.length >= prevLeft) break;
    prevLeft = cur.length;
    const r = await buildCycle(pal, cur);
    total.placed += r.placed; total.dug += r.dug;
    total.failed = r.failed; total.skipped = r.skipped; // актуальны ошибки последнего цикла
  }
  return total;
}

async function buildCycle(pal, todo) {
  const { bot } = pal;
  let dug = 0; const failed = []; const skipped = [];

  // 1. Копаем: подвал, расчистка, мешающие блоки (сверху вниз, чтобы не засыпало)
  const toDig = todo.filter((op) => {
    const b = bot.blockAt(op.pos);
    if (isFree(b)) return false;
    if (op.dig) return true;
    return op.replace && b.name !== op.block;
  }).sort((a, b) => b.pos.y - a.pos.y || a.pos.distanceTo(bot.entity.position) - b.pos.distanceTo(bot.entity.position));
  for (const op of toDig) {
    if (pal.interrupted) break;
    const b = bot.blockAt(op.pos);
    if (isFree(b)) continue;
    if (PROTECTED.test(b.name) || b.diggable === false) { skipped.push(`${b.name} в ${op.pos}`); continue; }
    try {
      if (bot.entity.position.distanceTo(op.pos.offset(0.5, 0.5, 0.5)) > 4.3) await gotoPos(pal, op.pos, 3, 30_000);
      if (bot.tool?.equipForBlock) await bot.tool.equipForBlock(b, {}).catch(() => {});
      await bot.dig(b, true);
      dug++;
    } catch (e) {
      failed.push(`копать ${op.pos}: ${e.message}`);
    }
  }

  // 2. Ставим: снизу вверх; навесное (лестницы, двери, факелы) — после опор
  let pending = todo.filter((op) => op.block)
    .sort((a, b) => a.pos.y - b.pos.y || Boolean(a.attach) - Boolean(b.attach) || a.pos.distanceTo(bot.entity.position) - b.pos.distanceTo(bot.entity.position));
  let placed = 0;
  for (let pass = 0; pass < 3 && pending.length && !pal.interrupted; pass++) {
    const next = [];
    for (const op of pending) {
      if (pal.interrupted) break;
      const cur = bot.blockAt(op.pos);
      if (cur?.name === op.block) continue;
      if (!countItem(bot, op.block)) { if (!op.optional) skipped.push(`${op.block} (нет в инвентаре)`); continue; }
      try {
        if (await placeAt(pal, op.block, op.pos, { attach: op.attach })) placed++;
      } catch (e) {
        if (pass === 2) failed.push(`${op.block} в ${op.pos}: ${e.message}`);
        else next.push(op);
      }
    }
    pending = next;
  }
  return { placed, dug, failed, skipped: [...new Set(skipped)] };
}

export function fmt(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}×${v}`).join(', ') || '—';
}
