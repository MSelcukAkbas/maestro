// Panel asistanı: kullanıcının panelle doğal dille konuştuğu, bütün grupları gören tek Claude Code oturumu. Yalnızca
// kullanıcı yazınca çalışır; panel ona kendiliğinden hiçbir şey göndermez. Kendi MCP adresi (/api/mcp/<asistan>) ile
// panel verisini okur ve var olan yollardan iş yapar: bekçi hamleleri ops'a, mesajlar gelen kutusuna (iletim pano ve
// notlarla aynı yoldan), model / effort / üye açma-kapama kullanıcı onayına (requests). Proje klasörlerini yalnızca
// Read / Grep / Glob ile okur. Metin ve model ayarı prompts/tools/asistan/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const store = require('../core/store');
const prompts = require('../core/prompts');
const discovery = require('../core/discovery');
const { sessionRecent, sessionMessages, sessionStats } = require('../core/usage');
const { MODELS, EFFORTS, PERMISSION_MODES } = require('../core/options');
const { writeSettingsFile, writeMcpConfig } = require('../session/hooks');
const { handleMcp, resolveMember, STATUS_TEXT } = require('../team/board');
const { callNoteTool } = require('../team/notes');
const helper = require('../watch/helper');
const {
  PORT, settings, hookState, manager, boards, notes, requests, inbox, meter, watch, ops, pending, ledger, events,
  HttpError, sharedConfigDir, findSession, sessionStatus, pushEvent, runningLead, pasteTo, cachedQuota, lastQuota,
  trustsDir, quotaLeft, groupWatchCfg, setMeterExtra, whenStopped,
} = require('./context');
const { memberSnapshot } = require('./members');
const { scheduler } = require('./schedule');
const { parseWhen, STEP_TYPES, STATUS_TEXT: SCHED_STATUS, MAX_STEPS } = require('../team/schedule');
const { hasDelivery } = require('./delivery');

const NAME = 'Panel asistanı';
const ACTOR = 'asistan';
// Asistan proje klasöründe açılmaz: projenin CLAUDE.md'si ve ayarları onun bağlamına girmesin.
const WORK_DIR = path.join(os.tmpdir(), 'claude-panel-asistan');
const METER_KEEP = 10 * 60 * 1000;

let rec = store.readJson('asistan.json', null) || {};
let lastRunning = 0;
let nav = () => false;

function save() {
  store.writeJson('asistan.json', rec);
}

function isAssistant(sid) {
  return !!rec.id && sid === rec.id;
}

// Arayüzü yönlendiren fonksiyon (http.js durum kanalına bağlar); bağlı arayüz yoksa false döner.
function setNav(fn) {
  nav = fn;
}

// Asistanın harcaması da ölçüme girsin (grup dışı oturum); kapandıktan sonra 10 dakika daha okunur.
setMeterExtra(() => {
  if (!rec.id) return [];
  if (manager.has(rec.id)) lastRunning = Date.now();
  return lastRunning && Date.now() - lastRunning < METER_KEEP ? [{ id: rec.id, name: NAME, accountId: rec.accountId }] : [];
});

function status(live) {
  const running = !!rec.id && manager.has(rec.id);
  let st = null;
  if (running) {
    try { st = sessionStatus({ id: rec.id }, live || discovery.liveSessions(sharedConfigDir())).status; } catch {}
  }
  return { id: rec.id || null, running, status: st, accountId: rec.accountId || null, unread: inbox.unread(), timers: scheduler.pendingCount() };
}

// Asistanı açar: kayıtlı konuşma varsa kaldığı yerden, fresh ya da kayıt yoksa yeni konuşmayla.
function open({ fresh = false, accountId } = {}) {
  if (rec.id && manager.has(rec.id)) {
    if (!fresh) return status();
    manager.stop(rec.id);
    return new Promise((resolve, reject) => whenStopped(rec.id, (err) => {
      if (err) return reject(new HttpError(409, 'Asistan kapanmadı, biraz sonra yeniden dene.'));
      try { resolve(open({ fresh: true, accountId })); } catch (e) { reject(e); }
    }));
  }
  const t = prompts.tool('asistan');
  const account = settings.accounts.find((a) => a.id === (accountId || rec.accountId)) || helper.pickAccount(settings.accounts, lastQuota());
  if (!account) throw new HttpError(409, 'Hesap tanımlı değil.');
  if (fresh || !rec.id) rec = { id: crypto.randomUUID(), createdAt: Date.now() };
  rec.accountId = account.id;
  save();
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const resume = !!discovery.transcriptPath(sharedConfigDir(), rec.id);
  const promptFile = path.join(store.PROMPT_DIR, `asistan-${rec.id}.md`);
  fs.writeFileSync(promptFile, t.system(), 'utf8');
  hookState.clear(rec.id);
  manager.launch({
    id: rec.id,
    name: NAME,
    cwd: WORK_DIR,
    configDir: account.configDir,
    resume,
    permissionMode: t.config.permissionMode || 'default',
    model: t.config.model,
    effort: t.config.effort,
    promptFile,
    settingsFile: writeSettingsFile(store.DATA_DIR, PORT, rec.id, { allow: t.config.allow || [], deny: t.config.deny || [] }),
    mcpConfig: writeMcpConfig(store.DATA_DIR, PORT, rec.id),
  });
  return status();
}

function stop() {
  if (rec.id && manager.has(rec.id)) manager.stop(rec.id);
  return { ok: true };
}

// ---------- yardımcılar ----------

const k = (n) => `${Math.round((n || 0) / 1000)}k`;
const mins = (ms) => (ms < 60000 ? `${Math.max(0, Math.round(ms / 1000))} sn` : ms < 3600000 ? `${Math.round(ms / 60000)} dk` : `${(ms / 3600000).toFixed(1)} sa`);
const shortId = (id) => String(id).slice(0, 8);
const clip = (s, max) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
const when = (ts) => new Date(ts).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const accName = (id) => (settings.accounts.find((a) => a.id === id) || {}).name || id;
const projectOf = (g) => store.loadProjects().find((p) => p.id === g.projectId) || null;

class ToolError extends Error {}
const fail = (msg) => { throw new ToolError(msg); };

function liveGroups() {
  return store.viewGroups().filter((g) => !g.archived);
}

// Grup: kimlik, kimliğin başı ya da adın bir parçası.
function findGroup(ref) {
  const v = String(ref || '').trim().toLocaleLowerCase('tr');
  if (!v) fail('Grup belirtilmedi.');
  const list = liveGroups();
  const exact = list.find((g) => g.id === v || g.name.toLocaleLowerCase('tr') === v);
  if (exact) return exact;
  const hits = list.filter((g) => (v.length >= 4 && g.id.startsWith(v)) || g.name.toLocaleLowerCase('tr').includes(v));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) fail(`"${ref}" birden çok gruba uyuyor: ${hits.map((g) => `${g.name} [${shortId(g.id)}]`).join(', ')}`);
  fail(`Grup bulunamadı: "${ref}". Açık gruplar: ${list.map((g) => `${g.name} [${shortId(g.id)}]`).join(', ') || 'yok'}`);
}

