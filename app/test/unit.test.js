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
  const { Presence } = require('../server/session/presence');
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
  const { Timeline } = require('../server/team/timeline');
  const tl = new Timeline(tmp('timeline'));
  tl.record('g', 'u', 'here', 1000);
  tl.record('g', 'u', 'away', 500);
  assert.deepStrictEqual(tl.get('g').u, [{ t: 1000, s: 'here' }, { t: 1000, s: 'away' }]);
});

test('sessions: başlatma betiği model ve effort verir', () => {
  const { buildScript } = require('../server/session/sessions');
  const s = buildScript({ name: 'x', sessionId: 'id', model: 'haiku', effort: 'low' });
  assert.match(s, /--model 'haiku' --effort 'low'/);
  assert.doesNotMatch(buildScript({ name: 'x', sessionId: 'id' }), /--effort/);
});

test('caps: skill listesi öğrenilir, türler ayrılır, kapatma skillOverrides olur', () => {
  const { Caps } = require('../server/setup/caps');
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

test('caps: depodaki skill\'ler rol klasöründeki rollerle gelir, rol değişikliği oraya yazılır, salt okunurdur', () => {
  const { Caps } = require('../server/setup/caps');
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
  assert.ok(c.load().skills.every((s) => s.builtin));
  // Rol değişikliği rol klasörlerine yazılır; caps.json'a ve depodaki dosyalara girmez. Yalnızca değişen skill yazılır.
  c.setRole('pskill:plan-skill', 'coder', true);
  c.setRole('pskill:review-skill', 'review', false);
  assert.deepStrictEqual(roles('plan-skill'), ['sef', 'coder']);
  assert.deepStrictEqual(roles('review-skill'), []);
  assert.deepStrictEqual(writes, ['plan-skill', 'review-skill']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'caps.json'), 'utf8'));
  assert.deepStrictEqual(saved.skills, []);
  assert.strictEqual(saved.builtinRoles, undefined);
  c.setRole('pskill:review-skill', 'review', true);
  assert.deepStrictEqual(assigned, { 'plan-skill': ['sef', 'coder'], 'review-skill': ['review'] });
  // Oturuma referans dosyalarıyla birlikte kopyalanır.
  const f = c.forSession('sid', 'sef', null);
  assert.ok(fs.existsSync(path.join(f.addDir, '.claude', 'skills', 'plan-skill', 'references', 'ek.md')));
  assert.ok(!fs.existsSync(path.join(f.addDir, '.claude', 'skills', 'review-skill')));
  assert.strictEqual(c.readSkill('plan-skill').builtin, true);
  assert.throws(() => c.removeSkill('plan-skill'), (e) => e.status === 403);
  assert.throws(() => c.writeRaw('plan-skill', '---\nname: plan-skill\ndescription: x\n---\n'), (e) => e.status === 403);
  assert.throws(() => c.writeSkill({ name: 'plan-skill', description: 'x', body: '' }), (e) => e.status === 409);
  assert.ok(fs.existsSync(path.join(repo, 'plan-skill', 'SKILL.md')));
  // Kullanıcı skill'i yerel katmanda kalır.
  c.writeSkill({ name: 'yerel-skill', description: 'Yerel', body: 'x' });
  assert.deepStrictEqual(c.load().skills.map((s) => [s.name, !!s.builtin]), [['plan-skill', true], ['review-skill', true], ['yerel-skill', false]]);
});

test('prompts/: her rolün ayarı ve talimatı var, depodaki skill\'ler var olan rollere atanmış', () => {
  const prompts = require('../server/core/prompts');
  const { Caps } = require('../server/setup/caps');
  const roles = prompts.roles();
  const ids = roles.map((r) => r.id);
  assert.ok(ids.length >= 14, 'rol klasörleri okunamadı');
  for (const r of roles) assert.ok(r.label && r.prompt.trim(), `${r.id}: ad ya da talimat boş`);
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
  for (const t of ['bekci', 'kurulum-danismani', 'not-duzenleyici', 'kapanis-ozeti']) assert.ok(prompts.tool(t).text().length > 100, t);
  const { systemPrompt, curatorLevels } = require('../server/team/curator');
  for (const lv of curatorLevels()) assert.ok(systemPrompt(lv).includes('Derinlik:'), lv);
});

test('optimizer: ekleme / çıkarma / effort doğrulanır', () => {
  const o = require('../server/setup/optimizer');
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
  const { Meter, newReader } = require('../server/watch/meter');
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
  const { Meter } = require('../server/watch/meter');
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
  const llm = require('../server/core/llm');
  const tok = llm.usageTok({ modelUsage: { 'claude-haiku-5-5': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 }, 'claude-sonnet-5-5': { inputTokens: 5 } } });
  assert.deepStrictEqual(tok, { haiku: { in: 1, out: 2, cw: 4, cr: 3 }, sonnet: { in: 5, out: 0, cw: 0, cr: 0 } });
  const args = llm.argsOf({ model: 'haiku', effort: 'low', system: 'S', tools: '', excludeDynamic: true });
  assert.deepStrictEqual(args.slice(0, 7), ['-p', '--model', 'haiku', '--effort', 'low', '--tools', '']);
  const { Meter } = require('../server/watch/meter');
  const m = new Meter(tmp('meter2'), tmp('proj2'));
  m.addSpend('a', tok);
  m.addSpend('a', tok);
  assert.strictEqual(m.acc.get('a').haiku.out, 4);
  const { Ledger } = require('../server/core/ledger');
  const lg = new Ledger(tmp('ledger'));
  lg.add({ kind: 'bekçi yardımcısı', account: 'a', model: 'haiku', ok: true, costUSD: 0.01, tok });
  lg.add({ kind: 'bekçi yardımcısı', account: 'a', model: 'haiku', ok: false, costUSD: 0, tok: {} });
  const v = lg.view();
  assert.strictEqual(v.day.byKind['bekçi yardımcısı'].calls, 2);
  assert.strictEqual(v.day.byKind['bekçi yardımcısı'].failed, 1);
  assert.ok(Math.abs(v.day.usd - 0.01) < 1e-9);
});

