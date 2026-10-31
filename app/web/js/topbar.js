// Maestro arayüzü · Üst çubuk: kota açılır penceresi ve bildirim kutusu.
// web/js/ altındaki dosyalar index.html'deki sırayla yüklenen klasik script'lerdir; üst düzey bildirimler ortak
// global kapsamdadır. Yüklenirken çalışan kod yalnızca kendinden önceki dosyaları kullanabilir.
'use strict';
// ---------- kota ----------

const quotaBtn = $('#quota-btn');
const quotaPop = $('#quota-pop');

function closeQuota() {
  quotaPop.hidden = true;
  quotaBtn.setAttribute('aria-expanded', 'false');
}

async function openQuota() {
  quotaPop.hidden = false;
  quotaBtn.setAttribute('aria-expanded', 'true');
  quotaPop.innerHTML = '<div class="note">Kota çekiliyor…</div>';
  try {
    const [q, m] = await Promise.all([getQuota(true), api('GET', '/api/meter').catch(() => null)]);
    const t = new Date(q.fetchedAt);
    // Panelin kendi model çağrıları (bekçi yardımcısı, kurulum danışmanı, rol danışmanı, mesaj geliştirici): oturum kaydı bırakmazlar.
    const lg = m && m.ledger && m.ledger.day;
    const kinds = lg ? Object.entries(lg.byKind) : [];
    const ledgerHtml = kinds.length ? `
        <div class="q-row" title="${esc(kinds.map(([k, v]) => `${k}: ${v.calls} çağrı, $${v.usd.toFixed(3)}${v.failed ? `, ${v.failed} hatalı` : ''}`).join('\n'))}">
          <div class="top"><span>Panelin model çağrıları</span><span class="note">son 24 saat</span></div>
          <div class="note">${kinds.reduce((a, [, v]) => a + v.calls, 0)} çağrı · $${lg.usd.toFixed(3)} · ${esc(kinds.map(([k]) => k).join(', '))}</div>
        </div>` : '';
    const line = (label, b) => {
      if (!b) return '';
      const left = Math.max(0, 100 - b.used);
      const low = left < 15 || b.severity === 'critical';
      return `
          <div class="q-line">
            <span class="note">${label}</span>
            <div class="bar"><span class="${low ? 'low' : ''}" style="width: ${Math.max(2, left)}%"></span></div>
            <span${low ? ' style="color: var(--danger)"' : ''}>%${Math.round(left)} kaldı</span>
          </div>
          <div class="note q-reset">${b.resetsAt ? `sıfırlanma ${esc(fmtDate(b.resetsAt))}` : 'pencere başlamadı'}${forecastText(b)}</div>`;
    };
    // "Bu hızla" tahmini: sıfırlanmadan önce biterse kırmızı.
    function forecastText(b) {
      const f = b.forecast;
      if (!f || b.used >= 100) return '';
      if (!f.eta) return f.basis === 'pencere yeni' ? ' · pencere yeni, tahmin için erken' : ' · henüz kullanım yok';
      if (!f.beforeReset) return ' · <span style="color: var(--accent)">bu hızla yeter</span>';
      return ` · <span style="color: var(--danger)">bu hızla ${esc(fmtDate(new Date(f.eta).toISOString()))}'de biter</span>`;
    }
    quotaPop.innerHTML = `
        <div class="kv"><strong>Kalan kota</strong><span class="note">${pad(t.getHours())}:${pad(t.getMinutes())}'de çekildi</span></div>
        ${q.rows.map((r) => `
          <div class="q-row">
            <div class="top"><span>${esc(r.name)}</span>${r.blocked
            ? `<span class="badge" style="color: var(--danger); border-color: var(--danger-line)">dolu · ${esc(fmtDate(r.blockedUntil))}'de açılır</span>`
            : r.status !== 'canlı' ? `<span class="note">${esc(r.status)}</span>` : ''}</div>
            ${line('5 saat', r.five)}
            ${line('7 gün', r.week)}
          </div>`).join('')}
        ${ledgerHtml}
        <button class="btn small" id="quota-again">↻ Yeniden çek</button>`;
    $('#quota-again').addEventListener('click', openQuota);
  } catch (err) {
    quotaPop.innerHTML = `<div class="note">Kota alınamadı: ${esc(err.message)}</div>`;
  }
}

