// Yetenekler: panel MCP'leri ve skill'leri, MCP denemesi, rollere yetenek verme / kapatma.
const path = require('path');

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

// Ham gövde (zip yükleme); JSON değil.
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, `Dosya en fazla ${Math.round(max / 1_000_000)} MB olabilir.`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function capsState() {
  return { ...caps.load(), inventory: caps.inventory(settings.accounts).map(({ config, ...x }) => x) };
}

function globalMcpNames() {
  return caps.inventory(settings.accounts).filter((x) => x.kind === 'mcp').map((x) => x.name);
}

route('GET', '/api/caps', async () => capsState());

route('POST', '/api/caps/mcp', async (req) => {
  const body = await readBody(req);
  capCall(() => caps.addMcp(body, globalMcpNames()));
  return capsState();
});

route('PUT', '/api/caps/mcp/([\\w-]+)', async (req, m) => {
  const body = await readBody(req);
  capCall(() => caps.updateMcp(m[1], body, globalMcpNames()));
  return capsState();
});

route('DELETE', '/api/caps/mcp/([\\w-]+)', async (req, m) => {
  capCall(() => caps.removeMcp(m[1]));
  return capsState();
});

// Kaydetmeden önce ya da kayıtlı bir MCP'yi (panel ya da hesaptaki) dener; tool adlarını döndürür.
route('POST', '/api/caps/test', async (req) => {
  const body = await readBody(req);
  let cfg = body.config;
  if (body.id) cfg = caps.load().mcps.find((x) => x.id === body.id);
  else if (body.key) cfg = (caps.inventory(settings.accounts).find((x) => x.key === body.key) || {}).config;
  if (!cfg) throw new HttpError(404, 'MCP bulunamadı.');
  return testMcp(cfg);
});

route('GET', '/api/caps/skill/([a-z0-9-]+)', async (req, m) => capCall(() => caps.readSkill(m[1])));

route('POST', '/api/caps/skill', async (req) => {
  const body = await readBody(req);
  capCall(() => {
    if (body.mode === 'dir') return caps.importDir(path.resolve(String(body.path || '').trim()), body.name);
    if (body.mode === 'raw') return caps.writeRaw(String(body.name || ''), String(body.text || '').slice(0, 200000));
    return caps.writeSkill({ name: body.name, description: body.description, body: body.body, replace: !!body.replace });
  });
  return capsState();
});

route('POST', '/api/caps/skill-zip', async (req) => {
  const url = new URL(req.url, 'http://x');
  const buf = await readRaw(req, 20_000_000);
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new HttpError(400, 'Bu bir zip dosyası değil.');
  try {
    await caps.importZip(buf, url.searchParams.get('name') || '');
  } catch (err) {
    throw new HttpError(err.status || 500, err.message);
  }
  return capsState();
});

route('DELETE', '/api/caps/skill/([a-z0-9-]+)', async (req, m) => {
  capCall(() => caps.removeSkill(m[1]));
  return capsState();
});

route('PUT', '/api/caps/role', async (req) => {
  const body = await readBody(req);
  if (!settings.roles.some((r) => r.id === body.roleId)) throw new HttpError(400, 'Rol bulunamadı.');
  // keys: bir gruptaki tüm yetenekler tek istekte (ör. yerleşik skill'lerin hepsi bu rolde kapalı).
  const keys = Array.isArray(body.keys) ? body.keys.slice(0, 200) : [body.key];
  for (const k of keys) capCall(() => caps.setRole(k, body.roleId, !!body.on));
  return capsState();
});
