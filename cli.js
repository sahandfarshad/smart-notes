// Small admin CLI used by the server manager (smartnotes menu) via `docker exec`.
//   node cli.js token [publicUrl]   -> print the Android sync token
//   node cli.js regen               -> generate a new sync key
//   node cli.js backup <file>       -> consistent SQLite backup
//   node cli.js count               -> number of notes
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import { encodeSyncToken } from './public/core.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const db = new Database(path.join(DATA_DIR, 'notes.db'));
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const get = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? JSON.parse(r.value) : null; };
const set = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'token') {
  if (!get('syncKey')) set('syncKey', crypto.randomBytes(24).toString('hex'));
  console.log(encodeSyncToken(arg || process.env.PUBLIC_URL || 'http://localhost:8080', get('syncKey')));
} else if (cmd === 'regen') {
  set('syncKey', crypto.randomBytes(24).toString('hex')); console.log('OK');
} else if (cmd === 'backup') {
  await db.backup(arg); console.log('OK');
} else if (cmd === 'count') {
  try { console.log(db.prepare('SELECT COUNT(*) c FROM notes WHERE deleted=0').get().c); } catch { console.log(0); }
} else {
  console.log('usage: node cli.js token|regen|backup <file>|count');
}
