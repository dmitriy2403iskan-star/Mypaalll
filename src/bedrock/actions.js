// Действия для Bedrock: всё через команды (/tp, /setblock, /fill, /give, /kill …).
// Нужен мир с читами и бот-оператор. Чертежи построек — те же, что в Java (src/building/blueprints.js).
import { ActionError } from '../actions/util.js';
import { house, simple, custom, billOfMaterials } from '../building/blueprints.js';
import { fmt } from '../building/executor.js';

// Java id → Bedrock id (где отличаются)
const BLOCK_ALIASES = {
  oak_door: 'wooden_door',
  stone_bricks: 'stonebrick',
  short_grass: 'tallgrass',
  bricks: 'brick_block',
  terracotta: 'hardened_clay',
  snow_block: 'snow',
};
// Bedrock: ladder facing_direction 2=north 3=south 4=west 5=east (куда «смотрит» лестница)
const LADDER_FACING = { '-1,0,0': 5, '1,0,0': 4, '0,0,-1': 3, '0,0,1': 2 };

const q = (name) => `"${String(name).replace(/"/g, '')}"`;

function blockSpec(op) {
  const id = BLOCK_ALIASES[op.block] || op.block;
  if (op.block === 'ladder' && op.attach) return `ladder ["facing_direction"=${LADDER_FACING[op.attach.join(',')] ?? 5}]`;
  return id;
}

/** Сжимаем операции в команды: одинаковые блоки в ряд по z → один /fill. */
export function opsToCommands(origin, ops) {
  const abs = ops.map((op) => ({ ...op, x: origin.x + op.x, y: origin.y + op.y, z: origin.z + op.z }));
  const digs = abs.filter((o) => o.dig).sort((a, b) => b.y - a.y);
  const places = abs.filter((o) => o.block);
  const plain = places.filter((o) => !o.attach).sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
  const attached = places.filter((o) => o.attach);
  const cmds = [];
  const runs = (list, spec) => {
    let i = 0;
    while (i < list.length) {
      const a = list[i];
      let j = i;
      while (j + 1 < list.length && list[j + 1].y === a.y && list[j + 1].x === a.x && list[j + 1].z === list[j].z + 1 && spec(list[j + 1]) === spec(a)) j++;
      const b = list[j];
      cmds.push(i === j ? `setblock ${a.x} ${a.y} ${a.z} ${spec(a)}` : `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${spec(a)}`);
      i = j + 1;
    }
  };
  runs(digs.sort((a, b) => b.y - a.y || a.x - b.x || a.z - b.z), () => 'air');
  runs(plain, blockSpec);
  for (const o of attached) {
    if (/door$/.test(o.block)) {
      const id = BLOCK_ALIASES[o.block] || o.block;
      cmds.push(`setblock ${o.x} ${o.y} ${o.z} ${id} ["upper_block_bit"=false]`);
      cmds.push(`setblock ${o.x} ${o.y + 1} ${o.z} ${id} ["upper_block_bit"=true]`);
    } else {
      cmds.push(`setblock ${o.x} ${o.y} ${o.z} ${blockSpec(o)}`);
    }
  }
  return cmds;
}

async function runCommands(pal, cmds) {
  const body = pal.bot;
  let ok = 0; const errors = [];
  for (let i = 0; i < cmds.length; i += 6) {
    if (pal.interrupted) break;
    const batch = cmds.slice(i, i + 6);
    const res = await Promise.all(batch.map((c) => body.command(c)));
    res.forEach((r, k) => (r.success ? ok++ : errors.push(`${batch[k]} → ${r.output}`)));
  }
  return { ok, errors };
}

function originFor(pal, args) {
  const me = pal.bot.entity?.position;
  if (!me) throw new ActionError('Не знаю своей позиции');
  if (args.x !== undefined && args.z !== undefined) return { x: Math.round(args.x), y: Math.round(args.y ?? me.y), z: Math.round(args.z) };
  return { x: Math.floor(me.x) + 2, y: Math.floor(me.y), z: Math.floor(me.z) + 2 };
}

