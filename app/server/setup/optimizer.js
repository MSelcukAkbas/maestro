// Kurulum optimizasyonu: grup açılmadan önce kurulum formundaki ekibi tek seferlik bir model çağrısıyla gözden geçirir.
// Model satır başına model, effort, izin modu, konuşma yapısı, rol talimatı ve yetenek önerir; rol kataloğundan satır
// ekleyebilir ve satır çıkarabilir (şef çıkarılmaz), var olan satırın rolünü değiştirmez. Hesap dağıtımı modele sorulmaz,
// kotaya göre kuralla yapılır. Panel CLAUDE.md / README / klasör yapısından bir özet, aynı projedeki önceki grupların
// harcama özetini ve son grubun not / kart başlıklarını verir; model ayrıca proje klasöründe Read / Grep / Glob ile
// hedefli inceleme yapabilir (yalnızca okuma). Yanıt panel tarafından doğrulanır.
const fs = require('fs');
const path = require('path');
const os = require('os');
const llm = require('../core/llm');
const { tool: promptTool } = require('../core/prompts');

const READ_TOOLS = 'Read,Grep,Glob';
const MAX_ROWS = 12;
const CWD = path.join(os.tmpdir(), 'claude-panel-helper');
const options = require('../core/options');

const MODELS = ['', ...options.MODELS];
// plan önerilmez: plan modundaki üye komut çalıştıramaz, ekiple çalışırken takılır.
const MODES = ['', ...options.PERMISSION_MODES.filter((m) => m !== 'plan')];
const EFFORTS = ['', ...options.EFFORTS];

function readHead(file, max) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    return t.length > max ? `${t.slice(0, max)}\n…(devamı var)` : t;
  } catch { return null; }
}

// Talimat dosyası (CLAUDE.md) projenin ne olduğunu en iyi anlatan kaynak; kırpılmadan verilir, yalnızca aşırı büyük
// dosyaya karşı üst sınır var (~20k token). Alt projelerinki de aynı amaçla geniş.
const CLAUDE_MD_MAX = 60000;
const SUB_CLAUDE_MD_MAX = 20000;

// Panelin çıkardığı proje özeti: talimat dosyaları, README, kök klasör ve kullanılan teknolojiler.
function projectSummary(dir) {
  const out = { klasor: path.basename(dir) };
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.') || d.name === '.claude').map((d) => (d.isDirectory() ? `${d.name}/` : d.name)); } catch {}
  out.kok = names.slice(0, 80);
  const claude = readHead(path.join(dir, 'CLAUDE.md'), CLAUDE_MD_MAX) || readHead(path.join(dir, '.claude', 'CLAUDE.md'), CLAUDE_MD_MAX);
  if (claude) out.claude_md = claude;
  const readme = names.find((n) => /^readme(\.md|\.txt)?$/i.test(n));
  if (readme) out.readme = readHead(path.join(dir, readme), 5000);
  const stack = [];
  const pkg = readHead(path.join(dir, 'package.json'), 200000);
  if (pkg) {
    try {
      const j = JSON.parse(pkg);
      stack.push(`node: ${Object.keys({ ...(j.dependencies || {}), ...(j.devDependencies || {}) }).slice(0, 40).join(', ')}`);
    } catch {}
  }
  const marks = [['build.gradle', 'gradle/android'], ['settings.gradle', 'gradle'], ['pom.xml', 'maven'], ['requirements.txt', 'python'], ['pyproject.toml', 'python'],
    ['go.mod', 'go'], ['Cargo.toml', 'rust'], ['Podfile', 'ios/cocoapods'], ['pubspec.yaml', 'flutter'], ['composer.json', 'php'], ['Gemfile', 'ruby'], ['docker-compose.yml', 'docker'], ['Dockerfile', 'docker']];
  for (const [f, label] of marks) if (names.includes(f)) stack.push(label);
  // Kökte talimat yoksa çoğu zaman asıl kod bir alt klasördedir: ilk seviyedeki alt projelerin talimat ve README'si de eklenir.
  const sub = [];
  for (const n of names.filter((x) => x.endsWith('/')).slice(0, 30)) {
    for (const [f, label] of marks) if (fs.existsSync(path.join(dir, n, f))) stack.push(`${n}${f} (${label})`);
    const spkg = readHead(path.join(dir, n, 'package.json'), 200000);
    if (spkg) {
      try {
        const j = JSON.parse(spkg);
        stack.push(`${n} node: ${Object.keys({ ...(j.dependencies || {}), ...(j.devDependencies || {}) }).slice(0, 30).join(', ')}`);
      } catch {}
    }
    if (sub.length < 3) {
      const c = readHead(path.join(dir, n, 'CLAUDE.md'), SUB_CLAUDE_MD_MAX);
      const r = readHead(path.join(dir, n, 'README.md'), 2000);
      if (c || r) sub.push({ klasor: n, ...(c ? { claude_md: c } : {}), ...(r ? { readme: r } : {}) });
    }
  }
  if (sub.length) out.alt_projeler = sub;
  if (stack.length) out.teknoloji = [...new Set(stack)];
  return out;
}

