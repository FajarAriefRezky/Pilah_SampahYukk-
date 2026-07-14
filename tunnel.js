#!/usr/bin/env node
import { spawn } from 'child_process';
import fetch from 'node-fetch';

const PORT = 3000;

// Wait for server to be ready
async function waitForServer(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(`http://localhost:${PORT}/health`);
      if (response.ok) {
        console.log('✅ Server is ready!\n');
        return true;
      }
    } catch (e) {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function startTunnel() {
  console.log('🔗 Starting public tunnel...\n');
  
  // Start localtunnel
  const lt = spawn('npx', ['localtunnel', '--port', PORT, '--host', 'http://localtunnel.me'], {
    stdio: 'inherit',
    shell: true
  });

  lt.on('close', (code) => {
    console.log(`\nTunnel closed with code ${code}`);
    process.exit(code);
  });
}

// Main
console.log('🎮 Pilah Yuk! Public Tunnel Setup');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (await waitForServer()) {
  await startTunnel();
} else {
  console.error('❌ Server failed to start');
  process.exit(1);
}
