import QrScanner from '../utils/qr-scanner.min.js';
import postData from '../utils/fetch.js';
import { getCurrentUser, logout } from '../utils/storage.js';
import {
  cosineSimilarity,
  createFaceModels,
  createSquareFaceCrop,
  detectFaces,
  embedFace,
  scoreLiveness,
  timings,
} from '../utils/face-onnx.js';
import { showToast } from './ui.js';

const $ = sel => document.querySelector(sel);
const user = getCurrentUser();
const studentId = user.username;
const studentName = user.name;

// ---------- Page basics (wired first so the page never feels dead) ----------
$('.user-name b').textContent = studentName;
$('.logout-btn').addEventListener('click', () => logout());

// Tabs: Home / Subjects / History
document.querySelectorAll('.nav-item').forEach(tab => {
  tab.addEventListener('click', () => {
    document
      .querySelectorAll('.nav-item')
      .forEach(t => t.removeAttribute('aria-current'));
    tab.setAttribute('aria-current', 'page');
    document
      .querySelectorAll('.view')
      .forEach(v => (v.hidden = v.id !== `view-${tab.dataset.view}`));
    // Land on the new heading so screen-reader users hear where they are
    document
      .querySelector(`#view-${tab.dataset.view} h1`)
      ?.focus({ preventScroll: true });
  });
});

// Call these when the backend can supply data (percent is 0-100).
export function setOverallPercent(percent) {
  $('#overallRing').style.setProperty('--pct', percent);
  $('#overallPct').textContent = `${Math.round(percent)}%`;
  $('#overallNote').textContent = 'Across all your subjects.';
}
// Builds one list row with textContent only, so names from the server can never become HTML
function listRow(title, subtitle, badgeText, badgeClass) {
  const li = document.createElement('li');
  li.className = 'card list-row';
  const left = document.createElement('span');
  left.append(title);
  if (subtitle) {
    left.append(document.createElement('br'));
    const small = document.createElement('small');
    small.textContent = subtitle;
    left.append(small);
  }
  const badge = document.createElement('span');
  badge.className = `badge ${badgeClass}`;
  badge.textContent = badgeText;
  li.append(left, badge);
  return li;
}
// subjects: [{ name, percent }]
export function renderSubjects(subjects) {
  $('#subjectEmpty').hidden = subjects.length > 0;
  $('#subjectList').replaceChildren(
    ...subjects.map(s =>
      listRow(
        String(s.name),
        '',
        `${s.percent >= 75 ? '✓' : '!'} ${s.percent}%`,
        s.percent >= 75 ? 'badge-success' : 'badge-warning',
      ),
    ),
  );
}
// records: [{ subject, date, status }]  status: 'present' | 'absent'
export function renderHistory(records) {
  $('#historyEmpty').hidden = records.length > 0;
  $('#historyList').replaceChildren(
    ...records.map(r => {
      const present = r.status === 'present';
      return listRow(
        String(r.subject),
        String(r.date),
        present ? '✓ Present' : '✕ Absent',
        present ? 'badge-success' : 'badge-danger',
      );
    }),
  );
}

// ---------- Face models + saved face (loaded in the background) ----------
let descriptor;
let faceModels;
const markBtn = $('#markAttendanceCard');
markBtn.setAttribute('aria-busy', 'true'); // spinner until face check is ready

const faceReady = (async () => {
  const cached = await cacheModelsFromManifest(
    '/utils/models/models-manifest.json',
  );
  if (!cached) throw new Error('Could not prepare the face models.');
  faceModels = await createFaceModels({ liveness: true });

  const normalizeDescriptor = values => {
    if (
      (!Array.isArray(values) && !(values instanceof Float32Array)) ||
      values.length !== 512
    )
      return null;
    let norm = 0;
    for (const value of values) {
      if (!Number.isFinite(value)) return null;
      norm += value * value;
    }
    norm = Math.sqrt(norm);
    if (norm < 1e-12) return null;
    return Float32Array.from(values, value => value / norm);
  };

  const res = await fetch(`/api/students/descriptors?id=${studentId}`);
  if (res.ok) {
    descriptor = normalizeDescriptor(await res.json());
  } else if (res.status !== 404) {
    throw new Error(`Could not load your face template (${res.status}).`);
  }
})();
faceReady
  .catch(error => {
    // Log the real reason, otherwise the toast hides what actually went wrong
    console.error('Face check setup failed', error);
    showToast('Could not prepare face check. Reload and try again.', error);
  })
  .finally(() => markBtn.removeAttribute('aria-busy'));

