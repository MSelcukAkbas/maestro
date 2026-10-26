// Claude Panel arayüzü · Çalışma ekranı: terminaller, harita, zaman çizelgesi, mesajlar, pano, notlar.
// web/js/ altındaki dosyalar index.html'deki sırayla yüklenen klasik script'lerdir; üst düzey bildirimler ortak
// global kapsamdadır. Yüklenirken çalışan kod yalnızca kendinden önceki dosyaları kullanabilir.
'use strict';
// ---------- 4 · çalışma ekranı ----------

const CAMPBELL = {
  background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff', selectionBackground: '#3a4152',
  black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
  brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
};

// Terminal menüsü: tek bir öge, sağ tıkla imlecin yanında açılır.
const termMenu = document.createElement('div');
termMenu.className = 'term-menu';
termMenu.setAttribute('role', 'menu');
termMenu.hidden = true;
document.body.appendChild(termMenu);
let termMenuTerm = null;
function closeTermMenu() {
  termMenu.hidden = true;
  termMenuTerm = null;
}
function openTermMenu(term, x, y) {
  termMenuTerm = term;
  termMenu.innerHTML = `
      <button type="button" role="menuitem" data-tm="copy"${term.hasSelection() ? '' : ' disabled'}>Kopyala</button>
      <button type="button" role="menuitem" data-tm="paste">Yapıştır</button>
      <button type="button" role="menuitem" data-tm="all">Tümünü seç</button>`;
  termMenu.hidden = false;
  const r = termMenu.getBoundingClientRect();
  termMenu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  termMenu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
}
termMenu.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tm]');
  const term = termMenuTerm;
  closeTermMenu();
  if (!b || !term) return;
  try {
    if (b.dataset.tm === 'copy') await navigator.clipboard.writeText(term.getSelection());
    else if (b.dataset.tm === 'paste') term.paste(await navigator.clipboard.readText());
    else term.selectAll();
  } catch {
    toast('Pano işlemi yapılamadı', true);
  }
  term.focus();
});
document.addEventListener('mousedown', (e) => {
  if (!termMenu.hidden && !termMenu.contains(e.target)) closeTermMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTermMenu();
});
window.addEventListener('resize', closeTermMenu);

// Sayfa değişince terminaller yok edilmez, kabıyla (holder) birlikte DOM'dan çıkarılıp saklanır; bağlantı açık kalır,
// gruba dönüşte 400 KB'lık geçmişi yeniden indirip ayrıştırmak gerekmez. Uzun süre dönülmezse yok edilir.
const TERM_STASH_MS = 5 * 60 * 1000;
const termStash = new Map();
function stashTerm(sid, obj) {
  if (obj.closed) return obj.dispose();
  obj.holder.remove();
  termStash.set(sid, { obj, timer: setTimeout(() => { termStash.delete(sid); obj.dispose(); }, TERM_STASH_MS) });
}
function takeTerm(sid, body) {
  const kept = termStash.get(sid);
  if (!kept) return null;
  clearTimeout(kept.timer);
  termStash.delete(sid);
  if (kept.obj.closed) { kept.obj.dispose(); return null; }
  body.appendChild(kept.obj.holder);
  requestAnimationFrame(() => { kept.obj.claimSize(); kept.obj.term.refresh(0, kept.obj.term.rows - 1); });
  return kept.obj;
}

