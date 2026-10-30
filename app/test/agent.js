// Ajan testi: services yeniden başlayınca terminal oturumları ajanda açık kalmalı ve terminal akışı yeniden bağlanmalı.
// Model çağırmaz (asistan oturumu açılır, istem gönderilmez). Kullanım: node test/agent.js
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
    await p.api('POST', '/api/assistant/open', {});
    let st = await p.api('GET', '/api/state');
    const sid = st.assistant.id;
    check(st.assistant.running, 'asistan açıldı');
    check(st.agent.connected, 'ajan bağlı');

    const before = await terminalOutput(p, sid);
    check(before.length > 0, 'terminal çıktısı services üzerinden akıyor');

    // Yalnızca services biter (SIGTERM); ajan ve oturum yaşamalı.
    p.child.kill();
    await until(() => p.child.exitCode != null, 10000);
    p = await startPanel(dataDir);
    st = await p.api('GET', '/api/state');
    check(st.agent.connected, 'services yeniden başladı, ajan yeniden bağlandı');
    check(st.assistant.running, 'asistan oturumu yeniden başlatmadan sonra hâlâ açık');

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
