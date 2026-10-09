import QrScanner from '../utils/qr-scanner.min.js';
import { postJson } from '../utils/fetch.js';
import { getCurrentUser } from '../utils/storage.js';
import { loadFaceModels } from './face-models.js';
import { session } from './state.js';
import { showToast } from './ui.js';
import { apiGet } from './api.js';
import {
  cameraErrorCode,
  describeError,
  looksLikeClassToken,
} from './errors.js';
import { clearOverlay, drawDetection, runFaceCheck } from './face-verify.js';

const $ = sel => document.querySelector(sel);
// auth-guard.js redirects when there is no signed-in student; {} just stops this module from throwing first.
const user = getCurrentUser() ?? {};
const studentId = user.username;
const studentName = user.name;

// ---------- Face models + saved face (loaded in the background) ----------
let descriptor;
let notApproved = false; // photos saved but not yet approved by an admin
let faceModels;
let faceSettled = false; // false while the models are still loading

const faceReady = (async () => {
  faceModels = await loadFaceModels();

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

  // Only this student's own template, fetched with their token
  const res = await apiGet('/api/student/face/template');
  if (res.ok) {
    descriptor = normalizeDescriptor(res.data);
  } else if (res.error === 'face_not_approved') {
    notApproved = true;
  } else if (res.status !== 404) {
    throw new Error(`Could not load your face template (${res.status}).`);
  }
})();
faceReady
  .catch(error => {
    console.error('Face check setup failed', error);
    showToast('Could not prepare face check. Reload and try again.', 'error');
  })
  .finally(() => {
    faceSettled = true;
  });

// ---------- Scan flow ----------
const video = $('#video');
const canvas = $('#overlay');
const scanResult = $('#scan-result');
const scannerSection = $('#scanner-section');
const zoomRow = $('#zoomRow');

const REJECT_COOLDOWN_MS = 1500; // pause after a rejected QR so the same code is not re-sent
const WATCHDOG_MS = 3000; // no decode attempt for this long means the scanner is stuck
const MAX_CAMERA_RESTARTS = 2;
const VERIFIED_VALID_MS = 60000; // a passed face check can be re-submitted for this long
const FACE_ROUNDS_BEFORE_IN_PERSON = 2;
const STATUS_POLL_MS = 5000;

let isProcessing = false;
let active = false; // false stops every loop when the flow is closed
let scanGeneration = 0;
let qrScanner = null;
let watchdogTimer = null;
let lastActivityAt = 0;
let cameraRestarts = 0;
let rejectedToken = null;
let cooldownUntil = 0;
let currentStep = 1;
let faceRounds = 0;
let expectedSubject = null; // the class the student tapped, so the prompt can name it
let flow = null; // { sessionId, section, subject, cameraFingerprint, verifiedAt }

// The Today tab asks for a scan from a card that says attendance is open.
window.addEventListener('student:scan', async ev => {
  const { subject, button } = ev.detail || {};
  if (!scannerSection.hidden) return; // already open
  // The default password must be changed before anything else
  if (session.me?.mustChangePassword) {
    showToast('Change your password first. You can do it in Profile.', 'error');
    return window.dispatchEvent(new CustomEvent('student:goto', { detail: 'profile' }));
  }
  // Spinner on the card's button while the face models finish loading
  if (!faceSettled) button?.setAttribute('aria-busy', 'true');
  try {
    await faceReady;
  } catch {
    return showToast('Face check is not ready. Reload and try again.', 'error');
  } finally {
    button?.removeAttribute('aria-busy');
  }
  if (!descriptor) {
    const e = describeError(notApproved ? 'face_not_approved' : 'face_not_enrolled');
    showToast(`${e.title} ${e.text}`, 'error');
    return window.dispatchEvent(new CustomEvent('student:goto', { detail: 'profile' }));
  }
  expectedSubject = subject || null;
  openScanner();
});
$('#closeScanBtn').addEventListener('click', closeScanner);

