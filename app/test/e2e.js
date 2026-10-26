// Uçtan uca testler: 7799'da ayrı veri klasörüyle panel açar, gerçek Claude oturumları başlatır (kota harcar).
// Kullanım: node test/e2e.js [senaryo ...]   (senaryo verilmezse hepsi). Hesap: E2E_ACCOUNT (varsayılan: en çok kotası kalan hesap).
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { REPO, makeDataDir, startPanel, typeInto, transcript, until, wait } = require('./lib');

const PROJECT_PATH = REPO;
let spent = 0;

function projectId(api, state) {
  const p = state.projects.find((x) => path.resolve(x.path) === path.resolve(PROJECT_PATH));
  if (!p) throw new Error('claude-panel projesi test verisinde yok');
  return p.id;
}

async function idle(api, gid, sid, ms = 120000) {
  return until(async () => {
    const s = await api('GET', '/api/state');
    const ss = s.groups.find((g) => g.id === gid).sessions.find((x) => x.id === sid);
    return ss && ss.status === 'idle' && ss.stats && ss.stats.lastAt ? ss : null;
  }, ms);
}

const SCENARIOS = {
  // Oturum açılışı: effort, skill kapatma, salt okunur rol ve kullanıcı mesajı (presence).
  async launch({ api, token, acc, pid }) {
    const caps = await api('GET', '/api/caps');
    const off = caps.inventory.filter((x) => x.kind === 'bundled').map((x) => x.key);
    const g = await api('POST', '/api/groups', {
      // acceptEdits: salt okunur kısıtı yalnızca izinle sağlanıyorsa Write burada sorulmadan çalışırdı.
      projectId: pid, name: 'e2e-launch', permissionMode: 'acceptEdits', firstTask: 'Yalnızca "ok" yaz.',
      rows: [{ key: 'a', roleId: 'guvenlik', accountId: acc, model: 'haiku', effort: 'low', caps: { on: [], off } }],
    });
    const sid = g.sessions[0].id;
    try {
      const prompt = fs.readFileSync(g.sessions[0].promptFile, 'utf8');
      assert.match(prompt, /effort low/);
      assert.match(prompt, /terminalde en fazla tek satır/, 'şef dışı rolde terminal kuralı yok');
      const first = await idle(api, g.id, sid);
      assert.ok(first, 'ilk görev bitmedi');
      // meter 10 sn'de bir okur; istenen ayarla gerçekleşen uyumlu olmalı.
      const checked = await until(async () => {
        const s = await api('GET', '/api/meter');
        return s.sessions[sid] && s.sessions[sid].effort ? s.sessions[sid] : null;
      }, 30000);
      assert.ok(checked, 'meter oturumu okumadı');
      assert.strictEqual(checked.effort, 'low');
      const st = (await api('GET', '/api/state')).groups.find((x) => x.id === g.id).sessions[0];
      assert.deepStrictEqual(st.drift, [], `ayar uyuşmuyor: ${st.drift}`);
      const lines = transcript(sid);
      const listing = lines.find((l) => l.type === 'attachment' && l.attachment.type === 'skill_listing');
      assert.ok(listing, 'oturum kaydında skill listesi yok');
      const names = listing.attachment.names;
      const leaked = off.map((k) => k.slice(6)).filter((n) => names.includes(n));
      assert.deepStrictEqual(leaked, [], `kapatılan skill yüklendi: ${leaked}`);
      assert.ok(JSON.stringify(lines).includes('"effort":"low"'), 'effort low uygulanmadı');
      await typeInto(token, sid, 'Write aracıyla e2e-yazma-denemesi.txt dosyası oluşturmayı dene, Bash kullanma, sonucu tek satır yaz.');
      const done = await until(async () => {
        const s = await api('GET', '/api/state');
        const p = s.presence && s.presence.lastMessage;
        return p && p.sid === sid && p.fam ? p : null;
      }, 120000);
      assert.ok(done, 'kullanıcı mesajı presence\'a düşmedi');
      assert.strictEqual(done.fam, 'haiku');
      await idle(api, g.id, sid);
      assert.ok(!fs.existsSync(path.join(PROJECT_PATH, 'e2e-yazma-denemesi.txt')), 'salt okunur rol dosya yazdı');
      const wrote = transcript(sid).some((l) => l.type === 'assistant' && Array.isArray(l.message.content)
        && l.message.content.some((c) => c && c.type === 'tool_use' && ['Write', 'Edit', 'NotebookEdit'].includes(c.name)));
      assert.ok(!wrote, 'salt okunur rolde düzenleme aracı çağrıldı');
    } finally {
      await api('POST', `/api/groups/${g.id}/stop`).catch(() => {});
    }
  },

  // Depodaki skills/: rolün varsayılan skill'i oturuma yüklenir; Ayarlar'da rolden çıkarılan yüklenmez; salt okunur.
  async builtinskills({ api, acc, pid }) {
    const caps = await api('GET', '/api/caps');
    const sec = caps.skills.find((s) => s.name === 'security-and-hardening');
    assert.ok(sec && sec.builtin && sec.roles.includes('guvenlik'), 'depodaki skill varsayılan rolüyle gelmedi');
    await assert.rejects(api('DELETE', '/api/caps/skill/security-and-hardening'), (e) => e.status === 403);
    await api('PUT', '/api/caps/role', { key: 'pskill:source-driven-development', roleId: 'arastirma', on: false });
    // İlk görev gruptaki yalnızca ilk üyeye gider; her rol kendi grubunda açılır ki ikisinin de kaydı oluşsun.
    const open = (roleId) => api('POST', '/api/groups', {
      projectId: pid, name: `e2e-builtin-${roleId}`, permissionMode: 'manual', firstTask: 'Yalnızca "ok" yaz.',
      rows: [{ key: 'a', roleId, accountId: acc, model: 'haiku', effort: 'low' }],
    });
    const groups = [await open('guvenlik'), await open('arastirma')];
    const listing = (sid) => until(() => {
      const l = transcript(sid).find((x) => x.type === 'attachment' && x.attachment.type === 'skill_listing');
      return l ? l.attachment.names : null;
    }, 120000);
    try {
      const n1 = await listing(groups[0].sessions[0].id);
      const n2 = await listing(groups[1].sessions[0].id);
      assert.ok(n1 && n2, 'oturum kaydında skill listesi yok (proje klasörü bu hesapta güvenilir mi?)');
      assert.ok(n1.includes('security-and-hardening'), `güvenlik rolüne skill yüklenmedi: ${n1}`);
      assert.ok(!n1.includes('planning-and-task-breakdown'), 'başka rolün skill\'i yüklendi');
      assert.ok(!n2.includes('source-driven-development'), 'rolden çıkarılan skill yüklendi');
      return `güvenlik: ${n1.filter((n) => !n.includes(':')).length} skill listede`;
    } finally {
      for (const g of groups) await api('POST', `/api/groups/${g.id}/stop`).catch(() => {});
    }
  },

  // Panelin yapıştırdığı bildirim (not) kullanıcı mesajı sayılmaz.
  async paste({ api, acc, pid }) {
    const g = await api('POST', '/api/groups', {
      projectId: pid, name: 'e2e-paste', permissionMode: 'manual', firstTask: 'Yalnızca "ok" yaz.',
      rows: [{ key: 'a', roleId: 'arastirma', accountId: acc, model: 'haiku', effort: 'low' }],
    });
    const sid = g.sessions[0].id;
    try {
      assert.ok(await idle(api, g.id, sid), 'ilk görev bitmedi');
      const before = transcript(sid).filter((l) => l.type === 'assistant').length;
      await api('POST', `/api/groups/${g.id}/notes`, { title: 'Bilgi', body: 'Bu bir test notudur; yanıt olarak yalnızca "tamam" yaz.', to: [sid] });
      const answered = await until(() => transcript(sid).filter((l) => l.type === 'assistant').length > before, 90000);
      assert.ok(answered, 'not bildirimi iletilmedi');
      const s = await api('GET', '/api/state');
      assert.ok(!s.presence.lastMessage || s.presence.lastMessage.sid !== sid, 'panel yapıştırması kullanıcı mesajı sayıldı');
    } finally {
      await api('POST', `/api/groups/${g.id}/stop`).catch(() => {});
    }
  },

  // Bekleyen değişiklik: effort değişimi üye boşken uygulanır, model değişimi "şimdi" ile beklemeden; ikisi de kaldığı yerden.
  async settings({ api, token, acc, pid }) {
    const g = await api('POST', '/api/groups', {
      projectId: pid, name: 'e2e-settings', permissionMode: 'manual', firstTask: 'Yalnızca "ok" yaz.',
      rows: [{ key: 'a', roleId: 'arastirma', accountId: acc, model: 'haiku', effort: 'low' }],
    });
    const sid = g.sessions[0].id;
    const effortOf = () => { const a = transcript(sid).filter((l) => l.type === 'assistant' && l.effort); return a.length ? a[a.length - 1].effort : null; };
    const modelOf = () => { const a = transcript(sid).filter((l) => l.type === 'assistant' && l.message && l.message.model); return a.length ? a[a.length - 1].message.model : null; };
    try {
      assert.ok(await idle(api, g.id, sid), 'ilk görev bitmedi');
      const r = await api('POST', `/api/sessions/${sid}/settings`, { effort: 'medium' });
      assert.ok(r.pending && r.pending.effort === 'medium', 'değişiklik sıraya girmedi');
      const applied = await until(async () => {
        const s = (await api('GET', '/api/state')).groups.find((x) => x.id === g.id).sessions[0];
        return !s.pending && s.running && s.status === 'idle' ? s : null;
      }, 90000);
      assert.ok(applied, 'effort değişikliği uygulanmadı');
      await typeInto(token, sid, 'Yalnızca "iki" yaz.');
      assert.ok(await until(() => effortOf() === 'medium', 90000), `effort medium olmadı (${effortOf()})`);
      const r2 = await api('POST', `/api/sessions/${sid}/settings`, { model: 'sonnet', now: true });
      assert.ok(r2.pending && r2.pending.now);
      await until(async () => {
        const s = (await api('GET', '/api/state')).groups.find((x) => x.id === g.id).sessions[0];
        return !s.pending && s.running && s.status === 'idle' ? s : null;
      }, 90000);
      await typeInto(token, sid, 'Yalnızca "üç" yaz.');
      assert.ok(await until(() => /sonnet/.test(modelOf() || ''), 90000), `model sonnet olmadı (${modelOf()})`);
      const st = (await api('GET', '/api/state')).groups.find((x) => x.id === g.id).sessions[0];
      assert.deepStrictEqual(st.drift, [], `ayar uyuşmuyor: ${st.drift}`);
    } finally {
      await api('POST', `/api/groups/${g.id}/stop`).catch(() => {});
    }
  },

  // Şefin yetenek isteği: şef uye_yetenek_degistir ile istek gönderir, kullanıcı onaylar, üyenin ayarı değişir ve
  // oturumu boşta kalınca yeni ayar dosyasıyla açılır.
  async teamcaps({ api, acc, pid, dataDir }) {
    const g = await api('POST', '/api/groups', {
      projectId: pid, name: 'e2e-teamcaps', permissionMode: 'manual',
      firstTask: 'Panel aracı uye_yetenek_degistir ile Araştırma üyesinde "dataviz" yeteneğinin kapatılması için istek gönder (gerekce: test). Başka hiçbir şey yapma; istek gönderilince "gönderildi" yaz.',
      rows: [
        { key: 's', roleId: 'sef', accountId: acc, model: 'haiku', effort: 'low', talkAll: true },
        { key: 'a', roleId: 'arastirma', accountId: acc, model: 'haiku', effort: 'low', reportsTo: ['s'] },
      ],
    });
    const member = g.sessions.find((x) => x.roleId === 'arastirma');
    try {
      const req = await until(async () => {
        const s = (await api('GET', '/api/state')).groups.find((x) => x.id === g.id);
        return (s.requests || []).find((r) => r.kind === 'caps') || null;
      }, 150000);
      assert.ok(req, 'şef yetenek isteği göndermedi');
      await api('POST', `/api/requests/${req.id}/approve`, {});
      // /api/state oturumun caps alanını göndermez (state.js); kayıt doğrudan groups.json'dan okunur.
      const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'groups.json'), 'utf8')).find((x) => x.id === g.id).sessions.find((x) => x.id === member.id);
      assert.ok(after.caps && after.caps.off.includes('skill:dataviz'), `kayıt değişmedi: ${JSON.stringify(after.caps)}`);
      // Oturum boşta kalınca yeni ayar dosyasıyla yeniden açılır (dosya açılışta yazılır).
      const f = path.join(dataDir, 'session-settings', `${member.id}.json`);
      const read = () => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
      const cfg = await until(() => ((read().skillOverrides || {}).dataviz === 'off' ? read() : null), 120000);
      assert.ok(cfg, `ayar dosyasında dataviz kapalı değil: ${JSON.stringify(read().skillOverrides)}`);
      const back = await until(async () => {
        const s = (await api('GET', '/api/state')).groups.find((x) => x.id === g.id).sessions.find((x) => x.id === member.id);
        return !s.pending && s.running ? s : null;
      }, 60000);
      assert.ok(back, 'üye yeniden açılmadı');
      return req.text;
    } finally {
      await api('POST', `/api/groups/${g.id}/stop`).catch(() => {});
    }
  },

  // Hesap değişimi: çalışan oturum durdurulup diğer hesapta kaldığı yerden açılır; panel ayakta kalır.
  async account({ api, acc, pid, accounts }) {
    const other = accounts.find((a) => a.id !== acc);
    if (!other) return 'tek hesap; atlandı';
    const g = await api('POST', '/api/groups', {
      projectId: pid, name: 'e2e-account', permissionMode: 'manual', firstTask: 'Yalnızca "ok" yaz.',
      rows: [{ key: 'a', roleId: 'arastirma', accountId: acc, model: 'haiku', effort: 'low' }],
    });
    const sid = g.sessions[0].id;
    try {
      assert.ok(await idle(api, g.id, sid), 'ilk görev bitmedi');
      const r = await api('POST', `/api/sessions/${sid}/account`, { accountId: other.id });
      assert.strictEqual(r.restarted, true);
      const back = await until(async () => {
        const s = await api('GET', '/api/state');
        const ss = s.groups.find((x) => x.id === g.id).sessions[0];
        return ss.running && ss.accountId === other.id ? ss : null;
      }, 60000);
      assert.ok(back, 'oturum yeni hesapta açılmadı');
    } finally {
      await api('POST', `/api/groups/${g.id}/stop`).catch(() => {});
    }
  },

  // Not düzenleyici: panel MCP'si ve hook anahtarıyla çalışır; tekrar eden iki notu birleştirmesi beklenir, harcaması deftere düşer.
  async curator({ api, acc, pid }) {
    const g = await api('POST', '/api/groups', {
      projectId: pid, name: 'e2e-curator', permissionMode: 'manual',
      rows: [{ key: 'a', roleId: 'arastirma', accountId: acc, model: 'haiku', effort: 'low' }],
    });
    await api('POST', `/api/groups/${g.id}/stop`);
    await api('POST', `/api/groups/${g.id}/notes`, { title: 'Port', body: 'Panel 7788 portunda çalışır.' });
    await api('POST', `/api/groups/${g.id}/notes`, { title: 'Panel portu', body: 'Panelin portu 7788.' });
    await api('POST', `/api/groups/${g.id}/notes`, { title: 'Test portu', body: 'Test paneli 7799 portunu kullanır.' });
    await api('POST', `/api/groups/${g.id}/curator/run`, { level: 'dusuk' });
    const done = await until(async () => {
      const s = await api('GET', `/api/groups/${g.id}/curator`);
      return !s.running && s.lastRunAt ? s : null;
    }, 15 * 60 * 1000, 5000);
    assert.ok(done, 'not düzenleyici bitmedi');
    const m = await api('GET', '/api/meter');
    const e = m.ledger.recent.find((x) => x.kind === 'not düzenleyici' && x.gid === g.id);
    assert.ok(e, 'deftere kayıt düşmedi');
    assert.ok(e.ok, `not düzenleyici hata verdi: ${e.error}`);
    spent += e.costUSD || 0;
    const notes = (await api('GET', `/api/groups/${g.id}/notes`)).notes;
    const last = done.last || {};
    assert.ok(last.ok, `not düzenleyici başarısız: ${last.text}`);
    return `$${(e.costUSD || 0).toFixed(3)}, ${e.turns} tur, ${notes.filter((n) => !n.archived).length} aktif not, birleşen ${(last.merged || []).length}; ${last.changes || ''} — ${String(last.text || '').slice(0, 200)}`;
  },

  // Not düzenleyici birleştirme: üyenin yazdığı (kullanıcı notu olmayan) iki tekrar not birleştirilmeli.
  async curatormerge({ api, acc, pid }) {
    const g = await api('POST', '/api/groups', {
      projectId: pid, name: 'e2e-curatormerge', permissionMode: 'manual',
      firstTask: 'not_ekle aracıyla iki not ekle. 1) başlık "Port", içerik "Panel 7788 portunda çalışır." 2) başlık "Panel portu", içerik "Panelin portu 7788; test paneli 7799 kullanır." Başka hiçbir şey yapma, bitince "eklendi" yaz.',
      rows: [{ key: 'a', roleId: 'arastirma', accountId: acc, model: 'haiku', effort: 'low' }],
    });
    try {
      const two = await until(async () => {
        const n = (await api('GET', `/api/groups/${g.id}/notes`)).notes.filter((x) => !x.archived);
        return n.length >= 2 ? n : null;
      }, 150000);
      assert.ok(two, 'üye notları eklemedi');
      await api('POST', `/api/groups/${g.id}/stop`);
      await api('POST', `/api/groups/${g.id}/curator/run`, { level: 'orta' });
      const done = await until(async () => {
        const s = await api('GET', `/api/groups/${g.id}/curator`);
        return !s.running && s.lastRunAt ? s : null;
      }, 15 * 60 * 1000, 5000);
      assert.ok(done && done.last && done.last.ok, `not düzenleyici bitmedi: ${done && done.last && done.last.text}`);
      const notes = (await api('GET', `/api/groups/${g.id}/notes`)).notes;
      const active = notes.filter((x) => !x.archived);
      const m = await api('GET', '/api/meter');
      const e = m.ledger.recent.find((x) => x.kind === 'not düzenleyici' && x.gid === g.id);
      spent += (e && e.costUSD) || 0;
      assert.ok((done.last.merged || []).length >= 1 && active.length === 1, `birleştirme yok: ${active.length} aktif not; ${done.last.text.slice(0, 200)}`);
      const body = active[0].body;
      assert.ok(/7788/.test(body) && /7799/.test(body), `birleşen notta bilgi kaybı: ${body}`);
      return `$${((e && e.costUSD) || 0).toFixed(3)}; birleşik not: ${active[0].title} — ${body.replace(/\n/g, ' ').slice(0, 120)}`;
    } finally {
      await api('POST', `/api/groups/${g.id}/stop`).catch(() => {});
    }
  },

  // Kurulum optimizer'ı: hedefle projeyi inceler (turns > 1), effort ve rol önerileri doğrulanmış gelir.
  async optimize({ api, acc, pid }) {
    const r = await api('POST', '/api/setup/optimize', {
      projectId: pid, permissionMode: 'manual', goal: 'Bekçinin hesap taşıma kararındaki bir hatayı düzelt (server/watch.js, server/ops.js).',
      rows: [
        { key: 'r1', roleId: 'sef', accountId: acc, model: 'opus', talkAll: true, reportsTo: [] },
        { key: 'r2', roleId: 'coder', accountId: acc, model: 'sonnet', reportsTo: ['r1'] },
        { key: 'r3', roleId: 'android', accountId: acc, model: 'sonnet', reportsTo: ['r1'] },
      ],
    });
    spent += r.costUSD || 0;
    assert.ok(r.turns > 1, `proje incelenmedi (turns ${r.turns})`);
    assert.ok(Array.isArray(r.adds) && Array.isArray(r.removes));
    return `turns ${r.turns}, $${(r.costUSD || 0).toFixed(3)}, ekle ${r.adds.map((a) => a.roleId)}, çıkar ${r.removes.map((x) => x.key)}`;
  },

  // Rol danışmanı (Sonnet): sorular → her sorunun ilk seçeneğiyle cevap → doğrulanmış öneriler. Hiçbir şey yazılmaz.
  async roleopt({ api, dataDir }) {
    const before = fs.readFileSync(path.join(dataDir, 'panel-prompts', 'roles', 'review', 'gorevler.md'), 'utf8');
    const q = await api('POST', '/api/roles/review/optimize', { step: 'sorular' });
    spent += q.costUSD || 0;
    assert.ok(q.questions.length >= 1 && q.questions.length <= 6, `soru sayısı ${q.questions.length}`);
    assert.ok(q.questions.every((x) => x.soru && Array.isArray(x.secenekler)));
    const answers = q.questions.map((x) => ({ soru: x.soru, cevap: x.secenekler[0] || 'fark etmez' }));
    const o = await api('POST', '/api/roles/review/optimize', { step: 'oneriler', answers });
    spent += o.costUSD || 0;
    assert.ok(Array.isArray(o.changes) && Array.isArray(o.rejected));
    // Metin önerisinin "eski" parçası rolün metninde bir kez geçer; izin gevşetmesi gelmez.
    for (const c of o.changes) {
      if (c.kind === 'text' && c.old && c.field === 'gorevler') assert.strictEqual(before.split(c.old).length, 2, `eski parça metinde bir kez geçmiyor: ${c.old.slice(0, 60)}`);
      assert.ok(!(c.field === 'readOnly' && c.value === false));
    }
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'panel-prompts', 'roles', 'review', 'gorevler.md'), 'utf8'), before, 'danışman dosyaya yazdı');
    return `${q.questions.length} soru, ${o.changes.length} öneri (${o.rejected.length} elendi), $${((q.costUSD || 0) + (o.costUSD || 0)).toFixed(3)}`;
  },
};

