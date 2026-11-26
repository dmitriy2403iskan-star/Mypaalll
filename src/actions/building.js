// Строительство. LLM описывает ЧТО построить (параметры или свой чертёж), а executor решает КАК.
import { ActionError, Vec3, isAir, placeAt } from './util.js';
import { house, simple, custom } from '../building/blueprints.js';
import { resolveOrigin, analyze, execute, fmt } from '../building/executor.js';

const POS = {
  x: { type: 'number', description: 'Угол постройки X (необязательно: по умолчанию перед ботом)' },
  y: { type: 'number', description: 'Уровень пола (необязательно: по умолчанию уровень земли)' },
  z: { type: 'number' },
  dry_run: { type: 'boolean', description: 'true — только посчитать материалы и показать план, ничего не строить' },
  allow_partial: { type: 'boolean', description: 'Строить, даже если материалов не хватает на всё' },
};

async function run(pal, plan, args, title) {
  const { bot } = pal;
  const origin = resolveOrigin(bot, args, plan.size);
  if (args.dry_run) {
    const a = analyze(bot, origin, plan.ops);
    return `${title}: ${plan.summary}. Угол ${origin}, размер ${plan.size.w}x${plan.size.l}, высота ~${plan.size.h}.
Нужно материалов: ${fmt(a.bill)}. ${Object.keys(a.missing).length ? `Не хватает: ${fmt(a.missing)}.` : 'Всего хватает.'}
Копать блоков: ${a.digs}.`;
  }
  const r = await execute(pal, origin, plan.ops, { allowPartial: args.allow_partial });
  if (r.note) return r.note;
  pal.memory.add('episodic', `Построил ${plan.summary} в ${origin}`, 3);
  if (args.remember_as) pal.memory.saveLocation(args.remember_as, origin.offset(Math.floor(plan.size.w / 2), 1, -1), bot.game.dimension);
  const parts = [`${title} — готово: ${plan.summary}. Поставлено ${r.placed}, выкопано ${r.dug}. Угол ${origin}.`];
  if (r.skipped.length) parts.push(`Пропущено: ${r.skipped.slice(0, 5).join('; ')}.`);
  if (r.failed.length) parts.push(`Не получилось ${r.failed.length}: ${r.failed.slice(0, 3).join('; ')}.`);
  if (!r.placed && !r.dug) throw new ActionError(parts.join(' '));
  return parts.join(' ');
}

export default [
  {
    name: 'build_house',
    description: `Построить дом по параметрам. Переводи просьбу игрока в параметры:
«с подвалом» → basement=true, «без подвала» → basement=false (по умолчанию без подвала),
«двухэтажный» → floors=2, «без окон» → windows=false, «плоская крыша» → roof="flat", «из камня» → wall_material="cobblestone".
Лестницы (ladder) между этажами и в подвал ставятся автоматически. Сначала вызови с dry_run=true, чтобы узнать материалы, собери их, затем строй.`,
    parameters: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Ширина (5-21), по умолчанию 7' },
        length: { type: 'number', description: 'Длина (5-21), по умолчанию 7' },
        floors: { type: 'number', description: 'Этажей (1-4), по умолчанию 1' },
        floor_height: { type: 'number', description: 'Высота этажа 3-6, по умолчанию 4' },
        basement: { type: 'boolean', description: 'Есть ли подвал' },
        basement_depth: { type: 'number', description: 'Глубина подвала 2-6, по умолчанию 3' },
        basement_lined: { type: 'boolean', description: 'Обшить стены подвала материалом стен' },
        roof: { type: 'string', enum: ['gable', 'flat', 'none'], description: 'gable — двускатная (по умолчанию)' },
        wall_material: { type: 'string', description: 'по умолчанию oak_planks' },
        floor_material: { type: 'string' },
        roof_material: { type: 'string' },
        corner_material: { type: 'string', description: 'Угловые столбы, например oak_log' },
        windows: { type: 'boolean', description: 'по умолчанию true' },
        window_material: { type: 'string', description: 'glass_pane (по умолчанию) или glass' },
        door: { type: 'boolean', description: 'по умолчанию true' },
        door_material: { type: 'string', description: 'например spruce_door' },
        torches: { type: 'boolean', description: 'Факелы внутри, если есть в инвентаре' },
        remember_as: { type: 'string', description: 'Сохранить как место (например "дом")' },
        ...POS,
      },
    },
    async run(pal, args) {
      return run(pal, house(args), args, 'Дом');
    },
  },
  {
    name: 'build_structure',
    description: 'Простая форма: wall (стена), platform (пол), tower (полая башня), box (закрытая коробка), pillar (столб), pit (яма/котлован), hut (маленький домик — то же, что build_house).',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['wall', 'platform', 'tower', 'box', 'pillar', 'pit', 'hut'] },
        material: { type: 'string', description: 'Блок из инвентаря' },
        width: { type: 'number' }, length: { type: 'number' }, height: { type: 'number' },
        ...POS,
      },
      required: ['type'],
    },
    async run(pal, args) {
      if (args.type === 'hut') {
        // старый тип «hut» из первой версии: маленький дом без подвала
        return run(pal, house({ width: args.width ?? 5, length: args.length ?? 5, floor_height: (args.height ?? 3) + 1, roof: 'flat', windows: false, wall_material: args.material, ...args }), args, 'Домик');
      }
      if (args.type !== 'pit' && !args.material) throw new ActionError('Укажи material');
      return run(pal, simple(args.type, args), args, 'Постройка');
    },
  },
  {
    name: 'build_custom',
    description: `Построить что угодно по своему чертежу (когда параметров build_house не хватает: башня с зубцами, мост, беседка, ферма, необычный дом).
layers — слои снизу вверх; каждый слой — массив строк (строка = ряд по z, символ = блок по x).
legend — что значит символ, массив строк вида "P=oak_planks", например ["P=oak_planks","G=glass_pane","L=oak_log","D=oak_door"].
"." или пробел — не трогать, "-" — выкопать/очистить. base_y — высота первого слоя относительно земли (например -3 для подвала).
Держи чертёж компактным (до ~15x15). Сначала dry_run=true.`,
    parameters: {
      type: 'object',
      properties: {
        layers: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        legend: { type: 'array', items: { type: 'string' }, description: 'Символ=блок, например "P=oak_planks"' },
        base_y: { type: 'number' },
        name: { type: 'string', description: 'Как назвать постройку' },
        remember_as: { type: 'string' },
        ...POS,
      },
      required: ['layers', 'legend'],
    },
    async run(pal, args) {
      const plan = custom(args);
      if (args.name) plan.summary = `${args.name} (${plan.summary})`;
      return run(pal, plan, args, 'Постройка');
    },
  },
  {
    name: 'place_block',
    description: 'Поставить один блок из инвентаря по координатам.',
    parameters: {
      type: 'object',
      properties: { block: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
      required: ['block', 'x', 'y', 'z'],
    },
    async run(pal, { block, x, y, z }) {
      const ok = await placeAt(pal, block, new Vec3(Math.round(x), Math.round(y), Math.round(z)));
      return ok ? `Поставил ${block}.` : 'Место уже занято.';
    },
  },
  {
    name: 'break_block',
    description: 'Сломать блок по координатам.',
    parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
    async run(pal, { x, y, z }) {
      const b = pal.bot.blockAt(new Vec3(Math.round(x), Math.round(y), Math.round(z)));
      if (!b || isAir(b)) return 'Там пусто.';
      await pal.bot.collectBlock.collect(b, { ignoreNoPath: true });
      return `Сломал ${b.name}.`;
    },
  },
];
