// Builds ../../frontend-dist: the student page's 20 modules become one small hashed file (plus separate files for
// the QR/face code that loads later), every text file gets a ready-made .br, and the file sizes the face engine
// expects are checked. Serve it with SERVE_DIST=1. The source in ../../frontend is never changed.
//
//   cd backend && npm i -D esbuild && node scripts/build-frontend.mjs
//
// It also makes ../../pages-deploy: the same site without the .br files, plus the _headers file Cloudflare Pages
// needs, ready to upload. Tell it where the API lives so the pages can reach it:
//   node scripts/build-frontend.mjs --api=https://your-name.ngrok-free.app
// Easiest and most reliable: let a Cloudflare Worker pass /api, /socket.io and /results on to your tunnel, so the
// browser only ever talks to the Cloudflare address (no CORS, no ngrok warning page). Add --proxy=<tunnel address>
// and deploy from the pages-worker folder it makes (see SPEED-UP.md).
// The 27 MB of face files can be left out of that copy and loaded from a CDN instead (see make-cdn-folder.mjs):
//   node scripts/build-frontend.mjs --api=https://... --assets=https://cdn.jsdelivr.net/gh/USER/REPO@v1
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const SRC = path.join(ROOT, 'frontend');
const DIST = path.join(ROOT, 'frontend-dist');

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  console.error(
    'esbuild is not installed. Run: npm i -D esbuild   (in the backend folder)',
  );
  process.exit(1);
}

// 1. The sizes in engine.js must match the files, or the progress bar and the integrity check would be wrong.
const engineSource = fs.readFileSync(
  path.join(SRC, 'js/face/engine.js'),
  'utf8',
);
for (const [, file, bytes] of engineSource.matchAll(
  /path:\s*'([^']+)',\s*bytes:\s*(\d+)/g,
)) {
  const actual = fs.statSync(path.join(SRC, file)).size;
  if (actual !== Number(bytes)) {
    console.error(
      `${file} is ${actual} bytes but js/face/engine.js says ${bytes}. Update FILES there (and bump VERSION).`,
    );
    process.exit(1);
  }
}

// 2. Fresh copy of the frontend
fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(SRC, DIST, { recursive: true });

// 3. Student page bundle. Dynamic import()s (scan-flow, enroll) become their own files, loaded on demand.
const common = {
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
};
const result = await esbuild.build({
  ...common,
  // One entry: the sign-in check first, then the app (both were separate module scripts that run in this order).
  stdin: {
    contents: "import './utils/auth-guard.js';\nimport './js/app.js';\n",
    resolveDir: SRC,
    sourcefile: 'student-entry.js',
  },
  splitting: true,
  outdir: path.join(DIST, 'assets'),
  entryNames: 'student-[hash]',
  chunkNames: 'chunk-[hash]',
  metafile: true,
  absWorkingDir: ROOT,
});

// The turn-guide worker is started with new URL('./guide.worker.js', import.meta.url). Give it a hashed name like
// the other files (so everything in assets/ can be cached for a year) and point that one string at the new name.
const workerBuild = await esbuild.build({
  ...common,
  entryPoints: [path.join(SRC, 'js/face/guide.worker.js')],
  outdir: path.join(DIST, 'assets'),
  entryNames: 'guide.worker-[hash]',
  metafile: true,
  absWorkingDir: ROOT,
});
const workerName = path.basename(Object.keys(workerBuild.metafile.outputs)[0]);
let patched = 0;
for (const file of Object.keys(result.metafile.outputs)) {
  const full = path.join(ROOT, file);
  const text = fs.readFileSync(full, 'utf8');
  if (text.includes('guide.worker.js')) {
    fs.writeFileSync(full, text.split('guide.worker.js').join(workerName));
    patched++;
  }
}
if (patched !== 1)
  throw new Error(
    `expected to point one file at the guide worker, found ${patched}`,
  );

// 4. Point student.html at the bundle
const outputs = result.metafile.outputs;
const find = input =>
  Object.entries(outputs).find(
    ([, o]) =>
      o.entryPoint &&
      o.entryPoint
        .split(path.sep)
        .join('/')
        .endsWith('/' + input),
  );
const [appFile, appMeta] =
  Object.entries(outputs).find(([, o]) => o.entryPoint) || [];