// ---------- Scan flow ----------
const video = $('#video');
const canvas = $('#overlay');
const scanResult = $('#scan-result');
const scannerSection = $('#scanner-section');
const zoomRow = $('#zoomRow');

const DETECTION_THRESHOLD = 0.5;
const LIVE_FRAMES_REQUIRED = 3;
const LIVE_LOGIT_THRESHOLD = Math.log(0.8 / 0.2);
const RECOGNITION_THRESHOLD = 0.45;
const FRAME_INTERVAL_MS = 0;
const MIN_FACE_WIDTH = 110;
const MIN_FACE_HEIGHT = 110;
const MIN_SHARPNESS = 18;
let liveStreak = [];
let lastLiveFrameAt = null;
let isProcessing = false;
let active = false; // false stops every loop when the flow is closed
let scanGeneration = 0;
let qrScanner = null;

// Verbose per-frame logging slows the loop down (especially with DevTools open),
// so keep DEBUG false except while tuning thresholds.
const DEBUG = false;
// Cheap one-line timing logs, handy for benchmarking
const SHOW_TIMINGS = false;

function logFaceDebug(stage, details) {
  if (!DEBUG) return;
  console.log(`[Face verification] ${stage}`, details);
}

// totalMs = everything the stage did, modelMs = only the time inside session.run()
function logTiming(stage, totalMs, modelMs) {
  if (!SHOW_TIMINGS) return;
  console.log(
    `[Face timing] ${stage}: ${totalMs.toFixed(0)}ms total, ${modelMs.toFixed(0)}ms in model`,
  );
}

markBtn.addEventListener('click', async () => {
  try {
    await faceReady;
  } catch {
    return showToast('Face check is not ready.', 'error');
  }
  if (!descriptor)
    return showToast(
      'Your face template needs to be re-enrolled by an admin.',
      'error',
    );
  openScanner();
});
$('#closeScanBtn').addEventListener('click', closeScanner);
$('#resultAction').addEventListener('click', () =>
  resultOk ? closeScanner() : openScanner(),
);

function setStep(n) {
  document.querySelectorAll('.steps li').forEach(li => {
    const s = Number(li.dataset.step);
    li.classList.toggle('done', s < n);
    li.classList.toggle('current', s === n);
    // Tell screen readers which step is active (colour alone is not enough)
    if (s === n) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
}
function setStatus(text, isError = false) {
  scanResult.textContent = text;
  scanResult.classList.toggle('error', isError);
}

let scanOpener = null; // the button that opened the scanner, so focus can return to it

async function openScanner() {
  scanOpener = scanOpener || document.activeElement;
  scanGeneration++;
  active = true;
  isProcessing = false;
  liveStreak = [];
  scannerSection.hidden = false;
  setPageInert(true);
  $('#closeScanBtn').focus();
  $('#cameraArea').hidden = false;
  $('#resultPanel').hidden = true;
  setStep(1);
  setStatus('Point your camera at the QR code.');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
    video.srcObject = stream;
    enableZoom(stream);
    await startQrScan();
  } catch {
    closeScanner();
    showToast(
      'Could not open the camera. Allow camera access and try again.',
      'error',
    );
  }
}

function closeScanner() {
  active = false;
  scanGeneration++;
  liveStreak = [];
  if (qrScanner) {
    qrScanner.destroy();
    qrScanner = null;
  }
  stopCamera();
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  scannerSection.hidden = true;
  setPageInert(false);
  scanOpener?.focus?.();
  scanOpener = null;
}

// While the scanner covers the page, the page behind it must not be reachable with Tab or a screen reader
function setPageInert(on) {
  document
    .querySelectorAll('.app-header, .app-nav, .app-main')
    .forEach(el => (el.inert = on));
}
// Escape closes the scanner
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !scannerSection.hidden) closeScanner();
});

async function startQrScan() {
  const cameraFingerprint = await getCameraId();
  qrScanner = new QrScanner(
    video,
    async result => {
      if (isProcessing) return;
      isProcessing = true;
      if (navigator.vibrate) navigator.vibrate(40);
      setStatus('Checking QR code...');
      await sendAttendance(result.data, cameraFingerprint);
    },
    { returnDetailedScanResult: true },
  );
  await qrScanner.start();
  await video.play();
}

