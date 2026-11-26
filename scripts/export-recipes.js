// Выгрузка полной базы крафтов для версии в формате спецификации.
// Использование: npm run export-recipes -- 1.21.4   →  data/recipes-export-1.21.4.json
import fs from 'node:fs';
import path from 'node:path';
import minecraftData from 'minecraft-data';
import { DATA_DIR } from '../src/config.js';
import { RecipeDB } from '../src/knowledge/recipes.js';

const version = process.argv[2] || '1.21.4';
const reg = minecraftData(version);
if (!reg) {
  console.error(`Версия ${version} не поддерживается minecraft-data. Доступны: ${minecraftData.supportedVersions.pc.slice(-15).join(', ')}`);
  process.exit(1);
}
const db = new RecipeDB(reg);
const all = db.exportAll();
const file = path.join(DATA_DIR, `recipes-export-${version}.json`);
fs.writeFileSync(file, JSON.stringify(all, null, 2));
const byCat = {};
for (const r of all) byCat[r.category] = (byCat[r.category] || 0) + 1;
console.log(`Версия ${version}: ${all.length} предметов с рецептами, ${all.reduce((s, r) => s + r.recipes.length, 0)} рецептов → ${file}`);
console.log(byCat);
