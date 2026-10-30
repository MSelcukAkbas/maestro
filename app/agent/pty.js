// PTY oturumları: her oturum kendi pwsh'unda çalışır, birden çok istemci (tarayıcı, PC penceresi) bağlanabilir.
// Boyut kuralı: en son yazan istemci PTY boyutunu belirler, diğerlerine bildirilir.
const pty = require('@lydell/node-pty');

const MAX_SCROLLBACK = 400000;

// Sınır aşılınca baştan kesilir; kesim bir kaçış dizisinin ortasına düşerse yeniden oynatılan geçmiş ekranı bozar,
// bu yüzden ilk satır sonuna kadar olan parça da atılır.
function trimScrollback(text) {
  if (text.length <= MAX_SCROLLBACK) return text;
  const cut = text.slice(-MAX_SCROLLBACK);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < 4000 ? cut.slice(nl + 1) : cut;
}

// Açılıştan sonra kapatmadan önce beklenen süreler (bkz. PtySession.kill).
const KILL_WAIT = 3000;
const KILL_SETTLE = 500;

// Üst Claude oturumunun değişkenleri yeni terminale sızmasın.
function cleanEnv(configDir, extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC)/i.test(k)) continue;
    env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  // Program açılırken terminal sorularına cevap verecek istemci olmayabilir; renk desteği baştan bildirilir.
  env.FORCE_COLOR = '3';
  return Object.assign(env, extra);
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// pwsh'a verilecek betik. Claude kapanınca pencere normal PowerShell olarak açık kalır (-NoExit).
function buildScript({ name, sessionId, resume, permissionMode, model, effort, promptFile, taskFile, settingsFile, mcpConfig, addDir }) {
  const args = ['--name', psQuote(name)];
  if (settingsFile) args.push('--settings', psQuote(settingsFile));
  if (mcpConfig) args.push('--mcp-config', psQuote(mcpConfig));
  // Rolün panel skill'leri bu klasörün .claude/skills altında.
  if (addDir) args.push('--add-dir', psQuote(addDir));
  if (resume) {
    args.push('--resume', psQuote(sessionId));
  } else {
    args.push('--session-id', psQuote(sessionId));
    if (promptFile) args.push('--append-system-prompt-file', psQuote(promptFile));
  }
  if (permissionMode) args.push('--permission-mode', psQuote(permissionMode));
  if (model) args.push('--model', psQuote(model));
  if (effort) args.push('--effort', psQuote(effort));
  if (!resume && taskFile) args.push(`(Get-Content -Raw -LiteralPath ${psQuote(taskFile)})`);
  return [
    `$Host.UI.RawUI.WindowTitle = ${psQuote(name)}`,
    `& claude ${args.join(' ')}`,
  ].join('\n');
}

class PtySession {
  constructor({ id, name, cwd, configDir, shell, script, env, onExit, onInput }) {
    this.id = id;
    this.name = name;
    this.size = { cols: 120, rows: 32 };
    this.scrollback = '';
    this.clients = new Set();
    this.owner = null;
    this.startedAt = Date.now();
    // Kullanıcının terminale son yazdığı an; panel yarım yazılmış bir girdinin üstüne yapıştırma yapmasın.
    this.lastInputAt = 0;
    // Kullanıcının Enter'a bastığı son an ve panelin son yapıştırmaları: gelen istemin kullanıcıdan mı panelden mi olduğu buradan ayrılır.
    this.lastEnterAt = 0;
    this.pastes = [];
    this.onInput = onInput || (() => {});

    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    this.pty = pty.spawn(shell, ['-NoLogo', '-NoExit', '-EncodedCommand', encoded], {
      name: 'xterm-256color',
      cols: this.size.cols,
      rows: this.size.rows,
      cwd,
      env: cleanEnv(configDir, env),
    });

    this.pty.onData((data) => {
      this.firstDataAt = this.firstDataAt || Date.now();
      this.scrollback = trimScrollback(this.scrollback + data);
      this.broadcast({ t: 'o', d: data });
    });
    this.pty.onExit(({ exitCode }) => {
      this.broadcast({ t: 'x', code: exitCode });
      for (const ws of this.clients) ws.close();
      onExit(this, exitCode);
    });
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(s);
  }

