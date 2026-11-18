// Data layer. Same UI talks to either:
//  - RemoteStore: the web panel served by your server (/api)
//  - LocalStore : the Android app (offline, IndexedDB on the phone, AI called from the phone, optional sync with the server)
import { classifyText, callProvider, newNote, mergeNotes, decodeSyncToken, DEFAULT_PROVIDERS } from './core.js';

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
  testAi() { return this.api('/settings/test', { method: 'POST' }); }
  exportAll() { return this.api('/export'); }
  importAll(data) { return this.api('/import', { method: 'POST', body: data }); }
  syncToken() { return this.api('/sync/token'); }
  regenerateSyncToken() { return this.api('/sync/token/regenerate', { method: 'POST' }); }
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
  t.oncomplete = () => resolve(out?.result ?? out); t.onerror = () => reject(t.error);
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

  async getSettings(withKeys = false) {
    const providers = await this.kvGet('providers', [{ id: 'gemini', name: 'Gemini', kind: 'gemini', ...DEFAULT_PROVIDERS.gemini, apiKey: '' }]);
    const activeProvider = await this.kvGet('activeProvider', 'gemini');
    if (withKeys) return { providers, activeProvider };
    return { activeProvider, auth: false, providers: providers.map(p => ({ ...p, apiKey: '', hasKey: !!p.apiKey, apiKeyMasked: p.apiKey ? p.apiKey.slice(0, 4) + '••••' + p.apiKey.slice(-4) : '' })) };
  }
  async saveSettings(st) {
    const old = (await this.getSettings(true)).providers;
    await this.kvSet('providers', st.providers.map(p => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey || old.find(o => o.id === p.id)?.apiKey || '' })));
    if (st.activeProvider) await this.kvSet('activeProvider', st.activeProvider);
    return { ok: true };
  }
  async testAi() { return { ok: true, reply: (await callProvider(await this.provider(), 'Reply with JSON {"ok":true}', 'ping')).slice(0, 200) }; }
  async exportAll() { return { version: 2, exported_at: new Date().toISOString(), notes: this.cache }; }
  async importAll(data) { await this.replaceAll(mergeNotes(this.cache, data.notes || [])); return { imported: (data.notes || []).length }; }

  // ---- server connection
  async server() { return this.kvGet('server', null); }
  async connect(token) {
    const { url, key } = decodeSyncToken(token);
    const r = await fetch(url + '/api/info'); if (!r.ok) throw new Error('سرور در دسترس نیست');
    const t = await fetch(url + '/api/sync', { headers: { Authorization: 'Bearer ' + key } });
    if (!t.ok) throw new Error('توکن پذیرفته نشد');
    await this.kvSet('server', { url, key, lastSync: null }); return { url };
  }
  async disconnect() { await this.kvSet('server', null); }
  /** mode: 'pull' (server -> phone), 'push' (phone -> server), 'merge' (two-way, newest wins) */
  async sync(mode) {
    const srv = await this.server(); if (!srv) throw new Error('به سروری وصل نیستید');
    const h = { Authorization: 'Bearer ' + srv.key, 'Content-Type': 'application/json' };
    const post = async notes => { const r = await fetch(srv.url + '/api/sync', { method: 'POST', headers: h, body: JSON.stringify({ mode: 'replace', notes }) }); if (!r.ok) throw new Error('ارسال به سرور ناموفق بود'); };
    let remote = [];
    if (mode !== 'push') { const r = await fetch(srv.url + '/api/sync', { headers: h }); if (!r.ok) throw new Error('دریافت از سرور ناموفق بود'); remote = (await r.json()).notes || []; }
    if (mode === 'pull') await this.replaceAll(remote);
    else if (mode === 'push') await post(this.cache);
    else { const merged = mergeNotes(this.cache, remote); await post(merged); await this.replaceAll(merged); }
    srv.lastSync = new Date().toISOString(); await this.kvSet('server', srv);
    return { count: this.cache.filter(n => !n.deleted).length };
  }
}
