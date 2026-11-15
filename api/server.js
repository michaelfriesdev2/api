'use strict';

/**
 * Baza Wiedzy – API (VPS)
 * Node.js + Express + Multer + JWT
 *  - logowanie (JWT), hasła hashowane scryptem (wbudowane w Node)
 *  - kategorie służb ratunkowych (dodawanie / edycja / usuwanie)
 *  - upload plików do uploads/<kategoria>/, metadane w data/db.json
 *  - CORS otwarty, żeby frontend (np. na Cloudflare Pages) mógł wołać API cross-origin
 * Frontend hostujesz OSOBNO (folder ../frontend). Możesz też opcjonalnie go serwować
 * z tego API ustawiając FRONTEND_DIR.
 */

const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const VERSION = '1.0.0';

// --------------------------------------------------------------- config
const PORT = parseInt(process.env.PORT, 10) || 6767;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE, 10) || (200 * 1024 * 1024);
const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY || '7d';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
// Panel admina serwowany z tego API – login-gated, dostępny pod ip:PORT
const ADMIN_DIR = path.join(__dirname, 'admin');
const FRONTEND_DIR = process.env.FRONTEND_DIR || (fs.existsSync(ADMIN_DIR) ? ADMIN_DIR : '');
const ICONS_DIR = path.join(__dirname, 'icons');

// --------------------------------------------------------------- utils
function uid(prefix) {
  return (prefix || 'id') + '-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}
function slugify(name) {
  return String(name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || ('kat-' + crypto.randomBytes(3).toString('hex'));
}
function sanitizeFilename(name) { return String(name).replace(/[^A-Za-z0-9.\-_]+/g, '_').slice(0, 120); }
function genPassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(12);
  let p = '';
  for (let i = 0; i < 12; i++) p += chars[b[i] % chars.length];
  return p;
}

// --------------------------------------------------------------- db (JSON)
let db = null, saveScheduled = false;
const DEFAULT_CATEGORIES = [
  { name: 'Straż pożarna', icon: '🔥', color: '#f87189' },
  { name: 'Policja',       icon: '🚓', color: '#8b9bff' },
  { name: 'Pogotowie',     icon: '🚑', color: '#5eead4' },
  { name: 'Pomoc drogowa', icon: '🚛', color: '#f5b85c' },
  { name: 'WOPR',          icon: '🛟', color: '#56cfe1' },
  { name: 'GOPR',          icon: '⛰️', color: '#a3b0ff' },
  { name: 'TOPR',          icon: '🏔️', color: '#b8a3ff' },
  { name: 'Ogólne',        icon: '📁', color: '#8c95a8' },
  { name: 'Inne',          icon: '📦', color: '#7a8397' }
];

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(path.join(UPLOAD_DIR, '_tmp'), { recursive: true });
  await fsp.mkdir(ICONS_DIR, { recursive: true });
}
async function loadDb() {
  try { db = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8')); }
  catch (e) { db = { config: {}, users: [], categories: [], files: [] }; await initDefaults(); }
  if (!db.config) db.config = {};
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.categories)) db.categories = [];
  if (!Array.isArray(db.files)) db.files = [];
  if (!db.config.jwtSecret) db.config.jwtSecret = crypto.randomBytes(48).toString('hex');
  if (db.config.requireAuthToView === undefined) db.config.requireAuthToView = false;
  await persist();
}
function scheduleSave() { if (saveScheduled) return; saveScheduled = true; setImmediate(async () => { saveScheduled = false; await persist(); }); }
async function persist() {
  try { const tmp = DATA_FILE + '.tmp'; await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8'); await fsp.rename(tmp, DATA_FILE); }
  catch (e) { console.error('Błąd zapisu bazy:', e.message); }
}
async function initDefaults() {
  for (const c of DEFAULT_CATEGORIES) db.categories.push({ id: uid('cat'), name: c.name, slug: slugify(c.name), icon: c.icon, color: c.color, createdAt: Date.now() });
  const password = process.env.ADMIN_PASSWORD || genPassword();
  await createUser(ADMIN_USERNAME, password, 'admin');
  if (!process.env.ADMIN_PASSWORD) {
    console.log('\n========================================================');
    console.log('  Utworzono konto administratora');
    console.log('  login: ' + ADMIN_USERNAME);
    console.log('  hasło: ' + password);
    console.log('  >>> Zmień hasło po pierwszym logowaniu! <<<');
    console.log('========================================================\n');
  } else {
    console.log('Konto admin utworzone z ADMIN_PASSWORD (login: ' + ADMIN_USERNAME + ')');
  }
}

// --------------------------------------------------------------- hasła (scrypt)
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return { hash: hash.toString('hex'), salt: salt.toString('hex') };
}
function verifyPassword(password, store) {
  if (!store) return false;
  try { const salt = Buffer.from(store.salt, 'hex'); const hash = Buffer.from(store.hash, 'hex'); const test = crypto.scryptSync(password, salt, 64); return crypto.timingSafeEqual(test, hash); }
  catch (e) { return false; }
}
async function createUser(username, password, role) {
  const user = { id: uid('usr'), username: String(username), role: role || 'user', password: await hashPassword(password), createdAt: Date.now() };
  db.users.push(user); return user;
}

