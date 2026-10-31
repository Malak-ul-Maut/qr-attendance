// Faster static file serving: cache rules per file type, and ready-made brotli files (.br) when the browser accepts them.
// Core Node only (plus express's res.sendFile), so it adds no packages.
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

const YEAR = 'public, max-age=31536000, immutable';

// What the browser may keep, by file. Rules, first match wins:
//  - pages and the service worker (sw.js): always ask (a 304 costs almost nothing) so a new deploy shows up on the next load
//  - files with a build hash in the name (assets/app-3F9A2C1B.js): never change, keep for a year
//  - the ONNX Runtime files and fonts: never change
//  - models: a week (bump VERSION in engine.js when one is replaced)
//  - images and icons: a week
//  - other JS/CSS/JSON: 5 minutes, so a reload within 5 minutes makes no request at all,
//    and an edited file still reaches every phone within 5 minutes
export function cacheControlFor(urlPath) {
  const p = urlPath.toLowerCase();
  if (p.endsWith('.html') || p === '/' || p.endsWith('.webmanifest') || p === '/sw.js') return 'no-cache';
  if (/\/assets\/.+-[a-z0-9]{8}\.(js|css|wasm|woff2)$/.test(p)) return YEAR;
  if (p.startsWith('/utils/ort/')) return YEAR;
  if (p.endsWith('.woff2')) return YEAR;
  if (p.startsWith('/utils/models/')) return 'public, max-age=604800';
  if (/\.(png|jpe?g|webp|svg|ico|gif|avif)$/.test(p)) return 'public, max-age=604800';
  if (/\.(m?js|css|json)$/.test(p)) return 'public, max-age=300';
  return 'public, max-age=0';
}

// express.static `setHeaders` callback. `root` is the folder being served.
export function staticHeaders(root) {
  return (res, filePath) => {
    const rel = '/' + path.relative(root, filePath).split(path.sep).join('/');
    res.setHeader('Cache-Control', cacheControlFor(rel));
  };
}

// Serves file.ext.br instead of file.ext when the browser sent Accept-Encoding: br and the .br file exists.
// Make the .br files with scripts/build-frontend.mjs (or `npm run precompress`).
// Must be mounted before compression(): that middleware leaves an already-encoded response alone.
export function precompressed(root) {
  const base = path.resolve(root);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!/\bbr\b/.test(req.headers['accept-encoding'] || '')) return next();
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    const ext = path.extname(urlPath).toLowerCase();
    const type = TYPES[ext];
    if (!type) return next();
    const file = path.resolve(base, '.' + urlPath);
    if (file !== base && !file.startsWith(base + path.sep)) return next(); // never leave the folder
    const br = file + '.br';
    let stat;
    try {
      stat = fs.statSync(br);
    } catch {
      return next();
    }
    if (!stat.isFile()) return next();
    res.set({
      'Content-Type': type,
      'Content-Encoding': 'br',
      Vary: 'Accept-Encoding',
      'Cache-Control': cacheControlFor(urlPath),
    });
    res.sendFile(br, { dotfiles: 'deny' }, err => {
      if (err && !res.headersSent) next();
    });
  };
}
