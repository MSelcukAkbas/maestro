// Sunucunun ortak bağlamı: ayarlar, erişim anahtarı, modül örnekleri ve birden çok parçanın kullandığı yardımcılar.
// Diğer parçalar (panel/*, routes/*) buradan alır. settings nesnesinin kimliği hiç değişmez (replaceSettings yerinde
// günceller); bu yüzden parçalar onu yüklenirken bir kez alabilir. Anahtar ve kota önbelleği değiştiği için fonksiyonla okunur.
const fs = require('fs');
const path = require('path');

const store = require('../core/store');
const prompts = require('../core/prompts');
const { discovery } = require('../../agent');
const { quota: { allQuota } } = require('../../agent');
const { sessionStats } = require('../core/usage');
const { Timeline } = require('../team/timeline');
const { Meter } = require('../watch/meter');
const { Watch, WATCH_DEFAULTS } = require('../watch/watch');
const { Ops } = require('../watch/ops');
const { AgentLink } = require('./agentlink');
const { HookState } = require('../session/hooks');
const { Boards } = require('../team/board');
const { Caps } = require('../setup/caps');
const { Notes } = require('../team/notes');
const { Requests } = require('../team/team');
const { Presence } = require('../session/presence');
const { Ledger } = require('../core/ledger');
const { Pending } = require('../session/pending');
const llm = require('../core/llm');
const { APP_ROOT } = require('../core/paths');

const ROOT = APP_ROOT;
const settings = store.loadSettings();
// Roller prompts/roles/ klasörlerinden okunur (dosya değişince yenilenir); settings.json'a yazılmaz.
Object.defineProperty(settings, 'roles', { enumerable: true, get: () => prompts.roles() });
let token = store.loadToken();
// Dinlenen port açılışta sabitlenir; ayarlardaki port değişikliği yeniden başlatınca geçerli olur.
const PORT = Number(process.env.MAESTRO_PORT) || settings.port;
const hookState = new HookState();
const manager = new AgentLink({ getShell: () => settings.shell, onToken: (t) => { hookState.token = t; } });
manager.onExit((id) => hookState.clear(id));
const boards = new Boards(store.DATA_DIR);
const caps = new Caps(store.DATA_DIR);
const notes = new Notes(store.DATA_DIR);
const requests = new Requests(store.DATA_DIR);
const timeline = new Timeline(store.DATA_DIR);
const meter = new Meter(store.DATA_DIR, path.join(sharedConfigDir(), 'projects'));
const watch = new Watch(store.DATA_DIR);
const presence = new Presence(store.DATA_DIR);
const ledger = new Ledger(store.DATA_DIR);
// Oturum açılırken istenen model / effort / kapalı skill'ler; oturum kaydındaki gerçekleşenle karşılaştırılır (launchDrift).
const launched = new Map();
const pending = new Pending(store.DATA_DIR);
llm.onSpend((e) => {
  ledger.add(e);
  meter.addSpend(e.account, e.tok);
});
caps.projectDirs = () => store.loadProjects().map((p) => p.path);
try { caps.learnFromTranscripts(path.join(sharedConfigDir(), 'projects')); } catch (err) { console.error('[panel] skill kataloğu:', err.message); }
manager.onInput((sess) => presence.touch(`terminal: ${sess.name}`));
const ops = new Ops({
  member: (sid) => findSession(store.viewGroups(), sid),
  state: (sid) => {
    const found = findSession(store.viewGroups(), sid);
    const p = manager.get(sid);
    if (!found || !p) return null;
    const live = discovery.liveSessions(sharedConfigDir());
    const h = hookState.get(sid);
    const st = sessionStatus(found.session, live);
    return { status: st.status, live: live.has(sid), ended: !!(h && h.ended), error: st.error || (h && h.error) || null, lastInputAt: p.lastInputAt };
  },
  info: (sid) => meter.sessionInfo(sid),
  lastText: (sid) => lastText(sid),
  delivering: (sid) => {
    const found = findSession(store.viewGroups(), sid);
    return !!found && (boards.hasPending(found.group.id, sid) || notes.hasPending(found.group.id, sid) || requests.hasInbox(sid));
  },
  paste: (sid, text, activity) => {
    const found = findSession(store.loadGroups(), sid);
    if (found && pasteTo(found.session, text)) hookState.set(sid, 'busy', { activity });
  },
  // Açılış katmanı bu bağlamı kullandığı için çağrı anında yüklenir (döngüsel require olmasın).
  switchAccount: (sid, accountId) => require('./launch').switchAccount(sid, accountId),
  renew: (sid, note, accountId) => require('./launch').renewSession(sid, note, accountId),
  event: (text, gid) => pushEvent(text.slice(0, 300), 'bekci', gid),
  log: (entry) => watch.note(entry),
});

