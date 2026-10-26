// Bekçi: kota, bağlam ve takılma sinyallerini kurallarla değerlendirir. Panel ortamıyla ilgili hamleleri (compact,
// hesap taşıma, yenileme) aday olarak çıkarır; hangisinin yapılacağına yardımcı model ya da kural varsayılanı karar
// verir, panel uygular (server/ops.js). Şefe yalnızca proje kararı gerektiren durumlar yazılır: kritik (iş yarıda
// kalabilir) hemen, yüksek olanlar aralıklı tek mesajda. Aynı bulgu tekrar gönderilmez; seviyesi yükselirse ya da uzun
// süre sürerse yeniden hatırlatılır.
const fs = require('fs');
const path = require('path');
const prompts = require('../core/prompts');
const { PRICE_IN } = require('./meter');

const DEFAULTS = { enabled: true, act: true, ai: true, quotaHalf: 50, quotaLow: 15, ctxWarn: 250000, ctxHigh: 500000, errStreak: 4, stuckMin: 20 };
const LEVELS = { normal: 1, 'yüksek': 2, kritik: 3 };
const LEVEL_TEXT = { normal: 'normal', 'yüksek': 'YÜKSEK', kritik: 'KRİTİK' };
const BATCH_EVERY = 10 * 60 * 1000;
const REMIND_AFTER = 60 * 60 * 1000;
const SOON = 45 * 60 * 1000;
const RESET_SOON = 20 * 60 * 1000;
const MOVE_MIN_LEFT = 30;
const RUNOUT_MAX_LEFT = 50;
// Kullanılmayan kota sıfırlanmada yanar: hesap ancak gerçekten tükenmek üzereyken terk edilir. Kalan bu kadar ya da
// azsa tahmine bakmadan taşınır; üstündeyse yalnızca tahmin sıfırlanmadan önce SOON içinde dolacağını söylüyorsa.
const MOVE_FLOOR = 5;
// Rolün bağlam profili: warn (iş bitip üye boşta kalınca hamle yapılan eşik) ve high (üst sınır; ilk uygun anda hamle).
// Değerler toplam bağlamdır (yeni oturum ~60k sabit kısımla başlar). Şef proje akışını taşıdığı için yüksek; işi alıp
// bitiren roller daha düşük. Ayarlar → Roller'de rol başına değiştirilir; profili olmayan rol genel ayarı kullanır.
const ROLE_CTX = {
  sef: { warn: 500000, high: 700000 },
  coder: { warn: 250000, high: 500000 },
  review: { warn: 200000, high: 400000 },
  arastirma: { warn: 150000, high: 300000 },
};
// warn eşiğini geçen üye ancak bu süredir hareketsizse (işi bitmiş) hamle alır.
const IDLE_FOR = 3 * 60 * 1000;
// Bu kadar compact'tan sonraki hamle devir notuyla yenilemedir.
const COMPACTS_BEFORE_RENEW = 2;

// Üyenin bağlam eşikleri: rolün kendi ayarı, yoksa rolün varsayılan profili, yoksa genel ayar. Küçük pencereli modelde
// (ör. 200k) eşikler pencerenin %50 ve %75'iyle sınırlanır; yoksa modelin kendi otomatik compact'i önce devreye girer.
function ctxLimits(session, info, settings, cfg) {
  const role = ((settings && settings.roles) || []).find((r) => r.id === session.roleId) || {};
  const def = ROLE_CTX[session.roleId] || {};
  let warn = Number(role.ctxWarn) || def.warn || cfg.ctxWarn;
  let high = Number(role.ctxHigh) || def.high || cfg.ctxHigh;
  const win = info && info.fam && settings && settings.contextWindows && Number(settings.contextWindows[info.fam]);
  if (win) {
    warn = Math.min(warn, win * 0.5);
    high = Math.min(high, win * 0.75);
  }
  return { warn, high: Math.max(high, warn) };
}
// Yenilemede devir notunun yaklaşık boyu. Yeni oturumun sabit kısmı (sistem istemi, tool'lar, panel istemi) compact
// sonrası kalan sabit kısımla aynı kabul edilir (meter.ratios().base).
const NOTE_TOK = 3000;