async function sendAttendance(token, cameraFingerprint) {
  const response = await postData('/api/attendance/verify', {
    studentId,
    studentName,
    token,
    cameraFingerprint,
    isFaceScanned: false,
  });

  if (!response) {
    setStatus(
      'Could not check the QR code. Check your connection and try again.',
      true,
    );
    isProcessing = false;
    return;
  }
  if (!response.ok) {
    setStatus(`QR code not accepted: ${response.error}. Try again.`, true);
    isProcessing = false; // keep scanning
    return;
  }
  if (qrScanner) {
    qrScanner.destroy();
    qrScanner = null;
  }
  stopCamera();
  setStep(2);
  setStatus('Look at the camera.');
  zoomRow.hidden = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
    });
    if (!active) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    video.srcObject = stream;
    await video.play();
    setStatus('Keep your face visible in the frame.');
    void verifyFace(
      response.sessionId,
      response.section,
      cameraFingerprint,
      scanGeneration,
    );
  } catch (error) {
    console.error('Could not start face verification camera', error);
    stopCamera();
    showResult(
      false,
      'Camera unavailable',
      'Allow camera access, then try again.',
    );
  }
}

function resetLiveStreak() {
  liveStreak = [];
  lastLiveFrameAt = null;
}

function assessFrame(face) {
  const boxWidth = face.box.x2 - face.box.x1;
  const boxHeight = face.box.y2 - face.box.y1;
  const centerX = (face.box.x1 + face.box.x2) / 2;
  const centerY = (face.box.y1 + face.box.y2) / 2;

  const faceSize = { width: boxWidth, height: boxHeight };
  if (boxWidth < MIN_FACE_WIDTH || boxHeight < MIN_FACE_HEIGHT) {
    const result = { ok: false, hint: 'Move closer to the camera.' };
    logFaceDebug('face-size gate', {
      ...faceSize,
      minimumWidth: MIN_FACE_WIDTH,
      minimumHeight: MIN_FACE_HEIGHT,
      passed: false,
    });
    return result;
  }
  const [leftEye, rightEye, nose, leftMouth, rightMouth] = face.landmarks;
  const eyeDistance = Math.hypot(
    rightEye.x - leftEye.x,
    rightEye.y - leftEye.y,
  );
  const eyeAngle = Math.abs(
    Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x),
  );
  const eyeCenterX = (leftEye.x + rightEye.x) / 2;
  const mouthCenterX = (leftMouth.x + rightMouth.x) / 2;
  const eyeAngleDegrees = (eyeAngle * 180) / Math.PI;
  const eyeRatio = eyeDistance / boxWidth;
  const noseEyeOffsetRatio = Math.abs(nose.x - eyeCenterX) / boxWidth;
  const noseMouthOffsetRatio = Math.abs(nose.x - mouthCenterX) / boxWidth;
  const imageQuality = measureImageQuality(video, face.box);
  if (imageQuality.brightness < 40) {
    logFaceDebug('brightness gate', {
      value: imageQuality.brightness,
      minimum: 40,
      passed: false,
    });
    return { ok: false, hint: 'Move to a brighter area.' };
  }
  if (imageQuality.sharpness < MIN_SHARPNESS) {
    logFaceDebug('sharpness gate', {
      value: imageQuality.sharpness,
      minimum: MIN_SHARPNESS,
      passed: false,
    });
    return { ok: false, hint: 'Hold still so the camera can focus.' };
  }

  // Only crop the face once the frame has passed the cheap checks above
  const crop = createSquareFaceCrop(video, face);
  const frontalScore =
    1 -
    Math.min(
      1,
      Math.abs(nose.x - eyeCenterX) / Math.max(boxWidth * 0.14, 1) +
        eyeAngle / ((18 * Math.PI) / 180),
    );
  logFaceDebug('frame quality gates', {
    ...faceSize,
    minimumWidth: MIN_FACE_WIDTH,
    minimumHeight: MIN_FACE_HEIGHT,
    centerX,
    centerY,
    eyeDistanceRatio: eyeRatio,
    eyeAngleDegrees,
    noseToEyesOffsetRatio: noseEyeOffsetRatio,
    noseToMouthOffsetRatio: noseMouthOffsetRatio,
    brightness: imageQuality.brightness,
    sharpness: imageQuality.sharpness,
    sharpnessMinimum: MIN_SHARPNESS,
    frontalScore,
    poseUsedAsGate: false,
    selectionQuality:
      Math.min(imageQuality.sharpness / 200, 1) * 0.65 + frontalScore * 0.35,
    passed: true,
  });
  return {
    ok: true,
    crop,
    quality:
      Math.min(imageQuality.sharpness / 200, 1) * 0.65 + frontalScore * 0.35,
  };
}