// --------------------------------------------------------------- auth
function makeToken(user) { return jwt.sign({ sub: user.id, username: user.username, role: user.role }, db.config.jwtSecret, { expiresIn: TOKEN_EXPIRY }); }
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Brak tokenu.' });
  try { req.user = jwt.verify(token, db.config.jwtSecret); next(); }
  catch (e) { return res.status(401).json({ error: 'Token nieprawidłowy lub wygasł.' }); }
}
function softAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) { try { req.user = jwt.verify(header.slice(7), db.config.jwtSecret); } catch (e) {} }
  next();
}
function viewGuard(req, res, next) {
  if (db.config.requireAuthToView && !req.user) return res.status(401).json({ error: 'Wymagane logowanie.' });
  next();
}
const loginAttempts = new Map();
function loginThrottle(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || now - rec.first > 15 * 60 * 1000) rec = { count: 0, first: now };
  rec.count++; loginAttempts.set(ip, rec);
  if (rec.count > 10) return res.status(429).json({ error: 'Zbyt wiele prób logowania. Spróbuj później.' });
  next();
}

// --------------------------------------------------------------- multer
const storage = multer.diskStorage({
  destination: async (req, file, cb) => { const dir = path.join(UPLOAD_DIR, '_tmp'); try { await fsp.mkdir(dir, { recursive: true }); cb(null, dir); } catch (e) { cb(e); } },
  filename: (req, file, cb) => { const ext = path.extname(file.originalname); const base = sanitizeFilename(path.basename(file.originalname, ext)) || 'plik'; cb(null, uid('f') + '_' + base + ext); }
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// --------------------------------------------------------------- helpers
function publicUser(u) { return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt }; }
function decorateFile(f, req) {
  const cat = db.categories.find(c => c.slug === f.category);
  return {
    id: f.id, title: f.title, description: f.description, originalName: f.originalName,
    size: f.size, mimetype: f.mimetype, uploadedAt: f.uploadedAt, uploader: f.uploader, category: f.category,
    tags: Array.isArray(f.tags) ? f.tags : [],
    categoryName: cat ? cat.name : 'Bez kategorii',
    categoryIcon: cat ? cat.icon : '📦',
    categoryIconUrl: cat ? (cat.iconUrl || null) : null,
    categoryColor: cat ? cat.color : '#8c95a8',
    canDelete: !!(req.user && (req.user.role === 'admin' || req.user.username === f.uploader))
  };
}

// --------------------------------------------------------------- app
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS (token w nagłówku, nie ciasteczka – bezpieczne dla osobistego API)
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.set('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// status API
app.get('/api', (req, res) => res.json({ name: 'Baza Wiedzy API', version: VERSION, status: 'ok' }));

// ---- auth ----
app.post('/api/auth/login', loginThrottle, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Podaj login i hasło.' });
  const user = db.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });
  res.json({ token: makeToken(user), user: publicUser(user) });
});
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.users.find(u => u.id === req.user.sub);
  if (!user) return res.status(404).json({ error: 'Nie znaleziono użytkownika.' });
  res.json({ user: publicUser(user) });
});
app.post('/api/auth/password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'Nowe hasło min. 6 znaków.' });
  const user = db.users.find(u => u.id === req.user.sub);
  if (!user) return res.status(404).json({ error: 'Nie znaleziono użytkownika.' });
  if (!verifyPassword(oldPassword || '', user.password)) return res.status(401).json({ error: 'Stare hasło nieprawidłowe.' });
  user.password = await hashPassword(String(newPassword)); scheduleSave(); res.json({ ok: true });
});