// Aynı projedeki son grupların rol + model başına harcaması. stats(sessionId) -> usage.sessionStats çıktısı.
function history(groups, stats, limit = 6) {
  const agg = new Map();
  for (const g of groups.slice(-limit)) {
    for (const s of g.sessions) {
      const st = stats(s.id);
      if (!st || !st.lastAt) continue;
      const model = s.model || (st.model ? String(st.model).replace(/^claude-/, '').split('-')[0] : 'varsayılan');
      const k = `${s.roleId === 'custom' ? s.roleLabel : s.roleId}|${model}`;
      const a = agg.get(k) || { rol: s.roleId === 'custom' ? `anlık: ${s.roleLabel}` : s.roleId, model, oturum: 0, toplam_usd: 0, mesaj: 0, eklenen_satir: 0, saat: 0 };
      a.oturum += 1;
      a.toplam_usd += st.costUSD || 0;
      a.mesaj += st.prompts || 0;
      a.eklenen_satir += st.linesAdded || 0;
      a.saat += st.firstAt && st.lastAt ? (st.lastAt - st.firstAt) / 3600000 : 0;
      agg.set(k, a);
    }
  }
  return [...agg.values()].map((a) => ({ ...a, toplam_usd: +a.toplam_usd.toFixed(2), ortalama_usd: +(a.toplam_usd / a.oturum).toFixed(2), saat: +a.saat.toFixed(1) }));
}

// Kota sırasına göre hesap dağıtımı: dolu ya da sorgulanamayan hesap atlanır; ağır satırlar (şef, opus) önce, en çok
// kotası kalan ve en az yük almış hesaba. Kota bilinmiyorsa satırın hesabı değişmez.
function assignAccounts(rows, accounts, quota) {
  const left = new Map();
  for (const r of (quota && quota.rows) || []) {
    if (r.status !== 'canlı' || r.blocked) continue;
    const l = Math.min(...[r.five, r.week].filter(Boolean).map((b) => 100 - b.used), 100);
    if (l > 5 && accounts.some((a) => a.id === r.accountId)) left.set(r.accountId, l);
  }
  if (!left.size) return {};
  const weight = (r) => (r.model === 'opus' ? 3 : r.model === 'haiku' ? 1 : 2) + (r.roleId === 'sef' ? 1 : 0);
  const load = new Map([...left.keys()].map((k) => [k, 0]));
  const out = {};
  for (const r of rows.slice().sort((a, b) => weight(b) - weight(a))) {
    const best = [...left.keys()].sort((a, b) => left.get(b) / (1 + load.get(b)) - left.get(a) / (1 + load.get(a)))[0];
    load.set(best, load.get(best) + weight(r));
    if (best !== r.accountId) out[r.key] = { accountId: best, why: `kota dağıtımı: %${Math.round(left.get(best))} kotası kalan hesap` };
  }
  return out;
}

