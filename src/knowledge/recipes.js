// База крафтов в формате спецификации (см. docs/RECIPES.md):
//  - КАЖДАЯ вариация — отдельная запись (wooden_pickaxe, stone_pickaxe, ...);
//  - рецепт хранится матрицей (pattern) + номера слотов, размер сетки, 2x2 или 3x3, станция;
//  - проверка версии: предмет существует только если он есть в данных текущей версии сервера.
// Источник полноты — minecraft-data (PrismarineJS) для конкретной версии сервера.
// Плавка и smithing в minecraft-data отсутствуют — они заданы таблицами ниже.
// Свои записи (например, из твоего TXT) кладутся в data/recipes/*.json и подмешиваются поверх.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

// ---------------------------------------------------------------- плавка (output ← inputs)
const SMELTING = {
  iron_ingot: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'],
  gold_ingot: ['raw_gold', 'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  copper_ingot: ['raw_copper', 'copper_ore', 'deepslate_copper_ore'],
  netherite_scrap: ['ancient_debris'],
  glass: ['sand', 'red_sand'],
  stone: ['cobblestone'],
  smooth_stone: ['stone'],
  deepslate: ['cobbled_deepslate'],
  brick: ['clay_ball'],
  terracotta: ['clay'],
  nether_brick: ['netherrack'],
  charcoal: ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
  smooth_sandstone: ['sandstone'],
  smooth_red_sandstone: ['red_sandstone'],
  smooth_quartz: ['quartz_block'],
  cracked_stone_bricks: ['stone_bricks'],
  green_dye: ['cactus'],
  dried_kelp: ['kelp'],
  sponge: ['wet_sponge'],
  cooked_beef: ['beef'],
  cooked_porkchop: ['porkchop'],
  cooked_chicken: ['chicken'],
  cooked_mutton: ['mutton'],
  cooked_cod: ['cod'],
  cooked_salmon: ['salmon'],
  cooked_rabbit: ['rabbit'],
  baked_potato: ['potato'],
};

// ---------------------------------------------------------------- smithing (незерит)
const NETHERITE_UPGRADES = ['sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'helmet', 'chestplate', 'leggings', 'boots'];

const CATEGORY_RULES = [
  [/_(pickaxe|axe|shovel|hoe)$|^(shears|flint_and_steel|fishing_rod|brush|spyglass|compass|clock)$/, 'tools'],
  [/_(sword)$|^(bow|crossbow|arrow|shield|trident|mace)$|_arrow$/, 'combat'],
  [/_(helmet|chestplate|leggings|boots)$/, 'armor'],
  [/_door$|_trapdoor$/, 'doors'],
  [/_boat$|_raft$|minecart$|^rail$|_rail$/, 'transport'],
  [/_slab$/, 'slabs'],
  [/_stairs$/, 'stairs'],
  [/_fence$|_fence_gate$|_wall$/, 'fences_walls'],
  [/_button$|_pressure_plate$|redstone|repeater|comparator|piston|observer|dropper|dispenser|hopper|lever|^target$|daylight|tripwire/, 'redstone'],
  [/_sign$|_hanging_sign$|banner|_bed$|carpet|candle|lantern|torch|painting|item_frame|flower_pot|^campfire$|soul_campfire/, 'decor'],
  [/_wool$|_concrete_powder$|_terracotta$|_stained_glass|_dye$/, 'colors'],
  [/^(crafting_table|furnace|blast_furnace|smoker|stonecutter|grindstone|smithing_table|cartography_table|loom|lectern|composter|anvil|enchanting_table|brewing_stand|barrel|chest|ender_chest|shulker_box|fletching_table|crafter)$/, 'stations_storage'],
  [/_block$|^(bricks|stone_bricks|.*_planks)$/, 'building_blocks'],
  [/cooked_|bread|cake|cookie|pie|stew|soup|golden_apple|golden_carrot/, 'food'],
];

export function categoryOf(name) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(name)) return cat;
  return 'misc';
}

