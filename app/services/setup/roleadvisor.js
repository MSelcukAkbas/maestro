// Rol danışmanı: tek bir rolün kalıcı tanımını (persona / görevler / sınırlar, model, effort, izinler, yetenekler, bağlam
// eşikleri) iki model çağrısıyla küçük adımlarla iyileştirir. Birinci çağrı ("sorular") rolü ve gerçek kullanım verisini
// inceleyip kullanıcıya soru üretir; ikinci çağrı ("oneriler") cevaplarla değişiklik önerir. İki çağrının sistem istemi
// aynıdır (önbellekten okunur). Model hiçbir şey yazmaz: öneriler panelde doğrulanır, kullanıcı seçip forma uygular.
// Metin ve ayarlar prompts/tools/rol-danismani/ (persona, görevler, sınırlar, çıktı md'leri; tool.json); her çağrıda okunur.
const fs = require('fs');
const path = require('path');
const os = require('os');
const llm = require('../core/llm');
const prompts = require('../core/prompts');
const options = require('../core/options');

const CWD = path.join(os.tmpdir(), 'maestro-helper');
const MODELS = ['', ...options.MODELS];
const EFFORTS = ['', ...options.EFFORTS];
// plan önerilmez: plan modundaki üye komut çalıştıramaz, ekiple çalışırken takılır.
const MODES = ['', ...options.PERMISSION_MODES.filter((m) => m !== 'plan')];
const TEXT_FIELDS = ['persona', 'gorevler', 'sinirlar'];
const config = () => prompts.tool('rol-danismani').config;

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

// Bu rolle açılmış geçmiş oturumlar (en yeni önce) ve model başına toplam. stats(sid) -> usage.sessionStats,
// events: kalıcı olay listesi (bekçinin hamleleri oturum adıyla yazılır).
function usage(roleId, groups, projects, stats, events, limit) {
  const rows = [];
  for (const g of groups) {
    const project = projects.find((p) => p.id === g.projectId);
    for (const s of g.sessions) {
      if (s.roleId !== roleId) continue;
      const st = stats(s.id);
      if (!st || !st.lastAt) continue;
      const bekci = events.filter((e) => e.gid === g.id && e.source === 'bekci' && String(e.text).startsWith(s.name));
      rows.push({
        at: st.lastAt,
        proje: project ? project.name : '?',
        grup: g.name,
        model: s.model || 'hesap varsayılanı',
        gerceklesen_model: st.model ? String(st.model).replace(/^claude-/, '') : null,
        effort: s.effort || '',
        ekibe_ozel_talimat: !!s.rolePrompt,
        sure_saat: st.firstAt ? +((st.lastAt - st.firstAt) / 3600000).toFixed(1) : 0,
        mesaj: st.prompts || 0,
        maliyet_usd: +(st.costUSD || 0).toFixed(2),
        eklenen_satir: st.linesAdded || 0,
        silinen_satir: st.linesRemoved || 0,
        son_baglam_token: st.context || null,
        bekci_hamleleri: bekci.length,
        bekci_son: bekci.slice(-2).map((e) => String(e.text).slice(s.name.length).replace(/^[:\s]+/, '').slice(0, 160)),
        son_mesaj_sonu: st.lastText ? String(st.lastText).slice(-300) : '',
      });
    }
  }
  rows.sort((a, b) => b.at - a.at);
  const toplam = {};
  for (const r of rows) {
    const k = r.gerceklesen_model || r.model;
    const t = toplam[k] || (toplam[k] = { oturum: 0, saat: 0, mesaj: 0, maliyet_usd: 0, eklenen_satir: 0 });
    t.oturum += 1;
    t.saat += r.sure_saat;
    t.mesaj += r.mesaj;
    t.maliyet_usd += r.maliyet_usd;
    t.eklenen_satir += r.eklenen_satir;
  }
  for (const t of Object.values(toplam)) {
    t.saat = +t.saat.toFixed(1);
    t.maliyet_usd = +t.maliyet_usd.toFixed(2);
    t.ortalama_usd = +(t.maliyet_usd / t.oturum).toFixed(2);
  }
  return { oturum_sayisi: rows.length, model_basina: toplam, oturumlar: rows.slice(0, limit).map(({ at, ...r }) => ({ tarih: new Date(at).toISOString().slice(0, 10), ...r })) };
}

