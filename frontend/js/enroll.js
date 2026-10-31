// Face enrolment (guided photos) and the camera self-test. One full-screen dialog serves both.
// Photos are taken live only: a gallery upload would let a student enrol someone else's picture.
import { apiGet, apiUpload } from './api.js';
import { h } from './dom.js';
import { engine } from './face/engine.js';
import { openCamera, nextFrame, stopCamera as stopVideo } from './face/camera.js';
import { assessFrame, assessGeometry, canvasToDataUrl, snapshotFrame, embedSnapshot, runFaceCheck, clearOverlay, drawDetection, FACE_TIPS, FACE_SETTINGS } from './face-verify.js';
import { averageTemplate, cosine, estimatePose, plausibleFace, shotsFor, shotRelax } from './pose.js';
import { createPoseGuide } from './pose-guide.js'; // smoothing + speed-aware coaching + steady arrow
import { buildPhotoMeta, lumaStats } from './capture-meta.js'; // per-photo metadata (pose, lighting, landmarks) saved with every photo
import { createTurnGuide } from './face/turn-guide.js';
import { cameraSize } from './face/perf.js';
import { createLoopStats } from './face/loop-stats.js';
import { createBoxSmoother } from './face/box-smoother.js';
import { getCurrentUser } from '../utils/storage.js';

const FACE_MODEL = 'w600k_mbf'; // must match the server
// ?debug=1 on the page address shows live timings and gate counts, and keeps the technical "what the camera saw" line.
const DEBUG = new URLSearchParams(location.search).has('debug');

const SETTINGS = {
  detectionThreshold: 0.7, // stricter than the QR check: these photos are kept for good, and a lower value let a ceiling fan through. The wide and deep shots ask for less (see SHOTS in pose.js).
  stableFrames: 3, // frames in a row inside the pose window before a photo is taken...
  holdMs: 450, // ...and the pose must also be held this long: frames now arrive faster (no fixed pause between them), so counting frames alone would shorten the hold
  lightEvery: 3, // the pixel-reading checks (light, blur, glare) run on every this-many-th frame; face size is checked on every frame
  graceMs: 400, // a face lost for less than this (the detector blinking at an extreme angle) keeps the hold-still count and the kept frames
  boxSmoothing: 0.55, // share of the way the drawn box moves to each new detection (1 = no smoothing)
  shotBudgetMs: 40000, // per photo
  samePersonMin: 0.3, // a new photo must look like the earlier ones (loose: poses differ)
  stillSize: 960, // longest side of the saved photo (the recognizer sees 112 px; bigger only slows the upload on mobile data)
  jpegQuality: 0.85,
  uploadStallMs: 30000, // no byte sent for this long: the upload is stuck, retry
  uploadAttempts: 3, // tries in all (the first plus two automatic retries) before "Try again" is offered
  maxMismatches: 3,
  graceFrames: 2, // frames in a row that may fall outside the pose window before the hold-still count restarts (landmarks jitter)
  candidateFrames: 4, // the last this-many good frames of a pose are kept; the sharpest two feed the embedding, the sharpest is saved
  noticeMs: 2200, // how long a failure message stays readable before 'Hold still' replaces it
  announceMs: 1500, // screen-reader coaching: at least this long between two sentences
};

// What the student reads on screen. English only, and nothing that names a direction: the arrow and the gauge show
// the way, and the sentences that name it ("a bit more to the left") go to screen readers only (see announce()).
// The pose name above the camera is the one bilingual line (SHOTS.short in pose.js).
const ENROL_HINTS = {
  noface: 'Face in the frame',
  multiple: 'Only you in view',
  far: 'Move closer',
  close: 'Move back a little',
  dark: 'More light',
  blurry: 'Hold still',
  backlit: 'Light in front, not behind',
  sidelit: 'Face the light',
  glare: 'Too bright on your face',
};
const ENROL_ASSESS = { ...FACE_SETTINGS, lightChecks: true };

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
const srEl = $('#captureSR');
const guide = createTurnGuide($('#captureCamera .camera-wrapper')); // animated arrows + ghost head + hold-still ring

// The face box and the turn guide are cleared together.
const clearAll = () => { clearOverlay(overlay); guide.hide(); };

