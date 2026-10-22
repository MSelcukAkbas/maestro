// Bekçinin hamleleri: compact, hesap taşıma ve yenileme (devir notu yazdırıp aynı rolü sıfır bağlamla açma).
// Panel bunları şefe sormadan uygular; şefe ek tur açmadan, bir sonraki turuna eklenen bilgi notu gider.
// Her üyede aynı anda tek hamle olur; hamle bitince o üye bir süre yeni hamle almaz.
// Hamleler bellekte tutulur: panel kapanınca oturumlar da kapandığı için yarım kalan hamlenin anlamı kalmaz.

// Model turu gerektiren hamle (compact, devir notu) boştaki üyeye yalnızca önbellek sıcakken gönderilir; soğuk
// önbellekte bağlamın tamamı baştan yazılır. Önbellek ömrü oturumun son turundan ölçülür (çoğunlukla 1 saat);
// sınırda kalmamak için bu pay kadar erken soğuk sayılır.
const WARM_MARGIN = 5 * 60 * 1000;
const warm = (info, now) => !!(info && info.lastTurnAt) && now - info.lastTurnAt < (info.cacheTtlMs || 60 * 60 * 1000) - WARM_MARGIN;
const COOLDOWN = 15 * 60 * 1000;
const COMPACT_WAIT = 10 * 60 * 1000;
const ASK_WAIT = 15 * 60 * 1000;
const QUEUE_WAIT = 60 * 60 * 1000;
const STOP_WAIT = 10 * 60 * 1000;
// Ana oturum boşta görünse de arka planda alt ajanları çalışıyor olabilir (ör. araştırma); oturumu yeniden başlatmak
// onları öldürür. Hamle için üyenin ve alt ajanlarının en az bu süredir hareketsiz olması beklenir.
const QUIET_MS = 90 * 1000;
const START_WAIT = 3 * 60 * 1000;
const POSTPONE = 30 * 60 * 1000;
const CANCEL_HOLD = 60 * 60 * 1000;
// Kullanıcı üyenin terminaline bu süre içinde yazdıysa onunla konuşuyordur; yenileme konuşmayı kesmesin diye beklenir.
const USER_QUIET = 5 * 60 * 1000;
const MIN_NOTE = 200;
const MAX_NOTE = 8000;
const COMPACT_FOCUS = 'Devam eden görevi, kullanıcının ve ekibin verdiği kararları, değişen dosyaları, kalan adımları ve ekip üyeleriyle süren konuşmaları ayrıntılı koru.';

const k = (n) => `${Math.round((n || 0) / 1000)}k`;

// Üyenin son mesajı kullanıcıdan (ya da ekipten) cevap bekliyor mu: soru, onay ya da seçim isteği. Bekliyorsa hamle
// yapılmaz; compact soruyu özete gömer, yenileme ve taşıma konuşmayı keser, devir talimatı da cevabın yerine geçer.
// Kod blokları ve bağlantılar ayıklanır; yalnızca mesajın son birkaç satırına bakılır.
const ASK_RE = /(\?|ister misin|ister misiniz|onayl[ıi]yor musun|onaylar m[ıi]s[ıi]n|onay[ıi]n[ıi]? bekl|onay ver|devam edeyim mi|yapay[ıi]m m[ıi]|hangisi|se[çc]er misin|se[çc]imini|karar[ıi]n[ıi]? bekl|cevab[ıi]n[ıi]? bekl|yan[ıi]t[ıi]n[ıi]? bekl|s[öo]yle(r misin|rsen)|bildir(ir misin|irsen)|should i|would you like|do you want|let me know|which (one|option)|please confirm)/i;
function asksUser(text) {
  const lines = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .split('\n').map((x) => x.trim()).filter(Boolean);
  return ASK_RE.test(lines.slice(-4).join('\n').slice(-600));
}

const DEVIR_TOOL = {
  name: 'devir_tamam',
  description: 'Yalnızca panel "[Claude Panel · Devir]" mesajıyla devir notu istediğinde çağır. not: yeni oturumun kaldığın yerden '
    + `devam etmesi için gereken her şey (en fazla ${MAX_NOTE} karakter). Şu an devredilemeyecek kritik bir işin ortasındaysan not yerine ertele alanına nedenini yaz.`,
  inputSchema: {
    type: 'object',
    properties: {
      not: { type: 'string', description: 'devir notu: görev ve kimden geldiği, yapılanlar, değişen dosyalar, kalan adımlar, açık sorular, kararlar, süren konuşmalar' },
      ertele: { type: 'string', description: 'devri şimdi yapmamak için kısa neden (isteğe bağlı)' },
    },
  },
};

