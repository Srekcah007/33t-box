const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 80;

const DATA_DIR = path.join(__dirname, 'data');
const COLLECTIONS_DIR = path.join(DATA_DIR, 'collections');
const COVERS_DIR = path.join(__dirname, 'covers');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(COLLECTIONS_DIR)) fs.mkdirSync(COLLECTIONS_DIR, { recursive: true });
if (!fs.existsSync(COVERS_DIR)) fs.mkdirSync(COVERS_DIR, { recursive: true });

// --- MIGRATION AUTOMATIQUE V1/V2 -> V3 MULTI-BASES ---
const legacyDbPath = path.join(DATA_DIR, 'vinyls.db');
const alexDbPath = path.join(COLLECTIONS_DIR, 'alex.db');
if (fs.existsSync(legacyDbPath) && !fs.existsSync(alexDbPath)) {
  console.log('Migration V2 -> V3 : Copie de data/vinyls.db vers data/collections/alex.db...');
  fs.copyFileSync(legacyDbPath, alexDbPath);
}

// --- BASE MAÎTRESSE DES UTILISATEURS & PARAMÈTRES GLOBAUX (users.db) ---
const masterDb = new Database(path.join(DATA_DIR, 'users.db'));
masterDb.pragma('journal_mode = WAL');

masterDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    password TEXT NOT NULL,
    is_super_admin INTEGER DEFAULT 0,
    avatar_color TEXT DEFAULT '#f59e0b',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invite_tokens (
    token TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    allowed_spaces TEXT DEFAULT '*',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS global_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);
try { masterDb.prepare("ALTER TABLE users ADD COLUMN visible_spaces TEXT DEFAULT '*'").run(); } catch (e) {}
try { masterDb.prepare("ALTER TABLE invite_tokens ADD COLUMN allowed_spaces TEXT DEFAULT '*'").run(); } catch (e) {}
try { masterDb.prepare("ALTER TABLE invite_tokens ADD COLUMN created_by TEXT DEFAULT NULL").run(); } catch (e) {}

// Initialisation de l'utilisateur principal Alex (en récupérant son mot de passe et token Discogs depuis alex.db si existants)
let initialAdminPass = 'admin';
let initialDiscogsToken = '';
if (fs.existsSync(alexDbPath)) {
  try {
    const tmpAlex = new Database(alexDbPath);
    const pRow = tmpAlex.prepare("SELECT value FROM settings WHERE key = 'admin_password'").get();
    if (pRow && pRow.value) initialAdminPass = pRow.value;
    const tRow = tmpAlex.prepare("SELECT value FROM settings WHERE key = 'discogs_token'").get();
    if (tRow && tRow.value) initialDiscogsToken = tRow.value;
    tmpAlex.close();
  } catch (e) {}
}

masterDb.prepare(`
  INSERT OR IGNORE INTO users (slug, name, password, is_super_admin, avatar_color)
  VALUES ('alex', 'Alex', ?, 1, '#f59e0b')
`).run(initialAdminPass);

masterDb.prepare(`
  INSERT OR IGNORE INTO global_settings (key, value) VALUES ('discogs_token', ?)
`).run(initialDiscogsToken);

// Cache de connexions SQLite par espace (slug)
const dbPool = new Map();

