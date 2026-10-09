// Face enrolment (guided photos) and the camera self-test. One full-screen dialog serves both.
// Photos are taken live only: a gallery upload would let a student enrol someone else's picture.
import { apiGet, apiPost } from './api.js';
import { h } from './dom.js';
import { engine } from './face/engine.js';
import { openCamera, nextFrame, stopCamera as stopVideo } from './face/camera.js';
import { assessFrame, snapshotFrame, embedSnapshot, runFaceCheck, clearOverlay, drawDetection, HINT_TEXT, FACE_TIPS } from './face-verify.js';
import { averageTemplate, checkPose, cosine, estimatePose, plausibleFace, shotsFor } from './pose.js';
import { getCurrentUser } from '../utils/storage.js';

const FACE_MODEL = 'w600k_mbf'; // must match the server
const SETTINGS = {
  detectionThreshold: 0.7, // stricter than the QR check: these photos are kept for good, and a lower value let a ceiling fan through
  stableFrames: 4, // frames in a row inside the pose window before a photo is taken
  intervalMs: 110,
  shotBudgetMs: 40000, // per photo
  samePersonMin: 0.3, // a new photo must look like the earlier ones (loose: poses differ)
  stillSize: 1280, // longest side of the saved photo
  jpegQuality: 0.92,
  maxMismatches: 3,
  graceFrames: 2, // frames in a row that may fall outside the pose window before the hold-still count restarts (landmarks jitter)
  noticeMs: 2200, // how long a failure message stays readable before 'Hold still' replaces it
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
const loading = $('#captureLoading');
const loadingText = $('#captureLoadingText');
const progressBar = $('#captureProgress');

let run = 0; // bumps on every open and close, so old loops stop
let opener = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isRunning = id => run === id && !dialog.hidden;
const setStatus = (text, bad = false) => { statusEl.textContent = text; statusEl.classList.toggle('error', bad); };

function setInert(on) {
  document.querySelectorAll('.app-header, .app-nav, .app-main').forEach(el => (el.inert = on));
}
function stopCamera() {
  stopVideo(video);
}
function open(title) {
  run++;
  opener = document.activeElement;
  $('#captureHeading').textContent = title;
  dialog.hidden = false;
  setInert(true);
  panel.hidden = true;
  loading.hidden = true;
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

const CAMERA_ERRORS = {
  NotAllowedError: ['Camera access is blocked.', 'Allow the camera for this site in your browser settings, then try again.'],
  NotFoundError: ['No camera found on this device.', 'Use a phone with a front camera.'],
  NotReadableError: ['The camera is being used by another app.', 'Close other apps or tabs that use the camera, then try again.'],
  stalled: ['The camera did not start.', 'Close other apps or tabs that use the camera, then try again.'],
  no_picture: ['The camera opened but sent no picture.', 'Close other apps or tabs that use the camera, then try again.'],
};
function cameraProblem(error) {
  if (window.isSecureContext === false) return ['The camera needs a secure (https) connection.', 'Open this page using the https address.'];
  return CAMERA_ERRORS[error?.name] || CAMERA_ERRORS[error?.code] || ['Could not start the camera.', 'Close the page, open it again and allow the camera.'];
}

// A result screen inside the dialog. buttons: [{label, primary, onclick}]
function showPanel({ tone = 'warn', title, text, tip, thumbs, buttons }) {
  stopCamera();
  clearOverlay(overlay);
  cameraArea.hidden = true;
  loading.hidden = true;
  dots.hidden = true; // the progress bars only belong with the live camera
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

// The loading strip. The camera preview stays visible above it the whole time, so the person can always see
// that the camera works while the face check downloads or starts.
const NOTE_FIRST_TIME = 'The first time, about 27 MB is downloaded. After that it opens straight away.';
function showLoading(text, fraction = null, note = NOTE_FIRST_TIME) {
  loading.hidden = false;
  loadingText.textContent = text;
  $('#captureLoadingNote').textContent = note;
  if (fraction === null) progressBar.removeAttribute('value'); else progressBar.value = Math.round(fraction * 100); // no value = moving bar
}
function engineText({ phase, fraction }) {
  if (phase === 'download') return [fraction === null ? 'Downloading the face check…' : `Downloading the face check… ${Math.round(fraction * 100)}%`, fraction];
  return ['Starting the face check…', null];
}

// Opens the camera and the face engine side by side. Resolves to the engine, or null after showing a message.
async function prepare(id) {
  cameraArea.hidden = false;
  showLoading('Opening the camera…');
  let cameraLive = false;
  let engineUpdate = { phase: 'download', fraction: null };
  const refresh = () => {
    if (!isRunning(id)) return;
    if (!cameraLive) return; // the camera message has priority until the preview is live
    const [text, fraction] = engineText(engineUpdate);
    showLoading(text, fraction, fraction === null ? 'Still starting. This can take a little while on some phones.' : NOTE_FIRST_TIME);
  };
  const engineReady = engine.start(update => { engineUpdate = update; refresh(); });
  engineReady.catch(() => {}); // handled below, once the camera question is settled

  let camera;
  try {
    camera = await openCamera(video, {
      facingMode: 'user',
      onWaiting: text => { if (isRunning(id) && !cameraLive) showLoading(text, null, ''); },
    });
  } catch (error) {
    console.error('Camera failed', error);
    stopCamera();
    if (!isRunning(id)) return null;
    const [title, text] = cameraProblem(error);
    showPanel({ title, text, buttons: [{ label: 'Try again', primary: true, onclick: retry }, { label: 'Close', onclick: close }] });
    return null;
  }
  if (!isRunning(id)) { stopCamera(); return null; } // closed while the camera was opening
  cameraLive = true;
  camera.track.addEventListener('ended', () => {
    if (isRunning(id)) showPanel({ title: 'The camera stopped.', text: 'Another app may have taken it. Close other apps that use the camera, then try again.', buttons: [{ label: 'Try again', primary: true, onclick: retry }, { label: 'Close', onclick: close }] });
  });
  refresh();

  try {
    await engineReady;
  } catch (error) {
    console.error('Face engine failed to load', error);
    if (isRunning(id)) showPanel({ title: "Couldn't get the face check ready", text: 'Check your connection and try again.', tip: String(error.message || error), buttons: [{ label: 'Try again', primary: true, onclick: retry }, { label: 'Close', onclick: close }] });
    else stopCamera();
    return null;
  }
  if (!isRunning(id)) { stopCamera(); return null; }
  loading.hidden = true;
  return engine;
}

// Starts again from the first screen of whichever flow is open.
let retryAction = null;
function retry() { close(); retryAction?.(); }

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------
export function startEnrolment({ wearsGlasses = false } = {}) {
  retryAction = () => startEnrolment({ wearsGlasses });
  const id = open('Add your face photos');
  enrol(id, shotsFor(wearsGlasses));
}

async function enrol(id, shots) {
  dots.hidden = false;
  dots.replaceChildren(...shots.map((s, i) => h('li', { 'data-i': i, 'aria-label': `Photo ${i + 1}` })));
  const eng = await prepare(id);
  if (!eng) return;

  const taken = []; // { shot, dataUrl, embedding }
  let baseline = null; // { pitch, roll } from the first photo
  let mismatches = 0;

  for (let i = 0; i < shots.length; i++) {
    markDots(i, taken.length);
    const shot = shots[i];
    instruction.textContent = shot.title;
    hint.textContent = `${shot.hint}  (Photo ${i + 1} of ${shots.length})`;
    $('#captureCamera').hidden = false;

    let result;
    try {
      result = await captureShot({ id, engine: eng, shot, baseline, taken, onMismatch: () => ++mismatches });
    } catch (error) {
      // The engine stopped (crashed or hung). Say so, instead of leaving a frozen camera view.
      console.error('Face check failed', error);
      if (!isRunning(id)) return;
      return showPanel({ title: 'The face check stopped working.', text: 'Please try again.', tip: String(error.message || error), buttons: [{ label: 'Try again', primary: true, onclick: retry }, { label: 'Close', onclick: close }] });
    }
    if (!isRunning(id)) return;
    if (result.status === 'camera_stalled') {
      return showPanel({ title: 'The camera stopped sending pictures.', text: 'Close other apps that use the camera, then try again.', buttons: [{ label: 'Try again', primary: true, onclick: retry }, { label: 'Close', onclick: close }] });
    }
    if (result.status === 'timeout') {
      return showPanel({
        title: "Couldn't take this photo",
        text: result.tip,
        tip: result.detail ? `What the camera saw: ${result.detail}` : undefined,
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
async function captureShot({ id, engine: eng, shot, baseline, taken, onMismatch }) {
  const startedAt = performance.now();
  const problems = {};
  const note = key => (problems[key] = (problems[key] || 0) + 1);
  let stable = 0;
  let misses = 0; // frames in a row outside the pose window
  let noticeUntil = 0; // while now < noticeUntil a failure message stays on screen
  const say = (text, bad = false) => { if (performance.now() >= noticeUntil) setStatus(text, bad); };
  const notice = (text, bad = true) => { setStatus(text, bad); noticeUntil = performance.now() + SETTINGS.noticeMs; };
  const templateSoFar = taken.filter(t => t.shot.template).map(t => t.embedding);

  while (isRunning(id)) {
    if (performance.now() - startedAt > SETTINGS.shotBudgetMs) {
      const top = Object.entries(problems).sort((a, b) => b[1] - a[1])[0]?.[0] || 'noface';
      // The tip for the most common problem, plus the raw counts so a failure can be understood
      const tip = top === 'pose' ? `Follow the instruction on screen: ${shot.title.toLowerCase()}, and hold still.` : FACE_TIPS[top] || 'Make sure your face is well lit and fully in view.';
      const names = { noface: 'no face', multiple: 'more than one face', far: 'too far', dark: 'too dark', blurry: 'blurry', pose: 'head position', };
      const detail = Object.entries(problems).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${names[k] || k}: ${n}`).join(', ');
      console.warn('[enrol] photo timed out', { shot: shot.id, problems });
      return { status: 'timeout', tip, detail };
    }
    const loopStart = performance.now();
    if (document.hidden) { await sleep(400); continue; } // a background tab gets no camera frames
    if (!(await nextFrame(video, 3000))) { if (!isRunning(id)) break; return { status: 'camera_stalled' }; }
    const faces = await engine.detect(video, SETTINGS.detectionThreshold);
    if (!isRunning(id)) break;

    if (faces.length !== 1) {
      const key = faces.length ? 'multiple' : 'noface';
      note(key); stable = 0; misses = 0; if (faces[0]) drawBox(faces[0], null); else clearOverlay(overlay); say(HINT_TEXT[key]);
    } else if (!plausibleFace(faces[0])) {
      note('noface'); stable = 0; misses = 0; drawBox(faces[0], null); say(HINT_TEXT.noface);
    } else {
      const face = faces[0];
      const gate = assessFrame(video, face);
      if (!gate.ok) {
        note(gate.hint); stable = 0; misses = 0; drawBox(face, null); say(HINT_TEXT[gate.hint]);
      } else {
        const pose = estimatePose(face.landmarks, baseline ? baseline.roll : null);
        const check = checkPose(shot, pose, baseline ? { pitch: baseline.pitch } : null);
        drawBox(face, check.ok);
        if (!check.ok && ++misses <= SETTINGS.graceFrames && stable > 0) {
          // one or two jittery frames while holding still: keep the count instead of starting again
        } else if (!check.ok) {
          note('pose'); stable = 0; say(check.hint);
        } else {
          misses = 0;
          stable++;
          // Everything below uses THIS frame (frames are not kept between loops).
          const current = { face, quality: gate.quality, pose };
          say(`Hold still (${Math.min(stable, SETTINGS.stableFrames)}/${SETTINGS.stableFrames})`);
          if (stable >= SETTINGS.stableFrames) {
            const taken1 = await takePhoto({ engine, current, templateSoFar });
            if (!isRunning(id)) break;
            if (taken1.status === 'ok') return { ...taken1, baseline: shot.id === 'front' ? { pitch: current.pose.pitch, roll: current.pose.roll } : null };
            if (taken1.status === 'mismatch') {
              if (onMismatch() >= SETTINGS.maxMismatches) return { status: 'different-person' };
              notice('That does not look like the earlier photos. Face the camera and try again.');
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

// The embedding and the saved photo, from the same instant.
async function takePhoto({ engine, current, templateSoFar }) {
  const small = snapshotFrame(video, current.face, current.quality, 640);
  const embedding = await embedSnapshot(engine, small);
  if (templateSoFar.length) {
    const mean = averageTemplate(templateSoFar);
    if (cosine(embedding, mean) < SETTINGS.samePersonMin) return { status: 'mismatch' };
  }
  const still = snapshotFrame(video, current.face, current.quality, SETTINGS.stillSize);
  return { status: 'ok', embedding: Array.from(embedding), dataUrl: still.canvas.toDataURL('image/jpeg', SETTINGS.jpegQuality) };
}

// good: true = green (right pose), false = red (wrong pose), null = amber (frame not usable yet, see the hint)
function drawBox(face, good) {
  drawDetection(overlay, video, face, '', good === null ? '#f59f00' : good ? '#2f9e44' : '#e5484d');
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
    if (user) localStorage.setItem('user', JSON.stringify({ ...user, faceEnrolled: false, faceStatus: 'pending' }));
  } catch { /* storage blocked: the server value wins on the next load */ }
  showPanel({ tone: 'ok', title: "You're all set", text: 'Your photos are saved and waiting for approval by the admin office. QR attendance starts once they are approved.', buttons: [{ label: 'Done', primary: true, onclick: () => { close(); window.dispatchEvent(new CustomEvent('student:changed')); } }] });
  window.dispatchEvent(new CustomEvent('student:changed'));
}

// ---------------------------------------------------------------------------
// Camera and lighting self-test: the real face check, but nothing is submitted.
// ---------------------------------------------------------------------------
export async function startSelfTest() {
  retryAction = () => startSelfTest();
  const id = open('Test your camera');
  dots.hidden = true;
  instruction.textContent = 'Look at the camera';
  hint.textContent = 'This only tests your camera and lighting. Nothing is sent or marked.';
  const [eng, templateRes] = await Promise.all([prepare(id), apiGet('/api/student/face/template')]);
  if (!eng || !isRunning(id)) return;
  if (!templateRes.ok) {
    return showPanel({ title: 'Your photos are not saved yet', text: 'Add your face photos first, then test your camera.', buttons: [{ label: 'Close', primary: true, onclick: close }] });
  }
  const descriptor = Float32Array.from(templateRes.data);
  let result;
  try {
    result = await runFaceCheck({ video, canvas: overlay, engine: eng, descriptor, isActive: () => isRunning(id), onStatus: setStatus });
  } catch (error) {
    console.error('Face check failed', error);
    if (!isRunning(id)) return;
    return showPanel({ title: 'The face check stopped working.', text: 'Please try again.', tip: String(error.message || error), buttons: [{ label: 'Try again', primary: true, onclick: () => { close(); startSelfTest(); } }, { label: 'Close', onclick: close }] });
  }
  if (!isRunning(id)) return;
  const again = () => { close(); startSelfTest(); };
  if (result.status === 'camera_stalled') return showPanel({ title: 'The camera stopped sending pictures.', text: 'Close other apps that use the camera, then try again.', buttons: [{ label: 'Try again', primary: true, onclick: again }, { label: 'Close', onclick: close }] });
  if (result.status === 'matched')
    return showPanel({ tone: 'ok', title: 'Looks good', text: 'Your camera and lighting work. The app recognised you.', buttons: [{ label: 'Done', primary: true, onclick: close }, { label: 'Test again', onclick: again }] });
  showPanel({ title: "We couldn't recognise you", text: 'Fix this before class so marking is quick.', tip: result.tip, buttons: [{ label: 'Test again', primary: true, onclick: again }, { label: 'Close', onclick: close }] });
}

window.addEventListener('student:enrol', ev => startEnrolment(ev.detail || {}));
window.addEventListener('student:selftest', () => startSelfTest());
