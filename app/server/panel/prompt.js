// Üyenin sistem istemi (data/prompts/<oturum>.md): prompts/shared/*.md bölümleri ad sırasıyla bu oturumun değerleriyle
// doldurulur (kimlik, rol talimatı, ekip, iletişim / pano / not kuralları; şefe ek orkestrasyon ve ekip yönetimi).
// Sunucu bağlamına bağlı değildir (hesap listesi parametreyle gelir); tek başına yüklenebilir.
const fs = require('fs');
const path = require('path');

const store = require('../core/store');
const prompts = require('../core/prompts');
const { MODEL_TEXT } = require('../core/options');

const PERMISSION_TEXT = {
  manual: 'her işlemde sorar',
  acceptEdits: 'dosya düzenlemelerini kendisi kabul eder',
  auto: 'otomatik',
  plan: 'plan modu (değişiklik yapmadan önce plan sunar)',
};

function permissionOf(group, s) {
  return s.permissionMode || group.permissionMode;
}

function accountName(accounts, id) {
  const a = accounts.find((x) => x.id === id);
  return a ? a.name : id;
}

function namesOf(group, ids) {
  return ids.map((id) => group.sessions.find((s) => s.id === id)).filter(Boolean).map((s) => s.name);
}

// Şef rolündeki oturum ekibi yönetir; ona her üyenin tam görevi verilir.
function isLead(group, s) {
  const lead = group.sessions.find((x) => x.roleId === 'sef' && !x.removed);
  return lead ? lead.id === s.id : false;
}

// Oturum kaydındaki talimat yalnızca kurulumda bu ekip için yazılmışsa (ya da anlık rolse) doludur; değilse rolün
// klasöründeki güncel talimat kullanılır, böylece prompt.md düzenlemesi yeni / yenilenen oturuma geçer.
function rolePromptOf(s) {
  if (s.rolePrompt) return s.rolePrompt;
  const role = s.roleId === 'custom' ? null : prompts.role(s.roleId);
  return (role && role.prompt) || '(talimat yok)';
}

function memberLine(group, m, self, accounts) {
  const reports = namesOf(group, m.reportsTo);
  const parts = [
    `${m.roleLabel}`,
    `hesap ${accountName(accounts, m.accountId)}`,
    `model ${MODEL_TEXT[m.model] || 'hesap varsayılanı'}`,
    `izin: ${PERMISSION_TEXT[permissionOf(group, m)] || permissionOf(group, m)}`,
  ];
  const tail = [];
  if (reports.length) tail.push(`rapor verir: ${reports.join(', ')}`);
  if (m.talkAll) tail.push('herkesle konuşur');
  return `- **${m.name}**${m.id === self.id ? ' (sen)' : ''} — ${parts.join(' · ')}${tail.length ? `. ${tail.join('; ')}` : ''}`;
}

// Şablon değişkenleri; adları ve anlamları prompts/README.md'de.
function promptVars(fullGroup, session, project, accounts) {
  // Gruptan çıkarılan üyeler ekip listesinde yer almaz.
  const group = { ...fullGroup, sessions: fullGroup.sessions.filter((s) => !s.removed || s.id === session.id) };
  const lead = isLead(group, session);
  const others = group.sessions.filter((s) => s.id !== session.id);
  return {
    grup: group.name,
    ad: session.name,
    rol: session.roleLabel,
    hesap: accountName(accounts, session.accountId),
    model: MODEL_TEXT[session.model] || 'hesap varsayılanı',
    effort: session.effort || '',
    izin: PERMISSION_TEXT[permissionOf(group, session)] || permissionOf(group, session),
    proje: project.path,
    rolTalimati: rolePromptOf(session),
    ekip: group.sessions.map((m) => memberLine(group, m, session, accounts)).join('\n'),
    sef: lead,
    sefEkipli: lead && others.length > 0,
    uyeGorevleri: lead ? others.map((m) => `### ${m.name} — ${m.roleLabel}\n${rolePromptOf(m)}`).join('\n') : '',
    raporVerdiklerin: namesOf(group, session.reportsTo).join(', '),
    raporVerenler: group.sessions.filter((s) => s.reportsTo.includes(session.id)).map((s) => s.name).join(', '),
    herkesle: !!session.talkAll,
    dokumanlar: project && (project.docRefs || []).length ? project.docRefs.map((r) => path.join(project.path, r)).join(', ') : '',
    akisNotu: group.flowNote || '',
  };
}

function buildPrompt(group, session, project, accounts) {
  const vars = promptVars(group, session, project, accounts);
  const body = prompts.sharedSections().map((t) => prompts.render(t, vars)).filter(Boolean).join('\n');
  // Başlıkların önünde tek boş satır; şablondaki diğer boş satırlar render'da atılır.
  return body.replace(/\n(#+ )/g, '\n\n$1') + '\n';
}

function writePromptFile(group, session, project, accounts) {
  const file = path.join(store.PROMPT_DIR, `${session.id}.md`);
  fs.writeFileSync(file, buildPrompt(group, session, project, accounts), 'utf8');
  return file;
}

module.exports = { PERMISSION_TEXT, permissionOf, rolePromptOf, buildPrompt, writePromptFile };
