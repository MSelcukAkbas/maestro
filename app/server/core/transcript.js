// Konuşma kaydı (projects/*/<id>.jsonl) için ortak okuyucu: dosya kaldığı yerden okunur, her satır bir kez ayrıştırılır
// ve hem ölçüme (meter: token, tur, compact, hata, skill listesi) hem özete (usage: maliyet, son metin, mesajlar) verilir.
const fs = require('fs');
const meter = require('../watch/meter');
const usage = require('./usage');

const cache = new Map();

function fresh() {
  const m = meter.newReader(0);
  m.shared = true;
  return { offset: 0, rest: '', m, u: usage.emptyState() };
}

// Dosyayı kaldığı yerden okur. Dosya yoksa null.
function read(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  let t = cache.get(file);
  // Kısalan dosya baştan okunur (yeniden yazılmış).
  if (!t || size < t.offset) {
    if (t) Object.assign(t.m, fresh().m);
    t = t ? Object.assign(t, { offset: 0, rest: '', u: usage.emptyState() }) : fresh();
    cache.set(file, t);
  }
  if (size > t.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - t.offset);
      fs.readSync(fd, buf, 0, buf.length, t.offset);
      t.offset = size;
      const lines = (t.rest + buf.toString('utf8')).split('\n');
      t.rest = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        meter.readObj(t.m, j);
        usage.applyObj(t.u, j);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return t;
}

// Ölçümün okuyucusu: dosya yoksa da (henüz oluşmamış oturum) boş okuyucu döner; aynı nesne korunur.
function reader(file) {
  const t = read(file);
  if (t) return t.m;
  if (!cache.has(file)) cache.set(file, fresh());
  return cache.get(file).m;
}

module.exports = { read, reader };
