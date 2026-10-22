# Claude Panel

Birden çok Claude Code oturumunu rollere ayrılmış bir ekip olarak tek panelden yönetmek için yerel web paneli.

## Testler

- `node --test test/` — model çağırmayan birim testleri.
- `node test/smoke.js` — API uç noktalarının neredeyse hepsini çağırır (500 yok, panel ayakta, günlükte hata yok); model harcamaz.
- `node test/e2e.js [senaryo ...]` — paneli 7799 portunda ayrı bir veri klasörüyle açar ve gerçek Claude oturumları
  başlatır (hesap kotası harcar; oturumlar Haiku ile). Senaryolar: `launch`, `paste`, `settings`, `teamcaps`, `account`, `curator`, `curatormerge`, `optimize`.
  Canlı panelin (7788) verisine ve oturumlarına dokunmaz.

## Skill bağlam optimizasyonu

Claude Code her istekte açık olan tüm skill açıklamalarını bağlama ekler: yerleşik skill'ler,
claude.ai skill'leri, eklenti ve proje skill'leri. Panel bu listeyi oturum kayıtlarından öğrenir,
her skill'in maliyetini gösterir ve kurulumdaki "Optimize et" adımı rolün kullanmayacağı
skill'leri kapatmayı önerir. Kurulumda skill'ler türüne göre gruplanır ve tek tek ya da grup
halinde açılıp kapatılabilir.

| Metrik | Değer |
|---|---|
| Katalog | 44 yetenek (39'unun maliyeti ölçülebilir) |
| Hepsi açıkken skill listesi | ~7,6k token / istek |
| Ortalama skill maliyeti | ~196 token |
| Optimizasyonun ortalama kazancı | ~6,3k token / istek (skill listesinin %82'si) |
| Toplam bağlama etkisi | oturum başında ~%10-12; bağlam büyüdükçe azalır |

Ölçüm: aynı modelde iki oturum açıldı, birinde 28 skill kapalıydı. İlk turdaki bağlam
51,8k'dan 46,4k token'a düştü.

### Örnek: üç kurulumda optimizer sonucu

Aşağıdaki satırlar örnektir; optimizer her projede rolün işine göre farklı skill'leri açık bırakır.

| Örnek rol | Açık kalan | Kazanç | Listedeki indirim |
|---|---|---|---|
| coder | 1.063 token | 6.578 token | %86 |
| şef (review ile) | 1.532 token | 6.109 token | %80 |
| şef (coder ile) | 1.470 token | 6.171 token | %81 |

### Notlar

- Skill başına değerler tahmindir (karakter / 3). Bu oran toplu ölçümle doğrulandı:
  16,4k karakter kapatılınca istek başına 5.455 token düştü.
- Liste her istekte önbellekten okunur (0,1× fiyat). Kota kazancı en çok oturum açılışı,
  compact ve hesap taşıma gibi önbelleğin yeniden yazıldığı anlarda görülür.
- Örnek: rol başına günde 200 istek, ayda ~38 M token daha az demektir (nominal).
- Değişiklik yeni ya da yenilenen oturumda hemen, devam eden oturumda bir sonraki
  compact'tan sonra geçerli olur.
- Eklenti skill'leri yalnızca eklentiyle birlikte kapatılabilir. Kancası olan eklentiyi
  kapatmak arka planda yaptığı işi de durdurur (ör. hafıza kaydı).
- MCP sunucuları ve agent getiren eklentiler de bağlama bir şey ekler; bunlar ölçülmedi.
