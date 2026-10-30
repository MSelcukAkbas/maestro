// Arayüzün okuduğu görünümler: panel durumu (/api/state ve durum kanalı), grup içi mesajlar ve açılışta başlatma kısayolu.
const fs = require('fs');
const path = require('path');

const store = require('../core/store');
const { discovery } = require('../../agent');
const { sessionStats, sessionMessages } = require('../core/usage');
const { KIND_TEXT, describe: describeRequest } = require('../team/team');
const { AWAY_MS } = require('../session/presence');
const {
  ROOT, settings, manager, requests, timeline, presence, ledger, pending, events, HttpError, sharedConfigDir, sessionStatus, USER_TL,
} = require('./context');
const { launchDrift } = require('./launch');
const assistant = require('./assistant');

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
    assistant: assistant.status(live),
    agent: { connected: manager.connected },
  };
}

const STARTUP_LINK = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Maestro.lnk');
const HIDDEN_LAUNCHER = path.join(ROOT, 'Maestro-Arkaplan.vbs');

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
    '$s.Description = "Maestro (arka planda)"',
    '$s.Save()',
  ].join('; ');
  const r = require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new HttpError(500, `Kısayol oluşturulamadı: ${(r.stderr || '').trim().slice(0, 300)}`);
}

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

module.exports = { buildState, STARTUP_LINK, setAutostart, groupActivity };
