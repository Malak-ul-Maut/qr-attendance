const DB_NAME = 'faceapi-models-db';
const STORE_NAME = 'models';

// ========== small IndexedDB wrapper ==========
function openDb(dbName = DB_NAME, storeName = STORE_NAME) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(storeName);
    };
    req.onsuccess = () => resolve({ db: req.result, storeName });
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, blob, dbName = DB_NAME, storeName = STORE_NAME) {
  const { db, storeName: s } = await openDb(dbName, storeName);
  return new Promise((res, rej) => {
    const tx = db.transaction(s, 'readwrite');
    tx.objectStore(s).put(blob, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function idbGet(key, dbName = DB_NAME, storeName = STORE_NAME) {
  const { db, storeName: s } = await openDb(dbName, storeName);
  return new Promise((res, rej) => {
    const tx = db.transaction(s, 'readonly');
    const req = tx.objectStore(s).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

// Helper to determine content type from URL
function contentTypeFromUrl(url) {
  if (url.endsWith('.json')) return 'application/json';
  if (url.endsWith('.bin')) return 'application/octet-stream';
  return 'application/octet-stream';
}

async function fetchModelInChunks(url) {
  const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  if (!head.ok) throw new Error(`Model metadata fetch failed ${url}: ${head.status}`);

  const size = Number(head.headers.get('content-length'));
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error(`Model size is unavailable for chunked download: ${url}`);

  const chunkSize = 1024 * 1024;
  const chunks = [];
  for (let start = 0; start < size; start += chunkSize) {
    const end = Math.min(start + chunkSize, size) - 1;
    const resp = await fetch(url, {
      cache: 'no-store',
      headers: { Range: `bytes=${start}-${end}` },
    });
    const contentRange = resp.headers.get('content-range');
    if (
      resp.status !== 206 ||
      contentRange !== `bytes ${start}-${end}/${size}`
    ) {
      throw new Error(
        `Invalid model chunk response for ${url}: expected bytes ${start}-${end}/${size}, received ${contentRange || resp.status}`,
      );
    }

    const chunk = await resp.blob();
    if (chunk.size !== end - start + 1)
      throw new Error(`Incomplete model chunk received for ${url}`);
    chunks.push(chunk);
  }

  return new Blob(chunks, { type: 'application/octet-stream' });
}

// onBytes(n) is called with the size of every piece that arrives, so the page can show a progress bar.
async function fetchModelBlob(url, onBytes = () => {}) {
  let resp;
  try {
    resp = await fetch(url, { cache: 'no-store' });
  } catch (error) {
    console.warn('Model download failed; retrying in chunks', url, error);
    return fetchModelInChunks(url);
  }

  if (!resp.ok) {
    if (resp.status < 500)
      throw new Error(`Model fetch failed ${url}: ${resp.status}`);
    console.warn(`Model fetch returned ${resp.status}; retrying in chunks`, url);
    return fetchModelInChunks(url);
  }

  try {
    if (!resp.body?.getReader) return await resp.blob(); // very old browser: no streaming, no progress
    const reader = resp.body.getReader();
    const pieces = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pieces.push(value);
      received += value.length;
      onBytes(value.length);
    }
    return new Blob(pieces, { type: 'application/octet-stream' });
  } catch (error) {
    console.warn('Model response was interrupted; retrying in chunks', url, error);
    return fetchModelInChunks(url);
  }
}

// ================== prefetch & store models from manifest ==================
// onProgress({ loaded, total }) gets bytes of the models still to download (never called when all are cached).
async function cacheModelsFromManifest(
  manifestUrl = '/utils/models/models-manifest.json',
  onProgress = null,
) {
  try {
    // normalize manifest URL
    const normalizedManifestUrl = new URL(manifestUrl, location.origin).href;

    // fetch the manifest (network)
    const manifestResp = await fetch(normalizedManifestUrl, {
      cache: 'no-store',
    });
    if (!manifestResp.ok)
      throw new Error('Manifest fetch failed ' + manifestResp.status);

    // Clone response before reading to avoid stream consumed error
    const files = await manifestResp.clone().json();

    // files is an array of relative or absolute URLs. First find which ones are not stored yet.
    const missing = [];
    for (const relative of files) {
      // normalize to absolute URL so keys are exact
      const url = new URL(relative, location.origin).href;
      if (!(await idbGet(url))) missing.push(url);
    }

    // Total size of the missing files, so the bar has an end (0 when the server does not say)
    let total = 0;
    if (onProgress) {
      const sizes = await Promise.all(
        missing.map(url =>
          fetch(url, { method: 'HEAD', cache: 'no-store' })
            .then(r => Number(r.headers.get('content-length')) || 0)
            .catch(() => 0),
        ),
      );
      total = sizes.reduce((a, b) => a + b, 0);
    }
    let loaded = 0;
    const report = () => onProgress && onProgress({ loaded, total });
    report();

    for (const url of missing) {
      console.log('cacheModelsFromManifest: downloading', url);
      const blob = await fetchModelBlob(url, n => {
        loaded += n;
        report();
      });
      await idbPut(url, blob);
      console.log('Cached model', url);
    }
    installModelFetchInterceptor();
    return true;
  } catch (e) {
    console.error('cacheModelsFromManifest error', e);
    return false;
  }
}

// ================== monkeypatch fetch for model requests ==================
function installModelFetchInterceptor() {
  if (window.__faceApiFetchInterceptorInstalled) {
    return;
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    try {
      const reqUrl = typeof input === 'string' ? input : input.url;
      const absUrl = new URL(reqUrl, location.origin).href;

      // intercept model requests under /utils/models/
      if (absUrl.includes('/utils/models/')) {
        const blob = await idbGet(absUrl);
        if (blob) {
          // respond from IndexedDB without network
          const ct = contentTypeFromUrl(absUrl);
          return new Response(blob, {
            status: 200,
            headers: { 'Content-Type': ct },
          });
        } else {
          console.log('Fetch Interceptor: cache miss -> network for', absUrl);
          // not cached yet — fall back to network
          return originalFetch(input, init);
        }
      }
      // not a model request, pass through
      return originalFetch(input, init);
    } catch (e) {
      console.warn('Fetch Interceptor: error, falling back to network', e);
      // on any internal error, fall back to network
      return originalFetch(input, init);
    }
  };

  window.__faceApiFetchInterceptorInstalled = true;
}
