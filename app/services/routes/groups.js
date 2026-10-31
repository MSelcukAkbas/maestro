// Projeler ve gruplar: durum, proje ekleme / silme, grup kurma, devam ettirme, üye ekleme, mesajlar, durdurma,
// grubu kapatma (dışa aktarma), arşiv ve üye sırası.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('../core/store');
const { discovery } = require('../../agent');
const { sessionStats, sessionMessages } = require('../core/usage');
const exporter = require('../team/exporter');
const { STATUS_TEXT } = require('../team/board');
const { actorLabel } = require('../team/notes');
const {
  manager, boards, notes, HttpError, isAllowedDir, sharedConfigDir, cleanText, pushEvent, boardGroup,
} = require('../panel/context');
const { createGroup, addSessionToGroup, startSessions } = require('../panel/launch');
const { buildState, groupActivity } = require('../panel/state');
const { route, readBody } = require('../panel/http');

route('GET', '/api/state', async () => buildState());

route('POST', '/api/projects', async (req) => {
  const body = await readBody(req);
  const p = path.resolve(String(body.path || '').trim());
  if (!body.path) throw new HttpError(400, 'Klasör yolu gerekli.');
  let st;
  try { st = fs.statSync(p); } catch { throw new HttpError(400, 'Klasör bulunamadı.'); }
  if (!st.isDirectory()) throw new HttpError(400, 'Bu bir klasör değil.');
  if (!isAllowedDir(p)) throw new HttpError(403, 'Klasör izinli klasörlerin dışında. Ayarlar > İzinli proje klasörleri.');
  const projects = store.loadProjects();
  const existing = projects.find((x) => x.path.toLowerCase() === p.toLowerCase());
  if (existing) return existing;
  const project = { id: crypto.randomUUID(), name: cleanText(body.name, 40) || path.basename(p), path: p, addedAt: Date.now(), lastUsedAt: Date.now() };
  projects.push(project);
  store.saveProjects(projects);
  return project;
});

route('DELETE', '/api/projects/([\\w-]+)', async (req, m) => {
  const groups = buildState().groups.filter((g) => g.projectId === m[1]);
  if (groups.some((g) => g.state === 'active')) throw new HttpError(409, 'Projede çalışan oturum var.');
  store.saveProjects(store.loadProjects().filter((p) => p.id !== m[1]));
  return { ok: true };
});

route('POST', '/api/groups', async (req) => createGroup(await readBody(req)));

route('POST', '/api/groups/([\\w-]+)/resume', async (req, m) => {
  const g = store.loadGroups().find((x) => x.id === m[1]);
  if (!g) throw new HttpError(404, 'Grup bulunamadı.');
  startSessions(g, g.sessions.filter((s) => !s.removed && !manager.has(s.id)), true);
  return { ok: true };
});

route('POST', '/api/groups/([\\w-]+)/sessions', async (req, m) => addSessionToGroup(m[1], await readBody(req)));

route('GET', '/api/groups/([\\w-]+)/activity', async (req, m) => groupActivity(m[1], new URL(req.url, 'http://x').searchParams.get('bodies') === '1'));
route('GET', '/api/groups/([\\w-]+)/message', async (req, m) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const g = store.viewGroups().find((x) => x.id === m[1]);
  const s = g && g.sessions.find((x) => x.id === q.get('from'));
  if (!s) throw new HttpError(404, 'Mesaj bulunamadı.');
  const ts = Number(q.get('ts'));
  const hit = sessionMessages(discovery.transcriptPath(sharedConfigDir(), s.id)).find((x) => x.ts === ts);
  if (!hit) throw new HttpError(404, 'Mesaj bulunamadı.');
  return { body: hit.body };
});

route('POST', '/api/groups/([\\w-]+)/stop', async (req, m) => {
  const groups = store.loadGroups();
  const g = groups.find((x) => x.id === m[1]);
  if (!g) throw new HttpError(404, 'Grup bulunamadı.');
  // Şefin son mesajı grubun kapanış kaydına saklanır (grup sonra devam ettirilse bile bu an kalır).
  const lead = g.sessions.find((s) => s.roleId === 'sef' && !s.removed) || g.sessions[0];
  const st = lead && sessionStats(discovery.transcriptPath(sharedConfigDir(), lead.id));
  if (st && st.lastText) {
    g.closing = { at: Date.now(), by: lead.name, text: st.lastText };
    store.saveGroups(groups);
  }
  for (const s of g.sessions) manager.stop(s.id);
  return { ok: true };
});