function sanitizeSlug(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

function getSpaceDb(slug) {
  const clean = sanitizeSlug(slug) || 'alex';
  const userExists = masterDb.prepare('SELECT slug, name FROM users WHERE slug = ?').get(clean);
  if (!userExists) return null;

  if (dbPool.has(clean)) return dbPool.get(clean);

  const dbPath = path.join(COLLECTIONS_DIR, `${clean}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS vinyls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      year INTEGER,
      release_year INTEGER,
      label TEXT,
      catalog_number TEXT,
      barcode TEXT,
      genre TEXT,
      media_type TEXT DEFAULT 'vinyl',
      format TEXT DEFAULT 'LP 12" 33T',
      condition_media TEXT DEFAULT 'NM',
      condition_sleeve TEXT DEFAULT 'NM',
      status TEXT DEFAULT 'collection',
      purchase_price REAL DEFAULT 0,
      target_price REAL DEFAULT 0,
      purchase_date TEXT,
      purchase_location TEXT,
      notes TEXT,
      cover_url TEXT,
      cover_local TEXT,
      discogs_id TEXT,
      deezer_album_id TEXT,
      wall_slot TEXT DEFAULT NULL,
      tracklist TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration douce des colonnes V3 (media_type et deezer_album_id) sur les bases existantes
  const cols = db.prepare("PRAGMA table_info(vinyls)").all().map(c => c.name);
  if (!cols.includes('media_type')) {
    db.exec("ALTER TABLE vinyls ADD COLUMN media_type TEXT DEFAULT 'vinyl'");
  }
  if (!cols.includes('deezer_album_id')) {
    db.exec("ALTER TABLE vinyls ADD COLUMN deezer_album_id TEXT DEFAULT ''");
  }

  const defaultSpaceSettings = {
    wall_rows: '2',
    wall_cols: '4',
    currency: '€',
    collection_title: clean === 'alex' ? '33T-Box' : `Collection de ${userExists.name}`
  };
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaultSpaceSettings)) {
    ins.run(k, v);
  }

  dbPool.set(clean, db);
  return db;
}

// Pré-initialiser la base d'Alex
getSpaceDb('alex');

app.use(express.json({ limit: '15mb' }));

const loginAttempts = new Map();
function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pwd), salt, 64).toString('hex');
  return 'scrypt:' + salt + ':' + hash;
}
function verifyPassword(pwd, stored) {
  if (!stored) return false;
  if (stored.startsWith('scrypt:')) {
    const [, salt, key] = stored.split(':');
    const hashBuffer = crypto.scryptSync(String(pwd), salt, 64);
    const keyBuffer = Buffer.from(key, 'hex');
    return keyBuffer.length === hashBuffer.length && crypto.timingSafeEqual(keyBuffer, hashBuffer);
  }
  return String(pwd) === String(stored);
}
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use('/covers', express.static(COVERS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Sessions actives : token -> { slug, name, is_super_admin }
const activeSessions = new Map();

function getSession(req) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token || !activeSessions.has(token)) return null;
  return activeSessions.get(token);
}

// Middleware : vérifie que l'utilisateur connecté a le droit de modifier l'espace ciblé (propriétaire de l'espace OU Super-Admin Alex)

function getInviteToken(req) {
  const tok = req.headers['x-invite-token'] || req.query.invite;
  if (!tok) return null;
  return masterDb.prepare('SELECT token, label, COALESCE(allowed_spaces, \'*\') AS allowed_spaces FROM invite_tokens WHERE token = ?').get(String(tok).trim()) || null;
}



function isSpaceAllowedForUser(session, spaceSlug) {
  if (!session) return true;
  if (session.is_super_admin) return true;
  const target = sanitizeSlug(spaceSlug || session.slug);
  if (target === session.slug) return true;
  const row = masterDb.prepare("SELECT COALESCE(visible_spaces, '*') AS visible_spaces FROM users WHERE slug = ?").get(session.slug);
  if (!row || row.visible_spaces === '*') return true;
  const allowed = row.visible_spaces.split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(target);
}

function isSpaceAllowedForInvite(invite, spaceSlug) {
  if (!invite) return true;
  if (!invite.allowed_spaces || invite.allowed_spaces === '*') return true;
  const list = invite.allowed_spaces.split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(sanitizeSlug(spaceSlug || 'alex'));
}

function requireReadAccess(req, res, next) {
  const session = getSession(req);
  if (session) {
    req.userSession = session;
    return next();
  }
  const invite = getInviteToken(req);
  if (invite) {
    req.inviteSession = invite;
    return next();
  }
  return res.status(401).json({ error: 'Accès privé : connexion ou lien d\'invitation requis.' });
}

function requireSpaceWriteAccess(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(403).json({ error: 'Non connecté. Connecte-toi à ton espace pour modifier.' });
  }
  const targetSpace = sanitizeSlug(req.query.space || req.body.space || req.headers['x-space'] || 'alex');
  if (session.slug !== targetSpace && !session.is_super_admin) {
    return res.status(403).json({ error: `Tu es connecté en tant que ${session.name} : tu ne peux modifier que ton propre espace.` });
  }
  req.userSession = session;
  req.targetSpace = targetSpace;
  next();
}

function requireSuperAdmin(req, res, next) {
  const session = getSession(req);
  if (!session || !session.is_super_admin) {
    return res.status(403).json({ error: 'Action réservée au Super-Admin (Alex).' });
  }
  req.userSession = session;
  next();
}

function getGlobalDiscogsToken() {
  const row = masterDb.prepare("SELECT value FROM global_settings WHERE key = 'discogs_token'").get();
  return row ? row.value : '';
}

function buildDiscogsAuthQuery(rawToken) {
  const t = (rawToken || '').trim();
  if (!t) return '';
  if (t.includes(':')) {
    const [k, s] = t.split(':');
    return `key=${encodeURIComponent(k.trim())}&secret=${encodeURIComponent(s.trim())}`;
  }
  return `token=${encodeURIComponent(t)}`;
}

async function downloadImage(url, destFilename) {
  if (!url || !url.startsWith('http')) return null;
  try { const u = new URL(url); if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(u.hostname)) return null; } catch (e) { return null; }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(url, {
      headers: {
        'User-Agent': '33TBoxApp/3.0 (+http://localhost)',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length < 500) return null;
    const destPath = path.join(COVERS_DIR, destFilename);
    fs.writeFileSync(destPath, buffer);
    return '/covers/' + destFilename;
  } catch (err) {
    return null;
  }
}

function cleanSearchTitle(title) {
  return (title || '')
    .replace(/Édition originale.*/i, '')
    .replace(/\(.*\)/g, '')
    .replace(/N°1/gi, '')
    .replace(/\.\.\./g, '')
    .trim();
}

// --- INTÉGRATION API DEEZER (Recherche Album, Tracklist, Previews 30s & Liens profonds) ---
async function searchDeezerAlbumAndTracks(artist, title) {
  try {
    const cleanT = cleanSearchTitle(title);
    const qStrict = encodeURIComponent(`artist:"${artist}" album:"${cleanT}"`);
    let res = await fetch(`https://api.deezer.com/search/album?q=${qStrict}&limit=5`);
    let data = res.ok ? await res.json() : { data: [] };

    if (!data.data || data.data.length === 0) {
      const qBroad = encodeURIComponent(`${artist} ${cleanT}`);
      res = await fetch(`https://api.deezer.com/search/album?q=${qBroad}&limit=5`);
      data = res.ok ? await res.json() : { data: [] };
    }
    if (!data.data || data.data.length === 0) return null;

    const album = data.data[0];
    const albumDetailRes = await fetch(`https://api.deezer.com/album/${album.id}`);
    if (!albumDetailRes.ok) return null;
    const albumFull = await albumDetailRes.json();

    const tracks = (albumFull.tracks && albumFull.tracks.data ? albumFull.tracks.data : []).map((t, idx) => {
      const min = Math.floor((t.duration || 0) / 60);
      const sec = String((t.duration || 0) % 60).padStart(2, '0');
      return {
        position: String(idx + 1),
        title: t.title_short || t.title,
        duration: t.duration ? `${min}:${sec}` : '',
        deezer_id: String(t.id),
        preview_url: t.preview || '',
        deezer_link: t.link || `https://www.deezer.com/track/${t.id}`
      };
    });

    const releaseYear = albumFull.release_date ? parseInt(albumFull.release_date.slice(0, 4), 10) : null;
    const genreName = (albumFull.genres && albumFull.genres.data && albumFull.genres.data[0])
      ? albumFull.genres.data[0].name
      : '';

    return {
      source: 'Deezer',
      external_id: `deezer_${albumFull.id}`,
      deezer_album_id: String(albumFull.id),
      artist: (albumFull.artist && albumFull.artist.name) ? albumFull.artist.name : artist,
      title: albumFull.title || title,
      release_year: releaseYear,
      label: albumFull.label || '',
      barcode: albumFull.upc || '',
      genre: genreName,
      cover_url: albumFull.cover_xl || albumFull.cover_big || '',
      tracklist: tracks
    };
  } catch (e) {
    return null;
  }
}

async function fetchDiscogsTracklist(id, type = 'release', rawToken = '') {
  if (!id) return [];
  try {
    const auth = buildDiscogsAuthQuery(rawToken);
    const endpoint = type === 'master' ? `masters/${id}` : `releases/${id}`;
    const url = `https://api.discogs.com/${endpoint}${auth ? '?' + auth : ''}`;
    const res = await fetch(url, { headers: { 'User-Agent': '33TBoxApp/3.0' } });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data.tracklist)) return [];
    return data.tracklist
      .filter(t => t.type_ !== 'heading' && t.title)
      .map((t, idx) => ({
        position: t.position || String(idx + 1),
        title: t.title,
        duration: t.duration || ''
      }));
  } catch (e) {
    return [];
  }
}

