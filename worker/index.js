const MAX_PLAYERS = 6;
const MATCH_DURATION_MS = 90000;
const SCORE_STEP = 10;
const MIN_SCORE_INTERVAL_MS = 150;
const HISTORY_LIMIT = 5;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      const hub = env.GAME_HUB.getByName('global-game-hub');
      return hub.fetch(request);
    }

    if (url.pathname === '/health') {
      return json({ ok: true, platform: 'cloudflare-workers', release: '2026-07-19-six-player-final-ranking' });
    }

    if (url.pathname === '/api/ranking') return json({ ranking: [] });
    if (url.pathname === '/api/me') return json({ error: 'Mode tamu aktif.' }, 401);
    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Fitur akun belum tersedia pada deployment Cloudflare.' }, 501);
    }

    const response = await env.ASSETS.fetch(request);
    if (response.headers.get('content-type')?.includes('text/html')) {
      const headers = new Headers(response.headers);
      headers.set('cache-control', 'no-store, no-cache, must-revalidate');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  },
};

export class GameHub {
  constructor(ctx) {
    this.ctx = ctx;
    this.rooms = new Map();
    this.players = new Map();
    this.nextId = 1;
  }

  async alarm() {
    const now = Date.now();
    this.rooms.forEach((room) => {
      if (room.started && !room.finished && room.endAt <= now) this.finish(room, 'timeout');
    });
    await this.scheduleAlarm();
  }

  async scheduleAlarm() {
    const deadlines = [...this.rooms.values()].filter((room) => room.started && !room.finished).map((room) => room.endAt);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }

  fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const playerId = `p${this.nextId++}`;
    this.players.set(server, { playerId, roomCode: null });

    server.addEventListener('message', (event) => this.onMessage(server, event.data));
    server.addEventListener('close', () => this.onClose(server));
    server.addEventListener('error', () => this.onClose(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  send(socket, payload) {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    } catch {
      this.onClose(socket);
    }
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (this.rooms.has(code));
    return code;
  }

  createRoom(code) {
    const room = {
      code,
      hostId: null,
      started: false,
      finished: false,
      startAt: null,
      endAt: null,
      rematchVotes: new Set(),
      history: [],
      players: new Map(),
      spectators: new Map(),
    };
    this.rooms.set(code, room);
    return room;
  }

  snapshot(room) {
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
      players: [...room.players.values()].map(({ socket, lastScoreAt, ...player }) => ({ ...player, connected: true })),
    };
  }

  broadcast(room) {
    const payload = { type: 'room:update', room: this.snapshot(room) };
    [...room.players.values(), ...room.spectators.values()].forEach((member) => this.send(member.socket, payload));
  }

  buildResults(players) {
    let previousScore = null;
    let previousRank = 0;
    return [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).map((player, index) => {
      if (player.score !== previousScore) previousRank = index + 1;
      previousScore = player.score;
      return { rank: previousRank, id: player.id, name: player.name, slot: player.slot, character: player.character, score: player.score };
    });
  }

  finish(room, reason = 'completed') {
    if (room.finished || room.players.size === 0) return false;
    room.players.forEach((player) => { player.status = 'finished'; });
    room.finished = true;
    room.endAt = Date.now();
    const results = this.buildResults(room.players.values());
    room.history = [{ id: `m_${room.endAt}`, finishedAt: room.endAt, reason, results }, ...room.history].slice(0, HISTORY_LIMIT);
    const payload = { type: 'room:finished', room: this.snapshot(room), results, reason };
    [...room.players.values(), ...room.spectators.values()].forEach((member) => this.send(member.socket, payload));
    return true;
  }

  finishIfReady(room) {
    if (room.finished || room.players.size === 0) return false;
    if (![...room.players.values()].every((player) => player.status === 'finished')) return false;
    return this.finish(room, 'completed');
  }

