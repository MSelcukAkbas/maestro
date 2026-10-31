// Harcama defteri: panelin kendi yaptığı model çağrıları (bekçi yardımcısı, kurulum danışmanı, rol danışmanı,
// mesaj geliştirici). Oturum kaydı bırakmadıkları için kota ekranında başka yerde görünmezler. data/ledger.json, son 500 çağrı.
const fs = require('fs');
const path = require('path');
const { units } = require('../watch/meter');

const KEEP = 500;

class Ledger {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'ledger.json');
    let d = [];
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    this.list = Array.isArray(d) ? d : [];
    // Model ailesi başına Claude Code'un bildirdiği en son bağlam penceresi.
    this.windows = {};
    for (const x of this.list) Object.assign(this.windows, x.windows || {});
  }

  add(e) {
    Object.assign(this.windows, e.windows || {});
    this.list.push({ ts: Date.now(), ...e, units: Math.round(units(e.tok) * 10000) / 10000 });
    if (this.list.length > KEEP) this.list = this.list.slice(-KEEP);
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.list), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[ledger] kaydedilemedi:', err.message);
    }
  }

  // Son 24 saat tür ve hesap bazında toplam, son 30 çağrı.
  view(now = Date.now()) {
    const day = this.list.filter((x) => now - x.ts < 24 * 3600 * 1000);
    const sum = (key) => {
      const out = {};
      for (const x of day) {
        const o = out[x[key]] || (out[x[key]] = { calls: 0, usd: 0, units: 0, failed: 0 });
        o.calls += 1;
        o.usd += x.costUSD || 0;
        o.units += x.units || 0;
        if (!x.ok) o.failed += 1;
      }
      return out;
    };
    return {
      windows: this.windows,
      day: { byKind: sum('kind'), byAccount: sum('account'), usd: day.reduce((a, x) => a + (x.costUSD || 0), 0) },
      totalUSD: this.list.reduce((a, x) => a + (x.costUSD || 0), 0),
      recent: this.list.slice(-30).reverse().map(({ tok, ...x }) => x),
    };
  }
}

module.exports = { Ledger };
