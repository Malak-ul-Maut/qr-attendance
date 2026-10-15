// Face engine worker. ALL model work happens here, so the page (camera, preview, buttons) never waits on it.
//
// Messages in:  { type:'init', version, assets:{ wasm, det, rec } }
//               { type:'detect', id, rgba, width, height, scale, threshold }
//               { type:'embed',  id, rgba }              (112x112 aligned face)
// Messages out: { type:'progress', loaded, total }  { type:'ready' }  { type:'error', id?, message }
//               { type:'result', id, ... }
/* global ort */
'use strict';

const ORT_BASE = '/utils/ort/';
importScripts(ORT_BASE + 'ort.wasm.min.js');

const STRIDES = [8, 16, 32];
const ANCHORS = 2;
const EMBEDDING_SIZE = 512;
const ARCFACE = 112;

let det = null;
let rec = null;

// ---------- asset cache (IndexedDB) ----------
// A self-signed https certificate makes browsers refuse to keep files in their normal HTTP cache, so the
// 27 MB of engine + models would be downloaded again on every visit. IndexedDB is not affected.
const DB_NAME = 'face-assets';
const STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}
async function cacheGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch { return null; } // no cache is fine, the file is just downloaded
}
async function cachePut(key, buffer) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(buffer, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  } catch { /* storage full or blocked: carry on without caching */ }
}
async function cacheDeleteOthers(keep) {
  try {
    const db = await openDb();
    await new Promise(resolve => {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => { for (const k of req.result) if (!keep.has(k)) store.delete(k); };
      store.transaction.oncomplete = () => { db.close(); resolve(); };
      store.transaction.onerror = () => { db.close(); resolve(); };
    });
  } catch { /* ignore */ }
}

// Downloads one file with progress. Rejects with a readable message for the usual server mistakes.
async function download(url, onBytes) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  // A server that answers a missing file with its home page would otherwise give us HTML to parse as a model.
  if (/text\/html/i.test(type)) throw new Error(`${url} is missing on the server (got a web page instead)`);
  const total = Number(res.headers.get('content-length')) || 0;
  onBytes(0, total);
  if (!res.body?.getReader) { const b = await res.arrayBuffer(); onBytes(b.byteLength, 0); return b; }
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    onBytes(value.length, 0);
  }
  if (total && size !== total) throw new Error(`${url} download was cut short (${size} of ${total} bytes)`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out.buffer;
}

async function getAsset(name, url, version, onBytes) {
  const key = `${version}:${name}:${url}`;
  const hit = await cacheGet(key);
  if (hit && hit.byteLength > 0) { onBytes(hit.byteLength, hit.byteLength); return { key, buffer: hit }; }
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) { // a flaky phone connection gets two more tries
    try {
      const buffer = await download(url, onBytes);
      await cachePut(key, buffer);
      return { key, buffer };
    } catch (error) {
      lastError = error;
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastError;
}

// ---------- init ----------
async function init({ version, assets }) {
  let loaded = 0;
  let total = 0;
  const report = () => postMessage({ type: 'progress', loaded, total });
  // track(bytesJustReceived, totalOfThisFileIfJustLearned)
  const track = (n, fileTotal) => {
    if (fileTotal) total += fileTotal;
    loaded += n;
    report();
  };
  const wasm = getAsset('wasm', assets.wasm, version, track);
  const det_ = getAsset('det', assets.det, version, track);
  const rec_ = getAsset('rec', assets.rec, version, track);
  const [w, d, r] = await Promise.all([wasm, det_, rec_]);
  cacheDeleteOthers(new Set([w.key, d.key, r.key])); // old versions are not needed any more

  postMessage({ type: 'stage', stage: 'starting' });
  ort.env.logLevel = 'error';
  // One thread: for models this small, extra threads are slower (see CHANGES.md) and would need
  // cross-origin isolation headers that make the page fragile.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false; // we ARE the worker
  ort.env.wasm.wasmPaths = {
    mjs: new URL(ORT_BASE + 'ort-wasm-simd-threaded.mjs', self.location.href).href,
    wasm: URL.createObjectURL(new Blob([w.buffer], { type: 'application/wasm' })),
  };
  const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
  det = await ort.InferenceSession.create(new Uint8Array(d.buffer), options);
  rec = await ort.InferenceSession.create(new Uint8Array(r.buffer), options);

  // The first run of a session is slow (memory and kernels are set up). Do it now, on a blank image.
  await runDetector(new Uint8ClampedArray(320 * 256 * 4), 320, 256, 1, 0.5);
  await runRecognizer(new Uint8ClampedArray(ARCFACE * ARCFACE * 4));
}

// ---------- detector (SCRFD det_500m) ----------
function rgbaToPlanar(rgba, width, height, mean, std) {
  const plane = width * height;
  const data = new Float32Array(plane * 3);
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    data[i] = (rgba[p] - mean) / std;
    data[plane + i] = (rgba[p + 1] - mean) / std;
    data[plane * 2 + i] = (rgba[p + 2] - mean) / std;
  }
  return data;
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / Math.max(areaA + areaB - inter, 1e-6);
}