(async () => {
  const want = process.argv.slice(2);
  const dataDir = makeDataDir('panel-e2e');
  const panel = await startPanel(dataDir);
  const results = [];
  try {
    const state = await panel.api('GET', '/api/state');
    const accounts = state.settings.accounts;
    // Varsayılan: en çok kotası kalan hesap (testler kullanıcının az kalan kotasını yemesin).
    let acc = process.env.E2E_ACCOUNT;
    if (!acc) {
      const q = await panel.api('GET', '/api/quota').catch(() => null);
      const left = (r) => (r.status !== 'canlı' || r.blocked ? -1 : Math.min(...[r.five, r.week].filter(Boolean).map((b) => 100 - b.used), 100));
      const best = q && q.rows.slice().sort((a, b) => left(b) - left(a))[0];
      acc = best && left(best) > 5 ? best.accountId : accounts[0].id;
    }
    results.push(`hesap: ${acc}`);
    const ctx = { api: panel.api, token: panel.token, acc, accounts, dataDir, pid: projectId(panel.api, state) };
    for (const [name, fn] of Object.entries(SCENARIOS)) {
      if (want.length && !want.includes(name)) continue;
      const t0 = Date.now();
      try {
        const note = await fn(ctx);
        results.push(`✔ ${name} (${Math.round((Date.now() - t0) / 1000)} sn)${note ? ` — ${note}` : ''}`);
      } catch (err) {
        results.push(`✖ ${name} (${Math.round((Date.now() - t0) / 1000)} sn): ${err.message}${err.cause ? ` (${err.cause.code || err.cause.message})` : ''}\n${panel.log().split('\n').slice(-8).join('\n')}`);
      }
    }
    // Model çağrı defteri: test sırasında panelin yaptığı yardımcı çağrılar.
    const m = await panel.api('GET', '/api/meter').catch(() => null);
    if (m && m.ledger) results.push(`defter: ${m.ledger.recent.length} çağrı, $${m.ledger.totalUSD.toFixed(3)}`);
  } finally {
    await panel.stop();
    await wait(300);
  }
  console.log(results.join('\n'));
  if (spent) console.log(`optimizer harcaması: $${spent.toFixed(3)}`);
  process.exitCode = results.some((r) => r.startsWith('✖')) ? 1 : 0;
})();
