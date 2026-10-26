// Bekleyen değişiklikler: çalışan bir üyenin model / effort ayarı değiştiğinde oturumun yeniden başlatılması gerekir.
// Değişiklik hemen değil en ucuz anda uygulanır: üye boştayken (iş yarıda kalmaz) ve model değişiminde önbellek
// soğumuşken (model değişimi önbelleği zaten sıfırlar; sıcakken yapmak bağlamı bir kez fazladan yazdırır). Effort
// değişimi 5.5 modellerde önbelleği korur, yalnızca boşta olmayı bekler. data/pending.json.
const fs = require('fs');
const path = require('path');

class Pending {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'pending.json');
    let d = {};
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    // sid -> { gid, at, model, effort, now, by }
    this.map = new Map(Object.entries(d && typeof d === 'object' ? d : {}));
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[pending] kaydedilemedi:', err.message);
    }
  }

  // change: { model?, effort? } — yalnızca değişen alanlar; aynı üyenin önceki bekleyen değişikliğiyle birleşir.
  add(sid, gid, change, by = 'user', now = false) {
    const cur = this.map.get(sid) || { gid, at: Date.now() };
    const next = { ...cur, ...change, by, now: !!(now || cur.now) };
    this.map.set(sid, next);
    this.save();
    return next;
  }

  get(sid) {
    return this.map.get(sid) || null;
  }

  remove(sid) {
    if (this.map.delete(sid)) this.save();
  }

  entries() {
    return [...this.map.entries()];
  }

  // Uygulama anı geldi mi? info: meter.sessionInfo, idle: üye boşta ve iletim / kullanıcı yazımı yok.
  ready(p, info, idle) {
    if (p.now) return true;
    if (!idle) return false;
    if (p.model) return !(info && info.cacheWarm);
    return true;
  }
}

// Açılışta istenen (want: { at, model, effort, skillsOff }) ile oturum kaydında gerçekleşen (info: meter.sessionInfo)
// arasındaki farklar; boşsa uyumlu.
function driftOf(want, info) {
  if (!want || !info) return [];
  const out = [];
  if (want.model && info.fam && info.fam !== want.model) out.push(`model ${want.model} istendi, ${info.fam} çalışıyor`);
  if (want.effort && info.effort && info.effort !== want.effort) out.push(`effort ${want.effort} istendi, ${info.effort} çalışıyor`);
  if (info.skills && info.skills.ts >= want.at - 5000) {
    const leaked = want.skillsOff.filter((n) => info.skills.names.includes(n));
    if (leaked.length) out.push(`kapatılan skill yüklü: ${leaked.slice(0, 5).join(', ')}${leaked.length > 5 ? ` +${leaked.length - 5}` : ''}`);
  }
  return out;
}

module.exports = { Pending, driftOf };
