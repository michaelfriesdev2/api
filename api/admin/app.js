'use strict';

/* ============================================================
   Baza Wiedzy – Panel admina (VPS, ip:6767)
   Logowanie + upload (z tagami) + kategorie (z ikonami SVG) +
   usuwanie + ustawienia.
   API w tym samym źródle (apiBase = '').
   ============================================================ */

const TOKEN_KEY = 'bw_admin_token';
const USER_KEY  = 'bw_admin_user';

const state = {
  token:      localStorage.getItem(TOKEN_KEY) || null,
  user:       JSON.parse(localStorage.getItem(USER_KEY) || 'null'),
  categories: [],
  files:      [],
  icons:      [],
  filterCat:  'all',
  search:     ''
};

/* ---------- API (same origin) ---------- */
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const isForm = opts.body instanceof FormData;
  if (opts.body && !isForm && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  let data = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    try { data = await res.json(); } catch (e) {}
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- utils ---------- */
function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function fmtSize(b) {
  if (!b && b !== 0) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 && i > 0 ? 1 : 0)) + ' ' + u[i];
}
function fmtDate(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  return d.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
         ' ' + d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}
function iconForMime(mime, name) {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return '🖼️';
  if (m.startsWith('video/')) return '🎬';
  if (m.startsWith('audio/')) return '🎵';
  if (m.includes('pdf')) return '📄';
  if (m.includes('zip') || m.includes('compressed') || m.includes('rar') || m.includes('7z')) return '🗜️';
  if (m.includes('word') || m.includes('document')) return '📝';
  if (m.includes('sheet') || m.includes('excel') || m.includes('csv')) return '📊';
  if (m.includes('presentation') || m.includes('powerpoint')) return '📽️';
  if (m.startsWith('text/') || m.includes('json') || m.includes('xml')) return '📃';
  const ext = (name || '').split('.').pop().toLowerCase();
  if (['doc', 'docx', 'rtf'].includes(ext)) return '📝';
  if (['xls', 'xlsx'].includes(ext)) return '📊';
  if (['ppt', 'pptx'].includes(ext)) return '📽️';
  if (['txt', 'log', 'md'].includes(ext)) return '📃';
  return '📎';
}
function toast(msg, type) {
  const stack = el('toastStack');
  const t = document.createElement('div');
  t.className = 'toast ' + (type || '');
  t.textContent = msg;
  stack.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 200); }, 3000);
}

