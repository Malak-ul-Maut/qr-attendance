const MODEL_ROOT = '/utils/models';

// 3 = only log real errors. ORT's default (warnings) prints a harmless output-shape
// warning for every detector output on every frame, which floods the console.
const BASE_SESSION_OPTIONS = { logSeverityLevel: 3 };

// The detector input size decides how many pixels the model has to process.
// 320 is about 4x cheaper than 640. If det_500m.onnx only accepts 640,
// detectFaces() switches to 640 automatically the first time 320 fails.
const PREFERRED_DETECTOR_SIZE = 320;
const FALLBACK_DETECTOR_SIZE = 640;
let detectorSize = PREFERRED_DETECTOR_SIZE;

const DETECTOR_STRIDES = [8, 16, 32];
const EMBEDDING_SIZE = 512;
const ARCFACE_SIZE = 112;
const ARCFACE_TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

// Time spent inside session.run() only (no canvas or JS work), updated on every call
export const timings = {
  detectorRunMs: 0,
  recognizerRunMs: 0,
  livenessRunMs: 0,
};

function getOrt() {
  if (!window.ort) throw new Error('ONNX Runtime Web is not loaded.');
  return window.ort;
}

// Loads one model on the CPU with WASM
async function createSession(ort, modelPath) {
  try {
    const session = await ort.InferenceSession.create(modelPath, {
      ...BASE_SESSION_OPTIONS,
      executionProviders: ['wasm'],
    });
    return session;
  } catch (error) {
    // Show exactly which model failed and why
    console.error(`[Face models] could not load ${modelPath}`, error);
    throw error;
  }
}

// Most CPU threads WASM may use.
const MAX_WASM_THREADS = 4;

export async function createFaceModels({ liveness = false } = {}) {
  const ort = getOrt();
  // Self-hosted ORT files (must be the same version as ort.wasm.min.js)
  ort.env.wasm.wasmPaths = '/utils/ort/';
  ort.env.logLevel = 'error';

  // Multi-threaded WASM only works when the page is cross-origin isolated
  // (the server must send the COOP and COEP headers). Otherwise it stays at 1 thread.
  ort.env.wasm.numThreads = window.crossOriginIsolated
    ? Math.min(MAX_WASM_THREADS, navigator.hardwareConcurrency || 1)
    : 1;
    
  const [detector, recognizer, livenessSession] = await Promise.all([
    createSession(ort, `${MODEL_ROOT}/det_500m.onnx`),
    createSession(ort, `${MODEL_ROOT}/w600k_mbf.onnx`),
    liveness
      ? createSession(ort, `${MODEL_ROOT}/minifasnetv2_quant.onnx`)
      : Promise.resolve(null),
  ]);

  const models = { detector, recognizer, liveness: livenessSession };
  await warmUp(models);
  return models;
}

// The first run of every ONNX session is slow (memory and kernels get set up).
// Running each model once on a blank image means the first real frame is already fast.
async function warmUp({ detector, recognizer, liveness }) {
  try {
    const blankDetectorFrame = makeCanvas(FALLBACK_DETECTOR_SIZE, FALLBACK_DETECTOR_SIZE).canvas;
    await detectFaces(blankDetectorFrame, detector);

    const blankFace = makeCanvas(ARCFACE_SIZE, ARCFACE_SIZE).canvas;
    await recognizer.run({
      [recognizer.inputNames[0]]: prepareFaceTensor(blankFace, ARCFACE_SIZE, 127.5, 127.5),
    });

    if (liveness) {
      const blankCrop = makeCanvas(128, 128).canvas;
      await scoreLiveness(blankCrop, liveness);
    }
  } catch (error) {
    // A failed warm-up only means the first frame is slower, so don't block the app
    console.warn('[Face models] warm-up failed', error);
  }
}

function dimensions(source) {
  const width = source.videoWidth || source.naturalWidth || source.width;
  const height = source.videoHeight || source.naturalHeight || source.height;
  if (!width || !height) throw new Error('Image has no usable dimensions.');
  return { width, height };
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create a canvas context.');
  return { canvas, context };
}

// Canvases are reused between frames instead of being created again every time
const scratchCanvases = new Map();
function getScratchCanvas(key, width, height) {
  let entry = scratchCanvases.get(key);
  if (!entry || entry.canvas.width !== width || entry.canvas.height !== height) {
    entry = makeCanvas(width, height);
    scratchCanvases.set(key, entry);
  }
  return entry;
}

