// Zamanlayıcı: kullanıcının asistan aracılığıyla kurduğu tek seferlik işler. Zamanı gelince panel sunucusu adımları
// sırayla kendisi yürütür (asistanın ya da başka bir oturumun açık olması gerekmez; panelin açık olması gerekir).
// Adımlar: ac (kapalı üyeleri kaldığı yerden açar), mesaj (kullanıcı mesajı, gelen kutusu yolundan), bekle (dakika,
// herkes boşta ya da cevaplar gelene kadar), compact (soğuk önbellekte de; kullanıcı kararı), kapat (yalnızca boştaki
// ve iletim beklemeyen üyeyi; çalışanı hiç kesmez). Üye kimlikleri her adımda çözülür: bekçinin yenilediği üye
// yerine açılanla değişir. data/zamanlayici.json; panel adım ortasında kapanırsa iş yarıda kalmış sayılır.
const fs = require('fs');
const path = require('path');

const MAX_PENDING = 20;
const MAX_STEPS = 12;
const MAX_AHEAD = 7 * 24 * 60 * 60 * 1000;
// Panel kapalıyken zamanı geçen iş bu kadar gecikmeyle hâlâ çalışır; daha geçse kaçırılmış sayılır.
const LATE = 15 * 60 * 1000;
const KEEP_DONE = 30;
const OPEN_WAIT = 5 * 60 * 1000;
// compact: bekçinin sıra bekleme süresi (1 saat) + compact'ın kendisi (10 dk) + pay.
const COMPACT_WAIT = 75 * 60 * 1000;
const DEFAULT_WAIT = { bosta: 60, yanit: 30, kapat: 30 };
const STEP_TYPES = ['ac', 'mesaj', 'bekle', 'compact', 'kapat'];
const STATUS_TEXT = { bekliyor: 'bekliyor', calisiyor: 'çalışıyor', bitti: 'bitti', iptal: 'iptal edildi', kacirildi: 'kaçırıldı', yarida: 'yarıda kaldı' };

