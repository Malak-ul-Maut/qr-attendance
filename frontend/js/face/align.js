// Face alignment and matching helpers. These run on the main thread (canvas drawing is cheap and GPU-backed);
// the heavy model work is in the engine worker.
const ARCFACE_SIZE = 112;
const ARCFACE_TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

let alignCanvas = null;

// Warps the face so its eyes, nose and mouth sit where the recognition model expects them.
export function alignFace(source, landmarks) {
  if (landmarks.length !== 5) throw new Error('Face alignment needs five landmarks.');
  if (!alignCanvas) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ARCFACE_SIZE;
    alignCanvas = { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  const { canvas, context } = alignCanvas;
  const sourceMean = [0, 0];
  const targetMean = [0, 0];
  for (let i = 0; i < 5; i++) {
    sourceMean[0] += landmarks[i].x / 5;
    sourceMean[1] += landmarks[i].y / 5;
    targetMean[0] += ARCFACE_TEMPLATE[i][0] / 5;
    targetMean[1] += ARCFACE_TEMPLATE[i][1] / 5;
  }
  let numeratorA = 0, numeratorB = 0, denominator = 0;
  for (let i = 0; i < 5; i++) {
    const x = landmarks[i].x - sourceMean[0];
    const y = landmarks[i].y - sourceMean[1];
    const u = ARCFACE_TEMPLATE[i][0] - targetMean[0];
    const v = ARCFACE_TEMPLATE[i][1] - targetMean[1];
    numeratorA += x * u + y * v;
    numeratorB += x * v - y * u;
    denominator += x * x + y * y;
  }
  if (denominator < 1e-6) throw new Error('Face landmarks are degenerate.');
  const a = numeratorA / denominator;
  const b = numeratorB / denominator;
  const translateX = targetMean[0] - a * sourceMean[0] + b * sourceMean[1];
  const translateY = targetMean[1] - b * sourceMean[0] - a * sourceMean[1];
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, ARCFACE_SIZE, ARCFACE_SIZE);
  context.setTransform(a, b, -b, a, translateX, translateY);
  context.drawImage(source, 0, 0);
  context.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

export function cosineSimilarity(a, b) {
  if (a.length !== 512 || b.length !== 512) return -1;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += a[i] * b[i];
  return sum;
}
