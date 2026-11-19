// Shared core: used by the server (Node) AND the web/Android UI.
// AI prompt, AI providers, Persian/English normalization and the instant search engine.

export const UNCATEGORIZED = 'دسته‌بندی نشده';

export const DEFAULT_PROVIDERS = {
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-latest' },
};

export const SYSTEM_PROMPT = `You organize a personal knowledge base. The user writes short notes in Persian or English:
dates of car maintenance, website addresses, phone numbers, events, ideas, purchases, etc.
Return ONLY a JSON object with these keys:
- "title": short title in the note's language (max 8 words)
- "summary": one-line summary in Persian
- "category": top-level category in Persian (e.g. "خودرو", "مخاطبین", "وب‌سایت‌ها", "رویدادها", "خرید", "سلامت", "مالی", "کار", "ایده‌ها"). REUSE an existing category when it fits.
- "subcategory": more specific Persian subcategory (e.g. "تعویض روغن"), or "" if none. Reuse existing ones when they fit.
- "type": one of note, date_log, link, contact, event, credential_hint, purchase, idea, other
- "fields": object of structured key/values extracted from the text, keys in Persian (e.g. {"تاریخ":"1403/08/20","کیلومتر":"85000"} or {"نام":"علی","تلفن":"+49..."} or {"آدرس":"https://..."}). Keep values exactly as written.
- "event_date": ISO date YYYY-MM-DD if the note refers to a specific date (convert Jalali/relative dates using today's date), else null
- "tags": 4-10 search tags, mixing Persian AND English synonyms (e.g. ["روغن","oil","ماشین","car","سرویس","service"])`;

export function buildUserPrompt(raw, notes) {
  const cats = {};
  for (const n of notes) if (!n.deleted && n.ai_status === 'done') (cats[n.category] ||= new Set()).add(n.subcategory || '');
  const existing = Object.entries(cats).map(([c, subs]) => `${c}: ${[...subs].filter(Boolean).join(' | ')}`).join('\n');
  return `Today: ${new Date().toISOString().slice(0, 10)}\nExisting categories:\n${existing || '(none yet)'}\n\nNote:\n${raw}`;
}

const str = v => (v == null ? '' : String(v));

export function parseAiResult(text, raw) {
  const m = str(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in AI response');
  const out = JSON.parse(m[0]);
  const fields = {};
  if (out.fields && typeof out.fields === 'object') for (const [k, v] of Object.entries(out.fields)) fields[str(k)] = str(v);
  return {
    title: str(out.title).slice(0, 200) || raw.slice(0, 60),
    summary: str(out.summary),
    category: str(out.category) || UNCATEGORIZED,
    subcategory: str(out.subcategory),
    type: str(out.type) || 'note',
    fields,
    tags: Array.isArray(out.tags) ? out.tags.map(str).filter(Boolean) : [],
    event_date: /^\d{4}-\d{2}-\d{2}$/.test(str(out.event_date)) ? out.event_date : null,
    ai_status: 'done', ai_error: null,
  };
}

export async function callProvider(p, system, user) {
  if (!p) throw new Error('No active AI provider');
  if (!p.apiKey) throw new Error('API key is empty: ' + p.name);
  if (!p.model) throw new Error('No model selected for ' + p.name);
  const base = str(p.baseUrl).replace(/\/+$/, '');
  let res, body;
  if (p.kind === 'gemini') {
    res = await fetch(`${base}/models/${encodeURIComponent(p.model)}:generateContent?key=${encodeURIComponent(p.apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
    return (body?.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
  }
  if (p.kind === 'anthropic') {
    res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: p.model, max_tokens: 1024, system, messages: [{ role: 'user', content: user }] }),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
    return (body?.content || []).map(x => x.text || '').join('');
  }
  res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify({ model: p.model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body?.choices?.[0]?.message?.content || '';
}

/** list the models a provider offers (so the user never types a model name) */
export async function listModels(p) {
  if (!p?.apiKey) throw new Error('API key is empty');
  const base = str(p.baseUrl).replace(/\/+$/, '');
  let res, body;
  if (p.kind === 'gemini') {
    const out = []; let page = '';
    do {
      res = await fetch(`${base}/models?pageSize=1000&key=${encodeURIComponent(p.apiKey)}${page ? '&pageToken=' + encodeURIComponent(page) : ''}`);
      body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
      for (const m of body.models || []) {
        if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
        const id = str(m.name).replace(/^models\//, '');
        if (/embedding|aqa|imagen|veo|tts|image-generation|native-audio|live/i.test(id)) continue;
        out.push({ id, name: m.displayName || id, info: m.description ? str(m.description).slice(0, 120) : '' });
      }
      page = body.nextPageToken || '';
    } while (page);
    return sortModels(out);
  }
  if (p.kind === 'anthropic') {
    res = await fetch(`${base}/models?limit=1000`, { headers: { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
    return sortModels((body.data || []).map(m => ({ id: m.id, name: m.display_name || m.id, info: '' })));
  }
  res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${p.apiKey}` } });
  body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return sortModels((body.data || body.models || []).map(m => ({ id: m.id || m.name, name: m.name || m.id, info: '' }))
    .filter(m => m.id && !/embed|whisper|tts|dall-e|moderation|audio|transcribe|image/i.test(m.id)));
}
const sortModels = list => list.sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));

