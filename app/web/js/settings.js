// Claude Panel arayüzü · Ayarlar: hesaplar, roller, yetenekler, genel, şablonlar, sistem.
// web/js/ altındaki dosyalar index.html'deki sırayla yüklenen klasik script'lerdir; üst düzey bildirimler ortak
// global kapsamdadır. Yüklenirken çalışan kod yalnızca kendinden önceki dosyaları kullanabilir.
'use strict';
// ---------- 5 · ayarlar ----------

const COLORS = [['blue', 'Mavi'], ['amber', 'Turuncu'], ['violet', 'Mor'], ['green', 'Yeşil']];

const SETTINGS_TABS = [
  ['hesaplar', 'Hesaplar'], ['roller', 'Roller'], ['yetenekler', 'Yetenekler'],
  ['genel', 'Genel'], ['sablonlar', 'Şablonlar'], ['sistem', 'Sistem'],
];
// "Ayarları kaydet" ile kaydedilen sekmeler; diğerlerindeki işlemler hemen uygulanır.
const FORM_TABS = ['hesaplar', 'roller', 'genel'];
const CAP_KIND = { plugin: 'eklenti', skill: 'skill', mcp: 'MCP' };
// Salt okunur rolde kapatılan araçlar (server/core/prompts.js READ_ONLY_TOOLS ile aynı).
const READ_ONLY_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

// "KEY=değer" / "Ad: değer" satırları ile nesne arasında.
const pairsToText = (o, sep) => Object.entries(o || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
function textToPairs(t, sep) {
  const out = {};
  for (const line of String(t || '').split(/\r?\n/)) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + sep.length).trim();
  }
  return out;
}

// Rollerin varsayılan bağlam profili (server/watch.js ROLE_CTX ile aynı): [eşik, üst sınır].
const ROLE_CTX_DEFAULTS = { sef: [500000, 700000], coder: [250000, 500000], review: [200000, 400000], arastirma: [150000, 300000] };
// Sunucudaki bekçi varsayılanlarıyla aynı (server/watch.js); ayar hiç kaydedilmediyse bunlar gösterilir.
const WATCH_DEFAULTS = { enabled: true, act: true, ai: true, quotaHalf: 50, quotaLow: 15, ctxWarn: 250000, ctxHigh: 500000, errStreak: 4, stuckMin: 20 };
const CURATOR_DEFAULTS = { enabled: true, everyH: 3, model: 'sonnet', level: 'orta' };
const CURATOR_LEVELS = [['dusuk', 'Düşük'], ['orta', 'Orta'], ['yuksek', 'Yüksek']];

