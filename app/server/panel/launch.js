// Oturum açma ve üye kaydı: grup kurma, üye ekleme, açılış (launchSession), yenileme (devir), hesap ve ayar değişikliği.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const store = require('../core/store');
const prompts = require('../core/prompts');
const discovery = require('../core/discovery');
const { writeSettingsFile, writeMcpConfig } = require('../session/hooks');
const { driftOf } = require('../session/pending');
const { MODELS, EFFORTS, PERMISSION_MODES } = require('../core/options');
const { permissionOf, writePromptFile } = require('./prompt');
const ctx = require('./context');

const {
  ROOT, PORT, settings, hookState, manager, boards, caps, notes, requests, meter, launched, pending,
  HttpError, isAllowedDir, sharedConfigDir, hhmm, cleanText, findSession, meterTick, whenStopped,
} = ctx;

function switchAccount(sessionId, accountId) {
  const account = settings.accounts.find((a) => a.id === accountId);
  if (!account) throw new HttpError(400, 'Hesap bulunamadı.');
  const groups = store.loadGroups();
  const found = findSession(groups, sessionId);
  if (!found) throw new HttpError(404, 'Oturum bulunamadı.');
  const { group, session } = found;
  if (session.accountId === account.id) return { ok: true, unchanged: true };
  const wasRunning = manager.has(session.id);
  // Önceki harcama eski hesaba yazılsın, ardından taşımanın maliyeti yeni hesapta ölçülsün.
  try {
    meterTick();
    meter.noteSwitch(session, discovery.transcriptPath(sharedConfigDir(), session.id), session.accountId, account.id);
  } catch (err) { console.error('[panel] ölçüm:', err.message); }
  session.accountId = account.id;
  store.saveGroups(groups);
  if (wasRunning) {
    manager.stop(session.id);
    whenStopped(session.id, (err) => {
      if (err) return console.error(`[panel] ${session.name}:`, err.message);
      try { launchSession(group, session, { resume: true }); } catch (e) { console.error(`[panel] ${session.name}:`, e.message); }
    });
  }
  return { ok: true, restarted: wasRunning };
}

// Üyenin model / effort ayarını değiştirir. Kayıt hemen güncellenir (sonraki açılış yeni ayarla olur); çalışan üye
// bekleyen değişiklik olarak en ucuz anda kaldığı yerden yeniden açılır (server/pending.js). now: beklemeden uygula.
function changeSettings(sessionId, body, by = 'user') {
  const groups = store.loadGroups();
  const found = findSession(groups, sessionId);
  if (!found || found.session.removed) throw new HttpError(404, 'Oturum bulunamadı.');
  const { group, session } = found;
  const change = {};
  if (body.model !== undefined) {
    if (body.model !== '' && !MODELS.includes(body.model)) throw new HttpError(400, `Geçersiz model: ${body.model}`);
    if ((session.model || '') !== body.model) change.model = body.model || 'varsayılan';
    session.model = body.model;
  }
  if (body.effort !== undefined) {
    if (body.effort !== '' && !EFFORTS.includes(body.effort)) throw new HttpError(400, `Geçersiz effort: ${body.effort}`);
    if ((session.effort || '') !== body.effort) change.effort = body.effort || 'varsayılan';
    session.effort = body.effort;
  }
  store.saveGroups(groups);
  if (!manager.has(session.id)) return { ok: true, running: false };
  if (!Object.keys(change).length && !body.now) return { ok: true, running: true, unchanged: true };
  const p = pending.add(session.id, group.id, change, by, !!body.now);
  return { ok: true, running: true, pending: p };
}

// Bekleyen değişikliği iptal eder: kayıt çalışan oturumun ayarına döner.
function cancelSettings(sessionId) {
  const groups = store.loadGroups();
  const found = findSession(groups, sessionId);
  const run = launched.get(sessionId);
  if (found && run) {
    found.session.model = run.model || '';
    found.session.effort = run.effort || '';
    store.saveGroups(groups);
  }
  pending.remove(sessionId);
  return { ok: true };
}

// İstenen ayarla gerçekleşen arasındaki farklar (boşsa uyumlu). Model ve effort ilk yanıttan, skill listesi açılıştan
// sonra yazılan listeden okunur; devam ettirilen oturumda liste ancak compact'tan sonra yenilenir, o zamana kadar bakılmaz.
function launchDrift(sid) {
  return driftOf(launched.get(sid), meter.sessionInfo(sid));
}

