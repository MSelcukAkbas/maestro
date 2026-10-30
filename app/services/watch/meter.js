// Ölçüm: hesap kotası ile token harcaması arasındaki oranı öğrenir, hesap taşıma ve compact maliyetini kaydeder,
// üyelerin bağlam büyüme hızını ve hatalı tool serilerini izler. Bekçi bu veriyle karar verir.
// Kota uç noktası tam sayı yüzde verdiği için oran tek tek ölçümlerden değil, aynı kota penceresi içindeki kesintisiz
// "temiz" aralıklardan (panel dışı oturumların harcaması karışmamış) çıkarılır.
const fs = require('fs');
const path = require('path');
const agent = require('../../agent');

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
// Varsayım: abonelik kotası token türlerini API fiyat oranlarıyla tartar (Fable fiyatı bilinmediği için Opus'unki).
// Ölçümler ham token bileşenleriyle saklanır; ağırlık değişirse geçmiş yeniden hesaplanır. Birim ≈ API eşdeğeri $.
const PRICE_IN = { opus: 5, sonnet: 3, haiku: 1, fable: 5 };
const MULT = { in: 1, out: 5, cw: 1.25, cr: 0.1 };

const MAX_TURNS = 40;
const CTX_KEEP = 2 * 3600 * 1000;
const STRETCH_KEEP = 14 * 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const HISTORY_KEEP = 7 * 24 * HOUR;
// Saatlik geçmiş diske en sık bu aralıkla yazılır (her dakikalık ölçümde yazmaya gerek yok).
const HISTORY_SAVE_GAP = 5 * 60 * 1000;
const MIN_STRETCH_USED = 3;
// Aynı pencere: sıfırlanma zamanı her sorguda saniyenin altında oynar.
const SAME_WINDOW = 120 * 1000;
// Aralıkta panel dışı harcama, hesabın panel harcamasının bu oranını geçerse aralık kirli sayılır.
const OUTSIDE_SHARE = 0.1;
const OUTSIDE_FLOOR = 0.01;
const RECENT_ERR = 30 * 60 * 1000;
const IDLE_COMPACT_GAP = 20 * 60 * 1000;
// Kullanıcının reddettiği ya da kestiği tool çağrıları modelin takıldığını göstermez; hata serisini ne artırır ne sıfırlar.
const NOT_STUCK = /^(Permission for this action was denied|The user doesn't want to proceed|\[Request interrupted by user|\[Tool call interrupted|The server-side auto mode classifier)/;

function family(model) {
  const m = String(model || '');
  return FAMILIES.find((f) => m.includes(f)) || null;
}

function addTok(dst, fam, c) {
  const t = dst[fam] || (dst[fam] = { in: 0, out: 0, cw: 0, cr: 0 });
  t.in += c.in || 0;
  t.out += c.out || 0;
  t.cw += c.cw || 0;
  t.cr += c.cr || 0;
}

function copyTok(src) {
  const out = {};
  for (const [f, t] of Object.entries(src || {})) out[f] = { ...t };
  return out;
}

function diffTok(a, b) {
  const out = {};
  for (const [f, t] of Object.entries(a || {})) {
    const p = (b && b[f]) || {};
    out[f] = { in: t.in - (p.in || 0), out: t.out - (p.out || 0), cw: t.cw - (p.cw || 0), cr: t.cr - (p.cr || 0) };
  }
  return out;
}

function mergeTok(dst, src) {
  for (const [f, t] of Object.entries(src || {})) addTok(dst, f, t);
}

function units(tok) {
  let u = 0;
  for (const [f, t] of Object.entries(tok || {})) {
    const p = PRICE_IN[f] || PRICE_IN.opus;
    u += p * (t.in * MULT.in + t.out * MULT.out + t.cw * MULT.cw + t.cr * MULT.cr) / 1e6;
  }
  return u;
}

function textLen(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((n, c) => n + (c && c.type === 'text' ? String(c.text || '').length : 0), 0);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((x) => (x && x.text) || '').join(' ') : '';
}

// Konuşma dosyasını kaldığı yerden okuyan, yalnızca token ve sinyal toplayan okuyucu. Alt ajan dosyalarındaki
// tüm satırlar isSidechain olduğu için usage.js bunları saymaz; burada sayılır.
function newReader(offset = 0) {
  return {
    offset, rest: '', seen: new Set(), tok: {}, turns: [], compacts: [],
    fam: null, ctx: 0, lastTurnAt: null, lastToolAt: null, errStreak: 0, errTimes: [],
  };
}

function readLine(r, line) {
  let j;
  try { j = JSON.parse(line); } catch { return; }
  readObj(r, j);
}

// j: konuşma kaydının ayrıştırılmış bir satırı.
function readObj(r, j) {
  const ts = j.timestamp ? Date.parse(j.timestamp) : null;
  if (j.type === 'system' && j.subtype === 'compact_boundary') {
    const m = j.compactMetadata || {};
    // Claude Code'un boşta compact'ı (önbellek düşmeden önce) kayıtta "auto" görünür; uzun bir sessizliğin ardından gelen
    // otomatik compact bağlam sınırından değil boşluktan sayılır. Bekçinin "2 compact → yenile" sayacına girmez.
    const idle = m.trigger === 'auto' && !!r.lastTurnAt && !!ts && ts - r.lastTurnAt >= IDLE_COMPACT_GAP;
    r.compacts.push({ ts: ts || Date.now(), trigger: m.trigger || null, idle, pre: Number(m.preTokens) || 0, post: Number(m.postTokens) || 0, summaryTok: 0 });
    // Compact sonrası ilk tura kadar bağlam tahminidir: özet (postTokens) + yeniden eklenen sabit kısım (ratios().base).
    // Yoksa eski bağlam büyük görünmeye devam eder ve aynı üyeye yeniden hamle önerilir.
    if (Number(m.postTokens)) {
      r.ctx = Number(m.postTokens);
      r.ctxEstimated = true;
    }
    return;
  }
  // Oturumun gördüğü skill listesi (ad + açıklama); yetenek kataloğu ve maliyet tahmini buradan öğrenilir.
  if (j.type === 'attachment' && j.attachment && j.attachment.type === 'skill_listing') {
    r.skillListing = j.attachment;
    // Oturumun bağlamındaki son liste: istenen skill ayarı uygulandı mı karşılaştırması için.
    if (!j.isSidechain && Array.isArray(j.attachment.names)) r.lastSkills = { names: j.attachment.names, ts: ts || Date.now() };
    return;
  }
  if (j.type === 'user' && j.message) {
    const c = j.message.content;
    // Compact çağrısının kendisi kayda usage yazmaz; tahmini maliyeti (eski bağlamın okunması + özet) eklenir.
    if (j.isCompactSummary) {
      const last = r.compacts[r.compacts.length - 1];
      if (last && !last.summaryTok) {
        last.summaryTok = Math.ceil(textLen(c) / 4);
        if (r.fam) addTok(r.tok, r.fam, { cr: last.pre, out: last.summaryTok });
      }
      return;
    }
    if (Array.isArray(c)) {
      for (const x of c) {
        if (!x || x.type !== 'tool_result') continue;
        if (x.is_error && NOT_STUCK.test(resultText(x.content).trim())) continue;
        if (x.is_error) {
          r.errStreak++;
          r.errTimes.push(ts || Date.now());
          if (r.errTimes.length > 50) r.errTimes.shift();
        } else r.errStreak = 0;
      }
    }
    return;
  }
  if (j.type !== 'assistant' || !j.message) return;
  const m = j.message;
  const fam = family(m.model);
  if (fam && !j.isSidechain) r.fam = fam;
  if (typeof j.effort === 'string' && !j.isSidechain) r.effort = j.effort;
  if (Array.isArray(m.content) && m.content.some((x) => x && x.type === 'tool_use') && ts) r.lastToolAt = ts;
  const u = m.usage;
  if (!u || !fam) return;
  const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  if (ctx > 0 && !j.isSidechain) {
    r.ctx = ctx;
    r.ctxEstimated = false;
  }
  // Önbellek ömrü: tur önbelleğe hangi süreyle yazdıysa (1 saat ya da 5 dakika) o geçerlidir.
  const cc = u.cache_creation;
  if (cc && !j.isSidechain) {
    if (cc.ephemeral_1h_input_tokens > 0) r.ttlMs = 60 * 60 * 1000;
    else if (cc.ephemeral_5m_input_tokens > 0) r.ttlMs = 5 * 60 * 1000;
  }
  const id = m.id || j.uuid;
  if (r.seen.has(id)) return;
  r.seen.add(id);
  const c = { in: u.input_tokens || 0, out: u.output_tokens || 0, cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0 };
  addTok(r.tok, fam, c);
  if (ts) r.lastTurnAt = ts;
  r.turns.push({ ts: ts || Date.now(), fam, ...c });
  if (r.turns.length > MAX_TURNS) r.turns.shift();
}

function readMore(r, file) {
  const res = agent.transcripts.readNew(file, { offset: r.offset, rest: r.rest });
  if (!res) return false;
  if (res.reset) Object.assign(r, newReader(0));
  if (res.cursor.offset === r.offset) return false;
  r.offset = res.cursor.offset;
  r.rest = res.cursor.rest;
  for (const line of res.lines) readLine(r, line);
  return true;
}

// Ekleme sırasına göre en yeni N kayıt.
function tail(list, n) {
  return list.length > n ? list.slice(list.length - n) : list;
}

class Meter {
  constructor(dataDir, projectsDir) {
    this.file = path.join(dataDir, 'meter.json');
    this.projectsDir = projectsDir;
    let d = {};
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    this.stretches = Array.isArray(d.stretches) ? d.stretches : [];
    this.records = Array.isArray(d.records) ? d.records : [];
    this.ttl = Array.isArray(d.ttl) ? d.ttl : [];
    // Saatlik tüketim geçmişi: usage = üye başına saatlik token ({ h, sid, name, acc, tok }), series = hesap başına saatin son kota ölçümü.
    this.usage = Array.isArray(d.usage) ? d.usage : [];
    this.series = Array.isArray(d.series) ? d.series : [];
    this.usageIndex = new Map(this.usage.map((x) => [`${x.h}:${x.sid}`, x]));
    this.lastSave = 0;
    this.startedAt = Date.now();
    this.readers = new Map();
    // Dosyanın hesaba yazılmış son token toplamı; ilk görüşte taban olur, önceki harcama sayılmaz.
    this.counted = new Map();
    this.acc = new Map();
    this.outside = {};
    this.track = new Map();
    this.sess = new Map();
    this.pending = [];
    this.outsideReady = false;
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ stretches: this.stretches, records: this.records, ttl: this.ttl, usage: this.usage, series: this.series }), 'utf8');
    fs.renameSync(tmp, this.file);
    this.lastSave = Date.now();
  }

  // Üyenin bu saatteki harcamasına ekler (alt ajanlar üyeye yazılır); 7 günden eski saatler atılır.
  addUsage(s, tok, now) {
    if (!(units(tok) > 0)) return;
    const h = Math.floor(now / HOUR) * HOUR;
    const key = `${h}:${s.id}`;
    let b = this.usageIndex.get(key);
    if (!b) {
      b = { h, sid: s.id, name: s.name, acc: s.accountId, tok: {} };
      this.usage.push(b);
      this.usageIndex.set(key, b);
    }
    // Aynı saat içinde hesap değiştiyse son hesap yazılır; saatlik toplam hesaba bölünmez.
    b.acc = s.accountId;
    b.name = s.name;
    mergeTok(b.tok, tok);
    this.usageDirty = true;
  }

  // Kota ölçümü her dakika gelir; saatin son ölçümü tutulur.
  addSeries(row, now) {
    if (!row.five && !row.week) return;
    const h = Math.floor(now / HOUR) * HOUR;
    const point = { h, t: now, acc: row.accountId, five: row.five ? row.five.used : null, week: row.week ? row.week.used : null };
    const i = this.series.findIndex((x) => x.h === h && x.acc === row.accountId);
    if (i >= 0) this.series[i] = point;
    else this.series.push(point);
    this.usageDirty = true;
  }

  pruneHistory(now) {
    const cut = now - HISTORY_KEEP;
    this.usage = this.usage.filter((x) => x.h >= cut);
    this.series = this.series.filter((x) => x.h >= cut);
    this.usageIndex = new Map(this.usage.map((x) => [`${x.h}:${x.sid}`, x]));
  }

  // Son `hours` saatin üye başına harcaması (birime göre azalan) ve hesap başına kota serisi. Pencerenin başına denk gelen
  // kısmi saat, harcamanın o saate eşit yayıldığı varsayımıyla oransal sayılır.
  history(hours, now = Date.now()) {
    const from = now - hours * HOUR;
    const bySid = new Map();
    for (const x of this.usage.filter((u) => u.h + HOUR > from)) {
      const e = bySid.get(x.sid) || { sid: x.sid, name: x.name, acc: x.acc, tok: {} };
      e.name = x.name;
      e.acc = x.acc;
      const w = Math.min(1, (x.h + HOUR - from) / HOUR);
      const part = {};
      for (const [f, t] of Object.entries(x.tok)) part[f] = { in: t.in * w, out: t.out * w, cw: t.cw * w, cr: t.cr * w };
      mergeTok(e.tok, part);
      bySid.set(x.sid, e);
    }
    const members = [...bySid.values()].map((e) => {
      const u = units(e.tok);
      const t = Object.values(e.tok).reduce((n, v) => n + v.in + v.out + v.cw + v.cr, 0);
      return { sid: e.sid, name: e.name, acc: e.acc, units: u, tokens: t, est: this.estimate(e.acc, u) };
    }).sort((a, b) => b.units - a.units);
    const series = this.series.filter((x) => x.h + HOUR > from).sort((a, b) => a.h - b.h);
    return { members, series };
  }

  // Baştan okunan dosya (panel oturumu) özetle ortak okuyucudan gelir; her satır bir kez ayrıştırılır. Sonundan okunan
  // (panel dışı, açılışta var olan) dosyanın yalnızca bundan sonraki harcaması gerektiği için kendi okuyucusu vardır.
  reader(file, fromEnd) {
    let r = this.readers.get(file);
    if (!r && !fromEnd) {
      r = require('../core/transcript').reader(file);
      this.readers.set(file, r);
      return r;
    }
    if (r && r.shared) return require('../core/transcript').reader(file);
    if (!r) {
      let size = 0;
      if (fromEnd) size = agent.transcripts.size(file) || 0;
      r = newReader(size);
      this.readers.set(file, r);
    }
    readMore(r, file);
    return r;
  }

  // Panel açıldıktan sonra oluşan dosyanın tamamı sayılır; önceden var olanın ilk görüşü taban olur.
  firstSight(file) {
    if (this.counted.has(file)) return;
    let born = 0;
    born = agent.transcripts.birth(file) || 0;
    if (born > this.startedAt) this.counted.set(file, {});
  }

  // Dosyanın son okumadan bu yana harcadığı token.
  delta(file, r) {
    const prev = this.counted.get(file);
    this.counted.set(file, copyTok(r.tok));
    return prev ? diffTok(r.tok, prev) : {};
  }

  // sessions: [{ id, name, accountId, file }] — çalışan ya da az önce çalışmış üyeler.
  tick(sessions, now = Date.now()) {
    for (const s of sessions) {
      if (!s.file) continue;
      const accTok = this.acc.get(s.accountId) || {};
      this.acc.set(s.accountId, accTok);
      this.firstSight(s.file);
      const r = this.reader(s.file, false);
      const own = this.delta(s.file, r);
      mergeTok(accTok, own);
      this.addUsage(s, own, now);
      const subs = agent.transcripts.subagentFiles(s.file);
      // Alt ajan çalışırken ana dosya sessiz kalır; son etkinlik alt ajanların son turu da hesaba katılarak bulunur.
      let subLastAt = 0;
      for (const p of subs) {
        this.firstSight(p);
        const sr = this.reader(p, false);
        const sub = this.delta(p, sr);
        mergeTok(accTok, sub);
        this.addUsage(s, sub, now);
        subLastAt = Math.max(subLastAt, sr.lastTurnAt || 0);
      }
      this.watchSession(s, r, now);
      this.sess.get(s.id).subLastAt = subLastAt;
    }
    this.persistHistory(now);
  }

  watchSession(s, r, now) {
    let w = this.sess.get(s.id);
    if (!w) {
      w = { ctxHist: [], compactsSeen: r.compacts.length, turnsSeen: r.turns.length };
      this.sess.set(s.id, w);
    }
    w.reader = r;
    w.file = s.file;
    w.name = s.name;
    w.accountId = s.accountId;
    // Bağlam küçüldüyse (compact) büyüme hızı o noktadan yeniden ölçülür.
    const h = w.ctxHist;
    const last = h[h.length - 1];
    const cur = this.context(r);
    if (cur && (!last || last.v !== cur)) {
      if (last && cur < last.v) h.length = 0;
      h.push({ t: now, v: cur });
    }
    while (h.length > 1 && now - h[0].t > CTX_KEEP) h.shift();

    let changed = false;
    for (const c of r.compacts.slice(w.compactsSeen)) {
      this.pending.push({ kind: 'compact', sid: s.id, name: s.name, acc: s.accountId, ts: c.ts, trigger: c.trigger, pre: c.pre, post: c.post, compact: c });
    }
    w.compactsSeen = r.compacts.length;

    // Önbellek ömrü gözlemi: aynı oturumda araya hesap değişimi ya da compact girmemiş ardışık iki tur.
    const fresh = r.turns.slice(Math.max(0, w.turnsSeen - 1));
    for (let i = 1; i < fresh.length; i++) {
      const a = fresh[i - 1];
      const b = fresh[i];
      const gap = b.ts - a.ts;
      const total = b.cw + b.cr;
      if (gap < 60 * 1000 || total < 20000) continue;
      const broken = this.records.concat(this.pending).some((x) => x.sid === s.id && x.ts > a.ts && x.ts <= b.ts)
        || r.compacts.some((c) => c.ts > a.ts && c.ts <= b.ts);
      if (broken) continue;
      const hit = b.cr >= 0.8 * total ? true : b.cw >= 0.5 * total ? false : null;
      if (hit == null) continue;
      this.ttl.push({ gap, hit, t: b.ts });
      if (this.ttl.length > 300) this.ttl.shift();
      changed = true;
    }
    w.turnsSeen = r.turns.length;

    // Bekleyen maliyet kayıtları: olaydan sonraki ilk tur (yeni hesapta ya da compact sonrası yeniden yazılan bağlam).
    for (const p of this.pending.filter((x) => x.sid === s.id)) {
      const turn = r.turns.find((t) => t.ts > p.ts);
      if (!turn) continue;
      const tok = {};
      addTok(tok, turn.fam, turn);
      if (p.kind === 'compact' && p.compact.summaryTok) addTok(tok, turn.fam, { cr: p.pre, out: p.compact.summaryTok });
      // Önbellek açısından önemli olan, olaydan önceki son tur ile sonraki ilk tur arasındaki süredir.
      if (p.prevTurnAt) p.idleMs = turn.ts - p.prevTurnAt;
      const rec = { ...p, compact: undefined, summaryTok: p.compact ? p.compact.summaryTok : undefined, turn: { ts: turn.ts, cw: turn.cw, cr: turn.cr, in: turn.in, out: turn.out, fam: turn.fam }, tok };
      this.records.push(rec);
      if (this.records.length > 300) this.records.shift();
      this.pending.splice(this.pending.indexOf(p), 1);
      changed = true;
    }
    if (changed) this.save();
  }

  // Hesap değişiminden hemen önce çağrılır (tick zaten yapılmış olmalı ki önceki harcama eski hesaba yazılsın).
  noteSwitch(session, file, from, to, now = Date.now()) {
    const r = file ? this.reader(file, false) : null;
    // Arada tur olmadan art arda yapılan değişimlerde yalnızca sonuncusu ölçülür.
    this.pending = this.pending.filter((x) => !(x.kind === 'tasi' && x.sid === session.id));
    this.pending.push({
      kind: 'tasi', sid: session.id, name: session.name, from, to, acc: to, ts: now,
      ctxBefore: r ? r.ctx : null, prevTurnAt: r ? r.lastTurnAt : null, idleMs: null,
    });
  }

  // Panel dışı oturumların harcaması: hangi hesapta çalıştıkları bilinmediği için yalnızca aralığı kirletir.
  scanOutside() {
    const panelFiles = new Set([...this.sess.values()].map((w) => w.file));
    for (const p of agent.transcripts.allFiles(this.projectsDir)) {
      if (panelFiles.has(p)) continue;
      // Açılışta var olan dosyalar sonundan, sonradan oluşanlar baştan okunur.
      let fresh = false;
      if (this.outsideReady && !this.readers.has(p)) {
        fresh = (agent.transcripts.birth(p) || 0) > this.startedAt;
        if (fresh) this.counted.set(p, {});
      }
      const r = this.reader(p, !fresh);
      mergeTok(this.outside, this.delta(p, r));
    }
    this.outsideReady = true;
  }

  // Taze kota ölçümü geldiğinde: her hesap ve pencere için açık aralığı uzatır ya da kapatıp kaydeder.
  onQuota(q, now = Date.now()) {
    this.scanOutside();
    let changed = false;
    for (const row of q.rows) {
      if (row.status !== 'canlı') continue;
      this.addSeries(row, now);
      for (const kind of ['five', 'week']) {
        const key = `${row.accountId}:${kind}`;
        const b = row[kind];
        const reset = b && b.resetsAt ? Date.parse(b.resetsAt) : NaN;
        if (!b || !Number.isFinite(reset)) {
          if (this.closeStretch(row.accountId, kind)) changed = true;
          this.track.delete(key);
          continue;
        }
        const point = { t: now, used: b.used, reset, tok: copyTok(this.acc.get(row.accountId)), out: copyTok(this.outside) };
        const tr = this.track.get(key);
        if (!tr) {
          this.track.set(key, { start: point, last: point });
          continue;
        }
        const sameWin = Math.abs(reset - tr.last.reset) < SAME_WINDOW && b.used >= tr.last.used;
        const dAcc = units(diffTok(point.tok, tr.last.tok));
        const dOut = units(diffTok(point.out, tr.last.out));
        const clean = sameWin && (dOut < OUTSIDE_FLOOR || dOut <= OUTSIDE_SHARE * dAcc);
        if (clean) {
          tr.last = point;
          continue;
        }
        if (this.closeStretch(row.accountId, kind)) changed = true;
        this.track.set(key, { start: point, last: point });
      }
    }
    if (changed) this.save();
    else this.persistHistory(now);
  }

  // Saatlik geçmişi en sık HISTORY_SAVE_GAP'te bir yazar; kota canlı olmasa da tick'ten çağrılır. force: kapanışta kalanı yazar.
  persistHistory(now = Date.now(), force = false) {
    if (!this.usageDirty || (!force && now - this.lastSave < HISTORY_SAVE_GAP)) return;
    this.pruneHistory(now);
    this.usageDirty = false;
    this.save();
  }

  closeStretch(accountId, kind) {
    const tr = this.track.get(`${accountId}:${kind}`);
    if (!tr) return false;
    const s = this.stretchOf(accountId, kind, tr);
    if (!s || s.dUsed < 1) return false;
    this.stretches.push(s);
    const cut = Date.now() - STRETCH_KEEP;
    this.stretches = this.stretches.filter((x) => x.t1 >= cut);
    return true;
  }

  stretchOf(accountId, kind, tr) {
    const tok = diffTok(tr.last.tok, tr.start.tok);
    if (!(units(tok) > 0)) return null;
    return { acc: accountId, kind, t0: tr.start.t, t1: tr.last.t, dUsed: tr.last.used - tr.start.used, tok };
  }

  // Kota yüzdesi / birim. Yalnızca en az MIN_STRETCH_USED puanlık değişim içeren aralıklar kullanılır (±1 yuvarlama payı).
  rate(accountId, kind) {
    const list = this.stretches.filter((x) => x.acc === accountId && x.kind === kind);
    const tr = this.track.get(`${accountId}:${kind}`);
    const open = tr && this.stretchOf(accountId, kind, tr);
    if (open) list.push(open);
    const ok = list.filter((x) => x.dUsed >= MIN_STRETCH_USED);
    const used = ok.reduce((n, x) => n + x.dUsed, 0);
    const u = ok.reduce((n, x) => n + units(x.tok), 0);
    const conf = !used ? 'yok' : used < 10 ? 'düşük' : used < 30 ? 'orta' : 'yüksek';
    return { perUnit: used && u ? used / u : null, conf, used, stretches: ok.length };
  }

  // Birimi tahmini kota yüzdesine çevirir.
  estimate(accountId, u) {
    const out = {};
    for (const kind of ['five', 'week']) {
      const r = this.rate(accountId, kind);
      out[kind] = r.perUnit ? { pct: Math.round(u * r.perUnit * 10) / 10, conf: r.conf } : null;
    }
    return out;
  }

  // Kayıtlardan öğrenilen oranlar; kayıt yoksa varsayılan (n: 0) döner. Compact varsayılanları bu makinedeki
  // 216 gerçek compact'ın (50k üstü) ortancasıdır.
  //  moveShare: taşımada yeni hesabın yeniden yazdığı bağlam payı (hesaplar arası ortak önbellekteki kısım hariç).
  //  compactKeep: özetin eski bağlama oranı; base: compact sonrası bağlama yeniden eklenen sabit kısım
  //  (sistem istemi, tool'lar, yeniden eklenen dosyalar); summaryShare: özet çıktısının eski bağlama oranı;
  //  cwShare: compact sonrası ilk turda yeniden yazılan bağlam payı.
  ratios() {
    const avg = (xs, def) => (xs.length ? { v: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length } : { v: def, n: 0 });
    const moves = this.records.filter((x) => x.kind === 'tasi' && x.ctxBefore > 20000 && x.turn);
    const comps = this.records.filter((x) => x.kind === 'compact' && x.pre > 20000 && x.turn);
    return {
      moveShare: avg(moves.map((x) => Math.min(1, x.turn.cw / x.ctxBefore)), 1),
      compactKeep: avg(comps.filter((x) => x.post).map((x) => x.post / x.pre), 0.073),
      base: avg(comps.filter((x) => x.post).map((x) => Math.max(0, x.turn.cw + x.turn.cr + x.turn.in - x.post)), 61000),
      summaryShare: avg(comps.filter((x) => x.summaryTok).map((x) => x.summaryTok / x.pre), 0.018),
      cwShare: avg(comps.map((x) => x.turn.cw / Math.max(1, x.turn.cw + x.turn.cr + x.turn.in)), 0.5),
    };
  }

  // Önbellek ömrü: en uzun isabetli boşluk ve en kısa ıskalanan boşluk.
  cacheTtl() {
    const hits = this.ttl.filter((x) => x.hit).map((x) => x.gap);
    const miss = this.ttl.filter((x) => !x.hit).map((x) => x.gap);
    return { maxHitMs: hits.length ? Math.max(...hits) : null, minMissMs: miss.length ? Math.min(...miss) : null, samples: this.ttl.length };
  }

  // Son turun bağlamı; compact sonrası ilk tura kadar tahmin.
  context(r) {
    if (!r.ctx) return null;
    return r.ctxEstimated ? Math.round(r.ctx + this.ratios().base.v) : r.ctx;
  }

  // Oturum kaydı olmayan harcama (panelin kendi model çağrıları): hesabın token toplamına eklenir ki kota aralıkları
  // bu harcamayı da görsün; yoksa kota yüzdesi token'sız artar ve oran şişer.
  addSpend(accountId, tok) {
    const accTok = this.acc.get(accountId) || {};
    this.acc.set(accountId, accTok);
    mergeTok(accTok, tok);
  }

  // Okunan yeni skill listeleri; her biri bir kez verilir.
  takeSkillListings() {
    const out = [];
    for (const w of this.sess.values()) {
      if (!w.reader || !w.reader.skillListing) continue;
      out.push(w.reader.skillListing);
      w.reader.skillListing = null;
    }
    return out;
  }

  // Verilen andan sonraki ilk tur (o mesajı hangi modelin yanıtladığı).
  turnAfter(sid, ts) {
    const w = this.sess.get(sid);
    return w ? w.reader.turns.find((t) => t.ts > ts) || null : null;
  }

  sessionInfo(sid, now = Date.now()) {
    const w = this.sess.get(sid);
    if (!w) return null;
    const r = w.reader;
    const h = w.ctxHist;
    let growthPer10m = null;
    const recent = h.filter((x) => now - x.t <= 30 * 60 * 1000);
    if (recent.length >= 2) {
      const a = recent[0];
      const b = recent[recent.length - 1];
      if (b.t - a.t >= 3 * 60 * 1000) growthPer10m = Math.round(((b.v - a.v) / (b.t - a.t)) * 600000);
    }
    return {
      context: this.context(r),
      fam: r.fam,
      effort: r.effort || null,
      skills: r.lastSkills || null,
      growthPer10m,
      lastTurnAt: r.lastTurnAt,
      lastActiveAt: Math.max(r.lastTurnAt || 0, r.lastToolAt || 0, w.subLastAt || 0) || null,
      lastToolAt: r.lastToolAt,
      errStreak: r.errStreak,
      errRecent: r.errTimes.filter((t) => now - t <= RECENT_ERR).length,
      // Boşta compact'lar ayrı sayılır (bekçinin yenileme sayacına girmez).
      compacts: r.compacts.filter((c) => !c.idle).length,
      idleCompacts: r.compacts.filter((c) => c.idle).length,
      lastCompact: r.compacts.length ? { pre: r.compacts[r.compacts.length - 1].pre, post: r.compacts[r.compacts.length - 1].post } : null,
      // Son turdan bu süre geçince önbellek düşer; sonraki tur bağlamın tamamını baştan yazar.
      cacheTtlMs: r.ttlMs || 60 * 60 * 1000,
      cacheWarm: !!r.lastTurnAt && now - r.lastTurnAt < (r.ttlMs || 60 * 60 * 1000),
    };
  }

  snapshot(accounts) {
    const rec = (x) => {
      const u = units(x.tok);
      return { ...x, units: Math.round(u * 1000) / 1000, est: this.estimate(x.acc, u) };
    };
    return {
      weights: { priceIn: PRICE_IN, mult: MULT, note: 'Varsayım: kota, token türlerini API fiyat oranlarıyla tartar. Birim ≈ API eşdeğeri $.' },
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, five: this.rate(a.id, 'five'), week: this.rate(a.id, 'week') })),
      sessions: Object.fromEntries([...this.sess.keys()].map((sid) => [sid, { name: this.sess.get(sid).name, ...this.sessionInfo(sid) }])),
      records: tail(this.records, 30).map(rec),
      pending: this.pending.map(({ compact, ...x }) => x),
      cacheTtl: this.cacheTtl(),
    };
  }
}

module.exports = { Meter, units, family, newReader, readMore, readObj, PRICE_IN };
