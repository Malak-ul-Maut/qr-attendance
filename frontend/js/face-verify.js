// Face check used by the student page: quality gates, liveness, 5 live frames, then recognition.
// It always ends: with a match, a timeout (with the most common problem as a tip), or a cancel.
import {
  cosineSimilarity,
  createSquareFaceCrop,
  detectFaces,
  embedFace,
  scoreLiveness,
} from '../utils/face-onnx.js';

export const FACE_SETTINGS = {
  detectionThreshold: 0.5,
  liveFramesRequired: 5,
  liveLogitThreshold: Math.log(0.8 / 0.2), // 80%
  recognitionThreshold: 0.45,
  minFaceWidth: 110,
  minFaceHeight: 110,
  minSharpness: 18,
  minBrightness: 40,
  budgetMs: 25000, // whole check
  maxAttempts: 3, // full 5-frame streaks that failed recognition
  intervalMs: 110, // about 9 checks a second, so the phone does not run hot
};

// What each kind of problem tells the student to do.
export const FACE_TIPS = {
  noface: 'Hold the phone at eye level so your whole face is in the frame.',
  multiple: 'Make sure only you are in the camera view.',
  far: 'Move closer to the camera.',
  dark: 'Move to a brighter place, with light on your face.',
  blurry: 'Hold the phone steady so the camera can focus.',
  liveness: 'Face the camera directly, with no photo or screen in view.',
  mismatch:
    'Take off glasses or a mask if you can, face the camera straight on, and try again.',
};

export const HINT_TEXT = {
  noface: 'Position your face in the frame.',
  multiple: 'Only one person should be in view.',
  far: 'Move closer to the camera.',
  dark: 'Move to a brighter area.',
  blurry: 'Hold still so the camera can focus.',
  liveness: 'Liveness check did not pass. Face the camera and try again.',
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Created once and reused, instead of a new canvas for every frame
let qualityScratch = null;

function createAnalysisCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create an analysis canvas.');
  return { canvas, context };
}

function measureImageQuality(source, box) {
  const size = 64;
  qualityScratch ||= createAnalysisCanvas(size, size);
  const { context } = qualityScratch;
  const width = source.videoWidth;
  const height = source.videoHeight;
  const x1 = Math.max(0, box.x1);
  const y1 = Math.max(0, box.y1);
  const x2 = Math.min(width, box.x2);
  const y2 = Math.min(height, box.y2);
  context.drawImage(source, x1, y1, x2 - x1, y2 - y1, 0, 0, size, size);
  const pixels = context.getImageData(0, 0, size, size).data;
  const gray = new Float32Array(size * size);
  let brightness = 0;
  for (let i = 0; i < gray.length; i++) {
    const pixel = i * 4;
    gray[i] =
      0.299 * pixels[pixel] +
      0.587 * pixels[pixel + 1] +
      0.114 * pixels[pixel + 2];
    brightness += gray[i];
  }
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const laplacian =
        gray[i - size] + gray[i - 1] + gray[i + 1] + gray[i + size] - 4 * gray[i];
      sum += laplacian;
      sumSquares += laplacian * laplacian;
      count++;
    }
  }
  return {
    sharpness: sumSquares / count - (sum / count) ** 2,
    brightness: brightness / gray.length,
  };
}

// Returns { ok:true, crop, quality } or { ok:false, hint } where hint is a key of HINT_TEXT.
export function assessFrame(video, face) {
  const s = FACE_SETTINGS;
  const boxWidth = face.box.x2 - face.box.x1;
  const boxHeight = face.box.y2 - face.box.y1;
  if (boxWidth < s.minFaceWidth || boxHeight < s.minFaceHeight)
    return { ok: false, hint: 'far' };

  const [leftEye, rightEye, nose] = face.landmarks;
  const eyeAngle = Math.abs(
    Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x),
  );
  const eyeCenterX = (leftEye.x + rightEye.x) / 2;
  const imageQuality = measureImageQuality(video, face.box);
  if (imageQuality.brightness < s.minBrightness)
    return { ok: false, hint: 'dark' };
  if (imageQuality.sharpness < s.minSharpness)
    return { ok: false, hint: 'blurry' };

  // Only crop the face once the frame has passed the cheap checks above
  const crop = createSquareFaceCrop(video, face);
  const frontalScore =
    1 -
    Math.min(
      1,
      Math.abs(nose.x - eyeCenterX) / Math.max(boxWidth * 0.14, 1) +
        eyeAngle / ((18 * Math.PI) / 180),
    );
  return {
    ok: true,
    crop,
    quality: Math.min(imageQuality.sharpness / 200, 1) * 0.65 + frontalScore * 0.35,
  };
}

