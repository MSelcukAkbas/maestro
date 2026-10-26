// Claude Panel sunucusu: yalnızca 127.0.0.1'de çalışır, her API ve WebSocket çağrısı erişim anahtarı ister.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const store = require('./store');
const discovery = require('./discovery');
const { allQuota } = require('./quota');
const { sessionStats, sessionMessages } = require('./usage');
const { Timeline } = require('./timeline');
const { Meter } = require('./meter');
const { Watch, WATCH_DEFAULTS, ctxLimits } = require('./watch');
const { Ops, DEVIR_TOOL, asksUser } = require('./ops');
const helper = require('./helper');
const optimizer = require('./optimizer');
const { SessionManager } = require('./sessions');
const { HookState, writeSettingsFile, writeMcpConfig, TOKEN_ENV } = require('./hooks');
const { Boards, resolveMember, handleMcp, STATUS_TEXT } = require('./board');
const exporter = require('./exporter');
const { Caps, testMcp } = require('./caps');
const { Notes, NOTE_TOOLS, NOTE_LEAD_TOOLS, CURATOR_TOOLS, CURATOR, callNoteTool, callCuratorTool, actorLabel } = require('./notes');
const { Curator, CURATOR_DEFAULTS, CURATOR_LEVELS } = require('./curator');
const { cleanRef, listDocs, readDoc, searchDocs, DOC_TOOL, callDocTool } = require('./docs');
const { Requests, TOOL_STATUS, LEAD_TOOLS, KIND_TEXT, callTeamTool, describe: describeRequest } = require('./team');
const { Presence, AWAY_MS } = require('./presence');
const { Ledger } = require('./ledger');
const { Pending, driftOf } = require('./pending');
const llm = require('./llm');
const { MODELS, MODEL_TEXT, EFFORTS, PERMISSION_MODES } = require('./options');

const ROOT = path.join(__dirname, '..');
let settings = store.loadSettings();
let token = store.loadToken();
// Dinlenen port açılışta sabitlenir; ayarlardaki port değişikliği yeniden başlatınca geçerli olur.
const PORT = Number(process.env.CLAUDE_PANEL_PORT) || settings.port;
const hookState = new HookState();
const manager = new SessionManager(settings.shell, { env: { [TOKEN_ENV]: hookState.token } });
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
  switchAccount: (sid, accountId) => switchAccount(sid, accountId),
  renew: (sid, note, accountId) => renewSession(sid, note, accountId),
  event: (text, gid) => pushEvent(text.slice(0, 300), 'bekci', gid),
  log: (entry) => watch.note(entry),
});

const curator = new Curator({
  notes, dataDir: store.DATA_DIR, port: PORT, token: hookState.token,
  // Kapatılan (arşivlenen) grupların notları zamanlı düzenlemeye girmez.
  groups: () => store.viewGroups().filter((g) => !g.archived),
  cards: (g) => boards.load(g.id).cards.map((c) => ({
    id: c.id, status: c.status, statusText: STATUS_TEXT[c.status], title: c.title, desc: c.desc,
    assignee: c.assignee ? actorLabel(g, c.assignee) : 'yok', lastNote: c.notes.length ? `${actorLabel(g, c.notes[c.notes.length - 1].by)}: ${c.notes[c.notes.length - 1].text}` : '',
  })),
  project: (g) => store.loadProjects().find((p) => p.id === g.projectId) || null,
  // Sorular yalnızca açık şefe gider; cevap tool'u yalnızca şefte var.
  lead: (g) => g.sessions.find((s) => !s.removed && s.roleId === 'sef' && manager.has(s.id)) || null,
  actorName: (g, id) => actorLabel(g, id),
  account: () => helper.pickAccount(settings.accounts, quotaMemo),
  settings: () => settings,
  event: (text, gid) => pushEvent(text.slice(0, 300), 'notlar', gid),
  tell: (gid, text) => ops.tell(gid, text),
});

const STATIC = {
  '/': ['web/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['web/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['web/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['web/style.css', 'text/css; charset=utf-8'],
  '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
  '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
};

// ---------- yardımcılar ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, max = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, 'İstek çok büyük.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Geçersiz JSON.')); }
    });
    req.on('error', reject);
  });
}

