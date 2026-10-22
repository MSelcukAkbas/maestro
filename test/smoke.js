// Duman testi: panelin API uç noktalarının hepsini 7799'da ayrı veri klasörüyle çağırır; hiçbiri 500 vermemeli
// ve panel ayakta kalmalı. Oturum açan çağrılar istem göndermez (model harcaması yok denecek kadar az). optimize ve
// curator/run model çağırdığı için e2e.js'te; open-pc masaüstünde pencere açtığı için yalnızca SMOKE_PC=1 ile.
// Kullanım: node test/smoke.js
const { makeDataDir, startPanel, wait, until } = require('./lib');

(async () => {
  const p = await startPanel(makeDataDir('panel-smoke'));
  const fails = [];
  let shut = false;
  let calls = 0;
  const hit = async (method, url, body, want = (s) => s < 500) => {
    calls++;
    let status;
    try {
      const r = await fetch(`http://127.0.0.1:7799${url}`, { method, headers: { 'x-panel-token': p.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      status = r.status;
      const j = await r.json().catch(() => ({}));
      if (!want(status)) fails.push(`${method} ${url} → ${status} ${j.error || ''}`);
      return j;
    } catch (err) {
      fails.push(`${method} ${url} → ${err.message}`);
      return {};
    }
  };
  try {
    const st = await hit('GET', '/api/state');
    const pid = st.projects.find((x) => x.name === 'claude-panel').id;
    const acc = st.settings.accounts[st.settings.accounts.length - 1].id;
    for (const u of ['/api/templates', '/api/meter', '/api/watch', '/api/quota', '/api/caps', '/api/caps/skill/yok-boyle-skill']) await hit('GET', u);
    await hit('POST', '/api/projects', { path: 'C:/Windows' });
    await hit('GET', `/api/projects/${pid}/docs`);
    await hit('GET', `/api/projects/${pid}/doc?path=README.md`);
    await hit('GET', `/api/projects/${pid}/docs/search?q=panel`);

    // Grup: istemsiz tek üye (oturum açılır ama model çağrılmaz), hemen durdurulur.
    const g = await hit('POST', '/api/groups', { projectId: pid, name: 'smoke', permissionMode: 'manual', rows: [{ key: 'a', roleId: 'arastirma', accountId: acc, model: 'haiku', effort: 'low' }] });
    const sid = g.sessions[0].id;
    await wait(1500);
    await hit('POST', `/api/groups/${g.id}/stop`);
    await until(async () => !(await hit('GET', '/api/state')).groups.find((x) => x.id === g.id).sessions[0].running, 15000, 500);
    await hit('GET', `/api/groups/${g.id}/activity`);
    await hit('GET', `/api/groups/${g.id}/board`);
    const card = await hit('POST', `/api/groups/${g.id}/board`, { title: 'Duman kartı', desc: 'açıklama', assignee: sid });
    const cid = card.id || (card.cards && card.cards[0] && card.cards[0].id) || 1;
    await hit('PUT', `/api/groups/${g.id}/board/${cid}`, { status: 'doing', note: 'not', version: card.version || 1 });
    await hit('DELETE', `/api/groups/${g.id}/board/${cid}`);
    await hit('POST', `/api/groups/${g.id}/notes`, { title: 'Not', body: 'gövde' });
    const notes = await hit('GET', `/api/groups/${g.id}/notes`);
    const nid = (notes.notes && notes.notes[0] && notes.notes[0].id) || 1;
    await hit('PUT', `/api/groups/${g.id}/notes/${nid}`, { title: 'Not', body: 'gövde 2', expect: 1 });
    await hit('GET', `/api/groups/${g.id}/notes/${nid}/history`);
    await hit('POST', `/api/groups/${g.id}/notes/${nid}/restore`, { index: 0 });
    await hit('POST', `/api/groups/${g.id}/notes/${nid}/unarchive`);
    await hit('DELETE', `/api/groups/${g.id}/notes/${nid}`);
    await hit('GET', `/api/groups/${g.id}/curator`);
    await hit('POST', `/api/groups/${g.id}/remind`, { text: 'hatırlatma', to: [sid] });
    await hit('PUT', `/api/groups/${g.id}/watch`, { act: false });
    await hit('POST', `/api/groups/${g.id}/ask-summary`);
    await hit('GET', `/api/groups/${g.id}/close`);
    await hit('POST', `/api/sessions/${sid}/settings`, { effort: 'medium' });
    await hit('DELETE', `/api/sessions/${sid}/settings`);
    await hit('POST', `/api/sessions/${sid}/account`, { accountId: st.settings.accounts[0].id });
    await hit('POST', `/api/sessions/${sid}/remove`, { notify: false });
    await hit('POST', `/api/sessions/${sid}/restore`);
    await hit('POST', `/api/sessions/${sid}/start`);
    await wait(1500);
    await hit('POST', `/api/sessions/${sid}/restart`);
    await wait(2000);
    await hit('POST', `/api/sessions/${sid}/stop`);
    await wait(3500);
    await hit('POST', `/api/groups/${g.id}/resume`);
    await wait(1500);
    await hit('POST', `/api/groups/${g.id}/stop`);
    await wait(3500);
    await hit('POST', `/api/groups/${g.id}/sessions`, { row: { roleId: 'dokuman', accountId: acc, model: 'haiku' } });
    await wait(1500);
    await hit('POST', `/api/groups/${g.id}/stop`);
    await wait(3500);
    await hit('POST', `/api/groups/${g.id}/archive`, { archived: true });
    await hit('POST', `/api/groups/${g.id}/archive`, { archived: false });
    await hit('POST', '/api/requests/999999/approve', {});
    await hit('POST', '/api/watch/ops/yok/cancel');

    // Şablon, ayar ve yetenek uçları.
    const tpl = await hit('POST', '/api/templates', { name: 'duman şablonu', rows: [{ key: 'a', roleId: 'coder', accountId: acc, effort: 'low' }] });
    const tid = (tpl.id) || ((await hit('GET', '/api/templates')).find((t) => t.name === 'duman şablonu') || {}).id;
    if (tid) {
      await hit('PUT', `/api/templates/${tid}`, { name: 'duman şablonu 2' });
      await hit('DELETE', `/api/templates/${tid}`);
    }
    const s2 = await hit('GET', '/api/state');
    const saved = await hit('PUT', '/api/settings', s2.settings);
    // Kaydet / geri oku: rol alanları korunmalı (boş alanların false / null'a dönmesi dışında).
    const norm = (rs) => JSON.stringify(rs.map((r) => ({ id: r.id, label: r.label, model: r.model || '', effort: r.effort || '', mode: r.permissionMode || '', prompt: r.prompt, ro: !!r.readOnly, w: r.ctxWarn || null, h: r.ctxHigh || null })));
    if (norm((saved.settings || saved).roles) !== norm(s2.settings.roles)) fails.push('PUT /api/settings rol alanlarını korumadı');
    await hit('POST', '/api/caps/mcp', { name: 'duman-mcp', type: 'http', url: 'https://example.invalid/mcp' });
    const mid = ((await hit('GET', '/api/caps')).mcps.find((m) => m.name === 'duman-mcp') || {}).id;
    if (mid) {
      await hit('PUT', `/api/caps/mcp/${mid}`, { name: 'duman-mcp', type: 'http', url: 'https://example.invalid/mcp2' });
      await hit('DELETE', `/api/caps/mcp/${mid}`);
    }
    await hit('POST', '/api/caps/skill', { mode: 'text', name: 'duman-skill', description: 'test', body: 'gövde' });
    await hit('PUT', '/api/caps/role', { key: 'pskill:duman-skill', roleId: 'coder', on: true });
    await hit('PUT', '/api/caps/role', { keys: ['skill:dataviz'], roleId: 'coder', on: false });
    await hit('PUT', '/api/caps/role', { keys: ['skill:dataviz'], roleId: 'coder', on: true });
    await hit('DELETE', '/api/caps/skill/duman-skill');

    // Zip'ten skill yükleme: geçici klasördeki SKILL.md sıkıştırılıp gönderilir, sonra silinir.
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');
    const zdir = fs.mkdtempSync(path.join(os.tmpdir(), 'duman-zip-'));
    fs.mkdirSync(path.join(zdir, 'duman-zip'));
    fs.writeFileSync(path.join(zdir, 'duman-zip', 'SKILL.md'), '---\nname: duman-zip\ndescription: test\n---\ngövde\n');
    const zip = path.join(zdir, 'skill.zip');
    execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${path.join(zdir, 'duman-zip')}' -DestinationPath '${zip}'`]);
    calls++;
    const zr = await fetch('http://127.0.0.1:7799/api/caps/skill-zip?name=duman-zip', { method: 'POST', headers: { 'x-panel-token': p.token }, body: fs.readFileSync(zip) });
    if (!zr.ok) fails.push(`POST /api/caps/skill-zip → ${zr.status} ${(await zr.json().catch(() => ({}))).error || ''}`);
    else if (!(await hit('GET', '/api/caps')).skills.some((x) => x.name === 'duman-zip')) fails.push('zip skill listede yok');
    await hit('DELETE', '/api/caps/skill/duman-zip');

    // MCP sınaması: geçersiz komut açılmadığını bildirmeli (500 değil).
    await hit('POST', '/api/caps/test', { config: { type: 'stdio', command: 'boyle-bir-komut-yok', args: [] } });

    // Windows başlangıcı: durum tersine çevrilip eski haline getirilir (kullanıcının ayarı değişmez).
    const auto = (await hit('GET', '/api/state')).autostart;
    const flip = await hit('POST', '/api/autostart', { enabled: !auto });
    const back = await hit('POST', '/api/autostart', { enabled: auto });
    if (flip.autostart !== !auto || back.autostart !== auto) fails.push(`autostart değişmedi ya da geri dönmedi (${auto} → ${flip.autostart} → ${back.autostart})`);

    // "PC'de aç" masaüstünde terminal penceresi açar; yalnızca SMOKE_PC=1 ile.
    if (process.env.SMOKE_PC === '1') {
      await hit('POST', `/api/sessions/${sid}/start`);
      await wait(2500);
      await hit('POST', `/api/sessions/${sid}/open-pc`);
      await wait(3000);
      await hit('POST', `/api/sessions/${sid}/stop`);
      await wait(3500);
    }

    // Erişim anahtarı yenileme: eski anahtar reddedilmeli, yeni anahtar çalışmalı.
    const rot = await hit('POST', '/api/token/rotate');
    const old = await fetch('http://127.0.0.1:7799/api/state', { headers: { 'x-panel-token': p.token } });
    if (old.status !== 401) fails.push(`eski anahtar hâlâ geçerli (${old.status})`);
    if (rot.token) p.token = rot.token;
    else p.token = fs.readFileSync(path.join(p.dataDir, 'token.txt'), 'utf8').trim();
    await hit('GET', '/api/state');

    // Kapatma: panel düzgün çıkmalı.
    await hit('POST', '/api/shutdown');
    const gone = await until(() => p.child.exitCode != null, 10000, 300);
    if (!gone) fails.push('shutdown sonrası panel kapanmadı');
    else if (p.child.exitCode !== 0) fails.push(`shutdown çıkış kodu ${p.child.exitCode}`);
    shut = true;
  } finally {
    const alive = shut || await fetch('http://127.0.0.1:7799/api/state', { headers: { 'x-panel-token': p.token } }).then((r) => r.ok).catch(() => false);
    if (!alive) fails.push(`panel düştü:\n${p.log().split('\n').slice(-6).join('\n')}`);
    const errs = p.log().split('\n').filter((l) => /TypeError|ReferenceError|SyntaxError|at .*index\.js/.test(l));
    if (errs.length) fails.push(`sunucu günlüğünde hata:\n${errs.slice(0, 8).join('\n')}`);
    await p.stop();
  }
  console.log(`${calls} çağrı; ${fails.length ? `${fails.length} sorun:\n${fails.join('\n')}` : 'hepsi 500 vermeden döndü, panel ayakta, günlükte hata yok'}`);
  process.exitCode = fails.length ? 1 : 0;
})();