/* ---------- auth ---------- */
function saveAuth(token, user) {
  state.token = token; state.user = user;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
function clearAuth() {
  state.token = null; state.user = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
function showGate()  { el('gate').style.display = 'flex'; el('panel').hidden = true; }
function showPanel() {
  el('gate').style.display = 'none'; el('panel').hidden = false;
  if (state.user) el('adminName').textContent = state.user.username;
  loadAll();
}

async function boot() {
  bindGate();
  bindPanel();
  if (state.token) {
    try {
      const d = await api('/api/auth/me');
      state.user = d.user;
      saveAuth(state.token, d.user);
      showPanel();
    } catch (e) { clearAuth(); showGate(); }
  } else { showGate(); }
}

function bindGate() {
  el('gateSubmit').addEventListener('click', doLogin);
  el('gatePass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  el('gateUser').addEventListener('keydown', e => { if (e.key === 'Enter') el('gatePass').focus(); });
}
async function doLogin() {
  const username = el('gateUser').value.trim(), password = el('gatePass').value;
  el('gateError').innerHTML = '';
  const btn = el('gateSubmit'); btn.disabled = true; btn.textContent = 'Logowanie…';
  try {
    const d = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    saveAuth(d.token, d.user);
    el('gatePass').value = '';
    showPanel();
    toast('Zalogowano: ' + d.user.username, 'ok');
  } catch (e) {
    el('gateError').innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  } finally {
    btn.disabled = false; btn.textContent = 'Zaloguj';
  }
}

/* ---------- load all ---------- */
async function loadAll() {
  await loadStats();
  await loadIcons();
  await loadCategories();
  await loadFiles();
}

/* ---------- stats ---------- */
async function loadStats() {
  try { const d = await api('/api/stats'); renderStats(d); } catch (e) { /* ignore */ }
}
function renderStats(s) {
  el('statsGrid').innerHTML =
    stat('📁', s.files, 'Plików') +
    stat('🗂️', s.categories, 'Kategorii') +
    stat('💾', fmtSize(s.totalSize), 'Rozmiar');
  el('cfgRequireView').checked = !!s.requireAuthToView;
}
function stat(ico, v, l) {
  return '<div class="stat"><div class="v">' + ico + ' ' + esc(String(v)) + '</div><div class="l">' + esc(l) + '</div></div>';
}

/* ---------- icons ---------- */
async function loadIcons() {
  try {
    const d = await api('/api/icons');
    state.icons = d.icons || [];
  } catch (e) { state.icons = []; }
  renderIconsGrid();
  renderIconPicker();
}

function renderIconsGrid() {
  const grid = el('iconsGrid');
  if (!state.icons.length) {
    grid.innerHTML = '<div style="color:var(--faint);font-size:13px;padding:6px 0">Brak ikon.</div>';
    return;
  }
  grid.innerHTML = state.icons.map(ico =>
    '<div class="icon-item">' +
      '<img src="' + esc(ico.url) + '" alt="' + esc(ico.name) + '">' +
      '<span>' + esc(ico.name) + '</span>' +
      '<button class="icon-action danger" data-del-icon="' + esc(ico.id) + '" title="Usuń ikonę">' +
        '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>' +
      '</button>' +
    '</div>'
  ).join('');
  grid.querySelectorAll('[data-del-icon]').forEach(btn =>
    btn.addEventListener('click', () => delIcon(btn.dataset.delIcon))
  );
}

function renderIconPicker() {
  const picker = el('catIconPicker');
  const selectedUrl = el('catIconUrl').value;
  if (!state.icons.length) {
    picker.innerHTML = '<div class="icon-picker-empty">Brak ikon – wgraj SVG powyżej</div>';
    return;
  }
  picker.innerHTML = state.icons.map(ico =>
    '<button type="button" class="icon-pick-btn' + (selectedUrl === ico.url ? ' selected' : '') + '" data-url="' + esc(ico.url) + '" data-id="' + esc(ico.id) + '" title="' + esc(ico.name) + '">' +
      '<img src="' + esc(ico.url) + '" alt="' + esc(ico.name) + '">' +
    '</button>'
  ).join('');
  picker.querySelectorAll('.icon-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = btn.dataset.url;
      if (el('catIconUrl').value === url) {
        // odznacz
        el('catIconUrl').value = '';
        btn.classList.remove('selected');
      } else {
        // zaznacz nowy
        picker.querySelectorAll('.icon-pick-btn').forEach(b => b.classList.remove('selected'));
        el('catIconUrl').value = url;
        btn.classList.add('selected');
      }
    });
  });
}

async function delIcon(id) {
  if (!confirm('Usunąć tę ikonę?')) return;
  try {
    await api('/api/icons/' + encodeURIComponent(id), { method: 'DELETE' });
    toast('Ikona usunięta.', 'ok');
    // jeśli usunięta ikona była wybrana – wyczyść pole
    const url = '/api/icons/' + encodeURIComponent(id);
    if (el('catIconUrl').value === url || el('catIconUrl').value.endsWith('/' + id)) {
      el('catIconUrl').value = '';
    }
    await loadIcons();
  } catch (e) { toast(e.message, 'danger'); }
}

