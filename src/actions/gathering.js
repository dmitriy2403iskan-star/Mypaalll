import { ActionError, countItem, sleep, gotoPos } from './util.js';
import { findBlocks } from '../minecraft/world.js';

/** Что выпадает из блока: stone → cobblestone и т.п. */
function dropsOf(bot, block) {
  const drops = (block.drops || []).map((d) => {
    const id = typeof d === 'object' ? (d.drop?.id ?? d.drop ?? d.id) : d;
    return bot.registry.items[id]?.name;
  }).filter(Boolean);
  return drops.length ? drops : [block.name];
}

function hasHarvestTool(bot, block) {
  if (!block.harvestTools) return true;
  return bot.inventory.items().some((i) => block.harvestTools[i.type]);
}

export default [
  {
    name: 'collect_blocks',
    description: 'Добыть блоки нужного типа и подобрать дроп. Можно указать часть имени: "log" найдёт любые брёвна. Например oak_log, stone, iron_ore, coal_ore, sand, dirt.',
    parameters: {
      type: 'object',
      properties: {
        block: { type: 'string', description: 'id блока Minecraft или его часть' },
        count: { type: 'number', description: 'Сколько добыть, по умолчанию 1' },
      },
      required: ['block'],
    },
    async run(pal, { block, count = 1 }) {
      const { bot } = pal;
      count = Math.min(Math.max(1, Math.round(count)), 64);
      let mined = 0;
      let lastError = '';
      const dropNames = new Set();
      for (let i = 0; i < count; i++) {
        if (pal.interrupted) break;
        const found = findBlocks(bot, block, 64, 8);
        if (!found.length) { lastError = `рядом нет блоков "${block}" (радиус 64)`; break; }
        const target = found.find((b) => hasHarvestTool(bot, b));
        if (!target) {
          const tools = Object.keys(found[0].harvestTools || {}).map((id) => bot.registry.items[id]?.name).filter(Boolean);
          throw new ActionError(`Для ${found[0].name} нужен инструмент: ${tools.slice(0, 3).join(' / ')}. Сначала скрафти его.`);
        }
        for (const d of dropsOf(bot, target)) dropNames.add(d);
        try {
          await bot.collectBlock.collect(target, { ignoreNoPath: true });
          mined++;
        } catch (e) {
          lastError = e.message;
          if (pal.interrupted) break;
          // пробуем следующий блок
        }
      }
      await sleep(300);
      const inv = Object.fromEntries([...dropNames].map((n) => [n, countItem(bot, n)]).filter(([, c]) => c > 0));
      if (!mined) throw new ActionError(`Не удалось добыть ${block}: ${lastError}`);
      return `Добыл ${mined}/${count} ${block}.${lastError ? ` Проблема: ${lastError}.` : ''} ${Object.keys(inv).length ? `В инвентаре: ${JSON.stringify(inv)}` : ''}`.trim();
    },
  },
  {
    name: 'pickup_items',
    description: 'Подобрать выпавшие предметы поблизости.',
    parameters: { type: 'object', properties: { radius: { type: 'number' } } },
    async run(pal, { radius = 16 }) {
      const { bot } = pal;
      const items = Object.values(bot.entities)
        .filter((e) => (e.name === 'item' || e.type === 'object' && e.objectType === 'Item') && e.position.distanceTo(bot.entity.position) <= radius)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
      let n = 0;
      for (const it of items.slice(0, 20)) {
        if (pal.interrupted) break;
        try { await gotoPos(pal, it.position, 0, 15_000); n++; } catch { /* недоступен */ }
      }
      await sleep(400);
      return n ? `Подобрал предметы (${n} куч).` : 'Рядом нечего подбирать.';
    },
  },
];