/** Сравнение версий вида "1.20.4" / "1.21". */
export function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// группы взаимозаменяемых ингредиентов — для коротких описаний ("любые доски")
const GROUPS = [
  [/_planks$/, 'любые доски (*_planks)'],
  [/^(stripped_)?[a-z_]+_(log|wood|stem|hyphae)$/, 'любые брёвна'],
  [/_wool$/, 'любая шерсть'],
];

export class RecipeDB {
  /** registry — объект minecraft-data для версии сервера (bot.registry или require('minecraft-data')(version)). */
  constructor(registry) {
    this.reg = registry;
    this.version = registry.version?.minecraftVersion || String(registry.version);
    this.custom = loadCustom();
  }

  name(id) {
    if (id === null || id === undefined) return null;
    if (typeof id === 'object') id = Array.isArray(id) ? id[0] : id.id;
    if (id === null || id === undefined || id < 0) return null;
    return this.reg.items[id]?.name ?? null;
  }

  exists(item) { return Boolean(this.reg.itemsByName[item]); }

  // ---------------------------------------------------------------- нормализация рецептов
  craftingRecipes(item) {
    const it = this.reg.itemsByName[item];
    if (!it) return [];
    return (this.reg.recipes?.[it.id] || []).map((r) => this.normalize(r, item));
  }

  normalize(r, item) {
    if (r.inShape) {
      // строки сверху вниз; null = пустая клетка
      const rows = r.inShape.map((row) => row.map((id) => this.name(id)));
      const h = rows.length; const w = Math.max(...rows.map((row) => row.length));
      const pattern = rows.map((row) => [...row, ...Array(w - row.length).fill(null)]);
      const twoByTwo = h <= 2 && w <= 2;
      // номера слотов сетки 3x3 (0..8), как в спецификации: «iron_ingot в 0,1,2; stick в 4 и 7»
      const slots = {};
      pattern.forEach((row, y) => row.forEach((n, x) => { if (n) (slots[n] ||= []).push(y * 3 + x); }));
      return {
        type: 'crafting_shaped',
        station: twoByTwo ? 'inventory' : 'crafting_table',
        grid_size: [w, h],
        allowed_grid: twoByTwo ? '2x2' : '3x3',
        also_works_in: twoByTwo ? '3x3' : null,
        requires_crafting_table: !twoByTwo,
        pattern,
        slots,
        ingredients: countList(pattern.flat().filter(Boolean)),
        output: { item, count: r.result?.count || 1 },
      };
    }
    const ings = (r.ingredients || []).map((id) => this.name(id)).filter(Boolean);
    const twoByTwo = ings.length <= 4;
    return {
      type: 'crafting_shapeless',
      station: twoByTwo ? 'inventory' : 'crafting_table',
      grid_size: null,
      allowed_grid: twoByTwo ? '2x2' : '3x3',
      also_works_in: twoByTwo ? '3x3' : null,
      requires_crafting_table: !twoByTwo,
      pattern: null,
      ingredients: countList(ings),
      output: { item, count: r.result?.count || 1 },
    };
  }

  smeltingRecipes(item) {
    return (SMELTING[item] || []).filter((i) => this.exists(i)).map((input) => ({
      type: 'smelting', station: 'furnace', ingredients: { [input]: 1 }, fuel: 'coal/charcoal/доски', output: { item, count: 1 },
    }));
  }

  smithingRecipes(item) {
    const m = item.match(/^netherite_(\w+)$/);
    if (!m || !NETHERITE_UPGRADES.includes(m[1]) || !this.exists(item)) return [];
    const base = `diamond_${m[1]}`;
    const withTemplate = this.exists('netherite_upgrade_smithing_template');
    return [{
      type: withTemplate ? 'smithing_transform' : 'smithing',
      station: 'smithing_table',
      pattern: [withTemplate ? ['netherite_upgrade_smithing_template', base, 'netherite_ingot'] : [base, 'netherite_ingot']],
      ingredients: withTemplate ? { netherite_upgrade_smithing_template: 1, [base]: 1, netherite_ingot: 1 } : { [base]: 1, netherite_ingot: 1 },
      output: { item, count: 1 },
      note: 'Не классический 3x3: улучшение на столе кузнеца. Автоматически бот это пока не делает.',
    }];
  }

