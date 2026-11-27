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
  const cmds = ['time set day', execAt(v, 'Steve', 'tp @s ^1 ^ ^-2'), execAt(v, 'Steve', 'fill ~3 ~ ~3 ~5 ~2 ~5 stone'),
    execAt(v, 'Steve', `setblock ~3 ~3 ~3 ${blockArg('oak_planks', v)}`), 'give "Steve" torch 4'];
  for (const cmd of cmds) {
    const r = await alex.command(cmd, 6000);
    results[`cmd: ${cmd}`] = r;
    log(cmd, '→', r.success ? 'OK' : 'FAIL', r.output);
  }
  await sleep(1000);
  results.positionAfterTp = alex.snapshot().position;
  alex.quit(); steve.quit();
} catch (e) {
  results.error = e.stack || String(e);
} finally {
  console.log(JSON.stringify(results, null, 2));
  try { server?.kill(); } catch { /* */ }
  const cmdOk = Object.entries(results).filter(([k]) => k.startsWith('cmd:')).every(([, v]) => v.success);
  const ok = results.spawn && results.chatReceived && cmdOk && !results.error;
  log(ok ? 'ВСЁ OK' : 'ЕСТЬ ОШИБКИ');
  setTimeout(() => process.exit(ok ? 0 : 1), 500);
}