class Ops {
  // deps: member(sid) -> { group, session } | null, state(sid) -> { status, live, ended, error, lastInputAt },
  // info(sid) -> meter.sessionInfo, lastText(sid) -> üyenin son mesajı, delivering(sid) -> başka bir iletim bekliyor mu, paste(sid, text, activity),
  // switchAccount(sid, accountId), renew(sid, note, accountId) -> yeni oturum kimliği, event(text), log(entry)
  constructor(deps) {
    this.d = deps;
    this.ops = new Map();
    this.cool = new Map();
    this.idle = new Map();
    this.info = new Map();
  }

  // Hamle alabilir mi: üzerinde hamle yok ve bekleme süresinde değil.
  free(sid, now = Date.now()) {
    return !this.ops.has(sid) && !(this.cool.get(sid) > now);
  }

  hold(sid, ms, now = Date.now()) {
    this.cool.set(sid, now + ms);
  }

  // op: { sid, gid, kind: 'compact' | 'move' | 'renew', accountId, then: { accountId } (compact sonrası taşıma), why, by,
  // force (kullanıcının isteği: bekleme süresi, sessizlik ve sıcak önbellek koşulları aranmaz) }
  add(op, now = Date.now()) {
    if (op.force) {
      const cur = this.ops.get(op.sid);
      if (cur && cur.state !== 'queued') return false;
    } else if (!this.free(op.sid, now)) return false;
    this.ops.set(op.sid, { ...op, state: 'queued', at: now, createdAt: now });
    return true;
  }

  get(sid) {
    return this.ops.get(sid) || null;
  }

  list() {
    return [...this.ops.values()].map(({ note, ...o }) => ({ ...o, noteLength: note ? note.length : undefined }));
  }

  name(sid) {
    const m = this.d.member(sid);
    return m ? m.session.name : sid;
  }

  // Şefe gidecek bilgi notu; şefin bir sonraki turuna eklenir.
  tell(gid, text) {
    this.info.set(gid, (this.info.get(gid) || []).concat(text).slice(-10));
  }

  hasInfo(gid) {
    return !!(this.info.get(gid) || []).length;
  }

  takeInfo(gid) {
    const list = this.info.get(gid);
    if (!list || !list.length) return null;
    this.info.delete(gid);
    return ['[Claude Panel · Bekçi bilgi] Panel, ekibin kota ve bağlam düzenini şöyle ayarladı (bilgi amaçlı; senin bir şey yapman gerekmiyor):', ...list.map((t) => `- ${t}`)].join('\n');
  }

  done(op, text, now) {
    this.ops.delete(op.sid);
    this.hold(op.sid, COOLDOWN, now);
    this.tell(op.gid, text);
    this.d.event(text, op.gid);
    this.d.log({ gid: op.gid, key: `op:${op.sid}`, level: 'normal', text: `tamamlandı: ${text}` });
  }

  fail(op, text, now, wait = COOLDOWN) {
    this.ops.delete(op.sid);
    this.hold(op.sid, wait, now);
    this.d.event(text, op.gid);
    this.d.log({ gid: op.gid, key: `op:${op.sid}`, level: 'yüksek', text: `olmadı: ${text}` });
  }

  // Üye terminaline yazılabilir mi: Claude açık, son turu hatasız (taşımada hata serbest: kota dolunca tur hatayla
  // biter), iki ardışık örnekte boşta, kullanıcı son 30 saniyede yazmamış, başka iletim beklemiyor.
  ready(sid, { warm: needWarm, allowError } = {}, now = Date.now()) {
    const st = this.d.state(sid);
    if (!st || !st.live || st.ended || (st.error && !allowError) || st.status !== 'idle' || now - (st.lastInputAt || 0) < 30000 || this.d.delivering(sid)) return false;
    if ((this.idle.get(sid) || 0) < 2) return false;
    const info = this.d.info(sid);
    if (info && info.lastActiveAt && now - info.lastActiveAt < QUIET_MS) return false;
    if (needWarm && !warm(this.d.info(sid), now)) return false;
    // Kota dolup tur hatayla bittiyse (taşıma) üye zaten cevap veremez; taşıma konuşmayı olduğu gibi devam ettirir.
    if (!(allowError && st.error) && this.waitsAnswer(sid, now)) return false;
    return true;
  }

  // Son mesaj cevap bekliyorsa hamle o cevaplanıp üye yeni bir tur yapana kadar bekler; bu bir kez kayda geçer.
  // force (kullanıcının isteği) beklemez.
  waitsAnswer(sid, now = Date.now()) {
    const op = this.ops.get(sid);
    if (op && op.force) return false;
    if (!asksUser(this.d.lastText && this.d.lastText(sid))) return false;
    if (op && !op.askNoted) {
      op.askNoted = true;
      this.d.log({ gid: op.gid, key: `op:${sid}`, level: 'normal', text: `${this.name(sid)}: son mesajında cevap bekliyor (soru, onay ya da seçim); hamle cevaplanıp yeni tur bitince yapılacak.` });
    }
    return true;
  }

