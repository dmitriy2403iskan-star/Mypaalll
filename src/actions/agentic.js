// «Мыслительные» инструменты: восприятие, планирование, память. Они не двигают бота, а дают LLM информацию и структуру.
import { snapshot, findBlocks, fmtPos, inventory } from '../minecraft/world.js';
import { ActionError } from './util.js';

export default [
  {
    name: 'inspect_surroundings',
    description: 'Подробно осмотреться: позиция, здоровье, инвентарь, сущности и блоки вокруг.',
    parameters: { type: 'object', properties: {} },
    async run(pal) {
      return JSON.stringify(snapshot(pal.bot));
    },
  },
  {
    name: 'find_block',
    description: 'Найти ближайшие блоки нужного типа и вернуть координаты (не идёт к ним).',
    parameters: { type: 'object', properties: { block: { type: 'string' }, max_distance: { type: 'number' } }, required: ['block'] },
    async run(pal, { block, max_distance = 64 }) {
      const found = findBlocks(pal.bot, block, Math.min(max_distance, 128), 5);
      if (!found.length) return `Блоков "${block}" в радиусе ${max_distance} нет. Попробуй explore.`;
      const me = pal.bot.entity.position;
      return found.map((b) => `${b.name} ${JSON.stringify(fmtPos(b.position))} (${Math.round(b.position.distanceTo(me))} бл.)`).join('\n');
    },
  },
  {
    name: 'get_recipe',
    description: 'Точный рецепт предмета для версии сервера: станция (инвентарь 2x2 / верстак 3x3 / печь / стол кузнеца), раскладка по клеткам, количество результата. Каждая вариация — отдельный id (iron_pickaxe, а не "кирка").',
    parameters: { type: 'object', properties: { item: { type: 'string', description: 'id предмета, например iron_pickaxe, oak_door' } }, required: ['item'] },
    async run(pal, { item }) {
      return pal.recipes().describe(item);
    },
  },
  {
    name: 'plan_crafting',
    description: 'Рассчитать всю цепочку для предмета с учётом инвентаря: что добыть (и каким инструментом), какие промежуточные крафты и плавки сделать по порядку. Используй перед сложным крафтом и для create_plan.',
    parameters: {
      type: 'object',
      properties: { item: { type: 'string' }, count: { type: 'number' } },
      required: ['item'],
    },
    async run(pal, { item, count = 1 }) {
      const bot = pal.bot;
      return pal.recipes().describePlan(String(item).replace(/^minecraft:/, ''), count, inventory(bot), {
        hasTable: findBlocks(bot, 'crafting_table', 24, 1).length > 0,
        hasFurnace: findBlocks(bot, 'furnace', 24, 1).length > 0,
      });
    },
  },
  {
    name: 'list_variants',
    description: 'Все вариации семейства предметов в этой версии: "pickaxe" → wooden_pickaxe, stone_pickaxe…; "door", "slab", "stairs", "boat", "bed"…',
    parameters: { type: 'object', properties: { family: { type: 'string' } }, required: ['family'] },
    async run(pal, { family }) {
      const list = pal.recipes().family(family);
      return list.length ? `${list.length} шт.: ${list.join(', ')}` : `Ничего не найдено по "${family}".`;
    },
  },
  {
    name: 'create_plan',
    description: 'Создать план для сложной многошаговой задачи (построить дом, сделать железную кирку...). Шаги — короткие конкретные действия. Используй ДО выполнения сложных задач, затем отмечай шаги через update_plan_step.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Список шагов по порядку' },
      },
      required: ['goal', 'steps'],
    },
    async run(pal, { goal, steps }) {
      if (!Array.isArray(steps) || !steps.length) throw new ActionError('Нужен хотя бы один шаг');
      const t = pal.tasks.create(goal, steps.slice(0, 20));
      return `План #${t.id} создан. Шаги:\n${t.steps.map((s, i) => `${i}. ${s.name}`).join('\n')}`;
    },
  },
  {
    name: 'update_plan_step',
    description: 'Отметить шаг текущего плана выполненным/проваленным. Обязательно проверь результат действия перед COMPLETED.',
    parameters: {
      type: 'object',
      properties: {
        step: { type: 'number', description: 'Номер шага (с 0)' },
        status: { type: 'string', enum: ['COMPLETED', 'FAILED', 'RUNNING', 'PENDING'] },
        note: { type: 'string' },
      },
      required: ['step', 'status'],
    },
    async run(pal, { step, status, note }) {
      const cur = pal.tasks.current();
      if (!cur) throw new ActionError('Нет активного плана.');
      const t = pal.tasks.updateStep(cur.id, step, status, note);
      return `План #${t.id} [${t.status}]:\n${t.steps.map((s, i) => `${i}. [${s.status}] ${s.name}`).join('\n')}`;
    },
  },
  {
    name: 'finish_plan',
    description: 'Завершить или отменить текущий план.',
    parameters: { type: 'object', properties: { status: { type: 'string', enum: ['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'] } }, required: ['status'] },
    async run(pal, { status }) {
      const cur = pal.tasks.current();
      if (!cur) return 'Активного плана нет.';
      pal.tasks.setStatus(cur.id, status);
      if (status === 'COMPLETED') pal.memory.add('episodic', `Выполнил задачу: ${cur.goal}`, 3);
      return `План #${cur.id} → ${status}.`;
    },
  },
  {
    name: 'remember',
    description: 'Сохранить важный факт в долговременную память (предпочтения игрока, договорённости, важные события).',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string' },
        kind: { type: 'string', enum: ['semantic', 'episodic'], description: 'semantic — постоянный факт, episodic — событие' },
        importance: { type: 'number', description: '1-5' },
      },
      required: ['fact'],
    },
    async run(pal, { fact, kind = 'semantic', importance = 3 }) {
      pal.memory.add(kind, fact, importance);
      return 'Запомнил.';
    },
  },
  {
    name: 'wait',
    description: 'Подождать указанное количество секунд (например, пока игрок что-то делает).',
    parameters: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] },
    async run(pal, { seconds }) {
      const end = Date.now() + Math.min(seconds, 120) * 1000;
      while (Date.now() < end && !pal.interrupted) await new Promise((r) => setTimeout(r, 250));
      return 'Подождал.';
    },
  },
];