function launchSession(group, session, { resume }) {
  const project = store.loadProjects().find((p) => p.id === group.projectId);
  if (!project) throw new HttpError(404, 'Proje bulunamadı.');
  if (!isAllowedDir(project.path)) throw new HttpError(403, 'Proje klasörü izinli klasörlerin dışında.');
  const account = settings.accounts.find((a) => a.id === session.accountId);
  if (!account) throw new HttpError(400, `Hesap bulunamadı: ${session.accountId}`);

  // Hiç başlamamış bir oturum devam ettirilemez; aynı kimlikle yeniden açılır.
  const canResume = resume && !!discovery.transcriptPath(sharedConfigDir(), session.id);
  const taskFile = !canResume && session.taskFile && !session.taskSent ? session.taskFile : null;
  hookState.clear(session.id);
  // Anlık rollü oturum (custom) yalnızca global yetenekleri olduğu gibi alır.
  const cap = caps.forSession(session.id, session.roleId, session.caps);
  // Salt okunur rol: talimattaki "dosya değiştirme" kuralı izinle de uygulanır.
  const role = settings.roles.find((r) => r.id === session.roleId);
  if (role && role.readOnly) cap.settings.deny.push(...READ_ONLY_DENY);
  // Açılış kayıttaki güncel ayarı kullanır; bu üyenin bekleyen değişikliği böylece uygulanmış olur.
  pending.remove(session.id);
  // İstenen ayar: oturum kaydından gerçekleşenle karşılaştırılır (launchDrift).
  launched.set(session.id, {
    at: Date.now(), model: session.model || null, effort: session.effort || null,
    skillsOff: Object.entries(cap.settings.skillOverrides).filter(([, v]) => v === 'off').map(([k]) => k),
  });

  manager.launch({
    id: session.id,
    name: session.name,
    cwd: project.path,
    configDir: account.configDir,
    resume: canResume,
    permissionMode: permissionOf(group, session),
    model: session.model || undefined,
    effort: session.effort || undefined,
    promptFile: session.promptFile,
    taskFile,
    settingsFile: writeSettingsFile(store.DATA_DIR, PORT, session.id, cap.settings),
    mcpConfig: writeMcpConfig(store.DATA_DIR, PORT, session.id, cap.mcpServers),
    addDir: cap.addDir,
  });
  return { taskSent: !!taskFile };
}

function markTaskSent(groupId, sessionId) {
  const groups = store.loadGroups();
  const g = groups.find((x) => x.id === groupId);
  const s = g && g.sessions.find((x) => x.id === sessionId);
  if (s) {
    s.taskSent = true;
    store.saveGroups(groups);
  }
}

function startSessions(group, sessions, resume) {
  sessions.forEach((s, i) => {
    setTimeout(() => {
      try {
        const r = launchSession(group, s, { resume });
        if (r.taskSent) markTaskSent(group.id, s.id);
      } catch (err) {
        console.error(`[panel] ${s.name} başlatılamadı:`, err.message);
      }
    }, i * 400);
  });
}

// Akış notundaki "proje · rol · hesap · HHmm" adlarını gerçek adlarla eşitler. Aynı öneke sahip birden çok satır varsa
// hangisinin kastedildiği bilinemez; o önek olduğu gibi bırakılır.
function fixFlowNames(text, renames) {
  const counts = new Map();
  for (const r of renames) counts.set(r.prefix, (counts.get(r.prefix) || 0) + 1);
  for (const r of renames) {
    if (counts.get(r.prefix) !== 1) continue;
    const re = new RegExp(r.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' · \\d{4}(?: #\\d+)?', 'g');
    text = text.replace(re, r.name);
  }
  return text;
}

const READ_ONLY_DENY = ['Edit', 'Write', 'NotebookEdit'];

// Kurulum satırından oturum kaydı üretir. Satırda seçim yoksa rolün varsayılan modeli / izin modu kullanılır;
// izin modu boş kalırsa grubun varsayılanı geçerli olur.
function buildSession(r, project, usedNames, time) {
  const account = settings.accounts.find((a) => a.id === r.accountId);
  if (!account) throw new HttpError(400, `Hesap bulunamadı: ${r.accountId}`);
  let roleLabel, roleShort, rolePrompt, roleId, roleMode = '', roleModel = '', roleEffort = '';
  if (r.roleId === 'custom') {
    roleId = 'custom';
    roleLabel = cleanText(r.customLabel, 40);
    if (!roleLabel) throw new HttpError(400, 'Anlık rol için rol adı gerekli.');
    roleShort = roleLabel;
    rolePrompt = String(r.customPrompt || '');
  } else {
    const role = settings.roles.find((x) => x.id === r.roleId);
    if (!role) throw new HttpError(400, `Rol bulunamadı: ${r.roleId}`);
    roleId = role.id;
    roleLabel = role.label;
    roleShort = role.short || role.label;
    // Kurulumda bu ekip için düzenlenen talimat rolün talimatının yerine geçer. Boşsa istem yazılırken rolün
    // klasöründeki güncel talimat kullanılır (panel/prompt.js rolePromptOf).
    rolePrompt = typeof r.prompt === 'string' && r.prompt.trim() ? r.prompt.trim() : '';
    roleMode = role.permissionMode || '';
    roleModel = role.model || '';
    roleEffort = role.effort || '';
  }
  const mode = r.permissionMode === undefined ? roleMode : r.permissionMode;
  const model = r.model === undefined ? roleModel : r.model;
  const effort = r.effort === undefined ? roleEffort : r.effort;
  const namePrefix = `${project.name} · ${roleShort} · ${account.id}`;
  const base = `${namePrefix} · ${time}`;
  let name = base;
  for (let n = 2; usedNames.has(name); n++) name = `${base} #${n}`;
  usedNames.add(name);
  return {
    id: crypto.randomUUID(),
    name,
    namePrefix,
    roleId,
    roleLabel,
    rolePrompt,
    permissionMode: PERMISSION_MODES.includes(mode) ? mode : '',
    accountId: account.id,
    model: MODELS.includes(model) ? model : '',
    effort: EFFORTS.includes(effort) ? effort : '',
    talkAll: !!r.talkAll,
    reportsTo: [],
    ...(capsOverride(r.caps) ? { caps: capsOverride(r.caps) } : {}),
  };
}