// Grubu kapatma: oturumlar durdurulur, istenirse notlar ve pano proje klasörüne Markdown olarak aktarılır; en son grup
// arşivlenir. Bir adım hata verirse grup kapanmaz, notlar yerinde kalır. İş arka planda sürer; arayüz durumu GET ile izler.
const closeJobs = new Map();

function closeJobView(gid) {
  const j = closeJobs.get(gid);
  return j ? { ...j } : { state: 'none', defaultDir: exporter.defaultDir(boardGroup(gid)) };
}

async function runClose(gid, opts) {
  const job = { state: 'running', step: 'Oturumlar durduruluyor', startedAt: Date.now(), export: opts.export };
  closeJobs.set(gid, job);
  try {
    let g = boardGroup(gid);
    for (const s of g.sessions) manager.stop(s.id);
    if (opts.export) {
      const project = store.loadProjects().find((p) => p.id === g.projectId);
      if (!project) throw new HttpError(404, 'Proje bulunamadı.');
      if (!isAllowedDir(project.path)) throw new HttpError(403, 'Proje klasörü izinli klasörlerin dışında.');
      job.step = 'Dosyalar yazılıyor';
      g = boardGroup(gid);
      const out = exporter.exportGroup({
        projectPath: project.path, rel: opts.dir, group: g, notes: notes.load(gid).notes, cards: boards.load(gid).cards,
        actor: (id) => actorLabel(g, id), statusText: STATUS_TEXT,
      });
      job.dir = out.dir;
      job.files = out.files.length;
      // Dışa aktarılan klasör projenin doküman kaynaklarına eklenir; sonraki gruplar Notlar ekranından okuyabilir.
      const projects = store.loadProjects();
      const p = projects.find((x) => x.id === project.id);
      const top = out.rel.split('/')[0];
      const refs = p.docRefs || [];
      if (!refs.some((r) => r === '.' || r === top || out.rel === r || out.rel.startsWith(`${r}/`)) && refs.length < 20) {
        p.docRefs = [...refs, top];
        store.saveProjects(projects);
        job.docRef = top;
      }
    }
    const groups = store.loadGroups();
    const gg = groups.find((x) => x.id === gid);
    gg.archived = true;
    gg.closedAt = Date.now();
    if (job.dir) gg.exportDir = job.dir;
    store.saveGroups(groups);
    Object.assign(job, { state: 'done', step: null, finishedAt: Date.now() });
    pushEvent(job.dir ? `Grup kapatıldı; notlar ${job.dir} klasörüne aktarıldı.` : 'Grup kapatıldı.', 'notlar', gid);
  } catch (err) {
    Object.assign(job, { state: 'failed', step: null, error: err.message });
  }
}

route('GET', '/api/groups/([\\w-]+)/close', async (req, m) => closeJobView(m[1]));

route('POST', '/api/groups/([\\w-]+)/close', async (req, m) => {
  const g = boardGroup(m[1]);
  const body = await readBody(req);
  const cur = closeJobs.get(g.id);
  if (cur && cur.state === 'running') throw new HttpError(409, 'Grup zaten kapatılıyor.');
  if (g.archived) throw new HttpError(409, 'Grup zaten kapalı.');
  const opts = { export: body.export !== false, dir: body.dir ? String(body.dir).slice(0, 300) : null };
  runClose(g.id, opts).catch((err) => console.error('[panel] grup kapatma:', err.message));
  return closeJobView(g.id);
});

route('POST', '/api/groups/([\\w-]+)/archive', async (req, m) => {
  const body = await readBody(req);
  const groups = store.loadGroups();
  const g = groups.find((x) => x.id === m[1]);
  if (!g) throw new HttpError(404, 'Grup bulunamadı.');
  if (g.sessions.some((s) => manager.has(s.id))) throw new HttpError(409, 'Önce gruptaki oturumları sonlandır.');
  g.archived = body.archived !== false;
  store.saveGroups(groups);
  return { ok: true };
});

// Üye sekmelerinin sürüklenerek sıralanması. body.ids: görünen sıradaki oturum kimlikleri; listede olmayanlar sonda kalır.
route('PUT', '/api/groups/([\\w-]+)/order', async (req, m) => {
  const body = await readBody(req);
  const groups = store.loadGroups();
  const g = groups.find((x) => x.id === m[1]);
  if (!g) throw new HttpError(404, 'Grup bulunamadı.');
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  const rank = new Map(ids.map((id, i) => [id, i]));
  const key = (s, i) => (rank.has(s.id) ? rank.get(s.id) : ids.length + i);
  g.sessions = g.sessions.map((s, i) => ({ s, k: key(s, i) })).sort((a, b) => a.k - b.k).map((x) => x.s);
  store.saveGroups(groups);
  return { ok: true };
});
