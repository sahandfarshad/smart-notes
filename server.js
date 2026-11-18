// Smart Notes – server (web panel + API + sync for the Android app)
import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyText, newNote, mergeNotes, listModels, testModel, encodeSyncToken, UNCATEGORIZED, DEFAULT_PROVIDERS } from './public/core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT_INTERNAL || process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- database
const db = new Database(path.join(DATA_DIR, 'notes.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT, raw TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '${UNCATEGORIZED}', subcategory TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'note',
  fields TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]', event_date TEXT,
  ai_status TEXT NOT NULL DEFAULT 'pending', ai_error TEXT, deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
// migrate v1 databases
const cols = db.prepare('PRAGMA table_info(notes)').all().map(c => c.name);
if (!cols.includes('uid')) db.exec('ALTER TABLE notes ADD COLUMN uid TEXT');
if (!cols.includes('deleted')) db.exec('ALTER TABLE notes ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
for (const r of db.prepare('SELECT id FROM notes WHERE uid IS NULL').all()) db.prepare('UPDATE notes SET uid=? WHERE id=?').run(crypto.randomUUID(), r.id);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_uid ON notes(uid)');

const getSetting = (k, def) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? JSON.parse(r.value) : def; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
if (!getSetting('providers')) {
  setSetting('providers', [{ id: 'gemini', name: 'Gemini', kind: 'gemini', ...DEFAULT_PROVIDERS.gemini, apiKey: process.env.GEMINI_API_KEY || '' }]);
  setSetting('activeProvider', 'gemini');
}
if (!getSetting('aiUpdatedAt')) setSetting('aiUpdatedAt', new Date(0).toISOString());
if (!getSetting('syncKey')) setSetting('syncKey', crypto.randomBytes(24).toString('hex'));

const toRow = n => db.prepare('SELECT * FROM notes WHERE uid=?').get(n);
const parse = r => r && ({ uid: r.uid, raw: r.raw, title: r.title, summary: r.summary, category: r.category, subcategory: r.subcategory, type: r.type,
  fields: JSON.parse(r.fields || '{}'), tags: JSON.parse(r.tags || '[]'), event_date: r.event_date, ai_status: r.ai_status, ai_error: r.ai_error,
  deleted: r.deleted ? 1 : 0, created_at: r.created_at, updated_at: r.updated_at });
const upsert = db.prepare(`INSERT INTO notes(uid,raw,title,summary,category,subcategory,type,fields,tags,event_date,ai_status,ai_error,deleted,created_at,updated_at)
  VALUES(@uid,@raw,@title,@summary,@category,@subcategory,@type,@fields,@tags,@event_date,@ai_status,@ai_error,@deleted,@created_at,@updated_at)
  ON CONFLICT(uid) DO UPDATE SET raw=excluded.raw,title=excluded.title,summary=excluded.summary,category=excluded.category,subcategory=excluded.subcategory,
  type=excluded.type,fields=excluded.fields,tags=excluded.tags,event_date=excluded.event_date,ai_status=excluded.ai_status,ai_error=excluded.ai_error,
  deleted=excluded.deleted,created_at=excluded.created_at,updated_at=excluded.updated_at`);
const s = v => (v == null ? '' : String(v));
function save(n) {
  upsert.run({ uid: s(n.uid) || crypto.randomUUID(), raw: s(n.raw), title: s(n.title), summary: s(n.summary), category: s(n.category) || UNCATEGORIZED,
    subcategory: s(n.subcategory), type: s(n.type) || 'note', fields: JSON.stringify(n.fields || {}), tags: JSON.stringify(n.tags || []),
    event_date: n.event_date || null, ai_status: s(n.ai_status) || 'done', ai_error: n.ai_error || null, deleted: n.deleted ? 1 : 0,
    created_at: s(n.created_at) || new Date().toISOString(), updated_at: s(n.updated_at) || new Date().toISOString() });
}
const allNotes = (withDeleted = false) => db.prepare(`SELECT * FROM notes ${withDeleted ? '' : 'WHERE deleted=0'} ORDER BY id DESC`).all().map(parse);
const activeProvider = () => getSetting('providers', []).find(p => p.id === getSetting('activeProvider'));
const KINDS = ['gemini', 'openai', 'anthropic'];
const cleanProvider = (p, prev) => ({ id: s(p.id) || crypto.randomUUID(), name: s(p.name) || 'AI', kind: KINDS.includes(p.kind) ? p.kind : 'openai',
  baseUrl: s(p.baseUrl), model: s(p.model), apiKey: p.apiKey ? s(p.apiKey) : (prev?.apiKey || '') });
/** AI settings incl. keys (only for the web session owner or the sync token holder) */
const getAi = () => ({ providers: getSetting('providers', []), activeProvider: getSetting('activeProvider'), updated_at: getSetting('aiUpdatedAt') });
function setAi(ai, keepOldKeys = false) {
  const old = getSetting('providers', []);
  setSetting('providers', (ai.providers || []).map(p => cleanProvider(p, keepOldKeys ? old.find(o => o.id === p.id) : null)));
  if (ai.activeProvider !== undefined) setSetting('activeProvider', s(ai.activeProvider));
  setSetting('aiUpdatedAt', s(ai.updated_at) || new Date().toISOString());
}
/** provider sent by the UI: if its key field is empty, use the saved key */
const withSavedKey = p => ({ ...cleanProvider(p || {}, getSetting('providers', []).find(o => o.id === p?.id)) });

async function classify(uid) {
  const n = parse(toRow(uid)); if (!n) return;
  try { Object.assign(n, await classifyText(activeProvider(), n.raw, allNotes())); }
  catch (e) { n.ai_status = 'error'; n.ai_error = String(e.message || e); }
  n.updated_at = new Date().toISOString(); save(n);
}

// ---------------------------------------------------------------- app
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '20mb' }));
app.use('/api', (req, res, next) => { // CORS for the Android app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const sessionToken = () => crypto.createHash('sha256').update(`smart-notes:${APP_USER}:${APP_PASSWORD}`).digest('hex');
const same = (a, b) => { const h = x => crypto.createHash('sha256').update(String(x)).digest(); return crypto.timingSafeEqual(h(a), h(b)); };
app.get('/api/info', (req, res) => res.json({ app: 'smart-notes', version: 3, auth: !!APP_PASSWORD }));
app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ token: '' });
  if (same(s(req.body?.username), APP_USER) && same(s(req.body?.password), APP_PASSWORD)) return res.json({ token: sessionToken() });
  res.status(401).json({ error: 'نام کاربری یا رمز اشتباه است' });
});
app.use('/api', (req, res, next) => {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  req.viaSync = !!t && same(t, getSetting('syncKey'));
  if (req.viaSync || !APP_PASSWORD || (t && same(t, sessionToken()))) return next();
  res.status(401).json({ error: 'auth' });
});

