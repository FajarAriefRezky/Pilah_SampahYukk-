import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'game-pilah-sampah')));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'game-pilah-sampah', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Pilah Yuk! server is running' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎮 Pilah Yuk! Game Server`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📱 Server berjalan di: http://localhost:${PORT}`);
  console.log(`🌐 Akses dari network lain: http://<IP-ADDRESS>:${PORT}`);
  console.log(`✅ Tekan Ctrl+C untuk berhenti\n`);
});