function imageToTensor(source, width, height, { mean, std, rgb = true }) {
  let context;
  if (source instanceof HTMLCanvasElement && source.width === width && source.height === height) {
    // The source is already a canvas of the right size, so read its pixels directly
    context = source.getContext('2d', { willReadFrequently: true });
  } else {
    ({ context } = getScratchCanvas(`tensor-${width}x${height}`, width, height));
    context.drawImage(source, 0, 0, width, height);
  }
  const pixels = context.getImageData(0, 0, width, height).data;
  const planeSize = width * height;
  const data = new Float32Array(planeSize * 3);

  for (let i = 0; i < planeSize; i++) {
    const pixel = i * 4;
    const first = rgb ? pixels[pixel] : pixels[pixel + 2];
    const third = rgb ? pixels[pixel + 2] : pixels[pixel];
    data[i] = (first - mean) / std;
    data[planeSize + i] = (pixels[pixel + 1] - mean) / std;
    data[planeSize * 2 + i] = (third - mean) / std;
  }

  return data;
}

function intersectionOverUnion(a, b) {
  const x1 = Math.max(a.box.x1, b.box.x1);
  const y1 = Math.max(a.box.y1, b.box.y1);
  const x2 = Math.min(a.box.x2, b.box.x2);
  const y2 = Math.min(a.box.y2, b.box.y2);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.box.x2 - a.box.x1) * (a.box.y2 - a.box.y1);
  const areaB = (b.box.x2 - b.box.x1) * (b.box.y2 - b.box.y1);
  return intersection / Math.max(areaA + areaB - intersection, 1e-6);
}

function nonMaximumSuppression(faces, threshold = 0.4) {
  const kept = [];
  faces.sort((a, b) => b.score - a.score);
  while (faces.length) {
    const best = faces.shift();
    kept.push(best);
    for (let i = faces.length - 1; i >= 0; i--) {
      if (intersectionOverUnion(best, faces[i]) > threshold) faces.splice(i, 1);
    }
  }
  return kept;
}

// Runs the detector once at a given input size
async function detectFacesAtSize(source, session, scoreThreshold, size) {
  const { width, height } = dimensions(source);
  const scale = Math.min(size / width, size / height);
  const resizedWidth = Math.round(width * scale);
  const resizedHeight = Math.round(height * scale);
  const { canvas, context } = getScratchCanvas('detector', size, size);
  context.fillStyle = 'black';
  context.fillRect(0, 0, size, size);
  context.drawImage(source, 0, 0, resizedWidth, resizedHeight);

  const ort = getOrt();
  const inputName = session.inputNames[0];
  // The canvas is already size x size, so its pixels are read directly
  const input = imageToTensor(canvas, size, size, {
    mean: 127.5,
    std: 128,
  });
  const runStartedAt = performance.now();
  const outputs = await session.run({
    [inputName]: new ort.Tensor('float32', input, [1, 3, size, size]),
  });
  timings.detectorRunMs = performance.now() - runStartedAt;
  const outputTensors = session.outputNames.map(name => outputs[name]);
  const faces = [];

  for (let level = 0; level < DETECTOR_STRIDES.length; level++) {
    const stride = DETECTOR_STRIDES[level];
    const scores = outputTensors[level].data;
    const boxes = outputTensors[level + DETECTOR_STRIDES.length].data;
    const landmarks = outputTensors[level + DETECTOR_STRIDES.length * 2].data;
    const gridWidth = size / stride;
    const anchorsPerCell = scores.length / (gridWidth * gridWidth);

    if (!Number.isInteger(anchorsPerCell) || boxes.length !== scores.length * 4 || landmarks.length !== scores.length * 10) {
      throw new Error('SCRFD model output shape is not supported.');
    }

    for (let i = 0; i < scores.length; i++) {
      const score = scores[i];
      if (score < scoreThreshold) continue;

      const cell = Math.floor(i / anchorsPerCell);
      const centerX = (cell % gridWidth) * stride;
      const centerY = Math.floor(cell / gridWidth) * stride;
      const offset = i * 4;
      const box = {
        x1: (centerX - boxes[offset] * stride) / scale,
        y1: (centerY - boxes[offset + 1] * stride) / scale,
        x2: (centerX + boxes[offset + 2] * stride) / scale,
        y2: (centerY + boxes[offset + 3] * stride) / scale,
      };
      const landmarkOffset = i * 10;
      const points = Array.from({ length: 5 }, (_, point) => ({
        x: (centerX + landmarks[landmarkOffset + point * 2] * stride) / scale,
        y: (centerY + landmarks[landmarkOffset + point * 2 + 1] * stride) / scale,
      }));
      box.x1 = Math.max(0, Math.min(width, box.x1));
      box.y1 = Math.max(0, Math.min(height, box.y1));
      box.x2 = Math.max(0, Math.min(width, box.x2));
      box.y2 = Math.max(0, Math.min(height, box.y2));
      if (box.x2 > box.x1 && box.y2 > box.y1) faces.push({ box, landmarks: points, score });
    }
  }

  faces.sort((a, b) => b.score - a.score);
  return nonMaximumSuppression(faces.slice(0, 1000)).slice(0, 20);
}

