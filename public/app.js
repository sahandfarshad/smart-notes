// Smart Notes – frontend (vanilla JS, no build step)
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = s => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
let token = localStorage.getItem('sn_token') || '';
let currentView = 'add';

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401) { showLogin(); throw new Error('auth'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ------------------------------------------------------------ views
function show(view) {
  currentView = view;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'add') loadRecent();
  if (view === 'table') loadTables();
  if (view === 'tree') loadTree();
  if (view === 'settings') loadSettings();
}
$$('#tabs button').forEach(b => b.onclick = () => { $('#search').value = ''; show(b.dataset.view); });

function card(n) {
  const fields = Object.entries(n.fields || {}).map(([k, v]) => `<div><b>${esc(k)}:</b> ${linkify(v)}</div>`).join('');
  const status = n.ai_status === 'error' ? `<div class="status-error">⚠️ ${esc(n.ai_error)}</div>`
    : n.ai_status === 'pending' ? '<div class="status-pending">در انتظار دسته‌بندی…</div>' : '';
  const date = n.event_date ? ` · ${esc(n.event_date)}` : '';
  return `<div class="card" data-id="${n.id}">
    <div class="path">${esc(n.category)}${n.subcategory ? ' › ' + esc(n.subcategory) : ''}${date}</div>
    <h4>${esc(n.title)}</h4>
    <div class="raw">${linkify(n.raw)}</div>
    <div class="fields">${fields}</div>
    <div class="tags">${(n.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    ${status}
  </div>`;
}
function bindCards(container, notes) {
  container.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', e => { if (e.target.tagName !== 'A') openEditor(notes.find(n => n.id == el.dataset.id)); });
  });
}
function renderCards(container, notes) {
  container.innerHTML = notes.length ? notes.map(card).join('') : '<p class="hint">چیزی نیست.</p>';
  bindCards(container, notes);
}

// ------------------------------------------------------------ add
async function loadRecent() { const notes = await api('/notes'); renderCards($('#recent'), notes.slice(0, 12)); fillCatList(notes); }
async function save() {
  const raw = $('#raw').value.trim(); if (!raw) return;
  const btn = $('#save'); btn.disabled = true; btn.textContent = '🤖 در حال دسته‌بندی…';
  try {
    const n = await api('/notes', { method: 'POST', body: { raw } });
    $('#raw').value = '';
    toast(n.ai_status === 'done' ? `ذخیره شد در «${n.category}${n.subcategory ? ' › ' + n.subcategory : ''}»` : 'ذخیره شد (بدون دسته‌بندی هوشمند)');
    loadRecent();
  } catch (e) { if (e.message !== 'auth') toast('خطا: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'ذخیره و دسته‌بندی'; }
}
$('#save').onclick = save;
$('#raw').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); });

// ------------------------------------------------------------ search
let st;
$('#search').addEventListener('input', () => {
  clearTimeout(st);
  st = setTimeout(async () => {
    const q = $('#search').value.trim();
    if (!q) return show(currentView === 'search' ? 'add' : currentView);
    const res = await api('/search?q=' + encodeURIComponent(q));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-search'));
    $$('#tabs button').forEach(b => b.classList.remove('active'));
    currentView = 'search';
    $('#search-title').textContent = `${res.length} نتیجه برای «${q}»`;
    renderCards($('#results'), res);
  }, 250);
});

