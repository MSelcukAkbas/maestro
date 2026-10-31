// Ajan testi: services yeniden başlayınca terminal oturumları ajanda açık kalmalı ve terminal akışı yeniden bağlanmalı.
// Model çağırmaz (grup istemsiz açılır, istem gönderilmez). Kullanım: node test/agent.js
const path = require('path');
const { makeDataDir, startPanel, wait, until } = require('./lib');

const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

async function terminalOutput(p, sid, ms = 4000) {
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.TEST_PANEL_PORT || 7799}/ws?t=${p.token}&s=${sid}`);
  let out = '';
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'o') out += m.d; });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await wait(ms);
  ws.close();
  return out;
}

(async () => {
  const fails = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); console.log(`${ok ? 'ok ' : 'HATA'} ${msg}`); };
  let p = await startPanel(makeDataDir('panel-agent'));
  const dataDir = p.dataDir;
  try {
    let st = await p.api('GET', '/api/state');
    const pid = st.projects.find((x) => path.resolve(x.path) === path.resolve(__dirname, '..', '..')).id;
    const acc = st.settings.accounts[st.settings.accounts.length - 1].id;
    const g = await p.api('POST', '/api/groups', {
      projectId: pid, name: 'agent-test', permissionMode: 'manual',
      rows: [{ key: 'a', roleId: 'arastirma', accountId: acc, model: 'haiku', effort: 'low' }],
    });
    const sid = g.sessions[0].id;
    st = await p.api('GET', '/api/state');
    const running = async (id) => {
      st = await p.api('GET', '/api/state');
      const grp = st.groups.find((x) => x.id === id);
      return !!(grp && grp.sessions[0] && grp.sessions[0].running);
    };
    check(await until(() => running(g.id), 15000, 500), 'grup oturumu açıldı');
    check(st.agent.connected, 'ajan bağlı');

    const before = await terminalOutput(p, sid);
    check(before.length > 0, 'terminal çıktısı services üzerinden akıyor');

    // Yalnızca services biter (SIGTERM); ajan ve oturum yaşamalı.
    p.child.kill();
    await until(() => p.child.exitCode != null, 10000);
    p = await startPanel(dataDir);
    st = await p.api('GET', '/api/state');
    check(st.agent.connected, 'services yeniden başladı, ajan yeniden bağlandı');
    check(await running(g.id), 'grup oturumu yeniden başlatmadan sonra hâlâ açık');

    const after = await terminalOutput(p, sid);
    check(after.includes(before.slice(0, 200)) || after.length >= before.length, 'terminal geçmişi yeniden bağlanınca geliyor');

    await p.api('POST', '/api/shutdown');
    const gone = await until(() => p.child.exitCode != null, 10000);
    check(gone, 'shutdown sonrası services kapandı');
    await wait(1500);
    const fs = require('fs');
    check(!fs.existsSync(path.join(dataDir, 'agent.json')), 'shutdown sonrası ajan da kapandı');
  } catch (err) {
    fails.push(err.stack || err.message);
  } finally {
    await p.stop();
  }
  if (fails.length) {
    console.log(`\n${fails.length} sorun:\n${fails.join('\n')}`);
    process.exit(1);
  }
  console.log('\nAjan testi geçti.');
})();