async function build(pal, plan, args, title) {
  const origin = originFor(pal, args);
  const cmds = opsToCommands(origin, plan.ops);
  const bill = billOfMaterials(plan.ops);
  if (args.dry_run) return `${title}: ${plan.summary}. Угол ${origin.x} ${origin.y} ${origin.z}. Блоков: ${fmt(bill)}. Команд: ${cmds.length}. (Bedrock: строю командами, материалы не тратятся.)`;
  const r = await runCommands(pal, cmds);
  if (!r.ok) throw new ActionError(`Команды не сработали (нужны читы и права оператора): ${r.errors.slice(0, 2).join('; ')}`);
  pal.memory.add('episodic', `Построил ${plan.summary} в ${origin.x} ${origin.y} ${origin.z}`, 3);
  if (args.remember_as) pal.memory.saveLocation(args.remember_as, { x: origin.x + Math.floor(plan.size.w / 2), y: origin.y + 1, z: origin.z - 1 }, pal.bot.dimension);
  return `${title} готов: ${plan.summary}. Команд выполнено ${r.ok}/${cmds.length}.${r.errors.length ? ` Ошибки: ${r.errors.slice(0, 2).join('; ')}` : ''}`;
}

const BUILD_POS = {
  x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
  dry_run: { type: 'boolean' }, remember_as: { type: 'string' },
};

const BLOCKED = /^\/?(op|deop|stop|kick|ban|ban-ip|pardon|whitelist|allowlist|permission|reload|save|transfer|setmaxplayers|changesetting)\b/i;