// ------------------------------------------------------------ table
let activeCat = null;
async function loadTables() {
  const notes = await api('/notes');
  const cats = [...new Set(notes.map(n => n.category))];
  $('#cat-chips').innerHTML = ['همه', ...cats].map(c => `<button class="${(activeCat || 'همه') === c ? 'active' : ''}">${esc(c)}</button>`).join('');
  $$('#cat-chips button').forEach(b => b.onclick = () => { activeCat = b.textContent === 'همه' ? null : b.textContent; loadTables(); });
  const groups = {};
  for (const n of notes) {
    if (activeCat && n.category !== activeCat) continue;
    const key = n.category + (n.subcategory ? ' › ' + n.subcategory : '');
    (groups[key] ||= []).push(n);
  }
  $('#tables').innerHTML = Object.entries(groups).map(([name, list]) => {
    const cols = [...new Set(list.flatMap(n => Object.keys(n.fields || {})))];
    return `<div class="tbl-wrap"><h3>${esc(name)} <span class="hint">(${list.length})</span></h3><table>
      <thead><tr><th>عنوان</th>${cols.map(c => `<th>${esc(c)}</th>`).join('')}<th>تاریخ</th><th>تگ‌ها</th></tr></thead>
      <tbody>${list.map(n => `<tr data-id="${n.id}"><td>${esc(n.title)}</td>${cols.map(c => `<td>${linkify(n.fields?.[c] ?? '')}</td>`).join('')}
        <td>${esc(n.event_date || n.created_at.slice(0, 10))}</td><td>${(n.tags || []).slice(0, 4).map(t => `<span class="tag">${esc(t)}</span>`).join(' ')}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }).join('') || '<p class="hint">هنوز یادداشتی ثبت نشده.</p>';
  bindCards($('#tables'), notes);
}

// ------------------------------------------------------------ tree
async function loadTree() {
  const tree = await api('/tree');
  $('#tree').innerHTML = tree.map(c => `<li><div class="node" data-cat="${esc(c.name)}"><span>📁 ${esc(c.name)}</span><span class="count">${c.count}</span></div>
    <ul>${c.children.map(s => `<li><div class="node" data-cat="${esc(c.name)}" data-sub="${esc(s.name)}"><span>${s.name ? '📂 ' + esc(s.name) : '📄 (بدون زیر دسته)'}</span><span class="count">${s.count}</span></div></li>`).join('')}</ul></li>`).join('')
    || '<p class="hint">خالی</p>';
  $$('#tree .node').forEach(el => el.onclick = async () => {
    $$('#tree .node').forEach(x => x.classList.remove('sel')); el.classList.add('sel');
    if (el.dataset.sub === undefined) el.parentElement.classList.toggle('open');
    const q = '?category=' + encodeURIComponent(el.dataset.cat) + (el.dataset.sub !== undefined ? '&subcategory=' + encodeURIComponent(el.dataset.sub) : '');
    renderCards($('#tree-notes'), await api('/notes' + q));
  });
}

function fillCatList(notes) { $('#cat-list').innerHTML = [...new Set(notes.map(n => n.category))].map(c => `<option value="${esc(c)}">`).join(''); }

