// Урезает node_modules для APK: 800 МБ → ~100 МБ.
//  - minecraft-data: оставляем только Java ≥ 1.20.4 и Bedrock ≥ 1.21.90 (старые версии на телефоне не нужны)
//  - удаляем то, что не нужно во время работы: typescript, @types, тесты, документацию, исходные карты, нативные .node
// Использование: node scripts/prune-for-mobile.js [путь к проекту]
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const nm = path.join(root, 'node_modules');
const KEEP = { pc: '1.20.4', bedrock: '1.21.90' };

const cmp = (a, b) => {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

let freed = 0;
const size = (p) => {
  let s = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) s += size(f); else if (e.isFile()) s += fs.statSync(f).size;
  }
  return s;
};
const rm = (p) => {
  if (!fs.existsSync(p)) return;
  const st = fs.lstatSync(p);
  freed += st.isDirectory() ? size(p) : st.size;
  fs.rmSync(p, { recursive: true, force: true });
};

function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (fn(p, e) === false) continue;
    if (e.isDirectory() && fs.existsSync(p)) walk(p, fn);
  }
}

// 1. minecraft-data (может быть несколько копий)
const mdCopies = [];
walk(nm, (p, e) => {
  if (e.isDirectory() && e.name === 'minecraft-data' && fs.existsSync(path.join(p, 'minecraft-data', 'data', 'dataPaths.json'))) mdCopies.push(p);
});
for (const md of mdCopies) {
  const dataDir = path.join(md, 'minecraft-data', 'data');
  const paths = JSON.parse(fs.readFileSync(path.join(dataDir, 'dataPaths.json'), 'utf8'));
  const keep = new Set();
  for (const edition of ['pc', 'bedrock']) {
    for (const [ver, files] of Object.entries(paths[edition] || {})) {
      if (cmp(ver, KEEP[edition]) < 0) continue;
      for (const folder of Object.values(files)) keep.add(folder);
    }
  }
  for (const edition of ['pc', 'bedrock']) {
    const edDir = path.join(dataDir, edition);
    if (!fs.existsSync(edDir)) continue;
    for (const v of fs.readdirSync(edDir)) {
      if (v === 'common' || v === 'latest') continue;
      if (!keep.has(`${edition}/${v}`)) rm(path.join(edDir, v));
    }
  }
  for (const extra of ['doc', 'docs', 'test']) rm(path.join(md, 'minecraft-data', extra));
}

// 2. пакеты, не нужные во время работы
walk(nm, (p, e) => {
  if (!e.isDirectory()) return;
  if (['typescript', '@types'].includes(e.name) && path.basename(path.dirname(p)) === 'node_modules') { rm(p); return false; }
  if (['test', 'tests', '__tests__', 'docs', 'doc', 'example', 'examples', '.github', 'benchmark', 'benchmarks', 'coverage'].includes(e.name)
    && !p.includes(`${path.sep}minecraft-data${path.sep}data${path.sep}`)) { rm(p); return false; }
  return true;
});

// 3. файлы
walk(nm, (p, e) => {
  if (!e.isFile()) return;
  if (/\.(md|markdown|map|ts|tsx|flow|node)$/i.test(e.name) && !e.name.endsWith('.d.ts.keep')) rm(p);
  if (/^(CHANGELOG|HISTORY|AUTHORS|CONTRIBUTING)/i.test(e.name)) rm(p);
});

console.log(`Удалено ${(freed / 1e6).toFixed(0)} МБ. Осталось в node_modules: ${(size(nm) / 1e6).toFixed(0)} МБ`);
