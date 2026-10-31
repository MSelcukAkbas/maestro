// Maestro sunucusu: yalnızca 127.0.0.1'de çalışır, her API ve WebSocket çağrısı erişim anahtarı ister.
// Bu dosya parçaları bağlar ve zamanlayıcıları kurar. Ortak bağlam panel/context.js; oturum açma panel/launch.js;
// sistem istemi panel/prompt.js; üyelere iletim panel/delivery.js; zamanlı işler panel/ticks.js; HTTP / WebSocket
// panel/http.js; API uçları routes/*.js.
const store = require('./core/store');
const agent = require('../agent');
const { manager, ops, cachedQuota, meterTick, PORT } = require('./panel/context');
const { boardIdleTick } = require('./panel/delivery');
const { pendingTick, sampleTimeline, watchTick } = require('./panel/ticks');
const http = require('./panel/http');

require('./routes/groups');
require('./routes/board');
require('./routes/sessions');
require('./routes/setup');
require('./routes/settings');
require('./routes/caps');

setInterval(pendingTick, 10000);
setInterval(sampleTimeline, 2000);
setInterval(() => { try { meterTick(); } catch (err) { console.error('[panel] ölçüm:', err.message); } }, 10000);
setInterval(() => { try { ops.tick(); } catch (err) { console.error('[panel] bekçi hamlesi:', err.message); } }, 3000);
setInterval(() => { try { watchTick(); } catch (err) { console.error('[panel] bekçi:', err.message); } }, 60 * 1000);

// Arayüz kapalıyken de ölçüm sürsün: üye çalışırken kota 5 dakikada bir (önbellek süresine uyarak) okunur.
setInterval(() => {
  if (!store.viewGroups().some((g) => g.sessions.some((s) => manager.has(s.id)))) return;
  cachedQuota().catch((err) => console.error('[panel] kota:', err.message));
}, 5 * 60 * 1000);

setInterval(boardIdleTick, 2000);

http.start();

// Yerel kullanım: terminal ajanı bağlı değilse ayrı süreç olarak başlatılır (çalışan bir ajan varsa yeniden bağlanması beklenir).
// MAESTRO_AGENT=harici: ajan başka makinede, burada başlatılmaz.
if (process.env.MAESTRO_AGENT !== 'harici') {
  if (!agent.launcher.running(store.DATA_DIR)) agent.launcher.spawnLocal({ port: PORT, dataDir: store.DATA_DIR });
  let missing = 0;
  setInterval(() => {
    missing = manager.connected ? 0 : missing + 1;
    if (missing < 2 || agent.launcher.running(store.DATA_DIR)) return;
    console.log('[panel] terminal ajanı başlatılıyor.');
    agent.launcher.spawnLocal({ port: PORT, dataDir: store.DATA_DIR });
    missing = 0;
  }, 1500);
}
