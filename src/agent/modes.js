// Поведение pal'а в зависимости от игрового режима: выживание, креатив, приключение, наблюдатель.
// От режима зависят: какие инструменты видит нейросеть, как работают рефлексы и откуда берутся блоки для стройки.

export const MODES = {
  survival: {
    title: 'выживание',
    say: 'Я в выживании — буду добывать и крафтить всё сам.',
    prompt: `Режим: ВЫЖИВАНИЕ. Ресурсы настоящие и конечные.
- Блоки и предметы надо добывать (collect_blocks), крафтить (craft_item) и плавить (smelt_item). plan_crafting подскажет цепочку.
- Перед стройкой: dry_run → собери недостающие материалы → строй.
- Следи за здоровьем и едой, ночью опасно, береги инструменты. Голод и бой рефлексы обрабатывают сами.`,
    blocked: ['get_item'],
    reflex: { eat: true, flee: true, defend: true },
    freeBlocks: false,
  },
  creative: {
    title: 'креатив',
    say: 'Я в креативе — блоки беру из инвентаря креатива, строю сразу без добычи.',
    prompt: `Режим: КРЕАТИВ. Любые предметы бесконечны и бесплатны, урона и голода нет.
- Ничего не добывай и не крафти: нужный предмет бери через get_item (в любом количестве).
- Стройка: материалы берутся автоматически — сразу вызывай build_house/build_custom без сбора ресурсов. Можно строить крупнее и красивее (стекло, кирпич, кварц, фонари).
- Можешь летать, высота не помеха. Еда и сон не нужны. Мобы тебя не трогают — защищай игрока, только если просят (guard).`,
    blocked: ['collect_blocks', 'craft_item', 'smelt_item', 'eat', 'sleep_in_bed', 'pickup_items', 'plan_crafting'],
    reflex: { eat: false, flee: false, defend: false },
    freeBlocks: true,
  },
  adventure: {
    title: 'приключение',
    say: 'Я в режиме приключения — ломать и ставить блоки не могу, но могу ходить, сражаться и помогать.',
    prompt: `Режим: ПРИКЛЮЧЕНИЕ. Ломать и ставить блоки нельзя (кроме разрешённых картой).
- Не пытайся строить и копать — честно скажи, что в этом режиме нельзя.
- Можно: ходить, следовать, охранять, сражаться, торговать предметами, крафтить из того, что есть, пользоваться сундуками.`,
    blocked: ['collect_blocks', 'break_block', 'place_block', 'build_house', 'build_structure', 'build_custom', 'get_item'],
    reflex: { eat: true, flee: true, defend: true },
    freeBlocks: false,
  },
  spectator: {
    title: 'наблюдатель',
    say: 'Я в режиме наблюдателя — могу только летать рядом и разговаривать.',
    prompt: `Режим: НАБЛЮДАТЕЛЬ. Нельзя взаимодействовать с миром: ни блоков, ни предметов, ни боя.
- Можно только перемещаться (сквозь стены), следовать за игроком, осматриваться и разговаривать.
- На просьбы что-то сделать отвечай, что нужно переключить тебя в выживание или креатив (/gamemode).`,
    allowedOnly: ['go_to_player', 'follow_player', 'stop', 'go_to_coords', 'go_to_location', 'save_location', 'explore', 'inspect_surroundings', 'find_block', 'get_recipe', 'list_variants', 'remember', 'wait'],
    reflex: { eat: false, flee: false, defend: false },
    freeBlocks: false,
  },
};

// Bedrock: у бота своё тело, правила те же, что в Java; команды — только в креативе или по прямой просьбе
const BEDROCK_EXTRA = {
  survival: '\n- Bedrock: всё делаешь руками, как игрок. Не раздавай бесплатные предметы командами и не меняй режим игры, если игрок явно не попросил.',
  creative: '\n- Bedrock: get_item выдаёт предмет командой /give (нужны права оператора); стройка в креативе идёт командами /fill и /setblock.',
  adventure: '',
  spectator: '',
};

/** Нормализация названий режимов (Java и Bedrock). */
export function normalizeMode(raw) {
  const m = String(raw ?? '').toLowerCase();
  if (m.includes('spectator')) return 'spectator';
  if (m.startsWith('creative') || m === '1') return 'creative';
  if (m.startsWith('adventure') || m === '2') return 'adventure';
  return 'survival';
}

export function modeProfile(raw) {
  return MODES[normalizeMode(raw)];
}

/** Доступно ли действие в этом режиме. */
export function actionAllowed(name, raw, edition = 'java') {
  const p = modeProfile(raw);
  if (p.allowedOnly && !p.allowedOnly.includes(name)) return false;
  return !(p.blocked || []).includes(name);
}

export function modePrompt(raw, edition = 'java') {
  const key = normalizeMode(raw);
  return MODES[key].prompt + (edition === 'bedrock' ? BEDROCK_EXTRA[key] : '');
}

/** Объяснение, почему действие недоступно (если нейросеть всё же его вызвала). */
export function blockedReason(name, raw) {
  const key = normalizeMode(raw);
  if (key === 'creative' && ['collect_blocks', 'craft_item', 'smelt_item', 'pickup_items'].includes(name)) return 'В креативе ничего не нужно добывать или крафтить — возьми предмет через get_item.';
  if (key === 'creative' && ['eat', 'sleep_in_bed'].includes(name)) return 'В креативе нет голода, а спать не обязательно.';
  if (key === 'adventure') return 'В режиме приключения нельзя ломать и ставить блоки.';
  if (key === 'spectator') return 'В режиме наблюдателя нельзя взаимодействовать с миром — попроси переключить меня в выживание или креатив.';
  return `Действие ${name} недоступно в режиме «${MODES[key].title}».`;
}
