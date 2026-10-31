// Maestro arayüzü · Yönlendirme, masaüstü bildirimleri ve açılış. En son yüklenir.
// web/js/ altındaki dosyalar index.html'deki sırayla yüklenen klasik script'lerdir; üst düzey bildirimler ortak
// global kapsamdadır. Yüklenirken çalışan kod yalnızca kendinden önceki dosyaları kullanabilir.
'use strict';
// ---------- yönlendirme ----------

let current = null;

function parseRoute() {
  const [pathPart, query] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = pathPart.split('/').filter(Boolean);
  // Çalışma ekranı görünümü adresle de seçilebilir: #/g/<grup>?view=map
  const view = new URLSearchParams(query || '').get('view');
  if (view && ['terms', 'map', 'time', 'msgs', 'board', 'notes', 'bekci'].includes(view)) store(VIEW_KEY, view);
  if (parts[0] === 'p' && parts[1] && parts[2] === 'kurulum') return [SetupView, { id: parts[1] }];
  if (parts[0] === 'p' && parts[1]) return [ProjectView, { id: parts[1] }];
  if (parts[0] === 'g' && parts[1]) return [WorkView, { id: parts[1], sid: parts[2] }];
  if (parts[0] === 'ayarlar') return [SettingsView, { tab: parts[1], role: parts[2] }];
  return [ProjectsView, {}];
}

async function navigate() {
  if (current && current.cleanup) current.cleanup();
  current = null;
  closeQuota();
  closeNotif();
  if (!token) {
    crumbs([{ label: 'Erişim' }]);
    app.innerHTML = '<div class="page"><div class="empty">Erişim anahtarı yok. Sunucu penceresinde yazan adresi (…/?t=…) aç.</div></div>';
    setServer(false, true);
    return;
  }
  try {
    // Durum kanalı güncel tuttuğu için ekran beklemeden önceki durumla açılır; yenisi gelince kendiliğinden tazelenir.
    if (state && stateLive()) refresh().then(afterState).catch(() => {});
    else await refresh();
  } catch (err) {
    app.innerHTML = `<div class="page"><div class="empty">${err.status === 401
      ? 'Erişim anahtarı geçersiz. Sunucu penceresinde yazan adresi yeniden aç.'
      : 'Sunucuya ulaşılamıyor. Paneli başlatan pencere açık mı?'}</div></div>`;
    return;
  }
  const [view, params] = parseRoute();
  current = view;
  view.mount(params);
}

window.addEventListener('hashchange', navigate);

// ---------- bildirimler ----------

const NOTIFY_KEY = 'maestro-notify';
const prevStatus = new Map();

// Bir oturum "onay bekliyor" durumuna geçince tarayıcı bildirimi; sekme başlığında bekleyen sayısı.
function watchState() {
  const waiting = [];
  for (const g of state.groups) {
    for (const s of g.sessions) {
      const k = s.running && !s.removed ? s.status : 'off';
      const before = prevStatus.get(s.id);
      prevStatus.set(s.id, k);
      if (k === 'waiting') waiting.push(s);
      if (k === 'waiting' && before && before !== 'waiting' && store(NOTIFY_KEY) === '1'
        && 'Notification' in window && Notification.permission === 'granted') {
        // Soru (AskUserQuestion) ile izin onayı ayrı yazılır; ikisinde de üyenin ne beklediği gövdede.
        const n = new Notification(`${s.roleLabel} ${s.waitKind === 'question' ? 'soru soruyor' : 'onay bekliyor'}`, {
          body: [s.activity && s.activity !== 'soru soruyor' ? s.activity : '', s.name].filter(Boolean).join('\n'), tag: s.id,
        });
        n.onclick = () => {
          window.focus();
          location.hash = `#/g/${g.id}/${s.id}`;
          n.close();
        };
      }
    }
  }
  document.title = waiting.length ? `(${waiting.length}) Maestro` : 'Maestro';
  // Panelin kendiliğinden yaptığı işler (ör. hesap rotasyonu, bekçinin hamleleri) bildirim kutusuna düşer.
  const evs = state.events || [];
  const top = evs.length ? evs[evs.length - 1].id : 0;
  if (!notifPop.hidden && top !== notifShownTop) openNotif();
  updateNotifCount();
}

// Durum iki saniyede bir yenilenir; açık ekranın canlı kısmı (varsa) yeniden çizilir.
function afterState() {
  watchState();
  if (current && current.poll && !document.hidden) current.poll();
}

let lastPoll = 0;
setInterval(async () => {
  if (!token || document.hidden && store(NOTIFY_KEY) !== '1') return;
  // Durum kanalı açıkken sunucu zaten itiyor; yoklama yalnızca kanalın sessiz kopmasına karşı 20 sn'de bir.
  if (stateLive() && Date.now() - lastPoll < 20000) return;
  lastPoll = Date.now();
  try {
    await refresh();
    afterState();
  } catch {}
}, 2000);

openStateChannel();
navigate();