  tick(now = Date.now()) {
    for (const sid of this.ops.keys()) {
      const st = this.d.state(sid);
      this.idle.set(sid, st && st.status === 'idle' ? (this.idle.get(sid) || 0) + 1 : 0);
    }
    for (const op of [...this.ops.values()]) {
      try { this.step(op, now); } catch (err) { this.fail(op, `${this.name(op.sid)}: ${err.message}`, now); }
    }
  }

  step(op, now) {
    const name = this.name(op.sid);
    const m = this.d.member(op.sid);
    if (op.state === 'queued' && (!m || m.session.removed)) return this.ops.delete(op.sid);
    if (op.state === 'queued' && now - op.createdAt > QUEUE_WAIT) {
      this.ops.delete(op.sid);
      return this.d.log({ gid: op.gid, key: `op:${op.sid}`, level: 'normal', text: `${name}: hamle 1 saat içinde uygun an bulamadı, bırakıldı.` });
    }
    if (op.kind === 'compact') {
      if (op.state === 'queued' && this.ready(op.sid, { warm: true }, now)) {
        const info = this.d.info(op.sid) || {};
        op.before = info.compacts || 0;
        op.ctxBefore = info.context || 0;
        this.d.paste(op.sid, `/compact ${COMPACT_FOCUS}`, 'compact');
        op.state = 'sent';
        op.at = now;
      } else if (op.state === 'sent') {
        const info = this.d.info(op.sid) || {};
        if ((info.compacts || 0) > op.before) {
          const c = info.lastCompact || {};
          const text = `${name}: compact edildi, bağlam ${k(c.pre || op.ctxBefore)} → ~${k(info.context)}`;
          if (op.then) {
            this.d.log({ gid: op.gid, key: `op:${op.sid}`, level: 'normal', text });
            op.kind = 'move';
            op.accountId = op.then.accountId;
            op.compacted = text;
            op.state = 'queued';
            this.idle.set(op.sid, 0);
          } else this.done(op, text, now);
        } else if (now - op.at > COMPACT_WAIT) this.fail(op, `${name}: compact 10 dakika içinde tamamlanmadı.`, now);
      }
    } else if (op.kind === 'move') {
      if (op.state === 'queued' && this.ready(op.sid, { allowError: true }, now)) {
        const from = m.session.accountId;
        if (from === op.accountId) return this.ops.delete(op.sid);
        this.d.switchAccount(op.sid, op.accountId);
        this.done(op, `${op.compacted ? `${op.compacted}; ardından ` : `${name}: `}${from} hesabından ${op.accountId} hesabına taşındı (kaldığı yerden devam)`, now);
      }
    } else if (op.kind === 'renew') {
      if (op.state === 'asked' && now - op.at > ASK_WAIT) {
        this.fail(op, `${name}: devir notu 15 dakika içinde gelmedi, yenileme bırakıldı.`, now);
      } else if (op.state === 'noted') {
        const st = this.d.state(op.sid);
        const info = this.d.info(op.sid);
        const quiet = !info || !info.lastActiveAt || now - info.lastActiveAt > 30 * 1000;
        if ((st && st.status === 'idle' && quiet) || now - op.at > STOP_WAIT) {
          op.newSid = this.d.renew(op.sid, op.note, op.accountId || null);
          op.state = 'starting';
          op.at = now;
        }
      } else if (op.state === 'starting') {
        const info = this.d.info(op.newSid);
        if (info && info.lastTurnAt && info.lastTurnAt >= op.at) {
          this.ops.delete(op.sid);
          this.hold(op.newSid, COOLDOWN, now);
          const text = `${name}: ${op.force ? 'kullanıcının isteğiyle' : `bağlamı ${k(op.ctxBefore)} olduğu için`} devir notuyla sıfır bağlamla yeniden açıldı${op.accountId && op.accountId !== op.fromAccount ? ` (${op.accountId} hesabında)` : ''}; adı ve rolü aynı, ona aynı adla yazmaya devam et`;
          this.tell(op.gid, text);
          this.d.event(text, op.gid);
          this.d.log({ gid: op.gid, key: `op:${op.sid}`, level: 'normal', text: `tamamlandı: ${text}` });
        } else if (now - op.at > START_WAIT) {
          this.fail(op, `${name}: yeni oturum açıldı ama 3 dakikadır ilk turunu yapmadı; terminaline bak.`, now);
        }
      }
    }
  }

