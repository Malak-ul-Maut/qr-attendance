// Loaded first on every page (a plain script, not a module).
//
// API_BASE is the address of the server that answers /api, /results and /socket.io. Leave it '' when this
// server also serves the pages (the usual way). When the pages are hosted somewhere else (Cloudflare Pages),
// `node scripts/build-frontend.mjs` writes your tunnel address here in the copy it makes for that host.
// Example: window.API_BASE = 'https://your-name.ngrok-free.app';
window.API_BASE = '';

// ASSET_BASE is where the 27 MB of face files (ONNX Runtime .wasm and two models) are downloaded from.
// '' = the same host as the page. `--assets=` in the build sets it to a CDN. If the CDN cannot be reached the
// engine falls back to API_BASE, which always has the files.
window.ASSET_BASE = '';

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
