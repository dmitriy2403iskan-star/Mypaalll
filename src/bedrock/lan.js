// Поиск мира Bedrock в локальной сети. Игра может не отвечать на 127.0.0.1, поэтому пробуем сразу
// указанный хост, адреса самого устройства и широковещательные адреса — кто ответит первым.
import os from 'node:os';

const ipToInt = (ip) => ip.split('.').reduce((a, p) => ((a << 8) | Number(p)) >>> 0, 0);
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

export function lanCandidates(host, interfaces) {
  let ifs = interfaces;
  if (!ifs) {
    try { ifs = os.networkInterfaces(); } catch { ifs = {}; } // на части Android список сетей недоступен
  }
  const local = Object.values(ifs).flat().filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal);
  const out = new Map();
  const add = (address, broadcast) => { if (address && !out.has(address)) out.set(address, { address, broadcast }); };
  add(host, host === '255.255.255.255');
  for (const i of local) add(i.address, false);
  for (const i of local) if (i.netmask) add(intToIp((ipToInt(i.address) | (~ipToInt(i.netmask) >>> 0)) >>> 0), true);
  add('255.255.255.255', true);
  return [...out.values()];
}

/** ping — функция из bedrock-protocol. Возвращает { host, ad } первого ответившего мира. */
export async function findLanWorld({ ping, host, port, timeout = 10_000, interfaces }) {
  const list = lanCandidates(host, interfaces);
  try {
    return await Promise.any(list.map(async (c) => {
      // на широковещательный адрес умеет слать только NetherNet
      const ad = await ping({ host: c.address, port, timeout, ...(c.broadcast ? { transport: 'nethernet' } : {}) });
      return { host: c.address, ad };
    }));
  } catch {
    throw new Error(`Мир в локальной сети не ответил. Проверены адреса: ${list.map((c) => c.address).join(', ')}`);
  }
}