app.get('/api/notes', (req, res) => res.json(allNotes()));
app.post('/api/notes', async (req, res) => {
  const raw = s(req.body?.raw).trim();
  if (!raw) return res.status(400).json({ error: 'متن خالی است' });
  const n = newNote(raw); save(n); await classify(n.uid);
  res.json(parse(toRow(n.uid)));
});
app.put('/api/notes/:uid', (req, res) => {
  const n = parse(toRow(req.params.uid)); if (!n) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  for (const k of ['raw', 'title', 'summary', 'category', 'subcategory', 'fields', 'tags', 'event_date']) if (b[k] !== undefined) n[k] = b[k];
  n.updated_at = new Date().toISOString(); save(n); res.json(parse(toRow(n.uid)));
});
app.post('/api/notes/:uid/reclassify', async (req, res) => { await classify(req.params.uid); res.json(parse(toRow(req.params.uid))); });
app.delete('/api/notes/:uid', (req, res) => {
  const n = parse(toRow(req.params.uid)); if (n) { n.deleted = 1; n.updated_at = new Date().toISOString(); save(n); }
  res.json({ ok: true });
});

// ---- sync (Android app, with the sync token): notes by uid, newest updated_at wins (deletes are tombstones), AI settings newest wins
app.get('/api/sync', (req, res) => res.json({ notes: allNotes(true), ai: getAi(), server_time: new Date().toISOString() }));
app.post('/api/sync', (req, res) => {
  const incoming = Array.isArray(req.body?.notes) ? req.body.notes.filter(n => n && n.uid) : [];
  db.transaction(() => {
    const cur = new Map(allNotes(true).map(n => [n.uid, n]));
    for (const n of incoming) { const c = cur.get(n.uid); if (!c || s(n.updated_at) > s(c.updated_at)) save(n); }
    const ai = req.body?.ai;
    if (ai && Array.isArray(ai.providers) && s(ai.updated_at) > s(getAi().updated_at)) setAi(ai);
  })();
  res.json({ notes: allNotes(true), ai: getAi(), server_time: new Date().toISOString() });
});
app.get('/api/sync/token', (req, res) => {
  if (req.viaSync) return res.status(403).json({ error: 'forbidden' });
  const url = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ token: encodeSyncToken(url, getSetting('syncKey')), url });
});
app.post('/api/sync/token/regenerate', (req, res) => {
  if (req.viaSync) return res.status(403).json({ error: 'forbidden' });
  setSetting('syncKey', crypto.randomBytes(24).toString('hex')); res.json({ ok: true });
});

