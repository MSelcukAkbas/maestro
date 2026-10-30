// Konuşma kaydı (projects/*/<id>.jsonl) için ortak okuyucu: dosya kaldığı yerden okunur, her satır bir kez ayrıştırılır
// ve hem ölçüme (meter: token, tur, compact, hata, skill listesi) hem özete (usage: maliyet, son metin, mesajlar) verilir.
const agent = require('../../agent');
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
  let t = cache.get(file);
  const res = agent.transcripts.readNew(file, t ? { offset: t.offset, rest: t.rest } : null);
  if (!res) return null;
  if (!t) {
    t = fresh();
    cache.set(file, t);
  } else if (res.reset) {
    // Kısalan dosya baştan okunur (yeniden yazılmış).
    Object.assign(t.m, fresh().m);
    Object.assign(t, { u: usage.emptyState() });
  }
  t.offset = res.cursor.offset;
  t.rest = res.cursor.rest;
  for (const line of res.lines) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    meter.readObj(t.m, j);
    usage.applyObj(t.u, j);
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
