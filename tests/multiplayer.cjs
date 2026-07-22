const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const port = 3917;
const server = spawn(process.execPath, ['game-pilah-sampah/server.js'], {
  cwd: process.cwd(), env: { ...process.env, PORT: String(port), MATCH_DURATION_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'],
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function next(socket, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout menunggu ${type}`)), timeout);
    const handler = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      clearTimeout(timer); socket.off('message', handler); resolve(message);
    };
    socket.on('message', handler);
  });
}

async function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return socket;
}

async function createMatch(size) {
  const sockets = [await connect()];
  sockets[0].send(JSON.stringify({ type: 'room:create', playerName: 'P1', playerSlot: 1, character: '🐼' }));
  const code = (await next(sockets[0], 'room:joined')).room.code;
  for (let index = 2; index <= size; index++) {
    const socket = await connect(); sockets.push(socket);
    socket.send(JSON.stringify({ type: 'room:join', roomCode: code, playerName: `P${index}`, playerSlot: index, character: '🎮' }));
    await next(socket, 'room:joined');
  }
  await wait(50); sockets[0].send(JSON.stringify({ type: 'room:start' })); await wait(1400);
  sockets.roomCode = code;
  return sockets;
}

async function run() {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server gagal aktif')), 3000);
    server.stdout.on('data', (chunk) => { if (chunk.toString().includes('Game server ready')) { clearTimeout(timer); resolve(); } });
    server.once('exit', (code) => reject(new Error(`Server berhenti: ${code}`)));
  });
  const six = await createMatch(6);
  const spectator = await connect();
  spectator.send(JSON.stringify({ type: 'room:spectate', roomCode: six.roomCode, playerName: 'Penonton' }));
  const spectatorJoined = await next(spectator, 'room:joined');
  assert.equal(spectatorJoined.role, 'spectator');
  assert.equal(spectatorJoined.room.spectators.length, 1);
  const spectatorLiveUpdate = next(spectator, 'room:update');
  const finalMessages = [...six.map((socket) => next(socket, 'room:finished')), next(spectator, 'room:finished')];
  spectator.send(JSON.stringify({ type: 'player:update', score: 9999, lives: 0, status: 'finished' }));
  six[0].send(JSON.stringify({ type: 'player:update', score: 999, lives: 3, status: 'finished' }));
  six[1].send(JSON.stringify({ type: 'player:update', score: 10, lives: 3, status: 'finished' }));
  six[2].send(JSON.stringify({ type: 'player:update', score: 10, lives: 3, status: 'finished' }));
  six.slice(3).forEach((socket) => socket.send(JSON.stringify({ type: 'player:update', score: 0, lives: 0, status: 'finished' })));
  const [finished] = await Promise.all(finalMessages);
  const spectatorLive = await spectatorLiveUpdate;
  assert.equal(spectatorLive.room.players.length, 6, 'spectator harus menerima snapshot pemain secara live');
  assert.equal(finished.results[0].score, 10, 'lonjakan skor harus dibatasi');
  assert.equal(finished.results[0].rank, 1);
  assert.equal(finished.results[1].rank, 1, 'skor seri harus memiliki ranking sama');
  assert.equal(finished.room.history.length, 1, 'hasil harus masuk riwayat');
  assert.equal(finished.results.length, 6, 'spectator tidak boleh masuk ranking');
  const voteUpdates = six.map((socket) => next(socket, 'room:update'));
  six.forEach((socket) => socket.send(JSON.stringify({ type: 'room:rematch' })));
  const updates = await Promise.all(voteUpdates);
  assert(updates.some((message) => message.room.rematchVotes.length > 0), 'voting rematch harus disiarkan');
  six.forEach((socket) => socket.close()); await wait(100);
  spectator.close();
  const two = await createMatch(2);
  const timeoutResult = await next(two[0], 'room:finished', 3000);
  assert.equal(timeoutResult.reason, 'timeout', 'match diam harus selesai karena timeout');
  assert(timeoutResult.results.every((player) => player.rank === 1), 'skor nol seri harus berbagi ranking pertama');
  two.forEach((socket) => socket.close());
  console.log('OK: multiplayer 2–6 pemain + spectator, timeout, tie, history, voting, dan proteksi skor');
}

run().finally(() => server.kill()).catch((error) => { console.error(error); process.exitCode = 1; });
