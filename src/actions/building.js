// Строительство по чертежам. LLM выбирает «что» (тип, размер, материал), а код решает «как» ставить блоки.
import { ActionError, countItem, placeAt, Vec3, isAir } from './util.js';

/** Генераторы чертежей: возвращают список относительных координат {x,y,z} (y=0 — уровень пола). */
const BLUEPRINTS = {
  platform: ({ w, l }) => box(w, l, 1, { fill: true }).map((p) => ({ ...p, y: -1 })),
  wall: ({ w, h }) => { const out = []; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push({ x, y, z: 0 }); return out; },
  tower: ({ w, h }) => box(w, w, h, { hollow: true }),
  box: ({ w, l, h }) => box(w, l, h, { hollow: true, roof: true }),
  hut: ({ w, l, h }) => {
    const door = { x: Math.floor(w / 2), z: 0 };
    return box(w, l, h, { hollow: true, roof: true })
      .filter((p) => !(p.x === door.x && p.z === door.z && (p.y === 0 || p.y === 1)));
  },
};

function box(w, l, h, { hollow = false, roof = false, fill = false } = {}) {
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < l; z++) {
        const edge = x === 0 || z === 0 || x === w - 1 || z === l - 1;
        if (fill || !hollow || edge) out.push({ x, y, z });
      }
    }
  }
  if (roof) for (let x = 0; x < w; x++) for (let z = 0; z < l; z++) out.push({ x, y: h, z });
  return out;
}

export default [
  {
    name: 'build_structure',
    description: 'Построить простую постройку рядом. Типы: hut (домик с дверным проёмом и крышей), box (закрытая коробка), wall (стена), tower (полая башня), platform (пол). Перед этим собери достаточно материала — функция сообщит, сколько нужно.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: Object.keys(BLUEPRINTS) },
        material: { type: 'string', description: 'Блок из инвентаря, например oak_planks, cobblestone' },
        width: { type: 'number', description: 'по умолчанию 5' },
        length: { type: 'number', description: 'по умолчанию 5' },
        height: { type: 'number', description: 'по умолчанию 3' },
        x: { type: 'number', description: 'Угол постройки (необязательно; по умолчанию в 2 блоках перед ботом)' },
        y: { type: 'number' },
        z: { type: 'number' },
        dry_run: { type: 'boolean', description: 'true — только посчитать нужный материал' },
      },
      required: ['type', 'material'],
    },
    async run(pal, args) {
      const { bot } = pal;
      const w = clamp(args.width ?? 5, 1, 15);
      const l = clamp(args.length ?? 5, 1, 15);
      const h = clamp(args.height ?? 3, 1, 8);
      const plan = BLUEPRINTS[args.type]?.({ w, l, h });
      const size = args.type === 'wall' ? `${w}x${h}` : args.type === 'platform' ? `${w}x${l}` : `${w}x${l}x${h}`;
      if (!plan) throw new ActionError(`Неизвестный тип постройки ${args.type}`);

      let origin;
      if (args.x !== undefined && args.z !== undefined) {
        origin = new Vec3(Math.round(args.x), Math.round(args.y ?? bot.entity.position.y), Math.round(args.z));
      } else {
        const p = bot.entity.position.floored();
        const yaw = bot.entity.yaw;
        origin = p.offset(Math.round(-Math.sin(yaw) * 3) - Math.floor(w / 2), 0, Math.round(-Math.cos(yaw) * 3) - Math.floor(l / 2));
        origin.y = surfaceY(bot, origin.x, origin.z, p.y);
      }

      const targets = plan.map((r) => origin.offset(r.x, r.y, r.z))
        .filter((pos) => isReplaceable(bot.blockAt(pos)));
      const have = countItem(bot, args.material);
      if (!targets.length) throw new ActionError(`Место ${origin} уже занято блоками. Отойди на ровное место или укажи координаты x,y,z.`);
      if (args.dry_run) return `Для ${args.type} ${size} нужно ${targets.length} ${args.material}, есть ${have}. Угол: ${origin}.`;
      if (have < targets.length) {
        throw new ActionError(`Не хватает материала: нужно ${targets.length} ${args.material}, есть ${have}. Добудь/скрафти ещё ${targets.length - have}.`);
      }

      // строим снизу вверх, ближние блоки первыми
      targets.sort((a, b) => a.y - b.y || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
      let placed = 0;
      const failed = [];
      let pending = targets;
      // несколько проходов: блоки, которым не к чему было прикрепиться, получают опору на следующем проходе
      for (let pass = 0; pass < 3 && pending.length && !pal.interrupted; pass++) {
        const next = [];
        for (const pos of pending) {
          if (pal.interrupted) break;
          try {
            if (await placeAt(pal, args.material, pos)) placed++;
          } catch (e) {
            next.push(pos);
            if (pass === 2) failed.push(`${pos}: ${e.message}`);
          }
        }
        pending = next;
      }
      pal.memory.add('episodic', `Построил ${args.type} ${size} из ${args.material} в ${origin}`, 3);
      if (!placed) throw new ActionError(`Ничего не удалось построить. ${failed.slice(0, 3).join('; ')}`);
      return `Построил ${args.type}: поставил ${placed}/${targets.length} блоков в районе ${origin}.${failed.length ? ` Не получилось ${failed.length}: ${failed.slice(0, 2).join('; ')}` : ''}`;
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

/** Уровень земли: первая пустая клетка над твёрдым блоком рядом с высотой y. */
function surfaceY(bot, x, z, y) {
  for (let yy = y + 4; yy >= y - 6; yy--) {
    const here = bot.blockAt(new Vec3(x, yy, z));
    const below = bot.blockAt(new Vec3(x, yy - 1, z));
    if (here && isReplaceable(here) && below?.boundingBox === 'block') return yy;
  }
  return y;
}
const isReplaceable = (b) => isAir(b) || ['water', 'short_grass', 'grass', 'tall_grass', 'snow'].includes(b.name);

const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(Number(v) || a)));
