// Duman testi: panelin API uç noktalarının hepsini 7799'da ayrı veri klasörüyle çağırır; hiçbiri 500 vermemeli
// ve panel ayakta kalmalı. Oturum açan çağrılar istem göndermez (model harcaması yok denecek kadar az). optimize model
// çağırdığı için e2e.js'te; open-pc masaüstünde pencere açtığı için yalnızca SMOKE_PC=1 ile.
// Kullanım: node test/smoke.js
const fs = require('fs');
const path = require('path');
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
    const pid = st.projects.find((x) => path.resolve(x.path) === path.resolve(__dirname, '..', '..')).id;
    const acc = st.settings.accounts[st.settings.accounts.length - 1].id;
    for (const u of ['/api/meter', '/api/watch', '/api/quota', '/api/caps']) await hit('GET', u);
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
    await hit('POST', `/api/groups/${g.id}/remind`, { text: 'hatırlatma', to: [sid] });
    await hit('GET', `/api/groups/${g.id}/close`);
    // Mesaj geliştirici: boş mesaj ve bilinmeyen oturum model çağırmadan reddedilir.
    await hit('POST', `/api/sessions/${sid}/improve-prompt`, { text: ' ' }, (s) => s === 400);
    await hit('POST', '/api/sessions/yok-boyle/improve-prompt', { text: 'x' }, (s) => s === 404);
    await hit('POST', `/api/sessions/${sid}/send`, { text: '' }, (s) => s === 400);
    await hit('POST', `/api/groups/${g.id}/board-improve`, { title: ' ', text: '' }, (s) => s === 400);
    // Üye menüsünden izin modu (kapalı üye: yalnızca kayıt).
    await hit('POST', `/api/sessions/${sid}/settings`, { permissionMode: 'acceptEdits' });
    await hit('POST', `/api/sessions/${sid}/settings`, { permissionMode: 'yolo' }, (s) => s === 400);
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

    // Rol danışmanı: bilinmeyen rol model çağırmadan 404.
    await hit('POST', '/api/roles/yok-boyle/optimize', { step: 'sorular' });
    const cu = await hit('GET', '/api/roles/review/cap-usage');
    if (typeof cu.oturum !== 'number' || !cu.keys) fails.push('GET /api/roles/review/cap-usage → biçim yanlış');
    await hit('GET', '/api/roles/yok-boyle/cap-usage', undefined, (s) => s === 404);
    const s2 = await hit('GET', '/api/state');
    const saved = await hit('PUT', '/api/settings', s2.settings);
    // Kaydet / geri oku: rol alanları korunmalı (boş alanların false / null'a dönmesi dışında).
    const norm = (rs) => JSON.stringify(rs.map((r) => ({ id: r.id, label: r.label, model: r.model || '', effort: r.effort || '', mode: r.permissionMode || '', persona: r.persona, gorevler: r.gorevler, sinirlar: r.sinirlar, ro: !!r.readOnly, w: r.ctxWarn || null, h: r.ctxHigh || null })));
    if (norm((saved.settings || saved).roles) !== norm(s2.settings.roles)) fails.push('PUT /api/settings rol alanlarını korumadı');
    // Bekçi düğmesi yalnızca { watch: { anahtar } } gönderir: roller, hesaplar ve diğer bekçi ayarları değişmemeli.
    const w0 = (await hit('GET', '/api/watch')).settings;
    await hit('PUT', '/api/settings', { watch: { ai: !w0.ai } });
    const s3 = await hit('GET', '/api/state');
    const w1 = (await hit('GET', '/api/watch')).settings;
    if (norm(s3.settings.roles) !== norm(s2.settings.roles) || s3.settings.accounts.length !== s2.settings.accounts.length) fails.push('kısmi PUT /api/settings rolleri ya da hesapları değiştirdi');
    if (w1.ai === w0.ai || JSON.stringify({ ...w1, ai: w0.ai }) !== JSON.stringify(w0)) fails.push('kısmi bekçi kaydı diğer bekçi ayarlarını değiştirdi');
    await hit('PUT', '/api/settings', { watch: { ai: w0.ai } });
    // Depodaki skill rol ataması (test paneli prompts/ kopyasına yazar) ve global skill'i rolde kapatma.
    await hit('PUT', '/api/caps/role', { key: 'pskill:security-and-hardening', roleId: 'coder', on: true });
    await hit('PUT', '/api/caps/role', { key: 'pskill:security-and-hardening', roleId: 'coder', on: false });
    await hit('PUT', '/api/caps/role', { keys: ['skill:dataviz'], roleId: 'coder', on: false });
    await hit('PUT', '/api/caps/role', { keys: ['skill:dataviz'], roleId: 'coder', on: true });
    // MCP sınaması: hesapta olmayan MCP 404 (500 değil).
    await hit('POST', '/api/caps/test', { key: 'mcp:yok-boyle-mcp' });

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
