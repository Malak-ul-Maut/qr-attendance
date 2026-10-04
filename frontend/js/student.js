import QrScanner from '../utils/qr-scanner/qr-scanner.min.js';
import postData from '../utils/fetch.js';
import { getCurrentUser, logout } from '../utils/storage.js';
import { loadDescriptors, saveDescriptors } from '../utils/cache-descriptors.js';
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
    document.querySelectorAll('.nav-item').forEach(t => t.removeAttribute('aria-current'));
    tab.setAttribute('aria-current', 'page');
    document.querySelectorAll('.view').forEach(v => (v.hidden = v.id !== `view-${tab.dataset.view}`));
    // Land on the new heading so screen-reader users hear where they are
    document.querySelector(`#view-${tab.dataset.view} h1`)?.focus({ preventScroll: true });
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
    ...subjects.map(s => listRow(String(s.name), '', `${s.percent >= 75 ? '✓' : '!'} ${s.percent}%`, s.percent >= 75 ? 'badge-success' : 'badge-warning')),
  );
}
// records: [{ subject, date, status }]  status: 'present' | 'absent'
export function renderHistory(records) {
  $('#historyEmpty').hidden = records.length > 0;
  $('#historyList').replaceChildren(
    ...records.map(r => {
      const present = r.status === 'present';
      return listRow(String(r.subject), String(r.date), present ? '✓ Present' : '✕ Absent', present ? 'badge-success' : 'badge-danger');
    }),
  );
}

// ---------- Face models + saved face (loaded in the background) ----------
let descriptor;
const markBtn = $('#markAttendanceCard');
markBtn.setAttribute('aria-busy', 'true'); // spinner until face check is ready

// Liveness (MiniFasNetV2) client-side support
let ortSession = null;
const LIVENESS_MODEL_PATH = '/utils/models/minifasnetv2_quant.onnx';
const LIVELINESS_FRAMES = 5; // number of frames to aggregate for liveness decision
const LIVELINESS_THRESHOLD = 0.6; // model-dependent threshold (tune on real data)
let livenessInProgress = false;
let livenessScores = [];

async function loadOrtModel() {
  try {
    if (!window.ort) {
      console.warn('onnxruntime (ort) not available in this page');
      return;
    }
    // create session; default backend will be used (wasm or webgl if available)
    ortSession = await ort.InferenceSession.create(LIVENESS_MODEL_PATH);
    console.log('Liveness model loaded', LIVENESS_MODEL_PATH);
  } catch (e) {
    console.error('Failed to load liveness model', e);
    ortSession = null;
  }
}

const faceReady = (async () => {
  await cacheModelsFromManifest('/utils/models/models-manifest.json');
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri('/utils/models'),
    faceapi.nets.faceLandmark68Net.loadFromUri('/utils/models'),
    faceapi.nets.faceRecognitionNet.loadFromUri('/utils/models'),
  ]);
  // try to load liveness model for ONNX inference in browser (optional)
  await loadOrtModel();

  descriptor = await loadDescriptors(studentId);
  if (!descriptor) {
    const res = await fetch(`/api/students/descriptors?id=${studentId}`);
    await saveDescriptors(studentId, await res.json());
    descriptor = await loadDescriptors(studentId);
  }
})();
faceReady
  .catch(() => showToast('Could not prepare face check. Reload and try again.', 'error'))
  .finally(() => markBtn.removeAttribute('aria-busy'));

// ---------- Scan flow ----------
const video = $('#video');
const canvas = $('#overlay');
const scanResult = $('#scan-result');
const scannerSection = $('#scanner-section');
const zoomRow = $('#zoomRow');

const inputSize = 128;
const scoreThreshold = 0.5;
const REQUIRED_STREAK = 4;
const MATCH_DISTANCE = 0.45;
let matchStreak = 0;
let distance;
let isProcessing = false;
let active = false; // false stops every loop when the flow is closed
let qrScanner = null;