// Coaching that names a direction goes to screen readers only. At most one sentence per announceMs, never the same one twice
// in a row, so a screen reader is not talked over by a message that changes every frame.
let srLast = '';
let srLastAt = 0;
function announce(text) {
  const now = performance.now();
  if (!text || text === srLast || now - srLastAt < SETTINGS.announceMs) return;
  srLast = text;
  srLastAt = now;
  srEl.textContent = text;
}

// ?debug=1: a small strip under the camera with live timings and gate counts (see face/loop-stats.js)
let debugEl = null;
function showDebug(text) {
  if (!DEBUG) return;
  if (!debugEl) {
    debugEl = document.createElement('pre');
    debugEl.id = 'captureDebug';
    $('#captureCamera').append(debugEl);
  }
  debugEl.textContent = text;
}

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
  $('#captureCancel').disabled = false;
  dialog.hidden = false;
  setInert(true);
  panel.hidden = true;
  loading.hidden = true;
  cameraArea.hidden = false;
  clearAll();
  $('#captureCancel').focus();
  return run;
}
function close() {
  run++;
  stopCamera();
  clearAll();
  dialog.hidden = true;
  setInert(false);
  opener?.focus?.();
  opener = null;
}
$('#captureCancel').addEventListener('click', close);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dialog.hidden && !$('#captureCancel').disabled) close(); });

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
  $('#captureCancel').disabled = false; // (it is off only while photos are being uploaded)
  stopCamera();
  clearAll();
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
      ideal: cameraSize(), // 1920x1440 on a laptop, 1280x960 on a phone: the saved photos are at most 960 px, so a phone gains nothing from more
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
  const doneIdx = new Set(); // indexes of shots that were taken
  const skippedIdx = new Set(); // optional shots the student could not do in time
  let baseline = null; // { pitch, roll } from the first photo
  let mismatches = 0;

  for (let i = 0; i < shots.length; i++) {
    markDots(i, doneIdx, skippedIdx);
    const shot = shots[i];
    instruction.textContent = shot.short; // big, two languages; the animated arrows on the picture show which way to turn
    guide.hide();
    hint.textContent = `${i + 1} / ${shots.length}`;
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
        tip: DEBUG && result.detail ? `What the camera saw: ${result.detail}` : undefined, // technical counts: only with ?debug=1
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
    taken.push({ shot, dataUrl: result.photos[0].dataUrl, photos: result.photos, embedding: result.embedding });
    if (navigator.vibrate) navigator.vibrate(40);
    guide.captured(); // ring completes, ripple, a check pops in the middle, one soft flash
    doneIdx.add(i);
    markDots(i + 1, doneIdx, skippedIdx); // the progress segment turns green right now (and pops)
    setStatus(`Photo ${i + 1} of ${shots.length} saved`);
    await sleep(900);
  }
  if (!isRunning(id)) return;
  markDots(shots.length, doneIdx, skippedIdx);
  review(taken);
}

