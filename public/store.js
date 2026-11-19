// Data layer. Same UI talks to either:
//  - RemoteStore: the web panel served by your server (/api)
//  - LocalStore : the Android app (offline, IndexedDB on the phone, AI called from the phone, optional sync with the server)
import { classifyText, listModels, testModel, uuid, newNote, mergeNotes, decodeSyncToken, DEFAULT_PROVIDERS } from './core.js';

// ---------------------------------------------------------------- remote (web panel)
export class RemoteStore {
  constructor() { this.kind = 'remote'; this.token = localStorage.getItem('sn_token') || ''; this.onAuth = () => {}; }
  async api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
      body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    });
    if (res.status === 401) { this.onAuth(); throw new Error('auth'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }
  async login(username, password) {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error);
    this.token = d.token; localStorage.setItem('sn_token', d.token);
  }
  logout() { localStorage.removeItem('sn_token'); this.token = ''; }
  all() { return this.api('/notes'); }
  add(raw) { return this.api('/notes', { method: 'POST', body: { raw } }); }
  update(uid, patch) { return this.api('/notes/' + uid, { method: 'PUT', body: patch }); }
  reclassify(uid) { return this.api('/notes/' + uid + '/reclassify', { method: 'POST' }); }
  remove(uid) { return this.api('/notes/' + uid, { method: 'DELETE' }); }
  getSettings() { return this.api('/settings'); }
  saveSettings(s) { return this.api('/settings', { method: 'PUT', body: s }); }
  listModels(provider) { return this.api('/ai/models', { method: 'POST', body: { provider } }).then(r => r.models); }
  testModel(provider, model) { return this.api('/ai/test', { method: 'POST', body: { provider, model } }); }
  exportAll(keys) { return this.api('/export' + (keys ? '?keys=1' : '')); }
  importAll(data, mode, importAi) { return this.api('/import', { method: 'POST', body: { ...data, mode, importAi } }); }
  syncToken() { return this.api('/sync/token'); }
  regenerateSyncToken() { return this.api('/sync/token/regenerate', { method: 'POST' }); }
}

// server replies must be JSON; an HTML page means a wrong address or an old server version
async function readJson(r, url) {
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error('پاسخ سرور نامعتبر است (' + url + '). سرور را با smartnotes › Update به نسخه ۳ به‌روز کنید'); }
}

// ---------------------------------------------------------------- local (Android, offline)
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('smart-notes', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('notes', { keyPath: 'uid' }); r.result.createObjectStore('kv'); };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
const tx = (db, store, mode, fn) => new Promise((resolve, reject) => {
  const t = db.transaction(store, mode); const out = fn(t.objectStore(store));
  t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out); t.onerror = () => reject(t.error);
});

export class LocalStore {
  constructor() { this.kind = 'local'; this.db = null; this.cache = null; }
  async init() { this.db = await idb(); this.cache = await tx(this.db, 'notes', 'readonly', s => s.getAll()); }
  async kvGet(k, def) { const v = await tx(this.db, 'kv', 'readonly', s => s.get(k)); return v === undefined ? def : v; }
  kvSet(k, v) { return tx(this.db, 'kv', 'readwrite', s => s.put(v, k)); }
  async put(n) { n = JSON.parse(JSON.stringify(n)); await tx(this.db, 'notes', 'readwrite', s => s.put(n)); const i = this.cache.findIndex(x => x.uid === n.uid); i >= 0 ? (this.cache[i] = n) : this.cache.push(n); return n; }
  async replaceAll(list) { await tx(this.db, 'notes', 'readwrite', s => { s.clear(); list.forEach(n => s.put(n)); }); this.cache = JSON.parse(JSON.stringify(list)); }

  async all() { return this.cache.filter(n => !n.deleted); }
  async provider() {
    const st = await this.getSettings(true);
    return st.providers.find(p => p.id === st.activeProvider);
  }
  async classify(n) {
    try { Object.assign(n, await classifyText(await this.provider(), n.raw, this.cache)); }
    catch (e) { n.ai_status = navigator.onLine === false ? 'pending' : 'error'; n.ai_error = String(e.message || e); }
    n.updated_at = new Date().toISOString(); return this.put(n);
  }
  async add(raw) { const n = newNote(raw); await this.put(n); return this.classify(n); }
  async update(uid, patch) { const n = this.cache.find(x => x.uid === uid); Object.assign(n, patch, { updated_at: new Date().toISOString() }); return this.put(n); }
  async reclassify(uid) { return this.classify(this.cache.find(x => x.uid === uid)); }
  async remove(uid) { return this.update(uid, { deleted: 1 }); }
  /** classify notes saved while offline */
  async retryPending() {
    let done = 0;
    for (const n of this.cache.filter(x => !x.deleted && x.ai_status !== 'done')) { await this.classify(n); if (n.ai_status === 'done') done++; }
    return done;
  }

