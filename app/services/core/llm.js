// Panelin yardımcı model çağrıları (bekçi yardımcısı, kurulum danışmanı, not düzenleyici) tek yerden: claude -p, hesabın
// kendi ayar klasörüyle, üst oturumun CLAUDE* / ANTHROPIC* değişkenleri temizlenmiş ortamda, ayar kaynakları kapalı.
// Çağrılar --no-session-persistence ile çalıştığı için oturum kaydı bırakmaz; harcamaları buradan deftere yazılır ve
// ölçüme (meter) eklenir. Yoksa kota yüzdesindeki artış token'sız görünür ve kota / birim oranı şişer.
const { spawn } = require('child_process');
const { family } = require('../watch/meter');

const listeners = [];

// fn({ kind, gid, account, model, ok, error, costUSD, turns, ms, tok }) — her çağrı bitince (hata dahil).
function onSpend(fn) {
  listeners.push(fn);
}

function cleanEnv(account, extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC)/i.test(k)) env[k] = v;
  env.CLAUDE_CONFIG_DIR = account.configDir;
  return Object.assign(env, extra || {});
}

// Sonuçtaki modelUsage (model başına, çok turlu çağrıda toplam) meter'ın aile bazlı token biçimine çevrilir.
function usageTok(res) {
  const tok = {};
  for (const [model, u] of Object.entries((res && res.modelUsage) || {})) {
    const fam = family(model);
    if (!fam || !u) continue;
    const t = tok[fam] || (tok[fam] = { in: 0, out: 0, cw: 0, cr: 0 });
    t.in += u.inputTokens || 0;
    t.out += u.outputTokens || 0;
    t.cw += u.cacheCreationInputTokens || 0;
    t.cr += u.cacheReadInputTokens || 0;
  }
  return tok;
}

// Claude Code'un bildirdiği bağlam penceresi (model ailesi başına); ayardaki pencere değeriyle karşılaştırmak için.
function windowsOf(res) {
  const out = {};
  for (const [model, u] of Object.entries((res && res.modelUsage) || {})) {
    const fam = family(model);
    if (fam && u && u.contextWindow) out[fam] = u.contextWindow;
  }
  return out;
}

function argsOf(o) {
  const a = ['-p', '--model', o.model];
  if (o.effort) a.push('--effort', o.effort);
  a.push('--tools', o.tools || '');
  if (o.allowed) a.push('--allowedTools', o.allowed);
  if (o.deny) a.push('--disallowedTools', o.deny);
  if (o.mcpConfig) a.push('--mcp-config', o.mcpConfig);
  a.push('--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands', '--no-chrome');
  if (o.maxTurns) a.push('--max-turns', String(o.maxTurns));
  if (o.excludeDynamic) a.push('--exclude-dynamic-system-prompt-sections');
  a.push('--system-prompt', o.system, '--output-format', 'json');
  return a;
}

// o: { kind, gid, label, account, model, effort, system, input, cwd, tools, allowed, deny, mcpConfig, maxTurns,
//      excludeDynamic, env, timeoutMs, timeoutMsg }
// Döner: { res, ok, text, costUSD, turns }. Süreç açılamaz, süre dolar ya da çıktı JSON değilse hata fırlatır;
// modelin kendi hatası (is_error) hata sayılmaz, ok: false ile döner (çağıran karar verir).
function run(o) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const report = (extra) => {
      const e = { kind: o.kind, gid: o.gid || null, account: o.account.id, model: o.model, ms: Date.now() - t0, ...extra };
      for (const fn of listeners) {
        try { fn(e); } catch (err) { console.error('[llm] defter:', err.message); }
      }
    };
    const child = spawn('claude', argsOf(o), { cwd: o.cwd, env: cleanEnv(o.account, o.env), windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      report({ ok: false, error: 'zaman aşımı', costUSD: 0, turns: 0, tok: {} });
      reject(new Error(o.timeoutMsg || `${o.label || 'model'} zaman aşımına uğradı`));
    }, o.timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      report({ ok: false, error: e.message, costUSD: 0, turns: 0, tok: {} });
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (child.killed) return;
      let res;
      try { res = JSON.parse(out); } catch {
        report({ ok: false, error: `çıkış ${code}`, costUSD: 0, turns: 0, tok: {} });
        return reject(new Error(`${o.label ? `${o.label} ` : ''}yanıtı okunamadı (çıkış ${code}): ${(err || out).trim().slice(0, 300)}`));
      }
      const r = { res, ok: !res.is_error, text: String(res.result || ''), costUSD: res.total_cost_usd || 0, turns: res.num_turns || 0 };
      report({ ok: r.ok, error: r.ok ? null : String(res.subtype || 'hata'), costUSD: r.costUSD, turns: r.turns, tok: usageTok(res), windows: windowsOf(res) });
      resolve(r);
    });
    child.stdin.end(o.input);
  });
}

module.exports = { run, onSpend, usageTok, windowsOf, argsOf, cleanEnv };