  // ---------------------------------------------------------------- записи
  /** Полная запись предмета в формате спецификации. */
  record(item) {
    item = String(item).replace(/^minecraft:/, '').trim().toLowerCase();
    const customRec = this.custom.get(item);
    const exists = this.exists(item);
    const rec = {
      id: `minecraft:${item}`,
      name: this.reg.itemsByName[item]?.displayName || customRec?.name || item,
      category: customRec?.category || categoryOf(item),
      exists_in_version: exists,
      version: this.version,
      recipes: exists ? [...this.craftingRecipes(item), ...this.smeltingRecipes(item), ...this.smithingRecipes(item)] : [],
    };
    // свои записи: проверка версий introduced_in / recipe_removed_in
    if (customRec) {
      if (customRec.introduced_in) rec.introduced_in = customRec.introduced_in;
      if (customRec.introduced_in && cmpVersion(this.version, customRec.introduced_in) < 0) {
        rec.exists_in_version = false;
        rec.note = `Предмет появился в ${customRec.introduced_in}, а сервер на ${this.version}`;
      }
      for (const r of customRec.recipes || []) {
        if (r.recipe_introduced_in && cmpVersion(this.version, r.recipe_introduced_in) < 0) continue;
        if (r.recipe_removed_in && cmpVersion(this.version, r.recipe_removed_in) >= 0) continue;
        if (!rec.recipes.some((x) => sameRecipe(x, r))) rec.recipes.push({ ...r, source: 'custom' });
      }
    }
    if (!rec.recipes.length && exists) rec.obtain = this.howToObtain(item);
    return rec;
  }

  /** Все вариации семейства: "pickaxe" → wooden_pickaxe, stone_pickaxe, ... (каждая отдельно). */
  family(query) {
    const q = String(query).toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');
    const names = this.reg.itemsArray.map((i) => i.name).filter((n) => n === q || n.endsWith(`_${q}`) || n.startsWith(`${q}_`) || n.includes(q));
    return names.slice(0, 80);
  }

  /** Откуда взять предмет, если он не крафтится. */
  howToObtain(item) {
    const it = this.reg.itemsByName[item];
    if (!it) return null;
    const blocks = this.reg.blocksArray.filter((b) => b.name === item || (b.drops || []).some((d) => (typeof d === 'object' ? (d.drop?.id ?? d.drop ?? d.id) : d) === it.id));
    if (!blocks.length) return 'Не крафтится и не добывается из блока: мобы, торговля, сундуки или мир.';
    // блоки, из которых выпадает предмет (stone → cobblestone), важнее самого блока-предмета
    blocks.sort((a, b) => (a.name === item) - (b.name === item));
    const b = blocks[0];
    const tools = Object.keys(b.harvestTools || {}).map((id) => this.reg.items[id]?.name).filter(Boolean);
    const minTool = tools.find((t) => t.startsWith('wooden')) || tools.find((t) => t.startsWith('stone')) || tools.find((t) => t.startsWith('iron')) || tools[0];
    const names = blocks.slice(0, 3).map((x) => x.name).join(' / ');
    return `Добывается из блока ${names}${minTool ? ` (нужен минимум ${minTool})` : ''}.`;
  }

