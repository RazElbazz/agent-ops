// db.mjs — the private data layer. SQLite (node:sqlite built-in, zero-dep) with WAL, so concurrent chats
// get atomic transactions and no lost-updates (the reason we moved off a JSON file). The .db file is
// gitignored: the engine is public, the data is local + private.
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const DB_PATH = join(ROOT, 'data.db')
export const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL;')
db.exec('PRAGMA busy_timeout = 4000;')

db.exec(`
CREATE TABLE IF NOT EXISTS operations (
  name TEXT PRIMARY KEY, category TEXT, summary TEXT, prompt TEXT,
  deps TEXT DEFAULT '[]', version INTEGER DEFAULT 1, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS components (
  name TEXT PRIMARY KEY, category TEXT, description TEXT, operations TEXT DEFAULT '[]', updated_at TEXT
);
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT, key TEXT, value TEXT,
  tags TEXT DEFAULT '', updated_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, owner TEXT, stream TEXT,
  priority INTEGER DEFAULT 2, status TEXT DEFAULT 'todo', deadline TEXT, due_when TEXT,
  note TEXT, dep INTEGER, created TEXT, done_on TEXT
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, component TEXT, type TEXT, data TEXT, created TEXT
);
CREATE TABLE IF NOT EXISTS actions_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, chat TEXT, action TEXT, payload TEXT, result TEXT
);
CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, chat TEXT, op TEXT, chain TEXT,
  input TEXT, output TEXT, status TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_knowledge_cat ON knowledge(category);
CREATE INDEX IF NOT EXISTS idx_records_comp ON records(component, type);
CREATE INDEX IF NOT EXISTS idx_traces_op ON traces(op);
`)

export const all = (sql, params = []) => db.prepare(sql).all(...params)
export const get = (sql, params = []) => db.prepare(sql).get(...params)
export const run = (sql, params = []) => db.prepare(sql).run(...params)
// atomic transaction wrapper (single-writer safety across chats)
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE')
  try { const r = fn(); db.exec('COMMIT'); return r }
  catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
}
export const nowISO = () => new Date().toISOString()
