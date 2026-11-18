// Smart Notes – server
// Express + SQLite (FTS5 trigram) + pluggable AI providers (Gemini / OpenAI-compatible / Anthropic-compatible)
import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- database
const db = new Database(path.join(DATA_DIR, 'notes.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'دسته‌بندی نشده',
  subcategory TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'note',
  fields TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  event_date TEXT,
  ai_status TEXT NOT NULL DEFAULT 'pending',
  ai_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_cat ON notes(category, subcategory);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, raw, summary, category, subcategory, tags, fields,
  content='notes', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, raw, summary, category, subcategory, tags, fields)
  VALUES (new.id, new.title, new.raw, new.summary, new.category, new.subcategory, new.tags, new.fields);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, raw, summary, category, subcategory, tags, fields)
  VALUES ('delete', old.id, old.title, old.raw, old.summary, old.category, old.subcategory, old.tags, old.fields);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, raw, summary, category, subcategory, tags, fields)
  VALUES ('delete', old.id, old.title, old.raw, old.summary, old.category, old.subcategory, old.tags, old.fields);
  INSERT INTO notes_fts(rowid, title, raw, summary, category, subcategory, tags, fields)
  VALUES (new.id, new.title, new.raw, new.summary, new.category, new.subcategory, new.tags, new.fields);
END;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const getSetting = (k, def) => {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
  return r ? JSON.parse(r.value) : def;
};
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(k, JSON.stringify(v));

// providers: [{id,name,kind:'gemini'|'openai'|'anthropic',baseUrl,apiKey,model}], activeProvider: id
if (!getSetting('providers')) {
  setSetting('providers', [{
    id: 'gemini', name: 'Gemini', kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: process.env.GEMINI_API_KEY || '', model: 'gemini-2.5-flash',
  }]);
  setSetting('activeProvider', 'gemini');
}

// ---------------------------------------------------------------- AI
const SYSTEM_PROMPT = `You organize a personal knowledge base. The user writes short notes in Persian or English:
dates of car maintenance, website addresses, phone numbers, passwords hints, events, ideas, purchases, etc.
Return ONLY a JSON object with these keys:
- "title": short title in the note's language (max 8 words)
- "summary": one-line summary in Persian
- "category": top-level category in Persian (e.g. "خودرو", "مخاطبین", "وب‌سایت‌ها", "رویدادها", "خرید", "سلامت", "مالی", "کار", "ایده‌ها"). REUSE an existing category when it fits.
- "subcategory": more specific Persian subcategory (e.g. "تعویض روغن"), or "" if none. Reuse existing ones when they fit.
- "type": one of note, date_log, link, contact, event, credential_hint, purchase, idea, other
- "fields": object of structured key/values extracted from the text, keys in Persian (e.g. {"تاریخ":"1403/08/20","کیلومتر":"85000"} or {"نام":"علی","تلفن":"+49..."} or {"آدرس":"https://..."}). Keep values exactly as written.
- "event_date": ISO date YYYY-MM-DD if the note refers to a specific date (convert Jalali/relative dates using today's date), else null
- "tags": 4-10 search tags, mixing Persian AND English synonyms (e.g. ["روغن","oil","ماشین","car","سرویس","service"])`;

function buildUserPrompt(raw) {
  const cats = db.prepare(`SELECT category, group_concat(DISTINCT subcategory) subs FROM notes
    WHERE ai_status='done' GROUP BY category`).all();
  const existing = cats.map(c => `${c.category}: ${(c.subs || '').split(',').filter(Boolean).join(' | ')}`).join('\n');
  const today = new Date().toISOString().slice(0, 10);
  return `Today: ${today}\nExisting categories:\n${existing || '(none yet)'}\n\nNote:\n${raw}`;
}

function extractJson(text) {
  if (!text) throw new Error('Empty AI response');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in AI response');
  return JSON.parse(m[0]);
}