// Çağrılan skill / MCP adının yetenek kataloğundaki anahtarı. Skill: panel skill'i, hesaptaki skill ya da "eklenti:ad"
// biçiminde eklentinin skill'i. MCP sunucusu: hesaptaki MCP ya da "plugin_<eklenti>_<sunucu>" (eklentinin).
function capKeyOf(catalog, kind, name) {
  const find = (f) => (catalog.find(f) || {}).key || null;
  const plugin = (f) => find((x) => x.key.startsWith('plugin:') && f(x.ad));
  if (kind === 'skill') {
    const pfx = name.includes(':') ? name.split(':')[0] : null;
    return find((x) => x.key === `pskill:${name}`) || find((x) => x.key === `skill:${name}`) || (pfx ? plugin((ad) => ad === pfx) : null);
  }
  return find((x) => x.key === `mcp:${name}`) || plugin((ad) => name.startsWith(`plugin_${ad}_`));
}

// Rolün bütün oturumlarında yetenek başına çağrı: { oturum, keys: { key: { cagri, oturum } } }. stats(sid) -> sessionStats.
// Panelin kendi MCP'si (pano / not araçları) yetenek değildir, sayılmaz.
function capUsage(roleId, groups, stats, catalog) {
  const keys = {};
  let n = 0;
  for (const g of groups) {
    for (const s of g.sessions) {
      if (s.roleId !== roleId) continue;
      const st = stats(s.id);
      if (!st || !st.lastAt) continue;
      n++;
      const seen = new Set();
      const add = (kind, calls) => {
        for (const [name, c] of Object.entries(calls || {})) {
          if (kind === 'mcp' && name === 'panel') continue;
          const key = capKeyOf(catalog, kind, name);
          if (!key) continue;
          const k = keys[key] || (keys[key] = { cagri: 0, oturum: 0 });
          k.cagri += c;
          if (!seen.has(key)) {
            seen.add(key);
            k.oturum++;
          }
        }
      };
      add('skill', st.skillCalls);
      add('mcp', st.mcpCalls);
    }
  }
  return { oturum: n, keys };
}

function ask(account, payload) {
  const t = prompts.tool('rol-danismani');
  fs.mkdirSync(CWD, { recursive: true });
  return llm.run({
    kind: 'rol danışmanı', account, model: t.config.model, effort: t.config.effort, system: t.system(), excludeDynamic: true,
    input: JSON.stringify(payload), cwd: CWD, tools: '', timeoutMs: t.config.timeoutSec * 1000, timeoutMsg: 'rol danışmanı zaman aşımına uğradı',
  }).then(({ res, ok }) => {
    if (!ok) throw new Error(`model hatası: ${String(res.result || res.subtype).slice(0, 200)}`);
    const text = String(res.result || '');
    const m = text.match(/\{[\s\S]*\}/);
    let parsed;
    try { parsed = JSON.parse(m ? m[0] : text); } catch { throw new Error(`model JSON yazmadı: ${text.slice(0, 200)}`); }
    return { parsed, account: account.id, costUSD: res.total_cost_usd || 0 };
  });
}

// Soruları doğrular: metni olan, en fazla maxQuestions soru; seçenekler 2-6 arası kısa metin.
function validateQuestions(parsed) {
  const max = config().maxQuestions;
  const list = Array.isArray(parsed && parsed.sorular) ? parsed.sorular : [];
  const out = [];
  for (const q of list) {
    if (out.length >= max) break;
    const soru = str(q && q.soru, 400);
    if (!soru) continue;
    const secenekler = Array.isArray(q.secenekler) ? [...new Set(q.secenekler.map((x) => str(x, 200)).filter(Boolean))].slice(0, 6) : [];
    out.push({ id: `s${out.length + 1}`, soru, neden: str(q.neden, 300), secenekler, coklu: q.coklu === true });
  }
  return { questions: out, summary: str(parsed && parsed.ozet, 600) };
}

