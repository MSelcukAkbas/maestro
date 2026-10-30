// Zamanlayıcının panele bağlanması (motor: team/schedule.js). Üye açma launch.js, iletim gelen kutusu, compact
// bekçinin hamle kuyruğu üzerinden yürür; zamanlayıcı kendi başına oturuma yazmaz.
const store = require('../core/store');
const { discovery } = require('../../agent');
const { Scheduler } = require('../team/schedule');
const {
  manager, inbox, ops, meter, sharedConfigDir, sessionStatus, pushEvent,
} = require('./context');
const { launchSession } = require('./launch');
const { hasDelivery } = require('./delivery');

const groupOf = (gid) => store.loadGroups().find((g) => g.id === gid && !g.archived) || null;

// Yenilenen üyenin yerine açılan (zincir boyunca); çıkarılan üye null.
function resolve(gid, sid) {
  const g = groupOf(gid);
  if (!g) return null;
  let s = g.sessions.find((x) => x.id === sid);
  for (let i = 0; s && s.renewedTo && i < 20; i++) s = g.sessions.find((x) => x.id === s.renewedTo);
  return s && !s.removed ? s : null;
}

const scheduler = new Scheduler(store.DATA_DIR, {
  group: groupOf,
  resolve,
  members: (gid) => {
    const g = groupOf(gid);
    return g ? g.sessions.filter((s) => !s.removed) : [];
  },
  status: (sid) => {
    if (!manager.has(sid)) return 'off';
    try { return sessionStatus({ id: sid }, discovery.liveSessions(sharedConfigDir())).status; } catch { return 'starting'; }
  },
  delivering: (gid, sid) => hasDelivery(gid, sid, true),
  firstTask: (s) => !!(s.taskFile && !s.taskSent && !discovery.transcriptPath(sharedConfigDir(), s.id)),
  launch: (gid, sid) => {
    const g = groupOf(gid);
    const s = g && g.sessions.find((x) => x.id === sid);
    if (!s) throw new Error('üye bulunamadı');
    if (!manager.has(sid)) launchSession(g, s, { resume: true });
  },
  stop: (sid) => manager.stop(sid),
  send: (sid, text, ask) => inbox.send(sid, text, ask),
  compact: (gid, sid) => ops.add({ sid, gid, kind: 'compact', accountId: null, why: 'zamanlayıcı (kullanıcının isteği)', by: 'zamanlayıcı', force: true, cold: true }),
  op: (sid) => ops.get(sid),
  cancelOp: (sid) => ops.cancel(sid),
  compacts: (sid) => (meter.sessionInfo(sid) || {}).compacts || 0,
  repliedSince: (sid, ts) => inbox.repliedSince(sid, ts),
  event: (text, gid) => pushEvent(text, 'zamanlayici', gid),
});

module.exports = { scheduler, resolve };
