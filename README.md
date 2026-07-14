# 🎮 Pilah Yuk! - Game Sortir Sampah

Tetris-style trash sorting game dengan mekanik falling items dan draggable bins untuk belajar tentang pemilahan sampah organik dan non-organik.

## 📱 Features

- ✅ Responsive design (Mobile & Desktop optimized)
- ✅ Falling trash items animation
- ✅ Draggable trash bins (Organik & Non-Organik)
- ✅ Sound effects dengan Web Audio API
- ✅ Lives system dengan ❤️ icon
- ✅ Score tracking & Game Over screen
- ✅ Confetti animation on correct catch
- ✅ Public server dengan tunneling support

## 🚀 Quick Start

### Local Server (Localhost)

```bash
# Install dependencies
npm install

# Start server
npm start

# Game akan accessible di http://localhost:3000
```

### Public Server (Akses dari Internet)

Untuk akses game dari mana saja (mobile, laptop lain, dll):

```bash
# Start dengan public tunnel
npm run public

# atau gunakan alternative tunnel
npm run tunnel
```

Server akan menampilkan public URL yang bisa dibuka dari perangkat lain.

## 📋 Cara Bermain

1. Klik **"Mulai Main"**
2. Sampah akan jatuh dari atas
3. Geser tong sampah (🗑️) ke **KIRI atau KANAN** untuk menangkap
4. Sampah organik → tong **ORGANIK** (hijau)
5. Sampah non-organik → tong **NON-ORGANIK** (biru)
6. ❤️ = 1 nyawa, kalo salah 3x game selesai!

## 🎮 Game Controls

- **Mouse/Trackpad**: Drag tong sampah ke kiri-kanan
- **Touch Screen**: Swipe tong sampah ke kiri-kanan
- **Keyboard**: Game tidak memerlukan keyboard

## 📱 Mobile Optimization

Game telah dioptimasi untuk mobile dengan:
- Responsive viewport configuration
- Touch-friendly bin dragging
- Viewport fit untuk notch devices (iPhone X+)
- Apple mobile web app support

## 🔊 Audio Features

- ✅ Correct catch: Do-Mi melody
- ✅ Wrong catch: Descending warning tone
- ✅ Miss: Alert tone
- ✅ Game Over: Descending melody

Semua suara generate secara real-time menggunakan Web Audio API (tidak perlu file audio).

## 📁 Project Structure

```
game-pilah-sampah/
├── game-pilah-sampah/
│   └── index.html          # Game (semua HTML/CSS/JS in one file)
├── server.js               # Express server
├── package.json            # Dependencies & scripts
├── README.md              # This file
└── tunnel.js              # Tunneling helper (optional)
```

## 🛠 Technology Stack

- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Backend**: Node.js + Express
- **Audio**: Web Audio API
- **Public Access**: Localtunnel

## 📊 Game Data

- **Total Items**: 16 (9 organik, 8 non-organik)
- **Lives**: 3 hearts (❤️)
- **Scoring**: +10 per correct catch
- **Game Duration**: 3+ missedDari items

## 🎯 Next Features (Optional)

- [ ] High score leaderboard (Firebase/Database)
- [ ] Multiplayer mode
- [ ] Difficulty levels (Easy/Medium/Hard)
- [ ] More trash items
- [ ] Power-ups
- [ ] Time-based challenges

## 🐛 Troubleshooting

### Port already in use
```bash
# Change PORT in server.js or use:
PORT=4000 npm start
```

### Sound not playing
- Check browser volume
- Allow autoplay in browser settings
- Some browsers require user interaction before audio

### Mobile button not responsive
- Try using pointer events instead of touch
- Check if CSS touch-action is set correctly

## 📝 License

Created for KKN - Sampah Sorting Education

---

**Enjoy playing Pilah Yuk! dan belajar tentang pentingnya pemilahan sampah! 🌍♻️**
