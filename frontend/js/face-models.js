// The face models (detector, liveness, recognizer), loaded once and shared by the scan flow and enrolment.
import { createFaceModels } from '../utils/face-onnx.js';

// The ONNX Runtime engine (about 11 MB) is fetched by the library itself the moment the first model starts,
// which used to happen out of sight. We fetch it first, with a progress bar. The browser keeps it in its
// HTTP cache (the server marks /utils/ort as cacheable for a year), so the library's own request is instant.
const ENGINE_FILES = ['/utils/ort/ort-wasm-simd-threaded.wasm', '/utils/ort/ort-wasm-simd-threaded.mjs'];

let promise = null;
const listeners = new Set(); // everyone currently waiting gets the progress updates
let lastProgress = null;

// Downloads the engine files, calling onBytes(n) for each piece. Resolves to the total size (0 if unknown).
async function fetchEngine(onBytes) {
  for (const url of ENGINE_FILES) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download ${url}: ${response.status}`);
    if (!response.body?.getReader) { await response.blob(); continue; }
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onBytes(value.length);
    }
  }
}

async function engineSize() {
  const sizes = await Promise.all(ENGINE_FILES.map(url =>
    fetch(url, { method: 'HEAD' }).then(r => Number(r.headers.get('content-length')) || 0).catch(() => 0)));
  return sizes.reduce((a, b) => a + b, 0);
}

// onProgress({ phase, fraction }): phase is 'download' (fraction 0..1, or null when the size is unknown),
// 'prepare' (everything is downloaded and the models are starting, a few seconds of work on the phone itself).
// `cacheModelsFromManifest` comes from utils/cache-models.js (a plain script on the page).
export function loadFaceModels(onProgress) {
  if (onProgress) {
    listeners.add(onProgress);
    if (lastProgress) onProgress(lastProgress); // a second caller joins midway
  }
  const emit = update => {
    lastProgress = update;
    listeners.forEach(fn => fn(update));
  };
  promise ||= (async () => {
    let modelBytes = 0, modelTotal = 0, engineBytes = 0, engineTotal = 0;
    const report = () => {
      const total = modelTotal + engineTotal;
      emit({ phase: 'download', fraction: total ? Math.min((modelBytes + engineBytes) / total, 1) : null });
    };
    engineTotal = await engineSize();
    const cached = await cacheModelsFromManifest('/utils/models/models-manifest.json', ({ loaded, total }) => {
      modelBytes = loaded; modelTotal = total; report();
    });
    if (!cached) throw new Error('Could not prepare the face models.');
    await fetchEngine(n => { engineBytes += n; report(); });
    emit({ phase: 'prepare', fraction: null });
    return createFaceModels({ liveness: true });
  })();
  // A failed load can be retried on the next call
  promise.catch(() => { promise = null; lastProgress = null; });
  const done = () => { if (onProgress) listeners.delete(onProgress); };
  promise.then(() => { lastProgress = null; done(); }, done);
  return promise;
}
