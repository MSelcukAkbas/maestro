// Grup notları: grup başına data/notes/<grup>.json. Ekibin ortak not defteri; kullanıcı arayüzden, üyeler panelin
// MCP tool'larıyla not ekler. Yeni not, ekleyen dışındaki alıcılara kısa bir bildirimle ("X, şu başlıklı not
// ekledi") iletilir; notun tamamı not_oku ile okunur. İletim görev panosuyla aynı yoldan gider.
const fs = require('fs');
const path = require('path');
const prompts = require('../core/prompts');

class NoteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const clean = (s, max) => String(s == null ? '' : s).trim().slice(0, max);
function short(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

const MAX_TITLE = 200;
const MAX_BODY = 20000;
const HISTORY_MAX = 30;
// Not düzenleyici (server/curator.js) notlara bu kimlikle yazar.
const CURATOR = 'curator';

// Kullanıcının yazdığı kısımlar: kullanıcının kendi notu bütünüyle onundur; model notunda kullanıcının eklediği ya da
// değiştirdiği satırlar kendi satırlarında [kullanıcı] … [/kullanıcı] arasında durur. İşaretleri sunucu, kullanıcının
// her kaydında satır sahipliğinden yeniden üretir; modeller onları görür ve korumak zorundadır.
const USER_OPEN = '[kullanıcı]';
const USER_CLOSE = '[/kullanıcı]';

// Gövde -> [{ t: satır, u: kullanıcının mı }], işaret satırları atılır.
function parseOwned(body) {
  const out = [];
  let u = false;
  for (const line of String(body || '').replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    if (t === USER_OPEN) { u = true; continue; }
    if (t === USER_CLOSE) { u = false; continue; }
    out.push({ t: line, u });
  }
  return out;
}

function emitOwned(lines) {
  const out = [];
  let u = false;
  for (const l of lines) {
    if (l.u !== u) {
      out.push(l.u ? USER_OPEN : USER_CLOSE);
      u = l.u;
    }
    out.push(l.t);
  }
  if (u) out.push(USER_CLOSE);
  return out.join('\n');
}

const plainBody = (body) => parseOwned(body).map((l) => l.t).join('\n');

// Kullanıcının metin parçaları (boşluklar sadeleştirilmiş): kullanıcı notunda gövdenin tamamı, diğerlerinde bloklar.
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
function userBlocks(note) {
  if (note.by === 'user') return note.body.trim() ? [squash(plainBody(note.body))] : [];
  const blocks = [];
  let cur = null;
  for (const l of parseOwned(note.body)) {
    if (l.u) (cur = cur || []).push(l.t);
    else if (cur) { blocks.push(cur); cur = null; }
  }
  if (cur) blocks.push(cur);
  return blocks.map((b) => squash(b.join('\n'))).filter(Boolean);
}

// Yeni gövdenin kullanıcı blokları verilen kullanıcı parçalarını olduğu gibi içermeli; eksik olanlar döner.
function lostUserText(body, blocks) {
  const have = squash(parseOwned(body).filter((l) => l.u).map((l) => l.t).join('\n'));
  return blocks.filter((b) => !have.includes(b));
}

// Tersi: model kendi yazdığını kullanıcının bloğuna koyamaz. Yeni gövdedeki her kullanıcı bloğu verilen kullanıcı
// parçalarından gelmeli; gelmeyen ilk blok döner.
function forgedUserText(body, blocks) {
  const allowed = blocks.join(' ');
  const out = [];
  let cur = null;
  for (const l of parseOwned(body)) {
    if (l.u) (cur = cur || []).push(l.t);
    else if (cur) { out.push(squash(cur.join('\n'))); cur = null; }
  }
  if (cur) out.push(squash(cur.join('\n')));
  return out.find((b) => b && !allowed.includes(b)) || null;
}

// Kullanıcının kaydı: eski satırlarla eşleşen satır sahibini korur, yeni ya da değişen satır kullanıcının olur.
function diffOwnership(oldLines, texts) {
  const n = oldLines.length;
  const m = texts.length;
  if (n * m > 4e6) {
    const pool = new Map();
    for (const l of oldLines) pool.set(l.t, (pool.get(l.t) || []).concat(l.u));
    return texts.map((t) => {
      const p = pool.get(t);
      return { t, u: p && p.length ? p.shift() : true };
    });
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i].t === texts[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && oldLines[i].t === texts[j]) { out.push({ t: texts[j], u: oldLines[i].u }); i++; j++; }
    else if (i < n && dp[i + 1][j] >= dp[i][j + 1]) i++;
    else { out.push({ t: texts[j], u: !!texts[j].trim() }); j++; }
  }
  // Boş satır kendi başına sahip belirlemez: iki kullanıcı satırı arasındaki boşluk bloğu bölmesin.
  for (let k = 1; k < out.length - 1; k++) if (!out[k].t.trim() && out[k - 1].u && out[k + 1].u) out[k].u = true;
  return out;
}

