// Serves the pages from the uploaded files and passes API traffic on to the tunnel.
// The browser only talks to this address, so there is no cross-origin check and no ngrok/zrok warning page
// (this request comes from Cloudflare, not a browser, and carries the skip headers).
const API = /^\/(api|results|socket\.io)\//;
// The face files normally come from the CDN. If the CDN is blocked the page asks for them here, and they are
// fetched from your server (they are not in the uploaded files when --assets is used).
const HEAVY = new Set(["/utils/ort/ort-wasm-simd-threaded.wasm","/utils/models/det_500m.onnx","/utils/models/w600k_mbf.onnx"]);

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
