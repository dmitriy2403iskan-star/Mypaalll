import pathfinderPkg from 'mineflayer-pathfinder';
import vec3pkg from 'vec3';

export const { goals } = pathfinderPkg;
export const Vec3 = vec3pkg.Vec3 || vec3pkg;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ActionError extends Error {}

export function findPlayer(bot, name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  const p = Object.values(bot.players).find((pl) => pl.username.toLowerCase() === lower)
    || Object.values(bot.players).find((pl) => pl.username.toLowerCase().includes(lower));
  return p?.entity ? p.entity : null;
}

export function itemByName(bot, name) {
  const it = bot.registry.itemsByName[name];
  if (!it) throw new ActionError(`Нет предмета "${name}". Используй точное id Minecraft, например oak_planks, stone_pickaxe.`);
  return it;
}

export function countItem(bot, name) {
  return bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
}

/** Идти к цели с таймаутом; бросает ошибку, если путь не найден. */
export async function goto(pal, goal, timeoutMs = 60_000) {
  const { bot } = pal;
  let timer;
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new ActionError('Не успел дойти (таймаут)')), timeoutMs); }),
    ]);
  } catch (e) {
    bot.pathfinder.stop();
    if (pal.interrupted) throw new ActionError('Действие прервано');
    throw e instanceof ActionError ? e : new ActionError(`Не могу дойти: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function gotoPos(pal, pos, range = 2, timeoutMs) {
  return goto(pal, new goals.GoalNear(pos.x, pos.y, pos.z, range), timeoutMs);
}

const isAir = (b) => !b || b.name === 'air' || b.name === 'cave_air' || b.boundingBox === 'empty';

/** Найти блок рядом с позицией, к грани которого можно прикрепить новый блок. */
export function referenceFor(bot, pos, attach) {
  const dirs = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
  // attach — к какому соседу обязательно крепить (лестница к стене, дверь к полу)
  const order = attach ? [attach] : dirs;
  for (const [dx, dy, dz] of order) {
    const ref = bot.blockAt(pos.offset(dx, dy, dz));
    if (ref && ref.boundingBox === 'block' && !ref.name.includes('water') && !ref.name.includes('lava')) {
      return { ref, face: new Vec3(-dx, -dy, -dz) };
    }
  }
  return null;
}

/** Поставить блок из инвентаря в конкретную точку. */
export async function placeAt(pal, itemName, pos, { attach } = {}) {
  const { bot } = pal;
  const target = bot.blockAt(pos);
  if (target && !isAir(target) && !['water', 'lava', 'short_grass', 'grass', 'tall_grass', 'snow'].includes(target.name)) return false; // уже занято
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) throw new ActionError(`Нет ${itemName} в инвентаре`);
  const r = referenceFor(bot, pos, attach);
  if (!r) throw new ActionError(`Не к чему прикрепить ${itemName} в ${pos}`);
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.2) await gotoPos(pal, pos, 3);
  // не стоять в месте установки
  const feet = bot.entity.position.floored();
  if ((feet.x === pos.x && feet.z === pos.z) && (feet.y === pos.y || feet.y + 1 === pos.y)) {
    await goto(pal, new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1)), 10_000).catch(() => {});
  }
  await bot.equip(item, 'hand');
  await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
  try {
    await bot.placeBlock(r.ref, r.face);
  } catch (e) {
    await sleep(150);
    const now = bot.blockAt(pos);
    if (!now || isAir(now)) throw new ActionError(`Не смог поставить ${itemName}: ${e.message}`);
  }
  return true;
}

/** Поставить блок где-нибудь рядом с ботом (для верстака/печки/сундука). */
export async function placeNearby(pal, itemName) {
  const { bot } = pal;
  const base = bot.entity.position.floored();
  for (let r = 1; r <= 3; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        for (const dy of [0, -1, 1]) {
          const pos = base.offset(dx, dy, dz);
          const here = bot.blockAt(pos);
          const below = bot.blockAt(pos.offset(0, -1, 0));
          const above = bot.blockAt(pos.offset(0, 1, 0));
          if (isAir(here) && below?.boundingBox === 'block' && isAir(above)) {
            try { await placeAt(pal, itemName, pos); return bot.blockAt(pos); } catch { /* пробуем дальше */ }
          }
        }
      }
    }
  }
  throw new ActionError(`Не нашёл место, чтобы поставить ${itemName}`);
}

export { isAir };
