# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Proje

Claude Panel: birden çok Claude Code oturumunu rollere ayrılmış bir ekip olarak (orkestra şefi + coder/review/araştırma…) tek yerel web panelinden yöneten Node.js uygulaması. Yalnızca Windows'ta, yalnızca `127.0.0.1`'de çalışır. Kod, yorumlar, arayüz metinleri ve rol talimatları Türkçe; yeni kod da böyle yazılır. Derleme adımı yok: sunucu düz CommonJS, arayüz vanilla JS + xterm: `web/js/*.js` (core, projects, setup, work, settings, bekci, topbar, main) `index.html`'deki sırayla yüklenen klasik script'ler; üst düzey bildirimler ortak global kapsamda, yüklenirken çalışan kod yalnızca önceki dosyaları kullanabilir (açılış `main.js`'te, en son). Yeni dosya eklenirse `index.html` ve `server/panel/http.js` `STATIC` listesine de eklenir. Bağımlılıklar yalnızca `ws`, `@lydell/node-pty`, `@xterm/*`. Node ≥ 22. Yerel git deposu (uzak depo yok); `data/`, `.remember/`, `external resources/` (kaynak olarak indirilen dış repolar) depo dışında.

Klasör düzeni: panelin tamamı `app/` altında (`server/`, `web/`, `prompts/`, `skills/`, `test/`, `data/`, `node_modules/`, `package.json`, `attach.js`, `.bat`/`.vbs`); kökte yalnızca `app/`, `external resources/`, belgeler ve `.gitignore`. Bu dosyadaki tüm yollar ve komutlar `app/`'e göredir (komutları `app/` içinde çalıştır).

Sunucu modülleri `server/` altında konuya göre: `core/` (store, options, llm, ledger, transcript, discovery, usage, paths, prompts), `session/` (sessions, hooks, presence, pending), `team/` (board, notes, team, curator, docs, exporter, timeline), `watch/` (meter, quota, watch, helper, ops), `setup/` (caps, optimizer). Uygulama kökü yalnızca `core/paths.js` `APP_ROOT`'tan alınır; modül kökü kendi `__dirname`'inden hesaplamaz.

## Komutlar

```bash
npm start                      # node server/index.js (canlı panel, port 7788, veri: data/)
node --test test/unit.test.js  # birim testleri (model çağırmaz). Node 24'te `node --test test/` klasör kabul etmez, hata verir
node --test --test-name-pattern "<ad>" test/unit.test.js   # tek birim testi
node test/smoke.js             # ~74 API çağrısı, 7799'da geçici veriyle; 500 yok, panel ayakta (SMOKE_PC=1 → open-pc de)
node test/e2e.js [senaryo ...] # gerçek Claude oturumları açar, KOTA HARCAR (Haiku). Senaryolar: launch builtinskills paste settings teamcaps account curator curatormerge optimize roleopt
node --check server/<klasör>/<dosya>.js # hızlı sözdizimi kontrolü
```

- **Canlı panel (7788) ile test paneli (7799) ayrıdır.** `test/lib.js` paneli `CLAUDE_PANEL_DATA=<geçici klasör>` ve `CLAUDE_PANEL_PORT=7799` ile açar, canlı `data/settings.json`, `projects.json`, `caps.json`'u (varsa) ve `prompts/` klasörünü kopyalar (`CLAUDE_PANEL_PROMPTS`; Ayarlar'dan kayıt depodaki rol dosyalarına yazmasın); canlı veride yoksa deponun kökünü "claude-panel" projesi olarak ekler; gruplar boş başlar. Canlı veriye ve oturumlara dokunma.
- Canlı panel kullanıcının açık ekip oturumlarını barındırır; yeniden başlatmak hepsini kapatır. Yeni kod canlıda ancak yeniden başlatınca geçer (`Claude-Panel.bat` ya da arka planda `Claude-Panel-Arkaplan.vbs`; kapatma Ayarlar → "Sunucuyu kapat"). Yeniden başlatmayı kullanıcıya sormadan yapma; yapılmadıysa "canlıda doğrulanmadı" diye raporla.
- Değişiklikten sonra beklenen doğrulama: `node --test test/unit.test.js` + ilgili `node test/e2e.js <senaryo>`; API eklendiyse `test/smoke.js`'e de ekle.
- e2e oturumları deponun kökünde (`app/`'in bir üstü, `test/lib.js` `REPO`) açar; klasör git deposu olduğundan Claude Code güveni deponun kökünden sorar (üst klasör `Desktop`'ın güveni artık yetmez). Hesapta klasör güvenilir değilse oturumlar güven ekranında bekler ve e2e "skill listesi yok" / "ilk görev bitmedi" diye düşer.
- İlk görev (`firstTask`) gruptaki yalnızca şefe ya da ilk üyeye gider; diğer üyelerin oturum kaydı ilk mesaja kadar oluşmaz.
- Ortam değişkenleri: `CLAUDE_PANEL_DATA`, `CLAUDE_PANEL_PROMPTS`, `CLAUDE_PANEL_PORT`, `CLAUDE_PANEL_ROTATE_MS`, `CLAUDE_PANEL_HOOK_DEBUG`, `TEST_PANEL_PORT`, `E2E_ACCOUNT`, `SMOKE_PC`.
- `attach.js <oturum-id> [port] [veri]`: harici terminali paneldeki bir oturumun PTY'sine bağlar.

