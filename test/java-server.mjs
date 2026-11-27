// Тест Java-бота против НАСТОЯЩЕГО сервера Minecraft Java (vanilla server.jar с сайта Mojang, скачивается в CI).
// Запуск: node test/java-server.mjs 1.21.4   (нужна Java подходящей версии в PATH)
// Проверяет те же умения, что и Bedrock-тест: ходьба, копание, установка, крафт (2x2 и верстак), еда, броня,
// отдать игроку, сундук, бой, печь — через настоящие действия бота (runAction), как их вызывает нейросеть.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import mineflayer from 'mineflayer';
import { createBot } from '../src/minecraft/bot.js';
import { runAction } from '../src/actions/index.js';
import { RecipeDB } from '../src/knowledge/recipes.js';

const version = process.argv[2] || '1.21.4';
const root = process.env.MC_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'mcjava-'));
const port = 25599;
const results = { version };
const log = (...a) => console.log('[test]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;

function finish(code) {
  console.log(JSON.stringify(results, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
  try { server?.stdin.write('stop\n'); } catch { /* */ }
  setTimeout(() => { try { server?.kill(); } catch { /* */ } process.exit(code); }, 3000);
}
setTimeout(() => { results.error = 'сторож: тест завис дольше 12 минут'; finish(1); }, 12 * 60000);

async function download() {
  const jar = path.join(root, 'server.jar');
  if (fs.existsSync(jar)) return jar;
  const manifest = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json();
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new Error(`Mojang не знает версию ${version}`);
  const meta = await (await fetch(entry.url)).json();
  const url = meta.downloads?.server?.url;
  if (!url) throw new Error(`У ${version} нет server.jar`);
  fs.writeFileSync(jar, Buffer.from(await (await fetch(url)).arrayBuffer()));
  return jar;
}

function startServer(jar) {
  fs.writeFileSync(path.join(root, 'eula.txt'), 'eula=true\n');
  const [maj, min] = version.split('.').map(Number);
  const flat = maj === 1 && min < 19 ? 'flat' : 'minecraft\\:flat';
  fs.writeFileSync(path.join(root, 'server.properties'), [
    'online-mode=false', `server-port=${port}`, `level-type=${flat}`, 'spawn-protection=0', 'difficulty=easy',
    'gamemode=survival', 'spawn-monsters=false', 'spawn-npcs=false', 'generate-structures=false', 'view-distance=6',
    'enforce-secure-profile=false', 'max-players=5', 'allow-flight=true',
  ].join('\n'));
  server = spawn('java', ['-Xmx1500M', '-jar', jar, 'nogui'], { cwd: root });
  server.stderr.on('data', (d) => process.stderr.write(d));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('сервер не запустился за 4 минуты')), 240000);
    server.stdout.on('data', (d) => {
      const s = d.toString();
      if (process.env.SERVER_LOG) process.stdout.write(s);
      if (/Done \(/.test(s)) { clearTimeout(t); resolve(); }
    });
    server.on('exit', (c) => reject(new Error(`сервер завершился (${c})`)));
  });
}

/** Команда в консоль сервера (не от бота). */
const consoleCmd = async (cmd, wait = 400) => { server.stdin.write(`${cmd}\n`); await sleep(wait); };

function connect(name, plugins = true) {
  return new Promise((resolve, reject) => {
    const bot = plugins ? createBot({ username: name, host: '127.0.0.1', port, version, auth: 'offline' })
      : mineflayer.createBot({ username: name, host: '127.0.0.1', port, version, auth: 'offline' });
    const t = setTimeout(() => reject(new Error(`${name}: нет spawn за 60 c`)), 60000);
    bot.once('spawn', () => { clearTimeout(t); resolve(bot); });
    bot.on('kicked', (r) => log(name, 'kicked', JSON.stringify(r)));
    bot.on('error', (e) => log(name, 'error', e.message));
  });
}

const count = (bot, name) => bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);