if (!appFile) throw new Error('bundle entry not found');
const url = f =>
  '/' + path.relative(DIST, path.join(ROOT, f)).split(path.sep).join('/');
const staticImports = meta =>
  meta.imports.filter(i => i.kind === 'import-statement').map(i => i.path);
const preload = [...new Set([appFile, ...staticImports(appMeta)])]
  .map(f => `    <link rel="modulepreload" href="${url(f)}" />`)
  .join('\n');

let html = fs.readFileSync(path.join(DIST, 'student.html'), 'utf8');
const eol = html.includes('\r\n') ? '\r\n' : '\n';
html = html.replace(/\r\n/g, '\n');
html = html.replace(
  /<!-- build:preload -->[\s\S]*?<!-- \/build:preload -->/,
  preload,
);
// auth-guard is inside the bundle now, so its own script tag goes
html = html
  .replace(
    /\s*<script src="utils\/auth-guard\.js" type="module"><\/script>/,
    '',
  )
  .replace('src="js/app.js"', `src="${url(appFile)}"`);
if (html.includes('js/app.js"') || html.includes('utils/auth-guard.js"'))
  throw new Error('student.html was not rewritten');
fs.writeFileSync(path.join(DIST, 'student.html'), html.replace(/\n/g, eol));

// 5. Brotli copies of every text file (the browser picks .br when it can)
let count = 0;
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(html|m?js|css|svg|json|wasm)$/.test(entry.name)) {
      const data = fs.readFileSync(full);
      if (data.length < 1024) continue;
      const br = zlib.brotliCompressSync(data, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
      });
      if (br.length < data.length * 0.95) {
        fs.writeFileSync(full + '.br', br);
        count++;
      }
    }
  }
})(DIST);

// 6. The copy for Cloudflare Pages: no .br files (Pages compresses by itself), the API address filled in,
//    and the cache rules as a _headers file (Pages does not run the server's cache code).
const PAGES = path.join(ROOT, 'pages-deploy');
fs.rmSync(PAGES, { recursive: true, force: true });
fs.cpSync(DIST, PAGES, {
  recursive: true,
  filter: src => !src.endsWith('.br'),
});
for (const unused of ['icons/mit-logo.png', 'icons/mit-building.jpg'])
  fs.rmSync(path.join(PAGES, unused), { force: true });
const HEAVY = [
  '/utils/ort/ort-wasm-simd-threaded.wasm',
  '/utils/models/det_500m.onnx',
  '/utils/models/w600k_mbf.onnx',
];
const assetsArg = process.argv.find(a => a.startsWith('--assets='));
const assetBase = assetsArg ? assetsArg.slice(9).replace(/\/+$/, '') : '';
if (assetBase) {
  if (!/^https:\/\/[^\s]+$/.test(assetBase)) {
    console.error(
      `--assets must look like https://cdn.jsdelivr.net/gh/USER/REPO@v1, got "${assetBase}"`,
    );
    process.exit(1);
  }
  // The big files are served by the CDN, so they are not uploaded to Cloudflare at all
  for (const heavy of HEAVY)
    fs.rmSync(path.join(PAGES, heavy.slice(1)), { force: true });
}
const apiArg = process.argv.find(a => a.startsWith('--api='));
const apiBase = (apiArg ? apiArg.slice(6) : process.env.API_BASE || '').replace(
  /\/+$/,
  '',
);
if (apiBase && !/^https:\/\/[^\s/]+$/.test(apiBase)) {
  console.error(
    `--api must look like https://your-name.ngrok-free.app (no path), got "${apiBase}"`,
  );
  process.exit(1);
}
const configFile = path.join(PAGES, 'utils/runtime-config.js');
const config = fs.readFileSync(configFile, 'utf8');
if (!config.includes("window.API_BASE = '';"))
  throw new Error('utils/runtime-config.js changed shape; update the build');
if (!config.includes("window.ASSET_BASE = '';"))
  throw new Error('utils/runtime-config.js changed shape; update the build');