  // ---------------------------------------------------------------- текст для LLM
  describe(item, maxRecipes = 3) {
    const rec = this.record(item);
    if (!rec.exists_in_version) return `${rec.id}: нет в версии ${this.version}. ${rec.note || ''}`.trim();
    const lines = [`${rec.id} (${rec.name}), категория ${rec.category}`];
    if (!rec.recipes.length) { lines.push(`Не крафтится. ${rec.obtain || ''}`); return lines.join('\n'); }
    const shown = dedupeByGroups(rec.recipes).slice(0, maxRecipes);
    shown.forEach((r, i) => {
      lines.push(`Рецепт ${i + 1}: ${r.type}, станция ${r.station}${r.allowed_grid ? `, сетка ${r.allowed_grid}` : ''}${r.groupNote ? ` (${r.groupNote})` : ''}`);
      if (r.pattern) for (const row of r.pattern) lines.push(`  [${row.map((c) => c || 'EMPTY').join(', ')}]`);
      else lines.push(`  ингредиенты: ${Object.entries(r.ingredients).map(([k, v]) => `${k}×${v}`).join(' + ')}`);
      lines.push(`  → ${r.output.item} ×${r.output.count}${r.note ? `. ${r.note}` : ''}`);
    });
    if (rec.recipes.length > shown.length) lines.push(`…и ещё ${rec.recipes.length - shown.length} вариантов рецепта`);
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- дерево крафта
  /**
   * Полная цепочка: что добыть и какие шаги выполнить, с учётом инвентаря.
   * Возвращает { gather: {item: n}, steps: [{action, item, times, count, station}], notes: [] }.
   */
  craftPlan(item, count = 1, inventory = {}, opts = {}) {
    const inv = { ...inventory };
    const plan = { gather: {}, steps: [], notes: [], needsTable: false, needsFurnace: false };
    this._need(item, count, inv, plan, new Set(), 0);
    if (plan.needsTable && !opts.hasTable && !inventory.crafting_table) {
      plan.notes.push('Нужен верстак — craft_item поставит его сам (из 4 досок).');
    }
    if (plan.needsFurnace && !opts.hasFurnace && !inventory.furnace) plan.notes.push('Нужна печь (8 cobblestone) и топливо.');
    return plan;
  }

  _need(item, qty, inv, plan, visiting, depth) {
    const take = Math.min(inv[item] || 0, qty);
    if (take) { inv[item] -= take; qty -= take; }
    if (qty <= 0) return;
    if (depth > 10 || visiting.has(item)) { plan.gather[item] = (plan.gather[item] || 0) + qty; return; }

    const crafts = this.craftingRecipes(item).filter((r) => !Object.keys(r.ingredients).some((i) => i === item || visiting.has(i)));
    const smelts = this.smeltingRecipes(item);
    // для слитков и т.п. плавка из сырья естественнее, чем разбор блоков/самородков
    const isCompressedSource = (r) => Object.keys(r.ingredients).some((i) => /_block$|_nugget$/.test(i));
    // разбор блоков (raw_iron_block → raw_iron) — только если такой блок уже есть в инвентаре
    const compressed = crafts.filter(isCompressedSource).filter((r) => Object.keys(r.ingredients).every((i) => (inv[i] || 0) > 0));
    let candidates = [...crafts.filter((r) => !isCompressedSource(r)), ...smelts, ...compressed];
    if (!candidates.length) { plan.gather[item] = (plan.gather[item] || 0) + qty; return; }

    // выбираем рецепт, для которого в инвентаре уже больше всего ингредиентов
    const score = (r) => Object.entries(r.ingredients).reduce((s, [i, n]) => s + Math.min(1, (inv[i] || 0) / n), 0) / Object.keys(r.ingredients).length;
    candidates = candidates.map((r, idx) => ({ r, s: score(r) - idx * 1e-3 })).sort((a, b) => b.s - a.s).map((x) => x.r);
    const r = candidates[0];
    const per = r.output.count;
    const times = Math.ceil(qty / per);

    visiting.add(item);
    for (const [ing, n] of Object.entries(r.ingredients)) this._need(ing, n * times, inv, plan, visiting, depth + 1);
    visiting.delete(item);

    if (r.type === 'smelting') plan.needsFurnace = true;
    if (r.requires_crafting_table) plan.needsTable = true;
    plan.steps.push({ action: r.type === 'smelting' ? 'smelt' : 'craft', item, times, count: times * per, station: r.station, from: r.ingredients });
    inv[item] = (inv[item] || 0) + times * per - qty;
  }

  describePlan(item, count, inventory, opts) {
    if (!this.exists(item)) return `Предмета ${item} нет в версии ${this.version}.`;
    const p = this.craftPlan(item, count, inventory, opts);
    const lines = [`План получения ${item} ×${count}:`];
    const gather = Object.entries(p.gather);
    if (gather.length) {
      lines.push('Добыть:');
      for (const [i, n] of gather) lines.push(`  - ${i} ×${n}: ${this.howToObtain(i) || ''}`);
    } else lines.push('Всё нужное для добычи уже есть в инвентаре.');
    if (p.steps.length) {
      lines.push('Шаги:');
      p.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.action === 'smelt' ? 'smelt_item' : 'craft_item'} ${s.item} → ${s.count} (${s.station}; из ${Object.entries(s.from).map(([k, v]) => `${k}×${v}`).join(', ')} за раз ×${s.times})`));
    }
    lines.push(...p.notes);
    return lines.join('\n');
  }

  /** Полная выгрузка в формате спецификации (для проверки/ручной правки). */
  exportAll() {
    return this.reg.itemsArray.map((i) => this.record(i.name)).filter((r) => r.recipes.length);
  }
}

// ---------------------------------------------------------------- helpers
function countList(names) {
  const out = {};
  for (const n of names) out[n] = (out[n] || 0) + 1;
  return out;
}

function sameRecipe(a, b) {
  return JSON.stringify(a.pattern || a.ingredients) === JSON.stringify(b.pattern || b.ingredients);
}

function genericName(n) {
  for (const [re, label] of GROUPS) if (re.test(n)) return label;
  return n;
}

/** Схлопываем рецепты, отличающиеся только видом досок/брёвен. */
function dedupeByGroups(recipes) {
  const seen = new Map();
  for (const r of recipes) {
    const sig = r.type + JSON.stringify(r.pattern ? r.pattern.map((row) => row.map((c) => c && genericName(c))) : Object.keys(r.ingredients).map(genericName).sort());
    if (seen.has(sig)) { seen.get(sig).variants++; continue; }
    seen.set(sig, { ...r, variants: 1 });
  }
  return [...seen.values()].map((r) => (r.variants > 1 ? { ...r, groupNote: `ещё ${r.variants - 1} вариантов с другим видом дерева/материала` } : r));
}

/**
 * Свои записи из data/recipes/*.json. Формат — как в спецификации (раздел 24):
 * { "id": "minecraft:x", "introduced_in": "1.20", "recipes": [{ "type": "crafting_shaped", "station": "...",
 *   "pattern": [[...],[...],[...]], "output": {"item":"minecraft:x","count":1}, "recipe_introduced_in": "...", "recipe_removed_in": "..." }] }
 * Допускается одиночный "recipe" вместо массива "recipes" и массив записей в файле.
 */
function loadCustom() {
  const dir = path.join(DATA_DIR, 'recipes');
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const rec of Array.isArray(raw) ? raw : [raw]) {
        const id = String(rec.id || '').replace(/^minecraft:/, '');
        if (!id) continue;
        const recipes = (rec.recipes || (rec.recipe ? [rec.recipe] : [])).map((r) => {
          const strip = (v) => (typeof v === 'string' ? v.replace(/^minecraft:/, '') : v);
          const pattern = r.pattern?.map((row) => row.map(strip)) || null;
          const ingredients = r.ingredients
            ? (Array.isArray(r.ingredients) ? countList(r.ingredients.map(strip)) : Object.fromEntries(Object.entries(r.ingredients).map(([k, v]) => [strip(k), v])))
            : countList((pattern || []).flat().filter(Boolean));
          return { ...r, pattern, ingredients, output: { item: id, count: r.output?.count || 1 } };
        });
        const prev = map.get(id);
        map.set(id, { ...prev, ...rec, recipes: [...(prev?.recipes || []), ...recipes] });
      }
    } catch (e) {
      console.error(`recipes: не удалось прочитать ${f}: ${e.message}`);
    }
  }
  return map;
}