// width/height: size of the (letterboxed) image given to the model, both multiples of 32.
// scale: model pixels per original pixel. Boxes come back in original pixels.
async function runDetector(rgba, width, height, scale, threshold) {
  const input = new ort.Tensor('float32', rgbaToPlanar(rgba, width, height, 127.5, 128), [1, 3, height, width]);
  const outputs = await det.run({ [det.inputNames[0]]: input });
  const names = det.outputNames;
  const found = [];
  for (let level = 0; level < STRIDES.length; level++) {
    const stride = STRIDES[level];
    const scores = outputs[names[level]].data;
    const boxes = outputs[names[level + 3]].data;
    const marks = outputs[names[level + 6]].data;
    const gridW = width / stride;
    const gridH = height / stride;
    if (scores.length !== gridW * gridH * ANCHORS || boxes.length !== scores.length * 4 || marks.length !== scores.length * 10)
      throw new Error('Unexpected detector output shape');
    for (let i = 0; i < scores.length; i++) {
      const score = scores[i];
      if (score < threshold) continue;
      const cell = (i / ANCHORS) | 0;
      const cx = (cell % gridW) * stride;
      const cy = ((cell / gridW) | 0) * stride;
      const o = i * 4;
      const box = {
        x1: (cx - boxes[o] * stride) / scale,
        y1: (cy - boxes[o + 1] * stride) / scale,
        x2: (cx + boxes[o + 2] * stride) / scale,
        y2: (cy + boxes[o + 3] * stride) / scale,
      };
      if (!(box.x2 > box.x1 && box.y2 > box.y1)) continue;
      const m = i * 10;
      const landmarks = [];
      for (let p = 0; p < 5; p++)
        landmarks.push({ x: (cx + marks[m + p * 2] * stride) / scale, y: (cy + marks[m + p * 2 + 1] * stride) / scale });
      found.push({ box, landmarks, score });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const f of found.slice(0, 500)) {
    if (kept.length >= 10) break;
    if (!kept.some(k => iou(k.box, f.box) > 0.4)) kept.push(f);
  }
  return kept;
}

// ---------- recognizer (ArcFace MobileFaceNet w600k_mbf) ----------
async function runRecognizer(rgba) {
  const input = new ort.Tensor('float32', rgbaToPlanar(rgba, ARCFACE, ARCFACE, 127.5, 127.5), [1, 3, ARCFACE, ARCFACE]);
  const out = (await rec.run({ [rec.inputNames[0]]: input }))[rec.outputNames[0]].data;
  if (out.length !== EMBEDDING_SIZE) throw new Error('Unexpected embedding size');
  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm < 1e-12) throw new Error('Invalid embedding');
  const emb = new Float32Array(EMBEDDING_SIZE);
  for (let i = 0; i < EMBEDDING_SIZE; i++) emb[i] = out[i] / norm;
  return emb;
}

// ---------- message loop ----------
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      await init(data);
      postMessage({ type: 'ready' });
    } else if (data.type === 'detect') {
      const t0 = performance.now();
      const faces = await runDetector(new Uint8ClampedArray(data.rgba), data.width, data.height, data.scale, data.threshold);
      postMessage({ type: 'result', id: data.id, faces, ms: performance.now() - t0 });
    } else if (data.type === 'embed') {
      const t0 = performance.now();
      const embedding = await runRecognizer(new Uint8ClampedArray(data.rgba));
      postMessage({ type: 'result', id: data.id, embedding, ms: performance.now() - t0 }, [embedding.buffer]);
    }
  } catch (error) {
    postMessage({ type: 'error', id: data.id, message: String(error?.message || error) });
  }
};