// Üye: kimlik, kimliğin ilk 8 hanesi, tam ad, tek üyeye denk gelen rol ya da "grup/rol".
function findMember(ref) {
  const v = String(ref || '').trim();
  if (!v) fail('Üye belirtilmedi.');
  const all = liveGroups().flatMap((g) => g.sessions.filter((s) => !s.removed).map((s) => ({ group: g, session: s })));
  const lower = v.toLocaleLowerCase('tr');
  const one = all.find((m) => m.session.id === v || m.session.name.toLocaleLowerCase('tr') === lower);
  if (one) return one;
  const pre = v.length >= 6 ? all.filter((m) => m.session.id.startsWith(v)) : [];
  if (pre.length === 1) return pre[0];
  if (pre.length > 1) fail(`"${v}" birden çok üyenin kimliğine uyuyor; daha uzun kimlik ver.`);
  const slash = v.indexOf('/');
  if (slash > 0) {
    const g = findGroup(v.slice(0, slash));
    let sid;
    try { sid = resolveMember(g, v.slice(slash + 1)); } catch (err) { fail(err.message); }
    if (sid) return { group: g, session: g.sessions.find((s) => s.id === sid) };
  }
  const byRole = all.filter((m) => [m.session.roleLabel, m.session.roleId].some((x) => x && x.toLocaleLowerCase('tr') === lower));
  if (byRole.length === 1) return byRole[0];
  if (byRole.length > 1) fail(`"${v}" birden çok üyeye uyuyor; kimliği ya da "grup/rol" kullan: ${byRole.map((m) => `${m.session.name} [${shortId(m.session.id)}]`).join(', ')}`);
  fail(`Üye bulunamadı: "${v}". panel_durumu ile kimliklere bak.`);
}

function findAccount(ref) {
  const v = String(ref || '').trim().toLocaleLowerCase('tr');
  const a = settings.accounts.find((x) => x.id.toLocaleLowerCase('tr') === v || String(x.name || '').toLocaleLowerCase('tr') === v);
  if (!a) fail(`Hesap bulunamadı: "${ref}". Hesaplar: ${settings.accounts.map((x) => `${x.id} (${x.name})`).join(', ')}`);
  return a;
}

function cacheText(i, now) {
  if (!i || !i.lastTurnAt) return 'önbellek yok';
  if (!i.cacheWarm) return `önbellek soğuk (son tur ${mins(now - i.lastTurnAt)} önce)`;
  return `önbellek sıcak (~${mins(Math.max(0, i.lastTurnAt + (i.cacheTtlMs || 3600000) - now))} kaldı)`;
}

// ---------- okuma tool'ları ----------

const DURUMLAR = ['calisiyor', 'bosta', 'hepsi'];

// panel_durumu süzgeci: hesap (kimlik) ve durum birleşir; calisiyor = boşta olmayan (kullanıcı onayı bekleyenler dahil).
function keepMember(m, accountId, durum) {
  return (!accountId || m.session.accountId === accountId)
    && (!durum || durum === 'hepsi' || (durum === 'bosta' ? m.status === 'idle' : m.status !== 'idle'));
}

