// Зонд для новых версий Bedrock: какие варианты пакетов «поставить / сломать блок» сервер принимает,
// а на каких рвёт соединение. Каждый вариант — в новом подключении (свой ник), чтобы обрыв не мешал следующим.
// Запуск: node test/bedrock-probe.mjs 1.26.60
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BedrockBody } from '../src/bedrock/body.js';

const require = createRequire(import.meta.url);
const bds = require('minecraft-bedrock-server');
const version = process.argv[2] || '1.26.60';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdsp-'));
const port = 19150;
const log = (...a) => console.log('[probe]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { log('сторож: завис'); process.exit(1); }, 9 * 60000);

function connect(name) {
  return new Promise((resolve, reject) => {
    const b = new BedrockBody({ username: name, host: '127.0.0.1', port, auth: 'offline', version });
    const t = setTimeout(() => reject(new Error('нет spawn')), 60000);
    b.once('spawn', () => { clearTimeout(t); resolve(b); });
    b.on('error', (e) => log(name, 'error', e.message));
  });
}

const air = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } };

// известные результаты для 1.26.60 (зонд рук): auth tx — ок, start_item_use_on — обрыв, ломание block_action — ок
const planks = (b) => b.crafting.recipesFor('oak_planks').find((x) => b.crafting.plan(x, 1));
const variants = {
  'craft: grid, без results_deprecated': (b) => { b.crafting.resultsMode = 'none'; return b.crafting.craftGrid(planks(b), false); },
  'craft: grid, results_deprecated пустой': (b) => { b.crafting.resultsMode = 'empty'; return b.crafting.craftGrid(planks(b), false); },
  'craft: auto, без results, без ingredients': (b) => { b.crafting.resultsMode = 'none'; b.crafting.autoIngredientsMode = 'none'; return b.crafting.craftAuto(planks(b), 1); },
  'craft: auto, без results, с ingredients': (b) => { b.crafting.resultsMode = 'none'; return b.crafting.craftAuto(planks(b), 1); },
  'craft: grid, results полный (как раньше)': (b) => { b.crafting.resultsMode = 'full'; return b.crafting.craftGrid(planks(b), false); },
};
const r_open = () => {};

const report = {};
let server;
try {
  log(`BDS ${version}`);
  server = await bds.startServerAndWait2(version, 180000, { root, path: root, 'server-port': port, 'server-portv6': port + 1 });
  let i = 0;
  for (const [name, fn] of Object.entries(variants)) {
    const nick = `P${++i}`;
    const r = (report[name] = {});
    try {
      const b = await connect(nick);
      await sleep(2500);
      await b.command(`give ${nick} oak_log 3`, 4000);
      await sleep(1500);
      r.inv = JSON.stringify(b.inventory.summary());
      const sent = [];
      const oq = b.client.queue.bind(b.client);
      b.client.queue = (n, d) => { if (n !== 'player_auth_input') sent.push(n); return oq(n, d); };
      const out = await Promise.race([fn(b), sleep(8000).then(() => 'таймаут')]);
      await sleep(1500);
      r.sent = [...new Set(sent)].join(',');
      r.result = JSON.stringify(out, (k, x) => (typeof x === 'bigint' ? String(x) : x))?.slice(0, 300);
      r.alive = !b.ended;
      r.invAfter = JSON.stringify(b.inventory.summary());
      b.quit();
    } catch (e) { r.error = e.message; }
    log(name, JSON.stringify(r));
    await sleep(1500);
  }
} catch (e) { log('ошибка', e.stack); }
console.log(JSON.stringify(report, null, 2));
try { server?.kill(); } catch { /* */ }
setTimeout(() => process.exit(0), 500);