// Kurulum satırındaki yetenek ayarı: rol varsayılanının üstüne açılan / kapatılan anahtarlar.
function capsOverride(c) {
  if (!c || typeof c !== 'object') return null;
  const keys = (l) => (Array.isArray(l) ? [...new Set(l.map((k) => cleanText(k, 200)).filter((k) => /^(plugin|skill|mcp|pmcp|pskill):./.test(k)))] : []);
  const on = keys(c.on);
  const off = keys(c.off).filter((k) => !on.includes(k));
  return on.length || off.length ? { on, off } : null;
}

// Çalışan bir gruba yeni üye ekler. Mevcut üyelerin talimatı açılışta kaydedildiği için değişmez;
// bu yüzden yeni üye ilk iş olarak kendini ilgili üyelere SendMessage ile tanıtır.
function addSessionToGroup(groupId, body) {
  const groups = store.loadGroups();
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw new HttpError(404, 'Grup bulunamadı.');
  const project = store.loadProjects().find((p) => p.id === group.projectId);
  if (!project) throw new HttpError(404, 'Proje bulunamadı.');
  if (group.sessions.filter((s) => !s.removed).length >= 12) throw new HttpError(400, 'Bir grupta en fazla 12 oturum olabilir.');
  const r = body.row || {};
  const usedNames = new Set(groups.flatMap((g) => g.sessions.map((s) => s.name)));
  const s = buildSession(r, project, usedNames, hhmm());
  delete s.namePrefix;
  const members = group.sessions.filter((m) => !m.removed);
  s.reportsTo = (Array.isArray(r.reportsTo) ? r.reportsTo : []).filter((id) => members.some((m) => m.id === id));
  group.sessions.push(s);
  s.promptFile = writePromptFile(group, s, project, settings.accounts);

  const task = String(body.firstTask || '').trim();
  let targets = [];
  if (body.introduce !== false && members.length) {
    const lead = members.find((m) => m.roleId === 'sef');
    targets = s.talkAll
      ? members.filter((m) => manager.has(m.id))
      : members.filter((m) => (lead && m.id === lead.id) || s.reportsTo.includes(m.id));
  }
  const parts = [
    prompts.message('yeni-uye', { tanitilacaklar: targets.map((m) => m.name).join(', '), gorev: task }),
    task ? prompts.message('ilk-gorev', { gorev: task.slice(0, 8000) }) : '',
  ].filter(Boolean);
  if (parts.length) {
    s.taskFile = path.join(store.PROMPT_DIR, `${s.id}.task.md`);
    fs.writeFileSync(s.taskFile, parts.join('\n\n'), 'utf8');
  }
  store.saveGroups(groups);
  startSessions(group, [s], false);
  return s;
}