// ------------------------------------------------------------ editor
let editing = null;
function openEditor(n) {
  editing = n; const f = $('#edit-form');
  f.raw.value = n.raw; f.title.value = n.title; f.category.value = n.category; f.subcategory.value = n.subcategory;
  f.event_date.value = n.event_date || ''; f.tags.value = (n.tags || []).join(', ');
  f.fields.value = Object.entries(n.fields || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  $('#editor').showModal();
}
$('#editor').addEventListener('close', async () => {
  const action = $('#editor').returnValue; const f = $('#edit-form'); if (!editing) return;
  try {
    if (action === 'save') {
      const fields = {}; f.fields.value.split('\n').forEach(l => { const i = l.indexOf(':'); if (i > 0) fields[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
      await api('/notes/' + editing.id, { method: 'PUT', body: { raw: f.raw.value, title: f.title.value, category: f.category.value, subcategory: f.subcategory.value,
        event_date: f.event_date.value || null, tags: f.tags.value.split(/[,،]/).map(s => s.trim()).filter(Boolean), fields } });
      toast('ذخیره شد');
    } else if (action === 'ai') {
      await api('/notes/' + editing.id, { method: 'PUT', body: { raw: f.raw.value } });
      toast('🤖 در حال دسته‌بندی…'); await api('/notes/' + editing.id + '/reclassify', { method: 'POST' }); toast('دسته‌بندی شد');
    } else if (action === 'delete') {
      if (confirm('حذف شود؟')) { await api('/notes/' + editing.id, { method: 'DELETE' }); toast('حذف شد'); }
    }
  } catch (e) { toast('خطا: ' + e.message); }
  editing = null; $('#search').value ? $('#search').dispatchEvent(new Event('input')) : show(currentView);
});

// ------------------------------------------------------------ settings
let settings = { providers: [], activeProvider: null };
const DEFAULTS = {
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-latest' },
};
async function loadSettings() {
  settings = await api('/settings');
  $('#logout').hidden = !settings.auth;
  renderProviders();
}
function renderProviders() {
  $('#providers').innerHTML = settings.providers.map((p, i) => `<div class="provider" data-i="${i}">
    <input type="radio" name="active" value="${esc(p.id)}" ${p.id === settings.activeProvider ? 'checked' : ''} title="فعال" style="width:auto" />
    <input data-k="name" value="${esc(p.name)}" placeholder="نام" />
    <select data-k="kind">${['gemini', 'openai', 'anthropic'].map(k => `<option value="${k}" ${p.kind === k ? 'selected' : ''}>${{ gemini: 'Gemini', openai: 'OpenAI-compatible', anthropic: 'Anthropic-compatible' }[k]}</option>`).join('')}</select>
    <input class="full" data-k="baseUrl" value="${esc(p.baseUrl)}" placeholder="Base URL" dir="ltr" />
    <input data-k="model" value="${esc(p.model)}" placeholder="Model" dir="ltr" style="grid-column: span 2" />
    <button data-del="${i}" class="danger">حذف</button>
    <input class="full" data-k="apiKey" type="password" placeholder="${p.hasKey ? 'کلید ذخیره شده: ' + esc(p.apiKeyMasked) + ' (برای تغییر، کلید جدید بنویسید)' : 'API Key'}" dir="ltr" />
  </div>`).join('');
  $$('#providers .provider').forEach(el => {
    const p = settings.providers[el.dataset.i];
    el.querySelectorAll('[data-k]').forEach(inp => inp.oninput = () => {
      p[inp.dataset.k] = inp.value;
      if (inp.dataset.k === 'kind') { Object.assign(p, DEFAULTS[inp.value]); renderProviders(); }
    });
    el.querySelector('[name=active]').onchange = e => settings.activeProvider = e.target.value;
  });
  $$('[data-del]').forEach(b => b.onclick = () => { settings.providers.splice(+b.dataset.del, 1); renderProviders(); });
}
$('#add-provider').onclick = () => {
  settings.providers.push({ id: crypto.randomUUID(), name: 'سرویس جدید', kind: 'openai', ...DEFAULTS.openai, apiKey: '' });
  renderProviders();
};
$('#save-settings').onclick = async () => {
  await api('/settings', { method: 'PUT', body: settings });
  $('#settings-msg').textContent = '✅ ذخیره شد'; loadSettings();
};
$('#test-ai').onclick = async () => {
  $('#settings-msg').textContent = 'در حال تست…';
  try { await api('/settings', { method: 'PUT', body: settings }); const r = await api('/settings/test', { method: 'POST' }); $('#settings-msg').textContent = '✅ اتصال برقرار است: ' + r.reply; }
  catch (e) { $('#settings-msg').textContent = '❌ ' + e.message; }
};
$('#export').onclick = async e => {
  e.preventDefault();
  const data = await api('/export');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = 'smart-notes-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
};
$('#import').onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  const data = JSON.parse(await file.text());
  const r = await api('/import', { method: 'POST', body: data }); toast(r.imported + ' یادداشت وارد شد');
};
$('#logout').onclick = () => { localStorage.removeItem('sn_token'); token = ''; location.reload(); };

// ------------------------------------------------------------ login
function showLogin() { if (!$('#login').open) $('#login').showModal(); }
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#password').value }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error);
    token = d.token; localStorage.setItem('sn_token', token); $('#login').close(); show(currentView);
  } catch (err) { $('#login-msg').textContent = err.message; }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
show('add');