/** quick real test of one model: returns { ok, ms, reply | error } */
export async function testModel(p, model) {
  const t = Date.now();
  try {
    const reply = await callProvider({ ...p, model }, 'Reply with JSON {"ok":true}', 'ping');
    return { ok: true, ms: Date.now() - t, reply: str(reply).slice(0, 120) };
  } catch (e) { return { ok: false, ms: Date.now() - t, error: str(e.message || e).slice(0, 300) }; }
}

export async function classifyText(provider, raw, notes) {
  return parseAiResult(await callProvider(provider, SYSTEM_PROMPT, buildUserPrompt(raw, notes)), raw);
}

// ---------------------------------------------------------------- notes
export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
}
export function newNote(raw) {
  const now = new Date().toISOString();
  return { uid: uuid(), raw, title: raw.slice(0, 60), summary: '', category: UNCATEGORIZED, subcategory: '', type: 'note',
    fields: {}, tags: [], event_date: null, ai_status: 'pending', ai_error: null, deleted: 0, created_at: now, updated_at: now };
}
/** merge two note lists by uid, newest updated_at wins (tombstones included) */
export function mergeNotes(a, b) {
  a = a || []; b = b || [];
  const map = new Map();
  for (const n of [...a, ...b]) {
    const cur = map.get(n.uid);
    if (!cur || str(n.updated_at) > str(cur.updated_at)) map.set(n.uid, n);
  }
  return [...map.values()];
}

// ---------------------------------------------------------------- search
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹', AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export function normalize(s) {
  return str(s).toLowerCase()
    .replace(/[۰-۹]/g, d => FA_DIGITS.indexOf(d)).replace(/[٠-٩]/g, d => AR_DIGITS.indexOf(d))
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[ةۀ]/g, 'ه').replace(/[أإآ]/g, 'ا').replace(/ؤ/g, 'و')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')      // harakat, tatweel
    .replace(/[\u200c\u200d\u200e\u200f]/g, ' ')      // ZWNJ etc
    .replace(/\s+/g, ' ').trim();
}

const W = { title: 6, tags: 5, path: 4, fields: 3, raw: 2, summary: 1 };
function indexOf(n) {
  if (n._ix && n._ixAt === n.updated_at + (n.pinned ? 'p' : '')) return n._ix;
  const ix = {
    title: normalize(n.title), tags: normalize((n.tags || []).join(' ')), path: normalize(n.category + ' ' + (n.subcategory || '')),
    fields: normalize(Object.entries(n.fields || {}).map(([k, v]) => k + ' ' + v).join(' ')), raw: normalize(n.raw), summary: normalize(n.summary),
  };
  for (const f of Object.keys(W)) { ix['_' + f] = ix[f].replace(/ /g, ''); ix['t_' + f] = [...new Set(ix[f].split(' ').filter(t => t.length >= 2))]; }
  Object.defineProperty(n, '_ix', { value: ix, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(n, '_ixAt', { value: n.updated_at + (n.pinned ? 'p' : ''), writable: true, enumerable: false, configurable: true });
  return ix;
}

/** edit distance with a cap (Damerau: adjacent swap counts as one) */
function editDist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v); rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[b.length];
}
// common Persian suffixes, so "ماشینها" / "ماشین‌های" / "ماشینم" also find "ماشین"
const SUFFIX = /(هایی|های|ها|ات|ان|ترین|تر|ای|یی|ی|م|ت|ش)$/;
const stem = w => (w.length > 4 ? w.replace(SUFFIX, '') : w);

/**
 * Persian-aware instant search: every word must match somewhere; ranked by where and how well it matched.
 * Exact substring > ignoring spaces/half-spaces > word stem > small typos (1 letter, 2 for long words).
 */
