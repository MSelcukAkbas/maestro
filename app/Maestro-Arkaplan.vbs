' Maestro'yu pencere açmadan arka planda başlatır. Panel adresini tarayıcıda aç:
' http://127.0.0.1:7788  (erişim anahtarı data\token.txt içinde; panel daha önce açıldıysa tarayıcı hatırlar)
' Kapatmak için: Panel > Ayarlar > "Sunucuyu kapat".
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node services\index.js", 0, False
