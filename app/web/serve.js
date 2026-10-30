// Arayüzün statik dosya sunumu: web/ altındaki her dosya (yol dışına çıkamaz) ve xterm paketleri. Yeni arayüz dosyası
// eklemek için yalnızca index.html'e yazmak yeterli; services/ arayüzün dosya listesini bilmez.
const fs = require('fs');
const path = require('path');

const WEB_DIR = __dirname;
const MODULES = path.join(__dirname, '..', 'node_modules');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const VENDOR = {
  '/vendor/xterm.js': '@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
};

// Yolu diskteki dosyaya çevirir; arayüzün dosyası değilse null.
function resolve(pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (VENDOR[pathname]) return path.join(MODULES, VENDOR[pathname]);
  const file = path.normalize(path.join(WEB_DIR, pathname));
  if (!file.startsWith(WEB_DIR + path.sep) || path.basename(file) === 'serve.js') return null;
  return TYPES[path.extname(file)] ? file : null;
}

// GET isteğini yanıtlar; arayüz dosyası değilse false döner (çağıran başka yollara bakar).
function serve(req, res, pathname) {
  if (req.method !== 'GET') return false;
  const file = resolve(pathname);
  if (!file) return false;
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
  return true;
}

module.exports = { serve, resolve };
