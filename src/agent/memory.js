// Три уровня памяти:
//  - short-term: последние реплики (в оперативке + таблица conversations)
//  - episodic:   события («построили дом у реки»)
//  - semantic:   постоянные факты («база игрока у реки», «любит деревянные дома»)
// Плюс именованные локации (дом, шахта...).
import { db } from '../db.js';
import { chat } from '../llm/router.js';
import { settings } from '../config.js';

export class Memory {
  constructor(palId) {
    this.palId = palId;
    this.shortTerm = db.prepare('SELECT speaker, message FROM conversations WHERE pal_id = ? ORDER BY id DESC LIMIT 40')
      .all(palId).reverse();
    this.sinceExtract = 0;
  }

  // ---------- краткосрочная ----------
  addMessage(speaker, message) {
    this.shortTerm.push({ speaker, message });
    const max = settings.get().agent.historyLength;
    if (this.shortTerm.length > max * 2) this.shortTerm.splice(0, this.shortTerm.length - max);
    db.prepare('INSERT INTO conversations (pal_id, speaker, message) VALUES (?,?,?)').run(this.palId, speaker, message);
    this.sinceExtract++;
  }

  recent(n = settings.get().agent.historyLength) {
    return this.shortTerm.slice(-n);
  }

  // ---------- долговременная ----------
  add(kind, content, importance = 3) {
    // lower() в SQLite не знает кириллицу — сравниваем в JS
    const norm = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim();
    const dupe = this.list().find((m) => norm(m.content) === norm(content));
    if (dupe) return dupe.id;
    return db.prepare('INSERT INTO memories (pal_id, kind, content, importance) VALUES (?,?,?,?)')
      .run(this.palId, kind, content, importance).lastInsertRowid;
  }

  list(kind) {
    return kind
      ? db.prepare('SELECT * FROM memories WHERE pal_id = ? AND kind = ? ORDER BY id DESC').all(this.palId, kind)
      : db.prepare('SELECT * FROM memories WHERE pal_id = ? ORDER BY id DESC').all(this.palId);
  }

  remove(id) { db.prepare('DELETE FROM memories WHERE id = ? AND pal_id = ?').run(id, this.palId); }

  /** Релевантные воспоминания: все важные факты + совпадения по словам запроса. */
  relevant(query = '', limit = 15) {
    const all = this.list();
    const words = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 2);
    const scored = all.map((m) => {
      const text = m.content.toLowerCase();
      const hits = words.filter((w) => text.includes(w.slice(0, Math.max(4, w.length - 2)))).length;
      return { m, score: hits * 3 + m.importance + (m.kind === 'semantic' ? 1 : 0) };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.m);
  }

  // ---------- локации ----------
  saveLocation(name, pos, dimension = 'overworld') {
    db.prepare(`INSERT INTO locations (pal_id, name, x, y, z, dimension) VALUES (?,?,?,?,?,?)
      ON CONFLICT(pal_id, name) DO UPDATE SET x=excluded.x, y=excluded.y, z=excluded.z, dimension=excluded.dimension`)
      .run(this.palId, name.toLowerCase(), Math.round(pos.x), Math.round(pos.y), Math.round(pos.z), dimension);
  }

  getLocation(name) {
    return db.prepare('SELECT * FROM locations WHERE pal_id = ? AND name = ?').get(this.palId, name.toLowerCase());
  }

  locations() { return db.prepare('SELECT * FROM locations WHERE pal_id = ? ORDER BY name').all(this.palId); }
  removeLocation(name) { db.prepare('DELETE FROM locations WHERE pal_id = ? AND name = ?').run(this.palId, name.toLowerCase()); }

  /**
   * Memory Extractor: раз в несколько реплик спрашиваем LLM «что из этого стоит запомнить?».
   * Сохраняем только значимое, а не каждое сообщение.
   */
  async extract(palName, provider) {
    if (!settings.get().agent.memoryExtraction || this.sinceExtract < 6) return [];
    this.sinceExtract = 0;
    const convo = this.recent(12).map((m) => `${m.speaker}: ${m.message}`).join('\n');
    const known = this.list().slice(0, 30).map((m) => `- ${m.content}`).join('\n') || '(пусто)';
    const memProvider = settings.get().llm.memoryProvider || provider;
    const res = await chat({
      provider: memProvider,
      system: `You extract long-term memories for a Minecraft AI companion named ${palName}.
Return ONLY a JSON array (possibly empty) of objects: {"kind":"semantic"|"episodic","content":"...","importance":1-5}.
semantic = lasting facts/preferences about players, the world, plans. episodic = notable events that happened.
Skip small talk, skip anything already known, skip transient commands like "come here". Write content in the conversation's language. Max 3 items.`,
      messages: [{ role: 'user', content: `Already known:\n${known}\n\nRecent conversation:\n${convo}` }],
      maxTokens: 2048,
    });
    const match = res.text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    let items = [];
    try { items = JSON.parse(match[0]); } catch { return []; }
    const saved = [];
    for (const it of items.slice(0, 3)) {
      if (!it?.content || !['semantic', 'episodic'].includes(it.kind)) continue;
      this.add(it.kind, String(it.content).slice(0, 300), Math.min(5, Math.max(1, Number(it.importance) || 3)));
      saved.push(it);
    }
    return saved;
  }
}
