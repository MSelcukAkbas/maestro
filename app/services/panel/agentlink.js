// Ajan bağlantısı (services tarafı): terminal oturumları ayrı ajan sürecinde yaşar, burada onların yerel bir aynası
// tutulur. has/get/launch/stop eskiden olduğu gibi eşzamanlıdır; durum ajanın gönderdiği olaylardan güncellenir.
// Ajan koparsa ayna boşalır, yeniden bağlanınca ajanın "hello" iletisindeki oturumlarla yeniden kurulur.
const crypto = require('crypto');

const CALL_TIMEOUT = 10000;

class RemoteSession {
  constructor(link, info) {
    this.link = link;
    this.id = info.id;
    this.name = info.name;
    this.startedAt = info.startedAt || Date.now();
    this.lastInputAt = info.lastInputAt || 0;
    this.lastEnterAt = info.lastEnterAt || 0;
    this.pastes = info.pastes || [];
    this.size = info.size || { cols: 120, rows: 32 };
  }

  // Panelin yapıştırmaları gelen istemin kullanıcıdan mı panelden mi olduğunu ayırmak için burada da kaydedilir.
  paste(text) {
    this.pastes.push({ t: Date.now(), text: String(text).replace(/\x1b/g, '') });
    if (this.pastes.length > 5) this.pastes.shift();
    this.link.call('paste', { id: this.id, text }).catch(() => {});
  }

  interrupt() {
    this.link.call('interrupt', { id: this.id }).catch(() => {});
  }

  // Tarayıcı ya da attach.js WebSocket'ini ajandaki PTY'ye bağlar.
  attach(ws) {
    this.link.attachTerminal(this.id, ws);
  }
}

class AgentLink {
  constructor({ getShell, onToken }) {
    this.getShell = getShell;
    // Ajan bağlandığında hook anahtarı ajandan alınır (HookState.token'a yazmak için).
    this.onToken = onToken;
    this.ws = null;
    this.map = new Map();
    this.calls = new Map();
    this.terms = new Map();
    this.exitListeners = [];
    this.inputListeners = [];
  }

  get connected() {
    return !!this.ws;
  }

  onInput(fn) {
    this.inputListeners.push(fn);
  }

  onExit(fn) {
    this.exitListeners.push(fn);
  }

  has(id) {
    return this.map.has(id);
  }

  get(id) {
    return this.map.get(id);
  }

  launch(opts) {
    if (this.map.has(opts.id)) return this.map.get(opts.id);
    if (!this.ws) throw new Error('Ajan bağlı değil; terminal başlatılamıyor.');
    const s = new RemoteSession(this, { id: opts.id, name: opts.name });
    this.map.set(opts.id, s);
    this.call('launch', { ...opts, shell: this.getShell() }).catch((err) => {
      console.error(`[panel] ${opts.name} açılamadı:`, err.message);
      this.drop(opts.id, null);
    });
    return s;
  }

  stop(id) {
    const s = this.map.get(id);
    if (s) this.call('stop', { id }).catch(() => {});
    return !!s;
  }

  stopAll() {
    this.call('stopAll', {}).catch(() => {});
  }

  // Ajanı ve içindeki bütün oturumları kapatır.
  shutdownAgent() {
    return this.call('shutdown', {}).catch(() => {});
  }

  drop(id, code) {
    if (!this.map.delete(id)) return;
    for (const fn of this.exitListeners) fn(id, code);
  }

  call(m, a) {
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error('Ajan bağlı değil.'));
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`Ajan yanıt vermedi: ${m}`));
      }, CALL_TIMEOUT);
      this.calls.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ k: 'req', id, m, a }));
      return undefined;
    });
  }

  attachTerminal(sid, ws) {
    if (!this.ws) {
      ws.send(JSON.stringify({ t: 'x', code: null }));
      ws.close();
      return;
    }
    const cid = crypto.randomUUID();
    this.terms.set(cid, ws);
    this.ws.send(JSON.stringify({ k: 'term-open', cid, sid }));
    ws.on('message', (raw) => {
      if (this.ws) this.ws.send(JSON.stringify({ k: 'term-msg', cid, d: raw.toString() }));
    });
    ws.on('close', () => {
      if (this.terms.delete(cid) && this.ws) this.ws.send(JSON.stringify({ k: 'term-close', cid }));
    });
  }

  // /agent WebSocket'i bağlandığında http.js çağırır.
  accept(ws) {
    // Yeni bağlantı eskisinin yerini alır (ajan yeniden bağlandı).
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = ws;
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      this.handle(ws, m);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.map.clear();
      for (const c of this.calls.values()) { clearTimeout(c.timer); c.reject(new Error('Ajan bağlantısı koptu.')); }
      this.calls.clear();
      for (const t of this.terms.values()) { try { t.close(); } catch {} }
      this.terms.clear();
      console.log('[panel] ajan bağlantısı koptu; terminal oturumları ajanda açık kalır.');
    });
    ws.on('error', () => {});
  }

  handle(ws, m) {
    if (m.k === 'hello') {
      this.map.clear();
      for (const info of m.sessions || []) this.map.set(info.id, new RemoteSession(this, info));
      if (m.hookToken) this.onToken(m.hookToken);
      console.log(`[panel] ajan bağlandı (${this.map.size} açık oturum).`);
    } else if (m.k === 'res') {
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      clearTimeout(c.timer);
      if (m.ok) c.resolve(m.r);
      else c.reject(new Error(m.e || 'Ajan hatası.'));
    } else if (m.k === 'ev') {
      this.event(m);
    } else if (m.k === 'term') {
      const t = this.terms.get(m.cid);
      if (t && t.readyState === 1) t.send(m.d);
    } else if (m.k === 'term-end') {
      const t = this.terms.get(m.cid);
      this.terms.delete(m.cid);
      if (t) { try { t.close(); } catch {} }
    }
  }

  event(m) {
    const s = this.map.get(m.id);
    if (m.ev === 'input' && s) {
      s.lastInputAt = m.lastInputAt;
      s.lastEnterAt = m.lastEnterAt;
      for (const fn of this.inputListeners) fn(s);
    } else if (m.ev === 'exit') {
      this.drop(m.id, m.code);
    }
  }
}

module.exports = { AgentLink, RemoteSession };