function allowedHosts() {
  return [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
}

function tokenOk(given) {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
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

function buildState() {
  const live = discovery.liveSessions(sharedConfigDir());
  const groups = store.viewGroups().map((g) => {
    const sessions = g.sessions.map((s) => {
      // Rol talimatı metni, dosya yolları ve oturuma özel yetenek ayarı arayüzde okunmaz; her 2 sn'lik yoklamada indirilmez.
      const { rolePrompt, promptFile, taskFile, caps, ...rest } = s;
      const running = manager.has(s.id);
      const st = sessionStatus(s, live);
      const stats = sessionStats(discovery.transcriptPath(sharedConfigDir(), s.id));
      return { ...rest, running, ...st, status: running ? st.status : null, stats, drift: running ? launchDrift(s.id) : [], pending: pending.get(s.id) };
    });
    const active = sessions.some((s) => s.running);
    const reqs = requests.pending(g.id).map((r) => ({ ...r, kindText: KIND_TEXT[r.kind], text: describeRequest(g, r, settings.roles, settings.accounts) }));
    return { ...g, sessions, requests: reqs, state: active ? 'active' : g.archived ? 'archived' : 'past' };
  });
  return {
    settings,
    projects: store.loadProjects(),
    groups,
    templates: store.loadTemplates(),
    events,
    autostart: fs.existsSync(STARTUP_LINK),
    presence: presence.view(),
    measuredWindows: ledger.windows,
  };
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

function switchAccount(sessionId, accountId) {
  const account = settings.accounts.find((a) => a.id === accountId);
  if (!account) throw new HttpError(400, 'Hesap bulunamadı.');
  const groups = store.loadGroups();
  const found = findSession(groups, sessionId);
  if (!found) throw new HttpError(404, 'Oturum bulunamadı.');
  const { group, session } = found;
  if (session.accountId === account.id) return { ok: true, unchanged: true };
  const wasRunning = manager.has(session.id);
  // Önceki harcama eski hesaba yazılsın, ardından taşımanın maliyeti yeni hesapta ölçülsün.
  try {
    meterTick();
    meter.noteSwitch(session, discovery.transcriptPath(sharedConfigDir(), session.id), session.accountId, account.id);
  } catch (err) { console.error('[panel] ölçüm:', err.message); }
  session.accountId = account.id;
  store.saveGroups(groups);
  if (wasRunning) {
    manager.stop(session.id);
    whenStopped(session.id, (err) => {
      if (err) return console.error(`[panel] ${session.name}:`, err.message);
      try { launchSession(group, session, { resume: true }); } catch (e) { console.error(`[panel] ${session.name}:`, e.message); }
    });
  }
  return { ok: true, restarted: wasRunning };
}

// Üyenin model / effort ayarını değiştirir. Kayıt hemen güncellenir (sonraki açılış yeni ayarla olur); çalışan üye
// bekleyen değişiklik olarak en ucuz anda kaldığı yerden yeniden açılır (server/pending.js). now: beklemeden uygula.
function changeSettings(sessionId, body, by = 'user') {
  const groups = store.loadGroups();
  const found = findSession(groups, sessionId);
  if (!found || found.session.removed) throw new HttpError(404, 'Oturum bulunamadı.');
  const { group, session } = found;
  const change = {};
  if (body.model !== undefined) {
    if (body.model !== '' && !MODELS.includes(body.model)) throw new HttpError(400, `Geçersiz model: ${body.model}`);
    if ((session.model || '') !== body.model) change.model = body.model || 'varsayılan';
    session.model = body.model;
  }
  if (body.effort !== undefined) {
    if (body.effort !== '' && !EFFORTS.includes(body.effort)) throw new HttpError(400, `Geçersiz effort: ${body.effort}`);
    if ((session.effort || '') !== body.effort) change.effort = body.effort || 'varsayılan';
    session.effort = body.effort;
  }
  store.saveGroups(groups);
  if (!manager.has(session.id)) return { ok: true, running: false };
  if (!Object.keys(change).length && !body.now) return { ok: true, running: true, unchanged: true };
  const p = pending.add(session.id, group.id, change, by, !!body.now);
  return { ok: true, running: true, pending: p };
}

// Bekleyen değişikliği iptal eder: kayıt çalışan oturumun ayarına döner.
function cancelSettings(sessionId) {
  const groups = store.loadGroups();
  const found = findSession(groups, sessionId);
  const run = launched.get(sessionId);
  if (found && run) {
    found.session.model = run.model || '';
    found.session.effort = run.effort || '';
    store.saveGroups(groups);
  }
  pending.remove(sessionId);
  return { ok: true };
}

function pendingTick() {
  const live = discovery.liveSessions(sharedConfigDir());
  for (const [sid, p] of pending.entries()) {
    const found = findSession(store.loadGroups(), sid);
    // Çıkarılan ya da kapanan üye: değişiklik kayıtta, sonraki açılışta uygulanır.
    if (!found || found.session.removed || !manager.has(sid)) {
      pending.remove(sid);
      continue;
    }
    const { group, session } = found;
    const pty = manager.get(sid);
    const idle = sessionStatus(session, live).status === 'idle' && ops.free(sid) && !hasDelivery(group.id, sid, true)
      && Date.now() - ((pty && pty.lastInputAt) || 0) > 30000;
    if (!pending.ready(p, meter.sessionInfo(sid), idle)) continue;
    pending.remove(sid);
    const what = [p.model ? `model ${p.model}` : '', p.effort ? `effort ${p.effort}` : '', p.caps ? 'yetenekler' : ''].filter(Boolean).join(', ') || 'ayar';
    pushEvent(`${session.name}: ${what} için kaldığı yerden yeniden açılıyor.`, 'panel', group.id);
    manager.stop(sid);
    whenStopped(sid, (err) => {
      if (err) return console.error(`[panel] ${session.name}:`, err.message);
      try { launchSession(group, session, { resume: true }); } catch (e) { console.error(`[panel] ${session.name}:`, e.message); }
    });
  }
}
setInterval(pendingTick, 10000);

// Kota uç noktası belgelenmemiş ve sık sorguda 429 döner; arayüz, otomatik rotasyon ve ekip_durumu tek önbelleği paylaşır.
const QUOTA_TTL = 2 * 60 * 1000;
let quotaMemo = null;
let quotaInflight = null;
function cachedQuota(force) {
  if (!force && quotaMemo && Date.now() - quotaMemo.fetchedAt < QUOTA_TTL) return Promise.resolve(quotaMemo);
  if (!quotaInflight) {
    if (process.env.CLAUDE_PANEL_HOOK_DEBUG) console.log('[panel] kota çekiliyor');
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

const ROTATE_EVERY = Number(process.env.CLAUDE_PANEL_ROTATE_MS) || 5 * 60 * 1000;
const noAlternativeWarned = new Set();
let rotating = false;

// Yalnızca "sıra sende" durumundaki oturumlar taşınır; çalışan bir işi yarıda kesmemek için. Bekçisi hamle yapan
// gruplar atlanır: taşıma kararını bekçi maliyet ve güven onayıyla birlikte verir, ikisi aynı üyeyi taşımaya çalışmasın.
async function autoRotateTick() {
  if (!settings.autoRotate || rotating) return;
  const running = store.loadGroups()
    .filter((g) => { const cfg = groupWatchCfg(g); return !(cfg.enabled && cfg.act); })
    .flatMap((g) => g.sessions.filter((s) => !s.removed && manager.has(s.id)).map((s) => ({ ...s, projectId: g.projectId })));
  if (!running.length) return;
  rotating = true;
  try {
    const q = await cachedQuota();
    const left = new Map(q.rows.map((r) => [r.accountId, quotaLeft(r)]));
    const live = discovery.liveSessions(sharedConfigDir());
    for (const s of running) {
      const l = left.get(s.accountId);
      if (l == null || l > 2) continue;
      if (sessionStatus(s, live).status !== 'idle' || !ops.free(s.id)) continue;
      // Proje klasörünü onaylamamış hesaba taşınan oturum açılışta güven sorusunda kalır.
      const project = store.loadProjects().find((p) => p.id === s.projectId);
      const best = [...left.entries()]
        .filter(([id, v]) => id !== s.accountId && v != null && v >= 10 && (!project || trustsDir(id, project.path)))
        .sort((a, b) => b[1] - a[1])[0];
      if (!best) {
        if (!noAlternativeWarned.has(s.id)) pushEvent(`${s.name}: ${s.accountId} kotası doldu ama yeterli kotası olan başka hesap yok.`);
        noAlternativeWarned.add(s.id);
        continue;
      }
      noAlternativeWarned.delete(s.id);
      switchAccount(s.id, best[0]);
      left.set(best[0], best[1] - 5);
      pushEvent(`${s.name}: ${s.accountId} kotası doldu, ${best[0]} hesabına taşındı (kaldığı yerden devam).`);
    }
  } catch (err) {
    console.error('[panel] otomatik hesap rotasyonu:', err.message);
  } finally {
    rotating = false;
  }
}
setInterval(autoRotateTick, ROTATE_EVERY);

const STARTUP_LINK = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Claude Panel.lnk');
const HIDDEN_LAUNCHER = path.join(ROOT, 'Claude-Panel-Arkaplan.vbs');

function setAutostart(enabled) {
  if (!enabled) {
    try { fs.unlinkSync(STARTUP_LINK); } catch {}
    return;
  }
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  const script = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(STARTUP_LINK)})`,
    `$s.TargetPath = ${q(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'))}`,
    `$s.Arguments = ${q(`"${HIDDEN_LAUNCHER}"`)}`,
    `$s.WorkingDirectory = ${q(ROOT)}`,
    '$s.Description = "Claude Panel (arka planda)"',
    '$s.Save()',
  ].join('; ');
  const r = require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new HttpError(500, `Kısayol oluşturulamadı: ${(r.stderr || '').trim().slice(0, 300)}`);
}

// ---------- etkinlik: zaman çizelgesi örneklemesi ve iletişim ----------

const USER_TL = '_user';

function sampleTimeline() {
  let live;
  try { live = discovery.liveSessions(sharedConfigDir()); } catch { return; }
  for (const g of store.viewGroups()) {
    let changed = false;
    for (const s of g.sessions) {
      if (timeline.record(g.id, s.id, sessionStatus(s, live).status)) changed = true;
    }
    if (changed) timeline.save(g.id);
  }
  // Kullanıcının başında olup olmadığı tek bir izde tutulur; grupların "sıra sende" süresi buna göre ayrılır.
  const u = presence.status();
  if (u && timeline.record(USER_TL, 'user', u.s, u.t)) timeline.save(USER_TL);
}
setInterval(sampleTimeline, 2000);

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
setInterval(() => { try { meterTick(); } catch (err) { console.error('[panel] ölçüm:', err.message); } }, 10000);
// Bekçi: dakikada bir kuralları değerlendirir. Proje kararı gerektiren durumları şefe yapıştırır; panel ortamıyla ilgili
// hamle adaylarını yardımcı modele (kapalıysa ya da yanıt geçersizse kural varsayılanına) seçtirip uygular.
// Kota, son ölçümden (en çok 10 dk eski) okunur.
const HOLD_WAIT = 10 * 60 * 1000;
const HOLD_SUGGEST = 30 * 60 * 1000;
// Yardımcı model grup başına sorulur; bir grubun sorusu sürerken o grubun adayları bir sonraki dakikaya kalır.
const helperBusy = new Set();

// Grubun bekçi ayarı: genel ayar (Ayarlar → Genel) üstüne grubun kendi açık/kapalı seçimleri (group.watch).
function groupWatchCfg(g) {
  return { ...WATCH_DEFAULTS, ...(settings.watch || {}), ...((g && g.watch) || {}) };
}

// Üyenin konuşma dosyasındaki son mesajı (yoksa boş).
function lastText(sid) {
  const st = sessionStats(discovery.transcriptPath(sharedConfigDir(), sid));
  return (st && st.lastText) || '';
}

// Yardımcı modelin göreceği bilgi: hesapların kalan kotası, adayların sayısal durumu ve son mesajlarının sonu (cevap
// bekleyen üyeyi tanıması için).
function helperContext(quota, members) {
  const now = Date.now();
  const left = (b) => (b ? Math.max(0, Math.round(100 - b.used)) : null);
  const resetMin = (b) => (b && b.resetsAt ? Math.max(0, Math.round((Date.parse(b.resetsAt) - now) / 60000)) : null);
  // Bu hızla sıfırlanmadan önce dolacaksa kaç dakikada; null: sıfırlanmaya yetiyor ya da tahmin yok.
  const runoutMin = (b) => (b && b.forecast && b.forecast.beforeReset && b.forecast.eta ? Math.max(0, Math.round((b.forecast.eta - now) / 60000)) : null);
  return {
    accounts: ((quota && quota.rows) || []).map((r) => ({
      hesap: r.accountId, durum: r.blocked ? 'dolu' : r.status,
      bes_saat_kalan: left(r.five), bes_saat_sifirlanma_dk: resetMin(r.five), bes_saat_tukenme_dk: runoutMin(r.five),
      hafta_kalan: left(r.week), hafta_sifirlanma_dk: resetMin(r.week), hafta_tukenme_dk: runoutMin(r.week),
    })),
    members: Object.fromEntries(members.map((m) => {
      const i = m.info || {};
      const lim = ctxLimits(m.session, m.info, settings, { ...WATCH_DEFAULTS, ...(settings.watch || {}) });
      const last = lastText(m.session.id);
      return [m.session.id, {
        rol: m.session.roleLabel, hesap: m.session.accountId, durum: m.status === 'busy' ? 'çalışıyor' : m.status === 'idle' ? 'boşta' : m.status,
        baglam_token: i.context || 0, buyume_10dk: i.growthPer10m || 0, compact_sayisi: i.compacts || 0,
        son_hareket_dk: i.lastActiveAt ? Math.round((now - i.lastActiveAt) / 60000) : null,
        rol_esigi_token: lim ? lim.warn : null,
        rol_ust_siniri_token: lim ? lim.high : null,
        cache_sicak: !!i.cacheWarm,
        cache_dusmesine_dk: i.cacheWarm && i.lastTurnAt ? Math.max(0, Math.round((i.lastTurnAt + i.cacheTtlMs - now) / 60000)) : 0,
        cevap_bekliyor: asksUser(last),
        son_mesaj_sonu: last.slice(-300),
      }];
    })),
  };
}

function applyDecisions(results, cfg) {
  for (const { cand, choice, by, why } of results) {
    if (!ops.free(cand.sid)) continue;
    const opt = cand.options.find((o) => o.id === choice);
    const text = `${cand.name}: ${cand.why} → ${opt.text} (karar: ${by}${why ? `, ${why}` : ''})`;
    watch.note({ gid: cand.gid, key: `op:${cand.sid}`, level: 'normal', text: `karar: ${text}` });
    if (opt.kind === 'wait') {
      ops.hold(cand.sid, HOLD_WAIT);
      continue;
    }
    if (!cfg.act) {
      ops.hold(cand.sid, HOLD_SUGGEST);
      pushEvent(`Öneri: ${text}`.slice(0, 300), 'bekci', cand.gid);
      continue;
    }
    if (ops.add({ sid: cand.sid, gid: cand.gid, kind: opt.kind, accountId: opt.accountId || null, then: opt.then || null, why: cand.why, by })) {
      pushEvent(text.slice(0, 300), 'bekci', cand.gid);
    }
  }
}

function watchTick() {
  const groups = store.loadGroups().filter((g) => g.sessions.some((s) => !s.removed && manager.has(s.id)) && groupWatchCfg(g).enabled);
  if (!groups.length) return;
  const live = discovery.liveSessions(sharedConfigDir());
  const input = {
    groups: groups.map((g) => ({
      group: g,
      lead: runningLead(g),
      members: memberSnapshot(g, live).map((m) => ({ session: m.session, status: m.status, info: m.info })),
    })),
    quota: quotaMemo && Date.now() - quotaMemo.fetchedAt < 10 * 60 * 1000 ? quotaMemo : null,
    // Gruplar yukarıda kendi ayarlarına göre süzüldü; eşikler genel ayardan gelir.
    meter, accounts: settings.accounts, settings: { ...settings, watch: { ...(settings.watch || {}), enabled: true } },
    leadStatus: (lead) => sessionStatus(lead, live).status,
    canHost: (accountId, group) => {
      const project = store.loadProjects().find((p) => p.id === group.projectId);
      return !project || trustsDir(accountId, project.path);
    },
  };
  const { sends, cands } = watch.tick(input);
  for (const m of sends) {
    const g = groups.find((x) => x.id === m.gid);
    if (m.held) pushEvent(`${g ? g.name : m.gid} (şef şu an mesaj alamıyor): ${m.text}`.slice(0, 300), 'bekci', m.gid);
    else if (pasteTo(m.lead, m.text) && m.level === 'kritik') pushEvent(`Şefe yazıldı (${m.lead.name}): ${m.text.split('\n')[1] || ''}`.slice(0, 300), 'bekci', m.gid);
  }
  for (const g of groups) {
    const cfg = groupWatchCfg(g);
    const todo = cands.filter((c) => c.gid === g.id && ops.free(c.sid));
    if (!todo.length) continue;
    if (!cfg.ai) {
      applyDecisions(helper.validate(todo, []), cfg);
      continue;
    }
    if (helperBusy.has(g.id)) continue;
    const account = helper.pickAccount(settings.accounts, input.quota);
    if (!account) {
      applyDecisions(helper.validate(todo, []), cfg);
      continue;
    }
    helperBusy.add(g.id);
    const members = input.groups.find((x) => x.group.id === g.id).members;
    helper.ask(account, todo, helperContext(input.quota, members))
      .then((r) => {
        watch.note({ gid: g.id, key: 'helper', level: 'normal', helper: { account: r.account, tokens: r.tokens, costUSD: r.costUSD }, text: `yardımcı model (${r.account}): ${todo.length} aday, ${r.tokens.in + r.tokens.cw + r.tokens.cr} girdi / ${r.tokens.out} çıktı token, ≈$${r.costUSD.toFixed(4)}` });
        applyDecisions(helper.validate(todo, r.decisions), groupWatchCfg(g));
      })
      .catch((err) => {
        console.error('[panel] yardımcı model:', err.message);
        watch.note({ gid: g.id, key: 'helper', level: 'yüksek', text: `yardımcı model yanıt vermedi, kural varsayılanı kullanıldı: ${err.message}` });
        applyDecisions(helper.validate(todo, []), groupWatchCfg(g));
      })
      .finally(() => { helperBusy.delete(g.id); });
  }
}
setInterval(() => { try { ops.tick(); } catch (err) { console.error('[panel] bekçi hamlesi:', err.message); } }, 3000);
setInterval(() => { try { watchTick(); } catch (err) { console.error('[panel] bekçi:', err.message); } }, 60 * 1000);
setInterval(() => { try { curator.tick(); } catch (err) { console.error('[panel] not düzenleyici:', err.message); } }, 10 * 60 * 1000);

// Arayüz kapalıyken de ölçüm sürsün: üye çalışırken kota 5 dakikada bir (önbellek süresine uyarak) okunur.
setInterval(() => {
  if (!store.viewGroups().some((g) => g.sessions.some((s) => manager.has(s.id)))) return;
  cachedQuota().catch((err) => console.error('[panel] kota:', err.message));
}, 5 * 60 * 1000);

// Grup içi mesajlar: her üyenin SendMessage çağrıları, alıcı adı grup üyeleriyle eşleştirilir.
// Mesaj gövdeleri yanıtın çoğunu tutar (yüzlerce mesajda ~1 MB); liste yalnızca özeti alır, gövde açılınca ya da aranınca istenir.
function groupActivity(gid, bodies = false) {
  const g = store.viewGroups().find((x) => x.id === gid);
  if (!g) throw new HttpError(404, 'Grup bulunamadı.');
  // Yenilenen üyenin eski ve yeni oturumu aynı adı taşır; ad güncel üyeye eşlenir.
  const byName = new Map([...g.sessions.filter((s) => s.removed), ...g.sessions.filter((s) => !s.removed)].map((s) => [s.name, s.id]));
  const messages = [];
  for (const s of g.sessions) {
    for (const m of sessionMessages(discovery.transcriptPath(sharedConfigDir(), s.id))) {
      messages.push({ ts: m.ts, from: s.id, to: byName.get(m.to) || null, toName: m.to, text: m.text, ...(bodies ? { body: m.body } : {}) });
    }
  }
  messages.sort((a, b) => a.ts - b.ts);
  return { now: Date.now(), messages, timeline: timeline.get(gid), user: timeline.get(USER_TL).user || [], awayMs: AWAY_MS };
}

// ---------- oturum başlatma ----------

const PERMISSION_TEXT = {
  manual: 'her işlemde sorar',
  acceptEdits: 'dosya düzenlemelerini kendisi kabul eder',
  auto: 'otomatik',
  plan: 'plan modu (değişiklik yapmadan önce plan sunar)',
};


function permissionOf(group, s) {
  return s.permissionMode || group.permissionMode;
}

function accountName(id) {
  const a = settings.accounts.find((x) => x.id === id);
  return a ? a.name : id;
}

function namesOf(group, ids) {
  return ids.map((id) => group.sessions.find((s) => s.id === id)).filter(Boolean).map((s) => s.name);
}

// Şef rolündeki oturum ekibi yönetir; ona her üyenin tam görevi verilir.
function isLead(group, s) {
  const lead = group.sessions.find((x) => x.roleId === 'sef' && !x.removed);
  return lead ? lead.id === s.id : false;
}

function memberLine(group, m, self) {
  const reports = namesOf(group, m.reportsTo);
  const parts = [
    `${m.roleLabel}`,
    `hesap ${accountName(m.accountId)}`,
    `model ${MODEL_TEXT[m.model] || 'hesap varsayılanı'}`,
    `izin: ${PERMISSION_TEXT[permissionOf(group, m)] || permissionOf(group, m)}`,
  ];
  const tail = [];
  if (reports.length) tail.push(`rapor verir: ${reports.join(', ')}`);
  if (m.talkAll) tail.push('herkesle konuşur');
  return `- **${m.name}**${m.id === self.id ? ' (sen)' : ''} — ${parts.join(' · ')}${tail.length ? `. ${tail.join('; ')}` : ''}`;
}

function writePromptFile(fullGroup, session, project) {
  // Gruptan çıkarılan üyeler ekip listesinde yer almaz.
  const group = { ...fullGroup, sessions: fullGroup.sessions.filter((s) => !s.removed || s.id === session.id) };
  const lead = isLead(group, session);
  const reports = namesOf(group, session.reportsTo);
  const reportedBy = group.sessions.filter((s) => s.reportsTo.includes(session.id)).map((s) => s.name);
  const others = group.sessions.filter((s) => s.id !== session.id);

  const lines = [
    '# Claude Panel ekip oturumu',
    `Bu oturum Claude Panel tarafından "${group.name}" grubunun bir üyesi olarak açıldı.`,
    'Ekipteki diğer üyeler aynı proje klasöründe çalışan ayrı Claude oturumlarıdır; aranızda yalnızca SendMessage ile haberleşirsiniz.',
    'Bu terminali kullanıcı da izliyor; kullanıcı doğrudan sana yazabilir. Kullanıcının talimatı ekip üyelerinin isteklerinden önce gelir.',
    '',
    '## Kimliğin',
    `- Adın: ${session.name} (diğer üyeler sana bu adla yazar)`,
    `- Rolün: ${session.roleLabel}`,
    `- Hesap / model: ${accountName(session.accountId)} / ${MODEL_TEXT[session.model] || 'hesap varsayılanı'}${session.effort ? ` (effort ${session.effort})` : ''}`,
    `- İzin modu: ${PERMISSION_TEXT[permissionOf(group, session)] || permissionOf(group, session)}`,
    `- Proje klasörü: ${project.path}`,
    '',
    '## Rol talimatı',
    session.rolePrompt || '(talimat yok)',
    '',
    '## Ekip',
    ...group.sessions.map((m) => memberLine(group, m, session)),
  ];

  if (lead && others.length) {
    lines.push('', '## Ekip üyelerinin görevleri', 'Görev dağıtırken her üyenin aşağıdaki rol talimatını ve izin modunu dikkate al.');
    for (const m of others) {
      lines.push('', `### ${m.name} — ${m.roleLabel}`, m.rolePrompt || '(talimat yok)');
    }
    lines.push(
      '',
      '## Orkestrasyon',
      '- Her üyeye tek seferde net ve kendi başına anlaşılır bir görev ver; görevin ilk satırı tek cümlelik özet olsun.',
      '- Birbirine bağlı işleri sırayla ver; bağımsız işleri aynı anda dağıtabilirsin.',
      '- Bir üyenin işini bitirdiğini öğrenmek için SendMessage\'ın notify_when_idle seçeneğini kullanabilirsin; "bitti mi?" diye tekrar tekrar sorma.',
      '- Aynı dosyaya iki üyeyi aynı anda yazdırma.',
      '- Kullanıcıya her önemli adımdan sonra bu terminalde kısa durum özeti ver.',
    );
  }

  lines.push(
    '',
    '## İletişim kuralları',
    reports.length ? `- Rapor verdiğin üyeler: ${reports.join(', ')}` : '- Belirli bir rapor verdiğin üye yok; işini bitirince sana görevi verene bildir.',
    reportedBy.length ? `- Sana rapor veren üyeler: ${reportedBy.join(', ')}` : '',
    session.talkAll
      ? '- Ekipteki herkesle SendMessage ile konuşabilirsin.'
      : '- Yalnızca rapor verdiğin üyelerle ve sana yazan üyelerle konuş.',
    '- Diğer üyelere ulaşmanın tek yolu SendMessage aracıdır; düz metin çıktın onlara ulaşmaz.',
    // Şef dışındaki üyelerin terminal çıktısını kimse okumuyor; uzun özet boşa çıktı token'ı ve büyüyen bağlamdır.
    lead ? '' : '- Kullanıcı genelde yalnızca şefle konuşur, bu terminalin çıktısını okumaz. Sonucunu kullanıcıya hitaben özetleme; raporu yalnızca SendMessage, pano ve notlarla ilet, terminalde en fazla tek satır bırak. Kullanıcı bu terminale doğrudan yazarsa ona normal cevap ver.',
    '- Alıcı olarak ekip listesindeki tam adı kullan. Ad ListAgents listesinde görünmüyorsa kullanıcıya bildir.',
    '- Mesajının ilk satırı tek cümlelik özet olsun (ne istiyorsun ya da ne bitti), ayrıntıyı alt satırlara yaz.',
    '- Rapor verirken: ne yaptın, değişen dosyalar, doğrulama sonucu, açık sorular, önerilen sıradaki adım.',
    '- Sana bir görev geldiğinde gereksiz "aldım" mesajı atma; işe başla, bitince ya da takılınca yaz.',
    '- Senin izin modunda reddedilen ya da yapamadığın bir işlemi başka bir üyeye yaptırmaya çalışma; kullanıcıya bildir.',
    '- Başka bir üyenin çalıştığı dosyayı aynı anda değiştirme; çakışma riski varsa önce sor.',
  );

  lines.push(
    '',
    '## Görev panosu',
    '- Ekibin görevleri Claude Panel görev panosunda kart olarak tutulur. Kullanıcı panoyu panelden izler ve düzenler.',
    '- Panelin MCP tool\'ları: pano_listele (kartlar), pano_ekle (yeni kart), pano_guncelle (durum, atanan, not).',
    '- Sana atanan kartta işe başlayınca durumu "yapılıyor", incelemeye hazır olunca "review", bitince "bitti" yap; takılırsan karta not ekle.',
    '- Kullanıcı ya da başka bir üye panoda seni ilgilendiren bir değişiklik yaparsa panel bunu sana "[Claude Panel · Görev panosu]" başlıklı notla iletir; bu notu kullanıcı talimatı gibi dikkate al.',
    lead
      ? '- Görev dağıtırken her alt görevi pano_ekle ile kart olarak aç ve üyeye ata; panel kartı üyeye kendiliğinden iletir, aynı görevi ayrıca SendMessage ile gönderme. Ayrıntı, soru ve yönlendirme için SendMessage kullanmaya devam et.'
      : '- Panodaki değişiklikler (ör. kartı review\'a almak) ilgili üyelere panel tarafından iletilir; aynı bilgiyi ayrıca SendMessage ile tekrar gönderme.',
    '',
    '## Grup notları',
    '- Ekibin ortak not defteri: kararlar, bulgular, herkesin bilmesi gereken bilgiler (API sözleşmesi, ortam, kurallar). Tool\'lar: not_listele, not_oku, not_ekle, not_guncelle.',
    '- Ekibi ilgilendiren bir karar ya da bilgi çıktığında not_ekle ile yaz; panel diğer üyelere kısa bildirim gönderir. Görev vermek için not değil panoyu kullan.',
    '- Biri not eklediğinde panel sana "[Claude Panel · Grup notları]" başlıklı kısa bildirim iletir; işinle ilgiliyse not_oku ile oku, değilse yanıt yazmadan işine devam et.',
    '- ekip_durumu: üyelerin ne yaptığı, hesapları ve hesapların kalan kotası.',
    '- Kullanıcı bir notu ya da dokümanı (tamamını ya da bir kısmını) sana "[Claude Panel · Hatırlatma]" başlığıyla gönderebilir; bunu kullanıcı talimatı gibi dikkate al.',
  );
  if (project && (project.docRefs || []).length) {
    lines.push(
      '',
      '## Proje dokümanları',
      `- Kullanıcının bu projedeki kendi dokümanları (proje notları): ${project.docRefs.map((r) => path.join(project.path, r)).join(', ')}`,
      '- İşe başlamadan ve karar verirken ilgili dokümana bak; dokuman_listele ile ara, Read ile oku. Bu dokümanlar kullanıcının referansıdır; kullanıcı istemedikçe değiştirme.',
    );
  }
  if (lead) {
    lines.push(
      '',
      '## Ekip yönetimi',
      '- rol_listesi ile paneldeki rolleri gör. Konuşulan iş için ekipte uygun rol yoksa uye_ekle ile o rolde yeni üye iste; gerekçeyi ve ilk görevi yaz.',
      '- Gereksiz kalan üyeyi uye_kapat ile, kotası dolmak üzere olan üyeyi uye_hesap_degistir ile başka hesaba almak için istek gönderebilirsin. Hesap seçerken ekip_durumu\'ndaki kotaya bak.',
      '- Üyenin işi bir skill, eklenti ya da MCP gerektiriyorsa (ya da gereksiz olanı varsa) uye_yetenek_degistir ile açma / kapama iste; rol_listesi rollerin yeteneklerini gösterir.',
      '- İşin niteliği değişen üyenin ayarını uye_ayar_degistir ile isteyebilirsin: rutin işe geçen üyeyi daha düşük effort\'a, zorlanan üyeyi daha yüksek effort\'a ya da modele. Önce effort\'u dene; model değişimi önbelleği sıfırlar.',
      '- Bu istekler kullanıcı onayına düşer; panel sonucu sana "[Claude Panel · Ekip yönetimi]" başlıklı bildirimle iletir. Onay beklerken aynı isteği tekrarlama.',
      '- Kota ve bağlam düzeni (compact, kotası azalan üyeyi başka hesaba taşıma, bağlamı büyüyen üyeyi devir notuyla sıfırdan açma) panelin bekçisinin işidir; bununla uğraşma. Yapılanlar sana "[Claude Panel · Bekçi bilgi]" notuyla bildirilir. Bekçi sana yalnızca proje kararı gerektiren durumlarda (ör. hiçbir hesapta kota kalmadı, bir üye takıldı) "[Claude Panel · Bekçi]" başlığıyla yazar.',
    );
  }

  if (group.flowNote) lines.push('', '## Akış notu', group.flowNote);
  const file = path.join(store.PROMPT_DIR, `${session.id}.md`);
  fs.writeFileSync(file, lines.filter((l) => l !== '').join('\n').replace(/\n(#+ )/g, '\n\n$1') + '\n', 'utf8');
  return file;
}

// İstenen ayarla gerçekleşen arasındaki farklar (boşsa uyumlu). Model ve effort ilk yanıttan, skill listesi açılıştan
// sonra yazılan listeden okunur; devam ettirilen oturumda liste ancak compact'tan sonra yenilenir, o zamana kadar bakılmaz.
function launchDrift(sid) {
  return driftOf(launched.get(sid), meter.sessionInfo(sid));
}

function launchSession(group, session, { resume }) {
  const project = store.loadProjects().find((p) => p.id === group.projectId);
  if (!project) throw new HttpError(404, 'Proje bulunamadı.');
  if (!isAllowedDir(project.path)) throw new HttpError(403, 'Proje klasörü izinli klasörlerin dışında.');
  const account = settings.accounts.find((a) => a.id === session.accountId);
  if (!account) throw new HttpError(400, `Hesap bulunamadı: ${session.accountId}`);

  // Hiç başlamamış bir oturum devam ettirilemez; aynı kimlikle yeniden açılır.
  const canResume = resume && !!discovery.transcriptPath(sharedConfigDir(), session.id);
  const taskFile = !canResume && session.taskFile && !session.taskSent ? session.taskFile : null;
  hookState.clear(session.id);
  // Anlık rollü oturum (custom) yalnızca global yetenekleri olduğu gibi alır.
  const cap = caps.forSession(session.id, session.roleId, session.caps);
  // Salt okunur rol: talimattaki "dosya değiştirme" kuralı izinle de uygulanır.
  const role = settings.roles.find((r) => r.id === session.roleId);
  if (role && role.readOnly) cap.settings.deny.push(...READ_ONLY_DENY);
  // Açılış kayıttaki güncel ayarı kullanır; bu üyenin bekleyen değişikliği böylece uygulanmış olur.
  pending.remove(session.id);
  // İstenen ayar: oturum kaydından gerçekleşenle karşılaştırılır (launchDrift).
  launched.set(session.id, {
    at: Date.now(), model: session.model || null, effort: session.effort || null,
    skillsOff: Object.entries(cap.settings.skillOverrides).filter(([, v]) => v === 'off').map(([k]) => k),
  });

  manager.launch({
    id: session.id,
    name: session.name,
    cwd: project.path,
    configDir: account.configDir,
    resume: canResume,
    permissionMode: permissionOf(group, session),
    model: session.model || undefined,
    effort: session.effort || undefined,
    promptFile: session.promptFile,
    taskFile,
    settingsFile: writeSettingsFile(store.DATA_DIR, PORT, session.id, cap.settings),
    mcpConfig: writeMcpConfig(store.DATA_DIR, PORT, session.id, cap.mcpServers),
    addDir: cap.addDir,
  });
  return { taskSent: !!taskFile };
}

function markTaskSent(groupId, sessionId) {
  const groups = store.loadGroups();
  const g = groups.find((x) => x.id === groupId);
  const s = g && g.sessions.find((x) => x.id === sessionId);
  if (s) {
    s.taskSent = true;
    store.saveGroups(groups);
  }
}

function startSessions(group, sessions, resume) {
  sessions.forEach((s, i) => {
    setTimeout(() => {
      try {
        const r = launchSession(group, s, { resume });
        if (r.taskSent) markTaskSent(group.id, s.id);
      } catch (err) {
        console.error(`[panel] ${s.name} başlatılamadı:`, err.message);
      }
    }, i * 400);
  });
}

// Akış notundaki "proje · rol · hesap · HHmm" adlarını gerçek adlarla eşitler. Aynı öneke sahip birden çok satır varsa
// hangisinin kastedildiği bilinemez; o önek olduğu gibi bırakılır.
function fixFlowNames(text, renames) {
  const counts = new Map();
  for (const r of renames) counts.set(r.prefix, (counts.get(r.prefix) || 0) + 1);
  for (const r of renames) {
    if (counts.get(r.prefix) !== 1) continue;
    const re = new RegExp(r.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' · \\d{4}(?: #\\d+)?', 'g');
    text = text.replace(re, r.name);
  }
  return text;
}

const READ_ONLY_DENY = ['Edit', 'Write', 'NotebookEdit'];

// Kurulum satırından oturum kaydı üretir. Satırda seçim yoksa rolün varsayılan modeli / izin modu kullanılır;
// izin modu boş kalırsa grubun varsayılanı geçerli olur.
function buildSession(r, project, usedNames, time) {
  const account = settings.accounts.find((a) => a.id === r.accountId);
  if (!account) throw new HttpError(400, `Hesap bulunamadı: ${r.accountId}`);
  let roleLabel, roleShort, rolePrompt, roleId, roleMode = '', roleModel = '', roleEffort = '';
  if (r.roleId === 'custom') {
    roleId = 'custom';
    roleLabel = cleanText(r.customLabel, 40);
    if (!roleLabel) throw new HttpError(400, 'Anlık rol için rol adı gerekli.');
    roleShort = roleLabel;
    rolePrompt = String(r.customPrompt || '');
  } else {
    const role = settings.roles.find((x) => x.id === r.roleId);
    if (!role) throw new HttpError(400, `Rol bulunamadı: ${r.roleId}`);
    roleId = role.id;
    roleLabel = role.label;
    roleShort = role.short || role.label;
    // Kurulumda bu ekip için düzenlenen talimat rolün kayıtlı talimatının yerine geçer.
    rolePrompt = typeof r.prompt === 'string' && r.prompt.trim() ? r.prompt.trim() : role.prompt;
    roleMode = role.permissionMode || '';
    roleModel = role.model || '';
    roleEffort = role.effort || '';
  }
  const mode = r.permissionMode === undefined ? roleMode : r.permissionMode;
  const model = r.model === undefined ? roleModel : r.model;
  const effort = r.effort === undefined ? roleEffort : r.effort;
  const namePrefix = `${project.name} · ${roleShort} · ${account.id}`;
  const base = `${namePrefix} · ${time}`;
  let name = base;
  for (let n = 2; usedNames.has(name); n++) name = `${base} #${n}`;
  usedNames.add(name);
  return {
    id: crypto.randomUUID(),
    name,
    namePrefix,
    roleId,
    roleLabel,
    rolePrompt,
    permissionMode: PERMISSION_MODES.includes(mode) ? mode : '',
    accountId: account.id,
    model: MODELS.includes(model) ? model : '',
    effort: EFFORTS.includes(effort) ? effort : '',
    talkAll: !!r.talkAll,
    reportsTo: [],
    ...(capsOverride(r.caps) ? { caps: capsOverride(r.caps) } : {}),
  };
}

// Kurulum satırındaki yetenek ayarı: rol varsayılanının üstüne açılan / kapatılan anahtarlar.
function capsOverride(c) {
  if (!c || typeof c !== 'object') return null;
  const keys = (l) => (Array.isArray(l) ? [...new Set(l.map((k) => cleanText(k, 200)).filter((k) => /^(plugin|skill|mcp|pmcp|pskill):./.test(k)))] : []);
  const on = keys(c.on);
  const off = keys(c.off).filter((k) => !on.includes(k));
  return on.length || off.length ? { on, off } : null;
}

// Çalışan bir gruba yeni üye ekler. Mevcut üyelerin talimatı açılışta kaydedildiği için değişmez;
// bu yüzden yeni üye ilk iş olarak kendini ilgili üyelere SendMessage ile tanıtır.
function addSessionToGroup(groupId, body) {
  const groups = store.loadGroups();
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw new HttpError(404, 'Grup bulunamadı.');
  const project = store.loadProjects().find((p) => p.id === group.projectId);
  if (!project) throw new HttpError(404, 'Proje bulunamadı.');
  if (group.sessions.filter((s) => !s.removed).length >= 12) throw new HttpError(400, 'Bir grupta en fazla 12 oturum olabilir.');
  const r = body.row || {};
  const usedNames = new Set(groups.flatMap((g) => g.sessions.map((s) => s.name)));
  const s = buildSession(r, project, usedNames, hhmm());
  delete s.namePrefix;
  const members = group.sessions.filter((m) => !m.removed);
  s.reportsTo = (Array.isArray(r.reportsTo) ? r.reportsTo : []).filter((id) => members.some((m) => m.id === id));
  group.sessions.push(s);
  s.promptFile = writePromptFile(group, s, project);

  const parts = [];
  if (body.introduce !== false && members.length) {
    const lead = members.find((m) => m.roleId === 'sef');
    const targets = s.talkAll
      ? members.filter((m) => manager.has(m.id))
      : members.filter((m) => (lead && m.id === lead.id) || s.reportsTo.includes(m.id));
    if (targets.length) {
      parts.push(
        'Ekibe çalışma sürerken yeni katıldın. Diğer üyeler seni henüz tanımıyor.',
        `İlk iş olarak şu üyelere SendMessage ile kendini kısaca tanıt: ${targets.map((m) => m.name).join(', ')}.`,
        'Tanıtımda adını, rolünü, kime rapor vereceğini ve hangi işleri alabileceğini yaz; ilk satır tek cümlelik özet olsun.',
      );
    }
  }
  const task = String(body.firstTask || '').trim();
  if (task) parts.push('', 'Kullanıcının ilk görevi:', task.slice(0, 8000));
  else if (parts.length) parts.push('Tanıtımdan sonra görev bekle.');
  if (parts.length) {
    s.taskFile = path.join(store.PROMPT_DIR, `${s.id}.task.md`);
    fs.writeFileSync(s.taskFile, parts.join('\n'), 'utf8');
  }
  store.saveGroups(groups);
  startSessions(group, [s], false);
  return s;
}

function createGroup(body) {
  const project = store.loadProjects().find((p) => p.id === body.projectId);
  if (!project) throw new HttpError(404, 'Proje bulunamadı.');
  if (!isAllowedDir(project.path)) throw new HttpError(403, 'Proje klasörü izinli klasörlerin dışında.');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new HttpError(400, 'En az bir oturum satırı gerekli.');
  if (rows.length > 12) throw new HttpError(400, 'Bir grupta en fazla 12 oturum olabilir.');
  const permissionMode = PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : 'manual';

  const groups = store.loadGroups();
  const usedNames = new Set(groups.flatMap((g) => g.sessions.map((s) => s.name)));
  const time = hhmm();
  const keyToId = new Map();
  // Kurulum ekranı akış notunu tahmini adlarla yazar; dakika değiştiyse ya da ad çakıştıysa gerçek adla değiştirilir.
  const renames = [];

  const sessions = rows.map((r) => {
    const s = buildSession(r, project, usedNames, time);
    keyToId.set(r.key, s.id);
    renames.push({ prefix: s.namePrefix, name: s.name });
    delete s.namePrefix;
    s.reportsToKeys = Array.isArray(r.reportsTo) ? r.reportsTo : [];
    return s;
  });
  for (const s of sessions) {
    s.reportsTo = s.reportsToKeys.map((k) => keyToId.get(k)).filter((id) => id && id !== s.id);
    delete s.reportsToKeys;
  }

  const group = {
    id: crypto.randomUUID(),
    projectId: project.id,
    name: `${cleanText(body.name, 60) || `${project.name} ekibi`} · ${time}`,
    createdAt: Date.now(),
    archived: false,
    flowNote: fixFlowNames(String(body.flowNote || '').slice(0, 8000), renames),
    permissionMode,
    sessions,
  };
  for (const s of sessions) s.promptFile = writePromptFile(group, s, project);

  const task = String(body.firstTask || '').trim();
  if (task) {
    const lead = sessions.find((s) => s.roleId === 'sef') || sessions[0];
    lead.taskFile = path.join(store.PROMPT_DIR, `${lead.id}.task.md`);
    fs.writeFileSync(lead.taskFile, task.slice(0, 8000), 'utf8');
  }

  groups.push(group);
  store.saveGroups(groups);
  const p = store.loadProjects();
  const pr = p.find((x) => x.id === project.id);
  if (pr) {
    pr.lastUsedAt = Date.now();
    store.saveProjects(p);
  }
  startSessions(group, sessions, false);
  return group;
}

// Üyeyi devir notuyla sıfır bağlamla yeniden açar: ad, rol, talimat, izin, model ve ekip ilişkileri aynı, oturum
// kimliği yeni. Eski oturum kapatılıp "yenilendi" olarak ekipten düşer; pano kartları, bekleyen bildirimler ve
// rapor ilişkileri yeni oturuma geçer. Ad aynı kaldığı için diğer üyeler ona aynı adla yazmaya devam eder.
function renewSession(oldSid, note, accountId) {
  const groups = store.loadGroups();
  const found = findSession(groups, oldSid);
  if (!found) throw new HttpError(404, 'Oturum bulunamadı.');
  const { group, session: old } = found;
  const project = store.loadProjects().find((p) => p.id === group.projectId);
  if (!project) throw new HttpError(404, 'Proje bulunamadı.');
  const s = { ...old, id: crypto.randomUUID(), accountId: accountId && settings.accounts.some((a) => a.id === accountId) ? accountId : old.accountId, reportsTo: [...(old.reportsTo || [])], renewedFrom: old.id };
  for (const key of ['promptFile', 'taskFile', 'taskSent', 'removed', 'renewedTo', 'renewedAt']) delete s[key];
  old.removed = true;
  old.renewedTo = s.id;
  old.renewedAt = Date.now();
  group.sessions.splice(group.sessions.indexOf(old), 1, s);
  group.sessions.push(old);
  for (const m of group.sessions) if (m !== old) m.reportsTo = (m.reportsTo || []).map((id) => (id === old.id ? s.id : id));
  s.promptFile = writePromptFile(group, s, project);
  s.taskFile = path.join(store.PROMPT_DIR, `${s.id}.task.md`);
  fs.writeFileSync(s.taskFile, [
    `[Claude Panel · Devir] Bu oturum, aynı roldeki önceki oturumun bağlamı büyüdüğü için panel tarafından sıfır bağlamla açıldı. Adın aynı (${s.name}); ekip sana aynı adla yazmaya devam eder, kendini tanıtma.`,
    'Önceki oturumun devir notu aşağıda. Notta sürmekte olan bir iş varsa kaldığı yerden devam et; yoksa görev bekle. Gerekirse dosyaları yeniden oku, notta olmayan ayrıntıyı tahmin etme.',
    '',
    note,
  ].join('\n'), 'utf8');
  store.saveGroups(groups);
  boards.reassign(group.id, old.id, s.id);
  notes.reassign(group.id, old.id, s.id);
  requests.reassign(old.id, s.id);
  manager.stop(old.id);
  whenStopped(old.id, (err) => {
    if (err) console.error(`[panel] ${old.name}: eski oturum kapanmadı, yenisi yine de açılıyor.`);
    startSessions(group, [s], false);
  });
  return s.id;
}

function openInWindowsTerminal(session) {
  const attach = path.join(ROOT, 'attach.js');
  const child = spawn('wt.exe', ['-w', '0', 'new-tab', '--title', session.name, process.execPath, attach, session.id, String(PORT), store.DATA_DIR], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.on('error', (err) => console.error('[panel] Windows Terminal açılamadı:', err.message));
  child.unref();
}

// Kapatma, açılıştan hemen sonra 3 sn'ye kadar ertelenebildiği için (PtySession.kill) 10 sn beklenir.
function whenStopped(id, cb, tries = 100) {
  if (!manager.has(id)) return cb();
  if (tries <= 0) return cb(new Error('Oturum kapanmadı.'));
  setTimeout(() => whenStopped(id, cb, tries - 1), 100);
}

// ---------- görev panosu: değişikliklerin üyelere iletilmesi ----------

// Üye çalışırken değişiklik, işi bitip durmak üzereyken iletilir: durması engellenir ve değişiklik gerekçe olarak
// verilir. Tool sonucuna eklenen bağlam kullanılmaz; model onu tool çıktısının parçası sayıp (haklı olarak)
// talimat olarak uygulamıyor.
// Üyeye iletilecek pano değişiklikleri ve grup notu bildirimleri tek metinde; take=true iletildi işaretler.
// viaIdle: boştaki üyenin terminaline yazılacak (bekçinin yenileme talimatı bu yolda yalnızca önbellek sıcakken gider).
// Yenilenmekte olan üyeye iletim yapılmaz; bekleyenler yeni oturuma geçer.
function hasDelivery(gid, sid, viaIdle) {
  if (ops.blocks(sid)) return false;
  return !!ops.renewAsk(sid, viaIdle) || boards.hasPending(gid, sid) || notes.hasPending(gid, sid) || requests.hasInbox(sid);
}

function takeDelivery(group, sid, viaIdle) {
  if (ops.blocks(sid)) return null;
  // Devir talimatı tek başına gider; üye notu yazarken araya başka iş girmesin.
  const renew = ops.takeRenewAsk(sid, viaIdle);
  if (renew) return { text: renew, activity: 'devir notu yazıyor' };
  const b = boards.hasPending(group.id, sid) ? boards.pendingFor(group, sid, true) : null;
  const n = notes.hasPending(group.id, sid) ? notes.pendingFor(group, sid, true) : null;
  const r = requests.takeInbox(sid);
  const text = [r, b, n].filter(Boolean).join('\n\n');
  return text ? { text, activity: r ? 'istek sonucu okunuyor' : b ? 'pano güncellemesi okunuyor' : 'grup notu okunuyor' } : null;
}

// Bekçinin şefe bilgi notu: şefin bir sonraki istemine ya da tool sonucuna ek bağlam olarak eklenir, ayrı tur açmaz.
function leadInfo(body) {
  const found = findSession(store.loadGroups(), body.session_id);
  if (!found || found.session.removed || !ops.hasInfo(found.group.id)) return null;
  const lead = runningLead(found.group);
  if (!lead || lead.id !== found.session.id) return null;
  const text = ops.takeInfo(found.group.id);
  return text ? { hookSpecificOutput: { hookEventName: body.hook_event_name, additionalContext: text } } : null;
}

function boardDelivery(body) {
  const ev = body.hook_event_name;
  if (ev === 'UserPromptSubmit' || ev === 'PostToolUse') return leadInfo(body);
  if (ev !== 'Stop') return null;
  const found = findSession(store.loadGroups(), body.session_id);
  if (!found || found.session.removed || !hasDelivery(found.group.id, found.session.id, false)) return null;
  const d = takeDelivery(found.group, found.session.id, false);
  if (!d) return null;
  hookState.set(found.session.id, 'busy', { activity: d.activity });
  return { decision: 'block', reason: d.text };
}

// Boştaki üyeye hook gelmez; değişiklik terminaline istem olarak yazılır. Yalnızca iki ardışık örnekte "boşta"
// görünen, Claude'u açık olan, son turu API hatasıyla bitmemiş ve kullanıcının son 10 saniyede yazmadığı oturumlara.
const idleSeen = new Map();
function boardIdleTick() {
  let live;
  try { live = discovery.liveSessions(sharedConfigDir()); } catch { return; }
  for (const g of store.viewGroups()) {
    for (const s of g.sessions) {
      const p = manager.get(s.id);
      const h = hookState.get(s.id);
      if (s.removed || !p || !live.has(s.id) || (h && (h.ended || h.error)) || sessionStatus(s, live).status !== 'idle') {
        idleSeen.delete(s.id);
        continue;
      }
      const n = (idleSeen.get(s.id) || 0) + 1;
      idleSeen.set(s.id, n);
      if (n < 2 || Date.now() - p.lastInputAt < 10000 || !hasDelivery(g.id, s.id, true)) continue;
      // Önce iletildi işaretlenir; bir sonraki örnek aynı değişikliği ikinci kez yazmasın.
      const d = takeDelivery(g, s.id, true);
      if (d && pasteTo(s, d.text)) {
        idleSeen.delete(s.id);
        hookState.set(s.id, 'busy', { activity: d.activity });
      }
    }
  }
}
setInterval(boardIdleTick, 2000);

function boardGroup(gid) {
  const g = store.loadGroups().find((x) => x.id === gid);
  if (!g) throw new HttpError(404, 'Grup bulunamadı.');
  return g;
}

function boardAssignee(g, v) {
  try {
    return resolveMember(g, v);
  } catch (err) {
    throw new HttpError(err.status || 400, err.message);
  }
}

// ---------- yönlendirme ----------

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, re: new RegExp(`^${pattern}$`), handler });
}

route('GET', '/api/state', async () => buildState());

route('POST', '/api/projects', async (req) => {
  const body = await readBody(req);
  const p = path.resolve(String(body.path || '').trim());
  if (!body.path) throw new HttpError(400, 'Klasör yolu gerekli.');
  let st;
  try { st = fs.statSync(p); } catch { throw new HttpError(400, 'Klasör bulunamadı.'); }
  if (!st.isDirectory()) throw new HttpError(400, 'Bu bir klasör değil.');
  if (!isAllowedDir(p)) throw new HttpError(403, 'Klasör izinli klasörlerin dışında. Ayarlar > İzinli proje klasörleri.');
  const projects = store.loadProjects();
  const existing = projects.find((x) => x.path.toLowerCase() === p.toLowerCase());
  if (existing) return existing;
  const project = { id: crypto.randomUUID(), name: cleanText(body.name, 40) || path.basename(p), path: p, addedAt: Date.now(), lastUsedAt: Date.now() };
  projects.push(project);
  store.saveProjects(projects);
  return project;
});

route('DELETE', '/api/projects/([\\w-]+)', async (req, m) => {
  const groups = buildState().groups.filter((g) => g.projectId === m[1]);
  if (groups.some((g) => g.state === 'active')) throw new HttpError(409, 'Projede çalışan oturum var.');
  store.saveProjects(store.loadProjects().filter((p) => p.id !== m[1]));
  return { ok: true };
});

route('POST', '/api/groups', async (req) => createGroup(await readBody(req)));

route('POST', '/api/groups/([\\w-]+)/resume', async (req, m) => {
  const g = store.loadGroups().find((x) => x.id === m[1]);
  if (!g) throw new HttpError(404, 'Grup bulunamadı.');
  startSessions(g, g.sessions.filter((s) => !s.removed && !manager.has(s.id)), true);
  return { ok: true };
});

route('POST', '/api/groups/([\\w-]+)/sessions', async (req, m) => addSessionToGroup(m[1], await readBody(req)));

route('GET', '/api/groups/([\\w-]+)/activity', async (req, m) => groupActivity(m[1], new URL(req.url, 'http://x').searchParams.get('bodies') === '1'));
route('GET', '/api/groups/([\\w-]+)/message', async (req, m) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const g = store.viewGroups().find((x) => x.id === m[1]);
  const s = g && g.sessions.find((x) => x.id === q.get('from'));
  if (!s) throw new HttpError(404, 'Mesaj bulunamadı.');
  const ts = Number(q.get('ts'));
  const hit = sessionMessages(discovery.transcriptPath(sharedConfigDir(), s.id)).find((x) => x.ts === ts);
  if (!hit) throw new HttpError(404, 'Mesaj bulunamadı.');
  return { body: hit.body };
});

route('GET', '/api/groups/([\\w-]+)/board', async (req, m) => {
  const b = boards.load(boardGroup(m[1]).id);
  return { cards: b.cards, removed: b.removed || [] };
});

route('POST', '/api/groups/([\\w-]+)/board', async (req, m) => {
  const g = boardGroup(m[1]);
  const body = await readBody(req);
  return boards.create(g, { title: body.title, desc: body.desc, status: body.status, assignee: boardAssignee(g, body.assignee) || null }, 'user');
});

route('PUT', '/api/groups/([\\w-]+)/board/(\\d+)', async (req, m) => {
  const g = boardGroup(m[1]);
  const body = await readBody(req);
  const patch = { title: body.title, desc: body.desc, status: body.status, note: body.note };
  if (body.assignee !== undefined) patch.assignee = boardAssignee(g, body.assignee);
  return boards.update(g, m[2], patch, 'user', body.version);
});

route('DELETE', '/api/groups/([\\w-]+)/board/(\\d+)', async (req, m) => boards.remove(boardGroup(m[1]), m[2], 'user'));

// ---------- ekip yönetimi: şefin istekleri ----------

// Grubun üyelerinin anlık görüntüsü: çalışıyor mu, hook durumu, konuşma özeti, ölçüm ve bağlam yüzdesi. Bekçi
// (watchTick) ve ekip_durumu aynı görüntüden beslenir.
function memberSnapshot(group, live = discovery.liveSessions(sharedConfigDir())) {
  return group.sessions.filter((s) => !s.removed).map((s) => {
    const running = manager.has(s.id);
    const st = sessionStatus(s, live);
    const stats = sessionStats(discovery.transcriptPath(sharedConfigDir(), s.id));
    const fam = stats && MODELS.find((f) => String(stats.model || '').includes(f));
    const win = fam && settings.contextWindows && settings.contextWindows[fam];
    const statusText = !running ? 'kapalı'
      : st.status === 'waiting' ? (st.waitKind === 'question' ? 'kullanıcıya soru soruyor' : 'kullanıcı onayı bekliyor')
        : st.status === 'idle' ? 'boşta' : `çalışıyor${st.activity ? ` (${st.activity})` : ''}`;
    return {
      session: s, running, status: running ? st.status : 'off', statusText, stats, info: meter.sessionInfo(s.id),
      contextPct: win && stats.context ? Math.round((stats.context / win) * 100) : null,
    };
  });
}

// ekip_durumu için üye satırları: durum metni, istatistik ve bağlam yüzdesi.
function memberRows(group) {
  return memberSnapshot(group).map((m) => ({ session: m.session, running: m.running, status: m.statusText, stats: m.stats, contextPct: m.contextPct, meter: m.info }));
}

// Rolün panelden aldığı ek yetenekler ve kapatılan global yetenekler, tek satır.
function roleCaps(roleId) {
  const c = caps.load();
  const add = [...c.mcps.filter((m) => m.roles.includes(roleId)).map((m) => `MCP ${m.name}`), ...c.skills.filter((s) => s.roles.includes(roleId)).map((s) => `skill ${s.name}`)];
  const off = Object.entries(c.globalOff).filter(([, roles]) => roles.includes(roleId)).map(([k]) => k.split(':').slice(1).join(':').split('@')[0]);
  return [add.length ? add.join(', ') : '', off.length ? `kapalı: ${off.join(', ')}` : ''].filter(Boolean).join(' · ');
}

// Grubun projesinde verilebilecek yetenekler (anahtar + ad): hesaplardaki ve oturumlarda görülenler, panelden eklenenler.
function capCatalogFor(group) {
  const project = store.loadProjects().find((p) => p.id === group.projectId);
  const c = caps.load();
  return [
    ...caps.inventory(settings.accounts).filter((x) => x.kind !== 'project' || (project && (x.projects || []).includes(project.path)))
      .map((x) => ({ key: x.key, name: x.name, kind: x.kind })),
    ...c.mcps.map((m) => ({ key: `pmcp:${m.id}`, name: m.name, kind: 'mcp' })),
    ...c.skills.map((s) => ({ key: `pskill:${s.name}`, name: s.name, kind: 'skill' })),
  ];
}

// Üyenin yetenek ayarına açma / kapama uygular: rol varsayılanıyla aynı olan kayıt silinir (kurulum ekranındaki kural).
function applyCaps(session, on, off) {
  const base = new Set(caps.roleKeys(session.roleId === 'custom' ? 'custom' : session.roleId, caps.inventory(settings.accounts)));
  const cur = { on: [...((session.caps && session.caps.on) || [])], off: [...((session.caps && session.caps.off) || [])] };
  const set = (key, want) => {
    cur.on = cur.on.filter((k) => k !== key);
    cur.off = cur.off.filter((k) => k !== key);
    if (want !== base.has(key)) cur[want ? 'on' : 'off'].push(key);
  };
  for (const k of on) set(k, true);
  for (const k of off) set(k, false);
  if (cur.on.length || cur.off.length) session.caps = cur;
  else delete session.caps;
}

// Onaylanan isteği uygular; sonuç cümlesi döner.
function execRequest(req) {
  const groups = store.loadGroups();
  const group = groups.find((g) => g.id === req.groupId);
  if (!group) throw new HttpError(404, 'Grup bulunamadı.');
  const a = req.args || {};
  const memberOf = (sid) => group.sessions.find((s) => s.id === sid && !s.removed);
  if (req.kind === 'add') {
    if (!settings.roles.some((r) => r.id === a.roleId)) throw new HttpError(400, 'Rol artık tanımlı değil.');
    let accountId = a.accountId && settings.accounts.some((x) => x.id === a.accountId) ? a.accountId : null;
    if (!accountId) {
      // En çok kotası kalan hesap (önbellekteki son ölçüm); ölçüm yoksa isteyen şefin hesabı.
      const best = quotaMemo && quotaMemo.rows.map((r) => [r.accountId, quotaLeft(r)]).filter(([, v]) => v != null && v > 0).sort((x, y) => y[1] - x[1])[0];
      const lead = memberOf(req.by);
      accountId = best ? best[0] : lead ? lead.accountId : settings.accounts[0].id;
    }
    const row = { roleId: a.roleId, accountId, reportsTo: memberOf(req.by) ? [req.by] : [] };
    if (a.model) row.model = a.model;
    if (a.effort) row.effort = a.effort;
    const s = addSessionToGroup(group.id, { row, firstTask: a.task || '', introduce: true });
    return `${s.name} açıldı (hesap ${accountId}); sana kendini tanıtacak${a.task ? ' ve ilk görevine başlayacak' : ''}.`;
  }
  const target = memberOf(a.target);
  if (!target) throw new HttpError(409, 'Üye artık ekipte değil.');
  if (req.kind === 'stop') {
    manager.stop(target.id);
    return `${target.name} kapatıldı; gerekirse kaldığı yerden yeniden açılabilir.`;
  }
  if (req.kind === 'remove') {
    manager.stop(target.id);
    target.removed = true;
    store.saveGroups(groups);
    return `${target.name} ekipten çıkarıldı; ona artık görev verme, açık işleri varsa başka üyeye devret.`;
  }
  if (req.kind === 'account') {
    const r = switchAccount(target.id, a.accountId);
    return `${target.name} artık ${a.accountId} hesabında${r.restarted ? '; kaldığı yerden yeniden açılıyor' : ''}.`;
  }
  if (req.kind === 'caps') {
    applyCaps(target, a.on || [], a.off || []);
    store.saveGroups(groups);
    if (!manager.has(target.id)) return `${target.name} yetenekleri değişti; sonraki açılışta geçerli.`;
    pending.add(target.id, group.id, { caps: 'yetenekler' }, 'sef');
    return `${target.name} yetenekleri değişti; boşta kalınca kaldığı yerden açılacak, skill listesi bir sonraki compact ya da yenilemede güncellenir.`;
  }
  if (req.kind === 'settings') {
    const r = changeSettings(target.id, { ...(a.model ? { model: a.model } : {}), ...(a.effort ? { effort: a.effort } : {}) }, 'sef');
    return `${target.name} ayarı değişti${r.pending ? '; boşta kalınca kaldığı yerden yeni ayarla açılacak' : r.running ? '' : '; sonraki açılışta geçerli'}.`;
  }
  throw new HttpError(400, 'Bilinmeyen istek türü.');
}

route('POST', '/api/requests/(\\d+)/(approve|reject)', async (req, m) => {
  const body = await readBody(req);
  const r = requests.get(m[1]);
  if (!r) throw new HttpError(404, 'İstek bulunamadı.');
  if (r.status !== 'pending') throw new HttpError(409, 'İstek zaten karara bağlandı.');
  const g = store.loadGroups().find((x) => x.id === r.groupId);
  const what = `#${r.id} (${KIND_TEXT[r.kind]}: ${g ? describeRequest(g, r, settings.roles, settings.accounts) : '?'})`;
  if (m[2] === 'reject') {
    const note = cleanText(body.note, 500);
    requests.decide(r.id, 'rejected', note);
    requests.notify(r.by, `${what} kullanıcı tarafından reddedildi${note ? `: ${note}` : '.'}`);
    return { ok: true };
  }
  let result;
  try {
    result = execRequest(r);
  } catch (err) {
    requests.decide(r.id, 'failed', err.message);
    requests.notify(r.by, `${what} onaylandı ama uygulanamadı: ${err.message}`);
    throw err;
  }
  requests.decide(r.id, 'approved', result);
  requests.notify(r.by, `${what} onaylandı: ${result}`);
  return { ok: true, result };
});

// ---------- proje dokümanları ve hatırlatma ----------

function docProject(pid) {
  const p = store.loadProjects().find((x) => x.id === pid);
  if (!p) throw new HttpError(404, 'Proje bulunamadı.');
  return p;
}

function docCall(fn) {
  try {
    return fn();
  } catch (err) {
    throw new HttpError(err.status || 500, err.message);
  }
}

route('GET', '/api/projects/([\\w-]+)/docs', async (req, m) => docCall(() => listDocs(docProject(m[1]))));

route('GET', '/api/projects/([\\w-]+)/doc', async (req, m) => {
  const rel = new URL(req.url, 'http://x').searchParams.get('path');
  const d = docCall(() => readDoc(docProject(m[1]), rel));
  return { path: d.path, size: d.size, mtime: d.mtime, text: d.text };
});

route('GET', '/api/projects/([\\w-]+)/docs/search', async (req, m) => {
  const q = new URL(req.url, 'http://x').searchParams.get('q');
  return docCall(() => searchDocs(docProject(m[1]), q));
});

route('PUT', '/api/projects/([\\w-]+)/doc-refs', async (req, m) => {
  const body = await readBody(req);
  const projects = store.loadProjects();
  const p = projects.find((x) => x.id === m[1]);
  if (!p) throw new HttpError(404, 'Proje bulunamadı.');
  const refs = docCall(() => [...new Set((Array.isArray(body.refs) ? body.refs : []).map((r) => cleanRef(p, r)).filter(Boolean))]);
  if (refs.length > 20) throw new HttpError(400, 'En fazla 20 kaynak eklenebilir.');
  p.docRefs = refs;
  store.saveProjects(projects);
  return listDocs(p);
});

const REMIND_MAX = 12000;
// Kod bloğu içeriği ``` içeriyorsa daha uzun bir çit kullanılır.
const fence = (t) => (t.includes('```') ? '````' : '```');

// Kullanıcının seçtiği notu ya da dokümanı (tamamı, satır aralığı ya da seçili metin) belirli üyelere hatırlatır.
route('POST', '/api/groups/([\\w-]+)/remind', async (req, m) => {
  const g = boardGroup(m[1]);
  const body = await readBody(req, 2_000_000);
  const live = g.sessions.filter((s) => !s.removed).map((s) => s.id);
  const to = [...new Set((Array.isArray(body.to) ? body.to : []).filter((sid) => live.includes(sid)))];
  if (!to.length) throw new HttpError(400, 'Hatırlatılacak üye seç.');
  const src = body.source || {};
  let label, text, abs = null;
  if (src.type === 'doc') {
    const project = docProject(g.projectId);
    const d = docCall(() => readDoc(project, src.path));
    label = `proje dokümanı ${d.path}`;
    text = d.text;
    abs = d.abs;
  } else if (src.type === 'note') {
    const note = notes.load(g.id).notes.find((x) => x.id === Number(src.id));
    if (!note) throw new HttpError(404, 'Not bulunamadı.');
    label = `grup notu #${note.id} "${note.title}"`;
    text = note.body || '';
  } else throw new HttpError(400, 'Kaynak türü doc ya da note olmalı.');

  let content = null, hint = null;
  const mode = body.mode;
  if (mode === 'lines') {
    const lines = text.split(/\r?\n/);
    const a = Math.max(1, Math.min(lines.length, Number(body.from) || 1));
    const b = Math.max(a, Math.min(lines.length, Number(body.to_line) || a));
    label += `, satır ${a}${b > a ? `–${b}` : ''}`;
    content = lines.slice(a - 1, b).join('\n');
  } else if (mode === 'text') {
    content = String(body.text || '').trim();
    if (!content) throw new HttpError(400, 'Seçili metin boş.');
    label += ', seçili kısım';
  } else if (abs && text.length > 6000) {
    // Uzun doküman terminale yapıştırılmaz; üye dosyayı kendisi okur. Başlıklar yön göstersin diye eklenir.
    const heads = text.split(/\r?\n/).map((l, i) => [l, i + 1]).filter(([l]) => /^#{1,3}\s/.test(l)).slice(0, 40);
    hint = [`Dosyanın tamamını Read ile oku: ${abs}`, ...(heads.length ? ['Başlıklar:', ...heads.map(([l, n]) => `  ${n}: ${l.trim()}`)] : [])].join('\n');
  } else content = text;
  if (content && content.length > REMIND_MAX) content = `${content.slice(0, REMIND_MAX)}\n… (kısaltıldı; tamamı için kaynağa bak)`;
  const note = cleanText(body.note, 2000);
  const f = content ? fence(content) : '';
  const msg = [
    '[Claude Panel · Hatırlatma] Kullanıcı sana şunu hatırlatıyor.',
    `Kaynak: ${label}`,
    note ? `Kullanıcının notu: ${note}` : '',
    content ? `${f}\n${content}\n${f}` : hint,
    'Bunu şu anki işinde dikkate al.',
  ].filter(Boolean).join('\n');
  notes.remind(g, to, msg);
  return { ok: true, to: to.length, chars: msg.length };
});

// Grup notları. Her notta alıcılar ve kime iletildiği / kimde beklediği de döner.
function notesView(g) {
  const n = notes.load(g.id);
  // Geçmiş büyük olabilir; ayrı uçtan alınır.
  return n.notes.map(({ history, ...x }) => ({
    ...x, historyCount: (history || []).length, waiting: Object.keys(n.pending).filter((sid) => n.pending[sid].some((p) => p.id === x.id)),
  }));
}

function noteCall(fn) {
  try {
    return fn();
  } catch (err) {
    throw new HttpError(err.status || 500, err.message);
  }
}

route('GET', '/api/groups/([\\w-]+)/notes', async (req, m) => ({ notes: notesView(boardGroup(m[1])) }));

route('POST', '/api/groups/([\\w-]+)/notes', async (req, m) => {
  const g = boardGroup(m[1]);
  const body = await readBody(req);
  const live = g.sessions.filter((s) => !s.removed).map((s) => s.id);
  const to = Array.isArray(body.to) ? body.to.filter((sid) => live.includes(sid)) : undefined;
  noteCall(() => notes.create(g, { title: body.title, body: body.body, to }, 'user'));
  return { notes: notesView(g) };
});

route('PUT', '/api/groups/([\\w-]+)/notes/(\\d+)', async (req, m) => {
  const g = boardGroup(m[1]);
  const body = await readBody(req);
  noteCall(() => notes.update(g, m[2], { title: body.title, body: body.body, expect: body.expect }, 'user'));
  return { notes: notesView(g) };
});

route('GET', '/api/groups/([\\w-]+)/notes/(\\d+)/history', async (req, m) => {
  const g = boardGroup(m[1]);
  const note = notes.load(g.id).notes.find((x) => x.id === Number(m[2]));
  if (!note) throw new HttpError(404, 'Not bulunamadı.');
  return { history: (note.history || []).map((h, i) => ({ ...h, index: i })).reverse() };
});

route('POST', '/api/groups/([\\w-]+)/notes/(\\d+)/restore', async (req, m) => {
  const g = boardGroup(m[1]);
  const body = await readBody(req);
  noteCall(() => notes.restore(g, m[2], body.index));
  return { notes: notesView(g) };
});

route('POST', '/api/groups/([\\w-]+)/notes/(\\d+)/unarchive', async (req, m) => {
  const g = boardGroup(m[1]);
  noteCall(() => notes.unarchive(g, m[2]));
  return { notes: notesView(g) };
});

route('GET', '/api/groups/([\\w-]+)/curator', async (req, m) => curator.status(boardGroup(m[1]).id));

route('POST', '/api/groups/([\\w-]+)/curator/run', async (req, m) => {
  const g = boardGroup(m[1]);
  if (curator.status(g.id).running) throw new HttpError(409, 'Not düzenleyici bu grupta zaten çalışıyor.');
  const body = await readBody(req).catch(() => ({}));
  curator.run(g, true, CURATOR_LEVELS.includes(body && body.level) ? body.level : null).catch((err) => console.error('[panel] not düzenleyici:', err.message));
  return curator.status(g.id);
});

route('DELETE', '/api/groups/([\\w-]+)/notes/(\\d+)', async (req, m) => {
  const g = boardGroup(m[1]);
  noteCall(() => notes.remove(g, m[2], 'user'));
  return { notes: notesView(g) };
});

route('POST', '/api/groups/([\\w-]+)/stop', async (req, m) => {
  const groups = store.loadGroups();
  const g = groups.find((x) => x.id === m[1]);
  if (!g) throw new HttpError(404, 'Grup bulunamadı.');
  // Şefin son mesajı kapanış özeti olarak saklanır (grup sonra devam ettirilse bile bu an kalır).
  const lead = g.sessions.find((s) => s.roleId === 'sef' && !s.removed) || g.sessions[0];
  const st = lead && sessionStats(discovery.transcriptPath(sharedConfigDir(), lead.id));
  if (st && (st.lastSummary || st.lastText)) {
    g.closing = { at: Date.now(), by: lead.name, text: st.lastSummary || st.lastText };
    store.saveGroups(groups);
  }
  for (const s of g.sessions) manager.stop(s.id);
  return { ok: true };
});

route('POST', '/api/groups/([\\w-]+)/ask-summary', async (req, m) => {
  const g = store.loadGroups().find((x) => x.id === m[1]);
  if (!g) throw new HttpError(404, 'Grup bulunamadı.');
  const lead = runningLead(g);
  if (!lead) throw new HttpError(409, 'Grupta çalışan oturum yok.');
  pasteTo(lead, [
    '[Claude Panel] Kullanıcı grubu kapatmaya hazırlanıyor.',
    'Gerekirse ekipten son durumu al, sonra bu terminalde "KAPANIŞ ÖZETİ" başlığıyla kısa bir özet yaz:',
    'yapılanlar, değişen dosyalar, test / doğrulama sonuçları, açık kalanlar, sıradaki adım önerisi.',
    'Özet bu grubun kapanış kaydına eklenecek; özetten sonra başka bir şey yazma.',
  ].join('\n'));
  return { ok: true, to: lead.name };
});

route('GET', '/api/templates', async () => store.loadTemplates());

// Kurulum optimizasyonu: formdaki ekibi grup açılmadan tek model çağrısıyla gözden geçirir; sonuç forma öneri olarak döner.
const CAP_KIND_TEXT = {
  plugin: 'eklenti', skill: 'skill (hesapta kurulu)', mcp: 'mcp', bundled: 'skill (Claude Code yerleşik)', synced: 'skill (claude.ai)', project: 'skill (proje klasöründe)',
};

route('POST', '/api/setup/optimize', async (req) => {
  const body = await readBody(req);
  const project = store.loadProjects().find((p) => p.id === body.projectId);
  if (!project) throw new HttpError(404, 'Proje bulunamadı.');
  if (!isAllowedDir(project.path)) throw new HttpError(403, 'Proje klasörü izinli klasörlerin dışında.');
  const raw = Array.isArray(body.rows) ? body.rows.slice(0, 12) : [];
  if (!raw.length) throw new HttpError(400, 'Optimize edilecek satır yok.');
  const quota = await cachedQuota().catch(() => quotaMemo);
  const account = helper.pickAccount(settings.accounts, quota);
  if (!account) throw new HttpError(409, 'Kotası olan hesap yok.');

  const inventory = caps.inventory(settings.accounts).filter((x) => x.kind !== 'project' || (x.projects || []).includes(project.path));
  const c = caps.load();
  const catalog = [
    ...inventory.map((x) => ({
      key: x.key, tur: CAP_KIND_TEXT[x.kind] || x.kind, ad: x.name, aciklama: String(x.description || '').slice(0, 160),
      ...(x.chars ? { tahmini_token: Math.round(x.chars / 3) } : {}),
      ...(x.skills ? { skilleri: x.skills } : {}),
      ...(x.hooks ? { kancasi_var: true } : {}),
    })),
    ...c.mcps.map((m) => ({ key: `pmcp:${m.id}`, tur: 'mcp (panel)', ad: m.name, aciklama: m.url || [m.command, ...(m.args || [])].join(' ') })),
    ...c.skills.map((k) => ({ key: `pskill:${k.name}`, tur: 'skill (panel)', ad: k.name, aciklama: String(k.description || '').slice(0, 160) })),
  ];
  const rows = raw.map((r) => {
    const role = settings.roles.find((x) => x.id === r.roleId);
    const custom = r.roleId === 'custom';
    const base = caps.roleKeys(custom ? 'custom' : r.roleId, inventory);
    const ov = r.caps || {};
    const on = new Set([...base, ...(ov.on || [])]);
    for (const k of ov.off || []) on.delete(k);
    return {
      key: cleanText(r.key, 20), roleId: custom ? 'custom' : role ? role.id : '', label: custom ? cleanText(r.customLabel, 40) : role ? role.label : '?',
      model: MODELS.includes(r.model) ? r.model : '', effort: EFFORTS.includes(r.effort) ? r.effort : '', permissionMode: PERMISSION_MODES.includes(r.permissionMode) ? r.permissionMode : '',
      talkAll: !!r.talkAll, reportsTo: Array.isArray(r.reportsTo) ? r.reportsTo.map(String) : [],
      prompt: custom ? String(r.customPrompt || '') : typeof r.prompt === 'string' && r.prompt.trim() ? r.prompt : (role && role.prompt) || '',
      manualPrompt: custom ? !!String(r.customPrompt || '').trim() : !!r.promptManual, caps: [...on], accountId: cleanText(r.accountId, 12),
    };
  });

  const groups = store.loadGroups().filter((g) => g.projectId === project.id).sort((a, b) => a.createdAt - b.createdAt);
  const stats = (sid) => sessionStats(discovery.transcriptPath(sharedConfigDir(), sid));
  const last = groups[groups.length - 1];
  let recent = null;
  if (last) {
    const n = notes.load(last.id).notes.filter((x) => !x.archived);
    const cards = boards.load(last.id).cards;
    recent = {
      grup: last.name,
      not_basliklari: n.slice(-40).map((x) => x.title),
      kartlar: cards.slice(-30).map((k) => `#${k.id} [${k.status}] ${k.title}`),
    };
  }
  const payload = {
    proje: optimizer.projectSummary(project.path),
    kullanici_notu: String(body.goal || '').trim() || null,
    grup_varsayilan_izin: PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : 'manual',
    rol_katalogu: settings.roles.map((r) => ({ id: r.id, ad: r.label, varsayilan_model: r.model || '', varsayilan_effort: r.effort || '', gorev: String(r.prompt || '').split('\n')[0].slice(0, 200) })),
    yetenekler: catalog,
    gecmis_harcama: optimizer.history(groups, stats),
    son_grup: recent,
    satirlar: rows.map((r) => ({
      key: r.key, rol: r.roleId, rol_adi: r.label, model: r.model, effort: r.effort, izin: r.permissionMode, herkesle: r.talkAll, rapor_verir: r.reportsTo,
      talimat: r.prompt, elle_yazildi: r.manualPrompt, yetenekler: r.caps,
    })),
  };
  const res = await optimizer.ask(account, payload, 'sonnet', project.path).catch((err) => { throw new HttpError(502, `Kurulum danışmanı: ${err.message}`); });
  const out = optimizer.validate(rows, res.parsed, catalog.map((x) => x.key), settings.roles.map((r) => r.id));
  // Eklenen satır modeli belirtilmemişse rolün varsayılanını alır; hesap aşağıda kotaya göre seçilir.
  for (const a of out.adds) {
    const role = settings.roles.find((r) => r.id === a.roleId);
    if (a.model === undefined) a.model = (role && role.model) || '';
    if (a.permissionMode === undefined) a.permissionMode = (role && role.permissionMode) || '';
    a.accountId = (rows.find((r) => r.roleId === 'sef') || rows[0]).accountId;
  }
  // Hesaplar modelin önerdiği modellerle birlikte kotaya göre dağıtılır (çıkarılanlar hariç, eklenenler dahil).
  const gone = new Set(out.removes.map((x) => x.key));
  const after = [
    ...rows.filter((r) => !gone.has(r.key)).map((r) => ({ ...r, model: (out.patches[r.key] || {}).model ?? r.model })),
    ...out.adds,
  ];
  for (const [key, a] of Object.entries(optimizer.assignAccounts(after, settings.accounts, quota))) {
    const add = out.adds.find((x) => x.key === key);
    if (add) {
      add.accountId = a.accountId;
      continue;
    }
    const p = out.patches[key] || (out.patches[key] = { why: {} });
    p.accountId = a.accountId;
    p.why.accountId = a.why;
  }
  return { ...out, account: res.account, costUSD: res.costUSD, turns: res.turns };
});

route('POST', '/api/templates', async (req) => {
  const body = await readBody(req);
  const name = cleanText(body.name, 60);
  if (!name) throw new HttpError(400, 'Şablon adı gerekli.');
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 12) : [];
  if (!rows.length) throw new HttpError(400, 'Şablonda en az bir satır olmalı.');
  const scope = body.scope === 'global' ? 'global' : String(body.scope || '');
  if (scope !== 'global' && !store.loadProjects().some((p) => p.id === scope)) throw new HttpError(400, 'Şablon kapsamı geçersiz.');
  const templates = store.loadTemplates();
  const tpl = {
    id: crypto.randomUUID(),
    name,
    scope,
    createdAt: Date.now(),
    permissionMode: PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : 'manual',
    rows: rows.map((r) => ({
      key: cleanText(r.key, 20),
      roleId: cleanText(r.roleId, 24),
      customLabel: cleanText(r.customLabel, 40),
      customPrompt: String(r.customPrompt || ''),
      ...(typeof r.prompt === 'string' && r.prompt.trim() ? { prompt: r.prompt.trim() } : {}),
      ...(capsOverride(r.caps) ? { caps: capsOverride(r.caps) } : {}),
      accountId: cleanText(r.accountId, 12),
      model: MODELS.includes(r.model) ? r.model : '',
      effort: EFFORTS.includes(r.effort) ? r.effort : '',
      permissionMode: PERMISSION_MODES.includes(r.permissionMode) ? r.permissionMode : '',
      talkAll: !!r.talkAll,
      reportsTo: Array.isArray(r.reportsTo) ? r.reportsTo.map((k) => cleanText(k, 20)) : [],
    })),
  };
  templates.push(tpl);
  store.saveTemplates(templates);
  return tpl;
});

route('PUT', '/api/templates/([\\w-]+)', async (req, m) => {
  const body = await readBody(req);
  const templates = store.loadTemplates();
  const t = templates.find((x) => x.id === m[1]);
  if (!t) throw new HttpError(404, 'Şablon bulunamadı.');
  if (body.name != null) t.name = cleanText(body.name, 60) || t.name;
  if (body.scope != null) t.scope = body.scope === 'global' ? 'global' : String(body.scope);
  store.saveTemplates(templates);
  return t;
});

route('DELETE', '/api/templates/([\\w-]+)', async (req, m) => {
  store.saveTemplates(store.loadTemplates().filter((t) => t.id !== m[1]));
  return { ok: true };
});

route('POST', '/api/autostart', async (req) => {
  const body = await readBody(req);
  setAutostart(!!body.enabled);
  return { autostart: fs.existsSync(STARTUP_LINK) };
});

route('POST', '/api/shutdown', async () => {
  setTimeout(shutdown, 200);
  return { ok: true };
});

// Grubu kapatma: oturumlar durdurulur, istenirse not düzenleyici kapanış özetini yazar ve notlar, pano ve özet proje
// klasörüne Markdown olarak aktarılır; en son grup arşivlenir. Bir adım hata verirse grup kapanmaz, notlar yerinde kalır.
// İş arka planda sürer; arayüz durumu GET ile izler.
const closeJobs = new Map();

function closeJobView(gid) {
  const j = closeJobs.get(gid);
  return j ? { ...j } : { state: 'none', defaultDir: exporter.defaultDir(boardGroup(gid)) };
}

async function runClose(gid, opts) {
  const job = { state: 'running', step: 'Oturumlar durduruluyor', startedAt: Date.now(), export: opts.export, summary: opts.summary };
  closeJobs.set(gid, job);
  try {
    let g = boardGroup(gid);
    for (const s of g.sessions) manager.stop(s.id);
    if (opts.export) {
      const project = store.loadProjects().find((p) => p.id === g.projectId);
      if (!project) throw new HttpError(404, 'Proje bulunamadı.');
      if (!isAllowedDir(project.path)) throw new HttpError(403, 'Proje klasörü izinli klasörlerin dışında.');
      let summary = null;
      if (opts.summary) {
        job.step = 'Kapanış özeti yazılıyor (not düzenleyici notları ve panoyu okuyor; birkaç dakika sürebilir)';
        try {
          const r = await curator.handoff(g);
          summary = r.text;
          job.costUSD = r.costUSD;
        } catch (err) {
          // Özetsiz devam etmek kullanıcının kararı: iş durur, arayüz "özetsiz aktar" seçeneğini sunar.
          Object.assign(job, { state: 'failed', step: null, error: `Kapanış özeti yazılamadı: ${err.message}`, canSkipSummary: true });
          return;
        }
      }
      job.step = 'Dosyalar yazılıyor';
      g = boardGroup(gid);
      const out = exporter.exportGroup({
        projectPath: project.path, rel: opts.dir, group: g, notes: notes.load(gid).notes, cards: boards.load(gid).cards,
        summary, actor: (id) => actorLabel(g, id), statusText: STATUS_TEXT,
      });
      job.dir = out.dir;
      job.files = out.files.length;
      // Dışa aktarılan klasör projenin doküman kaynaklarına eklenir; sonraki gruplar Notlar ekranından okuyabilir.
      const projects = store.loadProjects();
      const p = projects.find((x) => x.id === project.id);
      const top = out.rel.split('/')[0];
      const refs = p.docRefs || [];
      if (!refs.some((r) => r === '.' || r === top || out.rel === r || out.rel.startsWith(`${r}/`)) && refs.length < 20) {
        p.docRefs = [...refs, top];
        store.saveProjects(projects);
        job.docRef = top;
      }
    }
    const groups = store.loadGroups();
    const gg = groups.find((x) => x.id === gid);
    gg.archived = true;
    gg.closedAt = Date.now();
    if (job.dir) gg.exportDir = job.dir;
    store.saveGroups(groups);
    Object.assign(job, { state: 'done', step: null, finishedAt: Date.now() });
    pushEvent(job.dir ? `Grup kapatıldı; notlar ${job.dir} klasörüne aktarıldı.` : 'Grup kapatıldı.', 'notlar', gid);
  } catch (err) {
    Object.assign(job, { state: 'failed', step: null, error: err.message });
  }
}

route('GET', '/api/groups/([\\w-]+)/close', async (req, m) => closeJobView(m[1]));

route('POST', '/api/groups/([\\w-]+)/close', async (req, m) => {
  const g = boardGroup(m[1]);
  const body = await readBody(req);
  const cur = closeJobs.get(g.id);
  if (cur && cur.state === 'running') throw new HttpError(409, 'Grup zaten kapatılıyor.');
  if (g.archived) throw new HttpError(409, 'Grup zaten kapalı.');
  const opts = { export: body.export !== false, summary: body.export !== false && body.summary !== false, dir: body.dir ? String(body.dir).slice(0, 300) : null };
  runClose(g.id, opts).catch((err) => console.error('[panel] grup kapatma:', err.message));
  return closeJobView(g.id);
});

route('POST', '/api/groups/([\\w-]+)/archive', async (req, m) => {
  const body = await readBody(req);
  const groups = store.loadGroups();
  const g = groups.find((x) => x.id === m[1]);
  if (!g) throw new HttpError(404, 'Grup bulunamadı.');
  if (g.sessions.some((s) => manager.has(s.id))) throw new HttpError(409, 'Önce gruptaki oturumları sonlandır.');
  g.archived = body.archived !== false;
  store.saveGroups(groups);
  return { ok: true };
});

route('POST', '/api/sessions/([\\w-]+)/(stop|start|restart|open-pc|remove|restore)', async (req, m) => {
  const groups = store.loadGroups();
  const found = findSession(groups, m[1]);
  if (!found) throw new HttpError(404, 'Oturum bulunamadı.');
  const { group, session } = found;
  const action = m[2];
  if (action === 'remove' || action === 'restore') {
    // Gruptan çıkarma kaydı silmez; oturum kapatılır ve listede "çıkarıldı" olarak kalır.
    if (action === 'remove') manager.stop(session.id);
    if (action === 'restore' && session.removed) {
      // Yenilenen oturumun yerini yenisi aldı; geri eklenirse aynı adla iki üye olur.
      if (session.renewedTo) throw new HttpError(409, 'Bu oturum yenilendi; yerine açılan oturum ekipte.');
      if (group.sessions.filter((s) => !s.removed).length >= 12) throw new HttpError(400, 'Bir grupta en fazla 12 oturum olabilir.');
    }
    session.removed = action === 'remove';
    store.saveGroups(groups);
    // Diğer üyeler ayrılan üyeyi kendiliğinden bilmez; ekibi yöneten üyeye panel bildirir.
    let notified = null;
    const body = await readBody(req);
    if (action === 'remove' && body.notify !== false) {
      const lead = runningLead(group, session.id);
      if (lead && pasteTo(lead, `[Claude Panel] ${session.name} (${session.roleLabel}) kullanıcı tarafından ekipten çıkarıldı. Ona artık görev verme ve mesaj gönderme; açık işleri varsa başka bir üyeye devret.`)) {
        notified = lead.name;
      }
    }
    return { ok: true, notified };
  }
  if (session.removed) throw new HttpError(409, 'Oturum gruptan çıkarılmış; önce geri ekle.');
  if (action === 'stop') {
    manager.stop(session.id);
  } else if (action === 'start') {
    if (!manager.has(session.id)) launchSession(group, session, { resume: true });
  } else if (action === 'restart') {
    manager.stop(session.id);
    whenStopped(session.id, (err) => {
      if (err) return console.error(`[panel] ${session.name}:`, err.message);
      try { launchSession(group, session, { resume: true }); } catch (e) { console.error(`[panel] ${session.name}:`, e.message); }
    });
  } else if (action === 'open-pc') {
    if (!manager.has(session.id)) throw new HttpError(409, 'Oturum çalışmıyor.');
    openInWindowsTerminal(session);
  }
  return { ok: true };
});

// Oturumun hesabını değiştirir: çalışıyorsa kapatılır, yeni hesapla kaldığı yerden açılır.
// Konuşma dosyaları hesaplar arasında ortak olduğu için --resume diğer hesapta da çalışır.
// Oturum adı değişmez; ekipteki diğer üyeler ona bu adla ulaşmaya devam eder.
route('POST', '/api/sessions/([\\w-]+)/account', async (req, m) => {
  const body = await readBody(req);
  return switchAccount(m[1], body.accountId);
});

// Model / effort değişikliği: { model?, effort?, now? }; DELETE bekleyen değişikliği iptal eder.
route('POST', '/api/sessions/([\\w-]+)/settings', async (req, m) => changeSettings(m[1], await readBody(req)));
route('DELETE', '/api/sessions/([\\w-]+)/settings', async (req, m) => cancelSettings(m[1]));

route('GET', '/api/meter', async () => ({ ...meter.snapshot(settings.accounts), ledger: ledger.view() }));
// Bekçi grup başına: g verilirse o grubun bulguları, adayları, kayıtları, işlemleri ve geçerli ayarı.
route('GET', '/api/watch', async (req) => {
  const gid = new URL(req.url, 'http://x').searchParams.get('g');
  const g = gid ? store.loadGroups().find((x) => x.id === gid) : null;
  if (gid && !g) throw new HttpError(404, 'Grup bulunamadı.');
  return {
    ...watch.snapshot(gid),
    ops: ops.list().filter((o) => !gid || o.gid === gid),
    settings: g ? groupWatchCfg(g) : { ...WATCH_DEFAULTS, ...(settings.watch || {}) },
    groupWatch: g ? g.watch || {} : undefined,
  };
});

// Grubun bekçi ayarı (açık, hamleleri kendisi yapsın, kararı Haiku versin); verilmeyenler genel ayardan gelir.
route('PUT', '/api/groups/([\\w-]+)/watch', async (req, m) => {
  const body = await readBody(req);
  const groups = store.loadGroups();
  const g = groups.find((x) => x.id === m[1]);
  if (!g) throw new HttpError(404, 'Grup bulunamadı.');
  const w = { ...(g.watch || {}) };
  for (const key of ['enabled', 'act', 'ai']) if (body[key] != null) w[key] = !!body[key];
  g.watch = w;
  store.saveGroups(groups);
  return { ok: true, watch: groupWatchCfg(g) };
});

// Üye sekmelerinin sürüklenerek sıralanması. body.ids: görünen sıradaki oturum kimlikleri; listede olmayanlar sonda kalır.
route('PUT', '/api/groups/([\\w-]+)/order', async (req, m) => {
  const body = await readBody(req);
  const groups = store.loadGroups();
  const g = groups.find((x) => x.id === m[1]);
  if (!g) throw new HttpError(404, 'Grup bulunamadı.');
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  const rank = new Map(ids.map((id, i) => [id, i]));
  const key = (s, i) => (rank.has(s.id) ? rank.get(s.id) : ids.length + i);
  g.sessions = g.sessions.map((s, i) => ({ s, k: key(s, i) })).sort((a, b) => a.k - b.k).map((x) => x.s);
  store.saveGroups(groups);
  return { ok: true };
});

// Kullanıcının "sıfır context ile yenile" isteği. Çalışan üyeye devir notu yazdırılır (bekçinin yenilemesiyle aynı yol,
// beklemeden). Kapalı üye not yazamaz; aynı ad ve rolle doğrudan sıfırdan açılır. Pano ve notlar grubundadır, kalır.
route('POST', '/api/sessions/([\\w-]+)/renew', async (req, m) => {
  const found = findSession(store.loadGroups(), m[1]);
  if (!found || found.session.removed) throw new HttpError(404, 'Oturum bulunamadı.');
  const { group, session } = found;
  if (!manager.has(session.id)) {
    const sid = renewSession(session.id, [
      'Önceki oturum kapalıyken yenilendi; devir notu yok.',
      'İşe başlamadan pano_listele ile ekibin kartlarına ve sana atananlara, not_listele ile grup notlarına bak. Sonra görev bekle.',
    ].join('\n'), null);
    pushEvent(`${session.name}: kullanıcının isteğiyle sıfır context ile yeniden açıldı (devir notu yok, oturum kapalıydı).`, 'bekci', group.id);
    return { ok: true, sid, handoff: false };
  }
  if (!ops.add({ sid: session.id, gid: group.id, kind: 'renew', accountId: null, why: 'kullanıcı istedi', by: 'kullanıcı', force: true })) {
    throw new HttpError(409, 'Bu üyede süren bir işlem var (devir notu yazıyor ya da yeni oturum açılıyor).');
  }
  watch.note({ gid: group.id, key: `op:${session.id}`, level: 'normal', text: `karar: ${session.name}: kullanıcının isteğiyle devir notu yazdırıp sıfır context ile yeniden açılacak (karar: kullanıcı)` });
  return { ok: true, handoff: true };
});

route('POST', '/api/watch/ops/([\\w-]+)/cancel', async (req, m) => {
  const found = findSession(store.loadGroups(), m[1]);
  const r = ops.cancel(m[1]);
  if (!r.ok) throw new HttpError(409, r.error);
  watch.note({ gid: found ? found.group.id : null, key: `op:${m[1]}`, level: 'normal', text: `iptal: ${found ? found.session.name : m[1]}: kullanıcı işlemi iptal etti; bu üyeye 1 saat hamle önerilmez.` });
  return { ok: true };
});

route('GET', '/api/quota', async (req) => cachedQuota(new URL(req.url, 'http://x').searchParams.has('fresh')));

route('PUT', '/api/settings', async (req) => {
  const body = await readBody(req);
  const next = { ...settings };
  if (Array.isArray(body.allowedDirs)) next.allowedDirs = body.allowedDirs.map((d) => String(d).trim()).filter(Boolean);
  if (body.autoRotate != null) next.autoRotate = !!body.autoRotate;
  if (body.watch && typeof body.watch === 'object') {
    const w = { ...WATCH_DEFAULTS, ...(settings.watch || {}) };
    for (const key of ['enabled', 'act', 'ai']) if (body.watch[key] != null) w[key] = !!body.watch[key];
    const num = (key, lo, hi) => {
      const v = Number(body.watch[key]);
      if (body.watch[key] != null && Number.isFinite(v) && v >= lo && v <= hi) w[key] = Math.round(v);
    };
    num('quotaHalf', 1, 99);
    num('quotaLow', 1, 99);
    num('ctxWarn', 10000, 10000000);
    num('ctxHigh', 10000, 10000000);
    num('errStreak', 2, 50);
    num('stuckMin', 5, 240);
    next.watch = w;
  }
  if (body.curator && typeof body.curator === 'object') {
    const c = { ...CURATOR_DEFAULTS, ...(settings.curator || {}) };
    if (body.curator.enabled != null) c.enabled = !!body.curator.enabled;
    const h = Number(body.curator.everyH);
    if (body.curator.everyH != null && Number.isFinite(h) && h >= 1 && h <= 168) c.everyH = Math.round(h);
    if (MODELS.includes(body.curator.model)) c.model = body.curator.model;
    if (CURATOR_LEVELS.includes(body.curator.level)) c.level = body.curator.level;
    next.curator = c;
  }
  if (body.contextWindows && typeof body.contextWindows === 'object') {
    const cw = {};
    for (const k of MODELS) {
      const v = Number(body.contextWindows[k]);
      cw[k] = v >= 1000 && v <= 100000000 ? Math.round(v) : (settings.contextWindows || {})[k];
    }
    next.contextWindows = cw;
  }
  if (Array.isArray(body.accounts)) {
    next.accounts = body.accounts.map((a) => ({
      id: cleanText(a.id, 12), name: cleanText(a.name, 40), configDir: String(a.configDir || '').trim(), color: cleanText(a.color, 12) || 'blue',
    })).filter((a) => a.id && a.configDir);
    if (!next.accounts.length) throw new HttpError(400, 'En az bir hesap gerekli.');
  }
  if (Array.isArray(body.roles)) {
    next.roles = body.roles.map((r) => ({
      id: cleanText(r.id, 24),
      label: cleanText(r.label, 40),
      short: cleanText(r.short, 24),
      prompt: String(r.prompt || '').slice(0, 4000),
      permissionMode: PERMISSION_MODES.includes(r.permissionMode) ? r.permissionMode : '',
      model: MODELS.includes(r.model) ? r.model : '',
      readOnly: !!r.readOnly,
      effort: EFFORTS.includes(r.effort) ? r.effort : '',
      // Bağlam profili (token); boşsa rolün varsayılanı ya da genel ayar kullanılır.
      ctxWarn: Number(r.ctxWarn) >= 20000 && Number(r.ctxWarn) <= 10000000 ? Math.round(Number(r.ctxWarn)) : null,
      ctxHigh: Number(r.ctxHigh) >= 20000 && Number(r.ctxHigh) <= 10000000 ? Math.round(Number(r.ctxHigh)) : null,
    })).filter((r) => r.id && r.label && r.id !== 'custom');
  }
  if (body.port != null) {
    const port = Number(body.port);
    if (!(port >= 1024 && port <= 65535)) throw new HttpError(400, 'Port 1024–65535 arasında olmalı.');
    next.port = port;
  }
  settings = next;
  store.saveSettings(settings);
  if (Array.isArray(body.roles)) caps.pruneRoles(settings.roles.map((r) => r.id));
  return { settings, restartNeeded: body.port != null && Number(body.port) !== PORT };
});

// ---------- yetenekler (MCP / skill) ----------

function capCall(fn) {
  try {
    return fn();
  } catch (err) {
    throw new HttpError(err.status || 500, err.message);
  }
}

// Ham gövde (zip yükleme); JSON değil.
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, `Dosya en fazla ${Math.round(max / 1_000_000)} MB olabilir.`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function capsState() {
  return { ...caps.load(), inventory: caps.inventory(settings.accounts).map(({ config, ...x }) => x) };
}

function globalMcpNames() {
  return caps.inventory(settings.accounts).filter((x) => x.kind === 'mcp').map((x) => x.name);
}

route('GET', '/api/caps', async () => capsState());

route('POST', '/api/caps/mcp', async (req) => {
  const body = await readBody(req);
  capCall(() => caps.addMcp(body, globalMcpNames()));
  return capsState();
});

route('PUT', '/api/caps/mcp/([\\w-]+)', async (req, m) => {
  const body = await readBody(req);
  capCall(() => caps.updateMcp(m[1], body, globalMcpNames()));
  return capsState();
});

route('DELETE', '/api/caps/mcp/([\\w-]+)', async (req, m) => {
  capCall(() => caps.removeMcp(m[1]));
  return capsState();
});

// Kaydetmeden önce ya da kayıtlı bir MCP'yi (panel ya da hesaptaki) dener; tool adlarını döndürür.
route('POST', '/api/caps/test', async (req) => {
  const body = await readBody(req);
  let cfg = body.config;
  if (body.id) cfg = caps.load().mcps.find((x) => x.id === body.id);
  else if (body.key) cfg = (caps.inventory(settings.accounts).find((x) => x.key === body.key) || {}).config;
  if (!cfg) throw new HttpError(404, 'MCP bulunamadı.');
  return testMcp(cfg);
});

route('GET', '/api/caps/skill/([a-z0-9-]+)', async (req, m) => capCall(() => caps.readSkill(m[1])));

route('POST', '/api/caps/skill', async (req) => {
  const body = await readBody(req);
  capCall(() => {
    if (body.mode === 'dir') return caps.importDir(path.resolve(String(body.path || '').trim()), body.name);
    if (body.mode === 'raw') return caps.writeRaw(String(body.name || ''), String(body.text || '').slice(0, 200000));
    return caps.writeSkill({ name: body.name, description: body.description, body: body.body, replace: !!body.replace });
  });
  return capsState();
});

route('POST', '/api/caps/skill-zip', async (req) => {
  const url = new URL(req.url, 'http://x');
  const buf = await readRaw(req, 20_000_000);
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new HttpError(400, 'Bu bir zip dosyası değil.');
  try {
    await caps.importZip(buf, url.searchParams.get('name') || '');
  } catch (err) {
    throw new HttpError(err.status || 500, err.message);
  }
  return capsState();
});

route('DELETE', '/api/caps/skill/([a-z0-9-]+)', async (req, m) => {
  capCall(() => caps.removeSkill(m[1]));
  return capsState();
});

route('PUT', '/api/caps/role', async (req) => {
  const body = await readBody(req);
  if (!settings.roles.some((r) => r.id === body.roleId)) throw new HttpError(400, 'Rol bulunamadı.');
  // keys: bir gruptaki tüm yetenekler tek istekte (ör. yerleşik skill'lerin hepsi bu rolde kapalı).
  const keys = Array.isArray(body.keys) ? body.keys.slice(0, 200) : [body.key];
  for (const k of keys) capCall(() => caps.setRole(k, body.roleId, !!body.on));
  return capsState();
});

route('POST', '/api/token/rotate', async () => {
  token = store.rotateToken();
  return { token };
});

// ---------- sunucu ----------

const server = http.createServer(async (req, res) => {
  if (!allowedHosts().includes(req.headers.host)) {
    res.writeHead(421);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [rel, type] = STATIC[url.pathname];
    try {
      const data = fs.readFileSync(path.join(ROOT, rel));
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return res.end(data);
    } catch {
      res.writeHead(404);
      return res.end();
    }
  }

  if (!url.pathname.startsWith('/api/')) {
    res.writeHead(404);
    return res.end();
  }
  // Oturumların hook bildirimleri: kendi anahtarıyla gelir. Boş 2xx yanıt Claude'un akışını değiştirmez.
  if (url.pathname === '/api/hook' && req.method === 'POST') {
    if (!hookState.tokenOk(req.headers['x-panel-hook-token'])) return sendJson(res, 401, { error: 'Hook anahtarı geçersiz.' });
    try {
      // PostToolUse büyük tool çıktısını da taşır; reddedilirse oturumun terminalinde hook hatası görünür.
      const body = await readBody(req, 64_000_000);
      if (process.env.CLAUDE_PANEL_HOOK_DEBUG) console.log('[hook]', Date.now(), JSON.stringify({ ...body, tool_response: undefined, last_assistant_message: undefined, transcript_path: undefined, cwd: undefined, scratchpad_dir: undefined, session_id: undefined }).slice(0, 500));
      if (manager.has(body.session_id)) {
        hookState.handle(body);
        if (body.hook_event_name === 'UserPromptSubmit') {
          const found = findSession(store.loadGroups(), body.session_id);
          if (found) presence.prompt(body.session_id, body.prompt, manager.get(body.session_id), { name: found.session.name, group: found.group.name, role: found.session.roleLabel, gid: found.group.id, roleId: found.session.roleId });
        }
        const out = boardDelivery(body);
        if (out) return sendJson(res, 200, out);
      }
    } catch (err) {
      console.error('[panel] hook:', err.message);
    }
    res.writeHead(204);
    return res.end();
  }
  // Ekip üyelerinin görev panosu tool'ları (MCP, yalnızca JSON yanıtlı Streamable HTTP).
  const mcp = url.pathname.match(/^\/api\/mcp\/([\w-]+)$/);
  if (mcp) {
    if (!hookState.tokenOk(req.headers['x-panel-hook-token'])) return sendJson(res, 401, { error: 'Hook anahtarı geçersiz.' });
    // Sunucudan istemciye ayrı bir olay akışı yok.
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      return res.end();
    }
    try {
      const msg = await readBody(req);
      // Not düzenleyicinin adresi: curator-<grup>; yalnızca not tool'ları.
      const cur = mcp[1].match(/^curator-([\w-]+)$/);
      if (cur) {
        const g = store.loadGroups().find((x) => x.id === cur[1]);
        if (!g) return sendJson(res, 404, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32001, message: 'Grup bulunamadı.' } });
        const reply = await handleMcp(boards, g, CURATOR, msg, { tools: CURATOR_TOOLS, only: true, call: async (name, args) => callCuratorTool(notes, g, name, args) });
        if (!reply) {
          res.writeHead(202);
          return res.end();
        }
        return sendJson(res, 200, reply);
      }
      const found = findSession(store.loadGroups(), mcp[1]);
      if (!found) return sendJson(res, 404, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32001, message: 'Oturum bir panel grubunda değil.' } });
      const isLead = found.session.roleId === 'sef';
      const ctx = {
        group: found.group, sid: mcp[1], isLead, requests, roles: settings.roles, accounts: settings.accounts, models: MODELS, resolveMember,
        memberRows: () => memberRows(found.group), quota: () => cachedQuota(), roleCaps, meterRate: (id, kind) => meter.rate(id, kind),
        capCatalog: () => capCatalogFor(found.group),
      };
      const reply = await handleMcp(boards, found.group, mcp[1], msg, {
        tools: [...NOTE_TOOLS, DOC_TOOL, TOOL_STATUS, DEVIR_TOOL, ...(isLead ? [...LEAD_TOOLS, ...NOTE_LEAD_TOOLS] : [])],
        call: async (name, args) => {
          if (name === DEVIR_TOOL.name) return ops.handoff(mcp[1], args);
          if (name === DOC_TOOL.name) return callDocTool(store.loadProjects().find((p) => p.id === found.group.projectId), args);
          const r = callNoteTool(notes, found.group, mcp[1], name, args, resolveMember);
          return r !== undefined ? r : callTeamTool(ctx, name, args);
        },
      });
      if (!reply) {
        res.writeHead(202);
        return res.end();
      }
      return sendJson(res, 200, reply);
    } catch (err) {
      return sendJson(res, err.status || 500, { jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message } });
    }
  }
  if (!tokenOk(req.headers['x-panel-token'])) return sendJson(res, 401, { error: 'Erişim anahtarı geçersiz.' });

  // Arayüz durumu kendiliğinden yineler; yalnızca değişiklik isteyen çağrılar kullanıcı teması sayılır.
  if (req.method !== 'GET') presence.touch(`${req.method} ${url.pathname.replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, '/:id')}`);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    try {
      return sendJson(res, 200, await r.handler(req, m));
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('[panel]', err);
      return sendJson(res, status, { error: err.message || 'Sunucu hatası.' });
    }
  }
  sendJson(res, 404, { error: 'Bulunamadı.' });
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ req }) => {
    if (!allowedHosts().includes(req.headers.host)) return false;
    const origin = req.headers.origin;
    // Tarayıcı dışı istemcide (attach.js) origin olmaz; tarayıcıda yalnızca panelin kendi adresi.
    if (origin && !allowedHosts().some((h) => origin === `http://${h}`)) return false;
    const url = new URL(req.url, `http://${req.headers.host}`);
    return tokenOk(url.searchParams.get('t'));
  },
});