// Created once and reused, instead of making a new canvas for every frame
let qualityScratch = null;

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
        gray[i - size] +
        gray[i - 1] +
        gray[i + 1] +
        gray[i + size] -
        4 * gray[i];
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

function createAnalysisCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create an analysis canvas.');
  return { canvas, context };
}

function snapshotFrame(source, face, quality) {
  const sourceWidth = source.videoWidth;
  const sourceHeight = source.videoHeight;
  const scale = Math.min(1, 640 / Math.max(sourceWidth, sourceHeight));
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);
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

function clearOverlay() {
  const context = canvas.getContext('2d');
  if (context) context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawDetection(face, label, color = '#e5484d') {
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

async function verifyFace(sessionId, section, cameraFingerprint, generation) {
  logFaceDebug('threshold configuration', {
    detectorScoreMinimum: DETECTION_THRESHOLD,
    faceWidthMinimum: MIN_FACE_WIDTH,
    faceHeightMinimum: MIN_FACE_HEIGHT,
    centerPositionGate: false,
    poseGate: false,
    brightnessMinimum: 40,
    sharpnessMinimum: MIN_SHARPNESS,
    livenessLogitDifferenceMinimum: LIVE_LOGIT_THRESHOLD,
    livenessFramesRequired: LIVE_FRAMES_REQUIRED,
    recognitionCosineSimilarityMinimum: RECOGNITION_THRESHOLD,
    frameIntervalMs: FRAME_INTERVAL_MS,
  });
  while (active && generation === scanGeneration) {
    const iterationStartedAt = performance.now();
    try {
      const detectionStartedAt = performance.now();
      const faces = await detectFaces(
        video,
        faceModels.detector,
        DETECTION_THRESHOLD,
      );
      const detectionDurationMs = performance.now() - detectionStartedAt;
      logTiming('SCRFD detection', detectionDurationMs, timings.detectorRunMs);
      if (!active || generation !== scanGeneration) return;

      if (faces.length !== 1) {
        logFaceDebug('face-count gate', {
          detectedFaces: faces.length,
          requiredFaces: 1,
          passed: false,
        });
        resetLiveStreak();
        clearOverlay();
        setStatus(
          faces.length
            ? 'Only one person should be in view.'
            : 'Position your face in the frame.',
        );
      } else {
        const face = faces[0];
        logFaceDebug('detector', {
          score: face.score,
          minimumScore: DETECTION_THRESHOLD,
          box: face.box,
        });
        const gate = assessFrame(face);
        if (!gate.ok) {
          resetLiveStreak();
          clearOverlay();
          setStatus(gate.hint);
        } else {
          const livenessStartedAt = performance.now();
          const liveness = await scoreLiveness(gate.crop, faceModels.liveness);
          const livenessDurationMs = performance.now() - livenessStartedAt;
          logTiming(
            'MiniFASNet liveness',
            livenessDurationMs,
            timings.livenessRunMs,
          );
          if (!active || generation !== scanGeneration) return;

          const isLive = liveness.logitDifference >= LIVE_LOGIT_THRESHOLD;
          logFaceDebug('liveness', {
            realLogit: liveness.realLogit,
            spoofLogit: liveness.spoofLogit,
            logitDifference: liveness.logitDifference,
            minimumLogitDifference: LIVE_LOGIT_THRESHOLD,
            passed: isLive,
          });
          if (!isLive) {
            resetLiveStreak();
            drawDetection(face, 'Checking liveness');
            setStatus(
              'Liveness check did not pass. Face the camera and try again.',
            );
          } else {
            const now = performance.now();
            const candidate = snapshotFrame(video, face, gate.quality);
            liveStreak.push(candidate);
            if (liveStreak.length > LIVE_FRAMES_REQUIRED) liveStreak.shift();
            logFaceDebug('live frame cadence', {
              timeSincePreviousLiveFrameMs:
                lastLiveFrameAt === null
                  ? null
                  : Number((now - lastLiveFrameAt).toFixed(1)),
              currentStreak: liveStreak.length,
            });
            lastLiveFrameAt = now;
            drawDetection(face, 'Live');
            setStatus(
              `Liveness confirmed. Hold still (${liveStreak.length}/${LIVE_FRAMES_REQUIRED}).`,
            );

            if (liveStreak.length === LIVE_FRAMES_REQUIRED) {
              const bestFrame = liveStreak.reduce((best, current) =>
                current.quality > best.quality ? current : best,
              );
              setStatus('Liveness confirmed. Verifying your face...');
              const recognitionStartedAt = performance.now();
              const embedding = await embedFace(
                bestFrame.canvas,
                bestFrame.face,
                faceModels.recognizer,
              );
              const recognitionDurationMs =
                performance.now() - recognitionStartedAt;
              logTiming(
                'w600k_mbf recognition',
                recognitionDurationMs,
                timings.recognizerRunMs,
              );
              if (!active || generation !== scanGeneration) return;
              const similarity = cosineSimilarity(embedding, descriptor);
              logFaceDebug('recognition', {
                cosineSimilarity: similarity,
                minimumCosineSimilarity: RECOGNITION_THRESHOLD,
                passed: similarity >= RECOGNITION_THRESHOLD,
                selectedFrameQuality: bestFrame.quality,
              });

              if (similarity >= RECOGNITION_THRESHOLD) {
                drawDetection(face, studentName, '#2f9e44');
                stopCamera();
                setStatus('Submitting attendance...');
                const response = await postData('/api/attendance/verify', {
                  studentId,
                  studentName,
                  sessionId,
                  section,
                  cameraFingerprint,
                  isFaceScanned: true,
                });
                if (!active || generation !== scanGeneration) return;
                if (!response) {
                  showResult(
                    false,
                    'Attendance not marked',
                    'Could not reach the server. Try again.',
                  );
                  return;
                }
                if (response.ok) {
                  if (navigator.vibrate) navigator.vibrate(60);
                  showResult(
                    true,
                    'Attendance marked',
                    'You are marked present for this class.',
                  );
                } else {
                  showResult(
                    false,
                    'Attendance not marked',
                    response.error || 'Something went wrong.',
                  );
                }
                return;
              }

              resetLiveStreak();
              drawDetection(face, 'Not recognised');
              setStatus(
                'Face not recognised. Face the camera and try again.',
                true,
              );
            }
          }
        }
      }
    } catch (error) {
      console.error('Face verification failed', error);
      if (active && generation === scanGeneration) {
        stopCamera();
        showResult(false, 'Face verification unavailable', 'Please try again.');
      }
      return;
    }

    await new Promise(resolve => setTimeout(resolve, FRAME_INTERVAL_MS));
    logFaceDebug('loop timing', {
      iterationDurationMs: Number(
        (performance.now() - iterationStartedAt).toFixed(1),
      ),
      configuredDelayMs: FRAME_INTERVAL_MS,
    });
  }
}

// Success / failure screen (step 3)
let resultOk = false;
function showResult(ok, title, text) {
  active = false;
  scanGeneration++;
  resetLiveStreak();
  resultOk = ok;
  setStep(4); // all steps shown as done
  $('#cameraArea').hidden = true;
  setStatus('');
  const panel = $('#resultPanel');
  panel.hidden = false;
  panel.className = `card result-panel ${ok ? 'ok' : 'fail'}`;
  panel.querySelector('.result-icon').textContent = ok ? '✓' : '!';
  $('#resultTitle').textContent = title;
  $('#resultText').textContent = text;
  $('#resultAction').textContent = ok ? 'Done' : 'Try again';
  $('#resultAction').focus();
}

function stopCamera() {
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach(track => track.stop());
  video.srcObject = null;
}

async function getCameraId() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === 'videoinput');
  const preferred =
    inputs.find(d => d.label.toLowerCase().includes('back')) || inputs[0];
  return preferred.deviceId;
}

function enableZoom(stream) {
  const slider = $('#zoom-slider');
  const track = stream.getVideoTracks()[0];
  const zoom = track.getCapabilities?.().zoom;
  zoomRow.hidden = !zoom; // hide the controls if this camera can't zoom
  if (!zoom) return;

  slider.min = zoom.min;
  slider.max = zoom.max;
  const apply = value => {
    slider.value = Math.min(zoom.max, Math.max(zoom.min, value));
    track.applyConstraints({ advanced: [{ zoom: Number(slider.value) }] });
  };
  // Using on* properties so reopening the scanner never stacks duplicate listeners
  slider.oninput = () => apply(Number(slider.value));
  $('.slider-icon.left').onclick = () => apply(Number(slider.value) - 1);
  $('.slider-icon.right').onclick = () => apply(Number(slider.value) + 1);
}
