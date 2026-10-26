// Claude Code hook'ları: panelden açılan her oturuma --settings ile bir hook dosyası verilir. Hook'lar oturumun
// olaylarını (istem, tool çağrısı, izin isteği, bitiş) HTTP ile panele bildirir; panel durumu tahmin etmek yerine
// bu olaylardan bilir. Dosya yalnızca panel oturumlarına verilir; elle açılan Claude pencereleri etkilenmez.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Anahtar her açılışta yenilenir ve oturumlara ortam değişkeniyle verilir; dosyaya yazılmaz.
const TOKEN_ENV = 'PANEL_HOOK_TOKEN';
const MCP_SERVER = 'panel';
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];

// Oturuma özel ayar dosyası: hook'lar, panel tool izni ve rolün yetenek ayarları (kapatılan eklenti, skill, MCP).
function writeSettingsFile(dataDir, port, sessionId, extra = {}) {
  const hook = {
    type: 'http',
    url: `http://127.0.0.1:${port}/api/hook`,
    // Panel kapalıysa ya da yanıt gecikirse oturum beklemesin.
    timeout: 3,
    headers: { 'x-panel-hook-token': `$${TOKEN_ENV}` },
    allowedEnvVars: [TOKEN_ENV],
  };
  const hooks = {};
  for (const e of EVENTS) hooks[e] = [{ hooks: [hook] }];
  // Panelin görev panosu tool'ları her izin modunda sormadan çalışır.
  const permissions = { allow: [`mcp__${MCP_SERVER}`, ...(extra.allow || [])] };
  if (extra.deny && extra.deny.length) permissions.deny = extra.deny;
  const out = { permissions, hooks };
  if (extra.enabledPlugins && Object.keys(extra.enabledPlugins).length) out.enabledPlugins = extra.enabledPlugins;
  if (extra.skillOverrides && Object.keys(extra.skillOverrides).length) out.skillOverrides = extra.skillOverrides;
  const dir = path.join(dataDir, 'session-settings');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  return file;
}

// Oturuma özel MCP ayarı: adres oturum kimliğini taşır, böylece panel tool'u hangi üyenin çağırdığını bilir.
// Rolün panel MCP'leri de aynı dosyaya eklenir.
function writeMcpConfig(dataDir, port, sessionId, extraServers = {}) {
  const dir = path.join(dataDir, 'mcp');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.json`);
  const server = {
    type: 'http',
    url: `http://127.0.0.1:${port}/api/mcp/${sessionId}`,
    headers: { 'x-panel-hook-token': `\${${TOKEN_ENV}}` },
  };
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { ...extraServers, [MCP_SERVER]: server } }, null, 2));
  return file;
}

function short(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// Tool çağrısından "şu an ne yapıyor" satırı: tool adı ve hedefi (dosya adı, komut, arama deseni).
function describeTool(name, input) {
  const i = input || {};
  const target = i.file_path || i.notebook_path || i.path;
  if (target) return `${name} · ${path.basename(String(target))}`;
  if (i.command) return `${name} · ${short(i.command, 60)}`;
  if (i.pattern) return `${name} · ${short(i.pattern, 40)}`;
  if (i.url) return `${name} · ${short(i.url, 60)}`;
  if (i.to) return `${name} · ${short(i.to, 40)}`;
  if (i.description) return `${name} · ${short(i.description, 60)}`;
  return name;
}

// sessionId -> { status, waitKind, activity, ts }
class HookState {
  constructor() {
    this.token = crypto.randomBytes(24).toString('hex');
    this.map = new Map();
  }

  tokenOk(given) {
    if (typeof given !== 'string' || given.length !== this.token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(this.token));
  }

  get(id) {
    return this.map.get(id) || null;
  }

  clear(id) {
    this.map.delete(id);
  }

  set(id, status, extra = {}) {
    const prev = this.map.get(id) || {};
    this.map.set(id, {
      status,
      waitKind: extra.waitKind || null,
      activity: extra.activity !== undefined ? extra.activity : prev.activity || null,
      error: extra.error || null,
      // Claude kapandı, terminal düz PowerShell olarak açık kaldı.
      ended: !!extra.ended,
      ts: Date.now(),
    });
  }

  handle(body) {
    const id = body && body.session_id;
    if (typeof id !== 'string') return;
    const ev = body.hook_event_name;
    const tool = body.tool_name;
    switch (ev) {
      case 'UserPromptSubmit':
        this.set(id, 'busy', { activity: 'istem işleniyor' });
        break;
      case 'PreToolUse':
        // Kullanıcıya soru sorma tool'u: cevap beklenir.
        if (tool === 'AskUserQuestion') this.set(id, 'waiting', { waitKind: 'question', activity: 'soru soruyor' });
        else this.set(id, 'busy', { activity: describeTool(tool, body.tool_input) });
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        this.set(id, 'busy');
        break;
      case 'PermissionRequest':
        // Soru sorma tool'u da izin isteğinden geçer; bu bir izin değil, kullanıcıdan cevap beklemektir.
        if (tool === 'AskUserQuestion') this.set(id, 'waiting', { waitKind: 'question', activity: 'soru soruyor' });
        else if (tool === 'ExitPlanMode') this.set(id, 'waiting', { waitKind: 'permission', activity: 'plan onayı bekliyor' });
        else this.set(id, 'waiting', { waitKind: 'permission', activity: `izin: ${describeTool(tool, body.tool_input)}` });
        break;
      case 'Notification': {
        const kind = body.notification_type;
        if (kind === 'permission_prompt') {
          const cur = this.map.get(id);
          if (!cur || cur.status !== 'waiting') this.set(id, 'waiting', { waitKind: 'permission' });
        } else if (kind === 'elicitation_dialog' || kind === 'elicitation_url_dialog' || kind === 'agent_needs_input') {
          this.set(id, 'waiting', { waitKind: 'question', activity: short(body.message, 80) || 'girdi bekliyor' });
        } else if (kind === 'idle_prompt') {
          this.set(id, 'idle', { activity: null });
        }
        break;
      }
      case 'Stop':
        this.set(id, 'idle', { activity: null });
        break;
      case 'StopFailure':
        this.set(id, 'idle', { activity: null, error: short(body.error || body.message || 'API hatası', 120) });
        break;
      case 'SessionEnd':
        this.set(id, 'idle', { activity: 'Claude kapandı', ended: true });
        break;
      default:
        break;
    }
  }
}

module.exports = { HookState, writeSettingsFile, writeMcpConfig, TOKEN_ENV, MCP_SERVER, describeTool };