// projectDir: model bu klasörde yalnızca okuma araçlarıyla (Read, Grep, Glob) projeyi inceleyebilir.
// Metin ve ayarlar prompts/tools/kurulum-danismani/ (persona, görevler, sınırlar, çıktı md'leri; tool.json: model, maxTurns, timeoutSec); her çağrıda okunur.
// Tur sınırı proje incelemesinin uzamasını keser. model verilmezse tool.json'daki model.
function ask(account, payload, model = null, projectDir = null) {
  return new Promise((resolve, reject) => {
    const t = promptTool('kurulum-danismani');
    fs.mkdirSync(CWD, { recursive: true });
    const cwd = projectDir && fs.existsSync(projectDir) ? projectDir : CWD;
    const read = cwd !== CWD;
    llm.run({
      kind: 'kurulum danışmanı', account, model: model || t.config.model, system: t.system(), excludeDynamic: true, input: JSON.stringify(payload), cwd,
      tools: read ? READ_TOOLS : '', allowed: read ? READ_TOOLS : null, maxTurns: read ? t.config.maxTurns : null,
      timeoutMs: t.config.timeoutSec * 1000, timeoutMsg: 'kurulum danışmanı zaman aşımına uğradı',
    }).then(({ res, ok }) => {
      if (!ok) return reject(new Error(`model hatası: ${String(res.result || res.subtype).slice(0, 200)}`));
      // Talimatlar JSON dışında bloklar halinde gelir; uzun metni JSON'a kaçışlamak modelin en sık hatasıdır.
      const prompts = {};
      const text = String(res.result || '').replace(/^=== TALIMAT (\S+) ===\r?\n([\s\S]*?)\r?\n=== SON ===[ \t]*$/gm, (all, key, body) => {
        prompts[key] = body.trim();
        return '';
      });
      const m = text.match(/\{[\s\S]*\}/);
      let parsed;
      try { parsed = JSON.parse(m ? m[0] : text); } catch { return reject(new Error(`model JSON yazmadı: ${text.slice(0, 200)}`)); }
      for (const list of [parsed.satirlar, parsed.yeni_satirlar]) {
        for (const x of Array.isArray(list) ? list : []) if (x && prompts[x.key]) x.talimat = prompts[x.key];
      }
      resolve({ parsed, account: account.id, costUSD: res.total_cost_usd || 0, turns: res.num_turns || 0 });
    }, reject);
  });
}

