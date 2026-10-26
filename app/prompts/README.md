# prompts/ — rol, istem ve yardımcı model metinleri

Panelin modele giden bütün metinleri burada. Metinler `.md`, ayarlar `.json`. Dosyaları elle düzenleyebilirsin.
Panel her kullanımda dosyanın değişip değişmediğine bakar. Değişen dosya yeniden okunur, paneli yeniden başlatman
gerekmez. Ayarlar → Roller'den yapılan kayıt da aynı dosyalara yazılır.

## Ne zaman geçerli olur

- **Üye istemi** (rol talimatı ve `shared/` bölümleri) yalnızca oturum açılırken yazılır. Değişiklik yeni açılan
  üyeye ya da bekçinin yenilediği üyeye geçer. Çalışan oturum eski istemiyle devam eder, çünkü resume sistem istemini
  korur.
- **Yardımcı modeller** (`tools/`) her çağrıda dosyayı okur. Değişiklik bir sonraki çağrıda geçer.

## roles/<rol-kimliği>/

Klasör adı rolün kimliğidir: küçük harf, rakam, `-` ya da `_`, en fazla 24 karakter. Adı `_` ile başlayan klasör
okunmaz. Ayarlar'dan silinen rolün klasörü silinmez, `_silinen-<kimlik>-<zaman>` adıyla kenara alınır.

**`prompt.md`** rolün talimatıdır. Üye isteminde "## Rol talimatı" bölümüne aynen girer. Şefin isteminde ayrıca
"Ekip üyelerinin görevleri" altında da yer alır.

**`role.json`** rolün ayarlarını tutar:

| alan | anlamı |
|---|---|
| `label` | Arayüzde ve istemde görünen rol adı |
| `short` | Oturum adındaki kısa hali |
| `order` | Listedeki sıra |
| `model` | Varsayılan model: `opus`, `sonnet`, `haiku`. Boş bırakılırsa hesabın varsayılanı kullanılır |
| `effort` | Varsayılan effort: `low` … `max`. Boş bırakılırsa modelin varsayılanı kullanılır |
| `permissionMode` | Varsayılan izin modu. Boş bırakılırsa grubun varsayılanı kullanılır |
| `readOnly` | `true` ise Edit, Write ve NotebookEdit kapatılır |
| `ctxWarn`, `ctxHigh` | Bekçinin bağlam eşiği ve üst sınırı (token). `null` ise rolün ya da genel ayarın varsayılanı kullanılır |
| `skills` | Bu role verilen, panelle gelen skill'ler (`skills/` klasöründeki adlar) |

Kurulumda bir ekip için yazılan özel talimat yalnızca o ekipte geçerlidir; `prompt.md`'yi değiştirmez.

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
| `rolTalimati` | Rol talimatı: ekibe özel talimat, yoksa rolün `prompt.md`'si |
| `ekip` | Ekip listesi, üye başına bir satır |
| `sef` | Bu üye ekibin şefi mi (koşul olarak kullanılır) |
| `sefEkipli` | Şef, ve ekipte başka üye var |
| `uyeGorevleri` | Şefe giden liste: her üye için `### ad — rol` ve rol talimatı |
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

Modelin döndürdüğü yanıt panelde doğrulanır. Bu yüzden istemdeki çıktı biçimini (JSON alanları, blok başlıkları)
değiştirirsen, yanıtı ayrıştıran kodu da birlikte değiştirmen gerekir.
