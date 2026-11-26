// World Perception — «глаза» бота. Собирает компактное состояние мира.

const HOSTILE = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'slime', 'drowned', 'husk', 'stray',
  'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'blaze', 'ghast', 'magma_cube', 'wither_skeleton',
  'zombie_villager', 'silverfish', 'guardian', 'hoglin', 'piglin_brute', 'zoglin', 'vex', 'warden', 'bogged', 'breeze',
]);

export const isHostile = (e) => e && (e.type === 'hostile' || HOSTILE.has(e.name));

const round = (v) => Math.round(v * 10) / 10;
export const fmtPos = (p) => (p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null);

export function inventory(bot) {
  const inv = {};
  for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count;
  return inv;
}

export function nearbyEntities(bot, radius = 24) {
  const me = bot.entity.position;
  return Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position && e.position.distanceTo(me) <= radius)
    .map((e) => ({
      name: e.type === 'player' ? e.username : e.name,
      type: e.type === 'player' ? 'player' : isHostile(e) ? 'hostile' : e.type,
      distance: round(e.position.distanceTo(me)),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 15);
}

/** Уникальные типы блоков вокруг (сэмплирование по кубу) — дёшево и информативно. */
export function nearbyBlockTypes(bot, radius = 12) {
  const seen = new Map();
  const p = bot.entity.position.floored();
  for (let dx = -radius; dx <= radius; dx += 2) {
    for (let dy = -4; dy <= 6; dy += 1) {
      for (let dz = -radius; dz <= radius; dz += 2) {
        const b = bot.blockAt(p.offset(dx, dy, dz));
        if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') continue;
        seen.set(b.name, (seen.get(b.name) || 0) + 1);
      }
    }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([n]) => n);
}

export function findBlocks(bot, name, maxDistance = 64, count = 1) {
  const ids = [];
  const exact = bot.registry.blocksByName[name];
  if (exact) ids.push(exact.id);
  else {
    // «log» найдёт oak_log, birch_log и т.д.
    for (const b of bot.registry.blocksArray) if (b.name.includes(name)) ids.push(b.id);
  }
  if (!ids.length) return [];
  return bot.findBlocks({ matching: ids, maxDistance, count }).map((pos) => bot.blockAt(pos)).filter(Boolean);
}

export function timeOfDay(bot) {
  const t = bot.time?.timeOfDay ?? 0;
  if (t < 1000) return 'sunrise';
  if (t < 12000) return 'day';
  if (t < 13000) return 'sunset';
  return 'night';
}

/** Полный снимок состояния (Context Manager выберет из него нужное). */
export function snapshot(bot) {
  if (!bot?.entity) return null;
  return {
    position: fmtPos(bot.entity.position),
    health: Math.round(bot.health ?? 0),
    food: Math.round(bot.food ?? 0),
    dimension: bot.game?.dimension,
    gameMode: bot.game?.gameMode,
    time: timeOfDay(bot),
    isRaining: bot.isRaining,
    heldItem: bot.heldItem?.name || null,
    inventory: inventory(bot),
    nearbyEntities: nearbyEntities(bot),
    nearbyBlocks: nearbyBlockTypes(bot),
    biome: (() => { try { return bot.registry.biomes?.[bot.blockAt(bot.entity.position)?.biome?.id]?.name; } catch { return undefined; } })(),
  };
}
