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

let cached = null;
export function loadBedrockProtocol() {
  if (cached) return cached;
  patchRak();
  cached = require('bedrock-protocol');
  return cached;
}
