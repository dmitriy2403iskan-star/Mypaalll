// Context Manager: решает, что из состояния мира реально нужно LLM прямо сейчас.
// Полный снимок мира дорогой и шумный — отправляем только релевантное.
import { snapshot } from '../minecraft/world.js';

const INTENTS = {
  build: /стро|дом|хиж|стен|баш|build|house|hut|wall|tower|платформ/i,
  gather: /добуд|собер|руби|копа|шахт|дерев|брёв|брев|камн|руд|mine|collect|gather|wood|log|stone|ore|dig/i,
  craft: /крафт|сделай|скрафт|кирк|меч|топор|печ|сундук|верстак|craft|make|pickaxe|sword|axe|furnace|chest/i,
  combat: /атак|убей|защ|охран|бей|моб|зомби|attack|kill|fight|guard|protect|mob/i,
  explore: /исслед|разведа|найди|ищи|explore|find|search|look for/i,
};

export function detectIntents(text = '') {
  return Object.entries(INTENTS).filter(([, re]) => re.test(text)).map(([k]) => k);
}

export function buildContext(pal, message = '') {
  const s = snapshot(pal.bot);
  if (!s) return 'Бот ещё не в мире.';
  const intents = detectIntents(message);
  const task = pal.tasks.summary();
  const lines = [];

  lines.push(`# Состояние (${new Date().toLocaleTimeString('ru-RU')})`);
  lines.push(`Позиция: ${s.position.x} ${s.position.y} ${s.position.z} | ${s.dimension}${s.biome ? `, биом ${s.biome}` : ''} | ${s.time}${s.isRaining ? ', дождь' : ''}`);
  lines.push(`Здоровье ${s.health}/20, сытость ${s.food}/20, в руке: ${s.heldItem || 'ничего'}, режим игры: ${s.gameMode}`);
  if (pal.mode) lines.push(`Фоновый режим: ${pal.mode.type} → ${pal.mode.player}`);

  const inv = Object.entries(s.inventory);
  lines.push(`Инвентарь: ${inv.length ? inv.map(([k, v]) => `${k}×${v}`).join(', ') : 'пусто'}`);

  const players = s.nearbyEntities.filter((e) => e.type === 'player');
  const mobs = s.nearbyEntities.filter((e) => e.type !== 'player');
  lines.push(`Игроки рядом: ${players.length ? players.map((e) => `${e.name} (${e.distance} бл.)`).join(', ') : 'никого'}`);
  // мобы важны всегда, если враждебные; остальные — только для боя/охоты/исследования
  const relevantMobs = mobs.filter((e) => e.type === 'hostile' || intents.includes('combat') || intents.includes('explore'));
  if (relevantMobs.length) lines.push(`Существа: ${relevantMobs.slice(0, 8).map((e) => `${e.name}${e.type === 'hostile' ? '(враг)' : ''} ${e.distance}бл`).join(', ')}`);

  if (intents.some((i) => ['build', 'gather', 'craft', 'explore'].includes(i)) || !intents.length) {
    lines.push(`Блоки вокруг: ${s.nearbyBlocks.slice(0, intents.length ? 25 : 12).join(', ')}`);
  }

  const locs = pal.memory.locations();
  if (locs.length) lines.push(`Известные места: ${locs.map((l) => `${l.name} (${l.x} ${l.y} ${l.z})`).join('; ')}`);

  if (task) {
    lines.push(`\n# Текущий план #${task.id}: ${task.goal}`);
    lines.push(...task.steps);
  }

  const mems = pal.memory.relevant(message, 12);
  if (mems.length) {
    lines.push('\n# Что ты помнишь');
    for (const m of mems) lines.push(`- ${m.content}`);
  }
  return lines.join('\n');
}
