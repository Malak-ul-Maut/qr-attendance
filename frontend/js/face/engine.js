// Main-thread side of the face engine. The models live in a Web Worker (engine.worker.js), so a slow phone
// can never freeze the camera preview, the buttons, or the camera permission flow while a model runs.
//
//   import { engine } from './face/engine.js';
//   engine.start(({ phase, fraction }) => ...);   // safe to call many times; resolves when ready
//   const faces = await engine.detect(video);      // [{ box, landmarks, score }] in video pixels
//   const vector = await engine.embed(alignFace(canvas, face.landmarks));

// Bump when a model file changes: the cached copies on phones are replaced.
const VERSION = '2';
const ASSETS = {
  wasm: '/utils/ort/ort-wasm-simd-threaded.wasm',
  det: '/utils/models/det_500m.onnx',
  rec: '/utils/models/w600k_mbf.onnx',
};
const DETECT_LONG_SIDE = 320; // the detector sees the frame shrunk to this many pixels on its long side
const CALL_TIMEOUT_MS = 10000; // a worker call that takes longer than this means the worker is stuck
const NO_PROGRESS_MS = 45000; // no byte or stage update for this long while loading means it is stuck

const ceil32 = n => Math.max(32, Math.ceil(n / 32) * 32);

class FaceEngine {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.listeners = new Set();
    this.readyPromise = null;
    this.lastUpdate = null;
    this.scratch = null;
    this.timings = { detectMs: 0, embedMs: 0 };
  }

  // Starts loading (first call) and joins the load already running (later calls).
  // onProgress({ phase: 'download' | 'prepare', fraction | null })
  start(onProgress) {
    if (onProgress) {
      this.listeners.add(onProgress);
      if (this.lastUpdate) onProgress(this.lastUpdate);
    }
    if (!this.readyPromise) this.readyPromise = this.#boot();
    const done = () => onProgress && this.listeners.delete(onProgress);
    this.readyPromise.then(done, done);
    return this.readyPromise;
  }

  #emit(update) {
    this.lastUpdate = update;
    this.listeners.forEach(fn => fn(update));
  }

  #boot() {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker('/js/face/engine.worker.js');
      } catch (error) {
        return reject(new Error(`Could not start the face engine worker: ${error.message}`));
      }
      this.worker = worker;
      let settled = false;
      let watchdog;
      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        this.#teardown(error);
        reject(error);
      };
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => fail(new Error('The face engine stopped responding while loading.')), NO_PROGRESS_MS);
      };
      arm();
      this.#emit({ phase: 'download', fraction: null });
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          arm();
          this.#emit({ phase: 'download', fraction: data.total ? Math.min(data.loaded / data.total, 1) : null });
        } else if (data.type === 'stage') {
          arm();
          this.#emit({ phase: 'prepare', fraction: null });
        } else if (data.type === 'ready') {
          settled = true;
          clearTimeout(watchdog);
          worker.onmessage = event => this.#onMessage(event.data);
          worker.onerror = event => this.#teardown(new Error(event.message || 'The face engine crashed.'));
          this.lastUpdate = null;
          resolve();
        } else if (data.type === 'error') {
          fail(new Error(data.message));
        }
      };
      worker.onerror = event => fail(new Error(event.message || 'The face engine crashed while loading.'));
      worker.postMessage({ type: 'init', version: VERSION, assets: ASSETS });
    });
  }

  // Everything pending fails, and the next start() builds a fresh worker.
  #teardown(error) {
    this.worker?.terminate();
    this.worker = null;
    this.readyPromise = null;
    this.lastUpdate = null;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }

  #onMessage(data) {
    const entry = this.pending.get(data.id);
    if (!entry) return;
    this.pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.type === 'error') entry.reject(new Error(data.message));
    else entry.resolve(data);
  }

  #call(message, transfer) {
    if (!this.worker) return Promise.reject(new Error('The face engine is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A hung worker cannot be recovered: drop it so the next start() makes a new one.
        this.#teardown(new Error('The face engine did not answer in time.'));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  // Finds faces in the current video frame. Resolves to [] when there is none.
  async detect(video, threshold = 0.5) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) throw new Error('The camera has not produced a picture yet.');
    const scale = DETECT_LONG_SIDE / Math.max(vw, vh);
    const width = ceil32(vw * scale);
    const height = ceil32(vh * scale);
    if (!this.scratch || this.scratch.canvas.width !== width || this.scratch.canvas.height !== height) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      this.scratch = { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
    }
    const { context } = this.scratch;
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);
    context.drawImage(video, 0, 0, Math.round(vw * scale), Math.round(vh * scale));
    const rgba = context.getImageData(0, 0, width, height).data.buffer;
    const result = await this.#call({ type: 'detect', rgba, width, height, scale, threshold }, [rgba]);
    this.timings.detectMs = result.ms;
    return result.faces;
  }

  // canvas: a 112x112 aligned face (see align.js). Resolves to a unit-length Float32Array(512).
  async embed(canvas) {
    const rgba = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data.buffer;
    const result = await this.#call({ type: 'embed', rgba }, [rgba]);
    this.timings.embedMs = result.ms;
    return result.embedding;
  }
}

export const engine = new FaceEngine();