## Mimari

### Oturum yaşam döngüsü (panel/launch.js → session/sessions.js → session/hooks.js)
- `server/index.js` yalnızca parçaları bağlar ve tüm zamanlayıcıları kurar. Yapıştırıcı `server/panel/`: `context.js` (ayarlar, anahtar, modül örnekleri, ortak yardımcılar; `settings` nesnesinin kimliği sabit, `replaceSettings` yerinde günceller; anahtar `currentToken()`, kota önbelleği `lastQuota()` ile okunur), `prompt.js` (`writePromptFile`; sunucu bağlamına bağlı değil, tek başına yüklenir), `launch.js` (kurma, açılış, yenileme, hesap/ayar değişikliği), `delivery.js` (üyelere iletim), `members.js` (`memberSnapshot`, şef isteklerinin uygulanması), `ticks.js` (zamanlı işler), `state.js` (`buildState`), `http.js` (router `route(method, regex, handler)`, hook/MCP uçları, WebSocket `/ws`, `start()`). API uçları `server/routes/*.js` (require edilince kaydolur). Alt modüller birbirini çağırmaz; panel/ katmanından fonksiyon/callback alır (ör. `new Ops({ member, state, paste, ... })`).
- Kimlik: tarayıcı/API `x-panel-token` (data/token.txt); oturumların hook ve MCP çağrıları ayrı, her açılışta yenilenen `x-panel-hook-token` (ortam değişkeni `PANEL_HOOK_TOKEN`, dosyaya yazılmaz).
- `launchSession` (`panel/launch.js`) her üye için oturuma özel dosyalar üretir ve `SessionManager.launch` ile pwsh içinde `claude` başlatır:
  - `data/prompts/<sid>.md` → `--append-system-prompt-file` (`panel/prompt.js` `writePromptFile(group, session, project, accounts)`: `prompts/shared/*.md` bölümleri ad sırasıyla oturumun değerleriyle doldurulur — kimlik, persona, görevler, sınırlar, ekip, iletişim/pano/not kuralları; şefe ek orkestrasyon ve ekip yönetimi). Rolün üç metni istem yazılırken rol klasöründen okunur (`roleTextOf`); oturum kaydında `rolePrompt` yalnızca kurulumda ekibe özel yazılmışsa ya da anlık rolse durur ve yalnızca görevlerin yerine geçer. Şefe her üyenin yalnızca görevleri gider. Değişiklik yalnızca yeni/yenilenen oturumda geçer (resume sistem istemini korur).
  - `data/session-settings/<sid>.json` → `--settings`: tüm olaylar için `type:"http"` hook'lar (`/api/hook`), `mcp__panel` izni, rolün `deny` / `enabledPlugins` / `skillOverrides`'ı ve rolün `permissions.json` `allow` / `deny`'ı. Salt okunur rol = deny'da `Edit/Write/NotebookEdit` (review, arastirma, avukat, guvenlik; Bash açık).
  - `data/mcp/<sid>.json` → `--mcp-config`: panelin MCP sunucusu `/api/mcp/<sid>` (adres üyenin kimliğini taşır) + rolün panel MCP'leri.
  - `--session-id` / `--resume`, `--model`, `--effort`, `--permission-mode`, `--add-dir` (panel skill'leri), ilk görev `taskFile`.
- Hesaplar (`settings.accounts`) ayrı `CLAUDE_CONFIG_DIR` klasörleridir (`~/.claude`, `~/.claude-alt`, …); `sessions/` ve `projects/` klasörleri ortak klasöre bağlı olduğundan `discovery.js` tek yoldan okur.
- Durum tahmin edilmez: hook olayları (`HookState`) + `discovery` canlı oturum dosyaları + konuşma kaydı (jsonl).
- ConPTY tuzağı: açılıştan hemen sonra öldürülen oturum node-pty'de paneli 0xC0000374 ile düşürüyordu; `PtySession.kill` ilk çıktıya kadar ertelenir. Bu davranışı bozma.

### Panel → üye iletimi (board.js, notes.js, team.js)
Görev panosu kartları, grup notları ve ekip istek sonuçları dosyada "iletilecek" kaydı olarak tutulur (panel kapansa da kaybolmaz). İletim iki yoldan: üye bir tur bitirirken hook yanıtına `additionalContext` olarak (`boardDelivery`, ek tur açmaz) ya da boştaysa terminaline yapıştırarak (`boardIdleTick`). Üyelere giden metinler `prompts/messages/*.md` şablonlarıdır (`prompts.message(ad, değerler)`; kodda yalnızca liste satırları üretilir) ve `[Claude Panel · Görev panosu]`, `[… · Grup notları]`, `[… · Ekip yönetimi]`, `[… · Bekçi]`, `[… · Bekçi bilgi]`, `[… · Hatırlatma]`, `[… · Devir]` başlıklarını taşır; `prompts/shared/` istem metniyle uyumlu tutulmalı. Bekçinin bilgi notuna giden tek tek maddeler (ops.js, curator.js) olay kaydıyla ortak olduğu için kodda.
- MCP tool'ları (`handleMcp`, yalnızca JSON yanıtlı Streamable HTTP): pano_*, not_*, dokuman_listele, ekip_durumu, devir_tamam (ops), şefe ek olarak rol_listesi, uye_ekle, uye_kapat, uye_hesap_degistir, uye_ayar_degistir, uye_yetenek_degistir. Şefin istekleri **her zaman kullanıcı onayına** düşer (`data/requests.json`), panel kendiliğinden uygulamaz.
- Not düzenleyici (`curator.js`) ayrı MCP adresi `curator-<grup>` ile yalnızca not tool'larını kullanır; bilgi kaybı güvenceleri sunucuda (sürüm geçmişi, birleştirilen not arşive, `[kullanıcı]` metni korunur).
- Grup kapanışı `exporter.js`: notlar/pano/özet proje klasörüne Markdown; var olan dosyanın üstüne yazmaz.

### Ölçüm ve bekçi (meter → watch → helper → ops)
- `transcript.js` jsonl'i kaldığı yerden okur, her satırı bir kez ayrıştırıp hem `meter` hem `usage`'a verir.
- `meter.js`: kota/token oranı (kota uç noktası tam sayı yüzde verdiği için "temiz" aralıklardan), compact/taşıma maliyeti, bağlam büyüme hızı, hata serileri, `sessionInfo` (gerçekleşen `fam`, `effort`, `cacheWarm`, skill listesi). `quota.js` belgelenmemiş `api/oauth/usage` uç noktası.
- `watch.js` (dakikada bir): kurallarla aday hamle çıkarır; `helper.js` Haiku'ya hangisini seçeceğini sorar (geçersiz yanıtta kural varsayılanı); `ops.js` (3 sn'de bir) uygular: compact, hesap taşıma, yenileme (devir notu → aynı ad/rol sıfır bağlam). Rol bağlam profilleri ve grup bazlı `group.watch` genel ayarı ezer.
- **Tasarım kuralı (kullanıcı kararı):** bekçi proje değil panel ortamıyla ilgilenir. Mekanik işler şefe sorulmadan yapılır; şefe yalnızca proje kararı gerektiren durumlar (hiçbir hesapta kota yok, takılma, hata serisi) yazılır, yapılanlar ek tur açmadan bilgi notu olarak geçer. Gerekçe: şefe giden her mesaj en büyük bağlamı yeniden okutur.
- autoRotate bekçisi hamle yapan grupları atlar; güven onayı olmayan hesaba (`trustsDir`) taşıma yapılmaz.

