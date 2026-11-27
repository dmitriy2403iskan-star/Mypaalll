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

const variants = {
  // поставить блок
  'place: inventory_transaction': (b, ref, d) => b.hands.useItem(d, false),
  'place: auth tx': (b, ref, d) => b.hands.useItem(d, true),
  'place: auth tx + start/stop_item_use_on': (b, ref, d, face) => {
    b.movement.blockActions.push({ action: 'start_item_use_on', position: { ...ref }, face });
    setTimeout(() => b.movement.blockActions.push({ action: 'stop_item_use_on', position: { ...ref }, face }), 100);
    b.hands.useItem(d, true);
  },
  'place: auth tx, held=air': (b, ref, d) => b.hands.useItem({ ...d }, true) || (b.movement.itemInteract && (b.movement.itemInteract.data.held_item = air)),
  'place: only block_action start_item_use_on': (b, ref, d, face) => b.movement.blockActions.push({ action: 'start_item_use_on', position: { ...ref }, face }),
  // сломать (сервер считает ломание сам)
  'dig: block_action start/continue/stop': async (b, ref, d, face, target) => {
    b.movement.blockActions.push({ action: 'start_break', position: target, face: 1 });
    for (let i = 0; i < 20; i++) { await sleep(50); b.movement.blockActions.push({ action: 'continue_break', position: target, face: 1 }); }
    b.movement.blockActions.push({ action: 'predict_break', position: target, face: 1 }, { action: 'stop_break', position: target, face: 1 });
  },
};

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
      await b.command(`gamemode creative ${nick}`, 4000); // ломание мгновенное, блок не кончится
      await b.command(`give ${nick} dirt 16`, 4000);
      const p = b.movement.position; const x = Math.floor(p.x) + 2; const y = Math.floor(p.y); const z = Math.floor(p.z);
      await b.command(`fill ${x - 1} ${y - 1} ${z - 1} ${x + 1} ${y - 1} ${z + 1} stone`, 4000);
      await b.command(`fill ${x} ${y} ${z} ${x} ${y + 2} ${z} air`, 4000);
      if (name.startsWith('dig')) await b.command(`setblock ${x} ${y} ${z} dirt`, 4000);
      await sleep(1500);
      const slot = b.inventory.findSlot('dirt', true);
      if (slot >= 0) b.inventory.select(slot);
      await sleep(400);
      const ref = { x, y: y - 1, z }; const target = { x, y, z }; const face = 1;
      b.movement.lookAt({ x: x + 0.5, y: y, z: z + 0.5 });
      await sleep(200);
      const d = { action_type: 'click_block', block_position: ref, face, click_pos: { x: 0.5, y: 1, z: 0.5 }, block_runtime_id: b.hands.runtimeIdOf(ref) };
      r.before = b.blockAt(x, y, z)?.name;
      await fn(b, ref, d, face, target);
      await sleep(2500);
      r.alive = !b.ended;
      r.after = b.blockAt(x, y, z)?.name;
      r.ok = r.alive && r.after !== r.before;
      b.quit();
    } catch (e) { r.error = e.message; }
    log(name, JSON.stringify(r));
    await sleep(1500);
  }
} catch (e) { log('ошибка', e.stack); }
console.log(JSON.stringify(report, null, 2));
try { server?.kill(); } catch { /* */ }
setTimeout(() => process.exit(0), 500);
