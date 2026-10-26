// Kurulum: ekip şablonları, grup açılmadan önceki model önerisi (optimize) ve tek rolün iyileştirilmesi (rol danışmanı).
const crypto = require('crypto');

const store = require('../core/store');
const discovery = require('../core/discovery');
const { sessionStats } = require('../core/usage');
const { MODELS, EFFORTS, PERMISSION_MODES } = require('../core/options');
const helper = require('../watch/helper');
const optimizer = require('../setup/optimizer');
const roleadvisor = require('../setup/roleadvisor');
const prompts = require('../core/prompts');
const {
  settings, boards, caps, notes, events, HttpError, isAllowedDir, sharedConfigDir, cleanText, cachedQuota, lastQuota,
} = require('../panel/context');
const { capsOverride } = require('../panel/launch');
const { route, readBody } = require('../panel/http');

route('GET', '/api/templates', async () => store.loadTemplates());

// Kurulum optimizasyonu: formdaki ekibi grup açılmadan tek model çağrısıyla gözden geçirir; sonuç forma öneri olarak döner.
const CAP_KIND_TEXT = {
  plugin: 'eklenti', skill: 'skill (hesapta kurulu)', mcp: 'mcp', bundled: 'skill (Claude Code yerleşik)', synced: 'skill (claude.ai)', project: 'skill (proje klasöründe)',
};

// Modele verilen yetenek kataloğu: hesaplarda kurulu olanlar (inventory) + panelin MCP ve skill'leri.
function capCatalog(inventory) {
  const c = caps.load();
  return [
    ...inventory.map((x) => ({
      key: x.key, tur: CAP_KIND_TEXT[x.kind] || x.kind, ad: x.name, aciklama: String(x.description || '').slice(0, 160),
      ...(x.chars ? { tahmini_token: Math.round(x.chars / 3) } : {}),
      ...(x.skills ? { skilleri: x.skills } : {}),
      ...(x.hooks ? { kancasi_var: true } : {}),
    })),
    ...c.mcps.map((m) => ({ key: `pmcp:${m.id}`, tur: 'mcp (panel)', ad: m.name, aciklama: m.url || [m.command, ...(m.args || [])].join(' ') })),
    ...c.skills.map((k) => ({ key: `pskill:${k.name}`, tur: 'skill (panel)', ad: k.name, aciklama: String(k.description || '').slice(0, 160) })),
  ];
}

