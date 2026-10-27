// Mesaj geliştirici: kullanıcının bir üyeye yazacağı ham mesajı düzeltir ve nedenini kısaca söyler. Hiçbir şey göndermez;
// sonuç panelde gösterilir, kullanıcı kopyalar ya da üyeye gönderir. Metin ve ayarlar prompts/tools/prompt-gelistirici/.
const fs = require('fs');
const path = require('path');
const os = require('os');
const llm = require('../core/llm');
const prompts = require('../core/prompts');

const CWD = path.join(os.tmpdir(), 'claude-panel-helper');

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

// payload: { tur, hedef: { ad, rol, gorev }, grup, proje, baslik (kartta), mesaj, yonerge }. tur "kart": başlık + açıklama.
function ask(account, payload) {
  const t = prompts.tool('prompt-gelistirici');
  fs.mkdirSync(CWD, { recursive: true });
  return llm.run({
    kind: 'mesaj geliştirici', account, model: t.config.model, effort: t.config.effort, system: t.system(payload.tur === 'kart' ? [t.text('kart.md')] : []), excludeDynamic: true,
    input: JSON.stringify(payload), cwd: CWD, tools: '', timeoutMs: t.config.timeoutSec * 1000, timeoutMsg: 'mesaj geliştirici zaman aşımına uğradı',
  }).then(({ res, ok }) => {
    if (!ok) throw new Error(`model hatası: ${String(res.result || res.subtype).slice(0, 200)}`);
    const text = String(res.result || '');
    const m = text.match(/\{[\s\S]*\}/);
    let parsed;
    try { parsed = JSON.parse(m ? m[0] : text); } catch { throw new Error(`model JSON yazmadı: ${text.slice(0, 200)}`); }
    return { parsed, account: account.id, costUSD: res.total_cost_usd || 0 };
  });
}

// Yanıtı doğrular: boş metin kabul edilmez; gerekçeler kısa ve sınırlı sayıda.
function validate(parsed, original, kart) {
  const cfg = prompts.tool('prompt-gelistirici').config;
  const metin = typeof (parsed && parsed.metin) === 'string' ? parsed.metin.replace(/\r\n/g, '\n').trim() : '';
  if (!metin) throw new Error('model boş mesaj döndürdü');
  const reasons = (Array.isArray(parsed.gerekceler) ? parsed.gerekceler : []).map((x) => str(x, 300)).filter(Boolean).slice(0, cfg.maxReasons);
  const title = str(parsed.baslik, 200);
  if (kart && !title) throw new Error('model kart başlığı döndürmedi');
  return { ...(kart ? { title } : {}), text: metin, changed: parsed.degisti !== false && metin !== original.trim(), reasons };
}

module.exports = { ask, validate };
