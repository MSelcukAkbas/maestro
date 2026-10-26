// Rol yetenekleri: panelden eklenen MCP sunucuları ve skill'ler ile hesaplarda global kurulu olanlar.
// Panel yetenekleri yalnızca işaretlenen rollerin oturumlarına verilir; global olanlar rol bazında kapatılabilir.
// Hiçbiri hesapların kendi ayarlarına yazılmaz; her şey oturum açılırken ona özel dosyalarla verilir.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { APP_ROOT } = require('../core/paths');

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
// Panelin görev panosu sunucusu; bu ad panel MCP'lerine verilemez ve hiçbir rolde kapatılmaz.
const RESERVED_MCP = 'panel';
// claude.ai hesabından eşitlenen skill'lerin listedeki öneki; skillOverrides tam adla ("anthropic-skills:docs") kapatır.
const SYNCED_PREFIX = 'anthropic-skills';
// Panelle gelen skill'ler: depodaki skills/ klasörü (sürüm kontrolünde, panelden salt okunur). Varsayılan roller
// skills/roles.json'da; kullanıcının rol değişikliği caps.json builtinRoles'a varsayılandan fark olarak yazılır.
const BUILTIN_DIR = path.join(APP_ROOT, 'skills');
const READ_ONLY = 'Panelle gelen skill salt okunur; değişiklik depodaki skills/ klasöründe yapılır.';

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
  constructor(dataDir, builtinDir = BUILTIN_DIR) {
    this.file = path.join(dataDir, 'caps.json');
    this.skillDir = path.join(dataDir, 'skills');
    this.builtinDir = builtinDir;
    this.sessionDir = path.join(dataDir, 'session-skills');
    // () -> proje klasörleri; proje skill'lerini yerleşiklerden ayırmak için (index.js verir).
    this.projectDirs = null;
    fs.mkdirSync(this.skillDir, { recursive: true });
  }

  // Depodaki skill'ler: [{ name, description, defaults }]. defaults: roles.json'daki varsayılan roller.
  builtins() {
    const defaults = readJsonFile(path.join(this.builtinDir, 'roles.json')) || {};
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

  isBuiltin(name) {
    return this.load().skills.some((s) => s.name === name && s.builtin);
  }

  // { mcps: [{ id, name, type, command, args, env, url, headers, autoAllow, roles }],
  //   skills: [{ name, description, roles, builtin?, defaults? }], globalOff: { key: [roleId] },
  //   seen: { skillAdı: { chars, description, at } } — oturumların skill listesinde görülen her skill (kapatılan da kalır) }
  // skills önce depodaki (builtin, roller = varsayılan + builtinRoles farkı), sonra kullanıcının eklediği skill'ler.
  // Aynı adda kullanıcı skill'i daha önceden varsa o kalır, depodaki gizlenir (kullanıcının skill'i kaybolmasın).
  load() {
    const c = readJsonFile(this.file) || {};
    const user = (c.skills || []).filter((s) => !s.builtin);
    const over = c.builtinRoles || {};
    const builtin = this.builtins().filter((b) => !user.some((u) => u.name === b.name)).map((b) => {
      const o = over[b.name] || {};
      const roles = [...new Set([...b.defaults, ...(o.on || [])])].filter((r) => !(o.off || []).includes(r));
      return { name: b.name, description: b.description, roles, builtin: true, defaults: b.defaults };
    });
    return { mcps: c.mcps || [], skills: [...builtin, ...user], globalOff: c.globalOff || {}, seen: c.seen || {} };
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

  // Depodaki skill'ler dosyaya yazılmaz; yalnızca rollerinin varsayılandan farkı builtinRoles'a girer.
  save(c) {
    const builtinRoles = {};
    const skills = [];
    for (const s of c.skills || []) {
      if (!s.builtin) { skills.push(s); continue; }
      const on = s.roles.filter((r) => !s.defaults.includes(r));
      const off = s.defaults.filter((r) => !s.roles.includes(r));
      if (on.length || off.length) builtinRoles[s.name] = { ...(on.length ? { on } : {}), ...(off.length ? { off } : {}) };
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...c, skills, builtinRoles }, null, 2), 'utf8');
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

  // ---------- panel MCP'leri ----------

  // globalNames: hesaplardaki MCP adları; aynı ad, rolde global olanı kapatınca panel kopyasını da gizlerdi.
  cleanMcp(body, existingId, globalNames = []) {
    const name = String(body.name || '').trim();
    if (!MCP_NAME.test(name)) throw new CapError(400, 'MCP adı harf ya da rakamla başlamalı; yalnızca harf, rakam, _ ve - içerebilir.');
    if (name === RESERVED_MCP) throw new CapError(400, '"panel" adı panelin görev panosu sunucusuna ayrılmış.');
    const c = this.load();
    if (c.mcps.some((m) => m.name === name && m.id !== existingId)) throw new CapError(409, `"${name}" adında bir MCP zaten var.`);
    if (globalNames.includes(name)) throw new CapError(409, `"${name}" hesaplarda global olarak kurulu; panel MCP'sine başka bir ad ver.`);
    const type = body.type === 'http' ? 'http' : 'stdio';
    const pairs = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {})
      .map(([k, v]) => [String(k).trim(), String(v)]).filter(([k]) => k));
    const out = { name, type, autoAllow: !!body.autoAllow };
    if (type === 'stdio') {
      out.command = String(body.command || '').trim();
      if (!out.command) throw new CapError(400, 'Komut gerekli.');
      out.args = (Array.isArray(body.args) ? body.args : []).map(String).filter((s) => s !== '');
      out.env = pairs(body.env);
    } else {
      out.url = String(body.url || '').trim();
      if (!/^https?:\/\//i.test(out.url)) throw new CapError(400, 'Adres http:// ya da https:// ile başlamalı.');
      out.headers = pairs(body.headers);
    }
    return out;
  }

  addMcp(body, globalNames) {
    const m = { id: crypto.randomUUID(), ...this.cleanMcp(body, null, globalNames), roles: [] };
    const c = this.load();
    c.mcps.push(m);
    this.save(c);
    return m;
  }

  updateMcp(id, body, globalNames) {
    const c = this.load();
    const i = c.mcps.findIndex((m) => m.id === id);
    if (i < 0) throw new CapError(404, 'MCP bulunamadı.');
    c.mcps[i] = { ...c.mcps[i], ...this.cleanMcp(body, id, globalNames) };
    this.save(c);
    return c.mcps[i];
  }

  removeMcp(id) {
    const c = this.load();
    c.mcps = c.mcps.filter((m) => m.id !== id);
    this.save(c);
    return { ok: true };
  }

  // ---------- panel skill'leri ----------

  skillPath(name) {
    if (!SKILL_NAME.test(name)) throw new CapError(400, 'Skill adı küçük harf, rakam ve - içermeli (ör. android-sdk).');
    return path.join(this.skillDir, name);
  }

  readSkill(name) {
    const s = this.load().skills.find((x) => x.name === name);
    if (!s) throw new CapError(404, 'Skill bulunamadı.');
    const dir = s.builtin ? path.join(this.builtinDir, name) : this.skillPath(name);
    let text = '';
    try { text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch {}
    const files = [];
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else files.push(r);
      }
    };
    try { walk(dir, ''); } catch {}
    return { name, text, files, builtin: !!s.builtin };
  }

  // Kullanıcı skill'i yazılırken / alınırken depodaki bir skill'in adı kullanılamaz.
  notBuiltin(name) {
    if (this.isBuiltin(name)) throw new CapError(409, `"${name}" panelle gelen bir skill; başka bir ad ver.`);
  }

  register(name, description) {
    const c = this.load();
    const cur = c.skills.find((s) => s.name === name);
    if (cur) cur.description = description;
    else c.skills.push({ name, description, roles: [] });
    this.save(c);
    return c.skills.find((s) => s.name === name);
  }

  // Panelde yazılan skill: tek SKILL.md. Var olan skill'in yalnızca SKILL.md'si değişir, diğer dosyaları kalır.
  writeSkill({ name, description, body, replace }) {
    name = String(name || '').trim();
    description = String(description || '').replace(/\s+/g, ' ').trim();
    const dir = this.skillPath(name);
    if (!description) throw new CapError(400, 'Açıklama gerekli; Claude skill\'i ne zaman kullanacağını buradan anlar.');
    this.notBuiltin(name);
    const exists = this.load().skills.some((s) => s.name === name);
    if (exists && !replace) throw new CapError(409, `"${name}" adında bir skill zaten var.`);
    fs.mkdirSync(dir, { recursive: true });
    const text = `---\nname: ${name}\ndescription: ${description}\n---\n\n${String(body || '').trim()}\n`;
    fs.writeFileSync(path.join(dir, 'SKILL.md'), text, 'utf8');
    return this.register(name, description);
  }

  // Var olan skill'in SKILL.md'si olduğu gibi (başlık satırlarıyla) değiştirilir; diğer dosyalar kalır.
  writeRaw(name, text) {
    const dir = this.skillPath(name);
    if (this.isBuiltin(name)) throw new CapError(403, READ_ONLY);
    if (!this.load().skills.some((s) => s.name === name)) throw new CapError(404, 'Skill bulunamadı.');
    const meta = skillMeta(text);
    if (meta.name !== name) throw new CapError(400, `SKILL.md başındaki name satırı "${name}" olmalı.`);
    if (!meta.description) throw new CapError(400, 'SKILL.md başında description satırı olmalı.');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), String(text), 'utf8');
    return this.register(name, meta.description);
  }

  // Klasördeki skill olduğu gibi kopyalanır. SKILL.md klasörün kökünde ya da bir alt klasöründe olabilir.
  importDir(src, wantedName) {
    const root = findSkillRoot(src);
    if (!root) throw new CapError(400, 'Klasörde SKILL.md bulunamadı (kökte ya da bir alt klasörde olmalı).');
    const meta = skillMeta(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8'));
    if (!meta.description) throw new CapError(400, 'SKILL.md\'de description satırı yok.');
    const name = String(wantedName || meta.name || path.basename(root)).trim().toLowerCase();
    const dir = this.skillPath(name);
    this.notBuiltin(name);
    if (this.load().skills.some((s) => s.name === name)) throw new CapError(409, `"${name}" adında bir skill zaten var.`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(root, dir, { recursive: true, dereference: true });
    // Klasör adı ile SKILL.md'deki ad farklıysa Claude ikisini eşleştiremez; ad satırı düzeltilir.
    if (meta.name && meta.name !== name) {
      const f = path.join(dir, 'SKILL.md');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^(---\r?\n[\s\S]*?)^name:.*$/m, `$1name: ${name}`), 'utf8');
    }
    return this.register(name, meta.description);
  }

  // Zip önce boş bir geçici klasöre açılır; klasör dışına yazan girdi varsa reddedilir.
  async importZip(buf, wantedName) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-skill-'));
    try {
      const zip = path.join(tmp, 'skill.zip');
      const out = path.join(tmp, 'out');
      fs.writeFileSync(zip, buf);
      await new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          // Açmadan önce girdi adları denetlenir: kök yolla ya da .. ile klasör dışına çıkan girdi varsa hiç açılmaz.
          'Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead($env:PANEL_ZIP); '
          + "$bad = $z.Entries | Where-Object { $_.FullName -match '(^|[\\\\/])\\.\\.([\\\\/]|$)' -or $_.FullName -match '^([\\\\/]|[A-Za-z]:)' }; $z.Dispose(); "
          + 'if ($bad) { exit 3 }; '
          + 'Expand-Archive -LiteralPath $env:PANEL_ZIP -DestinationPath $env:PANEL_OUT -Force'],
        { env: { ...process.env, PANEL_ZIP: zip, PANEL_OUT: out }, windowsHide: true, timeout: 60000 },
        (err, stdout, stderr) => {
          if (!err) return resolve();
          if (err.code === 3) return reject(new CapError(400, 'Zip klasör dışına yazan bir girdi içeriyor.'));
          reject(new CapError(400, `Zip açılamadı: ${String(stderr || err.message).trim().split('\n')[0]}`));
        });
      });
      const realOut = fs.realpathSync(out);
      const check = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isSymbolicLink()) throw new CapError(400, 'Zip içinde bağlantı (link) olamaz.');
          if (!fs.realpathSync(p).startsWith(realOut + path.sep)) throw new CapError(400, 'Zip klasör dışına yazan bir girdi içeriyor.');
          if (e.isDirectory()) check(p);
        }
      };
      check(realOut);
      return this.importDir(realOut, wantedName);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  removeSkill(name) {
    const dir = this.skillPath(name);
    if (this.isBuiltin(name)) throw new CapError(403, READ_ONLY);
    const c = this.load();
    c.skills = c.skills.filter((s) => s.name !== name);
    this.save(c);
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  }

  // ---------- rol ataması ----------

  // Panel yeteneğinde roles = açık roller; global olanda globalOff[key] = kapalı roller.
  setRole(key, roleId, on) {
    const c = this.load();
    const flip = (list, add) => {
      const s = new Set(list || []);
      if (add) s.add(roleId); else s.delete(roleId);
      return [...s];
    };
    const [kind, ...rest] = String(key).split(':');
    const id = rest.join(':');
    if (kind === 'pmcp' || kind === 'pskill') {
      const list = kind === 'pmcp' ? c.mcps : c.skills;
      const item = list.find((x) => (kind === 'pmcp' ? x.id : x.name) === id);
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
    for (const m of c.mcps) m.roles = keep(m.roles);
    for (const s of c.skills) s.roles = keep(s.roles);
    for (const k of Object.keys(c.globalOff)) {
      c.globalOff[k] = keep(c.globalOff[k]);
      if (!c.globalOff[k].length) delete c.globalOff[k];
    }
    this.save(c);
  }

  // Bir rolün varsayılan olarak aldığı yetenek anahtarları (global olanlar: kapatılmadıysa açık; panel olanlar: işaretliyse).
  // Anlık rol (custom) yalnızca global yetenekleri alır.
  roleKeys(roleId, inventory) {
    const c = this.load();
    const on = inventory.filter((x) => !(c.globalOff[x.key] || []).includes(roleId)).map((x) => x.key);
    for (const m of c.mcps) if (m.roles.includes(roleId)) on.push(`pmcp:${m.id}`);
    for (const k of c.skills) if (k.roles.includes(roleId)) on.push(`pskill:${k.name}`);
    return on;
  }

  // Oturum açılırken: ayar dosyasına eklenecekler, MCP dosyasına eklenecek sunucular ve --add-dir klasörü.
  // Skill'ler oturuma özel bir klasöre kopyalanır; panelde sonradan değişen skill bir sonraki açılışta gelir.
  // override: kurulumda bu oturum için rol varsayılanının üstüne açılan / kapatılan anahtarlar ({ on: [], off: [] }).
  forSession(sessionId, roleId, override) {
    const c = this.load();
    const on = new Set((override && override.on) || []);
    const off = new Set((override && override.off) || []);
    const settings = { enabledPlugins: {}, skillOverrides: {}, deny: [], allow: [] };
    const mcpServers = {};
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
    for (const m of c.mcps) {
      if (!panelOn(`pmcp:${m.id}`, m.roles)) continue;
      mcpServers[m.name] = m.type === 'http'
        ? { type: 'http', url: m.url, headers: m.headers || {} }
        : { type: 'stdio', command: m.command, args: m.args || [], env: m.env || {} };
      if (m.autoAllow) settings.allow.push(mcpPrefix(m.name));
    }
    const dir = path.join(this.sessionDir, sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
    const skills = c.skills.filter((s) => panelOn(`pskill:${s.name}`, s.roles));
    let addDir = null;
    for (const s of skills) {
      const src = path.join(s.builtin ? this.builtinDir : this.skillDir, s.name);
      if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue;
      fs.cpSync(src, path.join(dir, '.claude', 'skills', s.name), { recursive: true });
      addDir = dir;
    }
    return { settings, mcpServers, addDir };
  }
}

function findSkillRoot(src) {
  let st;
  try { st = fs.statSync(src); } catch { return null; }
  if (!st.isDirectory()) return null;
  if (fs.existsSync(path.join(src, 'SKILL.md'))) return src;
  const subs = fs.readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(src, e.name, 'SKILL.md')));
  return subs.length === 1 ? path.join(src, subs[0].name) : null;
}

// ---------- "Dene": sunucuya bağlanıp tool listesini çekme ----------

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-panel-test', version: '1' } },
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