route('POST', '/api/setup/optimize', async (req) => {
  const body = await readBody(req);
  const project = store.loadProjects().find((p) => p.id === body.projectId);
  if (!project) throw new HttpError(404, 'Proje bulunamadı.');
  if (!isAllowedDir(project.path)) throw new HttpError(403, 'Proje klasörü izinli klasörlerin dışında.');
  const raw = Array.isArray(body.rows) ? body.rows.slice(0, 12) : [];
  if (!raw.length) throw new HttpError(400, 'Optimize edilecek satır yok.');
  const quota = await cachedQuota().catch(() => lastQuota());
  const account = helper.pickAccount(settings.accounts, quota);
  if (!account) throw new HttpError(409, 'Kotası olan hesap yok.');

  const inventory = caps.inventory(settings.accounts).filter((x) => x.kind !== 'project' || (x.projects || []).includes(project.path));
  const catalog = capCatalog(inventory);
  const rows = raw.map((r) => {
    const role = settings.roles.find((x) => x.id === r.roleId);
    const custom = r.roleId === 'custom';
    const base = caps.roleKeys(custom ? 'custom' : r.roleId, inventory);
    const ov = r.caps || {};
    const on = new Set([...base, ...(ov.on || [])]);
    for (const k of ov.off || []) on.delete(k);
    return {
      key: cleanText(r.key, 20), roleId: custom ? 'custom' : role ? role.id : '', label: custom ? cleanText(r.customLabel, 40) : role ? role.label : '?',
      model: MODELS.includes(r.model) ? r.model : '', effort: EFFORTS.includes(r.effort) ? r.effort : '', permissionMode: PERMISSION_MODES.includes(r.permissionMode) ? r.permissionMode : '',
      talkAll: !!r.talkAll, reportsTo: Array.isArray(r.reportsTo) ? r.reportsTo.map(String) : [],
      prompt: custom ? String(r.customPrompt || '') : typeof r.prompt === 'string' && r.prompt.trim() ? r.prompt : (role && role.gorevler) || '',
      manualPrompt: custom ? !!String(r.customPrompt || '').trim() : !!r.promptManual, caps: [...on], accountId: cleanText(r.accountId, 12),
    };
  });

  const groups = store.loadGroups().filter((g) => g.projectId === project.id).sort((a, b) => a.createdAt - b.createdAt);
  const stats = (sid) => sessionStats(discovery.transcriptPath(sharedConfigDir(), sid));
  const last = groups[groups.length - 1];
  let recent = null;
  if (last) {
    const n = notes.load(last.id).notes.filter((x) => !x.archived);
    const cards = boards.load(last.id).cards;
    recent = {
      grup: last.name,
      not_basliklari: n.slice(-40).map((x) => x.title),
      kartlar: cards.slice(-30).map((k) => `#${k.id} [${k.status}] ${k.title}`),
    };
  }
  const payload = {
    proje: optimizer.projectSummary(project.path),
    kullanici_notu: String(body.goal || '').trim() || null,
    grup_varsayilan_izin: PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : 'manual',
    rol_katalogu: settings.roles.map((r) => ({ id: r.id, ad: r.label, varsayilan_model: r.model || '', varsayilan_effort: r.effort || '', gorev: String(r.gorevler || '').split('\n')[0].slice(0, 200) })),
    yetenekler: catalog,
    gecmis_harcama: optimizer.history(groups, stats),
    son_grup: recent,
    satirlar: rows.map((r) => ({
      key: r.key, rol: r.roleId, rol_adi: r.label, model: r.model, effort: r.effort, izin: r.permissionMode, herkesle: r.talkAll, rapor_verir: r.reportsTo,
      talimat: r.prompt, elle_yazildi: r.manualPrompt, yetenekler: r.caps,
    })),
  };
  const res = await optimizer.ask(account, payload, null, project.path).catch((err) => { throw new HttpError(502, `Kurulum danışmanı: ${err.message}`); });
  const out = optimizer.validate(rows, res.parsed, catalog.map((x) => x.key), settings.roles.map((r) => r.id));
  // Eklenen satır modeli belirtilmemişse rolün varsayılanını alır; hesap aşağıda kotaya göre seçilir.
  for (const a of out.adds) {
    const role = settings.roles.find((r) => r.id === a.roleId);
    if (a.model === undefined) a.model = (role && role.model) || '';
    if (a.permissionMode === undefined) a.permissionMode = (role && role.permissionMode) || '';
    a.accountId = (rows.find((r) => r.roleId === 'sef') || rows[0]).accountId;
  }
  // Hesaplar modelin önerdiği modellerle birlikte kotaya göre dağıtılır (çıkarılanlar hariç, eklenenler dahil).
  const gone = new Set(out.removes.map((x) => x.key));
  const after = [
    ...rows.filter((r) => !gone.has(r.key)).map((r) => ({ ...r, model: (out.patches[r.key] || {}).model ?? r.model })),
    ...out.adds,
  ];
  for (const [key, a] of Object.entries(optimizer.assignAccounts(after, settings.accounts, quota))) {
    const add = out.adds.find((x) => x.key === key);
    if (add) {
      add.accountId = a.accountId;
      continue;
    }
    const p = out.patches[key] || (out.patches[key] = { why: {} });
    p.accountId = a.accountId;
    p.why.accountId = a.why;
  }
  return { ...out, account: res.account, costUSD: res.costUSD, turns: res.turns };
});