async function fetchItunesMetadataAndTracks(artist, title) {
  try {
    const cleanT = cleanSearchTitle(title);
    const q = encodeURIComponent(`${artist} ${cleanT}`);
    const res = await fetch(`https://itunes.apple.com/search?term=${q}&entity=album&limit=5`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.results || data.results.length === 0) return null;

    const col = data.results[0];
    const cover_url = col.artworkUrl100 ? col.artworkUrl100.replace('100x100bb', '600x600bb') : '';
    const year = col.releaseDate ? parseInt(col.releaseDate.slice(0, 4), 10) : null;
    const genre = col.primaryGenreName || '';

    let tracklist = [];
    if (col.collectionId) {
      const trRes = await fetch(`https://itunes.apple.com/lookup?id=${col.collectionId}&entity=song`);
      if (trRes.ok) {
        const trData = await trRes.json();
        const songs = (trData.results || []).filter(x => x.wrapperType === 'track');
        tracklist = songs.map((s, idx) => {
          const totalSec = s.trackTimeMillis ? Math.round(s.trackTimeMillis / 1000) : 0;
          const min = Math.floor(totalSec / 60);
          const sec = String(totalSec % 60).padStart(2, '0');
          return {
            position: String(s.trackNumber || idx + 1),
            title: s.trackName,
            duration: totalSec ? `${min}:${sec}` : ''
          };
        });
      }
    }

    return {
      source: 'iTunes HD',
      external_id: String(col.collectionId || ''),
      artist: col.artistName || artist,
      title: col.collectionName || title,
      release_year: year,
      label: col.copyright ? col.copyright.replace(/^℗\s*\d+\s*/, '').slice(0, 50) : '',
      genre,
      cover_url,
      tracklist
    };
  } catch (e) {
    return null;
  }
}

// Enrichir une tracklist existante avec les IDs et Previews Deezer
async function enrichTracklistWithDeezer(artist, title, tracks) {
  const dz = await searchDeezerAlbumAndTracks(artist, title);
  if (!dz) return { tracklist: tracks, deezer_album_id: '' };
  if (!tracks || tracks.length === 0) {
    return { tracklist: dz.tracklist || [], deezer_album_id: dz.deezer_album_id || '' };
  }
  const enriched = tracks.map((t, idx) => {
    const cleanName = (t.title || '').toLowerCase().trim();
    const match = (dz.tracklist || []).find(dt =>
      dt.title.toLowerCase().includes(cleanName) || cleanName.includes(dt.title.toLowerCase())
    ) || (dz.tracklist && dz.tracklist[idx]);

    return {
      ...t,
      deezer_id: match ? match.deezer_id : (t.deezer_id || ''),
      preview_url: match ? match.preview_url : (t.preview_url || ''),
      deezer_link: match ? match.deezer_link : (t.deezer_link || '')
    };
  });
  return { tracklist: enriched, deezer_album_id: dz.deezer_album_id || '' };
}


app.get('/api/invites', requireSpaceWriteAccess, (req, res) => {
  let list;
  if (req.userSession.is_super_admin) {
    list = masterDb.prepare("SELECT token, label, COALESCE(allowed_spaces, '*') AS allowed_spaces, created_by, created_at FROM invite_tokens ORDER BY created_at DESC").all();
  } else {
    list = masterDb.prepare("SELECT token, label, COALESCE(allowed_spaces, '*') AS allowed_spaces, created_by, created_at FROM invite_tokens WHERE created_by = ? ORDER BY created_at DESC").all(req.userSession.slug);
  }
  res.json({ invites: list });
});

app.post('/api/invites', requireSpaceWriteAccess, (req, res) => {
  const label = String(req.body.label || 'Invité').trim().slice(0, 60);
  let allowedSpaces;
  if (req.userSession.is_super_admin) {
    const rawSpaces = Array.isArray(req.body.allowed_spaces) ? req.body.allowed_spaces.map(sanitizeSlug).filter(Boolean) : [];
    allowedSpaces = rawSpaces.length > 0 ? rawSpaces.join(',') : '*';
  } else {
    // Un membre standard ne peut partager que son propre espace en lecture seule
    allowedSpaces = req.userSession.slug;
  }
  const token = crypto.randomBytes(18).toString('hex');
  masterDb.prepare('INSERT INTO invite_tokens (token, label, allowed_spaces, created_by) VALUES (?, ?, ?, ?)').run(token, label, allowedSpaces, req.userSession.slug);
  res.json({ ok: true, token, label, allowed_spaces: allowedSpaces, created_by: req.userSession.slug });
});

app.delete('/api/invites/:token', requireSpaceWriteAccess, (req, res) => {
  if (req.userSession.is_super_admin) {
    masterDb.prepare('DELETE FROM invite_tokens WHERE token = ?').run(req.params.token);
  } else {
    masterDb.prepare('DELETE FROM invite_tokens WHERE token = ? AND created_by = ?').run(req.params.token, req.userSession.slug);
  }
  res.json({ ok: true });
});

app.get('/api/auth/verify-invite', (req, res) => {
  const inv = getInviteToken(req);
  if (!inv) return res.status(401).json({ valid: false });
  res.json({ valid: true, label: inv.label, allowed_spaces: inv.allowed_spaces });
});

// --- ROUTES MULTI-ESPACES & UTILISATEURS ---
app.get('/api/spaces', requireReadAccess, (req, res) => {
  let users = masterDb.prepare("SELECT slug, name, is_super_admin, avatar_color, COALESCE(visible_spaces, '*') AS visible_spaces, created_at FROM users ORDER BY is_super_admin DESC, name ASC").all();
  if (req.inviteSession && req.inviteSession.allowed_spaces !== '*') {
    const allowed = req.inviteSession.allowed_spaces.split(',').map(s => s.trim()).filter(Boolean);
    users = users.filter(u => allowed.includes(u.slug));
  } else if (req.userSession && !req.userSession.is_super_admin) {
    const me = users.find(u => u.slug === req.userSession.slug);
    if (me && me.visible_spaces !== '*') {
      const allowed = me.visible_spaces.split(',').map(s => s.trim()).filter(Boolean);
      users = users.filter(u => u.slug === me.slug || allowed.includes(u.slug));
    }
  }
  const spaces = users.map(u => {
    const db = getSpaceDb(u.slug);
    let colCount = 0;
    let wishCount = 0;
    let vinylCount = 0;
    let cdCount = 0;
    let title = `Collection de ${u.name}`;
    if (db) {
      colCount = db.prepare("SELECT COUNT(*) as c FROM vinyls WHERE status = 'collection'").get().c;
      wishCount = db.prepare("SELECT COUNT(*) as c FROM vinyls WHERE status = 'wishlist'").get().c;
      vinylCount = db.prepare("SELECT COUNT(*) as c FROM vinyls WHERE status = 'collection' AND COALESCE(media_type, 'vinyl') = 'vinyl'").get().c;
      cdCount = db.prepare("SELECT COUNT(*) as c FROM vinyls WHERE status = 'collection' AND media_type = 'cd'").get().c;
      const tRow = db.prepare("SELECT value FROM settings WHERE key = 'collection_title'").get();
      if (tRow && tRow.value) title = tRow.value;
    }
    return {
      slug: u.slug,
      name: u.name,
      is_super_admin: Boolean(u.is_super_admin),
      visible_spaces: u.visible_spaces ?? '*',
      avatar_color: u.avatar_color || '#f59e0b',
      collection_title: title,
      counts: { collection: colCount, wishlist: wishCount, vinyl: vinylCount, cd: cdCount }
    };
  });
  res.json({ spaces });
});