/* ---------- categories ---------- */
async function loadCategories() {
  try { const d = await api('/api/categories'); state.categories = d.categories || []; }
  catch (e) { state.categories = []; }
  renderCatList();
  renderCatSelects();
}
function renderCatSelects() {
  const opts = '<option value="">— bez kategorii —</option>' +
    state.categories.map(c =>
      '<option value="' + esc(c.slug) + '">' + esc(c.icon) + ' ' + esc(c.name) + '</option>'
    ).join('');
  el('upCat').innerHTML = opts;
  const f = el('filterCat');
  const cur = state.filterCat;
  f.innerHTML =
    '<option value="all">Wszystkie kategorie</option>' +
    state.categories.map(c =>
      '<option value="' + esc(c.slug) + '"' + (cur === c.slug ? ' selected' : '') + '>' +
      esc(c.icon) + ' ' + esc(c.name) + '</option>'
    ).join('') +
    (cur === 'none'
      ? '<option value="none" selected>Bez kategorii</option>'
      : '<option value="none">Bez kategorii</option>');
  f.value = cur;
}
function renderCatList() {
  const list = el('catList');
  if (!state.categories.length) {
    list.innerHTML = '<div style="color:var(--faint);font-size:13px;padding:6px 0">Brak kategorii.</div>';
    return;
  }
  list.innerHTML = state.categories.map(c => {
    const icoHtml = c.iconUrl
      ? '<img src="' + esc(c.iconUrl) + '" class="cat-svg-ico" alt="">'
      : '<span class="c-ico">' + esc(c.icon) + '</span>';
    return '<div class="cat-row">' + icoHtml +
      '<div><div class="c-name">' + esc(c.name) + '</div><div class="c-slug">' + esc(c.slug) + '</div></div>' +
      '<button class="icon-action danger" data-del-cat="' + esc(c.id) + '" title="Usuń kategorię">' +
        '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>' +
      '</button>' +
    '</div>';
  }).join('');
  list.querySelectorAll('[data-del-cat]').forEach(b =>
    b.addEventListener('click', () => delCat(b.dataset.delCat))
  );
}

/* ---------- files ---------- */
async function loadFiles() {
  let url = '/api/files?limit=500';
  if (state.filterCat && state.filterCat !== 'all') url += '&category=' + encodeURIComponent(state.filterCat);
  if (state.search) url += '&q=' + encodeURIComponent(state.search);
  try { const d = await api(url); state.files = d.files || []; }
  catch (e) { state.files = []; }
  renderFiles();
}
function renderFiles() {
  const body = el('filesBody'), empty = el('emptyState');
  el('filesCount').textContent = '(' + state.files.length + ')';
  if (!state.files.length) {
    body.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = '<div class="big">📂</div>' +
      (state.search ? 'Brak wyników.' : 'Brak plików. Wyślij pierwszy plik powyżej.');
    return;
  }
  empty.hidden = true;
  body.innerHTML = state.files.map(f =>
    '<tr data-id="' + esc(f.id) + '">' +
      '<td>' +
        '<div class="file-name">' + iconForMime(f.mimetype, f.originalName) + ' ' + esc(f.title) + '</div>' +
        (f.description ? '<div class="file-desc">' + esc(f.description) + '</div>' : '') +
        '<div class="file-orig">' + esc(f.originalName) + '</div>' +
        (f.tags && f.tags.length
          ? '<div class="tag-list">' + f.tags.map(t => '<span class="tag-badge">' + esc(t) + '</span>').join('') + '</div>'
          : '') +
      '</td>' +
      '<td><span class="cat-chip" style="background:' + (f.categoryColor || '#242c3b') + '22;color:' + esc(f.categoryColor) + '">' +
        esc(f.categoryIcon) + ' ' + esc(f.categoryName) +
      '</span></td>' +
      '<td class="col-size">' + fmtSize(f.size) + '</td>' +
      '<td class="col-date">' + fmtDate(f.uploadedAt) + '</td>' +
      '<td class="col-actions"><div class="row-actions">' +
        '<button class="icon-action" data-act="dl" title="Pobierz"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg></button>' +
        '<button class="icon-action danger" data-act="del" title="Usuń"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>' +
      '</div></td>' +
    '</tr>'
  ).join('');
  body.querySelectorAll('tr').forEach(tr => {
    tr.querySelector('[data-act="dl"]').addEventListener('click', () => download(tr.dataset.id));
    tr.querySelector('[data-act="del"]').addEventListener('click', () => delFile(tr.dataset.id));
  });
}

async function download(id) {
  const f = state.files.find(x => x.id === id);
  try {
    const res = await fetch('/api/files/' + id + '/download', {
      headers: { Authorization: 'Bearer ' + state.token }
    });
    if (!res.ok) throw new Error('Błąd pobierania (' + res.status + ')');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = (f ? f.originalName : 'plik');
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) { toast(e.message, 'danger'); }
}
async function delFile(id) {
  if (!confirm('Usunąć ten plik z bazy i z dysku VPS?')) return;
  try {
    await api('/api/files/' + id, { method: 'DELETE' });
    toast('Plik usunięty.', 'ok');
    loadFiles(); loadStats();
  } catch (e) { toast(e.message, 'danger'); }
}

