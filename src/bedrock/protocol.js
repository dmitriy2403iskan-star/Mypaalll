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
  try {
    const Client = require('jsp-raknet/js/Client.js').default;
    const Req = require('jsp-raknet/js/protocol/OpenConnectionRequest1.js').default;
    if (Client.prototype.__mypalPatched) return;
    Client.prototype.sendConnectionRequest = function sendConnectionRequest() {
      this.__tries = (this.__tries || 0) + 1;
      const protocol = this.__tries % 2 === 1 ? 11 : 10;
      const packet = new Req();
      packet.mtuSize = this.mtuSize;
      packet.protocol = protocol;
      packet.encode();
      this.sendBuffer(packet.buffer);
      this.emit('connecting', { mtuSize: packet.mtuSize, protocol });
    };
    Client.prototype.__mypalPatched = true;
  } catch { /* jsp-raknet не установлен */ }
}
patchJspProtocol();

let cached = null;
export function loadBedrockProtocol() {
  if (cached) return cached;
  patchRak();
  cached = require('bedrock-protocol');
  return cached;
}
