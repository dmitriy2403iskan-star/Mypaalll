// Генераторы чертежей. Чертёж = список операций в ОТНОСИТЕЛЬНЫХ координатах:
//   { x, y, z, block }        — поставить блок
//   { x, y, z, dig: true }    — выкопать (подвал, расчистка внутри)
// x — ширина (вправо), z — длина (вглубь), y — высота; y=0 — уровень пола первого этажа.

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped'];

export function doorFor(material) {
  const wood = WOODS.find((w) => material.startsWith(`${w}_`));
  return `${wood || 'oak'}_door`;
}

/**
 * Дом с опциями. Всё, что игрок может попросить словами, — отдельный параметр:
 * «дом с подвалом», «без подвала», «двухэтажный», «с окнами», «с двускатной крышей», «из камня» …
 */
export function house(o = {}) {
  const w = clamp(o.width ?? 7, 5, 21);
  const l = clamp(o.length ?? 7, 5, 21);
  const floors = clamp(o.floors ?? 1, 1, 4);
  const fh = clamp(o.floor_height ?? 4, 3, 6);          // от пола до следующего пола
  const wall = o.wall_material || 'oak_planks';
  const floorMat = o.floor_material || wall;
  const roofMat = o.roof_material || wall;
  const pillar = o.corner_material || null;            // например oak_log по углам
  const windowMat = o.window_material || 'glass_pane';
  const basement = Boolean(o.basement);
  const bDepth = clamp(o.basement_depth ?? 3, 2, 6);
  const roof = ['flat', 'gable', 'none'].includes(o.roof) ? o.roof : 'gable';
  const windows = o.windows !== false;
  const door = o.door !== false;
  const torches = o.torches !== false;
  const ladders = floors > 1 || basement;

  const ops = [];
  const set = (x, y, z, block) => ops.push({ x, y, z, block });
  const dig = (x, y, z) => ops.push({ x, y, z, dig: true });
  const edge = (x, z) => x === 0 || z === 0 || x === w - 1 || z === l - 1;
  const corner = (x, z) => (x === 0 || x === w - 1) && (z === 0 || z === l - 1);
  const ladderX = 1; const ladderZ = l - 2;               // колонна лестницы у задней левой стены
  const doorX = Math.floor(w / 2);
  const topY = floors * fh;                               // уровень потолка/крыши

  // 1. Подвал: выкапываем внутренность под домом, пол подвала — floor_material
  if (basement) {
    for (let y = -1; y >= -bDepth; y--) for (let x = 1; x < w - 1; x++) for (let z = 1; z < l - 1; z++) dig(x, y, z);
    for (let x = 1; x < w - 1; x++) for (let z = 1; z < l - 1; z++) set(x, -bDepth - 1, z, floorMat);
    if (o.basement_lined) {
      for (let y = -bDepth; y <= -1; y++) for (let x = 0; x < w; x++) for (let z = 0; z < l; z++) if (edge(x, z)) set(x, y, z, wall);
    }
  }

  // 2. Перекрытия (пол каждого этажа) с люком под лестницу
  for (let f = 0; f < floors; f++) {
    const y = f * fh;
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < l; z++) {
        const hole = ladders && x === ladderX && z === ladderZ && (f > 0 || basement);
        if (!hole) set(x, y, z, f === 0 ? floorMat : (edge(x, z) ? wall : floorMat));
      }
    }
  }

  // 3. Расчистка внутри (трава, земля, листья на месте комнат)
  for (let f = 0; f < floors; f++) {
    for (let y = f * fh + 1; y < (f + 1) * fh; y++) for (let x = 1; x < w - 1; x++) for (let z = 1; z < l - 1; z++) dig(x, y, z);
  }

  // 4. Стены, углы, окна, дверной проём
  const windowSpots = new Set();
  if (windows) {
    for (let f = 0; f < floors; f++) {
      const wy = f * fh + 2;
      for (let x = 2; x < w - 2; x += 2) { if (!(f === 0 && Math.abs(x - doorX) <= 1)) windowSpots.add(`${x},${wy},0`); windowSpots.add(`${x},${wy},${l - 1}`); }
      for (let z = 2; z < l - 2; z += 2) { windowSpots.add(`0,${wy},${z}`); windowSpots.add(`${w - 1},${wy},${z}`); }
    }
  }
  for (let y = 1; y < topY; y++) {
    if (y % fh === 0) continue; // это уровень перекрытия, он уже поставлен
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < l; z++) {
        if (!edge(x, z)) continue;
        if (door && z === 0 && x === doorX && (y === 1 || y === 2)) continue; // проём
        if (windowSpots.has(`${x},${y},${z}`)) { set(x, y, z, windowMat); continue; }
        set(x, y, z, pillar && corner(x, z) ? pillar : wall);
      }
    }
  }

  // 5. Крыша
  if (roof === 'flat') {
    for (let x = 0; x < w; x++) for (let z = 0; z < l; z++) set(x, topY, z, roofMat);
  } else if (roof === 'gable') {
    // скаты вдоль длины, коньки по оси z; на торцах — фронтоны из материала стен
    const half = Math.ceil(w / 2);
    for (let i = 0; i < half; i++) {
      const y = topY + i;
      for (let z = -1; z <= l; z++) { set(i, y, z, roofMat); if (w - 1 - i !== i) set(w - 1 - i, y, z, roofMat); }
      for (let x = i + 1; x < w - 1 - i; x++) { set(x, y, 0, wall); set(x, y, l - 1, wall); }
    }
    // потолок над последним этажом, чтобы не было дыры между скатами
    for (let x = 1; x < w - 1; x++) for (let z = 1; z < l - 1; z++) set(x, topY, z, floorMat);
  }

  // 6. Лестница (ladder) через все люки: от пола подвала до последнего этажа
  if (ladders) {
    const from = basement ? -bDepth : 1;
    const to = (floors - 1) * fh;
    for (let y = from; y <= to; y++) ops.push({ x: ladderX, y, z: ladderZ, block: 'ladder', attach: [-1, 0, 0] });
  }

  // 7. Дверь и факелы (ставятся последними)
  if (door) ops.push({ x: doorX, y: 1, z: 0, block: o.door_material || doorFor(wall), attach: [0, -1, 0] });
  if (torches) {
    for (let f = 0; f < floors; f++) {
      const y = f * fh + 1;
      ops.push({ x: w - 2, y, z: 1, block: 'torch', attach: [0, -1, 0], optional: true });
      ops.push({ x: w - 2, y, z: l - 2, block: 'torch', attach: [0, -1, 0], optional: true });
    }
    if (basement) ops.push({ x: w - 2, y: -bDepth, z: 1, block: 'torch', attach: [0, -1, 0], optional: true });
  }

  const summary = `дом ${w}x${l}, этажей ${floors}${basement ? `, подвал глубиной ${bDepth}` : ', без подвала'}, крыша ${roof}, стены ${wall}${windows ? `, окна ${windowMat}` : ''}${door ? ', дверь' : ''}`;
  return { ops: dedupe(ops).map((op) => ({ ...op, replace: true })), summary, size: { w, l, h: topY + (roof === 'gable' ? Math.ceil(w / 2) : 1) } };
}

