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

// ================== prefetch & store models from manifest ==================
async function cacheModelsFromManifest(
  manifestUrl = '/utils/models/models-manifest.json',
) {
  try {
    // normalize manifest URL
    const normalizedManifestUrl = new URL(manifestUrl, location.origin).href;

    // fetch the manifest (network)
    console.log(
      'cacheModelsFromManifest: fetching manifest',
      normalizedManifestUrl,
    );
    const manifestResp = await fetch(normalizedManifestUrl, {
      cache: 'no-store',
    });
    if (!manifestResp.ok)
      throw new Error('Manifest fetch failed ' + manifestResp.status);

    // Clone response before reading to avoid stream consumed error
    const files = await manifestResp.clone().json();

    // files is an array of relative or absolute URLs
    for (const relative of files) {
      // normalize to absolute URL so keys are exact
      const url = new URL(relative, location.origin).href;

      // already cached?
      const existing = await idbGet(url);
      if (existing) {
        continue;
      }
      console.log('cacheModelsFromManifest: downloading', url);
      // fetch and store as blob
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error('Model fetch failed ' + url);
      const blob = await resp.blob();
      await idbPut(url, blob);
      console.log('Cached model', url);
    }
    console.log('All models cached locally.');
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
    console.log('Model fetch interceptor already installed');
    return;
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    try {
      const reqUrl = typeof input === 'string' ? input : input.url;
      const absUrl = new URL(reqUrl, location.origin).href;

      // intercept model requests under /utils/models/
      if (absUrl.includes('/utils/models/')) {
        console.log('Fetch Interceptor: model request for', absUrl);
        const blob = await idbGet(absUrl);
        if (blob) {
          console.log('Fetch Interceptor: serving from IndexedDB', absUrl);
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
  console.log('✅ Fetch model interceptor installed');
}
