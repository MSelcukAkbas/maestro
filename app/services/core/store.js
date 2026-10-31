// JSON kayıt dosyaları: settings, projects, groups ve erişim anahtarı.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { APP_ROOT } = require('./paths');

// MAESTRO_DATA ile ayrı bir veri klasörü verilebilir (deneme amaçlı ikinci bir panel için).
const DATA_DIR = process.env.MAESTRO_DATA || path.join(APP_ROOT, 'data');
const PROMPT_DIR = path.join(DATA_DIR, 'prompts');
fs.mkdirSync(PROMPT_DIR, { recursive: true });

const HOME = os.homedir();

const DEFAULT_SETTINGS = {
  port: 7788,
  shell: 'pwsh.exe',
  // Bağlam yüzdesi için model ailesi başına pencere (token). Modelin gerçek sınırı farklıysa Ayarlar'dan düzeltilir.
  contextWindows: { opus: 1000000, sonnet: 1000000, haiku: 200000 },
  allowedDirs: [path.join(HOME, 'Desktop')],
  accounts: [
    { id: '32', name: 'claude32', configDir: path.join(HOME, '.claude'), color: 'blue' },
    { id: '37', name: 'claude37', configDir: path.join(HOME, '.claude-alt'), color: 'amber' },
    { id: 'selo', name: 'claudeselo', configDir: path.join(HOME, '.claude-alt2'), color: 'violet' },
  ],
};

function file(name) {
  return path.join(DATA_DIR, name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[store] ${name} okunamadı:`, err.message);
    return structuredClone(fallback);
  }
}

// Yarım yazılmış dosya kalmasın diye önce geçici dosyaya yazılır.
function writeJson(name, value) {
  const target = file(name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

// Yalnızca okuyan sık çağrılar (zamanlayıcılar, durum yanıtı) için: dosya değişmedikçe aynı nesne döner.
// Döndürülen listeyi değiştirme; değiştirilecekse loadGroups kullanılır.
let groupsView = null;
function viewGroups() {
  let st;
  try { st = fs.statSync(file('groups.json')); } catch { return []; }
  if (groupsView && groupsView.mtime === st.mtimeMs && groupsView.size === st.size) return groupsView.list;
  const list = readJson('groups.json', []);
  groupsView = { mtime: st.mtimeMs, size: st.size, list };
  return list;
}

// Roller settings.json'da tutulmaz (prompts/roles/, core/prompts.js); eski kayıttaki roller yok sayılır.
function loadSettings() {
  const saved = readJson('settings.json', null);
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...(saved || {}) };
  delete settings.roles;
  delete settings.roleDefaultsVersion;
  if (!saved) saveSettings(settings);
  return settings;
}

function saveSettings(settings) {
  const { roles, ...rest } = settings;
  writeJson('settings.json', rest);
}

function loadToken() {
  const p = file('token.txt');
  try {
    const t = fs.readFileSync(p, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {}
  return rotateToken();
}

function rotateToken() {
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file('token.txt'), t, 'utf8');
  return t;
}

module.exports = {
  DATA_DIR,
  PROMPT_DIR,
  readJson,
  writeJson,
  loadSettings,
  saveSettings,
  loadProjects: () => readJson('projects.json', []),
  saveProjects: (p) => writeJson('projects.json', p),
  loadGroups: () => readJson('groups.json', []),
  viewGroups,
  saveGroups: (g) => { writeJson('groups.json', g); groupsView = null; },
  loadToken,
  rotateToken,
};