// "21:30", "yarın 08:00", "+90dk", "+1 sa 30 dk", "2 saat sonra", ISO tarih → zaman damgası. Geçersizse Error.
function parseWhen(input, now = Date.now()) {
  const raw = String(input || '').trim().toLocaleLowerCase('tr');
  if (!raw) throw new Error('Zaman verilmedi.');
  const clock = raw.match(/^(yarın\s+)?(\d{1,2})[:.](\d{2})$/);
  if (clock) {
    const h = Number(clock[2]);
    const m = Number(clock[3]);
    if (h > 23 || m > 59) throw new Error(`Geçersiz saat: ${input}`);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (clock[1]) d.setDate(d.getDate() + 1);
    else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const rel = raw.replace(/^\+/, '').replace(/\s*sonra$/, '');
  const parts = [...rel.matchAll(/(\d+)\s*(saat|sa|h|dakika|dk|m|min)\b/g)];
  if (parts.length && parts.map((x) => x[0]).join('').replace(/\s/g, '') === rel.replace(/\s/g, '')) {
    const ms = parts.reduce((t, [, n, u]) => t + Number(n) * (/^(saat|sa|h)$/.test(u) ? 3600000 : 60000), 0);
    if (ms <= 0) throw new Error('Süre sıfır olamaz.');
    return now + ms;
  }
  const iso = Date.parse(String(input).trim());
  if (Number.isFinite(iso)) return iso;
  throw new Error(`Zaman anlaşılamadı: "${input}". Örnek: 21:30, yarın 08:00, +90dk, +2sa.`);
}

class Scheduler {
  // deps: group(gid) -> grup | null; resolve(gid, sid) -> güncel üye (yenilenmişse yerine açılan; çıkarıldıysa null);
  // members(gid) -> grubun çıkarılmamış üyeleri; status(sid) -> 'off' | 'idle' | 'busy' | 'waiting' | 'starting' | …;
  // delivering(gid, sid) -> üyeye iletilecek bir şey var mı; firstTask(session) -> açılınca ilk görevi başlayacak mı;
  // launch(gid, sid) (hata fırlatabilir); stop(sid); send(sid, metin, cevapIste); compact(gid, sid) -> sıraya alındı mı;
  // op(sid) -> süren bekçi hamlesi; cancelOp(sid); compacts(sid) -> compact sayısı; repliedSince(sid, ts) -> bool;
  // event(metin, gid)
  constructor(dataDir, deps) {
    this.file = path.join(dataDir, 'zamanlayici.json');
    this.d = deps;
    this.data = { seq: 0, list: [] };
    try {
      const r = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (r && Array.isArray(r.list)) this.data = { seq: Number(r.seq) || 0, list: r.list };
    } catch {}
  }

  save() {
    // Biten işlerin en yenileri kalır.
    const live = this.data.list.filter((j) => ['bekliyor', 'calisiyor'].includes(j.durum));
    const done = this.data.list.filter((j) => !['bekliyor', 'calisiyor'].includes(j.durum)).slice(-KEEP_DONE);
    this.data.list = [...done, ...live].sort((a, b) => a.id - b.id);
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  list() {
    return this.data.list.slice();
  }

  get(id) {
    return this.data.list.find((j) => j.id === Number(id)) || null;
  }

  pendingCount() {
    return this.data.list.filter((j) => ['bekliyor', 'calisiyor'].includes(j.durum)).length;
  }

  // job: { ad, at, adimlar: [{ tur, gid, uyeler: [sid] | null, metin?, cevap?, dakika?, kosul?, enCok? }] } (doğrulanmış)
  add(job, now = Date.now()) {
    if (this.pendingCount() >= MAX_PENDING) throw new Error(`En fazla ${MAX_PENDING} bekleyen zamanlayıcı olabilir.`);
    if (!Array.isArray(job.adimlar) || !job.adimlar.length) throw new Error('En az bir adım gerekli.');
    if (job.adimlar.length > MAX_STEPS) throw new Error(`Bir zamanlayıcıda en fazla ${MAX_STEPS} adım olabilir.`);
    if (!(job.at > now - 60000)) throw new Error('Zaman geçmişte.');
    if (job.at - now > MAX_AHEAD) throw new Error('En fazla 7 gün sonrasına kurulabilir.');
    const item = {
      id: ++this.data.seq, ad: String(job.ad || '').slice(0, 120) || 'Zamanlayıcı', at: job.at, createdAt: now, by: job.by || 'kullanıcı (asistan)',
      durum: 'bekliyor', adim: 0, adimlar: job.adimlar, kayit: [],
    };
    this.data.list.push(item);
    this.save();
    return item;
  }

  log(job, text, now) {
    job.kayit.push({ ts: now, text });
    if (job.kayit.length > 60) job.kayit = job.kayit.slice(-60);
  }

  cancel(id, now = Date.now()) {
    const job = this.get(id);
    if (!job) throw new Error('Zamanlayıcı bulunamadı.');
    if (!['bekliyor', 'calisiyor'].includes(job.durum)) throw new Error(`Zamanlayıcı zaten ${STATUS_TEXT[job.durum]}.`);
    // Bu işin sıraya aldığı ve henüz başlamamış compact'lar da bırakılır.
    if (job.durum === 'calisiyor' && job.s && job.adimlar[job.adim].tur === 'compact') {
      for (const [sid, r] of Object.entries(job.s.uyeler || {})) if (r.queued && !r.sonuc) this.d.cancelOp(sid);
    }
    job.durum = 'iptal';
    job.bitis = now;
    this.log(job, 'kullanıcı iptal etti', now);
    this.save();
    return job;
  }

  // Panel açılışında: yarıda kalan işler kapatılır (oturumlar ve bekçi hamleleri panelle birlikte kapandı); zamanı
  // çoktan geçmiş olanlar kaçırılmış sayılır.
  recover(now = Date.now()) {
    let changed = false;
    for (const job of this.data.list) {
      if (job.durum === 'calisiyor') {
        job.durum = 'yarida';
        job.bitis = now;
        this.log(job, `panel ${job.adim + 1}. adımdayken kapandı; iş yarıda kaldı`, now);
        this.d.event(`Zamanlayıcı #${job.id} "${job.ad}" panel kapandığı için yarıda kaldı (${job.adim + 1}. adım).`, this.gidOf(job));
        changed = true;
      } else if (job.durum === 'bekliyor' && now - job.at > LATE) {
        job.durum = 'kacirildi';
        job.bitis = now;
        this.log(job, 'panel o saatte kapalıydı', now);
        this.d.event(`Zamanlayıcı #${job.id} "${job.ad}" kaçırıldı: panel ${new Date(job.at).toLocaleString('tr-TR')} saatinde kapalıydı.`, this.gidOf(job));
        changed = true;
      }
    }
    if (changed) this.save();
  }

  gidOf(job) {
    const s = job.adimlar.find((a) => a.gid);
    return s ? s.gid : null;
  }

  // Adımın üyeleri: verilmediyse grubun bütün üyeleri; verildiyse yenilenenler yerine açılanla.
  targets(step) {
    if (!step.uyeler) return this.d.members(step.gid).map((s) => s.id);
    return [...new Set(step.uyeler.map((sid) => this.d.resolve(step.gid, sid)).filter(Boolean).map((s) => s.id))];
  }

  tick(now = Date.now()) {
    let changed = false;
    for (const job of this.data.list) {
      if (job.durum === 'bekliyor' && job.at <= now) {
        if (now - job.at > LATE) {
          job.durum = 'kacirildi';
          job.bitis = now;
          this.log(job, 'zamanında çalıştırılamadı', now);
          this.d.event(`Zamanlayıcı #${job.id} "${job.ad}" kaçırıldı.`, this.gidOf(job));
        } else {
          job.durum = 'calisiyor';
          job.basladi = now;
          this.log(job, 'başladı', now);
          this.d.event(`Zamanlayıcı #${job.id} "${job.ad}" başladı.`, this.gidOf(job));
        }
        changed = true;
      }
      if (job.durum !== 'calisiyor') continue;
      // Bir tikte birden çok anlık adım (ör. mesaj) ilerleyebilir.
      for (let guard = 0; guard < MAX_STEPS && job.durum === 'calisiyor'; guard++) {
        let done;
        try {
          done = this.step(job, job.adimlar[job.adim], now);
        } catch (err) {
          this.log(job, `${job.adim + 1}. adım: ${err.message}`, now);
          done = true;
        }
        changed = true;
        if (!done) break;
        job.adim += 1;
        job.s = null;
        if (job.adim >= job.adimlar.length) {
          job.durum = 'bitti';
          job.bitis = now;
          this.log(job, 'bitti', now);
          const notes = job.kayit.filter((x) => x.uyari).map((x) => x.text);
          this.d.event(`Zamanlayıcı #${job.id} "${job.ad}" bitti${notes.length ? `; dikkat: ${notes.slice(0, 3).join(' · ')}` : '.'}`, this.gidOf(job));
        }
      }
    }
    if (changed) this.save();
  }

  warn(job, text, now) {
    job.kayit.push({ ts: now, text, uyari: true });
  }

  // Adım bittiyse true. Durum job.s'te tutulur (adım başında kurulur).
  step(job, step, now) {
    const no = `${job.adim + 1}. adım (${step.tur})`;
    const group = this.d.group(step.gid);
    if (!group) {
      this.warn(job, `${no}: grup artık yok, atlandı`, now);
      return true;
    }
    const name = (sid) => {
      const s = group.sessions.find((x) => x.id === sid);
      return s ? s.roleLabel || s.name : sid.slice(0, 8);
    };
    if (!job.s) job.s = { basladi: now, uyeler: {}, sayac: 0 };
    const s = job.s;
    const elapsed = now - s.basladi;

    if (step.tur === 'ac') {
      if (!s.acildi) {
        s.acildi = true;
        const opened = [];
        for (const sid of this.targets(step)) {
          const session = group.sessions.find((x) => x.id === sid);
          if (this.d.status(sid) !== 'off') continue;
          if (session && this.d.firstTask(session)) {
            this.warn(job, `${no}: ${name(sid)} hiç açılmamış, açılınca ilk görevine başlar; açılmadı`, now);
            continue;
          }
          try {
            this.d.launch(step.gid, sid);
            opened.push(sid);
            s.uyeler[sid] = {};
          } catch (err) {
            this.warn(job, `${no}: ${name(sid)} açılamadı: ${err.message}`, now);
          }
        }
        this.log(job, `${no}: ${opened.length ? `${opened.map(name).join(', ')} açılıyor` : 'açılacak kapalı üye yok'}`, now);
        return !opened.length;
      }
      const notReady = Object.keys(s.uyeler).filter((sid) => !['idle', 'waiting'].includes(this.d.status(sid)));
      if (!notReady.length) {
        this.log(job, `${no}: hepsi hazır`, now);
        return true;
      }
      if (elapsed > OPEN_WAIT) {
        this.warn(job, `${no}: ${notReady.map(name).join(', ')} 5 dakikada hazır olmadı (güven sorusu ya da açılış ekranı olabilir)`, now);
        return true;
      }
      return false;
    }

    if (step.tur === 'mesaj') {
      const list = this.targets(step);
      for (const sid of list) this.d.send(sid, step.metin, !!step.cevap);
      job.sonMesaj = { ts: now, uyeler: list };
      this.log(job, `${no}: ${list.map(name).join(', ') || 'kimse'} → "${String(step.metin).slice(0, 80)}"${step.cevap ? ' (cevap istendi)' : ''}`, now);
      return true;
    }

    if (step.tur === 'bekle') {
      if (step.dakika) {
        if (elapsed >= step.dakika * 60000) {
          this.log(job, `${no}: ${step.dakika} dk beklendi`, now);
          return true;
        }
        return false;
      }
      const limit = (step.enCok || DEFAULT_WAIT[step.kosul] || 60) * 60000;
      if (step.kosul === 'yanit') {
        const ask = job.sonMesaj;
        const waiting = ask ? ask.uyeler.filter((sid) => !this.d.repliedSince(sid, ask.ts)) : [];
        if (!waiting.length) {
          this.log(job, `${no}: cevaplar geldi`, now);
          return true;
        }
        if (elapsed > limit) {
          this.warn(job, `${no}: ${waiting.map(name).join(', ')} cevap vermedi`, now);
          return true;
        }
        return false;
      }
      // bosta: çalışan hedeflerin hepsi iki ardışık örnekte boşta ve iletim beklemiyor.
      const busy = this.targets(step).filter((sid) => this.d.status(sid) !== 'off' && (this.d.status(sid) !== 'idle' || this.d.delivering(step.gid, sid)));
      s.sayac = busy.length ? 0 : s.sayac + 1;
      if (s.sayac >= 2) {
        this.log(job, `${no}: herkes boşta`, now);
        return true;
      }
      if (elapsed > limit) {
        this.warn(job, `${no}: ${busy.map(name).join(', ')} hâlâ çalışıyordu; beklemeden devam edildi`, now);
        return true;
      }
      return false;
    }

    if (step.tur === 'compact') {
      if (!s.kuruldu) {
        s.kuruldu = true;
        for (const sid of this.targets(step)) {
          if (this.d.status(sid) === 'off') continue;
          const queued = this.d.compact(step.gid, sid);
          s.uyeler[sid] = { queued, once: this.d.compacts(sid) };
          if (!queued) {
            s.uyeler[sid].sonuc = 'sıraya alınamadı (süren başka bir hamle var)';
          }
        }
        const n = Object.keys(s.uyeler).length;
        this.log(job, `${no}: ${n ? `${Object.keys(s.uyeler).map(name).join(', ')} için compact sıraya alındı` : 'açık üye yok'}`, now);
        if (!n) return true;
      }
      for (const [sid, r] of Object.entries(s.uyeler)) {
        if (r.sonuc || this.d.op(sid)) continue;
        // Hamle bitti: başarıyı compact sayısının artmasından anla (bekçi başarısız hamleyi de siler).
        r.sonuc = this.d.compacts(sid) > r.once ? 'ok' : 'olmadı';
      }
      const open = Object.entries(s.uyeler).filter(([, r]) => !r.sonuc);
      if (open.length && elapsed <= COMPACT_WAIT) return false;
      const ok = Object.entries(s.uyeler).filter(([, r]) => r.sonuc === 'ok').map(([sid]) => name(sid));
      const bad = Object.entries(s.uyeler).filter(([, r]) => r.sonuc && r.sonuc !== 'ok').map(([sid]) => name(sid));
      this.log(job, `${no}: ${ok.length ? `compact edildi: ${ok.join(', ')}` : 'compact edilen yok'}`, now);
      if (bad.length) this.warn(job, `${no}: compact olmadı: ${bad.join(', ')}`, now);
      if (open.length) this.warn(job, `${no}: ${open.map(([sid]) => name(sid)).join(', ')} compact'ı zamanında bitmedi`, now);
      return true;
    }

    if (step.tur === 'kapat') {
      const limit = (step.enCok || DEFAULT_WAIT.kapat) * 60000;
      const left = [];
      for (const sid of this.targets(step)) {
        if (this.d.status(sid) === 'off') continue;
        // Çalışan, iletim bekleyen ya da bekçi hamlesi süren üye kapatılmaz; iki ardışık boş örnek beklenir.
        const free = this.d.status(sid) === 'idle' && !this.d.delivering(step.gid, sid) && !this.d.op(sid);
        const r = s.uyeler[sid] || (s.uyeler[sid] = { bos: 0 });
        r.bos = free ? r.bos + 1 : 0;
        if (r.bos >= 2) {
          this.d.stop(sid);
          r.kapandi = true;
        } else left.push(sid);
      }
      if (!left.length) {
        const closed = Object.entries(s.uyeler).filter(([, r]) => r.kapandi).map(([sid]) => name(sid));
        this.log(job, `${no}: ${closed.length ? `kapatıldı: ${closed.join(', ')}` : 'açık üye yoktu'}`, now);
        return true;
      }
      if (elapsed > limit) {
        this.warn(job, `${no}: ${left.map(name).join(', ')} hâlâ çalışıyordu, kapatılmadı`, now);
        return true;
      }
      return false;
    }

    this.warn(job, `${no}: bilinmeyen adım, atlandı`, now);
    return true;
  }
}

module.exports = { Scheduler, parseWhen, STEP_TYPES, STATUS_TEXT, MAX_STEPS };