export function search(notes, q, limit = 200) {
  const words = normalize(q).split(' ').filter(Boolean);
  const live = notes.filter(n => !n.deleted);
  if (!words.length) return live.slice().sort(byPinThenDate);
  const out = [];
  for (const n of live) {
    const ix = indexOf(n); let score = 0, ok = true;
    for (const w of words) {
      let best = 0;
      for (const f in W) {
        const h = ix[f]; if (!h) continue;
        const i = h.indexOf(w);
        if (i >= 0) {
          let s = W[f];
          if (i === 0 || h[i - 1] === ' ') s *= 2;                       // word start
          if (h === w || h.startsWith(w + ' ') || h.endsWith(' ' + w) || h.includes(' ' + w + ' ')) s *= 1.5; // whole word
          best = Math.max(best, s); continue;
        }
        if (best >= W[f]) continue;
        if (w.length >= 3 && ix['_' + f].includes(w)) { best = Math.max(best, W[f] * 0.9); continue; } // "روغن‌ماشین" = "روغن ماشین"
        if (w.length < 3) continue;
        const sw = stem(w), max = w.length >= 7 ? 2 : w.length >= 4 ? 1 : 0;
        for (const t of ix['t_' + f]) {
          if (stem(t) === sw || (sw.length >= 3 && t.startsWith(sw))) { best = Math.max(best, W[f] * 0.8); break; }
          if (max && editDist(w, t.slice(0, w.length + max), max) <= max) { best = Math.max(best, W[f] * 0.5); break; } // typo
        }
      }
      if (!best) { ok = false; break; }
      score += best;
    }
    if (ok) out.push([score + (n.pinned ? 0.5 : 0), n]);
  }
  out.sort((a, b) => b[0] - a[0] || byDate(a[1], b[1]));
  return out.slice(0, limit).map(x => x[1]);
}
export const byPinThenDate = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || byDate(a, b);

// ---------------------------------------------------------------- browsing helpers (tree, timeline, topic card, related, filters)
export const noteDate = n => str(n.event_date || n.created_at).slice(0, 10);

/** Jalali date parts via Intl (works in browsers, Android WebView and Node) */
const jf = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' }) : null;
export function jalali(iso) {
  const d = new Date(str(iso).slice(0, 10) + 'T12:00:00Z'); if (!jf || isNaN(d)) return null;
  const p = Object.fromEntries(jf.formatToParts(d).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day };
}
export const FA_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
export const faNum = x => String(x).replace(/\d/g, d => FA_DIGITS[d]);
export function faDate(iso) { const j = jalali(iso); return j ? faNum(`${j.y}/${String(j.m).padStart(2, '0')}/${String(j.d).padStart(2, '0')}`) : str(iso).slice(0, 10); }

/** what kind of information a note holds (for the filter chips) */
export function kindsOf(n) {
  const text = n.raw + ' ' + Object.entries(n.fields || {}).map(([k, v]) => k + ' ' + v).join(' ');
  const t = normalize(text); const k = new Set();
  if (n.type === 'link' || /https?:\/\/|www\.|\.(com|ir|org|net|de)\b/i.test(text)) k.add('link');
  if (n.type === 'contact' || /(\+|00)\d{8,}|\b0\d{9,10}\b|تلفن|موبایل|شماره/.test(t)) k.add('phone');
  if (n.type === 'purchase' || /تومان|ریال|یورو|دلار|قیمت|مبلغ|هزینه|€|\$/.test(t)) k.add('money');
  if (n.event_date) k.add('dated');
  if (n.type === 'idea') k.add('idea');
  return k;
}
export const KIND_FILTERS = { link: '🔗 لینک', phone: '📞 تماس', money: '💰 مبلغ', dated: '📅 تاریخ‌دار', idea: '💡 ایده' };
export const DATE_FILTERS = { all: 'همه زمان‌ها', d7: '۷ روز اخیر', d30: '۳۰ روز اخیر', y0: 'امسال', y1: 'پارسال' };
export function inDateRange(n, range, now = new Date()) {
  if (!range || range === 'all') return true;
  const d = noteDate(n);
  if (range === 'd7' || range === 'd30') return d >= new Date(now - (range === 'd7' ? 7 : 30) * 864e5).toISOString().slice(0, 10);
  const j = jalali(d), jy = jalali(now.toISOString())?.y; if (!j || !jy) return false;
  return j.y === (range === 'y0' ? jy : jy - 1);
}