  cancelMatch(room, disconnectedName) {
    room.started = false;
    room.finished = false;
    room.startAt = null;
    room.endAt = null;
    room.rematchVotes.clear();
    room.players.forEach((member) => Object.assign(member, {
      score: 0,
      lives: 3,
      status: 'ready',
    }));
    const payload = {
      type: 'room:cancelled',
      room: this.snapshot(room),
      message: `${disconnectedName} terputus. Pertandingan dibatalkan dan leaderboard tidak dihitung.`,
    };
    [...room.players.values(), ...room.spectators.values()].forEach((member) => this.send(member.socket, payload));
  }

  leaveCurrentRoom(socket) {
    const connection = this.players.get(socket);
    if (!connection?.roomCode) return;
    const room = this.rooms.get(connection.roomCode);
    connection.roomCode = null;
    if (!room) return;

    const disconnectedPlayer = room.players.get(connection.playerId);
    const wasSpectator = connection.role === 'spectator';
    const matchWasActive = room.started && !room.finished && !wasSpectator;
    room.players.delete(connection.playerId);
    room.spectators.delete(connection.playerId);
    if (room.hostId === connection.playerId) {
      room.hostId = room.players.keys().next().value || null;
    }
    if (room.players.size === 0 && room.spectators.size === 0) this.rooms.delete(room.code);
    else if (matchWasActive) {
      this.cancelMatch(room, disconnectedPlayer?.name || 'Seorang pemain');
    } else {
      this.broadcast(room);
    }
  }

  onClose(socket) {
    if (!this.players.has(socket)) return;
    this.leaveCurrentRoom(socket);
    this.players.delete(socket);
  }

  onMessage(socket, raw) {
    const connection = this.players.get(socket);
    if (!connection) return;

    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      this.send(socket, { type: 'error', message: 'Pesan tidak valid.' });
      return;
    }

    if (message.type === 'room:create' || message.type === 'room:join' || message.type === 'room:spectate') {
      const creating = message.type === 'room:create';
      const spectating = message.type === 'room:spectate';
      const roomCode = creating
        ? this.generateRoomCode()
        : String(message.roomCode || '').trim().toUpperCase().slice(0, 6);

      if (!creating && !/^[A-Z0-9]{6}$/.test(roomCode)) {
        this.send(socket, { type: 'error', message: 'Kode room harus terdiri dari 6 karakter.' });
        return;
      }

      const room = creating ? this.createRoom(roomCode) : this.rooms.get(roomCode);
      if (!room) {
        this.send(socket, { type: 'error', message: 'Room tidak ditemukan. Periksa kembali kode dari host.' });
        return;
      }
      if (room.started && !spectating) {
        this.send(socket, { type: 'error', message: 'Pertandingan room ini sudah dimulai.' });
        return;
      }
      if (!spectating && room.players.size >= MAX_PLAYERS) {
        this.send(socket, { type: 'error', message: 'Room sudah penuh (maksimal 6 pemain).' });
        return;
      }

      const playerName = String(message.playerName || '').trim().slice(0, 18);
      if (!playerName) {
        this.send(socket, { type: 'error', message: 'Nama pemain wajib diisi.' });
        return;
      }

      let slot = Number(message.playerSlot);
      if (!spectating && (!Number.isInteger(slot) || slot < 1 || slot > MAX_PLAYERS)) slot = 1;
      if (!spectating && [...room.players.values()].some((player) => player.slot === slot)) {
        slot = Array.from({ length: MAX_PLAYERS }, (_, index) => index + 1).find((candidate) =>
          ![...room.players.values()].some((player) => player.slot === candidate));
      }

      this.leaveCurrentRoom(socket);
      const player = {
        id: connection.playerId,
        name: playerName,
        slot,
        character: String(message.character || '🎮').slice(0, 12),
        socket,
        score: 0,
        lives: 3,
        status: 'ready',
        lastScoreAt: 0,
      };
      if (spectating) room.spectators.set(connection.playerId, { id: connection.playerId, name: playerName, role: 'spectator', socket });
      else room.players.set(connection.playerId, player);
      if (!spectating && !room.hostId) room.hostId = connection.playerId;
      connection.roomCode = roomCode;
      connection.role = spectating ? 'spectator' : 'player';
      this.send(socket, { type: 'room:joined', playerId: connection.playerId, role: connection.role, room: this.snapshot(room) });
      this.broadcast(room);
      return;
    }

