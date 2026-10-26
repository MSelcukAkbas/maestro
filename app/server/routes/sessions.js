// Üye işlemleri: durdur / başlat / yeniden aç / çıkar, hesap ve ayar değişikliği, sıfır bağlamla yenileme,
// şefin isteklerine onay / ret ve bekçi işleminin iptali.
const store = require('../core/store');
const { KIND_TEXT, describe: describeRequest } = require('../team/team');
const {
  settings, manager, requests, watch, ops, HttpError, cleanText, findSession, pushEvent, runningLead, pasteTo, whenStopped,
} = require('../panel/context');
const {
  switchAccount, changeSettings, cancelSettings, launchSession, renewSession, openInWindowsTerminal,
} = require('../panel/launch');
const { execRequest } = require('../panel/members');
const { route, readBody } = require('../panel/http');

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
