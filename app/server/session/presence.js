// Kullanıcının panelle son teması ve modellere son yazdığı mesajlar; data/presence.json.
// Temas: terminale yazma ya da arayüzden yapılan bir işlem (GET sorguları sayılmaz, arayüz onları kendiliğinden yineler).
// Mesaj: kullanıcının terminalde Enter'a basmasından sonra gelen istem. Panelin yapıştırdığı bildirimler, açılış görevi
// ve ekip mesajları kullanıcı mesajı sayılmaz. Mesajı yanıtlayan model, mesajdan sonraki ilk turdan okunur.
const fs = require('fs');
const path = require('path');

// Oturum meşgulken yazılan mesaj sıraya girer; istem bildirimi o sıra gelince düşer.
const ENTER_KEEP = 30 * 60 * 1000;
const SAVE_DELAY = 5000;
// Bu süre hiç temas olmazsa kullanıcı uzakta sayılır; uzaklık son temastan başlar.
const AWAY_MS = 10 * 60 * 1000;

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

class Presence {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'presence.json');
    let d = {};
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    // sessions: { sid: { sid, name, gid, roleId, ts, fam, model } } — oturumun kullanıcıdan aldığı son mesaj.
    this.data = { lastSeenAt: d.lastSeenAt || null, lastAction: d.lastAction || null, lastSid: d.lastSid || null, sessions: d.sessions || {} };
    this.timer = null;
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.error('[presence] kaydedilemedi:', err.message);
      }
    }, SAVE_DELAY);
  }

  touch(what, now = Date.now()) {
    this.data.lastSeenAt = now;
    this.data.lastAction = what;
    this.save();
  }

  // Zaman çizelgesi için: { s: 'here' | 'away', t: başladığı an } ya da hiç temas yoksa null.
  status(now = Date.now()) {
    const seen = this.data.lastSeenAt;
    if (!seen) return null;
    return { s: now - seen < AWAY_MS ? 'here' : 'away', t: seen };
  }

  // UserPromptSubmit geldiğinde çağrılır. p: oturumun PtySession'ı, info: { name, gid, roleId }.
  prompt(sid, text, p, info, now = Date.now()) {
    const enterAt = p.lastEnterAt;
    // Bir Enter yalnızca bir istemi kullanıcıya bağlar.
    p.lastEnterAt = 0;
    if (!enterAt || now - enterAt > ENTER_KEEP) return false;
    // Enter'dan sonra panel yapıştırdıysa ya da istem panelin yapıştırdığı metinse mesaj panelindir.
    const t = squash(text);
    if (p.pastes.some((x) => x.t >= enterAt || (t && squash(x.text).slice(0, 200) && t.includes(squash(x.text).slice(0, 200))))) return false;
    // group / role / text: arayüzdeki kısa etiket için; text yalnızca ilk 10 karakter tutulur.
    this.data.sessions[sid] = { sid, name: info.name, group: info.group, role: info.role, text: t.slice(0, 10), gid: info.gid, roleId: info.roleId, ts: now, fam: null, model: null };
    this.data.lastSid = sid;
    this.save();
    return true;
  }

  // Modeli henüz bilinmeyen mesajlar için yanıtlayan tur aranır. turnAfter(sid, ts) -> { fam } | null, model(sid) -> tam ad.
  resolve(turnAfter, model) {
    let changed = false;
    for (const m of Object.values(this.data.sessions)) {
      if (m.fam) continue;
      const turn = turnAfter(m.sid, m.ts);
      if (!turn) continue;
      m.fam = turn.fam;
      const full = model(m.sid);
      m.model = full && full.includes(turn.fam) ? full : null;
      changed = true;
    }
    if (changed) this.save();
  }

  view() {
    const list = Object.values(this.data.sessions);
    const byFam = {};
    for (const m of list) {
      if (m.fam && (!byFam[m.fam] || byFam[m.fam].ts < m.ts)) byFam[m.fam] = m;
    }
    return {
      lastSeenAt: this.data.lastSeenAt,
      lastAction: this.data.lastAction,
      lastMessage: this.data.sessions[this.data.lastSid] || null,
      byFam,
    };
  }
}

module.exports = { Presence, AWAY_MS };
