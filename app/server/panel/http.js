// HTTP sunucusu ve WebSocket: statik dosyalar, erişim anahtarı denetimi, yönlendirme (route), oturumların hook ve
// MCP çağrıları, terminal akışı ve durum kanalı. start() çağrılana kadar dinlemez.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const store = require('../core/store');
const { MODELS } = require('../core/options');
const { handleMcp, resolveMember } = require('../team/board');
const { NOTE_TOOLS, NOTE_LEAD_TOOLS, CURATOR_TOOLS, CURATOR, callNoteTool, callCuratorTool } = require('../team/notes');
const { DOC_TOOL, callDocTool } = require('../team/docs');
const { TOOL_STATUS, LEAD_TOOLS, callTeamTool } = require('../team/team');
const { DEVIR_TOOL } = require('../watch/ops');
const {
  ROOT, PORT, settings, currentToken, hookState, manager, boards, notes, requests, meter, presence, ops,
  HttpError, findSession, cachedQuota, shutdown, warmStats,
} = require('./context');
const { boardDelivery } = require('./delivery');
const { memberRows, roleCaps, capCatalogFor } = require('./members');
const { buildState } = require('./state');
const assistant = require('./assistant');

const STATIC = {
  '/': ['web/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['web/index.html', 'text/html; charset=utf-8'],
  '/js/core.js': ['web/js/core.js', 'text/javascript; charset=utf-8'],
  '/js/projects.js': ['web/js/projects.js', 'text/javascript; charset=utf-8'],
  '/js/setup.js': ['web/js/setup.js', 'text/javascript; charset=utf-8'],
  '/js/work.js': ['web/js/work.js', 'text/javascript; charset=utf-8'],
  '/js/improve.js': ['web/js/improve.js', 'text/javascript; charset=utf-8'],
  '/js/assistant.js': ['web/js/assistant.js', 'text/javascript; charset=utf-8'],
  '/js/settings.js': ['web/js/settings.js', 'text/javascript; charset=utf-8'],
  '/js/bekci.js': ['web/js/bekci.js', 'text/javascript; charset=utf-8'],
  '/js/topbar.js': ['web/js/topbar.js', 'text/javascript; charset=utf-8'],
  '/js/main.js': ['web/js/main.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['web/style.css', 'text/css; charset=utf-8'],
  '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
  '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, max = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, 'İstek çok büyük.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Geçersiz JSON.')); }
    });
    req.on('error', reject);
  });
}

function allowedHosts() {
  return [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
}

function tokenOk(given) {
  const token = currentToken();
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

// ---------- yönlendirme ----------

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, re: new RegExp(`^${pattern}$`), handler });
}

// ---------- sunucu ----------