// Durum kanalı (?ch=state): arayüz iki saniyede bir yoklamak yerine durum değişince tam yanıtı alır.
// Değişiklik saniyede bir denetlenir; kimse bağlı değilse durum hiç kurulmaz.
const stateClients = new Set();
let stateSent = '';
function pushState() {
  if (!stateClients.size) return;
  let json;
  try { json = JSON.stringify({ t: 'state', d: buildState() }); } catch (err) { console.error('[panel] durum:', err.message); return; }
  if (json === stateSent) return;
  stateSent = json;
  for (const ws of stateClients) if (ws.readyState === 1) ws.send(json);
}
setInterval(pushState, 1000);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('ch') === 'state') {
    stateClients.add(ws);
    ws.on('close', () => stateClients.delete(ws));
    ws.on('error', () => stateClients.delete(ws));
    // Yeni bağlanan hemen güncel durumu alır.
    try { ws.send(JSON.stringify({ t: 'state', d: buildState() })); } catch {}
    return;
  }
  const s = manager.get(url.searchParams.get('s'));
  if (!s) {
    ws.send(JSON.stringify({ t: 'x', code: null }));
    return ws.close();
  }
  s.attach(ws);
});

function shutdown() {
  // Zaman çizelgesinde panelin kapandığı an "kapalı" olarak işaretlenir; yoksa son durum yeniden açılışa kadar uzar.
  try {
    for (const g of store.loadGroups()) {
      let changed = false;
      for (const s of g.sessions) if (timeline.record(g.id, s.id, 'off')) changed = true;
      if (changed) timeline.save(g.id);
    }
    if (timeline.record(USER_TL, 'user', 'off')) timeline.save(USER_TL);
    store.writeJson('events.json', events);
  } catch {}
  manager.stopAll();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Windows'ta konsol penceresi kapatılınca gelir.
process.on('SIGHUP', shutdown);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} kullanımda; panel zaten çalışıyor olabilir. Tarayıcıda http://127.0.0.1:${PORT} adresini aç.`);
    process.exit(1);
  }
  throw err;
});

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

server.listen(PORT, '127.0.0.1', () => {
  warmStats();
  const url = `http://127.0.0.1:${PORT}/?t=${token}`;
  console.log(`Claude Panel çalışıyor: ${url}`);
  console.log('Bu pencereyi kapatırsan paneldeki oturumlar da kapanır.');
  if (process.argv.includes('--open')) spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
});