const members = (group) => group.sessions.filter((s) => !s.removed);
function actorName(group, actor) {
  if (actor === 'user') return 'kullanıcı';
  if (actor === CURATOR) return 'not düzenleyici';
  const s = group.sessions.find((x) => x.id === actor);
  return s ? s.name : 'bilinmeyen üye';
}

// Not düzenleyicinin özetindeki ekleyen: ad ve rol.
function actorLabel(group, actor) {
  const s = group.sessions.find((x) => x.id === actor);
  return s && s.roleLabel && s.roleLabel !== s.name ? `${s.name} (${s.roleLabel})` : actorName(group, actor);
}

function checkLen(title, body) {
  if (title != null && String(title).trim().length > MAX_TITLE) throw new NoteError(400, `Başlık en fazla ${MAX_TITLE} karakter olabilir.`);
  if (body != null && String(body).trim().length > MAX_BODY) throw new NoteError(400, `Not içeriği en fazla ${MAX_BODY} karakter olabilir (${String(body).trim().length}); kısalt ya da ikiye böl.`);
}

// Yeni not bildirimi birkaç saniye bekletilir; art arda eklenen notlar tek bildirimde gider.
const SETTLE_MS = 15000;

class Notes {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'notes');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(gid) {
    return path.join(this.dir, `${gid}.json`);
  }

  // { seq, notes: [{ id, title, body, by, createdAt, updatedAt, updatedBy, to: [sid], delivered: { sid: ts },
  //   history: [{ title, body, by, at }], archived, mergedInto }], pending: { sid: [{ id, kind, ts }] },
  //   reminders: { sid: [{ text, ts }] }, qseq, questions: [{ id, text, notes: [id], askedAt, sentAt, answer, answeredAt }] }
  load(gid) {
    try {
      const n = JSON.parse(fs.readFileSync(this.file(gid), 'utf8'));
      if (n && Array.isArray(n.notes)) return { pending: {}, reminders: {}, qseq: 0, questions: [], ...n };
    } catch {}
    return { seq: 0, notes: [], pending: {}, reminders: {}, qseq: 0, questions: [] };
  }

  // Değişmeden önceki sürüm geçmişe yazılır; kullanıcı her sürüme geri dönebilir.
  remember(note) {
    note.history = (note.history || []).concat({ title: note.title, body: note.body, by: note.updatedBy || note.by, at: note.updatedAt }).slice(-HISTORY_MAX);
  }

  find(n, id) {
    const note = n.notes.find((x) => x.id === Number(id));
    if (!note) throw new NoteError(404, `Not bulunamadı: #${id}`);
    return note;
  }

  save(gid, n) {
    const f = this.file(gid);
    fs.writeFileSync(f + '.tmp', JSON.stringify(n, null, 2));
    fs.renameSync(f + '.tmp', f);
  }

  queue(n, group, note, actor, kind) {
    for (const sid of note.to) {
      if (sid === actor || !members(group).some((s) => s.id === sid)) continue;
      const list = (n.pending[sid] || []).filter((p) => p.id !== note.id);
      list.push({ id: note.id, kind, ts: Date.now() });
      n.pending[sid] = list.slice(-20);
    }
  }

  // to: alıcı oturum kimlikleri; verilmezse ekleyen dışındaki tüm üyeler. Boş liste: kimseye bildirilmez.
  create(group, { title, body, to }, actor) {
    const n = this.load(group.id);
    checkLen(title, body);
    const t = clean(title, MAX_TITLE);
    if (!t) throw new NoteError(400, 'Not başlığı gerekli.');
    const now = Date.now();
    const note = {
      id: ++n.seq,
      title: t,
      // Kullanıcının notu bütünüyle onundur, işaret gerekmez; model de yeni notta kullanıcı işareti kullanamaz.
      body: plainBody(clean(body, MAX_BODY)),
      by: actor,
      createdAt: now,
      updatedAt: now,
      to: (Array.isArray(to) ? to : members(group).map((s) => s.id)).filter((sid) => sid !== actor),
      delivered: {},
    };
    n.notes.push(note);
    this.queue(n, group, note, actor, 'new');
    this.save(group.id, n);
    return note;
  }

  // Notu ekleyen, kullanıcı ya da not düzenleyici değiştirebilir. expect: yazanın okuduğu sürümün updatedAt değeri;
  // not o zamandan beri değiştiyse yazım reddedilir. Kullanıcı gövdeyi işaretsiz gönderir, satır sahipliği sunucuda
  // yeniden hesaplanır; diğerleri kullanıcının metnini [kullanıcı] blokları içinde olduğu gibi korumak zorundadır.
  // İçerik değiştiyse alıcılara "güncellendi" bildirimi gider; not düzenleyicinin düzenlemesi bildirilmez.
  update(group, id, { title, body, expect }, actor) {
    const n = this.load(group.id);
    const note = this.find(n, id);
    if (note.archived) throw new NoteError(409, `#${note.id} arşivde${note.mergedInto ? ` (#${note.mergedInto} notuyla birleştirildi)` : ''}; güncel not ${note.mergedInto ? `#${note.mergedInto}` : 'yok'}.`);
    if (expect != null && Number(expect) !== note.updatedAt) throw new NoteError(409, `#${note.id} sen okuduktan sonra değişti; not_oku ile yeniden oku, sonra düzenle.`);
    if (actor !== 'user' && actor !== CURATOR && note.by !== actor) throw new NoteError(403, `#${note.id} notunu ${actorName(group, note.by)} ekledi; yalnızca o ya da kullanıcı değiştirebilir. Ek bilgi için yeni not ekle.`);
    if (actor !== 'user' && note.by === 'user' && (body != null || title != null)) throw new NoteError(403, `#${note.id} kullanıcının notu; değiştirilemez. Gerekirse başka bir notla birleştir (kullanıcının metni [kullanıcı] bloğunda olduğu gibi kalmalı).`);
    checkLen(title, body);
    let nextTitle = note.title;
    let nextBody = note.body;
    if (title != null) {
      nextTitle = clean(title, MAX_TITLE);
      if (!nextTitle) throw new NoteError(400, 'Not başlığı boş olamaz.');
    }
    if (body != null) {
      const b = clean(body, MAX_BODY);
      if (actor === 'user') {
        const texts = plainBody(b).split('\n');
        nextBody = note.by === 'user' ? texts.join('\n') : emitOwned(diffOwnership(parseOwned(note.body), texts));
      } else {
        const lost = lostUserText(b, userBlocks(note));
        if (lost.length) throw new NoteError(400, `Kullanıcının yazdığı kısım silinmiş ya da değişmiş; ${USER_OPEN} … ${USER_CLOSE} blokları olduğu gibi kalmalı. Eksik: "${short(lost[0], 120)}"`);
        const forged = forgedUserText(b, userBlocks(note));
        if (forged) throw new NoteError(400, `${USER_OPEN} bloğuna yalnızca kullanıcının yazdığı metin girer; kendi eklediğin metni bloğun dışına yaz. Fazla: "${short(forged, 120)}"`);
        nextBody = b;
      }
      if (nextBody.length > MAX_BODY) throw new NoteError(400, `Not içeriği işaretlerle birlikte ${MAX_BODY} karakteri aşıyor; kısalt.`);
    }
    if (nextTitle === note.title && nextBody === note.body) return note;
    this.remember(note);
    note.title = nextTitle;
    note.body = nextBody;
    note.updatedAt = Date.now();
    note.updatedBy = actor;
    if (actor !== CURATOR) this.queue(n, group, note, actor, 'edit');
    this.save(group.id, n);
    return note;
  }

  // Kullanıcı notu geçmişteki bir sürüme döndürür (o anki sürüm de geçmişe yazılır).
  restore(group, id, index) {
    const n = this.load(group.id);
    const note = this.find(n, id);
    const h = (note.history || [])[Number(index)];
    if (!h) throw new NoteError(404, 'Bu sürüm bulunamadı.');
    this.remember(note);
    note.title = h.title;
    note.body = h.body;
    note.updatedAt = Date.now();
    note.updatedBy = 'user';
    this.save(group.id, n);
    return note;
  }

  // Not düzenleyicinin birleştirmesi: kaynak notlar hedefe katılır ve arşive alınır (silinmez, mergedInto ile hedefi
  // gösterir). Kaynakların ve hedefin kullanıcı metni yeni gövdede [kullanıcı] blokları içinde olduğu gibi durmalı.
  // expect: { id: updatedAt } okunan sürümler.
  merge(group, targetId, sourceIds, { title, body, expect }, actor) {
    const n = this.load(group.id);
    const target = this.find(n, targetId);
    const ids = [...new Set((sourceIds || []).map(Number))].filter((x) => x !== target.id);
    if (!ids.length) throw new NoteError(400, 'Birleştirilecek en az bir kaynak not gerekli.');
    const sources = ids.map((x) => this.find(n, x));
    const all = [target, ...sources];
    for (const x of all) {
      if (x.archived) throw new NoteError(409, `#${x.id} zaten arşivde${x.mergedInto ? ` (#${x.mergedInto} ile birleştirildi)` : ''}.`);
      const e = expect && expect[x.id];
      if (e == null) throw new NoteError(400, `#${x.id} için okuduğun sürüm (surumler alanında updatedAt) gerekli; önce not_oku.`);
      if (Number(e) !== x.updatedAt) throw new NoteError(409, `#${x.id} sen okuduktan sonra değişti; yeniden oku.`);
    }
    if (target.by === 'user') throw new NoteError(403, `#${target.id} kullanıcının notu; hedef olamaz. Onu kaynak yap, metni yeni notta [kullanıcı] bloğunda kalsın.`);
    checkLen(title, body);
    const b = clean(body, MAX_BODY);
    if (!b) throw new NoteError(400, 'Birleşmiş notun içeriği gerekli.');
    const owned = all.flatMap((x) => userBlocks(x));
    const lost = lostUserText(b, owned);
    if (lost.length) throw new NoteError(400, `Kullanıcının yazdığı kısım yeni gövdede ${USER_OPEN} … ${USER_CLOSE} bloğu içinde olduğu gibi yok. Eksik: "${short(lost[0], 120)}"`);
    const forged = forgedUserText(b, owned);
    if (forged) throw new NoteError(400, `${USER_OPEN} bloğuna yalnızca kullanıcının yazdığı metin girer; kendi eklediğin metni bloğun dışına yaz. Fazla: "${short(forged, 120)}"`);
    const now = Date.now();
    this.remember(target);
    if (title != null && clean(title, MAX_TITLE)) target.title = clean(title, MAX_TITLE);
    target.body = b;
    target.updatedAt = now;
    target.updatedBy = actor;
    target.to = [...new Set([...target.to, ...sources.flatMap((x) => x.to)])];
    for (const x of sources) {
      x.archived = true;
      x.mergedInto = target.id;
      x.archivedAt = now;
      x.archivedBy = actor;
    }
    for (const sid of Object.keys(n.pending)) {
      n.pending[sid] = n.pending[sid].filter((p) => !ids.includes(p.id));
      if (!n.pending[sid].length) delete n.pending[sid];
    }
    this.save(group.id, n);
    return target;
  }

  // Arşivdeki notu geri getirir (birleştirmenin geri alınması; hedefin önceki sürümü geçmişinde durur).
  unarchive(group, id) {
    const n = this.load(group.id);
    const note = this.find(n, id);
    if (!note.archived) return note;
    note.archived = false;
    delete note.mergedInto;
    delete note.archivedAt;
    delete note.archivedBy;
    this.save(group.id, n);
    return note;
  }

  remove(group, id, actor) {
    const n = this.load(group.id);
    const note = this.find(n, id);
    if (actor !== 'user' && note.by !== actor) throw new NoteError(403, 'Yalnızca kendi eklediğin notu silebilirsin.');
    n.notes = n.notes.filter((x) => x !== note);
    for (const sid of Object.keys(n.pending)) {
      n.pending[sid] = n.pending[sid].filter((p) => p.id !== note.id);
      if (!n.pending[sid].length) delete n.pending[sid];
    }
    this.save(group.id, n);
    return { ok: true };
  }

  // Not düzenleyicinin şefe sorusu (çelişen bilgi). Toplu olarak şefe hatırlatma yoluyla iletilir (sendQuestions).
  ask(group, text, noteIds) {
    const n = this.load(group.id);
    const t = clean(text, 2000);
    if (!t) throw new NoteError(400, 'Soru boş olamaz.');
    const ids = (noteIds || []).map(Number).filter((x) => n.notes.some((y) => y.id === x));
    if (n.questions.some((q) => !q.answer && squash(q.text) === squash(t))) throw new NoteError(409, 'Bu soru zaten şefe soruldu, cevap bekleniyor.');
    const q = { id: ++n.qseq, text: t, notes: ids, askedAt: Date.now(), sentAt: null, answer: null, answeredAt: null };
    n.questions.push(q);
    n.questions = n.questions.slice(-50);
    this.save(group.id, n);
    return q;
  }

  answer(group, qid, text) {
    const n = this.load(group.id);
    const q = n.questions.find((x) => x.id === Number(qid));
    if (!q) throw new NoteError(404, `Soru bulunamadı: S${qid}`);
    const t = clean(text, 4000);
    if (!t) throw new NoteError(400, 'Cevap boş olamaz.');
    q.answer = t;
    q.answeredAt = Date.now();
    this.save(group.id, n);
    return q;
  }

  // Henüz gönderilmemiş soruları tek mesajda şefe iletir.
  sendQuestions(group, leadId) {
    const n = this.load(group.id);
    const fresh = n.questions.filter((q) => !q.sentAt && !q.answer);
    if (!fresh.length || !leadId) return 0;
    const now = Date.now();
    for (const q of fresh) q.sentAt = now;
    this.save(group.id, n);
    const text = prompts.message('not-duzenleyici-sorusu', {
      sorular: fresh.map((q) => `- S${q.id}${q.notes.length ? ` (${q.notes.map((x) => `#${x}`).join(', ')})` : ''}: ${q.text}`).join('\n'),
    });
    this.remind(group, [leadId], text);
    return fresh.length;
  }

  // Kullanıcının seçip gönderdiği hatırlatma (not ya da proje dokümanı, tamamı ya da bir kısmı); beklemeden iletilir.
  remind(group, to, text) {
    const n = this.load(group.id);
    for (const sid of to) {
      if (!members(group).some((s) => s.id === sid)) continue;
      n.reminders[sid] = (n.reminders[sid] || []).concat({ text, ts: Date.now() }).slice(-5);
    }
    this.save(group.id, n);
  }

  // Yenilenen üyenin bekleyen not bildirimleri ve hatırlatmaları yeni oturuma geçer.
  reassign(gid, from, to) {
    const n = this.load(gid);
    if (n.pending[from]) n.pending[to] = n.pending[from];
    if (n.reminders[from]) n.reminders[to] = n.reminders[from];
    delete n.pending[from];
    delete n.reminders[from];
    this.save(gid, n);
  }

  // İletime hazır bildirim: hatırlatma varsa hemen; not bildiriminde en son eklenenin üstünden SETTLE_MS geçmiş olmalı.
  hasPending(gid, sid) {
    const n = this.load(gid);
    if ((n.reminders[sid] || []).length) return true;
    const list = n.pending[sid];
    return !!(list && list.length && Date.now() - Math.max(...list.map((p) => p.ts)) >= SETTLE_MS);
  }

  pendingFor(group, sid, take) {
    const n = this.load(group.id);
    const list = n.pending[sid] || [];
    const reminders = n.reminders[sid] || [];
    if (!list.length && !reminders.length) return null;
    const items = list.map((p) => ({ p, note: n.notes.find((x) => x.id === p.id) })).filter((x) => x.note);
    if (take) {
      delete n.pending[sid];
      delete n.reminders[sid];
      for (const { note } of items) note.delivered[sid] = Date.now();
      this.save(group.id, n);
    }
    const parts = reminders.map((r) => r.text);
    if (items.length) parts.push(this.noticeText(group, items));
    return parts.length ? parts.join('\n\n') : null;
  }

  noticeText(group, items) {
    const lines = [];
    for (const { p, note } of items) {
      const who = actorName(group, p.kind === 'edit' ? note.updatedBy || note.by : note.by);
      lines.push(`- #${note.id} "${note.title}" — ${who} ${p.kind === 'edit' ? 'güncelledi' : 'ekledi'}${note.body ? `: ${short(plainBody(note.body), 160)}` : ''}`);
    }
    return prompts.message('grup-notlari', { maddeler: lines.join('\n') });
  }
}

// ---------- MCP tool'ları (panelin "panel" sunucusunda, pano tool'larıyla birlikte) ----------

const OWN_TEXT = `${USER_OPEN} … ${USER_CLOSE} arasındaki satırlar kullanıcının yazdığıdır: olduğu gibi koru, değiştirme ya da silme.`;

const NOTE_TOOLS = [
  {
    name: 'not_listele',
    description: 'Ekibin ortak not defterindeki notları listeler (Maestro grup notları): numara, başlık, ekleyen, kısa önizleme.',
    inputSchema: { type: 'object', properties: { ara: { type: 'string', description: 'başlıkta ya da içerikte geçen kelime (isteğe bağlı)' } } },
  },
  {
    name: 'not_oku',
    description: 'Bir grup notunun tamamını okur.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'not numarası (#)' } }, required: ['id'] },
  },
  {
    name: 'not_ekle',
    description: 'Ekibin ortak not defterine not ekler: karar, bulgu, ortak bilgi (ör. API sözleşmesi, ortam bilgisi, kural). '
      + 'Panel diğer üyelere "şu üye şu başlıklı not ekledi" diye kısa bildirim gönderir. Görev vermek için not değil pano_ekle kullan.',
    inputSchema: {
      type: 'object',
      properties: {
        baslik: { type: 'string', description: 'notun kısa başlığı; bildirimde bu görünür' },
        icerik: { type: 'string', description: 'notun tamamı (Markdown olabilir)' },
        kime: { type: 'string', description: 'bildirim alacak üyeler: "herkes" (varsayılan), "kimse" ya da virgülle ayrılmış üye / rol adları' },
      },
      required: ['baslik'],
    },
  },
  {
    name: 'not_guncelle',
    description: `Kendi eklediğin bir notun başlığını ya da içeriğini değiştirir; alıcılara güncellendiği bildirilir. ${OWN_TEXT}`,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, baslik: { type: 'string' }, icerik: { type: 'string' } },
      required: ['id'],
    },
  },
];

// Yalnızca şefte: not düzenleyicinin sorularını cevaplamak için.
const NOTE_LEAD_TOOLS = [
  {
    name: 'not_sorusu_cevapla',
    description: 'Not düzenleyicinin "[Maestro · Not düzenleyici]" mesajıyla sorduğu çelişki sorusunu cevaplar; düzenleyici notları sonraki düzenlemede buna göre netleştirir.',
    inputSchema: {
      type: 'object',
      properties: { soru: { type: 'number', description: 'soru numarası (S3 için 3)' }, cevap: { type: 'string', description: 'hangisinin doğru olduğu ya da doğru bilgi' } },
      required: ['soru', 'cevap'],
    },
  },
];

const fmt = (ts) => new Date(ts).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function noteLine(group, note) {
  return `#${note.id} "${note.title}" · ${actorName(group, note.by)} · ${fmt(note.createdAt)}${note.by === 'user' ? ' · [kullanıcı notu]' : ''}`;
}

// Notun okunuşu: sahiplik açıklaması ve gövde. withVersion: düzenleyicinin yazarken vereceği sürüm.
function noteText(group, note, withVersion) {
  const head = [`${noteLine(group, note)}${note.updatedBy ? ` (son değiştiren ${actorName(group, note.updatedBy)}, ${fmt(note.updatedAt)})` : ''}`];
  if (withVersion) head.push(`surum: ${note.updatedAt}`);
  if (note.by === 'user') head.push('Bu notun tamamını kullanıcı yazdı.');
  else if (userBlocks(note).length) head.push(OWN_TEXT);
  return `${head.join('\n')}\n\n${note.body || '(içerik yok)'}`;
}

function readNote(notes, group, id, withVersion) {
  const all = notes.load(group.id).notes;
  let note = all.find((x) => x.id === Number(id));
  if (!note) throw new NoteError(404, `Not bulunamadı: #${id}`);
  let prefix = '';
  // Birleştirilmiş not: güncel hali hedefte.
  for (let i = 0; note.archived && note.mergedInto && i < 10; i++) {
    const next = all.find((x) => x.id === note.mergedInto);
    if (!next) break;
    prefix = `#${id} #${next.id} notuyla birleştirildi; güncel hali:\n\n`;
    note = next;
  }
  return prefix + noteText(group, note, withVersion);
}

function listNotes(notes, group, q) {
  let list = notes.load(group.id).notes.filter((x) => !x.archived);
  if (q) list = list.filter((x) => `${x.title}\n${x.body}`.toLocaleLowerCase('tr').includes(q));
  if (!list.length) return q ? 'Bu kelimeyi içeren not yok.' : 'Not defteri boş.';
  return list.slice().reverse().map((x) => `${noteLine(group, x)}${x.body ? `\n  ${short(plainBody(x.body), 200)}` : ''}`).join('\n');
}

// resolve: board.js resolveMember (aynı üye adı kuralları).
function callNoteTool(notes, group, sid, name, args, resolve) {
  const a = args || {};
  if (name === 'not_listele') return listNotes(notes, group, clean(a.ara, 100).toLocaleLowerCase('tr'));
  if (name === 'not_oku') return readNote(notes, group, a.id, false);
  if (name === 'not_ekle') {
    let to;
    const k = clean(a.kime, 1000);
    if (/^(kimse|yok|hiç kimse)$/i.test(k)) to = [];
    else if (k && !/^(herkes|hepsi|tümü|all)$/i.test(k)) {
      to = [...new Set(k.split(',').map((x) => resolve(group, x, sid)).filter(Boolean))];
    }
    const note = notes.create(group, { title: a.baslik, body: a.icerik, to }, sid);
    const names = note.to.map((x) => (group.sessions.find((s) => s.id === x) || {}).roleLabel).filter(Boolean);
    return `Not eklendi: ${noteLine(group, note)}. ${names.length ? `Bildirilecek: ${names.join(', ')}.` : 'Kimseye bildirilmeyecek.'}`;
  }
  if (name === 'not_guncelle') {
    const note = notes.update(group, a.id, { title: a.baslik, body: a.icerik }, sid);
    return `Güncellendi: ${noteLine(group, note)}`;
  }
  if (name === 'not_sorusu_cevapla') {
    const q = notes.answer(group, a.soru, a.cevap);
    return `S${q.id} cevabı kaydedildi; not düzenleyici notları sonraki düzenlemede buna göre netleştirecek.`;
  }
  return undefined;
}

// ---------- not düzenleyicinin tool'ları (server/curator.js, ayrı MCP adresi) ----------

const CURATOR_TOOLS = [
  {
    name: 'not_listele',
    description: 'Arşivde olmayan notları listeler: numara, başlık, ekleyen, tarih, kısa önizleme.',
    inputSchema: { type: 'object', properties: { ara: { type: 'string', description: 'başlıkta ya da içerikte geçen kelime (isteğe bağlı)' } } },
  },
  {
    name: 'not_oku',
    description: 'Bir notun tamamını ve sürümünü (surum) okur. Düzenlemeden ve birleştirmeden önce mutlaka oku.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'not_duzenle',
    description: `Bir notun başlığını ya da içeriğini yeniden düzenler (tekrarları ayıklamak, toparlamak, netleştirmek). Bilgi kaybetme. ${OWN_TEXT} Kullanıcının kendi notu düzenlenemez.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        baslik: { type: 'string' },
        icerik: { type: 'string', description: 'notun yeni tam içeriği' },
        surum: { type: 'number', description: 'not_oku\'nun verdiği surum' },
      },
      required: ['id', 'surum'],
    },
  },
  {
    name: 'not_birlestir',
    description: 'Aynı konudaki notları tek notta birleştirir: hedef not yeni içerikle güncellenir, kaynak notlar arşive alınır (silinmez, '
      + `hedefi gösterir). Yeni içerik hedefin ve kaynakların tüm bilgisini taşımalı. ${OWN_TEXT} Kullanıcının notu kaynak olabilir, hedef olamaz; `
      + `onun metni yeni içerikte ${USER_OPEN} … ${USER_CLOSE} bloğu içinde olduğu gibi yer almalı.`,
    inputSchema: {
      type: 'object',
      properties: {
        hedef: { type: 'number', description: 'kalacak notun numarası' },
        kaynaklar: { type: 'array', items: { type: 'number' }, description: 'hedefe katılıp arşive alınacak notlar' },
        baslik: { type: 'string' },
        icerik: { type: 'string', description: 'birleşmiş notun tam içeriği' },
        surumler: { type: 'object', description: 'hedef ve her kaynak için not_oku\'nun verdiği surum: {"12": 1760000000000, ...}' },
      },
      required: ['hedef', 'kaynaklar', 'icerik', 'surumler'],
    },
  },
  {
    name: 'sefe_sor',
    description: 'Notlarda çelişen bilgi varsa ve hangisinin doğru olduğu notlardan ya da projeden anlaşılmıyorsa şefe sorar. '
      + 'Sorular tur sonunda tek mesajda iletilir; cevap sonraki düzenlemede sana verilir. Çelişkiyi tahminle çözme.',
    inputSchema: {
      type: 'object',
      properties: { soru: { type: 'string', description: 'çelişkiyi ve seçenekleri açıkça yaz' }, notlar: { type: 'array', items: { type: 'number' } } },
      required: ['soru'],
    },
  },
];

function callCuratorTool(notes, group, name, args) {
  const a = args || {};
  if (name === 'not_listele') return listNotes(notes, group, clean(a.ara, 100).toLocaleLowerCase('tr'));
  if (name === 'not_oku') return readNote(notes, group, a.id, true);
  if (name === 'not_duzenle') {
    const note = notes.update(group, a.id, { title: a.baslik, body: a.icerik, expect: a.surum }, CURATOR);
    return `Düzenlendi: ${noteLine(group, note)} · yeni surum: ${note.updatedAt}`;
  }
  if (name === 'not_birlestir') {
    const note = notes.merge(group, a.hedef, a.kaynaklar, { title: a.baslik, body: a.icerik, expect: a.surumler }, CURATOR);
    return `Birleştirildi: ${noteLine(group, note)} · yeni surum: ${note.updatedAt}; ${(a.kaynaklar || []).map((x) => `#${x}`).join(', ')} arşive alındı.`;
  }
  if (name === 'sefe_sor') {
    const q = notes.ask(group, a.soru, a.notlar);
    return `Soru S${q.id} kaydedildi; tur sonunda şefe iletilecek.`;
  }
  throw new NoteError(400, `Bilinmeyen tool: ${name}`);
}

module.exports = {
  Notes, NoteError, NOTE_TOOLS, NOTE_LEAD_TOOLS, CURATOR_TOOLS, CURATOR, callNoteTool, callCuratorTool,
  SETTLE_MS, plainBody, userBlocks, actorLabel, USER_OPEN, USER_CLOSE,
};