### Kurulum ve yetenekler (optimizer.js, caps.js)
- `roleadvisor.js` (rol sayfasında "Rolü optimize et"): iki `llm.run` çağrısı — "sorular" (rol + bütün projelerdeki geçmiş kullanımı → kullanıcıya soru) ve "oneriler" (cevaplarla küçük değişiklik). Öneriler sunucuda doğrulanır (metnin en fazla ~%30u, izin gevşetilmez); hiçbiri yazılmaz, kullanıcı seçtiklerini forma uygulayıp kaydeder. MCP / bekleyen süreç yok.
- `optimizer.js`: grup açılmadan önce tek model çağrısıyla satır başına model/effort/izin/talimat/yetenek önerir (proje özeti + önceki grupların harcaması; proje klasöründe yalnızca Read/Grep/Glob). Hesap dağıtımı kuralla yapılır, modele sorulmaz. Yanıt sunucuda doğrulanır.
- Skill'ler iki katmanlı. **Depodaki `skills/`**: panelle gelen, role özel genel bilgi (projeye özel olan rol talimatıdır). Panelden salt okunur (düzenleme/silme 403, aynı adla yerel skill 409); hangi rollere verildiği `prompts/roles/<rol>/role.json` `skills` listesinde, kaynak ve uyarlamalar `skills/SOURCES.md`. **`data/skills/`**: kullanıcının panelden eklediği yerel skill'ler. `caps.load()` ikisini `builtin` işaretiyle birleştirir; `save()` depodakileri `caps.json`'a yazmaz; rol ataması değiştiyse `role.json`'lara yazar (`Caps` üçüncü parametresi `roleSkills`, testler bellekte verir). Anahtar ikisinde de `pskill:<ad>`; kurulum, optimizer ve şefin `uye_yetenek_degistir` isteği aynı yoldan çalışır. Skill eklerken: klasör + en az bir rolün `role.json` `skills`'i + SOURCES.md tablosu birlikte (birim testi tutarlılığı denetler); skill başka bir skill'in klasörüne `../` ile bağlanamaz, çünkü her skill oturuma ayrı kopyalanır.
- `caps.js`: panel MCP/skill'leri yalnızca işaretli rollere verilir; global skill/eklenti/MCP rol bazında kapatılır. Hiçbiri hesap ayarlarına yazılmaz, hep oturuma özel dosyayla. Skill kataloğu oturum kayıtlarındaki `skill_listing` ekinden öğrenilir (`caps.json seen`). `skillOverrides: "off"` yerleşik ve claude.ai skill'lerini kapatır, eklenti skill'ine işlemez (yalnızca `enabledPlugins`). Skill listesi oturum başında ve compact sonrası yazılır; kazanç yeni/yenilenen oturumda görülür.