function setStep(n) {
  currentStep = n;
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
function toastError(code) {
  const e = describeError(code);
  showToast(`${e.title} ${e.text}`, 'error');
}

let scanOpener = null; // the button that opened the scanner, so focus can return to it

async function openScanner() {
  scanOpener = scanOpener || document.activeElement;
  scanGeneration++;
  active = true;
  isProcessing = false;
  flow = null;
  faceRounds = 0;
  cameraRestarts = 0;
  rejectedToken = null;
  cooldownUntil = 0;
  scannerSection.hidden = false;
  setPageInert(true);
  $('#closeScanBtn').focus();
  $('#cameraArea').hidden = false;
  $('#resultPanel').hidden = true;
  setStep(1);

  // Without BarcodeDetector the library needs its worker file. Say so now instead of
  // showing a camera that can never scan.
  if (!('BarcodeDetector' in window) && !(await qrWorkerAvailable())) {
    closeScanner();
    return toastError('qr_unsupported');
  }
  await startQrStep();
}

async function startQrStep() {
  const generation = scanGeneration;
  setStatus(
    expectedSubject
      ? `Scan the QR code for ${expectedSubject}.`
      : 'Point your camera at the QR code.',
  );
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
  } catch (error) {
    if (!active || generation !== scanGeneration) return;
    closeScanner();
    return toastError(cameraErrorCode(error));
  }
  if (!active || generation !== scanGeneration) {
    stream.getTracks().forEach(track => track.stop());
    return;
  }
  try {
    const cameraFingerprint = await getCameraId(stream);
    if (!active || generation !== scanGeneration) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    enableZoom(stream);
    startQrScan(stream, cameraFingerprint);
  } catch (error) {
    console.error('Could not start the QR scanner', error);
    closeScanner();
    toastError(cameraErrorCode(error));
  }
}

function stopWatchdog() {
  clearInterval(watchdogTimer);
  watchdogTimer = null;
}
function destroyQrScanner() {
  stopWatchdog();
  if (qrScanner) {
    qrScanner.destroy();
    qrScanner = null;
  }
}

function closeScanner() {
  active = false;
  scanGeneration++;
  destroyQrScanner();
  stopCamera();
  clearOverlay(canvas);
  scannerSection.hidden = true;
  setPageInert(false);
  scanOpener?.focus?.();
  scanOpener = null;
  expectedSubject = null;
  // Today and Attendance re-read the server, so a new mark shows straight away.
  window.dispatchEvent(new CustomEvent('student:changed'));
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

// Order matters here. The scanner only starts decoding from the video's "play" event, so
// it must exist (and be listening) BEFORE the stream is attached. Attaching the stream
// first lets "play" fire early, and then nothing is ever decoded.
function startQrScan(stream, cameraFingerprint) {
  const generation = scanGeneration;
  lastActivityAt = Date.now();
  qrScanner = new QrScanner(
    video,
    result => {
      lastActivityAt = Date.now();
      handleQrResult(result.data, cameraFingerprint, generation);
    },
    {
      returnDetailedScanResult: true,
      onDecodeError: () => {
        lastActivityAt = Date.now(); // the scanner is alive, there is just no QR in view
      },
    },
  );
  video.srcObject = stream;
  qrScanner.start().catch(error => {
    if (!active || generation !== scanGeneration) return;
    console.error('QR scanner could not start', error);
    restartCamera(cameraFingerprint);
  });

  // Watchdog: if no decode attempt happens for a while, rebuild everything.
  stopWatchdog();
  watchdogTimer = setInterval(() => {
    if (!active || generation !== scanGeneration || isProcessing) return;
    if (document.hidden) return lastActivityAt = Date.now();
    if (Date.now() - lastActivityAt > WATCHDOG_MS)
      restartCamera(cameraFingerprint);
  }, 1000);
}

async function restartCamera() {
  if (cameraRestarts >= MAX_CAMERA_RESTARTS) {
    closeScanner();
    return toastError('camera_unknown');
  }
  cameraRestarts++;
  destroyQrScanner();
  stopCamera();
  setStatus('Camera is starting…');
  await startQrStep();
}

async function handleQrResult(data, cameraFingerprint, generation) {
  if (isProcessing || !active || generation !== scanGeneration) return;
  if (Date.now() < cooldownUntil || data === rejectedToken) return;

  // Not shaped like a class token: say so without bothering the server.
  if (!looksLikeClassToken(data)) {
    rejectedToken = data;
    cooldownUntil = Date.now() + REJECT_COOLDOWN_MS;
    const e = describeError('not_a_class_qr');
    return setStatus(`${e.title} ${e.text}`, true);
  }

  isProcessing = true;
  if (navigator.vibrate) navigator.vibrate(40);
  setStatus('Checking QR code...');
  const response = await postJson('/api/attendance/verify', {
    studentId,
    studentName,
    token: data,
    cameraFingerprint,
    isFaceScanned: false,
  });
  if (!active || generation !== scanGeneration) return;

  if (!response.ok) {
    const e = describeError(response);
    if (e.keepScanning || e.retryable) {
      // Stay on the QR step. Remember codes the server refused, but not network failures.
      if (response.error !== 'network' && e.keepScanning) rejectedToken = data;
      cooldownUntil = Date.now() + REJECT_COOLDOWN_MS;
      isProcessing = false;
      return setStatus(`${e.title} ${e.text}`, true);
    }
    destroyQrScanner();
    stopCamera();
    return showFailure(response, { primary: 'close' });
  }

  destroyQrScanner();
  stopCamera();
  flow = {
    sessionId: response.sessionId,
    section: response.section,
    subject: response.subject || null,
    cameraFingerprint,
    verifiedAt: 0,
  };
  startFaceStep();
}

// ---------- Step 2: face check ----------
async function startFaceStep() {
  const generation = scanGeneration;
  setStep(2);
  clearOverlay(canvas);
  zoomRow.hidden = true;
  $('#cameraArea').hidden = false;
  $('#resultPanel').hidden = true;
  setStatus(
    flow.subject ? `${flow.subject}. Look at the camera.` : 'Look at the camera.',
  );
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
    });
    if (!active || generation !== scanGeneration) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    video.srcObject = stream;
    await video.play();
  } catch (error) {
    console.error('Could not start face verification camera', error);
    stopCamera();
    if (!active || generation !== scanGeneration) return;
    return showFailure(cameraErrorCode(error), { primary: 'retryFace' });
  }
  setStatus('Keep your face visible in the frame.');

  // If the teacher closes attendance while the check runs, stop and say so.
  let stopCode = null;
  const poll = setInterval(async () => {
    const res = await fetch(
      `/api/attendance/session-status?sessionId=${encodeURIComponent(flow.sessionId)}&studentId=${encodeURIComponent(studentId)}`,
    )
      .then(r => r.json())
      .catch(() => null);
    if (res && res.ok && res.open === false) stopCode = res;
  }, STATUS_POLL_MS);
  const isRunning = () =>
    active && generation === scanGeneration && stopCode === null;

  let result;
  try {
    result = await runFaceCheck({
      video,
      canvas,
      models: faceModels,
      descriptor,
      isActive: isRunning,
      onStatus: setStatus,
    });
  } catch (error) {
    clearInterval(poll);
    console.error('Face verification failed', error);
    if (active && generation === scanGeneration) {
      stopCamera();
      showFailure('unknown', { primary: 'retryFace' });
    }
    return;
  }
  clearInterval(poll);
  if (!active || generation !== scanGeneration) return;

  if (result.status === 'cancelled' && stopCode) {
    stopCamera();
    return showFailure(
      { error: stopCode.error, subject: flow.subject },
      { primary: 'close' },
    );
  }
  if (result.status === 'timeout') {
    stopCamera();
    faceRounds++;
    return showFaceTimeout(result);
  }
  if (result.status !== 'matched') return;

  drawDetection(canvas, video, result.face, studentName, '#2f9e44');
  stopCamera();
  flow.verifiedAt = Date.now();
  submitAttendance();
}

