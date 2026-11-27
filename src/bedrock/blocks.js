// Перевод Java-названий блоков в команды Bedrock с учётом версии сервера (1.16.201 … новейшая).
//  - имена блоков берутся из данных той версии, к которой подключён бот (minecraft-data bedrock_<версия>);
//  - старые версии: planks/log/wool/stonebrick с типом вместо oak_planks/oak_log/white_wool/stone_bricks;
//  - до 1.19.70 в командах нет синтаксиса состояний ["key"=value] — используются числовые data-значения;
//  - до 1.19.50 — старый /execute: `execute <цель> ~ ~ ~ <команда>`.
import { createRequire } from 'node:module';
import { cmpVersion } from '../versions.js';

const require = createRequire(import.meta.url);
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak'];
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const ALIASES = { oak_door: 'wooden_door', short_grass: 'tallgrass', bricks: 'brick_block', terracotta: 'hardened_clay', snow_block: 'snow' };

const blockNames = new Map();
function namesFor(version) {
  if (!blockNames.has(version)) {
    let set = null;
    try { set = new Set(Object.keys(require('minecraft-data')(`bedrock_${version}`).blocksByName)); } catch { /* нет данных — считаем новой версией */ }
    blockNames.set(version, set);
  }
  return blockNames.get(version);
}

/** Java-имя → { id, states, data } для конкретной версии Bedrock. */
export function resolveBlock(name, version) {
  const names = namesFor(version);
  const has = (n) => !names || names.has(n);
  if (has(name) && !ALIASES[name]) return { id: name, states: {}, data: 0 };
  if (ALIASES[name] && has(ALIASES[name])) return { id: ALIASES[name], states: {}, data: 0 };
  let m;
  if ((m = name.match(/^(\w+?)_planks$/)) && WOODS.includes(m[1])) {
    return { id: 'planks', states: { wood_type: m[1] }, data: WOODS.indexOf(m[1]) };
  }
  if ((m = name.match(/^(\w+?)_log$/)) && WOODS.includes(m[1])) {
    const i = WOODS.indexOf(m[1]);
    return i < 4 ? { id: 'log', states: { old_log_type: m[1], pillar_axis: 'y' }, data: i } : { id: 'log2', states: { new_log_type: m[1], pillar_axis: 'y' }, data: i - 4 };
  }
  if ((m = name.match(/^(\w+)_wool$/)) && COLORS.includes(m[1])) {
    return { id: 'wool', states: { color: m[1] === 'light_gray' ? 'silver' : m[1] }, data: COLORS.indexOf(m[1]) };
  }
  if (name === 'stone_bricks') return { id: 'stonebrick', states: { stone_brick_type: 'default' }, data: 0 };
  return { id: ALIASES[name] || name, states: {}, data: 0 };
}

const fmtState = (v) => (typeof v === 'string' ? `"${v}"` : String(v));

/** Строка блока для /setblock и /fill: "oak_planks", "planks ["wood_type"="oak"]" или "planks 0". */
export function blockArg(name, version, extraStates = {}, extraData = 0) {
  const b = resolveBlock(name, version);
  const states = { ...b.states, ...extraStates };
  const modern = !version || cmpVersion(version, '1.19.70') >= 0;
  if (modern) {
    const keys = Object.keys(states);
    return keys.length ? `${b.id} [${keys.map((k) => `"${k}"=${fmtState(states[k])}`).join(',')}]` : b.id;
  }
  const data = b.data + extraData;
  return data ? `${b.id} ${data}` : b.id;
}

/** Выполнить команду «от позиции игрока» в синтаксисе нужной версии. */
export function execAt(version, target, command, self) {
  const t = `"${String(target).replace(/"/g, '')}"`;
  if (version && cmpVersion(version, '1.19.50') < 0) {
    // в старом /execute исполнителем становится цель, и @s означает её — бота называем по имени
    const cmd = self ? command.replace(/@s\b/g, `"${String(self).replace(/"/g, '')}"`) : command;
    return `execute ${t} ~ ~ ~ ${cmd}`;
  }
  return `execute at ${t} run ${command}`;
}
