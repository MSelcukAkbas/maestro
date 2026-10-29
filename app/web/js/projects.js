// Claude Panel arayüzü · Projeler listesi ve proje sayfası.
// web/js/ altındaki dosyalar index.html'deki sırayla yüklenen klasik script'lerdir; üst düzey bildirimler ortak
// global kapsamdadır. Yüklenirken çalışan kod yalnızca kendinden önceki dosyaları kullanabilir.
'use strict';
// ---------- 1 · projeler ----------

const ProjectsView = {
  mount() {
    crumbs([{ label: 'Projeler' }]);
    app.innerHTML = `
        <div class="page">
          <div class="page-head">
            <div>
              <h1>Proje seç</h1>
              <p class="sub">Oturumlar, seçtiğin projenin klasöründe açılır.</p>
            </div>
            <form class="actions" id="add-form">
              <input id="add-path" aria-label="Klasör yolu" placeholder="C:\\Users\\akbas\\Desktop\\proje" style="width: 288px; max-width: 100%" class="mono" autocomplete="off">
              <button class="btn primary" type="submit">Klasör ekle</button>
            </form>
          </div>
          <div id="proj-grid"></div>
        </div>`;
    $('#add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#add-path');
      const p = input.value.trim();
      if (!p) return;
      const created = await act(() => api('POST', '/api/projects', { path: p }), 'Proje eklendi.');
      if (created) {
        input.value = '';
        await refresh();
        this.poll();
      }
    });
    this.poll();
  },
  poll() {
    const projects = [...state.projects].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    const grid = $('#proj-grid');
    if (!projects.length) {
      grid.innerHTML = '<div class="empty">Henüz proje yok. Üstteki alana bir klasör yolu yazıp ekle. Klasör, Ayarlar\'daki izinli klasörlerin altında olmalı.</div>';
      return;
    }
    grid.className = 'grid-cards';
    grid.innerHTML = projects.map((p) => {
      const gs = groupsOf(p.id);
      const running = gs.flatMap((g) => g.sessions).filter((s) => s.running);
      const waiting = running.some((s) => s.status === 'waiting');
      const accs = [...new Set(gs.flatMap((g) => g.sessions.map((s) => s.accountId)))];
      const past = gs.filter((g) => g.state === 'past').length;
      const arch = gs.filter((g) => g.state === 'archived').length;
      const head = running.length
        ? `<span class="badge ${waiting ? 'waiting' : 'busy'}">${running.length} aktif${waiting ? ' · onay bekliyor' : ''}</span>`
        : '<span class="count">aktif yok</span>';
      return `
          <a class="card proj ${running.length ? 'has-active' : ''}" href="#/p/${esc(p.id)}">
            <div class="title"><span class="dot ${running.length ? (waiting ? 'waiting' : 'busy') : ''}"></span><span style="flex-grow:1">${esc(p.name)}</span>${head}</div>
            <div class="mono" style="color: var(--muted)">${esc(p.path)}</div>
            <div class="actions">${accs.map(accBadge).join('')}</div>
            <div class="meta"><span>${past} geçmiş · ${arch} arşiv</span><span>${esc(timeAgo(p.lastUsedAt))}</span></div>
          </a>`;
    }).join('');
  },
};

// ---------- 2 · proje sayfası ----------

const expanded = new Set();
// Sayfa iki saniyede bir yeniden çizildiği için açık bırakılan "son mesaj" kutuları burada hatırlanır.
const openDetails = new Set();
// Retro için grup etkinliği bir kez çekilir (geçmiş grup değişmediği için yeniden çekmeye gerek yok).
const retroCache = new Map();

