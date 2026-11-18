// Smart Notes UI – identical on the web panel and in the Android app
import { search, highlight, byDate, DEFAULT_PROVIDERS, uuid } from './core.js';
import { RemoteStore, LocalStore } from './store.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hl = (s, q) => highlight(esc(s), q).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); };
const fmtDate = s => (s ? String(s).slice(0, 10) : '');

const isApp = !!window.Capacitor?.isNativePlatform?.() || (location.hostname === 'localhost' && location.protocol === 'https:' && !location.port);
const store = isApp ? new LocalStore() : new RemoteStore();
let notes = [];
let page = 'home';

// ------------------------------------------------------------ data
async function reload() {
  try { notes = (await store.all()).sort(byDate); } catch (e) { if (e.message !== 'auth') toast('خطا: ' + e.message); }
  $('#cat-list').innerHTML = [...new Set(notes.map(n => n.category))].map(c => `<option value="${esc(c)}">`).join('');
  render();
}
function render() { if (page === 'home') renderHome(); if (page === 'table') renderTable(); }

// ------------------------------------------------------------ navigation
function go(p) {
  page = p;
  $$('.page').forEach(x => x.classList.toggle('active', x.id === 'page-' + p));
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.page === p));
  if (p === 'settings') loadSettings(); else render();
  window.scrollTo(0, 0);
}
$$('#tabs button').forEach(b => b.onclick = () => go(b.dataset.page));

