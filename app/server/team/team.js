// Ekip yönetimi: üyelerin ekip durumunu ve hesap kotalarını görmesi (ekip_durumu), şefin rol envanterine bakıp
// üye açma / kapatma / hesap değiştirme isteği göndermesi. İstekler kullanıcı onayına düşer; panel hiçbirini
// kendiliğinden uygulamaz. Sonuç şefe pano ve notlarla aynı iletim yolundan bildirilir.
// İstekler ve şefe gidecek sonuç bildirimleri data/requests.json'da tutulur; panel yeniden başlasa da kaybolmaz.
const fs = require('fs');
const path = require('path');
const prompts = require('../core/prompts');
const { EFFORTS } = require('../core/options');

class TeamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_PENDING = 5;
const MAX_SESSIONS = 12;
const KIND_TEXT = {
  add: 'yeni üye aç', stop: 'üyeyi kapat', remove: 'üyeyi ekipten çıkar', account: 'üyenin hesabını değiştir',
  settings: 'üyenin model / effort ayarını değiştir', caps: 'üyenin yeteneklerini değiştir',
};

const clean = (s, max) => String(s == null ? '' : s).trim().slice(0, max);
function short(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
const fmt = (ts) => new Date(ts).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

class Requests {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'requests.json');
  }

  // { seq, list: [{ id, groupId, by, kind, args, reason, status, createdAt, decidedAt, result }], inbox: { sid: [text] } }
  load() {
    try {
      const r = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (r && Array.isArray(r.list)) return { inbox: {}, ...r };
    } catch {}
    return { seq: 0, list: [], inbox: {} };
  }

  save(r) {
    // Karar verilmiş eski istekler atılır; bekleyenler her zaman kalır.
    const done = r.list.filter((x) => x.status !== 'pending');
    if (done.length > 100) {
      const drop = new Set(done.slice(0, done.length - 100));
      r.list = r.list.filter((x) => !drop.has(x));
    }
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(r, null, 2));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  pending(gid) {
    return this.load().list.filter((x) => x.groupId === gid && x.status === 'pending');
  }

  get(id) {
    return this.load().list.find((x) => x.id === Number(id)) || null;
  }

  create(gid, by, kind, args, reason) {
    const r = this.load();
    const open = r.list.filter((x) => x.groupId === gid && x.status === 'pending');
    if (open.length >= MAX_PENDING) throw new TeamError(429, `Onay bekleyen ${open.length} isteğin var; kullanıcı bunlara karar verene kadar yeni istek gönderme.`);
    const same = open.find((x) => x.kind === kind && JSON.stringify(x.args) === JSON.stringify(args));
    if (same) throw new TeamError(409, `Aynı istek zaten onay bekliyor (#${same.id}).`);
    const req = { id: ++r.seq, groupId: gid, by, kind, args, reason: clean(reason, 1000), status: 'pending', createdAt: Date.now() };
    r.list.push(req);
    this.save(r);
    return req;
  }

  decide(id, status, result) {
    const r = this.load();
    const req = r.list.find((x) => x.id === Number(id));
    if (!req) throw new TeamError(404, 'İstek bulunamadı.');
    if (req.status !== 'pending') throw new TeamError(409, `İstek zaten ${req.status === 'rejected' ? 'reddedildi' : 'karara bağlandı'}.`);
    req.status = status;
    req.decidedAt = Date.now();
    req.result = clean(result, 2000);
    this.save(r);
    return req;
  }

  notify(sid, text) {
    const r = this.load();
    r.inbox[sid] = (r.inbox[sid] || []).concat(text).slice(-10);
    this.save(r);
  }

  reassign(from, to) {
    const r = this.load();
    if (!r.inbox[from]) return;
    r.inbox[to] = (r.inbox[to] || []).concat(r.inbox[from]);
    delete r.inbox[from];
    this.save(r);
  }

  hasInbox(sid) {
    const list = this.load().inbox[sid];
    return !!(list && list.length);
  }

  takeInbox(sid) {
    const r = this.load();
    const list = r.inbox[sid];
    if (!list || !list.length) return null;
    delete r.inbox[sid];
    this.save(r);
    return prompts.message('ekip-yonetimi', { maddeler: list.map((t) => `- ${t}`).join('\n') });
  }
}

