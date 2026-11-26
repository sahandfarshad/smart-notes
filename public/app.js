// Smart Notes UI – identical on the web panel and in the Android app
import { normalize, search, highlight, byDate, byPinThenDate, DEFAULT_PROVIDERS, uuid, faDate, faNum, kindsOf, KIND_FILTERS, DATE_FILTERS, inDateRange, buildTree, buildTimeline, onThisDay, topicStats, related, noteDate } from './core.js';
import { RemoteStore, LocalStore } from './store.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hl = (s, q) => highlight(esc(s), q).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); };
// copy that also works on http:// (navigator.clipboard only exists on https/localhost)
async function copyText(text, el) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch {}
  const t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(t); t.select(); t.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  t.remove(); if (!ok && el) { el.focus(); el.select?.(); }
  return ok;
}
const fmtDate = s => (s ? faDate(s) : '');

const isApp = !!window.Capacitor?.isNativePlatform?.() || (location.hostname === 'localhost' && location.protocol === 'https:' && !location.port);
const store = isApp ? new LocalStore() : new RemoteStore();
let notes = [];
let page = 'home';

// ------------------------------------------------------------ data
async function reload() {
  try { notes = (await store.all()).sort(byDate); } catch (e) { if (e.message !== 'auth') toast('خطا: ' + e.message); }
  reloadInfos();
  $('#cat-list').innerHTML = [...new Set(notes.map(n => n.category))].map(c => `<option value="${esc(c)}">`).join('');
  render();
}
function render() { if (page === 'home') renderHome(); if (page === 'table') renderTable(); if (page === 'browse') renderBrowse(); if (page === 'info') renderInfos(); }

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
  const warn = n.ai_status === 'error' ? `<div class="warn">⚠️ دسته‌بندی نشد: ${esc(aiErr(n.ai_error))} <button class="retry" data-retry="${esc(n.uid)}">🔄 تلاش دوباره</button></div>`
    : n.ai_status === 'pending' ? `<div class="warn">⏳ منتظر اینترنت برای دسته‌بندی <button class="retry" data-retry="${esc(n.uid)}">🔄 تلاش دوباره</button></div>` : '';
  return `<div class="item" data-uid="${esc(n.uid)}">
    <div class="path">${hl(n.category, q)}${n.subcategory ? ' › ' + hl(n.subcategory, q) : ''} · ${esc(fmtDate(n.event_date || n.created_at))}</div>
    <div class="title">${n.pinned ? '📌 ' : ''}${hl(n.title, q)}</div>
    <div class="snip">${hl(fields || n.raw, q)}</div>
    ${q ? `<div class="tags">${(n.tags || []).map(t => `<span class="tag">${hl(t, q)}</span>`).join('')}</div>` : ''}
    ${warn}</div>`;
}
// AI errors in plain words (Google blocks Gemini for some countries, e.g. Iran IPs)
function aiErr(e) {
  e = String(e || '');
  if (/location is not supported|unsupported.*(country|region|location)|not available in your country/i.test(e)) return 'سرویس هوش مصنوعی از این کشور در دسترس نیست (محدودیت گوگل). VPN را روشن کنید و «تلاش دوباره» را بزنید.';
  return e;
}
const failedNotes = () => notes.filter(n => n.ai_status && n.ai_status !== 'done');
let retrying = false;
async function retryAi(uids) {
  if (retrying) return; retrying = true; let ok = 0;
  toast(`🤖 دسته‌بندی دوباره ${faNum(uids.length)} یادداشت…`);
  try {
    for (const uid of uids) { try { const r = await store.reclassify(uid); if (r?.ai_status === 'done') ok++; } catch (e) { if (e.message === 'auth') break; } }
    toast(ok ? `✅ ${faNum(ok)} از ${faNum(uids.length)} یادداشت دسته‌بندی شد` : '⚠️ باز هم نشد؛ اتصال یا VPN را بررسی کنید');
  } finally { retrying = false; }
  await reload(); autoSync();
}
// filters (date range + kind of information) and recent searches
const filt = { date: 'all', kinds: new Set() };
function renderFilters() {
  $('#filters').innerHTML = `<select id="f-date">${Object.entries(DATE_FILTERS).map(([k, v]) => `<option value="${k}" ${filt.date === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` +
    Object.entries(KIND_FILTERS).map(([k, v]) => `<button data-kind="${k}" class="${filt.kinds.has(k) ? 'active' : ''}">${v}</button>`).join('') +
    (filt.date !== 'all' || filt.kinds.size ? '<button data-clear>✕ حذف فیلترها</button>' : '');
  $('#f-date').onchange = e => { filt.date = e.target.value; renderFilters(); renderHome(); };
  $$('#filters [data-kind]').forEach(b => b.onclick = () => { const k = b.dataset.kind; filt.kinds.has(k) ? filt.kinds.delete(k) : filt.kinds.add(k); renderFilters(); renderHome(); });
  const c = $('#filters [data-clear]'); if (c) c.onclick = () => { filt.date = 'all'; filt.kinds.clear(); renderFilters(); renderHome(); };
}
const filtered = list => list.filter(n => inDateRange(n, filt.date) && [...filt.kinds].every(k => kindsOf(n).has(k)));
const recent = () => { try { return JSON.parse(localStorage.getItem('sn_recent') || '[]'); } catch { return []; } };
function rememberSearch(q) {
  q = q.trim(); if (q.length < 2) return;
  const r = recent().filter(x => x !== q && !q.startsWith(x)); r.unshift(q); localStorage.setItem('sn_recent', JSON.stringify(r.slice(0, 8)));
}
function renderRecent() {
  const r = recent(); const show = !$('#q1').value.trim() && r.length;
  $('#recent').innerHTML = show ? '<span class="hint" style="margin:0 2px">🕘</span>' + r.map(x => `<button data-q="${esc(x)}">${esc(x)}</button>`).join('') + '<button data-clear-recent title="پاک کردن">✕</button>' : '';
  $$('#recent [data-q]').forEach(b => b.onclick = () => { $('#q1').value = b.dataset.q; renderHome(); });
  const c = $('#recent [data-clear-recent]'); if (c) c.onclick = () => { localStorage.removeItem('sn_recent'); renderRecent(); };
}
const section = (title, list, q) => list.length ? `<div class="sec">${title}</div>` + list.map(n => item(n, q)).join('') : '';
function renderHome() {
  const q = $('#q1').value; const active = q.trim() || filt.date !== 'all' || filt.kinds.size;
  let html = '';
  if (active) {
    const res = filtered(q.trim() ? search(notes, q, 2000) : notes.slice().sort(byPinThenDate)).slice(0, 150);
    $('#count1').textContent = `${faNum(res.length)} نتیجه`;
    html = res.map(n => item(n, q)).join('');
  } else {
    const pinned = notes.filter(n => n.pinned).sort(byDate);
    const ago = onThisDay(notes);
    $('#count1').textContent = notes.length ? '' : 'هنوز چیزی ثبت نشده. اولین یادداشتت رو بنویس 👆';
    html = section('📌 سنجاق‌شده‌ها', pinned, '') + section('📆 همین روزها در سال‌های قبل', ago, '') +
      section('🕑 آخرین‌ها', notes.filter(n => !n.pinned).slice(0, 15), '');
  }
  const failed = failedNotes();
  if (failed.length && !active) html = `<div class="banner">⚠️ ${faNum(failed.length)} یادداشت دسته‌بندی نشده <button data-retry-all class="primary">🔄 تلاش دوباره همه</button></div>` + html;
  $('#results1').innerHTML = html;
  $$('#results1 .item').forEach(el => el.onclick = e => { if (e.target.tagName !== 'A' && !e.target.closest('[data-retry]')) openEditor(el.dataset.uid); });
  $$('#results1 [data-retry]').forEach(b => b.onclick = e => { e.stopPropagation(); retryAi([b.dataset.retry]); });
  const ra = $('#results1 [data-retry-all]'); if (ra) ra.onclick = () => retryAi(failedNotes().map(n => n.uid));
  renderRecent();
}
let recentT;
$('#q1').addEventListener('input', () => { renderHome(); clearTimeout(recentT); recentT = setTimeout(() => rememberSearch($('#q1').value), 1500); });
$('#q1').addEventListener('keydown', e => { if (e.key === 'Enter') rememberSearch($('#q1').value); });

// ------------------------------------------------------------ browse: tree + timeline + topic card
let view = 'tree'; const openNodes = new Set();
$$('.seg button').forEach(b => b.onclick = () => { view = b.dataset.view; $$('.seg button').forEach(x => x.classList.toggle('active', x === b)); renderBrowse(); });
$('#q3').addEventListener('input', () => renderBrowse());
function renderBrowse() {
  const q = $('#q3').value; const list = q.trim() ? search(notes, q, 5000) : notes;
  const open = k => (q.trim() || openNodes.has(k) ? 'open' : '');
  let html = '';
  if (view === 'tree') {
    const tree = buildTree(list);
    html = tree.map(c => `<details class="node" data-k="c:${esc(c.name)}" ${open('c:' + c.name)}>
      <summary><span class="nname">📁 ${hl(c.name, q)}</span><span class="ncount">${faNum(c.count)}</span><span class="nlast">${fmtDate(c.last)}</span>
        <button class="ninfo" data-topic="${esc(c.name)}" title="کارت موضوع">ℹ️</button></summary>
      ${c.subs.map(s => s.name ? `<details class="node sub" data-k="s:${esc(c.name)}/${esc(s.name)}" ${open('s:' + c.name + '/' + s.name)}>
          <summary><span class="nname">📂 ${hl(s.name, q)}</span><span class="ncount">${faNum(s.count)}</span><span class="nlast">${fmtDate(s.last)}</span>
            <button class="ninfo" data-topic="${esc(c.name)}" data-sub="${esc(s.name)}" title="کارت موضوع">ℹ️</button></summary>
          ${s.notes.map(n => leaf(n, q)).join('')}</details>` : s.notes.map(n => leaf(n, q)).join('')).join('')}
    </details>`).join('');
  } else {
    const tl = buildTimeline(list);
    html = tl.map((y, i) => `<details class="node" data-k="y:${y.year}" ${open('y:' + y.year) || (i === 0 && ![...openNodes].some(k => k.startsWith('y:')) ? 'open' : '')}>
      <summary><span class="nname">🗓️ ${faNum(y.year)}</span><span class="ncount">${faNum(y.count)}</span></summary>
      ${y.months.map(m => `<div class="month">${m.name} ${faNum(y.year)} <span class="hint">(${faNum(m.notes.length)})</span></div>${m.notes.map(n => leaf(n, q, true)).join('')}`).join('')}
    </details>`).join('');
  }
  $('#browse').innerHTML = html || '<p class="hint">چیزی پیدا نشد.</p>';
  $$('#browse details').forEach(d => d.ontoggle = () => { if (!q.trim()) d.open ? openNodes.add(d.dataset.k) : openNodes.delete(d.dataset.k); });
  $$('#browse .leaf').forEach(el => el.onclick = e => { if (e.target.tagName !== 'A') openEditor(el.dataset.uid); });
  $$('#browse [data-topic]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); openTopic(b.dataset.topic, b.dataset.sub); });
}
const leaf = (n, q, withPath) => `<div class="leaf" data-uid="${esc(n.uid)}"><span class="ldate">${fmtDate(noteDate(n))}</span>
  <span>${n.pinned ? '📌 ' : ''}${hl(n.title, q)}${withPath ? ` <span class="lpath">· ${esc(n.category)}${n.subcategory ? ' › ' + esc(n.subcategory) : ''}</span>` : ''}</span></div>`;

function openTopic(category, subcategory) {
  const t = topicStats(notes, category, subcategory);
  if (!subcategory && t.subs.length > 1) t.every = null; // the usual interval only makes sense for one kind of event
  const next = t.every && t.last ? new Date(Date.parse(t.last) + t.every * 864e5).toISOString().slice(0, 10) : null;
  const latest = Object.entries(t.latest);
  $('#topic-body').innerHTML = `<h3>${esc(category)}${subcategory ? ' › ' + esc(subcategory) : ''}</h3>
    <div class="stats">
      <div><b>${faNum(t.list.length)}</b><span>یادداشت</span></div>
      <div><b>${t.last ? fmtDate(t.last) : '—'}</b><span>آخرین بار${t.daysSince != null ? ` (${faNum(t.daysSince)} روز پیش)` : ''}</span></div>
      ${t.every ? `<div><b>هر ~${faNum(t.every)} روز</b><span>فاصله معمول${next ? ` · بعدی حدود ${fmtDate(next)}` : ''}</span></div>` : ''}
      <div><b>${t.first ? fmtDate(t.first) : '—'}</b><span>اولین بار</span></div>
    </div>
    ${latest.length ? `<div class="sec">آخرین مقدارها</div><table class="kv">${latest.map(([k, v]) => `<tr data-uid="${esc(v.uid)}"><th>${esc(k)}</th><td>${hl(v.value, '')}</td><td class="nowrap hint">${fmtDate(v.date)}</td></tr>`).join('')}</table>` : ''}
    ${!subcategory && t.subs.length ? `<div class="chips sub">${t.subs.map(s => `<button data-tsub="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
    <div class="sec">همه یادداشت‌ها</div>${t.list.map(n => leaf(n, '')).join('')}`;
  $$('#topic-body .leaf, #topic-body tr[data-uid]').forEach(el => el.onclick = () => { $('#topic').close(); openEditor(el.dataset.uid); });
  $$('#topic-body [data-tsub]').forEach(b => b.onclick = e => { e.preventDefault(); openTopic(category, b.dataset.tsub); });
  if (!$('#topic').open) $('#topic').showModal();
}
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

// ------------------------------------------------------------ useful info: everyday links, texts and images (the AI never sees these)
let infos = [];
async function reloadInfos() {
  try { infos = (await store.infos()).sort((a, b) => (a.ord || 0) - (b.ord || 0) || String(b.created_at).localeCompare(String(a.created_at))); }
  catch (e) { if (e.message !== 'auth') toast('خطا: ' + e.message); }
  if (page === 'info') renderInfos();
}
const firstUrl = t => (String(t || '').match(/https?:\/\/[^\s<>"']+/) || [])[0];
function renderInfos() {
  const q = normalize($('#qi').value);
  const list = q ? infos.filter(i => q.split(' ').every(w => normalize(i.title + ' ' + i.text).includes(w))) : infos;
  $('#infos').innerHTML = list.map(i => {
    const url = firstUrl(i.text);
    return `<div class="icard" data-uid="${esc(i.uid)}">
      ${i.image ? `<img class="ithumb" src="${esc(i.image)}" alt="" data-act="view" loading="lazy" />` : ''}
      <div class="ibody" data-act="${i.text ? 'copy' : i.image ? 'view' : 'edit'}" title="${i.text ? 'برای کپی بزنید' : ''}">
        ${i.title ? `<div class="ititle">${esc(i.title)}</div>` : ''}
        ${i.text ? `<div class="itext">${esc(i.text)}</div>` : ''}
      </div>
      <div class="iacts">
        ${i.text ? '<button data-act="copy" class="primary">📋 کپی</button>' : ''}
        ${url ? `<button data-act="open">🔗 باز کردن</button>` : ''}
        ${i.image ? '<button data-act="img">🖼️ کپی عکس</button>' : ''}
        <span class="grow"></span><button data-act="edit" title="ویرایش">✏️</button>
      </div></div>`;
  }).join('') || `<p class="hint">${infos.length ? 'چیزی پیدا نشد.' : 'چیزهایی که هر روز لازم دارید (لینک، شماره کارت، آدرس، عکس کارت ملی…) را اینجا بگذارید تا با یک لمس کپی شوند. 🔒 این بخش هیچ‌وقت برای هوش مصنوعی فرستاده نمی‌شود.'}</p>`;
  $$('#infos [data-act]').forEach(el => el.onclick = async e => {
    e.stopPropagation();
    const i = infos.find(x => x.uid === el.closest('.icard').dataset.uid); if (!i) return;
    const act = el.dataset.act;
    if (act === 'copy') toast(await copyText(i.text) ? '✅ کپی شد' + (i.title ? ': ' + i.title : '') : 'کپی نشد');
    else if (act === 'open') window.open(firstUrl(i.text), '_blank', 'noopener');
    else if (act === 'view') openInfoView(i);
    else if (act === 'img') copyImage(i);
    else if (act === 'edit') openInfoEditor(i);
  });
}
$('#qi').addEventListener('input', renderInfos);

// images are shrunk on the device before saving (max 1800px, JPEG) so sync stays light
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1800, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('عکس خوانده نشد')); };
    img.src = url;
  });
}
const dataUrlToBlob = async d => (await fetch(d)).blob();
async function pngBlob(d) {
  const img = new Image(); img.src = d; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0);
  return new Promise(r => c.toBlob(r, 'image/png'));
}
const fileName = i => (i.title || 'image').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) + '.jpg';
async function shareImage(i) {
  if (isApp) {
    try {
      const name = 'info-' + Date.now() + '.jpg';
      const r = await native('Filesystem', 'writeFile', { path: name, data: i.image.split(',')[1], directory: 'CACHE' });
      await native('Share', 'share', { title: i.title || '', files: [r.uri] });
    } catch (e) { if (!/cancel/i.test(String(e?.message || e))) toast('اشتراک ممکن نشد'); }
    return;
  }
  try { const f = new File([await dataUrlToBlob(i.image)], fileName(i), { type: 'image/jpeg' }); if (navigator.canShare?.({ files: [f] })) return await navigator.share({ files: [f], title: i.title || '' }); } catch {}
  const a = document.createElement('a'); a.href = i.image; a.download = fileName(i); a.click(); toast('⬇️ عکس دانلود شد');
}
async function copyImage(i) {
  try {
    if (navigator.clipboard?.write && window.ClipboardItem && window.isSecureContext) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(i.image) })]); return toast('✅ عکس کپی شد؛ هر جا خواستید Paste کنید');
    }
  } catch {}
  shareImage(i); // no image clipboard here (http or Android WebView): share sheet / download instead
}
let viewing = null;
function openInfoView(i) { viewing = i; $('#iv-title').textContent = i.title || ''; $('#iv-img').src = i.image; $('#info-view').showModal(); }
$('#info-view').addEventListener('close', () => {
  const a = $('#info-view').returnValue, i = viewing; viewing = null; $('#info-view').returnValue = '';
  if (!i) return; if (a === 'copy') copyImage(i); else if (a === 'share') shareImage(i);
});

let infoEditing = null, infoImage = '';
function setInfoImage(d) { infoImage = d || ''; const p = $('#info-preview'); p.hidden = !infoImage; p.src = infoImage; $('#info-rmimg').hidden = !infoImage; }
function openInfoEditor(i) {
  infoEditing = i || { uid: uuid() }; const f = $('#info-form');
  $('#info-head').textContent = i ? 'ویرایش' : 'افزودن به اطلاعات کاربردی';
  f.title.value = i?.title || ''; f.text.value = i?.text || ''; setInfoImage(i?.image);
  $('#info-del').hidden = !i; $('#info-top-btn').hidden = !i;
  $('#info-editor').returnValue = ''; $('#info-editor').showModal();
  if (!i) setTimeout(() => f.title.focus(), 50);
}
$('#info-add').onclick = () => openInfoEditor(null);
async function takeImage(file) {
  if (!file || !file.type.startsWith('image/')) return false;
  try { setInfoImage(await shrinkImage(file)); return true; } catch (e) { toast('❌ ' + e.message); return true; }
}
$('#info-file').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; await takeImage(f); };
$('#info-editor').addEventListener('paste', async e => {
  const f = [...(e.clipboardData?.items || [])].find(x => x.type.startsWith('image/'))?.getAsFile();
  if (f) { e.preventDefault(); await takeImage(f); }
});
// buttons that keep the dialog open
$('#info-paste').onclick = async e => {
  e.preventDefault();
  try {
    for (const it of await navigator.clipboard.read()) { const t = it.types.find(x => x.startsWith('image/')); if (t) { await takeImage(new File([await it.getType(t)], 'p', { type: t })); return; } }
    toast('عکسی در کلیپ‌بورد نیست');
  } catch { toast('اینجا چسباندن مستقیم ممکن نیست؛ «انتخاب عکس» را بزنید' + (isApp ? '' : ' یا Ctrl+V')); }
};
$('#info-rmimg').onclick = e => { e.preventDefault(); setInfoImage(''); };
$('#info-editor').addEventListener('close', async () => {
  const a = $('#info-editor').returnValue, f = $('#info-form'), i = infoEditing; infoEditing = null;
  if (!i || !a || a === 'cancel') return;
  try {
    const minOrd = Math.min(0, ...infos.map(x => x.ord || 0));
    if (a === 'save') {
      const item = { uid: i.uid, title: f.title.value.trim(), text: f.text.value.trim(), image: infoImage, ord: i.ord ?? minOrd - 1 };
      if (!item.title && !item.text && !item.image) return toast('چیزی برای ذخیره نیست');
      await store.saveInfo(item); toast('✅ ذخیره شد');
    } else if (a === 'top') { await store.saveInfo({ ...i, ord: minOrd - 1 }); toast('⬆️ اول فهرست شد'); }
    else if (a === 'delete') { if (!confirm('حذف شود؟')) return; await store.removeInfo(i.uid); toast('حذف شد'); }
    await reloadInfos(); autoSync();
  } catch (e) { toast('خطا: ' + e.message); }
});

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
  $('#pin-btn').textContent = editing.pinned ? '📌 برداشتن سنجاق' : '📌 سنجاق';
  const rel = related(notes, editing);
  $('#related').innerHTML = rel.length ? '<div class="sec">🔗 یادداشت‌های مرتبط</div>' + rel.map(n => `<button class="relbtn" value="open:${esc(n.uid)}" formnovalidate>${esc(fmtDate(noteDate(n)))} · ${esc(n.title)}</button>`).join('') : '';
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
    } else if (action === 'pin') {
      await store.update(n.uid, { pinned: n.pinned ? 0 : 1 }); toast(n.pinned ? 'سنجاق برداشته شد' : '📌 سنجاق شد');
    } else if (action.startsWith('open:')) {
      setTimeout(() => openEditor(action.slice(5)), 50); return;
    } else if (action === 'ai') {
      if (f.raw.value !== n.raw) await store.update(n.uid, { raw: f.raw.value });
      toast('🤖 …'); const r = await store.reclassify(n.uid); toast(r.ai_status === 'done' ? `✅ ${r.category}` : '⚠️ ' + aiErr(r.ai_error));
    } else if (action === 'copy') {
      toast(await copyText(n.raw) ? '✅ کپی شد' : 'کپی نشد');
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
// providerId -> { list, filter, onlyOk, tests: { model: {status, ms, error} } }; kept in localStorage so the cards stay after reopening
const modelState = (() => { try { return JSON.parse(localStorage.getItem('sn_models') || '{}'); } catch { return {}; } })();
const saveModels = () => { try { const keep = {}; for (const [k, v] of Object.entries(modelState)) if (v.list) keep[k] = { list: v.list, onlyOk: v.onlyOk, tests: Object.fromEntries(Object.entries(v.tests || {}).filter(([, t]) => t.status !== 'testing')) }; localStorage.setItem('sn_models', JSON.stringify(keep)); } catch {} };
async function loadSettings() {
  try { settings = await store.getSettings(); } catch { return; }
  renderProviders();
  // key saved but no cards yet -> fetch the list automatically
  settings.providers.filter(p => p.hasKey && !modelState[p.id]).forEach(p => fetchModels(p));
  $('#logout').hidden = !settings.auth;
  $('#version').textContent = (isApp ? 'اپ اندروید' : 'پنل وب') + ' · Smart Notes v4.3';
  if (!isApp) {
    $('#server-web').hidden = false;
    fetch('/api/info').then(r => r.json()).then(i => $('#version').textContent = 'پنل وب · Smart Notes v' + i.version).catch(() => {});
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
    <div class="row" style="margin:4px 0"><button data-models class="primary">${modelState[p.id]?.list ? '🔄 به‌روزرسانی فهرست مدل‌ها' : '🔎 دریافت مدل‌ها'}</button></div>
    <div data-cards>${modelCards(p)}</div>
  </div>`).join('');
  $$('#providers .provider').forEach(el => {
    const p = settings.providers[el.dataset.i];
    el.querySelectorAll('[data-k]').forEach(inp => inp.oninput = () => {
      p[inp.dataset.k] = inp.value;
      if (inp.dataset.k === 'kind') { Object.assign(p, DEFAULT_PROVIDERS[inp.value], { model: '' }); delete modelState[p.id]; saveModels(); renderProviders(); }
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
  const o = el.querySelector('[data-onlyok]'); if (o) o.onchange = () => { st.onlyOk = o.checked; rerenderCards(p); saveModels(); };
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
  saveModels(); renderProviders();
}
async function testOne(p, id) {
  const st = modelState[p.id]; st.tests[id] = { status: 'testing' }; rerenderCards(p);
  try { const r = await store.testModel({ ...p }, id); st.tests[id] = r.ok ? { status: 'ok', ms: r.ms } : { status: 'bad', error: r.error }; }
  catch (e) { st.tests[id] = { status: 'bad', error: e.message }; }
  rerenderCards(p); saveModels();
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
$('#copy-token').onclick = async () => {
  const b = $('#copy-token'); const ok = await copyText($('#sync-token').value, $('#sync-token'));
  b.textContent = ok ? '✅ کپی شد' : '❌ کپی نشد'; b.classList.toggle('primary', ok); toast(ok ? '✅ توکن کپی شد' : 'کپی نشد؛ توکن انتخاب شده، Ctrl+C بزنید');
  clearTimeout(b.t); b.t = setTimeout(() => { b.textContent = 'کپی'; b.classList.remove('primary'); }, 2500);
};
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
    await store.sync(); notes = (await store.all()).sort(byDate); await reloadInfos(); render(); updateBadge();
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
$('#copy-export').onclick = async () => toast(await copyText($('#export-text').value, $('#export-text')) ? '✅ کپی شد' : 'کپی نشد؛ متن انتخاب شده، دستی کپی کنید');
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
  renderFilters(); await reload(); updateBadge();
  if (isApp) { autoSync(); store.retryPending().then(n => n && reload()); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) return; isApp ? autoSync() : reload(); });
  setInterval(() => { if (document.hidden || $('#editor').open || $('#info-editor').open) return; isApp ? autoSync() : reload(); }, isApp ? 60000 : 30000);
})();