const ProjectView = {
  mount({ id }) {
    this.id = id;
    const p = project(id);
    if (!p) {
      app.innerHTML = '<div class="page"><div class="empty">Proje bulunamadı.</div></div>';
      return;
    }
    crumbs([{ label: 'Projeler', href: '#/' }, { label: p.name }]);
    app.innerHTML = `
        <div class="page">
          <div class="page-head">
            <div>
              <h1>${esc(p.name)}</h1>
              <div class="mono sub">${esc(p.path)}</div>
            </div>
            <div class="actions">
              <button class="btn ghost" id="del-proj">Projeyi listeden kaldır</button>
              <a class="btn primary" href="#/p/${esc(id)}/kurulum">${ICON_PLUS} Yeni kurulum</a>
            </div>
          </div>
          <div id="groups" class="section" style="gap: 25px"></div>
        </div>
        <dialog class="dlg" id="close-dlg" aria-labelledby="close-title"></dialog>`;
    $('#close-dlg').addEventListener('click', (e) => this.onCloseDlg(e));
    $('#del-proj').addEventListener('click', async () => {
      if (!confirm(`"${p.name}" projesi panel listesinden kaldırılsın mı? Klasöre ve konuşma dosyalarına dokunulmaz.`)) return;
      if (await act(() => api('DELETE', `/api/projects/${id}`), 'Proje kaldırıldı.')) location.hash = '#/';
    });
    $('#groups').addEventListener('click', (e) => this.onClick(e));
    $('#groups').addEventListener('toggle', (e) => {
      const d = e.target;
      if (!d.matches || !d.matches('details[data-sid]')) return;
      if (d.open) openDetails.add(d.dataset.sid); else openDetails.delete(d.dataset.sid);
    }, true);
    this.poll();
  },

  async onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { act: a, gid, sid } = btn.dataset;
    if (a === 'toggle') {
      if (expanded.has(gid)) expanded.delete(gid); else expanded.add(gid);
      this.poll();
      return;
    }
    if (a === 'close-group') return this.openClose(gid);
    if (a === 'stop-group' && !confirm('Gruptaki tüm oturumlar sonlandırılsın mı?')) return;
    if (a === 'stop' && !confirm('Oturum sonlandırılsın mı?')) return;
    const calls = {
      'stop-group': () => api('POST', `/api/groups/${gid}/stop`),
      resume: () => api('POST', `/api/groups/${gid}/resume`),
      archive: () => api('POST', `/api/groups/${gid}/archive`, { archived: true }),
      unarchive: () => api('POST', `/api/groups/${gid}/archive`, { archived: false }),
      start: () => api('POST', `/api/sessions/${sid}/start`),
      stop: () => api('POST', `/api/sessions/${sid}/stop`),
      pc: () => api('POST', `/api/sessions/${sid}/open-pc`),
      restore: () => api('POST', `/api/sessions/${sid}/restore`),
    };
    if (!calls[a]) return;
    btn.disabled = true;
    const ok = await act(calls[a]);
    btn.disabled = false;
    if (ok && a === 'resume') {
      location.hash = `#/g/${gid}`;
      return;
    }
    setTimeout(async () => { try { await refresh(); this.poll(); } catch {} }, 600);
  },

  // Grubu kapatma penceresi: kapanış özeti + proje klasörüne dışa aktarma tek seçenek; iş sunucuda sürer, durum izlenir.
  async openClose(gid) {
    const g = state.groups.find((x) => x.id === gid);
    if (!g) return;
    this.closeGid = gid;
    let job;
    try { job = await api('GET', `/api/groups/${gid}/close`); } catch (err) { return toast(err.message, true); }
    this.closeDir = job.defaultDir || this.closeDir || '';
    this.renderClose(job);
    $('#close-dlg').showModal();
    if (job.state === 'running') this.pollClose();
  },

  renderClose(job) {
    const dlg = $('#close-dlg');
    const g = state.groups.find((x) => x.id === this.closeGid);
    if (!dlg || !g) return;
    const p = project(this.id);
    const running = job.state === 'running';
    const body = job.state === 'done' ? `
          <p>Grup kapatıldı.${job.dir ? ` Notlar, pano ve kapanış özeti <span class="mono">${esc(job.dir)}</span> klasörüne aktarıldı (${job.files} dosya)${job.docRef ? `; klasör projenin dokümanlarına eklendi` : ''}.` : ''}</p>
          ${job.costUSD ? `<span class="note">Kapanış özeti: ${job.costUSD.toFixed(2)}</span>` : ''}`
      : running ? `
          <p><b>Kapatılıyor…</b></p><p class="note">${esc(job.step || '')}</p>
          <p class="note">Bu pencereyi kapatabilirsin; iş sunucuda sürer.</p>`
      : `
          ${job.state === 'failed' ? `<div class="warnbox">${esc(job.error || 'Kapatma tamamlanamadı.')} Grup kapanmadı, notlar yerinde.</div>` : ''}
          <p>Gruptaki açık oturumlar durdurulur ve grup arşive alınır. Claude'un konuşma dosyaları silinmez.</p>
          <label class="check"><input type="checkbox" id="close-export" ${this.closeExport !== false ? 'checked' : ''}>Kapanış özeti yaz ve notları proje klasörüne aktar</label>
          <p class="note">Not düzenleyici notları ve panoyu okuyup "Proje durumu" özetini yazar (birkaç dakika, birkaç dolar). Ardından özet, yapılacaklar (açık kartlar), biten işler ve her not ayrı Markdown dosyası olarak yazılır; senin yazdığın kısımlar olduğu gibi kalır.</p>
          <div class="field"><label for="close-dir">Hedef klasör (${esc(p ? p.path : 'proje')} altında)</label>
            <input id="close-dir" class="mono" value="${esc(this.closeDir || '')}"></div>`;
    const foot = job.state === 'done'
      ? '<button class="btn primary" data-cact="done">Tamam</button>'
      : running ? '<button class="btn ghost" data-cact="cancel">Kapat</button>'
      : `<button class="btn ghost" data-cact="cancel">Vazgeç</button>
           ${job.canSkipSummary ? '<button class="btn" data-cact="nosum">Özetsiz aktar ve kapat</button>' : ''}
           <button class="btn danger" data-cact="go">${job.state === 'failed' ? 'Yeniden dene' : 'Grubu kapat'}</button>`;
    dlg.innerHTML = `
        <div class="dlg-head"><div><h2 id="close-title">Grubu kapat</h2><p class="note">${esc(g.name)}</p></div></div>
        <div class="dlg-body">${body}</div>
        <div class="dlg-foot">${foot}</div>`;
  },

  async onCloseDlg(e) {
    const b = e.target.closest('[data-cact]');
    if (!b) return;
    const a = b.dataset.cact;
    const dlg = $('#close-dlg');
    if (a === 'cancel') return dlg.close();
    if (a === 'done') {
      dlg.close();
      await refresh().catch(() => {});
      return this.poll();
    }
    const ex = $('#close-export');
    if (ex) this.closeExport = ex.checked;
    const dir = $('#close-dir');
    if (dir) this.closeDir = dir.value.trim();
    const body = a === 'nosum' ? { export: true, summary: false, dir: this.closeDir } : { export: this.closeExport !== false, dir: this.closeDir };
    b.disabled = true;
    let job;
    try { job = await api('POST', `/api/groups/${this.closeGid}/close`, body); } catch (err) { b.disabled = false; return toast(err.message, true); }
    this.renderClose(job);
    this.pollClose();
  },

  pollClose() {
    clearTimeout(this.closeTimer);
    const gid = this.closeGid;
    this.closeTimer = setTimeout(async () => {
      let job;
      try { job = await api('GET', `/api/groups/${gid}/close`); } catch { return; }
      if (gid !== this.closeGid) return;
      const dlg = $('#close-dlg');
      if (dlg && dlg.open) this.renderClose(job);
      if (job.state === 'running') return this.pollClose();
      if (job.state === 'done') {
        toast('Grup kapatıldı.');
        await refresh().catch(() => {});
        this.poll();
      } else if (job.state === 'failed' && !(dlg && dlg.open)) toast(job.error || 'Grup kapatılamadı.', true);
    }, 2000);
  },

  poll() {
    const gs = groupsOf(this.id);
    const box = $('#groups');
    if (!box) return;
    const parts = [
      ['active', 'Aktif gruplar'],
      ['past', 'Geçmiş gruplar'],
      ['archived', 'Arşiv'],
    ].map(([key, title]) => {
      const list = gs.filter((g) => g.state === key);
      if (key === 'archived' && !list.length) return '';
      const body = list.length
        ? list.map((g) => this.groupHtml(g)).join('')
        : `<div class="empty">${key === 'active' ? 'Çalışan grup yok. "Yeni kurulum" ile başlat.' : 'Geçmiş grup yok.'}</div>`;
      return `
          <section class="section">
            <div class="section-head"><h2>${title}</h2><span class="count">${list.length}</span></div>
            ${body}
          </section>`;
    });
    box.innerHTML = parts.join('') + '<p class="note">Grubu kapatmak onu arşive alır; istersen notlarını önce proje klasörüne aktarır. Claude\'un konuşma dosyaları silinmez.</p>';
  },

  groupHtml(g) {
    const running = g.sessions.filter((s) => s.running);
    const waiting = running.filter((s) => s.status === 'waiting').length;
    const open = expanded.has(g.id) || g.state === 'active';
    let actions;
    if (g.state === 'active') {
      actions = `
          <a class="btn primary" href="#/g/${esc(g.id)}">Grubu aç</a>
          <button class="btn danger" data-act="stop-group" data-gid="${esc(g.id)}">Tümünü sonlandır</button>
          <button class="btn ghost" data-act="close-group" data-gid="${esc(g.id)}">Grubu kapat</button>`;
    } else if (g.state === 'past') {
      actions = `
          <button class="btn" data-act="resume" data-gid="${esc(g.id)}">Grubu devam ettir</button>
          <button class="btn ghost" data-act="close-group" data-gid="${esc(g.id)}">Grubu kapat</button>`;
    } else {
      actions = `<button class="btn ghost" data-act="unarchive" data-gid="${esc(g.id)}">Arşivden çıkar</button>`;
    }
    const tot = groupTotals(g);
    const meta = (g.state === 'active'
      ? `${g.sessions.length} oturum · ${running.length} açık`
      : `${new Date(g.createdAt).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${g.sessions.length} oturum · ${g.sessions.map((s) => s.roleLabel).join(', ')}`)
      + ` · ${fmtUsd(tot.cost)}${tot.added || tot.removed ? ` · +${tot.added}/−${tot.removed}` : ''}`;
    const sessions = open ? `
        <div class="sess-list">
          ${g.sessions.map((s) => `
            <div class="sess">
              <span class="dot ${statusKey(s)}"></span>
              <span class="label">${esc(s.roleLabel)}<small>${esc(s.name)}</small></span>
              <span class="stats">${esc(statsLine(s.stats))}</span>
              ${activityLine(s)}
              ${hintBadge(modelHint(s, g))}
              ${accBadge(s.accountId)}
              ${s.removed ? `<span class="badge">${s.renewedTo ? 'yenilendi' : 'gruptan çıkarıldı'}</span>` : statusBadge(s)}
              ${s.renewedTo
              ? ''
              : s.removed
              ? `<button class="btn small ghost" data-act="restore" data-sid="${esc(s.id)}">Gruba geri ekle</button>`
              : s.running
                ? `<a class="btn small" href="#/g/${esc(g.id)}/${esc(s.id)}">Bağlan</a>
                     <button class="btn small ghost" data-act="pc" data-sid="${esc(s.id)}">PC'de aç</button>
                     <button class="btn small danger" data-act="stop" data-sid="${esc(s.id)}">Sonlandır</button>`
                : g.state !== 'archived'
                  ? `<button class="btn small" data-act="start" data-sid="${esc(s.id)}">Başlat</button>`
                  : ''}
            </div>`).join('')}
        </div>` : '';
    return `
        <div class="card group ${g.state === 'active' ? 'active' : ''}">
          <div class="group-row">
            ${g.state === 'active' ? '' : `<button class="chev" data-act="toggle" data-gid="${esc(g.id)}" aria-expanded="${open}" aria-label="Oturumları göster">${ICON_CHEV}</button>`}
            <div class="info">
              <div class="name">${esc(g.name)}${waiting ? `<span class="badge waiting">${waiting} onay bekliyor</span>` : ''}</div>
              <div class="meta">${esc(meta)}</div>
            </div>
            <div class="actions">${actions}</div>
          </div>
          ${sessions}
          ${open && g.state !== 'active' ? this.summaryHtml(g, tot) : ''}
        </div>`;
  },

  // Kapanış özeti: süre, harcama, değişen satırlar ve her oturumun son mesajı. Konuşma dosyalarından hesaplanır, ek model çağrısı yapılmaz.
  // Ekip retrosu: kim kime ne kadar yazdı, kim ne kadar onay bekledi, harcama nerede; sonraki kurulum için öneriler.
  retroHtml(g, tot) {
    const a = retroCache.get(g.id);
    if (!a) {
      retroCache.set(g.id, 'loading');
      api('GET', `/api/groups/${g.id}/activity`)
        .then((x) => { retroCache.set(g.id, x); this.poll(); })
        .catch(() => retroCache.delete(g.id));
      return '<span class="note">Retro hazırlanıyor…</span>';
    }
    if (a === 'loading') return '<span class="note">Retro hazırlanıyor…</span>';
    // Süreler zaman çizelgesiyle aynı hesaptan. Kullanıcı yokken geçen onay beklemesi sayılmaz: izin modunu
    // suçlamak için kullanıcının başında olması gerekir.
    const ts = timeStats(g.sessions, a, g.createdAt, g.state !== 'active');
    const rows = g.sessions.map((s) => {
      const sent = a.messages.filter((m) => m.from === s.id).length;
      const recv = a.messages.filter((m) => m.to === s.id).length;
      const { waiting, busy } = ts.per[s.id];
      const cost = s.stats ? s.stats.costUSD : 0;
      return { s, sent, recv, waiting, busy, cost, share: tot.cost > 0 ? cost / tot.cost : 0 };
    });
    const tips = [];
    for (const r of rows) {
      if (!r.sent && !r.recv && (!r.s.stats || r.s.stats.prompts <= 1) && g.sessions.length > 1) {
        tips.push(`${r.s.roleLabel} hiç kullanılmadı; benzer işlerde kurulumdan çıkarılabilir.`);
      }
    }
    const top = [...rows].sort((x, y) => y.cost - x.cost)[0];
    if (top && top.share >= 0.5 && tot.cost > 0) {
      const hint = modelHint(top.s, g);
      tips.push(`Harcamanın %${Math.round(top.share * 100)}'i ${top.s.roleLabel} oturumunda.${hint ? ` ${hint}` : ''}`);
    }
    const totalWait = rows.reduce((n, r) => n + r.waiting, 0);
    const totalBusy = rows.reduce((n, r) => n + r.busy, 0);
    if (totalWait > 5 * 60000 || (totalBusy > 0 && totalWait / (totalWait + totalBusy) > 0.15)) {
      const most = [...rows].sort((x, y) => y.waiting - x.waiting)[0];
      tips.push(`Onay beklemede toplam ${fmtDur(totalWait)} geçti (en çok ${most.s.roleLabel}). Bu rollerde "Düzenlemeleri kabul et" izin modu düşünülebilir.`);
    }
    const lead = rows.find((r) => r.s.roleId === 'sef');
    if (lead && !lead.sent && g.sessions.length > 1) tips.push('Şef hiç görev dağıtmadı; ilk görevi şefe vermeyi ya da akış notunu netleştirmeyi dene.');
    if (!a.messages.length && g.sessions.length > 1) tips.push('Üyeler hiç mesajlaşmadı; bağlantıları ve akış notunu gözden geçir.');
    const hasTimeline = ts.recorded;
    return `
        <div class="retro">
          <strong style="font-size: 12.5px">Ekip retrosu</strong>
          <table class="retro-table">
            <thead><tr><th>Üye</th><th>Gönderdi</th><th>Aldı</th><th>Harcama</th><th>Onay bekleme</th></tr></thead>
            <tbody>${rows.map((r) => `
              <tr><td>${esc(r.s.roleLabel)} <span class="note">${esc(r.s.accountId)}</span></td><td>${r.sent}</td><td>${r.recv}</td>
                <td>${fmtUsd(r.cost)} <span class="note">%${Math.round(r.share * 100)}</span></td><td>${hasTimeline ? fmtDur(r.waiting) : '-'}</td></tr>`).join('')}
            </tbody>
          </table>
          ${tips.length ? `<ul class="tips">${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<span class="note">Belirgin bir sorun görünmüyor.</span>'}
          ${hasTimeline ? '' : '<span class="note">Onay bekleme süreleri zaman çizelgesinden gelir; bu grup zaman çizelgesi kaydı başlamadan çalışmış.</span>'}
        </div>`;
  },

  // Süre üç ayrı ölçüyle: grup süresi (duvar saati), ekip aktif (üst üste binenler bir kez), üyelerin toplamı.
  // Zaman çizelgesi kaydı olmayan eski gruplarda yalnızca konuşmalardaki ilk ve son mesaj arası gösterilir.
  durationHtml(g, tot) {
    const a = retroCache.get(g.id);
    const ts = a && a !== 'loading' ? timeStats(g.sessions, a, g.createdAt, g.state !== 'active') : null;
    if (ts && ts.recorded) {
      return `<span title="Grubun açılışından kapanışına duvar saati">Grup süresi <b>${fmtDur(ts.span)}</b></span>
            <span title="En az bir üyenin çalıştığı ya da onay beklediği süre; aynı anda çalışan üyeler bir kez sayılır">Ekip aktif <b>${fmtDur(ts.active)}</b></span>
            <span title="Her üyenin çalışma süresi toplanır; iki üye aynı saatte çalışınca iki saat sayılır">Üyelerin çalışma toplamı <b>${fmtDur(ts.agentBusy)}</b></span>`;
    }
    return `<span title="Konuşmalardaki ilk ve son mesaj arası (duvar saati)">İlk–son mesaj <b>${tot.first && tot.last ? fmtDur(tot.last - tot.first) : '-'}</b></span>`;
  },

  summaryHtml(g, tot) {
    const withText = g.sessions.filter((s) => s.stats && s.stats.lastText);
    return `
        <div class="summary">
          ${g.closing ? `
            <div class="closing">
              <div class="note">Kapanış özeti · ${esc(g.closing.by)} · ${esc(new Date(g.closing.at).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</div>
              <div class="last">${esc(g.closing.text)}</div>
            </div>` : ''}
          ${this.retroHtml(g, tot)}
          <strong style="font-size: 12.5px">Sayısal özet</strong>
          <div class="totals">
            ${this.durationHtml(g, tot)}
            <span>Harcama <b>${fmtUsd(tot.cost)}</b> <span class="note">(API karşılığı)</span></span>
            <span>Satır <b>+${tot.added} / −${tot.removed}</b></span>
            <span>Çıktı <b>${fmtTok(tot.output)} token</b></span>
            <span>Gelen mesaj <b>${tot.prompts}</b> <span class="note">(kullanıcı + ekip)</span></span>
          </div>
          ${withText.length ? withText.map((s) => `
            <details data-sid="${esc(s.id)}" ${openDetails.has(s.id) ? 'open' : ''}>
              <summary>${esc(s.roleLabel)} · son mesajı <span class="note">${esc(s.stats.lastAt ? new Date(s.stats.lastAt).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')}</span></summary>
              <div class="last">${esc(s.stats.lastText)}</div>
            </details>`).join('') : '<span class="note">Bu grupta henüz konuşma yok.</span>'}
        </div>`;
  },
};
