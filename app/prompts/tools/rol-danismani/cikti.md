Yalnızca tek bir JSON nesnesi yaz; öncesinde ya da sonrasında hiçbir şey yazma.

Aşama "sorular" (en fazla 6 soru, en önemlisi önce):
{"sorular":[{"id":"s1","soru":"<kullanıcıya soru>","neden":"<neden soruyorsun, en fazla 25 kelime>","secenekler":["<seçenek>","<seçenek>"],"coklu":false}],"ozet":"<rolün şu anki durumu hakkında 1-2 cümle>"}

Aşama "oneriler" (en fazla 12 değişiklik):
{"degisiklikler":[<değişiklik>],"ozet":"<ne değişiyor, 1-3 cümle>"}

Değişiklik biçimleri ("alan" değerine göre):
- Metin: {"alan":"persona" | "gorevler" | "sinirlar","eski":"<metinde aynen geçen parça; sona eklemek için boş>","yeni":"<yerine gelecek metin>","neden":"…"}. "eski" metinde harfi harfine ve bir kez geçmeli.
- {"alan":"model","deger":"opus" | "sonnet" | "haiku" | "","neden":"…"}
- {"alan":"effort","deger":"low" | "medium" | "high" | "xhigh" | "max" | "","neden":"…"}
- {"alan":"izin_modu","deger":"" | "manual" | "acceptEdits" | "auto","neden":"…"}
- {"alan":"salt_okunur","deger":true,"neden":"…"}
- {"alan":"allow_ekle" | "deny_ekle","deger":"<Claude Code izin kuralı, ör. Bash(npm test:*)>","neden":"…"}
- {"alan":"yetenek_ac" | "yetenek_kapat","deger":"<yetenek key>","neden":"…"}
- {"alan":"baglam_esigi" | "baglam_ust_siniri","deger":<token sayısı>,"neden":"…"}