export async function detectFaces(source, session, scoreThreshold = 0.5) {
  try {
    return await detectFacesAtSize(source, session, scoreThreshold, detectorSize);
  } catch (error) {
    // The model may only support its original 640 input, so switch to it once and retry
    if (detectorSize === FALLBACK_DETECTOR_SIZE) throw error;
    console.warn(`[Face models] detector failed at ${detectorSize}px, switching to ${FALLBACK_DETECTOR_SIZE}px`, error);
    detectorSize = FALLBACK_DETECTOR_SIZE;
    return detectFacesAtSize(source, session, scoreThreshold, detectorSize);
  }
}

export function createSquareFaceCrop(source, face, expansion = 1.5, size = 128) {
  const { width, height } = dimensions(source);
  const faceWidth = face.box.x2 - face.box.x1;
  const faceHeight = face.box.y2 - face.box.y1;
  const side = Math.min(Math.max(faceWidth, faceHeight) * expansion, width, height);
  const centerX = (face.box.x1 + face.box.x2) / 2;
  const centerY = (face.box.y1 + face.box.y2) / 2;
  const x = Math.max(0, Math.min(width - side, centerX - side / 2));
  const y = Math.max(0, Math.min(height - side, centerY - side / 2));

  const { canvas, context } = getScratchCanvas(`crop-${size}`, size, size);
  context.drawImage(source, x, y, side, side, 0, 0, size, size);
  return canvas;
}

export function alignFace(source, landmarks, size = ARCFACE_SIZE) {
  if (landmarks.length !== 5) throw new Error('Face alignment needs five landmarks.');
  const { canvas, context } = getScratchCanvas(`align-${size}`, size, size);
  const template = ARCFACE_TEMPLATE.map(([x, y]) => [
    (x * size) / ARCFACE_SIZE,
    (y * size) / ARCFACE_SIZE,
  ]);
  const sourceMean = [0, 0];
  const targetMean = [0, 0];
  for (let i = 0; i < 5; i++) {
    sourceMean[0] += landmarks[i].x / 5;
    sourceMean[1] += landmarks[i].y / 5;
    targetMean[0] += template[i][0] / 5;
    targetMean[1] += template[i][1] / 5;
  }

  let numeratorA = 0;
  let numeratorB = 0;
  let denominator = 0;
  for (let i = 0; i < 5; i++) {
    const x = landmarks[i].x - sourceMean[0];
    const y = landmarks[i].y - sourceMean[1];
    const u = template[i][0] - targetMean[0];
    const v = template[i][1] - targetMean[1];
    numeratorA += x * u + y * v;
    numeratorB += x * v - y * u;
    denominator += x * x + y * y;
  }
  if (denominator < 1e-6) throw new Error('Face landmarks are degenerate.');

  const a = numeratorA / denominator;
  const b = numeratorB / denominator;
  const translateX = targetMean[0] - a * sourceMean[0] + b * sourceMean[1];
  const translateY = targetMean[1] - b * sourceMean[0] - a * sourceMean[1];
  // The canvas is reused, so clear the previous frame and the previous transform first
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, size, size);
  context.setTransform(a, b, -b, a, translateX, translateY);
  context.drawImage(source, 0, 0);
  context.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

function prepareFaceTensor(canvas, size, mean, std) {
  const data = imageToTensor(canvas, size, size, { mean, std });
  const ort = getOrt();
  return new ort.Tensor('float32', data, [1, 3, size, size]);
}

function normalizeEmbedding(values) {
  if (values.length !== EMBEDDING_SIZE) throw new Error('Recognition model returned an unexpected embedding size.');
  let norm = 0;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm < 1e-12) throw new Error('Recognition model returned an invalid embedding.');
  return Float32Array.from(values, value => value / norm);
}

export async function embedFace(source, face, session) {
  const aligned = alignFace(source, face.landmarks);
  const input = prepareFaceTensor(aligned, ARCFACE_SIZE, 127.5, 127.5);
  const runStartedAt = performance.now();
  const outputs = await session.run({
    [session.inputNames[0]]: input,
  });
  timings.recognizerRunMs = performance.now() - runStartedAt;
  return normalizeEmbedding(outputs[session.outputNames[0]].data);
}

export function cosineSimilarity(a, b) {
  if (a.length !== EMBEDDING_SIZE || b.length !== EMBEDDING_SIZE) return -1;
  let similarity = 0;
  for (let i = 0; i < EMBEDDING_SIZE; i++) similarity += a[i] * b[i];
  return similarity;
}

export async function scoreLiveness(crop, session) {
  const input = prepareFaceTensor(crop, 128, 0, 255);
  const runStartedAt = performance.now();
  const outputs = await session.run({
    [session.inputNames[0]]: input,
  });
  timings.livenessRunMs = performance.now() - runStartedAt;
  const logits = outputs[session.outputNames[0]].data;
  if (logits.length !== 2) throw new Error('Liveness model returned an unexpected output size.');
  return {
    realLogit: logits[0],
    spoofLogit: logits[1],
    logitDifference: logits[0] - logits[1],
  };
}