try {
  log(`скачиваю server.jar ${version}`);
  const jar = await download();
  log('запускаю сервер');
  await startServer(jar);
  log('сервер готов');

  const alex = await connect('Alex');
  const steve = await connect('Steve', false);
  results.spawn = true;
  await sleep(2000);
  // «pal» с тем же интерфейсом, что и настоящий (действия берут из него бота, память, рецепты)
  const pal = {
    bot: alex, edition: 'java', interrupted: false, mode: null,
    get gameMode() { return alex.game?.gameMode; },
    memory: { add() {}, saveLocation() {}, getLocation() { return null; }, locations() { return []; } },
    recipes: () => (pal._r ||= new RecipeDB(alex.registry)),
    tasks: { current: () => null }, owner: () => 'Steve',
    setMode(t, p) { this.mode = { type: t, player: p }; }, stopAll() { this.mode = null; }, resumeMode() {},
    prepareForAction() { this.mode = null; alex.pathfinder?.setGoal(null); },
    log() {}, emit() {},
  };
  const J = (results.java = {});
  const act = async (name, args, key = name) => {
    const r = await runAction(pal, name, args);
    J[key] = `${r.ok ? '' : 'ОШИБКА: '}${r.result}`;
    log(name, JSON.stringify(args), '→', J[key]);
    return r;
  };

  // чат
  const heard = new Promise((r) => { steve.on('chat', (from, msg) => { if (from === 'Alex') r(msg); }); setTimeout(() => r(null), 8000); });
  alex.chat('Привет с Java!');
  results.chatReceived = await heard;

  // ходьба: Steve отходит на 10 блоков, бот идёт к нему пешком
  await consoleCmd('time set day');
  await consoleCmd('tp Steve Alex', 800);
  await consoleCmd('execute as Steve at @s run tp @s ~10 ~ ~', 1500);
  const from = alex.entity.position.clone();
  await act('go_to_player', { player: 'Steve' });
  results.walked = Math.round(alex.entity.position.distanceTo(from) * 10) / 10;
  results.distToSteve = Math.round(alex.entity.position.distanceTo(steve.entity.position) * 10) / 10;

  // копание и установка
  const dirt0 = count(alex, 'dirt');
  await act('collect_blocks', { block: 'dirt', count: 2 });
  J.dirtGot = count(alex, 'dirt') - dirt0;
  const p = alex.entity.position.floored();
  await act('place_block', { block: 'dirt', x: p.x + 2, y: p.y, z: p.z + 1 });
  J.placedBlock = alex.blockAt(p.offset(2, 0, 1))?.name;

  // крафт: доски (2x2), палки, верстак, кирка (3x3 — верстак бот поставит сам)
  await consoleCmd('give Alex oak_log 3', 1000);
  for (const [item, n] of [['oak_planks', 12], ['stick', 4], ['crafting_table', 1], ['wooden_pickaxe', 1]]) await act('craft_item', { item, count: n }, `craft ${item}`);
  J.pickaxe = count(alex, 'wooden_pickaxe');

  // еда: проголодаться эффектом и поесть
  await consoleCmd('give Alex bread 6');
  await consoleCmd('give Alex iron_helmet 1');
  await consoleCmd('give Alex cobblestone 2');
  await consoleCmd('give Alex coal 2');
  await consoleCmd('give Alex furnace 1');
  await consoleCmd('give Alex stone_sword 1', 800);
  await consoleCmd('effect give Alex hunger 30 255');
  for (let k = 0; k < 40 && alex.food > 15; k++) await sleep(500);
  await consoleCmd('effect clear Alex', 600);
  J.foodBefore = alex.food;
  await act('eat', {});
  J.foodAfter = alex.food;

  await act('equip', { item: 'iron_helmet' });
  J.helmetOn = alex.inventory.slots[5]?.name;

  // отдать игроку
  const sb0 = count(steve, 'bread');
  await act('give_items', { player: 'Steve', item: 'bread', count: 2 });
  for (let k = 0; k < 12 && count(steve, 'bread') <= sb0; k++) await sleep(500);
  J.steveGotBread = count(steve, 'bread') - sb0;

  // сундук рядом
  const q = alex.entity.position.floored();
  await consoleCmd(`setblock ${q.x - 2} ${q.y} ${q.z} chest`, 1000);
  const d1 = count(alex, 'dirt');
  await act('store_in_chest', { item: 'dirt', count: 1 });
  J.dirtStored = d1 - count(alex, 'dirt');
  await act('take_from_chest', { item: 'dirt', count: 1 });
  J.dirtBack = count(alex, 'dirt') - (d1 - J.dirtStored);

  // бой
  const r = alex.entity.position.floored();
  await consoleCmd(`summon pig ${r.x + 3} ${r.y} ${r.z + 1}`, 1500);
  await act('attack', { target: 'pig' });

  // печь
  await act('smelt_item', { item: 'cobblestone', count: 1 });
  J.stone = count(alex, 'stone');

  log('итог:', JSON.stringify(J));
  alex.quit(); steve.quit();
} catch (e) {
  results.error = e.stack || String(e);
}

const J = results.java || {};
const checks = {
  spawn: Boolean(results.spawn), chat: Boolean(results.chatReceived), walk: results.walked >= 5 && results.distToSteve <= 4,
  dig: J.dirtGot >= 1, place: J.placedBlock === 'dirt', craft: J.pickaxe >= 1, eat: J.foodAfter > J.foodBefore,
  equip: J.helmetOn === 'iron_helmet', give: J.steveGotBread >= 1, store: J.dirtStored >= 1, take: J.dirtBack >= 1,
  attack: /Победил/.test(J.attack || ''), smelt: J.stone >= 1,
};
results.checks = checks;
const ok = Object.values(checks).every(Boolean) && !results.error;
log('проверки:', JSON.stringify(checks));
log(ok ? 'ВСЁ OK' : 'ЕСТЬ ОШИБКИ');
finish(ok ? 0 : 1);