// ---------- yardımcılar ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isAllowedDir(p) {
  const target = path.resolve(p).toLowerCase();
  return settings.allowedDirs.some((d) => {
    const base = path.resolve(d).toLowerCase();
    return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  });
}

function sharedConfigDir() {
  return settings.accounts[0] && settings.accounts[0].configDir;
}

function hhmm(d = new Date()) {
  return String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
}

function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function findSession(groups, sessionId) {
  for (const g of groups) {
    const s = g.sessions.find((x) => x.id === sessionId);
    if (s) return { group: g, session: s };
  }
  return null;
}

// ---------- durum ----------

// Oturum durumu: hook olayı kesin bilgi verir (izin, soru, tool); Claude'un kendi durum kaydı ise hook'un görmediği
// geçişleri (ör. Esc ile kesme) yakalar. İkisi aynı durumu söylüyorsa ayrıntılı olan hook kullanılır; farklıysa
// Claude'un kaydı ancak hook'tan belirgin şekilde yeniyse geçerli olur (ikisi aynı olayda milisaniyelerle ayrışır).
// Claude bazen bitişten sonra arka planda tool çağırır (ör. önerilen istemin ön denemesi) ve bunun bitişi hook'a
// gelmez; kendi kaydı "boşta" derken hook uzun süredir sessizse "boşta" geçerli olur.
const LIVE_WINS_AFTER = 1000;
const STALE_BUSY = 5000;
function sessionStatus(s, live) {
  if (!manager.has(s.id)) return { status: 'off', waitKind: null, activity: null, error: null };
  const h = hookState.get(s.id);
  const l = live.get(s.id);
  const staleBusy = h && l && h.status === 'busy' && l.status === 'idle' && Date.now() - h.ts > STALE_BUSY;
  const hookWins = h && !staleBusy && (!l || !l.status || l.status === h.status || l.statusUpdatedAt <= h.ts + LIVE_WINS_AFTER);
  if (hookWins) return { status: h.status, waitKind: h.waitKind, activity: h.activity, error: h.error };
  const status = (l && l.status) || 'starting';
  return { status, waitKind: status === 'waiting' ? 'permission' : null, activity: status === 'busy' && h ? h.activity : null, error: null };
}

// ---------- olaylar, ekip bildirimleri, otomatik hesap rotasyonu, açılışta başlatma ----------

// Panelin kendiliğinden yaptığı işler (ör. hesap rotasyonu, bekçinin hamleleri) arayüzün bildirim kutusuna düşer.
// source: bildirimi üreten (panel, bekci; ileride başka yardımcılar). data/events.json'da saklanır; panel yeniden
// başlayınca bildirim geçmişi kaybolmaz.
const EVENTS_KEEP = 100;
const events = store.readJson('events.json', []).slice(-EVENTS_KEEP);
let eventSeq = events.reduce((n, e) => Math.max(n, e.id || 0), 0);
let eventsTimer = null;
function pushEvent(text, source = 'panel', gid = null) {
  events.push({ id: ++eventSeq, ts: Date.now(), text, source, gid });
  if (events.length > EVENTS_KEEP) events.shift();
  console.log(`[panel] ${source === 'bekci' ? 'Bekçi: ' : ''}${text}`);
  if (!eventsTimer) {
    eventsTimer = setTimeout(() => {
      eventsTimer = null;
      try { store.writeJson('events.json', events); } catch (err) { console.error('[panel] olaylar:', err.message); }
    }, 2000);
  }
}