function markDots(current, done, skipped = new Set()) {
  [...dots.children].forEach((li, i) => {
    li.classList.toggle('done', done instanceof Set ? done.has(i) : i < done);
    li.classList.toggle('skipped', skipped.has(i));
    li.classList.toggle('current', i === current);
    if (i === current) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
}

// One photo: wait until the face is right for this shot, hold, then take it.
//
// Per turn: wait for a NEW camera frame, find the face (in the worker), check it, and update the guide. There is no fixed
// pause between turns any more: the loop runs as fast as the phone can find faces, and a slow phone simply drops frames.
async function captureShot({ id, engine: eng, shot, baseline, taken, onMismatch }) {
  const startedAt = performance.now();
  const problems = {};
  const stats = createLoopStats();
  const note = key => { problems[key] = (problems[key] || 0) + 1; stats.count(key); }; // which gate fired, and how often
  const poseGuide = createPoseGuide(); // one per photo: smoothing starts fresh
  const smoother = createBoxSmoother(SETTINGS.boxSmoothing);
  const threshold = shot.threshold ?? SETTINGS.detectionThreshold; // wide and deep shots set their own (pose.js)
  const relax = shotRelax(shot);
  let stable = 0; // turns in a row inside the pose window
  let holdStartAt = 0; // when the current run of good turns began
  let misses = 0; // turns in a row outside the pose window
  let noticeUntil = 0; // while now < noticeUntil a failure message stays on screen
  let lastGoodAt = 0; // last turn that had one plausible face
  let frameNo = 0;
  let gate = null; // the last pixel-reading check
  let gateFrame = -99;
  let lastGateKey = '';
  const say = (text, bad = false) => { if (performance.now() >= noticeUntil) setStatus(text, bad); };
  const notice = (text, bad = true) => { setStatus(text, bad); noticeUntil = performance.now() + SETTINGS.noticeMs; };
  const candidates = []; // the last few good frames of this pose, each a full-size snapshot
  const templateSoFar = taken.filter(t => t.shot.template).map(t => t.embedding);
  const restart = () => { poseGuide.reset(); stable = 0; misses = 0; holdStartAt = 0; candidates.length = 0; gate = null; };
  const logGate = key => {
    if (DEBUG && key !== lastGateKey) console.info(`[enrol] ${shot.id}: ${key} at ${Math.round(performance.now() - startedAt)} ms`, stats.summary().counts);
    lastGateKey = key;
  };
  announce(shot.title); // the arrows are visual, so a screen reader is told the pose in words

  while (isRunning(id)) {
    if (performance.now() - startedAt > SETTINGS.shotBudgetMs) {
      const top = Object.entries(problems).sort((a, b) => b[1] - a[1])[0]?.[0] || 'noface';
      // The tip for the most common problem, plus the raw counts so a failure can be understood
      const tip = top === 'pose' ? `Follow the instruction on screen: ${shot.title.toLowerCase()}, and hold still.` : FACE_TIPS[top] || FACE_TIPS.noface;
      const names = { noface: 'no face', implausible: 'not shaped like a face', multiple: 'more than one face', far: 'too far', close: 'too close', dark: 'too dark', blurry: 'blurry', backlit: 'light behind you', sidelit: 'light on one side', glare: 'too bright', pose: 'head position', grace: 'frames kept through a short loss' };
      const detail = Object.entries(problems).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${names[k] || k}: ${n}`).join(', ');
      console.warn('[enrol] photo timed out', { shot: shot.id, problems, summary: stats.summary() });
      return { status: 'timeout', tip, detail };
    }
    if (document.hidden) { await sleep(400); continue; } // a background tab gets no camera frames
    if (!(await nextFrame(video, 3000))) { if (!isRunning(id)) break; return { status: 'camera_stalled' }; }
    const turnStart = performance.now();
    stats.frame(turnStart);
    frameNo++;
    const faces = await engine.detect(video, threshold);
    if (!isRunning(id)) break;
    stats.time('detect', performance.now() - turnStart);
    stats.time('detectWorker', engine.timings.detectMs);

    // ---- gate 1: is there exactly one face, shaped like a face? ----
    const face = faces.length === 1 && plausibleFace(faces[0], relax) ? faces[0] : null;
    const lost = faces.length > 1 ? 'multiple' : faces.length === 0 ? 'noface' : face ? null : 'implausible';
    if (lost) {
      note(lost);
      logGate(lost);
      // The detector often blinks for a frame or two at an extreme angle. Keep everything for a moment instead of starting over.
      if (lost !== 'multiple' && lastGoodAt && turnStart - lastGoodAt < SETTINGS.graceMs) {
        stats.count('grace');
        if (smoother.box) drawBox(smoother.box, null);
        continue;
      }
      restart();
      smoother.reset();
      if (faces[0]) drawBox(faces[0].box, null); else clearAll();
      guide.hide();
      say(ENROL_HINTS[lost === 'implausible' ? 'noface' : lost]);
      continue;
    }
    lastGoodAt = turnStart;
    logGate('face');
    const box = smoother.push(face.box);

    // ---- gate 2: size always; light, blur and glare on every few turns (they read pixels, which is the slow part) ----
    const candidatesWanted = stable > 0 && candidates.length < 2; // until two frames are kept, look at every turn
    const due = !gate || !gate.ok || frameNo - gateFrame >= SETTINGS.lightEvery || candidatesWanted;
    let assessedNow = false;
    if (due) {
      const t = performance.now();
      gate = assessFrame(video, face, ENROL_ASSESS);
      stats.time('assess', performance.now() - t);
      gateFrame = frameNo;
      assessedNow = true;
    } else {
      const size = assessGeometry(video, face, ENROL_ASSESS);
      if (size) gate = { ok: false, hint: size };
    }
    if (!gate.ok) {
      const hint = gate.hint;
      restart();
      note(hint);
      logGate(hint);
      drawBox(box, null);
      guide.hide();
      say(ENROL_HINTS[hint]);
      continue;
    }

    // ---- gate 3: the pose ----
    const rawPose = estimatePose(face.landmarks, baseline ? baseline.roll : null);
    const poseBaseline = baseline ? { pitch: baseline.pitch } : null;
    // The steady pose decides; the gauge shows the lighter display pose (see pose-guide.js).
    const r = poseGuide.step(shot, rawPose, poseBaseline, turnStart);
    const { pose, check } = r;
    const drawStart = performance.now();
    drawBox(box, check.ok);
    const showGuide = (state, fraction = 0) => guide.update({
      face: { ...face, box }, video, state, fraction,
      need: state === 'guide' ? r.need : null, // steady 8-way arrow, calm while the student should slow down
      meters: state === 'guide' ? r.meters : null, // how much the head has turned, as a gauge
    });
    if (!check.ok && ++misses <= SETTINGS.graceFrames && stable > 0) {
      // one or two jittery frames while holding still: keep the count instead of starting again
      showGuide('ok', Math.min(stable / SETTINGS.stableFrames, (turnStart - holdStartAt) / SETTINGS.holdMs));
    } else if (!check.ok) {
      note('pose'); logGate('pose'); stable = 0; holdStartAt = 0; candidates.length = 0; showGuide('guide');
      // A sentence that names a direction is for screen readers; the screen shows the arrow and the gauge.
      const coaching = r.text ?? check.hint;
      if (r.directional === false) say(coaching);
      else { say('Match the pose'); announce(coaching); }
    } else if (r.moving) {
      // inside the window but the head is still moving: wait for it to settle (this also avoids blurry photos)
      misses = 0;
      showGuide('ok', Math.min(stable / SETTINGS.stableFrames, (turnStart - holdStartAt) / SETTINGS.holdMs));
      say('Hold still');
    } else {
      misses = 0;
      if (stable === 0) holdStartAt = turnStart;
      stable++;
      showGuide('ok', Math.min(stable / SETTINGS.stableFrames, (turnStart - holdStartAt) / SETTINGS.holdMs));
      const current = { pose };
      // Keep this frame (full size) as a candidate, but only when its sharpness was just measured; only the last few are remembered.
      if (assessedNow) {
        candidates.push({
          snapshot: snapshotFrame(video, face, gate.quality, SETTINGS.stillSize), sharpness: gate.sharpness, light: gate.brightness, facePx: gate.facePx, pose,
          landmarks: face.landmarks.map(p => ({ x: p.x, y: p.y })), box: { ...face.box }, video: { w: video.videoWidth, h: video.videoHeight }, luma: faceLuma(video, face.box),
        });
        if (candidates.length > SETTINGS.candidateFrames) candidates.shift();
      }
      say('Hold still');
      if (stable >= SETTINGS.stableFrames && turnStart - holdStartAt >= SETTINGS.holdMs && candidates.length) {
        const taken1 = await takePhoto({ engine, shot, candidates, templateSoFar });
        if (!isRunning(id)) break;
        if (DEBUG) console.info(`[enrol] ${shot.id}: taken`, stats.summary());
        if (taken1.status === 'ok') return { ...taken1, baseline: shot.id === 'front' ? { pitch: current.pose.pitch, roll: current.pose.roll } : null };
        if (taken1.status === 'mismatch') {
          if (onMismatch() >= SETTINGS.maxMismatches) return { status: 'different-person' };
          notice('That does not look like the earlier photos. Face the camera and try again.');
        }
        stable = 0;
        holdStartAt = 0;
        candidates.length = 0;
      }
    }
    stats.time('draw', performance.now() - drawStart);
    stats.time('loop', performance.now() - turnStart);
    if (DEBUG && frameNo % 5 === 0) showDebug(stats.line());
  }
  return { status: 'cancelled' };
}

// Picks the sharpest two of the last few good frames (motion blur is the usual flaw), embeds both and averages the
// two embeddings: steadier than one frame. Only the sharpest is saved as a photo (one photo per pose); the runner-up
// has done its job once it is in the average, so it is never encoded or uploaded.
async function takePhoto({ engine, shot, candidates, templateSoFar }) {
  const ranked = [...candidates].sort((a, b) => b.sharpness - a.sharpness).slice(0, 2);
  const embeddings = [];
  for (const candidate of ranked) embeddings.push(await embedSnapshot(engine, candidate.snapshot));
  const embedding = embeddings.length > 1 ? averageTemplate(embeddings) : embeddings[0];
  if (templateSoFar.length) {
    const mean = averageTemplate(templateSoFar);
    if (cosine(embedding, mean) < (shot.identityMin ?? SETTINGS.samePersonMin)) return { status: 'mismatch' };
  }
  const best = ranked[0];
  // encode without blocking the page (one JPEG of up to 960 px)
  const dataUrl = await canvasToDataUrl(best.snapshot.canvas, 'image/jpeg', SETTINGS.jpegQuality);
  const photos = [{ dataUrl, meta: buildPhotoMeta({ shot, rank: 1, candidate: best, userAgent: navigator.userAgent }) }];
  return { status: 'ok', embedding: Array.from(embedding), photos };
}

// Brightness statistics (mean, spread, left/right and top/bottom balance) of the face in the current video frame.
// Saved with each photo so the CCTV tests can be split by lighting later. Never throws: null when it cannot be read.
let lumaCanvas = null;
function faceLuma(video, box) {
  try {
    const size = 48;
    const x1 = Math.max(0, box.x1), y1 = Math.max(0, box.y1);
    const x2 = Math.min(video.videoWidth, box.x2), y2 = Math.min(video.videoHeight, box.y2);
    if (x2 - x1 < 8 || y2 - y1 < 8) return null;
    if (!lumaCanvas) lumaCanvas = document.createElement('canvas');
    lumaCanvas.width = size;
    lumaCanvas.height = size;
    const context = lumaCanvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(video, x1, y1, x2 - x1, y2 - y1, 0, 0, size, size);
    return lumaStats(context.getImageData(0, 0, size, size).data, size, size);
  } catch {
    return null;
  }
}

// good: true = green (right pose), false = red (wrong pose), null = amber (frame not usable yet, see the hint).
// `box` is the smoothed box, so it glides. Which way to turn is shown by the turn guide (js/face/turn-guide.js), not here.
function drawBox(box, good) {
  const color = good === null ? '#f59f00' : good ? '#2f9e44' : '#e5484d';
  drawDetection(overlay, video, { box }, '', color);
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
      { label: 'Start over', onclick: () => { const wears = taken.some(t => t.shot.id === 'no-glasses'); open('Add your face photos'); enrol(run, shotsFor(wears)); } },
    ],
  });
}

const SAVE_ERRORS = {
  face_already_enrolled: ['This face is already registered under another account.', 'Contact the admin office.'],
  already_enrolled: ['Your photos are already saved.', 'To change them, ask the admin office to reset them.'],
  enrolment_in_progress: ['Your photos are still being saved.', 'Wait a few seconds and try again.'],
  password_change_required: ['Change your password first.', 'You can do it in Profile.'],
  too_many_attempts: ['Too many tries.', 'Wait an hour, or ask the admin office.'],
  network: ['No connection to the server.', 'Check your Wi-Fi or mobile data, then try again.'],
  timeout: ['The upload is taking too long.', 'Your connection is slow. Move to better Wi-Fi or mobile signal and try again. Nothing was lost.'],
  server_error: ['The server had a problem.', 'Please try again in a minute. Nothing was lost.'],
  wrong_face_model: ['This version of the app is out of date.', 'Reload the page and try again.'],
};
const RETRYABLE = new Set(['network', 'timeout', 'server_error']);
const RING_LENGTH = 2 * Math.PI * 19; // circumference of the ring in upload-ring (r = 19)
const svg = (tag, attrs) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

// The upload screen: a ring that fills as bytes go out, and a line saying what is happening.
function showUploading(megabytes) {
  $('#captureCancel').disabled = true; // closing now would not stop the upload, only hide it
  stopCamera();
  clearAll();
  cameraArea.hidden = true;
  loading.hidden = true;
  dots.hidden = true;
  setStatus('');
  panel.hidden = false;
  panel.className = 'card result-panel';
  const bar = svg('circle', { class: 'upload-bar', cx: 22, cy: 22, r: 19, 'stroke-dasharray': RING_LENGTH, 'stroke-dashoffset': RING_LENGTH });
  const ringSvg = svg('svg', { viewBox: '0 0 44 44', 'aria-hidden': 'true' });
  ringSvg.append(svg('circle', { class: 'upload-track', cx: 22, cy: 22, r: 19 }), bar);
  const pct = h('span', { class: 'upload-pct', text: '0%' });
  const ring = h('div', { class: 'upload-ring', role: 'progressbar', 'aria-label': 'Uploading your photos', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, ringSvg, pct);
  const line = h('p', { role: 'status', text: `Uploading ${megabytes.toFixed(1)} MB. Please keep this page open.` });
  panel.replaceChildren(ring, line);
  return {
    progress(fraction) {
      const done = fraction >= 1;
      bar.setAttribute('stroke-dashoffset', String(RING_LENGTH * (1 - Math.min(1, Math.max(0, fraction)))));
      pct.textContent = done ? '' : `${Math.round(fraction * 100)}%`;
      ring.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
      ring.classList.toggle('waiting', done); // everything is sent; the server is checking and filing the photos
      if (done) line.textContent = 'Saving your photos…';
    },
    note(text) {
      ring.classList.remove('waiting');
      bar.setAttribute('stroke-dashoffset', String(RING_LENGTH));
      pct.textContent = '0%';
      line.textContent = text;
    },
  };
}

async function save(taken) {
  const id = run;
  const templateGroup = taken.filter(t => t.shot.template).map(t => t.embedding);
  const descriptor = averageTemplate(templateGroup);
  // One photo per pose (the runner-up frame already helped the embedding and was never encoded)
  const images = taken.map(t => ({ dataUrl: t.photos[0].dataUrl, meta: t.photos[0].meta }));
  const body = { images, descriptor, model: FACE_MODEL };
  const megabytes = images.reduce((sum, image) => sum + image.dataUrl.length, 0) / 1e6;
  const ui = showUploading(megabytes);

  let res;
  let attempt = 1;
  for (; attempt <= SETTINGS.uploadAttempts; attempt++) {
    res = await apiUpload('/api/student/face', body, { onProgress: ui.progress, stallMs: SETTINGS.uploadStallMs });
    if (run !== id) return;
    if (res.ok || !RETRYABLE.has(res.error) || attempt === SETTINGS.uploadAttempts) break;
    ui.note(`Connection problem. Trying again (${attempt + 1} of ${SETTINGS.uploadAttempts})…`);
    await sleep(1500 * attempt);
    if (run !== id) return;
  }
  // If a try whose answer was lost actually got through, the next try is refused as "already saved" or "still saving".
  // Ask the server what it has before telling the student something is wrong.
  if (!res.ok && attempt > 1 && (res.error === 'already_enrolled' || res.error === 'enrolment_in_progress')) {
    for (let check = 0; check < 4 && !res.ok; check++) {
      const me = await apiGet('/api/student/me');
      if (run !== id) return;
      if (me.ok && me.faceStatus === 'pending') res = { ok: true };
      else if (res.error === 'enrolment_in_progress') await sleep(2000);
      else break;
    }
  }
  if (!res.ok) {
    const [title, text] = SAVE_ERRORS[res.error] || ["Couldn't save your photos.", 'Please try again.'];
    const canRetry = RETRYABLE.has(res.error) || res.error === 'enrolment_in_progress' || !SAVE_ERRORS[res.error];
    return showPanel({
      title, text,
      thumbs: taken.map((t, i) => ({ src: t.dataUrl, alt: `Photo ${i + 1}` })),
      buttons: [
        ...(canRetry ? [{ label: 'Try again', primary: true, onclick: () => save(taken) }] : []), // sends the same photos again; nothing is retaken
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
    result = await runFaceCheck({ video, canvas: overlay, engine: eng, descriptor, isActive: () => isRunning(id), onStatus: setStatus, settings: { liveness: false } });
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