app.put('/api/users/:slug/visibility', requireSuperAdmin, (req, res) => {
  const targetSlug = sanitizeSlug(req.params.slug);
  const rawList = Array.isArray(req.body.visible_spaces) ? req.body.visible_spaces.map(sanitizeSlug).filter(Boolean) : [];
  const val = rawList.join(',');
  masterDb.prepare('UPDATE users SET visible_spaces = ? WHERE slug = ?').run(val, targetSlug);
  res.json({ ok: true, visible_spaces: val });
});

app.post('/api/users', requireSuperAdmin, (req, res) => {
  const { name, slug, password, avatar_color } = req.body;
  const cleanSlug = sanitizeSlug(slug || name);
  if (!cleanSlug || !name || !password) {
    return res.status(400).json({ error: 'Nom, identifiant et mot de passe obligatoires.' });
  }
  const existing = masterDb.prepare('SELECT slug FROM users WHERE slug = ?').get(cleanSlug);
  if (existing) {
    return res.status(400).json({ error: 'Cet identifiant existe déjà.' });
  }
  masterDb.prepare(`
    INSERT INTO users (slug, name, password, is_super_admin, avatar_color)
    VALUES (?, ?, ?, 0, ?)
  `).run(cleanSlug, name.trim(), hashPassword(String(password).trim()), avatar_color || '#38bdf8');

  // Initialiser sa base SQLite dédiée immédiatement
  getSpaceDb(cleanSlug);
  res.json({ ok: true, slug: cleanSlug });
});

app.put('/api/users/:slug', requireSuperAdmin, (req, res) => {
  const target = sanitizeSlug(req.params.slug);
  const { name, password, avatar_color } = req.body;
  const u = masterDb.prepare('SELECT * FROM users WHERE slug = ?').get(target);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });

  masterDb.prepare(`
    UPDATE users SET name = ?, password = ?, avatar_color = ? WHERE slug = ?
  `).run(
    name ? name.trim() : u.name,
    password && String(password).trim() ? hashPassword(String(password).trim()) : u.password,
    avatar_color || u.avatar_color,
    target
  );
  res.json({ ok: true });
});

app.delete('/api/users/:slug', requireSuperAdmin, (req, res) => {
  const target = sanitizeSlug(req.params.slug);
  if (target === 'alex') {
    return res.status(400).json({ error: "Impossible de supprimer l'espace Super-Admin principal (Alex)." });
  }
  masterDb.prepare('DELETE FROM users WHERE slug = ?').run(target);
  if (dbPool.has(target)) {
    try { dbPool.get(target).close(); } catch (e) {}
    dbPool.delete(target);
  }
  const dbPath = path.join(COLLECTIONS_DIR, `${target}.db`);
  if (fs.existsSync(dbPath)) {
    fs.renameSync(dbPath, path.join(COLLECTIONS_DIR, `${target}_deleted_${Date.now()}.db.bak`));
  }
  res.json({ ok: true });
});

// --- ROUTES AUTH ---
app.post('/api/auth/login', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, resetAt: now + 900000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 900000; }
  if (rec.count >= 5) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessaie dans 15 minutes.' });
  }
  const { slug, password } = req.body;
  const cleanSlug = sanitizeSlug(slug || 'alex');
  const user = masterDb.prepare('SELECT * FROM users WHERE slug = ?').get(cleanSlug);
  if (!user || !verifyPassword(password, user.password)) {
    rec.count++;
    loginAttempts.set(ip, rec);
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
  }
  loginAttempts.delete(ip);
  if (!user.password.startsWith('scrypt:')) {
    masterDb.prepare('UPDATE users SET password = ? WHERE slug = ?').run(hashPassword(password), cleanSlug);
  }
  const token = crypto.randomBytes(24).toString('hex');
  const sessionData = {
    slug: user.slug,
    name: user.name,
    is_super_admin: Boolean(user.is_super_admin),
    avatar_color: user.avatar_color
  };
  activeSessions.set(token, sessionData);
  return res.json({ token, user: sessionData });
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) activeSessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/auth/check', (req, res) => {
  const session = getSession(req);
  res.json({ authenticated: Boolean(session), user: session || null });
});

// --- ROUTES PARAMÈTRES D'UN ESPACE ---
app.get('/api/settings/public', requireReadAccess, (req, res) => {
  if (!isSpaceAllowedForInvite(req.inviteSession, req.query.space) || !isSpaceAllowedForUser(req.userSession, req.query.space)) return res.status(403).json({ error: 'Accès non autorisé à cet espace.' });
  const space = sanitizeSlug(req.query.space || 'alex');
  const db = getSpaceDb(space) || getSpaceDb('alex');
  const getS = (k, def) => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return r ? r.value : def;
  };
  res.json({
    space,
    wall_rows: parseInt(getS('wall_rows', '2'), 10),
    wall_cols: parseInt(getS('wall_cols', '4'), 10),
    currency: getS('currency', '€'),
    collection_title: getS('collection_title', '33T-Box'),
    has_discogs_token: Boolean(getGlobalDiscogsToken())
  });
});

app.get('/api/settings/admin', requireSpaceWriteAccess, (req, res) => {
  const db = getSpaceDb(req.targetSpace);
  const getS = (k, def) => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return r ? r.value : def;
  };
  res.json({
    space: req.targetSpace,
    wall_rows: getS('wall_rows', '2'),
    wall_cols: getS('wall_cols', '4'),
    currency: getS('currency', '€'),
    collection_title: getS('collection_title', '33T-Box'),
    discogs_token: req.userSession.is_super_admin ? getGlobalDiscogsToken() : ''
  });
});

