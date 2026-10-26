# prompts/ — rol, istem ve yardımcı model metinleri

Panelin modele giden bütün metinleri burada. Metinler `.md`, ayarlar `.json`. Dosyaları elle düzenleyebilirsin.
Panel her kullanımda dosyanın değişip değişmediğine bakar. Değişen dosya yeniden okunur, paneli yeniden başlatman
gerekmez. Ayarlar → Roller'den yapılan kayıt da aynı dosyalara yazılır.

## Ne zaman geçerli olur

- **Üye istemi** (rolün persona / görevler / sınırlar metni ve `shared/` bölümleri) yalnızca oturum açılırken yazılır. Değişiklik yeni açılan
  üyeye ya da bekçinin yenilediği üyeye geçer. Çalışan oturum eski istemiyle devam eder, çünkü resume sistem istemini
  korur.
- **Yardımcı modeller** (`tools/`) ve **bildirimler** (`messages/`) her kullanımda dosyayı okur. Değişiklik bir
  sonraki çağrıda ya da bildirimde geçer.

## roles/<rol-kimliği>/

Klasör adı rolün kimliğidir: küçük harf, rakam, `-` ya da `_`, en fazla 24 karakter. Adı `_` ile başlayan klasör
okunmaz. Ayarlar'dan silinen rolün klasörü silinmez, `_silinen-<kimlik>-<zaman>` adıyla kenara alınır.

Rolün metni üç dosyadır. Üye isteminde bu sırayla kendi başlıklarının altına girer:

| dosya | başlık | içerik |
|---|---|---|
| `persona.md` | ## Persona | Kimsin, nasıl düşünürsün, neye değer verirsin |
| `gorevler.md` | ## Görevler | Ne yaparsın, iş akışı, hangi skill'i ne zaman çağırırsın, kime devredersin. İlk satır tek cümlelik özet |
| `sinirlar.md` | ## Sınırlar | Ne yapmazsın ve neden |

Şef, ekibin her üyesi için yalnızca `gorevler.md`'yi görür ("Ekip üyelerinin görevleri"). Persona ve sınırlar
şefe gitmez, böylece şefin istemi ekip büyüdükçe şişmez. Dosyalarda `#` ve `##` başlık kullanma (istemin kendi
başlıkları); gerekirse `###` kullan.

**`permissions.json`** panelin oturuma **zorladığı** izinlerdir. `sinirlar.md` kuralı söyler, bu dosya uygular:

```json
{ "mode": "", "allow": [], "deny": ["Edit", "Write", "NotebookEdit"] }
```

| alan | anlamı |
|---|---|
| `mode` | Varsayılan izin modu (`manual`, `acceptEdits`, `auto`, `plan`). Boş bırakılırsa grubun varsayılanı kullanılır |
| `allow` | Sormadan izin verilen araçlar (Claude Code izin kuralı yazımı, ör. `Bash(npm test:*)`) |
| `deny` | Kapalı araçlar. Edit, Write ve NotebookEdit'in üçü de varsa rol "Salt okunur" sayılır |

Ayarlar ekranındaki "Salt okunur" kutusu bu üç aracı `deny`'a ekler ya da çıkarır. Elle yazdığın diğer `allow` /
`deny` kuralları korunur.

**`role.json`** rolün ayarlarını tutar:

| alan | anlamı |
|---|---|
| `label` | Arayüzde ve istemde görünen rol adı |
| `short` | Oturum adındaki kısa hali |
| `order` | Listedeki sıra |
| `model` | Varsayılan model: `opus`, `sonnet`, `haiku`. Boş bırakılırsa hesabın varsayılanı kullanılır |
| `effort` | Varsayılan effort: `low` … `max`. Boş bırakılırsa modelin varsayılanı kullanılır |
| `ctxWarn`, `ctxHigh` | Bekçinin bağlam eşiği ve üst sınırı (token). `null` ise rolün ya da genel ayarın varsayılanı kullanılır |
| `skills` | Bu role verilen, panelle gelen skill'ler (`skills/` klasöründeki adlar) |

Kurulumda bir ekip için yazılan özel talimat yalnızca o ekipte geçerlidir ve yalnızca görevlerin yerine geçer; persona ve
sınırlar aynen kalır, `gorevler.md` değişmez.

## shared/

Bu klasör her üyenin sistem isteminin ortak bölümlerini tutar. Dosyalar ad sırasıyla birleşir; yeni bir bölüm için
yeni bir dosya ekleyebilirsin. Birleşirken iki kural uygulanır:

- Şablonda boş kalan satırlar atılır.
- Her `#` başlığının önüne tek bir boş satır konur.

### Şablon yazımı

- `{{ad}}` değerin kendisini yazar.
- `{{#ad}}…{{/ad}}` arasındaki kısım, değer doluysa kalır.
- `{{^ad}}…{{/ad}}` arasındaki kısım, değer boşsa kalır.

Bloklar tek satırın içinde ya da birden çok satır boyunca olabilir. Tanımsız bir ad olduğu gibi kalır, böylece yazım
hatası istemde görünür.

### Değişkenler