/** Простые формы. */
export function simple(type, o = {}) {
  const w = clamp(o.width ?? 5, 1, 21); const l = clamp(o.length ?? 5, 1, 21); const h = clamp(o.height ?? 3, 1, 12);
  const m = o.material || 'cobblestone';
  const ops = [];
  const edge = (x, z) => x === 0 || z === 0 || x === w - 1 || z === l - 1;
  if (type === 'wall') for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ops.push({ x, y, z: 0, block: m });
  if (type === 'platform') for (let x = 0; x < w; x++) for (let z = 0; z < l; z++) ops.push({ x, y: -1, z, block: m });
  if (type === 'tower') for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let z = 0; z < w; z++) if (x === 0 || z === 0 || x === w - 1 || z === w - 1) ops.push({ x, y, z, block: m });
  if (type === 'box') {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let z = 0; z < l; z++) if (edge(x, z)) ops.push({ x, y, z, block: m });
    for (let x = 0; x < w; x++) for (let z = 0; z < l; z++) ops.push({ x, y: h, z, block: m });
  }
  if (type === 'pillar') for (let y = 0; y < h; y++) ops.push({ x: 0, y, z: 0, block: m });
  if (type === 'pit' || type === 'basement') for (let y = -1; y >= -h; y--) for (let x = 0; x < w; x++) for (let z = 0; z < l; z++) ops.push({ x, y, z, dig: true });
  return { ops, summary: `${type} ${w}x${l}x${h} из ${m}`, size: { w, l, h } };
}

