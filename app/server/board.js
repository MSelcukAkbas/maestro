// Görev panosu: grup başına data/boards/<grup>.json. Kartları kullanıcı arayüzden, ekip üyeleri panelin MCP
// tool'larıyla değiştirir. Bir değişiklik başka bir üyeyi ilgilendiriyorsa kartta o üye için "iletilecek" kaydı
// tutulur; panel bunu üyeye durmak üzereyken hook yanıtıyla ya da boştaysa terminaline yazarak iletir ve kaydı
// "iletildi"ye çevirir.
// Kayıtlar dosyada durduğu için panel yeniden başlasa da, üye o sırada kapalı olsa da iletim kaybolmaz.
const fs = require('fs');
const path = require('path');

const STATUSES = ['todo', 'doing', 'review', 'done'];
const STATUS_TEXT = { todo: 'yapılacak', doing: 'yapılıyor', review: 'review', done: 'bitti' };
// MCP tool'larında Türkçe durum adları da kabul edilir.
const STATUS_ALIAS = {
  todo: 'todo', 'yapılacak': 'todo', yapilacak: 'todo',
  doing: 'doing', 'yapılıyor': 'doing', yapiliyor: 'doing',
  review: 'review', inceleme: 'review',
  done: 'done', bitti: 'done',
};

class BoardError extends Error {
  constructor(status, message, card) {
    super(message);
    this.status = status;
    this.card = card;
  }
}

function clean(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max);
}

// Çok satırlı metni satır yapısını koruyarak girintiler; kart açıklaması ve notlar kısaltılmadan iletilir.
function indent(s, pad) {
  return String(s == null ? '' : s).trim().split(/\r?\n/).map((l) => pad + l).join('\n');
}

function parseStatus(v) {
  if (v == null || v === '') return null;
  const k = STATUS_ALIAS[String(v).trim().toLowerCase()];
  if (!k) throw new BoardError(400, `Geçersiz durum: ${v}. Geçerli durumlar: ${STATUSES.map((s) => STATUS_TEXT[s]).join(', ')}.`);
  return k;
}

function members(group) {
  return group.sessions.filter((s) => !s.removed);
}

function memberName(group, sid) {
  const s = group.sessions.find((x) => x.id === sid);
  return s ? s.name : 'bilinmeyen üye';
}

function actorName(group, actor) {
  return actor === 'user' ? 'kullanıcı' : memberName(group, actor);
}

function lead(group) {
  return members(group).find((s) => s.roleId === 'sef') || null;
}

// Atanan kişi: oturum kimliği, tam ad ya da gruptaki tek bir üyeye denk gelen rol adı / kısa ad.
// "ben" çağıran üyeyi, boş değer ya da "yok" atamanın kaldırılmasını anlatır.
function resolveMember(group, value, self) {
  if (value == null) return undefined;
  const v = String(value).trim();
  if (!v || /^(yok|kimse|-|none|null)$/i.test(v)) return null;
  if (self && /^(ben|kendim|me|self)$/i.test(v)) return self;
  const list = members(group);
  const byId = list.find((s) => s.id === v);
  if (byId) return byId.id;
  const lower = v.toLocaleLowerCase('tr');
  const byName = list.find((s) => s.name.toLocaleLowerCase('tr') === lower);
  if (byName) return byName.id;
  const byRole = list.filter((s) => [s.roleLabel, s.roleId].some((x) => x && x.toLocaleLowerCase('tr') === lower)
    || (s.name.split(' · ')[1] || '').toLocaleLowerCase('tr') === lower);
  if (byRole.length === 1) return byRole[0].id;
  if (byRole.length > 1) throw new BoardError(400, `"${v}" birden çok üyeye uyuyor; tam adı kullan: ${byRole.map((s) => s.name).join(', ')}`);
  throw new BoardError(400, `Üye bulunamadı: "${v}". Ekip: ${list.map((s) => s.name).join(', ')}`);
}

