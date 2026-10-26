// Görev panosu, grup notları, not düzenleyici, proje dokümanları ve hatırlatma.
const store = require('../core/store');
const { resolveMember } = require('../team/board');
const { curatorLevels } = require('../team/curator');
const { cleanRef, listDocs, readDoc, searchDocs } = require('../team/docs');
const { boards, notes, curator, HttpError, cleanText, boardGroup } = require('../panel/context');
const { route, readBody } = require('../panel/http');

function boardAssignee(g, v) {
  try {
    return resolveMember(g, v);
  } catch (err) {
    throw new HttpError(err.status || 400, err.message);
  }
}

route('GET', '/api/groups/([\\w-]+)/board', async (req, m) => {
  const b = boards.load(boardGroup(m[1]).id);
  return { cards: b.cards, removed: b.removed || [] };
});

route('POST', '/api/groups/([\\w-]+)/board', async (req, m) => {
  const g = boardGroup(m[1]);
  const body = await readBody(req);
  return boards.create(g, { title: body.title, desc: body.desc, status: body.status, assignee: boardAssignee(g, body.assignee) || null }, 'user');
});

route('PUT', '/api/groups/([\\w-]+)/board/(\\d+)', async (req, m) => {
  const g = boardGroup(m[1]);
  const body = await readBody(req);
  const patch = { title: body.title, desc: body.desc, status: body.status, note: body.note };
  if (body.assignee !== undefined) patch.assignee = boardAssignee(g, body.assignee);
  return boards.update(g, m[2], patch, 'user', body.version);
});

route('DELETE', '/api/groups/([\\w-]+)/board/(\\d+)', async (req, m) => boards.remove(boardGroup(m[1]), m[2], 'user'));

function docProject(pid) {
  const p = store.loadProjects().find((x) => x.id === pid);
  if (!p) throw new HttpError(404, 'Proje bulunamadı.');
  return p;
}

function docCall(fn) {
  try {
    return fn();
  } catch (err) {
    throw new HttpError(err.status || 500, err.message);
  }
}

route('GET', '/api/projects/([\\w-]+)/docs', async (req, m) => docCall(() => listDocs(docProject(m[1]))));

route('GET', '/api/projects/([\\w-]+)/doc', async (req, m) => {
  const rel = new URL(req.url, 'http://x').searchParams.get('path');
  const d = docCall(() => readDoc(docProject(m[1]), rel));
  return { path: d.path, size: d.size, mtime: d.mtime, text: d.text };
});

route('GET', '/api/projects/([\\w-]+)/docs/search', async (req, m) => {
  const q = new URL(req.url, 'http://x').searchParams.get('q');
  return docCall(() => searchDocs(docProject(m[1]), q));
});

route('PUT', '/api/projects/([\\w-]+)/doc-refs', async (req, m) => {
  const body = await readBody(req);
  const projects = store.loadProjects();
  const p = projects.find((x) => x.id === m[1]);
  if (!p) throw new HttpError(404, 'Proje bulunamadı.');
  const refs = docCall(() => [...new Set((Array.isArray(body.refs) ? body.refs : []).map((r) => cleanRef(p, r)).filter(Boolean))]);
  if (refs.length > 20) throw new HttpError(400, 'En fazla 20 kaynak eklenebilir.');
  p.docRefs = refs;
  store.saveProjects(projects);
  return listDocs(p);
});

const REMIND_MAX = 12000;
// Kod bloğu içeriği ``` içeriyorsa daha uzun bir çit kullanılır.
const fence = (t) => (t.includes('```') ? '````' : '```');