markBtn.addEventListener('click', async () => {
  try {
    await faceReady;
  } catch {
    return showToast('Face check is not ready.', 'error');
  }
  if (!descriptor) return showToast('No face photo is registered for you. Ask your admin.', 'error');
  openScanner();
});
$('#closeScanBtn').addEventListener('click', closeScanner);
$('#resultAction').addEventListener('click', () => (resultOk ? closeScanner() : openScanner()));

function setStep(n) {
  document.querySelectorAll('.steps li').forEach(li => {
    const s = Number(li.dataset.step);
    li.classList.toggle('done', s < n);
    li.classList.toggle('current', s === n);
    // Tell screen readers which step is active (colour alone is not enough)
    if (s === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
}
function setStatus(text, isError = false) {
  scanResult.textContent = text;
  scanResult.classList.toggle('error', isError);
}

let scanOpener = null; // the button that opened the scanner, so focus can return to it

async function openScanner() {
  scanOpener = scanOpener || document.activeElement;
  active = true;
  isProcessing = false;
  matchStreak = 0;
  scannerSection.hidden = false;
  setPageInert(true);
  $('#closeScanBtn').focus();
  $('#cameraArea').hidden = false;
  $('#resultPanel').hidden = true;
  setStep(1);
  setStatus('Point your camera at the QR code.');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
    enableZoom(stream);
    await startQrScan();
  } catch {
    closeScanner();
    showToast('Could not open the camera. Allow camera access and try again.', 'error');
  }
}

function closeScanner() {
  active = false;
  if (qrScanner) { qrScanner.destroy(); qrScanner = null; }
  stopCamera();
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  scannerSection.hidden = true;
  setPageInert(false);
  scanOpener?.focus?.();
  scanOpener = null;
}

// While the scanner covers the page, the page behind it must not be reachable with Tab or a screen reader
function setPageInert(on) {
  document.querySelectorAll('.app-header, .app-nav, .app-main').forEach(el => (el.inert = on));
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
    studentId, studentName, token, cameraFingerprint, isFaceScanned: false,
  });

  if (!response.ok) {
    setStatus(`QR code not accepted: ${response.error}. Try again.`, true);
    isProcessing = false; // keep scanning
    return;
  }
  qrScanner.stop();
  stopCamera();
  setStep(2);
  setStatus('Look at the camera.');
  zoomRow.hidden = true;
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
  video.srcObject = stream;
  video.onloadedmetadata = () => {
    video.play();
    verifyFace(response.sessionId, response.section, cameraFingerprint);
  };
}

async function runLivenessOnResult(result) {
  // Crop the detected face area from the video into a temporary canvas, resize to inputSize
  const dims = faceapi.matchDimensions(canvas, video, true);
  const resized = faceapi.resizeResults(result, dims);
  const box = resized.detection.box;
  const sx = Math.max(0, box.x);
  const sy = Math.max(0, box.y);
  const sw = Math.max(1, box.width);
  const sh = Math.max(1, box.height);

  const off = document.createElement('canvas');
  off.width = inputSize;
  off.height = inputSize;
  const ctx = off.getContext('2d');
  // draw the face region scaled to model input
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, inputSize, inputSize);
  const img = ctx.getImageData(0, 0, inputSize, inputSize).data; // RGBA

  // Convert RGBA to CHW float32 (RGB channels), matching the ONNX input type.
  const hw = inputSize * inputSize;
  const chw = new Float32Array(3 * hw);
  // fill plane by plane
  for (let y = 0; y < inputSize; y++) {
    for (let x = 0; x < inputSize; x++) {
      const idx = (y * inputSize + x) * 4;
      const r = img[idx];
      const g = img[idx + 1];
      const b = img[idx + 2];
      const pos = y * inputSize + x;
      chw[pos] = r; // R plane
      chw[hw + pos] = g; // G plane
      chw[2 * hw + pos] = b; // B plane
    }
  }

  if (!ortSession) throw new Error('Liveness model not loaded');
  const inputName = (ortSession.inputNames && ortSession.inputNames[0]) || Object.keys(ortSession.inputMetadata || {})[0];
  if (!inputName) throw new Error('Could not determine ONNX input name');

  const feeds = {};
  feeds[inputName] = new ort.Tensor('float32', chw, [1, 3, inputSize, inputSize]);
  const results = await ortSession.run(feeds);
  const outName = (ortSession.outputNames && ortSession.outputNames[0]) || Object.keys(results)[0];
  const outTensor = results[outName];
  const outData = outTensor.data || outTensor;
  // assume single scalar score in output
  const score = Array.isArray(outData) || outData.length ? outData[0] : outData;
  return Number(score);
}

