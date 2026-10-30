// Maestro sunucusu: yalnızca 127.0.0.1'de çalışır, her API ve WebSocket çağrısı erişim anahtarı ister.
// Bu dosya parçaları bağlar ve zamanlayıcıları kurar. Ortak bağlam panel/context.js; oturum açma panel/launch.js;
// sistem istemi panel/prompt.js; üyelere iletim panel/delivery.js; zamanlı işler panel/ticks.js; HTTP / WebSocket
// panel/http.js; API uçları routes/*.js.
const store = require('./core/store');
const { manager, ops, curator, cachedQuota, meterTick } = require('./panel/context');
const { boardIdleTick } = require('./panel/delivery');
const { ROTATE_EVERY, pendingTick, autoRotateTick, sampleTimeline, watchTick } = require('./panel/ticks');
const http = require('./panel/http');
const { scheduler } = require('./panel/schedule');

require('./routes/groups');
require('./routes/board');
require('./routes/sessions');
require('./routes/setup');
require('./routes/settings');
require('./routes/caps');
require('./routes/assistant');

setInterval(pendingTick, 10000);
setInterval(autoRotateTick, ROTATE_EVERY);
setInterval(sampleTimeline, 2000);
setInterval(() => { try { meterTick(); } catch (err) { console.error('[panel] ölçüm:', err.message); } }, 10000);
setInterval(() => { try { ops.tick(); } catch (err) { console.error('[panel] bekçi hamlesi:', err.message); } }, 3000);
setInterval(() => { try { watchTick(); } catch (err) { console.error('[panel] bekçi:', err.message); } }, 60 * 1000);
setInterval(() => { try { curator.tick(); } catch (err) { console.error('[panel] not düzenleyici:', err.message); } }, 10 * 60 * 1000);

// Arayüz kapalıyken de ölçüm sürsün: üye çalışırken kota 5 dakikada bir (önbellek süresine uyarak) okunur.
setInterval(() => {
  if (!store.viewGroups().some((g) => g.sessions.some((s) => manager.has(s.id)))) return;
  cachedQuota().catch((err) => console.error('[panel] kota:', err.message));
}, 5 * 60 * 1000);

setInterval(boardIdleTick, 2000);
// Zamanlayıcı: panel kapalıyken yarıda kalan / zamanı geçenler açılışta işaretlenir.
scheduler.recover();
setInterval(() => { try { scheduler.tick(); } catch (err) { console.error('[panel] zamanlayıcı:', err.message); } }, 5000);

http.start();