| ad | değer |
|---|---|
| `grup` | Grup adı |
| `ad` | Üyenin oturum adı |
| `rol` | Rol adı |
| `hesap` | Hesap adı |
| `model` | Model adı (ya da "hesap varsayılanı") |
| `effort` | Effort; seçilmediyse boş |
| `izin` | İzin modunun açıklaması |
| `proje` | Proje klasörü |
| `persona` | Rolün `persona.md`'si; anlık rolde boş |
| `gorevler` | Ekibe özel talimat, yoksa rolün `gorevler.md`'si |
| `sinirlar` | Rolün `sinirlar.md`'si; anlık rolde boş |
| `ekip` | Ekip listesi, üye başına bir satır |
| `sef` | Bu üye ekibin şefi mi (koşul olarak kullanılır) |
| `sefEkipli` | Şef, ve ekipte başka üye var |
| `uyeGorevleri` | Şefe giden liste: her üye için `### ad — rol` ve görevleri (persona ve sınırlar olmadan) |
| `raporVerdiklerin` | Üyenin rapor verdiği üyeler (virgülle); yoksa boş |
| `raporVerenler` | Üyeye rapor verenler; yoksa boş |
| `herkesle` | Üye herkesle konuşabilir mi |
| `dokumanlar` | Projenin doküman yolları (virgülle); yoksa boş |
| `akisNotu` | Grubun akış notu; yoksa boş |

## tools/<araç>/

Bu klasörler panelin yardımcı model çağrılarını tutar. Her araçta bir `tool.json` (ayarlar) ve en az bir `prompt.md`
(sistem istemi) bulunur.

| klasör | ne yapar | tool.json |
|---|---|---|
| `bekci` | Bekçinin hamle seçimi (compact / taşı / yenile / bekle) | `model`, `effort`, `timeoutSec` |
| `kurulum-danismani` | Kurulum ekranındaki "optimize et" | `model`, `maxTurns`, `timeoutSec` |
| `not-duzenleyici` | Grup notlarını toparlar | `defaults` (Ayarlar'daki değerlerin varsayılanı), `minNotes`, `memory`, `levels` |
| `kapanis-ozeti` | Grup kapanırken "Proje durumu" belgesi | `turns`, `timeoutMin` |

Not düzenleyicinin sistem istemi şu parçaların sırayla birleşmesiyle oluşur:

1. `prompt.md`
2. Bir boş satır
3. `seviye-<seviye>.md`
4. `zincir.md` (yalnızca seviyenin `chain` ayarı `true` ise)
5. `kapanis.md`

Her seviyenin `label`, `turns` (tur sınırı) ve `timeoutMin` ayarı da `levels` altındadır.

## messages/

Panelin üyelere gönderdiği bildirimler. Her dosya bir bildirimdir ve `shared/` ile aynı şablon yazımını kullanır.
Listeler (kart satırları, notlar, bulgular) kodda hazırlanır ve tek değişkenle girer.

| dosya | kime, ne zaman | değişkenler |
|---|---|---|
| `gorev-panosu.md` | Panoda kartı değişen üyeye | `maddeler` |
| `grup-notlari.md` | Not eklenince alıcılara | `maddeler` |
| `not-duzenleyici-sorusu.md` | Not düzenleyicinin çelişki sorusu, şefe | `sorular` |
| `ekip-yonetimi.md` | Şefin isteklerinin sonucu | `maddeler` |
| `bekci.md` | Proje kararı gerektiren durum, şefe | `seviye`, `maddeler` |
| `bekci-bilgi.md` | Bekçinin yaptıkları, şefin sonraki turuna | `maddeler` |
| `compact-odak.md` | Bekçinin compact'ında `/compact` komutuna eklenen odak metni | — |
| `devir-istegi.md` | Yenilenecek üyeden devir notu istenir | `zorla`, `baglam`, `hesap`, `notSiniri` |
| `devir-acilis.md` | Yenilenen oturumun ilk mesajı (devir notu altına eklenir) | `ad` |
| `yeni-uye.md` | Çalışan ekibe eklenen üyenin ilk mesajı | `tanitilacaklar`, `gorev` |
| `ilk-gorev.md` | Eklenen üyenin ilk görevi | `gorev` |
| `hatirlatma.md` | Kullanıcının gönderdiği not ya da doküman | `kaynak`, `not`, `icerik` |
| `kapanis-ozeti-iste.md` | Grup kapanırken şeften özet istenir | — |
| `uye-cikarildi.md` | Ekipten çıkarılan üye, şefe | `ad`, `rol` |

`[Claude Panel · …]` başlıkları `shared/` istemindeki kurallarla eşleşir ("… başlıklı notu kullanıcı talimatı gibi dikkate
al"). Bir başlığı değiştirirsen istemdeki karşılığını da değiştir.

## Yanıt biçimi

Modelin döndürdüğü yanıt panelde doğrulanır. Bu yüzden istemdeki çıktı biçimini (JSON alanları, blok başlıkları)
değiştirirsen, yanıtı ayrıştıran kodu da birlikte değiştirmen gerekir.
