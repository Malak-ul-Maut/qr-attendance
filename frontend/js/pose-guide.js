// Steadier, more precise turn guidance. No DOM, so it can be tested on its own.
//
// Why this file exists. The face detector's five landmarks are a little noisy, and the pose ratios computed from
// them jump by a few percent from frame to frame. Shown raw, that made the arrow flip direction, the message
// change every other frame, and (worse) the guide kept saying "a bit more" while the student was already moving,
// so by the time the head arrived inside the window it had gone past it. This module fixes both:
//
//   1. SMOOTHING: a One-Euro filter on yaw and pitch. It removes the jitter when the head is still, but follows
//      quickly when the head really moves (so it adds almost no lag).
//   2. PREDICTION: from the filtered speed it estimates where the head will be in ~0.4 s (detection delay plus the
//      student's reaction time) and tells the student to slow down / stop BEFORE they cross the window.
//   3. STEADY ARROW: the arrow only points in 8 directions and changes direction only when clearly needed. A tiny
//      error on the second axis can no longer swing the arrow by 90 degrees.
//   4. STEADY TEXT: graded messages (far / near / slow / stop / back) and a minimum time on screen for each.
//
// The acceptance rule is still checkPose() in pose.js, with the same windows, now fed with the filtered pose.
//
// TWO POSES, ON PURPOSE. The steady pose above decides when a photo is taken, so it is smoothed hard (1.1 Hz). That
// smoothing is the right trade for "hold still", and the wrong one for the on-screen gauge: the dot trailed the real
// head by a few tenths of a second, so it felt sluggish. The gauge now shows a DISPLAY pose: a light filter, plus a
// short look-ahead from its own speed to cover the detection delay. It only draws; it never decides anything.
import { checkPose, poseGuidance, poseMeters, poseCoach } from './pose.js';

export const GUIDE_TUNING = {
  minCutoff: 1.1, // Hz. Lower = steadier when still (more smoothing), higher = more responsive
  beta: 3.0, // how fast the cutoff opens up with speed. Higher = less lag while turning
  derivCutoff: 1.0, // Hz, smoothing of the speed estimate
  lookaheadS: 0.5, // how far ahead (seconds) to predict the head: detection delay + reaction time
  maxLeadFraction: 1.2, // the prediction never jumps ahead by more than this fraction of the target window
  stillSpeed: 0.3, // while the head moves faster than this (units per second) the hold-still count does not advance
  minSpeed: 0.18, // pose units per second below which the head counts as still (no prediction; filtered noise at rest is ~0.1)
  movingFrames: 2, // the head must keep moving the same way for this many frames before the guide reacts to its speed
  nearFraction: 0.6, // remaining distance (as a share of the window width) above which it is "far"
  touchFraction: 0.15, // overshoot (share of the window width) below which it is just "a touch back"
  textMinMs: 450, // a message stays at least this long before a different one replaces it
  arrowSwitchDeg: 35, // the arrow turns to another direction only when the wanted direction is this far off
  axisDominance: 0.3, // an axis whose error is below this share of the other one is ignored for the arrow
  brakeStrength: 0.15, // arrow strength while the student should slow down / stop
  gapResetMs: 700, // no usable pose for this long (face lost, other face, bad light): forget the filter state, so old numbers cannot make the first frames after the gap look like fast movement
};

// The display pose (the gauge dot). Much lighter smoothing than GUIDE_TUNING; the look-ahead covers one detection round.
export const DISPLAY_TUNING = {
  minCutoff: 8, // Hz: almost no smoothing while still (jitter is small next to the gauge's width)
  beta: 20, // opens up fast with speed, so there is almost no lag while turning
  derivCutoff: 4, // Hz, smoothing of the speed estimate
  leadMs: 90, // look-ahead: roughly the time from the camera frame to the dot being drawn
  maxLead: 0.05, // never ahead by more than this many pose units (about a sixth of the narrowest yaw window)
  minSpeed: 0.1, // below this (units per second) there is no look-ahead: it would only add jitter
};

// ---------- One-Euro filter ----------
const alphaFor = (cutoff, dt) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };

