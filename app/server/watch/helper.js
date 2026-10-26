// Yardımcı model: bekçinin hamle adayları için hangi seçeneğin yapılacağını Haiku'ya sorar. Model yalnızca bu
// istemdeki sayıları ve adayların son mesajının sonunu (en fazla 300 karakter) görür: proje içeriği, CLAUDE.md, tool
// ve MCP yoktur (claude -p, boş klasörde, ayar kaynakları kapalı; ölçülen istem ~1k token). Yanıt panel tarafından
// doğrulanır: verilen seçenekler dışındaki her şey yok sayılır.
const fs = require('fs');
const path = require('path');
const os = require('os');
const llm = require('../core/llm');
const prompts = require('../core/prompts');

const CWD = path.join(os.tmpdir(), 'claude-panel-helper');

// Kota satırlarından en çok kotası kalan hesap (iki pencereden küçüğüne göre); yardımcı model onun hesabıyla çalışır.
function pickAccount(accounts, quota) {
  const left = (r) => (r.status !== 'canlı' || r.blocked ? -1 : Math.min(...[r.five, r.week].filter(Boolean).map((b) => 100 - b.used), 100));
  const rows = ((quota && quota.rows) || []).slice().sort((a, b) => left(b) - left(a));
  const best = rows[0] && left(rows[0]) > 5 ? accounts.find((a) => a.id === rows[0].accountId) : null;
  return best || accounts[0] || null;
}

// cands: [{ sid, name, why, options: [{ id, text }], def }], context: { accounts: [...], members: { sid: {...} } }
function ask(account, cands, context) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(CWD, { recursive: true });
    const payload = {
      hesaplar: context.accounts,
      uyeler: cands.map((c) => ({
        uye: c.sid,
        ...(context.members[c.sid] || {}),
        durum_nedeni: c.why,
        secenekler: c.options.map((o) => ({ id: o.id, aciklama: o.text })),
        kural_onerisi: c.def,
      })),
    };
    // Metin ve model ayarı prompts/tools/bekci/ (persona, görevler, sınırlar, çıktı md'leri; tool.json); her çağrıda okunur.
    const t = prompts.tool('bekci');
    llm.run({
      kind: 'bekçi yardımcısı', label: 'yardımcı model', account, model: t.config.model, effort: t.config.effort, system: t.system(), excludeDynamic: true,
      input: JSON.stringify(payload), cwd: CWD, timeoutMs: t.config.timeoutSec * 1000, timeoutMsg: 'yardımcı model zaman aşımı',
    }).then(({ res, ok, text }) => {
      if (!ok) return reject(new Error(`yardımcı model hatası: ${String(res.result || res.subtype).slice(0, 200)}`));
      const m = text.match(/\{[\s\S]*\}/);
      let parsed;
      try { parsed = JSON.parse(m ? m[0] : text); } catch { return reject(new Error(`yardımcı model JSON yazmadı: ${text.slice(0, 200)}`)); }
      const u = res.usage || {};
      resolve({
        decisions: Array.isArray(parsed.kararlar) ? parsed.kararlar : [],
        account: account.id,
        tokens: { in: u.input_tokens || 0, cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 },
        costUSD: res.total_cost_usd || 0,
      });
    }, reject);
  });
}

// Model yanıtını adaylarla doğrular: her aday için geçerli bir seçim, yoksa kural varsayılanı.
function validate(cands, decisions) {
  const by = new Map((decisions || []).filter((d) => d && typeof d.uye === 'string').map((d) => [d.uye, d]));
  return cands.map((c) => {
    const d = by.get(c.sid);
    const ok = d && c.options.some((o) => o.id === d.secim);
    return { cand: c, choice: ok ? d.secim : c.def, by: ok ? 'yardımcı model' : 'kural', why: ok ? String(d.neden || '').slice(0, 200) : null };
  });
}

module.exports = { ask, validate, pickAccount };
