// Ajan süreci: node agent/main.js --port 7788 --data <veri klasörü> [--url ws://host:port/agent]
// Terminal oturumlarını tutar; services bu sürece bağlanıp onları yönetir. Aynı veri klasörü için tek ajan çalışır.
const fs = require('fs');
const path = require('path');
const { AgentHost } = require('./host');
const { pidAlive } = require('./discovery');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dataDir = path.resolve(arg('data') || path.join(__dirname, '..', 'data'));
const port = Number(arg('port')) || 7788;
const url = arg('url') || `ws://127.0.0.1:${port}/agent`;
const lock = path.join(dataDir, 'agent.json');

try {
  const prev = JSON.parse(fs.readFileSync(lock, 'utf8'));
  if (prev.pid && prev.pid !== process.pid && pidAlive(prev.pid)) {
    console.error(`Ajan zaten çalışıyor (pid ${prev.pid}).`);
    process.exit(0);
  }
} catch {}
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, url, startedAt: Date.now() }), 'utf8');
process.on('exit', () => {
  try {
    if (JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid) fs.unlinkSync(lock);
  } catch {}
});

// Anahtar services tarafında yenilenebildiği için her bağlanışta dosyadan okunur (uzak kullanımda MAESTRO_TOKEN).
const getToken = () => process.env.MAESTRO_TOKEN || fs.readFileSync(path.join(dataDir, 'token.txt'), 'utf8').trim();
const host = new AgentHost({ url, getToken, log: (t) => console.log(`[ajan] ${t}`) });
host.start();
console.log(`[ajan] pid ${process.pid}, ${url}`);
// Konsol kapanması ya da Ctrl+C oturumları kapatmaz; yalnızca services'in shutdown isteği kapatır.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {});
