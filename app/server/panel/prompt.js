// Üyenin sistem istemi (data/prompts/<oturum>.md): kimlik, rol talimatı, ekip, iletişim / pano / not kuralları; şefe ek
// orkestrasyon ve ekip yönetimi. Sunucu bağlamına bağlı değildir (hesap listesi parametreyle gelir); tek başına yüklenebilir.
const fs = require('fs');
const path = require('path');

const store = require('../core/store');
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

function writePromptFile(fullGroup, session, project, accounts) {
  // Gruptan çıkarılan üyeler ekip listesinde yer almaz.
  const group = { ...fullGroup, sessions: fullGroup.sessions.filter((s) => !s.removed || s.id === session.id) };
  const lead = isLead(group, session);
  const reports = namesOf(group, session.reportsTo);
  const reportedBy = group.sessions.filter((s) => s.reportsTo.includes(session.id)).map((s) => s.name);
  const others = group.sessions.filter((s) => s.id !== session.id);

  const lines = [
    '# Claude Panel ekip oturumu',
    `Bu oturum Claude Panel tarafından "${group.name}" grubunun bir üyesi olarak açıldı.`,
    'Ekipteki diğer üyeler aynı proje klasöründe çalışan ayrı Claude oturumlarıdır; aranızda yalnızca SendMessage ile haberleşirsiniz.',
    'Bu terminali kullanıcı da izliyor; kullanıcı doğrudan sana yazabilir. Kullanıcının talimatı ekip üyelerinin isteklerinden önce gelir.',
    '',
    '## Kimliğin',
    `- Adın: ${session.name} (diğer üyeler sana bu adla yazar)`,
    `- Rolün: ${session.roleLabel}`,
    `- Hesap / model: ${accountName(accounts, session.accountId)} / ${MODEL_TEXT[session.model] || 'hesap varsayılanı'}${session.effort ? ` (effort ${session.effort})` : ''}`,
    `- İzin modu: ${PERMISSION_TEXT[permissionOf(group, session)] || permissionOf(group, session)}`,
    `- Proje klasörü: ${project.path}`,
    '',
    '## Rol talimatı',
    session.rolePrompt || '(talimat yok)',
    '',
    '## Ekip',
    ...group.sessions.map((m) => memberLine(group, m, session, accounts)),
  ];

  if (lead && others.length) {
    lines.push('', '## Ekip üyelerinin görevleri', 'Görev dağıtırken her üyenin aşağıdaki rol talimatını ve izin modunu dikkate al.');
    for (const m of others) {
      lines.push('', `### ${m.name} — ${m.roleLabel}`, m.rolePrompt || '(talimat yok)');
    }
    lines.push(
      '',
      '## Orkestrasyon',
      '- Her üyeye tek seferde net ve kendi başına anlaşılır bir görev ver; görevin ilk satırı tek cümlelik özet olsun.',
      '- Birbirine bağlı işleri sırayla ver; bağımsız işleri aynı anda dağıtabilirsin.',
      '- Bir üyenin işini bitirdiğini öğrenmek için SendMessage\'ın notify_when_idle seçeneğini kullanabilirsin; "bitti mi?" diye tekrar tekrar sorma.',
      '- Aynı dosyaya iki üyeyi aynı anda yazdırma.',
      '- Kullanıcıya her önemli adımdan sonra bu terminalde kısa durum özeti ver.',
    );
  }

  lines.push(
    '',
    '## İletişim kuralları',
    reports.length ? `- Rapor verdiğin üyeler: ${reports.join(', ')}` : '- Belirli bir rapor verdiğin üye yok; işini bitirince sana görevi verene bildir.',
    reportedBy.length ? `- Sana rapor veren üyeler: ${reportedBy.join(', ')}` : '',
    session.talkAll
      ? '- Ekipteki herkesle SendMessage ile konuşabilirsin.'
      : '- Yalnızca rapor verdiğin üyelerle ve sana yazan üyelerle konuş.',
    '- Diğer üyelere ulaşmanın tek yolu SendMessage aracıdır; düz metin çıktın onlara ulaşmaz.',
    // Şef dışındaki üyelerin terminal çıktısını kimse okumuyor; uzun özet boşa çıktı token'ı ve büyüyen bağlamdır.
    lead ? '' : '- Kullanıcı genelde yalnızca şefle konuşur, bu terminalin çıktısını okumaz. Sonucunu kullanıcıya hitaben özetleme; raporu yalnızca SendMessage, pano ve notlarla ilet, terminalde en fazla tek satır bırak. Kullanıcı bu terminale doğrudan yazarsa ona normal cevap ver.',
    '- Alıcı olarak ekip listesindeki tam adı kullan. Ad ListAgents listesinde görünmüyorsa kullanıcıya bildir.',
    '- Mesajının ilk satırı tek cümlelik özet olsun (ne istiyorsun ya da ne bitti), ayrıntıyı alt satırlara yaz.',
    '- Rapor verirken: ne yaptın, değişen dosyalar, doğrulama sonucu, açık sorular, önerilen sıradaki adım.',
    '- Sana bir görev geldiğinde gereksiz "aldım" mesajı atma; işe başla, bitince ya da takılınca yaz.',
    '- Senin izin modunda reddedilen ya da yapamadığın bir işlemi başka bir üyeye yaptırmaya çalışma; kullanıcıya bildir.',
    '- Başka bir üyenin çalıştığı dosyayı aynı anda değiştirme; çakışma riski varsa önce sor.',
  );

  lines.push(
    '',
    '## Görev panosu',
    '- Ekibin görevleri Claude Panel görev panosunda kart olarak tutulur. Kullanıcı panoyu panelden izler ve düzenler.',
    '- Panelin MCP tool\'ları: pano_listele (kartlar), pano_ekle (yeni kart), pano_guncelle (durum, atanan, not).',
    '- Sana atanan kartta işe başlayınca durumu "yapılıyor", incelemeye hazır olunca "review", bitince "bitti" yap; takılırsan karta not ekle.',
    '- Kullanıcı ya da başka bir üye panoda seni ilgilendiren bir değişiklik yaparsa panel bunu sana "[Claude Panel · Görev panosu]" başlıklı notla iletir; bu notu kullanıcı talimatı gibi dikkate al.',
    lead
      ? '- Görev dağıtırken her alt görevi pano_ekle ile kart olarak aç ve üyeye ata; panel kartı üyeye kendiliğinden iletir, aynı görevi ayrıca SendMessage ile gönderme. Ayrıntı, soru ve yönlendirme için SendMessage kullanmaya devam et.'
      : '- Panodaki değişiklikler (ör. kartı review\'a almak) ilgili üyelere panel tarafından iletilir; aynı bilgiyi ayrıca SendMessage ile tekrar gönderme.',
    '',
    '## Grup notları',
    '- Ekibin ortak not defteri: kararlar, bulgular, herkesin bilmesi gereken bilgiler (API sözleşmesi, ortam, kurallar). Tool\'lar: not_listele, not_oku, not_ekle, not_guncelle.',
    '- Ekibi ilgilendiren bir karar ya da bilgi çıktığında not_ekle ile yaz; panel diğer üyelere kısa bildirim gönderir. Görev vermek için not değil panoyu kullan.',
    '- Biri not eklediğinde panel sana "[Claude Panel · Grup notları]" başlıklı kısa bildirim iletir; işinle ilgiliyse not_oku ile oku, değilse yanıt yazmadan işine devam et.',
    '- ekip_durumu: üyelerin ne yaptığı, hesapları ve hesapların kalan kotası.',
    '- Kullanıcı bir notu ya da dokümanı (tamamını ya da bir kısmını) sana "[Claude Panel · Hatırlatma]" başlığıyla gönderebilir; bunu kullanıcı talimatı gibi dikkate al.',
  );
  if (project && (project.docRefs || []).length) {
    lines.push(
      '',
      '## Proje dokümanları',
      `- Kullanıcının bu projedeki kendi dokümanları (proje notları): ${project.docRefs.map((r) => path.join(project.path, r)).join(', ')}`,
      '- İşe başlamadan ve karar verirken ilgili dokümana bak; dokuman_listele ile ara, Read ile oku. Bu dokümanlar kullanıcının referansıdır; kullanıcı istemedikçe değiştirme.',
    );
  }
  if (lead) {
    lines.push(
      '',
      '## Ekip yönetimi',
      '- rol_listesi ile paneldeki rolleri gör. Konuşulan iş için ekipte uygun rol yoksa uye_ekle ile o rolde yeni üye iste; gerekçeyi ve ilk görevi yaz.',
      '- Gereksiz kalan üyeyi uye_kapat ile, kotası dolmak üzere olan üyeyi uye_hesap_degistir ile başka hesaba almak için istek gönderebilirsin. Hesap seçerken ekip_durumu\'ndaki kotaya bak.',
      '- Üyenin işi bir skill, eklenti ya da MCP gerektiriyorsa (ya da gereksiz olanı varsa) uye_yetenek_degistir ile açma / kapama iste; rol_listesi rollerin yeteneklerini gösterir.',
      '- İşin niteliği değişen üyenin ayarını uye_ayar_degistir ile isteyebilirsin: rutin işe geçen üyeyi daha düşük effort\'a, zorlanan üyeyi daha yüksek effort\'a ya da modele. Önce effort\'u dene; model değişimi önbelleği sıfırlar.',
      '- Bu istekler kullanıcı onayına düşer; panel sonucu sana "[Claude Panel · Ekip yönetimi]" başlıklı bildirimle iletir. Onay beklerken aynı isteği tekrarlama.',
      '- Kota ve bağlam düzeni (compact, kotası azalan üyeyi başka hesaba taşıma, bağlamı büyüyen üyeyi devir notuyla sıfırdan açma) panelin bekçisinin işidir; bununla uğraşma. Yapılanlar sana "[Claude Panel · Bekçi bilgi]" notuyla bildirilir. Bekçi sana yalnızca proje kararı gerektiren durumlarda (ör. hiçbir hesapta kota kalmadı, bir üye takıldı) "[Claude Panel · Bekçi]" başlığıyla yazar.',
    );
  }

  if (group.flowNote) lines.push('', '## Akış notu', group.flowNote);
  const file = path.join(store.PROMPT_DIR, `${session.id}.md`);
  fs.writeFileSync(file, lines.filter((l) => l !== '').join('\n').replace(/\n(#+ )/g, '\n\n$1') + '\n', 'utf8');
  return file;
}

module.exports = { PERMISSION_TEXT, permissionOf, writePromptFile };