// ------------------------------------------------------------ page 1: add + instant search
function item(n, q) {
  const fields = Object.entries(n.fields || {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
  const warn = n.ai_status === 'error' ? `<div class="warn">⚠️ دسته‌بندی نشد: ${esc(n.ai_error)}</div>` : n.ai_status === 'pending' ? '<div class="warn">⏳ منتظر اینترنت برای دسته‌بندی</div>' : '';
  return `<div class="item" data-uid="${esc(n.uid)}">
    <div class="path">${hl(n.category, q)}${n.subcategory ? ' › ' + hl(n.subcategory, q) : ''} · ${esc(fmtDate(n.event_date || n.created_at))}</div>
    <div class="title">${hl(n.title, q)}</div>
    <div class="snip">${hl(fields || n.raw, q)}</div>
    ${q ? `<div class="tags">${(n.tags || []).map(t => `<span class="tag">${hl(t, q)}</span>`).join('')}</div>` : ''}
    ${warn}</div>`;
}
function renderHome() {
  const q = $('#q1').value;
  const res = q.trim() ? search(notes, q, 100) : notes.slice(0, 15);
  $('#count1').textContent = q.trim() ? `${res.length} نتیجه` : (notes.length ? 'آخرین‌ها' : 'هنوز چیزی ثبت نشده. اولین یادداشتت رو بنویس 👆');
  $('#results1').innerHTML = res.map(n => item(n, q)).join('');
  $$('#results1 .item').forEach(el => el.onclick = e => { if (e.target.tagName !== 'A') openEditor(el.dataset.uid); });
}
$('#q1').addEventListener('input', renderHome);
const grow = () => { const t = $('#raw'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 220) + 'px'; };
$('#raw').addEventListener('input', grow);
async function save() {
  const raw = $('#raw').value.trim(); if (!raw) return $('#raw').focus();
  const btn = $('#save'); btn.disabled = true; btn.textContent = '⏳';
  try {
    const n = await store.add(raw);
    $('#raw').value = ''; grow();
    toast(n.ai_status === 'done' ? `✅ ${n.category}${n.subcategory ? ' › ' + n.subcategory : ''}` : '✅ ذخیره شد (بدون دسته‌بندی)');
    await reload(); autoSync();
  } catch (e) { if (e.message !== 'auth') toast('خطا: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'ثبت'; }
}
$('#save').onclick = save;
$('#raw').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); });

// ------------------------------------------------------------ page 2: search + table
let cat = null, sub = null;
function renderTable() {
  const q = $('#q2').value;
  const found = q.trim() ? search(notes, q, 5000) : notes;
  const cats = {};
  for (const n of found) { (cats[n.category] ||= { c: 0, subs: {} }).c++; if (n.subcategory) cats[n.category].subs[n.subcategory] = (cats[n.category].subs[n.subcategory] || 0) + 1; }
  if (cat && !cats[cat]) { cat = null; sub = null; }
  $('#chips').innerHTML = `<button data-c="" class="${!cat ? 'active' : ''}">همه (${found.length})</button>` +
    Object.entries(cats).sort((a, b) => b[1].c - a[1].c).map(([c, v]) => `<button data-c="${esc(c)}" class="${cat === c ? 'active' : ''}">${esc(c)} (${v.c})</button>`).join('');
  const subs = cat ? Object.entries(cats[cat].subs) : [];
  $('#subchips').innerHTML = subs.length ? `<button data-s="" class="${!sub ? 'active' : ''}">همه</button>` + subs.map(([s, c]) => `<button data-s="${esc(s)}" class="${sub === s ? 'active' : ''}">${esc(s)} (${c})</button>`).join('') : '';
  $$('#chips button').forEach(b => b.onclick = () => { cat = b.dataset.c || null; sub = null; renderTable(); });
  $$('#subchips button').forEach(b => b.onclick = () => { sub = b.dataset.s || null; renderTable(); });

  const rows = found.filter(n => (!cat || n.category === cat) && (!sub || n.subcategory === sub));
  $('#count2').textContent = `${rows.length} مورد`;
  const fieldCols = cat ? [...new Set(rows.flatMap(n => Object.keys(n.fields || {})))].slice(0, 6) : [];
  const head = `<tr><th>عنوان</th>${cat ? '' : '<th>دسته</th>'}${fieldCols.length ? fieldCols.map(c => `<th>${esc(c)}</th>`).join('') : '<th>جزئیات</th>'}<th>تاریخ</th></tr>`;
  const body = rows.map(n => `<tr data-uid="${esc(n.uid)}"><td>${hl(n.title, q)}</td>
    ${cat ? '' : `<td class="nowrap">${hl(n.category, q)}${n.subcategory ? ' › ' + hl(n.subcategory, q) : ''}</td>`}
    ${fieldCols.length ? fieldCols.map(c => `<td>${hl(n.fields?.[c] ?? '', q)}</td>`).join('') : `<td>${hl(Object.entries(n.fields || {}).map(([k, v]) => k + ': ' + v).join(' · ') || n.raw, q)}</td>`}
    <td class="nowrap">${esc(fmtDate(n.event_date || n.created_at))}</td></tr>`).join('');
  $('#table').innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
  $$('#table tbody tr').forEach(tr => tr.onclick = e => { if (e.target.tagName !== 'A') openEditor(tr.dataset.uid); });
}
$('#q2').addEventListener('input', renderTable);

// ------------------------------------------------------------ editor
let editing = null;
function openEditor(uid) {
  editing = notes.find(n => n.uid === uid); if (!editing) return;
  const f = $('#edit-form');
  f.raw.value = editing.raw; f.title.value = editing.title; f.category.value = editing.category; f.subcategory.value = editing.subcategory || '';
  f.event_date.value = editing.event_date || ''; f.tags.value = (editing.tags || []).join(', ');
  f.fields.value = Object.entries(editing.fields || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  $('#editor').showModal();
}
$('#editor').addEventListener('close', async () => {
  const action = $('#editor').returnValue, f = $('#edit-form'), n = editing; editing = null;
  if (!n) return;
  try {
    if (action === 'save') {
      const fields = {}; f.fields.value.split('\n').forEach(l => { const i = l.indexOf(':'); if (i > 0) fields[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
      await store.update(n.uid, { raw: f.raw.value, title: f.title.value, category: f.category.value, subcategory: f.subcategory.value,
        event_date: f.event_date.value || null, tags: f.tags.value.split(/[,،]/).map(s => s.trim()).filter(Boolean), fields });
      toast('ذخیره شد');
    } else if (action === 'ai') {
      if (f.raw.value !== n.raw) await store.update(n.uid, { raw: f.raw.value });
      toast('🤖 …'); const r = await store.reclassify(n.uid); toast(r.ai_status === 'done' ? `✅ ${r.category}` : '⚠️ ' + (r.ai_error || ''));
    } else if (action === 'copy') {
      await navigator.clipboard.writeText(n.raw).then(() => toast('کپی شد'), () => toast('کپی نشد'));
      return;
    } else if (action === 'delete') {
      if (!confirm('حذف شود؟')) return;
      await store.remove(n.uid); toast('حذف شد');
    } else return;
    await reload(); autoSync();
  } catch (e) { toast('خطا: ' + e.message); }
});

// ------------------------------------------------------------ settings
let settings = { providers: [] };
const modelState = {}; // providerId -> { list, filter, onlyOk, tests: { model: {status, ms, error} } }
async function loadSettings() {
  try { settings = await store.getSettings(); } catch { return; }
  renderProviders();
  $('#logout').hidden = !settings.auth;
  $('#version').textContent = (isApp ? 'اپ اندروید' : 'پنل وب') + ' · Smart Notes v3';
  if (!isApp) {
    $('#server-web').hidden = false;
    store.syncToken().then(r => $('#sync-token').value = r.token).catch(() => {});
  } else {
    $('#server-app').hidden = false;
    const srv = await store.server();
    $('#server-off').hidden = !!srv; $('#server-on').hidden = !srv;
    if (srv) { $('#server-url').textContent = srv.url; $('#last-sync').textContent = srv.lastSync ? new Date(srv.lastSync).toLocaleString('fa-IR') : '—'; }
  }
}
const KIND_LABEL = { gemini: 'Gemini', openai: 'OpenAI-compatible', anthropic: 'Anthropic-compatible' };
const msg = t => $('#settings-msg').textContent = t;
async function persist(note) {
  try { await store.saveSettings(settings); settings = await store.getSettings(); if (note) msg(note); autoSync(); return true; }
  catch (e) { msg('❌ ' + e.message); return false; }
}
function modelCards(p) {
  const st = modelState[p.id];
  if (!st) return '';
  if (st.loading) return '<p class="hint">⏳ در حال دریافت فهرست مدل‌ها…</p>';
  if (st.error) return `<p class="hint" style="color:var(--danger)">❌ ${esc(st.error)}</p>`;
  const f = (st.filter || '').toLowerCase();
  const list = st.list.filter(m => (!f || (m.id + ' ' + m.name).toLowerCase().includes(f)) && (!st.onlyOk || st.tests[m.id]?.status === 'ok'));
  const okCount = Object.values(st.tests).filter(t => t.status === 'ok').length;
  return `<div class="models-tools">
      <input type="search" data-mfilter placeholder="فیلتر مدل‌ها…" value="${esc(st.filter || '')}" dir="ltr" />
      <button data-testall>🧪 تست همه</button>
      <label class="check" style="margin:0"><input type="checkbox" data-onlyok ${st.onlyOk ? 'checked' : ''} /> فقط سالم‌ها (${okCount})</label>
    </div>
    <p class="hint">${st.list.length} مدل · روی هر کارت بزنید تا تست شود</p>
    <div class="models">${list.map(m => {
      const t = st.tests[m.id] || {}; const sel = p.model === m.id;
      const status = t.status === 'testing' ? '⏳ در حال تست…' : t.status === 'ok' ? `✅ کار می‌کند · ${(t.ms / 1000).toFixed(1)} ثانیه` : t.status === 'bad' ? '❌ ' + esc(t.error) : sel ? '⭐ انتخاب فعلی' : 'برای تست بزنید';
      return `<div class="mcard ${t.status === 'ok' ? 'ok' : t.status === 'bad' ? 'bad' : ''} ${sel ? 'selected' : ''}" data-model="${esc(m.id)}">
        <div class="mid">${esc(m.id)}</div>${m.name && m.name !== m.id ? `<div class="mname">${esc(m.name)}</div>` : ''}
        <div class="mst">${status}</div>
        ${t.status === 'ok' && !sel ? '<button class="primary" data-pick>✔ انتخاب این مدل</button>' : sel ? '<div class="mst">⭐ مدل فعال این سرویس</div>' : ''}
      </div>`;
    }).join('')}</div>`;
}
function renderProviders() {
  $('#providers').innerHTML = settings.providers.map((p, i) => `<div class="provider" data-i="${i}">
    <div class="prov-head">
      <input type="radio" name="active" value="${esc(p.id)}" ${p.id === settings.activeProvider ? 'checked' : ''} title="سرویس فعال" />
      <input data-k="name" value="${esc(p.name)}" placeholder="نام" />
      <select data-k="kind">${Object.keys(KIND_LABEL).map(k => `<option value="${k}" ${p.kind === k ? 'selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}</select>
      <button data-del class="danger" title="حذف">✕</button>
    </div>
    <input data-k="apiKey" type="password" dir="ltr" autocomplete="off" placeholder="${p.hasKey ? 'کلید ذخیره شده ' + esc(p.apiKeyMasked) + ' (برای تغییر، کلید جدید بنویسید)' : 'API Key'}" value="${esc(p.apiKey || '')}" />
    <details><summary>تنظیمات پیشرفته (آدرس سرویس)</summary><input data-k="baseUrl" value="${esc(p.baseUrl)}" placeholder="Base URL" dir="ltr" /></details>
    <div class="cur-model">مدل: <b dir="ltr">${esc(p.model || 'انتخاب نشده')}</b></div>
    <div class="row" style="margin:4px 0"><button data-models class="primary">🔎 دریافت مدل‌ها</button></div>
    <div data-cards>${modelCards(p)}</div>
  </div>`).join('');
  $$('#providers .provider').forEach(el => {
    const p = settings.providers[el.dataset.i];
    el.querySelectorAll('[data-k]').forEach(inp => inp.oninput = () => {
      p[inp.dataset.k] = inp.value;
      if (inp.dataset.k === 'kind') { Object.assign(p, DEFAULT_PROVIDERS[inp.value], { model: '' }); delete modelState[p.id]; renderProviders(); }
    });
    el.querySelector('[name=active]').onchange = e => { settings.activeProvider = e.target.value; persist('✅ سرویس فعال تغییر کرد'); };
    el.querySelector('[data-del]').onclick = () => { if (!confirm('این سرویس حذف شود؟')) return; settings.providers.splice(+el.dataset.i, 1); persist('حذف شد').then(renderProviders); };
    el.querySelector('[data-models]').onclick = () => fetchModels(p);
    bindCards(el, p);
  });
}
function rerenderCards(p) {
  const el = $$('#providers .provider').find(x => settings.providers[x.dataset.i]?.id === p.id); if (!el) return;
  const box = el.querySelector('[data-cards]'); const f = box.querySelector('[data-mfilter]'); const focus = f && document.activeElement === f;
  box.innerHTML = modelCards(p); el.querySelector('.cur-model b').textContent = p.model || 'انتخاب نشده';
  bindCards(el, p);
  if (focus) { const nf = box.querySelector('[data-mfilter]'); nf.focus(); nf.setSelectionRange(nf.value.length, nf.value.length); }
}
function bindCards(el, p) {
  const st = modelState[p.id]; if (!st || !st.list) return;
  const f = el.querySelector('[data-mfilter]'); if (f) f.oninput = () => { st.filter = f.value; rerenderCards(p); };
  const o = el.querySelector('[data-onlyok]'); if (o) o.onchange = () => { st.onlyOk = o.checked; rerenderCards(p); };
  const ta = el.querySelector('[data-testall]'); if (ta) ta.onclick = () => testAll(p);
  el.querySelectorAll('.mcard').forEach(c => c.onclick = async e => {
    const id = c.dataset.model;
    if (e.target.matches('[data-pick]')) return pick(p, id);
    if (st.tests[id]?.status === 'testing') return;
    await testOne(p, id);
  });
}
async function fetchModels(p) {
  modelState[p.id] = { loading: true, tests: modelState[p.id]?.tests || {} }; rerenderCards(p);
  try {
    const list = await store.listModels({ ...p });
    modelState[p.id] = { list, tests: modelState[p.id].tests, filter: '', onlyOk: false };
    if (p.apiKey) await persist('✅ کلید ذخیره شد'); // key worked -> keep it
    if (!list.length) modelState[p.id].error = 'مدلی پیدا نشد';
  } catch (e) { modelState[p.id] = { error: e.message + (p.kind === 'gemini' && !isApp ? ' (اگر سرور در ایران است، گوگل ممکن است IP آن را مسدود کند)' : ''), tests: {} }; }
  renderProviders();
}
async function testOne(p, id) {
  const st = modelState[p.id]; st.tests[id] = { status: 'testing' }; rerenderCards(p);
  try { const r = await store.testModel({ ...p }, id); st.tests[id] = r.ok ? { status: 'ok', ms: r.ms } : { status: 'bad', error: r.error }; }
  catch (e) { st.tests[id] = { status: 'bad', error: e.message }; }
  rerenderCards(p);
}
async function testAll(p) {
  const st = modelState[p.id]; const f = (st.filter || '').toLowerCase();
  const queue = st.list.filter(m => !f || (m.id + ' ' + m.name).toLowerCase().includes(f)).map(m => m.id).filter(id => st.tests[id]?.status !== 'testing');
  const worker = async () => { while (queue.length) await testOne(p, queue.shift()); };
  await Promise.all([worker(), worker(), worker()]);
  msg(`✅ تست تمام شد: ${Object.values(st.tests).filter(t => t.status === 'ok').length} مدل سالم`);
}
async function pick(p, id) {
  p.model = id; settings.activeProvider = settings.activeProvider || p.id;
  if (await persist(`✅ مدل ${id} انتخاب و ذخیره شد`)) { const keep = modelState[p.id]; settings.providers.forEach(x => { if (x.id === p.id) x.model = id; }); modelState[p.id] = keep; renderProviders(); }
}
$('#add-provider').onclick = () => { settings.providers.push({ id: uuid(), name: 'سرویس جدید', kind: 'openai', ...DEFAULT_PROVIDERS.openai, model: '', apiKey: '' }); renderProviders(); };
$('#save-settings').onclick = () => persist('✅ ذخیره شد').then(ok => ok && renderProviders());

// web: sync token
$('#copy-token').onclick = () => { $('#sync-token').select(); navigator.clipboard.writeText($('#sync-token').value).then(() => toast('کپی شد'), () => document.execCommand('copy')); };
$('#regen-token').onclick = async () => { if (!confirm('توکن قبلی باطل شود؟ اپ‌های متصل باید دوباره وصل شوند.')) return; await store.regenerateSyncToken(); loadSettings(); toast('توکن جدید ساخته شد'); };
// app: server connection
$('#paste-clip').onclick = async () => { try { $('#paste-token').value = (await navigator.clipboard.readText()).trim(); } catch { toast('با نگه داشتن انگشت روی کادر، Paste را بزنید'); $('#paste-token').focus(); } };
$('#connect').onclick = async () => {
  const b = $('#connect'); b.disabled = true; b.textContent = '⏳';
  try { const r = await store.connect($('#paste-token').value.replace(/\s+/g, '')); toast(`✅ وصل شد · ${r.count} یادداشت`); $('#paste-token').value = ''; await reload(); loadSettings(); updateBadge(); }
  catch (e) { toast('❌ ' + e.message); } finally { b.disabled = false; b.textContent = 'اتصال'; }
};
$('#go-connect').onclick = () => { go('settings'); setTimeout(() => $('#paste-token').focus(), 300); };
$('#disconnect').onclick = async () => { if (confirm('اتصال قطع شود؟ یادداشت‌های گوشی می‌مانند.')) { await store.disconnect(); loadSettings(); updateBadge(); } };
$('#sync-now').onclick = async () => {
  const b = $('#sync-now'); b.disabled = true;
  try { const r = await store.sync(); toast(`✅ همگام شد (${r.count} یادداشت)`); await reload(); loadSettings(); updateBadge(); }
  catch (e) { toast('❌ ' + e.message); updateBadge(true); } finally { b.disabled = false; }
};
async function autoSync() {
  if (!isApp || !(await store.server())) return;
  try {
    await store.sync(); notes = (await store.all()).sort(byDate); render(); updateBadge();
    if (page === 'settings' && !document.querySelector('#providers :focus')) { const keep = JSON.stringify(settings); const fresh = await store.getSettings(); if (JSON.stringify(fresh) !== keep && !Object.keys(modelState).length) { settings = fresh; renderProviders(); } }
  } catch { updateBadge(true); }
}
async function updateBadge(failed) {
  const b = $('#sync-badge');
  if (!isApp) { b.hidden = true; $('#connect-banner').hidden = true; return; }
  const srv = await store.server();
  $('#connect-banner').hidden = !!srv;
  b.hidden = false; b.textContent = !srv ? 'آفلاین' : failed ? '⚠️ همگام نشد' : '🟢 متصل به سرور';
}

// ------------------------------------------------------------ backup & restore
const native = (plugin, method, opts) => window.Capacitor?.Plugins?.[plugin]?.[method] ? window.Capacitor.Plugins[plugin][method](opts) : window.Capacitor.nativePromise(plugin, method, opts);
$('#export').onclick = async () => {
  const data = await store.exportAll($('#exp-keys').checked); const json = JSON.stringify(data, null, 2);
  const name = 'smart-notes-backup-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
  if (isApp) {
    try {
      const r = await native('Filesystem', 'writeFile', { path: name, data: json, directory: 'DOCUMENTS', encoding: 'utf8', recursive: true });
      toast('✅ در پوشه Documents ذخیره شد');
      try { await native('Share', 'share', { title: name, files: [r.uri] }); } catch {}
      return;
    } catch (e) { $('#export-fallback').hidden = false; $('#export-text').value = json; return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = name; a.click();
  toast('✅ فایل پشتیبان دانلود شد');
};
$('#copy-export').onclick = () => { $('#export-text').select(); navigator.clipboard.writeText($('#export-text').value).then(() => toast('کپی شد'), () => document.execCommand('copy')); };
$('#import').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.notes)) throw new Error('فایل پشتیبان معتبر نیست');
    const mode = document.querySelector('[name=imp-mode]:checked').value;
    if (mode === 'replace' && !confirm(`همه یادداشت‌های فعلی پاک و ${data.notes.length} یادداشت فایل جایگزین شود؟`)) return;
    const r = await store.importAll(data, mode, $('#imp-ai').checked);
    toast(`✅ ${r.imported} یادداشت بازیابی شد`); await reload(); loadSettings(); autoSync();
  } catch (err) { toast('❌ ' + err.message); }
};
$('#logout').onclick = () => { store.logout(); location.reload(); };

// ------------------------------------------------------------ login (web panel)
store.onAuth = () => { if (!$('#login').open) $('#login').showModal(); };
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await store.login($('#username').value, $('#password').value); $('#login').close(); reload(); }
  catch (err) { $('#login-msg').textContent = err.message; }
});

// ------------------------------------------------------------ boot
(async () => {
  if (isApp) {
    await store.init();
    window.addEventListener('online', async () => { const n = await store.retryPending(); if (n) { toast(`🤖 ${n} یادداشت دسته‌بندی شد`); reload(); } autoSync(); });
  } else if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  await reload(); updateBadge();
  if (isApp) { autoSync(); store.retryPending().then(n => n && reload()); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) return; isApp ? autoSync() : reload(); });
  setInterval(() => { if (document.hidden || $('#editor').open) return; isApp ? autoSync() : reload(); }, isApp ? 60000 : 30000);
})();
