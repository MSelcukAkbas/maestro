// Ekip yönetimi: üyelerin anlık görüntüsü (bekçi ve ekip_durumu), rol yetenekleri ve şefin onaylanan isteklerinin uygulanması.
const store = require('../core/store');
const discovery = require('../core/discovery');
const { sessionStats } = require('../core/usage');
const { MODELS } = require('../core/options');
const {
  settings, manager, caps, meter, pending, HttpError, sharedConfigDir, sessionStatus, lastQuota, quotaLeft,
} = require('./context');
const { addSessionToGroup, switchAccount, changeSettings } = require('./launch');

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
      const best = lastQuota() && lastQuota().rows.map((r) => [r.accountId, quotaLeft(r)]).filter(([, v]) => v != null && v > 0).sort((x, y) => y[1] - x[1])[0];
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

module.exports = { memberSnapshot, memberRows, roleCaps, capCatalogFor, execRequest };