/** category -> subcategory -> notes */
export function buildTree(notes) {
  const tree = new Map();
  for (const n of notes) {
    if (n.deleted) continue;
    const c = n.category || UNCATEGORIZED, s = n.subcategory || '';
    if (!tree.has(c)) tree.set(c, { name: c, count: 0, last: '', subs: new Map() });
    const node = tree.get(c); node.count++; if (noteDate(n) > node.last) node.last = noteDate(n);
    if (!node.subs.has(s)) node.subs.set(s, { name: s, count: 0, last: '', notes: [] });
    const sn = node.subs.get(s); sn.count++; sn.notes.push(n); if (noteDate(n) > sn.last) sn.last = noteDate(n);
  }
  const sortNodes = m => [...m.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
  return sortNodes(tree).map(c => ({ ...c, subs: sortNodes(c.subs).map(s => ({ ...s, notes: s.notes.sort(byDate) })) }));
}

/** Jalali year -> month -> notes, newest first */
export function buildTimeline(notes) {
  const years = new Map();
  for (const n of notes.filter(x => !x.deleted).sort(byDate)) {
    const j = jalali(noteDate(n)) || { y: 0, m: 0 };
    if (!years.has(j.y)) years.set(j.y, { year: j.y, count: 0, months: new Map() });
    const y = years.get(j.y); y.count++;
    if (!y.months.has(j.m)) y.months.set(j.m, { month: j.m, name: FA_MONTHS[j.m - 1] || '', notes: [] });
    y.months.get(j.m).notes.push(n);
  }
  return [...years.values()].map(y => ({ ...y, months: [...y.months.values()] }));
}

/** notes from this Jalali day (±2 days) in earlier years */
export function onThisDay(notes, now = new Date()) {
  const t = jalali(now.toISOString()); if (!t) return [];
  return notes.filter(n => { if (n.deleted) return false; const j = jalali(noteDate(n)); return j && j.y < t.y && j.m === t.m && Math.abs(j.d - t.d) <= 2; }).sort(byDate);
}

/** topic card: everything about one category (and optional subcategory) */
export function topicStats(notes, category, subcategory) {
  const list = notes.filter(n => !n.deleted && n.category === category && (!subcategory || n.subcategory === subcategory)).sort(byDate);
  const latest = {};   // field -> { value, date, uid } from the newest note that has it
  for (const n of list) for (const [k, v] of Object.entries(n.fields || {})) if (!latest[k] && str(v).trim()) latest[k] = { value: v, date: noteDate(n), uid: n.uid };
  const dates = list.map(noteDate).filter(Boolean).sort();
  const last = dates[dates.length - 1] || null;
  let every = null;  // average gap between dated entries, in days
  if (dates.length >= 3) every = Math.round((Date.parse(last) - Date.parse(dates[0])) / 864e5 / (dates.length - 1));
  return { list, latest, first: dates[0] || null, last, daysSince: last ? Math.floor((Date.now() - Date.parse(last)) / 864e5) : null, every,
    subs: [...new Set(list.map(n => n.subcategory).filter(Boolean))] };
}

/** related notes: shared category, tags and words */
export function related(notes, n, limit = 5) {
  const toks = x => new Set([...normalize([x.title, x.raw, (x.tags || []).join(' ')].join(' ')).split(' ').filter(w => w.length > 2).map(stem)]);
  const a = toks(n); const tagsA = new Set((n.tags || []).map(normalize));
  return notes.filter(x => !x.deleted && x.uid !== n.uid).map(x => {
    const b = toks(x); let common = 0; for (const w of b) if (a.has(w)) common++;
    let s = common / Math.sqrt((a.size || 1) * (b.size || 1));
    s += (x.tags || []).filter(t => tagsA.has(normalize(t))).length * 0.15;
    if (x.category === n.category) s += 0.2; if (x.subcategory && x.subcategory === n.subcategory) s += 0.3;
    return [s, x];
  }).filter(([s]) => s > 0.25).sort((p, q) => q[0] - p[0]).slice(0, limit).map(([, x]) => x);
}

export const byDate = (a, b) => str(b.event_date || b.created_at).localeCompare(str(a.event_date || a.created_at)) || str(b.created_at).localeCompare(str(a.created_at));

/** highlight query words in an already-escaped string (works on normalized-equal chars only for exact substrings) */
export function highlight(escaped, q) {
  const words = str(q).trim().split(/\s+/).filter(w => w.length > 0).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return escaped;
  return escaped.replace(new RegExp('(' + words.join('|') + ')', 'gi'), '<mark>$1</mark>');
}

/** sync token = "sn1." + base64url(JSON {u: serverUrl, k: key}) */
export function encodeSyncToken(url, key) {
  const b = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(JSON.stringify({ u: url, k: key })))) : Buffer.from(JSON.stringify({ u: url, k: key })).toString('base64');
  return 'sn1.' + b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeSyncToken(t) {
  t = str(t).trim();
  if (!t.startsWith('sn1.')) throw new Error('توکن نامعتبر است');
  let b = t.slice(4).replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '=';
  const o = JSON.parse(decodeURIComponent(escape(atob(b))));
  if (!o.u || !o.k) throw new Error('توکن نامعتبر است');
  return { url: o.u.replace(/\/+$/, ''), key: o.k };
}

/** AI settings travel between server and phone as one object; newest updated_at wins */
export const newerAi = (a, b) => (!a ? b : !b ? a : str(b.updated_at) > str(a.updated_at) ? b : a);