    const room = connection.roomCode ? this.rooms.get(connection.roomCode) : null;
    const player = room?.players.get(connection.playerId);
    const spectator = room?.spectators.get(connection.playerId);
    if (!room || (!player && !spectator)) {
      this.send(socket, { type: 'error', message: 'Belum masuk room.' });
      return;
    }

    if (message.type === 'room:start') {
      if (!player) { this.send(socket, { type: 'error', message: 'Spectator tidak dapat memulai pertandingan.' }); return; }
      if (room.hostId !== connection.playerId) {
        this.send(socket, { type: 'error', message: 'Hanya host yang dapat memulai permainan.' });
        return;
      }
      if (room.players.size < 2) {
        this.send(socket, { type: 'error', message: 'Tunggu minimal 2 pemain sebelum mulai.' });
        return;
      }
      room.started = true;
      room.finished = false;
      room.startAt = Date.now() + 1500;
      room.endAt = room.startAt + MATCH_DURATION_MS;
      room.rematchVotes.clear();
      room.players.forEach((member) => Object.assign(member, { score: 0, lives: 3, status: 'playing', lastScoreAt: room.startAt }));
      this.broadcast(room);
      this.scheduleAlarm();
      return;
    }

    if (message.type === 'room:rematch') {
      if (!player) { this.send(socket, { type: 'error', message: 'Spectator tidak ikut voting rematch.' }); return; }
      if (!room.finished) {
        this.send(socket, { type: 'error', message: 'Pertandingan belum selesai.' });
        return;
      }
      room.rematchVotes.add(connection.playerId);
      if (room.rematchVotes.size === room.players.size) {
        room.started = false;
        room.finished = false;
        room.startAt = null;
        room.endAt = null;
        room.rematchVotes.clear();
        room.players.forEach((member) => Object.assign(member, { score: 0, lives: 3, status: 'ready', lastScoreAt: 0 }));
      }
      this.broadcast(room);
      return;
    }

    if (message.type === 'client:ping') {
      this.send(socket, { type: 'server:pong', sentAt: Number(message.sentAt) || Date.now() });
      return;
    }

    if (message.type === 'player:gameplay' && player && room.started && !room.finished) {
      const rawSnapshot = message.snapshot || {};
      const snapshot = {
        items: (Array.isArray(rawSnapshot.items) ? rawSnapshot.items : []).slice(0, 16).map((item) => ({
          id: String(item.id || '').slice(0, 24), emoji: String(item.emoji || '🗑️').slice(0, 12), label: String(item.label || '').slice(0, 24),
          x: Math.max(0, Math.min(1, Number(item.x) || 0)), y: Math.max(-0.2, Math.min(1.2, Number(item.y) || 0)),
        })),
        organik: Math.max(-1, Math.min(1, Number(rawSnapshot.organik) || 0)),
        nonOrganik: Math.max(-1, Math.min(1, Number(rawSnapshot.nonOrganik) || 0)),
      };
      const payload = { type: 'spectator:gameplay', playerId: connection.playerId, snapshot };
      room.spectators.forEach((member) => this.send(member.socket, payload));
      return;
    }

    if (message.type === 'player:update' && room.started && !room.finished) {
      if (!player) return;
      const now = Date.now();
      const requestedScore = Math.max(0, Math.floor(Number(message.score) || 0));
      if (requestedScore > player.score && now - player.lastScoreAt >= MIN_SCORE_INTERVAL_MS) {
        player.score += Math.min(SCORE_STEP, requestedScore - player.score);
        player.lastScoreAt = now;
      }
      player.lives = Math.max(0, Math.min(3, Math.floor(Number(message.lives) || 0)));
      player.status = message.status === 'finished' || player.lives <= 0 ? 'finished' : 'playing';
      if (!this.finishIfReady(room)) this.broadcast(room);
    }
  }
}