// Bir isteğin kullanıcıya ve şefe okunur özeti.
function describe(group, req, roles, accounts) {
  const a = req.args || {};
  const member = (sid) => (group.sessions.find((s) => s.id === sid) || {}).name || 'bilinmeyen üye';
  const acc = (id) => (accounts.find((x) => x.id === id) || {}).name || id;
  if (req.kind === 'add') {
    const role = roles.find((r) => r.id === a.roleId);
    return `${role ? role.label : a.roleId} rolünde yeni üye · hesap: ${a.accountId ? acc(a.accountId) : 'en çok kotası kalan'} · model: ${a.model || 'rol varsayılanı'}${a.effort ? ` · effort ${a.effort}` : ''}`;
  }
  if (req.kind === 'account') return `${member(a.target)} → ${acc(a.accountId)} hesabı`;
  if (req.kind === 'caps') {
    const nm = (k) => k.split(':').slice(1).join(':').split('@')[0];
    return `${member(a.target)} → ${[(a.on || []).length ? `aç: ${a.on.map(nm).join(', ')}` : '', (a.off || []).length ? `kapat: ${a.off.map(nm).join(', ')}` : ''].filter(Boolean).join(' · ')}`;
  }
  if (req.kind === 'settings') return `${member(a.target)} → ${[a.model ? `model ${a.model}` : '', a.effort ? `effort ${a.effort}` : ''].filter(Boolean).join(', ')}`;
  return member(a.target);
}

// ---------- MCP tool'ları ----------

const TOOL_STATUS = {
  name: 'ekip_durumu',
  description: 'Ekibin anlık durumu (Claude Panel): her üyenin rolü, hesabı, modeli, ne yaptığı, bağlam doluluğu ve harcaması; '
    + 'hesapların kalan 5 saatlik ve 7 günlük kotası ve sıfırlanma zamanı. Kota birkaç dakikada bir yenilenir.',
  inputSchema: { type: 'object', properties: {} },
};

const LEAD_TOOLS = [
  {
    name: 'rol_listesi',
    description: 'Panelde tanımlı roller (rol envanteri): rol kimliği, adı, varsayılan modeli, görev tanımının özeti ve role verilen ek yetenekler. '
      + 'Konuşulan iş için ekipte uygun rol yoksa buradan seçip uye_ekle ile isteyebilirsin.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'uye_ekle',
    description: 'Gruba yeni üye açılması için kullanıcıya istek gönderir; kullanıcı onaylayınca açılır ve sonuç sana bildirilir. '
      + 'Rol, rol_listesi\'ndeki rol kimliği ya da adı olmalı. Hesap verilmezse en çok kotası kalan hesap seçilir.',
    inputSchema: {
      type: 'object',
      properties: {
        rol: { type: 'string', description: 'rol kimliği ya da adı (ör. android, backend)' },
        gerekce: { type: 'string', description: 'kullanıcıya gösterilecek kısa gerekçe: neden bu rol gerekli' },
        gorev: { type: 'string', description: 'yeni üyenin ilk görevi (isteğe bağlı); yoksa kendini tanıtıp görev bekler' },
        hesap: { type: 'string', description: 'hesap kısa adı ya da adı (isteğe bağlı)' },
        model: { type: 'string', description: 'opus, sonnet, haiku (isteğe bağlı; yoksa rolün varsayılanı)' },
        effort: { type: 'string', description: 'low, medium, high, xhigh, max (isteğe bağlı; yoksa modelin varsayılanı). Rutin işte düşük effort kotayı korur.' },
      },
      required: ['rol', 'gerekce'],
    },
  },
  {
    name: 'uye_kapat',
    description: 'Bir üyenin kapatılması ya da ekipten çıkarılması için kullanıcıya istek gönderir. Kapatılan üye sonra kaldığı yerden açılabilir; '
      + 'çıkarılan üye ekip listesinden düşer. Çalışan bir işi yarıda keseceğini unutma; mümkünse önce işini bitirmesini bekle.',
    inputSchema: {
      type: 'object',
      properties: {
        uye: { type: 'string', description: 'üyenin tam adı ya da gruptaki tek bir üyeye denk gelen rol adı' },
        gerekce: { type: 'string' },
        cikar: { type: 'boolean', description: 'true: ekipten çıkar; false (varsayılan): yalnızca kapat' },
      },
      required: ['uye', 'gerekce'],
    },
  },
  {
    name: 'uye_hesap_degistir',
    description: 'Bir üyenin başka hesapla (ör. kotası dolmak üzereyse) kaldığı yerden açılması için kullanıcıya istek gönderir.',
    inputSchema: {
      type: 'object',
      properties: {
        uye: { type: 'string', description: 'üyenin tam adı ya da rol adı' },
        hesap: { type: 'string', description: 'hedef hesabın kısa adı ya da adı' },
        gerekce: { type: 'string' },
      },
      required: ['uye', 'hesap', 'gerekce'],
    },
  },
  {
    name: 'uye_ayar_degistir',
    description: 'Bir üyenin modelini ya da effort ayarını değiştirmek için kullanıcıya istek gönderir (ör. rutin işe geçen üyeyi daha ucuz ayara '
      + 'almak ya da zorlanan üyeyi güçlendirmek). Onaylanınca üye boşta kalınca kaldığı yerden yeni ayarla açılır; model değişiminde önbellek '
      + 'soğuyana kadar beklenir. Effort değişimi modeli değiştirmekten ucuzdur, önce onu dene.',
    inputSchema: {
      type: 'object',
      properties: {
        uye: { type: 'string', description: 'üyenin tam adı ya da rol adı' },
        model: { type: 'string', description: 'opus, sonnet, haiku (isteğe bağlı)' },
        effort: { type: 'string', description: 'low, medium, high, xhigh, max (isteğe bağlı)' },
        gerekce: { type: 'string' },
      },
      required: ['uye', 'gerekce'],
    },
  },
  {
    name: 'uye_yetenek_degistir',
    description: 'Bir üyede skill, eklenti ya da MCP açılması veya kapatılması için kullanıcıya istek gönderir (ör. arayüz testine geçen üyeye '
      + 'tarayıcı skill\'i, belge yazacak üyeye docs). Ad, panelin yetenek listesindeki addır (rol_listesi her rolün açık / kapalı yeteneklerini gösterir). '
      + 'Onaylanınca üye boşta kalınca kaldığı yerden açılır; skill listesindeki değişiklik üyenin bir sonraki compact\'ından ya da yenilenmesinden sonra görünür. '
      + 'Her açık skill her istekte bağlama girer; gereksiz olanı kapatmayı da iste.',
    inputSchema: {
      type: 'object',
      properties: {
        uye: { type: 'string', description: 'üyenin tam adı ya da rol adı' },
        ac: { type: 'array', items: { type: 'string' }, description: 'açılacak yetenek adları' },
        kapat: { type: 'array', items: { type: 'string' }, description: 'kapatılacak yetenek adları' },
        gerekce: { type: 'string' },
      },
      required: ['uye', 'gerekce'],
    },
  },
];

