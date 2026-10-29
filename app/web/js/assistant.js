// Panel asistanı: sağ alttaki düğme, asistanın terminalini taşıyan çekmeceyi açar. Asistan yalnızca kullanıcı yazınca
// çalışan tek bir Claude oturumudur (sunucu: server/panel/assistant.js). Mikrofon düğmesi tarayıcının konuşma tanımasıyla
// söyleneni terminalin giriş satırına yazar; gönderme (Enter) kullanıcıdadır. Kısayol: Ctrl+K (terminal dışındayken).
const ASSISTANT_OPEN_KEY = 'claude-panel-assistant-open';

const Assistant = {
  el: null,
  termObj: null,
  termSid: null,
  rec: null,

  init() {
    const fab = document.createElement('button');
    fab.className = 'as-fab';
    fab.id = 'as-fab';
    fab.title = 'Panel asistanı (Ctrl+K)';
    fab.setAttribute('aria-label', 'Panel asistanı');
    fab.setAttribute('aria-expanded', 'false');
    fab.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg><span class="as-badge" hidden></span>';
    document.body.appendChild(fab);

    const el = document.createElement('section');
    el.className = 'as-drawer';
    el.hidden = true;
    el.setAttribute('aria-label', 'Panel asistanı');
    el.innerHTML = `
      <div class="as-h">
        <span class="as-dot" aria-hidden="true"></span>
        <b>Panel asistanı</b>
        <span class="note as-st"></span>
        <span class="grow"></span>
        <button type="button" class="btn icon small as-mic" data-as="mic" title="Sesle yaz (Türkçe)" aria-label="Sesle yaz" aria-pressed="false">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
        </button>
        <button type="button" class="btn small ghost as-tm-btn" data-as="timers" aria-expanded="false" title="Kurulu zamanlayıcılar">Zamanlayıcı</button>
        <button type="button" class="btn small ghost" data-as="fresh" title="Asistanı yeni, boş bir konuşmayla yeniden aç">Yeni konuşma</button>
        <button type="button" class="btn small ghost" data-as="stop" title="Asistan oturumunu kapat (konuşma saklanır)">Kapat</button>
        <button type="button" class="btn icon small" data-as="hide" aria-label="Çekmeceyi gizle" title="Gizle (Esc)">×</button>
      </div>
      <div class="as-timers" hidden></div>
      <div class="as-body"></div>
      <div class="as-off" hidden>
        <p>Asistan panelin tamamını görür: grupları, üyeleri, kotayı, bekçiyi. Ona doğal dille yaz; mesaj iletir, bekçi hamlesi sıraya alır, onay gerektirenleri karta düşürür. Sen yazmadıkça hiçbir şey yapmaz.</p>
        <p class="note">Örnek: "boştaki üyeleri bekçi incelesin" · "herkese sor: işin bitmesine ne kadar kaldı" · "review'ın terminalini aç"</p>
        <button type="button" class="btn primary" data-as="open">Asistanı aç</button>
      </div>`;
    document.body.appendChild(el);
    this.el = el;

    fab.addEventListener('click', () => this.toggle());
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-as]');
      if (b) this.act(b.dataset.as, b);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.target.closest('.xterm')) this.toggle(false);
    });
    document.addEventListener('keydown', (e) => {
      if ((e.key || '').toLowerCase() === 'k' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && !e.target.closest('.xterm, input, textarea')) {
        e.preventDefault();
        this.toggle();
      }
    });
    if (store(ASSISTANT_OPEN_KEY) === '1') this.toggle(true);
  },

  info() {
    return (state && state.assistant) || { running: false, unread: 0 };
  },

  toggle(show = this.el.hidden) {
    this.el.hidden = !show;
    $('#as-fab').setAttribute('aria-expanded', String(show));
    store(ASSISTANT_OPEN_KEY, show ? '1' : '0');
    if (show) {
      this.sync();
      requestAnimationFrame(() => { if (this.termObj) { this.termObj.claimSize(); this.termObj.term.focus(); } });
    } else this.stopMic();
  },

  // Durum değişince: rozet, durum yazısı ve terminalin bağlanması / ayrılması.
  sync() {
    if (!this.el) return;
    const a = this.info();
    const badge = $('#as-fab .as-badge');
    badge.hidden = !a.unread;
    badge.textContent = a.unread > 9 ? '9+' : String(a.unread || '');
    $('#as-fab').classList.toggle('on', !!a.running);
    if (this.el.hidden) return;
    const st = !a.running ? 'kapalı' : STATUS[a.status] === 'sıra sende' ? 'hazır' : STATUS[a.status] || 'açılıyor';
    this.el.querySelector('.as-st').textContent = `${st}${a.accountId ? ` · ${a.accountId}` : ''}${a.unread ? ` · ${a.unread} yeni yanıt` : ''}`;
    this.el.querySelector('.as-dot').dataset.s = a.running ? a.status || 'starting' : 'off';
    this.el.querySelector('[data-as="stop"]').hidden = !a.running;
    const tm = this.el.querySelector('.as-tm-btn');
    tm.textContent = a.timers ? `Zamanlayıcı · ${a.timers}` : 'Zamanlayıcı';
    if (a.timers !== this.lastTimers) {
      this.lastTimers = a.timers;
      if (!this.el.querySelector('.as-timers').hidden) this.loadTimers();
    }
    this.el.querySelector('.as-off').hidden = !!a.running;
    const body = this.el.querySelector('.as-body');
    body.hidden = !a.running;
    if (a.running && (this.termSid !== a.id || !this.termObj || this.termObj.closed)) {
      this.detach();
      this.termSid = a.id;
      this.termObj = createTerm(a.id, body);
      this.termObj.ready.then(() => { if (!this.el.hidden && this.termObj) this.termObj.term.focus(); });
    } else if (!a.running && this.termObj) this.detach();
  },

  // Kurulu zamanlayıcılar: liste, son kayıt satırları ve iptal. Kurmak asistanın işi.
  toggleTimers() {
    const box = this.el.querySelector('.as-timers');
    box.hidden = !box.hidden;
    this.el.querySelector('.as-tm-btn').setAttribute('aria-expanded', String(!box.hidden));
    if (!box.hidden) this.loadTimers();
  },

  async loadTimers() {
    const box = this.el.querySelector('.as-timers');
    let list;
    try { list = await api('GET', '/api/schedules'); } catch (err) { box.innerHTML = `<p class="note">${esc(err.message)}</p>`; return; }
    const at = (ts) => new Date(ts).toLocaleString('tr-TR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    box.innerHTML = list.length ? list.slice(0, 12).map((j) => {
      const live = j.durum === 'bekliyor' || j.durum === 'calisiyor';
      const last = j.kayit.length ? j.kayit[j.kayit.length - 1] : null;
      return `<div class="as-tm${live ? '' : ' done'}">
        <div class="as-tm-h"><b>#${j.id} ${esc(j.ad)}</b><span class="note">${esc(at(j.at))} · ${esc(j.durumText)}${j.durum === 'calisiyor' ? ` (${j.adim + 1}/${j.adimSayisi})` : ''}</span><span class="grow"></span>${live ? `<button type="button" class="btn small ghost" data-as="tm-cancel" data-id="${j.id}">İptal</button>` : ''}</div>
        <div class="note">${esc(j.adimlar.join(' → '))}${last ? ` · ${last.uyari ? 'dikkat: ' : ''}${esc(last.text)}` : ''}</div>
      </div>`;
    }).join('') : '<p class="note">Kurulu zamanlayıcı yok. Asistana "23:40\'ta şunu yap" diye söyle; önce önizleme gösterir, onaylarsan kurar.</p>';
  },

  detach() {
    if (this.termObj) this.termObj.dispose();
    this.termObj = null;
    this.termSid = null;
  },

  async act(what, btn) {
    if (what === 'hide') return this.toggle(false);
    if (what === 'mic') return this.mic(btn);
    if (what === 'timers') return this.toggleTimers();
    if (what === 'tm-cancel') {
      if (await act(() => api('DELETE', `/api/schedules/${btn.dataset.id}`), 'Zamanlayıcı iptal edildi.')) this.loadTimers();
      return;
    }
    if (what === 'stop') {
      await act(() => api('POST', '/api/assistant/stop'), 'Asistan kapatıldı; konuşma saklandı.');
      this.detach();
      return;
    }
    btn.disabled = true;
    try {
      state.assistant = await act(() => api('POST', '/api/assistant/open', { fresh: what === 'fresh' }));
      this.detach();
      this.sync();
    } finally {
      btn.disabled = false;
    }
  },

  // Konuşma tanıma: söylenen, terminalin giriş satırına yazılır (Enter'a kullanıcı basar).
  mic(btn) {
    if (this.rec) return this.stopMic();
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast('Bu tarayıcı konuşma tanımayı desteklemiyor.', true);
    if (!this.termObj || this.termObj.ws.readyState !== 1) return toast('Önce asistanı aç.', true);
    const rec = new SR();
    rec.lang = 'tr-TR';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e) => {
      const text = Array.from(e.results).map((r) => r[0].transcript).join(' ').trim();
      if (text && this.termObj && this.termObj.ws.readyState === 1) {
        this.termObj.ws.send(JSON.stringify({ t: 'i', d: text }));
        this.termObj.term.focus();
      }
    };
    rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') toast(`Ses: ${e.error}`, true); };
    rec.onend = () => this.stopMic();
    this.rec = rec;
    btn.setAttribute('aria-pressed', 'true');
    btn.classList.add('rec');
    rec.start();
  },

  stopMic() {
    if (this.rec) {
      const r = this.rec;
      this.rec = null;
      try { r.stop(); } catch {}
    }
    const b = this.el && this.el.querySelector('[data-as="mic"]');
    if (b) {
      b.setAttribute('aria-pressed', 'false');
      b.classList.remove('rec');
    }
  },
};
