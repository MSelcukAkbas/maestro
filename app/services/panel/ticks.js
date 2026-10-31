// Zamanlı işler: bekleyen ayar değişikliklerinin uygulanması, zaman çizelgesi örneklemesi ve bekçi.
// Zamanlayıcılar index.js'te kurulur; bu dosya yalnızca tik fonksiyonlarını verir.
const store = require('../core/store');
const { discovery } = require('../../agent');
const { ctxLimits } = require('../watch/watch');
const { asksUser } = require('../watch/ops');
const helper = require('../watch/helper');
const {
  settings, manager, timeline, meter, watch, presence, pending, ops,
  sharedConfigDir, findSession, sessionStatus, pushEvent, runningLead, pasteTo, lastQuota, trustsDir,
  USER_TL, watchCfg, lastText, whenStopped,
} = require('./context');
const { launchSession } = require('./launch');
const { hasDelivery } = require('./delivery');
const { memberSnapshot } = require('./members');

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
    const what = [p.model ? `model ${p.model}` : '', p.effort ? `effort ${p.effort}` : '', p.perm ? `izin ${p.perm}` : '', p.caps ? 'yetenekler' : ''].filter(Boolean).join(', ') || 'ayar';
    pushEvent(`${session.name}: ${what} için kaldığı yerden yeniden açılıyor.`, 'panel', group.id);
    manager.stop(sid);
    whenStopped(sid, (err) => {
      if (err) return console.error(`[panel] ${session.name}:`, err.message);
      try { launchSession(group, session, { resume: true }); } catch (e) { console.error(`[panel] ${session.name}:`, e.message); }
    });
  }
}

// Önceki çalışma düzgün kapanmadıysa açık kalan izler panelin son ayakta olduğu ana "kapalı" olarak kapatılır.
// Düzgün kapanışta izler zaten "kapalı"dır; record aynı durumu yeniden yazmaz.
let gapClosed = false;
function closeGap() {
  gapClosed = true;
  const t = timeline.lastAlive;
  if (!t) return;
  for (const g of store.loadGroups()) {
    let changed = false;
    for (const s of g.sessions) if (timeline.record(g.id, s.id, 'off', t)) changed = true;
    if (changed) timeline.save(g.id);
  }
  if (timeline.record(USER_TL, 'user', 'off', t)) timeline.save(USER_TL);
}

function sampleTimeline() {
  if (!gapClosed) closeGap();
  timeline.beat();
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

// Bekçi: dakikada bir kuralları değerlendirir. Proje kararı gerektiren durumları şefe yapıştırır; panel ortamıyla ilgili
// hamle adaylarını yardımcı modele (kapalıysa ya da yanıt geçersizse kural varsayılanına) seçtirip uygular.
// Kota, son ölçümden (en çok 10 dk eski) okunur.
const HOLD_WAIT = 10 * 60 * 1000;
const HOLD_SUGGEST = 30 * 60 * 1000;
// Yardımcı model grup başına sorulur; bir grubun sorusu sürerken o grubun adayları bir sonraki dakikaya kalır.
const helperBusy = new Set();

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
      const lim = ctxLimits(m.session, m.info, settings, watchCfg());
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
  const cfg = watchCfg();
  if (!cfg.enabled) return;
  const groups = store.loadGroups().filter((g) => g.sessions.some((s) => !s.removed && manager.has(s.id)));
  if (!groups.length) return;
  const live = discovery.liveSessions(sharedConfigDir());
  const input = {
    groups: groups.map((g) => ({
      group: g,
      lead: runningLead(g),
      members: memberSnapshot(g, live).map((m) => ({ session: m.session, status: m.status, info: m.info })),
    })),
    quota: lastQuota() && Date.now() - lastQuota().fetchedAt < 10 * 60 * 1000 ? lastQuota() : null,
    meter, accounts: settings.accounts, settings: { ...settings, watch: cfg },
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
        applyDecisions(helper.validate(todo, r.decisions), watchCfg());
      })
      .catch((err) => {
        console.error('[panel] yardımcı model:', err.message);
        watch.note({ gid: g.id, key: 'helper', level: 'yüksek', text: `yardımcı model yanıt vermedi, kural varsayılanı kullanıldı: ${err.message}` });
        applyDecisions(helper.validate(todo, []), watchCfg());
      })
      .finally(() => { helperBusy.delete(g.id); });
  }
}

module.exports = { pendingTick, sampleTimeline, watchTick };
