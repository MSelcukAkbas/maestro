// Grup kapanışında dışa aktarma: grubun notları ve görev panosu proje klasöründe okunabilir Markdown dosyalarına
// yazılır. Klasör yapısı:
//   00-icindekiler.md    grup bilgisi ve içindekiler
//   01-yapilacaklar.md   panodaki açık kartlar (yapılıyor, review, yapılacak) açıklama ve notlarıyla
//   02-biten-isler.md    bitti kartları
//   notlar/              her not ayrı dosya
//   arsiv/               birleştirilmiş ya da arşive alınmış notlar
// Metinler kısaltılmaz; kullanıcının yazdığı [kullanıcı] blokları olduğu gibi kalır. Var olan dosyanın üstüne yazılmaz.
const fs = require('fs');
const path = require('path');

const STATUS_ORDER = ['doing', 'review', 'todo'];

const fmt = (ts) => (ts ? new Date(ts).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');

// Windows dosya adında geçersiz karakterler ve Markdown bağlantısını bozan noktalama atılır; Türkçe harfler kalır.
function slug(s, max = 60) {
  const t = String(s || '').toLocaleLowerCase('tr').replace(/[<>:"/\\|?*\x00-\x1f#()[\]{},;!'`’“”—–·+=&%$@^~]/g, ' ')
    .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return t.slice(0, max).replace(/[-.]+$/, '') || 'not';
}

function inside(root, p) {
  const r = path.resolve(root).toLowerCase();
  const t = path.resolve(p).toLowerCase();
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

// Varsayılan hedef: <proje>/ekip-notlari/<tarih>_<grup adı>
function defaultDir(group, now = new Date()) {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `ekip-notlari/${d}_${slug(group.name.replace(/\s*·\s*\d{4}$/, ''), 50)}`;
}

function noteFile(n) {
  return `${String(n.id).padStart(3, '0')}-${slug(n.title)}.md`;
}

function noteMd(n, actor) {
  const meta = [
    `- Yazan: ${actor(n.by)}`,
    `- Eklendi: ${fmt(n.createdAt)} · son düzenleme: ${fmt(n.updatedAt)}${n.updatedBy ? ` (${actor(n.updatedBy)})` : ''}`,
  ];
  if (n.archived) meta.push(n.mergedInto ? `- #${n.mergedInto} notuyla birleştirildi (${fmt(n.archivedAt)})` : `- Arşive alındı (${fmt(n.archivedAt)})`);
  return [`# #${n.id} ${n.title}`, '', ...meta, '', n.body, ''].join('\n');
}

function cardMd(c, actor, statusText) {
  const lines = [`## #${c.id} ${c.title}`, '', `- Durum: ${statusText[c.status] || c.status} · atanan: ${c.assignee ? actor(c.assignee) : 'yok'} · sürüm ${c.version}`];
  if (c.desc) lines.push('', '### Açıklama', '', c.desc);
  if (c.notes && c.notes.length) {
    lines.push('', '### Notlar', '');
    for (const n of c.notes) lines.push(`- **${actor(n.by)}** (${fmt(n.ts)}):`, '', n.text.split('\n').map((l) => `  ${l}`).join('\n'), '');
  }
  return lines.join('\n');
}

// opts: { projectPath, rel, group, notes: [...], cards: [...], actor(id) -> ad, statusText }
// Dönüş: { dir (mutlak), rel, files }
function exportGroup(opts) {
  const { projectPath, group, notes, cards, actor, statusText } = opts;
  let rel = String(opts.rel || defaultDir(group)).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  let dir = path.resolve(projectPath, rel);
  if (!rel || !inside(projectPath, dir) || path.resolve(projectPath) === dir) throw Object.assign(new Error('Hedef klasör proje klasörünün içinde olmalı.'), { status: 400 });
  // Aynı adlı klasör varsa üstüne yazılmaz; sonuna sayı eklenir.
  for (let i = 2; fs.existsSync(dir); i++) dir = path.resolve(projectPath, `${rel}-${i}`);
  rel = path.relative(projectPath, dir).replace(/\\/g, '/');

  const live = notes.filter((n) => !n.archived);
  const archived = notes.filter((n) => n.archived);
  const open = cards.filter((c) => c.status !== 'done').sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.id - b.id);
  const done = cards.filter((c) => c.status === 'done');
  const files = [];
  const write = (name, text) => {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, { encoding: 'utf8', flag: 'wx' });
    files.push(name.replace(/\\/g, '/'));
  };

  const toc = [
    `# İçindekiler — ${group.name}`,
    '',
    `Grup: ${group.name} · açıldı ${fmt(group.createdAt)} · dışa aktarıldı ${fmt(Date.now())}`,
    `Üyeler: ${group.sessions.filter((s) => !s.removed).map((s) => `${s.roleLabel} (${s.name})`).join(', ')}`,
    '',
    `- [Yapılacaklar](01-yapilacaklar.md) — ${open.length} açık kart`,
    `- [Biten işler](02-biten-isler.md) — ${done.length} kart`,
    `- Notlar (${live.length}):`,
    ...live.map((n) => `  - [#${n.id} ${n.title}](notlar/${encodeURI(noteFile(n))})`),
    ...(archived.length ? [`- Arşiv (${archived.length}; birleştirilmiş ya da arşive alınmış):`, ...archived.map((n) => `  - [#${n.id} ${n.title}](arsiv/${encodeURI(noteFile(n))})`)] : []),
    '',
  ];
  write('00-icindekiler.md', toc.join('\n'));
  write('01-yapilacaklar.md', [`# Yapılacaklar — ${group.name}`, '', open.length ? 'Panodaki açık kartlar: önce yapılıyor, sonra review, sonra yapılacak.' : 'Açık kart yok.', '', ...open.map((c) => cardMd(c, actor, statusText))].join('\n'));
  write('02-biten-isler.md', [`# Biten işler — ${group.name}`, '', ...(done.length ? done.map((c) => cardMd(c, actor, statusText)) : ['Biten kart yok.'])].join('\n'));
  for (const n of live) write(`notlar/${noteFile(n)}`, noteMd(n, actor));
  for (const n of archived) write(`arsiv/${noteFile(n)}`, noteMd(n, actor));
  return { dir, rel, files };
}

module.exports = { exportGroup, defaultDir };