const server = http.createServer(async (req, res) => {
  if (!allowedHosts().includes(req.headers.host)) {
    res.writeHead(421);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [rel, type] = STATIC[url.pathname];
    try {
      const data = fs.readFileSync(path.join(ROOT, rel));
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return res.end(data);
    } catch {
      res.writeHead(404);
      return res.end();
    }
  }

  if (!url.pathname.startsWith('/api/')) {
    res.writeHead(404);
    return res.end();
  }
  // Oturumların hook bildirimleri: kendi anahtarıyla gelir. Boş 2xx yanıt Claude'un akışını değiştirmez.
  if (url.pathname === '/api/hook' && req.method === 'POST') {
    if (!hookState.tokenOk(req.headers['x-panel-hook-token'])) return sendJson(res, 401, { error: 'Hook anahtarı geçersiz.' });
    try {
      // PostToolUse büyük tool çıktısını da taşır; reddedilirse oturumun terminalinde hook hatası görünür.
      const body = await readBody(req, 64_000_000);
      if (process.env.CLAUDE_PANEL_HOOK_DEBUG) console.log('[hook]', Date.now(), JSON.stringify({ ...body, tool_response: undefined, last_assistant_message: undefined, transcript_path: undefined, cwd: undefined, scratchpad_dir: undefined, session_id: undefined }).slice(0, 500));
      if (manager.has(body.session_id)) {
        hookState.handle(body);
        if (body.hook_event_name === 'UserPromptSubmit') {
          const found = findSession(store.loadGroups(), body.session_id);
          if (found) presence.prompt(body.session_id, body.prompt, manager.get(body.session_id), { name: found.session.name, group: found.group.name, role: found.session.roleLabel, gid: found.group.id, roleId: found.session.roleId });
        }
        const out = boardDelivery(body);
        if (out) return sendJson(res, 200, out);
      }
    } catch (err) {
      console.error('[panel] hook:', err.message);
    }
    res.writeHead(204);
    return res.end();
  }
  // Ekip üyelerinin görev panosu tool'ları (MCP, yalnızca JSON yanıtlı Streamable HTTP).
  const mcp = url.pathname.match(/^\/api\/mcp\/([\w-]+)$/);
  if (mcp) {
    if (!hookState.tokenOk(req.headers['x-panel-hook-token'])) return sendJson(res, 401, { error: 'Hook anahtarı geçersiz.' });
    // Sunucudan istemciye ayrı bir olay akışı yok.
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      return res.end();
    }
    try {
      const msg = await readBody(req);
      // Not düzenleyicinin adresi: curator-<grup>; yalnızca not tool'ları.
      const cur = mcp[1].match(/^curator-([\w-]+)$/);
      if (cur) {
        const g = store.loadGroups().find((x) => x.id === cur[1]);
        if (!g) return sendJson(res, 404, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32001, message: 'Grup bulunamadı.' } });
        const reply = await handleMcp(boards, g, CURATOR, msg, { tools: CURATOR_TOOLS, only: true, call: async (name, args) => callCuratorTool(notes, g, name, args) });
        if (!reply) {
          res.writeHead(202);
          return res.end();
        }
        return sendJson(res, 200, reply);
      }
      // Panel asistanının adresi: kendi oturum kimliği; yalnızca asistan tool'ları.
      if (assistant.isAssistant(mcp[1])) {
        const reply = await assistant.handle(msg);
        if (!reply) {
          res.writeHead(202);
          return res.end();
        }
        return sendJson(res, 200, reply);
      }
      const found = findSession(store.loadGroups(), mcp[1]);
      if (!found) return sendJson(res, 404, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32001, message: 'Oturum bir panel grubunda değil.' } });
      const isLead = found.session.roleId === 'sef';
      const ctx = {
        group: found.group, sid: mcp[1], isLead, requests, roles: settings.roles, accounts: settings.accounts, models: MODELS, resolveMember,
        memberRows: () => memberRows(found.group), quota: () => cachedQuota(), roleCaps, meterRate: (id, kind) => meter.rate(id, kind),
        capCatalog: () => capCatalogFor(found.group),
      };
      const reply = await handleMcp(boards, found.group, mcp[1], msg, {
        tools: [...NOTE_TOOLS, DOC_TOOL, TOOL_STATUS, DEVIR_TOOL, assistant.REPLY_TOOL, ...(isLead ? [...LEAD_TOOLS, ...NOTE_LEAD_TOOLS] : [])],
        call: async (name, args) => {
          if (name === DEVIR_TOOL.name) return ops.handoff(mcp[1], args);
          if (name === assistant.REPLY_TOOL.name) return assistant.reply(mcp[1], args);
          if (name === DOC_TOOL.name) return callDocTool(store.loadProjects().find((p) => p.id === found.group.projectId), args);
          const r = callNoteTool(notes, found.group, mcp[1], name, args, resolveMember);
          return r !== undefined ? r : callTeamTool(ctx, name, args);
        },
      });
      if (!reply) {
        res.writeHead(202);
        return res.end();
      }
      return sendJson(res, 200, reply);
    } catch (err) {
      return sendJson(res, err.status || 500, { jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message } });
    }
  }
  if (!tokenOk(req.headers['x-panel-token'])) return sendJson(res, 401, { error: 'Erişim anahtarı geçersiz.' });

  // Arayüz durumu kendiliğinden yineler; yalnızca değişiklik isteyen çağrılar kullanıcı teması sayılır.
  if (req.method !== 'GET') presence.touch(`${req.method} ${url.pathname.replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, '/:id')}`);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    try {
      return sendJson(res, 200, await r.handler(req, m));
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('[panel]', err);
      return sendJson(res, status, { error: err.message || 'Sunucu hatası.' });
    }
  }
  sendJson(res, 404, { error: 'Bulunamadı.' });
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ req }) => {
    if (!allowedHosts().includes(req.headers.host)) return false;
    const origin = req.headers.origin;
    // Tarayıcı dışı istemcide (attach.js) origin olmaz; tarayıcıda yalnızca panelin kendi adresi.
    if (origin && !allowedHosts().some((h) => origin === `http://${h}`)) return false;
    const url = new URL(req.url, `http://${req.headers.host}`);
    return tokenOk(url.searchParams.get('t'));
  },
});

// Durum kanalı (?ch=state): arayüz iki saniyede bir yoklamak yerine durum değişince tam yanıtı alır.
// Değişiklik saniyede bir denetlenir; kimse bağlı değilse durum hiç kurulmaz.
const stateClients = new Set();
let stateSent = '';
function pushState() {
  if (!stateClients.size) return;
  let json;
  try { json = JSON.stringify({ t: 'state', d: buildState() }); } catch (err) { console.error('[panel] durum:', err.message); return; }
  if (json === stateSent) return;
  stateSent = json;
  for (const ws of stateClients) if (ws.readyState === 1) ws.send(json);
}
// Asistanın ekrani_ac tool'u: bağlı arayüzleri verilen adrese yönlendirir.
assistant.setNav((hash) => {
  let sent = false;
  for (const ws of stateClients) {
    if (ws.readyState !== 1) continue;
    ws.send(JSON.stringify({ t: 'nav', hash }));
    sent = true;
  }
  return sent;
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.searchParams.get('ch') === 'state') {
    stateClients.add(ws);
    ws.on('close', () => stateClients.delete(ws));
    ws.on('error', () => stateClients.delete(ws));
    // Yeni bağlanan hemen güncel durumu alır.
    try { ws.send(JSON.stringify({ t: 'state', d: buildState() })); } catch {}
    return;
  }
  const s = manager.get(url.searchParams.get('s'));
  if (!s) {
    ws.send(JSON.stringify({ t: 'x', code: null }));
    return ws.close();
  }
  s.attach(ws);
});

function start() {
  setInterval(pushState, 1000);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Windows'ta konsol penceresi kapatılınca gelir.
  process.on('SIGHUP', shutdown);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} kullanımda; panel zaten çalışıyor olabilir. Tarayıcıda http://127.0.0.1:${PORT} adresini aç.`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(PORT, '127.0.0.1', () => {
    warmStats();
    const url = `http://127.0.0.1:${PORT}/?t=${currentToken()}`;
    console.log(`Claude Panel çalışıyor: ${url}`);
    console.log('Bu pencereyi kapatırsan paneldeki oturumlar da kapanır.');
    if (process.argv.includes('--open')) spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
  });
}

module.exports = { route, readBody, start };