// Rol danışmanı (rol sayfasındaki "Rolü optimize et"): step "sorular" kullanıcıya soru, step "oneriler" cevaplara göre
// doğrulanmış değişiklik önerileri döner. Hiçbir şey yazılmaz; kullanıcı seçtiklerini forma uygular ve kaydeder.
// body.role: ekrandaki (kaydedilmemiş olabilir) tanım; geçersiz alan kayıtlı değerle kalır.
route('POST', '/api/roles/([\\w-]+)/optimize', async (req, m) => {
  const body = await readBody(req);
  const saved = settings.roles.find((r) => r.id === m[1]);
  if (!saved) throw new HttpError(404, 'Rol bulunamadı; önce kaydet.');
  const step = body.step === 'oneriler' ? 'oneriler' : 'sorular';
  const d = body.role && typeof body.role === 'object' ? body.role : {};
  const text = (k) => (typeof d[k] === 'string' ? d[k].slice(0, 40000) : saved[k] || '');
  const rules = (k) => (Array.isArray(d[k]) ? d[k].map((x) => cleanText(x, 200)).filter(Boolean).slice(0, 100) : saved[k] || []);
  const num = (k) => (Number(d[k]) >= 20000 && Number(d[k]) <= 10000000 ? Math.round(Number(d[k])) : saved[k] || null);
  const role = {
    id: saved.id, label: cleanText(d.label, 40) || saved.label,
    model: MODELS.includes(d.model) || d.model === '' ? d.model : saved.model || '',
    effort: EFFORTS.includes(d.effort) || d.effort === '' ? d.effort : saved.effort || '',
    permissionMode: PERMISSION_MODES.includes(d.permissionMode) || d.permissionMode === '' ? d.permissionMode : saved.permissionMode || '',
    readOnly: typeof d.readOnly === 'boolean' ? d.readOnly : !!saved.readOnly,
    allow: rules('allow'), deny: rules('deny'), ctxWarn: num('ctxWarn'), ctxHigh: num('ctxHigh'),
    persona: text('persona'), gorevler: text('gorevler'), sinirlar: text('sinirlar'),
  };
  const quota = await cachedQuota().catch(() => lastQuota());
  const account = helper.pickAccount(settings.accounts, quota);
  if (!account) throw new HttpError(409, 'Kotası olan hesap yok.');

  // Proje skill'leri yalnızca kendi projesinde görünür; rolün genel tanımı için katalog dışı.
  const inventory = caps.inventory(settings.accounts).filter((x) => x.kind !== 'project');
  const catalog = capCatalog(inventory);
  const onKeys = caps.roleKeys(role.id, inventory);
  const stats = (sid) => sessionStats(discovery.transcriptPath(sharedConfigDir(), sid));
  const cfg = prompts.tool('rol-danismani').config;
  const payload = {
    asama: step,
    rol: {
      id: role.id, ad: role.label, model: role.model, effort: role.effort, izin_modu: role.permissionMode, salt_okunur: role.readOnly,
      allow: role.allow, deny: role.deny.filter((t) => !prompts.READ_ONLY_TOOLS.includes(t)), baglam_esigi: role.ctxWarn, baglam_ust_siniri: role.ctxHigh,
      persona: role.persona, gorevler: role.gorevler, sinirlar: role.sinirlar,
    },
    yetenekler: catalog.map((x) => ({ ...x, acik: onKeys.includes(x.key) })),
    ortak_istem: prompts.sharedSections().join('\n\n'),
    diger_roller: settings.roles.filter((r) => r.id !== role.id).map((r) => ({ id: r.id, ad: r.label, gorev: String(r.gorevler || '').split('\n')[0].slice(0, 200) })),
    kullanim: roleadvisor.usage(role.id, store.loadGroups(), store.loadProjects(), stats, events, cfg.historySessions),
  };
  if (step === 'oneriler') {
    const qa = Array.isArray(body.answers) ? body.answers.slice(0, 10) : [];
    payload.cevaplar = qa.map((x) => ({ soru: cleanText(x && x.soru, 400), cevap: String((x && x.cevap) || '').trim().slice(0, 1000) })).filter((x) => x.soru && x.cevap);
    if (!payload.cevaplar.length) throw new HttpError(400, 'En az bir soruyu cevapla.');
  }
  const res = await roleadvisor.ask(account, payload).catch((err) => { throw new HttpError(502, `Rol danışmanı: ${err.message}`); });
  const out = step === 'sorular'
    ? roleadvisor.validateQuestions(res.parsed)
    : roleadvisor.validateProposals(role, res.parsed, catalog.map((x) => x.key), onKeys);
  return { step, ...out, usage: { sessions: payload.kullanim.oturum_sayisi }, account: res.account, costUSD: res.costUSD };
});

route('POST', '/api/templates', async (req) => {
  const body = await readBody(req);
  const name = cleanText(body.name, 60);
  if (!name) throw new HttpError(400, 'Şablon adı gerekli.');
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 12) : [];
  if (!rows.length) throw new HttpError(400, 'Şablonda en az bir satır olmalı.');
  const scope = body.scope === 'global' ? 'global' : String(body.scope || '');
  if (scope !== 'global' && !store.loadProjects().some((p) => p.id === scope)) throw new HttpError(400, 'Şablon kapsamı geçersiz.');
  const templates = store.loadTemplates();
  const tpl = {
    id: crypto.randomUUID(),
    name,
    scope,
    createdAt: Date.now(),
    permissionMode: PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : 'manual',
    rows: rows.map((r) => ({
      key: cleanText(r.key, 20),
      roleId: cleanText(r.roleId, 24),
      customLabel: cleanText(r.customLabel, 40),
      customPrompt: String(r.customPrompt || ''),
      ...(typeof r.prompt === 'string' && r.prompt.trim() ? { prompt: r.prompt.trim() } : {}),
      ...(capsOverride(r.caps) ? { caps: capsOverride(r.caps) } : {}),
      accountId: cleanText(r.accountId, 12),
      model: MODELS.includes(r.model) ? r.model : '',
      effort: EFFORTS.includes(r.effort) ? r.effort : '',
      permissionMode: PERMISSION_MODES.includes(r.permissionMode) ? r.permissionMode : '',
      talkAll: !!r.talkAll,
      reportsTo: Array.isArray(r.reportsTo) ? r.reportsTo.map((k) => cleanText(k, 20)) : [],
    })),
  };
  templates.push(tpl);
  store.saveTemplates(templates);
  return tpl;
});

route('PUT', '/api/templates/([\\w-]+)', async (req, m) => {
  const body = await readBody(req);
  const templates = store.loadTemplates();
  const t = templates.find((x) => x.id === m[1]);
  if (!t) throw new HttpError(404, 'Şablon bulunamadı.');
  if (body.name != null) t.name = cleanText(body.name, 60) || t.name;
  if (body.scope != null) t.scope = body.scope === 'global' ? 'global' : String(body.scope);
  store.saveTemplates(templates);
  return t;
});

route('DELETE', '/api/templates/([\\w-]+)', async (req, m) => {
  store.saveTemplates(store.loadTemplates().filter((t) => t.id !== m[1]));
  return { ok: true };
});
