// Test düzeneği: paneli ayrı bir veri klasörü ve portla (varsayılan 7799) başlatır; canlı panelin (7788) verisine ve
// oturumlarına dokunmaz. Gerçek Claude oturumu açan testler hesap kotası harcar; bunlar e2e.js'te, en ucuz modelle.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
// Deponun kökü (app/'in bir üstü): e2e oturumları burada açılır; Claude Code güveni deponun kökünden sorar.
const REPO = path.join(ROOT, '..');
const PORT = Number(process.env.TEST_PANEL_PORT) || 7799;
const BASE = `http://127.0.0.1:${PORT}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Canlı ayarların kopyasıyla geçici veri klasörü: hesaplar, projeler, yetenekler ve rol klasörleri gerçek, gruplar boş.
// Canlı veride panelin kendi projesi yoksa (ör. veri sıfırlandıysa) testlerin kullandığı "maestro" projesi eklenir.
function makeDataDir(name = 'panel-test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  for (const f of ['settings.json', 'projects.json', 'caps.json']) {
    const src = path.join(ROOT, 'data', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
  const pf = path.join(dir, 'projects.json');
  const projects = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : [];
  if (!projects.some((p) => path.resolve(p.path) === path.resolve(REPO))) {
    projects.push({ id: 'test-maestro', name: 'maestro', path: REPO, addedAt: Date.now(), lastUsedAt: Date.now() });
    fs.writeFileSync(pf, JSON.stringify(projects, null, 2));
  }
  // Rol ve istem klasörü: Ayarlar'dan kayıt depodaki prompts/'a yazmasın diye kopya.
  fs.cpSync(path.join(ROOT, 'prompts'), path.join(dir, 'panel-prompts'), { recursive: true });
  return dir;
}

async function startPanel(dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'services', 'index.js')], {
    cwd: ROOT, env: { ...process.env, MAESTRO_DATA: dataDir, MAESTRO_PORT: String(PORT), MAESTRO_PROMPTS: path.join(dataDir, 'panel-prompts') }, windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.on('exit', (code, signal) => { log += `\n[panel süreci bitti: kod ${code}, sinyal ${signal}]`; });
  for (let i = 0; i < 50; i++) {
    if (/çalışıyor/.test(log)) break;
    if (child.exitCode != null) throw new Error(`panel açılmadı:\n${log}`);
    await wait(200);
  }
  if (!/çalışıyor/.test(log)) throw new Error(`panel 10 sn içinde açılmadı:\n${log}`);
  const token = fs.readFileSync(path.join(dataDir, 'token.txt'), 'utf8').trim();
  const api = async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: { 'x-panel-token': token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
    return j;
  };
  // Terminal ajanı ayrı süreç olarak başlar; oturum açan testler bağlanmasını bekler.
  for (let i = 0; i < 50; i++) {
    const st = await api('GET', '/api/state').catch(() => null);
    if (st && st.agent && st.agent.connected) break;
    await wait(200);
  }
  const stop = async () => {
    if (child.exitCode != null) return;
    // Ajan ayrı süreçtir; kapatma isteği onu da (ve açık oturumları) bitirir.
    try { await api('POST', '/api/shutdown'); } catch {}
    for (let i = 0; i < 10 && child.exitCode == null; i++) await wait(200);
    if (child.exitCode != null) return;
    child.kill();
    for (let i = 0; i < 25 && child.exitCode == null; i++) await wait(200);
  };
  return { child, api, stop, token, dataDir, log: () => log };
}

// Oturumun terminaline kullanıcı gibi yazar (WebSocket) ve Enter'a basar.
async function typeInto(token, sid, text) {
  const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${token}&s=${sid}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await wait(1000);
  for (const ch of text) { ws.send(JSON.stringify({ t: 'i', d: ch })); await wait(20); }
  await wait(400);
  ws.send(JSON.stringify({ t: 'i', d: '\r' }));
  await wait(300);
  ws.close();
}

// Ortak oturum kayıt klasöründe oturumun jsonl satırları.
function transcript(sid) {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, `${sid}.jsonl`);
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  return [];
}

async function until(fn, ms = 120000, step = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(step);
  }
}

module.exports = { ROOT, REPO, PORT, wait, makeDataDir, startPanel, typeInto, transcript, until };