export function createOneEuro({ minCutoff, beta, derivCutoff }) {
  let x = null;
  let dx = 0;
  let last = 0;
  return {
    reset() { x = null; dx = 0; },
    // value at time t (ms). Returns { value, speed } (speed in units per second)
    next(value, t) {
      if (x === null) { x = value; dx = 0; last = t; return { value: x, speed: 0 }; }
      const dt = Math.min(Math.max((t - last) / 1000, 0.01), 0.5);
      last = t;
      const rawSpeed = (value - x) / dt;
      dx += alphaFor(derivCutoff, dt) * (rawSpeed - dx);
      const cutoff = minCutoff + beta * Math.abs(dx);
      x += alphaFor(cutoff, dt) * (value - x);
      return { value: x, speed: dx };
    },
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const STEP = Math.PI / 4;

// Which axis (yaw or pitch) is the student being coached on, in "progress" terms: p grows towards the target.
// s = +1 when the shot wants a positive value (turn left / chin down), -1 when it wants a negative one.
function axisState(window, value, speed, run, tuning) {
  const [lo, hi] = window;
  const directional = lo > 0 || hi < 0;
  if (!directional) return null; // a "straight" pose: the general coach handles "turn a little back"
  const s = lo > 0 ? 1 : -1;
  const pLo = s > 0 ? lo : -hi;
  const pHi = s > 0 ? hi : -lo;
  const W = pHi - pLo;
  const p = s * value;
  const v = s * (run >= tuning.movingFrames ? speed : 0); // a speed seen in one frame only is probably noise
  const lead = Math.abs(v) < tuning.minSpeed ? 0 : clamp(v * tuning.lookaheadS, -W * tuning.maxLeadFraction, W * tuning.maxLeadFraction);
  return { s, pLo, pHi, W, p, v, pred: p + lead };
}

// Wording per axis. These name a direction, so the page only reads them to screen readers (see `directional`).
const WORDS = {
  yawLeft: { far: 'Turn more to the left', near: 'A little more left' },
  yawRight: { far: 'Turn more to the right', near: 'A little more right' },
  down: { far: 'Chin down more', near: 'A little lower', back: 'Too low, lift your chin a little' },
  up: { far: 'Raise the phone more', near: 'A little higher', back: 'Too high, lower it a little' },
};
// These name no direction, so they stay on screen.
const SLOW = 'Slowly… almost there';
const STOP = 'Stop there';
const GOOD = 'Good, stay there';
const TOUCH = 'Just a touch back';
const TOO_FAR = 'Too far, turn back a little';
const say = (tone, text, directional) => ({ tone, text, directional });

function graded(kind, a, tuning) {
  // kind: 'yawLeft' | 'yawRight' | 'down' | 'up'
  const words = WORDS[kind];
  if (a.p < a.pLo) { // not enough yet
    const remaining = a.pLo - a.p;
    if (a.v > tuning.minSpeed && a.pred > a.pHi) return say('stop', STOP, false); // moving, and about to fly past
    if (a.v > tuning.minSpeed && a.pred >= a.pLo) return say('slow', SLOW, false); // moving, and about to arrive
    return say('little', remaining > tuning.nearFraction * a.W ? words.far : words.near, true);
  }
  if (a.p > a.pHi) { // past the window
    const over = a.p - a.pHi;
    if (a.v < -tuning.minSpeed && a.pred <= a.pHi) return say('slow', GOOD, false); // already coming back
    if (over < tuning.touchFraction * a.W) return say('much', kind.startsWith('yaw') ? TOUCH : words.back, true);
    return say('much', kind.startsWith('yaw') ? TOO_FAR : words.back, true);
  }
  return null;
}

export function createPoseGuide(tuning = GUIDE_TUNING, display = DISPLAY_TUNING) {
  const fYaw = createOneEuro(tuning);
  const fPitch = createOneEuro(tuning);
  const dYaw = createOneEuro(display);
  const dPitch = createOneEuro(display);
  let arrow = null; // current quantized direction (radians) or null
  let text = '';
  let tone = '';
  let directional = false;
  let textSince = 0;
  let runYaw = { dir: 0, n: 0 }; // how many frames in a row the head has moved the same way (yaw / pitch)
  let runPitch = { dir: 0, n: 0 };
  let lastT = null; // time of the last frame that had a usable pose

  const reset = () => { runYaw = { dir: 0, n: 0 }; runPitch = { dir: 0, n: 0 }; fYaw.reset(); fPitch.reset(); dYaw.reset(); dPitch.reset(); arrow = null; text = ''; tone = ''; directional = false; textSince = 0; lastT = null; };

  // Smooth one frame. Returns a pose like estimatePose() but with filtered yaw/pitch, plus speeds.
  function filter(pose, t) {
    if (!pose) return null;
    if (lastT !== null && t - lastT > tuning.gapResetMs) { // the filter's dt is capped at 0.5 s, so a long gap would otherwise leave stale state behind
      fYaw.reset(); fPitch.reset(); dYaw.reset(); dPitch.reset(); runYaw = { dir: 0, n: 0 }; runPitch = { dir: 0, n: 0 };
    }
    lastT = t;
    const y = fYaw.next(pose.yaw, t);
    const p = fPitch.next(pose.pitch, t);
    const track = (run, speed) => (Math.abs(speed) > tuning.minSpeed && (run.dir === 0 || Math.sign(speed) === run.dir) ? { dir: Math.sign(speed), n: run.n + 1 } : { dir: 0, n: 0 });
    runYaw = track(runYaw, y.speed);
    runPitch = track(runPitch, p.speed);
    // the display pose: light smoothing, plus a short look-ahead from its own speed
    const lead = (f, limit) => (Math.abs(f.speed) < display.minSpeed ? 0 : clamp((f.speed * display.leadMs) / 1000, -limit, limit));
    const dy = dYaw.next(pose.yaw, t);
    const dp = dPitch.next(pose.pitch, t);
    const shown = { yaw: dy.value + lead(dy, display.maxLead), pitch: dp.value + lead(dp, display.maxLead) };
    return { ...pose, yaw: y.value, pitch: p.value, yawSpeed: y.speed, pitchSpeed: p.speed, yawRun: runYaw.n, pitchRun: runPitch.n, shown };
  }

  function quantize(need) {
    if (!need) { arrow = null; return null; }
    let { dx, dy } = need;
    if (Math.abs(dy) < tuning.axisDominance * Math.abs(dx)) dy = 0;
    if (Math.abs(dx) < tuning.axisDominance * Math.abs(dy)) dx = 0;
    const wanted = Math.atan2(dy, dx);
    const diff = a => { let d = (wanted - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d); };
    if (arrow === null || diff(arrow) > (tuning.arrowSwitchDeg * Math.PI) / 180) arrow = Math.round(wanted / STEP) * STEP;
    return { dx: Math.cos(arrow) * need.strength, dy: Math.sin(arrow) * need.strength, strength: need.strength };
  }

  // shot, raw pose from estimatePose(), baseline {pitch}|null, t = performance.now()
  // -> { pose, check, need, meters, text, tone, moving }  (text/tone are null when the pose is right;
  //    moving = inside the window but the head is still moving, so "hold still" should not count yet)
  function step(shot, rawPose, baseline, t) {
    const pose = filter(rawPose, t);
    const check = checkPose(shot, pose, baseline);
    if (!pose || check.ok) {
      arrow = null;
      if (check.ok) { text = ''; tone = ''; }
      const moving = !!pose && (pose.yawRun >= tuning.movingFrames || pose.pitchRun >= tuning.movingFrames) && Math.max(Math.abs(pose.yawSpeed), Math.abs(pose.pitchSpeed)) > tuning.stillSpeed; // inside the window but still moving
      return { pose, check, need: null, meters: null, text: null, tone: null, directional: false, moving };
    }

    const general = poseCoach(shot, pose, baseline); // the original coach: also covers "straight" poses and the first photo
    const meters = poseMeters(shot, { ...pose, ...pose.shown }, baseline); // the gauge follows the display pose
    let result = general ? { text: general.text, tone: general.tone, directional: general.directional } : { text: check.hint, tone: 'off', directional: true };

    // Replace "a bit more" / "too far" with the graded, speed-aware wording of the axis that is further off.
    if (meters && general && (general.tone === 'little' || general.tone === 'much')) {
      const yawA = axisState(shot.yaw, pose.yaw, pose.yawSpeed, pose.yawRun, tuning);
      const pitchA = baseline ? axisState(shot.dPitch, pose.pitch - baseline.pitch, pose.pitchSpeed, pose.pitchRun, tuning) : null;
      const miss = (a) => (a ? (a.p < a.pLo ? (a.pLo - a.p) : a.p > a.pHi ? (a.p - a.pHi) : 0) / a.W : 0);
      const useYaw = yawA && (!pitchA || miss(yawA) >= miss(pitchA));
      const axis = useYaw ? yawA : pitchA;
      if (axis) {
        const kind = useYaw ? (shot.yaw[0] > 0 ? 'yawLeft' : 'yawRight') : (shot.dPitch[0] > 0 ? 'down' : 'up');
        result = graded(kind, axis, tuning) ?? result;
      }
    }

    // arrow: steady direction; calm (weak) while the student should slow down or stop
    let need = quantize(poseGuidance(shot, pose, baseline));
    if (need && (result.tone === 'stop' || result.tone === 'slow')) {
      const k = tuning.brakeStrength / Math.max(need.strength, 1e-6);
      if (k < 1) need = { dx: need.dx * k, dy: need.dy * k, strength: tuning.brakeStrength };
    }

    // a message stays long enough to be read; a stop/slow message may cut in at once
    const urgent = result.tone === 'stop' || result.tone === 'slow';
    if (result.text !== text && (urgent || textSince === 0 || t - textSince >= tuning.textMinMs)) { text = result.text; tone = result.tone; directional = result.directional; textSince = t; }
    return { pose, check, need, meters, text, tone, directional, moving: false };
  }

  return { step, reset, filter };
}