// Ekibi yöneten çalışan üye: önce şef, yoksa çalışan ilk üye.
function runningLead(group, exceptId) {
  const alive = group.sessions.filter((s) => !s.removed && s.id !== exceptId && manager.has(s.id));
  return alive.find((s) => s.roleId === 'sef') || alive[0] || null;
}

function pasteTo(session, text) {
  const p = manager.get(session.id);
  if (!p) return false;
  p.paste(text);
  return true;
}

// Kota uç noktası belgelenmemiş ve sık sorguda 429 döner; arayüz, otomatik rotasyon ve ekip_durumu tek önbelleği paylaşır.
const QUOTA_TTL = 2 * 60 * 1000;
let quotaMemo = null;
let quotaInflight = null;
function cachedQuota(force) {
  if (!force && quotaMemo && Date.now() - quotaMemo.fetchedAt < QUOTA_TTL) return Promise.resolve(quotaMemo);
  if (!quotaInflight) {
    if (process.env.MAESTRO_HOOK_DEBUG) console.log('[panel] kota çekiliyor');
    quotaInflight = allQuota(settings.accounts)
      .then((q) => {
        quotaMemo = q;
        try { meterTick(); meter.onQuota(q); } catch (err) { console.error('[panel] ölçüm:', err.message); }
        return q;
      })
      .finally(() => { quotaInflight = null; });
  }
  return quotaInflight;
}

// Hesap bu klasöre ya da bir üst klasörüne güven onayı vermiş mi (hesabın .claude.json'ı). Onaysız hesaba taşınan
// oturum açılışta güven sorusunda kalır. Dosya okunamazsa engellenmez.
function trustsDir(accountId, dir) {
  const account = settings.accounts.find((a) => a.id === accountId);
  if (!account) return false;
  let projects;
  try { projects = JSON.parse(fs.readFileSync(path.join(account.configDir, '.claude.json'), 'utf8')).projects || {}; } catch { return true; }
  const trusted = new Set(Object.entries(projects).filter(([, v]) => v && v.hasTrustDialogAccepted).map(([k]) => path.resolve(k).toLowerCase()));
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (trusted.has(d.toLowerCase())) return true;
    if (path.dirname(d) === d) return false;
  }
}

// Kalan kota yüzdesi: iki pencereden küçük olanı; dolu hesap 0.
function quotaLeft(row) {
  if (row.blocked) return 0;
  const vals = [row.five, row.week].filter(Boolean).map((b) => 100 - b.used);
  return vals.length ? Math.min(...vals) : null;
}

// ---------- etkinlik: zaman çizelgesi örneklemesi ve iletişim ----------

const USER_TL = '_user';


// Ölçüm: çalışan ve son 10 dakikada kapanmış üyelerin harcaması bulundukları hesaba yazılır.
const meterSeen = new Map();
function meterTick() {
  const now = Date.now();
  const list = [];
  for (const g of store.viewGroups()) {
    for (const s of g.sessions) {
      if (manager.has(s.id)) meterSeen.set(s.id, now);
      const seen = meterSeen.get(s.id);
      if (!seen) continue;
      if (now - seen > 10 * 60 * 1000) { meterSeen.delete(s.id); continue; }
      list.push({ id: s.id, name: s.name, accountId: s.accountId, file: discovery.transcriptPath(sharedConfigDir(), s.id) });
    }
  }
  meter.tick(list, now);
  for (const att of meter.takeSkillListings()) caps.learnSkills(att);
  presence.resolve((sid, ts) => meter.turnAfter(sid, ts), (sid) => {
    const st = sessionStats(discovery.transcriptPath(sharedConfigDir(), sid));
    return st && st.model;
  });
}


