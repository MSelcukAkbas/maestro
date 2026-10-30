// Maestro arayüzü · Bekçi görünümü (grubun çalışma ekranında).
// web/js/ altındaki dosyalar index.html'deki sırayla yüklenen klasik script'lerdir; üst düzey bildirimler ortak
// global kapsamdadır. Yüklenirken çalışan kod yalnızca kendinden önceki dosyaları kullanabilir.
'use strict';
// ---------- bekçi (grubun çalışma ekranında "Bekçi" görünümü) ----------

const OP_TEXT = { compact: 'compact', move: 'hesap taşıma', renew: 'yenileme (devir notu, sıfır context)' };
const OP_STATE = {
  queued: 'uygun an bekleniyor (üye boşta ve cache sıcakken)',
  sent: 'compact sürüyor',
  asked: 'devir notu bekleniyor',
  noted: 'devir notu alındı, eski oturum kapanıyor',
  starting: 'yeni oturum açılıyor',
};

function sessionById(sid) {
  for (const g of state.groups) {
    const s = g.sessions.find((x) => x.id === sid);
    if (s) return { g, s };
  }
  return null;
}
function when(ts) {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? '' : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} `}${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// Karar geçmişi kaydının türü, metnin önekinden.
function logKind(x) {
  if (x.key === 'helper') return x.level === 'yüksek' ? ['yardımcı model hatası', 'danger'] : ['yardımcı model', 'idle'];
  const m = /^(karar|tamamlandı|olmadı|iptal):/.exec(x.text);
  return m ? { karar: ['karar', 'idle'], 'tamamlandı': ['yapıldı', 'busy'], 'olmadı': ['olmadı', 'danger'], iptal: ['iptal', ''] }[m[1]] : ['kayıt', ''];
}
// Grubun bekçi ayarı: genel ayar (Ayarlar → Genel) üstüne grubun kendi açık/kapalı seçimleri.
function groupWatch(g) {
  return { ...WATCH_DEFAULTS, ...((state.settings && state.settings.watch) || {}), ...((g && g.watch) || {}) };
}
function bekciModeText(cfg) {
  return !cfg.enabled ? 'kapalı' : !cfg.act ? 'öneri modu: hamleleri uygulamaz, yalnızca bildirir' : `hamleleri kendisi yapar · karar: ${cfg.ai ? 'Haiku' : 'panel kuralları'}`;
}

const Bekci = {
  // Çalışma ekranının #activity kutusuna grubun bekçi görünümünü çizer.
  async refresh(g) {
    if (this.loading || (this.gid === g.id && Date.now() - this.loadedAt < 5000 && $('.bk-page'))) return;
    this.loading = true;
    try {
      this.data = await api('GET', `/api/watch?g=${encodeURIComponent(g.id)}`);
      this.gid = g.id;
      this.loadedAt = Date.now();
    } catch (err) {
      $('#activity').innerHTML = `<div class="empty">Bekçi bilgisi alınamadı: ${esc(err.message)}</div>`;
      return;
    } finally {
      this.loading = false;
    }
    this.render(g);
  },

  // Görünümdeki düğmeler: grup ayarı ve işlem iptali. Çalışma ekranı açılırken bir kez bağlanır.
  bind(box, group) {
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-bk-cancel]');
      if (!b) return;
      b.disabled = true;
      if (await act(() => api('POST', `/api/watch/ops/${b.dataset.bkCancel}/cancel`), 'İşlem iptal edildi.')) {
        this.loadedAt = 0;
        this.refresh(group());
      } else b.disabled = false;
    });
    box.addEventListener('change', async (e) => {
      const k = e.target.dataset && e.target.dataset.bkSet;
      if (!k) return;
      const g = group();
      if (await act(() => api('PUT', `/api/groups/${g.id}/watch`, { [k]: e.target.checked }), 'Bu grubun bekçi ayarı kaydedildi.')) {
        await refresh().catch(() => {});
        this.loadedAt = 0;
        this.refresh(group());
      } else e.target.checked = !e.target.checked;
    });
  },

  render(g) {
    const d = this.data;
    const cfg = d.settings || {};
    const box = $('#activity');
    const now = Date.now();
    const log = d.log || [];
    const day = log.filter((x) => now - x.ts < 24 * 3600 * 1000);
    const helper = day.filter((x) => x.helper);
    const cost = helper.reduce((a, x) => a + (x.helper.costUSD || 0), 0);
    const tok = helper.reduce((a, x) => a + Object.values(x.helper.tokens || {}).reduce((p, v) => p + v, 0), 0);
    const ops = d.ops || [];
    const cands = d.cands || [];
    const notes = (d.findings || []).filter((f) => !f.lead);
    const toLead = log.filter((x) => x.lead).slice(-20).reverse();
    const history = log.filter((x) => x.key && (x.key.startsWith('op:') || x.key === 'helper')).slice(-100).reverse();
    const who = (sid) => {
      const f = sessionById(sid);
      return f ? `<strong>${esc(f.s.roleLabel)}</strong> <span class="note">${esc(f.s.name)}</span>` : `<span class="note">${esc(sid)}</span>`;
    };
    const stat = (label, value, sub) => `<div class="card bk-stat"><span class="note">${label}</span><strong>${value}</strong>${sub ? `<span class="note">${sub}</span>` : ''}</div>`;
    const toggle = (k, label) => `<label class="check bk-toggle"><input type="checkbox" data-bk-set="${k}" ${cfg[k] ? 'checked' : ''}>${label}</label>`;
    const own = d.groupWatch || {};
    const keepScroll = box.scrollTop;
    box.innerHTML = `
        <div class="bk-page">
          <div class="bk-head">
            <div>
              <h2>Bekçi</h2>
              <div class="note">Bu grubun kota ve context düzenini yönetir: compact, hesap taşıma ve yenilemeyi kendisi yapar; şefe yalnızca proje kararı gerektiren durumları yazar.</div>
            </div>
            <div class="actions">${toggle('enabled', 'Açık')}${toggle('act', 'Hamleleri kendisi yapsın')}${toggle('ai', 'Kararı Haiku versin')}
              <a class="btn small ghost" href="#/ayarlar/genel" title="Eşikler ve yeni grupların varsayılanı">Eşikler</a></div>
          </div>
          ${Object.keys(own).length ? '<div class="note">Bu grup için ayrı ayar yapıldı; diğer gruplar Ayarlar → Genel\'deki varsayılanı kullanır.</div>' : ''}
          <div class="bk-stats">
            ${stat('Durum', cfg.enabled ? 'Açık' : 'Kapalı', esc(bekciModeText(cfg)))}
            ${stat('Süren işlem', ops.length, ops.length ? esc(ops.map((o) => OP_TEXT[o.kind]).join(', ')) : 'yok')}
            ${stat('Son 24 saatte yapılan', day.filter((x) => x.text.startsWith('tamamlandı:')).length, `${day.filter((x) => x.text.startsWith('olmadı:')).length} olmadı`)}
            ${stat('Yardımcı model (24 sa)', `${helper.length} çağrı`, `${tok.toLocaleString('tr-TR')} token · ≈$${cost.toFixed(4)}`)}
            ${stat('Şefe yazılan (24 sa)', day.filter((x) => x.lead).length, 'yalnızca proje kararı gerektirenler')}
          </div>

          <section class="section">
            <div class="section-head"><h2>Öneriler</h2><span class="count">şu an hamle gerektiren üyeler</span></div>
            ${cands.length ? `<div class="card bk-list">${cands.map((c) => {
            const op = ops.find((o) => o.sid === c.sid);
            return `
                <div class="bk-item">
                  <div class="bk-line">${who(c.sid)}<span class="grow"></span>${op ? `<span class="badge busy">işlemde: ${esc(OP_TEXT[op.kind])}</span>` : ''}</div>
                  <div class="note">${esc(c.why)}</div>
                  <ul class="bk-opts">${c.options.map((o) => `<li>${o.id === c.def ? '<span class="badge idle">kural önerisi</span> ' : ''}${esc(o.text)}</li>`).join('')}</ul>
                </div>`;
          }).join('')}</div>` : '<div class="empty">Şu an hamle gerektiren üye yok.</div>'}
          </section>

          <section class="section">
            <div class="section-head"><h2>Süren işlemler</h2></div>
            ${ops.length ? `<div class="card bk-list">${ops.map((o) => `
              <div class="bk-item">
                <div class="bk-line">${who(o.sid)}<span class="badge">${esc(OP_TEXT[o.kind])}${o.then ? ' + taşıma' : ''}${o.accountId ? ` → ${esc(o.accountId)}` : ''}</span><span class="grow"></span>
                  <button class="btn small ghost" data-bk-cancel="${esc(o.sid)}" ${['noted', 'starting'].includes(o.state) ? 'disabled title="Son aşamada, iptal edilemez"' : ''}>İptal</button></div>
                <div class="note">${esc(OP_STATE[o.state] || o.state)} · ${esc(when(o.at))}'den beri · karar: ${esc(o.by || '')} · ${esc(o.why || '')}</div>
              </div>`).join('')}</div>` : '<div class="empty">Süren işlem yok.</div>'}
          </section>

          <section class="section">
            <div class="section-head"><h2>Şefe yazılanlar</h2><span class="count">proje kararı gerektiren durumlar</span></div>
            ${toLead.length ? `<div class="card bk-list">${toLead.map((x) => `
              <div class="bk-item"><div class="bk-line"><span class="badge ${x.level === 'kritik' ? 'danger' : 'warn'}">${esc(x.level)}</span><span class="note">${esc(when(x.ts))}</span></div><div>${esc(x.text)}</div></div>`).join('')}</div>`
            : '<div class="empty">Şefe yazılan bir şey yok.</div>'}
          </section>

          <section class="section">
            <div class="section-head"><h2>Karar geçmişi</h2><span class="count">son ${history.length} kayıt</span></div>
            ${history.length ? `<div class="card bk-list">${history.map((x) => {
            const [label, cls] = logKind(x);
            return `<div class="bk-item"><div class="bk-line"><span class="badge ${cls}">${esc(label)}</span><span class="note">${esc(when(x.ts))}</span></div><div>${esc(x.text.replace(/^(karar|tamamlandı|olmadı|iptal): /, ''))}</div></div>`;
          }).join('')}</div>` : '<div class="empty">Henüz karar yok.</div>'}
          </section>

          ${notes.length ? `
          <section class="section">
            <div class="section-head"><h2>Gözlemler</h2><span class="count">kayda geçen, hamle gerektirmeyen durumlar</span></div>
            <div class="card bk-list">${notes.map((f) => `<div class="bk-item"><div>${esc(f.text)}</div></div>`).join('')}</div>
          </section>` : ''}
        </div>`;
    box.scrollTop = keepScroll;
  },
};
