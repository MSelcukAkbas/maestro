// Claude Panel arayüzü · Temel yardımcılar (seçici, kaçış, API, bildirim balonu, biçimlendirme) ve panel durumu (durum kanalı, ortak görünümler).
// web/js/ altındaki dosyalar index.html'deki sırayla yüklenen klasik script'lerdir; üst düzey bildirimler ortak
// global kapsamdadır. Yüklenirken çalışan kod yalnızca kendinden önceki dosyaları kullanabilir.
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