quotaBtn.addEventListener('click', () => {
  closeNotif();
  if (quotaPop.hidden) openQuota();
  else closeQuota();
});
document.addEventListener('click', (e) => {
  if (!quotaPop.hidden && !e.target.closest('.quota-wrap')) closeQuota();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !quotaPop.hidden) closeQuota();
});

// ---------- bildirim kutusu ----------

// Panelin ve yardımcı modellerin bildirimleri. Okunmamış sayısı bu tarayıcıda son açılış zamanına göre tutulur.
const NOTIF_SEEN_KEY = 'maestro-notif-seen';
const notifBtn = $('#notif-btn');
const notifPop = $('#notif-pop');
let notifShownTop = 0;

const notifSeen = () => Number(store(NOTIF_SEEN_KEY)) || 0;

function updateNotifCount() {
  const n = ((state && state.events) || []).filter((e) => e.ts > notifSeen()).length;
  const el = $('#notif-count');
  el.hidden = !n;
  el.textContent = n > 99 ? '99+' : String(n);
}

function renderNotif(seenBefore) {
  const evs = ((state && state.events) || []).slice().reverse().slice(0, 50);
  notifShownTop = evs.length ? evs[0].id : 0;
  // Çalışan her grubun bekçisi ayrı satır (ayar bütün gruplar için tek), tıklayınca o grubun Bekçi görünümü.
  const active = ((state && state.groups) || []).filter((g) => g.state === 'active');
  const gName = (gid) => ((state.groups || []).find((g) => g.id === gid) || {}).name;
  const bekciHref = (gid) => `#/g/${encodeURIComponent(gid)}?view=bekci`;
  notifPop.innerHTML = `
      <div class="kv"><strong>Bildirimler</strong><span class="note">panel ve yardımcı modeller</span></div>
      ${active.map((g) => {
      const cfg = watchCfg();
      return `<a class="notif-helper" href="${bekciHref(g.id)}"><span class="dot ${cfg.enabled ? 'busy' : ''}"></span><span><strong>Bekçi · ${esc(g.name)}</strong><span class="note">${esc(bekciModeText(cfg))}</span></span><span class="grow"></span>${ICON_CHEV}</a>`;
    }).join('')}
      <div class="notif-list">${evs.length ? evs.map((e) => {
      // Kaynak etiketi (bekçi / notlar / panel) ve olayın grubu; grubu olan olay o grubun ilgili ekranına götürür.
      const bk = e.source === 'bekci';
      const gn = e.gid && gName(e.gid);
      const href = e.gid && gn ? (bk ? bekciHref(e.gid) : e.source === 'notlar' ? `#/g/${encodeURIComponent(e.gid)}?view=notes` : `#/g/${encodeURIComponent(e.gid)}`) : null;
      const label = `${bk ? 'Bekçi' : { notlar: 'Notlar' }[e.source] || 'Panel'}${gn ? ` · ${gn}` : ''}`;
      const inner = `<div class="bk-line"><span class="badge ${bk ? 'idle' : ''}">${esc(label)}</span><span class="note">${esc(when(e.ts))}</span></div><div>${esc(e.text)}</div>`;
      const cls = `notif-item${e.ts > seenBefore ? ' new' : ''}`;
      return href ? `<a class="${cls}" href="${href}">${inner}</a>` : `<div class="${cls}">${inner}</div>`;
    }).join('') : '<div class="note" style="padding: 9px 2px">Henüz bildirim yok.</div>'}</div>`;
}

function closeNotif() {
  notifPop.hidden = true;
  notifBtn.setAttribute('aria-expanded', 'false');
}

function openNotif() {
  closeQuota();
  notifPop.hidden = false;
  notifBtn.setAttribute('aria-expanded', 'true');
  const seenBefore = notifSeen();
  renderNotif(seenBefore);
  const evs = (state && state.events) || [];
  if (evs.length) store(NOTIF_SEEN_KEY, String(Math.max(seenBefore, ...evs.map((e) => e.ts))));
  updateNotifCount();
}

notifBtn.addEventListener('click', () => (notifPop.hidden ? openNotif() : closeNotif()));
notifPop.addEventListener('click', (e) => { if (e.target.closest('a')) closeNotif(); });
document.addEventListener('click', (e) => {
  if (!notifPop.hidden && !e.target.closest('#notif-pop, #notif-btn')) closeNotif();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !notifPop.hidden) closeNotif();
});