// Model yanıtını formdaki satırlarla doğrular; geçersiz alanlar atılır, var olan satırın rolü hiçbir zaman değişmez.
// rows: [{ key, roleId, model, effort, permissionMode, talkAll, reportsTo, manualPrompt }], capKeys: geçerli yetenek anahtarları
function validate(rows, parsed, capKeys, roleIds = []) {
  const keys = new Set(rows.map((r) => r.key));
  const caps = new Set(capKeys);
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const byKey = new Map((Array.isArray(parsed && parsed.satirlar) ? parsed.satirlar : []).filter((x) => x && keys.has(x.key)).map((x) => [x.key, x]));
  const patches = {};
  for (const r of rows) {
    const x = byKey.get(r.key);
    if (!x) continue;
    const why = x.neden && typeof x.neden === 'object' ? x.neden : {};
    const p = { why: {} };
    if (typeof x.model === 'string' && MODELS.includes(x.model) && x.model !== r.model) { p.model = x.model; p.why.model = str(why.model, 200); }
    if (typeof x.effort === 'string' && EFFORTS.includes(x.effort) && x.effort !== (r.effort || '')) { p.effort = x.effort; p.why.effort = str(why.effort, 200); }
    if (typeof x.izin === 'string' && MODES.includes(x.izin) && x.izin !== r.permissionMode) { p.permissionMode = x.izin; p.why.permissionMode = str(why.izin, 200); }
    if (typeof x.herkesle === 'boolean' && x.herkesle !== !!r.talkAll) { p.talkAll = x.herkesle; p.why.links = str(why.baglanti, 200); }
    if (Array.isArray(x.rapor_verir)) {
      const to = [...new Set(x.rapor_verir.filter((k) => typeof k === 'string' && keys.has(k) && k !== r.key))];
      if (to.slice().sort().join() !== r.reportsTo.slice().sort().join()) { p.reportsTo = to; p.why.links = str(why.baglanti, 200); }
    }
    if (!r.manualPrompt && typeof x.talimat === 'string' && x.talimat.trim().length > 40) { p.prompt = x.talimat.trim(); p.why.prompt = str(why.talimat, 200); }
    const on = Array.isArray(x.yetenek_ac) ? x.yetenek_ac.filter((k) => caps.has(k)) : [];
    const off = Array.isArray(x.yetenek_kapat) ? x.yetenek_kapat.filter((k) => caps.has(k) && !on.includes(k)) : [];
    if (on.length || off.length) { p.caps = { on, off }; p.why.caps = str(why.yetenek, 200); }
    if (Object.keys(p).length > 1) patches[r.key] = p;
  }
  // Çıkarılacak satırlar: şef hiçbir zaman, ekip de boş kalmaz.
  const removes = [];
  for (const x of Array.isArray(parsed && parsed.cikar) ? parsed.cikar : []) {
    const r = x && rows.find((y) => y.key === x.key);
    if (!r || r.roleId === 'sef' || removes.some((y) => y.key === r.key) || removes.length + 1 >= rows.length) continue;
    removes.push({ key: r.key, why: str(x.neden, 200) });
    delete patches[r.key];
  }
  // Eklenecek satırlar yalnızca rol kataloğundan; toplam 12 üyeyi geçmez.
  const adds = [];
  const room = MAX_ROWS - (rows.length - removes.length);
  const gone = new Set(removes.map((x) => x.key));
  const newKeys = new Set((Array.isArray(parsed && parsed.yeni_satirlar) ? parsed.yeni_satirlar : []).map((x) => x && x.key).filter((k) => typeof k === 'string' && /^yeni_\d{1,2}$/.test(k)));
  for (const x of Array.isArray(parsed && parsed.yeni_satirlar) ? parsed.yeni_satirlar : []) {
    if (adds.length >= room) break;
    if (!x || !newKeys.has(x.key) || adds.some((y) => y.key === x.key) || !roleIds.includes(x.rol) || x.rol === 'sef') continue;
    const to = Array.isArray(x.rapor_verir) ? [...new Set(x.rapor_verir.filter((k) => typeof k === 'string' && k !== x.key && ((keys.has(k) && !gone.has(k)) || newKeys.has(k))))] : [];
    adds.push({
      key: x.key, roleId: x.rol,
      model: typeof x.model === 'string' && MODELS.includes(x.model) ? x.model : undefined,
      effort: typeof x.effort === 'string' && EFFORTS.includes(x.effort) ? x.effort : '',
      permissionMode: typeof x.izin === 'string' && MODES.includes(x.izin) ? x.izin : undefined,
      talkAll: x.herkesle === true, reportsTo: to,
      prompt: typeof x.talimat === 'string' && x.talimat.trim().length > 40 ? x.talimat.trim() : null,
      capsOff: Array.isArray(x.yetenek_kapat) ? x.yetenek_kapat.filter((k) => caps.has(k)) : [],
      why: str(x.neden, 200),
    });
  }
  // Var olan satırların bağlantılarında yeni satırlara ve çıkarılan satırlara verilen key'ler düzeltilir.
  for (const p of Object.values(patches)) {
    if (p.reportsTo) p.reportsTo = p.reportsTo.filter((k) => !gone.has(k));
  }
  for (const r of rows) {
    const x = byKey.get(r.key);
    if (!x || gone.has(r.key) || !Array.isArray(x.rapor_verir)) continue;
    const extra = x.rapor_verir.filter((k) => adds.some((a) => a.key === k));
    if (!extra.length) continue;
    const p = patches[r.key] || (patches[r.key] = { why: {} });
    p.reportsTo = [...new Set([...(p.reportsTo || r.reportsTo.filter((k) => !gone.has(k))), ...extra])];
    p.why.links = p.why.links || str((x.neden || {}).baglanti, 200);
  }
  const list = (v, n) => (Array.isArray(v) ? v.map((s) => str(s, 300)).filter(Boolean).slice(0, n) : []);
  return { patches, adds, removes, suggestions: list(parsed && parsed.oneriler, 8), flowExtra: list(parsed && parsed.akis_eki, 6) };
}

module.exports = { projectSummary, history, assignAccounts, ask, validate };