// ---- categories ----
app.get('/api/categories', softAuth, viewGuard, (req, res) => res.json({ categories: db.categories, uncategorizedCount: db.files.filter(f => !f.category).length }));
app.post('/api/categories', authMiddleware, (req, res) => {
  const { name, icon, color, iconUrl } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Podaj nazwę kategorii.' });
  let slug = slugify(name);
  if (db.categories.some(c => c.slug === slug)) slug = slug + '-' + crypto.randomBytes(2).toString('hex');
  const cat = { id: uid('cat'), name: String(name).trim(), slug, icon: (icon || '📦').slice(0, 4), color: (color || '#8b9bff').slice(0, 9), iconUrl: iconUrl || null, createdAt: Date.now() };
  db.categories.push(cat); scheduleSave(); res.json({ category: cat });
});
app.patch('/api/categories/:id', authMiddleware, (req, res) => {
  const cat = db.categories.find(c => c.id === req.params.id || c.slug === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Nie znaleziono kategorii.' });
  const { name, icon, color, iconUrl } = req.body || {};
  if (name) cat.name = String(name).trim();
  if (icon) cat.icon = String(icon).slice(0, 4);
  if (color) cat.color = String(color).slice(0, 9);
  if (iconUrl !== undefined) cat.iconUrl = iconUrl || null; // null = usuń ikonę SVG
  scheduleSave(); res.json({ category: cat });
});
app.delete('/api/categories/:id', authMiddleware, (req, res) => {
  const idx = db.categories.findIndex(c => c.id === req.params.id || c.slug === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Nie znaleziono kategorii.' });
  const cat = db.categories[idx];
  for (const f of db.files) if (f.category === cat.slug) f.category = '';
  db.categories.splice(idx, 1); scheduleSave(); res.json({ ok: true });
});

// ---- files ----
app.get('/api/tags', softAuth, viewGuard, (req, res) => {
  const counts = {};
  for (const f of db.files) {
    for (const t of (Array.isArray(f.tags) ? f.tags : [])) {
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  const tags = Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  res.json({ tags });
});

app.get('/api/files', softAuth, viewGuard, (req, res) => {
  let files = db.files.slice().sort((a, b) => b.uploadedAt - a.uploadedAt);
  const { category, q, tag } = req.query;
  if (category && category !== 'all') {
    if (category === 'none') files = files.filter(f => !f.category);
    else files = files.filter(f => f.category === category);
  }
  if (tag) {
    const tagLower = String(tag).toLowerCase().trim();
    files = files.filter(f => Array.isArray(f.tags) && f.tags.includes(tagLower));
  }
  if (q) {
    const t = String(q).toLowerCase();
    files = files.filter(f => (f.title || '').toLowerCase().includes(t) || (f.originalName || '').toLowerCase().includes(t) || (f.description || '').toLowerCase().includes(t));
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const total = files.length;
  const slice = files.slice((page - 1) * limit, page * limit);
  res.json({ total, page, limit, files: slice.map(f => decorateFile(f, req)) });
});
app.get('/api/files/:id', softAuth, viewGuard, (req, res) => {
  const f = db.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Nie znaleziono pliku.' });
  res.json({ file: decorateFile(f, req) });
});
app.get('/api/files/:id/download', softAuth, viewGuard, (req, res) => {
  const f = db.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Nie znaleziono pliku.' });
  const filePath = path.join(UPLOAD_DIR, f.storedPath);
  fs.stat(filePath, (err) => {
    if (err) return res.status(404).json({ error: 'Plik nie istnieje na dysku.' });
    // licznik pobrań
    const today = new Date().toISOString().slice(0, 10);
    if (!db.downloads) db.downloads = { total: 0, daily: {} };
    db.downloads.total = (db.downloads.total || 0) + 1;
    db.downloads.daily[today] = (db.downloads.daily[today] || 0) + 1;
    // ogranicz historię do 90 dni
    const days = Object.keys(db.downloads.daily).sort();
    if (days.length > 90) days.slice(0, days.length - 90).forEach(d => delete db.downloads.daily[d]);
    scheduleSave();
    res.download(filePath, f.originalName);
  });
});

// view – serwuje plik inline (do podglądu w przeglądarce / miniaturki)
app.get('/api/files/:id/view', softAuth, viewGuard, (req, res) => {
  const f = db.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Nie znaleziono pliku.' });
  const filePath = path.join(UPLOAD_DIR, f.storedPath);
  fs.stat(filePath, (err) => {
    if (err) return res.status(404).json({ error: 'Plik nie istnieje na dysku.' });
    res.set('Content-Type', f.mimetype || 'application/octet-stream');
    res.set('Content-Disposition', 'inline; filename="' + encodeURIComponent(f.originalName) + '"');
    res.set('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(filePath).pipe(res);
  });
});
app.post('/api/files', authMiddleware, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) { if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Plik za duży (max ' + Math.round(MAX_FILE_SIZE / 1048576) + ' MB).' }); return res.status(400).json({ error: err.message || 'Błąd uploadu.' }); }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Brak pliku (pole formularza "file").' });
  const category = (req.body.category || '').trim();
  if (category && !db.categories.some(c => c.slug === category)) { try { await fsp.unlink(req.file.path); } catch (e) {} return res.status(400).json({ error: 'Nieznana kategoria: ' + category }); }
  try {
    const catFolder = category || '_bez_kategorii';
    const destDir = path.join(UPLOAD_DIR, catFolder);
    await fsp.mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, req.file.filename);
    await fsp.rename(req.file.path, destPath);
    const rel = path.relative(UPLOAD_DIR, destPath).replace(/\\/g, '/');
    const rawTags = (req.body.tags || '').trim();
    const tags = rawTags
      ? rawTags.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0 && t.length <= 32).slice(0, 20)
      : [];
    const rec = { id: uid('file'), originalName: req.file.originalname, storedName: req.file.filename, storedPath: rel, category: category || '', title: (req.body.title || '').trim() || req.file.originalname, description: (req.body.description || '').trim(), tags, size: req.file.size, mimetype: req.file.mimetype, uploadedAt: Date.now(), uploader: req.user.username };
    db.files.push(rec); scheduleSave(); res.status(201).json({ file: decorateFile(rec, req) });
  } catch (e) { try { await fsp.unlink(req.file.path); } catch (err) {} res.status(500).json({ error: 'Błąd zapisu pliku: ' + e.message }); }
});
app.delete('/api/files/:id', authMiddleware, async (req, res) => {
  const idx = db.files.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Nie znaleziono pliku.' });
  const f = db.files[idx];
  try { await fsp.unlink(path.join(UPLOAD_DIR, f.storedPath)); } catch (e) {}
  db.files.splice(idx, 1); scheduleSave(); res.json({ ok: true });
});

// ---- counters (publiczne, bez auth) ----
app.get('/api/counters/:key', (req, res) => {
  const key = req.params.key;
  if (!db.counters) db.counters = {};
  const c = db.counters[key] || { total: 0, daily: {} };
  const today = new Date().toISOString().slice(0, 10);
  res.json({ key, total: c.total || 0, today: c.daily[today] || 0 });
});

app.post('/api/counters/:key', (req, res) => {
  const key = req.params.key;
  if (!/^[a-z0-9_-]{1,40}$/.test(key)) return res.status(400).json({ error: 'Nieprawidłowy klucz.' });
  if (!db.counters) db.counters = {};
  if (!db.counters[key]) db.counters[key] = { total: 0, daily: {} };
  const today = new Date().toISOString().slice(0, 10);
  db.counters[key].total = (db.counters[key].total || 0) + 1;
  db.counters[key].daily[today] = (db.counters[key].daily[today] || 0) + 1;
  // ogranicz historię do 90 dni
  const days = Object.keys(db.counters[key].daily).sort();
  if (days.length > 90) days.slice(0, days.length - 90).forEach(d => delete db.counters[key].daily[d]);
  scheduleSave();
  res.json({ key, total: db.counters[key].total, today: db.counters[key].daily[today] });
});

// ---- stats / config ----
app.get('/api/stats', softAuth, viewGuard, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const dl = db.downloads || { total: 0, daily: {} };
  res.json({
    files: db.files.length,
    categories: db.categories.length,
    totalSize: db.files.reduce((s, f) => s + (f.size || 0), 0),
    requireAuthToView: !!db.config.requireAuthToView,
    loggedIn: !!req.user,
    downloadsTotal: dl.total || 0,
    downloadsToday: dl.daily[today] || 0
  });
});
app.patch('/api/config', authMiddleware, (req, res) => {
  const { requireAuthToView } = req.body || {};
  if (typeof requireAuthToView === 'boolean') db.config.requireAuthToView = requireAuthToView;
  scheduleSave(); res.json({ config: db.config });
});

