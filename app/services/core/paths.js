// Uygulama kökü (app/): veri, depodaki skill'ler, arayüz ve başlatma betikleri buna göre bulunur.
// Modüller kökü kendi __dirname'inden hesaplamaz; klasör derinliği değişince yollar sessizce kaymasın.
const path = require('path');

const APP_ROOT = path.join(__dirname, '..', '..');

module.exports = { APP_ROOT };
