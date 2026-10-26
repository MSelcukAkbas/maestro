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
function liveSessions(configDir) {
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

function transcriptPath(configDir, sessionId) {
  const cached = transcriptCache.get(sessionId);
  if (cached && fs.existsSync(cached)) return cached;
  const root = path.join(configDir, 'projects');
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) {
      transcriptCache.set(sessionId, p);
      return p;
    }
  }
  return null;
}

module.exports = { liveSessions, transcriptPath, pidAlive };