/**
 * Свободный чертёж от ИИ: слои снизу вверх, в каждом слое строки = z, символы = x.
 *   legend: { "P": "oak_planks", "G": "glass_pane", "D": "oak_door" }
 *   '.' или ' ' — не трогать, '-' — выкопать/очистить.
 *   base_y — с какой высоты начинается первый слой (например -3 для подвала).
 */
export function custom({ layers, legend = {}, base_y = 0 }) {
  if (!Array.isArray(layers) || !layers.length) throw new Error('layers должен быть непустым массивом слоёв');
  // legend: {"P":"oak_planks"} или ["P=oak_planks", ...]
  if (Array.isArray(legend)) legend = Object.fromEntries(legend.map((e) => String(e).split(/\s*[=:]\s*/)).filter((kv) => kv.length === 2));
  const ops = [];
  let maxW = 0; let maxL = 0;
  layers.forEach((layer, i) => {
    const rows = Array.isArray(layer) ? layer : String(layer).split('\n');
    maxL = Math.max(maxL, rows.length);
    rows.forEach((row, z) => {
      maxW = Math.max(maxW, row.length);
      [...row].forEach((ch, x) => {
        if (ch === '.' || ch === ' ') return;
        if (ch === '-') { ops.push({ x, y: base_y + i, z, dig: true }); return; }
        const block = legend[ch];
        if (!block) throw new Error(`Символ "${ch}" не описан в legend`);
        const op = { x, y: base_y + i, z, block: block.replace(/^minecraft:/, '') };
        if (/door$/.test(op.block) || op.block === 'torch') op.attach = [0, -1, 0];
        ops.push(op);
      });
    });
  });
  if (ops.length > 3000) throw new Error('Слишком большой чертёж (больше 3000 блоков)');
  return { ops: dedupe(ops).map((op) => ({ ...op, replace: true })), summary: `свой чертёж ${maxW}x${maxL}, слоёв ${layers.length}`, size: { w: maxW, l: maxL, h: layers.length } };
}

/** Ведомость материалов: { block: count }. */
export function billOfMaterials(ops) {
  const bill = {};
  for (const op of ops) if (op.block && !op.optional) bill[op.block] = (bill[op.block] || 0) + 1;
  // двери: 1 предмет на 2 блока высоты, ставится одной операцией — уже учтено
  return bill;
}

function dedupe(ops) {
  // последняя операция для клетки выигрывает (дверь поверх проёма, окно поверх стены)
  const map = new Map();
  for (const op of ops) {
    const k = `${op.x},${op.y},${op.z}`;
    if (op.dig && map.has(k) && map.get(k).block) continue; // не копаем там, где уже решено ставить блок
    map.delete(k); // новая операция встаёт в конец — сохраняем порядок «сначала конструкция, потом детали»
    map.set(k, op);
  }
  return [...map.values()];
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(Number(v) || a)));