class Boards {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'boards');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(gid) {
    return path.join(this.dir, `${gid}.json`);
  }

  load(gid) {
    try {
      const b = JSON.parse(fs.readFileSync(this.file(gid), 'utf8'));
      if (b && Array.isArray(b.cards)) return b;
    } catch {}
    return { seq: 0, cards: [] };
  }

  save(gid, b) {
    const f = this.file(gid);
    fs.writeFileSync(f + '.tmp', JSON.stringify(b, null, 2));
    fs.renameSync(f + '.tmp', f);
  }

  // Değişikliğin kimi ilgilendirdiği ve her alıcıya ne anlatılacağı. Değişikliği yapan kendine bildirilmez.
  notify(group, card, before, actor, changes) {
    const to = new Map();
    const add = (sid, text) => {
      if (!sid || sid === actor || !members(group).some((s) => s.id === sid)) return;
      if (!to.has(sid)) to.set(sid, []);
      to.get(sid).push(text);
    };
    const statusChanged = before && before.status !== card.status;
    if (card.assignee) {
      if (!before || before.assignee !== card.assignee) add(card.assignee, 'sana atandı');
      else if (changes.length) add(card.assignee, changes.join('; '));
    }
    if (before && before.assignee && before.assignee !== card.assignee) add(before.assignee, `artık sana atanmış değil (${actorName(group, actor)} değiştirdi)`);
    if (statusChanged && card.status === 'review') {
      const reviewers = members(group).filter((s) => s.roleId === 'review' && s.id !== card.assignee);
      if (reviewers.length) for (const r of reviewers) add(r.id, 'incelemeye (review) geldi; incele ve sonucu kartta güncelle');
      else add(lead(group) && lead(group).id, 'incelemeye (review) geldi');
    }
    const l = lead(group);
    if (l && l.id !== card.assignee) {
      if (statusChanged && (card.status === 'done' || before.status === 'review')) add(l.id, changes.join('; '));
      else if (!before && !card.assignee && actor === 'user') add(l.id, 'kullanıcı yeni kart açtı, henüz kimseye atanmadı; uygun üyeye ata');
    }
    card.pending = card.pending || {};
    for (const [sid, texts] of to) {
      const prev = card.pending[sid];
      card.pending[sid] = { version: card.version, changes: [...(prev ? prev.changes : []), ...texts].slice(-8) };
    }
  }

  create(group, fields, actor) {
    const b = this.load(group.id);
    const title = clean(fields.title, 200);
    if (!title) throw new BoardError(400, 'Kart başlığı gerekli.');
    const now = Date.now();
    const card = {
      id: ++b.seq,
      title,
      desc: clean(fields.desc, Infinity),
      status: parseStatus(fields.status) || 'todo',
      assignee: fields.assignee || null,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
      version: 1,
      notes: [],
      pending: {},
      delivered: {},
    };
    this.notify(group, card, null, actor, []);
    b.cards.push(card);
    this.save(group.id, b);
    return card;
  }

  // patch: title, desc, status, assignee (oturum kimliği ya da null), note. version verilirse kartın güncel
  // sürümüyle eşleşmeli; eşleşmezse değişiklik uygulanmaz ve güncel kart döner.
  update(group, id, patch, actor, version) {
    const b = this.load(group.id);
    const card = b.cards.find((c) => c.id === Number(id));
    if (!card) throw new BoardError(404, `Kart bulunamadı: #${id}`);
    if (version != null && Number(version) !== card.version) {
      throw new BoardError(409, `Kart #${card.id} sen okuduktan sonra değişti (sürüm ${card.version}). Güncel hâline bakıp yeniden dene.`, card);
    }
    const before = { ...card };
    const changes = [];
    if (patch.title != null) {
      const t = clean(patch.title, 200);
      if (!t) throw new BoardError(400, 'Kart başlığı boş olamaz.');
      if (t !== card.title) { card.title = t; changes.push('başlık değişti'); }
    }
    if (patch.desc != null) {
      const d = clean(patch.desc, Infinity);
      if (d !== card.desc) { card.desc = d; changes.push('açıklama güncellendi'); }
    }
    const st = parseStatus(patch.status);
    if (st && st !== card.status) {
      changes.push(`durum: ${STATUS_TEXT[card.status]} → ${STATUS_TEXT[st]} (${actorName(group, actor)})`);
      card.status = st;
    }
    if (patch.assignee !== undefined && patch.assignee !== card.assignee) {
      card.assignee = patch.assignee;
      changes.push(`atanan: ${card.assignee ? memberName(group, card.assignee) : 'yok'}`);
    }
    const note = clean(patch.note, Infinity);
    if (note) {
      card.notes.push({ ts: Date.now(), by: actor, text: note });
      if (card.notes.length > 50) card.notes.shift();
      changes.push(`not (${actorName(group, actor)}):\n${indent(note, '    ')}`);
    }
    if (!changes.length) return card;
    card.version += 1;
    card.updatedAt = Date.now();
    card.updatedBy = actor;
    this.notify(group, card, before, actor, changes);
    this.save(group.id, b);
    return card;
  }

  remove(group, id, actor) {
    const b = this.load(group.id);
    const i = b.cards.findIndex((c) => c.id === Number(id));
    if (i < 0) throw new BoardError(404, `Kart bulunamadı: #${id}`);
    const [card] = b.cards.splice(i, 1);
    // Silinen kart kendi kaydıyla iletilemez; atanan üyeye iletilmek üzere panoda ayrı tutulur.
    if (card.assignee && card.assignee !== actor && card.status !== 'done') {
      b.removed = (b.removed || []).concat({ id: card.id, title: card.title, assignee: card.assignee, by: actor, ts: Date.now() }).slice(-20);
    }
    this.save(group.id, b);
    return { ok: true };
  }

  // Üyeye iletilecek değişiklikler; take=true ise iletildi olarak işaretlenir.
  pendingFor(group, sid, take) {
    const b = this.load(group.id);
    const items = [];
    for (const c of b.cards) {
      const p = c.pending && c.pending[sid];
      if (!p) continue;
      items.push({ card: c, changes: p.changes });
      if (take) {
        delete c.pending[sid];
        c.delivered = c.delivered || {};
        c.delivered[sid] = c.version;
      }
    }
    const removed = (b.removed || []).filter((r) => r.assignee === sid);
    if (take && removed.length) b.removed = b.removed.filter((r) => r.assignee !== sid);
    if (take && (items.length || removed.length)) this.save(group.id, b);
    if (!items.length && !removed.length) return null;
    return deliveryText(group, sid, items, removed);
  }

  // Yenilenen üyenin kartları ve bekleyen iletimleri yeni oturuma geçer; kimseye bildirim gitmez.
  reassign(gid, from, to) {
    const b = this.load(gid);
    for (const c of b.cards) {
      if (c.assignee === from) c.assignee = to;
      if (c.pending && c.pending[from]) {
        c.pending[to] = c.pending[from];
        delete c.pending[from];
      }
    }
    for (const r of b.removed || []) if (r.assignee === from) r.assignee = to;
    this.save(gid, b);
  }

  hasPending(gid, sid) {
    const b = this.load(gid);
    return b.cards.some((c) => c.pending && c.pending[sid]) || (b.removed || []).some((r) => r.assignee === sid);
  }
}