// ---- icons ----
const iconStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ICONS_DIR),
  filename: (req, file, cb) => {
    const base = sanitizeFilename(path.basename(file.originalname, '.svg')) || 'icon';
    cb(null, uid('ico') + '_' + base + '.svg');
  }
});
const uploadIcon = multer({
  storage: iconStorage,
  limits: { fileSize: 512 * 1024 }, // max 512 KB na SVG
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'image/svg+xml' || file.originalname.toLowerCase().endsWith('.svg');
    cb(ok ? null : new Error('Tylko pliki SVG.'), ok);
  }
});

// lista ikon
app.get('/api/icons', softAuth, async (req, res) => {
  try {
    const files = await fsp.readdir(ICONS_DIR);
    const icons = files.filter(f => f.endsWith('.svg')).map(f => ({
      id: f,
      name: f.replace(/^ico-[a-z0-9]+-/, '').replace(/\.svg$/, ''),
      url: '/api/icons/' + encodeURIComponent(f)
    }));
    res.json({ icons });
  } catch (e) { res.json({ icons: [] }); }
});

// serwuj plik SVG
app.get('/api/icons/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // zapobiegaj path traversal
  const filePath = path.join(ICONS_DIR, filename);
  if (!filename.endsWith('.svg')) return res.status(400).json({ error: 'Tylko SVG.' });
  fs.stat(filePath, (err) => {
    if (err) return res.status(404).json({ error: 'Nie znaleziono ikony.' });
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(filePath).pipe(res);
  });
});

