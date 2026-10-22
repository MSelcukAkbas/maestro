# Skill kaynakları

Bu klasördeki skill'ler dış repolardan kopyalanıp panele uyarlandı. Güncellemek için kayıtlı commit ile kaynağın
güncel hali arasındaki farka bakılır, uyarlamalar korunarak elle aktarılır.

## addyosmani/agent-skills

- Kaynak: https://github.com/addyosmani/agent-skills
- Commit: `aeac41d4d005999432bb7312f7ff06383a91d59d` (v0.6.13, 2026-10-13)
- Lisans: MIT — `LICENSE-agent-skills`

| Skill | Önerilen rol |
|---|---|
| planning-and-task-breakdown | şef |
| spec-driven-development | şef |
| code-review-and-quality | review |
| security-and-hardening | güvenlik |
| test-driven-development | test |
| debugging-and-error-recovery | debug |
| code-simplification | kod kalitesi |
| frontend-ui-engineering | frontend |

### Uyarlamalar

- Panel her skill'i ayrı klasör olarak oturuma kopyalar; kaynaktaki `../../references/*.md` bağlantıları kırılacağından
  gereken ortak dosyalar skill'in kendi `references/` klasörüne alındı ve yollar `references/<dosya>` yapıldı:
  - planning-and-task-breakdown ← definition-of-done.md
  - code-review-and-quality ← security-checklist.md, performance-checklist.md
  - security-and-hardening ← security-checklist.md (`hardening-patterns.md` içindeki yol da düzeltildi)
  - test-driven-development ← testing-patterns.md
  - frontend-ui-engineering ← accessibility-checklist.md