  resizeTo(cols, rows) {
    cols = Math.floor(cols);
    rows = Math.floor(rows);
    if (!(cols >= 20 && rows >= 5 && cols <= 500 && rows <= 200)) return;
    if (cols === this.size.cols && rows === this.size.rows) return;
    this.size = { cols, rows };
    this.pty.resize(cols, rows);
    this.broadcast({ t: 's', ...this.size });
  }

  attach(ws) {
    this.clients.add(ws);
    ws.send(JSON.stringify({ t: 's', ...this.size }));
    ws.send(JSON.stringify({ t: 'o', d: this.scrollback }));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'i' && typeof m.d === 'string') {
        this.owner = ws;
        this.lastInputAt = Date.now();
        if (m.cols && m.rows) this.resizeTo(m.cols, m.rows);
        this.pty.write(m.d);
        if (m.d.includes('\r')) this.lastEnterAt = this.lastInputAt;
        this.onInput(this, m.d);
      } else if (m.t === 'r' && (this.owner === ws || this.owner === null)) {
        this.owner = ws;
        this.resizeTo(m.cols, m.rows);
      }
    });
    ws.on('close', () => {
      this.clients.delete(ws);
      if (this.owner === ws) this.owner = null;
    });
  }

  // Panelin kendi bildirimlerini oturumun giriş kutusuna yazar ve gönderir. Metin, terminalin yapıştırma
  // işaretleriyle sarılır; böylece içindeki satır sonları mesajı erken göndermez. Oturum meşgulse Claude
  // mesajı sıraya alır.
  paste(text) {
    const clean = String(text).replace(/\x1b/g, '');
    this.pastes.push({ t: Date.now(), text: clean });
    if (this.pastes.length > 5) this.pastes.shift();
    this.pty.write(`\x1b[200~${clean}\x1b[201~`);
    setTimeout(() => {
      try { this.pty.write('\r'); } catch {}
    }, 400);
  }

  // Çalışan turu Esc ile keser (kullanıcının "araya gir" mesajı için).
  interrupt() {
    try { this.pty.write('\x1b'); } catch {}
  }

  // Windows'ta ConPTY, açılışını bitirmeden kapatılırsa node-pty yerel kodu panel sürecini düşürüyor (0xC0000374,
  // yığın bozulması): açılıştan hemen sonra durdurulan oturum bütün paneli ve diğer oturumları kapatıyordu. Kapatma,
  // terminal ilk çıktısını verene (en çok KILL_WAIT) kadar ertelenir.
  // now: panel kapanırken beklemeden (süreç zaten bitiyor).
  kill(now = false) {
    if (this.killing && !now) return;
    this.killing = true;
    const go = () => { try { this.pty.kill(); } catch {} };
    const wait = this.firstDataAt ? Math.max(0, this.firstDataAt + KILL_SETTLE - Date.now()) : Math.max(0, this.startedAt + KILL_WAIT - Date.now());
    if (wait > 0 && !now) setTimeout(go, wait);
    else go();
  }
}

class SessionManager {
  constructor(shell, { env } = {}) {
    this.shell = shell;
    // Her oturuma verilen ortam değişkenleri; ayar dosyası oturuma özeldir ve açılışta verilir.
    this.env = env || {};
    this.map = new Map();
    this.exitListeners = [];
    this.inputListeners = [];
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

  launch({ id, name, cwd, configDir, shell, resume, permissionMode, model, effort, promptFile, taskFile, settingsFile, mcpConfig, addDir }) {
    if (this.map.has(id)) return this.map.get(id);
    const script = buildScript({ name, sessionId: id, resume, permissionMode, model, effort, promptFile, taskFile, settingsFile, mcpConfig, addDir });
    const s = new PtySession({
      id, name, cwd, configDir, shell: shell || this.shell, script, env: this.env,
      onInput: (sess, data) => {
        for (const fn of this.inputListeners) fn(sess, data);
      },
      onExit: (sess, code) => {
        this.map.delete(sess.id);
        for (const fn of this.exitListeners) fn(sess.id, code);
      },
    });
    this.map.set(id, s);
    return s;
  }

  stop(id) {
    const s = this.map.get(id);
    if (s) s.kill();
    return !!s;
  }

  stopAll() {
    for (const s of this.map.values()) s.kill(true);
  }
}

module.exports = { SessionManager, buildScript, psQuote };