app.put('/api/settings', requireSpaceWriteAccess, (req, res) => {
  const db = getSpaceDb(req.targetSpace);
  const { wall_rows, wall_cols, currency, collection_title, discogs_token, new_password } = req.body;
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  if (wall_rows !== undefined) upsert.run('wall_rows', String(wall_rows));
  if (wall_cols !== undefined) upsert.run('wall_cols', String(wall_cols));
  if (currency !== undefined) upsert.run('currency', String(currency));
  if (collection_title !== undefined) upsert.run('collection_title', String(collection_title));

  if (req.userSession.is_super_admin && discogs_token !== undefined) {
    masterDb.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('discogs_token', ?)").run(String(discogs_token).trim());
  }
  if (new_password && String(new_password).trim().length > 0) {
    masterDb.prepare('UPDATE users SET password = ? WHERE slug = ?').run(hashPassword(String(new_password).trim()), req.targetSpace);
  }
  res.json({ ok: true });
});

// --- ROUTES DISQUES (VINYLES & CD) PAR ESPACE ---
app.get('/api/vinyls', requireReadAccess, (req, res) => {
  if (!isSpaceAllowedForInvite(req.inviteSession, req.query.space) || !isSpaceAllowedForUser(req.userSession, req.query.space)) return res.status(403).json({ error: 'Accès non autorisé à cet espace.' });
  const space = sanitizeSlug(req.query.space || 'alex');
  const db = getSpaceDb(space);
  if (!db) return res.status(404).json({ error: 'Espace introuvable' });
  const rows = db.prepare('SELECT * FROM vinyls ORDER BY artist ASC, year ASC').all();
  res.json(rows);
});


function findDuplicateMedia(db, artist, title, mediaType, excludeId = null) {
  const normArtist = String(artist || '').trim().toLowerCase();
  const normTitle = String(title || '').trim().toLowerCase();
  const normMedia = mediaType === 'cd' ? 'cd' : 'vinyl';
  const sql = excludeId
    ? "SELECT id, status FROM vinyls WHERE LOWER(TRIM(artist)) = ? AND LOWER(TRIM(title)) = ? AND COALESCE(media_type, 'vinyl') = ? AND id != ?"
    : "SELECT id, status FROM vinyls WHERE LOWER(TRIM(artist)) = ? AND LOWER(TRIM(title)) = ? AND COALESCE(media_type, 'vinyl') = ?";
  return excludeId
    ? db.prepare(sql).get(normArtist, normTitle, normMedia, excludeId)
    : db.prepare(sql).get(normArtist, normTitle, normMedia);
}

