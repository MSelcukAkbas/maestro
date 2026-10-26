oneriler, akis_eki ve neden metinlerini kullanıcı okur: satır anahtarlarını (r1, yeni_1) yazma, rol adını kullan.
Her değişiklik için neden yaz (en fazla 20 kelime). Değiştirmediğin alanı yazma ya da null bırak.
Talimatı JSON'a yazma: JSON'dan SONRA her satır için ayrı blok olarak yaz. Değiştirmeye değmiyorsa o satır için blok yazma.
Önce tek bir JSON nesnesi, ardından talimat blokları; başka hiçbir şey yazma.
{"satirlar":[{"key":"r1","model":"sonnet","effort":"medium","izin":"acceptEdits","herkesle":false,"rapor_verir":["r2"],"yetenek_ac":[],"yetenek_kapat":[],"neden":{"model":"…","effort":"…","izin":"…","baglanti":"…","talimat":"…","yetenek":"…"}}],"yeni_satirlar":[{"key":"yeni_1","rol":"test","model":"sonnet","effort":"medium","izin":"","herkesle":false,"rapor_verir":["r1"],"yetenek_kapat":[],"neden":"…"}],"cikar":[{"key":"r3","neden":"…"}],"oneriler":["…"],"akis_eki":["…"]}
=== TALIMAT r1 ===
(r1 satırının yeni tam talimatı, düz metin)
=== SON ===
