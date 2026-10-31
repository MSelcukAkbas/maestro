// Rol yetenekleri: panelle gelen skill'ler (depodaki skills/) ve hesaplarda global kurulu olanlar (eklenti, skill, MCP).
// Panel skill'leri yalnızca işaretlenen rollerin oturumlarına verilir; global olanlar rol bazında kapatılabilir.
// Hiçbiri hesapların kendi ayarlarına yazılmaz; her şey oturum açılırken ona özel dosyalarla verilir.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { APP_ROOT } = require('../core/paths');
const prompts = require('../core/prompts');

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Panelin görev panosu sunucusu; hesaplardaki listede gösterilmez ve hiçbir rolde kapatılmaz.
const RESERVED_MCP = 'panel';
// claude.ai hesabından eşitlenen skill'lerin listedeki öneki; skillOverrides tam adla ("anthropic-skills:docs") kapatır.
const SYNCED_PREFIX = 'anthropic-skills';
// Panelle gelen skill'ler: depodaki skills/ klasörü (sürüm kontrolünde, panelden salt okunur). Hangi rollere verildiği
// rol klasöründe (prompts/roles/<id>/role.json "skills"); panelden yapılan rol değişikliği de oraya yazılır.
const BUILTIN_DIR = path.join(APP_ROOT, 'skills');
const ROLE_SKILLS = { map: () => prompts.skillRoles(), set: (name, roles) => prompts.setSkillRoles(name, roles) };