// Önerileri rolün şu anki tanımıyla doğrular. role: { persona, gorevler, sinirlar, model, effort, permissionMode, readOnly,
// allow, deny, ctxWarn, ctxHigh }, capKeys: geçerli yetenek anahtarları, onKeys: rolde açık olanlar.
// Metin değişikliği: "eski" metinde bir kez geçmeli (boşsa sona ekleme); bir metinde değişen toplam, metnin maxTextChange
// oranını geçemez (boş metinde 1500 karakter). İzin gevşetmesi (salt okunuru kaldırmak, deny silmek) şemada yok.
function validateProposals(role, parsed, capKeys, onKeys) {
  const cfg = config();
  const caps = new Set(capKeys);
  const on = new Set(onKeys);
  const budget = {};
  for (const f of TEXT_FIELDS) budget[f] = Math.max(String(role[f] || '').length * cfg.maxTextChange, String(role[f] || '').trim() ? 300 : 1500);
  const used = {};
  const seen = new Set();
  const out = [];
  const rejected = [];
  for (const d of Array.isArray(parsed && parsed.degisiklikler) ? parsed.degisiklikler : []) {
    if (out.length >= cfg.maxChanges) break;
    const alan = d && d.alan;
    const why = str(d && d.neden, 300);
    const skip = (reason) => rejected.push({ alan: String(alan || '?'), reason });
    if (TEXT_FIELDS.includes(alan)) {
      const cur = String(role[alan] || '');
      const eski = typeof d.eski === 'string' ? d.eski : '';
      const yeni = typeof d.yeni === 'string' ? d.yeni.replace(/\r\n/g, '\n') : '';
      if ((!yeni.trim() && !eski) || yeni === eski) { skip('değişiklik getirmiyor'); continue; }
      if (eski && cur.split(eski).length !== 2) { skip('eski parça metinde bir kez geçmiyor'); continue; }
      const size = Math.max(eski.length, yeni.length);
      if ((used[alan] || 0) + size > budget[alan]) { skip('metnin üçte birinden fazlası değişiyor'); continue; }
      if (out.some((x) => x.field === alan && x.old && eski && (x.old.includes(eski) || eski.includes(x.old)))) { skip('aynı parçaya ikinci değişiklik'); continue; }
      used[alan] = (used[alan] || 0) + size;
      out.push({ kind: 'text', field: alan, old: eski, new: yeni, why });
      continue;
    }
    const v = d ? d.deger : undefined;
    const key = `${alan}:${typeof v === 'string' ? v : JSON.stringify(v)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (alan === 'model' && typeof v === 'string' && MODELS.includes(v) && v !== (role.model || '')) out.push({ kind: 'set', field: 'model', value: v, why });
    else if (alan === 'effort' && typeof v === 'string' && EFFORTS.includes(v) && v !== (role.effort || '')) out.push({ kind: 'set', field: 'effort', value: v, why });
    else if (alan === 'izin_modu' && typeof v === 'string' && MODES.includes(v) && v !== (role.permissionMode || '')) out.push({ kind: 'set', field: 'permissionMode', value: v, why });
    else if (alan === 'salt_okunur' && v === true && !role.readOnly) out.push({ kind: 'set', field: 'readOnly', value: true, why });
    else if ((alan === 'allow_ekle' || alan === 'deny_ekle') && typeof v === 'string' && /^[A-Za-z][\w.-]*(\(.{1,180}\))?$/.test(v.trim())) {
      const list = alan === 'allow_ekle' ? 'allow' : 'deny';
      if (!(role[list] || []).includes(v.trim())) out.push({ kind: 'rule', field: list, value: v.trim(), why });
    } else if ((alan === 'yetenek_ac' || alan === 'yetenek_kapat') && typeof v === 'string' && caps.has(v)) {
      const want = alan === 'yetenek_ac';
      if (on.has(v) !== want) out.push({ kind: 'cap', field: 'cap', value: v, on: want, why });
    } else if ((alan === 'baglam_esigi' || alan === 'baglam_ust_siniri') && Number(v) >= 20000 && Number(v) <= 10000000) {
      out.push({ kind: 'set', field: alan === 'baglam_esigi' ? 'ctxWarn' : 'ctxHigh', value: Math.round(Number(v)), why });
    } else skip('geçersiz ya da değişiklik getirmeyen alan');
  }
  return { changes: out.map((c, i) => ({ id: `d${i + 1}`, ...c })), rejected, summary: str(parsed && parsed.ozet, 800) };
}

module.exports = { usage, capUsage, capKeyOf, ask, validateQuestions, validateProposals };
