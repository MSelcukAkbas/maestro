// İstem ve rol klasörü (app/prompts/): kullanıcının elle düzenlediği metinler .md, ayarlar .json.
//   roles/<id>/role.json + prompt.md   rol ayarları ve rol talimatı (adı "_" ile başlayan klasör okunmaz)
//   shared/*.md                         üye sistem isteminin ortak bölümleri (ad sırasıyla birleşir)
//   tools/<ad>/tool.json + *.md         panelin yardımcı model çağrılarının (bekçi, kurulum danışmanı, …) metni ve ayarı
// Dosyalar okunurken önbelleğe alınır; değişiklik zamanı / boyutu değişen dosya yeniden okunur, böylece elle yapılan
// düzenleme yeniden başlatmadan bir sonraki kullanımda geçer. Panelden yapılan kayıt da aynı dosyalara yazılır.
const fs = require('fs');
const path = require('path');
const { APP_ROOT } = require('./paths');

// CLAUDE_PANEL_PROMPTS ile ayrı bir klasör verilebilir (testler geçici kopya kullanır).
const PROMPTS_DIR = process.env.CLAUDE_PANEL_PROMPTS || path.join(APP_ROOT, 'prompts');
const ROLE_ID = /^[a-z0-9][a-z0-9_-]{0,23}$/;
// Rol klasörü taraması en fazla bu sıklıkta yenilenir (settings.roles sık okunur).
const ROLE_RECHECK_MS = 1000;

const files = new Map();

function statOf(abs) {
  try { return fs.statSync(abs); } catch { return null; }
}

// Metin dosyası: satır sonları LF'e çevrilir (git Windows'ta CRLF'e çevirebilir), sondaki satır sonu atılır.
// Dosya yoksa null.
function text(rel) {
  const abs = path.join(PROMPTS_DIR, rel);
  const st = statOf(abs);
  if (!st) { files.delete(abs); return null; }
  const hit = files.get(abs);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.value;
  const value = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  files.set(abs, { mtime: st.mtimeMs, size: st.size, value });
  return value;
}

// JSON dosyası; yoksa ya da bozuksa null (bozuk dosya konsola yazılır).
function json(rel) {
  const t = text(rel);
  if (t == null) return null;
  try { return JSON.parse(t); } catch (err) {
    console.error(`[prompts] ${rel} okunamadı:`, err.message);
    return null;
  }
}

// Yarım yazılmış dosya kalmasın diye geçici dosya + rename.
function writeFile(rel, value) {
  const abs = path.join(PROMPTS_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, value, 'utf8');
  fs.renameSync(tmp, abs);
  files.delete(abs);
}

// ---------- roller ----------

let roleCache = null;

