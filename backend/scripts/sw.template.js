// Service worker for the BUILT site (backend/scripts/build-frontend.mjs fills in BUILD and PRECACHE and writes it to
// frontend-dist/sw.js). Source/dev pages never register it, so editing files in ../frontend is unaffected.
//
//  - Everything in PRECACHE is downloaded once per build and then served from the phone with no network request at all.
//    That is every page script, style, font and icon, so a repeat visit makes almost no requests, even on weak Wi-Fi.
//  - Pages (HTML) ask the network first, so a new deploy shows up on the next load. If the network is slow or down,
//    the saved copy is used.
//  - Other same-site files (for example the face engine's loader) are saved the first time they are used.
//  - Never touched: /api, /results, /socket.io, anything on another site (the face models on the CDN are kept by
//    the face engine in IndexedDB), and non-GET requests.
// The last two builds' caches are kept, so a page that is still open can fetch a file it loads late.
const BUILD = '__BUILD__';
const CACHE = `sam-${BUILD}`;
const PRECACHE = __PRECACHE__;
const KEEP_BUILDS = 2;
const PAGE_WAIT_MS = 2500; // how long a page waits for the network before showing its saved copy

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // One missing file must not stop the whole install, so each is added on its own.
      await Promise.allSettled(PRECACHE.map(url => cache.add(new Request(url, { cache: 'reload' }))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const names = (await caches.keys()).filter(name => name.startsWith('sam-')).sort().reverse();
      await Promise.all(names.slice(KEEP_BUILDS).map(name => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

// A response is only worth keeping if it is what the URL should be (a tunnel's warning page or an error would be HTML).
function worthKeeping(request, response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false;
  const type = response.headers.get('content-type') || '';
  const wantsHtml = request.mode === 'navigate' || /\.html?$/.test(new URL(request.url).pathname);
  return wantsHtml ? /text\/html/.test(type) : !/text\/html/.test(type);
}

async function keep(request, response) {
  if (!worthKeeping(request, response)) return;
  const cache = await caches.open(CACHE);
  await cache.put(request, response);
}

async function fromAnyCache(request, options) {
  return caches.match(request, options);
}

async function files(request) {
  const saved = await fromAnyCache(request);
  if (saved) return saved;
  const response = await fetch(request);
  const copy = response.clone();
  keep(request, copy).catch(() => {});
  return response;
}

async function pages(request) {
  const saved = await fromAnyCache(request, { ignoreSearch: true });
  const network = fetch(request).then(response => {
    keep(request, response.clone()).catch(() => {});
    return response;
  });
  if (!saved) return network;
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), PAGE_WAIT_MS));
  try {
    return (await Promise.race([network, timeout])) || saved;
  } catch {
    return saved; // offline
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/(api|results|socket\.io)\//.test(url.pathname) || url.pathname === '/sw.js') return;
  if (request.headers.has('range')) return; // media-style partial requests go straight through
  event.respondWith(request.mode === 'navigate' ? pages(request) : files(request));
});
