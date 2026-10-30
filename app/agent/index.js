// Ajan: kullanıcının bilgisayarına bağlı her şey (PTY'ler, Claude'un kendi kayıt dosyaları, hesap kotası) burada.
// services/ ajana yalnızca bu dosya üzerinden erişir; ileride ajan ayrı bir süreç olunca bu arayüz ağ üzerinden
// çalışacak şekilde değiştirilir, çağıran kod aynı kalır.
const pty = require('./pty');
const discovery = require('./discovery');
const quota = require('./quota');

const transcripts = require('./transcripts');

module.exports = { ...pty, discovery, quota, transcripts };
