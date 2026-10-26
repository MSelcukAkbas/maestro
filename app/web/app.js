(() => {
  'use strict';

  // ---------- temel yardımcılar ----------

  const $ = (sel, el = document) => el.querySelector(sel);
  const app = $('#app');
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  const TOKEN_KEY = 'claude-panel-token';
  const LAYOUT_KEY = 'claude-panel-layout';
  const VIEW_KEY = 'claude-panel-view';
  const SPLIT_KEY = 'claude-panel-split';
  const MAPWIN_KEY = 'claude-panel-mapwin';
  const NOTETAB_KEY = 'claude-panel-notetab';
  const DOCOPEN_KEY = 'claude-panel-docopen';

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch {}
    return null;
  }

  // Sunucunun verdiği adres ?t=<anahtar> taşır; anahtar saklanıp adresten silinir.
  function readToken() {
    const params = new URLSearchParams(location.search);
    const t = params.get('t');
    if (t) {
      store(TOKEN_KEY, t);
      history.replaceState(null, '', location.pathname + location.hash);
      return t;
    }
    return store(TOKEN_KEY);
  }
  let token = readToken();

  async function api(method, url, body) {
    const headers = { 'x-panel-token': token || '' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 6000 : 3000);
  }

  async function act(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (err) {
      toast(err.message, true);
      return null;
    }
  }

  // Notlar için küçük Markdown: başlık, liste, alıntı, kod bloğu, ayırıcı, satır içi kod, kalın, italik, bağlantı.
  // Metin önce kaçırılır; yalnızca bu biçimler etikete çevrilir.
  function mdLite(src) {
    const inline = (t) => esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    const out = [];
    let list = null, para = [], code = null;
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    for (const line of String(src).replace(/\r\n?/g, '\n').split('\n')) {
      if (code) {
        if (/^\s*```/.test(line)) {
          out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
          code = null;
        } else code.push(line);
        continue;
      }
      if (/^\s*```/.test(line)) { flushPara(); flushList(); code = []; continue; }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        flushPara(); flushList();
        const lv = Math.min(4, h[1].length + 2);
        out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
      const li = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
      if (li) {
        flushPara();
        const tag = li[1] ? 'ol' : 'ul';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(li[2]);
        continue;
      }
      if (/^>\s?/.test(line)) { flushPara(); flushList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      flushList();
      para.push(line);
    }
    if (code) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    flushPara();
    flushList();
    return out.join('');
  }

  // Grup notunda kullanıcının yazdığı satırlar [kullanıcı] … [/kullanıcı] arasındadır (işaretleri sunucu üretir).
  const OWN_RE = /^\s*\[(\/?)kullanıcı\]\s*$/;
  function noteSegments(body) {
    const segs = [];
    let u = false;
    for (const line of String(body || '').replace(/\r\n?/g, '\n').split('\n')) {
      const m = OWN_RE.exec(line);
      if (m) { u = !m[1]; continue; }
      const last = segs[segs.length - 1];
      if (last && last.u === u) last.lines.push(line);
      else segs.push({ u, lines: [line] });
    }
    return segs;
  }
  const notePlain = (body) => noteSegments(body).map((s) => s.lines.join('\n')).join('\n');
  function noteMd(body) {
    return noteSegments(body).map((s) => {
      const html = mdLite(s.lines.join('\n'));
      return s.u ? `<div class="own-user"><span class="own-tag">sen yazdın</span>${html}</div>` : html;
    }).join('');
  }

  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = () => { const d = new Date(); return pad(d.getHours()) + pad(d.getMinutes()); };

  function timeAgo(ms) {
    if (!ms) return '';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'az önce';
    if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
    if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
    const d = Math.floor(s / 86400);
    return d === 1 ? 'dün' : `${d} gün önce`;
  }

  // Kullanıcının uzakta olduğu aralıklar (sunucunun "Sen" izinden): [[başlangıç, bitiş], ...].
  function awayIntervals(user, end) {
    const out = [];
    user.forEach((e, i) => {
      if (e.s === 'away') out.push([e.t, i + 1 < user.length ? user[i + 1].t : end]);
    });
    return out;
  }

  // [t0, t1) aralığını uzakta olunan ve olunmayan parçalara böler: [[t0, t1, uzakta], ...].
  function splitAway(away, t0, t1) {
    const out = [];
    let t = t0;
    for (const [a0, a1] of away) {
      if (a1 <= t || a0 >= t1) continue;
      if (a0 > t) out.push([t, a0, false]);
      out.push([Math.max(t, a0), Math.min(t1, a1), true]);
      t = Math.min(t1, a1);
    }
    if (t < t1) out.push([t, t1, false]);
    return out;
  }

  function fmtDate(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function fmtTok(n) {
    if (!n) return '0';
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
    return String(n);
  }

  // Abonelikle kullanımda bu tutar faturalanmaz; API fiyatıyla karşılığıdır.
  const fmtUsd = (n) => `≈$${(n || 0) >= 1 ? n.toFixed(2) : (n || 0).toFixed(3)}`;

  function fmtDur(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    return m < 60 ? `${m} dk` : `${Math.floor(m / 60)} sa ${m % 60} dk`;
  }

  const FAMILIES = ['opus', 'sonnet', 'haiku'];
  const familyOf = (model) => FAMILIES.find((f) => String(model || '').includes(f)) || null;

  // Bağlamın model penceresine oranı; pencere Ayarlar > Bağlam pencereleri'nden gelir.
  function ctxPct(st) {
    if (!st || !st.context) return null;
    const fam = familyOf(st.model);
    const win = fam && state.settings.contextWindows && state.settings.contextWindows[fam];
    return win ? Math.round((st.context / win) * 100) : null;
  }

  function statsLine(st) {
    if (!st) return '';
    const pct = ctxPct(st);
    const parts = [`bağlam ${fmtTok(st.context)}${pct != null ? ` (%${pct}${pct >= 80 ? ' ⚠' : ''})` : ''}`, fmtUsd(st.costUSD)];
    if (st.linesAdded || st.linesRemoved) parts.push(`+${st.linesAdded}/−${st.linesRemoved}`);
    return parts.join(' · ');
  }

  function groupTotals(g) {
    const t = { cost: 0, added: 0, removed: 0, output: 0, prompts: 0, first: null, last: null };
    for (const s of g.sessions) {
      const st = s.stats;
      if (!st) continue;
      t.cost += st.costUSD;
      t.added += st.linesAdded;
      t.removed += st.linesRemoved;
      t.output += st.tokens.output;
      t.prompts += st.prompts;
      if (st.firstAt && (!t.first || st.firstAt < t.first)) t.first = st.firstAt;
      if (st.lastAt && (!t.last || st.lastAt > t.last)) t.last = st.lastAt;
    }
    return t;
  }

  // Model önerisi: rolün varsayılan modeli farklıysa ya da pahalı model harcamanın büyük kısmını
  // yardımcı bir rolde yiyorsa. Kesin fiyat hesabı değil, yön gösterir.
  const CHEAP_ROLES = ['arastirma', 'review', 'avukat', 'debug', 'kalite', 'test', 'guvenlik', 'dokuman'];
  function modelHint(s, g) {
    const st = s.stats;
    const fam = st && familyOf(st.model);
    if (!fam) return '';
    const role = state.settings.roles.find((r) => r.id === s.roleId);
    if (role && role.model && role.model !== fam) {
      return `Bu rolün varsayılan modeli ${role.model}; oturum ${fam} kullanıyor. Rolün işi daha ucuz modelle yapılabilir.`;
    }
    if (fam === 'opus' && CHEAP_ROLES.includes(s.roleId) && g) {
      const total = groupTotals(g).cost;
      const share = total > 0 ? st.costUSD / total : 0;
      if (share >= 0.35 && st.costUSD >= 0.2) {
        return `Grup harcamasının %${Math.round(share * 100)}'i bu oturumda ve Opus kullanıyor. ${s.roleLabel} için Sonnet ya da Haiku çoğu zaman yeterli.`;
      }
    }
    return '';
  }

  const hintBadge = (text) => (text ? `<span class="badge hint" title="${esc(text)}">öneri</span>` : '');

  // Kota bir kez çekilip kısa süre saklanır; Kurulum ve üye ekleme ekranları aynı sonucu kullanır.
  let quotaCache = null;
  async function getQuota(force) {
    if (!force && quotaCache && Date.now() - quotaCache.fetchedAt < 120000) return quotaCache;
    quotaCache = await api('GET', `/api/quota${force ? '?fresh=1' : ''}`);
    return quotaCache;
  }

  function quotaLeftOf(accountId) {
    const r = quotaCache && quotaCache.rows.find((x) => x.accountId === accountId);
    if (!r) return null;
    if (r.blocked) return 0;
    const vals = [r.five, r.week].filter(Boolean).map((b) => 100 - b.used);
    return vals.length ? Math.round(Math.min(...vals)) : null;
  }

  function accountOptionLabel(a) {
    const left = quotaLeftOf(a.id);
    if (left == null) return a.name;
    return left === 0 ? `${a.name} · DOLU` : `${a.name} · %${left} kaldı`;
  }

  // ---------- durum ----------

  let state = null;

  function setServer(ok, authFail) {
    const dot = $('#server-pill');
    const label = ok ? 'sunucu çalışıyor' : authFail ? 'erişim anahtarı geçersiz' : 'sunucuya ulaşılamıyor';
    dot.className = ok ? 'srv ok' : 'srv bad';
    dot.title = label;
    dot.setAttribute('aria-label', label);
  }

  const FAM_TEXT = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

  // Kullanıcının son mesajı (hangi oturum, hangi model) ve panelle son teması; ayrıntı üstüne gelince.
  function setPresence() {
    const pill = $('#presence-pill');
    const p = state.presence || {};
    const m = p.lastMessage;
    if (!m && !p.lastSeenAt) { pill.hidden = true; return; }
    pill.hidden = false;
    // Yeni kayıtlar "grup - rol: mesaj"; eski kayıtlarda (grup alanı yok) oturum adı gösterilir.
    if (m) pill.textContent = m.group ? `${m.group} - ${m.role}: ${m.text}` : `${m.name} · ${FAM_TEXT[m.fam] || '?'} · ${timeAgo(m.ts)}`;
    else pill.textContent = `temas: ${timeAgo(p.lastSeenAt)}`;
    const lines = [];
    if (p.lastSeenAt) lines.push(`Panelle son temas: ${timeAgo(p.lastSeenAt)}${p.lastAction ? ` (${p.lastAction})` : ''}`);
    for (const [fam, x] of Object.entries(p.byFam || {}).sort((a, b) => b[1].ts - a[1].ts)) {
      lines.push(`${FAM_TEXT[fam] || fam}${x.model ? ` (${x.model})` : ''}: ${timeAgo(x.ts)} · ${x.name}`);
    }
    pill.title = lines.join('\n');
  }

  async function refresh() {
    try {
      state = await api('GET', '/api/state');
      setServer(true);
      setPresence();
    } catch (err) {
      setServer(false, err.status === 401);
      throw err;
    }
  }

  // Durum kanalı: sunucu durum değişince tam yanıtı iter; kanal açıkken yoklama yalnızca seyrek bir güvencedir.
  let stateWs = null;
  let stateWsRetry = null;
  const stateLive = () => !!stateWs && stateWs.readyState === 1;
  function openStateChannel() {
    if (!token || stateWs || stateWsRetry) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&ch=state`);
    stateWs = ws;
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t !== 'state' || !m.d) return;
      state = m.d;
      setServer(true);
      setPresence();
      afterState();
    };
    ws.onclose = () => {
      stateWs = null;
      stateWsRetry = setTimeout(() => { stateWsRetry = null; openStateChannel(); }, 2000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  const account = (id) => state.settings.accounts.find((a) => a.id === id);
  const project = (id) => state.projects.find((p) => p.id === id);
  const groupsOf = (pid) => state.groups.filter((g) => g.projectId === pid).sort((a, b) => b.createdAt - a.createdAt);

  function accBadge(id) {
    const a = account(id);
    return `<span class="badge acc-${esc(a ? a.color : 'blue')}" title="${esc(a ? a.name : id)}">${esc(id)}</span>`;
  }

  const STATUS = {
    busy: 'çalışıyor',
    waiting: 'onay bekliyor',
    idle: 'sıra sende',
    starting: 'açılıyor',
  };

  function statusKey(s) {
    return s.running ? (STATUS[s.status] ? s.status : 'busy') : 'off';
  }

  function statusLabel(s) {
    const k = statusKey(s);
    if (k === 'off') return 'kapalı';
    return k === 'waiting' && s.waitKind === 'question' ? 'soru soruyor' : STATUS[k];
  }

  function statusBadge(s) {
    const k = statusKey(s);
    if (k === 'off') return '<span class="badge">kapalı</span>';
    const label = statusLabel(s);
    const err = s.error ? ` <span class="badge danger" title="${esc(s.error)}">hata</span>` : '';
    // Açılışta istenen model / effort / skill ayarı oturum kaydındakiyle uyuşmuyorsa (ör. terminalde /model ile değiştirildi).
    const drift = (s.drift || []).length ? ` <span class="badge warn" title="${esc(s.drift.join('\n'))}">ayar uyuşmuyor</span>` : '';
    const pend = s.pending ? ` <span class="badge" title="${esc(pendingText(s.pending))}: uygun anda kaldığı yerden yeniden açılacak">değişiklik bekliyor</span>` : '';
    return `<span class="badge ${k}">${label}</span>${err}${drift}${pend}`;
  }

  // Bekleyen model / effort değişikliğinin kısa metni.
  function pendingText(p) {
    return [p.model ? `model ${p.model}` : '', p.effort ? `effort ${p.effort}` : '', p.caps ? 'yetenekler' : ''].filter(Boolean).join(', ') || 'yeniden başlatma';
  }

  // Hook'tan gelen "şu an ne yapıyor" satırı.
  function activityLine(s) {
    return s.running && s.activity ? `<span class="act-line" title="${esc(s.activity)}">${esc(s.activity)}</span>` : '';
  }

  function crumbs(items) {
    $('#crumbs').innerHTML = items
      .map((it, i) => (i === items.length - 1
        ? `<span class="here">${esc(it.label)}</span>`
        : `<a href="${esc(it.href)}">${esc(it.label)}</a><span>/</span>`))
      .join('');
  }

  const ICON_PLUS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const ICON_CROWN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg>';
  const ICON_MSGS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';
  const ICON_TERM ='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>';
  const ICON_MAP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg>';
  const ICON_TIME = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const ICON_BOARD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/></svg>';
  const ICON_NOTES = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>';
  const ICON_CHEV ='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

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
      const rows = g.sessions.map((s) => {
        const sent = a.messages.filter((m) => m.from === s.id).length;
        const recv = a.messages.filter((m) => m.to === s.id).length;
        const tl = (a.timeline || {})[s.id] || [];
        let waiting = 0, busy = 0;
        // Kullanıcı yokken geçen onay beklemesi sayılmaz: izin modunu suçlamak için kullanıcının başında olması gerekir.
        const away = awayIntervals(a.user || [], a.now);
        tl.forEach((e, i) => {
          const end = i + 1 < tl.length ? tl[i + 1].t : a.now;
          if (e.s === 'waiting') waiting += splitAway(away, e.t, end).filter((x) => !x[2]).reduce((n, x) => n + x[1] - x[0], 0);
          if (e.s === 'busy') busy += end - e.t;
        });
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
      const hasTimeline = rows.some((r) => r.waiting || r.busy);
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
            <span>Süre <b>${tot.first && tot.last ? fmtDur(tot.last - tot.first) : '-'}</b></span>
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
      return row.prompt != null ? row.prompt : (this.roleOf(row) || {}).prompt || '';
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
                <div class="field"${om('prompt')}><label for="rp-${r.key}">Rol talimatı (yalnızca bu grupta; rolün kayıtlı talimatı değişmez)</label>
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

  // ---------- 5 · ayarlar ----------

  const COLORS = [['blue', 'Mavi'], ['amber', 'Turuncu'], ['violet', 'Mor'], ['green', 'Yeşil']];

  const SETTINGS_TABS = [
    ['hesaplar', 'Hesaplar'], ['roller', 'Roller'], ['yetenekler', 'Yetenekler'],
    ['genel', 'Genel'], ['sablonlar', 'Şablonlar'], ['sistem', 'Sistem'],
  ];
  // "Ayarları kaydet" ile kaydedilen sekmeler; diğerlerindeki işlemler hemen uygulanır.
  const FORM_TABS = ['hesaplar', 'roller', 'genel'];
  const CAP_KIND = { plugin: 'eklenti', skill: 'skill', mcp: 'MCP' };

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
    mount({ tab }) {
      crumbs([{ label: 'Projeler', href: '#/' }, { label: 'Ayarlar' }]);
      this.tab = SETTINGS_TABS.some(([k]) => k === tab) ? tab : 'hesaplar';
      this.model = JSON.parse(JSON.stringify(state.settings));
      this.model.allowedText = this.model.allowedDirs.join('\n');
      this.dirty = false;
      this.openRoles = new Set();
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
        this.model.roles.push({ id, label: '', short: '', prompt: '', permissionMode: '', model: '' });
        this.openRoles.add(id);
        this.dirty = true;
        this.render();
      } else if (a === 'del-role') {
        const r = this.model.roles[Number(b.dataset.i)];
        if (r && r.label && !confirm(`"${r.label}" rolü silinsin mi? Kaydedince yetenek atamaları da kalkar.`)) return;
        this.model.roles.splice(Number(b.dataset.i), 1);
        this.dirty = true;
        this.render();
      } else if (a === 'role-toggle') {
        const id = b.dataset.rid;
        if (this.openRoles.has(id)) this.openRoles.delete(id);
        else this.openRoles.add(id);
        this.renderBody();
      } else if (a === 'save') {
        const body = {
          accounts: this.model.accounts,
          roles: this.model.roles,
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
      const m = this.model;
      const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
      const modelLabel = (v) => (MODELS.find(([x]) => x === v) || [v, v])[1];
      const firstLine = (t) => String(t || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
      return `
        <section class="section">
          <div class="section-head"><h2>Roller</h2><span class="count">${m.roles.length} rol · kurulumda seçilir</span></div>
          <div class="card role-list">
            ${m.roles.map((r, i) => {
              const open = this.openRoles.has(r.id);
              const rc = this.roleCaps(r.id);
              const capText = rc && (rc.add.length || rc.off.length)
                ? [rc.add.length ? `+ ${rc.add.join(', ')}` : '', rc.off.length ? `kapalı: ${rc.off.join(', ')}` : ''].filter(Boolean).join(' · ')
                : '';
              return `
              <div class="role-row${open ? ' open' : ''}">
                <button class="role-sum" data-act="role-toggle" data-rid="${esc(r.id)}" aria-expanded="${open}">
                  <span class="rdot" style="background: ${roleColor({ roleId: r.id, roleLabel: r.label })}"></span>
                  <span class="rs-main">
                    <span class="rs-top"><span class="rs-name">${esc(r.label || 'Adsız rol')}</span><span class="mono note">${esc(r.short || '')}</span>
                      ${r.model ? `<span class="badge">${esc(modelLabel(r.model))}</span>` : ''}
                      ${r.permissionMode ? `<span class="badge">${esc(permLabel(r.permissionMode))}</span>` : ''}
                      ${rc && rc.add.length ? `<span class="badge acc-green">+${rc.add.length} yetenek</span>` : ''}
                      ${rc && rc.off.length ? `<span class="badge">${rc.off.length} kapalı</span>` : ''}</span>
                    <span class="rs-desc">${esc(firstLine(r.prompt))}</span>
                  </span>
                  <span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span>
                </button>
                ${open ? `
                <div class="role-item">
                  <div class="field"><label for="rl-${i}">Rol adı</label><input id="rl-${i}" data-f="roles.${i}.label" value="${esc(r.label)}" maxlength="40"></div>
                  <div class="field"><label for="rs-${i}">Oturum adındaki kısa hali</label><input id="rs-${i}" data-f="roles.${i}.short" value="${esc(r.short)}" maxlength="24"></div>
                  <div class="field"><label for="rmo-${i}">Varsayılan model</label>
                    <select id="rmo-${i}" data-f="roles.${i}.model">${MODELS.map(([v, l]) => opt(v, l, r.model || '')).join('')}</select></div>
                  <div class="field"><label for="ref-${i}">Varsayılan effort</label>
                    <select id="ref-${i}" data-f="roles.${i}.effort">${EFFORTS.map(([v, l]) => opt(v, l, r.effort || '')).join('')}</select></div>
                  <div class="field"><label for="rm-${i}">Varsayılan izin modu</label>
                    <select id="rm-${i}" data-f="roles.${i}.permissionMode">
                      ${opt('', 'Grup varsayılanı', r.permissionMode || '')}
                      ${PERMISSION_LABELS.map(([v, l]) => opt(v, l, r.permissionMode)).join('')}
                    </select></div>
                  <label class="check" style="align-self: end" title="Oturumda dosya düzenleme araçları (Edit, Write, NotebookEdit) kapatılır; talimata ek olarak izinle uygulanır."><input type="checkbox" data-f="roles.${i}.readOnly" ${r.readOnly ? 'checked' : ''}>Salt okunur</label>
                  <div class="field"><label for="rcw-${i}">Bağlam eşiği (token)</label><input id="rcw-${i}" type="number" step="10000" data-f="roles.${i}.ctxWarn" value="${esc(r.ctxWarn || '')}" placeholder="${esc(ROLE_CTX_DEFAULTS[r.id] ? ROLE_CTX_DEFAULTS[r.id][0] : 'genel ayar')}"></div>
                  <div class="field"><label for="rch-${i}">Bağlam üst sınırı (token)</label><input id="rch-${i}" type="number" step="10000" data-f="roles.${i}.ctxHigh" value="${esc(r.ctxHigh || '')}" placeholder="${esc(ROLE_CTX_DEFAULTS[r.id] ? ROLE_CTX_DEFAULTS[r.id][1] : 'genel ayar')}"></div>
                  <button class="btn icon" style="align-self: end" data-act="del-role" data-i="${i}" aria-label="Rolü kaldır" title="Rolü kaldır">✕</button>
                  <div class="field" style="grid-column: 1 / -1"><label for="rp-${i}">Rol talimatı</label><textarea id="rp-${i}" rows="8" data-f="roles.${i}.prompt">${esc(r.prompt)}</textarea></div>
                  <div class="note" style="grid-column: 1 / -1">Bağlam: eşiği geçen üye işi bitip 3 dakika boş kalınca, üst sınırı geçen ilk uygun anda bekçiden hamle alır; iki compact'tan sonraki hamle devir notuyla yenilemedir. Boş bırakılırsa rolün varsayılanı (yer tutucudaki değer) ya da genel ayar kullanılır.</div>
                  <div class="note" style="grid-column: 1 / -1">Yetenekler: ${capText ? esc(capText) : 'global olanların hepsi açık, ek yetenek yok'} · <a href="#/ayarlar/yetenekler" data-act="tab" data-tab="yetenekler">Yetenekler'de değiştir</a></div>
                </div>` : ''}
              </div>`;
            }).join('')}
          </div>
          <div><button class="btn ghost" data-act="add-role">${ICON_PLUS} Rol ekle</button></div>
        </section>`;
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
      // Panelin kendi model çağrıları (bekçi yardımcısı, kurulum danışmanı, not düzenleyici): oturum kaydı bırakmazlar.
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
  const NOTIF_SEEN_KEY = 'claude-panel-notif-seen';
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
    // Bekçi grup başına çalışır: çalışan her grubun bekçisi ayrı satır, tıklayınca o grubun Bekçi görünümü.
    const active = ((state && state.groups) || []).filter((g) => g.state === 'active');
    const gName = (gid) => ((state.groups || []).find((g) => g.id === gid) || {}).name;
    const bekciHref = (gid) => `#/g/${encodeURIComponent(gid)}?view=bekci`;
    notifPop.innerHTML = `
      <div class="kv"><strong>Bildirimler</strong><span class="note">panel ve yardımcı modeller</span></div>
      ${active.map((g) => {
        const cfg = groupWatch(g);
        return `<a class="notif-helper" href="${bekciHref(g.id)}"><span class="dot ${cfg.enabled ? 'busy' : ''}"></span><span><strong>Bekçi · ${esc(g.name)}</strong><span class="note">${esc(bekciModeText(cfg))}</span></span><span class="grow"></span>${ICON_CHEV}</a>`;
      }).join('')}
      <div class="notif-list">${evs.length ? evs.map((e) => {
        // Kaynak etiketi (bekçi / not düzenleyici / panel) ve olayın grubu; grubu olan olay o grubun ilgili ekranına götürür.
        const bk = e.source === 'bekci';
        const gn = e.gid && gName(e.gid);
        const href = e.gid && gn ? (bk ? bekciHref(e.gid) : e.source === 'notlar' ? `#/g/${encodeURIComponent(e.gid)}?view=notes` : `#/g/${encodeURIComponent(e.gid)}`) : null;
        const label = `${bk ? 'Bekçi' : e.source === 'notlar' ? 'Notlar' : 'Panel'}${gn ? ` · ${gn}` : ''}`;
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

  // ---------- yönlendirme ----------

  let current = null;

  function parseRoute() {
    const [pathPart, query] = location.hash.replace(/^#\/?/, '').split('?');
    const parts = pathPart.split('/').filter(Boolean);
    // Çalışma ekranı görünümü adresle de seçilebilir: #/g/<grup>?view=map
    const view = new URLSearchParams(query || '').get('view');
    if (view && ['terms', 'map', 'time', 'msgs', 'board', 'notes', 'bekci'].includes(view)) store(VIEW_KEY, view);
    if (parts[0] === 'p' && parts[1] && parts[2] === 'kurulum') return [SetupView, { id: parts[1] }];
    if (parts[0] === 'p' && parts[1]) return [ProjectView, { id: parts[1] }];
    if (parts[0] === 'g' && parts[1]) return [WorkView, { id: parts[1], sid: parts[2] }];
    if (parts[0] === 'ayarlar') return [SettingsView, { tab: parts[1] }];
    return [ProjectsView, {}];
  }

  async function navigate() {
    if (current && current.cleanup) current.cleanup();
    current = null;
    closeQuota();
    closeNotif();
    if (!token) {
      crumbs([{ label: 'Erişim' }]);
      app.innerHTML = '<div class="page"><div class="empty">Erişim anahtarı yok. Sunucu penceresinde yazan adresi (…/?t=…) aç.</div></div>';
      setServer(false, true);
      return;
    }
    try {
      // Durum kanalı güncel tuttuğu için ekran beklemeden önceki durumla açılır; yenisi gelince kendiliğinden tazelenir.
      if (state && stateLive()) refresh().then(afterState).catch(() => {});
      else await refresh();
    } catch (err) {
      app.innerHTML = `<div class="page"><div class="empty">${err.status === 401
        ? 'Erişim anahtarı geçersiz. Sunucu penceresinde yazan adresi yeniden aç.'
        : 'Sunucuya ulaşılamıyor. Paneli başlatan pencere açık mı?'}</div></div>`;
      return;
    }
    const [view, params] = parseRoute();
    current = view;
    view.mount(params);
  }

  window.addEventListener('hashchange', navigate);

  // ---------- bildirimler ----------

  const NOTIFY_KEY = 'claude-panel-notify';
  const prevStatus = new Map();

  // Bir oturum "onay bekliyor" durumuna geçince tarayıcı bildirimi; sekme başlığında bekleyen sayısı.
  function watchState() {
    const waiting = [];
    for (const g of state.groups) {
      for (const s of g.sessions) {
        const k = s.running && !s.removed ? s.status : 'off';
        const before = prevStatus.get(s.id);
        prevStatus.set(s.id, k);
        if (k === 'waiting') waiting.push(s);
        if (k === 'waiting' && before && before !== 'waiting' && store(NOTIFY_KEY) === '1'
          && 'Notification' in window && Notification.permission === 'granted') {
          // Soru (AskUserQuestion) ile izin onayı ayrı yazılır; ikisinde de üyenin ne beklediği gövdede.
          const n = new Notification(`${s.roleLabel} ${s.waitKind === 'question' ? 'soru soruyor' : 'onay bekliyor'}`, {
            body: [s.activity && s.activity !== 'soru soruyor' ? s.activity : '', s.name].filter(Boolean).join('\n'), tag: s.id,
          });
          n.onclick = () => {
            window.focus();
            location.hash = `#/g/${g.id}/${s.id}`;
            n.close();
          };
        }
      }
    }
    document.title = waiting.length ? `(${waiting.length}) Claude Panel` : 'Claude Panel';
    // Panelin kendiliğinden yaptığı işler (ör. hesap rotasyonu, bekçinin hamleleri) bildirim kutusuna düşer.
    const evs = state.events || [];
    const top = evs.length ? evs[evs.length - 1].id : 0;
    if (!notifPop.hidden && top !== notifShownTop) openNotif();
    updateNotifCount();
  }

  // Durum iki saniyede bir yenilenir; açık ekranın canlı kısmı (varsa) yeniden çizilir.
  function afterState() {
    watchState();
    if (current && current.poll && !document.hidden) current.poll();
  }

  let lastPoll = 0;
  setInterval(async () => {
    if (!token || document.hidden && store(NOTIFY_KEY) !== '1') return;
    // Durum kanalı açıkken sunucu zaten itiyor; yoklama yalnızca kanalın sessiz kopmasına karşı 20 sn'de bir.
    if (stateLive() && Date.now() - lastPoll < 20000) return;
    lastPoll = Date.now();
    try {
      await refresh();
      afterState();
    } catch {}
  }, 2000);

  openStateChannel();
  navigate();
})();