### Metinler ve roller (`prompts/`, git'te; ayrıntı `prompts/README.md`)
- Modele giden bütün metinler burada, kullanıcı elle düzenler: `roles/<id>/` (`role.json` ayarlar: label, short, order, model, effort, ctxWarn, ctxHigh, skills; `persona.md`, `gorevler.md`, `sinirlar.md`; `permissions.json` zorlanan izinler: mode, allow, deny — sınırlar.md söyler, permissions.json uygular), `shared/*.md` (üye istemi bölümleri, `{{ad}}` / `{{#ad}}…{{/ad}}` / `{{^ad}}…{{/ad}}` şablonu), `tools/<araç>/` (`tool.json` + `persona.md` / `gorevler.md` / `sinirlar.md` / `cikti.md`, `## Persona` … `## Çıktı` başlıklarıyla birleşir: `bekci`, `kurulum-danismani`, `rol-danismani`, `not-duzenleyici`, `kapanis-ozeti`), `messages/*.md` (panelden üyelere bildirimler).
- Erişim yalnızca `core/prompts.js`: dosyalar değişiklik zamanı/boyutuyla önbelleklenir, değişen dosya yeniden okunur (yeniden başlatma gerekmez; `fs.watch` yok). CRLF → LF. `settings.roles` `context.js`'te bu klasörü okuyan getter'dır; `replaceSettings` onu ezmez. Ayarlar → Roller kaydı `prompts.saveRoles` ile yalnızca değişen dosyaları yazar; silinen rolün klasörü `_silinen-<id>-<zaman>` olur (`_` ile başlayan klasör okunmaz). Değişen dosyaların eski hali önce `roles/<id>/archive/<zaman>/`'a (+ `kayit.json`: kaynak elle / rol danışmanı / geri yükleme) alınır, rol başına 30 sürüm; rol sayfasındaki "Geçmiş" fark gösterir ve geri yükler. Arşiv ve kullanıcının panelden yaptığı rol düzenlemeleri git'e commit edilmez.
- Yardımcı model araçları metni ve ayarı her çağrıda `prompts.tool(ad)` ile okur; kodda istem metni ya da model/tur/süre sabiti tutulmaz. Yanıt biçimini değiştiren istem düzenlemesi ayrıştıran kodla birlikte yapılır.