async function callProvider(p, system, user) {
  if (!p) throw new Error('No active AI provider');
  if (!p.apiKey) throw new Error('API key is empty for provider ' + p.name);
  const base = (p.baseUrl || '').replace(/\/+$/, '');
  let res, body;
  if (p.kind === 'gemini') {
    res = await fetch(`${base}/models/${encodeURIComponent(p.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
    return body?.candidates?.[0]?.content?.parts?.map(x => x.text).join('') || '';
  }
  if (p.kind === 'anthropic') {
    res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: p.model, max_tokens: 1024, system, messages: [{ role: 'user', content: user }] }),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
    return (body?.content || []).map(x => x.text || '').join('');
  }
  // openai-compatible (OpenAI, OpenRouter, Groq, DeepSeek, Ollama, LM Studio, Gemini's /openai endpoint, ...)
  res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify({
      model: p.model, temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body?.choices?.[0]?.message?.content || '';
}

const activeProvider = () => {
  const id = getSetting('activeProvider');
  return getSetting('providers', []).find(p => p.id === id);
};

const s = v => (v == null ? '' : String(v));
async function classify(id) {
  const note = db.prepare('SELECT * FROM notes WHERE id=?').get(id);
  if (!note) return;
  try {
    const out = extractJson(await callProvider(activeProvider(), SYSTEM_PROMPT, buildUserPrompt(note.raw)));
    const tags = Array.isArray(out.tags) ? out.tags.map(s).filter(Boolean) : [];
    const fields = out.fields && typeof out.fields === 'object' ? out.fields : {};
    db.prepare(`UPDATE notes SET title=?, summary=?, category=?, subcategory=?, type=?, fields=?, tags=?,
      event_date=?, ai_status='done', ai_error=NULL, updated_at=datetime('now') WHERE id=?`).run(
      s(out.title).slice(0, 200) || note.raw.slice(0, 60), s(out.summary), s(out.category) || 'دسته‌بندی نشده',
      s(out.subcategory), s(out.type) || 'note', JSON.stringify(fields), JSON.stringify(tags),
      /^\d{4}-\d{2}-\d{2}$/.test(s(out.event_date)) ? out.event_date : null, id);
  } catch (e) {
    db.prepare(`UPDATE notes SET ai_status='error', ai_error=?, updated_at=datetime('now') WHERE id=?`).run(String(e.message || e), id);
  }
}

// ---------------------------------------------------------------- app
const app = express();
app.use(express.json({ limit: '5mb' }));

// optional password protection (set APP_PASSWORD env)
const tokenFor = pw => crypto.createHash('sha256').update('smart-notes:' + pw).digest('hex');
app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ token: '' });
  if (req.body?.password === APP_PASSWORD) return res.json({ token: tokenFor(APP_PASSWORD) });
  res.status(401).json({ error: 'رمز اشتباه است' });
});
app.use('/api', (req, res, next) => {
  if (!APP_PASSWORD) return next();
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const h = x => crypto.createHash('sha256').update(x).digest();
  if (t && crypto.timingSafeEqual(h(t), h(tokenFor(APP_PASSWORD)))) return next();
  res.status(401).json({ error: 'auth' });
});

const parse = n => n && ({ ...n, fields: JSON.parse(n.fields || '{}'), tags: JSON.parse(n.tags || '[]') });

app.get('/api/notes', (req, res) => {
  const { category, subcategory } = req.query;
  let sql = 'SELECT * FROM notes'; const args = [];
  if (category) { sql += ' WHERE category=?'; args.push(category); if (subcategory != null) { sql += ' AND subcategory=?'; args.push(subcategory); } }
  sql += ' ORDER BY COALESCE(event_date, created_at) DESC, id DESC';
  res.json(db.prepare(sql).all(...args).map(parse));
});

app.post('/api/notes', async (req, res) => {
  const raw = s(req.body?.raw).trim();
  if (!raw) return res.status(400).json({ error: 'متن خالی است' });
  const { lastInsertRowid: id } = db.prepare('INSERT INTO notes(raw, title) VALUES(?, ?)').run(raw, raw.slice(0, 60));
  await classify(id);
  res.json(parse(db.prepare('SELECT * FROM notes WHERE id=?').get(id)));
});

app.put('/api/notes/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM notes WHERE id=?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  db.prepare(`UPDATE notes SET raw=?, title=?, summary=?, category=?, subcategory=?, fields=?, tags=?, event_date=?,
    updated_at=datetime('now') WHERE id=?`).run(
    b.raw ?? n.raw, b.title ?? n.title, b.summary ?? n.summary, b.category ?? n.category, b.subcategory ?? n.subcategory,
    b.fields ? JSON.stringify(b.fields) : n.fields, b.tags ? JSON.stringify(b.tags) : n.tags,
    b.event_date !== undefined ? b.event_date : n.event_date, n.id);
  res.json(parse(db.prepare('SELECT * FROM notes WHERE id=?').get(n.id)));
});

app.post('/api/notes/:id/reclassify', async (req, res) => {
  await classify(Number(req.params.id));
  res.json(parse(db.prepare('SELECT * FROM notes WHERE id=?').get(req.params.id)));
});

app.delete('/api/notes/:id', (req, res) => {
  db.prepare('DELETE FROM notes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/search', (req, res) => {
  const q = s(req.query.q).trim();
  if (!q) return res.json([]);
  const words = q.split(/\s+/).filter(Boolean);
  let rows;
  if (words.every(w => [...w].length >= 3)) {
    const match = words.map(w => '"' + w.replace(/"/g, '""') + '"').join(' AND ');
    rows = db.prepare(`SELECT n.*, bm25(notes_fts, 5, 1, 2, 3, 3, 4, 1) AS rank FROM notes_fts
      JOIN notes n ON n.id = notes_fts.rowid WHERE notes_fts MATCH ? ORDER BY rank LIMIT 200`).all(match);
  } else {
    const where = words.map(() => `(title||' '||raw||' '||summary||' '||category||' '||subcategory||' '||tags||' '||fields) LIKE ?`).join(' AND ');
    rows = db.prepare(`SELECT * FROM notes WHERE ${where} ORDER BY id DESC LIMIT 200`).all(...words.map(w => `%${w}%`));
  }
  res.json(rows.map(parse));
});

app.get('/api/tree', (req, res) => {
  const rows = db.prepare(`SELECT category, subcategory, COUNT(*) c FROM notes GROUP BY category, subcategory ORDER BY category, subcategory`).all();
  const tree = {};
  for (const r of rows) {
    tree[r.category] ??= { name: r.category, count: 0, children: [] };
    tree[r.category].count += r.c;
    tree[r.category].children.push({ name: r.subcategory, count: r.c });
  }
  res.json(Object.values(tree));
});

// settings (API keys are masked on read)
const mask = k => (k ? k.slice(0, 4) + '••••' + k.slice(-4) : '');
app.get('/api/settings', (req, res) => {
  res.json({
    activeProvider: getSetting('activeProvider'),
    providers: getSetting('providers', []).map(p => ({ ...p, apiKey: '', apiKeyMasked: mask(p.apiKey), hasKey: !!p.apiKey })),
    auth: !!APP_PASSWORD,
  });
});
app.put('/api/settings', (req, res) => {
  const old = getSetting('providers', []);
  const incoming = Array.isArray(req.body?.providers) ? req.body.providers : old;
  const providers = incoming.map(p => {
    const prev = old.find(o => o.id === p.id);
    return {
      id: s(p.id) || crypto.randomUUID(), name: s(p.name) || 'AI', kind: ['gemini', 'openai', 'anthropic'].includes(p.kind) ? p.kind : 'openai',
      baseUrl: s(p.baseUrl), model: s(p.model), apiKey: p.apiKey ? s(p.apiKey) : (prev?.apiKey || ''),
    };
  });
  setSetting('providers', providers);
  if (req.body?.activeProvider) setSetting('activeProvider', s(req.body.activeProvider));
  res.json({ ok: true });
});
app.post('/api/settings/test', async (req, res) => {
  try {
    const out = await callProvider(activeProvider(), 'Reply with JSON {"ok":true}', 'ping');
    res.json({ ok: true, reply: out.slice(0, 200) });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

// backup
app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="smart-notes-backup.json"');
  res.json({ version: 1, exported_at: new Date().toISOString(), notes: db.prepare('SELECT * FROM notes').all().map(parse) });
});
app.post('/api/import', (req, res) => {
  const notes = req.body?.notes || [];
  const ins = db.prepare(`INSERT INTO notes(raw,title,summary,category,subcategory,type,fields,tags,event_date,ai_status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => { for (const n of notes) ins.run(s(n.raw), s(n.title), s(n.summary), s(n.category) || 'دسته‌بندی نشده', s(n.subcategory), s(n.type) || 'note',
    JSON.stringify(n.fields || {}), JSON.stringify(n.tags || []), n.event_date || null, n.ai_status || 'done',
    n.created_at || new Date().toISOString(), n.updated_at || new Date().toISOString()); })();
  res.json({ imported: notes.length });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Smart Notes on http://localhost:${PORT}`));
