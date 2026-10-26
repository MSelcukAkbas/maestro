// Claude'un kendi kayıtlarını okur: canlı oturum durumları (sessions/<pid>.json) ve konuşma dosyaları (projects/*/<id>.jsonl).
// Hesapların sessions ve projects klasörleri ortak klasöre bağlı olduğu için tek bir hesabın yolu yeterli.
const fs = require('fs');
const path = require('path');

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// sessionId -> { pid, name, status, cwd, updatedAt, statusUpdatedAt }
// Zamanlayıcılar ve durum yanıtı aynı saniyede birkaç kez çağırır; sonuç LIVE_TTL boyunca paylaşılır.
const LIVE_TTL = 1000;
let liveCache = null;
function liveSessions(configDir) {
  const now = Date.now();
  if (liveCache && liveCache.dir === configDir && now - liveCache.at < LIVE_TTL) return liveCache.out;
  const out = scanLive(configDir);
  liveCache = { dir: configDir, at: now, out };
  return out;
}

function scanLive(configDir) {
  const dir = path.join(configDir, 'sessions');
  const out = new Map();
  let files;
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!j.sessionId || !pidAlive(j.pid)) continue;
      out.set(j.sessionId, {
        pid: j.pid, name: j.name, status: j.status || null, cwd: j.cwd, updatedAt: j.updatedAt,
        statusUpdatedAt: j.statusUpdatedAt || j.updatedAt || 0,
      });
    } catch {}
  }
  return out;
}

const transcriptCache = new Map();
// projects/ altında yüzlerce klasör olabilir; her oturum için tek tek aramak yerine klasörler bir geçişte dizinlenir.
// Dizinde olmayan oturum için yeni tarama en erken MISS_TTL sonra yapılır (yeni açılan oturumun kaydı gecikmeden görünsün).
const MISS_TTL = 5000;
let indexedAt = 0;

function indexTranscripts(root) {
  indexedAt = Date.now();
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return; }
  for (const d of dirs) {
    let files;
    try { files = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.jsonl')) transcriptCache.set(f.slice(0, -6), path.join(root, d, f));
    }
  }
}

function transcriptPath(configDir, sessionId) {
  const cached = transcriptCache.get(sessionId);
  if (cached && fs.existsSync(cached)) return cached;
  if (Date.now() - indexedAt < MISS_TTL) return null;
  indexTranscripts(path.join(configDir, 'projects'));
  const found = transcriptCache.get(sessionId);
  return found && fs.existsSync(found) ? found : null;
}

module.exports = { liveSessions, transcriptPath, pidAlive };
