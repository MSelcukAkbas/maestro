// Not düzenleyici: grup notlarını aralıklı olarak toparlayan alt model. Tekrarları ayıklar, aynı konudaki notları
// birleştirir, çelişen bilgiyi şefe sorar ve gelen cevaba göre notu netleştirir. Notlara doğrudan dosya olarak değil,
// panelin ayrı MCP adresindeki tool'larla yazar (server/notes.js CURATOR_TOOLS); projede yalnızca okuma tool'ları
// (Read, Grep, Glob) vardır. Bilgi kaybına karşı güvenceler sunucuda: her yazımdan önceki sürüm geçmişe girer,
// birleştirilen not silinmez arşive alınır, kullanıcının metni olduğu gibi kalmayan yazım reddedilir.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const llm = require('../core/llm');
const prompts = require('../core/prompts');
const { CURATOR, plainBody, userBlocks } = require('./notes');
const { TOKEN_ENV } = require('../session/hooks');

// Metinler ve ayarlar prompts/tools/not-duzenleyici/ (tool.json: varsayılanlar, minNotes, memory, derinlik seviyeleri;
// persona / görevler / sınırlar / çıktı md'leri; görevlerin sonuna seviye-<ad>.md ve zincir.md) ve prompts/tools/kapanis-ozeti/
// altında; her çalıştırmada okunur.
// Derinlik: modelin hangi notlara bakacağı ve ne kadar ileri gideceği. Zamanlı çalıştırma ayardaki seviyeyi,
// "Şimdi düzenle" seçilen seviyeyi kullanır.
const tool = () => prompts.tool('not-duzenleyici');
const defaults = () => tool().config.defaults;
const levels = () => tool().config.levels;
const levelNames = () => Object.keys(levels());

function systemPrompt(level) {
  const t = tool();
  // Zincir kuralı (review/düzeltme zincirini ana nota katma) seviyenin "chain" ayarıyla eklenir.
  return t.system([t.text(`seviye-${level}.md`), ...(levels()[level].chain ? [t.text('zincir.md')] : [])]);
}

