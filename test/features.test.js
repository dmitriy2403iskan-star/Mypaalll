// Тесты: генератор построек, база крафтов, лимиты.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mypal-feat-'));
fs.mkdirSync(path.join(process.env.DATA_DIR, 'recipes'));
// своя запись в формате спецификации (как будет из TXT)
fs.writeFileSync(path.join(process.env.DATA_DIR, 'recipes', 'custom.json'), JSON.stringify([
  { id: 'minecraft:magic_wand', introduced_in: '1.99', recipe: { type: 'crafting_shaped', station: 'crafting_table', pattern: [['minecraft:stick']], output: { count: 1 } } },
  { id: 'minecraft:stick', recipes: [{ type: 'crafting_shaped', station: 'inventory', pattern: [['minecraft:dead_bush']], output: { count: 1 }, recipe_introduced_in: '1.0' }] },
]));

const md = (await import('minecraft-data')).default;
const { RecipeDB, cmpVersion } = await import('../src/knowledge/recipes.js');
const { house, custom, simple, billOfMaterials } = await import('../src/building/blueprints.js');
const { isLimitError, parseHeaders, usage, LimitExhaustedError } = await import('../src/llm/usage.js');
const { settings } = await import('../src/config.js');

const db = new RecipeDB(md('1.20.4'));

test('Рецепт: точная матрица, слоты, 3x3', () => {
  const r = db.record('iron_pickaxe').recipes[0];
  assert.deepEqual(r.pattern, [['iron_ingot', 'iron_ingot', 'iron_ingot'], [null, 'stick', null], [null, 'stick', null]]);
  assert.deepEqual(r.slots, { iron_ingot: [0, 1, 2], stick: [4, 7] });
  assert.equal(r.allowed_grid, '3x3');
  assert.equal(r.requires_crafting_table, true);
});

