// Yardımcı model: bekçinin hamle adayları için hangi seçeneğin yapılacağını Haiku'ya sorar. Model yalnızca bu
// istemdeki sayıları ve adayların son mesajının sonunu (en fazla 300 karakter) görür: proje içeriği, CLAUDE.md, tool
// ve MCP yoktur (claude -p, boş klasörde, ayar kaynakları kapalı; ölçülen istem ~1k token). Yanıt panel tarafından
// doğrulanır: verilen seçenekler dışındaki her şey yok sayılır.
const fs = require('fs');
const path = require('path');
const os = require('os');
const llm = require('../core/llm');

const TIMEOUT = 90 * 1000;
const CWD = path.join(os.tmpdir(), 'claude-panel-helper');

const SYSTEM = [
  'Sen Claude Panel\'in bekçisisin. Panelde birden çok Claude hesabıyla çalışan bir ekip var.',
  'Görevin: her üye için verilen seçeneklerden birini seçmek. Amaç hesap kotalarını en verimli kullanmak ve işin yarıda kalmamasını sağlamak.',
  'Claude kotası nasıl işler:',
  '- Her hesabın iki penceresi var: 5 saatlik (ilk mesajla başlar, 5 saat sonra sıfırlanır) ve haftalık (7 günlük toplam). Hangisi dolarsa hesap o sıfırlanana kadar çalışmaz. *_kalan yüzde, *_sifirlanma_dk sıfırlanmaya kalan dakikadır.',
  '- Kotayı mesaj sayısı değil işlenen token harcar. Her tur bağlamın tamamını yeniden okur: büyük bağlamlı üyenin kısa bir turu bile pahalıdır.',
  '- Önbellekten okumak ucuzdur (~0,1 kat), önbelleğe yazmak pahalıdır (~1,25-2 kat). Önbellek son turdan sonra yaklaşık 1 saat yaşar (cache_sicak, cache_dusmesine_dk); soğuksa sonraki tur bağlamı zaten baştan yazar, o zaman taşımanın ek maliyeti yoktur.',
  '- Kullanılmayan kota sıfırlanmada yanar, devretmez: hesap tükenmek üzere değilken onu terk etmek kotayı israf eder. Doğrusu bir hesabı tükenmesine az kalana kadar kullanmaktır. *_tukenme_dk bu hızla dolmaya kalan süredir (null: sıfırlanmaya yetiyor). Hedef hesabın da tükenme süresine bak.',
  'Hamleler:',
  '- compact bağlamı küçültür, sonraki her tur ucuzlar; özet bir kez maliyet çıkarır. Sistem istemi gibi sabit kısım kalır, oturum aynı devam eder.',
  '- yenile, üyeye devir notu yazdırıp aynı rolü sıfır bağlamla açar; bağlam en çok bununla küçülür ama ayrıntı kaybı riski vardır, en iyi iş arasında yapılır.',
  '- taşı, üyeyi başka hesaba geçirir; yeni hesapta bağlam önbelleğe baştan yazılır, bu yüzden bağlam büyük ve önbellek sıcaksa pahalıdır.',
  '- bekle, hiçbir şey yapmaz; kotanın sıfırlanması yakınsa, üye işini bitirmek üzereyse ya da cevap bekliyorsa mantıklıdır.',
  'Bağlam için sıra: üyede bu oturumda 2 compact yapılmadıysa compact, yapıldıysa yenile. Rol eşikleri (rol_esigi_token, rol_ust_siniri_token) rolün önemine göre ayarlıdır (şef yüksek, araştırma düşük).',
  'cevap_bekliyor true ise ya da son_mesaj_sonu kullanıcıya veya ekibe soru soruyor, onay ya da seçim bekliyorsa bekle seç: hamle o soruyu ve beklenen cevabı kaybettirir.',
  'Maliyetler "birim" (≈ API eşdeğeri $) ya da hesabın kota yüzdesidir. kural_onerisi, panelin kendi kuralının seçimidir; daha iyisi yoksa onu seç.',
  'Yalnızca JSON yaz, başka hiçbir şey yazma: {"kararlar":[{"uye":"<uye kimliği>","secim":"<seçenek kimliği>","neden":"<en fazla 15 kelime>"}]}',
].join('\n');

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
    llm.run({
      kind: 'bekçi yardımcısı', label: 'yardımcı model', account, model: 'haiku', effort: 'low', system: SYSTEM, excludeDynamic: true,
      input: JSON.stringify(payload), cwd: CWD, timeoutMs: TIMEOUT, timeoutMsg: 'yardımcı model zaman aşımı',
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