const fmt = (ts) => (ts ? new Date(ts).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');

class Curator {
  // deps: notes, dataDir, port, token, groups() -> gruplar, project(group) -> { path } | null, lead(group) -> oturum | null,
  // actorName(group, id), account(settings) -> { id, configDir }, settings() -> panel ayarları, event(text, gid), tell(gid, text)
  constructor(deps) {
    this.d = deps;
    this.file = path.join(deps.dataDir, 'curator.json');
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.state = {}; }
    this.running = new Map();
  }

  cfg() {
    return { ...defaults(), ...((this.d.settings() || {}).curator || {}) };
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // Notlar ya da şefin cevapları değişmediyse yeniden çalışmanın anlamı yok.
  hash(gid) {
    const n = this.d.notes.load(gid);
    const live = n.notes.filter((x) => !x.archived).map((x) => [x.id, x.updatedAt]);
    const answers = n.questions.filter((q) => q.answer && !q.appliedAt).map((q) => q.id);
    return crypto.createHash('sha1').update(JSON.stringify([live, answers])).digest('hex');
  }

  status(gid) {
    const s = this.state[gid] || {};
    const n = this.d.notes.load(gid);
    return {
      ...this.cfg(), running: this.running.has(gid), startedAt: (this.running.get(gid) || {}).at || null,
      lastRunAt: s.lastRunAt || null, last: s.last || null, levels: Object.fromEntries(Object.entries(levels()).map(([k, v]) => [k, v.label])),
      open: n.questions.filter((q) => !q.answer).length, answered: n.questions.filter((q) => q.answer && !q.appliedAt).length,
      questions: n.questions.slice(-20),
    };
  }

  // Zamanlayıcı: açık, aralığı dolmuş ve notları değişmiş gruplar.
  // İlk düzenleme elle başlatılır (Notlar → Şimdi düzenle): büyük not defterinde ilk geçiş pahalı olabilir.
  tick(now = Date.now()) {
    const cfg = this.cfg();
    for (const g of this.d.groups()) {
      // Şef kapalıyken sorulan sorular şef açılınca iletilir.
      const lead = this.d.lead(g);
      if (lead) this.d.notes.sendQuestions(g, lead.id);
      if (!cfg.enabled || this.running.has(g.id)) continue;
      const s = this.state[g.id] || {};
      if (!s.lastRunAt || now - s.lastRunAt < cfg.everyH * 3600 * 1000) continue;
      const n = this.d.notes.load(g.id);
      if (n.notes.filter((x) => !x.archived).length < tool().config.minNotes) continue;
      if (s.hash && s.hash === this.hash(g.id)) continue;
      this.run(g).catch((err) => console.error('[panel] not düzenleyici:', err.message));
    }
  }

  // Modelin ilk gördüğü özet: her notun kimliği, sahibi, zamanları, boyu; açık ve cevaplanmış sorular.
  brief(g, since, level, memory) {
    const n = this.d.notes.load(g.id);
    const live = n.notes.filter((x) => !x.archived);
    const rows = live.map((x) => {
      const own = x.by === 'user' ? 'kullanıcı notu' : `${userBlocks(x).length} kullanıcı bloğu`;
      const changed = !since ? '' : x.createdAt > since ? ' · YENİ' : x.updatedAt > since ? ' · DEĞİŞTİ' : '';
      return `- #${x.id} "${x.title}" · ekleyen: ${this.d.actorName(g, x.by)} · eklendi ${fmt(x.createdAt)} · son düzenleme ${fmt(x.updatedAt)}${x.updatedBy ? ` (${this.d.actorName(g, x.updatedBy)})` : ''} · ${plainBody(x.body).length} karakter · ${own} · ${x.to.length} alıcı${changed}`;
    });
    const open = n.questions.filter((q) => !q.answer);
    const answered = n.questions.filter((q) => q.answer && !q.appliedAt);
    const project = this.d.project(g);
    return [
      `Grup: ${g.name}${project ? ` · proje klasörü: ${project.path} (şu an buradasın)` : ''}`,
      `Bugün: ${fmt(Date.now())} · önceki düzenleme: ${since ? fmt(since) : 'yok (ilk düzenleme)'}`,
      '',
      `Notlar (${live.length}; arşivdekiler hariç):`,
      ...rows,
      '',
      answered.length ? 'Şefin cevapladığı sorular (ilgili notları buna göre netleştir):' : null,
      ...answered.map((q) => `- S${q.id}${q.notes.length ? ` (${q.notes.map((x) => `#${x}`).join(', ')})` : ''}: ${q.text}\n  CEVAP: ${q.answer}`),
      open.length ? 'Cevap bekleyen sorular (yeniden sorma; ilgili kısma dokunma):' : null,
      ...open.map((q) => `- S${q.id}: ${q.text}`),
      memory.length ? '' : null,
      memory.length ? 'Önceki çalıştırmaların özeti (hafızan; eskiden yeniye):' : null,
      ...memory.map((m) => `--- ${fmt(m.at)} · ${(levels()[m.level] || levels().orta || {}).label || m.level} derinlik
${m.text}`),
      '',
      `Derinlik: ${levels()[level].label}. Notları not_oku ile oku, sonra düzenle.${level === 'yuksek' ? ' Tüm notları kart ve konu gruplarına ayırarak ele al.' : ' Önce YENİ ve DEĞİŞTİ işaretli notlara bak.'}`,
    ].filter((x) => x != null).join('\n');
  }

  writeMcp(gid) {
    const dir = path.join(this.d.dataDir, 'mcp');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `curator-${gid}.json`);
    fs.writeFileSync(file, JSON.stringify({
      // Anahtar dosyaya yazılmaz; süreç ortamından okunur (server/hooks.js ile aynı).
      mcpServers: { panel: { type: 'http', url: `http://127.0.0.1:${this.d.port}/api/mcp/curator-${gid}`, headers: { 'x-panel-hook-token': `\${${TOKEN_ENV}}` } } },
    }, null, 2));
    return file;
  }

  async run(g, manual = false, level = null) {
    if (this.running.has(g.id)) throw Object.assign(new Error('Not düzenleyici bu grupta zaten çalışıyor.'), { status: 409 });
    const cfg = this.cfg();
    const lvs = levels();
    const lv = lvs[level] ? level : lvs[cfg.level] ? cfg.level : defaults().level;
    const memSize = tool().config.memory;
    const account = this.d.account();
    if (!account) throw Object.assign(new Error('Kotası olan hesap yok.'), { status: 409 });
    const project = this.d.project(g);
    const s = this.state[g.id] || {};
    const startedAt = Date.now();
    const appliedIds = this.d.notes.load(g.id).questions.filter((q) => q.answer && !q.appliedAt).map((q) => q.id);
    // Hafıza: eski kayıtlarda yalnızca son çalıştırma vardır.
    const memory = (s.memory || (s.last && s.last.ok ? [{ at: s.last.at, level: 'orta', text: s.last.text }] : [])).slice(-memSize);
    this.running.set(g.id, { at: startedAt, level: lv });
    this.d.event(`Not düzenleyici başladı (${account.id} hesabı, ${cfg.model}, ${lvs[lv].label} derinlik${manual ? ', elle' : ''}).`, g.id);
    let result;
    try {
      result = await this.spawn(g, account, cfg.model, project, this.brief(g, s.lastRunAt || null, lv, memory),
        { turns: lvs[lv].turns, timeoutMin: lvs[lv].timeoutMin, system: systemPrompt(lv) });
    } catch (err) {
      result = { ok: false, text: err.message, costUSD: 0 };
    } finally {
      this.running.delete(g.id);
    }
    const n = this.d.notes.load(g.id);
    const edited = n.notes.filter((x) => x.updatedBy === CURATOR && x.updatedAt > startedAt && !x.archived).map((x) => x.id);
    const merged = n.notes.filter((x) => x.archivedBy === CURATOR && x.archivedAt > startedAt).map((x) => x.id);
    const asked = n.questions.filter((q) => q.askedAt > startedAt).length;
    if (result.ok && appliedIds.length) {
      for (const q of n.questions) if (appliedIds.includes(q.id)) q.appliedAt = Date.now();
      this.d.notes.save(g.id, n);
    }
    const lead = this.d.lead(g);
    const sent = lead ? this.d.notes.sendQuestions(g, lead.id) : 0;
    const changes = `${edited.length} not düzenlendi, ${merged.length} not birleştirildi${asked ? `, şefe ${asked} soru` : ''}`;
    const text = String(result.text || '').slice(0, 3000);
    this.state[g.id] = {
      lastRunAt: Date.now(),
      hash: this.hash(g.id),
      memory: result.ok ? [...memory, { at: Date.now(), level: lv, text }].slice(-memSize) : memory,
      last: { at: Date.now(), ok: result.ok, account: account.id, model: cfg.model, level: lv, costUSD: result.costUSD || 0, edited, merged, asked, sent, text, changes, ms: Date.now() - startedAt },
    };
    this.save();
    this.d.event(result.ok ? `Not düzenleyici bitti: ${changes}.` : `Not düzenleyici tamamlanamadı: ${String(result.text).slice(0, 200)}`, g.id);
    if (result.ok && (edited.length || merged.length)) {
      this.d.tell(g.id, `Not düzenleyici grup notlarını toparladı: ${changes}${merged.length ? ` (${merged.map((x) => `#${x}`).join(', ')} arşive alındı; numarası sorulursa not_oku birleşmiş nota yönlendirir)` : ''}.`);
    }
    return this.state[g.id].last;
  }

  // Grup kapanırken: notlara ve panoya bakıp tek bir "Proje durumu" metni yazar. Notlara yazmaz (yalnızca okuma tool'ları);
  // metin modelin son cevabıdır ve dışa aktarılan klasörün giriş sayfası olur.
  async handoff(g) {
    if (this.running.has(g.id)) throw Object.assign(new Error('Not düzenleyici bu grupta şu an çalışıyor; bitince tekrar dene.'), { status: 409 });
    const account = this.d.account();
    if (!account) throw Object.assign(new Error('Kotası olan hesap yok.'), { status: 409 });
    const cfg = this.cfg();
    const cards = this.d.cards(g);
    const open = cards.filter((c) => c.status !== 'done');
    const brief = [
      this.brief(g, null, 'yuksek', []).split('\nDerinlik:')[0],
      '',
      `Görev panosu (${cards.length} kart; ${open.length} açık):`,
      ...cards.map((c) => `- #${c.id} [${c.statusText}] "${c.title}" · atanan: ${c.assignee}${c.status !== 'done' && c.desc ? `\n  Açıklama: ${c.desc.replace(/\n/g, '\n  ')}` : ''}${c.lastNote ? `\n  Son not: ${c.lastNote.replace(/\n/g, '\n  ')}` : ''}`),
      g.closing ? `\nŞefin son mesajı (${fmt(g.closing.at)}):\n${g.closing.text}` : '',
      '',
      'Grup kapanıyor. Notları not_oku ile oku ve kapanış belgesini yaz.',
    ].join('\n');
    this.running.set(g.id, { at: Date.now(), level: 'devir' });
    this.d.event(`Kapanış özeti yazılıyor (${account.id} hesabı, ${cfg.model}).`, g.id);
    try {
      const t = prompts.tool('kapanis-ozeti');
      const r = await this.spawn(g, account, cfg.model, this.d.project(g), brief, {
        kind: 'kapanış özeti', turns: t.config.turns, timeoutMin: t.config.timeoutMin, system: t.system(), allowed: 'Read,Grep,Glob,mcp__panel__not_listele,mcp__panel__not_oku',
        deny: 'mcp__panel__not_duzenle,mcp__panel__not_birlestir,mcp__panel__sefe_sor',
      });
      if (!r.ok || !r.text.trim()) throw new Error(r.text || 'boş yanıt');
      return { text: r.text.trim(), costUSD: r.costUSD, account: account.id, model: cfg.model };
    } finally {
      this.running.delete(g.id);
    }
  }

  async spawn(g, account, model, project, brief, opts) {
    const r = await llm.run({
      kind: opts.kind || 'not düzenleyici', gid: g.id, account, model, system: opts.system, input: brief,
      cwd: project && fs.existsSync(project.path) ? project.path : this.d.dataDir,
      tools: 'Read,Grep,Glob', allowed: opts.allowed || 'Read,Grep,Glob,mcp__panel', deny: opts.deny || null,
      mcpConfig: this.writeMcp(g.id), maxTurns: opts.turns, env: { [TOKEN_ENV]: this.d.token },
      timeoutMs: opts.timeoutMin * 60 * 1000, timeoutMsg: `not düzenleyici ${opts.timeoutMin} dakikada bitmedi`,
    });
    return { ok: r.ok, text: r.text || String(r.res.subtype || ''), costUSD: r.costUSD };
  }
}

module.exports = { Curator, systemPrompt, curatorDefaults: defaults, curatorLevels: levelNames };
