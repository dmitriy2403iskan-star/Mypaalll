// Загрузка bedrock-protocol с чистым JS RakNet (jsp-raknet).
// Нативный raknet-native не собирается на телефонах (Termux) и без компилятора, поэтому в package.json
// он заменён заглушкой, а здесь все запросы бэкенда 'raknet-native' перенаправляются на 'jsp-raknet'.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let cached = null;

export function loadBedrockProtocol() {
  if (cached) return cached;
  const rakPath = require.resolve('bedrock-protocol/src/rak.js');
  const original = require(rakPath);
  require.cache[rakPath].exports = (backend) => original(!backend || backend === 'raknet-native' ? 'jsp-raknet' : backend);
  cached = require('bedrock-protocol');
  return cached;
}