// upload SVG
app.post('/api/icons', authMiddleware, (req, res) => {
  uploadIcon.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Błąd uploadu.' });
    if (!req.file) return res.status(400).json({ error: 'Brak pliku SVG.' });
    res.status(201).json({
      icon: {
        id: req.file.filename,
        name: req.file.filename.replace(/^ico-[a-z0-9]+-/, '').replace(/\.svg$/, ''),
        url: '/api/icons/' + encodeURIComponent(req.file.filename)
      }
    });
  });
});

// usuń ikonę
app.delete('/api/icons/:filename', authMiddleware, async (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename.endsWith('.svg')) return res.status(400).json({ error: 'Tylko SVG.' });
  try {
    await fsp.unlink(path.join(ICONS_DIR, filename));
    res.json({ ok: true });
  } catch (e) { res.status(404).json({ error: 'Nie znaleziono ikony.' }); }
});

// 404 API
app.use('/api', (req, res) => res.status(404).json({ error: 'Nie znaleziono endpointu.' }));

// opcjonalnie: serwuj frontend (np. do testów na VPS bez Cloudflare)
if (FRONTEND_DIR && fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR, { maxAge: '1h' }));
  app.get('*', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));
} else {
  app.get('/', (req, res) => res.json({ name: 'Baza Wiedzy API', version: VERSION, status: 'ok', note: 'Frontend hostuj osobno (Cloudflare Pages). Ustaw apiBase w frontend/config.js na adres tego API.' }));
}

// --------------------------------------------------------------- start
(async () => {
  await ensureDirs();
  await loadDb();
  app.listen(PORT, HOST, () => {
    console.log('Baza Wiedzy API działa:');
    console.log('  http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
    console.log('  pliki: ' + UPLOAD_DIR);
    console.log('  max:   ' + Math.round(MAX_FILE_SIZE / 1048576) + ' MB / plik');
    if (FRONTEND_DIR) console.log('  frontend: ' + FRONTEND_DIR);
  });
})();

process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
