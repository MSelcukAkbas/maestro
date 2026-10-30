// Konuşma kayıtlarının (projects/*/<id>.jsonl) dosya erişimi: boyut, oluşma zamanı, kaldığı yerden yeni satırlar,
// alt ajan dosyaları ve proje klasörlerinin taranması. Satırların ne anlama geldiği services/ tarafındadır.
const fs = require('fs');
const path = require('path');

function size(file) {
  try { return fs.statSync(file).size; } catch { return null; }
}

function birth(file) {
  try { return fs.statSync(file).birthtimeMs; } catch { return null; }
}

// cursor: { offset, rest } (rest: sonu newline ile bitmemiş yarım satır). Dosya yoksa null.
// reset: dosya kısalmış (yeniden yazılmış), okuma baştan yapıldı. Dönen cursor bir sonraki çağrıya verilir.
function readNew(file, cursor) {
  const sz = size(file);
  if (sz === null) return null;
  let c = cursor || { offset: 0, rest: '' };
  let reset = false;
  if (sz < c.offset) {
    c = { offset: 0, rest: '' };
    reset = true;
  }
  if (sz === c.offset) return { lines: [], cursor: c, reset };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(sz - c.offset);
    fs.readSync(fd, buf, 0, buf.length, c.offset);
    const lines = (c.rest + buf.toString('utf8')).split('\n');
    const rest = lines.pop();
    return { lines: lines.filter((l) => l.trim()), cursor: { offset: sz, rest }, reset };
  } finally {
    fs.closeSync(fd);
  }
}

// Oturum dosyasının alt ajan kayıtları (tam yollar).
function subagentFiles(file) {
  const dir = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); } catch { return []; }
}

// projects/ altındaki bütün konuşma dosyaları (tam yollar).
function allFiles(projectsDir) {
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(projectsDir); } catch { return out; }
  for (const d of dirs) {
    let files;
    try { files = fs.readdirSync(path.join(projectsDir, d)); } catch { continue; }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(projectsDir, d, f));
  }
  return out;
}

module.exports = { size, birth, readNew, subagentFiles, allFiles };