fs.writeFileSync(
  configFile,
  config
    .replace(
      "window.API_BASE = '';",
      `window.API_BASE = ${JSON.stringify(apiBase)};`,
    )
    .replace(
      "window.ASSET_BASE = '';",
      `window.ASSET_BASE = ${JSON.stringify(assetBase)};`,
    ),
);
fs.copyFileSync(
  path.join(PAGES, 'homepage.html'),
  path.join(PAGES, 'index.html'),
);
// Rules must not overlap: where two rules match one file, Pages joins their values into one broken header.
fs.writeFileSync(
  path.join(PAGES, '_headers'),
  `/assets/*
  Cache-Control: public, max-age=31536000, immutable
/utils/ort/*
  Cache-Control: public, max-age=31536000, immutable
/utils/models/*
  Cache-Control: public, max-age=604800
/fonts/*
  Cache-Control: public, max-age=2592000, immutable
/icons/*
  Cache-Control: public, max-age=604800
/js/*
  Cache-Control: public, max-age=300
/css/*
  Cache-Control: public, max-age=300
`,
);
let biggest = 0;
let files = 0;
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      files++;
      biggest = Math.max(biggest, fs.statSync(full).size);
    }
  }
})(PAGES);
if (biggest > 25 * 1024 * 1024)
  throw new Error('a file is over the 25 MiB Cloudflare Pages limit');

// 7. --proxy: a Worker that serves the pages and forwards API calls to the tunnel, plus its wrangler config
const proxyArg = process.argv.find(a => a.startsWith('--proxy='));
if (proxyArg) {
  const origin = proxyArg.slice(8).replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+$/.test(origin)) {
    console.error(
      `--proxy must look like https://your-name.ngrok-free.app (no path), got "${origin}"`,
    );
    process.exit(1);
  }
  if (apiBase)
    console.warn(
      'Note: with --proxy the pages call their own address, so --api is not needed.',
    );
  const WORKER = path.join(ROOT, 'pages-worker');
  fs.rmSync(WORKER, { recursive: true, force: true });
  fs.mkdirSync(WORKER);
  fs.writeFileSync(
    path.join(WORKER, 'worker.js'),
    `// Serves the pages from the uploaded files and passes API traffic on to the tunnel.
// The browser only talks to this address, so there is no cross-origin check and no ngrok/zrok warning page
// (this request comes from Cloudflare, not a browser, and carries the skip headers).
const API = /^\\/(api|results|socket\\.io)\\//;
// The face files normally come from the CDN. If the CDN is blocked the page asks for them here, and they are
// fetched from your server (they are not in the uploaded files when --assets is used).
const HEAVY = new Set(${JSON.stringify(HEAVY)});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!API.test(url.pathname) && !HEAVY.has(url.pathname)) return env.ASSETS.fetch(request);
    const upstream = new Request(new URL(url.pathname + url.search, env.ORIGIN), request);
    upstream.headers.set('ngrok-skip-browser-warning', '1');
    upstream.headers.set('skip_zrok_interstitial', '1');
    try {
      return await fetch(upstream); // also carries the socket.io WebSocket upgrade
    } catch (error) {
      return new Response(JSON.stringify({ ok: false, error: 'server_unreachable' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
`,
  );
  fs.writeFileSync(
    path.join(WORKER, 'wrangler.jsonc'),
    JSON.stringify(
      {
        name: 'smart-attendance-marker',
        main: 'worker.js',
        compatibility_date: '2026-10-01',
        assets: {
          directory: '../pages-deploy',
          binding: 'ASSETS',
          run_worker_first: [
            '/api/*',
            '/results/*',
            '/socket.io/*',
            ...(assetBase ? HEAVY : []),
          ],
        },
        vars: { ORIGIN: origin },
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Made pages-worker/ (API traffic is passed on to ${origin}). Deploy with: cd pages-worker && npx wrangler deploy`,
  );
}

const kb = n => (n / 1024).toFixed(1) + ' KB';
console.log(`Built frontend-dist (${count} brotli files).`);
for (const [file, o] of Object.entries(outputs))
  console.log(
    `  ${path.relative(DIST, path.join(ROOT, file))}  ${kb(o.bytes)}`,
  );
console.log('Start the server with SERVE_DIST=1 to use frontend-dist.');
console.log(
  `Made pages-deploy (${files} files, largest ${kb(biggest)}), API_BASE = ${apiBase ? apiBase : "'' (not set: the pages would call their own address)"}, face files from ${assetBase || 'the same host as the pages'}`,
);