### Kalıcı veri (`data/`, gitignore)
`settings.json` (hesaplar, eşikler; roller burada değil — eski kayıttaki `roles` yok sayılır, `saveSettings` yazmaz), `projects.json`, `groups.json`, `boards/`, `notes/`, `timeline/`, `requests.json`, `pending.json`, `events.json`, `ledger.json`, `meter.json`, `presence.json`, `caps.json`, `prompts/`, `session-settings/`, `mcp/`. Yazımlar geçici dosya + rename ile atomik (`store.writeJson` deseni).

## Ortak altyapı (yeni kod buna oturur)

Tekrarlanan kod ve dağınık kayıt ölçüm hatası ürettiği için parçalar ortak temele taşındı. Yeni iş yazarken:

- **Yardımcı model çağrısı yalnızca `llm.run`** (`server/core/llm.js`). `claude -p`'yi doğrudan spawn etme. llm.js: hesabın config klasörü, `CLAUDE*/ANTHROPIC*` temizlenmiş ortam, `--setting-sources ""`, `--no-session-persistence`, `--strict-mcp-config`, JSON çıktı. Bu çağrılar oturum kaydı bırakmaz; harcama `onSpend` → `ledger.js` (data/ledger.json, son 500) ve `meter.addSpend` ile ölçüme eklenir. Atlanırsa kota artışı token'sız görünür ve oran şişer. Model hatası (`is_error`) fırlatmaz, `ok:false` döner.
- **Seçenek listeleri yalnızca `server/core/options.js`** (`MODELS`, `MODEL_TEXT`, `EFFORTS`, `PERMISSION_MODES`). Yeni değer orada eklenir; varsayılanlar sahibinde kalır (`WATCH_DEFAULTS` watch.js'te; rol varsayılanları `role.json`'da, not düzenleyicininki `tools/not-duzenleyici/tool.json` `defaults`).
- **Konuşma kaydı yalnızca `transcript.js`** üzerinden okunur. Üye görüntüsü `memberSnapshot` bekçi ve `ekip_durumu` için ortaktır.
- **Çalışan üyenin ayar değişikliği `pending.js` kuyruğuna** gider (kullanıcı menüsü, şef `uye_ayar_degistir` / `uye_yetenek_degistir`). `ready()`: üye boşta olmalı; model değişiminde ayrıca önbellek soğuk olmalı (effort 5.5 modellerde önbelleği korur). Uygulama = durdur + resume + yeni `--model/--effort`. "Şimdi uygula" `now:true`.
- **Açılış doğrulaması `driftOf`**: istenen model/effort/kapalı skill, jsonl'de gerçekleşenle karşılaştırılır → arayüzde "ayar uyuşmuyor" rozeti. "Uygulandı" demek için bu kanıt kullanılır.
- **Olaylar kalıcı** (`pushEvent` → events.json); bildirim kutusu buradan beslenir.
- Maliyet hesabı yalnızca `watch.js`'te (`costs`, `renewCost`).

## Değişmez kurallar ve kullanıcı kararları

