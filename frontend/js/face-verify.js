// The face check used by the student page: find one face, check it is usable, compare it with the saved
// template. It always ends: with a match, a timeout (with the most common problem as a tip), a cancel, or a
// camera that stopped delivering pictures.
import { alignFace, cosineSimilarity } from './face/align.js';
import { nextFrame } from './face/camera.js';

export const FACE_SETTINGS = {
  detectionThreshold: 0.5,
  stableFrames: 3, // good frames in a row before the face is compared
  recognitionThreshold: 0.45,
  minFaceFraction: 0.16, // face width as a share of the shorter side of the picture
  minFaceWidth: 80, // ...but never fewer pixels than this
  hardBlur: 6, // below this the frame is rejected as blurry
  minBrightness: 40,
  budgetMs: 25000, // whole check
  maxAttempts: 3, // full streaks that failed recognition
  frameStallMs: 3000, // no new camera frame for this long: the camera froze
};

// What each kind of problem tells the student to do.
export const FACE_TIPS = {
  noface: 'Hold the phone at eye level so your whole face is in the frame.',
  multiple: 'Make sure only you are in the camera view.',
  far: 'Move closer to the camera.',
  dark: 'Move to a brighter place, with light on your face.',
  blurry: 'Hold the phone steady so the camera can focus.',
  mismatch: 'Take off glasses or a mask if you can, face the camera straight on, and try again.',
};

export const HINT_TEXT = {
  noface: 'Position your face in the frame.',
  multiple: 'Only one person should be in view.',
  far: 'Move closer to the camera.',
  dark: 'Move to a brighter area.',
  blurry: 'Hold still so the camera can focus.',
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let qualityScratch = null;

function createAnalysisCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create an analysis canvas.');
  return { canvas, context };
}

// Brightness and sharpness of the face area, from a 64x64 copy of it.
function measureImageQuality(source, box) {
  const size = 64;
  qualityScratch ||= createAnalysisCanvas(size, size);
  const { context } = qualityScratch;
  const x1 = Math.max(0, box.x1);
  const y1 = Math.max(0, box.y1);
  const x2 = Math.min(source.videoWidth, box.x2);
  const y2 = Math.min(source.videoHeight, box.y2);
  context.drawImage(source, x1, y1, x2 - x1, y2 - y1, 0, 0, size, size);
  const pixels = context.getImageData(0, 0, size, size).data;
  const gray = new Float32Array(size * size);
  let brightness = 0;
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4;
    gray[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
    brightness += gray[i];
  }
  let sum = 0, sumSquares = 0, count = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const laplacian = gray[i - size] + gray[i - 1] + gray[i + 1] + gray[i + size] - 4 * gray[i];
      sum += laplacian;
      sumSquares += laplacian * laplacian;
      count++;
    }
  }
  return { sharpness: sumSquares / count - (sum / count) ** 2, brightness: brightness / gray.length };
}

// { ok:true, quality } or { ok:false, hint } where hint is a key of HINT_TEXT.
// Sharpness is mostly used to PICK the best frame, not to throw frames away: only a really blurry frame is refused.
export function assessFrame(video, face, settings = FACE_SETTINGS) {
  const s = settings;
  const boxWidth = face.box.x2 - face.box.x1;
  const minWidth = Math.max(s.minFaceWidth, Math.min(video.videoWidth, video.videoHeight) * s.minFaceFraction);
  if (boxWidth < minWidth) return { ok: false, hint: 'far' };
  const imageQuality = measureImageQuality(video, face.box);
  if (imageQuality.brightness < s.minBrightness) return { ok: false, hint: 'dark' };
  if (imageQuality.sharpness < s.hardBlur) return { ok: false, hint: 'blurry' };

  const [leftEye, rightEye, nose] = face.landmarks;
  const eyeAngle = Math.abs(Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x));
  const eyeCenterX = (leftEye.x + rightEye.x) / 2;
  const frontalScore = 1 - Math.min(1, Math.abs(nose.x - eyeCenterX) / Math.max(boxWidth * 0.14, 1) + eyeAngle / ((18 * Math.PI) / 180));
  return { ok: true, quality: Math.min(imageQuality.sharpness / 200, 1) * 0.65 + frontalScore * 0.35 };
}