export default [
  {
    name: 'go_to_player',
    description: 'Переместиться к игроку (телепорт командой).',
    parameters: { type: 'object', properties: { player: { type: 'string' } }, required: ['player'] },
    async run(pal, { player }) {
      const r = await pal.bot.command(`execute at ${q(player)} run tp @s ^1 ^ ^-1`);
      if (!r.success) throw new ActionError(`Не получилось: ${r.output}. Нужны читы/оператор, и игрок должен быть онлайн.`);
      return `Я рядом с ${player}.`;
    },
  },
  {
    name: 'follow_player',
    description: 'Следовать за игроком в фоне (держится позади него), пока не скажут stop.',
    parameters: { type: 'object', properties: { player: { type: 'string' }, distance: { type: 'number' } }, required: ['player'] },
    async run(pal, { player, distance = 3 }) {
      pal.setMode('follow', player, { distance });
      return `Следую за ${player}.`;
    },
  },
  {
    name: 'guard',
    description: 'Охранять игрока: следовать и уничтожать враждебных мобов вокруг него. Выключается через stop.',
    parameters: { type: 'object', properties: { player: { type: 'string' } }, required: ['player'] },
    async run(pal, { player }) {
      pal.setMode('guard', player, { distance: 3 });
      return `Охраняю ${player}.`;
    },
  },
  {
    name: 'clear_hostiles',
    description: 'Уничтожить враждебных мобов в радиусе вокруг игрока или себя.',
    parameters: { type: 'object', properties: { player: { type: 'string' }, radius: { type: 'number' } } },
    async run(pal, { player, radius = 16 }) {
      const r = Math.min(64, radius);
      const res = await pal.bot.command(player ? `execute at ${q(player)} run kill @e[family=monster,r=${r}]` : `kill @e[family=monster,r=${r}]`);
      return res.success ? `Мобы вокруг уничтожены (${res.output}).` : `Враждебных мобов рядом нет (${res.output}).`;
    },
  },
  {
    name: 'stop',
    description: 'Остановить фоновые режимы (следование, охрана).',
    parameters: { type: 'object', properties: {} },
    async run(pal) { pal.stopAll(); return 'Остановился.'; },
  },
  {
    name: 'go_to_coords',
    description: 'Переместиться к координатам.',
    parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'z'] },
    async run(pal, { x, y, z }) {
      const r = await pal.bot.command(`tp @s ${x} ${y ?? '~'} ${z}`);
      if (!r.success) throw new ActionError(r.output);
      return `Я в ${x} ${y ?? '~'} ${z}.`;
    },
  },
  {
    name: 'save_location',
    description: 'Запомнить место (по умолчанию — где стоит бот).',
    parameters: { type: 'object', properties: { name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['name'] },
    async run(pal, { name, x, y, z }) {
      const me = pal.bot.entity?.position;
      const pos = x !== undefined && z !== undefined ? { x, y: y ?? me?.y ?? 64, z } : me;
      if (!pos) throw new ActionError('Не знаю позиции');
      pal.memory.saveLocation(name, pos, pal.bot.dimension);
      return `Запомнил "${name}": ${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}.`;
    },
  },
  {
    name: 'go_to_location',
    description: 'Переместиться в сохранённое место.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async run(pal, { name }) {
      const loc = pal.memory.getLocation(name);
      if (!loc) throw new ActionError(`Не знаю места "${name}". Известные: ${pal.memory.locations().map((l) => l.name).join(', ') || 'нет'}`);
      const r = await pal.bot.command(`tp @s ${loc.x} ${loc.y} ${loc.z}`);
      if (!r.success) throw new ActionError(r.output);
      return `Я в "${name}".`;
    },
  },
  {
    name: 'give_items',
    description: 'Выдать игроку предметы командой /give (Bedrock-id предмета).',
    parameters: { type: 'object', properties: { player: { type: 'string' }, item: { type: 'string' }, count: { type: 'number' } }, required: ['player', 'item'] },
    async run(pal, { player, item, count = 1 }) {
      const r = await pal.bot.command(`give ${q(player)} ${BLOCK_ALIASES[item] || item} ${Math.min(Math.max(1, count), 64 * 36)}`);
      if (!r.success) throw new ActionError(`Не вышло: ${r.output}`);
      return `Выдал ${count} ${item} игроку ${player}.`;
    },
  },
  {
    name: 'build_house',
    description: 'Построить дом по параметрам (командами /fill и /setblock). «с подвалом» → basement=true, «без подвала» → false, «двухэтажный» → floors=2, «из камня» → wall_material="cobblestone", «плоская крыша» → roof="flat".',
    parameters: {
      type: 'object',
      properties: {
        width: { type: 'number' }, length: { type: 'number' }, floors: { type: 'number' }, floor_height: { type: 'number' },
        basement: { type: 'boolean' }, basement_depth: { type: 'number' }, basement_lined: { type: 'boolean' },
        roof: { type: 'string', enum: ['gable', 'flat', 'none'] },
        wall_material: { type: 'string' }, floor_material: { type: 'string' }, roof_material: { type: 'string' }, corner_material: { type: 'string' },
        windows: { type: 'boolean' }, window_material: { type: 'string' }, door: { type: 'boolean' }, door_material: { type: 'string' }, torches: { type: 'boolean' },
        ...BUILD_POS,
      },
    },
    async run(pal, args) { return build(pal, house(args), args, 'Дом'); },
  },
  {
    name: 'build_structure',
    description: 'Простая форма: wall, platform, tower, box, pillar, pit.',
    parameters: {
      type: 'object',
      properties: { type: { type: 'string', enum: ['wall', 'platform', 'tower', 'box', 'pillar', 'pit'] }, material: { type: 'string' }, width: { type: 'number' }, length: { type: 'number' }, height: { type: 'number' }, ...BUILD_POS },
      required: ['type'],
    },
    async run(pal, args) { return build(pal, simple(args.type, args), args, 'Постройка'); },
  },
  {
    name: 'build_custom',
    description: 'Построить по своему чертежу: layers — слои снизу вверх (строки = z, символы = x), legend — ["P=oak_planks", ...], "." — не трогать, "-" — очистить.',
    parameters: {
      type: 'object',
      properties: { layers: { type: 'array', items: { type: 'array', items: { type: 'string' } } }, legend: { type: 'array', items: { type: 'string' } }, base_y: { type: 'number' }, name: { type: 'string' }, ...BUILD_POS },
      required: ['layers', 'legend'],
    },
    async run(pal, args) {
      const plan = custom(args);
      if (args.name) plan.summary = `${args.name} (${plan.summary})`;
      return build(pal, plan, args, 'Постройка');
    },
  },
  {
    name: 'run_command',
    description: 'Выполнить любую игровую команду Bedrock (time set day, weather clear, effect, summon, fill…). Опасные админ-команды запрещены.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    async run(pal, { command }) {
      if (BLOCKED.test(command.trim())) throw new ActionError('Эту команду мне выполнять нельзя.');
      const r = await pal.bot.command(command);
      return `${r.success ? 'OK' : 'Ошибка'}: ${r.output}`;
    },
  },
  {
    name: 'inspect_surroundings',
    description: 'Позиция, здоровье, игроки рядом.',
    parameters: { type: 'object', properties: {} },
    async run(pal) { return JSON.stringify(pal.bot.snapshot()); },
  },
];

/** Фоновый цикл режимов follow/guard для Bedrock. */
export function startBedrockModes(pal) {
  let busy = false;
  const timer = setInterval(async () => {
    const mode = pal.mode;
    const body = pal.bot;
    if (!mode || busy || !body || body.ended) return;
    busy = true;
    try {
      const target = body.findPlayer(mode.player);
      const me = body.entity?.position;
      const far = !target?.position || !me || Math.hypot(target.position.x - me.x, target.position.z - me.z) > (mode.distance || 3) + 2;
      if (far) await body.command(`execute at ${q(mode.player)} run tp @s ^1 ^ ^-${mode.distance || 2}`, 2500);
      if (mode.type === 'guard') await body.command(`execute at ${q(mode.player)} run kill @e[family=monster,r=12]`, 2500);
    } finally {
      busy = false;
    }
  }, 1500);
  return () => clearInterval(timer);
}
