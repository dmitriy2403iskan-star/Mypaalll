import { ActionError, countItem, itemByName, placeNearby, gotoPos, sleep } from './util.js';
import { findBlocks, inventory } from '../minecraft/world.js';

async function getCraftingTable(pal) {
  const { bot } = pal;
  let table = findBlocks(bot, 'crafting_table', 24, 1)[0];
  if (table) return table;
  if (!countItem(bot, 'crafting_table')) {
    // попробуем сделать верстак из досок
    const tableItem = bot.registry.itemsByName.crafting_table;
    const recipe = bot.recipesFor(tableItem.id, null, 1, null)[0];
    if (!recipe) throw new ActionError('Нужен верстак: нет верстака рядом и не хватает досок (нужно 4 доски).');
    await bot.craft(recipe, 1, null);
  }
  table = await placeNearby(pal, 'crafting_table');
  return table;
}

function describeMissing(bot, item) {
  // показываем ингредиенты первого рецепта, чтобы LLM поняла, что добыть
  const recipes = bot.registry.recipes?.[item.id];
  if (!recipes?.length) return 'рецепт неизвестен (возможно, предмет добывается или плавится)';
  const r = recipes[0];
  const need = {};
  const add = (id) => {
    if (id === null || id === undefined) return;
    const realId = typeof id === 'object' ? id.id ?? id[0] : id;
    if (realId === null || realId === undefined || realId < 0) return;
    const n = bot.registry.items[realId]?.name || realId;
    need[n] = (need[n] || 0) + 1;
  };
  if (r.inShape) r.inShape.flat().forEach(add);
  if (r.ingredients) r.ingredients.forEach(add);
  return `на 1 крафт нужно ${JSON.stringify(need)} (результат ×${r.result?.count || 1})`;
}

export default [
  {
    name: 'craft_item',
    description: 'Скрафтить предмет. Верстак найдётся рядом или будет поставлен автоматически. Примеры: oak_planks, stick, crafting_table, wooden_pickaxe, stone_pickaxe, furnace, chest, torch, oak_door.',
    parameters: {
      type: 'object',
      properties: { item: { type: 'string' }, count: { type: 'number', description: 'Сколько предметов нужно получить' } },
      required: ['item'],
    },
    async run(pal, { item, count = 1 }) {
      const { bot } = pal;
      const it = itemByName(bot, item);
      const before = countItem(bot, item);
      // 1) рецепт 2x2 из инвентаря — верстак не нужен
      let table = null;
      let recipe = bot.recipesFor(it.id, null, 1, null)[0];
      if (!recipe) {
        if (!bot.recipesAll(it.id, null, true).length) throw new ActionError(`${item} не крафтится на верстаке.\n${pal.recipes().describe(item)}`);
        // 2) материалов не хватает даже с верстаком — сразу говорим, чего не хватает
        if (!bot.recipesFor(it.id, null, 1, true).length) throw new ActionError(`Не хватает материалов для ${item}.\n${pal.recipes().describePlan(item, count, inventory(bot))}`);
        // 3) нужен верстак 3x3
        table = await getCraftingTable(pal);
        await gotoPos(pal, table.position, 3);
        recipe = bot.recipesFor(it.id, null, 1, table)[0];
      }
      if (!recipe) throw new ActionError(`Не хватает материалов для ${item}: ${describeMissing(bot, it)}.`);
      const per = recipe.result?.count || 1;
      let times = Math.ceil(count / per);
      // ограничиваем количеством, на которое хватает ресурсов
      while (times > 0 && !bot.recipesFor(it.id, null, times * per, table).length) times--;
      if (times <= 0) throw new ActionError(`Не хватает материалов для ${item}: ${describeMissing(bot, it)}.`);
      // по одному крафту: на новых версиях Mineflayer зависает на пакетном крафте (updateSlot:0 timeout)
      let done = 0; let lastErr = null;
      for (let k = 0; k < times && !pal.interrupted; k++) {
        const r1 = bot.recipesFor(it.id, null, 1, table)[0];
        if (!r1) break;
        try {
          await bot.craft(r1, 1, table);
          done++; lastErr = null;
        } catch (e) {
          lastErr = e;
          // окно могло зависнуть — закрываем и пробуем этот крафт ещё раз
          try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch { /* */ }
          await sleep(400);
          try { const r2 = bot.recipesFor(it.id, null, 1, table)[0]; if (r2) { await bot.craft(r2, 1, table); done++; lastErr = null; } } catch (e2) { lastErr = e2; break; }
        }
        await sleep(120);
      }
      if (!done && lastErr) throw new ActionError(`Крафт ${item} не удался: ${lastErr.message}`);
      await sleep(200);
      const made = countItem(bot, item) - before;
      return `Скрафтил ${made} ${item}${made < count ? ` (на ${count} не хватило материалов)` : ''}. Теперь в инвентаре: ${countItem(bot, item)}.`;
    },
  },
  {
    name: 'smelt_item',
    description: 'Переплавить предметы в печке (raw_iron → iron_ingot, sand → glass, beef → cooked_beef). Печь найдётся рядом или будет поставлена из инвентаря.',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Что плавить: raw_iron, raw_gold, sand, beef, cobblestone...' },
        count: { type: 'number' },
        fuel: { type: 'string', description: 'Топливо, по умолчанию coal / charcoal / доски' },
      },
      required: ['item'],
    },
    async run(pal, { item, count = 1, fuel }) {
      const { bot } = pal;
      const input = itemByName(bot, item);
      const have = countItem(bot, item);
      if (!have) throw new ActionError(`Нет ${item} в инвентаре.`);
      count = Math.min(count, have);
      let furnaceBlock = findBlocks(bot, 'furnace', 24, 1)[0];
      if (!furnaceBlock) {
        if (!countItem(bot, 'furnace')) throw new ActionError('Нет печки. Скрафти furnace (8 cobblestone).');
        furnaceBlock = await placeNearby(pal, 'furnace');
      }
      await gotoPos(pal, furnaceBlock.position, 3);
      const fuelName = fuel || ['coal', 'charcoal', 'oak_planks', 'spruce_planks', 'birch_planks', 'oak_log'].find((f) => countItem(bot, f) > 0);
      if (!fuelName || !countItem(bot, fuelName)) throw new ActionError('Нет топлива (coal, charcoal, доски).');
      let furnace = await bot.openFurnace(furnaceBlock);
      try {
        const fuelNeeded = Math.min(countItem(bot, fuelName), fuelName.includes('coal') ? Math.ceil(count / 8) : Math.ceil(count / 1.5));
        if (!furnace.fuelItem()) await furnace.putFuel(bot.registry.itemsByName[fuelName].id, null, fuelNeeded);
        await furnace.putInput(input.id, null, count);
        const deadline = Date.now() + count * 10_500 + 5000;
        let got = 0;
        while (got < count && Date.now() < deadline && !pal.interrupted) {
          await sleep(2000);
          if (furnace.outputItem()) { got += furnace.outputItem().count; await furnace.takeOutput(); }
        }
        // окно могло не получить обновление выхода (бывает на 1.19) — переоткрываем печь, как игрок
        if (!got && !pal.interrupted) {
          furnace.close(); await sleep(300);
          furnace = await bot.openFurnace(furnaceBlock);
          await sleep(500);
          if (furnace.outputItem()) { got += furnace.outputItem().count; await furnace.takeOutput(); }
        }
        return got ? `Переплавил ${got} ${item}.` : 'Плавка не завершилась вовремя — результат останется в печке.';
      } finally {
        furnace.close();
      }
    },
  },
];
