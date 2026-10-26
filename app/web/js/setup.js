// Claude Panel arayüzü · Kurulum ekranı: ekip satırları, roller, hesaplar, yetenekler, optimize, şablonlar.
// web/js/ altındaki dosyalar index.html'deki sırayla yüklenen klasik script'lerdir; üst düzey bildirimler ortak
// global kapsamdadır. Yüklenirken çalışan kod yalnızca kendinden önceki dosyaları kullanabilir.
'use strict';
// ---------- 3 · kurulum ----------

const PERMISSION_LABELS = [
  ['manual', 'Her işlemde sor'],
  ['acceptEdits', 'Düzenlemeleri kabul et'],
  ['auto', 'Otomatik'],
  ['plan', 'Plan modu'],
];
const MODELS = [['', 'Hesap varsayılanı'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
// Oturuma --effort ile verilir; boş: modelin varsayılanı.
const EFFORTS = [['', 'Model varsayılanı'], ['low', 'Düşük'], ['medium', 'Orta'], ['high', 'Yüksek'], ['xhigh', 'Çok yüksek'], ['max', 'En yüksek']];
// Skill listesinde ölçülen oran: 16,2k karakter kapatınca istek başına ~5,4k token düştü.
const CHARS_PER_TOK = 3;
// Yetenek grupları (server/caps.js inventory türleri; panel: panelden eklenenler).
const CAP_GROUPS = [['plugin', 'Eklentiler'], ['skill', 'Hesap skill\'leri'], ['project', 'Proje skill\'leri'], ['synced', 'claude.ai skill\'leri'], ['bundled', 'Claude Code yerleşik skill\'leri'], ['mcp', 'MCP sunucuları'], ['panel', 'Panel yetenekleri']];

let rowSeq = 0;
const newRow = (roleId, accountId, extra = {}) => ({
  key: `r${++rowSeq}`, roleId, accountId, model: roleDefaultModel(roleId), effort: roleDefaultEffort(roleId), permissionMode: roleDefaultMode(roleId),
  customLabel: '', customPrompt: '', talkAll: false, reportsTo: [],
  // prompt: bu ekip için düzenlenen rol talimatı (null: rolün kayıtlı talimatı); caps: rol varsayılanının üstüne açılan / kapatılan yetenekler.
  prompt: null, promptManual: false, caps: { on: [], off: [] }, ...extra,
});

function roleDefaultMode(roleId) {
  const r = state.settings.roles.find((x) => x.id === roleId);
  return (r && r.permissionMode) || '';
}

function roleDefaultModel(roleId) {
  const r = state.settings.roles.find((x) => x.id === roleId);
  return (r && r.model) || '';
}

function roleDefaultEffort(roleId) {
  const r = state.settings.roles.find((x) => x.id === roleId);
  return (r && r.effort) || '';
}

// Kod yazan roller; akış notunda Review / Kod kalitesi ile birlikte anılır.
const CODER_ROLES = ['coder', 'backend', 'frontend', 'android'];

const LINK_STYLES = [
  ['zincir', 'İş akışı zinciri (kod → kalite → review → şef)'],
  ['sef', 'Şef merkezli (herkes şefe)'],
  ['serbest', 'Serbest (herkes herkesle)'],
  ['elle', 'Elle (otomatik ayarlama kapalı)'],
];

const permLabel = (mode) => (PERMISSION_LABELS.find(([v]) => v === mode) || [mode, mode])[1];

const SetupView = {
  mount({ id }) {
    const p = project(id);
    if (!p) {
      app.innerHTML = '<div class="page"><div class="empty">Proje bulunamadı.</div></div>';
      return;
    }
    this.project = p;
    crumbs([{ label: 'Projeler', href: '#/' }, { label: p.name, href: `#/p/${id}` }, { label: 'Yeni kurulum' }]);
    const accs = state.settings.accounts.map((a) => a.id);
    const acc = (i) => accs[i % accs.length];
    const roleIds = state.settings.roles.map((r) => r.id);
    const has = (r) => roleIds.includes(r);
    const sef = newRow(has('sef') ? 'sef' : roleIds[0], acc(1));
    const coder = newRow(has('coder') ? 'coder' : roleIds[0], acc(0));
    const review = newRow(has('review') ? 'review' : roleIds[0], acc(2));
    this.form = {
      name: `${p.name} ekibi`,
      permissionMode: 'manual',
      firstTask: '',
      linkStyle: 'zincir',
      flowAuto: true,
      flowNote: '',
      rows: [sef, coder, review],
    };
    this.autoLinks();
    this.form.flowNote = this.buildFlow();
    app.innerHTML = '<div class="page" id="setup"></div>';
    const root = $('#setup');
    root.addEventListener('input', (e) => this.onInput(e));
    root.addEventListener('change', (e) => this.onInput(e, true));
    root.addEventListener('click', (e) => this.onClick(e));
    // Satırların "Talimat ve yetenekler" bölümü yeniden çizimde açık kalsın.
    this.openMore = new Set();
    root.addEventListener('toggle', (e) => {
      const d = e.target.closest && e.target.closest('details.row-more');
      const k = d && d.closest('[data-key]');
      if (k) { if (d.open) this.openMore.add(k.dataset.key); else this.openMore.delete(k.dataset.key); }
    }, true);
    this.opt = null;
    this.capsData = null;
    this.render();
    // Hesap seçeneklerinde kalan kota ve dolu hesap uyarısı için kota bir kez çekilir.
    getQuota().then(() => { if ($('#setup')) this.render(); }).catch(() => {});
    api('GET', '/api/caps').then((c) => { this.capsData = c; if ($('#setup')) this.render(); }).catch(() => {});
  },

  // Yetenek kataloğu: hesaplarda kurulu olanlar ve panelden eklenenler, satırdaki anahtar biçimiyle.
  capCatalog() {
    const c = this.capsData;
    if (!c) return [];
    return [
      // Başka projenin klasöründeki skill bu projede açılan oturuma zaten gelmez.
      ...(c.inventory || []).filter((x) => x.kind !== 'project' || (x.projects || []).includes(this.project.path)).map((x) => ({
        key: x.key, kind: x.kind, group: x.kind, name: x.kind === 'synced' ? x.name.replace(/^[^:]+:/, '') : x.name,
        desc: x.description || '', chars: x.chars || 0, hooks: !!x.hooks,
      })),
      ...(c.mcps || []).map((m) => ({ key: `pmcp:${m.id}`, kind: 'mcp', group: 'panel', name: m.name, desc: m.url || m.command || '', chars: 0 })),
      ...(c.skills || []).map((k) => ({ key: `pskill:${k.name}`, kind: 'skill', group: 'panel', name: k.name, desc: k.description || '', chars: 0 })),
    ];
  },

  // Satırın yetenekleri türüne göre gruplanır; her grup tek tıkla açılıp kapatılabilir.
  capsBlock(r, mk, om) {
    const catalog = this.capCatalog();
    if (!catalog.length) return '';
    const tok = (n) => `~${n >= 1000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n)} tok`;
    const onList = catalog.filter((x) => this.capOn(r, x.key));
    const onTok = onList.reduce((a, x) => a + x.chars / CHARS_PER_TOK, 0);
    const groups = CAP_GROUPS.map(([g, label]) => [g, label, catalog.filter((x) => x.group === g)]).filter(([, , l]) => l.length);
    return `
              <div class="field"${om('caps')}><span class="lbl">Yetenekler <span class="note">${onList.length}/${catalog.length} açık${onTok ? ` · açık skill açıklamaları her istekte ${tok(onTok)}` : ''}${r.caps.on.length || r.caps.off.length ? ' · bu satıra özel ayar var' : ''}</span></span>
                ${groups.map(([g, label, list]) => {
                const n = list.filter((x) => this.capOn(r, x.key)).length;
                const t = list.filter((x) => this.capOn(r, x.key)).reduce((a, x) => a + x.chars / CHARS_PER_TOK, 0);
                return `
                <div class="cap-group">
                  <div class="cap-group-head"><span>${esc(label)}</span><span class="note">${n}/${list.length} açık${t ? ` · ${tok(t)}` : ''}</span><span class="grow"></span>
                    ${n ? `<button type="button" class="btn small ghost" data-act="cap-group" data-group="${g}" data-on="false">hepsini kapat</button>` : ''}
                    ${n < list.length ? `<button type="button" class="btn small ghost" data-act="cap-group" data-group="${g}" data-on="true">hepsini aç</button>` : ''}</div>
                  <div class="cap-chips">${list.map((x) => `<label class="cap-chip" data-on="${this.capOn(r, x.key)}"${(mk.capKeys || []).includes(x.key) ? ' data-opt="true"' : ''} title="${esc(`${x.desc}${x.hooks ? ' · Kancası var: kapatınca arka planda yaptığı iş de durur.' : ''}`.slice(0, 400))}"><input type="checkbox" data-f="cap" value="${esc(x.key)}" ${this.capOn(r, x.key) ? 'checked' : ''}>${esc(x.name)}${x.chars ? `<span class="note">${tok(x.chars / CHARS_PER_TOK)}</span>` : ''}${x.hooks ? '<span class="note">kanca</span>' : ''}</label>`).join('')}</div>
                </div>`;
              }).join('')}</div>`;
  },

  // Rolün varsayılan olarak aldığı yetenekler (server/caps.js roleKeys ile aynı kural); anlık rol yalnızca globalleri alır.
  capDefault(row, key) {
    const c = this.capsData;
    if (!c) return false;
    if (/^(plugin|skill|mcp):/.test(key)) return !(c.globalOff[key] || []).includes(row.roleId);
    if (row.roleId === 'custom') return false;
    const m = key.startsWith('pmcp:') ? (c.mcps || []).find((x) => `pmcp:${x.id}` === key) : (c.skills || []).find((x) => `pskill:${x.name}` === key);
    return !!(m && m.roles.includes(row.roleId));
  },

  capOn(row, key) {
    if (row.caps.on.includes(key)) return true;
    if (row.caps.off.includes(key)) return false;
    return this.capDefault(row, key);
  },

  // Satırda yeteneği aç / kapat; rol varsayılanıyla aynıysa ayar kaydı silinir.
  setCap(row, key, on) {
    row.caps.on = row.caps.on.filter((k) => k !== key);
    row.caps.off = row.caps.off.filter((k) => k !== key);
    if (on !== this.capDefault(row, key)) row.caps[on ? 'on' : 'off'].push(key);
  },

  rolePromptOf(row) {
    return row.prompt != null ? row.prompt : (this.roleOf(row) || {}).gorevler || '';
  },

  roleOf(row) {
    return state.settings.roles.find((r) => r.id === row.roleId);
  },

  rowLabel(row, i) {
    if (row.roleId === 'custom') return row.customLabel || `#${i + 1}`;
    const r = this.roleOf(row);
    return r ? r.short || r.label : `#${i + 1}`;
  },

  namePreview(row, i) {
    return `${this.project.name} · ${this.rowLabel(row, i)} · ${row.accountId} · ${hhmm()}`;
  },

  // Akış notunun otomatik hali: ekipteki her oturumun adı, rolü, hesabı, modeli, izin modu, görevi ve bağlantıları.
  buildFlow() {
    const f = this.form;
    const modelLabel = (m) => (MODELS.find(([v]) => v === m) || MODELS[0])[1];
    const firstLine = (t) => String(t || '').split('\n').map((s) => s.trim()).find(Boolean) || '—';
    const nameOfKey = (k) => {
      const j = f.rows.findIndex((x) => x.key === k);
      return j >= 0 ? this.namePreview(f.rows[j], j) : null;
    };
    const lines = [`Ekip (${f.rows.length} oturum):`];
    f.rows.forEach((r, i) => {
      const role = r.roleId === 'custom' ? r.customLabel || 'Anlık rol' : (this.roleOf(r) || {}).label || '?';
      const task = r.roleId === 'custom' ? r.customPrompt : this.rolePromptOf(r);
      const acc = account(r.accountId);
      lines.push(`${i + 1}. ${this.namePreview(r, i)} — ${role} · ${acc ? acc.name : r.accountId} · ${modelLabel(r.model)}${r.effort ? ` (effort ${r.effort})` : ''} · izin: ${permLabel(r.permissionMode || f.permissionMode)}`);
      lines.push(`   Görev: ${firstLine(task)}`);
      const to = r.reportsTo.map(nameOfKey).filter(Boolean);
      const links = [];
      if (to.length) links.push(`rapor verir: ${to.join(', ')}`);
      if (r.talkAll) links.push('herkesle konuşur');
      if (links.length) lines.push(`   ${links.join('; ')}`);
    });
    const ids = f.rows.map((r) => r.roleId);
    lines.push('', 'İş akışı:');
    if (ids.includes('sef')) lines.push('- Şef görevi alt işlere böler, rolüne göre üyelere dağıtır; sonuçları birleştirip kullanıcıya özetler.');
    const writers = CODER_ROLES.filter((id) => ids.includes(id));
    const coders = writers.map((id) => (state.settings.roles.find((x) => x.id === id) || {}).label || id).join(', ');
    if (writers.length > 1) lines.push(`- Kod işleri katmanına göre dağıtılır: ${coders}. API sözleşmesi değişirse Backend ilgili üyelere bildirir.`);
    if (writers.length && ids.includes('kalite')) {
      lines.push(ids.includes('review')
        ? `- Akış: kod yazan üye (${coders}) yazar → Kod kalitesi değişikliği ve dayandığı mevcut kodu inceler, bulgularını yazana iletir → yazan üye uygun olanları uygular → Review inceler. Review sorun bulursa ilgili üyeye geri gönderir.`
        : `- Kod yazan üye (${coders}) yazar; Kod kalitesi yeniden kullanım ve kalite bulgularını ona iletir, yazan üye uygun olanları uygular.`);
    } else if (writers.length && ids.includes('review')) {
      lines.push(`- Kod yazan üyenin (${coders}) değişiklikleri Review'a gider; Review sorun bulursa o üyeye geri gönderir, sorun yoksa onaylar.`);
    }
    if (ids.includes('debug')) lines.push('- Hata çıktığında Debug kök nedeni bulur, düzeltme önerisini ilgili üyeye iletir.');
    if (ids.includes('arastirma')) lines.push('- Araştırma gerektiren sorular Araştırma üyesine gider; cevabı soruyu soran üyeye döner.');
    if (ids.includes('avukat')) lines.push('- Önemli plan ve kararlar uygulanmadan önce Şeytanın avukatına danışılır; ciddi itiraz yoksa iş devam eder.');
    if (ids.includes('test')) lines.push('- Biten işi Test / QA doğrular: testleri yazar ve çalıştırır, arayüzü dener; hata bulursa ilgili üyeye geri gönderir.');
    if (ids.includes('guvenlik')) lines.push('- Yetki, girdi, gizli bilgi ya da dışa açık uç noktaya dokunan değişiklikler Güvenlik denetiminden geçer.');
    if (ids.includes('dokuman')) lines.push('- Davranışı ya da kurulumu değiştiren işler bitince Dokümantasyon belgeleri günceller.');
    if (ids.includes('ops')) lines.push('- Sunucu, dağıtım ve altyapı işleri Ops üyesine gider; etkisi olan her işlem kullanıcı onayıyla yapılır.');
    lines.push('- Her üye işini bitirince rapor verdiği üyelere SendMessage ile bildirir.');
    if (f.flowExtra && f.flowExtra.length) lines.push('', 'Bu ekip için:', ...f.flowExtra.map((x) => `- ${x}`));
    return lines.join('\n');
  },

  // Şablon satırları yeni anahtarlarla eklenir; rapor bağlantıları yeni anahtarlara çevrilir.
  // Artık olmayan rol ya da hesap varsa satır ilk rol / ilk hesapla gelir.
  rowsFromTemplate(tpl) {
    const roles = state.settings.roles.map((r) => r.id);
    const accs = state.settings.accounts.map((a) => a.id);
    const map = new Map();
    const rows = tpl.rows.map((t) => {
      const roleId = t.roleId === 'custom' || roles.includes(t.roleId) ? t.roleId : roles[0];
      const r = newRow(roleId, accs.includes(t.accountId) ? t.accountId : accs[0], {
        model: t.model || '', effort: t.effort || '', permissionMode: t.permissionMode || '', talkAll: !!t.talkAll,
        customLabel: t.customLabel || '', customPrompt: t.customPrompt || '',
        prompt: t.prompt || null, promptManual: !!t.prompt,
        caps: { on: [...((t.caps && t.caps.on) || [])], off: [...((t.caps && t.caps.off) || [])] },
      });
      map.set(t.key, r.key);
      r.tplReports = t.reportsTo || [];
      return r;
    });
    for (const r of rows) {
      r.reportsTo = r.tplReports.map((k) => map.get(k)).filter(Boolean);
      delete r.tplReports;
    }
    return rows;
  },

  quotaWarnings() {
    const seen = new Set();
    const lines = [];
    for (const r of this.form.rows) {
      if (seen.has(r.accountId)) continue;
      seen.add(r.accountId);
      const left = quotaLeftOf(r.accountId);
      const a = account(r.accountId);
      if (left === 0) lines.push(`${a ? a.name : r.accountId} dolu; bu hesaptaki oturumlar çalışamaz.`);
      else if (left != null && left < 15) lines.push(`${a ? a.name : r.accountId} hesabında %${left} kota kaldı; uzun işte yarıda kalabilir.`);
    }
    return lines.length ? `<div class="warnbox">${lines.map(esc).join('<br>')}</div>` : '';
  },

  templatesHtml() {
    const p = this.project;
    const list = (state.templates || []).filter((t) => t.scope === 'global' || t.scope === p.id);
    return `
        <details class="card tpl-card" ${list.length ? 'open' : ''}>
          <summary><strong>Şablonlar</strong> <span class="note">${list.length} kullanılabilir</span></summary>
          <div class="tpl-body">
            ${list.length ? list.map((t) => `
              <div class="tpl-row">
                <div class="info">
                  <div style="font-weight: 500">${esc(t.name)} <span class="badge">${t.scope === 'global' ? 'genel' : esc(p.name)}</span></div>
                  <div class="note">${t.rows.length} oturum · ${esc(t.rows.map((r) => r.roleId === 'custom' ? r.customLabel : ((state.settings.roles.find((x) => x.id === r.roleId) || {}).label || r.roleId)).join(', '))}</div>
                </div>
                <button class="btn small primary" data-act="tpl-append" data-tid="${esc(t.id)}">Alta ekle</button>
                <button class="btn small" data-act="tpl-load" data-tid="${esc(t.id)}">Yükle (değiştir)</button>
                <button class="btn small ghost" data-act="tpl-del" data-tid="${esc(t.id)}" aria-label="Şablonu sil" title="Şablonu sil">✕</button>
              </div>`).join('') : '<div class="note">Henüz şablon yok. Aşağıdaki satırları kurup şablon olarak kaydedebilirsin.</div>'}
            <div class="tpl-save">
              <input id="tpl-name" placeholder="Şablon adı" maxlength="60" aria-label="Şablon adı">
              <select id="tpl-scope" aria-label="Şablon kapsamı"><option value="${esc(p.id)}">Sadece ${esc(p.name)}</option><option value="global">Tüm projeler</option></select>
              <button class="btn small" data-act="tpl-save">Mevcut kurulumu kaydet</button>
            </div>
          </div>
        </details>`;
  },

  // Rol dağılımına göre bağlantıları kurar. Düzenler: zincir (kod yazan → kod kalitesi → review → şef; diğerleri şefe),
  // şef merkezli (herkes yalnızca şefe), serbest (herkes herkesle). Elle değiştirilen bağlantılara ("elle") dokunulmaz.
  autoLinks() {
    const f = this.form;
    const style = f.linkStyle || 'zincir';
    if (style === 'elle') return;
    const rows = f.rows;
    const first = (id) => rows.find((r) => r.roleId === id);
    const all = (ids) => rows.filter((r) => ids.includes(r.roleId));
    const lead = first('sef') || null;
    const hub = lead || rows[0];
    const keys = (list, self) => [...new Set(list.filter(Boolean).map((r) => r.key))].filter((k) => k !== self.key);
    for (const r of rows) {
      r.talkAll = style === 'serbest' || (!!lead && r === lead);
      if (r === lead) { r.reportsTo = []; continue; }
      if (style !== 'zincir') { r.reportsTo = keys([hub], r); continue; }
      const review = first('review');
      const kalite = first('kalite');
      const coders = all(CODER_ROLES);
      let to;
      if (CODER_ROLES.includes(r.roleId)) {
        to = [kalite, review, lead];
        // API sözleşmesi değişince Backend, arayüz tarafındaki üyelere bildirir.
        if (r.roleId === 'backend') to.push(...all(['frontend', 'android']));
      } else if (r.roleId === 'kalite') to = coders.length ? coders : [review || lead];
      else if (r.roleId === 'review') to = lead ? [lead] : coders;
      else if (['debug', 'test', 'guvenlik'].includes(r.roleId)) to = lead ? [lead] : coders;
      else to = [hub];
      r.reportsTo = keys(to, r);
    }
  },

  syncFlow() {
    if (!this.form.flowAuto) return;
    this.form.flowNote = this.buildFlow();
    const ta = $('#g-flow');
    if (ta) ta.value = this.form.flowNote;
  },

  onInput(e, structural) {
    const el = e.target;
    const f = el.dataset.f;
    if (!f) return;
    const key = el.closest('[data-key]') && el.closest('[data-key]').dataset.key;
    const row = key && this.form.rows.find((r) => r.key === key);
    const value = el.type === 'checkbox' ? el.checked : el.value;
    if (row) {
      if (f === 'reportsTo') {
        const target = el.value;
        row.reportsTo = el.checked ? [...new Set([...row.reportsTo, target])] : row.reportsTo.filter((k) => k !== target);
        this.form.linkStyle = 'elle';
      } else if (f === 'talkAll') {
        row.talkAll = value;
        this.form.linkStyle = 'elle';
      } else if (f === 'cap') {
        this.setCap(row, el.value, el.checked);
      } else if (f === 'prompt') {
        row.prompt = value;
        row.promptManual = true;
      } else {
        row[f] = value;
        if (f === 'roleId') {
          row.permissionMode = roleDefaultMode(value);
          row.model = roleDefaultModel(value);
          row.effort = roleDefaultEffort(value);
          row.prompt = null;
          row.promptManual = false;
          row.caps = { on: [], off: [] };
          this.autoLinks();
        }
      }
    } else {
      this.form[f] = value;
      if (f === 'flowNote') this.form.flowAuto = false;
      if (f === 'linkStyle') this.autoLinks();
    }
    if (f !== 'flowNote') this.syncFlow();
    // Yapıyı değiştiren seçimlerde (rol, hesap, grup izni) form yeniden çizilir; yazı alanlarında çizilmez ki imleç kaybolmasın.
    if (structural && (f === 'roleId' || f === 'accountId' || f === 'permissionMode' || f === 'cap' || f === 'linkStyle' || f === 'reportsTo' || f === 'talkAll')) this.render();
    else this.renderSide();
  },

  async onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const a = btn.dataset.act;
    if (a === 'add') {
      const r = newRow(state.settings.roles[0].id, state.settings.accounts[0].id);
      this.form.rows.push(r);
      this.autoLinks();
      this.syncFlow();
      this.render();
    } else if (a === 'cap-group') {
      const row = this.form.rows.find((r) => r.key === btn.closest('[data-key]').dataset.key);
      if (!row) return;
      const on = btn.dataset.on === 'true';
      for (const x of this.capCatalog().filter((c) => c.group === btn.dataset.group)) this.setCap(row, x.key, on);
      this.openMore.add(row.key);
      this.render();
    } else if (a === 'remove') {
      const key = btn.closest('[data-key]').dataset.key;
      this.form.rows = this.form.rows.filter((r) => r.key !== key);
      for (const r of this.form.rows) r.reportsTo = r.reportsTo.filter((k) => k !== key);
      this.autoLinks();
      this.syncFlow();
      this.render();
    } else if (a === 'tpl-append' || a === 'tpl-load') {
      const tpl = (state.templates || []).find((t) => t.id === btn.dataset.tid);
      if (!tpl) return;
      if (a === 'tpl-load') {
        this.form.rows = [];
        this.form.permissionMode = tpl.permissionMode || this.form.permissionMode;
      }
      this.form.rows.push(...this.rowsFromTemplate(tpl));
      // Şablonun kendi bağlantıları korunur; alta eklenen satırlar için düzen yeniden kurulur.
      if (a === 'tpl-load') this.form.linkStyle = 'elle';
      else this.autoLinks();
      this.syncFlow();
      this.render();
      toast(a === 'tpl-load' ? `"${tpl.name}" yüklendi.` : `"${tpl.name}" alta eklendi.`);
    } else if (a === 'tpl-del') {
      const tpl = (state.templates || []).find((t) => t.id === btn.dataset.tid);
      if (!tpl || !confirm(`"${tpl.name}" şablonu silinsin mi?`)) return;
      if (await act(() => api('DELETE', `/api/templates/${tpl.id}`), 'Şablon silindi.')) {
        await refresh().catch(() => {});
        this.render();
      }
    } else if (a === 'tpl-save') {
      const name = $('#tpl-name').value.trim();
      if (!name) return toast('Şablon adı yaz.', true);
      if (!this.form.rows.length) return toast('Kaydedilecek satır yok.', true);
      const saved = await act(() => api('POST', '/api/templates', {
        name, scope: $('#tpl-scope').value, permissionMode: this.form.permissionMode, rows: this.form.rows,
      }), 'Şablon kaydedildi.');
      if (saved) {
        await refresh().catch(() => {});
        this.render();
      }
    } else if (a === 'regen-flow') {
      this.form.flowAuto = true;
      this.syncFlow();
      this.renderSide();
    } else if (a === 'start') {
      await this.submit(btn);
    } else if (a === 'optimize') {
      await this.optimize('');
    } else if (a === 'opt-goal') {
      $('#opt-dlg').showModal();
    } else if (a === 'opt-cancel') {
      $('#opt-dlg').close();
    } else if (a === 'opt-run') {
      const goal = $('#opt-goal').value.trim();
      this.optGoal = goal;
      $('#opt-dlg').close();
      await this.optimize(goal);
    } else if (a === 'opt-undo') {
      if (!this.opt || !this.opt.before) return;
      this.form = this.opt.before;
      this.opt = null;
      this.render();
      toast('Optimizasyon geri alındı.');
    } else if (a === 'opt-dismiss') {
      this.opt = null;
      this.render();
    }
  },

  // Formdaki ekibi panelin kurulum danışmanına gönderir, dönen önerileri forma uygular; önceki hali geri alma için saklanır.
  // Optimizasyonun skill bağlamında sağladığı kazanç: satır başına ve toplam, istek başına tahmini token.
  optTokHtml(o) {
    const rows = (o.tok || []).filter((x) => Math.round(x.before) !== Math.round(x.after));
    if (!rows.length) return '';
    const k = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
    const b = o.tok.reduce((a, x) => a + x.before, 0);
    const af = o.tok.reduce((a, x) => a + x.after, 0);
    const pct = b ? Math.round(((b - af) / b) * 100) : 0;
    return `
              <div class="opt-tok">
                <div><b>Skill bağlamı: ${k(b)} → ${k(af)} tok</b> <span class="note">${o.tok.length > 1 ? `${o.tok.length} rolün toplamı, ` : ''}istek başına · ${b > af ? `−${k(b - af)} (%${pct})` : `+${k(af - b)}`}</span></div>
                ${rows.map((x) => `<div class="note">${esc(x.label)}: ${k(x.before)} → ${k(x.after)}</div>`).join('')}
                <div class="note">Tahmin; yeni ya da yenilenen oturumda geçerli olur.</div>
              </div>`;
  },

  async optimize(goal) {
    const f = this.form;
    if (!f.rows.length) return toast('Önce en az bir rol ekle.', true);
    if (this.optBusy) return;
    this.optBusy = true;
    this.renderSide();
    let r;
    try {
      r = await api('POST', '/api/setup/optimize', {
        projectId: this.project.id, permissionMode: f.permissionMode, goal,
        rows: f.rows.map((x) => ({ ...x, prompt: x.roleId === 'custom' ? null : x.prompt })),
      });
    } catch (err) {
      toast(err.message, true);
    } finally {
      this.optBusy = false;
    }
    if (!r) return this.renderSide();
    const before = structuredClone(f);
    // Satırın açık yeteneklerinin her istekte bağlama eklediği tahmini token (skill açıklamaları).
    const capTok = (row) => this.capCatalog().filter((x) => this.capOn(row, x.key)).reduce((a, x) => a + x.chars / CHARS_PER_TOK, 0);
    const tokBefore = Object.fromEntries(f.rows.map((row) => [row.key, capTok(row)]));
    const marks = {};
    for (const row of f.rows) {
      const p = r.patches[row.key];
      if (!p) continue;
      const m = (marks[row.key] = {});
      if (p.model !== undefined) { row.model = p.model; m.model = p.why.model; }
      if (p.effort !== undefined) { row.effort = p.effort; m.effort = p.why.effort; }
      if (p.permissionMode !== undefined) { row.permissionMode = p.permissionMode; m.permissionMode = p.why.permissionMode; }
      if (p.accountId) { row.accountId = p.accountId; m.accountId = p.why.accountId; }
      if (p.talkAll !== undefined) { row.talkAll = p.talkAll; m.links = p.why.links; }
      if (p.reportsTo) { row.reportsTo = p.reportsTo; m.links = p.why.links; }
      if (p.talkAll !== undefined || p.reportsTo) f.linkStyle = 'elle';
      if (p.prompt) {
        if (row.roleId === 'custom') row.customPrompt = p.prompt;
        else { row.prompt = p.prompt; row.promptManual = false; }
        m.prompt = p.why.prompt;
      }
      if (p.caps) {
        for (const k of p.caps.on) this.setCap(row, k, true);
        for (const k of p.caps.off) this.setCap(row, k, false);
        m.caps = p.why.caps;
        m.capKeys = [...p.caps.on, ...p.caps.off];
      }
    }
    // Optimizer'ın çıkardığı ve eklediği üyeler; çıkarılanın skill bağlamı da kazanca sayılır.
    const removed = [];
    for (const x of r.removes || []) {
      const i = f.rows.findIndex((row) => row.key === x.key);
      if (i < 0) continue;
      removed.push({ label: this.rowLabel(f.rows[i], i), why: x.why, tok: tokBefore[x.key] || 0 });
      delete marks[x.key];
      f.rows.splice(i, 1);
    }
    const added = [];
    for (const a of r.adds || []) {
      if (!state.settings.roles.some((x) => x.id === a.roleId)) continue;
      const row = newRow(a.roleId, a.accountId, {
        key: a.key, effort: a.effort || '', talkAll: !!a.talkAll, reportsTo: a.reportsTo || [],
        ...(a.model !== undefined ? { model: a.model } : {}),
        ...(a.permissionMode !== undefined ? { permissionMode: a.permissionMode } : {}),
        ...(a.prompt ? { prompt: a.prompt } : {}),
      });
      for (const k of a.capsOff || []) this.setCap(row, k, false);
      f.rows.push(row);
      marks[row.key] = { added: a.why };
      added.push({ label: this.rowLabel(row, f.rows.length - 1), why: a.why });
    }
    for (const row of f.rows) row.reportsTo = row.reportsTo.filter((k) => f.rows.some((o) => o.key === k));
    if (removed.length || added.length) f.linkStyle = 'elle';
    f.flowExtra = r.flowExtra || [];
    f.flowAuto = true;
    this.syncFlow();
    const changed = Object.keys(marks).length + removed.length;
    const tok = [
      ...f.rows.map((row, i) => ({ label: this.rowLabel(row, i), before: tokBefore[row.key] || 0, after: capTok(row) })),
      ...removed.map((x) => ({ label: `${x.label} (çıkarıldı)`, before: x.tok, after: 0 })),
    ];
    // Model metinde satır anahtarı (r1, yeni_1) yazarsa rol adıyla değiştirilir.
    const labels = new Map([...before.rows, ...f.rows].map((row) => [row.key, row.roleId === 'custom' ? row.customLabel : ((state.settings.roles.find((x) => x.id === row.roleId) || {}).label || row.key)]));
    const unkey = (t) => String(t || '').replace(/\b(r\d+|yeni_\d+)\b/g, (k) => labels.get(k) || k);
    for (const x of [...added, ...removed]) x.why = unkey(x.why);
    this.opt = { before, marks, suggestions: (r.suggestions || []).map(unkey), costUSD: r.costUSD, account: r.account, turns: r.turns || 0, changed, tok, added, removed };
    this.render();
    toast(changed ? `${changed} satır optimize edildi.` : 'Değiştirilecek bir şey bulunmadı.');
  },

  async submit(btn) {
    const f = this.form;
    if (!f.rows.length) return toast('En az bir oturum satırı ekle.', true);
    const missing = f.rows.findIndex((r) => r.roleId === 'custom' && !r.customLabel.trim());
    if (missing >= 0) return toast(`#${missing + 1}: anlık rol için rol adı yaz.`, true);
    this.syncFlow();
    btn.disabled = true;
    const group = await act(() => api('POST', '/api/groups', {
      projectId: this.project.id,
      name: f.name,
      permissionMode: f.permissionMode,
      firstTask: f.firstTask,
      flowNote: f.flowNote,
      rows: f.rows,
    }));
    btn.disabled = false;
    if (group) {
      toast(`${group.sessions.length} oturum açılıyor…`);
      await refresh().catch(() => {});
      location.hash = `#/g/${group.id}`;
    }
  },

  render() {
    const f = this.form;
    const roles = state.settings.roles;
    const accs = state.settings.accounts;
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
    const rowsHtml = f.rows.map((r, i) => {
      const others = f.rows.filter((o) => o.key !== r.key);
      // Optimizasyonun değiştirdiği alanlar işaretlenir; gerekçe üzerine gelince görünür.
      const mk = (this.opt && this.opt.marks[r.key]) || {};
      const om = (k) => (k in mk ? ` data-opt="true" title="Optimize: ${esc(mk[k] || 'değiştirildi')}"` : '');
      const capsHtml = this.capsBlock(r, mk, om);
      return `
          <div class="card row-card" data-key="${esc(r.key)}">
            <div class="row-top">
              <span class="num">#${i + 1}</span>
              <span class="preview">${esc(this.namePreview(r, i))}</span>
              ${r.roleId === 'custom' ? '<span class="badge acc-green">anlık rol</span>' : ''}
              ${'added' in mk ? `<span class="badge acc-green" title="${esc(mk.added || '')}">optimize ekledi</span>` : ''}
              <button class="btn icon" data-act="remove" aria-label="Satırı kaldır" title="Satırı kaldır">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
              </button>
            </div>
            <div class="row-fields">
              <div class="field"><label for="role-${r.key}">Rol</label>
                <select id="role-${r.key}" data-f="roleId">
                  ${roles.map((x) => opt(x.id, x.label, r.roleId)).join('')}
                  ${opt('custom', 'Anlık rol…', r.roleId)}
                </select></div>
              <div class="field"${om('accountId')}><label for="acc-${r.key}">Hesap</label>
                <select id="acc-${r.key}" data-f="accountId">${accs.map((a) => opt(a.id, accountOptionLabel(a), r.accountId)).join('')}</select></div>
              <div class="field"${om('model')}><label for="model-${r.key}">Model</label>
                <select id="model-${r.key}" data-f="model">${MODELS.map(([v, l]) => opt(v, l, r.model)).join('')}</select></div>
              <div class="field"${om('effort')}><label for="effort-${r.key}">Effort</label>
                <select id="effort-${r.key}" data-f="effort">${EFFORTS.map(([v, l]) => opt(v, l, r.effort || '')).join('')}</select></div>
              <div class="field"${om('permissionMode')}><label for="perm-${r.key}">İzin modu</label>
                <select id="perm-${r.key}" data-f="permissionMode">
                  ${opt('', `Grup: ${permLabel(f.permissionMode)}`, r.permissionMode)}
                  ${PERMISSION_LABELS.map(([v, l]) => opt(v, l, r.permissionMode)).join('')}
                </select></div>
            </div>
            ${r.roleId === 'custom' ? `
              <div class="row-fields">
                <div class="field"><label for="cl-${r.key}">Rol adı</label>
                  <input id="cl-${r.key}" data-f="customLabel" value="${esc(r.customLabel)}" placeholder="güvenlik denetçisi" maxlength="40"></div>
              </div>
              <div class="field"${om('prompt')}><label for="cp-${r.key}">Rol talimatı</label>
                <textarea id="cp-${r.key}" data-f="customPrompt" rows="2" placeholder="Bu oturum ne yapsın, ne yapmasın?">${esc(r.customPrompt)}</textarea></div>
              ${capsHtml ? `<details class="row-more"${'caps' in mk || this.openMore.has(r.key) ? ' open' : ''}><summary>Yetenekler</summary>${capsHtml}</details>` : ''}` : `
              <details class="row-more"${'prompt' in mk || 'caps' in mk || this.openMore.has(r.key) ? ' open' : ''}>
                <summary>Talimat ve yetenekler${r.prompt != null ? ' <span class="badge">bu ekibe özel talimat</span>' : ''}</summary>
                <div class="field"${om('prompt')}><label for="rp-${r.key}">Görevler (yalnızca bu grupta; rolün kayıtlı görevleri değişmez, persona ve sınırlar aynen kalır)</label>
                  <textarea id="rp-${r.key}" data-f="prompt" rows="6">${esc(this.rolePromptOf(r))}</textarea></div>
                ${capsHtml}
              </details>`}
            <div class="links"${om('links')}>
              <label class="check"><input type="checkbox" data-f="talkAll" ${r.talkAll ? 'checked' : ''}>herkesle konuşur</label>
              ${others.length ? '<span>Rapor verir →</span>' : ''}
              ${others.map((o) => {
              const j = f.rows.indexOf(o);
              return `<label class="check"><input type="checkbox" data-f="reportsTo" value="${esc(o.key)}" ${r.reportsTo.includes(o.key) ? 'checked' : ''}>${esc(this.rowLabel(o, j))}</label>`;
            }).join('')}
            </div>
          </div>`;
    }).join('');

    $('#setup').innerHTML = `
        <div class="page-head">
          <div>
            <h1>Kurulum</h1>
            <p class="sub">Rolleri, hesapları ve bağlantıları ayarla, sonra hepsini birlikte başlat.</p>
          </div>
        </div>
        <div class="setup">
          <div class="setup-main">
            <div class="row-fields">
              <div class="field"><label for="g-name">Grup adı</label><input id="g-name" data-f="name" value="${esc(f.name)}" maxlength="60"></div>
              <div class="field"><label for="g-perm">Grubun varsayılan izin modu</label>
                <select id="g-perm" data-f="permissionMode">${PERMISSION_LABELS.map(([v, l]) => opt(v, l, f.permissionMode)).join('')}</select></div>
              <div class="field"><label for="g-links">Bağlantı düzeni</label>
                <select id="g-links" data-f="linkStyle" title="Rol ekleyip çıkardıkça kim kime rapor verecek kendiliğinden ayarlanır; bir bağlantıyı elle değiştirince düzen Elle'ye geçer">${LINK_STYLES.map(([v, l]) => opt(v, l, f.linkStyle || 'zincir')).join('')}</select></div>
            </div>
            ${this.templatesHtml()}
            ${rowsHtml}
            <button class="btn ghost" data-act="add" style="border-style: dashed; color: var(--accent)">${ICON_PLUS} Satır ekle</button>
            <div class="field"><label for="g-task">İlk görev</label>
              <textarea id="g-task" data-f="firstTask" rows="3" placeholder="Başlarken Şef'e (yoksa ilk satıra) gönderilecek mesaj">${esc(f.firstTask)}</textarea>
              <span class="note">Boş bırakırsan oturumlar açılır ve senden komut bekler.</span></div>
            <div class="field">
              <div class="links" style="justify-content: space-between">
                <label for="g-flow" style="font-size: 11px">Akış notu</label>
                <button class="btn small ghost" data-act="regen-flow">↻ Ekipten yeniden oluştur</button>
              </div>
              <textarea id="g-flow" data-f="flowNote" rows="12" class="mono">${esc(f.flowNote)}</textarea>
              <span class="note">Ekip değiştikçe kendiliğinden güncellenir; elle düzenlersen güncelleme durur. Bu not tüm oturumların talimatına eklenir. Şef ayrıca her üyenin tam rol talimatını alır.</span></div>
          </div>
          <aside class="card setup-side" id="setup-side"></aside>
        </div>
        <dialog class="dlg" id="opt-dlg" aria-labelledby="opt-title">
          <div class="dlg-head"><div><h2 id="opt-title">Not ekleyerek optimize et</h2>
            <p class="note">İsteğe bağlı. Boş bırakırsan hedef projeden, son grubun notlarından ve kartlarından çıkarılır.</p></div></div>
          <div class="dlg-body">
            <textarea id="opt-goal" rows="5" placeholder="ör. bu sefer OCR doğruluğuna odaklan, kota az; araştırma ucuz modelde kalsın">${esc(this.optGoal || '')}</textarea>
          </div>
          <div class="dlg-foot">
            <button class="btn ghost" data-act="opt-cancel">Vazgeç</button>
            <button class="btn primary" data-act="opt-run">Optimize et</button>
          </div>
        </dialog>`;
    this.renderSide();
  },

  renderSide() {
    const side = $('#setup-side');
    if (!side) return;
    const f = this.form;
    const counts = {};
    for (const r of f.rows) counts[r.accountId] = (counts[r.accountId] || 0) + 1;
    const label = (key) => {
      const i = f.rows.findIndex((r) => r.key === key);
      return i >= 0 ? this.rowLabel(f.rows[i], i) : '?';
    };
    const map = f.rows.map((r, i) => {
      const to = r.reportsTo.map(label);
      const parts = [];
      if (r.talkAll) parts.push('⇄ herkes');
      if (to.length) parts.push('→ ' + to.join(', '));
      return `${esc(this.rowLabel(r, i))} ${esc(parts.join(' · ') || '—')}`;
    }).join('<br>');
    const o = this.opt;
    const optHtml = `
        <div class="opt-box">
          <div class="opt-btns">
            <button class="btn primary" data-act="optimize" ${this.optBusy ? 'disabled' : ''} title="Rolleri koruyarak model, hesap, izin, bağlantı, talimat ve yetenekleri bu projeye göre ayarlar">${this.optBusy ? 'Optimize ediliyor…' : '✦ Optimize et'}</button>
            <button class="btn icon" data-act="opt-goal" ${this.optBusy ? 'disabled' : ''} aria-label="Not ekleyerek optimize et" title="Not ekleyerek optimize et (isteğe bağlı)">✎</button>
          </div>
          ${this.optBusy ? '<span class="note">Proje, geçmiş harcamalar ve son grubun notları inceleniyor; 1-2 dakika sürebilir.</span>' : ''}
          ${o ? `
            <div class="opt-res">
              <div><b>${o.changed ? `${o.changed} satır değişti` : 'Değişiklik yok'}</b> <span class="note">· ${o.costUSD ? `$${o.costUSD.toFixed(3)} · ` : ''}${o.turns > 1 ? `projeyi ${o.turns - 1} adımda inceledi · ` : ''}${esc(o.account || '')} hesabı</span></div>
              ${o.changed ? '<span class="note">Değişen alanlar işaretli; gerekçe için üzerine gel.</span>' : ''}
              ${(o.added || []).length ? `<div class="note">Eklenen üyeler:</div><ul>${o.added.map((x) => `<li>${esc(x.label)}${x.why ? ` — ${esc(x.why)}` : ''}</li>`).join('')}</ul>` : ''}
              ${(o.removed || []).length ? `<div class="note">Çıkarılan üyeler:</div><ul>${o.removed.map((x) => `<li>${esc(x.label)}${x.why ? ` — ${esc(x.why)}` : ''}</li>`).join('')}</ul>` : ''}
              ${this.optTokHtml(o)}
              ${o.suggestions.length ? `<div class="note">Öneriler:</div><ul>${o.suggestions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
              <div class="opt-btns">
                ${o.before ? '<button class="btn small" data-act="opt-undo">Geri al</button>' : ''}
                <button class="btn small ghost" data-act="opt-dismiss">Kapat</button>
              </div>
            </div>` : ''}
        </div>`;
    side.innerHTML = `
        ${optHtml}
        <h2 style="font-size: 14.5px">Özet</h2>
        <div class="kv"><span>Proje</span><span class="mono">${esc(this.project.name)}</span></div>
        <div class="kv"><span>Oturum</span><span>${f.rows.length}</span></div>
        <div class="kv"><span>Hesaplar</span><span>${Object.entries(counts).map(([k, v]) => `${esc(k)}${v > 1 ? ' ×' + v : ''}`).join(' · ')}</span></div>
        <div style="border-top: 1px solid var(--line); padding-top: 11px">
          <div class="note" style="margin-bottom: 5.5px">Bağlantı haritası</div>
          <div class="mono" style="line-height: 1.7; color: var(--text-2)">${map}</div>
        </div>
        ${this.quotaWarnings()}
        <button class="btn primary" data-act="start" style="min-height: 43px; font-size: 13.5px">Hepsini başlat</button>
        <span class="note" style="text-align: center">${quotaCache ? 'Hesap listelerindeki kota, sayfa açılırken çekildi.' : 'Kota çekiliyor…'}</span>`;
  },
};
