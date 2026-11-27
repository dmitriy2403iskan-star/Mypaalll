// Существа вокруг Bedrock-бота (как bot.entities в Mineflayer): мобы, игроки, их позиции и смерть.
const EYE = 1.62;

export const HOSTILE = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'creeper', 'spider',
  'cave_spider', 'enderman', 'witch', 'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'blaze', 'ghast',
  'guardian', 'elder_guardian', 'piglin_brute', 'hoglin', 'zoglin', 'silverfish', 'endermite', 'shulker', 'warden', 'breeze', 'creaking']);
export const isHostileType = (t) => HOSTILE.has(String(t || '').replace(/^minecraft:/, ''));

export class Entities extends Map {
  constructor(body) {
    super();
    this.body = body;
    const c = body.client;
    const key = (id) => String(id);
    c.on('add_entity', (p) => {
      const id = p.runtime_id ?? p.runtime_entity_id;
      this.set(key(id), { id, type: String(p.entity_type || '').replace(/^minecraft:/, ''), position: { ...p.position }, alive: true, at: Date.now() });
    });
    c.on('add_player', (p) => {
      const id = p.runtime_id ?? p.runtime_entity_id;
      this.set(key(id), { id, type: 'player', name: p.username, position: p.position ? { x: p.position.x, y: p.position.y - EYE, z: p.position.z } : null, alive: true });
    });
    c.on('move_entity', (p) => {
      const e = this.get(key(p.runtime_entity_id));
      if (e && p.position) e.position = { x: p.position.x, y: p.position.y - (e.type === 'player' ? EYE : 0), z: p.position.z };
    });
    c.on('move_player', (p) => {
      const e = this.get(key(p.runtime_id));
      if (e && p.position) e.position = { x: p.position.x, y: p.position.y - EYE, z: p.position.z };
    });
    c.on('move_entity_delta', (p) => {
      const e = this.get(key(p.runtime_entity_id));
      if (!e || !e.position) return;
      // в старых версиях поля есть только при флагах, в 1.26+ — необязательные; значения абсолютные
      if (typeof p.x === 'number') e.position.x = p.x;
      if (typeof p.y === 'number') e.position.y = p.y - (e.type === 'player' ? EYE : 0);
      if (typeof p.z === 'number') e.position.z = p.z;
    });
    c.on('remove_entity', (p) => { this.delete(key(p.entity_id_self)); });
    c.on('entity_event', (p) => {
      const id = key(p.runtime_entity_id);
      if (p.event_id === 'death_animation') { const e = this.get(id); if (e) e.alive = false; }
      if (p.event_id === 'hurt_animation') {
        if (id === key(body.runtimeId)) body.emit('hurt');
        else { const e = this.get(id); if (e) e.hurtAt = Date.now(); }
      }
    });
  }

  /** Ближайшее живое существо, подходящее под фильтр. */
  nearest(from, test, radius = 32) {
    let best = null; let bestD = radius;
    for (const e of this.values()) {
      if (!e.alive || !e.position || !test(e)) continue;
      const d = Math.hypot(e.position.x - from.x, e.position.y - from.y, e.position.z - from.z);
      if (d < bestD) { best = e; bestD = d; }
    }
    return best;
  }

  /** Для снимка состояния: кто рядом (мобы и игроки). */
  list(from, radius = 24) {
    const out = [];
    for (const e of this.values()) {
      if (!e.alive || !e.position) continue;
      const d = Math.hypot(e.position.x - from.x, e.position.y - from.y, e.position.z - from.z);
      if (d <= radius) out.push({ name: e.name || e.type, type: e.type === 'player' ? 'player' : isHostileType(e.type) ? 'hostile' : 'mob', distance: Math.round(d * 10) / 10 });
    }
    return out.sort((a, b) => a.distance - b.distance).slice(0, 15);
  }
}