function roleDirs() {
  try {
    return fs.readdirSync(path.join(PROMPTS_DIR, 'roles'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && ROLE_ID.test(e.name)).map((e) => e.name);
  } catch { return []; }
}

function readRole(id) {
  const cfg = json(`roles/${id}/role.json`);
  if (!cfg || !cfg.label) return null;
  return {
    role: {
      id,
      label: String(cfg.label),
      short: String(cfg.short || cfg.label),
      prompt: text(`roles/${id}/prompt.md`) || '',
      permissionMode: cfg.permissionMode || '',
      model: cfg.model || '',
      readOnly: !!cfg.readOnly,
      effort: cfg.effort || '',
      ctxWarn: cfg.ctxWarn || null,
      ctxHigh: cfg.ctxHigh || null,
    },
    order: Number(cfg.order) || 0,
    skills: Array.isArray(cfg.skills) ? cfg.skills : [],
  };
}

// Klasör listesi ve dosya zamanlarından imza; değişmedikçe aynı dizi döner.
function loadRoles() {
  const now = Date.now();
  if (roleCache && now - roleCache.at < ROLE_RECHECK_MS) return roleCache;
  const ids = roleDirs();
  const sig = ids.map((id) => ['role.json', 'prompt.md'].map((f) => {
    const st = statOf(path.join(PROMPTS_DIR, 'roles', id, f));
    return st ? `${st.mtimeMs}:${st.size}` : '-';
  }).join('/') + `@${id}`).join('|');
  if (roleCache && roleCache.sig === sig) { roleCache.at = now; return roleCache; }
  const all = ids.map(readRole).filter(Boolean).sort((a, b) => a.order - b.order || a.role.id.localeCompare(b.role.id));
  roleCache = { at: now, sig, list: all.map((x) => x.role), skills: Object.fromEntries(all.map((x) => [x.role.id, x.skills])) };
  return roleCache;
}

// [{ id, label, short, prompt, permissionMode, model, readOnly, effort, ctxWarn, ctxHigh }], role.json "order" sırasıyla.
// Dönen diziyi değiştirme.
function roles() {
  return loadRoles().list;
}

function role(id) {
  return roles().find((r) => r.id === id) || null;
}

// Ayarlar ekranından gelen tam rol listesini klasörlere yazar: yalnızca değişen dosya yazılır, sıra listedeki sıradır.
// Listede olmayan rolün klasörü silinmez, "_silinen-<id>-<zaman>" adıyla kenara alınır (elle yazılmış metin kaybolmasın).
function saveRoles(list) {
  for (const r of list) if (!ROLE_ID.test(r.id)) throw new Error(`Geçersiz rol kimliği: ${r.id}`);
  const keep = new Set(list.map((r) => r.id));
  for (const id of roleDirs()) {
    if (keep.has(id)) continue;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    fs.renameSync(path.join(PROMPTS_DIR, 'roles', id), path.join(PROMPTS_DIR, 'roles', `_silinen-${id}-${stamp}`));
  }
  list.forEach((r, i) => {
    const old = json(`roles/${r.id}/role.json`) || {};
    const cfg = {
      label: r.label, short: r.short || r.label, order: i + 1,
      model: r.model || '', effort: r.effort || '', permissionMode: r.permissionMode || '',
      readOnly: !!r.readOnly, ctxWarn: r.ctxWarn || null, ctxHigh: r.ctxHigh || null,
      skills: Array.isArray(old.skills) ? old.skills : [],
    };
    const cfgText = `${JSON.stringify(cfg, null, 2)}\n`;
    if (text(`roles/${r.id}/role.json`) !== cfgText.replace(/\n+$/, '')) writeFile(`roles/${r.id}/role.json`, cfgText);
    const prompt = String(r.prompt || '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
    if ((text(`roles/${r.id}/prompt.md`) ?? null) !== prompt) writeFile(`roles/${r.id}/prompt.md`, `${prompt}\n`);
  });
  roleCache = null;
}

// Panelle gelen (depodaki) skill'lerin varsayılan rolleri: { skillAdı: [rolId] } — role.json "skills" listelerinden.
function skillRoles() {
  const map = {};
  for (const [id, list] of Object.entries(loadRoles().skills)) {
    for (const name of list) (map[name] = map[name] || []).push(id);
  }
  return map;
}

// Bir skill'in açık olduğu rolleri yazar: her rolün role.json "skills" listesi buna göre güncellenir.
function setSkillRoles(name, roleIds) {
  for (const id of roleDirs()) {
    const cfg = json(`roles/${id}/role.json`);
    if (!cfg) continue;
    const list = Array.isArray(cfg.skills) ? cfg.skills : [];
    const want = roleIds.includes(id);
    if (want === list.includes(name)) continue;
    cfg.skills = want ? [...list, name] : list.filter((x) => x !== name);
    writeFile(`roles/${id}/role.json`, `${JSON.stringify(cfg, null, 2)}\n`);
  }
  roleCache = null;
}

// ---------- yardımcı model araçları ----------

// tools/<ad>/: config = tool.json, text(dosya) = o klasördeki .md (varsayılan prompt.md). Dosya eksikse hata fırlatır;
// eksik metinle model çağırmak sessizce yanlış sonuç verir.
function tool(name) {
  const config = json(`tools/${name}/tool.json`);
  if (!config) throw new Error(`prompts/tools/${name}/tool.json okunamadı`);
  return {
    config,
    text(file = 'prompt.md') {
      const t = text(`tools/${name}/${file}`);
      if (t == null) throw new Error(`prompts/tools/${name}/${file} bulunamadı`);
      return t;
    },
  };
}

// ---------- şablon ----------

// {{ad}} değeri yazar; {{#ad}}…{{/ad}} değer doluysa (boş dize, false, boş dizi değilse), {{^ad}}…{{/ad}} boşsa kalır.
// Bloklar satır içinde ya da satırlar boyunca olabilir. Şablonda boş kalan satırlar atılır; değerin kendi içindeki boş
// satırlar korunur. Değerin içindeki {{…}} yeniden işlenmez. Tanımsız ad olduğu gibi bırakılır (yazım hatası görünsün).
function render(template, vars) {
  const on = (k) => {
    const v = vars[k];
    return Array.isArray(v) ? v.length > 0 : !!v;
  };
  let t = template;
  for (let prev = null; prev !== t;) {
    prev = t;
    t = t.replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (all, kind, k, body) => ((kind === '#') === on(k) ? body : ''));
  }
  const out = [];
  for (const line of t.split('\n')) {
    const v = line.replace(/\{\{(\w+)\}\}/g, (all, k) => (k in vars ? String(vars[k] ?? '') : all));
    if (v.trim() !== '') out.push(v);
  }
  return out.join('\n');
}

// shared/ altındaki bölüm dosyaları, ad sırasıyla.
function sharedSections() {
  let names = [];
  try { names = fs.readdirSync(path.join(PROMPTS_DIR, 'shared')).filter((f) => f.endsWith('.md')).sort(); } catch {}
  return names.map((f) => text(`shared/${f}`)).filter((t) => t != null);
}

module.exports = { PROMPTS_DIR, ROLE_ID, text, json, roles, role, saveRoles, skillRoles, setSkillRoles, tool, render, sharedSections };