// ---------- Step 3: submit ----------
async function submitAttendance() {
  const generation = scanGeneration;
  setStatus('Submitting attendance...');
  const response = await postJson('/api/attendance/verify', {
    studentId,
    studentName,
    sessionId: flow.sessionId,
    section: flow.section,
    cameraFingerprint: flow.cameraFingerprint,
    isFaceScanned: true,
  });
  if (!active || generation !== scanGeneration) return;

  if (response.ok) {
    if (navigator.vibrate) navigator.vibrate(60);
    const subject = response.subject || flow.subject;
    return showResult({
      tone: 'success',
      title: 'Attendance marked',
      text: subject
        ? `You are marked present for ${subject}.`
        : 'You are marked present for this class.',
      receipt: [
        ['Class', subject || 'This class'],
        ['Time', formatTime(response.markedAt)],
        ['Method', 'QR code'],
      ],
      primary: { label: 'Done', action: closeScanner },
    });
  }
  const e = describeError({ ...response, subject: response.subject || flow.subject });
  // A network or server problem keeps the passed face check, so it can be re-sent.
  if (e.retryable && Date.now() - flow.verifiedAt < VERIFIED_VALID_MS)
    return showFailure(response, { primary: 'retrySubmit' });
  showFailure(response, { primary: e.retryable ? 'retryFace' : 'close' });
}

// ---------- Result screen ----------
const PANEL_CLASS = { success: 'ok', warning: 'warn', error: 'fail' };
const PANEL_ICON = { success: '✓', warning: '!', error: '!' };