app.post('/api/vinyls', requireSpaceWriteAccess, async (req, res) => {
  const db = getSpaceDb(req.targetSpace);
  const d = req.body;
  if (!d.title || !d.artist) {
    return res.status(400).json({ error: 'Artiste et Titre obligatoires' });
  }
  const dupCreate = findDuplicateMedia(db, d.artist, d.title, d.media_type);
  if (dupCreate) {
    const labelSupport = d.media_type === 'cd' ? 'CD' : 'Vinyle';
    const labelStatus = dupCreate.status === 'wishlist' ? 'ta Wishlist' : 'ta Collection';
    return res.status(409).json({ error: `Doublon bloqué : "${d.artist} - ${d.title}" en ${labelSupport} existe déjà dans ${labelStatus}.` });
  }

  if (d.wall_slot) {
    db.prepare('UPDATE vinyls SET wall_slot = NULL WHERE wall_slot = ?').run(d.wall_slot);
  }

  let localCover = d.cover_local || null;
  if (d.cover_base64 && d.cover_base64.startsWith('data:image')) {
    const base64Data = d.cover_base64.replace(/^data:image\/\w+;base64,/, '');
    const filename = `cover_upload_${req.targetSpace}_${Date.now()}.jpg`;
    fs.writeFileSync(path.join(COVERS_DIR, filename), Buffer.from(base64Data, 'base64'));
    localCover = '/covers/' + filename;
  } else if (d.cover_url && d.cover_url.startsWith('http')) {
    const filename = `cover_${req.targetSpace}_${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;
    const downloaded = await downloadImage(d.cover_url, filename);
    if (downloaded) localCover = downloaded;
  }

  let tracklistArr = [];
  try {
    tracklistArr = typeof d.tracklist === 'string' ? JSON.parse(d.tracklist) : (d.tracklist || []);
  } catch (e) { tracklistArr = []; }

  let deezerAlbumId = d.deezer_album_id || '';

  if (tracklistArr.length === 0 && d.discogs_id && !String(d.discogs_id).startsWith('deezer_') && !String(d.discogs_id).startsWith('itunes_')) {
    const token = getGlobalDiscogsToken();
    tracklistArr = await fetchDiscogsTracklist(d.discogs_id, d.discogs_type || 'release', token);
  }

  // Enrichissement systématique avec Deezer (pour avoir les extraits 30s et liens profonds)
  const dzEnrich = await enrichTracklistWithDeezer(d.artist, d.title, tracklistArr);
  tracklistArr = dzEnrich.tracklist;
  if (!deezerAlbumId && dzEnrich.deezer_album_id) deezerAlbumId = dzEnrich.deezer_album_id;

  const mediaType = d.media_type === 'cd' ? 'cd' : 'vinyl';
  const defaultFormat = mediaType === 'cd' ? 'CD Album' : 'LP 12" 33T';

  const stmt = db.prepare(`
    INSERT INTO vinyls (
      title, artist, year, release_year, label, catalog_number, barcode, genre, media_type, format,
      condition_media, condition_sleeve, status, purchase_price, target_price,
      purchase_date, purchase_location, notes, cover_url, cover_local, discogs_id, deezer_album_id, wall_slot, tracklist
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    d.title, d.artist, d.year || null, d.release_year || null, d.label || '',
    d.catalog_number || '', d.barcode || '', d.genre || '', mediaType, d.format || defaultFormat,
    d.condition_media || 'NM', d.condition_sleeve || 'NM', d.status || 'collection',
    parseFloat(d.purchase_price) || 0, parseFloat(d.target_price) || 0,
    d.purchase_date || '', d.purchase_location || '', d.notes || '',
    d.cover_url || '', localCover, d.discogs_id || '', deezerAlbumId, d.wall_slot || null,
    JSON.stringify(tracklistArr)
  );

  const created = db.prepare('SELECT * FROM vinyls WHERE id = ?').get(info.lastInsertRowid);
  res.json(created);
});

app.put('/api/vinyls/:id', requireSpaceWriteAccess, async (req, res) => {
  const db = getSpaceDb(req.targetSpace);
  const { id } = req.params;
  const d = req.body;
  const existing = db.prepare('SELECT * FROM vinyls WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Disque introuvable' });
  const targetArtist = d.artist ?? existing.artist;
  const targetTitle = d.title ?? existing.title;
  const targetMedia = d.media_type ?? existing.media_type ?? 'vinyl';
  const dupUpdate = findDuplicateMedia(db, targetArtist, targetTitle, targetMedia, id);
  if (dupUpdate) {
    const labelSupport = targetMedia === 'cd' ? 'CD' : 'Vinyle';
    const labelStatus = dupUpdate.status === 'wishlist' ? 'ta Wishlist' : 'ta Collection';
    return res.status(409).json({ error: `Doublon bloqué : "${targetArtist} - ${targetTitle}" en ${labelSupport} existe déjà dans ${labelStatus}.` });
  }

  if (d.wall_slot) {
    db.prepare('UPDATE vinyls SET wall_slot = NULL WHERE wall_slot = ? AND id != ?').run(d.wall_slot, id);
  }

  let localCover = d.cover_local !== undefined ? d.cover_local : existing.cover_local;

  if (d.cover_base64 && d.cover_base64.startsWith('data:image')) {
    const base64Data = d.cover_base64.replace(/^data:image\/\w+;base64,/, '');
    const filename = `cover_${req.targetSpace}_${id}_${Date.now()}.jpg`;
    fs.writeFileSync(path.join(COVERS_DIR, filename), Buffer.from(base64Data, 'base64'));
    localCover = '/covers/' + filename;
  } else if (d.cover_url && d.cover_url.startsWith('http') && (d.cover_url !== existing.cover_url || !localCover)) {
    const filename = `cover_${req.targetSpace}_${id}_${Date.now()}.jpg`;
    const downloaded = await downloadImage(d.cover_url, filename);
    if (downloaded) localCover = downloaded;
  }

  let tracklistStr = existing.tracklist || '[]';
  if (d.tracklist !== undefined) {
    tracklistStr = typeof d.tracklist === 'string' ? d.tracklist : JSON.stringify(d.tracklist);
  }

  const stmt = db.prepare(`
    UPDATE vinyls SET
      title = ?, artist = ?, year = ?, release_year = ?, label = ?, catalog_number = ?,
      barcode = ?, genre = ?, media_type = ?, format = ?, condition_media = ?, condition_sleeve = ?,
      status = ?, purchase_price = ?, target_price = ?, purchase_date = ?,
      purchase_location = ?, notes = ?, cover_url = ?, cover_local = ?,
      discogs_id = ?, deezer_album_id = ?, wall_slot = ?, tracklist = ?
    WHERE id = ?
  `);

  stmt.run(
    d.title ?? existing.title,
    d.artist ?? existing.artist,
    d.year !== undefined ? d.year : existing.year,
    d.release_year !== undefined ? d.release_year : existing.release_year,
    d.label ?? existing.label,
    d.catalog_number ?? existing.catalog_number,
    d.barcode ?? existing.barcode,
    d.genre ?? existing.genre,
    d.media_type ?? existing.media_type ?? 'vinyl',
    d.format ?? existing.format,
    d.condition_media ?? existing.condition_media,
    d.condition_sleeve ?? existing.condition_sleeve,
    d.status ?? existing.status,
    d.purchase_price !== undefined ? parseFloat(d.purchase_price) || 0 : existing.purchase_price,
    d.target_price !== undefined ? parseFloat(d.target_price) || 0 : existing.target_price,
    d.purchase_date ?? existing.purchase_date,
    d.purchase_location ?? existing.purchase_location,
    d.notes ?? existing.notes,
    d.cover_url ?? existing.cover_url,
    localCover,
    d.discogs_id ?? existing.discogs_id,
    d.deezer_album_id ?? existing.deezer_album_id ?? '',
    d.wall_slot !== undefined ? d.wall_slot : existing.wall_slot,
    tracklistStr,
    id
  );

  const updated = db.prepare('SELECT * FROM vinyls WHERE id = ?').get(id);
  res.json(updated);
});

