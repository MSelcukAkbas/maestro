// Asistanın gelen / giden kutusu: kullanıcının asistan aracılığıyla üyelere gönderdiği mesajlar ve üyelerin
// asistana_yanit ile verdiği cevaplar. Giden mesajlar pano ve notlarla aynı iletim yolundan gider (tur sonunda ya da
// boştaysa terminaline); bilgi notları üyenin bir sonraki istemine ya da tool sonucuna ek bağlam olarak eklenir, tur
// açmaz. data/inbox.json'da tutulur; panel yeniden başlasa da kaybolmaz.
const fs = require('fs');
const path = require('path');
const prompts = require('../core/prompts');

const MAX_PER_MEMBER = 10;
const MAX_REPLIES = 100;
const MAX_TEXT = 8000;

class Inbox {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'inbox.json');
  }

  // { seq, msgs: { sid: [metin] }, info: { sid: [metin] }, replies: [{ id, ts, sid, name, group, text, read }] }
  load() {
    try {
      const r = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (r && typeof r === 'object') return { seq: 0, msgs: {}, info: {}, replies: [], ...r };
    } catch {}
    return { seq: 0, msgs: {}, info: {}, replies: [] };
  }

  save(r) {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(r, null, 2));
    fs.renameSync(this.file + '.tmp', this.file);
  }

  // Üyeye mesaj (tur açar). ask: cevabı asistana_yanit ile vermesi istenir.
  send(sid, text, ask = false) {
    const r = this.load();
    const body = prompts.message('kullanici-mesaji', { metin: String(text).slice(0, MAX_TEXT), cevap: !!ask, bilgi: false });
    r.msgs[sid] = (r.msgs[sid] || []).concat(body).slice(-MAX_PER_MEMBER);
    this.save(r);
  }

  // Üyeye bilgi notu (tur açmaz; bir sonraki çalışmasına eklenir).
  note(sid, text) {
    const r = this.load();
    r.info[sid] = (r.info[sid] || []).concat(String(text).slice(0, MAX_TEXT)).slice(-MAX_PER_MEMBER);
    this.save(r);
  }

  hasPending(sid) {
    const list = this.load().msgs[sid];
    return !!(list && list.length);
  }

  take(sid) {
    const r = this.load();
    const list = r.msgs[sid];
    if (!list || !list.length) return null;
    delete r.msgs[sid];
    this.save(r);
    return list.join('\n\n');
  }

  hasInfo(sid) {
    const list = this.load().info[sid];
    return !!(list && list.length);
  }

  takeInfo(sid) {
    const r = this.load();
    const list = r.info[sid];
    if (!list || !list.length) return null;
    delete r.info[sid];
    this.save(r);
    return prompts.message('kullanici-mesaji', { metin: list.map((t) => `- ${t}`).join('\n'), cevap: false, bilgi: true });
  }

  // Yenilenen üyenin bekleyenleri yeni oturuma geçer.
  reassign(from, to) {
    const r = this.load();
    let changed = false;
    for (const key of ['msgs', 'info']) {
      if (!r[key][from]) continue;
      r[key][to] = (r[key][to] || []).concat(r[key][from]);
      delete r[key][from];
      changed = true;
    }
    if (changed) this.save(r);
  }

  reply(sid, name, group, text) {
    const r = this.load();
    const item = { id: ++r.seq, ts: Date.now(), sid, name, group, text: String(text || '').trim().slice(0, MAX_TEXT), read: false };
    r.replies.push(item);
    if (r.replies.length > MAX_REPLIES) r.replies = r.replies.slice(-MAX_REPLIES);
    this.save(r);
    return item;
  }

  // all: okunmuşlar dahil son 20; değilse okunmamışlar okundu işaretlenip döner.
  replies(all = false) {
    const r = this.load();
    if (all) return r.replies.slice(-20);
    const out = r.replies.filter((x) => !x.read);
    if (out.length) {
      for (const x of out) x.read = true;
      this.save(r);
    }
    return out;
  }

  // Üye ts'den sonra asistana_yanit ile cevap verdi mi (zamanlayıcının "cevapları bekle" adımı).
  repliedSince(sid, ts) {
    return this.load().replies.some((x) => x.sid === sid && x.ts >= ts);
  }

  unread() {
    return this.load().replies.filter((x) => !x.read).length;
  }
}

module.exports = { Inbox };
