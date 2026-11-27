// Загрузка bedrock-protocol с чистым JS RakNet (jsp-raknet).
// Нативный raknet-native не собирается на телефонах (Termux) и без компилятора, поэтому в package.json
// он заменён заглушкой, а здесь все запросы бэкенда 'raknet-native' перенаправляются на 'jsp-raknet'.
// Заплатка ставится СРАЗУ при импорте модуля — до того, как bedrock-protocol загрузит кто-то ещё.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function patchRak() {
  let rakPath;
  try { rakPath = require.resolve('bedrock-protocol/src/rak.js'); } catch { return false; }
  const mod = require(rakPath);
  if (mod.__mypalPatched) return true;
  const patched = (backend) => mod(!backend || backend === 'raknet-native' ? 'jsp-raknet' : backend);
  patched.__mypalPatched = true;
  require.cache[rakPath].exports = patched;
  return true;
}
patchRak();

// jsp-raknet всегда шлёт RakNet-протокол 10, а Bedrock с 1.19.30 требует 11 (старые — 10).
// Чередуем 11 и 10 между попытками соединения — так подходит любой сервер 1.16 … новейший.
function patchJspProtocol() {
  // jsp-raknet ищем так же, как его находит сам bedrock-protocol (копия может лежать у него внутри)
  const places = [];
  try { places.push(createRequire(require.resolve('bedrock-protocol/src/rak.js'))); } catch { /* */ }
  places.push(require);
  for (const req of places) {
    try {
      const clientMod = req('jsp-raknet/js/Client.js');
      const Client = clientMod.Client || clientMod.default;
      const ReqMod = req('jsp-raknet/js/protocol/OpenConnectionRequest1.js');
      const Req = ReqMod.default || ReqMod;
      if (!Client || Client.prototype.__mypalPatched) continue;
      const debug = (() => { try { return req('debug')('raknet'); } catch { return () => {}; } })();
      Client.prototype.sendConnectionRequest = function sendConnectionRequest() {
        this.__tries = (this.__tries || 0) + 1;
        const protocol = this.__tries % 2 === 1 ? 11 : 10;
        debug(`[mypal] OpenConnectionRequest1: RakNet protocol ${protocol}, mtu ${this.mtuSize}`);
        const packet = new Req();
        packet.mtuSize = this.mtuSize;
        packet.protocol = protocol;
        packet.encode();
        this.sendBuffer(packet.buffer);
        this.emit('connecting', { mtuSize: packet.mtuSize, protocol });
      };
      Client.prototype.__mypalPatched = true;
    } catch { /* в этом месте jsp-raknet нет */ }
  }
}
patchJspProtocol();

let cached = null;
export function loadBedrockProtocol() {
  if (cached) return cached;
  patchRak();
  cached = require('bedrock-protocol');
  return cached;
}