const SettingsView = {
  mount({ tab, role }) {
    crumbs([{ label: 'Projeler', href: '#/' }, { label: 'Ayarlar' }]);
    this.tab = SETTINGS_TABS.some(([k]) => k === tab) ? tab : 'hesaplar';
    this.model = JSON.parse(JSON.stringify(state.settings));
    this.model.allowedText = this.model.allowedDirs.join('\n');
    // İzin kuralları ekranda satır satır düzenlenir; salt okunur araçları "Salt okunur" kutusu yönetir.
    for (const r of this.model.roles) {
      r.allowText = (r.allow || []).join('\n');
      r.denyText = (r.deny || []).filter((t) => !READ_ONLY_TOOLS.includes(t)).join('\n');
    }
    this.dirty = false;
    // Açık rol sayfası (#/ayarlar/roller/<rol>); yoksa rol listesi.
    this.roleId = this.tab === 'roller' && role ? decodeURIComponent(role) : null;
    // Rol danışmanının açık kartı: { rid, busy, questions, changes, … }.
    this.ropt = null;
    this.caps = null;
    this.capTests = {};
    app.innerHTML = '<div class="page" id="settings"></div>';
    const root = $('#settings');
    root.addEventListener('input', (e) => this.onInput(e));
    root.addEventListener('change', (e) => this.onInput(e));
    root.addEventListener('click', (e) => this.onClick(e));
    this.render();
    this.loadCaps();
  },

  async loadCaps() {
    try {
      this.caps = await api('GET', '/api/caps');
    } catch (err) {
      this.caps = { error: err.message };
    }
    if ($('#settings') && ['yetenekler', 'roller'].includes(this.tab)) this.renderBody();
  },

  setDirty() {
    if (this.dirty) return;
    this.dirty = true;
    this.renderHead();
  },

  onInput(e) {
    const el = e.target;
    if (el.dataset.cap && e.type === 'change') return this.toggleCap(el);
    const f = el.dataset.f;
    if (!f) return;
    const [list, idx, key] = f.split('.');
    const val = el.type === 'checkbox' ? el.checked : el.value;
    if (key) this.model[list][Number(idx)][key] = val;
    else this.model[f] = val;
    this.setDirty();
  },

  async toggleCap(el) {
    el.disabled = true;
    // "group:<tür>": o türdeki bütün yetenekler bu rolde birlikte açılır / kapanır.
    const grp = el.dataset.cap.startsWith('group:') ? el.dataset.cap.slice(6) : null;
    const keys = grp ? (this.caps.inventory || []).filter((x) => x.kind === grp).map((x) => x.key) : null;
    const r = await act(() => api('PUT', '/api/caps/role', grp ? { keys, roleId: el.dataset.role, on: el.checked } : { key: el.dataset.cap, roleId: el.dataset.role, on: el.checked }));
    if (r) {
      this.caps = r;
      if (grp) this.renderBody();
    } else el.checked = !el.checked;
    el.disabled = false;
  },

  async onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    // Sekme bağlantısı adresi değiştirip görünümü yeniden kurmasın; kaydedilmemiş değişiklikler kalır.
    if (b.tagName === 'A') e.preventDefault();
    if (a === 'tab') {
      this.tab = b.dataset.tab;
      this.roleId = null;
      history.replaceState(null, '', `#/ayarlar/${this.tab}`);
      this.render();
    } else if (a === 'add-acc') {
      this.model.accounts.push({ id: '', name: '', configDir: '', color: 'green' });
      this.dirty = true;
      this.render();
    } else if (a === 'del-acc') {
      this.model.accounts.splice(Number(b.dataset.i), 1);
      this.dirty = true;
      this.render();
    } else if (a === 'add-role') {
      const id = `rol${Date.now().toString(36)}`;
      this.model.roles.push({ id, label: '', short: '', persona: '', gorevler: '', sinirlar: '', permissionMode: '', model: '', allowText: '', denyText: '' });
      this.dirty = true;
      this.openRole(id);
      this.renderHead();
    } else if (a === 'del-role') {
      const r = this.model.roles[Number(b.dataset.i)];
      if (r && r.label && !confirm(`"${r.label}" rolü silinsin mi? Kaydedince yetenek atamaları da kalkar.`)) return;
      this.model.roles.splice(Number(b.dataset.i), 1);
      this.dirty = true;
      this.openRole(null);
      this.renderHead();
    } else if (a.startsWith('ropt-')) {
      this.onRoleOpt(a);
    } else if (a === 'role-open') {
      this.openRole(b.dataset.rid);
    } else if (a === 'role-back') {
      this.openRole(null);
    } else if (a === 'role-move') {
      // Sıra kurulumdaki rol listesinin sırasıdır; kaydedince role.json "order"a yazılır.
      const i = Number(b.dataset.i);
      const j = i + Number(b.dataset.dir);
      const list = this.model.roles;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      this.setDirty();
      this.renderBody();
      const again = $(`[data-act="role-move"][data-i="${j}"][data-dir="${b.dataset.dir}"]`);
      if (again && !again.disabled) again.focus();
    } else if (a === 'save') {
      const lines = (t) => String(t || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const body = {
        accounts: this.model.accounts,
        roles: this.model.roles.map(({ allowText, denyText, ...r }) => ({ ...r, allow: lines(allowText), deny: lines(denyText) })),
        allowedDirs: this.model.allowedText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
        port: Number(this.model.port),
        autoRotate: !!this.model.autoRotate,
        watch: Object.fromEntries(Object.keys(WATCH_DEFAULTS).map((k) => {
          const v = this.model[`watch.${k}`] ?? (this.model.watch || {})[k] ?? WATCH_DEFAULTS[k];
          return [k, typeof WATCH_DEFAULTS[k] === 'boolean' ? !!v : Number(v)];
        })),
        contextWindows: Object.fromEntries(FAMILIES.map((k) => [k, Number(this.model[`cw.${k}`] ?? (this.model.contextWindows || {})[k])])),
        curator: Object.fromEntries(Object.keys(CURATOR_DEFAULTS).map((k) => {
          const v = this.model[`cur.${k}`] ?? (this.model.curator || {})[k] ?? CURATOR_DEFAULTS[k];
          return [k, k === 'enabled' ? !!v : k === 'everyH' ? Number(v) : v];
        })),
      };
      const r = await act(() => api('PUT', '/api/settings', body), 'Ayarlar kaydedildi.');
      if (r) {
        this.dirty = false;
        await refresh().catch(() => {});
        this.renderHead();
        this.loadCaps();
        if (r.restartNeeded) toast('Port değişikliği sunucu yeniden başlatılınca geçerli olur.');
      }
    } else if (a === 'notify') {
      if (b.checked) {
        if (!('Notification' in window)) {
          b.checked = false;
          return toast('Bu tarayıcı bildirimleri desteklemiyor.', true);
        }
        const p = await Notification.requestPermission();
        if (p !== 'granted') {
          b.checked = false;
          return toast('Tarayıcı bildirim izni verilmedi.', true);
        }
      }
      store(NOTIFY_KEY, b.checked ? '1' : '0');
      toast(b.checked ? 'Onay bekleyen oturumlar için bildirim açık.' : 'Bildirimler kapalı.');
    } else if (a === 'autostart') {
      const r = await act(() => api('POST', '/api/autostart', { enabled: b.checked }));
      if (r) {
        b.checked = r.autostart;
        toast(r.autostart ? 'Panel Windows açılışında arka planda başlayacak.' : 'Açılışta başlatma kapatıldı.');
      } else b.checked = !b.checked;
    } else if (a === 'shutdown') {
      if (!confirm('Sunucu kapatılsın mı? Paneldeki tüm oturumlar da kapanır (sonra "Grubu devam ettir" ile açılabilir).')) return;
      if (await act(() => api('POST', '/api/shutdown'))) toast('Sunucu kapanıyor.');
    } else if (a === 'tpl-del') {
      const t = (state.templates || []).find((x) => x.id === b.dataset.tid);
      if (!t || !confirm(`"${t.name}" şablonu silinsin mi?`)) return;
      if (await act(() => api('DELETE', `/api/templates/${t.id}`), 'Şablon silindi.')) {
        await refresh().catch(() => {});
        this.renderBody();
      }
    } else if (a === 'rotate') {
      if (!confirm('Erişim anahtarı yenilensin mi? Açık olan diğer panel sekmeleri ve PC pencereleri yeniden bağlanmak zorunda kalır.')) return;
      const r = await act(() => api('POST', '/api/token/rotate'), 'Erişim anahtarı yenilendi.');
      if (r) {
        token = r.token;
        store(TOKEN_KEY, token);
      }
    } else if (a === 'cap-test') {
      this.testCap(b.dataset.key, b.dataset.id ? { id: b.dataset.id } : { key: b.dataset.key });
    } else if (a === 'mcp-new') {
      this.openMcp(null);
    } else if (a === 'mcp-edit') {
      this.openMcp(this.caps.mcps.find((m) => m.id === b.dataset.id));
    } else if (a === 'mcp-del') {
      const m = this.caps.mcps.find((x) => x.id === b.dataset.id);
      if (!m || !confirm(`"${m.name}" MCP'si silinsin mi? Yeni açılan oturumlara artık verilmez.`)) return;
      const r = await act(() => api('DELETE', `/api/caps/mcp/${m.id}`), 'MCP silindi.');
      if (r) { this.caps = r; this.renderBody(); }
    } else if (a === 'skill-new') {
      this.openSkill(null);
    } else if (a === 'skill-edit') {
      const r = await act(() => api('GET', `/api/caps/skill/${b.dataset.name}`));
      if (r) this.openSkill(r);
    } else if (a === 'skill-del') {
      if (!confirm(`"${b.dataset.name}" skill'i silinsin mi? Paneldeki kopyası da silinir.`)) return;
      const r = await act(() => api('DELETE', `/api/caps/skill/${b.dataset.name}`), 'Skill silindi.');
      if (r) { this.caps = r; this.renderBody(); }
    } else if (a.startsWith('dlg-')) {
      this.onDialog(a, b);
    }
  },

  // Rol sayfasını açar (id) ya da listeye döner (null). Adres değişir ama görünüm yeniden kurulmaz; kaydedilmemiş
  // değişiklikler kalır.
  openRole(id) {
    this.roleId = id;
    if (this.ropt && this.ropt.rid !== id) this.ropt = null;
    history.replaceState(null, '', id ? `#/ayarlar/roller/${encodeURIComponent(id)}` : '#/ayarlar/roller');
    this.renderBody();
    window.scrollTo(0, 0);
    const focus = $(id ? '#set-body h2' : '#set-body .role-sum');
    if (focus) focus.focus({ preventScroll: true });
  },

  // ---------- rol danışmanı ----------

  // Ekrandaki (kaydedilmemiş olabilir) rol tanımı: danışman bunun üzerinde çalışır, öneriler buna uygulanır.
  roleDraft(r) {
    const lines = (t) => String(t || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return {
      label: r.label, model: r.model || '', effort: r.effort || '', permissionMode: r.permissionMode || '', readOnly: !!r.readOnly,
      allow: lines(r.allowText), deny: lines(r.denyText), ctxWarn: r.ctxWarn || null, ctxHigh: r.ctxHigh || null,
      persona: r.persona || '', gorevler: r.gorevler || '', sinirlar: r.sinirlar || '',
    };
  },

  async onRoleOpt(a) {
    const r = this.model.roles.find((x) => x.id === this.roleId);
    if (!r) return;
    if (a === 'ropt-cancel') {
      this.ropt = null;
      return this.renderBody();
    }
    // İstek sürerken kullanıcı başka role geçebilir ya da vazgeçebilir; yanıt yalnızca aynı oturuma işlenir.
    const call = async (step, extra, busy) => {
      const cur = { ...(this.ropt || {}), rid: r.id, busy, error: null };
      this.ropt = cur;
      this.renderBody();
      try {
        const res = await api('POST', `/api/roles/${encodeURIComponent(r.id)}/optimize`, { step, role: this.roleDraft(r), ...extra });
        if (this.ropt !== cur) return null;
        cur.busy = null;
        cur.cost = (cur.cost || 0) + (res.costUSD || 0);
        return res;
      } catch (err) {
        if (this.ropt === cur) {
          cur.busy = null;
          cur.error = err.message;
          this.renderBody();
        }
        return null;
      }
    };
    if (a === 'ropt-start') {
      this.ropt = null;
      const res = await call('sorular', {}, 'Rol ve kullanım verisi inceleniyor, sorular hazırlanıyor…');
      if (!res) return;
      Object.assign(this.ropt, { questions: res.questions, summary: res.summary, sessions: res.usage.sessions, changes: null });
      if (!res.questions.length) this.ropt.error = 'Danışman soru üretmedi; yeniden dene.';
      this.renderBody();
    } else if (a === 'ropt-ask') {
      const answers = this.ropt.questions.map((q) => {
        const picked = [...document.querySelectorAll(`[data-ropt-q="${q.id}"]:checked`)].map((x) => x.value);
        const other = ($(`#ropt-o-${q.id}`) || {}).value || '';
        return { soru: q.soru, cevap: [...picked, other.trim()].filter(Boolean).join('; ') };
      }).filter((x) => x.cevap);
      if (!answers.length) return toast('En az bir soruyu cevapla.', true);
      this.ropt.answers = answers;
      const res = await call('oneriler', { answers }, 'Cevaplara göre öneriler hazırlanıyor…');
      if (!res) return;
      Object.assign(this.ropt, { changes: res.changes, rejected: res.rejected, proposalSummary: res.summary });
      // Metin düzeltmeleri işaretli gelir; model, effort, izin, yetenek ve eşikler kullanıcı işaretlerse uygulanır.
      this.ropt.selected = new Set(res.changes.filter((c) => c.kind === 'text').map((c) => c.id));
      this.renderBody();
    } else if (a === 'ropt-apply') {
      const sel = new Set([...document.querySelectorAll('[data-ropt-sel]:checked')].map((x) => x.dataset.roptSel));
      const chosen = this.ropt.changes.filter((c) => sel.has(c.id));
      if (!chosen.length) return toast('Uygulanacak öneri seçilmedi.', true);
      let form = 0;
      const missed = [];
      for (const c of chosen) {
        if (c.kind === 'text') {
          const cur = String(r[c.field] || '');
          const i = c.old ? cur.indexOf(c.old) : -1;
          if (c.old && i < 0) { missed.push(c); continue; }
          r[c.field] = c.old ? cur.slice(0, i) + c.new + cur.slice(i + c.old.length) : `${cur.replace(/\s+$/, '')}${cur.trim() ? '\n' : ''}${c.new}`;
          form++;
        } else if (c.kind === 'set') {
          r[c.field] = c.value;
          form++;
        } else if (c.kind === 'rule') {
          const k = c.field === 'allow' ? 'allowText' : 'denyText';
          r[k] = `${String(r[k] || '').replace(/\s+$/, '')}${String(r[k] || '').trim() ? '\n' : ''}${c.value}`;
          form++;
        }
      }
      // Yetenek işaretleri Yetenekler bölümündeki gibi hemen kaydedilir.
      for (const c of chosen.filter((x) => x.kind === 'cap')) {
        try {
          this.caps = await api('PUT', '/api/caps/role', { key: c.value, roleId: r.id, on: c.on });
        } catch (err) {
          missed.push(c);
        }
      }
      const caps = chosen.filter((c) => c.kind === 'cap' && !missed.includes(c)).length;
      this.ropt = null;
      if (form) this.dirty = true;
      this.renderHead();
      this.renderBody();
      toast([
        form ? `${form} öneri forma uygulandı; dosyaya yazmak için "Ayarları kaydet".` : '',
        caps ? `${caps} yetenek değişikliği kaydedildi.` : '',
        missed.length ? `${missed.length} öneri uygulanamadı (metin bu arada değişmiş olabilir).` : '',
      ].filter(Boolean).join(' '), missed.length > 0);
    }
  },

  // Rol sayfasının üstündeki danışman kartı: bekleme, sorular ya da öneriler.
  roleOptCard(r) {
    const o = this.ropt;
    if (!o || o.rid !== r.id) return '';
    const head = (title, note) => `
          <div class="ropt-head"><h2>${title}</h2>${note ? `<span class="count">${note}</span>` : ''}<span class="grow"></span>
            <button class="btn small ghost" data-act="ropt-cancel">Kapat</button></div>`;
    const cost = o.cost ? `$${o.cost.toFixed(2)} harcandı` : '';
    if (o.busy) return `<section class="card ropt" aria-live="polite">${head('Rol danışmanı', cost)}<p class="note">${esc(o.busy)}</p></section>`;
    const err = o.error ? `<p class="note warn-note">${esc(o.error)}</p>` : '';
    if (o.changes) {
      const LABEL = { persona: 'Persona', gorevler: 'Görevler', sinirlar: 'Sınırlar', model: 'Model', effort: 'Effort', permissionMode: 'İzin modu', readOnly: 'Salt okunur', allow: 'Sormadan izin', deny: 'Kapalı araç', cap: 'Yetenek', ctxWarn: 'Bağlam eşiği', ctxHigh: 'Bağlam üst sınırı' };
      const val = (c) => (c.field === 'permissionMode' ? (c.value ? permLabel(c.value) : 'grup varsayılanı') : c.field === 'readOnly' ? 'açık' : c.value === '' ? 'varsayılan' : String(c.value));
      const cur = (c) => (c.field === 'permissionMode' ? (r.permissionMode ? permLabel(r.permissionMode) : 'grup varsayılanı') : String(r[c.field] || 'varsayılan'));
      const body = (c) => {
        if (c.kind === 'text') {
          return `<div class="ropt-diff">${c.old ? `<del>${esc(c.old)}</del>` : '<span class="note">sona eklenir</span>'}<ins>${esc(c.new)}</ins></div>`;
        }
        if (c.kind === 'cap') return `<div class="mono">${esc(c.value.split(':').slice(1).join(':'))} · ${c.on ? 'aç' : 'kapat'}</div>`;
        if (c.kind === 'rule') return `<div class="mono">+ ${esc(c.value)}</div>`;
        return `<div>${esc(cur(c))} → <b>${esc(val(c))}</b></div>`;
      };
      return `
        <section class="card ropt">
          ${head('Rol danışmanı: öneriler', cost)}
          ${o.proposalSummary ? `<p>${esc(o.proposalSummary)}</p>` : ''}
          ${err}
          ${o.changes.length ? `<div class="ropt-list">${o.changes.map((c) => `
            <label class="ropt-item">
              <input type="checkbox" data-ropt-sel="${c.id}" ${o.selected.has(c.id) ? 'checked' : ''}>
              <span class="ropt-main"><span class="ropt-field">${esc(LABEL[c.field] || c.field)}${c.kind === 'cap' ? ' (hemen kaydedilir)' : ''}</span>
                ${body(c)}
                ${c.why ? `<span class="note">${esc(c.why)}</span>` : ''}</span>
            </label>`).join('')}</div>` : '<p class="note">Danışman değişiklik önermedi; tanım cevaplarını zaten karşılıyor.</p>'}
          ${o.rejected && o.rejected.length ? `<p class="note">${o.rejected.length} öneri küçük değişiklik kuralına uymadığı için gösterilmedi.</p>` : ''}
          <div class="actions">
            <button class="btn ghost" data-act="ropt-start">Baştan sor</button>
            ${o.changes.length ? '<button class="btn primary" data-act="ropt-apply">Seçilenleri forma uygula</button>' : ''}
          </div>
        </section>`;
    }
    if (o.questions) {
      return `
        <section class="card ropt">
          ${head('Rol danışmanı: sorular', [o.sessions ? `${o.sessions} geçmiş oturum incelendi` : 'geçmiş kullanım yok', cost].filter(Boolean).join(' · '))}
          ${o.summary ? `<p>${esc(o.summary)}</p>` : ''}
          ${err}
          ${o.questions.map((q) => `
            <fieldset class="ropt-q">
              <legend>${esc(q.soru)}</legend>
              ${q.neden ? `<p class="note">${esc(q.neden)}</p>` : ''}
              <div class="ropt-opts">${q.secenekler.map((s) => `
                <label class="check"><input type="${q.coklu ? 'checkbox' : 'radio'}" name="ropt-${q.id}" data-ropt-q="${q.id}" value="${esc(s)}">${esc(s)}</label>`).join('')}
              </div>
              <input id="ropt-o-${q.id}" aria-label="${esc(q.soru)}: kendi cevabın" placeholder="Kendi cevabın ya da ek not (isteğe bağlı)">
            </fieldset>`).join('')}
          <div class="actions">
            <button class="btn primary" data-act="ropt-ask">Önerileri al</button>
            <span class="note">Cevapsız sorular atlanır. Öneriler küçük değişikliklerdir; hiçbiri sen kaydetmeden yazılmaz.</span>
          </div>
        </section>`;
    }
    return `<section class="card ropt">${head('Rol danışmanı', cost)}${err}<div class="actions"><button class="btn" data-act="ropt-start">Yeniden dene</button></div></section>`;
  },

  async testCap(slot, payload) {
    this.capTests[slot] = { running: true };
    this.renderBody();
    try {
      this.capTests[slot] = await api('POST', '/api/caps/test', payload);
    } catch (err) {
      this.capTests[slot] = { ok: false, error: err.message };
    }
    if ($('#settings') && this.tab === 'yetenekler') this.renderBody();
  },

  testLine(slot) {
    const t = this.capTests[slot];
    if (!t) return '';
    if (t.running) return '<div class="cap-test note">Bağlanılıyor…</div>';
    if (t.ok) return `<div class="cap-test ok">✓ Çalışıyor · ${t.tools.length} tool${t.tools.length ? `: <span class="mono">${esc(t.tools.slice(0, 12).join(', '))}${t.tools.length > 12 ? '…' : ''}</span>` : ''} · ${t.ms} ms</div>`;
    return `<div class="cap-test err">✕ ${esc(t.error)}${t.stderr ? `<pre class="mono">${esc(t.stderr)}</pre>` : ''}</div>`;
  },

  // ---------- diyaloglar ----------

  openMcp(m) {
    this.dlg = { kind: 'mcp', id: m ? m.id : null };
    const v = m || { name: '', type: 'stdio', command: '', args: [], env: {}, url: '', headers: {}, autoAllow: false };
    const dlg = $('#cap-dlg');
    dlg.innerHTML = `
        <div class="dlg-head"><div><h2 id="cap-dlg-title">${m ? `MCP: ${esc(m.name)}` : 'MCP ekle'}</h2>
          <div class="note">Yalnızca işaretlediğin rollerin oturumlarına verilir; hesap ayarlarına yazılmaz.</div></div>
          <button class="btn icon" data-act="dlg-close" aria-label="Kapat">✕</button></div>
        <div class="dlg-body">
          <div class="row-fields">
            <div class="field"><label for="mc-name">Ad</label><input id="mc-name" class="mono" maxlength="48" value="${esc(v.name)}" placeholder="ör. sshtools"></div>
            <div class="field"><label for="mc-type">Tür</label><select id="mc-type">
              <option value="stdio" ${v.type !== 'http' ? 'selected' : ''}>Komut (stdio)</option>
              <option value="http" ${v.type === 'http' ? 'selected' : ''}>HTTP</option></select></div>
          </div>
          <div class="mc-stdio" ${v.type === 'http' ? 'hidden' : ''}>
            <div class="field"><label for="mc-cmd">Komut</label><input id="mc-cmd" class="mono" value="${esc(v.command || '')}" placeholder="ör. C:\\Python314\\python.exe ya da npx"></div>
            <div class="field"><label for="mc-args">Argümanlar (her satıra bir tane)</label><textarea id="mc-args" class="mono" rows="3" placeholder="-m&#10;app.main">${esc((v.args || []).join('\n'))}</textarea></div>
            <div class="field"><label for="mc-env">Ortam değişkenleri (her satıra AD=değer)</label><textarea id="mc-env" class="mono" rows="3" placeholder="PYTHONPATH=C:\\...&#10;API_TOKEN=\${MY_TOKEN}">${esc(pairsToText(v.env, '='))}</textarea></div>
          </div>
          <div class="mc-http" ${v.type === 'http' ? '' : 'hidden'}>
            <div class="field"><label for="mc-url">Adres</label><input id="mc-url" class="mono" value="${esc(v.url || '')}" placeholder="https://…/mcp"></div>
            <div class="field"><label for="mc-headers">Header'lar (her satıra Ad: değer)</label><textarea id="mc-headers" class="mono" rows="3" placeholder="Authorization: Bearer \${MY_TOKEN}">${esc(pairsToText(v.headers, ': '))}</textarea></div>
          </div>
          <p class="note">Token ve parolayı düz yazmak yerine <span class="mono">\${DEĞİŞKEN}</span> yaz; değer Windows ortam değişkeninden okunur ve panelin dosyalarına girmez.</p>
          <label class="check" style="align-self: flex-start"><input type="checkbox" id="mc-allow" ${v.autoAllow ? 'checked' : ''}>Tool'ları izin sormadan çalışsın</label>
          <div id="mc-test"></div>
        </div>
        <div class="dlg-foot">
          <button class="btn ghost" data-act="dlg-mcp-test" style="margin-right: auto">Dene</button>
          <button class="btn ghost" data-act="dlg-close">Vazgeç</button>
          <button class="btn primary" data-act="dlg-mcp-save">${m ? 'Kaydet' : 'Ekle'}</button>
        </div>`;
    $('#mc-type').addEventListener('change', (e) => {
      const http = e.target.value === 'http';
      $('.mc-stdio', dlg).hidden = http;
      $('.mc-http', dlg).hidden = !http;
    });
    if (!dlg.open) dlg.showModal();
    $('#mc-name').focus();
  },

  mcpForm() {
    return {
      name: $('#mc-name').value.trim(),
      type: $('#mc-type').value,
      command: $('#mc-cmd').value.trim(),
      args: $('#mc-args').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      env: textToPairs($('#mc-env').value, '='),
      url: $('#mc-url').value.trim(),
      headers: textToPairs($('#mc-headers').value, ':'),
      autoAllow: $('#mc-allow').checked,
    };
  },

  openSkill(sk) {
    this.dlg = { kind: 'skill', name: sk ? sk.name : null, mode: 'text' };
    const dlg = $('#cap-dlg');
    dlg.innerHTML = sk ? `
        <div class="dlg-head"><div><h2 id="cap-dlg-title">Skill: ${esc(sk.name)}</h2>
          <div class="note">${sk.files.length} dosya${sk.files.length > 1 ? ` · ${esc(sk.files.filter((f) => f !== 'SKILL.md').slice(0, 6).join(', '))}${sk.files.length > 7 ? '…' : ''}` : ''}. Burada yalnızca SKILL.md düzenlenir.</div></div>
          <button class="btn icon" data-act="dlg-close" aria-label="Kapat">✕</button></div>
        <div class="dlg-body">
          <div class="field"><label for="sk-raw">SKILL.md</label><textarea id="sk-raw" class="mono" rows="20">${esc(sk.text)}</textarea>
            <span class="note">Baştaki --- arasındaki name satırı "${esc(sk.name)}" kalmalı; description Claude'un skill'i ne zaman kullanacağını belirler.</span></div>
        </div>
        <div class="dlg-foot">
          <button class="btn ghost" data-act="dlg-close">Vazgeç</button>
          <button class="btn primary" data-act="dlg-skill-raw">Kaydet</button>
        </div>` : `
        <div class="dlg-head"><div><h2 id="cap-dlg-title">Skill ekle</h2>
          <div class="note">Skill panelde saklanır, yalnızca işaretlediğin rollerin oturumlarına verilir.</div></div>
          <button class="btn icon" data-act="dlg-close" aria-label="Kapat">✕</button></div>
        <div class="dlg-body">
          <div class="seg" role="group" aria-label="Ekleme yolu">
            <button data-act="dlg-skill-mode" data-mode="text" aria-pressed="true">Panelde yaz</button>
            <button data-act="dlg-skill-mode" data-mode="dir" aria-pressed="false">Klasörden</button>
            <button data-act="dlg-skill-mode" data-mode="zip" aria-pressed="false">Zip yükle</button>
          </div>
          <div class="field"><label for="sk-name">Ad <span class="note">(küçük harf, rakam, -)</span></label><input id="sk-name" class="mono" maxlength="64" placeholder="ör. android-sdk"></div>
          <div class="sk-mode" data-mode="text">
            <div class="field"><label for="sk-desc">Açıklama</label><input id="sk-desc" maxlength="1000" placeholder="Ne işe yarar, Claude ne zaman kullanmalı"></div>
            <div class="field"><label for="sk-body">İçerik (talimatlar, Markdown)</label><textarea id="sk-body" rows="12" class="mono"></textarea></div>
          </div>
          <div class="sk-mode" data-mode="dir" hidden>
            <div class="field"><label for="sk-path">Klasör yolu</label><input id="sk-path" class="mono" placeholder="C:\\Users\\…\\android-skill">
              <span class="note">SKILL.md klasörün kökünde ya da tek bir alt klasöründe olmalı. Klasör panele kopyalanır; ad boşsa SKILL.md'deki ad kullanılır.</span></div>
          </div>
          <div class="sk-mode" data-mode="zip" hidden>
            <div class="field"><label for="sk-zip">Zip dosyası (en fazla 20 MB)</label><input id="sk-zip" type="file" accept=".zip,application/zip"></div>
          </div>
        </div>
        <div class="dlg-foot">
          <button class="btn ghost" data-act="dlg-close">Vazgeç</button>
          <button class="btn primary" data-act="dlg-skill-save">Ekle</button>
        </div>`;
    if (!dlg.open) dlg.showModal();
    (sk ? $('#sk-raw') : $('#sk-name')).focus();
  },

  async onDialog(a, b) {
    const dlg = $('#cap-dlg');
    const done = (r, msg) => {
      if (!r) return;
      this.caps = r;
      dlg.close();
      toast(msg);
      this.renderBody();
    };
    if (a === 'dlg-close') return dlg.close();
    if (a === 'dlg-mcp-test') {
      const out = $('#mc-test');
      out.innerHTML = '<div class="cap-test note">Bağlanılıyor…</div>';
      const slot = '__dlg';
      try {
        this.capTests[slot] = await api('POST', '/api/caps/test', { config: this.mcpForm() });
      } catch (err) {
        this.capTests[slot] = { ok: false, error: err.message };
      }
      if ($('#mc-test')) $('#mc-test').innerHTML = this.testLine(slot);
      return;
    }
    if (a === 'dlg-mcp-save') {
      const id = this.dlg.id;
      const r = await act(() => (id ? api('PUT', `/api/caps/mcp/${id}`, this.mcpForm()) : api('POST', '/api/caps/mcp', this.mcpForm())));
      return done(r, id ? 'MCP kaydedildi.' : 'MCP eklendi. Hangi rollere verileceğini işaretle.');
    }
    if (a === 'dlg-skill-mode') {
      this.dlg.mode = b.dataset.mode;
      for (const x of dlg.querySelectorAll('[data-act="dlg-skill-mode"]')) x.setAttribute('aria-pressed', String(x === b));
      for (const x of dlg.querySelectorAll('.sk-mode')) x.hidden = x.dataset.mode !== this.dlg.mode;
      return;
    }
    if (a === 'dlg-skill-raw') {
      const r = await act(() => api('POST', '/api/caps/skill', { mode: 'raw', name: this.dlg.name, text: $('#sk-raw').value }));
      return done(r, 'Skill kaydedildi. Yeni açılan oturumlarda geçerli.');
    }
    if (a === 'dlg-skill-save') {
      const name = $('#sk-name').value.trim();
      const mode = this.dlg.mode;
      let r;
      if (mode === 'zip') {
        const f = $('#sk-zip').files[0];
        if (!f) return toast('Zip dosyası seç.', true);
        r = await act(async () => {
          const res = await fetch(`/api/caps/skill-zip?name=${encodeURIComponent(name)}`, {
            method: 'POST', headers: { 'x-panel-token': token || '', 'content-type': 'application/zip' }, body: f,
          });
          const data = await res.json().catch(() => null);
          if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
          return data;
        });
      } else if (mode === 'dir') {
        r = await act(() => api('POST', '/api/caps/skill', { mode: 'dir', path: $('#sk-path').value, name }));
      } else {
        r = await act(() => api('POST', '/api/caps/skill', { mode: 'text', name, description: $('#sk-desc').value, body: $('#sk-body').value }));
      }
      return done(r, 'Skill eklendi. Hangi rollere verileceğini işaretle.');
    }
  },

  // ---------- çizim ----------

  render() {
    $('#settings').innerHTML = `
        <div class="page-head" id="set-head"></div>
        <div class="set-layout">
          <nav class="set-nav" role="tablist" aria-label="Ayar bölümleri">
            ${SETTINGS_TABS.map(([k, l]) => `<button role="tab" data-act="tab" data-tab="${k}" aria-selected="${k === this.tab}">${l}</button>`).join('')}
          </nav>
          <div class="set-body" id="set-body" role="tabpanel"></div>
        </div>
        <dialog class="dlg" id="cap-dlg" aria-labelledby="cap-dlg-title"></dialog>`;
    this.renderHead();
    this.renderBody();
  },

  renderHead() {
    const head = $('#set-head');
    if (!head) return;
    const form = FORM_TABS.includes(this.tab);
    head.innerHTML = `
        <div><h1>Ayarlar</h1><p class="sub">${form ? 'Bu bölümdeki değişiklikler "Ayarları kaydet" ile uygulanır.' : 'Bu bölümdeki işlemler hemen uygulanır.'}</p></div>
        ${this.dirty ? '<span class="dirty-note">● Kaydedilmemiş değişiklik var</span>' : ''}
        ${form || this.dirty ? '<button class="btn primary" data-act="save">Ayarları kaydet</button>' : ''}`;
  },

  renderBody() {
    const body = $('#set-body');
    if (!body) return;
    const fn = {
      hesaplar: this.tabAccounts, roller: this.tabRoles, yetenekler: this.tabCaps,
      genel: this.tabGeneral, sablonlar: this.tabTemplates, sistem: this.tabSystem,
    }[this.tab];
    body.innerHTML = fn.call(this);
  },

  tabAccounts() {
    const m = this.model;
    const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
    return `
        <section class="section">
          <div class="section-head"><h2>Hesaplar</h2><span class="count">her hesap bir yapılandırma klasörüne bağlı</span></div>
          <div class="card settings-list">
            ${m.accounts.map((a, i) => `
              <div class="item">
                <div class="field"><label for="ai-${i}">Kısa ad</label><input id="ai-${i}" data-f="accounts.${i}.id" value="${esc(a.id)}" maxlength="12"></div>
                <div class="field"><label for="an-${i}">Hesap adı</label><input id="an-${i}" data-f="accounts.${i}.name" value="${esc(a.name)}" maxlength="40"></div>
                <div class="field"><label for="ad-${i}">Yapılandırma klasörü</label><input id="ad-${i}" class="mono" data-f="accounts.${i}.configDir" value="${esc(a.configDir)}"></div>
                <div class="actions" style="align-self: end">
                  <select aria-label="Renk" data-f="accounts.${i}.color" style="width: 99px">${COLORS.map(([v, l]) => opt(v, l, a.color)).join('')}</select>
                  <button class="btn icon" data-act="del-acc" data-i="${i}" aria-label="Hesabı kaldır" title="Hesabı kaldır">✕</button>
                </div>
              </div>`).join('')}
          </div>
          <div><button class="btn ghost" data-act="add-acc">${ICON_PLUS} Hesap ekle</button></div>
          <p class="note">Paneldeki oturumlar bu klasörü CLAUDE_CONFIG_DIR olarak kullanır; PowerShell'deki claude32 / claude37 / claudeselo ile aynı mantık.</p>
        </section>`;
  },

  // Rolün aldığı panel yetenekleri ve kapatılan global yetenekler (kayıtlı rol kimliğine göre).
  roleCaps(rid) {
    const c = this.caps;
    if (!c || c.error) return null;
    const add = [...c.mcps.filter((m) => m.roles.includes(rid)).map((m) => m.name), ...c.skills.filter((s) => s.roles.includes(rid)).map((s) => s.name)];
    const off = Object.entries(c.globalOff).filter(([, roles]) => roles.includes(rid)).map(([k]) => k.split(':').slice(1).join(':').split('@')[0]);
    return { add, off };
  },

  tabRoles() {
    const i = this.roleId ? this.model.roles.findIndex((r) => r.id === this.roleId) : -1;
    if (i >= 0) return this.rolePage(this.model.roles[i], i);
    this.roleId = null;
    const m = this.model;
    const modelLabel = (v) => (MODELS.find(([x]) => x === v) || [v, v])[1];
    const firstLine = (t) => String(t || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
    const last = m.roles.length - 1;
    return `
        <section class="section">
          <div class="section-head"><h2>Roller</h2><span class="count">${m.roles.length} rol · kurulumda bu sırayla listelenir</span></div>
          <div class="card role-list">
            ${m.roles.map((r, i) => {
            const rc = this.roleCaps(r.id);
            return `
              <div class="role-row">
                <button class="role-sum" data-act="role-open" data-rid="${esc(r.id)}">
                  <span class="rdot" style="background: ${roleColor({ roleId: r.id, roleLabel: r.label })}"></span>
                  <span class="rs-main">
                    <span class="rs-top"><span class="rs-name">${esc(r.label || 'Adsız rol')}</span><span class="mono note">${esc(r.short || '')}</span>
                      ${r.model ? `<span class="badge">${esc(modelLabel(r.model))}${r.effort ? ` · ${esc(r.effort)}` : ''}</span>` : ''}
                      ${r.permissionMode ? `<span class="badge">${esc(permLabel(r.permissionMode))}</span>` : ''}
                      ${r.readOnly ? '<span class="badge">salt okunur</span>' : ''}
                      ${rc && rc.add.length ? `<span class="badge acc-green">+${rc.add.length} yetenek</span>` : ''}
                      ${rc && rc.off.length ? `<span class="badge">${rc.off.length} kapalı</span>` : ''}</span>
                    <span class="rs-desc">${esc(firstLine(r.gorevler) || 'Görev yazılmadı')}</span>
                  </span>
                  <span class="chev" aria-hidden="true">›</span>
                </button>
                <div class="role-move">
                  <button class="btn icon small" data-act="role-move" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="${esc(r.label || 'Rol')}: yukarı taşı" title="Yukarı taşı">↑</button>
                  <button class="btn icon small" data-act="role-move" data-i="${i}" data-dir="1" ${i === last ? 'disabled' : ''} aria-label="${esc(r.label || 'Rol')}: aşağı taşı" title="Aşağı taşı">↓</button>
                </div>
              </div>`;
          }).join('')}
          </div>
          <div><button class="btn ghost" data-act="add-role">${ICON_PLUS} Rol ekle</button></div>
        </section>`;
  },

  // Tek rolün sayfası: rolün bütün ayarları (role.json, permissions.json, üç metin) ve yetenekleri.
  rolePage(r, i) {
    const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
    const ctx = ROLE_CTX_DEFAULTS[r.id];
    return `
        <div class="role-page-top">
          <button class="btn small ghost" data-act="role-back">← Roller</button>
        </div>
        <div class="role-title">
          <span class="rdot" style="background: ${roleColor({ roleId: r.id, roleLabel: r.label })}"></span>
          <h2 tabindex="-1">${esc(r.label || 'Adsız rol')}</h2>
          <span class="mono note" title="Rolün kimliği ve klasörü: prompts/roles/${esc(r.id)}/">${esc(r.id)}</span>
          <span class="grow"></span>
          ${state.settings.roles.some((x) => x.id === r.id)
    ? `<button class="btn small" data-act="ropt-start" ${this.ropt && this.ropt.rid === r.id && this.ropt.busy ? 'disabled' : ''} title="Rolü ve geçmiş kullanımını inceler, sana sorular sorar, cevaplarına göre küçük değişiklikler önerir (Sonnet, iki kısa çağrı)">✦ Rolü optimize et</button>`
    : ''}
          <button class="btn small ghost danger-text" data-act="del-role" data-i="${i}">Rolü sil</button>
        </div>
        ${this.roleOptCard(r)}

        <section class="section">
          <div class="section-head"><h2>Genel</h2></div>
          <div class="card set-card cols2">
            <div class="field"><label for="rl-${i}">Rol adı</label><input id="rl-${i}" data-f="roles.${i}.label" value="${esc(r.label)}" maxlength="40"></div>
            <div class="field"><label for="rs-${i}">Oturum adındaki kısa hali</label><input id="rs-${i}" data-f="roles.${i}.short" value="${esc(r.short)}" maxlength="24"></div>
            <div class="field"><label for="rmo-${i}">Varsayılan model</label>
              <select id="rmo-${i}" data-f="roles.${i}.model">${MODELS.map(([v, l]) => opt(v, l, r.model || '')).join('')}</select></div>
            <div class="field"><label for="ref-${i}">Varsayılan effort</label>
              <select id="ref-${i}" data-f="roles.${i}.effort">${EFFORTS.map(([v, l]) => opt(v, l, r.effort || '')).join('')}</select></div>
          </div>
        </section>

        <section class="section">
          <div class="section-head"><h2>Metinler</h2><span class="count">rolün sistem istemindeki bölümleri</span></div>
          <div class="card set-card">
            <div class="field"><label for="rpe-${i}">Persona</label><textarea id="rpe-${i}" rows="12" data-f="roles.${i}.persona">${esc(r.persona)}</textarea>
              <span class="note">Kimsin, neye öncelik verirsin, deneyimle neyi fark edersin. Görev ya da yasak yazma; onların yeri aşağıda.</span></div>
            <div class="field"><label for="rp-${i}">Görevler</label><textarea id="rp-${i}" rows="16" data-f="roles.${i}.gorevler">${esc(r.gorevler)}</textarea>
              <span class="note">Ne yaparsın, hangi sırayla, hangi skill'i ne zaman çağırırsın. İlk satır tek cümlelik özet. Şef ekibin yalnızca bu metnini görür.</span></div>
            <div class="field"><label for="rsi-${i}">Sınırlar</label><textarea id="rsi-${i}" rows="8" data-f="roles.${i}.sinirlar">${esc(r.sinirlar)}</textarea>
              <span class="note">Ne yapmazsın ve neden. Zorlanabilenler aşağıdaki İzinler'de uygulanır.</span></div>
          </div>
        </section>

        <section class="section">
          <div class="section-head"><h2>İzinler</h2><span class="count">oturuma zorlanır</span></div>
          <div class="card set-card cols2">
            <div class="field"><label for="rm-${i}">Varsayılan izin modu</label>
              <select id="rm-${i}" data-f="roles.${i}.permissionMode">
                ${opt('', 'Grup varsayılanı', r.permissionMode || '')}
                ${PERMISSION_LABELS.map(([v, l]) => opt(v, l, r.permissionMode)).join('')}
              </select></div>
            <label class="check" style="align-self: end"><input type="checkbox" data-f="roles.${i}.readOnly" ${r.readOnly ? 'checked' : ''}>Salt okunur (Edit, Write, NotebookEdit kapalı)</label>
            <div class="field"><label for="ral-${i}">Sormadan izin verilenler (her satıra bir kural)</label>
              <textarea id="ral-${i}" class="mono" rows="4" data-f="roles.${i}.allowText" placeholder="Bash(npm test:*)">${esc(r.allowText)}</textarea></div>
            <div class="field"><label for="rde-${i}">Kapalı araçlar (her satıra bir kural)</label>
              <textarea id="rde-${i}" class="mono" rows="4" data-f="roles.${i}.denyText" placeholder="Bash(git push:*)">${esc(r.denyText)}</textarea></div>
            <p class="note" style="grid-column: 1 / -1">Kurallar Claude Code izin yazımıyla: araç adı (<span class="mono">WebFetch</span>) ya da araç ve desen (<span class="mono">Bash(npm test:*)</span>). Yeni açılan ya da yenilenen oturumda geçerli olur.</p>
          </div>
        </section>

        <section class="section">
          <div class="section-head"><h2>Bağlam</h2><span class="count">bekçinin bu roldeki eşikleri</span></div>
          <div class="card set-card cols2">
            <div class="field"><label for="rcw-${i}">Bağlam eşiği (token)</label><input id="rcw-${i}" type="number" step="10000" data-f="roles.${i}.ctxWarn" value="${esc(r.ctxWarn || '')}" placeholder="${esc(ctx ? ctx[0] : 'genel ayar')}"></div>
            <div class="field"><label for="rch-${i}">Bağlam üst sınırı (token)</label><input id="rch-${i}" type="number" step="10000" data-f="roles.${i}.ctxHigh" value="${esc(r.ctxHigh || '')}" placeholder="${esc(ctx ? ctx[1] : 'genel ayar')}"></div>
            <p class="note" style="grid-column: 1 / -1">Eşiği geçen üye işi bitip 3 dakika boş kalınca, üst sınırı geçen ilk uygun anda bekçiden hamle alır; iki compact'tan sonraki hamle devir notuyla yenilemedir. Boş bırakılırsa rolün varsayılanı (yer tutucudaki değer) ya da genel ayar kullanılır.</p>
          </div>
        </section>

        <section class="section">
          <div class="section-head"><h2>Yetenekler</h2><span class="count">işaret hemen kaydedilir</span></div>
          ${this.roleCapsEditor(r.id)}
        </section>`;
  },

  // Rol sayfasındaki yetenek listesi: Yetenekler sekmesindeki işaretlerin yalnızca bu rol için olanı (aynı istek).
  roleCapsEditor(rid) {
    if (!state.settings.roles.some((x) => x.id === rid)) return '<p class="note">Rolü kaydedince yeteneklerini buradan seçebilirsin.</p>';
    const c = this.caps;
    if (!c) return '<div class="note">Yetenekler yükleniyor…</div>';
    if (c.error) return `<div class="empty">Yetenekler alınamadı: ${esc(c.error)}</div>`;
    const inv = c.inventory || [];
    const offOf = (key) => c.globalOff[key] || [];
    const on = (key) => !offOf(key).includes(rid);
    const row = (key, checked, name, badges, desc) => `
          <label class="cap-check">
            <input type="checkbox" data-cap="${esc(key)}" data-role="${esc(rid)}" ${checked ? 'checked' : ''}>
            <span class="cc-main"><span class="cap-head"><span class="cap-name mono">${esc(name)}</span>${badges}</span>
              ${desc ? `<span class="cap-desc">${esc(desc)}</span>` : ''}</span>
          </label>`;
    const tok = (x) => (x.chars ? `<span class="note">~${Math.round(x.chars / CHARS_PER_TOK)} tok</span>` : '');
    const card = (title, rows, note) => (rows.length ? `
          <div class="section-head"><h3>${title}</h3><span class="count">${rows.length}</span></div>
          ${note ? `<p class="note">${note}</p>` : ''}
          <div class="card cap-list">${rows.join('')}</div>` : '');
    const panel = [
      ...c.mcps.map((m) => row(`pmcp:${m.id}`, m.roles.includes(rid), m.name, '<span class="badge acc-green">panel</span><span class="badge">MCP</span>', m.type === 'http' ? m.url : [m.command, ...(m.args || [])].join(' '))),
      ...c.skills.map((s) => row(`pskill:${s.name}`, s.roles.includes(rid), s.name, `<span class="badge acc-green">${s.builtin ? 'panel' : 'yerel'}</span><span class="badge">skill</span>`, s.description)),
    ];
    const global = [
      ...inv.filter((x) => x.kind === 'mcp').map((x) => row(x.key, on(x.key), x.name, '<span class="badge">MCP</span>', x.description)),
      ...inv.filter((x) => x.kind === 'skill').map((x) => row(x.key, on(x.key), x.name, '<span class="badge">skill</span>', x.description)),
      ...inv.filter((x) => x.kind === 'plugin').map((x) => row(x.key, on(x.key), x.name, `<span class="badge">eklenti</span>${x.hooks ? '<span class="badge warn" title="Kapatınca arka planda yaptığı iş de durur">kancalı</span>' : ''}${tok(x)}`, x.description)),
    ];
    // Oturumlarda görülen skill türleri kalabalık: tür başına "hepsi" işareti ve açılır liste.
    const seen = [['synced', 'claude.ai skill\'leri'], ['project', 'Proje skill\'leri'], ['bundled', 'Claude Code yerleşik skill\'leri']].map(([kind, title]) => {
      const list = inv.filter((x) => x.kind === kind);
      if (!list.length) return '';
      const openCount = list.filter((x) => on(x.key)).length;
      return `
          <div class="card cap-list">
            ${row(`group:${kind}`, openCount > 0, `${title}: hepsi`, `<span class="note">${openCount}/${list.length} açık</span>`, 'İşareti kaldırınca bu roldeki hepsi kapanır.')}
            <details class="cap-more"><summary>Tek tek seç</summary>
              ${list.map((x) => row(x.key, on(x.key), x.name, tok(x), x.description)).join('')}
            </details>
          </div>`;
    }).join('');
    return `
        <p class="note">Değişiklik yeni açılan ya da yenilenen oturumda geçerli olur. Yeni yetenek eklemek ve diğer rollerle birlikte görmek için <a href="#/ayarlar/yetenekler" data-act="tab" data-tab="yetenekler">Yetenekler</a>.</p>
        ${card('Panel yetenekleri', panel, 'Panelle gelen ya da panelden eklenen; yalnızca işaretli rollere verilir.')}
        ${card('Hesaplarda kurulu olanlar', global, 'İşareti kaldırınca bu roldeki oturumlarda kapanır; hesap ayarların değişmez.')}
        ${seen}`;
  },

  // Rol işaret kutuları: panel yeteneğinde açık roller, global olanda kapatılmamış roller işaretli.
  roleChecks(key, isOn) {
    return `<div class="rchips">${state.settings.roles.map((r) => `
        <label class="rchip"><input type="checkbox" data-cap="${esc(key)}" data-role="${esc(r.id)}" ${isOn(r.id) ? 'checked' : ''}>
          <span class="rdot" style="background: ${roleColor({ roleId: r.id, roleLabel: r.label })}"></span>${esc(r.short || r.label)}</label>`).join('')}</div>`;
  },

  tabCaps() {
    const c = this.caps;
    if (!c) return '<div class="note">Yetenekler yükleniyor…</div>';
    if (c.error) return `<div class="empty">Yetenekler alınamadı: ${esc(c.error)}</div>`;
    const inv = c.inventory || [];
    const offOf = (key) => c.globalOff[key] || [];
    const accs = (x) => `hesap: ${x.accounts.join(', ')}`;
    const unsaved = this.dirty ? '<p class="note warn-note">Rollerde kaydedilmemiş değişiklik var; yeni ya da yeniden adlandırılan roller kaydedince burada görünür.</p>' : '';

    const mcpRows = [
      ...c.mcps.map((m) => `
          <div class="cap-row">
            <div class="cap-head">
              <span class="cap-name mono">${esc(m.name)}</span><span class="badge acc-green">panel</span>
              <span class="badge">${m.type === 'http' ? 'HTTP' : 'komut'}</span>
              ${m.autoAllow ? '<span class="badge">izin sormaz</span>' : ''}
              <span class="grow"></span>
              <button class="btn small ghost" data-act="cap-test" data-key="pmcp:${esc(m.id)}" data-id="${esc(m.id)}">Dene</button>
              <button class="btn small ghost" data-act="mcp-edit" data-id="${esc(m.id)}">Düzenle</button>
              <button class="btn small ghost danger-text" data-act="mcp-del" data-id="${esc(m.id)}">Sil</button>
            </div>
            <div class="cap-desc mono">${esc(m.type === 'http' ? m.url : [m.command, ...(m.args || [])].join(' '))}${Object.keys(m.type === 'http' ? m.headers || {} : m.env || {}).length ? ` <span class="note">· ${esc(Object.keys(m.type === 'http' ? m.headers : m.env).map((k) => `${k}=•••`).join(' '))}</span>` : ''}</div>
            ${this.testLine(`pmcp:${m.id}`)}
            ${this.roleChecks(`pmcp:${m.id}`, (rid) => m.roles.includes(rid))}
          </div>`),
      ...inv.filter((x) => x.kind === 'mcp').map((x) => `
          <div class="cap-row">
            <div class="cap-head">
              <span class="cap-name mono">${esc(x.name)}</span><span class="badge">global</span><span class="note">${esc(accs(x))}</span>
              <span class="grow"></span>
              <button class="btn small ghost" data-act="cap-test" data-key="${esc(x.key)}">Dene</button>
            </div>
            <div class="cap-desc mono">${esc(x.description)}</div>
            ${this.testLine(x.key)}
            ${this.roleChecks(x.key, (rid) => !offOf(x.key).includes(rid))}
          </div>`),
    ];

    const globalSkillNames = new Set(inv.filter((x) => x.kind === 'skill').map((x) => x.name));
    const skillRows = [
      ...c.skills.map((s) => `
          <div class="cap-row">
            <div class="cap-head">
              <span class="cap-name mono">${esc(s.name)}</span>
              ${s.builtin
              ? `<span class="badge acc-green" title="Panelle gelen skill (depodaki skills/ klasörü); panelden düzenlenmez. Varsayılan roller: ${esc((s.defaults || []).join(', ') || 'yok')}">panel</span>`
              : '<span class="badge" title="Panelden eklediğin skill (data/skills)">yerel</span>'}
              ${globalSkillNames.has(s.name) ? '<span class="badge warn" title="Global skill ile aynı ad; o rolde global olanı kapatırsan bu da gizlenir">ad çakışıyor</span>' : ''}
              <span class="grow"></span>
              ${s.builtin ? '' : `<button class="btn small ghost" data-act="skill-edit" data-name="${esc(s.name)}">Düzenle</button>
              <button class="btn small ghost danger-text" data-act="skill-del" data-name="${esc(s.name)}">Sil</button>`}
            </div>
            <div class="cap-desc">${esc(s.description)}</div>
            ${this.roleChecks(`pskill:${s.name}`, (rid) => s.roles.includes(rid))}
          </div>`),
      ...inv.filter((x) => x.kind === 'skill').map((x) => `
          <div class="cap-row">
            <div class="cap-head"><span class="cap-name mono">${esc(x.name)}</span><span class="badge">global</span><span class="note">${esc(accs(x))}</span></div>
            <div class="cap-desc">${esc(x.description)}</div>
            ${this.roleChecks(x.key, (rid) => !offOf(x.key).includes(rid))}
          </div>`),
    ];

    // Oturumlarda görülen yerleşik ve claude.ai skill'leri: tür başına bir "bu rolde hepsi" satırı, ardından tek tek.
    const tok = (x) => (x.chars ? `<span class="note">~${Math.round(x.chars / CHARS_PER_TOK)} tok</span>` : '');
    const seenSection = (kind, title, note) => {
      const list = inv.filter((x) => x.kind === kind);
      if (!list.length) return '';
      const total = Math.round(list.reduce((a, x) => a + (x.chars || 0), 0) / CHARS_PER_TOK);
      const allOn = (rid) => list.some((x) => !offOf(x.key).includes(rid));
      return `
        <section class="section">
          <div class="section-head"><h2>${title}</h2><span class="count">${list.length}</span><span class="note">hepsi açıkken her istekte ~${total} tok</span></div>
          <p class="note">${note}</p>
          <div class="card cap-list">
            <div class="cap-row">
              <div class="cap-head"><span class="cap-name">Bu türün hepsi</span><span class="note">işareti kaldırınca o rolde hepsi kapanır; en az biri açıksa işaretli görünür</span></div>
              ${this.roleChecks(`group:${kind}`, allOn)}
            </div>
            ${list.map((x) => `
            <div class="cap-row">
              <div class="cap-head"><span class="cap-name mono">${esc(x.name)}</span>${tok(x)}</div>
              <div class="cap-desc">${esc(x.description)}</div>
              ${this.roleChecks(x.key, (rid) => !offOf(x.key).includes(rid))}
            </div>`).join('')}
          </div>
        </section>`;
    };

    const pluginRows = inv.filter((x) => x.kind === 'plugin').map((x) => `
        <div class="cap-row">
          <div class="cap-head"><span class="cap-name mono">${esc(x.name)}</span><span class="badge">global</span>${x.hooks ? '<span class="badge warn" title="Kapatınca arka planda yaptığı iş de durur">kancalı</span>' : ''}${tok(x)}<span class="note">${esc(x.id)} · ${esc(accs(x))}</span></div>
          ${x.description ? `<div class="cap-desc">${esc(x.description)}</div>` : ''}
          ${this.roleChecks(x.key, (rid) => !offOf(x.key).includes(rid))}
        </div>`);

    const empty = (t) => `<div class="note" style="padding: 12.5px 14.5px">${t}</div>`;
    return `
        <p class="note">Panel yetenekleri yalnızca işaretli rollere verilir. Global olanlar hesaplarda kurulu; işareti kaldırdığın rolde o oturumlar için kapanır, hesap ayarların değişmez. MCP ve eklenti değişiklikleri yeni açılan ya da yeniden başlatılan oturumlarda geçerli olur. Skill listesi oturumun geçmişinde durduğu için skill değişikliği yeni açılan ya da yenilenen oturumda, devam ettirilen oturumda ise bir sonraki compact'tan sonra geçerli olur.</p>
        ${unsaved}
        <section class="section">
          <div class="section-head"><h2>MCP sunucuları</h2><span class="count">${mcpRows.length}</span><span class="grow"></span>
            <button class="btn small" data-act="mcp-new">${ICON_PLUS} MCP ekle</button></div>
          <div class="card cap-list">${mcpRows.join('') || empty('MCP yok.')}</div>
        </section>
        <section class="section">
          <div class="section-head"><h2>Skill'ler</h2><span class="count">${skillRows.length}</span><span class="grow"></span>
            <button class="btn small" data-act="skill-new">${ICON_PLUS} Skill ekle</button></div>
          <div class="card cap-list">${skillRows.join('') || empty('Skill yok.')}</div>
        </section>
        <section class="section">
          <div class="section-head"><h2>Eklentiler</h2><span class="count">${pluginRows.length}</span></div>
          <p class="note">Eklenti kapatılınca içindeki MCP'ler ve skill'ler birlikte kapanır.</p>
          <div class="card cap-list">${pluginRows.join('') || empty('Açık eklenti yok.')}</div>
        </section>
        ${seenSection('synced', 'claude.ai skill\'leri', 'claude.ai hesabından eşitlenen skill\'ler. Açıklamaları her istekte bağlama girer; rolün kullanmayacaklarını kapat.')}
        ${seenSection('project', 'Proje skill\'leri', 'Proje klasörlerindeki .claude/skills; yalnızca o projede açılan oturumlarda görünür.')}
        ${seenSection('bundled', 'Claude Code yerleşik skill\'leri', 'Claude Code ile gelen skill\'ler. Liste oturum kayıtlarından öğrenilir; yeni sürümde gelen skill bir oturum açılınca burada görünür.')}`;
  },

  tabGeneral() {
    const m = this.model;
    const wv = (k) => m[`watch.${k}`] ?? (m.watch || {})[k] ?? WATCH_DEFAULTS[k];
    const cv = (k) => m[`cur.${k}`] ?? (m.curator || {})[k] ?? CURATOR_DEFAULTS[k];
    return `
        <section class="section">
          <div class="section-head"><h2>Sunucu</h2></div>
          <div class="card set-card grid2">
            <div class="field"><label for="s-port">Port</label><input id="s-port" type="number" data-f="port" value="${esc(m.port)}"></div>
            <div class="field"><span class="lbl">Oturum kabuğu</span><div class="mono" style="padding-top: 9px">${esc(m.shell)}</div></div>
            <div class="field" style="grid-column: 1 / -1"><label for="s-dirs">İzinli proje klasörleri (her satıra bir klasör)</label>
              <textarea id="s-dirs" rows="3" class="mono" data-f="allowedText">${esc(m.allowedText)}</textarea>
              <span class="note">Proje ve oturumlar yalnızca bu klasörlerin altında açılabilir.</span></div>
          </div>
        </section>
        <section class="section">
          <div class="section-head"><h2>Otomasyon</h2></div>
          <div class="card set-card">
            <label class="check" style="align-self: flex-start"><input type="checkbox" data-f="autoRotate" ${m.autoRotate ? 'checked' : ''}>Kota dolunca hesabı otomatik değiştir</label>
            <p class="note">Açıkken panel 5 dakikada bir kotayı çeker. Bir hesabın kotası dolduğunda o hesaptaki "sıra sende" durumundaki oturumlar, en çok kotası kalan hesaba taşınır ve kaldığı yerden devam eder. Çalışan bir iş yarıda kesilmez. Proje klasörünü onaylamamış hesaba taşınmaz. Bekçisi hamle yapan gruplarda taşımayı bekçi yapar; bu ayar yalnızca bekçisi kapalı ya da yalnızca uyaran gruplar içindir.</p>
          </div>
        </section>
        <section class="section">
          <div class="section-head"><h2>Bekçi</h2><span class="count">grupların varsayılanı; her grup kendi çalışma ekranındaki Bekçi görünümünden ayrıca açılıp kapatılabilir</span></div>
          <div class="card set-card" style="display: grid; gap: 12.5px; grid-template-columns: repeat(auto-fit, minmax(162px, 1fr))">
            <label class="check" style="grid-column: 1 / -1; align-self: flex-start"><input type="checkbox" data-f="watch.enabled" ${wv('enabled') ? 'checked' : ''}>Bekçi açık</label>
            <label class="check" style="grid-column: 1 / -1; align-self: flex-start"><input type="checkbox" data-f="watch.act" ${wv('act') ? 'checked' : ''}>Hamleleri kendisi yapsın (compact, hesap taşıma, yenileme); kapalıyken yalnızca öneri bildirimi çıkar</label>
            <label class="check" style="grid-column: 1 / -1; align-self: flex-start"><input type="checkbox" data-f="watch.ai" ${wv('ai') ? 'checked' : ''}>Kararı yardımcı model (Haiku) versin; kapalıyken panelin kuralları seçer</label>
            ${[['quotaHalf', 'Kota yarılama uyarısı (% kullanıldı)'], ['quotaLow', 'Kritik kota (% kaldı)'], ['ctxWarn', 'Bağlam eşiği, profili olmayan roller (token)'], ['ctxHigh', 'Bağlam üst sınırı, profili olmayan roller (token)'], ['errStreak', 'Art arda hatalı tool'], ['stuckMin', 'Takılma süresi (dk)']]
  .map(([k, label]) => `<div class="field"><label for="w-${k}">${label}</label><input id="w-${k}" type="number" data-f="watch.${k}" value="${esc(wv(k))}"></div>`).join('')}
            <p class="note" style="grid-column: 1 / -1">Bekçi dakikada bir kota, bağlam ve takılma sinyallerine bakar. Kotası azalan üyeyi başka hesaba taşır, bağlamı büyüyeni compact eder ya da devir notu yazdırıp aynı adla sıfır bağlamla yeniden açar; bunları üye boştayken ya da işini bitirirken yapar, şefe yalnızca bilgi notu düşer. Seçimi, panelin ölçtüğü maliyetlere bakarak yardımcı model verir: CLAUDE.md, proje ve tool görmeden, en çok kotası kalan hesapta tek seferlik kısa bir çağrı (~1k token). Şefe yalnızca proje kararı gerektiren durumlar yazılır: hiçbir hesapta kota kalmaması, art arda hata, takılma.</p>
          </div>
        </section>
        <section class="section">
          <div class="section-head"><h2>Not düzenleyici</h2><span class="count">grup notlarını aralıklı olarak toparlayan alt model</span></div>
          <div class="card set-card" style="display: grid; gap: 12.5px; grid-template-columns: repeat(auto-fit, minmax(162px, 1fr))">
            <label class="check" style="grid-column: 1 / -1; align-self: flex-start"><input type="checkbox" data-f="cur.enabled" ${cv('enabled') ? 'checked' : ''}>Açık (kapalıyken yalnızca Notlar ekranındaki "Şimdi düzenle" ile çalışır)</label>
            <div class="field"><label for="cur-every">Aralık (saat)</label><input id="cur-every" type="number" min="1" max="168" data-f="cur.everyH" value="${esc(cv('everyH'))}"></div>
            <div class="field"><label for="cur-model">Model</label><select id="cur-model" data-f="cur.model">${['haiku', 'sonnet', 'opus'].map((x) => `<option value="${x}" ${cv('model') === x ? 'selected' : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select></div>
            <div class="field"><label for="cur-level">Derinlik (zamanlı çalışma)</label><select id="cur-level" data-f="cur.level">${CURATOR_LEVELS.map(([k, v]) => `<option value="${k}" ${cv('level') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
            <p class="note" style="grid-column: 1 / -1">Derinlik: <b>düşük</b> yalnızca yeni ve değişen notlara bakar, araştırma yapmaz; <b>orta</b> bunlarla aynı kart ya da konudaki eski notları da ele alır, sonuçlanmış review/düzeltme zincirlerini ana nota "İnceleme geçmişi" olarak katar; <b>yüksek</b> tüm notları kart ve konu gruplarıyla baştan toparlar, geçersiz kalan kural ve kararları işaretler, notlardaki yol ve iddiaları projede doğrular (uzun ve pahalı; elle başlatman önerilir). Her çalıştırma önceki üç çalıştırmanın özetini görür, bilerek ayrı bıraktığı notlara yeniden takılmaz.</p>
            <p class="note" style="grid-column: 1 / -1">İlk düzenlemeyi Notlar ekranındaki "Şimdi düzenle" başlatır; sonra notlar değiştiyse aralık dolunca kendisi çalışır: tekrarları toplar, aynı konudaki notları birleştirir, çelişkiyi önce projede araştırır, çözemezse şefe sorar ve cevaba göre notu netleştirir. Notlara yalnızca panelin tool'larıyla yazar, projede yalnızca okur. Senin yazdığın kısımlara dokunamaz; her değişiklikten önceki sürüm saklanır, birleştirilen not silinmez arşive alınır. Üyelere bildirim gitmez, şefe tek bilgi notu düşer. En çok kotası kalan hesapta çalışır.</p>
          </div>
        </section>
        <section class="section">
          <div class="section-head"><h2>Bağlam pencereleri</h2><span class="count">bağlam yüzdesi bu değerlerle hesaplanır</span></div>
          <div class="card set-card" style="display: grid; gap: 12.5px; grid-template-columns: repeat(auto-fit, minmax(162px, 1fr))">
            ${FAMILIES.map((k) => {
            // Claude Code'un panelin model çağrılarında bildirdiği gerçek pencere; ayardan farklıysa gösterilir.
            const real = (state.measuredWindows || {})[k];
            const cur = Number(m[`cw.${k}`] ?? (m.contextWindows || {})[k]);
            return `<div class="field"><label for="cw-${k}">${k[0].toUpperCase() + k.slice(1)} (token)</label><input id="cw-${k}" type="number" data-f="cw.${k}" value="${esc(m[`cw.${k}`] ?? ((m.contextWindows || {})[k] || ''))}">${real && real !== cur ? `<span class="note warn-note">Claude Code bildirdiği pencere: ${esc(fmtTok(real))}</span>` : ''}</div>`;
          }).join('')}
            <p class="note" style="grid-column: 1 / -1">Model ailesinin gerçek bağlam sınırı farklıysa buradan düzelt. %80'i geçen oturumlarda ⚠ işareti çıkar. Bekçi küçük pencerede eşikleri pencerenin %50 / %75'iyle sınırlar.</p>
          </div>
        </section>`;
  },

  tabTemplates() {
    return `
        <section class="section">
          <div class="section-head"><h2>Şablonlar</h2><span class="count">${(state.templates || []).length}</span></div>
          <div class="card settings-list">
            ${(state.templates || []).length ? state.templates.map((t) => {
            const p = t.scope === 'global' ? null : project(t.scope);
            return `
                <div class="tpl-row" style="padding: 9px 14.5px">
                  <div class="info"><div style="font-weight: 500">${esc(t.name)}</div>
                    <div class="note">${t.scope === 'global' ? 'Tüm projeler' : esc(p ? p.name : 'silinmiş proje')} · ${t.rows.length} oturum</div></div>
                  <button class="btn small ghost" data-act="tpl-del" data-tid="${esc(t.id)}">Sil</button>
                </div>`;
          }).join('') : '<div class="note" style="padding: 12.5px 14.5px">Şablon yok. Kurulum ekranında "Mevcut kurulumu kaydet" ile oluşturulur.</div>'}
          </div>
        </section>`;
  },

  tabSystem() {
    return `
        <section class="section">
          <div class="section-head"><h2>Bu tarayıcı</h2></div>
          <div class="card set-card">
            <label class="check" style="align-self: flex-start"><input type="checkbox" data-act="notify" ${store(NOTIFY_KEY) === '1' ? 'checked' : ''}>Oturum onay bekleyince tarayıcı bildirimi göster</label>
          </div>
        </section>
        <section class="section">
          <div class="section-head"><h2>Güvenlik</h2></div>
          <div class="card set-card">
            <div class="actions" style="align-items: center">
              <div style="flex-grow: 1"><div style="font-weight: 500">Erişim anahtarı</div><div class="note">Panel adresindeki ?t= anahtarı. Sunucu penceresi her açılışta doğru adresi yazar.</div></div>
              <button class="btn" data-act="rotate">Yenile</button>
            </div>
          </div>
        </section>
        <section class="section">
          <div class="section-head"><h2>Sunucu</h2></div>
          <div class="card set-card">
            <label class="check" style="align-self: flex-start"><input type="checkbox" data-act="autostart" ${state.autostart ? 'checked' : ''}>Windows açılışında paneli arka planda başlat</label>
            <p class="note">Arka planda çalışan panelin penceresi olmaz; yanlışlıkla pencere kapatıp oturumları kaybetme riski kalkar. Elle arka planda başlatmak için klasördeki Claude-Panel-Arkaplan.vbs dosyasını çalıştır.</p>
            <div><button class="btn danger" data-act="shutdown">Sunucuyu kapat</button></div>
          </div>
        </section>`;
  },
};