test('quota: sıfırlanma anı geçmiş pencere kullanılmamış sayılır, tahmin yeni pencerede beklemeye alınır', () => {
  const { readBuckets, forecast } = require('../server/watch/quota');
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
  const { Ops, asksUser } = require('../server/watch/ops');
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
  const { ctxLimits } = require('../server/watch/watch');
  const cfg = { ctxWarn: 250000, ctxHigh: 500000 };
  const settings = { roles: [{ id: 'coder' }], contextWindows: { haiku: 200000, sonnet: 1000000 } };
  assert.deepStrictEqual(ctxLimits({ roleId: 'coder' }, { fam: 'sonnet' }, settings, cfg), { warn: 250000, high: 500000 });
  assert.deepStrictEqual(ctxLimits({ roleId: 'coder' }, { fam: 'haiku' }, settings, cfg), { warn: 100000, high: 150000 });
  settings.roles[0].ctxWarn = 300000;
  assert.strictEqual(ctxLimits({ roleId: 'coder' }, { fam: 'sonnet' }, settings, cfg).warn, 300000);
});

test('bekleyen değişiklik: uygulama anı ve istenen / gerçekleşen farkı', () => {
  const { Pending, driftOf } = require('../server/session/pending');
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
  const { render } = require('../server/core/prompts');
  const t = '# Başlık\n{{#a}}- a: {{a}}{{/a}}\n{{^a}}- a yok{{/a}}\n\n{{#b}}\n## B\n{{b}}\n{{/b}}\n- {{bilinmeyen}}';
  assert.strictEqual(render(t, { a: 'x', b: 'satır1\n\nsatır2 {{a}}' }), '# Başlık\n- a: x\n## B\nsatır1\n\nsatır2 {{a}}\n- {{bilinmeyen}}');
  assert.strictEqual(render(t, { a: '', b: false }), '# Başlık\n- a yok\n- {{bilinmeyen}}');
});

test('prompts: roller klasörlere yazılır, silinen rol kenara alınır, elle düzenleme yeniden okunur', () => {
  const dir = tmp('prompts');
  fs.cpSync(path.join(ROOT, 'prompts'), dir, { recursive: true });
  const script = `
    const p = require('./server/core/prompts');
    const out = {};
    const list = p.roles().map((r) => ({ ...r }));
    out.n = list.length;
    const coderSkills = p.skillRoles();
    list[0].prompt = 'yeni talimat\\n\\nikinci';
    list.push({ id: 'yeni-rol', label: 'Yeni', short: 'yeni', prompt: 'x', model: 'haiku' });
    p.saveRoles(list.filter((r) => r.id !== 'dokuman'));
    out.first = p.roles()[0].prompt;
    out.last = p.roles().at(-1).id;
    out.hasDoc = p.roles().some((r) => r.id === 'dokuman');
    out.skillsKept = JSON.stringify(p.skillRoles()[Object.keys(coderSkills)[0]]) === JSON.stringify(coderSkills[Object.keys(coderSkills)[0]]);
    p.setSkillRoles('deneme-skill', ['yeni-rol']);
    out.skill = p.skillRoles()['deneme-skill'];
    require('fs').writeFileSync(require('path').join(p.PROMPTS_DIR, 'roles', 'sef', 'prompt.md'), 'elle\\r\\n');
    const t0 = Date.now(); while (Date.now() - t0 < 1100);
    out.manual = p.role('sef').prompt;
    process.stdout.write(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env: { ...process.env, CLAUDE_PANEL_PROMPTS: dir, CLAUDE_PANEL_DATA: tmp('prompts-data') }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.first, 'yeni talimat\n\nikinci');
  assert.strictEqual(o.last, 'yeni-rol');
  assert.strictEqual(o.hasDoc, false);
  assert.ok(o.skillsKept);
  assert.deepStrictEqual(o.skill, ['yeni-rol']);
  assert.strictEqual(o.manual, 'elle');
  assert.ok(fs.readdirSync(path.join(dir, 'roles')).some((d) => d.startsWith('_silinen-dokuman-')));
  // Roller settings.json'a yazılmaz.
  const data = tmp('store');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ port: 7788, roles: [{ id: 'eski' }], roleDefaultsVersion: 7 }));
  const s2 = spawnSync(process.execPath, ['-e', "const st=require('./server/core/store');const s=st.loadSettings();st.saveSettings({ ...s, roles: [1] });process.stdout.write(JSON.stringify(s))"], {
    cwd: ROOT, env: { ...process.env, CLAUDE_PANEL_DATA: data }, encoding: 'utf8',
  });
  assert.strictEqual(s2.status, 0, s2.stderr);
  assert.strictEqual(JSON.parse(s2.stdout).roles, undefined);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).roles, undefined);
});
