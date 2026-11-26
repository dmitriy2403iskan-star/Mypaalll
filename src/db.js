// SQLite через встроенный node:sqlite (Node >= 22.13) — без нативной сборки.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

export const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'mypal.sqlite'));

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS pals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  personality  TEXT NOT NULL DEFAULT '',
  traits       TEXT NOT NULL DEFAULT '{}',   -- JSON: humor, helpfulness, verbosity...
  provider     TEXT NOT NULL DEFAULT '',     -- пусто = глобальный activeProvider
  owner        TEXT NOT NULL DEFAULT '',     -- ник игрока-хозяина
  skin         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pal_id      INTEGER NOT NULL REFERENCES pals(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('semantic','episodic')),
  content     TEXT NOT NULL,
  importance  INTEGER NOT NULL DEFAULT 3,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pal_id      INTEGER NOT NULL REFERENCES pals(id) ON DELETE CASCADE,
  speaker     TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pal_id      INTEGER NOT NULL REFERENCES pals(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  x REAL, y REAL, z REAL,
  dimension   TEXT NOT NULL DEFAULT 'overworld',
  UNIQUE (pal_id, name)
);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pal_id      INTEGER NOT NULL REFERENCES pals(id) ON DELETE CASCADE,
  goal        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'PENDING',
  steps       TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const count = db.prepare('SELECT COUNT(*) AS n FROM pals').get().n;
if (count === 0) {
  db.prepare('INSERT INTO pals (name, personality, traits) VALUES (?, ?, ?)').run(
    'Alex',
    'Дружелюбный, спокойный и немного шутливый напарник. Говорит коротко и по делу, любит строить и исследовать.',
    JSON.stringify({ humor: 0.6, helpfulness: 1, verbosity: 0.3 }),
  );
}

export const pals = {
  list: () => db.prepare('SELECT * FROM pals ORDER BY id').all().map(parsePal),
  get: (id) => parsePal(db.prepare('SELECT * FROM pals WHERE id = ?').get(id)),
  create: ({ name, personality = '', traits = {}, provider = '', owner = '', skin = '' }) => {
    const r = db.prepare('INSERT INTO pals (name, personality, traits, provider, owner, skin) VALUES (?,?,?,?,?,?)')
      .run(name, personality, JSON.stringify(traits), provider, owner, skin);
    return pals.get(r.lastInsertRowid);
  },
  update: (id, patch) => {
    const cur = pals.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    db.prepare('UPDATE pals SET name=?, personality=?, traits=?, provider=?, owner=?, skin=? WHERE id=?')
      .run(next.name, next.personality, JSON.stringify(next.traits || {}), next.provider || '', next.owner || '', next.skin || '', id);
    return pals.get(id);
  },
  remove: (id) => db.prepare('DELETE FROM pals WHERE id = ?').run(id),
};

function parsePal(row) {
  if (!row) return null;
  return { ...row, traits: safeJson(row.traits, {}) };
}

export function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