const hhmm = (ts) => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
// Sıfırlanma bir günden uzaksa saat tek başına yanıltır (haftalık pencere): gün de yazılır.
const when = (ts, now) => (ts - now > 20 * 3600 * 1000
  ? new Date(ts).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : hhmm(ts));
// Pencere bu hızla sıfırlanmadan önce dolacaksa true.
const draining = (row) => [row.five, row.week].some((b) => b && b.forecast && b.forecast.beforeReset);
const k = (n) => `${Math.round(n / 1000)}k`;
const mins = (ms) => (ms < 90 * 60 * 1000 ? `${Math.max(1, Math.round(ms / 60000))} dk` : `${(ms / 3600000).toFixed(1)} sa`);

function watchSettings(settings) {
  return { ...DEFAULTS, ...((settings && settings.watch) || {}) };
}

// Kalan kota: iki pencereden küçük olanı.
function leftOf(row) {
  if (!row || row.status !== 'canlı') return null;
  if (row.blocked) return 0;
  const vals = [row.five, row.week].filter(Boolean).map((b) => 100 - b.used);
  return vals.length ? Math.min(...vals) : null;
}

class Watch {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'watch.json');
    let d = {};
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    this.log = Array.isArray(d.log) ? d.log : [];
    // grup -> anahtar -> { level, sentAt, text }
    this.active = new Map();
    this.queue = new Map();
    this.lastBatch = new Map();
    this.current = new Map();
    this.cands = new Map();
    // hesap:pencere -> tükenme tahmininin ilk görüldüğü kota ölçümü (fetchedAt). Tek ölçümdeki ani harcama (ör. bekçinin
    // kendi compact'ları) taşıma sebebi olmasın diye tahmin ancak farklı bir ölçümde de tutarsa hamleye dönüşür.
    this.runSeen = new Map();
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ log: this.log }), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  // Birimi tahmini kota yüzdesine çevirip kısa metin yapar.
  costText(meter, accountId, u) {
    const est = meter.estimate(accountId, u);
    const kind = est.five ? 'five' : est.week ? 'week' : null;
    if (!kind) return `≈${u.toFixed(2)} birim`;
    const label = kind === 'five' ? '5 saatlik' : 'haftalık';
    return `≈%${est[kind].pct} ${label}${est[kind].conf === 'düşük' ? ' (düşük güven)' : ''}`;
  }

  // Tahmini maliyetler (birim). compact eski hesaba, taşıma yeni hesaba yazılır; perTurn: compact sonrası her turun
  // önbellekten daha az okuması sayesinde kazancı.
  costs(meter, ctx, fam) {
    const r = meter.ratios();
    const p = (PRICE_IN[fam] || PRICE_IN.opus) / 1e6;
    const rewrite = (n, share) => n * p * (share * 1.25 + (1 - share) * 0.1);
    const after = Math.min(ctx, r.base.v + ctx * r.compactKeep.v);
    const compact = ctx * p * 0.1 + ctx * r.summaryShare.v * p * 5 + rewrite(after, r.cwShare.v);
    return {
      move: rewrite(ctx, r.moveShare.v),
      compact,
      moveAfterCompact: rewrite(after, r.moveShare.v),
      after,
      perTurn: (ctx - after) * p * 0.1,
    };
  }

  // Yenileme: eski oturum devir notunu sıcak önbellekten okuyarak yazar, yeni oturum sabit kısım + notla başlar.
  renewCost(meter, ctx, fam) {
    const p = (PRICE_IN[fam] || PRICE_IN.opus) / 1e6;
    const after = meter.ratios().base.v + NOTE_TOK;
    return { cost: ctx * p * 0.1 + NOTE_TOK * p * 5 + after * p * 1.25, after };
  }

  // input: { groups: [{ group, lead, members: [{ session, status, info }] }], quota, meter, accounts, settings }
  // Dönüş: grup -> { findings: [{ key, level, text, lead }], cands: [{ sid, gid, name, why, options, def }] }.
  // lead: true olan bulgu proje kararı gerektirir ve şefe gider; diğerleri yalnızca kayda geçer. cands: panelin
  // kendisinin yapabileceği hamle seçenekleri (compact, taşıma, yenileme, bekle) ve kural varsayılanı.
  evaluate(input, now = Date.now()) {
    const cfg = watchSettings(input.settings);
    const rows = new Map(((input.quota && input.quota.rows) || []).map((r) => [r.accountId, r]));
    const accName = (id) => (input.accounts.find((a) => a.id === id) || {}).name || id;
    const fetchedAt = (input.quota && input.quota.fetchedAt) || null;
    const runKeys = new Set();
    const out = new Map();
    for (const { group, lead, members } of input.groups) {
      const nameOf = (m) => `${m.session.name}${lead && m.session.id === lead.id ? ' (sen)' : ''}`;
      const stText = (m) => (m.status === 'busy' ? 'çalışıyor' : m.status === 'idle' ? 'boşta' : m.status);
      const findings = [];
      const cands = [];
      const running = members.filter((m) => m.status !== 'off');
      // Hedef hesap bu proje klasörüne güven onayı vermiş olmalı; yoksa taşınan oturum açılışta güven sorusunda kalır.
      // Kendisi de sıfırlanmadan önce dolacak hesap ancak başka seçenek yoksa hedef olur.
      const roomy = (exceptId) => [...rows.values()]
        .filter((r) => r.accountId !== exceptId && leftOf(r) != null && leftOf(r) >= MOVE_MIN_LEFT)
        .sort((a, b) => draining(a) - draining(b) || leftOf(b) - leftOf(a));
      const bestTarget = (exceptId) => roomy(exceptId).find((r) => !input.canHost || input.canHost(r.accountId, group)) || null;

      // Üye için hamle seçenekleri; maliyet compact'ta eski hesaba, taşıma ve yenilemede yeni hesaba yazılır.
      const isCold = (m) => !!(m.info && m.info.lastTurnAt) && m.info.cacheWarm === false;
      const options = (m, target) => {
        const ctx = (m.info && m.info.context) || 0;
        const fam = m.info && m.info.fam;
        const acc = m.session.accountId;
        const c = this.costs(input.meter, ctx, fam);
        const rn = this.renewCost(input.meter, ctx, fam);
        const lim = ctxLimits(m.session, m.info, input.settings, cfg);
        const list = [];
        const gainful = c.after < ctx * 0.8;
        const renewGain = rn.after < ctx * 0.8;
        // Önbellek düştüyse (son turdan beri ömrü geçti) sonraki tur bağlamı zaten baştan yazacak: taşımanın ek maliyeti yok.
        const cold = isCold(m);
        const later = cold ? ' (cache soğuk: üye yeniden çalışıp boşa çıkınca yapılır)' : '';
        if (target) {
          const to = target.accountId;
          list.push({ id: 'tasi', kind: 'move', accountId: to, text: cold
            ? `${accName(to)} hesabına taşı (cache zaten soğuk, son tur ${mins(now - m.info.lastTurnAt)} önce: taşımanın ek maliyeti yok, bağlam ${k(ctx)} olduğu gibi kalır)`
            : `${accName(to)} hesabına taşı (yeni hesapta ${this.costText(input.meter, to, c.move)}, bağlam ${k(ctx)} olduğu gibi kalır)` });
          if (ctx >= lim.warn && gainful) list.push({ id: 'compact_tasi', kind: 'compact', then: { accountId: to }, text: `önce compact (bu hesapta ${this.costText(input.meter, acc, c.compact)}, bağlam ~${k(c.after)}'e iner), sonra ${accName(to)} hesabına taşı (${this.costText(input.meter, to, c.moveAfterCompact)})${later}` });
          if (ctx >= lim.warn && renewGain) list.push({ id: 'yenile_tasi', kind: 'renew', accountId: to, text: `devir notu yazdırıp ${accName(to)} hesabında sıfır bağlamla aç (${this.costText(input.meter, to, rn.cost)}, bağlam ~${k(rn.after)}; ayrıntı kaybı riski)${later}` });
        } else {
          if (gainful) list.push({ id: 'compact', kind: 'compact', text: `compact (${this.costText(input.meter, acc, c.compact)}, bağlam ~${k(c.after)}'e iner, sonraki her tur ${this.costText(input.meter, acc, c.perTurn)} ucuzlar)${later}` });
          if (renewGain) list.push({ id: 'yenile', kind: 'renew', text: `devir notu yazdırıp aynı hesapta sıfır bağlamla aç (${this.costText(input.meter, acc, rn.cost)}, bağlam ~${k(rn.after)}; ayrıntı kaybı riski)${later}` });
        }
        list.push({ id: 'bekle', kind: 'wait', text: 'şimdilik bir şey yapma' });
        return list;
      };
      // Yalnızca "bekle" kalan (compact da yenileme de kazandırmayan) üye aday sayılmaz.
      const cand = (m, why, opts, def) => {
        if (opts.length < 2) return;
        cands.push({ sid: m.session.id, gid: group.id, name: m.session.name, why, options: opts, def: opts.find((o) => o.id === def) ? def : opts[0].id });
      };

      const handled = new Set();
      const byAcc = new Map();
      for (const m of running) byAcc.set(m.session.accountId, (byAcc.get(m.session.accountId) || []).concat(m));
      for (const [accId, ms] of byAcc) {
        const row = rows.get(accId);
        if (!row || row.status !== 'canlı') continue;
        const busy = ms.some((m) => m.status === 'busy');
        const who = ms.map((m) => `${nameOf(m)} (${stText(m)}, bağlam ${k((m.info && m.info.context) || 0)})`).join(', ');
        for (const [kind, label] of [['five', '5 saatlik'], ['week', 'haftalık']]) {
          const b = row[kind];
          if (!b) continue;
          const left = Math.max(0, 100 - b.used);
          const reset = b.resetsAt ? Date.parse(b.resetsAt) : null;
          const f = b.forecast;
          // Tükenme tahmini yalnızca kotanın yarısından azı kaldığında hamle sebebi sayılır; bol kotalı hesapta kısa
          // süreli yoğun harcama tahmini abartır.
          const runsOut = left <= RUNOUT_MAX_LEFT && f && f.beforeReset && f.eta && f.eta - now < SOON;
          const runKey = `${accId}:${kind}`;
          let confirmed = false;
          if (runsOut) {
            runKeys.add(runKey);
            const seen = this.runSeen.get(runKey);
            if (seen == null) this.runSeen.set(runKey, fetchedAt);
            else confirmed = seen !== fetchedAt;
          }
          if (left <= MOVE_FLOOR || confirmed) {
            const why = `${accName(accId)} hesabında ${label} kotada %${left} kaldı${runsOut ? `, bu hızla ~${mins(Math.max(0, f.eta - now))} içinde dolar` : ''}${reset ? ` (sıfırlanma ${when(reset, now)})` : ''}`;
            if (reset && reset - now < RESET_SOON) {
              findings.push({ key: `quota:${accId}:${kind}`, level: 'normal', text: `${why}. Sıfırlanmaya ${mins(reset - now)} var; taşımak yerine bekleniyor.` });
              continue;
            }
            const target = bestTarget(accId);
            if (!target) {
              // Taşınacak yer yoksa iş planı değişir: bu, şefin kararıdır.
              // Biten kotayı compact ya da yenilemeyle harcamamak için bu üyelere bağlam hamlesi de önerilmez.
              for (const m of ms) handled.add(m.session.id);
              const untrusted = roomy(accId).map((r) => accName(r.accountId));
              findings.push({ key: `quota:${accId}:${kind}`, level: busy ? 'kritik' : 'yüksek', lead: true, text: `${why}. Bu hesapta: ${who}. Taşınabilecek, kotası %${MOVE_MIN_LEFT} üstünde başka hesap yok${untrusted.length ? ` (${untrusted.join(', ')} hesabında kota var ama bu proje klasörü o hesapta onaylanmamış; kullanıcı o hesapla klasörü bir kez açıp onaylarsa taşıma yapılabilir, bunu kullanıcıya söyle)` : ''}; bu üyelerin işini toparlayıp kısa durum yazmasını iste, uzun işleri sıfırlanmadan sonraya bırak.` });
              continue;
            }
            for (const m of ms) {
              if (handled.has(m.session.id)) continue;
              handled.add(m.session.id);
              const ctx = (m.info && m.info.context) || 0;
              const lim = ctxLimits(m.session, m.info, input.settings, cfg);
              const ladder = ((m.info && m.info.compacts) || 0) >= COMPACTS_BEFORE_RENEW ? 'yenile_tasi' : 'compact_tasi';
              cand(m, why, options(m, target), isCold(m) || ctx < lim.warn ? 'tasi' : ladder);
            }
          } else if (left <= cfg.quotaLow) {
            // Az kaldı ama henüz taşıma zamanı değil: kalan kota bu hesapta kullanılır, yalnızca kayda geçer.
            const fate = f && f.eta && f.beforeReset
              ? `bu hızla ${when(f.eta, now)} civarı dolar; dolmaya ${mins(SOON)} kala başka hesaba taşınır`
              : 'bu hızla sıfırlanmaya yetiyor, taşınmıyor';
            findings.push({ key: `low:${accId}:${kind}:${reset ? Math.round(reset / 3600000) : ''}`, level: 'normal', text: `${accName(accId)}: ${label} kotada %${left} kaldı${reset ? ` (sıfırlanma ${when(reset, now)})` : ''}; ${fate}.` });
          } else if (left <= 100 - cfg.quotaHalf) {
            findings.push({ key: `half:${accId}:${kind}:${reset ? Math.round(reset / 3600000) : ''}`, level: 'normal', text: `${accName(accId)}: ${label} kotanın yarısı geçildi, %${left} kaldı${f && f.eta && f.beforeReset ? ` (bu hızla ${when(f.eta, now)} civarı dolar, sıfırlanma ${when(reset, now)})` : ''}.` });
          }
        }
      }

      for (const m of running) {
        const info = m.info;
        if (!info) continue;
        const name = nameOf(m);
        const ctx = info.context || 0;
        // Bağlam: rol eşiğini (warn) geçen üye işi bitip IDLE_FOR boyunca boş kalınca, üst sınırı (high) geçen ilk uygun
        // anda hamle alır. Sıra: COMPACTS_BEFORE_RENEW kez compact, sonra devir notuyla yenileme.
        const lim = ctxLimits(m.session, info, input.settings, cfg);
        const lastAct = info.lastActiveAt || Math.max(info.lastTurnAt || 0, info.lastToolAt || 0);
        const restingFor = m.status === 'idle' && lastAct ? now - lastAct : 0;
        if (!handled.has(m.session.id) && (ctx >= lim.high || (ctx >= lim.warn && restingFor >= IDLE_FOR))) {
          const why = `bağlam ${k(ctx)} (rol eşiği ${k(lim.warn)}, üst sınır ${k(lim.high)})${ctx < lim.high ? `, ${mins(restingFor)} boşta` : ''}${info.compacts ? `, bu oturumda ${info.compacts} compact yapıldı` : ''}`;
          const opts = options(m, null);
          const ladder = (info.compacts || 0) >= COMPACTS_BEFORE_RENEW ? 'yenile' : 'compact';
          cand(m, why, opts, opts.some((o) => o.id === ladder) ? ladder : 'yenile');
        } else if (info.growthPer10m >= 30000 && ctx >= lim.warn / 2 && ctx < lim.warn) {
          findings.push({ key: `grow:${m.session.id}`, level: 'normal', text: `${name}: bağlam hızlı büyüyor (${k(ctx)}, +${k(info.growthPer10m)}/10dk); bu hızla ~${mins(((lim.warn - ctx) / info.growthPer10m) * 600000)} içinde rol eşiği ${k(lim.warn)}'i geçer.` });
        }
        if (info.errStreak >= cfg.errStreak) {
          findings.push({ key: `err:${m.session.id}`, level: 'yüksek', lead: true, text: `${name}: art arda ${info.errStreak} hatalı tool çağrısı; aynı hatada dönüyor olabilir. Ne denediğini ve neye takıldığını sor.` });
        }
        if (m.status === 'busy' && lastAct && now - lastAct > cfg.stuckMin * 60000) {
          findings.push({ key: `stuck:${m.session.id}`, level: 'yüksek', lead: true, text: `${name}: ${mins(now - lastAct)} süredir çalışıyor görünüyor ama yeni bir tur ya da tool çağrısı yok; uzun bir komut bekliyor ya da takılmış olabilir.` });
        }
      }
      out.set(group.id, { findings, cands });
    }
    for (const key of [...this.runSeen.keys()]) if (!runKeys.has(key)) this.runSeen.delete(key);
    return out;
  }

  // Bulguları ayıklar; { sends: şefe gidecek mesajlar [{ gid, lead, level, text, held }], cands: hamle adayları } döner.
  // held: şef şu an mesaj alamadığı için bekletilen yeni kritik bulgu (yalnızca arayüze bildirim olarak gösterilir).
  // Şefe yalnızca proje kararı gerektiren bulgular gider; diğerleri kayda geçer, hamleleri panel yapar.
  tick(input, now = Date.now()) {
    const cfg = watchSettings(input.settings);
    if (!cfg.enabled) return { sends: [], cands: [] };
    const all = this.evaluate(input, now);
    const sends = [];
    const cands = [];
    let logged = false;
    for (const { group, lead } of input.groups) {
      const { findings, cands: gc } = all.get(group.id) || { findings: [], cands: [] };
      cands.push(...gc);
      this.current.set(group.id, findings);
      this.cands.set(group.id, gc);
      const act = this.active.get(group.id) || new Map();
      this.active.set(group.id, act);
      const keys = new Set(findings.map((f) => f.key));
      // Düzelen bulgu silinir; yeniden oluşursa tekrar bildirilir.
      for (const key of [...act.keys()]) if (!keys.has(key)) act.delete(key);
      const q = this.queue.get(group.id) || new Map();
      this.queue.set(group.id, q);
      for (const key of [...q.keys()]) if (!keys.has(key)) q.delete(key);
      const newCritical = [];
      for (const f of findings) {
        const prev = act.get(f.key);
        const fresh = !prev || LEVELS[f.level] > LEVELS[prev.level] || (now - prev.sentAt > REMIND_AFTER && f.level !== 'normal');
        if (!fresh) continue;
        act.set(f.key, { level: f.level, sentAt: now });
        this.log.push({ ts: now, gid: group.id, level: f.level, key: f.key, text: f.text, lead: !!f.lead });
        logged = true;
        if (!f.lead) continue;
        q.set(f.key, f);
        if (f.level === 'kritik') newCritical.push(f);
      }
      const pending = [...q.values()];
      if (!pending.length) continue;
      const critical = pending.some((f) => f.level === 'kritik');
      if (!critical && now - (this.lastBatch.get(group.id) || 0) < BATCH_EVERY) continue;
      // Şef izin ya da soru ekranındayken yapıştırılan metnin Enter'ı bir seçeneği onaylayabilir; şef boşta ya da
      // çalışırken gönderilir (çalışıyorsa Claude mesajı sıraya alır), aksi halde kuyruk bekler.
      if (!lead || !['idle', 'busy'].includes(input.leadStatus && input.leadStatus(lead))) {
        for (const f of newCritical) sends.push({ gid: group.id, lead, level: 'kritik', text: f.text, held: true });
        continue;
      }
      pending.sort((a, b) => LEVELS[b.level] - LEVELS[a.level]);
      const top = pending[0].level;
      const text = prompts.message('bekci', {
        seviye: LEVEL_TEXT[top], maddeler: pending.map((f) => `- (${LEVEL_TEXT[f.level]}) ${f.text}`).join('\n'),
      });
      sends.push({ gid: group.id, lead, level: top, text });
      q.clear();
      this.lastBatch.set(group.id, now);
    }
    if (logged) {
      if (this.log.length > 300) this.log = this.log.slice(-300);
      this.save();
    }
    return { sends, cands };
  }

  // Hamle kararlarının ve sonuçlarının kaydı (karar geçmişi).
  note(entry, now = Date.now()) {
    this.log.push({ ts: now, ...entry });
    if (this.log.length > 300) this.log = this.log.slice(-300);
    this.save();
  }

  snapshot(gid) {
    return {
      findings: gid ? this.current.get(gid) || [] : Object.fromEntries(this.current),
      cands: gid ? this.cands.get(gid) || [] : Object.fromEntries(this.cands),
      log: gid ? this.log.filter((x) => x.gid === gid) : this.log,
    };
  }
}

module.exports = { Watch, watchSettings, WATCH_DEFAULTS: DEFAULTS, ROLE_CTX, ctxLimits };
