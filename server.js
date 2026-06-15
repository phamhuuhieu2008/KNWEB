const express = require('express');
const multer = require('multer');
const cron = require('node-cron');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Tạo thư mục uploads nếu chưa có
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// Cấu hình multer lưu ảnh
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    cb(null, `face_${timestamp}.jpg`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// === API ROUTES ===

// Upload ảnh từ client
app.post('/api/upload', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Không có file' });

  const photoData = {
    filename: req.file.filename,
    originalname: req.file.originalname,
    size: req.file.size,
    uploadedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    userAgent: req.headers['user-agent']
  };

  // Lưu metadata vào file JSON
  const metaFile = path.join(uploadsDir, `${req.file.filename}.json`);
  fs.writeFileSync(metaFile, JSON.stringify(photoData, null, 2));

  console.log(`[${new Date().toLocaleString('vi-VN')}] Ảnh mới: ${req.file.filename} - IP: ${photoData.ip}`);
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

  // Sắp xếp mới nhất trước
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

  console.log(`[${new Date().toLocaleString('vi-VN')}] Đã xóa: ${filename}`);
  res.json({ success: true });
});

// Thống kê
app.get('/api/stats', (req, res) => {
  const files = fs.readdirSync(uploadsDir).filter(f => f.endsWith('.jpg'));
  res.json({ total: files.length });
});

// === CRON JOB: Tự xóa ảnh sau 24 giờ ===
cron.schedule('*/10 * * * *', () => {
  const files = fs.readdirSync(uploadsDir).filter(f => f.endsWith('.jpg'));
  let deleted = 0;

  files.forEach(filename => {
    const metaFile = path.join(uploadsDir, `${filename}.json`);
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      if (new Date() > new Date(meta.expiresAt)) {
        fs.unlinkSync(path.join(uploadsDir, filename));
        fs.unlinkSync(metaFile);
        deleted++;
      }
    }
  });

  if (deleted > 0) {
    console.log(`[Auto-Delete] Đã xóa ${deleted} ảnh hết hạn`);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Server đang chạy tại: http://localhost:${PORT}`);
  console.log(`📸 Trang người dùng: http://localhost:${PORT}`);
  console.log(`🔐 Trang Admin:      http://localhost:${PORT}/admin.html`);
  console.log(`📁 Ảnh lưu tại:      ${uploadsDir}\n`);
});
