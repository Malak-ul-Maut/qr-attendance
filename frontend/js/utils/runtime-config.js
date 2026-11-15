// Loaded first on every page (a plain script, not a module).
//
// API_BASE is the address of the server that answers /api, /results and /socket.io. Leave it '' when this
// server also serves the pages (the usual way). When the pages are hosted somewhere else (Cloudflare Pages),
// `node scripts/build-frontend.mjs` writes your tunnel address here in the copy it makes for that host.
// Example: window.API_BASE = 'https://your-name.ngrok-free.app';
window.API_BASE = '';

// ASSET_BASE is where the face-engine WASM and models are downloaded from.
// Source pages served by the backend get this value from assets.manifest.json. The optimized build requires a CDN
// (`--assets=`) and omits these files, so built pages need CDN access for face verification.
window.ASSET_BASE = '';

// SW_ENABLED turns on the service worker (sw.js), which keeps the site's own files on the phone. Only the built site
// (`npm run build`) has a sw.js, so the build switches this on; source/dev pages leave it off.
window.SW_ENABLED = false;
if (window.SW_ENABLED && 'serviceWorker' in navigator)
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {
      // not a secure page, or blocked: the site just works without it
    });
  });

(function () {
  var base = String(window.API_BASE || '').replace(/\/+$/, '');
  window.API_BASE = base;
  window.apiUrl = function (path) { return base + path; };
  if (!base) return; // same server: nothing to do

  // Every fetch('/api/...') in the pages is sent to the API server instead. The two extra headers make the
  // free ngrok and zrok "are you sure you want to visit" pages skip fetch calls (they would otherwise reply
  // with HTML instead of JSON).
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof input === 'string' && /^\/(api|results)\//.test(input)) {
      var headers = new Headers((init && init.headers) || {});
      headers.set('ngrok-skip-browser-warning', '1');
      headers.set('skip_zrok_interstitial', '1');
      input = base + input;
      init = Object.assign({}, init, { headers: headers });
    }
    return nativeFetch(input, init);
  };
})();
