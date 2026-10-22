# Skill kaynakları

Bu klasördeki skill'ler panelle gelen, role özel genel bilgidir: projeden bağımsızdır, rolün alanını (ör. backend'e API
tasarımı) anlatır. Projeye özel talimat ayrıdır (rol talimatı, kurulum optimizer'ı projeye göre düzenler).

Dış kaynaklı skill'ler kopyalanıp panele uyarlandı. Güncellemek için kayıtlı commit ile kaynağın güncel hali
arasındaki farka bakılır, uyarlamalar korunarak elle aktarılır.

## Rol eşleştirmesi

Panelin okuduğu varsayılan eşleştirme `roles.json`'dadır; bu tablo onun okunur hâlidir, değişince ikisi birlikte
güncellenir. Kullanıcının Ayarlar → Yetenekler'de yaptığı rol değişikliği `data/caps.json` (`builtinRoles`) içine
varsayılandan fark olarak yazılır, bu dosyalara dokunmaz.

| Rol (id) | Skill | Kaynak |
|---|---|---|
| Orkestra şefi (`sef`) | planning-and-task-breakdown, spec-driven-development | agent-skills |
| Coder (genel) (`coder`) | incremental-implementation | agent-skills |
| Backend (`backend`) | api-and-interface-design, observability-and-instrumentation | agent-skills |
| Frontend (`frontend`) | frontend-ui-engineering | agent-skills |
| Android (`android`) | android-app-engineering | panel |
| Review (`review`) | code-review-and-quality | agent-skills |
| Debug (`debug`) | debugging-and-error-recovery | agent-skills |
| Kod kalitesi (`kalite`) | code-simplification | agent-skills |
| Araştırma (`arastirma`) | source-driven-development | agent-skills |
| Ops (`ops`) | ci-cd-and-automation | agent-skills |
| Şeytanın avukatı (`avukat`) | doubt-driven-development | agent-skills |
| Test / QA (`test`) | test-driven-development | agent-skills |
| Güvenlik (`guvenlik`) | security-and-hardening | agent-skills |
| Dokümantasyon (`dokuman`) | documentation-and-adrs | agent-skills |

Her role 1–2 skill verilir: her skill'in açıklaması her istekte bağlamdadır (~120 token), gövdesi yalnızca skill
çağrılınca okunur.

## Panel (kendi skill'lerimiz)

- **android-app-engineering** — sıfırdan yazıldı (2026-10-22), agent-skills yapısında. Sürüme bağlı ayrıntı (API seviyesi
  davranış değişiklikleri, kütüphane sürümleri, Play politikaları) bilerek yazılmadı; skill bunları resmî dokümandan
  doğrulamayı şart koşar.

## addyosmani/agent-skills

- Kaynak: https://github.com/addyosmani/agent-skills
- Commit: `aeac41d4d005999432bb7312f7ff06383a91d59d` (v0.6.13, 2026-10-13)
- Lisans: MIT — `LICENSE-agent-skills`

### Uyarlamalar

- **Ortak referanslar:** Panel her skill'i ayrı klasör olarak oturuma kopyalar; kaynaktaki `../../references/*.md`
  bağlantıları kırılacağından gereken ortak dosyalar skill'in kendi `references/` klasörüne alındı ve yollar
  `references/<dosya>` yapıldı:
  - planning-and-task-breakdown, incremental-implementation ← definition-of-done.md
  - code-review-and-quality ← security-checklist.md, performance-checklist.md
  - security-and-hardening ← security-checklist.md (`hardening-patterns.md` içindeki yol da düzeltildi)
  - test-driven-development ← testing-patterns.md
  - frontend-ui-engineering ← accessibility-checklist.md
  - observability-and-instrumentation ← observability-checklist.md
- **Görev listesi ve plan:** planning-and-task-breakdown ve spec-driven-development'ta görev listesi panel ekibinde
  görev panosuna (`pano_ekle`, kart başına bir görev, panel kartı üyeye iletir), plan dokümanı grup notuna (`not_ekle`)
  yazılır; panel dışında kaynaktaki `tasks/plan.md` / `tasks/todo.md` geçerli. Panelde olmayan `/build` komutuna atıflar
  ve "şef kod yazmaz" ile çelişen uygulama adımı uyarlandı.
- **doubt-driven-development:** Codex / Gemini CLI ile model dışı ikinci görüş bölümü çıkarıldı (panel yalnızca Claude
  kullanır); yerine yüksek riskli kararda gözden geçiren alt ajanı farklı bir Claude modelinde çalıştırma kondu. Her
  döngüde kullanıcıya soru sorma kuralı kaldırıldı (kullanıcı genelde yalnızca şefin terminalini okur); bulgular panelin
  rapor kanallarıyla iletilir. Repoda olmayan `agents/` listesi ve `orchestration-patterns.md` atıfları çıkarıldı;
  `/review` atıfları `code-review-and-quality`'ye çevrildi.
- **Kopyalanmayan skill'lere atıflar çıkarıldı:** api-and-interface-design ← deprecation-and-migration;
  spec-driven-development ← incremental-implementation, context-engineering; code-review-and-quality ←
  performance-optimization, constraint-driven-development; security-and-hardening ← observability-and-instrumentation
  (o zaman kopyalanmamıştı); test-driven-development ← browser-testing-with-devtools; observability-and-instrumentation ←
  performance-optimization, shipping-and-launch; incremental-implementation ← git-workflow-and-versioning.
- Skill açıklamaları (`description`, her istekte bağlamda) değiştirilmedi.
