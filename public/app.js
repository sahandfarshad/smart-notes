// Smart Notes UI – identical on the web panel and in the Android app
import { search, highlight, byDate, DEFAULT_PROVIDERS, uuid } from './core.js';
import { RemoteStore, LocalStore } from './store.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hl = (s, q) => highlight(esc(s), q).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); };
const fmtDate = s => (s ? String(s).slice(0, 10) : '');

const isApp = !!window.Capacitor?.isNativePlatform?.();
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
async function loadSettings() {
  try { settings = await store.getSettings(); } catch { return; }
  renderProviders();
  $('#logout').hidden = !settings.auth;
  $('#version').textContent = (isApp ? 'اپ اندروید' : 'پنل وب') + ' · Smart Notes v2';
  if (!isApp) {
    $('#server-web').hidden = false;
    store.syncToken().then(r => $('#sync-token').value = r.token).catch(() => {});
  } else {
    $('#server-app').hidden = false;
    const srv = await store.server();
    $('#server-off').hidden = !!srv; $('#server-on').hidden = !srv;
    if (srv) { $('#server-url').textContent = srv.url; $('#last-sync').textContent = srv.lastSync ? new Date(srv.lastSync).toLocaleString('fa-IR') : '—'; }
    $('#auto-sync').checked = await store.kvGet('autoSync', false);
  }
}
const KIND_LABEL = { gemini: 'Gemini', openai: 'OpenAI-compatible', anthropic: 'Anthropic-compatible' };
function renderProviders() {
  $('#providers').innerHTML = settings.providers.map((p, i) => `<div class="provider" data-i="${i}">
    <input type="radio" name="active" value="${esc(p.id)}" ${p.id === settings.activeProvider ? 'checked' : ''} title="فعال" style="width:auto" />
    <input data-k="name" value="${esc(p.name)}" placeholder="نام" />
    <select data-k="kind">${Object.keys(KIND_LABEL).map(k => `<option value="${k}" ${p.kind === k ? 'selected' : ''}>${KIND_LABEL[k]}</option>`).join('')}</select>
    <button data-del="${i}" class="danger">✕</button>
    <input class="full" data-k="baseUrl" value="${esc(p.baseUrl)}" placeholder="Base URL" dir="ltr" />
    <input class="full" data-k="model" value="${esc(p.model)}" placeholder="Model" dir="ltr" />
    <input class="full" data-k="apiKey" type="password" dir="ltr" placeholder="${p.hasKey ? 'کلید ذخیره شده ' + esc(p.apiKeyMasked) + ' (برای تغییر، جدید بنویسید)' : 'API Key'}" />
  </div>`).join('');
  $$('#providers .provider').forEach(el => {
    const p = settings.providers[el.dataset.i];
    el.querySelectorAll('[data-k]').forEach(inp => inp.oninput = () => {
      p[inp.dataset.k] = inp.value;
      if (inp.dataset.k === 'kind') { Object.assign(p, DEFAULT_PROVIDERS[inp.value]); renderProviders(); }
    });
    el.querySelector('[name=active]').onchange = e => settings.activeProvider = e.target.value;
  });
  $$('[data-del]').forEach(b => b.onclick = () => { settings.providers.splice(+b.dataset.del, 1); renderProviders(); });
}
$('#add-provider').onclick = () => { settings.providers.push({ id: uuid(), name: 'سرویس جدید', kind: 'openai', ...DEFAULT_PROVIDERS.openai, apiKey: '' }); renderProviders(); };
$('#save-settings').onclick = async () => { try { await store.saveSettings(settings); $('#settings-msg').textContent = '✅ ذخیره شد'; loadSettings(); } catch (e) { $('#settings-msg').textContent = '❌ ' + e.message; } };
$('#test-ai').onclick = async () => {
  $('#settings-msg').textContent = '⏳ …';
  try { await store.saveSettings(settings); const r = await store.testAi(); $('#settings-msg').textContent = '✅ وصل است: ' + r.reply; }
  catch (e) { $('#settings-msg').textContent = '❌ ' + e.message; }
};
// web: sync token
$('#copy-token').onclick = () => { $('#sync-token').select(); navigator.clipboard.writeText($('#sync-token').value).then(() => toast('کپی شد'), () => document.execCommand('copy')); };
$('#regen-token').onclick = async () => { if (!confirm('توکن قبلی باطل شود؟ اپ‌های متصل باید دوباره وصل شوند.')) return; await store.regenerateSyncToken(); loadSettings(); toast('توکن جدید ساخته شد'); };
// app: server connection
$('#connect').onclick = async () => {
  try { const r = await store.connect($('#paste-token').value); toast('وصل شد: ' + r.url); $('#paste-token').value = ''; loadSettings(); }
  catch (e) { toast('❌ ' + e.message); }
};
$('#disconnect').onclick = async () => { if (confirm('اتصال قطع شود؟ یادداشت‌های گوشی می‌مانند.')) { await store.disconnect(); loadSettings(); updateBadge(); } };
$$('[data-sync]').forEach(b => b.onclick = async () => {
  const mode = b.dataset.sync;
  if (mode !== 'merge' && !confirm(mode === 'pull' ? 'همه اطلاعات گوشی با سرور جایگزین شود؟' : 'همه اطلاعات سرور با گوشی جایگزین شود؟')) return;
  b.disabled = true;
  try { const r = await store.sync(mode); toast(`✅ همگام شد (${r.count} یادداشت)`); await reload(); loadSettings(); updateBadge(); }
  catch (e) { toast('❌ ' + e.message); } finally { b.disabled = false; }
});
$('#auto-sync').onchange = e => store.kvSet('autoSync', e.target.checked);
async function autoSync() {
  if (!isApp || !(await store.server()) || !(await store.kvGet('autoSync', false))) return;
  try { await store.sync('merge'); notes = (await store.all()).sort(byDate); render(); updateBadge(); } catch { updateBadge(true); }
}
async function updateBadge(failed) {
  const b = $('#sync-badge');
  if (!isApp) { b.hidden = true; return; }
  const srv = await store.server();
  b.hidden = false; b.textContent = !srv ? 'آفلاین' : failed ? 'همگام نشد' : 'متصل به سرور';
}
// backup
$('#export').onclick = async () => {
  const data = await store.exportAll(); const json = JSON.stringify(data, null, 2); const name = 'smart-notes-' + new Date().toISOString().slice(0, 10) + '.json';
  if (isApp && navigator.share) { try { await navigator.share({ title: name, text: json }); return; } catch {} }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = name; a.click();
};
$('#import').onchange = async e => { const f = e.target.files[0]; if (!f) return; const r = await store.importAll(JSON.parse(await f.text())); toast(r.imported + ' یادداشت وارد شد'); reload(); };
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !isApp) reload(); });
})();
