// Ajan sunucu bağlantısı: PTY'leri tutan süreç services'e kendisi bağlanır (WebSocket, /agent). Bağlantı koparsa
// oturumlar açık kalır ve ajan yeniden bağlanır; services yeniden başlayınca terminaller kapanmaz.
// Protokol (JSON): services→ajan {k:'req', id, m, a} · {k:'term-open'|'term-msg'|'term-close', cid, ...};
// ajan→services {k:'hello', hookToken, sessions} · {k:'res', id, ok, r|e} · {k:'ev', ev, ...} · {k:'term'|'term-end', cid, d}.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { SessionManager } = require('./pty');

// Oturumların hook ve MCP çağrılarında gönderdiği anahtarın ortam değişkeni adı (services/session/hooks.js TOKEN_ENV ile aynı).
const HOOK_TOKEN_ENV = 'PANEL_HOOK_TOKEN';
const RETRY_MS = 1000;

// Tarayıcı WebSocket'inin ajandaki karşılığı: PtySession.attach bunu gerçek bir ws gibi kullanır.
class RemoteClient extends EventEmitter {
  constructor(host, cid) {
    super();
    this.host = host;
    this.cid = cid;
    this.readyState = 1;
  }

  send(data) {
    this.host.send({ k: 'term', cid: this.cid, d: data });
  }

  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.host.send({ k: 'term-end', cid: this.cid });
    this.emit('close');
  }
}

class AgentHost {
  // url: services adresi (ws://127.0.0.1:7788/agent), getToken: her bağlanışta güncel erişim anahtarı.
  constructor({ url, getToken, log = () => {} }) {
    this.url = url;
    this.getToken = getToken;
    this.log = log;
    // Anahtar ajanın ömrü boyunca sabit: services yeniden başlasa da açık oturumların hook'ları geçerli kalır.
    this.hookToken = crypto.randomBytes(24).toString('hex');
    this.manager = new SessionManager(null, { env: { [HOOK_TOKEN_ENV]: this.hookToken } });
    this.ws = null;
    this.clients = new Map();
    this.closed = false;
    this.manager.onInput((s) => this.send({
      k: 'ev', ev: 'input', id: s.id, lastInputAt: s.lastInputAt, lastEnterAt: s.lastEnterAt,
    }));
    this.manager.onExit((id, code) => this.send({ k: 'ev', ev: 'exit', id, code }));
  }

  start() {
    this.connect();
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  connect() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(`${this.url}?t=${encodeURIComponent(this.getToken())}`); } catch { setTimeout(() => this.connect(), RETRY_MS); return; }
    let opened = false;
    ws.on('open', () => {
      opened = true;
      this.ws = ws;
      this.send({ k: 'hello', hookToken: this.hookToken, sessions: this.snapshot() });
      this.log('services bağlandı');
    });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      this.handle(m);
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      // Bağlantı koptu: bağlı tarayıcı terminalleri düşer, oturumların kendisi açık kalır.
      for (const c of [...this.clients.values()]) { c.readyState = 3; c.emit('close'); }
      this.clients.clear();
      if (opened) this.log('services bağlantısı koptu');
      if (!this.closed) setTimeout(() => this.connect(), RETRY_MS);
    });
    ws.on('error', () => {});
  }

  snapshot() {
    return [...this.manager.map.values()].map((s) => ({
      id: s.id, name: s.name, startedAt: s.startedAt, lastInputAt: s.lastInputAt, lastEnterAt: s.lastEnterAt, pastes: s.pastes, size: s.size,
    }));
  }

  handle(m) {
    if (m.k === 'req') return this.request(m);
    if (m.k === 'term-open') {
      const s = this.manager.get(m.sid);
      if (!s) return this.send({ k: 'term-end', cid: m.cid });
      const c = new RemoteClient(this, m.cid);
      this.clients.set(m.cid, c);
      c.on('close', () => this.clients.delete(m.cid));
      return s.attach(c);
    }
    const c = this.clients.get(m.cid);
    if (!c) return undefined;
    if (m.k === 'term-msg') c.emit('message', m.d);
    else if (m.k === 'term-close') { c.readyState = 3; c.emit('close'); }
    return undefined;
  }

  request(m) {
    const reply = (ok, r, e) => this.send({ k: 'res', id: m.id, ok, r, e });
    try {
      const a = m.a || {};
      const mgr = this.manager;
      let r = null;
      if (m.m === 'launch') {
        r = { id: mgr.launch(a).id };
      } else if (m.m === 'stop') {
        r = mgr.stop(a.id);
      } else if (m.m === 'stopAll') {
        mgr.stopAll();
      } else if (m.m === 'paste') {
        const s = mgr.get(a.id);
        if (s) s.paste(a.text);
        r = !!s;
      } else if (m.m === 'interrupt') {
        const s = mgr.get(a.id);
        if (s) s.interrupt();
        r = !!s;
      } else if (m.m === 'shutdown') {
        reply(true, null);
        this.shutdown();
        return;
      } else {
        throw new Error(`Bilinmeyen ajan isteği: ${m.m}`);
      }
      reply(true, r);
    } catch (err) {
      reply(false, null, err.message);
    }
  }

  // Bütün oturumları kapatır ve süreci bitirir (yalnızca services'in açık isteğiyle).
  shutdown() {
    this.closed = true;
    this.manager.stopAll();
    setTimeout(() => process.exit(0), 400);
  }
}

module.exports = { AgentHost, HOOK_TOKEN_ENV };
