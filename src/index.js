import { settings } from './config.js';
import { pals } from './db.js';
import { manager } from './agent/manager.js';
import os from 'node:os';
import { startServer } from './server/server.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

if (host !== '127.0.0.1' && host !== 'localhost' && !process.env.PANEL_PASSWORD) {
  console.error('\n  ⚠ Панель открыта в сеть без пароля — любой в Wi-Fi увидит твои ключи. Задай PANEL_PASSWORD=...\n');
}
await startServer({ port, host });
const s = settings.get();
const lan = host === '0.0.0.0'
  ? Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${port}`)
  : [];
const mcTarget = s.minecraft.edition === 'bedrock'
  ? `Bedrock ${s.minecraft.bedrock.realm ? `Realm «${s.minecraft.bedrock.realm}»` : `${s.minecraft.bedrock.host || s.minecraft.host}:${s.minecraft.bedrock.port}`}`
  : `Java ${s.minecraft.host}:${s.minecraft.port}`;
console.log(`
  ███ MyPal — ИИ-компаньон для Minecraft
  Панель:     http://${host === '0.0.0.0' ? 'localhost' : host}:${port}${lan.length ? `\n  С телефона: ${lan.join('  ')}` : ''}
  LLM:        ${s.llm.activeProvider} (${s.llm.providers[s.llm.activeProvider]?.model || '?'})
  Minecraft:  ${mcTarget}
  Pals:       ${pals.list().map((p) => p.name).join(', ')}
`);

// AUTOCONNECT=Alex,Zoe — подключить pal'ов сразу при старте
if (process.env.AUTOCONNECT) {
  for (const name of process.env.AUTOCONNECT.split(',')) {
    const p = pals.list().find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    if (p) manager.get(p.id).connect();
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const pal of manager.running.values()) pal.disconnect();
    setTimeout(() => process.exit(0), 300);
  });
}
