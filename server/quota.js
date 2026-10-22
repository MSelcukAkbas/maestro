// Hesap kotası: PowerShell profilindeki claude-kota ile aynı uç nokta ve aynı kimlik bilgisi.
// Uç nokta belgelenmemiş; her hata satır içinde "Durum" olarak döner, panel çökmez.
const fs = require('fs');
const path = require('path');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const STATUS_TEXT = {
  401: 'oturum yenile',
  403: 'yetki reddedildi',
  429: 'çok sık sorgu',
};

// Yanıttaki "limits" listesi varsa o kullanılır (kullanılan yüzde + önem derecesi); yoksa five_hour / seven_day alanları.
function readBuckets(u, now = Date.now()) {
  const out = { five: null, week: null };
  const limits = Array.isArray(u.limits) ? u.limits : [];
  const session = limits.find((l) => l.kind === 'session');
  const weekly = limits.find((l) => l.kind === 'weekly_all') || limits.find((l) => l.group === 'weekly');
  const pick = (lim, legacy) => {
    if (lim && lim.percent != null) return { used: Number(lim.percent), resetsAt: lim.resets_at || null, severity: lim.severity || null };
    if (legacy && legacy.utilization != null) return { used: Number(legacy.utilization), resetsAt: legacy.resets_at || null, severity: null };
    return null;
  };
  out.five = expire(pick(session, u.five_hour), now);
  out.week = expire(pick(weekly, u.seven_day), now);
  return out;
}

// Sıfırlanma anı geçmiş pencere: uç nokta bir sonraki mesaja kadar eski yüzdeyi döndürebiliyor. Geçen pencere
// kullanılmamış sayılır; yoksa dolu hesap sıfırlandıktan sonra da "dolu" görünür ve rotasyon onu atlar.
function expire(b, now) {
  if (!b || !b.resetsAt) return b;
  const reset = Date.parse(b.resetsAt);
  return Number.isFinite(reset) && reset <= now ? { used: 0, resetsAt: null, severity: null } : b;
}

const WINDOW_MS = { five: 5 * 3600 * 1000, week: 7 * 24 * 3600 * 1000 };
const MIN_SAMPLE_GAP = 10 * 60 * 1000;
// Hesap başına önceki ölçümler: aynı pencerede en az 10 dk önceki bir ölçüm varsa son dönemin hızı kullanılır.
const history = new Map();

// Bu hızla pencerenin ne zaman dolacağını tahmin eder. Önceki ölçüm yoksa pencerenin başından beri ortalama hız kullanılır.
function forecast(kind, bucket, prev, now) {
  if (!bucket || !bucket.resetsAt) return null;
  const reset = Date.parse(bucket.resetsAt);
  if (!Number.isFinite(reset)) return null;
  const left = 100 - bucket.used;
  if (left <= 0) return { eta: now, beforeReset: true, basis: 'dolu' };
  let rate = null;
  let basis = null;
  const p = prev && prev[kind];
  // Sıfırlanma zamanı her sorguda saniyenin altında oynar; aynı pencere bir dakikalık payla tanınır.
  if (p && Math.abs(Date.parse(p.resetsAt) - reset) < 60 * 1000 && now - prev.ts >= MIN_SAMPLE_GAP && bucket.used > p.used) {
    rate = (bucket.used - p.used) / (now - prev.ts);
    basis = 'son dönem';
  } else {
    // Pencere yeni başladıysa birkaç dakikadaki harcama tüm pencereye yayılınca "birazdan biter" gibi yanlış bir
    // tahmin çıkar (ör. 2 dakikada %3 → 1 saatte biter). Pencerenin en az beşte biri geçmeden ortalama kullanılmaz.
    const elapsed = now - (reset - WINDOW_MS[kind]);
    if (elapsed < WINDOW_MS[kind] / 5) return { eta: null, beforeReset: false, basis: 'pencere yeni' };
    if (elapsed > 0 && bucket.used > 0) {
      rate = bucket.used / elapsed;
      basis = 'pencere ortalaması';
    }
  }
  if (!rate) return { eta: null, beforeReset: false, basis: 'kullanım yok' };
  const eta = now + left / rate;
  return { eta, beforeReset: eta < reset, basis };
}

function rememberSample(accountId, five, week, now) {
  const list = history.get(accountId) || [];
  list.push({ ts: now, five: five && { used: five.used, resetsAt: five.resetsAt }, week: week && { used: week.used, resetsAt: week.resetsAt } });
  // 6 saatten eski ölçümler atılır.
  history.set(accountId, list.filter((x) => now - x.ts < 6 * 3600 * 1000));
}

function previousSample(accountId, now) {
  const list = history.get(accountId) || [];
  // En az 10 dk önceki en yeni ölçüm.
  for (let i = list.length - 1; i >= 0; i--) if (now - list[i].ts >= MIN_SAMPLE_GAP) return list[i];
  return null;
}

async function accountQuota(account) {
  const row = { accountId: account.id, name: account.name, five: null, week: null, blocked: false, blockedUntil: null, status: 'canlı' };
  let token;
  try {
    const cred = JSON.parse(fs.readFileSync(path.join(account.configDir, '.credentials.json'), 'utf8'));
    token = cred.claudeAiOauth && cred.claudeAiOauth.accessToken;
  } catch {
    row.status = 'kimlik okunamadı';
    return row;
  }
  if (!token) {
    row.status = 'giriş yapılmamış';
    return row;
  }
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      row.status = STATUS_TEXT[res.status] || `HTTP ${res.status}`;
      return row;
    }
    const now = Date.now();
    const b = readBuckets(await res.json(), now);
    const prev = previousSample(account.id, now);
    row.five = b.five && { ...b.five, forecast: forecast('five', b.five, prev, now) };
    row.week = b.week && { ...b.week, forecast: forecast('week', b.week, prev, now) };
    rememberSample(account.id, b.five, b.week, now);
    // Herhangi bir pencere dolduysa hesap o pencere sıfırlanana kadar kullanılamaz.
    const full = [b.five, b.week].filter((x) => x && x.used >= 100);
    if (full.length) {
      row.blocked = true;
      row.blockedUntil = full.map((x) => x.resetsAt).filter(Boolean).sort().pop() || null;
    }
  } catch {
    row.status = 'sorgulanamadı';
  }
  return row;
}

async function allQuota(accounts) {
  const rows = await Promise.all(accounts.map(accountQuota));
  return { fetchedAt: Date.now(), rows };
}

module.exports = { allQuota, readBuckets, forecast };