test('Рецепт: 2x2 в инвентаре, двери ×3, вариации отдельно', () => {
  assert.equal(db.record('crafting_table').recipes[0].allowed_grid, '2x2');
  assert.equal(db.record('oak_door').recipes[0].output.count, 3);
  const picks = db.family('pickaxe');
  for (const p of ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']) assert.ok(picks.includes(p));
});

test('Smithing и плавка', () => {
  const n = db.record('netherite_pickaxe').recipes[0];
  assert.equal(n.station, 'smithing_table');
  assert.ok(n.ingredients.diamond_pickaxe && n.ingredients.netherite_ingot);
  assert.equal(db.record('glass').recipes[0].type, 'smelting');
});

test('Проверка версий', () => {
  assert.equal(new RecipeDB(md('1.16.5')).record('cherry_door').exists_in_version, false);
  assert.equal(new RecipeDB(md('1.20.4')).record('cherry_door').exists_in_version, true);
  assert.equal(cmpVersion('1.20.4', '1.20'), 1);
  assert.equal(cmpVersion('1.19', '1.20'), -1);
});

test('Свои записи из data/recipes подмешиваются', () => {
  const stick = db.record('stick');
  assert.ok(stick.recipes.some((r) => r.source === 'custom' && r.ingredients.dead_bush === 1));
});

test('План крафта: каменная кирка с нуля и с инвентарём', () => {
  const p = db.craftPlan('stone_pickaxe', 1, {});
  assert.equal(p.gather.cobblestone, 3);
  assert.ok(Object.keys(p.gather).some((k) => k.endsWith('_log')));
  assert.equal(p.steps.at(-1).item, 'stone_pickaxe');
  const p2 = db.craftPlan('stone_pickaxe', 1, { cobblestone: 5, stick: 4 });
  assert.deepEqual(p2.gather, {});
  assert.equal(p2.steps.length, 1);
  const iron = db.craftPlan('iron_ingot', 3, {});
  assert.equal(iron.gather.raw_iron, 3); // плавка из сырья, а не разбор блока
});

test('Дом без подвала и с подвалом', () => {
  const a = house({ width: 7, length: 7 });
  const b = house({ width: 7, length: 7, basement: true, basement_depth: 3 });
  assert.ok(!a.ops.some((o) => o.y < 0));
  assert.ok(b.ops.some((o) => o.dig && o.y === -3));
  assert.ok(b.ops.some((o) => o.block === 'ladder' && o.y < 0), 'в подвал ведёт лестница');
  assert.ok(!a.ops.some((o) => o.block === 'ladder'), 'одноэтажному дому без подвала лестница не нужна');
  assert.match(a.summary, /без подвала/);
  assert.match(b.summary, /подвал глубиной 3/);
});

test('Двухэтажный дом: окна, дверь, лестница, материалы', () => {
  const h = house({ floors: 2, wall_material: 'cobblestone', window_material: 'glass', roof: 'flat' });
  const bill = billOfMaterials(h.ops);
  assert.ok(bill.cobblestone > 50);
  assert.ok(bill.glass > 0);
  assert.equal(bill.oak_door, 1);
  assert.ok(bill.ladder >= 4);
  // проём двери не заставлен стеной
  assert.ok(!h.ops.some((o) => o.x === 3 && o.z === 0 && o.y === 2 && o.block));
});

test('Свой чертёж и простые формы', () => {
  const c = custom({ layers: [['PPP', 'P-P', 'PPP'], ['G.G']], legend: ['P=oak_planks', 'G=glass'], base_y: -1 });
  assert.equal(billOfMaterials(c.ops).oak_planks, 8);
  assert.ok(c.ops.some((o) => o.dig && o.y === -1));
  assert.throws(() => custom({ layers: [['X']], legend: {} }), /legend/);
  assert.equal(simple('pit', { width: 2, length: 2, height: 2 }).ops.length, 8);
});

test('Лимиты: классификация ошибок и заголовков', () => {
  assert.equal(isLimitError(429, '{"error":{"code":"insufficient_quota"}}').level, 'exhausted');
  assert.equal(isLimitError(429, 'RESOURCE_EXHAUSTED: Quota exceeded').level, 'exhausted');
  assert.equal(isLimitError(400, 'Your credit balance is too low').level, 'exhausted');
  assert.equal(isLimitError(429, 'rate limited').level, 'warning');
  assert.equal(isLimitError(500, 'oops'), null);
  const h = parseHeaders(new Headers({ 'anthropic-ratelimit-tokens-limit': '1000', 'anthropic-ratelimit-tokens-remaining': '50' }));
  assert.deepEqual([h.limitTokens, h.remainingTokens], [1000, 50]);
});

test('Лимиты: предупреждение при остатке ≤ порога и один раз за эпизод', () => {
  const events = [];
  usage.on('warning', (e) => events.push(['warning', e]));
  usage.on('exhausted', (e) => events.push(['exhausted', e]));
  const headers = (rem) => new Headers({ 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': String(rem) });
  usage.record('openai', { inputTokens: 10, outputTokens: 5, headers: headers(50) });
  assert.equal(events.length, 0);
  usage.record('openai', { headers: headers(8) });
  usage.record('openai', { headers: headers(7) });
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'warning');
  assert.equal(events[0][1].percent, 8);
  usage.record('openai', { headers: headers(0) });
  assert.equal(events.at(-1)[0], 'exhausted', 'с warning эскалирует до exhausted');
});

test('Лимиты: свой дневной бюджет блокирует запросы', async () => {
  settings.update({ limits: { dailyTokenBudget: 100 } });
  usage.record('gemini', { inputTokens: 80, outputTokens: 30 });
  assert.ok(usage.budgetExhausted('gemini'));
  const { chat } = await import('../src/llm/router.js');
  await assert.rejects(chat({ provider: 'gemini', messages: [] }), LimitExhaustedError);
  settings.update({ limits: { dailyTokenBudget: 0 } });
});

test('Bedrock: чертёж → команды /fill и /setblock', async () => {
  const { opsToCommands } = await import('../src/bedrock/actions.js');
  const { BEDROCK_ACTIONS, ACTIONS } = await import('../src/actions/index.js');
  const cmds = opsToCommands({ x: 10, y: 64, z: 20 }, house({ width: 5, length: 5, basement: true, basement_depth: 2, roof: 'flat' }).ops);
  assert.ok(cmds.some((c) => /^fill \S+ \S+ \S+ \S+ \S+ \S+ air$/.test(c)), 'подвал копается через /fill … air');
  assert.ok(cmds.some((c) => c.startsWith('fill ') && c.endsWith(' oak_planks')), 'ряды блоков сжаты в /fill');
  assert.ok(cmds.some((c) => c.includes('wooden_door ["upper_block_bit"=true]')), 'дверь — две половины, Bedrock-id');
  assert.ok(cmds.some((c) => c.includes('ladder ["facing_direction"=5]')), 'лестница повернута от стены');
  assert.ok(cmds.length < house({ width: 5, length: 5, basement: true, basement_depth: 2, roof: 'flat' }).ops.length / 2, 'команд заметно меньше, чем блоков');
  // копание идёт раньше установки
  assert.ok(cmds.findIndex((c) => c.endsWith(' air')) < cmds.findIndex((c) => c.endsWith(' oak_planks')));
  const names = BEDROCK_ACTIONS.map((a) => a.name);
  for (const n of ['follow_player', 'build_house', 'run_command', 'plan_crafting', 'remember']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('collect_blocks'), 'в Bedrock нет ручной добычи');
  assert.equal(new Set(names).size, names.length, 'без дубликатов');
  assert.ok(ACTIONS.find((a) => a.name === 'build_structure').parameters.properties.type.enum.includes('hut'), 'старый тип hut сохранён');
});

test('Версии: Java 1.16.5 – новейшая, Bedrock 1.16.201 – новейшая', async () => {
  const { supportedVersions, checkVersion } = await import('../src/versions.js');
  const v = supportedVersions();
  assert.equal(v.java.min, '1.16.5');
  assert.equal(v.bedrock.min, '1.16.201');
  assert.ok(v.java.list.includes('1.16.5') && v.java.list.includes(v.java.max));
  assert.ok(v.bedrock.list.includes('1.16.201') && v.bedrock.list.includes(v.bedrock.max));
  assert.equal(checkVersion('java', '1.16.5'), null);
  assert.equal(checkVersion('java', v.java.max), null);
  assert.match(checkVersion('java', '1.12.2'), /слишком старая/);
  assert.match(checkVersion('java', '99.1'), /новее/);
  assert.equal(checkVersion('bedrock', '1.16.201'), null);
  // база крафтов работает на самой старой и самой новой Java
  assert.ok(new RecipeDB(md('1.16.5')).record('iron_pickaxe').recipes.length);
  assert.ok(new RecipeDB(md(v.java.max)).record('iron_pickaxe').recipes.length);
});

test('Bedrock: старые версии — data-значения и старый /execute', async () => {
  const { blockArg, execAt } = await import('../src/bedrock/blocks.js');
  assert.equal(blockArg('oak_planks', '1.16.201'), 'planks');
  assert.equal(blockArg('spruce_planks', '1.16.201'), 'planks 1');
  assert.equal(blockArg('red_wool', '1.16.201'), 'wool 14');
  assert.equal(blockArg('oak_door', '1.16.201', { upper_block_bit: true }, 8), 'wooden_door 8');
  assert.equal(blockArg('spruce_planks', '1.20.0'), 'planks ["wood_type"="spruce"]');
  assert.equal(blockArg('oak_planks', '1.26.60'), 'oak_planks');
  assert.equal(blockArg('stone_bricks', '1.26.60'), 'stone_bricks');
  assert.equal(execAt('1.16.201', 'Steve', 'tp @s ~ ~ ~'), 'execute "Steve" ~ ~ ~ tp @s ~ ~ ~');
  assert.equal(execAt('1.26.60', 'Steve', 'tp @s ~ ~ ~'), 'execute at "Steve" run tp @s ~ ~ ~');
});

test('Режимы игры: инструменты и правила зависят от выживания/креатива', async () => {
  const { actionAllowed, modePrompt, normalizeMode, modeProfile } = await import('../src/agent/modes.js');
  const { toolSchemas } = await import('../src/actions/index.js');
  const names = (mode, edition = 'java') => toolSchemas({ gameMode: mode, edition }).map((t) => t.name);
  // выживание: добыча и крафт есть, get_item нет
  assert.ok(names('survival').includes('collect_blocks') && names('survival').includes('craft_item'));
  assert.ok(!names('survival').includes('get_item'));
  // креатив: наоборот
  assert.ok(names('creative').includes('get_item') && names('creative').includes('build_house'));
  assert.ok(!names('creative').includes('collect_blocks') && !names('creative').includes('eat'));
  // приключение: нельзя строить; наблюдатель: только движение и разговор
  assert.ok(!names('adventure').includes('build_house') && names('adventure').includes('attack'));
  assert.ok(!names('spectator').includes('attack') && names('spectator').includes('follow_player'));
  // Bedrock: в приключении стройка командами разрешена, get_item нет
  assert.ok(names('adventure', 'bedrock').includes('build_house'));
  assert.ok(!names('creative', 'bedrock').includes('get_item'));
  assert.equal(normalizeMode('creative_spectator'), 'spectator');
  assert.equal(normalizeMode(1), 'creative');
  assert.equal(modeProfile('creative').reflex.eat, false);
  assert.equal(modeProfile('survival').reflex.flee, true);
  assert.match(modePrompt('creative'), /get_item/);
  assert.match(modePrompt('survival'), /добывать/);
  assert.equal(actionAllowed('collect_blocks', 'creative'), false);
});
