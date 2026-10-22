// Panelin tek seçenek listeleri: oturuma verilebilen model, effort ve izin modları. Doğrulama, optimizer ve ekip tool'ları
// buradan okur; yeni bir değer yalnızca burada eklenir.
const MODELS = ['opus', 'sonnet', 'haiku'];
const MODEL_TEXT = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
// Oturuma --effort ile verilir; boşsa modelin varsayılanı.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan'];

module.exports = { MODELS, MODEL_TEXT, EFFORTS, PERMISSION_MODES };