/* ---------- upload pliku ---------- */
let uploadFile = null;
function bindUpload() {
  // plik główny
  const dz = el('dropzone'), input = el('fileInput');
  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', () => setFile(input.files[0]));
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => { if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
  el('upSubmit').addEventListener('click', doUpload);

  // ikona SVG
  const idz = el('iconDropzone'), iinput = el('iconFileInput');
  idz.addEventListener('click', () => iinput.click());
  iinput.addEventListener('change', () => setIconFile(iinput.files[0]));
  ['dragenter', 'dragover'].forEach(ev => idz.addEventListener(ev, e => { e.preventDefault(); idz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => idz.addEventListener(ev, e => { e.preventDefault(); idz.classList.remove('drag'); }));
  idz.addEventListener('drop', e => {
    e.preventDefault(); idz.classList.remove('drag');
    if (e.dataTransfer.files[0]) setIconFile(e.dataTransfer.files[0]);
  });
  el('iconUpSubmit').addEventListener('click', doIconUpload);
}
function setFile(file) {
  uploadFile = file;
  el('dzName').textContent = file ? (file.name + ' · ' + fmtSize(file.size)) : '';
  if (file && !el('upTitle').value) el('upTitle').value = file.name.replace(/\.[^.]+$/, '');
}
async function doUpload() {
  el('upError').innerHTML = '';
  if (!uploadFile) { el('upError').innerHTML = '<div class="error-box">Wybierz plik.</div>'; return; }
  const fd = new FormData();
  fd.append('file', uploadFile);
  fd.append('category', el('upCat').value);
  fd.append('title', el('upTitle').value);
  fd.append('description', el('upDesc').value);
  fd.append('tags', el('upTags').value);
  const btn = el('upSubmit'); btn.disabled = true; btn.textContent = 'Wysyłanie…';
  try {
    const d = await api('/api/files', { method: 'POST', body: fd });
    toast('Wysłano: ' + d.file.title, 'ok');
    resetUpload(); loadFiles(); loadStats();
  } catch (e) {
    el('upError').innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  } finally {
    btn.disabled = false; btn.textContent = 'Wyślij plik';
  }
}
function resetUpload() {
  uploadFile = null;
  el('fileInput').value = '';
  el('dzName').textContent = '';
  el('upTitle').value = '';
  el('upDesc').value = '';
  el('upTags').value = '';
}

/* ---------- upload ikony ---------- */
let iconFile = null;
function setIconFile(file) {
  iconFile = file;
  el('iconDzName').textContent = file ? file.name : '';
}
async function doIconUpload() {
  el('iconUpError').innerHTML = '';
  if (!iconFile) { el('iconUpError').innerHTML = '<div class="error-box">Wybierz plik SVG.</div>'; return; }
  const fd = new FormData();
  fd.append('file', iconFile);
  const btn = el('iconUpSubmit'); btn.disabled = true; btn.textContent = 'Wysyłanie…';
  try {
    await api('/api/icons', { method: 'POST', body: fd });
    toast('Ikona wgrana.', 'ok');
    iconFile = null;
    el('iconFileInput').value = '';
    el('iconDzName').textContent = '';
    await loadIcons();
  } catch (e) {
    el('iconUpError').innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  } finally {
    btn.disabled = false; btn.textContent = 'Wgraj ikonę';
  }
}

/* ---------- categories CRUD ---------- */
function bindCats() { el('catAdd').addEventListener('click', addCat); }
async function addCat() {
  el('catAddError').innerHTML = '';
  const name  = el('catName').value.trim();
  const icon  = el('catIcon').value.trim() || '📦';
  const color = el('catColor').value.trim() || '#8b9bff';
  const iconUrl = el('catIconUrl').value || null;
  if (!name) { el('catAddError').innerHTML = '<div class="error-box">Podaj nazwę.</div>'; return; }
  try {
    await api('/api/categories', { method: 'POST', body: JSON.stringify({ name, icon, color, iconUrl }) });
    el('catName').value = '';
    el('catIcon').value = '📦';
    el('catColor').value = '#8b9bff';
    el('catIconUrl').value = '';
    // odznacz picker
    el('catIconPicker').querySelectorAll('.icon-pick-btn').forEach(b => b.classList.remove('selected'));
    toast('Dodano kategorię.', 'ok');
    await loadCategories();
    loadFiles();
  } catch (e) {
    el('catAddError').innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}
async function delCat(id) {
  if (!confirm('Usunąć kategorię? Pliki w niej przejdą do „Bez kategorii" (nie zostaną usunięte).')) return;
  try {
    await api('/api/categories/' + id, { method: 'DELETE' });
    toast('Kategoria usunięta.', 'ok');
    await loadCategories(); loadFiles();
  } catch (e) { toast(e.message, 'danger'); }
}

/* ---------- config ---------- */
function bindConfig() {
  el('cfgRequireView').addEventListener('change', e => setConfig({ requireAuthToView: e.target.checked }));
}
async function setConfig(body) {
  try { await api('/api/config', { method: 'PATCH', body: JSON.stringify(body) }); toast('Zapisano ustawienia.', 'ok'); }
  catch (e) { toast(e.message, 'danger'); loadStats(); }
}

/* ---------- change password ---------- */
function openPassModal() {
  openModal('zmiana hasła', `
    <div id="passError"></div>
    <div class="field"><label>Stare hasło</label><input id="passOld" type="password" autocomplete="current-password"></div>
    <div class="field"><label>Nowe hasło</label><input id="passNew" type="password" autocomplete="new-password" placeholder="min. 6 znaków"></div>
    <div class="field"><label>Powtórz hasło</label><input id="passNew2" type="password" autocomplete="new-password"></div>
  `, [
    { label: 'Anuluj', cls: '', action: closeModal },
    { label: 'Zmień hasło', cls: 'btn-primary', action: doChangePass }
  ]);
  setTimeout(() => el('passOld').focus(), 50);
}
async function doChangePass() {
  const oldPassword = el('passOld').value, newPassword = el('passNew').value, n2 = el('passNew2').value;
  el('passError').innerHTML = '';
  if (newPassword !== n2) { el('passError').innerHTML = '<div class="error-box">Hasła nie są zgodne.</div>'; return; }
  if (newPassword.length < 6) { el('passError').innerHTML = '<div class="error-box">Nowe hasło min. 6 znaków.</div>'; return; }
  try {
    await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) });
    closeModal(); toast('Hasło zmienione.', 'ok');
  } catch (e) {
    el('passError').innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

/* ---------- modal core ---------- */
function openModal(label, contentHtml, buttons) {
  el('modalLabel').textContent = label;
  el('modalContent').innerHTML = contentHtml;
  el('modalFoot').innerHTML = (buttons || []).map((b, i) =>
    '<button class="btn ' + (b.cls || '') + '" data-mb="' + i + '">' + esc(b.label) + '</button>'
  ).join('');
  (buttons || []).forEach((b, i) => {
    const node = el('modalFoot').querySelector('[data-mb="' + i + '"]');
    if (node) node.addEventListener('click', b.action);
  });
  el('modalBox').classList.add('show'); el('overlay').style.display = 'block';
}
function closeModal() {
  el('modalBox').classList.remove('show'); el('overlay').style.display = 'none';
  el('modalContent').innerHTML = ''; el('modalFoot').innerHTML = '';
}

/* ---------- bind panel ---------- */
function bindPanel() {
  bindUpload(); bindCats(); bindConfig();
  el('btnLogout').addEventListener('click', () => { clearAuth(); showGate(); toast('Wylogowano.', 'ok'); });
  el('btnPass').addEventListener('click', openPassModal);
  el('modalClose').addEventListener('click', closeModal);
  el('overlay').addEventListener('click', closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  el('searchInput').addEventListener('input', e => {
    state.search = e.target.value.trim();
    clearTimeout(window._t); window._t = setTimeout(loadFiles, 250);
  });
  el('filterCat').addEventListener('change', e => { state.filterCat = e.target.value; loadFiles(); });
}

document.addEventListener('DOMContentLoaded', boot);