// Régénération unitaire (Discogs + Deezer Previews 30s + iTunes HD)
app.post('/api/vinyls/:id/regenerate', requireSpaceWriteAccess, async (req, res) => {
  const db = getSpaceDb(req.targetSpace);
  const { id } = req.params;
  const v = db.prepare('SELECT * FROM vinyls WHERE id = ?').get(id);
  if (!v) return res.status(404).json({ error: 'Disque introuvable' });

  const token = getGlobalDiscogsToken();
  const auth = buildDiscogsAuthQuery(token);
  const cleanT = cleanSearchTitle(v.title);

  let foundCoverUrl = v.cover_url || '';
  let foundLabel = v.label || '';
  let foundBarcode = v.barcode || '';
  let foundDiscogsId = v.discogs_id || '';
  let foundDeezerAlbumId = v.deezer_album_id || '';
  let foundYear = v.year || v.release_year || null;
  let foundTracklist = [];
  try { foundTracklist = JSON.parse(v.tracklist || '[]'); } catch (e) { foundTracklist = []; }

  // 1. Discogs
  if (auth) {
    try {
      const q = encodeURIComponent(`${v.artist} ${cleanT}`);
      const discogsRes = await fetch(`https://api.discogs.com/database/search?q=${q}&type=release&per_page=8&${auth}`, {
        headers: { 'User-Agent': '33TBoxApp/3.0' }
      });
      if (discogsRes.ok) {
        const data = await discogsRes.json();
        const best = (data.results || []).find(item => item.cover_image && !item.cover_image.includes('spacer.gif'));
        if (best) {
          if (!foundCoverUrl || !v.cover_local) foundCoverUrl = best.cover_image;
          if (!foundLabel && best.label) foundLabel = Array.isArray(best.label) ? best.label[0] : best.label;
          if (!foundBarcode && best.barcode) foundBarcode = Array.isArray(best.barcode) ? best.barcode[0] : '';
          if (!foundYear && best.year) foundYear = parseInt(best.year, 10);
          foundDiscogsId = String(best.id);

          if (foundTracklist.length === 0) {
            foundTracklist = await fetchDiscogsTracklist(best.id, best.type || 'release', token);
          }
        }
      }
    } catch (e) {}
  }

  // 2. Deezer (Pochettes 1000x1000 + Tracklist avec Previews MP3 30s + Deep link)
  const dz = await searchDeezerAlbumAndTracks(v.artist, v.title);
  if (dz) {
    if (!foundCoverUrl && dz.cover_url) foundCoverUrl = dz.cover_url;
    if (!foundLabel && dz.label) foundLabel = dz.label;
    if (!foundBarcode && dz.barcode) foundBarcode = dz.barcode;
    if (!foundYear && dz.release_year) foundYear = dz.release_year;
    if (dz.deezer_album_id) foundDeezerAlbumId = dz.deezer_album_id;

    if (foundTracklist.length === 0 && dz.tracklist && dz.tracklist.length > 0) {
      foundTracklist = dz.tracklist;
    } else if (foundTracklist.length > 0 && dz.tracklist && dz.tracklist.length > 0) {
      // Associer les extraits audio 30s aux pistes existantes
      foundTracklist = foundTracklist.map((t, idx) => {
        const cleanName = (t.title || '').toLowerCase().trim();
        const match = dz.tracklist.find(dt =>
          dt.title.toLowerCase().includes(cleanName) || cleanName.includes(dt.title.toLowerCase())
        ) || dz.tracklist[idx];
        return {
          ...t,
          deezer_id: match ? match.deezer_id : (t.deezer_id || ''),
          preview_url: match ? match.preview_url : (t.preview_url || ''),
          deezer_link: match ? match.deezer_link : (t.deezer_link || '')
        };
      });
    }
  }

  // 3. Secours iTunes HD
  const itunes = await fetchItunesMetadataAndTracks(v.artist, v.title);
  if (itunes) {
    if (!foundCoverUrl && itunes.cover_url) foundCoverUrl = itunes.cover_url;
    if (!foundLabel && itunes.label) foundLabel = itunes.label;
    if (!foundYear && itunes.release_year) foundYear = itunes.release_year;
    if (foundTracklist.length === 0 && itunes.tracklist && itunes.tracklist.length > 0) {
      foundTracklist = itunes.tracklist;
    }
  }

  // 4. Téléchargement local de la pochette
  let localCover = v.cover_local;
  if (foundCoverUrl && (!localCover || req.body.force_cover)) {
    const filename = `cover_${req.targetSpace}_${v.id}_${Date.now()}.jpg`;
    const dl = await downloadImage(foundCoverUrl, filename);
    if (dl) localCover = dl;
  }
  if (!localCover && dz && dz.cover_url) {
    const filename = `cover_${req.targetSpace}_${v.id}_${Date.now()}.jpg`;
    const dl = await downloadImage(dz.cover_url, filename);
    if (dl) { localCover = dl; foundCoverUrl = dz.cover_url; }
  }
  if (!localCover && itunes && itunes.cover_url) {
    const filename = `cover_${req.targetSpace}_${v.id}_${Date.now()}.jpg`;
    const dl = await downloadImage(itunes.cover_url, filename);
    if (dl) { localCover = dl; foundCoverUrl = itunes.cover_url; }
  }

  db.prepare(`
    UPDATE vinyls
    SET cover_url = ?, cover_local = ?, label = ?, barcode = ?, year = COALESCE(year, ?),
        release_year = COALESCE(release_year, ?), discogs_id = ?, deezer_album_id = ?, tracklist = ?
    WHERE id = ?
  `).run(
    foundCoverUrl, localCover, foundLabel, foundBarcode,
    foundYear, foundYear, foundDiscogsId, foundDeezerAlbumId, JSON.stringify(foundTracklist), v.id
  );

  const updated = db.prepare('SELECT * FROM vinyls WHERE id = ?').get(v.id);
  res.json({ ok: true, vinyl: updated });
});

// Copier un disque d'un espace visité vers son propre espace (Wishlist ou Collection)
app.post('/api/vinyls/copy-to-my-space', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(403).json({ error: 'Connecte-toi d\'abord à ton compte pour copier un disque.' });

  const { from_space, vinyl_id, target_status } = req.body;
  const sourceDb = getSpaceDb(from_space);
  const myDb = getSpaceDb(session.slug);
  if (!sourceDb || !myDb) return res.status(404).json({ error: 'Espace introuvable' });

  const srcVinyl = sourceDb.prepare('SELECT * FROM vinyls WHERE id = ?').get(vinyl_id);
  if (!srcVinyl) return res.status(404).json({ error: 'Disque source introuvable' });
  const dupCopy = findDuplicateMedia(myDb, srcVinyl.artist, srcVinyl.title, srcVinyl.media_type || 'vinyl');
  if (dupCopy) {
    const labelSupport = srcVinyl.media_type === 'cd' ? 'CD' : 'Vinyle';
    const labelStatus = dupCopy.status === 'wishlist' ? 'ta Wishlist' : 'ta Collection';
    return res.status(409).json({ error: `Tu possèdes déjà "${srcVinyl.artist} - ${srcVinyl.title}" en ${labelSupport} dans ${labelStatus}.` });
  }

  const stmt = myDb.prepare(`
    INSERT INTO vinyls (
      title, artist, year, release_year, label, catalog_number, barcode, genre, media_type, format,
      condition_media, condition_sleeve, status, purchase_price, target_price,
      purchase_date, purchase_location, notes, cover_url, cover_local, discogs_id, deezer_album_id, wall_slot, tracklist
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `);

  const info = stmt.run(
    srcVinyl.title, srcVinyl.artist, srcVinyl.year, srcVinyl.release_year, srcVinyl.label,
    srcVinyl.catalog_number, srcVinyl.barcode, srcVinyl.genre, srcVinyl.media_type || 'vinyl', srcVinyl.format,
    srcVinyl.condition_media || 'NM', srcVinyl.condition_sleeve || 'NM',
    target_status === 'collection' ? 'collection' : 'wishlist',
    0, srcVinyl.purchase_price || 0, '', `Copié depuis l'espace de ${from_space}`,
    '', srcVinyl.cover_url, srcVinyl.cover_local, srcVinyl.discogs_id, srcVinyl.deezer_album_id || '',
    srcVinyl.tracklist || '[]'
  );

  res.json({ ok: true, new_id: info.lastInsertRowid, target_space: session.slug });
});