// Kullanıcının seçtiği notu ya da dokümanı (tamamı, satır aralığı ya da seçili metin) belirli üyelere hatırlatır.
route('POST', '/api/groups/([\\w-]+)/remind', async (req, m) => {
  const g = boardGroup(m[1]);
  const body = await readBody(req, 2_000_000);
  const live = g.sessions.filter((s) => !s.removed).map((s) => s.id);
  const to = [...new Set((Array.isArray(body.to) ? body.to : []).filter((sid) => live.includes(sid)))];
  if (!to.length) throw new HttpError(400, 'Hatırlatılacak üye seç.');
  const src = body.source || {};
  let label, text, abs = null;
  if (src.type === 'doc') {
    const project = docProject(g.projectId);
    const d = docCall(() => readDoc(project, src.path));
    label = `proje dokümanı ${d.path}`;
    text = d.text;
    abs = d.abs;
  } else if (src.type === 'note') {
    const note = notes.load(g.id).notes.find((x) => x.id === Number(src.id));
    if (!note) throw new HttpError(404, 'Not bulunamadı.');
    label = `grup notu #${note.id} "${note.title}"`;
    text = note.body || '';
  } else throw new HttpError(400, 'Kaynak türü doc ya da note olmalı.');

  let content = null, hint = null;
  const mode = body.mode;
  if (mode === 'lines') {
    const lines = text.split(/\r?\n/);
    const a = Math.max(1, Math.min(lines.length, Number(body.from) || 1));
    const b = Math.max(a, Math.min(lines.length, Number(body.to_line) || a));
    label += `, satır ${a}${b > a ? `–${b}` : ''}`;
    content = lines.slice(a - 1, b).join('\n');
  } else if (mode === 'text') {
    content = String(body.text || '').trim();
    if (!content) throw new HttpError(400, 'Seçili metin boş.');
    label += ', seçili kısım';
  } else if (abs && text.length > 6000) {
    // Uzun doküman terminale yapıştırılmaz; üye dosyayı kendisi okur. Başlıklar yön göstersin diye eklenir.
    const heads = text.split(/\r?\n/).map((l, i) => [l, i + 1]).filter(([l]) => /^#{1,3}\s/.test(l)).slice(0, 40);
    hint = [`Dosyanın tamamını Read ile oku: ${abs}`, ...(heads.length ? ['Başlıklar:', ...heads.map(([l, n]) => `  ${n}: ${l.trim()}`)] : [])].join('\n');
  } else content = text;
  if (content && content.length > REMIND_MAX) content = `${content.slice(0, REMIND_MAX)}\n… (kısaltıldı; tamamı için kaynağa bak)`;
  const note = cleanText(body.note, 2000);
  const f = content ? fence(content) : '';
  const msg = [
    '[Claude Panel · Hatırlatma] Kullanıcı sana şunu hatırlatıyor.',
    `Kaynak: ${label}`,
    note ? `Kullanıcının notu: ${note}` : '',
    content ? `${f}\n${content}\n${f}` : hint,
    'Bunu şu anki işinde dikkate al.',
  ].filter(Boolean).join('\n');
  notes.remind(g, to, msg);
  return { ok: true, to: to.length, chars: msg.length };
});

// Grup notları. Her notta alıcılar ve kime iletildiği / kimde beklediği de döner.
function notesView(g) {
  const n = notes.load(g.id);
  // Geçmiş büyük olabilir; ayrı uçtan alınır.
  return n.notes.map(({ history, ...x }) => ({
    ...x, historyCount: (history || []).length, waiting: Object.keys(n.pending).filter((sid) => n.pending[sid].some((p) => p.id === x.id)),
  }));
}

function noteCall(fn) {
  try {
    return fn();
  } catch (err) {
    throw new HttpError(err.status || 500, err.message);
  }
}

route('GET', '/api/groups/([\\w-]+)/notes', async (req, m) => ({ notes: notesView(boardGroup(m[1])) }));

route('POST', '/api/groups/([\\w-]+)/notes', async (req, m) => {
  const g = boardGroup(m[1]);
  const body = await readBody(req);
  const live = g.sessions.filter((s) => !s.removed).map((s) => s.id);
  const to = Array.isArray(body.to) ? body.to.filter((sid) => live.includes(sid)) : undefined;
  noteCall(() => notes.create(g, { title: body.title, body: body.body, to }, 'user'));
  return { notes: notesView(g) };
});

route('PUT', '/api/groups/([\\w-]+)/notes/(\\d+)', async (req, m) => {
  const g = boardGroup(m[1]);
  const body = await readBody(req);
  noteCall(() => notes.update(g, m[2], { title: body.title, body: body.body, expect: body.expect }, 'user'));
  return { notes: notesView(g) };
});

route('GET', '/api/groups/([\\w-]+)/notes/(\\d+)/history', async (req, m) => {
  const g = boardGroup(m[1]);
  const note = notes.load(g.id).notes.find((x) => x.id === Number(m[2]));
  if (!note) throw new HttpError(404, 'Not bulunamadı.');
  return { history: (note.history || []).map((h, i) => ({ ...h, index: i })).reverse() };
});

route('POST', '/api/groups/([\\w-]+)/notes/(\\d+)/restore', async (req, m) => {
  const g = boardGroup(m[1]);
  const body = await readBody(req);
  noteCall(() => notes.restore(g, m[2], body.index));
  return { notes: notesView(g) };
});

route('POST', '/api/groups/([\\w-]+)/notes/(\\d+)/unarchive', async (req, m) => {
  const g = boardGroup(m[1]);
  noteCall(() => notes.unarchive(g, m[2]));
  return { notes: notesView(g) };
});

route('GET', '/api/groups/([\\w-]+)/curator', async (req, m) => curator.status(boardGroup(m[1]).id));

route('POST', '/api/groups/([\\w-]+)/curator/run', async (req, m) => {
  const g = boardGroup(m[1]);
  if (curator.status(g.id).running) throw new HttpError(409, 'Not düzenleyici bu grupta zaten çalışıyor.');
  const body = await readBody(req).catch(() => ({}));
  curator.run(g, true, curatorLevels().includes(body && body.level) ? body.level : null).catch((err) => console.error('[panel] not düzenleyici:', err.message));
  return curator.status(g.id);
});

route('DELETE', '/api/groups/([\\w-]+)/notes/(\\d+)', async (req, m) => {
  const g = boardGroup(m[1]);
  noteCall(() => notes.remove(g, m[2], 'user'));
  return { notes: notesView(g) };
});
