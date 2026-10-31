// Model çağırmayan birim testleri: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

test('presence: yalnızca Enter sonrası ve panel yapıştırması olmayan istem kullanıcı mesajıdır', () => {
  const { Presence } = require('../services/session/presence');
  const pr = new Presence(tmp('presence'));
  const p = { lastEnterAt: 0, pastes: [] };
  const info = { name: 'coder', gid: 'g', roleId: 'coder' };
  assert.strictEqual(pr.prompt('s1', 'açılış görevi', p, info, 1000), false);
  p.lastEnterAt = 2000;
  assert.strictEqual(pr.prompt('s1', 'merhaba', p, info, 2500), true);
  p.lastEnterAt = 3000;
  p.pastes.push({ t: 3100, text: 'Panodan bildirim' });
  assert.strictEqual(pr.prompt('s1', 'Panodan bildirim', p, info, 3600), false);
  p.lastEnterAt = 5000;
  assert.strictEqual(pr.prompt('s1', 'Panodan   bildirim', p, info, 5200), false);
  p.lastEnterAt = 7000;
  assert.strictEqual(pr.prompt('s1', 'x', p, info, 7000 + 31 * 60000), false);
  pr.resolve((sid) => (sid === 's1' ? { fam: 'sonnet' } : null), () => 'claude-sonnet-5-5');
  assert.strictEqual(pr.view().lastMessage.model, 'claude-sonnet-5-5');
  pr.touch('test', 10000);
  assert.deepStrictEqual(pr.status(10000 + 60000), { s: 'here', t: 10000 });
  assert.deepStrictEqual(pr.status(10000 + 11 * 60000), { s: 'away', t: 10000 });
  clearTimeout(pr.timer);
});

test('timeline: geriye tarihli kayıt önceki kaydın gerisine düşmez', () => {
  const { Timeline } = require('../services/team/timeline');
  const tl = new Timeline(tmp('timeline'));
  tl.record('g', 'u', 'here', 1000);
  tl.record('g', 'u', 'away', 500);
  assert.deepStrictEqual(tl.get('g').u, [{ t: 1000, s: 'here' }, { t: 1000, s: 'away' }]);
});

test('timeline: panelin son ayakta olduğu an sonraki açılışta okunur', () => {
  const { Timeline } = require('../services/team/timeline');
  const dir = tmp('timeline-alive');
  const tl = new Timeline(dir);
  assert.strictEqual(tl.lastAlive, null);
  tl.beat(100000);
  tl.beat(110000);
  assert.strictEqual(new Timeline(dir).lastAlive, 100000);
});

test('sessions: başlatma betiği model ve effort verir', () => {
  const { buildScript } = require('../agent');
  const s = buildScript({ name: 'x', sessionId: 'id', model: 'haiku', effort: 'low' });
  assert.match(s, /--model 'haiku' --effort 'low'/);
  assert.doesNotMatch(buildScript({ name: 'x', sessionId: 'id' }), /--effort/);
});

test('caps: skill listesi öğrenilir, türler ayrılır, kapatma skillOverrides olur', () => {
  const { Caps } = require('../services/setup/caps');
  const dir = tmp('caps');
  const c = new Caps(dir);
  const proj = tmp('proj');
  fs.mkdirSync(path.join(proj, '.claude', 'skills', 'proje-skill'), { recursive: true });
  c.projectDirs = () => [proj];
  c.learnSkills({
    names: ['dataviz', 'anthropic-skills:docs', 'proje-skill', 'baska-eklenti:x'],
    content: '- dataviz: grafik\n- anthropic-skills:docs: belge\n- proje-skill: proje\n- baska-eklenti:x: eklenti',
  });
  const inv = c.inventory([]);
  const kind = (k) => (inv.find((x) => x.key === k) || {}).kind;
  assert.strictEqual(kind('skill:dataviz'), 'bundled');
  assert.strictEqual(kind('skill:anthropic-skills:docs'), 'synced');
  assert.strictEqual(kind('skill:proje-skill'), 'project');
  assert.strictEqual(kind('skill:baska-eklenti:x'), undefined);
  assert.strictEqual(inv.find((x) => x.key === 'skill:dataviz').chars, '- dataviz: grafik'.length);
  const f = c.forSession('sid', 'coder', { on: [], off: ['skill:anthropic-skills:docs', 'skill:dataviz'] });
  assert.deepStrictEqual(f.settings.skillOverrides, { 'anthropic-skills:docs': 'off', dataviz: 'off' });
});

