// Yetenekler: liste, hesaptaki MCP'yi deneme, rollere yetenek verme / kapatma.
const { testMcp } = require('../setup/caps');
const { settings, caps, HttpError } = require('../panel/context');
const { route, readBody } = require('../panel/http');

function capCall(fn) {
  try {
    return fn();
  } catch (err) {
    throw new HttpError(err.status || 500, err.message);
  }
}

function capsState() {
  return { ...caps.load(), inventory: caps.inventory(settings.accounts).map(({ config, ...x }) => x) };
}

route('GET', '/api/caps', async () => capsState());

// Hesaplarda kurulu bir MCP'yi dener; tool adlarını döndürür.
route('POST', '/api/caps/test', async (req) => {
  const body = await readBody(req);
  const cfg = body.key && (caps.inventory(settings.accounts).find((x) => x.key === body.key) || {}).config;
  if (!cfg) throw new HttpError(404, 'MCP bulunamadı.');
  return testMcp(cfg);
});

route('PUT', '/api/caps/role', async (req) => {
  const body = await readBody(req);
  if (!settings.roles.some((r) => r.id === body.roleId)) throw new HttpError(400, 'Rol bulunamadı.');
  // keys: bir gruptaki tüm yetenekler tek istekte (ör. yerleşik skill'lerin hepsi bu rolde kapalı).
  const keys = Array.isArray(body.keys) ? body.keys.slice(0, 200) : [body.key];
  for (const k of keys) capCall(() => caps.setRole(k, body.roleId, !!body.on));
  return capsState();
});