function cardLine(group, c) {
  return `#${c.id} "${c.title}" · ${STATUS_TEXT[c.status]} · atanan: ${c.assignee ? memberName(group, c.assignee) : 'yok'} · sürüm ${c.version}`;
}

function deliveryText(group, sid, items, removed) {
  const lines = ['[Claude Panel · Görev panosu] Panoda seni ilgilendiren değişiklikler:'];
  for (const { card, changes } of items) {
    lines.push(`- ${cardLine(group, card)} — ${changes.join('; ')}`);
    if (card.assignee === sid && card.desc && changes.some((x) => x === 'sana atandı' || x === 'açıklama güncellendi')) {
      lines.push(`  Açıklama:\n${indent(card.desc, '    ')}`);
    }
  }
  for (const r of removed) lines.push(`- #${r.id} "${r.title}" panodan silindi (${actorName(group, r.by)}); bu kart üzerinde çalışma.`);
  lines.push('Kartın durumu değiştikçe (başladın, incelemeye hazır, bitti, takıldın) panel MCP aracı pano_guncelle ile güncelle; tüm kartlar için pano_listele.');
  return lines.join('\n');
}

// ---------- MCP: ekip üyelerinin panoyu okuyup değiştirdiği tool'lar ----------

const TOOLS = [
  {
    name: 'pano_listele',
    description: 'Ekibin görev panosundaki kartları listeler (Claude Panel). Sana atanan işleri görmek için kapsam "benim" ver. '
      + 'Kart durumları: yapılacak, yapılıyor, review, bitti.',
    inputSchema: {
      type: 'object',
      properties: {
        kapsam: { type: 'string', enum: ['hepsi', 'benim'], description: 'hepsi (varsayılan) ya da yalnızca sana atananlar' },
        durum: { type: 'string', description: 'yalnızca bu durumdaki kartlar: yapılacak, yapılıyor, review, bitti' },
        id: { type: 'number', description: 'yalnızca bu kart, tüm notlarıyla' },
      },
    },
  },
  {
    name: 'pano_ekle',
    description: 'Görev panosuna yeni kart ekler. Bir üyeye atarsan panel kartı ona kendiliğinden iletir; ayrıca SendMessage ile aynı görevi göndermene gerek yok.',
    inputSchema: {
      type: 'object',
      properties: {
        baslik: { type: 'string', description: 'tek cümlelik görev özeti' },
        aciklama: { type: 'string', description: 'ne yapılacak, kabul kriteri, dokunulacak dosyalar' },
        atanan: { type: 'string', description: 'üyenin tam adı ya da rol adı (ör. coder); "ben" kendin' },
        durum: { type: 'string', description: 'yapılacak (varsayılan), yapılıyor, review, bitti' },
      },
      required: ['baslik'],
    },
  },
  {
    name: 'pano_guncelle',
    description: 'Bir kartı günceller: durum, atanan, başlık, açıklama ya da not. İşe başlayınca "yapılıyor", incelemeye hazır olunca "review", '
      + 'bitince "bitti" yap; takılırsan not ekle. Review rolündeysen inceleme sonucunu not olarak yaz; onaylıyorsan "bitti", düzeltme gerekiyorsa "yapılıyor" yap. '
      + 'Panel değişikliği ilgili üyelere (atanan, review, şef) kendiliğinden iletir.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'kart numarası (#)' },
        durum: { type: 'string', description: 'yapılacak, yapılıyor, review, bitti' },
        atanan: { type: 'string', description: 'yeni atanan üye (tam ad ya da rol adı); "yok" atamayı kaldırır' },
        baslik: { type: 'string' },
        aciklama: { type: 'string' },
        not: { type: 'string', description: 'karta eklenecek not (ilerleme, engel, inceleme sonucu)' },
        surum: { type: 'number', description: 'okuduğun kart sürümü; verilirse kart o arada değiştiyse güncelleme reddedilir' },
      },
      required: ['id'],
    },
  },
];

