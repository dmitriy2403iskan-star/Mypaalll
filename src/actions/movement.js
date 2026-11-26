import { goals, goto, gotoPos, findPlayer, ActionError, Vec3 } from './util.js';
import { fmtPos } from '../minecraft/world.js';

export default [
  {
    name: 'go_to_player',
    description: 'Подойти к игроку (один раз). Для постоянного сопровождения используй follow_player.',
    parameters: {
      type: 'object',
      properties: { player: { type: 'string', description: 'Ник игрока' }, distance: { type: 'number', description: 'На каком расстоянии остановиться, по умолчанию 2' } },
      required: ['player'],
    },
    async run(pal, { player, distance = 2 }) {
      const target = findPlayer(pal.bot, player);
      if (!target) throw new ActionError(`Не вижу игрока ${player}. Он слишком далеко или не в сети.`);
      await gotoPos(pal, target.position, distance, 120_000);
      return `Дошёл до ${player}.`;
    },
  },
  {
    name: 'follow_player',
    description: 'Постоянно следовать за игроком в фоне, пока не вызовут stop или другое действие движения.',
    parameters: {
      type: 'object',
      properties: { player: { type: 'string' }, distance: { type: 'number', description: 'Дистанция, по умолчанию 3' } },
      required: ['player'],
    },
    async run(pal, { player, distance = 3 }) {
      const target = findPlayer(pal.bot, player);
      if (!target) throw new ActionError(`Не вижу игрока ${player}.`);
      pal.setMode('follow', player);
      pal.bot.pathfinder.setGoal(new goals.GoalFollow(target, distance), true);
      return `Следую за ${player}.`;
    },
  },
  {
    name: 'stop',
    description: 'Остановить все текущие действия и фоновые режимы (следование, бой, охрана).',
    parameters: { type: 'object', properties: {} },
    async run(pal) {
      pal.stopAll();
      return 'Остановился.';
    },
  },
  {
    name: 'go_to_coords',
    description: 'Идти к координатам.',
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, range: { type: 'number' } },
      required: ['x', 'z'],
    },
    async run(pal, { x, y, z, range = 1 }) {
      const goal = y === undefined || y === null ? new goals.GoalXZ(x, z) : new goals.GoalNear(x, y, z, range);
      await goto(pal, goal, 180_000);
      return `Пришёл в ${JSON.stringify(fmtPos(pal.bot.entity.position))}.`;
    },
  },
  {
    name: 'save_location',
    description: 'Запомнить место под именем (например "дом", "шахта"). Без координат — текущая позиция бота.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
      required: ['name'],
    },
    async run(pal, { name, x, y, z }) {
      const pos = x !== undefined && z !== undefined ? { x, y: y ?? pal.bot.entity.position.y, z } : pal.bot.entity.position;
      pal.memory.saveLocation(name, pos, pal.bot.game.dimension);
      return `Запомнил место "${name}": ${JSON.stringify(fmtPos(pos))}.`;
    },
  },
  {
    name: 'go_to_location',
    description: 'Идти в сохранённое место по имени (дом, база, шахта...).',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async run(pal, { name }) {
      const loc = pal.memory.getLocation(name);
      if (!loc) {
        const known = pal.memory.locations().map((l) => l.name).join(', ') || 'нет';
        throw new ActionError(`Не знаю места "${name}". Известные места: ${known}.`);
      }
      await gotoPos(pal, new Vec3(loc.x, loc.y, loc.z), 2, 300_000);
      return `Пришёл в "${name}".`;
    },
  },
  {
    name: 'explore',
    description: 'Исследовать местность: уйти в случайном (или заданном) направлении на указанное расстояние.',
    parameters: {
      type: 'object',
      properties: {
        distance: { type: 'number', description: 'Блоков, по умолчанию 40' },
        direction: { type: 'string', enum: ['north', 'south', 'east', 'west', 'random'] },
      },
    },
    async run(pal, { distance = 40, direction = 'random' }) {
      const dirs = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
      let [dx, dz] = dirs[direction] || [];
      if (dx === undefined) { const a = Math.random() * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); }
      const p = pal.bot.entity.position;
      await goto(pal, new goals.GoalXZ(Math.round(p.x + dx * distance), Math.round(p.z + dz * distance)), 120_000);
      return `Прошёл ~${distance} блоков. Сейчас в ${JSON.stringify(fmtPos(pal.bot.entity.position))}.`;
    },
  },
];
