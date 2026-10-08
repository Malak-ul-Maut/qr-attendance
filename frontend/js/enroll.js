// Face enrolment (guided photos) and the camera self-test. One full-screen dialog serves both.
// Photos are taken live only: a gallery upload would let a student enrol someone else's picture.
import { apiGet, apiPost } from './api.js';
import { h } from './dom.js';
import { loadFaceModels } from './face-models.js';
import { assessFrame, snapshotFrame, runFaceCheck, clearOverlay, HINT_TEXT, FACE_TIPS } from './face-verify.js';
import { averageTemplate, checkPose, cosine, estimatePose, shotsFor } from './pose.js';
import { detectFaces, embedFace, scoreLiveness } from '../utils/face-onnx.js';
import { getCurrentUser } from '../utils/storage.js';

const FACE_MODEL = 'w600k_mbf'; // must match the server
const SETTINGS = {
  detectionThreshold: 0.5,
  liveLogitThreshold: Math.log(0.8 / 0.2),
  stableFrames: 4, // frames in a row inside the pose window before a photo is taken
  intervalMs: 110,
  shotBudgetMs: 40000, // per photo
  samePersonMin: 0.3, // a new photo must look like the earlier ones (loose: poses differ)
  stillSize: 1280, // longest side of the saved photo
  jpegQuality: 0.92,
  maxMismatches: 3,
};

const $ = sel => document.querySelector(sel);
const dialog = $('#capture-section');
const video = $('#captureVideo');
const overlay = $('#captureOverlay');
const statusEl = $('#captureStatus');
const instruction = $('#captureInstruction');
const hint = $('#captureHint');
const dots = $('#captureDots');
const cameraArea = $('#captureCamera');
const panel = $('#capturePanel');

let run = 0; // bumps on every open and close, so old loops stop
let opener = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isRunning = id => run === id && !dialog.hidden;
const setStatus = (text, bad = false) => { statusEl.textContent = text; statusEl.classList.toggle('error', bad); };

function setInert(on) {
  document.querySelectorAll('.app-header, .app-nav, .app-main').forEach(el => (el.inert = on));
}
function stopCamera() {
  video.srcObject?.getTracks().forEach(t => t.stop());
  video.srcObject = null;
}
function open(title) {
  run++;
  opener = document.activeElement;
  $('#captureHeading').textContent = title;
  dialog.hidden = false;
  setInert(true);
  panel.hidden = true;
  cameraArea.hidden = false;
  clearOverlay(overlay);
  $('#captureCancel').focus();
  return run;
}
function close() {
  run++;
  stopCamera();
  clearOverlay(overlay);
  dialog.hidden = true;
  setInert(false);
  opener?.focus?.();
  opener = null;
}
$('#captureCancel').addEventListener('click', close);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dialog.hidden) close(); });

async function openFrontCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } } });
  video.srcObject = stream;
  await video.play();
}

const CAMERA_ERRORS = {
  NotAllowedError: ['Camera access is blocked.', 'Allow the camera for this site in your browser settings, then try again.'],
  NotFoundError: ['No camera found on this device.', 'Use a phone with a front camera.'],
  NotReadableError: ['The camera is being used by another app.', 'Close other apps or tabs that use the camera, then try again.'],
};
function cameraProblem(error) {
  if (window.isSecureContext === false) return ['The camera needs a secure (https) connection.', 'Open this page using the https address.'];
  return CAMERA_ERRORS[error?.name] || ['Could not start the camera.', 'Close the page, open it again and allow the camera.'];
}

