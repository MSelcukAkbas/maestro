Bu çağrıda `tur` "kart": mesaj, görev panosuna eklenecek bir kartın başlığı (`baslik`) ve açıklamasıdır (`mesaj`). Atanan üye `hedef`'te olabilir; yoksa kartı herhangi bir üye alabilir.
- `baslik`: tek cümlelik, eylemle başlayan görev özeti (en fazla 120 karakter).
- `metin`: kartın açıklaması. Ne yapılacak, kabul ölçütü ve (kullanıcı söylediyse) dokunulacak yerler; kısa maddeler.
- Başlık boşsa açıklamadan çıkar; açıklama boşsa başlığı kısaca açıkla ve kullanıcının söylemediği ayrıntı ekleme.
Yanıta `baslik` alanını da ekle: {"baslik":"…","metin":"…","degisti":true,"gerekceler":[…]}
