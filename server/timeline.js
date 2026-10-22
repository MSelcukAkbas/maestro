// Zaman çizelgesi: oturum durumlarındaki geçişler (açılıyor / çalışıyor / onay bekliyor / sıra sende / kapalı)
// iki saniyede bir örneklenir ve grup başına data/timeline/<grup>.json dosyasına yazılır.
// Kayıt panel çalışırken tutulur; panel kapalıyken geçen süre çizelgede boşluk olarak görünür.
const fs = require('fs');
const path = require('path');

class Timeline {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'timeline');
    fs.mkdirSync(this.dir, { recursive: true });
    this.cache = new Map();
  }

  file(gid) {
    return path.join(this.dir, `${gid}.json`);
  }

  load(gid) {
    if (!this.cache.has(gid)) {
      let data = {};
      try { data = JSON.parse(fs.readFileSync(this.file(gid), 'utf8')); } catch {}
      this.cache.set(gid, data);
    }
    return this.cache.get(gid);
  }

  // Yalnızca durum değiştiğinde kayıt eklenir. Hiç kaydı olmayan oturum için "kapalı" yazılmaz.
  record(gid, sid, status, ts = Date.now()) {
    const data = this.load(gid);
    const list = data[sid] || [];
    const last = list[list.length - 1];
    if (last && last.s === status) return false;
    if (!last && status === 'off') return false;
    // Geriye tarihli kayıt (kullanıcının uzaklaştığı an) bir önceki kaydın gerisine düşmez.
    list.push({ t: last ? Math.max(last.t, ts) : ts, s: status });
    data[sid] = list;
    return true;
  }

  save(gid) {
    const data = this.load(gid);
    const target = this.file(gid);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, target);
  }

  get(gid) {
    return this.load(gid);
  }
}

module.exports = { Timeline };