// A result screen inside the dialog. buttons: [{label, primary, onclick}]
function showPanel({ tone = 'warn', title, text, tip, thumbs, buttons }) {
  stopCamera();
  clearOverlay(overlay);
  cameraArea.hidden = true;
  setStatus('');
  panel.hidden = false;
  panel.className = `card result-panel ${tone}`;
  panel.replaceChildren(...[
    h('div', { class: 'result-icon', 'aria-hidden': 'true', text: tone === 'ok' ? '✓' : '!' }),
    h('h2', { id: 'capturePanelTitle', tabindex: '-1', text: title }),
    text && h('p', { text }),
    tip && h('p', { class: 'result-tip', text: tip }),
    thumbs && h('ul', { class: 'thumbs' }, thumbs.map(t => h('li', {}, h('img', { src: t.src, alt: t.alt })))),
    ...buttons.map(b => h('button', { class: `btn ${b.primary ? 'btn-primary' : 'btn-secondary'}`, type: 'button', onclick: b.onclick, text: b.label })),
  ].filter(Boolean)); // skipped parts are undefined/false, which replaceChildren would print as text
  panel.querySelector('#capturePanelTitle').focus();
}

async function prepare(id) {
  setStatus('Getting the face check ready…');
  let models;
  try {
    models = await loadFaceModels();
  } catch (error) {
    console.error('Face models failed to load', error);
    if (isRunning(id)) showPanel({ title: "Couldn't get the face check ready", text: 'Check your connection, reload the page and try again.', buttons: [{ label: 'Close', primary: true, onclick: close }] });
    return null;
  }
  try {
    await openFrontCamera();
  } catch (error) {
    if (!isRunning(id)) return null;
    const [title, text] = cameraProblem(error);
    showPanel({ title, text, buttons: [{ label: 'Close', primary: true, onclick: close }] });
    return null;
  }
  return isRunning(id) ? models : null;
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------
export function startEnrolment({ wearsGlasses = false } = {}) {
  const id = open('Add your face photos');
  enrol(id, shotsFor(wearsGlasses));
}

async function enrol(id, shots) {
  dots.hidden = false;
  dots.replaceChildren(...shots.map((s, i) => h('li', { 'data-i': i, 'aria-label': `Photo ${i + 1}` })));
  const models = await prepare(id);
  if (!models) return;

  const taken = []; // { shot, dataUrl, embedding }
  let baseline = null; // { pitch, roll } from the first photo
  let mismatches = 0;

  for (let i = 0; i < shots.length; i++) {
    markDots(i, taken.length);
    const shot = shots[i];
    instruction.textContent = shot.title;
    hint.textContent = `${shot.hint}  (Photo ${i + 1} of ${shots.length})`;
    $('#captureCamera').hidden = false;

    const result = await captureShot({ id, models, shot, baseline, taken, onMismatch: () => ++mismatches });
    if (!isRunning(id)) return;
    if (result.status === 'timeout') {
      return showPanel({
        title: "Couldn't take this photo",
        text: result.tip,
        buttons: [
          { label: 'Try again', primary: true, onclick: () => { open('Add your face photos'); enrol(run, shots); } },
          { label: 'Close', onclick: close },
        ],
      });
    }
    if (result.status === 'different-person') {
      return showPanel({
        title: 'That photo does not look like you',
        text: 'All the photos must be of the same person, taken one after the other.',
        buttons: [{ label: 'Start over', primary: true, onclick: () => { open('Add your face photos'); enrol(run, shots); } }, { label: 'Close', onclick: close }],
      });
    }
    if (i === 0) baseline = result.baseline;
    taken.push({ shot, dataUrl: result.dataUrl, embedding: result.embedding });
    if (navigator.vibrate) navigator.vibrate(40);
    setStatus('Got it.');
    await sleep(500);
  }
  if (!isRunning(id)) return;
  markDots(shots.length, shots.length);
  review(taken);
}

function markDots(current, done) {
  [...dots.children].forEach((li, i) => {
    li.classList.toggle('done', i < done);
    li.classList.toggle('current', i === current);
    if (i === current) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
}

// One photo: wait until the face is right for this shot, hold, then take it.
async function captureShot({ id, models, shot, baseline, taken, onMismatch }) {
  const startedAt = performance.now();
  const problems = {};
  const note = key => (problems[key] = (problems[key] || 0) + 1);
  let stable = 0;
  const templateSoFar = taken.filter(t => t.shot.template).map(t => t.embedding);

  while (isRunning(id)) {
    if (performance.now() - startedAt > SETTINGS.shotBudgetMs) {
      const top = Object.entries(problems).sort((a, b) => b[1] - a[1])[0]?.[0] || 'noface';
      return { status: 'timeout', tip: FACE_TIPS[top] || 'Make sure your face is well lit and fully in view.' };
    }
    const loopStart = performance.now();
    const faces = await detectFaces(video, models.detector, SETTINGS.detectionThreshold);
    if (!isRunning(id)) break;

    if (faces.length !== 1) {
      const key = faces.length ? 'multiple' : 'noface';
      note(key); stable = 0; clearOverlay(overlay); setStatus(HINT_TEXT[key]);
    } else {
      const face = faces[0];
      const gate = assessFrame(video, face);
      if (!gate.ok) {
        note(gate.hint); stable = 0; clearOverlay(overlay); setStatus(HINT_TEXT[gate.hint]);
      } else {
        const pose = estimatePose(face.landmarks, baseline ? baseline.roll : null);
        const check = checkPose(shot, pose, baseline ? { pitch: baseline.pitch } : null);
        drawBox(face, check.ok);
        if (!check.ok) {
          note('pose'); stable = 0; setStatus(check.hint);
        } else {
          stable++;
          // Everything below uses THIS frame (the crop canvas is reused, so an older frame's crop is gone).
          const current = { face, quality: gate.quality, pose, crop: gate.crop };
          setStatus(`Hold still (${Math.min(stable, SETTINGS.stableFrames)}/${SETTINGS.stableFrames})`);
          if (stable >= SETTINGS.stableFrames) {
            const taken1 = await takePhoto({ models, current, templateSoFar });
            if (!isRunning(id)) break;
            if (taken1.status === 'ok') return { ...taken1, baseline: shot.id === 'front' ? { pitch: current.pose.pitch, roll: current.pose.roll } : null };
            if (taken1.status === 'not-live') { note('liveness'); setStatus(HINT_TEXT.liveness); }
            if (taken1.status === 'mismatch') {
              if (onMismatch() >= SETTINGS.maxMismatches) return { status: 'different-person' };
              setStatus('That does not look like the earlier photos. Face the camera and try again.', true);
            }
            stable = 0;
          }
        }
      }
    }
    const spent = performance.now() - loopStart;
    if (spent < SETTINGS.intervalMs) await sleep(SETTINGS.intervalMs - spent);
  }
  return { status: 'cancelled' };
}

// Liveness on the chosen frame, then the embedding and the saved photo, from the same instant.
async function takePhoto({ models, current, templateSoFar }) {
  const live = await scoreLiveness(current.crop, models.liveness);
  if (live.logitDifference < SETTINGS.liveLogitThreshold) return { status: 'not-live' };

  const small = snapshotFrame(video, current.face, current.quality, 640);
  const embedding = await embedFace(small.canvas, small.face, models.recognizer);
  if (templateSoFar.length) {
    const mean = averageTemplate(templateSoFar);
    if (cosine(embedding, mean) < SETTINGS.samePersonMin) return { status: 'mismatch' };
  }
  const still = snapshotFrame(video, current.face, current.quality, SETTINGS.stillSize);
  return { status: 'ok', embedding: Array.from(embedding), dataUrl: still.canvas.toDataURL('image/jpeg', SETTINGS.jpegQuality) };
}

function drawBox(face, good) {
  const w = video.videoWidth, hgt = video.videoHeight;
  if (overlay.width !== w || overlay.height !== hgt) { overlay.width = w; overlay.height = hgt; }
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, w, hgt);
  const { x1, y1, x2, y2 } = face.box;
  ctx.strokeStyle = good ? '#2f9e44' : '#e5484d';
  ctx.lineWidth = Math.max(3, w / 240);
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
}

// ---- review and save ----
function review(taken) {
  const thumbs = taken.map((t, i) => ({ src: t.dataUrl, alt: `Photo ${i + 1}: ${t.shot.title}` }));
  showPanel({
    tone: 'ok',
    title: 'Check your photos',
    text: 'Make sure your face is clear in each one. Once saved, the photos are locked. Only the admin office can reset them.',
    thumbs,
    buttons: [
      { label: 'Save my photos', primary: true, onclick: () => save(taken) },
      { label: 'Start over', onclick: () => { const wears = taken.length > 7; open('Add your face photos'); enrol(run, shotsFor(wears)); } },
    ],
  });
}

const SAVE_ERRORS = {
  face_already_enrolled: ['This face is already registered under another account.', 'Contact the admin office.'],
  already_enrolled: ['Your photos are already saved.', 'To change them, ask the admin office to reset them.'],
  password_change_required: ['Change your password first.', 'You can do it in Profile.'],
  too_many_attempts: ['Too many tries.', 'Wait an hour, or ask the admin office.'],
  network: ['No connection to the server.', 'Check your Wi-Fi or mobile data, then try again.'],
  wrong_face_model: ['This version of the app is out of date.', 'Reload the page and try again.'],
};

async function save(taken) {
  const id = run;
  const templateGroup = taken.filter(t => t.shot.template).map(t => t.embedding);
  const descriptor = averageTemplate(templateGroup);
  const buttons = panel.querySelectorAll('button');
  buttons.forEach(b => (b.disabled = true));
  panel.querySelector('button').setAttribute('aria-busy', 'true');
  const res = await apiPost('/api/student/face', {
    images: taken.map(t => ({ dataUrl: t.dataUrl })),
    descriptor,
    model: FACE_MODEL,
  });
  if (run !== id) return;
  if (!res.ok) {
    const [title, text] = SAVE_ERRORS[res.error] || ["Couldn't save your photos.", 'Please try again.'];
    return showPanel({
      title, text,
      thumbs: taken.map((t, i) => ({ src: t.dataUrl, alt: `Photo ${i + 1}` })),
      buttons: [
        ...(res.error === 'network' || !SAVE_ERRORS[res.error] ? [{ label: 'Try again', primary: true, onclick: () => review(taken) }] : []),
        { label: 'Close', onclick: close },
      ],
    });
  }
  try {
    const user = getCurrentUser();
    if (user) localStorage.setItem('user', JSON.stringify({ ...user, faceEnrolled: true }));
  } catch { /* storage blocked: the server value wins on the next load */ }
  showPanel({ tone: 'ok', title: "You're all set", text: 'Your photos are saved. You can now mark attendance with the QR code.', buttons: [{ label: 'Done', primary: true, onclick: () => { close(); window.dispatchEvent(new CustomEvent('student:changed')); } }] });
  window.dispatchEvent(new CustomEvent('student:changed'));
}

// ---------------------------------------------------------------------------
// Camera and lighting self-test: the real face check, but nothing is submitted.
// ---------------------------------------------------------------------------
export async function startSelfTest() {
  const id = open('Test your camera');
  dots.hidden = true;
  instruction.textContent = 'Look at the camera';
  hint.textContent = 'This only tests your camera and lighting. Nothing is sent or marked.';
  const [models, templateRes] = await Promise.all([prepare(id), apiGet('/api/student/face/template')]);
  if (!models || !isRunning(id)) return;
  if (!templateRes.ok) {
    return showPanel({ title: 'Your photos are not saved yet', text: 'Add your face photos first, then test your camera.', buttons: [{ label: 'Close', primary: true, onclick: close }] });
  }
  const descriptor = Float32Array.from(templateRes.data);
  const result = await runFaceCheck({ video, canvas: overlay, models, descriptor, isActive: () => isRunning(id), onStatus: setStatus });
  if (!isRunning(id)) return;
  const again = () => { close(); startSelfTest(); };
  if (result.status === 'matched')
    return showPanel({ tone: 'ok', title: 'Looks good', text: 'Your camera and lighting work. The app recognised you.', buttons: [{ label: 'Done', primary: true, onclick: close }, { label: 'Test again', onclick: again }] });
  showPanel({ title: "We couldn't recognise you", text: 'Fix this before class so marking is quick.', tip: result.tip, buttons: [{ label: 'Test again', primary: true, onclick: again }, { label: 'Close', onclick: close }] });
}

window.addEventListener('student:enrol', ev => startEnrolment(ev.detail || {}));
window.addEventListener('student:selftest', () => startSelfTest());
