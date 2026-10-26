// Bu terminal penceresini paneldeki bir oturuma bağlar: node attach.js <oturum-id> [port] [veri-klasörü]
// Pencereyi kapatmak oturumu kapatmaz; yalnızca bu görüntü kapanır.
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const sessionId = process.argv[2];
if (!sessionId) {
  console.error('Kullanım: node attach.js <oturum-id>');
  process.exit(1);
}

const dataDir = process.argv[4] || path.join(__dirname, 'data');
const token = fs.readFileSync(path.join(dataDir, 'token.txt'), 'utf8').trim();
const port = Number(process.argv[3]) || JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).port;

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}&s=${encodeURIComponent(sessionId)}`);
const mySize = () => ({ cols: process.stdout.columns, rows: process.stdout.rows });

ws.on('open', () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => ws.send(JSON.stringify({ t: 'i', d: d.toString('utf8'), ...mySize() })));
  process.stdout.on('resize', () => ws.send(JSON.stringify({ t: 'r', ...mySize() })));
});
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'o') process.stdout.write(m.d);
  else if (m.t === 'x') {
    process.stdout.write('\r\n[Oturum kapandı]\r\n');
    process.exit(0);
  }
});
ws.on('close', () => process.exit(0));
ws.on('error', (err) => {
  console.error('Panele bağlanılamadı:', err.message);
  process.exit(1);
});