// A copy of the current frame (shrunk to maxSize) with the face coordinates scaled to match.
export function snapshotFrame(source, face, quality, maxSize = 640) {
  const scale = Math.min(1, maxSize / Math.max(source.videoWidth, source.videoHeight));
  const width = Math.round(source.videoWidth * scale);
  const height = Math.round(source.videoHeight * scale);
  const { canvas, context } = createAnalysisCanvas(width, height);
  context.drawImage(source, 0, 0, width, height);
  return {
    canvas,
    face: {
      box: Object.fromEntries(Object.entries(face.box).map(([key, value]) => [key, value * scale])),
      landmarks: face.landmarks.map(point => ({ x: point.x * scale, y: point.y * scale })),
    },
    quality,
  };
}

// Embedding of a snapshot, same alignment and model as at enrolment.
export async function embedSnapshot(engine, snapshot) {
  return engine.embed(alignFace(snapshot.canvas, snapshot.face.landmarks));
}

export function clearOverlay(canvas) {
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}

// Draws the face box. Called for EVERY frame that has a face, so the person always sees that it is working.
// (No text is drawn on the canvas: the preview is mirrored by CSS, which would flip it. Status text is shown below the preview.)
export function drawDetection(canvas, video, face, _label, color = '#e5484d') {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, width, height);
  const { x1, y1, x2, y2 } = face.box;
  context.strokeStyle = color;
  context.lineWidth = Math.max(3, width / 240);
  context.strokeRect(x1, y1, x2 - x1, y2 - y1);
}

// Runs until it matches, runs out of time or attempts, or isActive() turns false.
// Resolves to one of:
//   { status: 'matched', similarity, face }
//   { status: 'timeout', reason: 'time' | 'attempts', problem, tip, attempts }
//   { status: 'cancelled' }
//   { status: 'camera_stalled' }
// A thrown error (engine failure) is left for the caller to handle.
export async function runFaceCheck({ video, canvas, engine, descriptor, isActive, onStatus, settings = {} }) {
  const s = { ...FACE_SETTINGS, ...settings };
  const startedAt = performance.now();
  const problems = {};
  const note = key => (problems[key] = (problems[key] || 0) + 1);
  let streak = [];
  let attempts = 0;

  const timeout = reason => {
    const ranked = Object.entries(problems).sort((a, b) => b[1] - a[1]);
    const problem = ranked.length ? ranked[0][0] : 'noface';
    return { status: 'timeout', reason, problem, tip: FACE_TIPS[problem] || FACE_TIPS.mismatch, attempts };
  };
  const blocked = (key, face) => {
    note(key);
    streak = [];
    if (face) drawDetection(canvas, video, face, '', '#f59f00'); else clearOverlay(canvas);
    onStatus(HINT_TEXT[key]);
  };

  while (isActive()) {
    if (performance.now() - startedAt > s.budgetMs) return timeout('time');
    if (document.hidden) { await sleep(400); continue; } // a background tab gets no camera frames
    if (!(await nextFrame(video, s.frameStallMs))) {
      if (!isActive()) break;
      return { status: 'camera_stalled' };
    }
    const faces = await engine.detect(video, s.detectionThreshold);
    if (!isActive()) break;

    if (faces.length !== 1) {
      blocked(faces.length ? 'multiple' : 'noface', faces[0]);
      continue;
    }
    const face = faces[0];
    const gate = assessFrame(video, face, s);
    if (!gate.ok) { blocked(gate.hint, face); continue; }

    streak.push(snapshotFrame(video, face, gate.quality));
    if (streak.length > s.stableFrames) streak.shift();
    drawDetection(canvas, video, face, '', '#2f9e44');
    if (streak.length < s.stableFrames) {
      onStatus(`Hold still (${streak.length}/${s.stableFrames})`);
      continue;
    }

    onStatus('Checking your face...');
    const best = streak.reduce((a, b) => (b.quality > a.quality ? b : a));
    const embedding = await embedSnapshot(engine, best);
    if (!isActive()) break;
    const similarity = cosineSimilarity(embedding, descriptor);
    if (similarity >= s.recognitionThreshold) return { status: 'matched', similarity, face };

    attempts++;
    note('mismatch');
    streak = [];
    drawDetection(canvas, video, face, '', '#e5484d');
    onStatus(`Face not recognised (attempt ${attempts} of ${s.maxAttempts}).`);
    if (attempts >= s.maxAttempts) return timeout('attempts');
    await sleep(400); // let the message be read before the next try
  }
  return { status: 'cancelled' };
}
