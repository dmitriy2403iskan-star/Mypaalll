import { settings } from './config.js';
import { pals } from './db.js';
import { manager } from './agent/manager.js';
import { startServer } from './server/server.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

await startServer({ port, host });
const s = settings.get();
console.log(`
  ███ MyPal — ИИ-компаньон для Minecraft
  Панель:     http://${host === '0.0.0.0' ? 'localhost' : host}:${port}
  LLM:        ${s.llm.activeProvider} (${s.llm.providers[s.llm.activeProvider]?.model || '?'})
  Minecraft:  ${s.minecraft.host}:${s.minecraft.port}
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
