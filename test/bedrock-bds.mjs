// Тест против НАСТОЯЩЕГО Bedrock Dedicated Server (скачивается с minecraft.net в CI).
// Запуск: npm i --no-save minecraft-bedrock-server && node test/bedrock-bds.mjs [версия]
// Проверяет: вход бота, позицию, чат между двумя клиентами, выполнение команд (tp, fill, give) на реальном сервере.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BedrockBody } from '../src/bedrock/body.js';
import { supportedVersions } from '../src/versions.js';

const require = createRequire(import.meta.url);
const bds = require('minecraft-bedrock-server');
const version = process.argv[2] || supportedVersions().bedrock.max;
const root = process.env.BDS_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'bds-'));
const port = 19140;
const results = { version };
const log = (...a) => console.log('[test]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round3 = (p) => (p ? { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) } : null);

function connect(name) {
  return new Promise((resolve, reject) => {
    const b = new BedrockBody({ username: name, host: '127.0.0.1', port, auth: 'offline', version });
    const t = setTimeout(() => reject(new Error(`${name}: нет spawn за 60 c`)), 60000);
    b.once('spawn', () => { clearTimeout(t); resolve(b); });
    b.on('error', (e) => log(name, 'error', e.message));
    b.on('kicked', (r) => log(name, 'kicked', r));
  });
}

let server;
try {
  log(`скачиваю и запускаю BDS ${version} в ${root}`);
  server = await bds.startServerAndWait2(version, 180000, { root, path: root, 'server-port': port, 'server-portv6': port + 1 });
  log('BDS запущен');

  const alex = await connect('Alex');
  results.spawn = true;
  results.gameMode = alex.gameMode;
  results.position = alex.snapshot().position;
  log('Alex в мире', JSON.stringify(results.position), 'режим', alex.gameMode);

  const steve = await connect('Steve');
  await sleep(1500);
  const heard = new Promise((r) => { steve.on('chat', (from, msg) => { if (from === 'Alex') r(msg); }); setTimeout(() => r(null), 8000); });
  alex.chat('Привет с Bedrock!');
  results.chatReceived = await heard;
  log('Steve услышал:', results.chatReceived);

  // строим рядом со Steve (точка появления каждый раз разная, далёкие чанки не загружены)
  const { execAt, blockArg } = await import('../src/bedrock/blocks.js');
  const v = alex.version || version;
  const cmds = ['time set day', execAt(v, 'Steve', 'tp @s ^1 ^ ^-2', 'Alex'), execAt(v, 'Steve', 'fill ~3 ~1 ~3 ~5 ~3 ~5 glass'),
    execAt(v, 'Steve', `setblock ~3 ~3 ~3 ${blockArg('oak_planks', v)}`), 'give Steve torch 4'];
  for (const cmd of cmds) {
    const r = await alex.command(cmd, 6000);
    results[`cmd: ${cmd}`] = r;
    log(cmd, '→', r.success ? 'OK' : 'FAIL', r.output);
  }
  await sleep(1000);
  results.positionAfterTp = alex.snapshot().position;

  // ---- ХОДЬБА БЕЗ КОМАНД (собственное тело) ----
  // подготовка командами: Alex рядом со Steve, затем Steve отходит на 8 блоков
  results.nativeReady = Boolean(alex.nativeReady);
  if (alex.nativeReady) {
    // площадка под ногами: тест не зависит от рельефа (холмы, овраги, вода)
    await alex.command(execAt(v, 'Steve', 'fill ~-3 ~-1 ~-3 ~12 ~-1 ~3 stone'), 6000);
    await alex.command(execAt(v, 'Steve', 'fill ~-3 ~ ~-3 ~12 ~3 ~3 air'), 6000);
    await alex.command(execAt(v, 'Steve', 'tp @s ~ ~ ~', 'Alex'), 6000);
    await alex.command(execAt(v, 'Steve', 'tp Steve ~8 ~ ~'), 6000);
    await sleep(3000); // чанки и позиции
    results.chunksLoaded = alex.world.columns.size;
    results.worldStats = alex.world.stats;
    // что бот «видит» в столбце под Steve: первые твёрдые блоки сверху вниз
    const sp = alex.findPlayer('Steve')?.position;
    if (sp) {
      const col = [];
      for (let y = Math.floor(sp.y) + 2; y >= Math.floor(sp.y) - 6; y--) { const b = alex.blockAt(sp.x, y, sp.z); col.push(`${y}:${b ? b.name : 'null'}`); }
      results.columnUnderSteve = col.join(' ');
      log('столбец под Steve:', results.columnUnderSteve);
      log('мир:', JSON.stringify(results.worldStats));
    }
    const target = alex.findPlayer('Steve')?.position;
    const from = alex.movement.position.clone();
    results.walk = { from: round3(from), target: round3(target) };
    if (target) {
      const t0 = Date.now();
      try {
        await alex.goto(target, 1.8, 25000);
        results.walk.arrived = true;
      } catch (e) { results.walk.error = e.message; }
      results.walk.seconds = (Date.now() - t0) / 1000;
      await sleep(1500);
      // главное: где Alex с точки зрения СЕРВЕРА — Steve видит его позицию из пакетов сервера
      const alexSeen = steve.findPlayer('Alex')?.position;
      const steveSelf = steve.snapshot().position;
      results.walk.alexSeenBySteve = round3(alexSeen);
      results.walk.botThinks = round3(alex.movement.position);
      results.walk.corrections = alex.movement.corrections || 0;
      results.walk.serverDistToSteve = alexSeen && steveSelf ? Math.hypot(alexSeen.x - steveSelf.x, alexSeen.z - steveSelf.z) : null;
      results.walk.walked = alexSeen ? Math.hypot(alexSeen.x - from.x, alexSeen.z - from.z) : null;
      log('ходьба:', JSON.stringify(results.walk));
    }

    // ---- РУКИ: поставить и сломать блок без команд ----
    results.hands = { serverAuthBreaking: alex.hands?.serverAuthBreaking };
    await alex.command('give Alex dirt 8', 6000); // подготовка
    await sleep(1500);
    results.hands.dirtBefore = alex.inventory.count('dirt');
    results.hands.inventory = alex.inventory.summary();
    const me = alex.movement.position;
    const spot = { x: Math.floor(me.x) + 2, y: Math.floor(me.y), z: Math.floor(me.z) };
    results.hands.spot = spot;
    results.hands.spotBefore = alex.blockAt(spot.x, spot.y, spot.z)?.name;
    results.hands.below = alex.blockAt(spot.x, spot.y - 1, spot.z)?.name;
    // что сервер отвечает на попытку поставить блок (для отладки новых версий)
    const seenAfterPlace = {};
    const skip = /move_|level_chunk|subchunk|network_chunk|set_time|update_attributes|set_entity_data|add_entity|move_entity|player_list|level_event|set_entity_motion/;
    const onPkt = (pk) => { const n = pk?.data?.name; if (n && !skip.test(n)) seenAfterPlace[n] = (seenAfterPlace[n] || 0) + 1; };
    alex.client.on('packet', onPkt);
    try { results.hands.placed = await alex.placeBlock(spot, 'dirt'); } catch (e) { results.hands.placeError = e.message; }
    alex.client.off('packet', onPkt);
    results.hands.serverReplied = seenAfterPlace;
    await sleep(500);
    results.hands.afterPlace = alex.blockAt(spot.x, spot.y, spot.z)?.name;
    try { results.hands.dug = await alex.dig(spot); } catch (e) { results.hands.digError = e.message; }
    await sleep(500);
    results.hands.afterDig = alex.blockAt(spot.x, spot.y, spot.z)?.name;
    // подобрать дроп: подойти к месту
    try { await alex.goto({ x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 }, 0.6, 8000); } catch { /* */ }
    await sleep(1500);
    results.hands.dirtAfter = alex.inventory.count('dirt');
    log('руки:', JSON.stringify(results.hands));
  }
  alex.quit(); steve.quit();
} catch (e) {
  results.error = e.stack || String(e);
} finally {
  console.log(JSON.stringify(results, null, 2));
  try { server?.kill(); } catch { /* */ }
  const cmdOk = Object.entries(results).filter(([k]) => k.startsWith('cmd:')).every(([, v]) => v.success);
  // ходьба засчитывается, если сервер видит, что бот прошёл ≥5 блоков и стоит рядом со Steve
  const walkOk = !results.nativeReady || (results.walk?.walked >= 5 && results.walk?.serverDistToSteve <= 3.5);
  results.walkOk = walkOk;
  // руки засчитываются, если СЕРВЕР подтвердил установку и ломание (мы видим его update_block)
  const handsOk = !results.nativeReady || (results.hands?.afterPlace === 'dirt' && /air/.test(results.hands?.afterDig || ''));
  results.handsOk = handsOk;
  const ok = results.spawn && results.chatReceived && cmdOk && walkOk && handsOk && !results.error;
  log(ok ? 'ВСЁ OK' : 'ЕСТЬ ОШИБКИ');
  setTimeout(() => process.exit(ok ? 0 : 1), 500);
}