// Grubun bekçi ayarı: genel ayar (Ayarlar → Genel) üstüne grubun kendi açık/kapalı seçimleri (group.watch).
function groupWatchCfg(g) {
  return { ...WATCH_DEFAULTS, ...(settings.watch || {}), ...((g && g.watch) || {}) };
}

// Üyenin konuşma dosyasındaki son mesajı (yoksa boş).
function lastText(sid) {
  const st = sessionStats(discovery.transcriptPath(sharedConfigDir(), sid));
  return (st && st.lastText) || '';
}

// Kapatma, açılıştan hemen sonra 3 sn'ye kadar ertelenebildiği için (PtySession.kill) 10 sn beklenir.
function whenStopped(id, cb, tries = 100) {
  if (!manager.has(id)) return cb();
  if (tries <= 0) return cb(new Error('Oturum kapanmadı.'));
  setTimeout(() => whenStopped(id, cb, tries - 1), 100);
}

function boardGroup(gid) {
  const g = store.loadGroups().find((x) => x.id === gid);
  if (!g) throw new HttpError(404, 'Grup bulunamadı.');
  return g;
}

// withAgent: ajanı ve açık bütün oturumları da kapatır; olmadan yalnızca services biter, oturumlar ajanda yaşar.
function shutdown(withAgent = false) {
  // Zaman çizelgesinde panelin kapandığı an "kapalı" olarak işaretlenir; yoksa son durum yeniden açılışa kadar uzar.
  try {
    for (const g of store.loadGroups()) {
      let changed = false;
      for (const s of g.sessions) if (timeline.record(g.id, s.id, 'off')) changed = true;
      if (changed) timeline.save(g.id);
    }
    if (timeline.record(USER_TL, 'user', 'off')) timeline.save(USER_TL);
    store.writeJson('events.json', events);
    meter.persistHistory(Date.now(), true);
  } catch {}
  if (withAgent) manager.shutdownAgent();
  setTimeout(() => process.exit(0), withAgent ? 800 : 300);
}

// Açılışta tüm konuşma kayıtlarının ilk ayrıştırması (arşivdekiler dahil birkaç saniye) ilk isteği bekletmesin diye
// oturum oturum, aralarda olay döngüsüne dönerek yapılır.
function warmStats() {
  const ids = store.viewGroups().flatMap((g) => g.sessions.map((s) => s.id));
  let i = 0;
  const step = () => {
    if (i >= ids.length) return;
    try { sessionStats(discovery.transcriptPath(sharedConfigDir(), ids[i])); } catch {}
    i += 1;
    setImmediate(step);
  };
  setImmediate(step);
}

// Ayarlar yerinde değiştirilir; settings nesnesini tutan parçalar güncel hali görür.
function replaceSettings(next) {
  for (const k of Object.keys(settings)) if (k !== 'roles') delete settings[k];
  const { roles, ...rest } = next;
  Object.assign(settings, rest);
}

function currentToken() {
  return token;
}

function rotateToken() {
  token = store.rotateToken();
  return token;
}

function lastQuota() {
  return quotaMemo;
}

module.exports = {
  ROOT, PORT, settings, replaceSettings, currentToken, rotateToken,
  hookState, manager, boards, caps, notes, requests, timeline, meter, watch, presence, ledger, launched, pending, ops,
  HttpError, isAllowedDir, sharedConfigDir, hhmm, cleanText, findSession, sessionStatus,
  events, pushEvent, runningLead, pasteTo, cachedQuota, lastQuota, trustsDir, quotaLeft,
  USER_TL, meterTick, groupWatchCfg, lastText, whenStopped, boardGroup, shutdown, warmStats,
};