test('caps: depodaki skill\'ler rol klasöründeki rollerle gelir, rol değişikliği oraya yazılır', () => {
  const { Caps } = require('../services/setup/caps');
  const repo = tmp('builtin');
  const mk = (name, desc) => {
    fs.mkdirSync(path.join(repo, name, 'references'), { recursive: true });
    fs.writeFileSync(path.join(repo, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\nGövde\n`);
    fs.writeFileSync(path.join(repo, name, 'references', 'ek.md'), 'ek');
  };
  mk('plan-skill', 'Planlama');
  mk('review-skill', 'İnceleme');
  // Rol klasörlerinin yerine bellekte tutulan atama (prompts.skillRoles / setSkillRoles yerine).
  const assigned = { 'plan-skill': ['sef'], 'review-skill': ['review'] };
  const writes = [];
  const roleSkills = { map: () => structuredClone(assigned), set: (name, roles) => { writes.push(name); assigned[name] = [...roles]; } };
  const dir = tmp('caps-b');
  const c = new Caps(dir, repo, roleSkills);
  const roles = (n) => c.load().skills.find((s) => s.name === n).roles;
  assert.deepStrictEqual(roles('plan-skill'), ['sef']);
  // Rol değişikliği rol klasörlerine yazılır; caps.json'a ve depodaki dosyalara girmez. Yalnızca değişen skill yazılır.
  c.setRole('pskill:plan-skill', 'coder', true);
  c.setRole('pskill:review-skill', 'review', false);
  assert.deepStrictEqual(roles('plan-skill'), ['sef', 'coder']);
  assert.deepStrictEqual(roles('review-skill'), []);
  assert.deepStrictEqual(writes, ['plan-skill', 'review-skill']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'caps.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(saved), ['globalOff', 'seen']);
  c.setRole('pskill:review-skill', 'review', true);
  assert.deepStrictEqual(assigned, { 'plan-skill': ['sef', 'coder'], 'review-skill': ['review'] });
  // Oturuma referans dosyalarıyla birlikte kopyalanır.
  const f = c.forSession('sid', 'sef', null);
  assert.ok(fs.existsSync(path.join(f.addDir, '.claude', 'skills', 'plan-skill', 'references', 'ek.md')));
  assert.ok(!fs.existsSync(path.join(f.addDir, '.claude', 'skills', 'review-skill')));
});

test('prompts/: her rolün ayarı ve talimatı var, depodaki skill\'ler var olan rollere atanmış', () => {
  const prompts = require('../services/core/prompts');
  const { Caps } = require('../services/setup/caps');
  const roles = prompts.roles();
  const ids = roles.map((r) => r.id);
  assert.ok(ids.length >= 14, 'rol klasörleri okunamadı');
  for (const r of roles) assert.ok(r.label && r.persona.trim() && r.gorevler.trim() && r.sinirlar.trim(), `${r.id}: ad, persona, görevler ya da sınırlar boş`);
  // Kullanıcı kararı (CLAUDE.md): şef opus, araştırma / doküman haiku, diğerleri sonnet; Fable yok.
  const model = Object.fromEntries(roles.map((r) => [r.id, r.model]));
  assert.strictEqual(model.sef, 'opus');
  assert.strictEqual(model.arastirma, 'haiku');
  assert.strictEqual(model.dokuman, 'haiku');
  for (const id of ['coder', 'backend', 'frontend', 'android', 'review', 'debug', 'kalite', 'ops', 'avukat', 'test', 'guvenlik']) assert.strictEqual(model[id], 'sonnet', id);
  const map = prompts.skillRoles();
  const names = new Caps(tmp('caps-r'), undefined, { map: () => ({}), set: () => {} }).builtins().map((x) => x.name);
  for (const n of Object.keys(map)) assert.ok(names.includes(n), `role.json'da bilinmeyen skill: ${n}`);
  for (const n of names) assert.ok(map[n] && map[n].length, `${n} hiçbir role atanmamış`);
  for (const id of ids) assert.ok(Object.values(map).some((rs) => rs.includes(id)), `${id} rolüne skill yok`);
  // Yardımcı model araçlarının dosyaları tam.
  // Yardımcı model araçlarının dosyaları tam: dört bölüm de dolu.
  for (const t of ['bekci', 'kurulum-danismani']) {
    for (const f of ['persona.md', 'gorevler.md', 'sinirlar.md', 'cikti.md']) assert.ok(prompts.tool(t).text(f).trim().length > 20, `${t}/${f}`);
    assert.match(prompts.tool(t).system(), /^## Persona\n[\s\S]+\n## Görevler\n[\s\S]+\n## Sınırlar\n[\s\S]+\n## Çıktı\n/, t);
  }
  // Koddaki her bildirim adının messages/ altında dosyası var.
  const used = new Set();
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) for (const m of fs.readFileSync(p, 'utf8').matchAll(/\bmessage\('([a-z0-9-]+)'/g)) used.add(m[1]);
  });
  walk(path.join(ROOT, 'services'));
  assert.ok(used.size >= 12, `bildirim adları bulunamadı: ${[...used]}`);
  for (const n of used) assert.doesNotThrow(() => prompts.message(n, {}), n);
});

test('optimizer: ekleme / çıkarma / effort doğrulanır', () => {
  const o = require('../services/setup/optimizer');
  const rows = [
    { key: 'r1', roleId: 'sef', model: 'opus', effort: '', reportsTo: [], talkAll: true },
    { key: 'r2', roleId: 'coder', model: 'sonnet', effort: '', reportsTo: ['r1', 'r3'] },
    { key: 'r3', roleId: 'review', model: '', effort: '', reportsTo: ['r1'] },
  ];
  const parsed = {
    satirlar: [{ key: 'r2', effort: 'medium', rapor_verir: ['r1', 'yeni_1'] }, { key: 'r1', effort: 'kocaman' }],
    cikar: [{ key: 'r1' }, { key: 'r3', neden: 'gereksiz' }],
    yeni_satirlar: [
      { key: 'yeni_1', rol: 'test', effort: 'low', yetenek_kapat: ['skill:dataviz', 'skill:yok'] },
      { key: 'yeni_2', rol: 'yok' }, { key: 'kotu', rol: 'test' }, { key: 'yeni_3', rol: 'sef' },
    ],
  };
  const out = o.validate(rows, parsed, ['skill:dataviz'], ['sef', 'coder', 'review', 'test']);
  assert.deepStrictEqual(out.removes.map((x) => x.key), ['r3']);
  assert.deepStrictEqual(out.adds.map((x) => [x.key, x.roleId, x.effort, x.capsOff]), [['yeni_1', 'test', 'low', ['skill:dataviz']]]);
  assert.strictEqual(out.patches.r2.effort, 'medium');
  assert.deepStrictEqual(out.patches.r2.reportsTo, ['r1', 'yeni_1']);
  assert.strictEqual(out.patches.r1, undefined);
});

test('meter: skill listesi yakalanır, mesajdan sonraki ilk tur bulunur', () => {
  const { Meter, newReader } = require('../services/watch/meter');
  const dir = tmp('meter');
  const f = path.join(dir, 's.jsonl');
  const lines = [
    { type: 'attachment', attachment: { type: 'skill_listing', names: ['a'], content: '- a: x' } },
    { type: 'assistant', timestamp: new Date(5000).toISOString(), message: { id: 'm1', model: 'claude-haiku-5-5', usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const m = new Meter(dir, dir);
  m.tick([{ id: 's', name: 's', accountId: 'a', file: f }], 6000);
  assert.strictEqual(m.takeSkillListings().length, 1);
  assert.strictEqual(m.takeSkillListings().length, 0);
  assert.strictEqual(m.turnAfter('s', 1000).fam, 'haiku');
  assert.strictEqual(m.turnAfter('s', 9000), null);
  assert.ok(newReader);
});

test('meter: uzun sessizlikten sonraki otomatik compact boşta compact sayılır', () => {
  const { Meter } = require('../services/watch/meter');
  const dir = tmp('meter3');
  const f = path.join(dir, 's.jsonl');
  const turn = (t, id) => ({ type: 'assistant', timestamp: new Date(t).toISOString(), message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 1 } } });
  const compact = (t, trigger) => ({ type: 'system', subtype: 'compact_boundary', timestamp: new Date(t).toISOString(), compactMetadata: { trigger, preTokens: 300000, postTokens: 20000 } });
  const lines = [turn(0, 'a'), compact(60000, 'manual'), turn(120000, 'b'), compact(120000 + 50 * 60000, 'auto'), turn(120000 + 51 * 60000, 'c'), compact(120000 + 52 * 60000, 'auto')];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const m = new Meter(dir, dir);
  m.tick([{ id: 's', name: 's', accountId: 'a', file: f }], 200 * 60000);
  const info = m.sessionInfo('s', 200 * 60000);
  assert.strictEqual(info.compacts, 2);
  assert.strictEqual(info.idleCompacts, 1);
});

test('llm + defter: modelUsage aile token\'ına çevrilir, meter hesabına eklenir', () => {
  const llm = require('../services/core/llm');
  const tok = llm.usageTok({ modelUsage: { 'claude-haiku-5-5': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 }, 'claude-sonnet-5-5': { inputTokens: 5 } } });
  assert.deepStrictEqual(tok, { haiku: { in: 1, out: 2, cw: 4, cr: 3 }, sonnet: { in: 5, out: 0, cw: 0, cr: 0 } });
  const args = llm.argsOf({ model: 'haiku', effort: 'low', system: 'S', tools: '', excludeDynamic: true });
  assert.deepStrictEqual(args.slice(0, 7), ['-p', '--model', 'haiku', '--effort', 'low', '--tools', '']);
  const { Meter } = require('../services/watch/meter');
  const m = new Meter(tmp('meter2'), tmp('proj2'));
  m.addSpend('a', tok);
  m.addSpend('a', tok);
  assert.strictEqual(m.acc.get('a').haiku.out, 4);
  const { Ledger } = require('../services/core/ledger');
  const lg = new Ledger(tmp('ledger'));
  lg.add({ kind: 'bekçi yardımcısı', account: 'a', model: 'haiku', ok: true, costUSD: 0.01, tok });
  lg.add({ kind: 'bekçi yardımcısı', account: 'a', model: 'haiku', ok: false, costUSD: 0, tok: {} });
  const v = lg.view();
  assert.strictEqual(v.day.byKind['bekçi yardımcısı'].calls, 2);
  assert.strictEqual(v.day.byKind['bekçi yardımcısı'].failed, 1);
  assert.ok(Math.abs(v.day.usd - 0.01) < 1e-9);
});

test('quota: sıfırlanma anı geçmiş pencere kullanılmamış sayılır, tahmin yeni pencerede beklemeye alınır', () => {
  const { readBuckets, forecast } = require('../agent/quota');
  const now = Date.parse('2026-10-21T10:00:00Z');
  const b = readBuckets({ limits: [
    { kind: 'session', percent: 100, resets_at: '2026-10-21T09:00:00Z' },
    { kind: 'weekly_all', percent: 61, resets_at: '2026-10-25T01:00:00Z' },
  ] }, now);
  assert.deepStrictEqual(b.five, { used: 0, resetsAt: null, severity: null });
  assert.strictEqual(b.week.used, 61);
  assert.strictEqual(forecast('five', b.five, null, now), null);
  // 5 saatlik pencere 10 dk önce başladıysa tahmin yapılmaz.
  const fresh = { used: 10, resetsAt: new Date(now + 4.8 * 3600000).toISOString() };
  assert.strictEqual(forecast('five', fresh, null, now).basis, 'pencere yeni');
  // Son 10 dakikada %10 → %40 kalan 40 dk'da biter, sıfırlanmadan önce.
  const mid = { used: 60, resetsAt: new Date(now + 2 * 3600000).toISOString() };
  const prev = { ts: now - 10 * 60000, five: { used: 50, resetsAt: mid.resetsAt } };
  const f = forecast('five', mid, prev, now);
  assert.strictEqual(f.basis, 'son dönem');
  assert.strictEqual(f.beforeReset, true);
  assert.strictEqual(Math.round((f.eta - now) / 60000), 40);
});

test('bekçi: cevap bekleyen üyeye hamle yapılmaz, kullanıcı zorlarsa yapılır', () => {
  const { Ops, asksUser } = require('../services/watch/ops');
  assert.strictEqual(asksUser('Testleri yazdım.\nDevam edeyim mi?'), true);
  assert.strictEqual(asksUser('Bitti. Değişen dosyalar: a.js'), false);
  assert.strictEqual(asksUser('```js\nif (a?.b) {}\n```\nTamamlandı.'), false);
  const logs = [];
  const ops = new Ops({ lastText: () => 'Hangisini seçeyim? A mı B mi?', log: (e) => logs.push(e), member: () => ({ session: { name: 'coder' } }) });
  ops.ops.set('s', { gid: 'g' });
  assert.strictEqual(ops.waitsAnswer('s'), true);
  assert.strictEqual(ops.waitsAnswer('s'), true);
  assert.strictEqual(logs.length, 1, 'bekleme bir kez kayda geçer');
  ops.ops.set('s', { gid: 'g', force: true });
  assert.strictEqual(ops.waitsAnswer('s'), false);
});

test('bekçi: bağlam eşikleri rol profili ve pencereyle sınırlanır', () => {
  const { ctxLimits } = require('../services/watch/watch');
  const cfg = { ctxWarn: 250000, ctxHigh: 500000 };
  const settings = { roles: [{ id: 'coder' }], contextWindows: { haiku: 200000, sonnet: 1000000 } };
  assert.deepStrictEqual(ctxLimits({ roleId: 'coder' }, { fam: 'sonnet' }, settings, cfg), { warn: 250000, high: 500000 });
  assert.deepStrictEqual(ctxLimits({ roleId: 'coder' }, { fam: 'haiku' }, settings, cfg), { warn: 100000, high: 150000 });
  settings.roles[0].ctxWarn = 300000;
  assert.strictEqual(ctxLimits({ roleId: 'coder' }, { fam: 'sonnet' }, settings, cfg).warn, 300000);
});

test('bekleyen değişiklik: uygulama anı ve istenen / gerçekleşen farkı', () => {
  const { Pending, driftOf } = require('../services/session/pending');
  const p = new Pending(tmp('pending'));
  const e = p.add('s', 'g', { effort: 'medium' });
  assert.strictEqual(p.ready(e, { cacheWarm: true }, false), false, 'boşta değilken beklenir');
  assert.strictEqual(p.ready(e, { cacheWarm: true }, true), true, 'effort önbelleği korur, boşta uygulanır');
  const m = p.add('s', 'g', { model: 'sonnet' });
  assert.deepStrictEqual([m.model, m.effort], ['sonnet', 'medium'], 'değişiklikler birleşir');
  assert.strictEqual(p.ready(m, { cacheWarm: true }, true), false, 'model değişimi önbellek soğuyana kadar bekler');
  assert.strictEqual(p.ready(m, { cacheWarm: false }, true), true);
  assert.strictEqual(p.ready(p.add('s', 'g', {}, 'user', true), { cacheWarm: true }, false), true, 'şimdi uygula beklemez');
  assert.strictEqual(new Pending(p.file.replace(/pending\.json$/, '')).get('s').model, 'sonnet', 'diske yazılır');
  const want = { at: 100000, model: 'haiku', effort: 'low', skillsOff: ['dataviz', 'anthropic-skills:docs'] };
  assert.deepStrictEqual(driftOf(want, { fam: 'haiku', effort: 'low', skills: { ts: 101000, names: ['remember:doctor'] } }), []);
  const d = driftOf(want, { fam: 'sonnet', effort: 'high', skills: { ts: 101000, names: ['dataviz'] } });
  assert.strictEqual(d.length, 3);
  // Açılıştan önce yazılmış (devam ettirilen oturumdaki eski) liste karşılaştırılmaz.
  assert.deepStrictEqual(driftOf(want, { fam: 'haiku', skills: { ts: 0, names: ['dataviz'] } }), []);
});

test('prompts: şablon blokları, boş satırlar ve değer içeriği', () => {
  const { render } = require('../services/core/prompts');
  const t = '# Başlık\n{{#a}}- a: {{a}}{{/a}}\n{{^a}}- a yok{{/a}}\n\n{{#b}}\n## B\n{{b}}\n{{/b}}\n- {{bilinmeyen}}';
  assert.strictEqual(render(t, { a: 'x', b: 'satır1\n\nsatır2 {{a}}' }), '# Başlık\n- a: x\n## B\nsatır1\n\nsatır2 {{a}}\n- {{bilinmeyen}}');
  assert.strictEqual(render(t, { a: '', b: false }), '# Başlık\n- a yok\n- {{bilinmeyen}}');
});

test('prompts: roller klasörlere yazılır, silinen rol kenara alınır, elle düzenleme yeniden okunur', () => {
  const dir = tmp('prompts');
  fs.cpSync(path.join(ROOT, 'prompts'), dir, { recursive: true });
  const script = `
    const p = require('./services/core/prompts');
    const out = {};
    const list = p.roles().map((r) => ({ ...r }));
    out.n = list.length;
    const coderSkills = p.skillRoles();
    list[0].gorevler = 'yeni talimat\\n\\nikinci';
    list.push({ id: 'yeni-rol', label: 'Yeni', short: 'yeni', gorevler: 'x', readOnly: true, model: 'haiku' });
    list.push({ id: 'izinli', label: 'İzinli', gorevler: 'x', readOnly: false, allow: ['Bash(npm test:*)'], deny: ['WebFetch', 'Edit'] });
    p.saveRoles(list.filter((r) => r.id !== 'dokuman'));
    out.first = p.roles()[0].gorevler;
    out.last = p.roles().at(-2).id;
    out.permAllow = JSON.parse(require('fs').readFileSync(require('path').join(p.PROMPTS_DIR, 'roles', 'izinli', 'permissions.json'), 'utf8'));
    out.hasDoc = p.roles().some((r) => r.id === 'dokuman');
    out.skillsKept = JSON.stringify(p.skillRoles()[Object.keys(coderSkills)[0]]) === JSON.stringify(coderSkills[Object.keys(coderSkills)[0]]);
    p.setSkillRoles('deneme-skill', ['yeni-rol']);
    out.skill = p.skillRoles()['deneme-skill'];
    require('fs').writeFileSync(require('path').join(p.PROMPTS_DIR, 'roles', 'sef', 'persona.md'), 'elle\\r\\n');
    const t0 = Date.now(); while (Date.now() - t0 < 1100);
    out.manual = p.role('sef').persona;
    out.perm = JSON.parse(require('fs').readFileSync(require('path').join(p.PROMPTS_DIR, 'roles', 'yeni-rol', 'permissions.json'), 'utf8'));
    out.newRole = p.role('yeni-rol');
    out.review = p.role('review');
    // Üye istemi: persona / görevler / sınırlar bölümleri; şefe üyenin yalnızca görevleri gider.
    const { buildPrompt } = require('./services/panel/prompt');
    const mk = (id, roleId, extra) => ({ id, name: id, roleId, roleLabel: roleId, accountId: 'x', reportsTo: [], ...extra });
    const g = { name: 'G', permissionMode: 'manual', sessions: [mk('a', 'sef'), mk('b', 'review'), mk('c', 'coder', { rolePrompt: 'ekibe özel görev' })] };
    out.lead = buildPrompt(g, g.sessions[0], { path: 'C:/p' }, []);
    out.member = buildPrompt(g, g.sessions[1], { path: 'C:/p' }, []);
    out.custom = buildPrompt(g, g.sessions[2], { path: 'C:/p' }, []);
    const { quietOf } = require('./services/panel/prompt');
    out.quiet = [quietOf(g, g.sessions[0]), quietOf(g, g.sessions[1]), quietOf(g, { ...g.sessions[1], roleId: 'custom' }), quietOf({ sessions: [g.sessions[1]] }, g.sessions[1]), quietOf(g, mk('d', 'yeni-rol'))];
    out.solo = buildPrompt({ ...g, sessions: [g.sessions[1]] }, g.sessions[1], { path: 'C:/p' }, []);
    process.stdout.write(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env: { ...process.env, MAESTRO_PROMPTS: dir, MAESTRO_DATA: tmp('prompts-data') }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.first, 'yeni talimat\n\nikinci');
  assert.strictEqual(o.last, 'yeni-rol');
  assert.strictEqual(o.hasDoc, false);
  assert.ok(o.skillsKept);
  assert.deepStrictEqual(o.skill, ['yeni-rol']);
  assert.strictEqual(o.manual, 'elle');
  // "Salt okunur" permissions.json deny'ına yazılır; review'da bu araçlar kapalı.
  assert.deepStrictEqual(o.perm, { mode: '', allow: [], deny: ['Edit', 'Write', 'NotebookEdit'] });
  assert.strictEqual(o.newRole.readOnly, true);
  // Ekrandan gelen allow / deny yazılır; salt okunur araçlarını yalnızca "readOnly" belirler.
  assert.deepStrictEqual(o.permAllow, { mode: '', allow: ['Bash(npm test:*)'], deny: ['WebFetch'] });
  assert.ok(o.review.readOnly && o.review.deny.includes('Write'));
  // Sessiz: şef dışı rollerde açık; kayıtta gelmediyse korunur. Şefli grupta üye şefe sorar, şef bunu bilir; şefsiz grupta etkisiz.
  assert.strictEqual(o.review.sessiz, true);
  assert.deepStrictEqual(o.quiet, [false, true, true, false, false]);
  assert.ok(o.member.includes('AskUserQuestion kapalı') && !o.lead.includes('AskUserQuestion kapalı') && !o.solo.includes('AskUserQuestion kapalı'));
  assert.ok(o.lead.includes('soruları sana gelir'));
  const sections = (t) => (t.match(/^## .+$/gm) || []);
  for (const h of ['## Persona', '## Görevler', '## Sınırlar']) assert.ok(sections(o.member).includes(h), `üye isteminde ${h} yok`);
  assert.ok(o.member.includes(o.review.persona.split('\n')[0]) && o.member.includes(o.review.sinirlar.split('\n')[0]));
  // Şefin "Ekip üyelerinin görevleri" bölümünde review'ın görevleri var, personası / sınırları yok.
  const tasks = o.lead.split('## Ekip üyelerinin görevleri')[1].split('\n## ')[0];
  assert.ok(tasks.includes(o.review.gorevler.split('\n')[0]));
  assert.ok(!tasks.includes(o.review.persona.split('\n')[0]) && !tasks.includes(o.review.sinirlar.split('\n')[0]));
  assert.ok(tasks.includes('ekibe özel görev'));
  // Ekibe özel talimat yalnızca görevlerin yerine geçer.
  assert.ok(o.custom.includes('## Görevler\nekibe özel görev') && sections(o.custom).includes('## Persona'));
  assert.ok(fs.readdirSync(path.join(dir, 'roles')).some((d) => d.startsWith('_silinen-dokuman-')));
  // Roller settings.json'a yazılmaz.
  const data = tmp('store');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ port: 7788, roles: [{ id: 'eski' }], roleDefaultsVersion: 7 }));
  const s2 = spawnSync(process.execPath, ['-e', "const st=require('./services/core/store');const s=st.loadSettings();st.saveSettings({ ...s, roles: [1] });process.stdout.write(JSON.stringify(s))"], {
    cwd: ROOT, env: { ...process.env, MAESTRO_DATA: data }, encoding: 'utf8',
  });
  assert.strictEqual(s2.status, 0, s2.stderr);
  assert.strictEqual(JSON.parse(s2.stdout).roles, undefined);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).roles, undefined);
});

test('rol danışmanı: skill / MCP çağrıları sayılır, yetenek anahtarına eşlenir, rol başına toplanır', () => {
  const usage = require('../services/core/usage');
  const { capUsage, capKeyOf } = require('../services/setup/roleadvisor');
  const st = usage.emptyState();
  const tu = (id, name, input) => ({ type: 'assistant', timestamp: '2026-10-26T10:00:00Z', message: { id, model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id, name, input }] } });
  usage.applyObj(st, tu('a', 'Skill', { skill: 'tdd' }));
  usage.applyObj(st, tu('a', 'Skill', { skill: 'tdd' })); // aynı satır iki kez yazılırsa bir kez sayılır
  usage.applyObj(st, tu('b', 'Skill', { skill: 'context7:docs' }));
  usage.applyObj(st, tu('c', 'mcp__ljr__rank', {}));
  usage.applyObj(st, tu('d', 'mcp__plugin_context7_context7__query-docs', {}));
  usage.applyObj(st, tu('e', 'mcp__panel__pano_listele', {}));
  usage.applyObj(st, { type: 'user', message: { content: '<command-name>/review</command-name>\n<command-args></command-args>' } });
  assert.deepStrictEqual(st.skillCalls, { tdd: 1,'context7:docs': 1, review: 1 });
  assert.deepStrictEqual(st.mcpCalls, { ljr: 1, plugin_context7_context7: 1, panel: 1 });
  const catalog = [
    { key: 'pskill:tdd', ad: 'tdd' }, { key: 'skill:review', ad: 'review' }, { key: 'plugin:context7@x', ad: 'context7' },
    { key: 'mcp:ljr', ad: 'ljr' },
  ];
  assert.strictEqual(capKeyOf(catalog, 'skill', 'context7:docs'), 'plugin:context7@x');
  assert.strictEqual(capKeyOf(catalog, 'mcp', 'plugin_context7_context7'), 'plugin:context7@x');
  assert.strictEqual(capKeyOf(catalog, 'skill', 'yok'), null);
  const stats = { s1: { lastAt: 1, skillCalls: st.skillCalls, mcpCalls: st.mcpCalls }, s2: { lastAt: 1, skillCalls: { tdd: 3 }, mcpCalls: {} }, s3: null };
  const groups = [{ sessions: [{ id: 's1', roleId: 'coder' }, { id: 's2', roleId: 'coder' }, { id: 's3', roleId: 'coder' }, { id: 's4', roleId: 'review' }] }];
  const u = capUsage('coder', groups, (sid) => stats[sid], catalog);
  assert.strictEqual(u.oturum, 2);
  assert.deepStrictEqual(u.keys['pskill:tdd'], { cagri: 4, oturum: 2 });
  // Eklentinin skill'i ve MCP'si aynı anahtarda toplanır; panelin kendi MCP'si sayılmaz.
  assert.deepStrictEqual(u.keys['plugin:context7@x'], { cagri: 2, oturum: 1 });
  assert.deepStrictEqual(Object.keys(u.keys).sort(), ['mcp:ljr', 'plugin:context7@x', 'pskill:tdd', 'skill:review']);
});

test('rol danışmanı: öneriler küçük değişiklik kuralıyla doğrulanır, izin gevşetilmez', () => {
  const { validateProposals, validateQuestions, usage } = require('../services/setup/roleadvisor');
  const role = {
    persona: 'Kıdemli bir gözden geçiricisin.', gorevler: 'Diff\'i oku.\n- Bulguları yaz.\n- Testleri çalıştır.', sinirlar: '- Dosya değiştirmezsin.',
    model: 'sonnet', effort: 'high', permissionMode: '', readOnly: true, allow: [], deny: ['Edit', 'Write', 'NotebookEdit'], ctxWarn: null, ctxHigh: null,
  };
  const r = validateProposals(role, { degisiklikler: [
    { alan: 'gorevler', eski: '- Bulguları yaz.', yeni: '- Bulguları önem sırasıyla yaz.', neden: 'cevap' },
    { alan: 'gorevler', eski: 'metinde olmayan', yeni: 'x' },
    { alan: 'gorevler', eski: '- Testleri çalıştır.', yeni: '- Testleri çalıştır.' },
    { alan: 'persona', eski: '', yeni: 'x'.repeat(2000) },
    { alan: 'sinirlar', eski: '', yeni: '- Kanıtsız bulgu yazmazsın.' },
    { alan: 'model', deger: 'opus' }, { alan: 'model', deger: 'fable' }, { alan: 'effort', deger: 'high' },
    { alan: 'izin_modu', deger: 'plan' }, { alan: 'salt_okunur', deger: false }, { alan: 'salt_okunur', deger: true },
    { alan: 'deny_ekle', deger: 'Bash(git push:*)' }, { alan: 'allow_ekle', deger: 'rm -rf; echo' },
    { alan: 'yetenek_ac', deger: 'pskill:a' }, { alan: 'yetenek_ac', deger: 'pskill:yok' }, { alan: 'yetenek_kapat', deger: 'pskill:b' },
    { alan: 'baglam_esigi', deger: 5 },
  ] }, ['pskill:a', 'pskill:b'], ['pskill:b']);
  const got = r.changes.map((c) => `${c.kind}:${c.field}:${c.kind === 'text' ? c.new.slice(0, 12) : c.value}${c.kind === 'cap' ? `:${c.on}` : ''}`);
  assert.deepStrictEqual(got, ['text:gorevler:- Bulguları ', 'text:sinirlar:- Kanıtsız b', 'set:model:opus', 'rule:deny:Bash(git push:*)', 'cap:cap:pskill:a:true', 'cap:cap:pskill:b:false']);
  // Metinde bir kez geçmeyen, değişiklik getirmeyen, sınırı aşan ve izin gevşeten öneriler atılır.
  assert.ok(r.rejected.length >= 8);
  const q = validateQuestions({ sorular: [{ soru: 'A?', secenekler: ['x', 'x', 'y'] }, { soru: '' }, ...Array.from({ length: 9 }, (_, i) => ({ soru: `S${i}?` }))] });
  assert.strictEqual(q.questions.length, 6);
  assert.deepStrictEqual(q.questions[0], { id: 's1', soru: 'A?', neden: '', secenekler: ['x', 'y'], coklu: false });
  // Kullanım: yalnızca bu rolün kaydı olan oturumları, en yeni önce.
  const groups = [{ id: 'g', projectId: 'p', name: 'G', sessions: [{ id: 'a', name: 'n-a', roleId: 'review', model: 'sonnet' }, { id: 'b', name: 'n-b', roleId: 'coder' }, { id: 'c', name: 'n-c', roleId: 'review' }] }];
  const st = { a: { lastAt: 2e12, firstAt: 2e12 - 3600000, costUSD: 1.234, prompts: 4, model: 'claude-sonnet-5-5' }, c: null };
  const u = usage('review', groups, [{ id: 'p', name: 'P' }], (sid) => st[sid] || null, [{ gid: 'g', source: 'bekci', text: 'n-a: compact yapıldı' }], 10);
  assert.strictEqual(u.oturum_sayisi, 1);
  assert.strictEqual(u.oturumlar[0].maliyet_usd, 1.23);
  assert.strictEqual(u.oturumlar[0].bekci_hamleleri, 1);
  assert.strictEqual(u.model_basina['sonnet-5-5'].oturum, 1);
});

test('mesaj geliştirici: yanıt doğrulanır, boş metin reddedilir, aynı metin değişmedi sayılır', () => {
  const { validate } = require('../services/setup/promptdev');
  const ok = validate({ metin: ' Yeni mesaj\r\nikinci satır ', degisti: true, gerekceler: ['a', '', 'b', 3] }, 'ham');
  assert.deepStrictEqual(ok, { text: 'Yeni mesaj\nikinci satır', changed: true, reasons: ['a', 'b'] });
  assert.strictEqual(validate({ metin: 'ham', degisti: true, gerekceler: [] }, ' ham ').changed, false);
  assert.strictEqual(validate({ metin: 'x', degisti: false }, 'ham').changed, false);
  assert.throws(() => validate({ metin: '  ' }, 'ham'), /boş/);
  assert.throws(() => validate(null, 'ham'));
  assert.ok(require('../services/core/prompts').tool('prompt-gelistirici').system().includes('## Çıktı'));
});

test('mesaj geliştirici: kart modunda başlık zorunlu, kart istemi göreve eklenir', () => {
  const { validate } = require('../services/setup/promptdev');
  assert.deepStrictEqual(validate({ baslik: ' Başlık ', metin: 'Açıklama', gerekceler: [] }, 'ham', true), { title: 'Başlık', text: 'Açıklama', changed: true, reasons: [] });
  assert.throws(() => validate({ metin: 'Açıklama' }, 'ham', true), /başlığı/);
  assert.ok(require('../services/core/prompts').tool('prompt-gelistirici').text('kart.md').includes('baslik'));
});

test('Meter saatlik geçmiş: üye başına birim sırası, kota serisi, kalıcılık ve 7 gün sınırı', () => {
  const { Meter } = require('../services/watch/meter');
  const dir = tmp('meterhist');
  const HOUR = 3600 * 1000;
  const t0 = 1000 * HOUR;
  const m = new Meter(dir, dir);
  m.addUsage({ id: 'a', name: 'küçük', accountId: 'x' }, { sonnet: { in: 1000, out: 1000, cw: 0, cr: 0 } }, t0);
  m.addUsage({ id: 'b', name: 'büyük', accountId: 'x' }, { sonnet: { in: 1000, out: 100000, cw: 0, cr: 0 } }, t0 + 60000);
  m.addUsage({ id: 'b', name: 'büyük', accountId: 'x' }, { sonnet: { in: 0, out: 1000, cw: 0, cr: 0 } }, t0 + 2 * HOUR);
  m.addSeries({ accountId: 'x', five: { used: 10 }, week: { used: 20 } }, t0);
  m.addSeries({ accountId: 'x', five: { used: 12 }, week: { used: 21 } }, t0 + 1000);
  const h = m.history(24, t0 + 3 * HOUR);
  assert.deepStrictEqual(h.members.map((e) => e.sid), ['b', 'a']);
  assert.strictEqual(h.series.length, 1);
  assert.strictEqual(h.series[0].five, 12);
  assert.deepStrictEqual(m.history(1, t0 + 3 * HOUR).members.map((e) => e.sid), ['b']);
  m.save();
  const again = new Meter(dir, dir);
  assert.strictEqual(again.history(24, t0 + 3 * HOUR).members.length, 2);
  again.pruneHistory(t0 + 8 * 24 * HOUR);
  assert.strictEqual(again.usage.length, 0);
});

test('Meter saatlik geçmiş: kısmi ilk saat oransal sayılır, kota olmadan da yazılır ve kapanışta zorla yazılır', () => {
  const { Meter } = require('../services/watch/meter');
  const dir = tmp('meterhist2');
  const HOUR = 3600 * 1000;
  const t0 = 1000 * HOUR;
  const m = new Meter(dir, dir);
  m.addUsage({ id: 'a', name: 'a', accountId: 'x' }, { sonnet: { in: 0, out: 100000, cw: 0, cr: 0 } }, t0);
  // Pencere saatin ortasında başlar: o saatin yarısı sayılır.
  const half = m.history(1, t0 + HOUR + HOUR / 2).members[0];
  assert.strictEqual(Math.round(half.tokens), 50000);
  m.persistHistory(t0 + 60000);
  assert.ok(fs.existsSync(path.join(dir, 'meter.json')));
  fs.unlinkSync(path.join(dir, 'meter.json'));
  m.addUsage({ id: 'a', name: 'a', accountId: 'x' }, { sonnet: { in: 1, out: 1, cw: 0, cr: 0 } }, t0 + 120000);
  m.persistHistory(t0 + 120000);
  assert.ok(!fs.existsSync(path.join(dir, 'meter.json')));
  m.persistHistory(t0 + 120000, true);
  assert.ok(fs.existsSync(path.join(dir, 'meter.json')));
});

test('ayrım: services/ ajana yalnızca agent/index.js üzerinden erişir, agent/ services/e hiç bağlanmaz', () => {
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  };
  const reqs = (f) => [...fs.readFileSync(f, 'utf8').matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).filter((r) => r.startsWith('.'));
  for (const f of walk(path.join(ROOT, 'services'))) {
    for (const r of reqs(f)) {
      const target = path.resolve(path.dirname(f), r);
      if (target.startsWith(path.join(ROOT, 'agent') + path.sep)) assert.fail(`${path.relative(ROOT, f)} agent/ içine doğrudan bağlanıyor: ${r}`);
    }
  }
  for (const f of walk(path.join(ROOT, 'agent'))) {
    for (const r of reqs(f)) {
      const target = path.resolve(path.dirname(f), r);
      if (target.startsWith(path.join(ROOT, 'services'))) assert.fail(`${path.relative(ROOT, f)} services/ içine bağlanıyor: ${r}`);
    }
  }
});

test('ajan: oturumlara verilen hook anahtarı değişkeni services ile aynı ad', () => {
  assert.equal(require('../agent/host').HOOK_TOKEN_ENV, require('../services/session/hooks').TOKEN_ENV);
});

test('web/serve: arayüz dosyaları sunulur, web/ dışına ve serve.js\'e çıkılamaz', () => {
  const { resolve } = require('../web/serve');
  for (const p of ['/', '/index.html', '/js/core.js', '/style.css', '/vendor/xterm.js', '/vendor/xterm.css', '/vendor/addon-fit.js']) {
    const f = resolve(p);
    assert.ok(f && fs.existsSync(f), p);
  }
  for (const p of ['/serve.js', '/../package.json', '/..%2Fpackage.json', '/js/../../package.json', '/js', '/nope.exe']) assert.equal(resolve(p), null, p);
});
