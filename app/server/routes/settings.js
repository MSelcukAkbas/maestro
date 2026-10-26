// Ayarlar ve panel geneli: ayarları kaydetme, açılışta başlatma, sunucuyu kapatma, erişim anahtarı, ölçüm,
// bekçi görünümü ve kota.
const fs = require('fs');

const store = require('../core/store');
const prompts = require('../core/prompts');
const { MODELS, EFFORTS, PERMISSION_MODES } = require('../core/options');
const { WATCH_DEFAULTS } = require('../watch/watch');
const { curatorDefaults, curatorLevels } = require('../team/curator');
const {
  PORT, settings, replaceSettings, rotateToken, caps, meter, watch, ledger, ops, HttpError, cleanText, cachedQuota,
  groupWatchCfg, shutdown,
} = require('../panel/context');
const { STARTUP_LINK, setAutostart } = require('../panel/state');
const { route, readBody } = require('../panel/http');

route('POST', '/api/autostart', async (req) => {
  const body = await readBody(req);
  setAutostart(!!body.enabled);
  return { autostart: fs.existsSync(STARTUP_LINK) };
});

route('POST', '/api/shutdown', async () => {
  setTimeout(shutdown, 200);
  return { ok: true };
});

route('GET', '/api/meter', async () => ({ ...meter.snapshot(settings.accounts), ledger: ledger.view() }));
// Bekçi grup başına: g verilirse o grubun bulguları, adayları, kayıtları, işlemleri ve geçerli ayarı.
route('GET', '/api/watch', async (req) => {
  const gid = new URL(req.url, 'http://x').searchParams.get('g');
  const g = gid ? store.loadGroups().find((x) => x.id === gid) : null;
  if (gid && !g) throw new HttpError(404, 'Grup bulunamadı.');
  return {
    ...watch.snapshot(gid),
    ops: ops.list().filter((o) => !gid || o.gid === gid),
    settings: g ? groupWatchCfg(g) : { ...WATCH_DEFAULTS, ...(settings.watch || {}) },
    groupWatch: g ? g.watch || {} : undefined,
  };
});

route('GET', '/api/quota', async (req) => cachedQuota(new URL(req.url, 'http://x').searchParams.has('fresh')));

route('PUT', '/api/settings', async (req) => {
  const body = await readBody(req);
  const next = { ...settings };
  if (Array.isArray(body.allowedDirs)) next.allowedDirs = body.allowedDirs.map((d) => String(d).trim()).filter(Boolean);
  if (body.autoRotate != null) next.autoRotate = !!body.autoRotate;
  if (body.watch && typeof body.watch === 'object') {
    const w = { ...WATCH_DEFAULTS, ...(settings.watch || {}) };
    for (const key of ['enabled', 'act', 'ai']) if (body.watch[key] != null) w[key] = !!body.watch[key];
    const num = (key, lo, hi) => {
      const v = Number(body.watch[key]);
      if (body.watch[key] != null && Number.isFinite(v) && v >= lo && v <= hi) w[key] = Math.round(v);
    };
    num('quotaHalf', 1, 99);
    num('quotaLow', 1, 99);
    num('ctxWarn', 10000, 10000000);
    num('ctxHigh', 10000, 10000000);
    num('errStreak', 2, 50);
    num('stuckMin', 5, 240);
    next.watch = w;
  }
  if (body.curator && typeof body.curator === 'object') {
    const c = { ...curatorDefaults(), ...(settings.curator || {}) };
    if (body.curator.enabled != null) c.enabled = !!body.curator.enabled;
    const h = Number(body.curator.everyH);
    if (body.curator.everyH != null && Number.isFinite(h) && h >= 1 && h <= 168) c.everyH = Math.round(h);
    if (MODELS.includes(body.curator.model)) c.model = body.curator.model;
    if (curatorLevels().includes(body.curator.level)) c.level = body.curator.level;
    next.curator = c;
  }
  if (body.contextWindows && typeof body.contextWindows === 'object') {
    const cw = {};
    for (const k of MODELS) {
      const v = Number(body.contextWindows[k]);
      cw[k] = v >= 1000 && v <= 100000000 ? Math.round(v) : (settings.contextWindows || {})[k];
    }
    next.contextWindows = cw;
  }
  if (Array.isArray(body.accounts)) {
    next.accounts = body.accounts.map((a) => ({
      id: cleanText(a.id, 12), name: cleanText(a.name, 40), configDir: String(a.configDir || '').trim(), color: cleanText(a.color, 12) || 'blue',
    })).filter((a) => a.id && a.configDir);
    if (!next.accounts.length) throw new HttpError(400, 'En az bir hesap gerekli.');
  }
  let roles = null;
  if (Array.isArray(body.roles)) {
    roles = body.roles.map((r) => ({
      id: cleanText(r.id, 24),
      label: cleanText(r.label, 40),
      short: cleanText(r.short, 24),
      prompt: String(r.prompt || '').slice(0, 40000),
      permissionMode: PERMISSION_MODES.includes(r.permissionMode) ? r.permissionMode : '',
      model: MODELS.includes(r.model) ? r.model : '',
      readOnly: !!r.readOnly,
      effort: EFFORTS.includes(r.effort) ? r.effort : '',
      // Bağlam profili (token); boşsa rolün varsayılanı ya da genel ayar kullanılır.
      ctxWarn: Number(r.ctxWarn) >= 20000 && Number(r.ctxWarn) <= 10000000 ? Math.round(Number(r.ctxWarn)) : null,
      ctxHigh: Number(r.ctxHigh) >= 20000 && Number(r.ctxHigh) <= 10000000 ? Math.round(Number(r.ctxHigh)) : null,
    })).filter((r) => prompts.ROLE_ID.test(r.id) && r.label && r.id !== 'custom');
  }
  if (body.port != null) {
    const port = Number(body.port);
    if (!(port >= 1024 && port <= 65535)) throw new HttpError(400, 'Port 1024–65535 arasında olmalı.');
    next.port = port;
  }
  replaceSettings(next);
  store.saveSettings(settings);
  // Roller prompts/roles/<id>/ klasörlerine yazılır (role.json + prompt.md).
  if (roles) prompts.saveRoles(roles);
  if (Array.isArray(body.roles)) caps.pruneRoles(settings.roles.map((r) => r.id));
  return { settings, restartNeeded: body.port != null && Number(body.port) !== PORT };
});

route('POST', '/api/token/rotate', async () => {
  return { token: rotateToken() };
});