app.delete('/api/vinyls/:id', requireSpaceWriteAccess, (req, res) => {
  const db = getSpaceDb(req.targetSpace);
  db.prepare('DELETE FROM vinyls WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- RECHERCHE EXTERNE MULTI-SOURCES (Discogs + Deezer + iTunes HD) ---
app.get('/api/external/search', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(403).json({ error: 'Connexion requise' });

  const { q, barcode, media_type } = req.query;
  const token = getGlobalDiscogsToken();
  const auth = buildDiscogsAuthQuery(token);
  const combinedResults = [];

  // 1. Discogs
  if (auth) {
    try {
      const formatFilter = media_type === 'cd' ? '&format=CD' : (media_type === 'vinyl' ? '&format=Vinyl' : '');
      const searchParam = barcode
        ? `barcode=${encodeURIComponent(barcode)}&type=release`
        : `q=${encodeURIComponent(q || '')}&type=release${formatFilter}`;
      const url = `https://api.discogs.com/database/search?${searchParam}&per_page=6&${auth}`;
      const response = await fetch(url, { headers: { 'User-Agent': '33TBoxApp/3.0' } });
      if (response.ok) {
        const data = await response.json();
        for (const item of (data.results || [])) {
          const parts = (item.title || '').split(' - ');
          const artist = parts.length > 1 ? parts[0].trim() : 'Artiste';
          const title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : item.title;
          combinedResults.push({
            source: 'Discogs',
            external_id: String(item.id),
            discogs_type: item.type || 'release',
            artist,
            title,
            release_year: item.year ? parseInt(item.year, 10) : null,
            label: Array.isArray(item.label) ? item.label[0] : (item.label || ''),
            catalog_number: item.catno || '',
            barcode: Array.isArray(item.barcode) ? item.barcode[0] : (barcode || ''),
            genre: [...(item.genre || []), ...(item.style || [])].slice(0, 2).join(', '),
            format: Array.isArray(item.format) ? item.format.join(', ') : (media_type === 'cd' ? 'CD Album' : 'LP 12" 33T'),
            cover_url: (item.cover_image && !item.cover_image.includes('spacer.gif')) ? item.cover_image : ''
          });
        }
      }
    } catch (err) {}
  }

  // 2. Deezer (Pochettes XL 1000x1000 + ID Album pour l'audio)
  if (!barcode && q) {
    try {
      const dzRes = await fetch(`https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=4`);
      if (dzRes.ok) {
        const dzData = await dzRes.json();
        for (const alb of (dzData.data || [])) {
          combinedResults.push({
            source: 'Deezer',
            external_id: `deezer_${alb.id}`,
            deezer_album_id: String(alb.id),
            artist: alb.artist ? alb.artist.name : '',
            title: alb.title || '',
            release_year: null,
            label: '',
            catalog_number: '',
            barcode: '',
            genre: '',
            format: media_type === 'cd' ? 'CD Album' : 'LP 12" 33T',
            cover_url: alb.cover_xl || alb.cover_big || ''
          });
        }
      }
    } catch (e) {}
  }

  // 3. iTunes HD
  if (!barcode && q) {
    try {
      const itRes = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=album&limit=4`);
      if (itRes.ok) {
        const itData = await itRes.json();
        for (const col of (itData.results || [])) {
          combinedResults.push({
            source: 'iTunes HD',
            external_id: `itunes_${col.collectionId}`,
            artist: col.artistName || '',
            title: col.collectionName || '',
            release_year: col.releaseDate ? parseInt(col.releaseDate.slice(0, 4), 10) : null,
            label: col.copyright ? col.copyright.replace(/^℗\s*\d+\s*/, '').slice(0, 45) : '',
            catalog_number: '',
            barcode: '',
            genre: col.primaryGenreName || '',
            format: media_type === 'cd' ? 'CD Album' : 'LP 12" 33T',
            cover_url: col.artworkUrl100 ? col.artworkUrl100.replace('100x100bb', '600x600bb') : ''
          });
        }
      }
    } catch (e) {}
  }

  res.json({ results: combinedResults });
});

// Récupérer les détails complets (Tracklist + Previews Deezer 30s)
app.get('/api/external/details', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(403).json({ error: 'Connexion requise' });

  const { source, id, artist, title } = req.query;
  const token = getGlobalDiscogsToken();
  let tracks = [];

  if (source === 'Discogs' && id) {
    tracks = await fetchDiscogsTracklist(id, 'release', token);
  }

  const dzEnrich = await enrichTracklistWithDeezer(artist || '', title || '', tracks);
  if (dzEnrich.tracklist && dzEnrich.tracklist.length > 0) {
    return res.json({ tracklist: dzEnrich.tracklist, deezer_album_id: dzEnrich.deezer_album_id });
  }

  const itunes = await fetchItunesMetadataAndTracks(artist || '', title || '');
  return res.json({ tracklist: itunes ? itunes.tracklist : [], deezer_album_id: '' });
});

// Recherche Deezer à la volée pour écouter un morceau (même si la tracklist n'avait pas encore de preview_url)
app.get('/api/deezer/track', requireReadAccess, async (req, res) => {
  const { artist, track, album } = req.query;
  try {
    const qStrict = encodeURIComponent(`artist:"${artist || ''}" track:"${track || ''}"`);
    let r = await fetch(`https://api.deezer.com/search?q=${qStrict}&limit=3`);
    let d = r.ok ? await r.json() : { data: [] };

    if (!d.data || d.data.length === 0) {
      const qBroad = encodeURIComponent(`${artist || ''} ${track || ''} ${album || ''}`);
      r = await fetch(`https://api.deezer.com/search?q=${qBroad}&limit=3`);
      d = r.ok ? await r.json() : { data: [] };
    }

    if (d.data && d.data.length > 0) {
      const item = d.data[0];
      return res.json({
        found: true,
        deezer_id: String(item.id),
        title: item.title,
        artist: item.artist ? item.artist.name : artist,
        preview_url: item.preview || '',
        deezer_link: item.link || `https://www.deezer.com/track/${item.id}`,
        album_id: item.album ? String(item.album.id) : '',
        cover: item.album ? (item.album.cover_medium || '') : ''
      });
    }
    res.json({ found: false });
  } catch (e) {
    res.json({ found: false });
  }
});

// Export Backup JSON d'un espace
app.get('/api/backup/export', requireSpaceWriteAccess, (req, res) => {
  const db = getSpaceDb(req.targetSpace);
  const vinyls = db.prepare('SELECT * FROM vinyls').all();
  const settings = db.prepare('SELECT key, value FROM settings').all();
  res.setHeader('Content-Disposition', `attachment; filename="33t_box_${req.targetSpace}_backup.json"`);
  res.json({ space: req.targetSpace, exported_at: new Date().toISOString(), vinyls, settings });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================================`);
  console.log(` 33T-Box V3 (Multi-User, Vinyles/CD & Deezer) sur le port ${PORT}`);
  console.log(`===============================================================`);
});
