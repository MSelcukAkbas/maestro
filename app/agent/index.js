// Ajan: kullanıcının bilgisayarına bağlı her şey (PTY'ler, Claude'un kendi kayıt dosyaları, hesap kotası) burada.
// services/ ajana yalnızca bu dosya üzerinden erişir.
// Terminal oturumları ayrı bir süreçte (main.js) yaşar; services onlara host.js protokolüyle bağlanır.
// Dosya ve kota erişimi (discovery, transcripts, quota) şimdilik services ile aynı makinede çağrılır.
const pty = require('./pty');
const discovery = require('./discovery');
const quota = require('./quota');
const transcripts = require('./transcripts');
const launcher = require('./launcher');

module.exports = { buildScript: pty.buildScript, psQuote: pty.psQuote, discovery, quota, transcripts, launcher };
