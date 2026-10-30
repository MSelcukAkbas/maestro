// Yerel kullanımda services ajanı kendisi başlatır: ayrı, konsolsuz bir süreç (services kapanınca oturumlar yaşasın).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pidAlive } = require('./discovery');

// Bu veri klasörü için çalışan bir ajan süreci var mı.
function running(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent.json'), 'utf8'));
    return !!j.pid && pidAlive(j.pid);
  } catch {
    return false;
  }
}

function spawnLocal({ port, dataDir }) {
  const child = spawn(process.execPath, [path.join(__dirname, 'main.js'), '--port', String(port), '--data', dataDir], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  return child.pid;
}

module.exports = { running, spawnLocal };