function formatTime(iso) {
  const date = iso ? new Date(iso) : new Date();
  return Number.isNaN(date.getTime())
    ? new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// options: { tone, title, text, tip, receipt: [[label, value]], code, primary: {label, action}, secondary }
function showResult(options) {
  scanGeneration++; // stops any loop still running
  clearOverlay(canvas);
  setStep(options.tone === 'success' ? 4 : currentStep);
  $('#cameraArea').hidden = true;
  setStatus('');

  const panel = $('#resultPanel');
  panel.hidden = false;
  panel.className = `card result-panel ${PANEL_CLASS[options.tone] || 'fail'}`;
  panel.querySelector('.result-icon').textContent =
    PANEL_ICON[options.tone] || '!';
  $('#resultTitle').textContent = options.title;
  $('#resultText').textContent = options.text || '';
  $('#resultText').hidden = !options.text;

  const tip = $('#resultTip');
  tip.textContent = options.tip || '';
  tip.hidden = !options.tip;

  const receipt = $('#receipt');
  receipt.replaceChildren(
    ...(options.receipt || []).map(([label, value]) => {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      row.append(dt, dd);
      return row;
    }),
  );
  receipt.hidden = !options.receipt?.length;

  const primary = $('#resultAction');
  primary.textContent = options.primary.label;
  primary.onclick = options.primary.action;

  const secondary = $('#resultSecondary');
  secondary.hidden = !options.secondary;
  if (options.secondary) {
    secondary.textContent = options.secondary.label;
    secondary.onclick = options.secondary.action;
  }

  // The raw code is only for support, tucked away.
  const details = $('#resultDetails');
  details.hidden = !options.code;
  details.open = false;
  $('#resultCode').textContent = options.code || '';

  active = true; // the panel is open, Cancel/Escape must still work
  $('#resultTitle').focus();
}

// Reopens the QR step from the start.
function restartScan() {
  openScanner();
}

// A refused or failed request, shown with the message and next step from errors.js.
// primary: 'close' | 'retryFace' | 'retrySubmit' | 'rescan'
function showFailure(codeOrResponse, { primary = 'close' } = {}) {
  const e = describeError(codeOrResponse);
  const actions = {
    close: { label: 'Close', action: closeScanner },
    rescan: { label: 'Scan again', action: restartScan },
    retryFace: { label: 'Try again', action: () => startFaceStep() },
    retrySubmit: {
      label: 'Retry submit',
      action: () => {
        $('#resultPanel').hidden = true;
        $('#cameraArea').hidden = false;
        submitAttendance();
      },
    },
  };
  const options = {
    tone: e.tone,
    title: e.title,
    text: e.text,
    code: e.code === 'unknown' ? '' : e.code,
    primary: actions[primary],
  };
  if (primary === 'retrySubmit')
    options.text = `${e.text} Your face check is kept for a minute.`;
  if (primary !== 'close') options.secondary = actions.close;
  showResult(options);
}

function showFaceTimeout(result) {
  const inPerson = faceRounds >= FACE_ROUNDS_BEFORE_IN_PERSON;
  const options = {
    tone: 'warning',
    title: "We couldn't verify your face",
    text:
      result.reason === 'attempts'
        ? 'Your face did not match after a few tries.'
        : 'The check ran out of time.',
    tip: result.tip,
    code: `face_check_${result.reason}:${result.problem}`,
    primary: { label: 'Try again', action: () => startFaceStep() },
    secondary: { label: 'Close', action: closeScanner },
  };
  if (inPerson) {
    // Nothing is sent anywhere. The teacher reads this and marks the student by hand.
    options.text = 'Ask your teacher to mark you present. Show them this screen.';
    options.receipt = [
      ['Student', studentName],
      ['ID', studentId],
      ['Class', flow?.subject || 'This class'],
      ['Time', formatTime()],
      ['Reason', 'Face check failed'],
    ];
  }
  showResult(options);
}

function stopCamera() {
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach(track => track.stop());
  video.srcObject = null;
}

// The id of the camera actually in use. It marks which phone sent a scan.
async function getCameraId(stream) {
  const fromTrack = stream?.getVideoTracks?.()[0]?.getSettings?.().deviceId;
  if (fromTrack) return fromTrack;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === 'videoinput');
  const preferred =
    inputs.find(d => d.label.toLowerCase().includes('back')) || inputs[0];
  return preferred?.deviceId || null;
}

let workerChecked = null;
function qrWorkerAvailable() {
  workerChecked ||= fetch('/utils/qr-scanner-worker.min.js', { method: 'HEAD' })
    .then(
      r =>
        r.ok &&
        /javascript/i.test(r.headers.get('content-type') || ''),
    )
    .catch(() => false);
  return workerChecked;
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