async function verifyFace(sessionId, section, cameraFingerprint) {
  if (!active) return;
  const again = () => requestAnimationFrame(() => verifyFace(sessionId, section, cameraFingerprint));

  const result = await faceapi
    .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!active) return;
  if (!result) return again();

  displayOverlay(result);

  if (matchStreak < REQUIRED_STREAK) {
    matchStreak = distance < MATCH_DISTANCE ? matchStreak + 1 : 0;
    setStatus(distance < MATCH_DISTANCE ? 'Hold still...' : 'Face not recognised. Face the camera.');
    return again();
  }

  // At this point face matches the enrolled descriptor consistently
  // Run liveness checks across a short sequence of frames using the ONNX model
  if (!ortSession) {
    // If the liveness model failed to load, notify the user and do not proceed
    setStatus('Liveness model is not available. Try again later.', true);
    return;
  }

  if (!livenessInProgress) {
    livenessInProgress = true;
    livenessScores = [];
  }

  try {
    const score = await runLivenessOnResult(result);
    livenessScores.push(score);
    setStatus(`Verifying liveness... (${livenessScores.length}/${LIVELINESS_FRAMES})`);
  } catch (err) {
    console.error('Liveness inference error', err);
    setStatus('Liveness check failed. Try again.', true);
    livenessInProgress = false;
    matchStreak = 0;
    return again();
  }

  if (livenessScores.length < LIVELINESS_FRAMES) return again();

  livenessInProgress = false;
  const avg = livenessScores.reduce((a, b) => a + b, 0) / livenessScores.length;
  if (avg < LIVELINESS_THRESHOLD) {
    // failed liveness
    setStatus('Liveness not detected. Try again.', true);
    matchStreak = 0; // require the student to re-hold for match
    return again();
  }

  // Passed liveness: submit attendance to backend
  stopCamera();
  setStatus('Submitting attendance...');
  const response = await postData('/api/attendance/verify', {
    studentId, studentName, sessionId, section, cameraFingerprint, isFaceScanned: true,
  });

  if (response.ok) {
    if (navigator.vibrate) navigator.vibrate(60);
    showResult(true, 'Attendance marked', 'You are marked present for this class.');
  } else {
    showResult(false, 'Attendance not marked', response.error || 'Something went wrong.');
  }
}

function isSmiling(landmarks) {
  const mouth = landmarks.getMouth();
  const jaw = landmarks.getJawOutline();
  const mouthWidth = Math.hypot(mouth[0].x - mouth[6].x, mouth[0].y - mouth[6].y);
  const faceWidth = Math.hypot(jaw[0].x - jaw[16].x, jaw[0].y - jaw[16].y);
  return mouthWidth / faceWidth > 0.42 && distance < MATCH_DISTANCE;
}

// Success / failure screen (step 3)
let resultOk = false;
function showResult(ok, title, text) {
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

function displayOverlay(result) {
  const dims = faceapi.matchDimensions(canvas, video, true);
  const resized = faceapi.resizeResults(result, dims);
  distance = faceapi.euclideanDistance(resized.descriptor, descriptor);
  // No raw distance numbers on screen
  const label = distance < MATCH_DISTANCE ? studentName : 'Not recognised';
  new faceapi.draw.DrawBox(resized.detection.box, { label }).draw(canvas);
}

async function getCameraId() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === 'videoinput');
  const preferred = inputs.find(d => d.label.toLowerCase().includes('back')) || inputs[0];
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