function callTool(boards, group, sid, name, args) {
  const a = args || {};
  if (name === 'pano_listele') {
    if (a.id != null) {
      const c = boards.load(group.id).cards.find((x) => x.id === Number(a.id));
      if (!c) throw new BoardError(404, `Kart bulunamadı: #${a.id}`);
      const notes = c.notes.map((n) => `- ${actorName(group, n.by)}:\n${indent(n.text, '    ')}`).join('\n');
      return `${cardLine(group, c)}\nAçıklama:\n${c.desc ? indent(c.desc, '  ') : '  (yok)'}${notes ? `\nNotlar:\n${notes}` : ''}`;
    }
    const st = parseStatus(a.durum);
    let cards = boards.load(group.id).cards;
    if (a.kapsam === 'benim') cards = cards.filter((c) => c.assignee === sid);
    if (st) cards = cards.filter((c) => c.status === st);
    if (!cards.length) return 'Panoda bu ölçüte uyan kart yok.';
    return cards.map((c) => {
      const last = c.notes.length ? `\n  son not (${actorName(group, c.notes[c.notes.length - 1].by)}):\n${indent(c.notes[c.notes.length - 1].text, '    ')}` : '';
      return `${cardLine(group, c)}${c.desc ? `\n${indent(c.desc, '  ')}` : ''}${last}`;
    }).join('\n');
  }
  if (name === 'pano_ekle') {
    const card = boards.create(group, {
      title: a.baslik, desc: a.aciklama, status: a.durum, assignee: resolveMember(group, a.atanan, sid) || null,
    }, sid);
    return `Kart eklendi: ${cardLine(group, card)}`;
  }
  if (name === 'pano_guncelle') {
    const patch = { title: a.baslik, desc: a.aciklama, status: a.durum, note: a.not };
    const who = resolveMember(group, a.atanan, sid);
    if (who !== undefined) patch.assignee = who;
    const card = boards.update(group, a.id, patch, sid, a.surum);
    return `Güncellendi: ${cardLine(group, card)}`;
  }
  throw new BoardError(400, `Bilinmeyen tool: ${name}`);
}

// Streamable HTTP taşımasının yalnızca JSON yanıtlı kısmı: her istek tek bir JSON-RPC mesajıdır.
// extra: aynı sunucudaki başka tool'lar (grup notları); call tanımadığı tool için undefined döner.
async function handleMcp(boards, group, sid, msg, extra = { tools: [], call: () => undefined }) {
  if (!msg || msg.id === undefined) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-panel', version: '0.1.0' },
        instructions: 'Claude Panel görev panosu ve grup notları. Görevler kartlarda tutulur; kart durumunu işin aşamasına göre pano_guncelle ile güncelle. '
          + 'Ekibin bilmesi gereken kararları ve ortak bilgileri not_ekle ile grup notlarına yaz.',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      // only: yalnızca verilen tool'lar (not düzenleyici pano tool'larını görmez).
      return ok({ tools: extra.only ? extra.tools : [...TOOLS, ...extra.tools] });
    case 'tools/call': {
      const p = msg.params || {};
      try {
        const other = await extra.call(p.name, p.arguments);
        const text = other !== undefined ? other : callTool(boards, group, sid, p.name, p.arguments);
        return ok({ content: [{ type: 'text', text }] });
      } catch (err) {
        const extra = err.card ? `\nGüncel kart: ${cardLine(group, err.card)}` : '';
        return ok({ content: [{ type: 'text', text: `${err.message}${extra}` }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Desteklenmeyen yöntem: ${msg.method}` } };
  }
}

module.exports = { Boards, BoardError, STATUSES, STATUS_TEXT, resolveMember, handleMcp };