// ---- settings
const mask = k => (k ? k.slice(0, 4) + '••••' + k.slice(-4) : '');
app.get('/api/settings', (req, res) => res.json({
  activeProvider: getSetting('activeProvider'), auth: !!APP_PASSWORD,
  providers: getSetting('providers', []).map(p => ({ ...p, apiKey: '', apiKeyMasked: mask(p.apiKey), hasKey: !!p.apiKey })),
}));
app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  setAi({ providers: Array.isArray(b.providers) ? b.providers : getSetting('providers', []), activeProvider: b.activeProvider, updated_at: new Date().toISOString() }, true);
  res.json({ ok: true });
});
app.post('/api/ai/models', async (req, res) => {
  try { res.json({ models: await listModels(withSavedKey(req.body?.provider)) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/ai/test', async (req, res) => res.json(await testModel(withSavedKey(req.body?.provider), s(req.body?.model))));

// ---- backup: notes (+ AI settings). import mode: merge (newest wins) or replace (everything else is deleted, also on synced phones)
app.get('/api/export', (req, res) => {
  const ai = getAi();
  if (req.query.keys !== '1') ai.providers = ai.providers.map(p => ({ ...p, apiKey: '' }));
  res.json({ app: 'smart-notes', version: 3, exported_at: new Date().toISOString(), notes: allNotes(true), ai });
});
app.post('/api/import', (req, res) => {
  const b = req.body || {};
  const notes = (Array.isArray(b.notes) ? b.notes : []).filter(Boolean).map(n => ({ ...n, uid: n.uid || crypto.randomUUID() }));
  const now = new Date().toISOString();
  db.transaction(() => {
    if (b.mode === 'replace') {
      const keep = new Set(notes.map(n => n.uid));
      for (const n of allNotes(true)) if (!keep.has(n.uid) && !n.deleted) save({ ...n, deleted: 1, updated_at: now });
      notes.forEach(n => save({ ...n, updated_at: now }));
    } else mergeNotes(allNotes(true), notes).forEach(save);
    if (b.importAi && b.ai && Array.isArray(b.ai.providers)) setAi({ ...b.ai, updated_at: now }, true);
  })();
  res.json({ imported: notes.length });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Smart Notes listening on :${PORT}`));