function toolDurum(a) {
  const now = Date.now();
  const live = discovery.liveSessions(sharedConfigDir());
  const all = liveGroups();
  const account = a.hesap ? findAccount(a.hesap) : null;
  if (a.durum && !DURUMLAR.includes(a.durum)) fail(`Geçersiz durum: "${a.durum}". Seçenekler: ${DURUMLAR.join(', ')}`);
  const filtered = !!account || (a.durum && a.durum !== 'hepsi');
  const keep = (m) => keepMember(m, account && account.id, a.durum);
  const groups = a.grup ? [findGroup(a.grup)] : all.filter((g) => a.hepsi || g.sessions.some((s) => !s.removed && manager.has(s.id)));
  const out = [];
  for (const g of groups) {
    const members = memberSnapshot(g, live);
    const shown = members.filter((m) => m.running && keep(m));
    if (filtered && !shown.length) continue;
    const p = projectOf(g);
    const cfg = groupWatchCfg(g);
    const cards = boards.load(g.id).cards;
    const reqs = requests.pending(g.id);
    if (a.kompakt) out.push(`## ${g.name} [${shortId(g.id)}]`);
    else out.push(`## ${g.name} [${shortId(g.id)}] · proje ${p ? `${p.name} (${p.path})` : '?'} · bekçi ${cfg.enabled ? (cfg.act ? 'açık' : 'yalnız öneri') : 'kapalı'}${reqs.length ? ` · onay bekleyen ${reqs.length} istek` : ''}`);
    const closed = [];
    for (const m of members) {
      const s = m.session;
      if (!m.running) { closed.push(`${s.roleLabel} [${shortId(s.id)}]`); continue; }
      if (!keep(m)) continue;
      if (a.kompakt) {
        out.push(`- [${shortId(s.id)}] ${s.roleLabel} · ${s.accountId} · ${m.statusText} · ${m.contextPct != null ? `%${m.contextPct}` : '?'}`);
        continue;
      }
      const i = m.info || {};
      const parts = [
        `[${shortId(s.id)}] ${s.roleLabel}`, s.name, `hesap ${s.accountId}`, m.statusText, `izin ${s.permissionMode || g.permissionMode || 'manual'}`,
        `model ${i.fam || s.model || '?'}${i.effort || s.effort ? `/${i.effort || s.effort}` : ''}`,
        `bağlam ${k(i.context || (m.stats && m.stats.context))}${m.contextPct != null ? ` (%${m.contextPct})` : ''}`,
        cacheText(i, now),
      ];
      if (i.compacts) parts.push(`${i.compacts} compact`);
      if (i.lastActiveAt) parts.push(`son hareket ${mins(now - i.lastActiveAt)} önce`);
      const open = cards.filter((c) => c.assignee === s.id && c.status !== 'done');
      parts.push(open.length ? `açık kart: ${open.map((c) => `#${c.id} ${STATUS_TEXT[c.status]}`).join(', ')}` : 'açık kartı yok');
      const op = ops.get(s.id);
      if (op) parts.push(`bekçi hamlesi: ${op.kind} (${op.state})`);
      const pd = pending.get(s.id);
      if (pd) parts.push(`bekleyen ayar: ${[pd.model ? `model ${pd.model}` : '', pd.effort ? `effort ${pd.effort}` : '', pd.perm ? `izin ${pd.perm}` : '', pd.caps ? 'yetenekler' : ''].filter(Boolean).join(', ')}`);
      if (inbox.hasPending(s.id)) parts.push('iletilmeyi bekleyen kullanıcı mesajı var');
      out.push(`- ${parts.join(' · ')}`);
    }
    if (closed.length && !filtered) out.push(a.kompakt ? `- kapalı ${closed.length}` : `- kapalı: ${closed.join(', ')}`);
  }
  const others = all.filter((g) => !groups.includes(g));
  if (others.length && !filtered) out.push(`\nÇalışan üyesi olmayan gruplar: ${others.map((g) => `${g.name} [${shortId(g.id)}]`).join(', ')}`);
  return out.join('\n') || (filtered ? 'Ölçüte uyan açık üye yok.' : 'Açık grup yok.');
}

// Açık (PTY'si olan) üyeler hesap başına; durum panelle aynı kaynaktan (memberSnapshot): boşta / bekliyor / çalışıyor.
function openByAccount() {
  const live = discovery.liveSessions(sharedConfigDir());
  const byAccount = new Map();
  for (const g of liveGroups()) {
    for (const m of memberSnapshot(g, live)) {
      if (!m.running) continue;
      const list = byAccount.get(m.session.accountId) || [];
      list.push({ label: `${m.session.roleLabel} [${shortId(m.session.id)}]`, state: m.status === 'idle' ? 'boşta' : m.status === 'waiting' ? 'bekliyor' : 'çalışıyor' });
      byAccount.set(m.session.accountId, list);
    }
  }
  return byAccount;
}

function openText(list = []) {
  if (!list.length) return 'açık üye yok';
  const count = (state) => list.filter((x) => x.state === state).length;
  const parts = [['çalışıyor', count('çalışıyor')], ['boşta', count('boşta')], ['kullanıcı bekliyor', count('bekliyor')]].filter(([, n]) => n).map(([t, n]) => `${t} ${n}`);
  return `açık ${list.length} (${parts.join(', ')}): ${list.map((x) => `${x.label} ${x.state}`).join(', ')}`;
}

// Tek pencere: kalan %, sıfırlanma ve (tahmin varsa) bu hızla dolma süresi; pencere yoksa null.
function quotaWin(label, b, now) {
  if (!b) return null;
  const reset = b.resetsAt ? Date.parse(b.resetsAt) : null;
  const f = b.forecast;
  return `${label} %${Math.max(0, Math.round(100 - b.used))} kaldı${reset ? ` (sıfırlanma ${mins(reset - now)} sonra)` : ''}${f && f.eta ? `, bu hızla ~${mins(Math.max(0, f.eta - now))} içinde dolar${f.beforeReset ? '' : ' (sıfırlanmadan sonra)'}` : ''}`;
}

async function toolKota() {
  const q = await cachedQuota().catch(() => lastQuota());
  if (!q || !q.rows) return 'Kota okunamadı.';
  const now = Date.now();
  const open = openByAccount();
  const lines = q.rows.map((r) => [`${accName(r.accountId)} (${r.accountId})`, r.blocked ? 'DOLU' : r.status, quotaWin('5 saat', r.five, now), quotaWin('hafta', r.week, now), openText(open.get(r.accountId))].filter(Boolean).join(' · '));
  return `Kota (ölçüm ${mins(now - q.fetchedAt)} önce):\n${lines.join('\n')}`;
}

// Risk, quota.js tahminine (forecast) dayanır: kritik = dolu ya da sıfırlanmadan önce dolacak, uyarı = bir pencerede %20'den az kaldı,
// bilinmiyor = kota ölçülemedi.
function accountRisk(r) {
  if (r.blocked) return { level: 'kritik', why: 'kota DOLU' };
  const wins = [['5 saat', r.five], ['hafta', r.week]].filter(([, b]) => b);
  if (r.status !== 'canlı' || !wins.length) return { level: 'bilinmiyor', why: `kota ölçülemedi (${r.status || 'pencere yok'})` };
  const draining = wins.filter(([, b]) => b.forecast && b.forecast.beforeReset);
  if (draining.length) return { level: 'kritik', why: draining.map(([label]) => `${label} penceresi sıfırlanmadan dolacak`).join(', ') };
  const low = wins.filter(([, b]) => 100 - b.used < 20);
  if (low.length) return { level: 'uyarı', why: low.map(([label, b]) => `${label} penceresinde %${Math.max(0, Math.round(100 - b.used))} kaldı`).join(', ') };
  return { level: 'normal', why: 'her pencerede %20 üstü kaldı, tahmin sıfırlanmayı aşmıyor' };
}

async function toolHesapOzeti() {
  const q = await cachedQuota().catch(() => lastQuota());
  if (!q || !q.rows) return 'Kota okunamadı.';
  const now = Date.now();
  const open = openByAccount();
  const lines = q.rows.map((r) => {
    const risk = accountRisk(r);
    return `- ${accName(r.accountId)} (${r.accountId}) · RİSK ${risk.level.toLocaleUpperCase('tr')}: ${risk.why}\n  ${quotaWin('5 saat', r.five, now) || '5 saat yok'} · ${quotaWin('hafta', r.week, now) || 'hafta yok'}\n  ${openText(open.get(r.accountId))}`;
  });
  return `Hesap özeti (kota ölçümü ${mins(now - q.fetchedAt)} önce):\n${lines.join('\n')}`;
}

// Üye başına harcama (birim ≈ API eşdeğeri $; tahmini kota yüzdesi hesabın ölçülen oranından) ve hesap başına kota serisi.
function toolTuketim(a) {
  const hours = Math.min(Math.max(Number(a.saat) || 24, 1), 168);
  const account = a.hesap ? findAccount(a.hesap) : null;
  const group = a.grup ? findGroup(a.grup) : null;
  const top = Math.min(Math.max(Number(a.adet) || 15, 1), 50);
  const now = Date.now();
  const h = meter.history(hours, now);
  // Oran tek pencere içindir; aralık pencereden uzunsa yüzde 100'ü aşabilir, o zaman "pencere eşdeğeri" olarak yazılır.
  const pct = (e) => ['five', 'week'].filter((kind) => e.est[kind]).map((kind) => {
    const p = e.est[kind].pct;
    return `${kind === 'five' ? '5s' : 'hafta'} ${p > 100 ? `≈${(p / 100).toFixed(1)} pencere eşdeğeri` : `≈%${p}`} (güven ${e.est[kind].conf})`;
  }).join(', ');
  let members = h.members.filter((e) => !account || e.acc === account.id);
  if (group) members = members.filter((e) => group.sessions.some((s) => s.id === e.sid));
  const out = [`Son ${hours} saatte üye tüketimi (birim ≈ API eşdeğeri $; kota yüzdesi tahmindir):`];
  if (!members.length) out.push('- kayıt yok (geçmiş panel açıkken tutulur, en çok 7 gün)');
  members.slice(0, top).forEach((e, i) => out.push(`${i + 1}. ${e.name} [${shortId(e.sid)}] · hesap ${e.acc} · ${e.units.toFixed(2)} birim · ${k(e.tokens)} token${pct(e) ? ` · ${pct(e)}` : ''}`));
  if (members.length > top) out.push(`… ${members.length - top} üye daha`);
  const rows = new Map();
  for (const x of h.series) if (!account || x.acc === account.id) rows.set(x.acc, [...(rows.get(x.acc) || []), x]);
  out.push('', 'Kota serisi (saatin son ölçümü, kullanılan %):');
  if (!rows.size) out.push('- ölçüm yok');
  for (const [acc, pts] of rows) {
    // Pencere sıfırlanınca değer düşer; artış yalnızca pozitif farkların toplamıdır.
    const rise = (key) => pts.reduce((n, x, i) => (i && x[key] != null && pts[i - 1][key] != null && x[key] > pts[i - 1][key] ? n + x[key] - pts[i - 1][key] : n), 0);
    const stamp = (x) => `${hours > 24 ? `${when(x.h).slice(0, 5)} ` : ''}${new Date(x.h).getHours().toString().padStart(2, '0')}:00`;
    const line = pts.slice(-12).map((x) => `${stamp(x)} 5s ${x.five ?? '?'}% hafta ${x.week ?? '?'}%`).join(' | ');
    out.push(`- ${accName(acc)} (${acc}): ${hours} saatte 5s +${Math.round(rise('five'))} puan, hafta +${Math.round(rise('week'))} puan · ${line}`);
  }
  return out.join('\n');
}

function toolOlaylar(a) {
  const n = Math.min(Math.max(Number(a.adet) || 20, 1), 100);
  const g = a.grup ? findGroup(a.grup) : null;
  const list = events.filter((e) => !g || e.gid === g.id).slice(-n);
  const out = [`Son ${list.length} olay:`, ...list.map((e) => `- ${when(e.ts)} [${e.source}] ${e.text}`)];
  const opsNow = ops.list().filter((o) => !g || o.gid === g.id);
  if (opsNow.length) out.push('', 'Süren bekçi hamleleri:', ...opsNow.map((o) => `- ${ops.name(o.sid)} [${shortId(o.sid)}]: ${o.kind} (${o.state}) · ${o.by || ''} · ${o.why || ''}`));
  const snap = watch.snapshot(g ? g.id : undefined);
  const findings = g ? snap.findings : Object.values(snap.findings).flat();
  if (findings.length) out.push('', 'Bekçinin şu anki bulguları:', ...findings.map((f) => `- [${f.level}] ${f.text}`));
  const log = snap.log.slice(-10);
  if (log.length) out.push('', 'Bekçi kaydı (son 10):', ...log.map((x) => `- ${when(x.ts)} ${x.text}`));
  const day = ledger.view().day;
  out.push('', `Yardımcı model harcaması (24 saat): ≈$${day.usd.toFixed(3)} · ${Object.entries(day.byKind).map(([kind, v]) => `${kind} ${v.calls} çağrı`).join(', ') || 'yok'}`);
  return out.join('\n');
}

function toolPano(a) {
  const g = findGroup(a.grup);
  const name = (sid) => (g.sessions.find((s) => s.id === sid) || {}).roleLabel || 'yok';
  let cards = boards.load(g.id).cards;
  if (a.durum) cards = cards.filter((c) => c.status === a.durum);
  if (!cards.length) return 'Panoda bu ölçüte uyan kart yok.';
  return cards.map((c) => {
    const last = c.notes.length ? c.notes[c.notes.length - 1] : null;
    return `#${c.id} [${STATUS_TEXT[c.status]}] ${c.title} · atanan: ${c.assignee ? name(c.assignee) : 'yok'}${c.desc ? `\n  ${clip(c.desc, 300)}` : ''}${last ? `\n  son not: ${clip(last.text, 200)}` : ''}`;
  }).join('\n');
}

function toolNotlar(a) {
  const g = findGroup(a.grup);
  if (a.id != null) return callNoteTool(notes, g, 'user', 'not_oku', { id: a.id }, resolveMember);
  return callNoteTool(notes, g, 'user', 'not_listele', { ara: a.ara || '' }, resolveMember);
}

function toolKonusma(a) {
  const { group, session } = findMember(a.uye);
  const file = discovery.transcriptPath(sharedConfigDir(), session.id);
  const n = Math.min(Math.max(Number(a.adet) || 6, 1), 12);
  const recent = sessionRecent(file).slice(-n);
  const sent = sessionMessages(file).slice(-5);
  const st = sessionStats(file);
  const out = [`${session.name} [${shortId(session.id)}] · ${group.name}`];
  out.push(`Son ${recent.length} mesaj (eskiden yeniye):`);
  for (const r of recent) out.push(`- ${when(r.ts)} ${r.from === 'üye' ? 'ÜYE' : 'GELEN'}: ${r.text}`);
  if (sent.length) out.push('', 'Ekibe gönderdiği son mesajlar:', ...sent.map((m) => `- ${when(m.ts)} → ${m.to}: ${m.text}`));
  if (st && st.lastSummary) out.push('', `Kapanış özeti: ${clip(st.lastSummary, 1500)}`);
  return out.join('\n');
}

function toolMaliyet(a) {
  const { group, session } = findMember(a.uye);
  if (!manager.has(session.id)) return `${session.name} kapalı; hamle yapılamaz.`;
  const now = Date.now();
  const i = meter.sessionInfo(session.id) || {};
  const ctx = i.context || 0;
  const c = watch.costs(meter, ctx, i.fam);
  const rn = watch.renewCost(meter, ctx, i.fam);
  const cold = !!i.lastTurnAt && i.cacheWarm === false;
  const acc = session.accountId;
  const p = projectOf(group);
  const q = lastQuota();
  const out = [
    `${session.name} [${shortId(session.id)}] · bağlam ${k(ctx)} · model ${i.fam || '?'} · ${cacheText(i, now)} · ${i.compacts || 0} compact`,
    `- compact: bu hesapta ${watch.costText(meter, acc, c.compact)}, bağlam ~${k(c.after)}'e iner, sonraki her tur ${watch.costText(meter, acc, c.perTurn)} ucuzlar${cold ? '. Önbellek soğuk: compact ancak üye yeniden çalışıp önbellek ısınınca yapılır' : ''}`,
    `- yenile (devir notu, sıfır bağlam): ${watch.costText(meter, acc, rn.cost)}, bağlam ~${k(rn.after)}; ayrıntı kaybı riski`,
  ];
  for (const r of (q && q.rows) || []) {
    if (r.accountId === acc) continue;
    const left = quotaLeft(r);
    const trusted = !p || trustsDir(r.accountId, p.path);
    out.push(`- ${accName(r.accountId)} (${r.accountId}) hesabına taşı: ${cold ? 'önbellek zaten soğuk, ek maliyet yok' : watch.costText(meter, r.accountId, c.move)} · o hesapta kalan %${left == null ? '?' : left}${trusted ? '' : ' · bu proje klasörü o hesapta onaylı değil, taşınamaz'}`);
  }
  out.push('- hiçbir şey yapmamak: boştaki oturum kota harcamaz.');
  return out.join('\n');
}

function toolYanitlar(a) {
  const list = inbox.replies(!!a.hepsi);
  if (!list.length) return a.hepsi ? 'Hiç yanıt yok.' : 'Okunmamış yanıt yok.';
  return list.map((r) => `- ${when(r.ts)} ${r.name} [${shortId(r.sid)}] (${r.group}): ${r.text}`).join('\n');
}

function toolRoller() {
  return settings.roles.map((r) => `- ${r.id}: ${r.label} · model ${r.model || 'varsayılan'} · effort ${r.effort || 'varsayılan'}`).join('\n');
}

// ---------- iş yapan tool'lar ----------

const MOVES = { compact: 'compact', yenile: 'renew', tasi: 'move' };
const MOVE_TEXT = { compact: 'compact', renew: 'yenileme (devir notuyla sıfır bağlam)', move: 'hesap taşıma' };

function toolHamle(a) {
  const { group, session } = findMember(a.uye);
  if (a.hamle === 'iptal') {
    const r = ops.cancel(session.id);
    if (!r.ok) fail(r.error);
    pushEvent(`Asistan: ${session.name} için bekçi hamlesi iptal edildi.`, ACTOR, group.id);
    return `${session.name}: süren hamle iptal edildi.`;
  }
  const kind = MOVES[a.hamle];
  if (!kind) fail('hamle: compact, yenile, tasi ya da iptal olmalı.');
  if (!manager.has(session.id)) fail(`${session.name} kapalı.`);
  let accountId = null;
  if (kind === 'move') {
    const acc = findAccount(a.hesap);
    if (acc.id === session.accountId) fail(`${session.name} zaten ${acc.id} hesabında.`);
    const p = projectOf(group);
    if (p && !trustsDir(acc.id, p.path)) fail(`${acc.id} hesabı bu proje klasörünü onaylamamış; taşınan oturum güven sorusunda kalır. Kullanıcı o hesapla klasörü bir kez açıp onaylamalı.`);
    accountId = acc.id;
  }
  const cur = ops.get(session.id);
  if (cur) fail(`${session.name} üzerinde zaten süren bir hamle var: ${cur.kind} (${cur.state}).`);
  const ok = ops.add({ sid: session.id, gid: group.id, kind, accountId, why: 'kullanıcının isteği (asistan)', by: 'kullanıcı (asistan)', force: true, fromAccount: session.accountId });
  if (!ok) fail(`${session.name}: hamle sıraya alınamadı.`);
  pushEvent(`Asistan: ${session.name} için ${MOVE_TEXT[kind]} sıraya alındı.`, ACTOR, group.id);
  const info = meter.sessionInfo(session.id) || {};
  const coldNote = kind === 'compact' && info.lastTurnAt && info.cacheWarm === false ? ' Önbellek soğuk: compact üye yeniden çalışıp önbellek ısınınca yapılır.' : '';
  return `${session.name}: ${MOVE_TEXT[kind]}${accountId ? ` (${accountId})` : ''} sıraya alındı. Bekçi üye boşta kalınca uygular (en geç 1 saat içinde fırsat bulamazsa bırakır); sonuç olaylara düşer.${coldNote}`;
}

const TONES = ['normal', 'bilgi', 'acil'];

function toolMesaj(a) {
  const text = String(a.metin || '').trim();
  if (!text) fail('metin boş.');
  const refs = (Array.isArray(a.uyeler) ? a.uyeler : String(a.uyeler || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  if (!refs.length) fail('uyeler boş.');
  const tone = TONES.includes(a.ton) ? a.ton : 'normal';
  const targets = [];
  for (const r of refs) {
    const m = findMember(r);
    if (!targets.some((t) => t.session.id === m.session.id)) targets.push(m);
  }
  const lines = [];
  for (const { group, session } of targets) {
    const running = manager.has(session.id);
    if (tone === 'bilgi') {
      inbox.note(session.id, text);
      lines.push(`${session.name}: bilgi notu bırakıldı; bir sonraki çalışmasında görecek, tur açmaz.`);
    } else if (tone === 'acil' && running && !['busy', 'idle'].includes(sessionStatus(session, discovery.liveSessions(sharedConfigDir())).status)) {
      // Onay / soru bekleyen ya da açılış ekranındaki üyeye yazılan metin bekleyen seçimin yerine geçerdi; normal yoldan gider.
      inbox.send(session.id, text, !!a.cevap_iste);
      lines.push(`${session.name}: onay, soru ya da açılış ekranında; araya girilmedi, hazır olunca iletilecek.`);
    } else if (tone === 'acil' && running && ops.blocks(session.id)) {
      // Bekçi yeniliyor: mesaj yeni oturuma geçer.
      inbox.send(session.id, text, !!a.cevap_iste);
      lines.push(`${session.name}: bekçi şu an yeniliyor; mesaj yeni oturuma iletilecek.`);
    } else if (tone === 'acil' && running) {
      const p = manager.get(session.id);
      const busy = sessionStatus(session, discovery.liveSessions(sharedConfigDir())).status === 'busy';
      if (busy) p.interrupt();
      const body = prompts.message('kullanici-mesaji', { metin: text, cevap: !!a.cevap_iste, bilgi: false });
      setTimeout(() => {
        if (pasteTo(session, body)) hookState.set(session.id, 'busy', { activity: 'kullanıcı mesajı okunuyor' });
      }, busy ? 1500 : 0);
      lines.push(`${session.name}: ${busy ? 'çalıştığı tur kesildi ve ' : ''}mesaj terminaline yazıldı.`);
    } else {
      inbox.send(session.id, text, !!a.cevap_iste);
      const st = running ? sessionStatus(session, discovery.liveSessions(sharedConfigDir())).status : 'off';
      lines.push(`${session.name}: ${!running ? 'kapalı; açılınca iletilecek' : st === 'idle' ? 'boşta, birkaç saniye içinde terminaline yazılacak' : 'çalışıyor; turu bitince iletilecek'}.`);
    }
  }
  // Şef ekipten kopmasın: şefin dışındaki üyelere giden mesaj şefe bilgi notu olarak geçer (tur açmaz).
  if (a.sefe_bilgi !== false && tone !== 'bilgi') {
    for (const g of [...new Set(targets.map((t) => t.group))]) {
      const lead = runningLead(g);
      if (!lead || lead.roleId !== 'sef' || targets.some((t) => t.session.id === lead.id)) continue;
      const names = targets.filter((t) => t.group === g).map((t) => t.session.name).join(', ');
      inbox.note(lead.id, `Kullanıcı asistan aracılığıyla ${names} üyesine yazdı: "${clip(text, 400)}"`);
      lines.push(`Şefe (${lead.name}) bilgi notu bırakıldı.`);
    }
  }
  for (const g of [...new Set(targets.map((t) => t.group))]) {
    pushEvent(`Asistan → ${targets.filter((t) => t.group === g).map((t) => t.session.roleLabel).join(', ')} (${tone}): ${clip(text, 160)}`, ACTOR, g.id);
  }
  if (a.cevap_iste) lines.push('Cevaplar geldikçe yanitlar tool\'u ile okunur.');
  return lines.join('\n');
}

function toolKart(a) {
  const g = findGroup(a.grup);
  let assignee = null;
  try { assignee = a.atanan ? resolveMember(g, a.atanan) : null; } catch (err) { fail(err.message); }
  const card = boards.create(g, { title: a.baslik, desc: a.aciklama || '', status: 'todo', assignee }, 'user');
  pushEvent(`Asistan: ${g.name} panosuna #${card.id} "${clip(card.title, 80)}" eklendi.`, ACTOR, g.id);
  return `Kart eklendi: #${card.id} "${card.title}"${assignee ? ` · atanan ${(g.sessions.find((s) => s.id === assignee) || {}).name}` : ''}.`;
}

const REQ_KINDS = { ayar: 'settings', kapat: 'stop', cikar: 'remove', hesap: 'account', ekle: 'add' };

function toolOnay(a) {
  const kind = REQ_KINDS[a.tur];
  if (!kind) fail('tur: ayar, kapat, cikar, hesap ya da ekle olmalı.');
  const reason = String(a.gerekce || '').trim();
  if (!reason) fail('gerekce gerekli; kullanıcı onay kartında görecek.');
  let gid;
  let args;
  if (kind === 'add') {
    const g = findGroup(a.grup);
    const v = String(a.rol || '').trim().toLocaleLowerCase('tr');
    const role = settings.roles.find((r) => r.id === v || String(r.label).toLocaleLowerCase('tr') === v);
    if (!role) fail(`Rol bulunamadı: "${a.rol}". roller tool'una bak.`);
    gid = g.id;
    args = { roleId: role.id, ...(a.hesap ? { accountId: findAccount(a.hesap).id } : {}), task: String(a.gorev || '').slice(0, 8000) };
    if (a.model) args.model = a.model;
    if (a.effort) args.effort = a.effort;
  } else if (kind === 'settings') {
    // Bir ya da birden çok üye; hepsi aynı grupta olmalı (onay kartı grubun ekranında).
    const refs = Array.isArray(a.uyeler) && a.uyeler.length ? a.uyeler : [a.uye];
    const list = [];
    for (const r of refs) {
      const m = findMember(r);
      if (!list.some((x) => x.session.id === m.session.id)) list.push(m);
    }
    if (new Set(list.map((m) => m.group.id)).size > 1) fail('Bir onay kartındaki üyeler aynı grupta olmalı; her grup için ayrı çağır.');
    gid = list[0].group.id;
    args = list.length > 1 ? { targets: list.map((m) => m.session.id) } : { target: list[0].session.id };
    if (a.model) args.model = a.model;
    if (a.effort) args.effort = a.effort;
    if (a.izin) {
      if (!PERMISSION_MODES.includes(a.izin)) fail(`izin yalnızca ${PERMISSION_MODES.join(', ')} olabilir.`);
      args.permissionMode = a.izin;
    }
    if (!args.model && !args.effort && !args.permissionMode) fail('ayar için model, effort ya da izin ver.');
  } else {
    const { group, session } = findMember(a.uye);
    gid = group.id;
    args = { target: session.id };
    if (kind === 'account') args.accountId = findAccount(a.hesap).id;
  }
  if (args.model && !MODELS.includes(args.model)) fail(`model yalnızca ${MODELS.join(', ')} olabilir.`);
  if (args.effort && !EFFORTS.includes(args.effort)) fail(`effort yalnızca ${EFFORTS.join(', ')} olabilir.`);
  let req;
  try { req = requests.create(gid, ACTOR, kind, args, reason); } catch (err) { fail(err.message); }
  pushEvent(`Asistan onay istedi (#${req.id}): ${a.tur} · ${clip(reason, 160)}`, ACTOR, gid);
  return `İstek #${req.id} grubun ekranında onay kartı olarak bekliyor; kullanıcı onaylayınca uygulanır.`;
}

const VIEWS = ['terms', 'map', 'time', 'msgs', 'board', 'notes', 'bekci'];

function toolEkran(a) {
  let hash;
  if (a.sayfa === 'ayarlar') hash = '#/ayarlar';
  else if (a.sayfa === 'projeler') hash = '#/';
  else if (a.uye) {
    const { group, session } = findMember(a.uye);
    hash = `#/g/${group.id}/${session.id}?view=terms`;
  } else if (a.grup) {
    const g = findGroup(a.grup);
    hash = `#/g/${g.id}${VIEWS.includes(a.gorunum) ? `?view=${a.gorunum}` : ''}`;
  } else fail('uye, grup ya da sayfa ver.');
  return nav(hash) ? 'Ekranda açıldı.' : 'Panel arayüzü açık değil; ekran değiştirilemedi.';
}

// ---------- zamanlayıcı ----------

const fmtAt = (ts) => new Date(ts).toLocaleString('tr-TR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const STEP_TEXT = { ac: 'aç', mesaj: 'mesaj', bekle: 'bekle', compact: 'compact', kapat: 'kapat' };

// Asistanın verdiği adımları doğrular ve motorun biçimine çevirir; önizleme satırlarını ve uyarıları da üretir.
function planSteps(a) {
  const list = Array.isArray(a.adimlar) ? a.adimlar : [];
  if (!list.length) fail('adimlar boş.');
  if (list.length > MAX_STEPS) fail(`En fazla ${MAX_STEPS} adım.`);
  const steps = [];
  const lines = [];
  const warns = [];
  // Önizlemede üyenin o adımda açık olup olmayacağı: şu anki durum + önceki ac / kapat adımları.
  const openAt = new Map();
  const isOpen = (sid) => (openAt.has(sid) ? openAt.get(sid) : manager.has(sid));
  for (const [i, raw] of list.entries()) {
    const no = `${i + 1}.`;
    const tur = String(raw.tur || '').trim();
    if (!STEP_TYPES.includes(tur)) fail(`${no} adım: tur ${STEP_TYPES.join(', ')} olmalı.`);
    const g = findGroup(raw.grup || a.grup);
    let sids = null;
    if (Array.isArray(raw.uyeler) && raw.uyeler.length) {
      sids = [];
      for (const ref of raw.uyeler) {
        const m = findMember(String(ref));
        if (m.group.id !== g.id) fail(`${no} adım: ${m.session.name} ${g.name} grubunda değil.`);
        if (!sids.includes(m.session.id)) sids.push(m.session.id);
      }
    }
    const members = (sids || g.sessions.filter((s) => !s.removed).map((s) => s.id)).map((sid) => g.sessions.find((s) => s.id === sid));
    const who = sids ? members.map((s) => `${s.roleLabel} [${shortId(s.id)}]`).join(', ') : `bütün üyeler (${members.length})`;
    const step = { tur, gid: g.id, uyeler: sids };
    let desc = '';
    if (tur === 'ac') {
      const closed = members.filter((s) => !isOpen(s.id));
      desc = closed.length ? `açılacak: ${closed.map((s) => s.roleLabel).join(', ')}` : 'açılacak kapalı üye yok (şu anki duruma göre)';
      for (const s of closed) {
        if (s.taskFile && !s.taskSent && !discovery.transcriptPath(sharedConfigDir(), s.id)) warns.push(`${no} ${s.roleLabel} hiç açılmamış; açılınca ilk görevine başlayacağı için zamanlayıcı onu açmaz.`);
        else if (hasDelivery(g.id, s.id, true)) warns.push(`${no} ${s.roleLabel}: bekleyen pano / not / mesaj iletimi var; açılınca okuyup çalışmaya başlar.`);
        openAt.set(s.id, true);
      }
    } else if (tur === 'mesaj') {
      step.metin = String(raw.metin || '').trim().slice(0, 8000);
      if (!step.metin) fail(`${no} adım: mesaj metni boş.`);
      step.cevap = !!raw.cevap_iste;
      desc = `"${clip(step.metin, 120)}"${step.cevap ? ' · cevap istenir (asistana_yanit)' : ''}`;
      const closed = members.filter((s) => !isOpen(s.id));
      if (closed.length) warns.push(`${no} ${closed.map((s) => s.roleLabel).join(', ')} o sırada kapalı olacak; mesaj ancak açılınca iletilir.`);
    } else if (tur === 'bekle') {
      const dk = Number(raw.dakika);
      if (dk > 0) {
        step.dakika = Math.min(Math.round(dk), 24 * 60);
        desc = `${step.dakika} dk`;
      } else {
        if (!['bosta', 'yanit'].includes(raw.kosul)) fail(`${no} adım: bekle için dakika ya da kosul (bosta / yanit) ver.`);
        step.kosul = raw.kosul;
        if (Number(raw.en_cok_dk) > 0) step.enCok = Math.min(Math.round(Number(raw.en_cok_dk)), 24 * 60);
        desc = `${raw.kosul === 'bosta' ? 'herkes boşta kalana kadar' : 'son mesajın cevapları gelene kadar'} (en çok ${step.enCok || (raw.kosul === 'bosta' ? 60 : 30)} dk)`;
      }
    } else if (tur === 'compact') {
      const parts = [];
      for (const s of members) {
        if (!isOpen(s.id)) {
          warns.push(`${no} ${s.roleLabel} o sırada kapalı olacak; compact'ı atlanır.`);
          continue;
        }
        const info = meter.sessionInfo(s.id) || {};
        const st = sessionStats(discovery.transcriptPath(sharedConfigDir(), s.id)) || {};
        const ctx = info.context || st.context || 0;
        if (!ctx) {
          parts.push(`${s.roleLabel} bağlam ölçümü yok`);
          continue;
        }
        const fam = info.fam || s.model || 'opus';
        const c = watch.costs(meter, ctx, fam);
        parts.push(`${s.roleLabel} ${k(ctx)} → ~${k(c.after)}, soğuksa ${watch.costText(meter, s.accountId, c.compactCold)}`);
      }
      desc = parts.join(' · ') || 'açık üye olmayacak';
      warns.push(`${no} compact önbellek soğuk olsa da yapılır (bağlam önbelleksiz okunur); maliyet yukarıda.`);
    } else if (tur === 'kapat') {
      if (Number(raw.en_cok_dk) > 0) step.enCok = Math.min(Math.round(Number(raw.en_cok_dk)), 24 * 60);
      desc = `yalnızca boştaki üyeler; çalışan üye en çok ${step.enCok || 30} dk beklenir, hâlâ çalışıyorsa kapatılmaz`;
      for (const s of members) openAt.set(s.id, false);
    }
    steps.push(step);
    lines.push(`${no} ${STEP_TEXT[tur]} · ${g.name} · ${who}${desc ? ` · ${desc}` : ''}`);
  }
  return { steps, lines, warns };
}

function toolZamanlayiciKur(a) {
  const now = Date.now();
  let at;
  try { at = parseWhen(a.zaman, now); } catch (err) { fail(err.message); }
  const { steps, lines, warns } = planSteps(a);
  const ad = clip(a.ad || '', 120) || 'Zamanlayıcı';
  const head = `"${ad}" · şimdi ${fmtAt(now)} · çalışma zamanı ${fmtAt(at)} (${mins(at - now)} sonra)`;
  const tail = ['Panel o saatte açık olmalı (bilgisayar uykuda olursa çalışmaz); panel adım ortasında kapanırsa iş yarıda kalır.'];
  if (!a.kesinlestir) {
    return [`ÖNİZLEME (kurulmadı): ${head}`, ...lines, ...(warns.length ? ['Uyarılar:', ...warns.map((w) => `- ${w}`)] : []), ...tail,
      'Bunu kullanıcıya göster; "tamam" derse aynı argümanlarla kesinlestir: true çağır.'].join('\n');
  }
  let job;
  try { job = scheduler.add({ ad, at, adimlar: steps }, now); } catch (err) { fail(err.message); }
  pushEvent(`Asistan zamanlayıcı kurdu (#${job.id}) "${ad}": ${fmtAt(at)}`, ACTOR, steps[0].gid);
  return [`Zamanlayıcı #${job.id} kuruldu: ${head}`, ...lines, ...tail].join('\n');
}

function scheduleView() {
  return scheduler.list().slice(-30).reverse().map((j) => ({
    id: j.id, ad: j.ad, at: j.at, durum: j.durum, durumText: SCHED_STATUS[j.durum] || j.durum, adim: j.adim, adimSayisi: j.adimlar.length,
    adimlar: j.adimlar.map((s) => STEP_TEXT[s.tur] || s.tur), kayit: j.kayit.slice(-6),
  }));
}

function cancelSchedule(id) {
  const job = scheduler.cancel(id);
  pushEvent(`Zamanlayıcı #${job.id} "${job.ad}" iptal edildi.`, 'zamanlayici', scheduler.gidOf(job));
  return job;
}

function toolZamanlayicilar(a) {
  const list = scheduleView().filter((j) => a.hepsi || ['bekliyor', 'calisiyor'].includes(j.durum));
  if (!list.length) return a.hepsi ? 'Hiç zamanlayıcı yok.' : 'Bekleyen ya da çalışan zamanlayıcı yok.';
  return list.map((j) => [
    `#${j.id} "${j.ad}" · ${fmtAt(j.at)} · ${j.durumText}${j.durum === 'calisiyor' ? ` (${j.adim + 1}/${j.adimSayisi}. adım)` : ''} · adımlar: ${j.adimlar.join(' → ')}`,
    ...j.kayit.map((x) => `  - ${when(x.ts)} ${x.uyari ? 'DİKKAT: ' : ''}${x.text}`),
  ].join('\n')).join('\n');
}

function toolZamanlayiciIptal(a) {
  try { cancelSchedule(Number(a.id)); } catch (err) { fail(err.message); }
  return `Zamanlayıcı #${a.id} iptal edildi.`;
}

// ---------- MCP ----------

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const UYE = { type: 'string', description: 'üyenin kimliği (panel_durumu\'ndaki 8 haneli kısa kimlik), tam adı, tek üyeye uyan rol ya da "grup/rol"' };
const GRUP = { type: 'string', description: 'grubun kısa kimliği ya da adının bir parçası' };

const TOOLS = [
  { name: 'panel_durumu', description: 'Açık grupların ve çalışan üyelerin anlık durumu: rol, hesap, ne yaptığı, model/effort, bağlam, önbellek, açık kartlar, süren bekçi hamlesi, bekleyen ayar. Kısa kimlikleri diğer tool\'larda kullan. Filtreler birleşir; çok üye varsa kompakt kullan.', inputSchema: obj({ grup: GRUP, hepsi: { type: 'boolean', description: 'çalışan üyesi olmayan grupları da ayrıntılı göster' }, hesap: { type: 'string', description: 'yalnız bu hesabın (kimlik ya da ad) açık üyeleri' }, durum: { type: 'string', enum: DURUMLAR, description: 'calisiyor: boşta olmayan (kullanıcı onayı bekleyenler dahil) açık üyeler · bosta: boştakiler' }, kompakt: { type: 'boolean', description: 'üye başına tek kısa satır: kimlik, rol, hesap, durum, bağlam %' } }) },
  { name: 'kota', description: 'Hesapların 5 saatlik ve haftalık kalan kotası, sıfırlanma ve tükenme tahmini, hesap başına açık üyeler (çalışıyor / boşta).', inputSchema: obj({}) },
  { name: 'hesap_ozeti', description: 'Tek çağrıda hesap başına kota (5 saat / hafta kalan, tükenme tahmini), açık üyeler (çalışıyor / boşta) ve risk seviyesi (kritik: dolu ya da sıfırlanmadan dolacak · uyarı: %20\'den az kaldı · normal) gerekçesiyle. "Hangi hesap sıkışık, kimi taşımalıyım" soruları için.', inputSchema: obj({}) },
  { name: 'tuketim', description: 'Son N saatte kim ne kadar harcadı: üye başına token ve tahmini kota yüzdesi (çoktan aza), hesap başına saatlik kota serisi. "Kim ne kadar yakıyor, kota neden bu kadar düştü" soruları için. Geçmiş en çok 7 gün, panel açıkken tutulur.', inputSchema: obj({ saat: { type: 'number', description: 'son kaç saat (varsayılan 24, en çok 168)' }, hesap: { type: 'string', description: 'yalnız bu hesap (kimlik ya da ad)' }, grup: GRUP, adet: { type: 'number', description: 'listelenecek üye sayısı (varsayılan 15)' } }) },
  { name: 'olaylar', description: 'Panelin son olayları (bekçi, panel, asistan), süren bekçi hamleleri, bekçinin bulguları ve kaydı, yardımcı model harcaması. "Ne oldu, bekçi neden X yaptı" soruları için.', inputSchema: obj({ grup: GRUP, adet: { type: 'number', description: 'olay sayısı (varsayılan 20)' } }) },
  { name: 'pano_oku', description: 'Grubun görev panosu kartları.', inputSchema: obj({ grup: GRUP, durum: { type: 'string', enum: ['todo', 'doing', 'review', 'done'] } }, ['grup']) },
  { name: 'notlar', description: 'Grubun notları: id yoksa liste (ara ile süz), id varsa notun tamamı.', inputSchema: obj({ grup: GRUP, id: { type: 'number' }, ara: { type: 'string' } }, ['grup']) },
  { name: 'uye_konusmasi', description: 'Bir üyenin son mesajları (gelen istemler ve kendi yazdıkları) ve ekibe gönderdiği son mesajlar. Üyeye soru sormadan önce buna bak; cevap buradaysa üyeyi rahatsız etme.', inputSchema: obj({ uye: UYE, adet: { type: 'number', description: 'mesaj sayısı (varsayılan 6, en çok 12)' } }, ['uye']) },
  { name: 'hamle_maliyeti', description: 'Bir üye için compact, yenileme ve her hesaba taşımanın tahmini kota maliyeti ve etkisi (bekçinin hesabıyla aynı). Hamle yapmadan önce çağır.', inputSchema: obj({ uye: UYE }, ['uye']) },
  { name: 'yanitlar', description: 'Üyelerin asistana_yanit ile verdiği cevaplar. Varsayılan: okunmamışlar (okundu işaretlenir).', inputSchema: obj({ hepsi: { type: 'boolean', description: 'okunmuşlar dahil son 20' } }) },
  { name: 'roller', description: 'Paneldeki roller: kimlik, ad, varsayılan model ve effort.', inputSchema: obj({}) },
  { name: 'bekci_hamlesi', description: 'Kullanıcının istediği bekçi hamlesini hemen sıraya alır (onay kartı yok): compact, yenile (devir notuyla sıfır bağlam), tasi (başka hesaba, kaldığı yerden) ya da iptal. Bekçi üye boşta kalınca uygular.', inputSchema: obj({ uye: UYE, hamle: { type: 'string', enum: ['compact', 'yenile', 'tasi', 'iptal'] }, hesap: { type: 'string', description: 'tasi için hedef hesap' } }, ['uye', 'hamle']) },
  { name: 'mesaj_gonder', description: 'Kullanıcının mesajını bir ya da birden çok üyeye iletir; üye bunu kullanıcının talimatı olarak okur. ton: normal (çalışıyorsa turu bitince, boştaysa hemen terminaline; tur açar), bilgi (tur açmaz, üyenin bir sonraki çalışmasına eklenir), acil (çalışan turu Esc ile keser ve hemen yazar). cevap_iste: üye cevabını asistana_yanit ile verir, yanitlar ile okunur. Şef dışındaki üyelere giden mesaj şefe bilgi notu olarak da geçer (sefe_bilgi:false kapatır).', inputSchema: obj({ uyeler: { type: 'array', items: { type: 'string' }, description: 'hedef üyeler (kimlik, ad ya da "grup/rol")' }, metin: { type: 'string' }, ton: { type: 'string', enum: TONES }, cevap_iste: { type: 'boolean' }, sefe_bilgi: { type: 'boolean' } }, ['uyeler', 'metin']) },
  { name: 'pano_ekle', description: 'Grubun panosuna kullanıcı adına kart ekler (yapılacak). atanan verilirse karta atanır ve üyeye iletilir.', inputSchema: obj({ grup: GRUP, baslik: { type: 'string' }, aciklama: { type: 'string' }, atanan: { type: 'string', description: 'gruptaki üye (ad ya da rol)' } }, ['grup', 'baslik']) },
  { name: 'onay_iste', description: 'Kullanıcı onayı gereken değişikliği grubun ekranına onay kartı olarak koyar: ayar (model / effort / izin modu; uyeler ile aynı gruptaki birden çok üyeye tek kart), kapat, cikar, hesap (başka hesaba), ekle (yeni üye). Onaylanınca panel uygular.', inputSchema: obj({ tur: { type: 'string', enum: Object.keys(REQ_KINDS) }, uye: UYE, uyeler: { type: 'array', items: { type: 'string' }, description: 'ayar için birden çok üye (aynı grupta)' }, grup: GRUP, izin: { type: 'string', enum: PERMISSION_MODES, description: 'ayar için izin modu: manual (her işlemde sorar), acceptEdits (düzenlemeleri kendisi kabul eder), auto (otomatik), plan' }, rol: { type: 'string', description: 'ekle için rol kimliği ya da adı' }, model: { type: 'string', enum: MODELS }, effort: { type: 'string', enum: EFFORTS }, hesap: { type: 'string' }, gorev: { type: 'string', description: 'ekle için ilk görev' }, gerekce: { type: 'string', description: 'onay kartında görünecek kısa gerekçe' } }, ['tur', 'gerekce']) },
  { name: 'zamanlayici_kur', description: 'Kullanıcının istediği işi ileri bir saate kurar; zamanı gelince panel adımları sırayla kendisi yürütür (asistanın açık olması gerekmez). Önce kesinlestir olmadan çağır: önizleme döner (gerçek saat, üyeler, maliyet, uyarılar). Önizlemeyi kullanıcıya göster, "tamam" derse aynı argümanlarla kesinlestir: true ile çağır.', inputSchema: obj({ ad: { type: 'string', description: 'kısa ad' }, zaman: { type: 'string', description: '"21:30", "yarın 08:00", "+90dk", "+2sa" ya da ISO tarih; sunucu yorumlar' }, grup: GRUP, adimlar: { type: 'array', items: { type: 'object', properties: {
      tur: { type: 'string', enum: STEP_TYPES, description: 'ac: kapalı üyeleri kaldığı yerden açar · mesaj: kullanıcı mesajı iletir · bekle: dakika ya da kosul · compact: soğuk önbellekte de yapılır · kapat: yalnızca boştaki üyeleri kapatır' },
      grup: GRUP, uyeler: { type: 'array', items: { type: 'string' }, description: 'boşsa grubun bütün üyeleri' },
      metin: { type: 'string', description: 'mesaj için' }, cevap_iste: { type: 'boolean', description: 'mesaj için: üye asistana_yanit ile cevaplar' },
      dakika: { type: 'number', description: 'bekle: sabit süre' }, kosul: { type: 'string', enum: ['bosta', 'yanit'], description: 'bekle: herkes boşta kalana ya da son mesajın cevapları gelene kadar' },
      en_cok_dk: { type: 'number', description: 'bekle (kosul) ve kapat için en uzun bekleme' },
    }, required: ['tur'] } }, kesinlestir: { type: 'boolean' } }, ['zaman', 'adimlar']) },
  { name: 'zamanlayicilar', description: 'Kurulu zamanlayıcılar: saat, durum, adımlar ve yürütme kaydı (uyarılar dahil).', inputSchema: obj({ hepsi: { type: 'boolean', description: 'bitmiş / iptal edilmişler dahil' } }) },
  { name: 'zamanlayici_iptal', description: 'Bekleyen ya da çalışan bir zamanlayıcıyı iptal eder.', inputSchema: obj({ id: { type: 'number' } }, ['id']) },
  { name: 'ekrani_ac', description: 'Kullanıcının panel arayüzünde bir ekranı açar: üyenin terminali, grubun bir görünümü ya da ayarlar / projeler sayfası.', inputSchema: obj({ uye: UYE, grup: GRUP, gorunum: { type: 'string', enum: VIEWS }, sayfa: { type: 'string', enum: ['ayarlar', 'projeler'] } }) },
];

const CALLS = {
  panel_durumu: toolDurum, kota: toolKota, hesap_ozeti: toolHesapOzeti, tuketim: toolTuketim, olaylar: toolOlaylar, pano_oku: toolPano, notlar: toolNotlar, uye_konusmasi: toolKonusma,
  hamle_maliyeti: toolMaliyet, yanitlar: toolYanitlar, roller: toolRoller, bekci_hamlesi: toolHamle, mesaj_gonder: toolMesaj,
  pano_ekle: toolKart, onay_iste: toolOnay, ekrani_ac: toolEkran,
  zamanlayici_kur: toolZamanlayiciKur, zamanlayicilar: toolZamanlayicilar, zamanlayici_iptal: toolZamanlayiciIptal,
};

function handle(msg) {
  return handleMcp(boards, null, rec.id, msg, {
    tools: TOOLS,
    only: true,
    instructions: 'Claude Panel asistan tool\'ları: panelin durumu, kota, olaylar, pano ve notları okuma; kullanıcının isteğiyle mesaj, bekçi hamlesi, pano kartı ve onay kartı.',
    call: async (name, args) => {
      const fn = CALLS[name];
      if (!fn) throw new ToolError(`Bilinmeyen tool: ${name}`);
      return fn(args || {});
    },
  });
}

// ---------- üyelerin cevap tool'u ----------

const REPLY_TOOL = {
  name: 'asistana_yanit',
  description: 'Yalnızca "[Claude Panel · Kullanıcı]" mesajı senden cevap istediğinde çağır: cevabın kullanıcının panel asistanına iletilir. Kısa ve net yaz.',
  inputSchema: obj({ cevap: { type: 'string' } }, ['cevap']),
};

function reply(sid, args) {
  const text = String((args && args.cevap) || '').trim();
  if (!text) throw new ToolError('cevap boş.');
  const found = findSession(store.loadGroups(), sid);
  if (!found) throw new ToolError('Oturum bir panel grubunda değil.');
  inbox.reply(sid, found.session.name, found.group.name, text);
  return 'Cevabın kullanıcıya iletildi.';
}

module.exports = { accountRisk, keepMember, openText, isAssistant, status, open, stop, handle, setNav, REPLY_TOOL, reply, TOOLS, findMember, findGroup, scheduleView, cancelSchedule };