const LEAD_NAMES = LEAD_TOOLS.map((t) => t.name);

function findRole(roles, v) {
  const q = clean(v, 60).toLocaleLowerCase('tr');
  const r = roles.find((x) => [x.id, x.label, x.short].some((y) => y && y.toLocaleLowerCase('tr') === q));
  if (!r) throw new TeamError(400, `Rol bulunamadı: "${v}". Roller: ${roles.map((x) => `${x.id} (${x.label})`).join(', ')}`);
  return r;
}

function findAccount(accounts, v) {
  const q = clean(v, 60).toLocaleLowerCase('tr');
  const a = accounts.find((x) => [x.id, x.name].some((y) => y && y.toLocaleLowerCase('tr') === q));
  if (!a) throw new TeamError(400, `Hesap bulunamadı: "${v}". Hesaplar: ${accounts.map((x) => `${x.id} (${x.name})`).join(', ')}`);
  return a;
}

// ctx: group, sid, isLead, requests, roles, accounts, models, resolveMember, memberRows(), quota() (önbellekli), roleCaps(roleId),
// capCatalog() -> [{ key, name, kind }] (panelin yetenek listesi),
// meterRate(hesap, 'five'|'week') (öğrenilen kota oranı)
async function callTeamTool(ctx, name, args) {
  const a = args || {};
  const { group, sid } = ctx;
  if (name === 'ekip_durumu') {
    const rows = ctx.memberRows();
    const lines = [`Ekip "${group.name}":`];
    for (const r of rows) {
      const s = r.session;
      const st = r.stats;
      const bits = [r.status, `hesap ${s.accountId}`];
      if (st && st.model) bits.push(st.model);
      const m = r.running && r.meter;
      const ctxBits = [m && m.context ? `${Math.round(m.context / 1000)}k` : null, m && m.growthPer10m ? `${m.growthPer10m > 0 ? '+' : ''}${Math.round(m.growthPer10m / 1000)}k/10dk` : null].filter(Boolean);
      if (r.contextPct != null) bits.push(`bağlam %${r.contextPct}${ctxBits.length ? ` (${ctxBits.join(', ')})` : ''}`);
      else if (ctxBits.length) bits.push(`bağlam ${ctxBits.join(', ')}`);
      if (m && m.errStreak >= 3) bits.push(`art arda ${m.errStreak} hatalı tool`);
      if (st && st.costUSD) bits.push(`≈$${st.costUSD.toFixed(2)}`);
      lines.push(`- ${s.name}${s.id === sid ? ' (sen)' : ''} — ${bits.join(' · ')}`);
    }
    let q;
    try { q = await ctx.quota(); } catch (err) { q = null; lines.push('', `Kota alınamadı: ${err.message}`); }
    if (q) {
      lines.push('', `Hesap kotaları (${fmt(q.fetchedAt)} itibarıyla):`);
      for (const row of q.rows) {
        const users = rows.filter((r) => r.session.accountId === row.accountId && r.running).map((r) => r.session.roleLabel);
        const b = (label, x) => (x ? `${label} %${Math.max(0, Math.round(100 - x.used))} kaldı${x.resetsAt ? ` (sıfırlanma ${fmt(Date.parse(x.resetsAt))})` : ''}` : null);
        const parts = row.status !== 'canlı' ? [row.status] : [b('5 saat', row.five), b('7 gün', row.week)].filter(Boolean);
        if (row.blocked) parts.unshift(`DOLU${row.blockedUntil ? `, ${fmt(Date.parse(row.blockedUntil))}'de açılır` : ''}`);
        const rates = ctx.meterRate ? [['5 saat', 'five'], ['7 gün', 'week']].map(([label, kind]) => {
          const x = ctx.meterRate(row.accountId, kind);
          return x.perUnit ? `${label} %${x.perUnit.toFixed(2)}/birim (güven ${x.conf})` : null;
        }).filter(Boolean) : [];
        lines.push(`- ${row.name} (${row.accountId}): ${parts.join(' · ') || 'bilgi yok'}${users.length ? ` · bu hesapta: ${users.join(', ')}` : ''}${rates.length ? ` · ölçülen oran: ${rates.join(', ')}` : ''}`);
      }
    }
    if (lines.some((l) => l.includes('/birim'))) lines.push('(Ölçülen oran: 1 birimlik harcamanın (≈ API eşdeğeri $1) kotadan götürdüğü yüzde; panelin kendi ölçümüdür.)');
    const open = ctx.requests.pending(group.id);
    if (open.length) lines.push('', `Onay bekleyen istekler: ${open.map((x) => `#${x.id} ${KIND_TEXT[x.kind]}`).join(', ')}`);
    return lines.join('\n');
  }
  if (!LEAD_NAMES.includes(name)) return undefined;
  // Tool listesi açılışta alındığı için şef olmayan bir üye de adla çağırabilir; yetki her çağrıda denetlenir.
  if (!ctx.isLead) throw new TeamError(403, 'Bu tool yalnızca ekibin orkestra şefine açık.');
  if (name === 'rol_listesi') {
    return ctx.roles.map((r) => {
      const first = String(r.prompt || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
      const caps = ctx.roleCaps(r.id);
      const inTeam = group.sessions.filter((s) => !s.removed && s.roleId === r.id).length;
      return `- ${r.id} · ${r.label}${r.model ? ` · varsayılan model ${r.model}` : ''}${inTeam ? ` · ekipte ${inTeam} üye` : ''}\n  ${short(first, 220)}${caps ? `\n  yetenekler: ${caps}` : ''}`;
    }).join('\n');
  }
  const members = group.sessions.filter((s) => !s.removed);
  const reason = clean(a.gerekce, 1000);
  if (!reason) throw new TeamError(400, 'gerekce gerekli; kullanıcı isteği onaylarken bunu görür.');
  let req;
  if (name === 'uye_ekle') {
    const role = findRole(ctx.roles, a.rol);
    if (group.sessions.filter((s) => !s.removed).length >= MAX_SESSIONS) throw new TeamError(400, `Grupta en fazla ${MAX_SESSIONS} oturum olabilir.`);
    const model = clean(a.model, 20).toLowerCase();
    if (model && !ctx.models.includes(model)) throw new TeamError(400, `Geçersiz model: ${a.model}. Geçerli: ${ctx.models.join(', ')}`);
    const effort = clean(a.effort, 20).toLowerCase();
    if (effort && !EFFORTS.includes(effort)) throw new TeamError(400, `Geçersiz effort: ${a.effort}. Geçerli: ${EFFORTS.join(', ')}`);
    const args2 = { roleId: role.id, accountId: a.hesap ? findAccount(ctx.accounts, a.hesap).id : null, model: model || null, effort: effort || null, task: clean(a.gorev, 8000) || null };
    req = ctx.requests.create(group.id, sid, 'add', args2, reason);
  } else if (name === 'uye_kapat') {
    const target = ctx.resolveMember(group, a.uye, sid);
    if (!target) throw new TeamError(400, 'Kapatılacak üyeyi belirt.');
    if (target === sid) throw new TeamError(400, 'Kendini kapatamazsın.');
    if (!members.some((s) => s.id === target)) throw new TeamError(400, 'Üye ekipte değil.');
    req = ctx.requests.create(group.id, sid, a.cikar ? 'remove' : 'stop', { target }, reason);
  } else if (name === 'uye_hesap_degistir') {
    const target = ctx.resolveMember(group, a.uye, sid);
    if (!target) throw new TeamError(400, 'Üyeyi belirt.');
    const acc = findAccount(ctx.accounts, a.hesap);
    const s = members.find((x) => x.id === target);
    if (!s) throw new TeamError(400, 'Üye ekipte değil.');
    if (s.accountId === acc.id) throw new TeamError(400, `${s.name} zaten ${acc.name} hesabında.`);
    req = ctx.requests.create(group.id, sid, 'account', { target, accountId: acc.id }, reason);
  } else if (name === 'uye_ayar_degistir') {
    const target = ctx.resolveMember(group, a.uye, sid);
    if (!target) throw new TeamError(400, 'Üyeyi belirt.');
    const s = members.find((x) => x.id === target);
    if (!s) throw new TeamError(400, 'Üye ekipte değil.');
    const model = clean(a.model, 20).toLowerCase();
    const effort = clean(a.effort, 20).toLowerCase();
    if (model && !ctx.models.includes(model)) throw new TeamError(400, `Geçersiz model: ${a.model}. Geçerli: ${ctx.models.join(', ')}`);
    if (effort && !EFFORTS.includes(effort)) throw new TeamError(400, `Geçersiz effort: ${a.effort}. Geçerli: ${EFFORTS.join(', ')}`);
    if (!model && !effort) throw new TeamError(400, 'model ya da effort ver.');
    if ((!model || model === s.model) && (!effort || effort === s.effort)) throw new TeamError(400, `${s.name} zaten bu ayarda.`);
    req = ctx.requests.create(group.id, sid, 'settings', { target, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, reason);
  } else if (name === 'uye_yetenek_degistir') {
    const target = ctx.resolveMember(group, a.uye, sid);
    if (!target) throw new TeamError(400, 'Üyeyi belirt.');
    if (!members.some((x) => x.id === target)) throw new TeamError(400, 'Üye ekipte değil.');
    const catalog = ctx.capCatalog();
    const find = (n) => {
      const q = clean(n, 120).toLowerCase();
      const hit = catalog.find((c) => c.key.toLowerCase() === q || c.name.toLowerCase() === q)
        || catalog.find((c) => c.name.toLowerCase().split(':').pop() === q);
      if (!hit) throw new TeamError(400, `Yetenek bulunamadı: ${n}. Örnek adlar: ${catalog.slice(0, 25).map((c) => c.name).join(', ')}`);
      return hit.key;
    };
    const on = [...new Set((Array.isArray(a.ac) ? a.ac : []).map(find))];
    const off = [...new Set((Array.isArray(a.kapat) ? a.kapat : []).map(find))].filter((k) => !on.includes(k));
    if (!on.length && !off.length) throw new TeamError(400, 'ac ya da kapat listesinde en az bir yetenek ver.');
    req = ctx.requests.create(group.id, sid, 'caps', { target, on, off }, reason);
  }
  return `İstek #${req.id} kullanıcı onayına gönderildi: ${KIND_TEXT[req.kind]} — ${describe(group, req, ctx.roles, ctx.accounts)}. `
    + 'Kullanıcı karar verince sonucu panel sana bildirecek; o zamana kadar aynı isteği tekrar gönderme.';
}

module.exports = { Requests, TeamError, TOOL_STATUS, LEAD_TOOLS, KIND_TEXT, callTeamTool, describe, findRole };