function createGroup(body) {
  const project = store.loadProjects().find((p) => p.id === body.projectId);
  if (!project) throw new HttpError(404, 'Proje bulunamadı.');
  if (!isAllowedDir(project.path)) throw new HttpError(403, 'Proje klasörü izinli klasörlerin dışında.');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new HttpError(400, 'En az bir oturum satırı gerekli.');
  if (rows.length > 12) throw new HttpError(400, 'Bir grupta en fazla 12 oturum olabilir.');
  const permissionMode = PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : 'manual';

  const groups = store.loadGroups();
  const usedNames = new Set(groups.flatMap((g) => g.sessions.map((s) => s.name)));
  const time = hhmm();
  const keyToId = new Map();
  // Kurulum ekranı akış notunu tahmini adlarla yazar; dakika değiştiyse ya da ad çakıştıysa gerçek adla değiştirilir.
  const renames = [];

  const sessions = rows.map((r) => {
    const s = buildSession(r, project, usedNames, time);
    keyToId.set(r.key, s.id);
    renames.push({ prefix: s.namePrefix, name: s.name });
    delete s.namePrefix;
    s.reportsToKeys = Array.isArray(r.reportsTo) ? r.reportsTo : [];
    return s;
  });
  for (const s of sessions) {
    s.reportsTo = s.reportsToKeys.map((k) => keyToId.get(k)).filter((id) => id && id !== s.id);
    delete s.reportsToKeys;
  }

  const group = {
    id: crypto.randomUUID(),
    projectId: project.id,
    name: `${cleanText(body.name, 60) || `${project.name} ekibi`} · ${time}`,
    createdAt: Date.now(),
    archived: false,
    flowNote: fixFlowNames(String(body.flowNote || '').slice(0, 8000), renames),
    permissionMode,
    sessions,
  };
  for (const s of sessions) s.promptFile = writePromptFile(group, s, project, settings.accounts);

  const task = String(body.firstTask || '').trim();
  if (task) {
    const lead = sessions.find((s) => s.roleId === 'sef') || sessions[0];
    lead.taskFile = path.join(store.PROMPT_DIR, `${lead.id}.task.md`);
    fs.writeFileSync(lead.taskFile, task.slice(0, 8000), 'utf8');
  }

  groups.push(group);
  store.saveGroups(groups);
  const p = store.loadProjects();
  const pr = p.find((x) => x.id === project.id);
  if (pr) {
    pr.lastUsedAt = Date.now();
    store.saveProjects(p);
  }
  startSessions(group, sessions, false);
  return group;
}

// Üyeyi devir notuyla sıfır bağlamla yeniden açar: ad, rol, talimat, izin, model ve ekip ilişkileri aynı, oturum
// kimliği yeni. Eski oturum kapatılıp "yenilendi" olarak ekipten düşer; pano kartları, bekleyen bildirimler ve
// rapor ilişkileri yeni oturuma geçer. Ad aynı kaldığı için diğer üyeler ona aynı adla yazmaya devam eder.
function renewSession(oldSid, note, accountId) {
  const groups = store.loadGroups();
  const found = findSession(groups, oldSid);
  if (!found) throw new HttpError(404, 'Oturum bulunamadı.');
  const { group, session: old } = found;
  const project = store.loadProjects().find((p) => p.id === group.projectId);
  if (!project) throw new HttpError(404, 'Proje bulunamadı.');
  const s = { ...old, id: crypto.randomUUID(), accountId: accountId && settings.accounts.some((a) => a.id === accountId) ? accountId : old.accountId, reportsTo: [...(old.reportsTo || [])], renewedFrom: old.id };
  for (const key of ['promptFile', 'taskFile', 'taskSent', 'removed', 'renewedTo', 'renewedAt']) delete s[key];
  old.removed = true;
  old.renewedTo = s.id;
  old.renewedAt = Date.now();
  group.sessions.splice(group.sessions.indexOf(old), 1, s);
  group.sessions.push(old);
  for (const m of group.sessions) if (m !== old) m.reportsTo = (m.reportsTo || []).map((id) => (id === old.id ? s.id : id));
  s.promptFile = writePromptFile(group, s, project, settings.accounts);
  s.taskFile = path.join(store.PROMPT_DIR, `${s.id}.task.md`);
  // Devir notu şablona girmez: şablonda boş satır atıldığı için araya boş satırla altına eklenir.
  fs.writeFileSync(s.taskFile, `${prompts.message('devir-acilis', { ad: s.name })}\n\n${note}`, 'utf8');
  store.saveGroups(groups);
  boards.reassign(group.id, old.id, s.id);
  notes.reassign(group.id, old.id, s.id);
  requests.reassign(old.id, s.id);
  manager.stop(old.id);
  whenStopped(old.id, (err) => {
    if (err) console.error(`[panel] ${old.name}: eski oturum kapanmadı, yenisi yine de açılıyor.`);
    startSessions(group, [s], false);
  });
  return s.id;
}

function openInWindowsTerminal(session) {
  const attach = path.join(ROOT, 'attach.js');
  const child = spawn('wt.exe', ['-w', '0', 'new-tab', '--title', session.name, process.execPath, attach, session.id, String(PORT), store.DATA_DIR], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.on('error', (err) => console.error('[panel] Windows Terminal açılamadı:', err.message));
  child.unref();
}

module.exports = {
  switchAccount, changeSettings, cancelSettings, launchDrift, launchSession, startSessions, capsOverride,
  addSessionToGroup, createGroup, renewSession, openInWindowsTerminal,
};
