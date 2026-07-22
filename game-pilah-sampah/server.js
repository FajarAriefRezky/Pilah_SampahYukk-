const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MATCH_DURATION_MS = Math.max(1000, Number(process.env.MATCH_DURATION_MS) || 90000);
const SCORE_STEP = 10;
const MIN_SCORE_INTERVAL_MS = 150;
const HISTORY_LIMIT = 5;
const MAX_PLAYERS = 6;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'users.json');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function ensureDataStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: [] }, null, 2), 'utf8');
  }
}

function loadDb() {
  ensureDataStore();
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { users: Array.isArray(parsed.users) ? parsed.users : [] };
  } catch {
    return { users: [] };
  }
}

function saveDb(db) {
  ensureDataStore();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    bestScore: Number(user.bestScore) || 0,
    lastScore: Number(user.lastScore) || 0,
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const sessions = new Map();
const rooms = new Map();

function getTokenFromRequest(req) {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return String(req.headers['x-auth-token'] || '').trim();
}

function getAuthenticatedUser(req, db) {
  const token = getTokenFromRequest(req);
  if (!token || !sessions.has(token)) return null;
  const userId = sessions.get(token);
  return db.users.find((user) => user.id === userId) || null;
}

function generateSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, userId);
  return token;
}

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      code: roomCode,
      started: false,
      finished: false,
      startAt: null,
      endAt: null,
      rematchVotes: new Set(),
      history: [],
      finishTimer: null,
      players: new Map(),
      spectators: new Map(),
    });
  }
  return rooms.get(roomCode);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function roomSnapshot(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    finished: room.finished,
    startAt: room.startAt,
    endAt: room.endAt,
    rematchVotes: [...room.rematchVotes],
    history: room.history,
    spectators: [...room.spectators.values()].map(({ socket, ...spectator }) => spectator),
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      slot: player.slot,
      character: player.character,
      score: player.score,
      lives: player.lives,
      status: player.status,
      connected: true,
    })),
  };
}

function broadcastRoom(room) {
  const payload = JSON.stringify({ type: 'room:update', room: roomSnapshot(room) });
  [...room.players.values(), ...room.spectators.values()].forEach((member) => {
    if (member.socket.readyState === 1) member.socket.send(payload);
  });
}

function buildResults(players) {
  let previousScore = null;
  let previousRank = 0;
  return [...players]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((player, index) => {
      if (player.score !== previousScore) previousRank = index + 1;
      previousScore = player.score;
      return { rank: previousRank, id: player.id, name: player.name, slot: player.slot, character: player.character, score: player.score };
    });
}

function finishRoom(room, reason = 'completed') {
  if (room.finished) return false;
  clearTimeout(room.finishTimer);
  room.finishTimer = null;
  room.players.forEach((player) => { player.status = 'finished'; });
  room.finished = true;
  room.endAt = Date.now();
  const results = buildResults(room.players.values());
  const record = { id: `m_${room.endAt}`, finishedAt: room.endAt, reason, results };
  room.history = [record, ...room.history].slice(0, HISTORY_LIMIT);
  const payload = JSON.stringify({ type: 'room:finished', room: roomSnapshot(room), results, reason });
  [...room.players.values(), ...room.spectators.values()].forEach((member) => { if (member.socket.readyState === 1) member.socket.send(payload); });
  return true;
}

function finishRoomIfReady(room) {
  const everyoneFinished = room.players.size > 0
    && [...room.players.values()].every((player) => player.status === 'finished');
  if (!everyoneFinished || room.finished) return false;

  return finishRoom(room, 'completed');
}

function cancelRoomMatch(room, disconnectedName) {
  room.started = false;
  room.finished = false;
  room.startAt = null;
  room.endAt = null;
  room.rematchVotes.clear();
  clearTimeout(room.finishTimer);
  room.finishTimer = null;
  room.players.forEach((member) => {
    member.score = 0;
    member.lives = 3;
    member.status = 'ready';
  });

  const payload = JSON.stringify({
    type: 'room:cancelled',
    room: roomSnapshot(room),
    message: `${disconnectedName} terputus. Pertandingan dibatalkan dan leaderboard tidak dihitung.`,
  });
  [...room.players.values(), ...room.spectators.values()].forEach((member) => {
    if (member.socket.readyState === 1) member.socket.send(payload);
  });
}

function cleanupRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.players.size === 0 && room.spectators.size === 0) {
    clearTimeout(room.finishTimer);
    rooms.delete(roomCode);
  }
}

function sendWsJson(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function serveFile(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(requestPath).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500);
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' };
    if (ext === '.html') {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
      headers.Pragma = 'no-cache';
      headers.Expires = '0';
    } else {
      headers['Cache-Control'] = 'public, max-age=300';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, 'http://localhost');

  if (parsedUrl.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (parsedUrl.pathname === '/api/register' && req.method === 'POST') {
    readJsonBody(req)
      .then((body) => {
        const username = normalizeUsername(body.username);
        const password = String(body.password || '');

        if (username.length < 3 || username.length > 16) {
          sendJson(res, 400, { error: 'Username harus 3-16 karakter.' });
          return;
        }
        if (!/^[a-z0-9_]+$/.test(username)) {
          sendJson(res, 400, { error: 'Username hanya boleh huruf kecil, angka, underscore.' });
          return;
        }
        if (password.length < 4 || password.length > 40) {
          sendJson(res, 400, { error: 'Password harus 4-40 karakter.' });
          return;
        }

        const db = loadDb();
        const existing = db.users.find((user) => user.username === username);
        if (existing) {
          sendJson(res, 409, { error: 'Username sudah dipakai.' });
          return;
        }

        const now = Date.now();
        const user = {
          id: `u_${now}_${Math.floor(Math.random() * 9999)}`,
          username,
          passwordHash: hashPassword(password),
          bestScore: 0,
          lastScore: 0,
          createdAt: now,
          updatedAt: now,
        };
        db.users.push(user);
        saveDb(db);

        const token = generateSession(user.id);
        sendJson(res, 201, { token, user: publicUser(user) });
      })
      .catch(() => sendJson(res, 400, { error: 'Body request tidak valid.' }));
    return;
  }

  if (parsedUrl.pathname === '/api/login' && req.method === 'POST') {
    readJsonBody(req)
      .then((body) => {
        const username = normalizeUsername(body.username);
        const password = String(body.password || '');
        const db = loadDb();
        const user = db.users.find((item) => item.username === username);

        if (!user || user.passwordHash !== hashPassword(password)) {
          sendJson(res, 401, { error: 'Username atau password salah.' });
          return;
        }

        const token = generateSession(user.id);
        sendJson(res, 200, { token, user: publicUser(user) });
      })
      .catch(() => sendJson(res, 400, { error: 'Body request tidak valid.' }));
    return;
  }

  if (parsedUrl.pathname === '/api/me' && req.method === 'GET') {
    const db = loadDb();
    const user = getAuthenticatedUser(req, db);
    if (!user) {
      sendJson(res, 401, { error: 'Belum login.' });
      return;
    }
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (parsedUrl.pathname === '/api/score' && req.method === 'POST') {
    readJsonBody(req)
      .then((body) => {
        const db = loadDb();
        const user = getAuthenticatedUser(req, db);
        if (!user) {
          sendJson(res, 401, { error: 'Belum login.' });
          return;
        }

        const score = Math.max(0, Number(body.score) || 0);
        user.lastScore = score;
        user.bestScore = Math.max(Number(user.bestScore) || 0, score);
        user.updatedAt = Date.now();
        saveDb(db);

        sendJson(res, 200, { ok: true, user: publicUser(user) });
      })
      .catch(() => sendJson(res, 400, { error: 'Body request tidak valid.' }));
    return;
  }

  if (parsedUrl.pathname === '/api/ranking' && req.method === 'GET') {
    const db = loadDb();
    const limit = Math.max(5, Math.min(50, Number(parsedUrl.searchParams.get('limit')) || 10));
    const ranking = [...db.users]
      .sort((a, b) => {
        const scoreDiff = (Number(b.bestScore) || 0) - (Number(a.bestScore) || 0);
        if (scoreDiff !== 0) return scoreDiff;
        return (a.updatedAt || 0) - (b.updatedAt || 0);
      })
      .slice(0, limit)
      .map((user, index) => ({
        rank: index + 1,
        username: user.username,
        bestScore: Number(user.bestScore) || 0,
      }));

    sendJson(res, 200, { ranking });
    return;
  }

  serveFile(req, res);
});

const wss = new WebSocketServer({ server, path: '/ws' });
let nextId = 1;

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const playerId = `p${nextId++}`;
  let currentRoomCode = null;
  let currentRole = null;

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendWsJson(ws, { type: 'error', message: 'Pesan tidak valid.' });
      return;
    }

    if (message.type === 'room:create' || message.type === 'room:join' || message.type === 'room:spectate') {
      const isCreating = message.type === 'room:create';
      const isSpectating = message.type === 'room:spectate';
      const roomCode = isCreating
        ? generateRoomCode()
        : String(message.roomCode || '').trim().toUpperCase().slice(0, 6);
      const playerName = String(message.playerName || '').trim().slice(0, 18) || 'Pemain';
      let playerSlot = Number(message.playerSlot);
      const character = String(message.character || '').trim().slice(0, 12);

      if (!isCreating && !/^[A-Z0-9]{6}$/.test(roomCode)) {
        sendWsJson(ws, { type: 'error', message: 'Kode room harus terdiri dari 6 karakter.' });
        return;
      }

      const room = isCreating ? getRoom(roomCode) : rooms.get(roomCode);
      if (!room) {
        sendWsJson(ws, { type: 'error', message: 'Room tidak ditemukan. Periksa kembali kode dari host.' });
        return;
      }

      if (room.started && !isSpectating) {
        sendWsJson(ws, { type: 'error', message: 'Pertandingan room ini sudah dimulai. Buat atau gabung room lain.' });
        return;
      }

      if (currentRoomCode) {
        const previousRoom = rooms.get(currentRoomCode);
        previousRoom?.players.delete(playerId);
        previousRoom?.spectators.delete(playerId);
        if (previousRoom) broadcastRoom(previousRoom);
        cleanupRoom(currentRoomCode);
      }

      if (!isSpectating && (!Number.isInteger(playerSlot) || playerSlot < 1 || playerSlot > MAX_PLAYERS)) {
        sendWsJson(ws, { type: 'error', message: 'Pilih Player 1 sampai Player 6.' });
        return;
      }
      if (!String(message.playerName || '').trim()) {
        sendWsJson(ws, { type: 'error', message: 'Nama pemain wajib diisi.' });
        return;
      }
      if (!isSpectating && room.players.size >= MAX_PLAYERS) {
        sendWsJson(ws, { type: 'error', message: 'Room sudah penuh (maksimal 6 pemain).' });
        return;
      }
      if (!isSpectating && [...room.players.values()].some((member) => member.slot === playerSlot)) {
        // Pemain memilih karakter sebelum memperoleh snapshot lobby, sehingga ia
        // belum tahu slot mana yang sudah terisi. Tempatkan otomatis ke slot kosong.
        playerSlot = Array.from({ length: MAX_PLAYERS }, (_, index) => index + 1).find((slot) =>
          ![...room.players.values()].some((member) => member.slot === slot)
        );
      }
      if (isSpectating) {
        room.spectators.set(playerId, { id: playerId, name: playerName, role: 'spectator', socket: ws });
      } else room.players.set(playerId, {
        id: playerId,
        name: playerName,
        slot: playerSlot,
        character: character || '🐼',
        socket: ws,
        score: 0,
        lives: 3,
        status: 'ready',
        lastScoreAt: 0,
      });
      if (!isSpectating && !room.hostId) room.hostId = playerId;
      currentRoomCode = roomCode;
      currentRole = isSpectating ? 'spectator' : 'player';

      sendWsJson(ws, { type: 'room:joined', playerId, role: currentRole, room: roomSnapshot(room) });
      broadcastRoom(room);
      return;
    }

    if (!currentRoomCode) {
      sendWsJson(ws, { type: 'error', message: 'Belum masuk room.' });
      return;
    }

    const room = rooms.get(currentRoomCode);
    const player = room?.players.get(playerId);
    const spectator = room?.spectators.get(playerId);
    if (!room || (!player && !spectator)) {
      sendWsJson(ws, { type: 'error', message: 'Room tidak ditemukan.' });
      return;
    }

    if (message.type === 'room:start') {
      if (!player) { sendWsJson(ws, { type: 'error', message: 'Spectator tidak dapat memulai pertandingan.' }); return; }
      if (!room.started) {
        if (room.hostId !== playerId) {
          sendWsJson(ws, { type: 'error', message: 'Hanya pembuat room yang dapat memulai permainan.' });
          return;
        }
        if (room.players.size < 2) {
          sendWsJson(ws, { type: 'error', message: 'Tunggu minimal 2 pemain sebelum mulai.' });
          return;
        }
        room.started = true;
        room.finished = false;
        room.startAt = Date.now() + 1200;
        room.endAt = room.startAt + MATCH_DURATION_MS;
        room.rematchVotes.clear();
        room.players.forEach((member) => {
          member.score = 0;
          member.lives = 3;
          member.status = 'playing';
          member.lastScoreAt = room.startAt;
        });
        clearTimeout(room.finishTimer);
        room.finishTimer = setTimeout(() => finishRoom(room, 'timeout'), Math.max(0, room.endAt - Date.now()));
      }
      broadcastRoom(room);
      return;
    }

    if (message.type === 'room:rematch') {
      if (!player) { sendWsJson(ws, { type: 'error', message: 'Spectator tidak ikut voting rematch.' }); return; }
      if (!room.finished) {
        sendWsJson(ws, { type: 'error', message: 'Pertandingan belum selesai.' });
        return;
      }
      room.rematchVotes.add(playerId);
      if (room.rematchVotes.size === room.players.size) {
        room.started = false;
        room.finished = false;
        room.startAt = null;
        room.endAt = null;
        room.rematchVotes.clear();
        room.players.forEach((member) => { member.score = 0; member.lives = 3; member.status = 'ready'; member.lastScoreAt = 0; });
      }
      broadcastRoom(room);
      return;
    }

    if (message.type === 'client:ping') {
      sendWsJson(ws, { type: 'server:pong', sentAt: Number(message.sentAt) || Date.now() });
      return;
    }

    if (message.type === 'player:update') {
      if (!player) return;
      if (!room.started || room.finished) return;
      const now = Date.now();
      const requestedScore = Math.max(0, Math.floor(Number(message.score) || 0));
      if (requestedScore > player.score && now - player.lastScoreAt >= MIN_SCORE_INTERVAL_MS) {
        player.score += Math.min(SCORE_STEP, requestedScore - player.score);
        player.lastScoreAt = now;
      }
      player.lives = Math.max(0, Math.min(3, Math.floor(Number(message.lives) || 0)));
      player.status = message.status === 'finished' || player.lives <= 0 ? 'finished' : 'playing';
      if (!finishRoomIfReady(room)) broadcastRoom(room);
      return;
    }
  });

  ws.on('close', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const disconnectedPlayer = room.players.get(playerId);
    const wasSpectator = currentRole === 'spectator';
    const matchWasActive = room.started && !room.finished && !wasSpectator;
    room.players.delete(playerId);
    room.spectators.delete(playerId);
    if (room.hostId === playerId) room.hostId = room.players.keys().next().value || null;
    if (matchWasActive) {
      cancelRoomMatch(room, disconnectedPlayer?.name || 'Seorang pemain');
    } else {
      broadcastRoom(room);
    }
    cleanupRoom(currentRoomCode);
  });
});

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(PORT, () => {
  console.log(`Game server ready at http://localhost:${PORT}`);
});