  async getAi() {
    return {
      providers: await this.kvGet('providers', [{ id: 'gemini', name: 'Gemini', kind: 'gemini', ...DEFAULT_PROVIDERS.gemini, apiKey: '' }]),
      activeProvider: await this.kvGet('activeProvider', 'gemini'),
      updated_at: await this.kvGet('aiUpdatedAt', new Date(0).toISOString()),
    };
  }
  async setAi(ai) {
    await this.kvSet('providers', (ai.providers || []).map(p => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey || '' })));
    await this.kvSet('activeProvider', ai.activeProvider || '');
    await this.kvSet('aiUpdatedAt', ai.updated_at || new Date().toISOString());
  }
  async getSettings(withKeys = false) {
    const { providers, activeProvider } = await this.getAi();
    if (withKeys) return { providers, activeProvider };
    return { activeProvider, auth: false, providers: providers.map(p => ({ ...p, apiKey: '', hasKey: !!p.apiKey, apiKeyMasked: p.apiKey ? p.apiKey.slice(0, 4) + '••••' + p.apiKey.slice(-4) : '' })) };
  }
  async saveSettings(st) {
    const old = (await this.getAi()).providers;
    await this.setAi({ providers: st.providers.map(p => ({ ...p, apiKey: p.apiKey || old.find(o => o.id === p.id)?.apiKey || '' })),
      activeProvider: st.activeProvider, updated_at: new Date().toISOString() });
    return { ok: true };
  }
  async withKey(p) { const o = (await this.getAi()).providers.find(x => x.id === p.id); return { ...p, apiKey: p.apiKey || o?.apiKey || '' }; }
  async listModels(p) { return listModels(await this.withKey(p)); }
  async testModel(p, model) { return testModel(await this.withKey(p), model); }
  async exportAll(keys) {
    const ai = await this.getAi();
    if (!keys) ai.providers = ai.providers.map(p => ({ ...p, apiKey: '' }));
    return { app: 'smart-notes', version: 3, exported_at: new Date().toISOString(), notes: this.cache, ai };
  }
  async importAll(data, mode, importAi) {
    const now = new Date().toISOString();
    const incoming = (data.notes || []).filter(Boolean).map(n => ({ ...n, uid: n.uid || uuid() }));
    if (mode === 'replace') {
      const keep = new Set(incoming.map(n => n.uid));
      const gone = this.cache.filter(n => !keep.has(n.uid)).map(n => ({ ...n, deleted: 1, updated_at: now }));
      await this.replaceAll([...gone, ...incoming.map(n => ({ ...n, updated_at: now }))]);
    } else await this.replaceAll(mergeNotes(this.cache, incoming));
    if (importAi && data.ai?.providers) {
      const old = (await this.getAi()).providers;
      await this.setAi({ ...data.ai, providers: data.ai.providers.map(p => ({ ...p, apiKey: p.apiKey || old.find(o => o.id === p.id)?.apiKey || '' })), updated_at: now });
    }
    return { imported: incoming.length };
  }

  // ---- server connection
  async server() { const s = await this.kvGet('server', null); return s && s.url && s.key ? s : null; }
  async connect(token) {
    const { url, key } = decodeSyncToken(token);
    let r;
    try { r = await fetch(url + '/api/sync', { headers: { Authorization: 'Bearer ' + key } }); } catch { throw new Error('سرور در دسترس نیست: ' + url); }
    if (r.status === 401) throw new Error('توکن پذیرفته نشد');
    if (!r.ok) throw new Error('سرور در دسترس نیست');
    const remote = await readJson(r, url);
    // first connection: AI settings come from the server, notes of both sides are merged
    if (remote.ai?.providers) await this.setAi(remote.ai);
    await this.replaceAll(mergeNotes(this.cache, remote.notes || []));
    await this.kvSet('server', { url, key, lastSync: null });
    return { url, ...(await this.sync()) };
  }
  async disconnect() { await this.kvSet('server', null); }
  /** two-way sync: every note by uid, newest version wins (deletes too); AI settings: newest wins */
  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const srv = await this.server(); if (!srv) throw new Error('به سروری وصل نیستید');
      let r;
      try {
        r = await fetch(srv.url + '/api/sync', { method: 'POST', headers: { Authorization: 'Bearer ' + srv.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: this.cache, ai: await this.getAi() }) });
      } catch { throw new Error('سرور در دسترس نیست'); }
      if (r.status === 401) throw new Error('توکن باطل شده؛ توکن جدید را وارد کنید');
      if (!r.ok) throw new Error('همگام‌سازی ناموفق بود');
      const remote = await readJson(r, srv.url);
      await this.replaceAll(mergeNotes(this.cache, remote.notes || []));
      const mine = await this.getAi();
      if (remote.ai?.providers && String(remote.ai.updated_at) > String(mine.updated_at)) await this.setAi(remote.ai);
      srv.lastSync = new Date().toISOString(); await this.kvSet('server', srv);
      return { count: this.cache.filter(n => !n.deleted).length };
    })();
    try { return await this.syncing; } finally { this.syncing = null; }
  }
}
