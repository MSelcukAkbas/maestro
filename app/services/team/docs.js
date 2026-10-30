// Proje dokümanları: kullanıcının proje klasöründeki kendi dokümanları (ör. Dokumanlar/, _docs/) notlar ekranında
// "proje notu" olarak görünür. Panel dosyalara yazmaz; yalnızca listeler, okur ve arar. Kaynaklar proje kaydında
// (projects.json → docRefs) proje köküne göreli yollar olarak tutulur ve proje klasörünün dışına çıkamaz.
const fs = require('fs');
const path = require('path');

class DocError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Metin olarak gösterilen türler; diğer dosyalar listelenmez.
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.mmd', '.json', '.yaml', '.yml', '.csv', '.log', '.sql', '.ini', '.toml', '.xml']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.worktrees', 'dist', 'build']);
const MAX_FILES = 3000;
const MAX_READ = 2_000_000;

function inside(root, p) {
  const r = path.resolve(root).toLowerCase();
  const t = path.resolve(p).toLowerCase();
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

// Kullanıcının girdiği kaynak: proje köküne göreli ya da proje içinde mutlak yol. Göreli, / ayraçlı hâli saklanır.
function cleanRef(project, ref) {
  const raw = String(ref || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;
  const abs = path.resolve(project.path, raw);
  if (!inside(project.path, abs)) throw new DocError(400, `"${raw}" proje klasörünün dışında; yalnızca ${project.path} altındaki klasör ve dosyalar eklenebilir.`);
  let st;
  try { st = fs.statSync(abs); } catch { throw new DocError(400, `"${raw}" bulunamadı.`); }
  if (!st.isDirectory() && !TEXT_EXT.has(path.extname(abs).toLowerCase())) throw new DocError(400, `"${raw}" metin dosyası değil.`);
  return path.relative(project.path, abs).split(path.sep).join('/') || '.';
}

function firstHeading(abs) {
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    const m = /^#{1,3}\s+(.+)$/m.exec(buf.slice(0, n).toString('utf8'));
    return m ? m[1].trim().slice(0, 160) : '';
  } catch {
    return '';
  }
}

// Kaynaklardaki metin dosyaları: göreli yol, boyut, değişme zamanı, ilk başlık.
function listDocs(project) {
  const out = [];
  const seen = new Set();
  const walk = (abs) => {
    if (out.length >= MAX_FILES) return;
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(abs); } catch { return; }
      for (const n of names.sort((a, b) => a.localeCompare(b, 'tr'))) {
        if (SKIP_DIRS.has(n)) continue;
        walk(path.join(abs, n));
      }
      return;
    }
    if (!TEXT_EXT.has(path.extname(abs).toLowerCase())) return;
    const rel = path.relative(project.path, abs).split(path.sep).join('/');
    if (seen.has(rel)) return;
    seen.add(rel);
    out.push({ path: rel, size: st.size, mtime: st.mtimeMs, title: firstHeading(abs) });
  };
  for (const ref of project.docRefs || []) walk(path.resolve(project.path, ref));
  return { refs: project.docRefs || [], files: out, truncated: out.length >= MAX_FILES };
}

// Yalnızca kaynaklardan birinin altındaki dosya okunur.
function resolveDoc(project, rel) {
  const abs = path.resolve(project.path, String(rel || ''));
  const ok = (project.docRefs || []).some((ref) => inside(path.resolve(project.path, ref), abs)) && inside(project.path, abs);
  if (!ok) throw new DocError(403, 'Dosya proje dokümanı kaynaklarının dışında.');
  if (!TEXT_EXT.has(path.extname(abs).toLowerCase())) throw new DocError(400, 'Metin dosyası değil.');
  return abs;
}

function readDoc(project, rel) {
  const abs = resolveDoc(project, rel);
  let st;
  try { st = fs.statSync(abs); } catch { throw new DocError(404, 'Dosya bulunamadı.'); }
  if (st.size > MAX_READ) throw new DocError(413, `Dosya çok büyük (${Math.round(st.size / 1e6)} MB).`);
  const text = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '');
  return { path: path.relative(project.path, abs).split(path.sep).join('/'), abs, size: st.size, mtime: st.mtimeMs, text };
}

// İçerikte arama: büyük/küçük harf duyarsız, dosya başına en çok 5, toplam 200 sonuç.
function searchDocs(project, q) {
  const needle = String(q || '').trim().toLocaleLowerCase('tr');
  if (needle.length < 2) throw new DocError(400, 'En az 2 karakter yaz.');
  const hits = [];
  for (const f of listDocs(project).files) {
    if (hits.length >= 200) break;
    if (f.size > MAX_READ) continue;
    let text;
    try { text = fs.readFileSync(path.resolve(project.path, f.path), 'utf8'); } catch { continue; }
    if (!text.toLocaleLowerCase('tr').includes(needle)) continue;
    let n = 0;
    text.split(/\r?\n/).forEach((line, i) => {
      if (n >= 5 || hits.length >= 200 || !line.toLocaleLowerCase('tr').includes(needle)) return;
      hits.push({ path: f.path, line: i + 1, text: line.trim().slice(0, 200) });
      n++;
    });
  }
  return { q: needle, hits };
}

const DOC_TOOL = {
  name: 'dokuman_listele',
  description: 'Kullanıcının proje dokümanlarını (proje notları, ör. Dokumanlar/ klasörü) listeler; ara verilirse dosya adında, başlıkta '
    + 've içerikte arar. Dosyaları Read ile oku; bu dokümanlar kullanıcının referansıdır, izin almadan değiştirme.',
  inputSchema: { type: 'object', properties: { ara: { type: 'string', description: 'kelime ya da ifade (isteğe bağlı)' } } },
};

function callDocTool(project, args) {
  if (!project || !(project.docRefs || []).length) return 'Bu projede kullanıcı proje dokümanı kaynağı tanımlamamış.';
  const q = String((args && args.ara) || '').trim().toLocaleLowerCase('tr');
  const { files } = listDocs(project);
  const lines = [`Proje kökü: ${project.path}`];
  const byName = files.filter((f) => !q || `${f.path}\n${f.title}`.toLocaleLowerCase('tr').includes(q));
  lines.push(q ? `Adında/başlığında "${q}" geçen ${byName.length} dosya:` : `${files.length} doküman:`);
  for (const f of byName.slice(0, 150)) lines.push(`- ${f.path}${f.title ? ` — ${f.title}` : ''}`);
  if (byName.length > 150) lines.push(`… ve ${byName.length - 150} dosya daha; ara ile daralt.`);
  if (q.length >= 2) {
    const { hits } = searchDocs(project, q);
    if (hits.length) {
      lines.push('', `İçerikte geçtiği yerler (${hits.length}):`);
      for (const h of hits.slice(0, 60)) lines.push(`- ${h.path}:${h.line} ${h.text}`);
    }
  }
  return lines.join('\n');
}

module.exports = { DocError, cleanRef, listDocs, readDoc, searchDocs, TEXT_EXT, DOC_TOOL, callDocTool };
