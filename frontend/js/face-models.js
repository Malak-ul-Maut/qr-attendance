// The face models (detector, liveness, recognizer), loaded once and shared by the scan flow and enrolment.
import { createFaceModels } from '../utils/face-onnx.js';

let promise = null;

// Starts loading on the first call; later calls share the same promise.
// `cacheModelsFromManifest` comes from utils/cache-models.js (a plain script on the page).
export function loadFaceModels() {
  promise ||= (async () => {
    const cached = await cacheModelsFromManifest('/utils/models/models-manifest.json');
    if (!cached) throw new Error('Could not prepare the face models.');
    return createFaceModels({ liveness: true });
  })();
  // A failed load can be retried on the next call
  promise.catch(() => { promise = null; });
  return promise;
}