  // Yenileme talimatı, üyeye pano ve not bildirimleriyle aynı yoldan gider: çalışırken bitişte, boştayken terminaline.
  // Boştaki üyeye yalnızca önbellek sıcakken; kullanıcı üyeyle konuşuyorsa hiç.
  renewAsk(sid, viaIdle, now = Date.now()) {
    const op = this.ops.get(sid);
    if (!op || op.kind !== 'renew' || op.state !== 'queued') return null;
    if (op.force) return op;
    const st = this.d.state(sid);
    if (st && now - (st.lastInputAt || 0) < USER_QUIET) return null;
    if (viaIdle && !warm(this.d.info(sid), now)) return null;
    if (this.waitsAnswer(sid, now)) return null;
    return op;
  }

  takeRenewAsk(sid, viaIdle, now = Date.now()) {
    const op = this.renewAsk(sid, viaIdle, now);
    if (!op) return null;
    const m = this.d.member(sid);
    const info = this.d.info(sid) || {};
    op.state = 'asked';
    op.at = now;
    op.ctxBefore = info.context || 0;
    op.fromAccount = m ? m.session.accountId : null;
    return [
      `[Claude Panel · Devir] ${op.force ? 'Kullanıcının isteğiyle' : `Bağlamın ${k(op.ctxBefore)} oldu;`} panel bu oturumu sıfır bağlamla yeniden açacak${op.accountId && op.accountId !== op.fromAccount ? ` (${op.accountId} hesabında)` : ''}. Adın, rolün ve ekipteki yerin aynı kalacak.`,
      '1. Şu an yaptığın adımı güvenli bir noktada bırak: yarım düzenleme bırakma, yeni iş başlatma.',
      `2. devir_tamam tool'unu çağır ve "not" alanına yeni oturumun kaldığın yerden devam etmesi için gereken her şeyi yaz: elindeki görev ve kimden geldiği, yapılanlar, değişen dosyalar, kalan adımlar, açık sorular, verilen önemli kararlar, ekip üyeleriyle süren konuşmalar (en fazla ${MAX_NOTE} karakter).`,
      '3. devir_tamam\'dan sonra başka bir şey yapma; panel bu oturumu kapatıp yenisini açacak.',
      op.force ? null : 'Devredilemeyecek kritik bir işin ortasındaysan not yerine "ertele" alanına nedenini yaz; panel 30 dakika sonra yeniden dener.',
    ].filter(Boolean).join('\n');
  }

  // Kullanıcının iptali: henüz başlamamış ya da sonucu beklenen hamle bırakılır. Devir notu alınıp eski oturum
  // kapanmaya başladıysa geri dönülmez.
  cancel(sid, now = Date.now()) {
    const op = this.ops.get(sid);
    if (!op) return { ok: false, error: 'Bu üyede süren işlem yok.' };
    if (['noted', 'starting'].includes(op.state)) return { ok: false, error: 'Yenileme son aşamada (devir notu alındı); artık iptal edilemez.' };
    this.ops.delete(sid);
    this.hold(sid, CANCEL_HOLD, now);
    return { ok: true };
  }

  // Yenilenmekte olan üyeye başka iletim yapılmaz; bekleyen pano ve not bildirimleri yeni oturuma geçer.
  blocks(sid) {
    const op = this.ops.get(sid);
    return !!(op && op.kind === 'renew' && ['asked', 'noted', 'starting'].includes(op.state));
  }

  // devir_tamam tool'u.
  handoff(sid, args, now = Date.now()) {
    const op = this.ops.get(sid);
    if (!op || op.kind !== 'renew' || op.state !== 'asked') throw Object.assign(new Error('Senden devir notu istenmedi; bu tool\'u yalnızca "[Claude Panel · Devir]" mesajından sonra kullan.'), { status: 400 });
    const name = this.name(sid);
    const later = String((args && args.ertele) || '').trim().slice(0, 300);
    if (later) {
      this.fail(op, `${name}: yenilemeyi erteledi (${later}).`, now, POSTPONE);
      return 'Tamam, devir ertelendi. İşine devam et; panel en erken 30 dakika sonra yeniden sorar.';
    }
    const note = String((args && args.not) || '').trim();
    if (note.length < MIN_NOTE) throw Object.assign(new Error(`Devir notu çok kısa (${note.length} karakter). Yeni oturum yalnızca bu notu görecek; görevi, yapılanları, değişen dosyaları ve kalan adımları yaz.`), { status: 400 });
    op.note = note.slice(0, MAX_NOTE);
    op.state = 'noted';
    op.at = now;
    return `Devir notu alındı (${op.note.length} karakter). Başka bir şey yapma; panel birazdan bu oturumu kapatıp aynı adla yenisini açacak.`;
  }
}

module.exports = { Ops, DEVIR_TOOL, MAX_NOTE, asksUser };
