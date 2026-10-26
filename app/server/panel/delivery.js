// Görev panosu, grup notu, ekip isteği sonucu ve bekçi notlarının üyelere iletilmesi: tur biterken hook yanıtıyla
// (boardDelivery) ya da boştaysa terminaline yapıştırarak (boardIdleTick).
const discovery = require('../core/discovery');
const {
  hookState, manager, boards, notes, requests, ops, sharedConfigDir, findSession, sessionStatus, runningLead, pasteTo,
} = require('./context');
const store = require('../core/store');

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

module.exports = { hasDelivery, boardDelivery, boardIdleTick };