class CapError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Claude Code MCP tool adlarında sunucu adının harf, rakam, _ ve - dışındaki karakterleri _ olur.
function mcpPrefix(name) {
  return `mcp__${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

// MCP ayarlarındaki ${VAR} ve ${VAR:-varsayılan} yazımı; Claude Code da aynı şekilde açar.
function expandEnv(s, env = process.env) {
  return String(s).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (all, name, def) => {
    const v = env[name];
    if (v != null && v !== '') return v;
    return def != null ? def : all;
  });
}

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// SKILL.md başındaki --- arasındaki name / description.
function skillMeta(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  lines.forEach((line, i) => {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (!kv) return;
    let v = kv[2].trim();
    // Çok satırlı YAML değeri (description: > ya da |): girintili sonraki satırlar.
    if (/^[>|][-+]?$/.test(v) || v === '') {
      const more = [];
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) more.push(lines[j].trim());
      v = more.join(' ');
    }
    out[kv[1]] = v.replace(/^["']|["']$/g, '');
  });
  return out;
}

class Caps {
  // roleSkills: { map() -> { skillAdı: [rolId] }, set(skillAdı, [rolId]) } — depodaki skill'lerin rolleri (testler verir).
  constructor(dataDir, builtinDir = BUILTIN_DIR, roleSkills = ROLE_SKILLS) {
    this.file = path.join(dataDir, 'caps.json');
    this.builtinDir = builtinDir;
    this.roleSkills = roleSkills;
    this.sessionDir = path.join(dataDir, 'session-skills');
    // () -> proje klasörleri; proje skill'lerini yerleşiklerden ayırmak için (index.js verir).
    this.projectDirs = null;
  }

  // Depodaki skill'ler: [{ name, description, defaults }]. defaults: skill'in rol klasörlerinde açık olduğu roller.
  builtins() {
    const defaults = this.roleSkills.map();
    let dirs = [];
    try { dirs = fs.readdirSync(this.builtinDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch {}
    const out = [];
    for (const name of dirs) {
      if (!SKILL_NAME.test(name)) continue;
      let text;
      try { text = fs.readFileSync(path.join(this.builtinDir, name, 'SKILL.md'), 'utf8'); } catch { continue; }
      const meta = skillMeta(text);
      if (!meta.description) continue;
      out.push({ name, description: meta.description, defaults: Array.isArray(defaults[name]) ? defaults[name] : [] });
    }
    return out;
  }

  // { skills: [{ name, description, roles, defaults }], globalOff: { key: [roleId] },
  //   seen: { skillAdı: { chars, description, at } } — oturumların skill listesinde görülen her skill (kapatılan da kalır) }
  // skills: depodaki skill'ler; roles = rol klasörlerindeki atama (defaults ile başlar, setRole değiştirir).
  load() {
    const c = readJsonFile(this.file) || {};
    const skills = this.builtins().map((b) => ({ name: b.name, description: b.description, roles: [...b.defaults], defaults: b.defaults }));
    return { skills, globalOff: c.globalOff || {}, seen: c.seen || {} };
  }

  // Oturum kaydındaki skill_listing eki: { names, content }. content satırları "- ad: açıklama" biçimindedir;
  // satırın uzunluğu skill'in her istekte bağlama eklediği metindir.
  learnSkills(att) {
    if (!att || !Array.isArray(att.names) || typeof att.content !== 'string') return false;
    const lines = att.content.split(/\n(?=- )/);
    const c = this.load();
    let changed = false;
    for (const name of att.names) {
      if (typeof name !== 'string' || !name) continue;
      const line = lines.find((l) => l === `- ${name}` || l.startsWith(`- ${name}: `));
      if (!line) continue;
      const description = line.slice(name.length + 4).trim().slice(0, 400);
      const cur = c.seen[name];
      if (cur && cur.chars === line.length && cur.description === description) continue;
      c.seen[name] = { chars: line.length, description, at: Date.now() };
      changed = true;
    }
    if (changed) this.save(c);
    return changed;
  }

  // Açılışta: son oturum kayıtlarının başındaki skill listeleri (panel kapalıyken açılmış oturumlar da kataloğa girsin).
  learnFromTranscripts(projectsDir, limit = 30) {
    const files = [];
    try {
      for (const d of fs.readdirSync(projectsDir)) {
        let names = [];
        try { names = fs.readdirSync(path.join(projectsDir, d)); } catch { continue; }
        for (const n of names) {
          if (!n.endsWith('.jsonl')) continue;
          const f = path.join(projectsDir, d, n);
          try { files.push({ f, t: fs.statSync(f).mtimeMs }); } catch {}
        }
      }
    } catch { return; }
    for (const { f } of files.sort((a, b) => b.t - a.t).slice(0, limit)) {
      let head = '';
      try {
        const fd = fs.openSync(f, 'r');
        const buf = Buffer.alloc(1024 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        head = buf.toString('utf8', 0, n);
      } catch { continue; }
      for (const line of head.split('\n')) {
        if (!line.includes('"skill_listing"')) continue;
        try {
          const j = JSON.parse(line);
          if (j.type === 'attachment' && j.attachment && j.attachment.type === 'skill_listing') this.learnSkills(j.attachment);
        } catch {}
      }
    }
  }

  // Skill'ler caps.json'a yazılmaz; rolleri değiştiyse rol klasörlerine yazılır. caps.json yalnızca globalOff ve seen tutar.
  save(c) {
    for (const s of c.skills || []) {
      const same = s.roles.length === s.defaults.length && s.roles.every((r) => s.defaults.includes(r));
      if (!same) this.roleSkills.set(s.name, s.roles);
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ globalOff: c.globalOff, seen: c.seen }, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  // Hesapların kendi kurulumundaki eklentiler, kişisel skill'ler ve MCP sunucuları. Anahtar türü ve adı taşır:
  // plugin:<ad@pazar>, skill:<ad>, mcp:<ad>. Aynı öğe birden çok hesapta varsa hesap listesi birleşir.
  inventory(accounts) {
    const items = new Map();
    const add = (key, base, accountId) => {
      const cur = items.get(key) || { key, ...base, accounts: [] };
      if (!cur.accounts.includes(accountId)) cur.accounts.push(accountId);
      if (!cur.description && base.description) cur.description = base.description;
      items.set(key, cur);
    };
    for (const a of accounts) {
      const dir = a.configDir;
      const st = readJsonFile(path.join(dir, 'settings.json')) || {};
      const installed = (readJsonFile(path.join(dir, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
      for (const [id, on] of Object.entries(st.enabledPlugins || {})) {
        if (!on) continue;
        let description = '';
        let hooks = false;
        const inst = (installed[id] || [])[0];
        if (inst && inst.installPath) {
          const pj = readJsonFile(path.join(inst.installPath, '.claude-plugin', 'plugin.json')) || {};
          description = pj.description || '';
          // Kancası olan eklenti kapatılınca yalnızca bağlam değil, arka planda yaptığı iş de durur (ör. hafıza kaydı).
          hooks = !!pj.hooks || fs.existsSync(path.join(inst.installPath, 'hooks', 'hooks.json'));
        }
        add(`plugin:${id}`, { kind: 'plugin', name: id.split('@')[0], id, description, hooks }, a.id);
      }
      let skillNames = [];
      try { skillNames = fs.readdirSync(path.join(dir, 'skills')); } catch {}
      for (const n of skillNames) {
        let text;
        try { text = fs.readFileSync(path.join(dir, 'skills', n, 'SKILL.md'), 'utf8'); } catch { continue; }
        const meta = skillMeta(text);
        add(`skill:${meta.name || n}`, { kind: 'skill', name: meta.name || n, description: meta.description || '' }, a.id);
      }
      const cj = readJsonFile(path.join(dir, '.claude.json')) || {};
      for (const [n, cfg] of Object.entries(cj.mcpServers || {})) {
        if (n === RESERVED_MCP) continue;
        const description = cfg.url ? cfg.url : [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' ');
        add(`mcp:${n}`, { kind: 'mcp', name: n, description, config: cfg }, a.id);
      }
    }
    // Oturumlarda görülen skill'ler: Claude Code'un yerleşik skill'leri (bundled) ve claude.ai'den gelenler (synced,
    // "kaynak:ad"). Eklenti skill'i tek tek kapatılamaz (skillOverrides eklentiye işlemez); boyutu eklentiye yazılır.
    // chars: listede her istekte bağlama giren metin; token ≈ chars / 3 (ölçüm: 16,2k karakter ≈ 5,4k token).
    const c = this.load();
    const panelSkills = new Set(c.skills.map((s) => s.name));
    const all = accounts.map((a) => a.id);
    // Proje klasörlerindeki .claude/skills: yalnızca o projede açılan oturumlarda görünür.
    const projectSkills = new Map();
    for (const dir of this.projectDirs ? this.projectDirs() : []) {
      try {
        for (const n of fs.readdirSync(path.join(dir, '.claude', 'skills'))) projectSkills.set(n, [...(projectSkills.get(n) || []), dir]);
      } catch {}
    }
    for (const [name, s] of Object.entries(c.seen)) {
      if (panelSkills.has(name)) continue;
      const own = items.get(`skill:${name}`);
      if (own) {
        own.chars = s.chars;
        continue;
      }
      const pfx = name.includes(':') ? name.split(':')[0] : null;
      const plugin = pfx && [...items.values()].find((x) => x.kind === 'plugin' && x.name === pfx);
      if (plugin) {
        plugin.chars = (plugin.chars || 0) + s.chars;
        plugin.skills = [...(plugin.skills || []), name];
        continue;
      }
      // Önekli olup eklentisi açık olmayan skill (kapalı eklenti): panelden ayrıca kapatılamaz, listelenmez.
      if (pfx && pfx !== SYNCED_PREFIX) continue;
      const kind = pfx ? 'synced' : projectSkills.has(name) ? 'project' : 'bundled';
      items.set(`skill:${name}`, { key: `skill:${name}`, kind, name, description: s.description, chars: s.chars, accounts: all, ...(kind === 'project' ? { projects: projectSkills.get(name) } : {}) });
    }
    return [...items.values()].sort((x, y) => x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name));
  }

  // ---------- rol ataması ----------

  // Panel skill'inde roles = açık roller; global olanda globalOff[key] = kapalı roller.
  setRole(key, roleId, on) {
    const c = this.load();
    const flip = (list, add) => {
      const s = new Set(list || []);
      if (add) s.add(roleId); else s.delete(roleId);
      return [...s];
    };
    const [kind, ...rest] = String(key).split(':');
    const id = rest.join(':');
    if (kind === 'pskill') {
      const item = c.skills.find((x) => x.name === id);
      if (!item) throw new CapError(404, 'Yetenek bulunamadı.');
      item.roles = flip(item.roles, on);
    } else if (['plugin', 'skill', 'mcp'].includes(kind) && id) {
      c.globalOff[key] = flip(c.globalOff[key], !on);
      if (!c.globalOff[key].length) delete c.globalOff[key];
    } else throw new CapError(400, 'Geçersiz yetenek anahtarı.');
    this.save(c);
    return c;
  }

  // Rol silinince atamalarda kalan adı temizlenir.
  pruneRoles(roleIds) {
    const c = this.load();
    const keep = (list) => (list || []).filter((r) => roleIds.includes(r));
    for (const s of c.skills) s.roles = keep(s.roles);
    for (const k of Object.keys(c.globalOff)) {
      c.globalOff[k] = keep(c.globalOff[k]);
      if (!c.globalOff[k].length) delete c.globalOff[k];
    }
    this.save(c);
  }

  // Bir rolün varsayılan olarak aldığı yetenek anahtarları (global olanlar: kapatılmadıysa açık; panel skill'leri: işaretliyse).
  // Anlık rol (custom) yalnızca global yetenekleri alır.
  roleKeys(roleId, inventory) {
    const c = this.load();
    const on = inventory.filter((x) => !(c.globalOff[x.key] || []).includes(roleId)).map((x) => x.key);
    for (const k of c.skills) if (k.roles.includes(roleId)) on.push(`pskill:${k.name}`);
    return on;
  }

  // Oturum açılırken: ayar dosyasına eklenecekler ve --add-dir klasörü.
  // Skill'ler oturuma özel bir klasöre kopyalanır; depoda sonradan değişen skill bir sonraki açılışta gelir.
  // override: kurulumda bu oturum için rol varsayılanının üstüne açılan / kapatılan anahtarlar ({ on: [], off: [] }).
  forSession(sessionId, roleId, override) {
    const c = this.load();
    const on = new Set((override && override.on) || []);
    const off = new Set((override && override.off) || []);
    const settings = { enabledPlugins: {}, skillOverrides: {}, deny: [], allow: [] };
    const globalKeys = new Set([...Object.keys(c.globalOff), ...off].filter((k) => /^(plugin|skill|mcp):/.test(k)));
    for (const key of globalKeys) {
      if (on.has(key) || !(off.has(key) || (c.globalOff[key] || []).includes(roleId))) continue;
      const [kind, ...rest] = key.split(':');
      const id = rest.join(':');
      if (kind === 'plugin') settings.enabledPlugins[id] = false;
      else if (kind === 'skill') settings.skillOverrides[id] = 'off';
      else if (kind === 'mcp' && id !== RESERVED_MCP) settings.deny.push(mcpPrefix(id));
    }
    const panelOn = (key, roles) => !off.has(key) && (on.has(key) || roles.includes(roleId));
    const dir = path.join(this.sessionDir, sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
    const skills = c.skills.filter((s) => panelOn(`pskill:${s.name}`, s.roles));
    let addDir = null;
    for (const s of skills) {
      const src = path.join(this.builtinDir, s.name);
      if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue;
      fs.cpSync(src, path.join(dir, '.claude', 'skills', s.name), { recursive: true });
      addDir = dir;
    }
    return { settings, addDir };
  }
}

// ---------- "Dene": sunucuya bağlanıp tool listesini çekme ----------

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'maestro-test', version: '1' } },
};
const TEST_TIMEOUT = 20000;

function killTree(child) {
  if (!child || child.exitCode != null) return;
  execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
}

function testStdio(cfg) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const [k, v] of Object.entries(cfg.env || {})) env[k] = expandEnv(v);
    let child;
    const started = Date.now();
    let stderr = '';
    let buf = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree(child);
      resolve({ ...r, ms: Date.now() - started, stderr: stderr.trim().slice(-1500) });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `${TEST_TIMEOUT / 1000} saniyede yanıt gelmedi.` }), TEST_TIMEOUT);
    const command = expandEnv(cfg.command);
    const args = (cfg.args || []).map((a) => expandEnv(a));
    // npx gibi .cmd komutları Windows'ta doğrudan açılamaz; o durumda cmd.exe üzerinden denenir.
    const start = (viaCmd) => {
      try {
        child = viaCmd
          ? spawn('cmd.exe', ['/d', '/c', command, ...args], { env, windowsHide: true })
          : spawn(command, args, { env, windowsHide: true });
      } catch (err) {
        if (!viaCmd) return start(true);
        return finish({ ok: false, error: err.message });
      }
      const c = child;
      c.stdin.on('error', () => {});
      c.on('error', (err) => {
        if (c !== child) return;
        if (!viaCmd && (err.code === 'ENOENT' || err.code === 'EINVAL')) return start(true);
        finish({ ok: false, error: err.message });
      });
      c.on('exit', (code) => setTimeout(() => {
        if (c === child) finish({ ok: false, error: `Sunucu kapandı (çıkış kodu ${code}).` });
      }, 200));
      child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-10000); });
      child.stdout.on('data', onData);
      send(INIT);
    };
    const send = (msg) => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch {} };
    const onData = (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) return finish({ ok: false, error: msg.error.message || 'initialize hatası' });
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) return finish({ ok: false, error: msg.error.message || 'tools/list hatası' });
          return finish({ ok: true, tools: (msg.result && msg.result.tools || []).map((t) => t.name) });
        }
      }
    };
    start(false);
  });
}

// Streamable HTTP: yanıt düz JSON ya da olay akışı (text/event-stream) olabilir.
async function testHttp(cfg) {
  const started = Date.now();
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const [k, v] of Object.entries(cfg.headers || {})) headers[k] = expandEnv(v);
  const url = expandEnv(cfg.url);
  const call = async (msg) => {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(TEST_TIMEOUT) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) headers['mcp-session-id'] = sid;
    if (msg.id == null) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 ? ' (yetki: header / token eksik ya da yanlış)' : ''}`);
    const text = await res.text();
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        try {
          const m = JSON.parse(line.slice(5).trim());
          if (m.id === msg.id) return m;
        } catch {}
      }
      throw new Error('Olay akışında yanıt bulunamadı.');
    }
    return JSON.parse(text);
  };
  try {
    const init = await call(INIT);
    if (init.error) throw new Error(init.error.message || 'initialize hatası');
    await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    if (list.error) throw new Error(list.error.message || 'tools/list hatası');
    return { ok: true, tools: (list.result && list.result.tools || []).map((t) => t.name), ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? `${TEST_TIMEOUT / 1000} saniyede yanıt gelmedi.` : err.message, ms: Date.now() - started };
  }
}

function testMcp(cfg) {
  return cfg.type === 'http' || (cfg.url && !cfg.command) ? testHttp(cfg) : testStdio(cfg);
}

module.exports = { Caps, CapError, testMcp, mcpPrefix, RESERVED_MCP };