- **Modeller yalnızca opus / sonnet / haiku. Fable kullanılmaz**; öneri, varsayılan, tasarım ya da seçenek olarak ekleme (meter.js aile tanıma/fiyat ve MODEL_TEXT gösterimi bilerek kaldı).
- Rol varsayılanları: şef opus; coder/backend/frontend/android, review, debug, kalite, ops, avukat, test, güvenlik sonnet; araştırma ve dokümantasyon haiku. Effort: şef/review/debug/avukat/güvenlik high; kod yazanlar/kalite/ops/test medium; araştırma/doküman low. `contextWindows.haiku: 200000` bilerek düşük (eşikler düşük kalsın).
- Şef dışı roller kullanıcıya hitaben terminale özet yazmaz; sonuç SendMessage/pano/not ile gider, terminalde en fazla tek satır (`prompts/shared/03-iletisim.md` ortak kuralında, rol talimatında değil).
- Model/effort hiçbir zaman otomatik düşürülmez; yalnızca öneri + kullanıcı onayı. Kalite ölçülmez, optimizer kalite iddiası taşımaz.
- **Önbellek (prompt cache) kuralları** — her hamlede maliyet olarak hesaba kat:
  - Kırar: model değişimi (fallback dahil), fast mode'u açmak, compact (sıcakta ucuz, soğukta pahalı), Claude Code sürüm yükseltmesi, ~1 saat boşluk (abonelikte 1h TTL; kota aşılınca 5 dk; alt ajanlar 5 dk), **hesap taşıma** (organizasyonlar arası izole), tool search kapalıyken MCP ekleme/çıkarma.
  - Korur: Opus/Sonnet/Haiku 5.5'te effort değişimi (ölçüldü; Claude Code'un uyarısı genel metin), izin modu, CLAUDE.md düzenleme (sonraki compact/restart'a kadar uygulanmaz), skill çağırma, alt ajan.
  - Terminalde `/model` ya da `/effort` Enter ile hesabın ayarına yazar (aynı hesaptaki diğer oturumları etkiler); panel oturuma özel `--model` / `--effort` kullanır.
- Claude Code idle compaction (`idleCompaction`) bekçinin boşta compact mantığıyla çakışabilir; boşta compact (≥20 dk sessizlik) bekçinin "2 compact → yenile" sayacından ayrı tutulur.

## Planlananlar (henüz kod yok)

### Anlık ortam optimizasyonu — en önemli sonraki özellik
Grup çalışırken ortamı değerlendirip yapısal değişiklik öneren, kullanıcı onaylı özellik. Ortak altyapının üstüne oturur; tasarım kararları:
- Ayrı sistem değil, `optimizer.js`'in **çalışma anı modu**. İş bölümü: bekçi otomatik ortam hamleleri (compact/taşı/yenile, hesap taşıma) bekçide kalır; yeni mod yalnızca yapısal kararlar: model, effort, izin, talimat, yetenek, üye aç/kapat, haftalık kota dağılımı.
- Şef denetçi değil girdi sağlayıcı: "önümüzdeki saatlerde hangi rol ne iş yapacak" sorusu; şefin görüşü yalnızca etkili maddelerde (açık kartlı rolün modelini düşürme, üye kapatma) istenir — şef en pahalı bağlam.
- Her öneri maddesi uygulama yolu (hemen / sonraki boşlukta restart+resume / sonraki yenilemede) ve tahmini maliyet (`watch.costs` / `renewCost`) taşır. Onaylananlar `pending.js` kuyruğuna girer, en ucuz anda (önbellek soğuk ya da bekçi yenilemesi) uygulanır.
- "Uygulandı" ancak doğrulanınca: jsonl'deki gerçekleşen model (`meter` `fam`) ve effort (`driftOf`). Küçük pencereli modele düşürmede bağlamın sığmama riskini kontrol et.
- Kazanç gerçekçi hesaplanır: boştaki oturum kota harcamaz (boştaki rolü kapatmanın kazancı ~0). Asıl kaldıraç aktif rollerin model/effort'u, haftalık kota planlaması (bekçi yalnızca kısa pencereye bakıyor) ve aşama değişimleri.
- Model yükseltme kuralı: görev varsayılanla başlar; kanıta dayalı sonuç yoksa, testler başarısızsa ya da karmaşıklık beklenenden yüksekse önce effort, sonra model yükseltilir; bulgular ve başarısız denemeler aktarılır, iş tekrarlatılmaz.
- Tetik: elle düğme + kural sinyalleri (haftalık kota bitecek, aşama değişimi, pahalı modelde rutin iş); periyodik model çağrısı yok. Onay madde madde; reddedilen madde durum imzasıyla hatırlanır, imza değişmeden tekrar gösterilmez. Her uygulanan değişikliğin kaydı tutulur ve tek tıkla geri alınabilir.
- Veri kaynağı adayı: Claude Code statusline JSON'u (ondalıklı `rate_limits`, `context_window`, canlı `effort.level`, `prompt_cache.warm/expires_at/last_miss_cause`) oturuma özel `--settings` içindeki bir statusLine komutuyla panele POST ettirilebilir (hooks.js gibi). Yalnızca çalışan oturumu olan hesaplara veri gelir; boştaki hesaplar için `quota.js` gerekli kalır.

### Diğer
- Rol bazlı skill paketleri / şefe özel skill'ler: istendi ama senaryo netleşmedi — başlamadan kullanıcıya hangi senaryoyu istediğini sor. Altyapı hazır (caps.js rol işaretleme, `uye_yetenek_degistir`). Doğrulanmadı: proje skill'ini `skillOverrides` ile kapatma; çalışan oturuma `--add-dir` ile eklenen skill'in yeniden başlatmasız görünmesi.
- Bilinen açıklar: e2e'de Write/Bash tool'unun bazen yüklenmemesi; arayüz (tarayıcı) testlerinin bir kısmı (grup kapanışı UI, özet adımı) elle doğrulanmadı.