export function snapshotFrame(source, face, quality, maxSize = 640) {
  const scale = Math.min(1, maxSize / Math.max(source.videoWidth, source.videoHeight));
  const width = Math.round(source.videoWidth * scale);
  const height = Math.round(source.videoHeight * scale);
  const { canvas, context } = createAnalysisCanvas(width, height);
  context.drawImage(source, 0, 0, width, height);
  return {
    canvas,
    face: {
      box: Object.fromEntries(
        Object.entries(face.box).map(([key, value]) => [key, value * scale]),
      ),
      landmarks: face.landmarks.map(point => ({
        x: point.x * scale,
        y: point.y * scale,
      })),
    },
    quality,
  };
}

export function clearOverlay(canvas) {
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}

function drawDetection(canvas, video, face, label, color = '#e5484d') {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, width, height);
  const { x1, y1, x2, y2 } = face.box;
  context.strokeStyle = color;
  context.lineWidth = Math.max(2, width / 320);
  context.strokeRect(x1, y1, x2 - x1, y2 - y1);
  context.font = `${Math.max(16, width / 32)}px sans-serif`;
  context.fillStyle = color;
  context.fillText(label, x1, Math.max(20, y1 - 8));
}

// Runs until it matches, runs out of time or attempts, or isActive() turns false.
// Resolves to one of:
//   { status: 'matched', similarity, face }
//   { status: 'timeout', reason: 'time' | 'attempts', problem, tip, attempts }
//   { status: 'cancelled' }
// A thrown error (model failure) is left for the caller to handle.
export async function runFaceCheck({
  video,
  canvas,
  models,
  descriptor,
  isActive,
  onStatus,
  settings = {},
}) {
  const s = { ...FACE_SETTINGS, ...settings };
  const startedAt = performance.now();
  const problems = {}; // hint key -> number of frames it showed up in
  const note = key => (problems[key] = (problems[key] || 0) + 1);
  let streak = [];
  let attempts = 0;

  const timeout = reason => {
    const ranked = Object.entries(problems).sort((a, b) => b[1] - a[1]);
    const problem = ranked.length ? ranked[0][0] : 'noface';
    return {
      status: 'timeout',
      reason,
      problem,
      tip: FACE_TIPS[problem] || FACE_TIPS.mismatch,
      attempts,
    };
  };

  while (isActive()) {
    if (performance.now() - startedAt > s.budgetMs) return timeout('time');
    const loopStartedAt = performance.now();

    const faces = await detectFaces(video, models.detector, s.detectionThreshold);
    if (!isActive()) break;

    if (faces.length !== 1) {
      const key = faces.length ? 'multiple' : 'noface';
      note(key);
      streak = [];
      clearOverlay(canvas);
      onStatus(HINT_TEXT[key]);
    } else {
      const face = faces[0];
      const gate = assessFrame(video, face);
      if (!gate.ok) {
        note(gate.hint);
        streak = [];
        clearOverlay(canvas);
        onStatus(HINT_TEXT[gate.hint]);
      } else {
        const liveness = await scoreLiveness(gate.crop, models.liveness);
        if (!isActive()) break;
        if (liveness.logitDifference < s.liveLogitThreshold) {
          note('liveness');
          streak = [];
          drawDetection(canvas, video, face, 'Checking liveness');
          onStatus(HINT_TEXT.liveness);
        } else {
          streak.push(snapshotFrame(video, face, gate.quality));
          if (streak.length > s.liveFramesRequired) streak.shift();
          drawDetection(canvas, video, face, 'Live');
          onStatus(
            `Liveness confirmed. Hold still (${streak.length}/${s.liveFramesRequired}).`,
          );

          if (streak.length === s.liveFramesRequired) {
            const best = streak.reduce((a, b) => (b.quality > a.quality ? b : a));
            onStatus('Liveness confirmed. Verifying your face...');
            const embedding = await embedFace(
              best.canvas,
              best.face,
              models.recognizer,
            );
            if (!isActive()) break;
            const similarity = cosineSimilarity(embedding, descriptor);
            if (similarity >= s.recognitionThreshold)
              return { status: 'matched', similarity, face };

            attempts++;
            note('mismatch');
            streak = [];
            drawDetection(canvas, video, face, 'Not recognised');
            onStatus(`Face not recognised (attempt ${attempts} of ${s.maxAttempts}).`);
            if (attempts >= s.maxAttempts) return timeout('attempts');
          }
        }
      }
    }

    // Throttle: wait out the rest of the interval instead of running back to back
    const spent = performance.now() - loopStartedAt;
    if (spent < s.intervalMs) await sleep(s.intervalMs - spent);
  }
  return { status: 'cancelled' };
}

export { drawDetection };
