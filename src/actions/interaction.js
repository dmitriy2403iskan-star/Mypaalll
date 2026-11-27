import { ActionError, countItem, findPlayer, gotoPos, itemByName, goals, sleep, ensureItem } from './util.js';
import { findBlocks, isHostile } from '../minecraft/world.js';

const FOOD_PRIORITY = ['golden_carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_salmon', 'cooked_chicken', 'cooked_cod',
  'baked_potato', 'bread', 'cooked_rabbit', 'apple', 'carrot', 'beef', 'porkchop', 'mutton', 'chicken', 'potato', 'sweet_berries', 'melon_slice', 'cookie'];

export async function eatBest(bot) {
  const foods = bot.registry.foodsByName || {};
  const items = bot.inventory.items().filter((i) => foods[i.name] && i.name !== 'rotten_flesh' && i.name !== 'spider_eye' && i.name !== 'poisonous_potato');
  if (!items.length) return null;
  items.sort((a, b) => {
    const ia = FOOD_PRIORITY.indexOf(a.name); const ib = FOOD_PRIORITY.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const food = items[0];
  await bot.equip(food, 'hand');
  await bot.consume();
  return food.name;
}

export default [
  {
    name: 'give_items',
    description: 'Передать предметы игроку (подойти и выбросить ему).',
    parameters: {
      type: 'object',
      properties: { player: { type: 'string' }, item: { type: 'string' }, count: { type: 'number' } },
      required: ['player', 'item'],
    },
    async run(pal, { player, item, count = 1 }) {
      const { bot } = pal;
      await ensureItem(pal, item, count); // в креативе — берём из инвентаря креатива
      const have = countItem(bot, item);
      if (!have) throw new ActionError(`Нет ${item} в инвентаре.`);
      const target = findPlayer(bot, player);
      if (!target) throw new ActionError(`Не вижу ${player}.`);
      if (bot.entity.position.distanceTo(target.position) > 3) await gotoPos(pal, target.position, 2.5, 60_000);
      await bot.lookAt(target.position.offset(0, 1.0, 0));
      const n = Math.min(count, have);
      const id = itemByName(bot, item).id;
      try { await bot.toss(id, null, n); } catch {
        // сервер иногда отклоняет клик по слоту (рассинхрон окна) — повторяем один раз
        await sleep(500);
        await bot.toss(id, null, Math.min(n, countItem(bot, item)));
      }
      // отойти назад, чтобы не подобрать брошенное самому (задержка подбора 2 с)
      const me = bot.entity.position; const away = me.minus(target.position);
      const len = Math.hypot(away.x, away.z) || 1;
      await gotoPos(pal, me.offset((away.x / len) * 3, 0, (away.z / len) * 3), 1, 5000).catch(() => {});
      return `Отдал ${n} ${item} игроку ${player}.`;
    },
  },
  {
    name: 'drop_items',
    description: 'Выбросить предметы из инвентаря.',
    parameters: { type: 'object', properties: { item: { type: 'string' }, count: { type: 'number' } }, required: ['item'] },
    async run(pal, { item, count }) {
      const have = countItem(pal.bot, item);
      if (!have) throw new ActionError(`Нет ${item}.`);
      await pal.bot.toss(itemByName(pal.bot, item).id, null, Math.min(count ?? have, have));
      return `Выбросил ${item}.`;
    },
  },
  {
    name: 'equip',
    description: 'Взять предмет в руку или надеть броню.',
    parameters: {
      type: 'object',
      properties: { item: { type: 'string' }, slot: { type: 'string', enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] } },
      required: ['item'],
    },
    async run(pal, { item, slot }) {
      await ensureItem(pal, item, 1);
      const it = pal.bot.inventory.items().find((i) => i.name === item);
      if (!it) throw new ActionError(`Нет ${item}.`);
      const auto = /helmet/.test(item) ? 'head' : /chestplate|elytra/.test(item) ? 'torso' : /leggings/.test(item) ? 'legs' : /boots/.test(item) ? 'feet' : item === 'shield' ? 'off-hand' : 'hand';
      await pal.bot.equip(it, slot || auto);
      return `Экипировал ${item} (${slot || auto}).`;
    },
  },
  {
    name: 'eat',
    description: 'Поесть (лучшую еду из инвентаря).',
    parameters: { type: 'object', properties: {} },
    async run(pal) {
      if (pal.bot.food >= 20) return 'Я сыт.';
      const ate = await eatBest(pal.bot);
      if (!ate) throw new ActionError('Нет еды в инвентаре.');
      await sleep(400); // сытость сервер присылает чуть позже
      return `Съел ${ate}. Сытость: ${pal.bot.food}/20.`;
    },
  },
  {
    name: 'sleep_in_bed',
    description: 'Лечь спать в ближайшую кровать (только ночью).',
    parameters: { type: 'object', properties: {} },
    async run(pal) {
      const bed = findBlocks(pal.bot, 'bed', 32, 1)[0];
      if (!bed) throw new ActionError('Рядом нет кровати.');
      await gotoPos(pal, bed.position, 2);
      await pal.bot.sleep(bed);
      return 'Сплю. Проснусь утром.';
    },
  },
  {
    name: 'attack',
    description: 'Атаковать ближайшее существо по имени (zombie, cow, skeleton...) или "hostile" — ближайшего враждебного моба.',
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    async run(pal, { target }) {
      const { bot } = pal;
      const me = bot.entity.position;
      const entity = Object.values(bot.entities)
        .filter((e) => e !== bot.entity && e.position && e.position.distanceTo(me) < 32)
        .filter((e) => (target === 'hostile' ? isHostile(e) : (e.name === target || e.username === target)))
        .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
      if (!entity) throw new ActionError(`Рядом нет ${target}.`);
      if (entity.type === 'player' && entity.username === pal.owner()) throw new ActionError('Я не буду атаковать своего напарника.');
      const weapon = bot.inventory.items().filter((i) => /sword|_axe/.test(i.name))
        .sort((a, b) => (b.name.includes('netherite') - a.name.includes('netherite')) || (b.name.includes('diamond') - a.name.includes('diamond')) || (b.name.includes('iron') - a.name.includes('iron')))[0];
      if (weapon) await bot.equip(weapon, 'hand');
      bot.pvp.attack(entity);
      const t0 = Date.now();
      while (entity.isValid && Date.now() - t0 < 20_000 && !pal.interrupted) await sleep(500);
      bot.pvp.stop();
      // плагин PvP иногда «теряет» цель (моб отошёл, путь перестроился) — добиваем сами: подойти и бить
      const t1 = Date.now();
      while (entity.isValid && Date.now() - t1 < 15_000 && !pal.interrupted) {
        if (bot.entity.position.distanceTo(entity.position) > 3) await gotoPos(pal, entity.position, 2, 4000).catch(() => {});
        else { await bot.lookAt(entity.position.offset(0, entity.height / 2, 0)).catch(() => {}); bot.attack(entity); }
        await sleep(600);
      }
      return entity.isValid ? `Бой с ${target} прерван.` : `Победил ${target}.`;
    },
  },
  {
    name: 'guard',
    description: 'Режим охраны: в фоне защищать игрока/себя от враждебных мобов, следуя за игроком. Выключается через stop.',
    parameters: { type: 'object', properties: { player: { type: 'string' } }, required: ['player'] },
    async run(pal, { player }) {
      const target = findPlayer(pal.bot, player);
      if (!target) throw new ActionError(`Не вижу ${player}.`);
      pal.setMode('guard', player);
      pal.bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true);
      return `Охраняю ${player}.`;
    },
  },
  {
    name: 'store_in_chest',
    description: 'Положить предметы в ближайший сундук. item="all" — всё, кроме инструментов, брони и еды.',
    parameters: { type: 'object', properties: { item: { type: 'string' }, count: { type: 'number' } }, required: ['item'] },
    async run(pal, { item, count }) {
      const { bot } = pal;
      const chestBlock = findBlocks(bot, 'chest', 32, 1)[0];
      if (!chestBlock) throw new ActionError('Рядом нет сундука.');
      await gotoPos(pal, chestBlock.position, 2);
      const chest = await bot.openContainer(chestBlock);
      const stored = [];
      try {
        const keep = /pickaxe|_axe|sword|shovel|hoe|helmet|chestplate|leggings|boots|shield/;
        const foods = bot.registry.foodsByName || {};
        const items = item === 'all'
          ? bot.inventory.items().filter((i) => !keep.test(i.name) && !foods[i.name])
          : bot.inventory.items().filter((i) => i.name === item);
        if (!items.length) throw new ActionError(`Нет ${item} для хранения.`);
        for (const it of items) {
          const n = item === 'all' ? it.count : Math.min(count ?? it.count, it.count);
          await chest.deposit(it.type, null, n);
          stored.push(`${n} ${it.name}`);
          if (item !== 'all' && count !== undefined) break;
        }
      } finally { chest.close(); }
      return `Положил в сундук: ${stored.join(', ')}.`;
    },
  },
  {
    name: 'take_from_chest',
    description: 'Взять предметы из ближайшего сундука. Без item — просто посмотреть содержимое.',
    parameters: { type: 'object', properties: { item: { type: 'string' }, count: { type: 'number' } } },
    async run(pal, { item, count = 1 }) {
      const { bot } = pal;
      const chestBlock = findBlocks(bot, 'chest', 32, 1)[0];
      if (!chestBlock) throw new ActionError('Рядом нет сундука.');
      await gotoPos(pal, chestBlock.position, 2);
      const chest = await bot.openContainer(chestBlock);
      try {
        const contents = {};
        for (const i of chest.containerItems()) contents[i.name] = (contents[i.name] || 0) + i.count;
        if (!item) return `В сундуке: ${JSON.stringify(contents)}`;
        const avail = contents[item] || 0;
        if (!avail) throw new ActionError(`В сундуке нет ${item}. Есть: ${JSON.stringify(contents)}`);
        const n = Math.min(count, avail);
        await chest.withdraw(itemByName(bot, item).id, null, n);
        return `Взял ${n} ${item}.`;
      } finally { chest.close(); }
    },
  },
];