function createTerm(sessionId, body) {
  const container = document.createElement('div');
  container.style.cssText = 'width: 100%; height: 100%';
  body.appendChild(container);
  const term = new Terminal({
    fontFamily: "'Cascadia Mono', Consolas, monospace",
    fontSize: 12,
    scrollback: 10000,
    cursorBlink: true,
    theme: CAMPBELL,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&s=${encodeURIComponent(sessionId)}`);
  // ready: bağlantının geçmişi yazıldıktan (ya da bağlantı koptuktan) sonra çözülür; açılış sırası bunu bekler.
  let markReady;
  const obj = { term, ws, closed: false, holder: container, ready: new Promise((r) => { markReady = r; }) };

  // Bu pencerenin istediği boyut; yalnızca bu pencere yazınca (ya da başka sahip yokken) uygulanır.
  const wanted = () => {
    const d = container.offsetParent ? fit.proposeDimensions() : null;
    return d && d.cols > 0 && d.rows > 0 ? { cols: d.cols, rows: d.rows } : {};
  };
  obj.claimSize = () => {
    const w = wanted();
    if (ws.readyState === 1 && w.cols) ws.send(JSON.stringify({ t: 'r', ...w }));
  };
  ws.onopen = () => obj.claimSize();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'o') term.write(m.d, markReady);
    else if (m.t === 's') term.resize(m.cols, m.rows);
    else if (m.t === 'x') {
      obj.closed = true;
      term.write('\r\n\x1b[90m[Oturum kapandı]\x1b[0m\r\n');
    }
  };
  ws.onclose = () => { obj.closed = true; markReady(); };
  term.onData((d) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d, ...wanted() }));
  });
  const ro = new ResizeObserver(() => obj.claimSize());
  ro.observe(container);
  // Sağ tık: tarayıcı menüsü (İncele, tarayıcının yapıştırması) yerine uygulamanın terminal menüsü.
  const onContext = (e) => {
    e.preventDefault();
    openTermMenu(term, e.clientX, e.clientY);
  };
  container.addEventListener('contextmenu', onContext);
  obj.dispose = () => {
    ro.disconnect();
    container.removeEventListener('contextmenu', onContext);
    if (termMenuTerm === term) closeTermMenu();
    try { ws.close(); } catch {}
    term.dispose();
    container.remove();
  };
  return obj;
}

// Harita yardımcıları.
const MAP_WINDOWS = [['15m', '15 dk', 15 * 60000], ['1h', '1 saat', 3600000], ['all', 'Tümü', 0]];
const ROLE_COLORS = {
  sef: '#f0b45a', coder: '#6aa8ff', review: '#b690ff', debug: '#ef6b6b', kalite: '#34d1a0',
  arastirma: '#61d6d6', ops: '#e6894a', avukat: '#e879b5',
  backend: '#4f7cff', frontend: '#2fc6e0', android: '#7fd35b',
  test: '#c9d45a', guvenlik: '#ff8a5c', dokuman: '#9fb3c8',
};
const EXTRA_COLORS = ['#a3e635', '#fbbf24', '#38bdf8', '#f472b6', '#94a3b8'];
// Sekmelerde rolün ikonu (rol rengiyle). Tanımsız roller genel kullanıcı ikonunu alır.
const ROLE_ICON_PATHS = {
  sef: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15 20a5 5 0 0 1 6-4"/>',
  coder: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  review: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  debug: '<rect x="8" y="7" width="8" height="12" rx="4"/><path d="M12 7V4M8 12H4M20 12h-4M8 16l-3 3M16 16l3 3M9 4l2 2M15 4l-2 2"/>',
  kalite: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  arastirma: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  ops: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  avukat: '<path d="M12 4v16M6 20h12M4 8h16M4 8l-2 5a3 3 0 0 0 4 0zM20 8l-2 5a3 3 0 0 0 4 0z"/>',
  backend: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  frontend: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  android: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  test: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>',
  guvenlik: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  dokuman: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>',
};
const ROLE_ICON_DEFAULT = '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>';
function roleIcon(s) {
  const p = ROLE_ICON_PATHS[s && s.roleId] || ROLE_ICON_DEFAULT;
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
function roleColor(s) {
  if (!s) return '#8d95a8';
  if (ROLE_COLORS[s.roleId]) return ROLE_COLORS[s.roleId];
  let h = 0;
  for (const ch of s.roleLabel || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return EXTRA_COLORS[h % EXTRA_COLORS.length];
}
function initials(label) {
  const words = String(label || '?').split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toLocaleUpperCase('tr');
}
// p noktasından q'ya doğru d kadar ilerlemiş nokta (okları düğüm kenarında başlatıp bitirmek için).
function towards(p, q, d) {
  const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1;
  return { x: p.x + (dx / len) * d, y: p.y + (dy / len) * d };
}

const BOARD_COLS = [['todo', 'Yapılacak'], ['doing', 'Yapılıyor'], ['review', 'Review'], ['done', 'Bitti']];

const WorkView = {
  mount({ id, sid }) {
    this.gid = id;
    this.selected = sid || null;
    this.layout = ['grid', 'split'].includes(store(LAYOUT_KEY)) ? store(LAYOUT_KEY) : 'tek';
    this.view = ['map', 'time', 'msgs', 'board', 'notes', 'bekci'].includes(store(VIEW_KEY)) ? store(VIEW_KEY) : 'terms';
    this.noteSel = null;
    this.noteReading = false;
    this.noteQuery = '';
    this.noteTab = store(NOTETAB_KEY) === 'docs' ? 'docs' : 'group';
    this.docs = null;
    this.docText = {};
    this.docSel = null;
    this.docHits = null;
    this.docQuery = '';
    this.docOpen = null;
    this.srcView = false;
    this.noteEd = null;
    this.noteHist = null;
    this.showArchived = false;
    this.curStatus = null;
    this.curAt = 0;
    this.lineSel = null;
    this.notesKey = null;
    this.boardKey = null;
    this.dragCard = null;
    this.msgFilter = 'all';
    this.openMsgs = new Set();
    this.msgBodies = new Map();
    this.allBodies = false;
    this.mapWindow = ['15m', '1h', 'all'].includes(store(MAPWIN_KEY)) ? store(MAPWIN_KEY) : 'all';
    this.mapSel = null;
    this.mapKey = null;
    this.panes = new Map();
    document.body.classList.add('work');
    app.innerHTML = `
        <div class="work-bar">
          <div class="tabs" id="tabs" role="tablist" aria-label="Oturumlar"></div>
          <div class="quota-wrap" id="closed-wrap" hidden>
            <button class="btn small" id="closed-btn" aria-expanded="false" aria-controls="closed-pop" aria-haspopup="true"></button>
            <div class="quota-pop menu-pop closed-pop" id="closed-pop" role="dialog" aria-label="Kapalı üyeler" hidden></div>
          </div>
          <button class="btn small add-member" id="add-member" aria-label="Üye ekle" title="Üye ekle">${ICON_PLUS}</button>
          <div class="seg view-seg" role="group" aria-label="Görünüm" id="view-seg">
            <button data-view="terms" aria-pressed="${this.view === 'terms'}" aria-label="Terminaller" title="Terminaller">${ICON_TERM}</button>
            <button data-view="map" aria-pressed="${this.view === 'map'}" aria-label="Harita" title="Harita">${ICON_MAP}</button>
            <button data-view="time" aria-pressed="${this.view === 'time'}" aria-label="Zaman" title="Zaman">${ICON_TIME}</button>
            <button data-view="msgs" aria-pressed="${this.view === 'msgs'}" aria-label="Mesajlar" title="Mesajlar">${ICON_MSGS}</button>
            <button data-view="board" aria-pressed="${this.view === 'board'}" aria-label="Pano" title="Pano">${ICON_BOARD}</button>
            <button data-view="notes" aria-pressed="${this.view === 'notes'}" aria-label="Notlar" title="Notlar">${ICON_NOTES}</button>
          </div>
        </div>
        <div class="req-bar" id="req-bar" role="region" aria-label="Şefin onay bekleyen istekleri" hidden></div>
        <div class="terms ${this.layout === 'tek' ? '' : this.layout}" id="terms"><div class="splitter" id="splitter" role="separator" aria-orientation="vertical" aria-label="Panel genişliğini ayarla" hidden></div></div>
        <div class="activity" id="activity" hidden></div>
        <dialog class="dlg" id="add-dlg" aria-labelledby="add-title"></dialog>
        <dialog class="dlg" id="card-dlg" aria-labelledby="card-title"></dialog>
        <dialog class="dlg" id="remind-dlg" aria-labelledby="remind-title"></dialog>
        <dialog class="dlg" id="refs-dlg" aria-labelledby="refs-title"></dialog>
        <div class="sess-menu" id="sess-menu" role="dialog" aria-label="Oturum ayrıntıları ve işlemleri" hidden></div>`;
    $('#view-seg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (!b) return;
      this.view = b.dataset.view;
      store(VIEW_KEY, this.view);
      this.applyView();
      this.poll();
    });
    $('#bekci-btn').hidden = false;
    this.onBekciBtn = () => {
      this.view = 'bekci';
      store(VIEW_KEY, this.view);
      this.applyView();
      this.poll();
    };
    $('#bekci-btn').addEventListener('click', this.onBekciBtn);
    const act$ = $('#activity');
    // Harita: zaman aralığı, düğüm seçimi, üzerine gelince ilgili okları vurgulama.
    const redrawMap = () => {
      this.mapKey = null;
      const g = this.group();
      if (g && this.lastActivity) this.renderMap(g, this.lastActivity);
    };
    act$.addEventListener('click', (e) => {
      const w = e.target.closest('[data-mw]');
      if (w) {
        this.mapWindow = w.dataset.mw;
        store(MAPWIN_KEY, this.mapWindow);
        return redrawMap();
      }
      const sn = e.target.closest('[data-sel]');
      if (sn) {
        this.mapSel = sn.dataset.sel && sn.dataset.sel !== this.mapSel ? sn.dataset.sel : null;
        return redrawMap();
      }
    });
    act$.addEventListener('keydown', (e) => {
      const sn = e.target.closest('.node[data-sel]');
      if (sn && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.mapSel = sn.dataset.sel;
        redrawMap();
      }
    });
    act$.addEventListener('mouseover', (e) => {
      const n = e.target.closest('.node[data-sel]');
      const svg = $('#map-svg');
      if (!svg) return;
      svg.querySelectorAll('.lit').forEach((x) => x.classList.remove('lit'));
      svg.classList.toggle('focus', !!n);
      if (!n) return;
      const sid = n.dataset.sel;
      n.classList.add('lit');
      svg.querySelectorAll('.edge').forEach((ed) => {
        if (ed.dataset.from === sid || ed.dataset.to === sid) {
          ed.classList.add('lit');
          const other = ed.dataset.from === sid ? ed.dataset.to : ed.dataset.from;
          const on = svg.querySelector(`.node[data-sel="${CSS.escape(other)}"]`);
          if (on) on.classList.add('lit');
        }
      });
    });
    act$.addEventListener('click', (e) => {
      const n = e.target.closest('[data-goto]');
      if (!n) return;
      this.view = 'terms';
      store(VIEW_KEY, this.view);
      this.applyView();
      this.select(n.dataset.goto);
    });
    this.initBoard();
    this.initNotes();
    Bekci.bind(act$, () => this.group());
    $('#req-bar').addEventListener('click', (e) => this.onRequest(e));
    this.applyView();
    $('#add-member').addEventListener('click', () => this.openAdd());
    const dlg = $('#add-dlg');
    dlg.addEventListener('input', (e) => this.onAddInput(e));
    dlg.addEventListener('change', (e) => this.onAddInput(e, true));
    dlg.addEventListener('click', (e) => this.onAddClick(e));
    $('#tabs').addEventListener('click', (e) => {
      const m = e.target.closest('[data-menu]');
      if (m) return this.toggleMenu(m.dataset.menu, m);
      const t = e.target.closest('[data-sid]');
      if (t) this.select(t.dataset.sid);
    });
    // Üye sekmeleri basılı tutup sürüklenerek sıralanır; şef her zaman en solda kalır.
    const tabsEl = $('#tabs');
    let dragSid = null;
    const clearDrop = () => tabsEl.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after'));
    tabsEl.addEventListener('dragstart', (e) => {
      const tab = e.target.closest('.tab[data-tid]');
      if (!tab) return;
      dragSid = tab.dataset.tid;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragSid);
      tab.classList.add('dragging');
    });
    tabsEl.addEventListener('dragover', (e) => {
      const tab = e.target.closest('.tab[data-tid]');
      if (!dragSid || !tab || tab.dataset.tid === dragSid || tab.dataset.lead === 'true') return;
      e.preventDefault();
      const r = tab.getBoundingClientRect();
      tabsEl.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      tab.classList.add(e.clientX > r.left + r.width / 2 ? 'drop-after' : 'drop-before');
    });
    tabsEl.addEventListener('drop', async (e) => {
      const tab = e.target.closest('.tab[data-tid]');
      if (!dragSid || !tab || tab.dataset.tid === dragSid || tab.dataset.lead === 'true') return;
      e.preventDefault();
      const after = tab.classList.contains('drop-after');
      const sid = dragSid;
      dragSid = null;
      clearDrop();
      const ids = [...tabsEl.querySelectorAll('.tab[data-tid]')].map((x) => x.dataset.tid).filter((id) => id !== sid);
      ids.splice(ids.indexOf(tab.dataset.tid) + (after ? 1 : 0), 0, sid);
      try {
        await api('PUT', `/api/groups/${encodeURIComponent(this.gid)}/order`, { ids });
      } catch (err) {
        toast(err.message, true);
      }
      this.poll();
    });
    tabsEl.addEventListener('dragend', () => {
      dragSid = null;
      clearDrop();
    });
    $('#closed-btn').addEventListener('click', () => ($('#closed-pop').hidden ? this.openClosed() : this.closeClosed()));
    $('#closed-pop').addEventListener('click', (e) => this.onClosedAction(e));
    this.initLayoutMenu();
    this.initSplitter();
    const menu = $('#sess-menu');
    menu.addEventListener('click', (e) => this.onAction(e));
    menu.addEventListener('change', (e) => this.onAccountChange(e));
    // Menü dışına tıklayınca ya da Esc ile kapanır.
    this.onDocClick = (e) => {
      if (!menu.hidden && !e.target.closest('#sess-menu') && !e.target.closest('[data-menu]')) this.closeMenu();
      if (!$('#layout-pop').hidden && !e.target.closest('#layout-wrap')) this.closeLayoutMenu();
      if (!$('#closed-pop').hidden && !e.target.closest('#closed-wrap')) this.closeClosed();
    };
    this.onDocKey = (e) => {
      if (e.key !== 'Escape') return;
      if (!menu.hidden) this.closeMenu(true);
      if (!$('#closed-pop').hidden) this.closeClosed(true);
      if (!$('#layout-pop').hidden) this.closeLayoutMenu(true);
    };
    document.addEventListener('click', this.onDocClick);
    document.addEventListener('keydown', this.onDocKey);
    window.addEventListener('resize', this.onResize = () => this.closeMenu());
    $('#terms').addEventListener('click', (e) => {
      const m = e.target.closest('[data-menu]');
      if (m) return this.toggleMenu(m.dataset.menu, m);
      const off = e.target.closest('[data-start]');
      if (off) {
        act(() => api('POST', `/api/sessions/${off.dataset.start}/start`), 'Oturum açılıyor…');
        return;
      }
      const pane = e.target.closest('.pane');
      // Bölünmüş düzende küçük panele tıklamak onu büyütmez; büyük panel sekmeden seçilir.
      if (pane && pane.dataset.sid !== this.selected && this.layout !== 'split') this.select(pane.dataset.sid, true);
    });
    this.poll();
  },

  group() {
    return state.groups.find((g) => g.id === this.gid);
  },

  select(sid, keepFocus) {
    this.selected = sid;
    history.replaceState(null, '', `#/g/${this.gid}/${sid}`);
    this.poll();
    const p = this.panes.get(sid);
    if (p && p.term && !keepFocus) p.term.term.focus();
  },

  // ----- şefin ekip istekleri (yeni üye, kapatma, hesap değişikliği): kullanıcı onayı -----

  renderRequests(g) {
    const bar = $('#req-bar');
    const list = g.requests || [];
    bar.hidden = !list.length;
    if (!list.length) { this.reqKey = null; bar.innerHTML = ''; return; }
    // Ret notu yazılırken yenileme kutuyu silmesin.
    if (bar.contains(document.activeElement) && document.activeElement.matches('input')) return;
    const nameOf = (sid) => g.sessions.find((s) => s.id === sid);
    const key = JSON.stringify([list.map((r) => r.id), list.map((r) => { const t = r.args && nameOf(r.args.target); return t ? [statusKey(t), t.activity] : null; })]);
    if (key === this.reqKey) return;
    this.reqKey = key;
    bar.innerHTML = list.map((r) => {
      const by = nameOf(r.by);
      const t = r.args && r.args.target ? nameOf(r.args.target) : null;
      const busy = t && t.running && (t.status === 'busy' || t.status === 'waiting');
      const warn = t && r.kind !== 'add' && t.running
        ? `<div class="rq-warn ${busy ? 'hot' : ''}">${esc(t.roleLabel)} şu an <b>${esc(statusLabel(t))}</b>${t.activity ? ` · ${esc(t.activity)}` : ''}${busy ? ' — onaylarsan yaptığı iş yarıda kalır.' : ''}</div>` : '';
      return `
          <div class="rq">
            <div class="rq-main">
              <div class="rq-top"><span class="rq-tag">Şef isteği #${r.id}</span><b>${esc(r.kindText)}</b><span class="note">${esc(by ? by.roleLabel : '?')} · ${esc(timeAgo(r.createdAt))}</span></div>
              <div class="rq-what">${esc(r.text)}</div>
              ${r.reason ? `<div class="rq-why"><span class="note">Gerekçe:</span> ${esc(r.reason)}</div>` : ''}
              ${r.kind === 'add' && r.args.task ? `<details class="rq-task"><summary>İlk görev</summary><div>${esc(r.args.task)}</div></details>` : ''}
              ${warn}
            </div>
            <div class="rq-act">
              <input type="text" data-reqnote="${r.id}" placeholder="Ret notu (isteğe bağlı)" aria-label="İstek #${r.id} için ret notu" maxlength="500">
              <button class="btn small ghost" data-reqact="reject" data-rid="${r.id}">Reddet</button>
              <button class="btn small primary" data-reqact="approve" data-rid="${r.id}">Onayla</button>
            </div>
          </div>`;
    }).join('');
  },

  async onRequest(e) {
    const b = e.target.closest('[data-reqact]');
    if (!b) return;
    const id = b.dataset.rid;
    const approve = b.dataset.reqact === 'approve';
    const noteEl = $(`#req-bar [data-reqnote="${id}"]`);
    b.disabled = true;
    const r = await act(() => api('POST', `/api/requests/${id}/${approve ? 'approve' : 'reject'}`, { note: noteEl ? noteEl.value : '' }));
    b.disabled = false;
    if (!r) return;
    toast(approve ? `Onaylandı: ${r.result}` : 'Reddedildi; şefe bildirilecek.');
    this.reqKey = null;
    await refresh().catch(() => {});
    this.poll();
  },

  // ----- oturum menüsü (⋯): ayrıntılar ve işlemler -----

  toggleMenu(sid, anchor) {
    if (!$('#sess-menu').hidden && this.menuSid === sid) return this.closeMenu();
    this.menuSid = sid;
    this.menuAnchor = anchor;
    this.renderMenu();
    const menu = $('#sess-menu');
    menu.hidden = false;
    this.placeMenu();
    anchor.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('button, select');
    if (first) first.focus();
  },

  closeMenu(refocus) {
    const menu = $('#sess-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    const sid = this.menuSid;
    this.menuSid = null;
    if (refocus) {
      const a = app.querySelector(`[data-menu="${CSS.escape(sid)}"]`);
      if (a) a.focus();
    }
  },

  // Düğmenin altına, ekrana sığacak şekilde; sığmazsa üstüne.
  placeMenu() {
    const menu = $('#sess-menu');
    const sid = this.menuSid;
    const a = (this.menuAnchor && this.menuAnchor.isConnected && this.menuAnchor)
      || app.querySelector(`[data-menu="${CSS.escape(sid)}"]`);
    if (!a) return this.closeMenu();
    this.menuAnchor = a;
    const r = a.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  },

  renderMenu() {
    const menu = $('#sess-menu');
    const g = this.group();
    const s = g && g.sessions.find((x) => x.id === this.menuSid);
    if (!s) return this.closeMenu();
    // Hesap menüsü açıkken iki saniyelik yenileme menüyü kapatmasın.
    if (menu.contains(document.activeElement) && document.activeElement.matches('select')) return;
    const st = s.stats;
    const modelLabel = (m) => (MODELS.find(([v]) => v === m) || [m, m])[1];
    const modelText = st && st.model ? st.model : s.model ? modelLabel(s.model) : 'hesap varsayılanı';
    const names = (ids) => (ids || []).map((id) => (g.sessions.find((x) => x.id === id) || {}).roleLabel).filter(Boolean).join(', ');
    const members = g.sessions.filter((x) => !x.removed);
    const row = (k, v) => (v ? `<div class="sm-k">${k}</div><div class="sm-v">${v}</div>` : '');
    menu.innerHTML = `
        <div class="sm-head">
          <span class="dot ${statusKey(s)}"></span>
          <div class="sm-title"><div class="sm-name">${esc(s.roleLabel)} · ${esc(s.accountId)}</div><div class="mono note" title="${esc(s.name)}">${esc(s.name)}</div></div>
          <button class="btn icon small" data-act="close-menu" aria-label="Kapat">✕</button>
        </div>
        <div class="sm-grid">
          ${row('Durum', `${statusBadge(s)} ${activityLine(s)}`)}
          <div class="sm-k">Hesap</div><div class="sm-v">
            <select class="small-select" data-acc aria-label="Oturumun hesabı">
              ${state.settings.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === s.accountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
            </select></div>
          ${row('Model', esc(modelText))}
          <div class="sm-k">Ayar</div><div class="sm-v">
            <select class="small-select" data-set="model" aria-label="Oturumun modeli">${MODELS.map(([v, l]) => `<option value="${esc(v)}" ${v === (s.model || '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
            <select class="small-select" data-set="effort" aria-label="Oturumun effort ayarı">${EFFORTS.map(([v, l]) => `<option value="${esc(v)}" ${v === (s.effort || '') ? 'selected' : ''}>${esc(v ? `effort: ${l}` : 'effort: model varsayılanı')}</option>`).join('')}</select>
            ${s.pending ? `<div class="note warn-note">Değişiklik bekliyor (${esc(pendingText(s.pending))}): ${s.pending.now ? 'hemen uygulanıyor' : s.pending.model ? 'üye boşta ve önbellek soğuyunca' : 'üye boşta kalınca'} kaldığı yerden yeniden açılacak.
              <button class="btn small" data-act="apply-now">Şimdi uygula</button> <button class="btn small ghost" data-act="cancel-pending">İptal</button></div>` : ''}
          </div>
          ${row('İzin modu', esc(permLabel(s.permissionMode || g.permissionMode || 'manual')))}
          ${st ? row('Bağlam', esc(statsLine(st))) : ''}
          ${st && st.prompts ? row('Kullanım', esc(`${st.prompts} istem · ${fmtTok(st.tokens && st.tokens.output)} çıktı token`)) : ''}
          ${st && st.firstAt ? row('Zaman', esc(`${fmtDate(st.firstAt)} → ${fmtDate(st.lastAt)}`)) : ''}
          ${row('Rapor verir', esc(names(s.reportsTo)))}
          ${s.talkAll ? row('Konuşma', 'herkesle konuşur') : ''}
          ${row('Kimlik', `<span class="mono">${esc(s.id)}</span>`)}
        </div>
        <div class="sm-actions">
          ${s.running
          ? `<button class="btn small" data-act="pc">PC'de aç</button>
               <button class="btn small" data-act="restart">Yeniden başlat</button>
               <button class="btn small danger" data-act="stop">Sonlandır</button>`
          : '<button class="btn small primary" data-act="start">Başlat</button>'}
          ${s.roleId === 'sef' && members.some((x) => x.running) ? '<button class="btn small" data-act="summary" title="Şefin terminaline kapanış özeti isteği gönderir">Şeften özet iste</button>' : ''}
          <button class="btn small" data-act="renew" title="Devir notu yazdırıp aynı ad ve rolle sıfır context ile yeniden açar; pano ve notlar kalır">Sıfır context ile yenile</button>
          <button class="btn small ghost danger-text" data-act="remove">Gruptan çıkar</button>
        </div>`;
  },

  // Kapatılan üyeler sekmelerden düşer, sondaki "Kapalı (N)" düğmesinde toplanır; oradan açılır ya da gruptan çıkarılır.
  renderClosed(closed) {
    const pop = $('#closed-pop');
    $('#closed-wrap').hidden = !closed.length;
    $('#closed-btn').textContent = `Kapalı (${closed.length})`;
    if (!closed.length) return this.closeClosed();
    // Yalnızca liste değişince yeniden çizilir; yoksa iki saniyelik yenileme odaktaki düğmeyi düşürür.
    const key = JSON.stringify(closed.map((s) => [s.id, s.roleLabel, s.accountId]));
    if (pop.hidden || key === this.closedKey) return;
    this.closedKey = key;
    pop.innerHTML = `<div class="note">Kapalı üyeler · kaldığı yerden açılır</div>${closed.map((s) => `
        <div class="closed-row">
          <span class="dot off"></span>
          <span class="cr-name" title="${esc(s.name)}">${esc(s.roleLabel)} · ${esc(s.accountId)}</span>
          <button class="btn small primary" data-copen="${esc(s.id)}">Aç</button>
          <button class="btn small ghost danger-text" data-cremove="${esc(s.id)}">Çıkar</button>
        </div>`).join('')}`;
  },

  openClosed() {
    const g = this.group();
    if (!g) return;
    $('#closed-pop').hidden = false;
    $('#closed-btn').setAttribute('aria-expanded', 'true');
    this.renderClosed(this.closedOf(g));
    const first = $('#closed-pop').querySelector('button');
    if (first) first.focus();
  },

  closeClosed(focus) {
    $('#closed-pop').hidden = true;
    this.closedKey = null;
    $('#closed-btn').setAttribute('aria-expanded', 'false');
    if (focus) $('#closed-btn').focus();
  },

  // Çalışan üye varken kapalı olanlar gizlenir; hiçbiri çalışmıyorsa (grup durmuş) hepsi sekmede kalır.
  closedOf(g) {
    const members = g.sessions.filter((s) => !s.removed);
    return members.some((s) => s.running) ? members.filter((s) => !s.running) : [];
  },

  async onClosedAction(e) {
    const b = e.target.closest('[data-copen], [data-cremove]');
    if (!b) return;
    if (b.dataset.copen) {
      const sid = b.dataset.copen;
      b.disabled = true;
      const r = await act(() => api('POST', `/api/sessions/${sid}/start`), 'Oturum açılıyor…');
      b.disabled = false;
      if (!r) return;
      this.selected = sid;
      this.closeClosed();
      await refresh();
      return;
    }
    if (!confirm('Oturum gruptan çıkarılsın mı? Konuşması silinmez; proje sayfasından gruba geri eklenebilir.\n\nPanel, ekibi yöneten üyeye (şef) bu üyenin ayrıldığını bildirecek.')) return;
    b.disabled = true;
    const r = await act(() => api('POST', `/api/sessions/${b.dataset.cremove}/remove`, { notify: true }));
    b.disabled = false;
    if (r) toast(r.notified ? `Gruptan çıkarıldı; ${r.notified} oturumuna bildirildi.` : 'Gruptan çıkarıldı. Bildirilecek çalışan üye yoktu.');
  },

  // Görünüm (düzen) menüsü üst çubukta, Kota'nın yanında; yalnızca terminaller görünümünde.
  initLayoutMenu() {
    const btn = $('#layout-btn');
    const pop = $('#layout-pop');
    const LAYOUTS = [
      ['tek', 'Tek', 'Yalnızca seçili oturum'],
      ['split', 'Bölünmüş', 'Seçili oturum solda büyük, diğerleri sağda; ayırıcı sürüklenir'],
      ['grid', 'Izgara', 'Tüm oturumlar yan yana'],
    ];
    const render = () => {
      $('#layout-cur').textContent = `Görünüm: ${LAYOUTS.find((l) => l[0] === this.layout)[1]}`;
      pop.innerHTML = `<div class="note">Terminal düzeni</div>${LAYOUTS.map(([k, l, d]) => `
          <button class="menu-item" role="menuitemradio" aria-checked="${k === this.layout}" data-layout="${k}">
            <span class="mi-check" aria-hidden="true">${k === this.layout ? '✓' : ''}</span>
            <span><span class="mi-label">${l}</span><span class="note">${d}</span></span>
          </button>`).join('')}`;
    };
    this.renderLayoutMenu = render;
    this.onLayoutBtn = () => {
      if (pop.hidden) {
        render();
        pop.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        const cur = pop.querySelector('[aria-checked="true"]');
        if (cur) cur.focus();
      } else this.closeLayoutMenu();
    };
    this.onLayoutPick = (e) => {
      const b = e.target.closest('[data-layout]');
      if (!b) return;
      this.layout = b.dataset.layout;
      store(LAYOUT_KEY, this.layout);
      $('#terms').classList.toggle('grid', this.layout === 'grid');
      $('#terms').classList.toggle('split', this.layout === 'split');
      render();
      this.closeLayoutMenu(true);
      this.poll();
    };
    btn.addEventListener('click', this.onLayoutBtn);
    pop.addEventListener('click', this.onLayoutPick);
    render();
  },

  closeLayoutMenu(refocus) {
    const pop = $('#layout-pop');
    if (pop.hidden) return;
    pop.hidden = true;
    $('#layout-btn').setAttribute('aria-expanded', 'false');
    if (refocus) $('#layout-btn').focus();
  },

  // Model / effort değişikliği: kayıt hemen değişir; çalışan üye uygun anda kaldığı yerden yeniden açılır.
  async onSettingChange(sel) {
    const g = this.group();
    const s = g && g.sessions.find((x) => x.id === this.menuSid);
    if (!s) return;
    sel.blur();
    const r = await act(() => api('POST', `/api/sessions/${s.id}/settings`, { [sel.dataset.set]: sel.value }));
    if (!r) return;
    await refresh();
    this.renderMenu();
    if (!r.running) toast('Ayar kaydedildi; üye bir sonraki açılışta bu ayarla başlar.');
    else if (r.pending) toast(r.pending.model
      ? 'Model değişikliği sıraya alındı: üye boşta ve önbelleği soğuyunca kaldığı yerden yeniden açılacak (model değişimi önbelleği zaten sıfırlar). Beklemek istemezsen "Şimdi uygula".'
      : 'Effort değişikliği sıraya alındı: üye boşta kalınca kaldığı yerden yeniden açılacak.');
  },

  async onAccountChange(e) {
    const set = e.target.closest('[data-set]');
    if (set && this.menuSid) return this.onSettingChange(set);
    const sel = e.target.closest('[data-acc]');
    if (!sel || !this.menuSid) return;
    const g = this.group();
    const s = g && g.sessions.find((x) => x.id === this.menuSid);
    const a = account(sel.value);
    if (!s || !a) return;
    const msg = s.running
      ? `"${s.name}" kapatılıp ${a.name} hesabıyla kaldığı yerden açılacak. Oturum adı aynı kalır. Devam edilsin mi?`
      : `"${s.name}" bundan sonra ${a.name} hesabıyla açılacak. Devam edilsin mi?`;
    if (!confirm(msg)) {
      sel.value = s.accountId;
      sel.blur();
      return;
    }
    sel.blur();
    const r = await act(() => api('POST', `/api/sessions/${s.id}/account`, { accountId: a.id }));
    if (r) toast(r.restarted ? `${a.name} hesabıyla yeniden açılıyor…` : `Hesap ${a.name} olarak değişti.`);
  },

  async onAction(e) {
    const b = e.target.closest('[data-act]');
    if (!b || !this.menuSid) return;
    const sid = this.menuSid;
    const a = b.dataset.act;
    if (a === 'close-menu') return this.closeMenu(true);
    if (a === 'apply-now' || a === 'cancel-pending') {
      if (a === 'apply-now' && !confirm('Üye şimdi kaldığı yerden yeniden açılsın mı? Çalışıyorsa işi yarıda kalır; model değişiyorsa bağlam önbelleğe baştan yazılır.')) return;
      const r = await act(() => (a === 'apply-now' ? api('POST', `/api/sessions/${sid}/settings`, { now: true }) : api('DELETE', `/api/sessions/${sid}/settings`)));
      if (r) { await refresh(); this.renderMenu(); }
      return;
    }
    if (a === 'stop' && !confirm('Oturum sonlandırılsın mı?')) return;
    if (a === 'restart' && !confirm('Oturum kapatılıp kaldığı yerden yeniden açılsın mı?')) return;
    if (a === 'remove' && !confirm('Oturum kapatılıp gruptan çıkarılsın mı? Konuşması silinmez; proje sayfasından gruba geri eklenebilir.\n\nPanel, ekibi yöneten üyeye (şef) bu üyenin ayrıldığını bildirecek.')) return;
    if (a === 'summary' && !confirm('Şeften kapanış özeti istensin mi? Panel, şefin terminaline özet isteğini yazıp gönderecek.')) return;
    if (a === 'renew') {
      const s = (this.group() || { sessions: [] }).sessions.find((x) => x.id === sid);
      if (!confirm(s && s.running
        ? 'Üye sıfır context ile yenilensin mi?\n\nPanel üyeye devir notu yazdırır (elindeki iş, yapılanlar, kalan adımlar); ardından eski oturumu kapatıp aynı ad, rol ve hesapla yeni oturum açar ve notu ona verir. Pano kartları, grup notları ve bekleyen bildirimler yeni oturuma geçer; diğer üyeler ona aynı adla yazmaya devam eder.'
        : 'Üye kapalı olduğu için devir notu yazamaz. Aynı ad, rol ve hesapla sıfır context ile açılsın mı?\n\nPano kartları ve grup notları kalır; yeni oturum işe panoya ve notlara bakarak başlar.')) return;
      b.disabled = true;
      const r = await act(() => api('POST', `/api/sessions/${sid}/renew`));
      b.disabled = false;
      if (!r) return;
      this.closeMenu();
      toast(r.handoff ? 'Devir notu istendi; not gelince yeni oturum açılacak. İlerlemeyi Bekçi ekranından izleyebilirsin.' : 'Sıfır context ile açılıyor.');
      return;
    }
    if (a === 'summary') {
      b.disabled = true;
      const r = await act(() => api('POST', `/api/groups/${this.gid}/ask-summary`));
      b.disabled = false;
      if (r) toast(`Kapanış özeti ${r.to} oturumundan istendi. Özet yazılınca "Tümünü sonlandır" ile kapatabilirsin.`);
      return;
    }
    const path = { pc: 'open-pc', restart: 'restart', stop: 'stop', start: 'start', remove: 'remove' }[a];
    b.disabled = true;
    const r = await act(() => api('POST', `/api/sessions/${sid}/${path}`, a === 'remove' ? { notify: true } : undefined));
    b.disabled = false;
    if (r && a !== 'pc') this.closeMenu();
    if (r && a === 'remove') toast(r.notified ? `Gruptan çıkarıldı; ${r.notified} oturumuna bildirildi.` : 'Gruptan çıkarıldı. Bildirilecek çalışan üye yoktu.');
  },

  // Bölünmüş düzende ayırıcı sürüklenerek sol panelin genişliği ayarlanır; oran bu tarayıcıda saklanır.
  initSplitter() {
    const terms = $('#terms');
    const sp = $('#splitter');
    const saved = Number(store(SPLIT_KEY));
    if (saved >= 20 && saved <= 85) terms.style.setProperty('--split', `${saved}%`);
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('drag');
      const move = (ev) => {
        const r = terms.getBoundingClientRect();
        const pct = Math.max(20, Math.min(85, ((ev.clientX - r.left) / r.width) * 100));
        terms.style.setProperty('--split', `${pct.toFixed(1)}%`);
      };
      const up = () => {
        sp.classList.remove('drag');
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        store(SPLIT_KEY, parseFloat(terms.style.getPropertyValue('--split')) || 62);
        for (const pane of this.panes.values()) if (pane.term) pane.term.claimSize();
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
  },

  // Bölünmüş düzende seçili oturum solda tüm satırları kaplar, diğerleri sağda alt alta dizilir.
  placePanes(members) {
    const terms = $('#terms');
    const sp = $('#splitter');
    const split = this.layout === 'split' && members.length > 1;
    sp.hidden = !split;
    terms.style.gridTemplateRows = split ? `repeat(${members.length - 1}, minmax(0, 1fr))` : '';
    if (split) {
      sp.style.gridColumn = '2';
      sp.style.gridRow = '1 / -1';
    }
    for (const s of members) {
      const pane = this.panes.get(s.id);
      if (!pane) continue;
      const main = s.id === this.selected;
      pane.el.style.gridColumn = split ? (main ? '1' : '3') : (this.layout === 'split' ? '1 / -1' : '');
      pane.el.style.gridRow = split && main ? '1 / -1' : '';
      if (split) pane.el.style.order = main ? '-1' : '';
    }
  },

  // ----- harita ve zaman çizelgesi -----

  // Terminaller aynı anda değil sırayla açılır: önce şef, sonra seçili üye, sonra diğerleri sekme sırasıyla.
  // Her biri geçmişini yazıp bitirince (ya da 2 sn dolunca) sıradaki açılır.
  pumpTerms() {
    if (this.pumping) return;
    const gen = this.pumpGen = (this.pumpGen || 0) + 1;
    const pick = () => {
      const rank = (sid) => {
        const s = this.group() && this.group().sessions.find((x) => x.id === sid);
        return s && s.roleId === 'sef' ? 0 : sid === this.selected ? 1 : 2 + (this.openOrder || []).indexOf(sid);
      };
      const ids = [...this.panes].filter(([, p]) => p.want && !p.term && p.visible).map(([sid]) => sid);
      return ids.sort((x, y) => rank(x) - rank(y))[0] || null;
    };
    const step = async () => {
      const sid = pick();
      const pane = sid && this.panes.get(sid);
      if (!pane) { this.pumping = false; return; }
      pane.want = false;
      const body = pane.el.querySelector('.pane-body');
      body.innerHTML = '';
      pane.term = createTerm(sid, body);
      await Promise.race([pane.term.ready, new Promise((r) => setTimeout(r, 2000))]);
      if (gen !== this.pumpGen) return;
      setTimeout(step, 80);
    };
    this.pumping = true;
    step();
  },

  applyView() {
    $('#terms').hidden = this.view !== 'terms';
    $('#layout-wrap').hidden = this.view !== 'terms';
    if (this.view !== 'terms') this.closeLayoutMenu();
    $('#activity').hidden = this.view === 'terms';
    app.querySelectorAll('#view-seg button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.view === this.view)));
    $('#bekci-btn').setAttribute('aria-pressed', String(this.view === 'bekci'));
  },

  async refreshActivity(g) {
    if (this.loadingActivity) return;
    this.loadingActivity = true;
    try {
      const a = await api('GET', `/api/groups/${g.id}/activity`);
      this.lastActivity = a;
      if (this.view === 'map') this.renderMap(g, a);
      else if (this.view === 'time') this.renderTimeline(g, a);
      else if (this.view === 'msgs') this.renderMsgs(g, a);
    } catch (err) {
      $('#activity').innerHTML = `<div class="empty">Etkinlik alınamadı: ${esc(err.message)}</div>`;
    } finally {
      this.loadingActivity = false;
    }
  },

  // İletişim haritası. Şef ortada, diğer üyeler çevresinde; oklar mesaj yönünü, kalınlık mesaj sayısını,
  // akan noktalar son bir dakikadaki mesajları gösterir. Düğümün dış halkası bağlamın doluluğudur.
  // Veri değişmedikçe yeniden çizilmez (animasyon ve üzerine gelme durumu bozulmasın diye).
  renderMap(g, a) {
    const members = g.sessions.filter((s) => !s.removed);
    const win = MAP_WINDOWS.find((w) => w[0] === this.mapWindow) || MAP_WINDOWS[0];
    const since = win[2] ? a.now - win[2] : 0;
    const msgs = a.messages.filter((m) => m.ts >= since);
    const key = JSON.stringify([
      members.map((s) => [s.id, statusKey(s), s.accountId, s.stats && s.stats.context, s.stats && Math.round(s.stats.costUSD * 100)]),
      msgs.length, msgs.length ? msgs[msgs.length - 1].ts : 0, this.mapWindow, this.mapSel, Math.floor(a.now / 15000),
    ]);
    if (key === this.mapKey && $('#map-svg')) return;
    this.mapKey = key;

    const W = 1000, H = 660, cx = W / 2, cy = H / 2 - 34, NR = 44;
    const lead = members.length > 2 ? members.find((s) => s.roleId === 'sef') : null;
    const ring = members.filter((s) => s !== lead);
    const R = ring.length > 1 ? Math.min(330, 230 + ring.length * 14) : 0;
    const pos = new Map();
    if (lead) pos.set(lead.id, { x: cx, y: cy });
    ring.forEach((s, i) => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / ring.length + (lead ? Math.PI / ring.length : 0);
      pos.set(s.id, { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) * 0.72 });
    });

    const HOT_MS = 60000;
    const edges = new Map();
    const sent = new Map(), recv = new Map();
    let outside = 0;
    for (const m of msgs) {
      sent.set(m.from, (sent.get(m.from) || 0) + 1);
      if (m.to) recv.set(m.to, (recv.get(m.to) || 0) + 1);
      if (!m.to || !pos.has(m.from) || !pos.has(m.to)) { outside++; continue; }
      const k = `${m.from}>${m.to}`;
      const e = edges.get(k) || { from: m.from, to: m.to, n: 0, last: 0, text: '', hot: 0 };
      e.n++;
      if (m.ts >= e.last) { e.last = m.ts; e.text = m.text; }
      if (a.now - m.ts < HOT_MS) e.hot++;
      edges.set(k, e);
    }
    const maxN = Math.max(1, ...[...edges.values()].map((e) => e.n));

    const edgeSvg = [...edges.values()].map((e) => {
      const p = pos.get(e.from), q = pos.get(e.to);
      const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
      // Her yön kendi tarafına bükülür; karşılıklı konuşmada iki eğri ayrışır.
      const bend = Math.min(70, len * 0.18);
      const c = { x: (p.x + q.x) / 2 + nx * bend, y: (p.y + q.y) / 2 + ny * bend };
      const start = towards(p, c, NR + 8), end = towards(q, c, NR + 14);
      const d = `M${start.x.toFixed(1)},${start.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`;
      const mid = { x: 0.25 * start.x + 0.5 * c.x + 0.25 * end.x, y: 0.25 * start.y + 0.5 * c.y + 0.25 * end.y };
      const w = 1.6 + (e.n / maxN) * 5;
      const color = roleColor(members.find((s) => s.id === e.from));
      const from = members.find((s) => s.id === e.from), to = members.find((s) => s.id === e.to);
      const dots = e.hot ? Array.from({ length: Math.min(3, e.hot) }, (_, i) => `
          <circle r="4.5" class="particle" fill="${color}"><animateMotion dur="1.8s" begin="${(i * 0.6).toFixed(1)}s" repeatCount="indefinite" path="${d}"></animateMotion></circle>`).join('') : '';
      return `
          <g class="edge ${e.hot ? 'hot' : ''}" data-from="${esc(e.from)}" data-to="${esc(e.to)}">
            <title>${esc(from.roleLabel)} → ${esc(to.roleLabel)}: ${e.n} mesaj. Son: ${esc(e.text)}</title>
            <path d="${d}" stroke="${color}" stroke-width="${w.toFixed(1)}" marker-end="url(#mk-${esc(e.from)})"></path>
            ${dots}
            <g class="pill" transform="translate(${mid.x.toFixed(1)},${mid.y.toFixed(1)})">
              <rect x="-14" y="-11" width="28" height="22" rx="11"></rect>
              <text>${e.n}</text>
            </g>
          </g>`;
    }).join('');

    const markers = members.map((s) => `
        <marker id="mk-${esc(s.id)}" viewBox="0 0 10 10" refX="7" refY="5" markerUnits="userSpaceOnUse" markerWidth="13" markerHeight="13" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="${roleColor(s)}"></path>
        </marker>`).join('');

    const CIRC = 2 * Math.PI * (NR + 7);
    const nodeSvg = members.map((s) => {
      const p = pos.get(s.id);
      const k = statusKey(s);
      const color = roleColor(s);
      const pct = ctxPct(s.stats);
      const arc = pct == null ? 0 : Math.min(1, pct / 100);
      const last = s.stats && s.stats.lastAt ? timeAgo(s.stats.lastAt) : '';
      const cost = s.stats ? fmtUsd(s.stats.costUSD) : '';
      return `
          <g class="node ${k} ${this.mapSel === s.id ? 'sel' : ''}" data-sel="${esc(s.id)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" role="button" tabindex="0" aria-label="${esc(s.roleLabel)} ayrıntıları">
            <title>${esc(s.name)} · ${esc(statsLine(s.stats))}</title>
            ${k === 'busy' || k === 'starting' ? `<circle class="halo" r="${NR + 4}" fill="${color}"></circle>` : ''}
            <circle class="ctx-track" r="${NR + 7}"></circle>
            ${arc ? `<circle class="ctx-arc ${pct >= 80 ? 'warn' : ''}" r="${NR + 7}" stroke-dasharray="${(CIRC * arc).toFixed(1)} ${CIRC.toFixed(1)}" transform="rotate(-90)"></circle>` : ''}
            <circle class="body" r="${NR}" style="--rc: ${color}"></circle>
            <circle class="status-dot ${k}" cx="${(NR * 0.72).toFixed(1)}" cy="${(-NR * 0.72).toFixed(1)}" r="8"></circle>
            <text class="n-ini" y="9">${esc(initials(s.roleLabel))}</text>
            <text class="n-role" y="${NR + 30}">${esc(s.roleLabel)}</text>
            <text class="n-sub" y="${NR + 48}">${esc(s.accountId)} · ${esc(statusLabel(s))}${last ? ` · ${esc(last)}` : ''}</text>
            <text class="n-sub" y="${NR + 64}">${esc(cost)}${pct != null ? ` · bağlam %${pct}` : ''}</text>
          </g>`;
    }).join('');

    const sel = members.find((s) => s.id === this.mapSel);
    const roleOf = (id) => (members.find((s) => s.id === id) || {}).roleLabel;
    const detail = sel ? (() => {
      const lastMsg = [...msgs].reverse().find((m) => m.from === sel.id || m.to === sel.id);
      return `
          <div class="node-card">
            <div class="nc-head"><span class="nc-dot" style="background: ${roleColor(sel)}"></span><strong>${esc(sel.roleLabel)}</strong>${statusBadge(sel)}</div>
            <div class="mono note" style="word-break: break-all">${esc(sel.name)}</div>
            <div class="nc-grid">
              <span>Hesap</span><b>${esc(sel.accountId)}</b>
              <span>Model</span><b>${esc((sel.stats && familyOf(sel.stats.model)) || sel.model || 'varsayılan')}</b>
              <span>Gönderdi / aldı</span><b>${sent.get(sel.id) || 0} / ${recv.get(sel.id) || 0}</b>
              <span>Harcama</span><b>${esc(sel.stats ? fmtUsd(sel.stats.costUSD) : '-')}</b>
              <span>Bağlam</span><b>${esc(sel.stats ? `${fmtTok(sel.stats.context)}${ctxPct(sel.stats) != null ? ` (%${ctxPct(sel.stats)})` : ''}` : '-')}</b>
            </div>
            ${lastMsg ? `<div class="note">Son mesaj · ${esc(roleOf(lastMsg.from) || '?')} → ${esc(roleOf(lastMsg.to) || lastMsg.toName || '?')}</div><div class="nc-msg">${esc(lastMsg.text)}</div>` : ''}
            <div class="actions"><button class="btn small primary" data-goto="${esc(sel.id)}">Terminale git</button><button class="btn small ghost" data-sel="">Kapat</button></div>
          </div>` ;
    })() : '';

    const recent = msgs.slice(-14).reverse();
    $('#activity').innerHTML = `
        <div class="map-wrap">
          <div class="map-box card">
            <div class="map-top">
              <div class="seg" role="group" aria-label="Zaman aralığı">
                ${MAP_WINDOWS.map(([v, l]) => `<button data-mw="${v}" aria-pressed="${this.mapWindow === v}">${l}</button>`).join('')}
              </div>
              <span class="note">${msgs.length} mesaj${outside ? ` · ${outside} grup dışına` : ''}</span>
            </div>
            <svg id="map-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Ekip iletişim haritası">
              <defs>
                ${markers}
                <radialGradient id="map-bg" cx="50%" cy="48%" r="60%"><stop offset="0%" stop-color="#1a2030"></stop><stop offset="100%" stop-color="#11141a" stop-opacity="0"></stop></radialGradient>
                <pattern id="map-dots" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.2" fill="#232836"></circle></pattern>
              </defs>
              <rect width="${W}" height="${H}" fill="url(#map-dots)"></rect>
              <rect width="${W}" height="${H}" fill="url(#map-bg)"></rect>
              ${lead && R ? `<ellipse cx="${cx}" cy="${cy}" rx="${R}" ry="${(R * 0.72).toFixed(1)}" class="orbit"></ellipse>` : ''}
              ${edgeSvg}${nodeSvg}
            </svg>
            <div class="map-legend">
              ${[...new Set(members.map((s) => s.roleId))].map((rid) => {
              const s = members.find((x) => x.roleId === rid);
              return `<span><i style="background: ${roleColor(s)}"></i>${esc(s.roleLabel)}</span>`;
            }).join('')}
              <span class="note">Dış halka: bağlam doluluğu · akan nokta: son 1 dk · düğüme tıkla: ayrıntı</span>
            </div>
          </div>
          <div class="msg-list card">
            ${detail}
            <div class="msg-head"><strong>Son mesajlar</strong><span class="note">${msgs.length}</span></div>
            ${recent.length ? recent.map((m) => `
              <div class="msg ${a.now - m.ts < HOT_MS ? 'hot' : ''}" data-mfrom="${esc(m.from)}">
                <div class="note"><span class="nc-dot" style="background: ${roleColor(members.find((s) => s.id === m.from))}"></span>${esc(new Date(m.ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }))} · <b>${esc(roleOf(m.from) || '?')}</b> → <b>${esc(roleOf(m.to) || m.toName || '?')}</b></div>
                <div>${esc(m.text)}</div>
              </div>`).join('') : '<div class="note" style="padding: 11px 12.5px">Bu aralıkta ekip içi mesaj yok.</div>'}
          </div>
        </div>`;
  },

  // Ajan mesajları: filtre ve arama alanı bir kez kurulur, liste her yenilemede güncellenir (yazı kaybolmasın diye).
  renderMsgs(g, a) {
    if (!a) return;
    const box = $('#activity');
    if (!$('#msg-tools')) {
      this.msgKey = null;
      box.innerHTML = `
          <div class="card msgs">
            <div class="msg-tools" id="msg-tools">
              <div class="seg" id="msg-filter" role="group" aria-label="Üyeye göre filtre"></div>
              <input id="msg-search" placeholder="Mesajlarda ara" aria-label="Mesajlarda ara">
              <span class="note" id="msg-count"></span>
            </div>
            <div id="msg-items"></div>
          </div>`;
      $('#msg-filter').addEventListener('click', (e) => {
        const b = e.target.closest('[data-mf]');
        if (!b) return;
        this.msgFilter = b.dataset.mf;
        this.renderMsgs(this.group(), this.lastActivity);
      });
      $('#msg-search').addEventListener('input', () => this.renderMsgs(this.group(), this.lastActivity));
      $('#msg-items').addEventListener('toggle', (e) => {
        const d = e.target;
        if (!d.matches || !d.matches('details[data-mid]')) return;
        if (d.open) this.openMsgs.add(d.dataset.mid); else this.openMsgs.delete(d.dataset.mid);
        if (d.open) this.loadBody(d);
      }, true);
    }
    const members = g.sessions;
    const q = $('#msg-search').value.trim().toLocaleLowerCase('tr');
    if (q) this.loadAllBodies();
    // Mesaj listesi, filtre ve arama değişmediyse yeniden çizilmez (açık ayrıntılar ve kaydırma korunur).
    // "Yeni" işareti için süre dilimi de anahtarda: 45 sn'lik pencere kapanınca liste bir kez yenilenir.
    const key = JSON.stringify([g.id, members.map((s) => [s.id, s.roleLabel]), this.msgFilter, q, a.messages.length,
      a.messages.length ? a.messages[a.messages.length - 1].ts : 0, Math.floor(a.now / 15000), this.msgBodies.size]);
    if (key === this.msgKey) return;
    this.msgKey = key;
    const label = (id, fallback) => {
      const s = members.find((x) => x.id === id);
      return s ? s.roleLabel : fallback || '?';
    };
    $('#msg-filter').innerHTML = [['all', 'Tümü'], ...members.map((s) => [s.id, s.roleLabel])]
      .map(([v, l]) => `<button data-mf="${esc(v)}" aria-pressed="${this.msgFilter === v}">${esc(l)}</button>`).join('');
    const list = a.messages
      .filter((m) => this.msgFilter === 'all' || m.from === this.msgFilter || m.to === this.msgFilter)
      .filter((m) => !q || `${m.text}\n${this.msgBodies.get(`${m.ts}-${m.from}`) || ''}`.toLocaleLowerCase('tr').includes(q))
      .slice(-300)
      .reverse();
    $('#msg-count').textContent = `${list.length} / ${a.messages.length} mesaj`;
    $('#msg-items').innerHTML = list.length ? list.map((m) => {
      const mid = `${m.ts}-${m.from}`;
      const time = new Date(m.ts).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `
          <details class="msg-item ${a.now - m.ts < 45000 ? 'hot' : ''}" data-mid="${esc(mid)}" ${this.openMsgs.has(mid) ? 'open' : ''}>
            <summary><span class="note">${esc(time)}</span> <b>${esc(label(m.from))}</b> → <b>${esc(label(m.to, m.toName))}</b> · ${esc(m.text)}</summary>
            <div class="last">${esc(this.msgBodies.get(mid) || m.text)}</div>
          </details>`;
    }).join('') : '<div class="note" style="padding: 12.5px">Eşleşen mesaj yok.</div>';
  },

  // Mesaj gövdesi listeyle gelmez; ayrıntı açılınca tek mesaj olarak alınır.
  async loadBody(d) {
    const mid = d.dataset.mid;
    if (this.msgBodies.has(mid)) return;
    const i = mid.indexOf('-');
    try {
      const r = await api('GET', `/api/groups/${this.gid}/message?from=${encodeURIComponent(mid.slice(i + 1))}&ts=${mid.slice(0, i)}`);
      this.msgBodies.set(mid, r.body);
      const box = d.querySelector('.last');
      if (box) box.textContent = r.body;
    } catch {}
  },

  // Arama gövdelerde de yapılır; bunun için tüm gövdeler bir kez alınır.
  async loadAllBodies() {
    if (this.allBodies) return;
    this.allBodies = true;
    try {
      const r = await api('GET', `/api/groups/${this.gid}/activity?bodies=1`);
      for (const m of r.messages) this.msgBodies.set(`${m.ts}-${m.from}`, m.body);
      this.msgKey = null;
      if (this.lastActivity && this.view === 'msgs') this.renderMsgs(this.group(), this.lastActivity);
    } catch { this.allBodies = false; }
  },

  renderTimeline(g, a) {
    const members = g.sessions.filter((s) => !s.removed);
    const tl = a.timeline || {};
    let start = g.createdAt;
    for (const s of members) {
      const list = tl[s.id];
      if (list && list.length && list[0].t < start) start = list[0].t;
    }
    const end = a.now;
    const span = Math.max(60000, end - start);
    const pct = (t) => Math.max(0, Math.min(100, ((t - start) / span) * 100));
    const COLORS = { busy: 'busy', starting: 'starting', waiting: 'waiting', idle: 'idle', off: 'off', away: 'away' };
    const LABEL = { ...STATUS, off: 'kapalı', away: 'sıra sende · sen yoktun' };

    // Kullanıcının uzakta olduğu aralıklar; "sıra sende" ve "onay bekliyor" bu aralıklarda ayrı gösterilir.
    const user = a.user || [];
    const away = awayIntervals(user, end);
    const split = (t0, t1) => splitAway(away, t0, t1);
    const bar = (cls, label, t0, t1) => `<span class="seg-bar ${cls}" style="left: ${pct(t0)}%; width: ${Math.max(0.3, pct(t1) - pct(t0))}%" title="${esc(label)} · ${hhmmOf(t0)}–${hhmmOf(t1)} (${fmtDur(t1 - t0)})"></span>`;

    // Eksen: 6–10 çizgi olacak şekilde aralık seçilir.
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480].map((m) => m * 60000);
    const step = steps.find((s) => span / s <= 10) || steps[steps.length - 1];
    const ticks = [];
    for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push(t);
    const hhmmOf = (t) => new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

    const sums = {};
    const rows = members.map((s) => {
      const list = tl[s.id] || [];
      const totals = { busy: 0, waiting: 0, idle: 0, away: 0 };
      const segs = list.map((e, i) => {
        const to = i + 1 < list.length ? list[i + 1].t : end;
        if (e.s === 'off') return '';
        if (e.s !== 'idle' && e.s !== 'waiting') {
          if (e.s in totals) totals[e.s] += to - e.t;
          return bar(COLORS[e.s] || 'busy', LABEL[e.s] || e.s, e.t, to);
        }
        // Sen yokken geçen bekleme ayrı sayılır: oturum sana değil, senin dönmene bekliyordu.
        return split(e.t, to).map(([t0, t1, out]) => {
          totals[out ? 'away' : e.s] += t1 - t0;
          return out ? bar('away', e.s === 'waiting' ? 'onay bekliyor · sen yoktun' : LABEL.away, t0, t1) : bar(COLORS[e.s], LABEL[e.s], t0, t1);
        }).join('');
      }).join('');
      sums[s.id] = totals;
      const marks = a.messages.filter((m) => m.from === s.id).map((m) => {
        const to = members.find((x) => x.id === m.to);
        return `<span class="msg-mark" style="left: ${pct(m.ts)}%" title="${hhmmOf(m.ts)} → ${esc(to ? to.roleLabel : m.toName)}: ${esc(m.text)}"></span>`;
      }).join('');
      return `
          <div class="tl-row">
            <button class="tl-name" data-goto="${esc(s.id)}" title="${esc(s.name)}"><span class="dot ${statusKey(s)}"></span>${esc(s.roleLabel)} <span class="note">${esc(s.accountId)}</span></button>
            <div class="tl-track">${segs}${marks}</div>
            <div class="tl-sum note">çalıştı ${fmtDur(totals.busy)} · <span style="color: var(--warn-text)">onay ${fmtDur(totals.waiting)}</span> · sıra sende ${fmtDur(totals.idle)}${totals.away ? ` · sen yoktun ${fmtDur(totals.away)}` : ''}</div>
          </div>`;
    }).join('');
    const userSegs = user.map((e, i) => {
      const to = i + 1 < user.length ? user[i + 1].t : end;
      if (e.s === 'off' || to <= start) return '';
      return bar(e.s === 'away' ? 'away' : 'here', e.s === 'away' ? 'uzaktaydın' : 'paneldeydin', Math.max(start, e.t), to);
    }).join('');
    const userRow = user.length ? `
          <div class="tl-row">
            <span class="tl-name">Sen</span>
            <div class="tl-track">${userSegs}</div>
            <div class="tl-sum note">${Math.round((a.awayMs || 600000) / 60000)} dk temas olmazsa uzakta sayılırsın</div>
          </div>` : '';

    // İstatistik: toplamlar ve üye bazında dağılım; satırlardaki sayılarla aynı kaynaktan hesaplanır.
    const sumOf = (k) => members.reduce((t, s) => t + sums[s.id][k], 0);
    const sentBy = (id) => a.messages.filter((m) => m.from === id).length;
    const awayTotal = away.reduce((t, [a0, a1]) => t + (a1 - a0), 0);
    const tiles = [
      ['Çalışma', fmtDur(sumOf('busy'))],
      ['Onay bekleme', fmtDur(sumOf('waiting'))],
      ['Sıra sende', fmtDur(sumOf('idle'))],
      ['Sen uzaktaydın', fmtDur(awayTotal)],
      ['Mesaj', String(a.messages.length)],
    ];
    const statsHtml = `
        <div class="card tl-stats">
          <div class="tl-tiles">${tiles.map(([l, v]) => `<div class="tl-tile"><span>${l}</span><strong>${v}</strong></div>`).join('')}</div>
          <div class="tl-tbl-wrap">
            <table class="tl-stats-tbl">
              <thead><tr><th>Üye</th><th>Çalıştı</th><th>Çalışma oranı</th><th>Onay</th><th>Sıra sende</th><th>Gönderdiği mesaj</th></tr></thead>
              <tbody>${members.map((s) => {
              const t = sums[s.id];
              return `<tr><td><span class="dot ${statusKey(s)}"></span>${esc(s.roleLabel)}</td><td>${fmtDur(t.busy)}</td><td>${Math.round((t.busy / span) * 100)}%</td><td>${fmtDur(t.waiting)}</td><td>${fmtDur(t.idle)}</td><td>${sentBy(s.id)}</td></tr>`;
            }).join('')}</tbody>
            </table>
          </div>
        </div>`;

    $('#activity').innerHTML = `
        <div class="card tl">
          <div class="tl-row tl-axis">
            <span></span>
            <div class="tl-track">${ticks.map((t) => `<span class="tick" style="left: ${pct(t)}%">${hhmmOf(t)}</span>`).join('')}</div>
            <span></span>
          </div>
          ${userRow}
          ${rows}
          <div class="tl-legend note">
            <span><i class="seg-bar busy"></i>çalışıyor</span>
            <span><i class="seg-bar waiting"></i>onay bekliyor</span>
            <span><i class="seg-bar idle"></i>sıra sende</span>
            <span><i class="seg-bar away"></i>sen yoktun</span>
            <span><i class="msg-mark"></i>gönderilen mesaj</span>
            <span>Kayıt yalnızca panel açıkken tutulur; boşluklar kapalı ya da kaydedilmemiş süredir.</span>
          </div>
        </div>
        ${statsHtml}`;
  },

  // ----- çalışırken üye ekleme -----

  // ----- görev panosu -----

  // ----- grup notları -----

  initNotes() {
    const act$ = $('#activity');
    act$.addEventListener('click', (e) => {
      const b = e.target.closest('[data-nact]');
      if (!b || this.view !== 'notes') return;
      const id = Number(b.dataset.nid);
      const a = b.dataset.nact;
      // Satır içi düzenleyici.
      if (a === 'etab') {
        this.noteEd.tab = b.dataset.tab;
        return this.renderEditor(this.group(), $('#notes-read'));
      }
      if (a === 'eto') {
        const all = b.dataset.all === '1';
        $('#notes-read').querySelectorAll('[data-neto]').forEach((x) => { x.checked = all; });
        this.noteEd.to = new Set(all ? this.group().sessions.filter((s) => !s.removed).map((s) => s.id) : []);
        return;
      }
      if (a === 'esave') return this.saveEdit();
      if (a === 'ecancel') {
        if (!this.leaveEdit()) return;
        this.notesKey = null;
        return this.renderNotes(this.group(), this.lastNotes);
      }
      if (a === 'hist') return this.openHistory(id);
      if (a === 'hsel') { this.noteHist.sel = Number(b.dataset.hi); this.notesKey = null; return this.renderNotes(this.group(), this.lastNotes); }
      if (a === 'hrestore') return this.restoreVersion(Number(b.dataset.hi));
      if (a === 'currun') return this.runCurator();
      if (a === 'unarch') return this.unarchiveNote(id);
      // Buradan sonrakiler okuma alanını değiştirir: açık düzenleyicide kaydedilmemiş değişiklik varsa sorulur.
      if (['tab', 'sel', 'back', 'new', 'edit', 'arch', 'dsel', 'dhit'].includes(a) && !this.leaveEdit()) return;
      if (a === 'arch') {
        this.showArchived = !this.showArchived;
        this.noteSel = null;
        this.noteHist = null;
        this.notesKey = null;
        return this.renderNotes(this.group(), this.lastNotes);
      }
      if (a === 'tab') {
        this.noteTab = b.dataset.tab;
        store(NOTETAB_KEY, this.noteTab);
        this.noteReading = false;
        this.lineSel = null;
        this.notesKey = null;
        this.docKey = null;
        if (this.noteTab === 'docs') this.loadDocs(this.group());
        return this.renderNotes(this.group(), this.lastNotes);
      }
      if (a === 'dfold') return this.toggleDocDir(b);
      if (a === 'dsel') return this.openDoc(b.dataset.path);
      if (a === 'dhit') return this.openDoc(b.dataset.path, Number(b.dataset.ln));
      if (a === 'dclear') { this.docHits = null; this.docKey = null; return this.renderNotes(this.group(), this.lastNotes); }
      if (a === 'refs') return this.openRefs();
      if (a === 'remind') return this.openRemind(b.dataset.kind);
      if (a === 'src') {
        this.srcView = b.dataset.src === '1';
        this.notesKey = null;
        this.docKey = null;
        return this.renderNotes(this.group(), this.lastNotes);
      }
      if (a === 'ln') {
        const n = Number(b.dataset.ln);
        const s = this.lineSel;
        if (e.shiftKey && s) this.lineSel = { from: Math.min(s.from, n), to: Math.max(s.from, n) };
        else this.lineSel = s && s.from === n && s.to === n ? null : { from: n, to: n };
        return this.paintLines();
      }
      if (a === 'new') this.startEdit(null);
      else if (a === 'edit') this.startEdit(id);
      else if (a === 'sel' || a === 'back') {
        if (a === 'sel') {
          // Arşivdeki notun hedefine geçerken liste de ona göre değişir.
          const t = (this.lastNotes.notes || []).find((x) => x.id === id);
          if (t && !!t.archived !== !!this.showArchived) this.showArchived = !!t.archived;
          if (this.noteSel !== id) this.noteHist = null;
          this.noteSel = id;
          this.lineSel = null;
        }
        if (a === 'back') this.docKey = null;
        // Dar ekranda liste ile okuma alanı arasında geçiş.
        this.noteReading = a === 'sel';
        this.renderNotes(this.group(), this.lastNotes);
        if (a === 'back') { const it = $(`#notes-list [data-nid="${id || this.noteSel}"]`); if (it) it.focus(); }
      } else if (a === 'del') this.deleteNote(id);
    });
    act$.addEventListener('input', (e) => {
      if (this.noteEd && (e.target.id === 'ne-title' || e.target.id === 'ne-body')) {
        this.noteEd[e.target.id === 'ne-title' ? 'title' : 'body'] = e.target.value;
        this.noteEd.dirty = true;
        return;
      }
      if (this.noteEd && e.target.dataset.neto) {
        if (e.target.checked) this.noteEd.to.add(e.target.dataset.neto);
        else this.noteEd.to.delete(e.target.dataset.neto);
        return;
      }
      if (e.target.id === 'docs-q') {
        this.docQuery = e.target.value;
        if (this.docHits && !e.target.value.trim()) this.docHits = null;
        this.docKey = null;
        return this.renderNotes(this.group(), this.lastNotes);
      }
      if (e.target.id !== 'notes-q') return;
      this.noteQuery = e.target.value;
      this.notesKey = null;
      this.renderNotes(this.group(), this.lastNotes);
    });
    act$.addEventListener('keydown', (e) => {
      // Düzenleyicide Ctrl+Enter kaydeder, Esc vazgeçer.
      if (this.noteEd && (e.target.id === 'ne-title' || e.target.id === 'ne-body')) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.saveEdit(); }
        else if (e.key === 'Escape' && this.leaveEdit()) { this.notesKey = null; this.renderNotes(this.group(), this.lastNotes); }
        return;
      }
      if (e.target.id === 'docs-q' && e.key === 'Enter') {
        e.preventDefault();
        this.searchDocs(e.target.value);
      }
    });
    const rdlg = $('#remind-dlg');
    rdlg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mdlg]');
      if (!b) return;
      if (b.dataset.mdlg === 'cancel') return rdlg.close();
      if (b.dataset.mdlg === 'send') this.sendRemind();
    });
    rdlg.addEventListener('input', () => this.remindPreview());
    rdlg.addEventListener('change', () => this.remindPreview());
    const fdlg = $('#refs-dlg');
    fdlg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rdlg]');
      if (!b) return;
      if (b.dataset.rdlg === 'cancel') return fdlg.close();
      if (b.dataset.rdlg === 'save') this.saveRefs();
    });
  },

  async runCurator() {
    const sel = $('#cur-run-level');
    const r = await act(() => api('POST', `/api/groups/${this.gid}/curator/run`, { level: sel ? sel.value : undefined }), 'Not düzenleyici başladı; bitince bildirim gelir.');
    if (!r) return;
    this.curStatus = r;
    this.curAt = Date.now();
    this.notesKey = null;
    this.renderNotes(this.group(), this.lastNotes);
  },

  async unarchiveNote(id) {
    const r = await act(() => api('POST', `/api/groups/${this.gid}/notes/${id}/unarchive`), 'Not arşivden çıkarıldı.');
    if (!r) return;
    this.lastNotes = r;
    this.showArchived = false;
    this.noteSel = id;
    this.notesKey = null;
    this.renderNotes(this.group(), r);
  },

  async refreshNotes(g) {
    if (this.loadingNotes) return;
    this.loadingNotes = true;
    try {
      await this.loadCurator(g);
      this.lastNotes = await api('GET', `/api/groups/${g.id}/notes`);
      this.renderNotes(g, this.lastNotes);
    } catch (err) {
      this.notesKey = null;
      $('#activity').innerHTML = err.status === 404
        ? '<div class="empty">Grup notları için panel sunucusunun yeniden başlatılması gerekiyor (yeni sürüm henüz yüklenmedi).</div>'
        : `<div class="empty">Notlar alınamadı: ${esc(err.message)}</div>`;
    } finally {
      this.loadingNotes = false;
    }
  },

  renderNotes(g, data) {
    if (!g || !data || this.view !== 'notes') return;
    const box = $('#activity');
    if (!$('#notes-app')) {
      this.notesKey = null;
      box.innerHTML = `
          <div class="notes-app" id="notes-app">
            <aside class="notes-side">
              <div class="seg ns-tabs" role="group" aria-label="Not türü">
                <button data-nact="tab" data-tab="group">Grup notları <span class="count" id="notes-count"></span></button>
                <button data-nact="tab" data-tab="docs">Proje dokümanları <span class="count" id="docs-count"></span></button>
              </div>
              <div class="ns-pane" id="ns-group">
                <div class="ns-head">
                  <input id="notes-q" type="search" placeholder="Notlarda ara" aria-label="Notlarda ara" value="${esc(this.noteQuery || '')}">
                  <button class="btn small primary" data-nact="new">${ICON_PLUS} Not ekle</button>
                </div>
                <div class="ns-list" id="notes-list" role="list"></div>
                <div class="ns-foot" id="notes-foot"></div>
              </div>
              <div class="ns-pane" id="ns-docs">
                <div class="ns-head">
                  <input id="docs-q" type="search" placeholder="Ada göre süz · Enter: içerikte ara" aria-label="Dokümanlarda ara" value="${esc(this.docQuery || '')}">
                  <button class="btn small" data-nact="refs" title="Proje dokümanı kaynaklarını düzenle">Kaynaklar</button>
                </div>
                <div class="ns-list" id="docs-list" role="list"></div>
              </div>
            </aside>
            <section class="notes-read" id="notes-read" aria-live="polite"></section>
          </div>`;
    }
    const docsTab = this.noteTab === 'docs';
    $('#ns-group').hidden = docsTab;
    $('#ns-docs').hidden = !docsTab;
    $('#notes-app').querySelectorAll('[data-nact="tab"]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.tab === this.noteTab)));
    if (docsTab) this.loadDocs(g);
    const members = g.sessions.filter((s) => !s.removed);
    const q = (this.noteQuery || '').trim().toLocaleLowerCase('tr');
    const archived = data.notes.filter((n) => n.archived).length;
    if (!archived) this.showArchived = false;
    const list = data.notes.slice().reverse().filter((n) => !!n.archived === !!this.showArchived && (!q || `${n.title}\n${n.body}`.toLocaleLowerCase('tr').includes(q)));
    if (!this.noteEd && !list.some((n) => n.id === this.noteSel)) this.noteSel = list.length ? list[0].id : null;
    $('#notes-app').classList.toggle('reading', !!this.noteReading && (docsTab ? !!this.docSel : this.noteSel != null));
    if (docsTab) {
      $('#notes-count').textContent = String(data.notes.length);
      this.notesKey = null;
      return this.renderDocs(g);
    }
    const key = JSON.stringify([data.notes, members.map((s) => [s.id, s.roleLabel]), q, this.noteSel, this.noteReading, this.srcView, this.showArchived, this.noteHist, this.curStatus, !!this.noteEd, Math.floor(Date.now() / 60000)]);
    if (key === this.notesKey) return;
    this.notesKey = key;
    this.docKey = null;
    const nameOf = (sid) => {
      if (sid === 'user') return { label: 'sen', color: 'var(--text-2)' };
      if (sid === 'curator') return { label: 'not düzenleyici', color: 'var(--muted)' };
      const s = g.sessions.find((x) => x.id === sid);
      return s ? { label: `${s.roleLabel} · ${s.accountId}`, color: roleColor(s) } : { label: 'çıkarılmış üye', color: 'var(--muted)' };
    };
    const who = (sid) => {
      const w = nameOf(sid);
      return `<span class="kc-who"><span class="rdot" style="background: ${w.color}"></span>${esc(w.label)}</span>`;
    };
    $('#notes-count').textContent = String(data.notes.length);

    const listEl = $('#notes-list');
    const scroll = listEl.scrollTop;
    listEl.innerHTML = list.length ? list.map((n) => {
      const waiting = (n.waiting || []).length;
      return `
          <button class="ns-item" role="listitem" data-nact="sel" data-nid="${n.id}" aria-current="${n.id === this.noteSel}">
            <span class="ns-top"><span class="ns-name">${esc(n.title)}</span><span class="ns-time">${esc(timeAgo(n.updatedAt || n.createdAt))}</span></span>
            <span class="ns-meta">${who(n.by)}${waiting ? `<span class="kc-deliv wait">${waiting} bekliyor</span>` : ''}${n.archived && n.mergedInto ? `<span class="note">→ #${n.mergedInto}</span>` : ''}</span>
            ${n.body ? `<span class="ns-prev">${esc(notePlain(n.body).replace(/[#*`>\-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180))}</span>` : ''}
          </button>`;
    }).join('') : `<div class="ns-empty">${q ? 'Aramaya uyan not yok.' : this.showArchived ? 'Arşiv boş.' : 'Henüz not yok.'}</div>`;
    listEl.scrollTop = scroll;
    this.renderCurator(archived);

    const read = $('#notes-read');
    if (this.noteEd) return this.renderEditor(g, read);
    delete read.dataset.ed;
    const n = list.find((x) => x.id === this.noteSel);
    if (!n) {
      read.innerHTML = `<div class="nr-empty">
          <div class="nr-empty-title">${data.notes.length ? 'Soldan bir not seç' : 'Not defteri boş'}</div>
          <p class="note">Ekibin ortak not defteri: kararlar, bulgular, herkesin bilmesi gereken bilgiler. Üyeler <span class="mono">not_ekle</span> ile yazar; yeni not diğer üyelere "şu üye şu başlıklı not ekledi" diye kısa bildirimle iletilir.</p>
          <button class="btn primary" data-nact="new">${ICON_PLUS} İlk notu ekle</button></div>`;
      return;
    }
    const waiting = n.waiting || [];
    const chips = n.to.map((sid) => {
      const w = nameOf(sid);
      const wait = waiting.includes(sid);
      const got = !wait && (n.delivered || {})[sid];
      return `<span class="nr-chip ${wait ? 'wait' : got ? 'ok' : ''}" title="${wait ? 'iletilmeyi bekliyor' : got ? 'iletildi' : 'iletilmedi'}"><span class="rdot" style="background: ${w.color}"></span>${esc(w.label)} ${wait ? '⏳' : got ? '✓' : ''}</span>`;
    }).join('');
    const edited = n.updatedAt > n.createdAt + 1000;
    const hist = this.noteHist && this.noteHist.id === n.id ? this.noteHist : null;
    const owner = n.by === 'user'
      ? '<span class="own-badge">senin notun</span>'
      : n.body && noteSegments(n.body).some((s) => s.u) ? '<span class="own-badge soft">senin eklediğin kısımlar işaretli</span>' : '';
    read.innerHTML = `
        <div class="nr-head">
          <button class="btn small ghost nr-back" data-nact="back">← Notlar</button>
          <div class="nr-titlebox">
            <div class="nr-kicker"><span class="kc-id">#${n.id}</span>${who(n.by)}${owner}<span class="note">${esc(fmtDate(n.createdAt))}${edited ? ` · düzenlendi ${esc(timeAgo(n.updatedAt))}${n.updatedBy && n.updatedBy !== n.by ? ` (${esc(nameOf(n.updatedBy).label)})` : ''}` : ''}</span></div>
            <h2 class="nr-title">${esc(n.title)}</h2>
          </div>
          <div class="nr-actions">
            ${n.body ? `<div class="seg" role="group" aria-label="Görünüm"><button data-nact="src" data-src="0" aria-pressed="${!this.srcView}">Görünüm</button><button data-nact="src" data-src="1" aria-pressed="${!!this.srcView}">Satırlar</button></div>` : ''}
            ${n.archived ? `<button class="btn small" data-nact="unarch" data-nid="${n.id}">Arşivden çıkar</button>` : `
            <button class="btn small primary" data-nact="remind" data-kind="note">${this.lineSel ? `Hatırlat (satır ${this.lineSel.from}${this.lineSel.to > this.lineSel.from ? `–${this.lineSel.to}` : ''})` : 'Hatırlat'}</button>
            <button class="btn small" data-nact="edit" data-nid="${n.id}">Düzenle</button>`}
            ${n.historyCount ? `<button class="btn small ghost" data-nact="hist" data-nid="${n.id}" aria-pressed="${!!hist}">Geçmiş (${n.historyCount})</button>` : ''}
            <button class="btn small ghost danger-text" data-nact="del" data-nid="${n.id}">Sil</button>
          </div>
        </div>
        ${n.archived ? `<div class="nr-banner">Bu not ${n.archivedBy === 'curator' ? 'not düzenleyici tarafından ' : ''}${n.mergedInto ? `<button class="linkish" data-nact="sel" data-nid="${n.mergedInto}">#${n.mergedInto}</button> notuyla birleştirildi` : 'arşive alındı'}${n.archivedAt ? ` (${esc(timeAgo(n.archivedAt))})` : ''}. Silinmedi; arşivden çıkarırsan yeniden listede görünür.</div>` : ''}
        ${hist ? this.histHtml(hist, nameOf) : ''}
        <div class="nr-body${this.srcView ? ' nr-src' : ' md'}">${!n.body ? '<p class="note">İçerik yok.</p>' : this.srcView ? this.linesHtml(n.body) : noteMd(n.body)}</div>
        <div class="nr-foot"><span class="note">Bildirim:</span>${n.to.length ? chips : '<span class="note">kimseye bildirilmedi</span>'}</div>`;
  },

  // Not geçmişi: her sürüm (kim, ne zaman) ve seçilen sürümün içeriği; o sürüme dönülebilir.
  histHtml(h, nameOf) {
    if (h.loading) return '<div class="nr-hist"><span class="note">Geçmiş yükleniyor…</span></div>';
    if (h.error) return `<div class="nr-hist"><span class="note">${esc(h.error)}</span></div>`;
    const sel = h.items.find((x) => x.index === h.sel) || null;
    return `<div class="nr-hist">
        <div class="nh-head"><strong>Önceki sürümler</strong><span class="note">Her değişiklikten önceki hali saklanır; geri dönmek de yeni bir sürüm olarak kaydedilir.</span><button class="btn icon small" data-nact="hist" data-nid="${h.id}" aria-label="Geçmişi kapat">✕</button></div>
        <div class="nh-list">${h.items.map((x) => `<button class="nh-item" data-nact="hsel" data-hi="${x.index}" aria-current="${x.index === h.sel}"><span>${esc(fmtDate(x.at))}</span><span class="note">${esc(nameOf(x.by).label)} · ${esc(x.title)} · ${notePlain(x.body).length} kr.</span></button>`).join('')}</div>
        ${sel ? `<div class="nh-prev md">${sel.body ? noteMd(sel.body) : '<p class="note">İçerik yok.</p>'}</div>
          <div class="actions"><button class="btn small primary" data-nact="hrestore" data-hi="${sel.index}">Bu sürüme dön</button></div>` : '<p class="note">İçeriğini görmek için bir sürüm seç.</p>'}
      </div>`;
  },

  // Not düzenleyicinin durumu ve arşiv geçişi (not listesinin altında).
  renderCurator(archived) {
    const el = $('#notes-foot');
    if (!el) return;
    const c = this.curStatus;
    const last = c && c.last;
    const state = !c ? '' : c.running ? `çalışıyor (${esc(timeAgo(c.startedAt))} başladı)`
      : last ? `${esc(timeAgo(last.at))}${last.level && c.levels ? ` (${esc(c.levels[last.level] || last.level)})` : ''}: ${last.ok ? esc(last.changes) : 'tamamlanamadı'}` : 'henüz çalışmadı · ilk düzenlemeyi Şimdi düzenle başlatır';
    el.innerHTML = `
        <div class="nf-row"><div class="nf-head"><span class="nf-label" title="${last && last.text ? esc(last.text) : 'Notları aralıklı olarak toparlar: tekrarları birleştirir, çelişkileri şefe sorar. Senin yazdığın kısımlara dokunmaz.'}">Not düzenleyici</span>
          <span class="note nf-state">${state}${c && c.open ? ` · şefte ${c.open} soru` : ''}</span></div>
          <div class="nf-actions">${c && c.levels ? `<select id="cur-run-level" class="small-select" title="Derinlik: düşük yalnızca yeni notlara bakar; orta bunlarla ilgili eski notları da ele alır, onaylanmış review zincirlerini katar; yüksek tüm notları kart ve konu gruplarıyla baştan toparlar, geçersiz kalanları işaretler, iddiaları projede doğrular (daha uzun ve pahalı)" ${c.running ? 'disabled' : ''}>${Object.entries(c.levels).map(([k, v]) => `<option value="${k}" ${k === c.level ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>` : ''}
          <button class="btn small ghost" data-nact="currun" ${c && c.running ? 'disabled' : ''}>Şimdi düzenle</button></div></div>
        ${archived ? `<button class="linkish" data-nact="arch">${this.showArchived ? '← Notlara dön' : `Arşiv (${archived})`}</button>` : ''}`;
  },

  async loadCurator(g) {
    if (this.curLoading || (this.curAt && Date.now() - this.curAt < 15000)) return;
    this.curLoading = true;
    try {
      this.curStatus = await api('GET', `/api/groups/${g.id}/curator`);
    } catch {
      this.curStatus = null;
    } finally {
      this.curAt = Date.now();
      this.curLoading = false;
    }
  },

  async openHistory(id) {
    if (this.noteHist && this.noteHist.id === id) { this.noteHist = null; return this.renderNotes(this.group(), this.lastNotes); }
    this.noteHist = { id, loading: true };
    this.renderNotes(this.group(), this.lastNotes);
    try {
      const r = await api('GET', `/api/groups/${this.gid}/notes/${id}/history`);
      this.noteHist = { id, items: r.history, sel: r.history.length ? r.history[0].index : null };
    } catch (err) {
      this.noteHist = { id, error: err.message };
    }
    this.renderNotes(this.group(), this.lastNotes);
  },

  async restoreVersion(index) {
    const id = this.noteHist && this.noteHist.id;
    if (id == null || !confirm('Not bu sürüme döndürülsün mü? Şimdiki hali geçmişte saklanır.')) return;
    const r = await act(() => api('POST', `/api/groups/${this.gid}/notes/${id}/restore`, { index }), 'Not önceki sürüme döndürüldü.');
    if (!r) return;
    this.lastNotes = r;
    this.noteHist = null;
    this.notesKey = null;
    this.renderNotes(this.group(), r);
  },

  // ----- satır içi not düzenleyici (GitHub gibi: okuma alanında Yaz / Önizleme) -----

  startEdit(id) {
    if (!this.leaveEdit()) return;
    const n = id ? (this.lastNotes.notes || []).find((x) => x.id === id) : null;
    if (id && !n) return;
    const members = this.group().sessions.filter((s) => !s.removed);
    this.noteEd = {
      id: n ? n.id : null, title: n ? n.title : '', body: n ? notePlain(n.body) : '', expect: n ? n.updatedAt : null,
      tab: 'write', to: new Set(members.map((s) => s.id)), dirty: false, seq: (this.noteEd ? this.noteEd.seq : 0) + 1,
    };
    if (n) this.noteSel = n.id;
    this.noteHist = null;
    this.noteReading = true;
    this.notesKey = null;
    this.renderNotes(this.group(), this.lastNotes);
  },

  // Düzenleyiciden çıkış: kaydedilmemiş değişiklik varsa sorulur.
  leaveEdit() {
    const e = this.noteEd;
    if (e && e.dirty && !confirm('Nottaki kaydedilmemiş değişiklikler kaybolsun mu?')) return false;
    this.noteEd = null;
    return true;
  },

  renderEditor(g, read) {
    const e = this.noteEd;
    const key = `${e.seq}:${e.tab}`;
    // Yazarken liste ya da zaman güncellemesi düzenleyiciyi yeniden kurmasın.
    if (read.dataset.ed === key) return;
    read.dataset.ed = key;
    const n = e.id ? (this.lastNotes.notes || []).find((x) => x.id === e.id) : null;
    const members = g.sessions.filter((s) => !s.removed);
    const marked = n && n.by !== 'user' && noteSegments(n.body).some((s) => s.u);
    read.innerHTML = `
        <div class="ne">
          <div class="ne-top">
            <span class="kc-id">${n ? `#${n.id}` : 'Yeni not'}</span>
            <input id="ne-title" class="ne-title" maxlength="200" value="${esc(e.title)}" placeholder="Başlık (bildirimde görünür)" aria-label="Başlık">
          </div>
          <div class="ne-box">
            <div class="ne-tabs" role="tablist">
              <button role="tab" data-nact="etab" data-tab="write" aria-selected="${e.tab === 'write'}">Yaz</button>
              <button role="tab" data-nact="etab" data-tab="preview" aria-selected="${e.tab === 'preview'}">Önizleme</button>
              <span class="note ne-hint">${n && n.by !== 'user' ? 'Eklediğin ya da değiştirdiğin satırlar kaydedince "sen yazdın" olarak işaretlenir; modeller onlara dokunamaz.' : 'Markdown destekli.'}</span>
            </div>
            ${e.tab === 'write'
            ? `<textarea id="ne-body" class="ne-body mono" placeholder="Karar, bulgu, ortak bilgi…" aria-label="İçerik">${esc(e.body)}</textarea>`
            : `<div class="ne-preview md">${e.body.trim() ? mdLite(e.body) : '<p class="note">Önizlenecek bir şey yok.</p>'}</div>`}
          </div>
          ${marked && e.tab === 'write' ? '<p class="note">Okuma görünümünde "sen yazdın" kutusundaki satırlar senindir; burada işaretsiz görünür.</p>' : ''}
          ${n ? '<p class="note">Kaydedince notun alıcılarına "güncellendi" diye bildirilir.</p>' : `<div class="field"><span class="lbl">Bildirilecek üyeler</span>
            <div class="rchips">${members.map((s) => `<label class="rchip"><input type="checkbox" data-neto="${esc(s.id)}" ${e.to.has(s.id) ? 'checked' : ''}><span class="rdot" style="background: ${roleColor(s)}"></span>${esc(s.roleLabel)} · ${esc(s.accountId)}</label>`).join('')}</div>
            <div class="actions"><button class="btn small ghost" data-nact="eto" data-all="1">Hepsi</button><button class="btn small ghost" data-nact="eto" data-all="0">Hiçbiri</button></div></div>`}
          <div class="ne-foot">
            <button class="btn ghost" data-nact="ecancel">Vazgeç</button>
            <button class="btn primary" data-nact="esave">${n ? 'Değişiklikleri kaydet' : 'Notu ekle'}</button>
          </div>
        </div>`;
    const f = e.tab === 'write' ? $('#ne-body') : null;
    if (!e.focused) { e.focused = true; ($('#ne-title').value ? f || $('#ne-title') : $('#ne-title')).focus(); }
    else if (f) f.focus();
  },

  async saveEdit() {
    const e = this.noteEd;
    if (!e) return;
    if (!e.title.trim()) { toast('Başlık gerekli.', true); return $('#ne-title') && $('#ne-title').focus(); }
    const body = { title: e.title, body: e.body };
    let r;
    if (e.id) r = await act(() => api('PUT', `/api/groups/${this.gid}/notes/${e.id}`, { ...body, expect: e.expect }), 'Not kaydedildi.');
    else {
      body.to = [...e.to];
      r = await act(() => api('POST', `/api/groups/${this.gid}/notes`, body), body.to.length ? 'Not eklendi; üyelere bildirilecek.' : 'Not eklendi.');
    }
    if (!r) return;
    this.lastNotes = r;
    if (!e.id) {
      const mine = r.notes.filter((x) => x.by === 'user');
      if (mine.length) this.noteSel = mine[mine.length - 1].id;
    }
    this.noteEd = null;
    this.notesKey = null;
    this.renderNotes(this.group(), r);
  },

  // ----- proje dokümanları (proje notları) ve hatırlatma -----

  async loadDocs(g, force) {
    if (this.loadingDocs) return;
    if (!force && this.docs && Date.now() - this.docsAt < 60000) return;
    this.loadingDocs = true;
    try {
      this.docs = await api('GET', `/api/projects/${g.projectId}/docs`);
      this.docsErr = null;
    } catch (err) {
      this.docsErr = err.status === 404 ? 'Proje dokümanları için panel sunucusunun yeniden başlatılması gerekiyor.' : err.message;
    } finally {
      this.docsAt = Date.now();
      this.loadingDocs = false;
      this.docKey = null;
      this.renderNotes(this.group(), this.lastNotes);
    }
  },

  async openDoc(rel, line) {
    this.docSel = rel;
    this.docFocus = line || null;
    // Açılan dokümanın klasörleri kapalıysa ağaçta görünür olsun.
    const open = this.docOpenSet();
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join('/'));
    if (!this.docOpen.fresh) this.saveDocOpen();
    this.lineSel = line ? { from: line, to: line } : null;
    if (line) this.srcView = true;
    this.noteReading = true;
    this.docKey = null;
    if (!this.docText[rel]) {
      this.renderNotes(this.group(), this.lastNotes);
      try {
        this.docText[rel] = await api('GET', `/api/projects/${this.group().projectId}/doc?path=${encodeURIComponent(rel)}`);
      } catch (err) {
        this.docText[rel] = { error: err.message };
      }
      this.docKey = null;
    }
    this.renderNotes(this.group(), this.lastNotes);
  },

  async searchDocs(q) {
    q = String(q || '').trim();
    if (q.length < 2) { this.docHits = null; this.docKey = null; return this.renderNotes(this.group(), this.lastNotes); }
    this.docHits = { q, loading: true, hits: [] };
    this.docKey = null;
    this.renderNotes(this.group(), this.lastNotes);
    try {
      const r = await api('GET', `/api/projects/${this.group().projectId}/docs/search?q=${encodeURIComponent(q)}`);
      this.docHits = { q, hits: r.hits };
    } catch (err) {
      this.docHits = { q, hits: [], error: err.message };
    }
    this.docKey = null;
    this.renderNotes(this.group(), this.lastNotes);
  },

  // Satır numaralı kaynak görünümü; numaraya tıklayınca satır, Shift ile aralık seçilir.
  linesHtml(text) {
    const sel = this.lineSel;
    return `<div class="src" role="list">${String(text).split(/\r?\n/).map((l, i) => {
      const n = i + 1;
      const on = sel && n >= sel.from && n <= sel.to;
      return `<div class="sl${on ? ' on' : ''}" data-ln="${n}" role="listitem"><button class="ln" data-nact="ln" data-ln="${n}" aria-label="Satır ${n}">${n}</button><span class="tx">${esc(l) || ' '}</span></div>`;
    }).join('')}</div>`;
  },

  // Seçimi yeniden çizmeden günceller.
  paintLines() {
    const sel = this.lineSel;
    $('#notes-read').querySelectorAll('.sl').forEach((el) => {
      const n = Number(el.dataset.ln);
      el.classList.toggle('on', !!sel && n >= sel.from && n <= sel.to);
    });
    const b = $('#notes-read [data-nact="remind"]');
    if (b) b.textContent = sel ? `Hatırlat (satır ${sel.from}${sel.to > sel.from ? `–${sel.to}` : ''})` : 'Hatırlat';
  },

  // Klasör ağacının açık klasörleri proje başına saklanır; ilk açılışta yalnız üst klasörler açık.
  docOpenSet() {
    const pid = this.group().projectId;
    if (this.docOpen && this.docOpen.pid === pid) return this.docOpen.set;
    let list = null;
    try { list = JSON.parse(store(`${DOCOPEN_KEY}-${pid}`)); } catch {}
    const fresh = !Array.isArray(list);
    this.docOpen = { pid, set: new Set(fresh ? [] : list), fresh };
    return this.docOpen.set;
  },
  saveDocOpen() {
    if (!this.docOpen) return;
    this.docOpen.fresh = false;
    store(`${DOCOPEN_KEY}-${this.docOpen.pid}`, JSON.stringify([...this.docOpen.set]));
  },
  // Aç/kapa yeniden çizim yapmadan anında: yalnız alt içeriğin görünürlüğü değişir.
  toggleDocDir(b) {
    const open = this.docOpenSet();
    const dir = b.dataset.dir;
    const was = b.getAttribute('aria-expanded') === 'true';
    if (was) open.delete(dir); else open.add(dir);
    b.setAttribute('aria-expanded', String(!was));
    const kids = b.nextElementSibling;
    if (kids && kids.classList.contains('ds-kids')) kids.hidden = was;
    this.saveDocOpen();
  },
  docTree(files, open, all) {
    const root = { dirs: new Map(), files: [], n: 0 };
    for (const f of files) {
      let node = root;
      node.n++;
      for (const p of f.path.split('/').slice(0, -1)) {
        if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [], n: 0 });
        node = node.dirs.get(p);
        node.n++;
      }
      node.files.push(f);
    }
    const cmp = (a, b) => a.localeCompare(b, 'tr', { sensitivity: 'base', numeric: true });
    const walk = (node, base) => {
      const dirs = [...node.dirs].sort((a, b) => cmp(a[0], b[0])).map(([name, sub]) => {
        let label = name;
        let path = base ? `${base}/${name}` : name;
        // Tek alt klasörden ibaret zincirler tek satırda gösterilir (a/b/c).
        while (!sub.files.length && sub.dirs.size === 1) {
          const [[n2, s2]] = sub.dirs;
          label += `/${n2}`;
          path += `/${n2}`;
          sub = s2;
        }
        if (!base && this.docOpen && this.docOpen.fresh) open.add(path);
        const isOpen = all || open.has(path);
        return `<button class="ds-fold" data-nact="dfold" data-dir="${esc(path)}" aria-expanded="${isOpen}">${ICON_CHEV}<span class="ds-fname">${esc(label)}</span><span class="ds-fcount">${sub.n}</span></button>
            <div class="ds-kids"${isOpen ? '' : ' hidden'}>${walk(sub, path)}</div>`;
      }).join('');
      return dirs + node.files.map((f) => `<button class="ds-item" data-nact="dsel" data-path="${esc(f.path)}" aria-current="${f.path === this.docSel}">
            <span class="ns-name">${esc(f.path.split('/').pop())}</span>${f.title ? `<span class="ns-prev">${esc(f.title)}</span>` : ''}</button>`).join('');
    };
    return walk(root, '');
  },
  renderDocs(g) {
    const listEl = $('#docs-list');
    const read = $('#notes-read');
    const d = this.docs;
    const nq = (this.docQuery || '').trim().toLocaleLowerCase('tr');
    const doc = this.docSel && this.docText[this.docSel];
    const key = JSON.stringify([d && d.files.length, d && d.refs, nq, this.docHits, this.docSel, !!doc, this.srcView, this.noteReading, this.docsErr]);
    if (key === this.docKey) return;
    this.docKey = key;
    $('#docs-count').textContent = d ? String(d.files.length) : '';
    const scroll = listEl.scrollTop;
    if (this.docsErr) listEl.innerHTML = `<div class="ns-empty">${esc(this.docsErr)}</div>`;
    else if (!d) listEl.innerHTML = '<div class="ns-empty">Yükleniyor…</div>';
    else if (!d.refs.length) listEl.innerHTML = '<div class="ns-empty">Bu projede doküman kaynağı yok. "Kaynaklar" ile proje içindeki bir klasörü (ör. Dokumanlar) ekle.</div>';
    else if (this.docHits) {
      const h = this.docHits;
      const groups = new Map();
      for (const x of h.hits) groups.set(x.path, (groups.get(x.path) || []).concat(x));
      listEl.innerHTML = `<div class="ds-info">${h.loading ? 'Aranıyor…' : h.error ? esc(h.error) : `"${esc(h.q)}" · ${h.hits.length} sonuç`}<button class="linkish" data-nact="dclear">aramayı kapat</button></div>`
        + [...groups].map(([p, hits]) => `
            <div class="ds-hitfile">${esc(p.split('/').pop())}<span class="ds-dir">${esc(p.split('/').slice(0, -1).join('/'))}</span></div>
            ${hits.map((x) => `<button class="ds-hit" data-nact="dhit" data-path="${esc(x.path)}" data-ln="${x.line}"><span class="kc-id">${x.line}</span>${esc(x.text)}</button>`).join('')}`).join('');
    } else {
      const files = d.files.filter((f) => !nq || `${f.path}\n${f.title}`.toLocaleLowerCase('tr').includes(nq));
      // Ada göre süzerken eşleşmeler kapalı klasörde saklanmasın diye ağaç tümüyle açık çizilir.
      listEl.innerHTML = files.length ? this.docTree(files, this.docOpenSet(), !!nq) + (d.truncated ? '<div class="ns-empty">Liste ilk 3000 dosyada kesildi.</div>' : '')
        : '<div class="ns-empty">Ada uyan doküman yok. İçerikte aramak için Enter\'a bas.</div>';
    }
    listEl.scrollTop = scroll;

    if (!this.docSel) {
      read.innerHTML = `<div class="nr-empty">
          <div class="nr-empty-title">Proje dokümanları</div>
          <p class="note">Proje klasöründeki kendi dokümanların (ör. <span class="mono">Dokumanlar/</span>) burada proje notu olarak görünür. Üyeler bu klasörleri bilir ve <span class="mono">dokuman_listele</span> ile arar. Bir dokümanı ya da seçtiğin satırları istediğin üyelere hatırlatabilirsin.</p>
          <button class="btn" data-nact="refs">Kaynakları düzenle</button></div>`;
      return;
    }
    const parts = this.docSel.split('/');
    const isMd = /\.(md|markdown)$/i.test(this.docSel);
    let body;
    if (!doc) body = '<p class="note">Yükleniyor…</p>';
    else if (doc.error) body = `<p class="note">${esc(doc.error)}</p>`;
    else body = this.srcView || !isMd ? this.linesHtml(doc.text) : `<div class="md">${mdLite(doc.text)}</div>`;
    const sel = this.lineSel;
    read.innerHTML = `
        <div class="nr-head">
          <button class="btn small ghost nr-back" data-nact="back">← Liste</button>
          <div class="nr-titlebox">
            <div class="nr-kicker"><span class="badge">proje notu</span><span class="mono note">${esc(parts.slice(0, -1).join('/'))}</span>
              ${doc && !doc.error ? `<span class="note">${esc(fmtDate(doc.mtime))} · ${Math.max(1, Math.round(doc.size / 1024))} KB</span>` : ''}</div>
            <h2 class="nr-title">${esc(parts[parts.length - 1])}</h2>
          </div>
          <div class="nr-actions">
            ${isMd ? `<div class="seg" role="group" aria-label="Görünüm"><button data-nact="src" data-src="0" aria-pressed="${!this.srcView}">Görünüm</button><button data-nact="src" data-src="1" aria-pressed="${!!this.srcView}">Satırlar</button></div>` : ''}
            <button class="btn small primary" data-nact="remind" data-kind="doc">${sel ? `Hatırlat (satır ${sel.from}${sel.to > sel.from ? `–${sel.to}` : ''})` : 'Hatırlat'}</button>
          </div>
        </div>
        <div class="nr-body${this.srcView || !isMd ? ' nr-src' : ''}">${body}</div>
        <div class="nr-foot"><span class="note">${this.srcView || !isMd ? 'Satır numarasına tıkla, Shift ile aralık seç; ya da metni fareyle seçip Hatırlat\'a bas.' : 'Metni fareyle seçip Hatırlat\'a basarsan yalnızca seçili kısım gider. Satır seçmek için "Satırlar" görünümüne geç.'}</span></div>`;
    if (this.docFocus) {
      const el = read.querySelector(`.sl[data-ln="${this.docFocus}"]`);
      if (el) el.scrollIntoView({ block: 'center' });
      this.docFocus = null;
    }
  },

  openRefs() {
    const g = this.group();
    const p = project(g.projectId);
    const dlg = $('#refs-dlg');
    dlg.innerHTML = `
        <div class="dlg-head"><div><h2 id="refs-title">Proje dokümanı kaynakları</h2>
          <div class="note">${esc(p ? p.path : '')} altındaki klasör ya da dosyalar; her satıra bir tane. Panel bu dosyaları yalnızca okur.</div></div>
          <button class="btn icon" data-rdlg="cancel" aria-label="Kapat">✕</button></div>
        <div class="dlg-body">
          <div class="field"><label for="rf-list">Kaynaklar</label>
            <textarea id="rf-list" class="mono" rows="6" placeholder="Dokumanlar&#10;_docs&#10;CLAUDE.md">${esc(((this.docs && this.docs.refs) || []).join('\n'))}</textarea>
            <span class="note">Göreli yol proje köküne göredir. Metin dosyaları (md, txt, mmd, json, yaml, csv…) listelenir; node_modules ve .git atlanır. Değişiklik yeni açılan ya da yeniden başlatılan üyelerin talimatına girer.</span></div>
        </div>
        <div class="dlg-foot"><button class="btn ghost" data-rdlg="cancel">Vazgeç</button><button class="btn primary" data-rdlg="save">Kaydet</button></div>`;
    if (!dlg.open) dlg.showModal();
    $('#rf-list').focus();
  },

  async saveRefs() {
    const refs = $('#rf-list').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const r = await act(() => api('PUT', `/api/projects/${this.group().projectId}/doc-refs`, { refs }), 'Kaynaklar kaydedildi.');
    if (!r) return;
    $('#refs-dlg').close();
    this.docs = r;
    this.docsAt = Date.now();
    this.docText = {};
    this.docHits = null;
    this.docKey = null;
    this.renderNotes(this.group(), this.lastNotes);
  },

  // Hatırlatma: seçili not ya da doküman; tamamı, seçili satırlar ya da fareyle seçilen metin.
  openRemind(kind) {
    const g = this.group();
    const read = $('#notes-read');
    const s = window.getSelection();
    const picked = s && !s.isCollapsed && read.contains(s.anchorNode) ? s.toString().trim() : '';
    let label, text;
    if (kind === 'doc') {
      const d = this.docText[this.docSel];
      if (!d || d.error) return;
      label = this.docSel;
      text = d.text;
    } else {
      const n = (this.lastNotes.notes || []).find((x) => x.id === this.noteSel);
      if (!n) return;
      label = `grup notu #${n.id} "${n.title}"`;
      text = n.body || '';
    }
    const sel = this.lineSel;
    this.remind = { kind, label, text, picked, sel };
    const lines = text.split(/\r?\n/);
    const long = kind === 'doc' && text.length > 6000;
    const mode = picked ? 'text' : sel ? 'lines' : 'all';
    const members = g.sessions.filter((x) => !x.removed);
    const dlg = $('#remind-dlg');
    dlg.innerHTML = `
        <div class="dlg-head"><div><h2 id="remind-title">Hatırlat</h2><div class="note mono">${esc(label)}</div></div>
          <button class="btn icon" data-mdlg="cancel" aria-label="Kapat">✕</button></div>
        <div class="dlg-body">
          <div class="field"><span class="lbl">Ne gönderilsin</span>
            <div class="rm-modes">
              <label class="check"><input type="radio" name="rm-mode" value="all" ${mode === 'all' ? 'checked' : ''}>Tamamı${long ? ' (uzun: dosya yolu ve başlıklar gider, üye kendisi okur)' : ''}</label>
              <label class="check"><input type="radio" name="rm-mode" value="lines" ${mode === 'lines' ? 'checked' : ''}>Satırlar
                <input type="number" id="rm-from" min="1" max="${lines.length}" value="${sel ? sel.from : 1}" aria-label="İlk satır"> –
                <input type="number" id="rm-to" min="1" max="${lines.length}" value="${sel ? sel.to : Math.min(lines.length, 20)}" aria-label="Son satır"></label>
              <label class="check" ${picked ? '' : 'title="Önce okuma alanında metin seç"'}><input type="radio" name="rm-mode" value="text" ${mode === 'text' ? 'checked' : ''} ${picked ? '' : 'disabled'}>Seçili metin${picked ? ` (${picked.length} karakter)` : ''}</label>
            </div></div>
          <div class="field"><span class="lbl">Kime</span>
            <div class="rchips">${members.map((x) => `<label class="rchip"><input type="checkbox" data-rmto="${esc(x.id)}"><span class="rdot" style="background: ${roleColor(x)}"></span>${esc(x.roleLabel)} · ${esc(x.accountId)}</label>`).join('')}</div></div>
          <div class="field"><label for="rm-note">Not (isteğe bağlı)</label><textarea id="rm-note" rows="2" placeholder="ör. Bu kurala göre devam et"></textarea></div>
          <div class="field"><span class="lbl">Önizleme</span><pre class="rm-prev mono" id="rm-prev"></pre></div>
        </div>
        <div class="dlg-foot"><button class="btn ghost" data-mdlg="cancel">Vazgeç</button><button class="btn primary" data-mdlg="send">Gönder</button></div>`;
    this.remindPreview();
    if (!dlg.open) dlg.showModal();
  },

  remindPreview() {
    const r = this.remind;
    const mode = ($('#remind-dlg input[name="rm-mode"]:checked') || {}).value || 'all';
    const lines = r.text.split(/\r?\n/);
    let t;
    if (mode === 'text') t = r.picked;
    else if (mode === 'lines') {
      const a = Math.max(1, Number($('#rm-from').value) || 1);
      const b = Math.max(a, Number($('#rm-to').value) || a);
      t = lines.slice(a - 1, b).join('\n');
    } else t = r.kind === 'doc' && r.text.length > 6000 ? '(Uzun doküman: üyeye dosyanın yolu ve başlık listesi gider, tamamını kendisi okur.)' : r.text;
    $('#rm-prev').textContent = t.length > 1200 ? `${t.slice(0, 1200)}\n…` : t || '(boş)';
  },

  async sendRemind() {
    const r = this.remind;
    const dlg = $('#remind-dlg');
    const to = [...dlg.querySelectorAll('[data-rmto]')].filter((x) => x.checked).map((x) => x.dataset.rmto);
    if (!to.length) return toast('En az bir üye seç.', true);
    const mode = dlg.querySelector('input[name="rm-mode"]:checked').value;
    const body = {
      to, mode, note: $('#rm-note').value,
      source: r.kind === 'doc' ? { type: 'doc', path: this.docSel } : { type: 'note', id: this.noteSel },
    };
    if (mode === 'lines') { body.from = Number($('#rm-from').value); body.to_line = Number($('#rm-to').value); }
    if (mode === 'text') body.text = r.picked;
    const res = await act(() => api('POST', `/api/groups/${this.gid}/remind`, body));
    if (!res) return;
    dlg.close();
    toast(`${res.to} üyeye hatırlatma gönderildi; boştaysa hemen, çalışıyorsa işini bitirince iletilir.`);
  },

  async deleteNote(id) {
    const n = (this.lastNotes.notes || []).find((x) => x.id === id);
    if (!n || !confirm(`#${n.id} "${n.title}" notu silinsin mi? Henüz iletilmemiş bildirimleri de iptal edilir.`)) return;
    const r = await act(() => api('DELETE', `/api/groups/${this.gid}/notes/${id}`), 'Not silindi.');
    if (!r) return;
    this.lastNotes = r;
    this.noteSel = null;
    this.noteReading = false;
    this.notesKey = null;
    this.renderNotes(this.group(), r);
  },

  initBoard() {
    const act$ = $('#activity');
    act$.addEventListener('click', (e) => {
      const nb = e.target.closest('[data-bnew]');
      if (nb) return this.openCard(null, nb.dataset.bnew);
      const c = e.target.closest('[data-bcard]');
      if (c) this.openCard(Number(c.dataset.bcard));
    });
    act$.addEventListener('keydown', (e) => {
      const c = e.target.closest('[data-bcard]');
      if (c && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.openCard(Number(c.dataset.bcard));
      }
    });
    act$.addEventListener('dragstart', (e) => {
      const c = e.target.closest('[data-bcard]');
      if (!c) return;
      this.dragCard = Number(c.dataset.bcard);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', c.dataset.bcard);
      c.classList.add('drag');
    });
    act$.addEventListener('dragend', () => {
      this.dragCard = null;
      act$.querySelectorAll('.kcard.drag, .kcol.over').forEach((x) => x.classList.remove('drag', 'over'));
    });
    act$.addEventListener('dragover', (e) => {
      const col = e.target.closest('[data-col]');
      if (!col || this.dragCard == null) return;
      e.preventDefault();
      act$.querySelectorAll('.kcol.over').forEach((x) => x !== col && x.classList.remove('over'));
      col.classList.add('over');
    });
    act$.addEventListener('drop', (e) => {
      const col = e.target.closest('[data-col]');
      if (!col || this.dragCard == null) return;
      e.preventDefault();
      const card = this.lastBoard && this.lastBoard.cards.find((x) => x.id === this.dragCard);
      this.dragCard = null;
      col.classList.remove('over');
      if (card && card.status !== col.dataset.col) this.saveCard(card.id, { status: col.dataset.col, version: card.version });
    });
    const dlg = $('#card-dlg');
    dlg.addEventListener('click', (e) => this.onCardClick(e));
    dlg.addEventListener('close', () => { this.boardKey = null; });
  },

  async refreshBoard(g) {
    if (this.loadingBoard) return;
    this.loadingBoard = true;
    try {
      this.lastBoard = await api('GET', `/api/groups/${g.id}/board`);
      this.renderBoard(g, this.lastBoard);
    } catch (err) {
      $('#activity').innerHTML = `<div class="empty">Pano alınamadı: ${esc(err.message)}</div>`;
    } finally {
      this.loadingBoard = false;
    }
  },

  renderBoard(g, b) {
    const box = $('#activity');
    // Sürükleme sürerken ya da kart penceresi açıkken iki saniyelik yenileme panoyu yeniden çizmesin.
    if (this.dragCard != null || $('#card-dlg').open) return;
    const members = g.sessions.filter((s) => !s.removed);
    const key = JSON.stringify([b.cards, members.map((s) => [s.id, statusKey(s)])]);
    if (key === this.boardKey && $('#kanban')) return;
    this.boardKey = key;
    const name = (sid) => {
      const s = g.sessions.find((x) => x.id === sid);
      return s ? `${s.roleLabel} · ${s.accountId}` : '?';
    };
    const who = (by) => (by === 'user' ? 'sen' : name(by));
    const cardHtml = (c) => {
      const pend = Object.keys(c.pending || {});
      const a = c.assignee && g.sessions.find((x) => x.id === c.assignee);
      // Atanan üyenin bekleyen iletimi yoksa ve ya iletim almış ya da son değişikliği kendisi yapmışsa güncel bilgidedir.
      const delivered = c.assignee && !pend.includes(c.assignee) && ((c.delivered || {})[c.assignee] != null || c.updatedBy === c.assignee);
      const deliv = pend.length
        ? `<span class="kc-deliv wait" title="Panel bu değişikliği ilgili üyelere iletecek: çalışıyorsa işini bitirdiği anda, boştaysa terminaline yazarak">⏳ iletilecek: ${esc(pend.map(name).join(', '))}</span>`
        : delivered ? '<span class="kc-deliv ok" title="Son değişiklik atanan üyeye iletildi">✓ iletildi</span>' : '';
      const last = c.notes.length ? c.notes[c.notes.length - 1] : null;
      return `
          <article class="kcard" draggable="true" tabindex="0" data-bcard="${c.id}" aria-label="Kart ${c.id}: ${esc(c.title)}">
            <div class="kc-top"><span class="kc-id">#${c.id}</span><span class="kc-title">${esc(c.title)}</span></div>
            ${c.desc ? `<div class="kc-desc">${esc(c.desc)}</div>` : ''}
            ${last ? `<div class="kc-note" title="${esc(last.text)}"><b>${esc(who(last.by))}:</b> ${esc(last.text)}</div>` : ''}
            <div class="kc-meta">
              ${a ? `<span class="kc-who"><span class="dot ${statusKey(a)}"></span>${esc(a.roleLabel)}</span>` : '<span class="kc-who none">atanmadı</span>'}
              ${deliv}
              <span class="grow"></span>
              ${c.notes.length ? `<span class="note" title="Not sayısı">💬 ${c.notes.length}</span>` : ''}
              <span class="note" title="Son değiştiren: ${esc(who(c.updatedBy))}">${esc(timeAgo(c.updatedAt))}</span>
            </div>
          </article>`;
    };
    const cols = BOARD_COLS.map(([k, label]) => {
      const list = b.cards.filter((c) => c.status === k).sort((x, y) => y.updatedAt - x.updatedAt);
      return `
          <section class="kcol" data-col="${k}" aria-label="${esc(label)}">
            <header><span class="kcol-dot ${k}"></span><b>${esc(label)}</b><span class="note">${list.length}</span><span class="grow"></span>
              <button class="btn icon small ghost" data-bnew="${k}" aria-label="${esc(label)} sütununa kart ekle" title="Kart ekle">${ICON_PLUS}</button></header>
            <div class="kcards">${list.map(cardHtml).join('') || '<div class="kc-empty">Kart yok</div>'}</div>
          </section>`;
    }).join('');
    box.innerHTML = `
        <div class="board">
          <div class="board-tools">
            <button class="btn small" data-bnew="todo" style="color: var(--accent)">${ICON_PLUS} Kart ekle</button>
            <span class="note">Kartı sürükleyerek durumunu değiştir. Seni ilgilendiren değişiklikler ekip üyelerine kendiliğinden iletilir; üyeler de panoyu kendi araçlarıyla günceller.</span>
          </div>
          <div class="kanban" id="kanban">${cols}</div>
        </div>`;
  },

  openCard(id, status) {
    const g = this.group();
    const card = id != null && this.lastBoard ? this.lastBoard.cards.find((c) => c.id === id) : null;
    if (id != null && !card) return;
    this.cardEdit = card ? { id: card.id, version: card.version } : { id: null };
    const members = g.sessions.filter((s) => !s.removed);
    const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
    const cur = card || { title: '', desc: '', status: status || 'todo', assignee: null, notes: [] };
    const who = (by) => {
      if (by === 'user') return 'sen';
      const s = g.sessions.find((x) => x.id === by);
      return s ? s.roleLabel : '?';
    };
    $('#card-dlg').innerHTML = `
        <div class="dlg-head">
          <div><h2 id="card-title">${card ? `Kart #${card.id}` : 'Yeni kart'}</h2>
            <div class="note">${card ? `sürüm ${card.version} · son değiştiren ${esc(who(card.updatedBy))} · ${esc(timeAgo(card.updatedAt))}` : 'Atadığın üyeye panel kendiliğinden iletir'}</div></div>
          <button class="btn icon" data-cact="cancel" aria-label="Kapat">✕</button>
        </div>
        <div class="dlg-body">
          <div class="field"><label for="cd-title">Başlık</label><input id="cd-title" maxlength="200" value="${esc(cur.title)}" placeholder="Tek cümlelik görev özeti"></div>
          <div class="field"><label for="cd-desc">Açıklama</label><textarea id="cd-desc" rows="5" placeholder="Ne yapılacak, kabul kriteri, dokunulacak dosyalar">${esc(cur.desc)}</textarea></div>
          <div class="row-fields">
            <div class="field"><label for="cd-status">Durum</label><select id="cd-status">${BOARD_COLS.map(([k, l]) => opt(k, l, cur.status)).join('')}</select></div>
            <div class="field"><label for="cd-who">Atanan</label><select id="cd-who">${opt('', 'Atanmadı', cur.assignee || '')}${members.map((m) => opt(m.id, `${m.roleLabel} · ${m.accountId}`, cur.assignee || '')).join('')}</select></div>
          </div>
          ${card && card.notes.length ? `<div class="field"><span class="lbl">Notlar</span><div class="kc-notes">${card.notes.slice().reverse().map((n) => `
            <div class="kc-n"><span class="note">${esc(new Date(n.ts).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))} · ${esc(who(n.by))}</span><div>${esc(n.text)}</div></div>`).join('')}</div></div>` : ''}
          <div class="field"><label for="cd-note">${card ? 'Not ekle' : 'Not (isteğe bağlı)'}</label><textarea id="cd-note" rows="2" placeholder="Atanan üyeye iletilecek not"></textarea></div>
        </div>
        <div class="dlg-foot">
          ${card ? '<button class="btn ghost" data-cact="delete" style="color: var(--danger); margin-right: auto">Sil</button>' : ''}
          <button class="btn ghost" data-cact="cancel">Vazgeç</button>
          <button class="btn primary" data-cact="save">${card ? 'Kaydet' : 'Ekle'}</button>
        </div>`;
    const dlg = $('#card-dlg');
    if (!dlg.open) dlg.showModal();
    $('#cd-title').focus();
  },

  async onCardClick(e) {
    const b = e.target.closest('[data-cact]');
    if (!b) return;
    const dlg = $('#card-dlg');
    const ed = this.cardEdit;
    if (b.dataset.cact === 'cancel') return dlg.close();
    if (b.dataset.cact === 'delete') {
      if (!confirm(`Kart #${ed.id} silinsin mi? Atanan üye bitmemiş bir kartsa silindiği kendisine bildirilir.`)) return;
      const r = await act(() => api('DELETE', `/api/groups/${this.gid}/board/${ed.id}`));
      if (r) {
        dlg.close();
        this.refreshBoard(this.group());
      }
      return;
    }
    const body = {
      title: $('#cd-title').value,
      desc: $('#cd-desc').value,
      status: $('#cd-status').value,
      assignee: $('#cd-who').value,
      note: $('#cd-note').value,
    };
    if (!body.title.trim()) return toast('Kart başlığı yaz.', true);
    b.disabled = true;
    let ok;
    if (ed.id == null) {
      ok = await act(() => api('POST', `/api/groups/${this.gid}/board`, body));
      // Yeni kartta not, açıklamanın sonuna eklenmek yerine ayrı bir not olarak kaydedilir.
      if (ok && body.note.trim()) await act(() => api('PUT', `/api/groups/${this.gid}/board/${ok.id}`, { note: body.note, version: ok.version }));
    } else {
      ok = await this.saveCard(ed.id, { ...body, version: ed.version }, true);
    }
    b.disabled = false;
    if (ok) {
      dlg.close();
      this.refreshBoard(this.group());
    }
  },

  // Kart bu arada bir üye tarafından değiştirildiyse sunucu 409 döner; güncel hâli gösterilir.
  async saveCard(id, body, fromDialog) {
    try {
      const r = await api('PUT', `/api/groups/${this.gid}/board/${id}`, body);
      if (!fromDialog) this.refreshBoard(this.group());
      return r;
    } catch (err) {
      if (err.status === 409) {
        toast('Kart bu arada değişti; güncel hâli yüklendi. Değişikliğini yeniden yap.', true);
        this.boardKey = null;
        await this.refreshBoard(this.group());
        if (fromDialog) this.openCard(id);
      } else toast(err.message, true);
      return null;
    }
  },

  members() {
    const g = this.group();
    return g ? g.sessions.filter((s) => !s.removed) : [];
  },

  openAdd() {
    const roles = state.settings.roles;
    const first = roles.find((r) => r.id === 'arastirma') || roles[0];
    const lead = this.members().find((m) => m.roleId === 'sef');
    this.addForm = {
      roleId: first.id,
      customLabel: '',
      customPrompt: '',
      accountId: state.settings.accounts[0].id,
      model: roleDefaultModel(first.id),
      permissionMode: roleDefaultMode(first.id),
      talkAll: false,
      reportsTo: lead ? [lead.id] : [],
      firstTask: '',
      introduce: true,
    };
    // Kota en çok kalan hesap önceden seçilir.
    const pickBest = () => {
      const ranked = state.settings.accounts.map((a) => [a.id, quotaLeftOf(a.id)]).filter(([, v]) => v != null).sort((x, y) => y[1] - x[1]);
      if (!this.addForm.accTouched && ranked.length && ranked[0][1] > 0) this.addForm.accountId = ranked[0][0];
    };
    pickBest();
    this.renderAdd();
    $('#add-dlg').showModal();
    getQuota().then(() => {
      if (!$('#add-dlg').open) return;
      pickBest();
      this.renderAdd();
    }).catch(() => {});
  },

  onAddInput(e, structural) {
    const el = e.target;
    const f = el.dataset.af;
    if (!f) return;
    const form = this.addForm;
    if (f === 'reportsTo') {
      form.reportsTo = el.checked ? [...new Set([...form.reportsTo, el.value])] : form.reportsTo.filter((x) => x !== el.value);
      return;
    }
    form[f] = el.type === 'checkbox' ? el.checked : el.value;
    if (f === 'accountId') form.accTouched = true;
    if (f === 'roleId') {
      form.model = roleDefaultModel(el.value);
      form.permissionMode = roleDefaultMode(el.value);
    }
    if (structural && f === 'roleId') this.renderAdd();
  },

  async onAddClick(e) {
    const b = e.target.closest('[data-aact]');
    if (!b) return;
    if (b.dataset.aact === 'cancel') {
      $('#add-dlg').close();
      return;
    }
    const f = this.addForm;
    if (f.roleId === 'custom' && !f.customLabel.trim()) return toast('Anlık rol için rol adı yaz.', true);
    b.disabled = true;
    const s = await act(() => api('POST', `/api/groups/${this.gid}/sessions`, {
      row: {
        roleId: f.roleId, customLabel: f.customLabel, customPrompt: f.customPrompt, accountId: f.accountId,
        model: f.model, permissionMode: f.permissionMode, talkAll: f.talkAll, reportsTo: f.reportsTo,
      },
      firstTask: f.firstTask,
      introduce: f.introduce,
    }));
    b.disabled = false;
    if (!s) return;
    $('#add-dlg').close();
    toast(`${s.name} açılıyor…`);
    await refresh().catch(() => {});
    this.select(s.id);
  },

  renderAdd() {
    const f = this.addForm;
    const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
    const g = this.group();
    const members = this.members();
    $('#add-dlg').innerHTML = `
        <div class="dlg-head">
          <div><h2 id="add-title">Gruba üye ekle</h2><div class="note">${esc(g ? g.name : '')} — çalışan oturumlar etkilenmez</div></div>
          <button class="btn icon" data-aact="cancel" aria-label="Kapat">✕</button>
        </div>
        <div class="dlg-body">
          <div class="row-fields">
            <div class="field"><label for="ad-role">Rol</label>
              <select id="ad-role" data-af="roleId">${state.settings.roles.map((r) => opt(r.id, r.label, f.roleId)).join('')}${opt('custom', 'Anlık rol…', f.roleId)}</select></div>
            <div class="field"><label for="ad-acc">Hesap</label>
              <select id="ad-acc" data-af="accountId">${state.settings.accounts.map((a) => opt(a.id, accountOptionLabel(a), f.accountId)).join('')}</select></div>
            <div class="field"><label for="ad-model">Model</label>
              <select id="ad-model" data-af="model">${MODELS.map(([v, l]) => opt(v, l, f.model)).join('')}</select></div>
            <div class="field"><label for="ad-perm">İzin modu</label>
              <select id="ad-perm" data-af="permissionMode">${opt('', `Grup: ${permLabel(g ? g.permissionMode : 'manual')}`, f.permissionMode)}${PERMISSION_LABELS.map(([v, l]) => opt(v, l, f.permissionMode)).join('')}</select></div>
          </div>
          ${f.roleId === 'custom' ? `
            <div class="field"><label for="ad-cl">Rol adı</label><input id="ad-cl" data-af="customLabel" value="${esc(f.customLabel)}" maxlength="40" placeholder="performans analisti"></div>
            <div class="field"><label for="ad-cp">Rol talimatı</label><textarea id="ad-cp" data-af="customPrompt" rows="3">${esc(f.customPrompt)}</textarea></div>` : ''}
          <div class="links">
            <label class="check"><input type="checkbox" data-af="talkAll" ${f.talkAll ? 'checked' : ''}>herkesle konuşur</label>
            ${members.length ? '<span>Rapor verir →</span>' : ''}
            ${members.map((m) => `<label class="check"><input type="checkbox" data-af="reportsTo" value="${esc(m.id)}" ${f.reportsTo.includes(m.id) ? 'checked' : ''}>${esc(m.roleLabel)} · ${esc(m.accountId)}</label>`).join('')}
          </div>
          <div class="field"><label for="ad-task">İlk görev (isteğe bağlı)</label>
            <textarea id="ad-task" data-af="firstTask" rows="3" placeholder="Yeni üyenin hemen başlayacağı iş">${esc(f.firstTask)}</textarea></div>
          <label class="check" style="align-self: flex-start"><input type="checkbox" data-af="introduce" ${f.introduce ? 'checked' : ''}>Açılınca kendini şefe ve rapor verdiği üyelere tanıtsın</label>
          <p class="note">Mevcut üyelerin talimatı açılışta kaydedildiği için yeni üyeyi kendiliğinden bilmezler; tanıtım mesajı bu yüzden önemli.</p>
        </div>
        <div class="dlg-foot">
          <button class="btn ghost" data-aact="cancel">Vazgeç</button>
          <button class="btn primary" data-aact="start">Başlat</button>
        </div>`;
  },

  poll() {
    if (!$('#tabs')) return;
    const g = this.group();
    if (!g) {
      app.innerHTML = '<div class="page"><div class="empty">Grup bulunamadı.</div></div>';
      return;
    }
    const p = project(g.projectId);
    crumbs([{ label: 'Projeler', href: '#/' }, { label: p ? p.name : '?', href: `#/p/${g.projectId}` }, { label: g.name }]);
    // Orkestra şefi çalışma alanını yönettiği için sekmelerde ve panellerde her zaman en solda ve ayrı renkte durur.
    // Kapatılan üyeler sekmede ve panelde görünmez, "Kapalı (N)" düğmesinde durur.
    const closed = this.closedOf(g);
    const members = g.sessions.filter((s) => !s.removed && !closed.includes(s)).sort((a, b) => (b.roleId === 'sef') - (a.roleId === 'sef'));
    if (!this.selected || !members.some((s) => s.id === this.selected)) {
      const first = members.find((s) => s.roleId === 'sef' && s.running) || members.find((s) => s.running) || members[0];
      this.selected = first && first.id;
    }
    // Gruptan çıkarılan ya da kapatılan üyenin paneli kaldırılır.
    for (const [sid, pane] of this.panes) {
      if (members.some((s) => s.id === sid)) continue;
      if (pane.term) pane.term.dispose();
      pane.el.remove();
      this.panes.delete(sid);
    }

    // Sekmeler yalnızca değişince yeniden çizilir; yoksa çalışan sekmenin dönen kenar efekti her yenilemede baştan başlar.
    const tabsKey = JSON.stringify([members.map((s) => [s.id, statusKey(s), s.waitKind, s.roleLabel, s.accountId, s.name]), this.selected, this.menuSid]);
    if (tabsKey !== this.tabsKey) {
      this.tabsKey = tabsKey;
      // Klavye odağı bir sekme düğmesindeyse yeniden çizimden sonra aynı düğmeye geri verilir.
      const fa = document.activeElement;
      const keep = fa && $('#tabs').contains(fa) ? (fa.dataset.menu ? `[data-menu="${CSS.escape(fa.dataset.menu)}"]` : `[data-sid="${CSS.escape(fa.dataset.sid || '')}"]`) : null;
      // "Üye ekle" düğmesi son sekmenin yanında kalsın diye çizimden sonra aynı düğme (dinleyicisiyle) yeniden eklenir.
      const addBtn = $('#add-member');
      $('#tabs').innerHTML = members.map((s) => `
          <div class="tab" data-tid="${esc(s.id)}" draggable="${s.roleId === 'sef' ? 'false' : 'true'}" data-on="${s.id === this.selected}" data-st="${statusKey(s)}"${s.roleId === 'sef' ? ' data-lead="true" title="Orkestra şefi: ekibi yönetir"' : ''}>
            <button class="tab-main" role="tab" data-sid="${esc(s.id)}" aria-selected="${s.id === this.selected}" aria-label="${esc(s.roleLabel)}">
              <span class="dot ${statusKey(s)}"></span>${s.roleId === 'sef' ? `<span class="lead-mark" aria-hidden="true">${ICON_CROWN}</span>` : ''}<span class="tab-av" style="color: ${roleColor(s)}" aria-hidden="true">${roleIcon(s)}</span><span class="tab-name">${esc(s.roleLabel)}</span>
              ${s.status === 'waiting' && s.running ? `<span class="badge waiting">${s.waitKind === 'question' ? 'soru' : 'onay'}</span>` : ''}
            </button>
            <button class="tab-more" data-menu="${esc(s.id)}" aria-haspopup="dialog" aria-expanded="${this.menuSid === s.id}" aria-label="${esc(s.roleLabel)} · ayrıntılar ve işlemler" title="Ayrıntılar ve işlemler">⋯</button>
          </div>`).join('');
      $('#tabs').appendChild(addBtn);
      if (keep) { const k = $('#tabs').querySelector(keep); if (k) k.focus(); }
    }
    // Üzerine gelince görünen "ne yapıyor" satırı sık değişir; sekmeyi yeniden çizmeden güncellenir.
    for (const s of members) {
      const b = $('#tabs').querySelector(`[data-sid="${CSS.escape(s.id)}"]`);
      if (b) b.querySelector('.tab-name').textContent = s.roleLabel;
    }
    this.renderClosed(closed);
    this.renderRequests(g);
    if (this.menuSid) {
      this.renderMenu();
      if (!$('#sess-menu').hidden) this.placeMenu();
    }

    const terms = $('#terms');
    for (const s of members) {
      let pane = this.panes.get(s.id);
      if (!pane) {
        const el = document.createElement('section');
        el.className = s.roleId === 'sef' ? 'pane lead' : 'pane';
        el.dataset.sid = s.id;
        el.innerHTML = `<div class="pane-head"><span class="dot"></span><span class="nm"></span><span class="st"></span><button class="tab-more pane-more" data-menu="${esc(s.id)}" aria-haspopup="dialog" aria-label="${esc(s.roleLabel)} · ayrıntılar ve işlemler" title="Ayrıntılar ve işlemler">⋯</button></div><div class="pane-body"></div>`;
        terms.appendChild(el);
        pane = { el, term: null };
        this.panes.set(s.id, pane);
      }
      const head = pane.el.querySelector('.pane-head');
      head.querySelector('.dot').className = `dot ${statusKey(s)}`;
      head.querySelector('.nm').textContent = s.name;
      head.querySelector('.st').innerHTML = `<span class="stats" title="Bağlam: son istekteki token sayısı ve model penceresine oranı · harcama API fiyatıyla karşılığıdır">${esc(statsLine(s.stats))}</span> ${activityLine(s)} ${hintBadge(modelHint(s, g))} ${accBadge(s.accountId)} ${statusBadge(s)}`;
      pane.el.classList.toggle('selected', s.id === this.selected);
      pane.el.classList.toggle('waiting', s.running && s.status === 'waiting');
      pane.el.hidden = this.layout === 'tek' && s.id !== this.selected;
      const visible = !pane.el.hidden && this.view === 'terms';
      // Gizliyken çıkan çıktı sonrası gösterilen terminal yeniden çizilir.
      if (visible && !pane.visible) pane.refresh = true;
      pane.visible = visible;

      const body = pane.el.querySelector('.pane-body');
      if (s.running) {
        // Yeniden başlatılan oturuma yeni bağlantı açılır.
        if (pane.term && pane.term.closed) {
          pane.term.dispose();
          pane.term = null;
        }
        if (!pane.term) {
          // Gizli kapta açılan terminal hücre boyutunu ölçemeyip bozuk çizer; yalnızca görünen pane açılır.
          // Açılış sırayla yapılır (bkz. pumpTerms).
          if (pane.visible) body.innerHTML = '';
          const kept = pane.visible ? takeTerm(s.id, body) : null;
          if (kept) pane.term = kept;
          else {
            pane.want = pane.visible;
            if (pane.want && !body.querySelector('.pane-off')) body.innerHTML = '<div class="pane-off"><span>Bağlanıyor…</span></div>';
          }
        }
      } else if (!pane.term) {
        body.innerHTML = `<div class="pane-off"><span>Oturum kapalı.</span><button class="btn" data-start="${esc(s.id)}">Başlat (kaldığı yerden)</button></div>`;
      }
    }
    this.placePanes(members);
    this.openOrder = members.map((s) => s.id);
    this.pumpTerms();
    requestAnimationFrame(() => {
      for (const pane of this.panes.values()) {
        if (!pane.term || pane.el.hidden) continue;
        pane.term.claimSize();
        if (pane.refresh && this.view === 'terms') {
          pane.refresh = false;
          pane.term.term.refresh(0, pane.term.term.rows - 1);
        }
      }
    });
    if (this.view === 'board') this.refreshBoard(g);
    else if (this.view === 'notes') this.refreshNotes(g);
    else if (this.view === 'bekci') Bekci.refresh(g);
    else if (this.view !== 'terms') this.refreshActivity(g);
  },

  cleanup() {
    for (const [sid, pane] of this.panes) if (pane.term) stashTerm(sid, pane.term);
    this.panes.clear();
    this.pumping = false;
    this.pumpGen = (this.pumpGen || 0) + 1;
    document.body.classList.remove('work');
    document.removeEventListener('click', this.onDocClick);
    document.removeEventListener('keydown', this.onDocKey);
    window.removeEventListener('resize', this.onResize);
    $('#layout-btn').removeEventListener('click', this.onLayoutBtn);
    $('#layout-pop').removeEventListener('click', this.onLayoutPick);
    $('#layout-pop').hidden = true;
    $('#layout-btn').setAttribute('aria-expanded', 'false');
    $('#layout-wrap').hidden = true;
    $('#bekci-btn').removeEventListener('click', this.onBekciBtn);
    $('#bekci-btn').hidden = true;
  },
};
