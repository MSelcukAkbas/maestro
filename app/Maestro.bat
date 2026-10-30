@echo off
title Maestro
cd /d "%~dp0"
if not exist node_modules (
  echo Bagimliliklar kuruluyor...
  call npm install || goto :hata
)
node server\index.js --open
echo.
echo Panel kapandi. Bu pencereyi kapatabilirsin.
pause
exit /b

:hata
echo npm install basarisiz oldu.
pause
