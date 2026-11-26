// Поддерживаемые версии Minecraft. Верхняя граница берётся из библиотек (обновишь npm-пакеты — расширится сама).
//   Java:    1.16.5  … последняя версия, которую знает mineflayer
//   Bedrock: 1.16.201 (самая ранняя 1.16 в bedrock-protocol; «1.16.5» у Bedrock нет) … последняя версия bedrock-protocol
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const JAVA_MIN = '1.16.5';
export const BEDROCK_MIN = '1.16.201';

export function cmpVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

let cached;
export function supportedVersions() {
  if (cached) return cached;
  const md = require('minecraft-data');
  const mfVersions = require('mineflayer/lib/version.js');
  const javaMax = mfVersions.latestSupportedVersion;
  const java = md.supportedVersions.pc.filter((v) => cmpVersion(v, JAVA_MIN) >= 0 && cmpVersion(v, javaMax) <= 0 && !/[a-z]/i.test(v));
  let bedrockMax = BEDROCK_MIN;
  let bedrock = [];
  try {
    const opts = require('bedrock-protocol/src/options.js');
    bedrock = Object.keys(opts.Versions).filter((v) => cmpVersion(v, BEDROCK_MIN) >= 0).sort(cmpVersion);
    bedrockMax = bedrock.at(-1) || opts.CURRENT_VERSION;
  } catch { /* bedrock-protocol не установлен */ }
  cached = {
    java: { min: JAVA_MIN, max: javaMax, list: java },
    bedrock: { min: BEDROCK_MIN, max: bedrockMax, list: bedrock },
    text: `Java ${JAVA_MIN} – ${javaMax}, Bedrock ${BEDROCK_MIN} – ${bedrockMax}`,
  };
  return cached;
}

/** null — версия поддерживается (или не задана), иначе — понятное объяснение. */
export function checkVersion(edition, version) {
  if (!version) return null;
  const s = supportedVersions()[edition === 'bedrock' ? 'bedrock' : 'java'];
  if (cmpVersion(version, s.min) < 0) return `Версия ${version} слишком старая: поддерживаются ${edition === 'bedrock' ? 'Bedrock' : 'Java'} ${s.min} – ${s.max}.`;
  if (cmpVersion(version, s.max) > 0) return `Версия ${version} новее, чем знает MyPal (до ${s.max}). Обнови MyPal (npm update / новый APK) или сервер на ${s.max}.`;
  if (edition === 'bedrock' && !s.list.includes(version)) return `Bedrock ${version} не найден. Поддерживаемые: ${s.list.slice(-8).join(', ')}…`;
  return null;
}
