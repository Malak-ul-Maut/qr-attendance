// Simulation: a student turns towards the "left" pose while the pose estimate is noisy and delayed.
// Compares the old raw guidance with the new filtered, speed-aware guidance. Not a real-phone test.
import { checkPose, poseCoach, poseGuidance, SHOTS } from '../frontend/js/pose.js';
import { createPoseGuide, GUIDE_TUNING } from '../frontend/js/pose-guide.js';
const OVR = process.env.TUNE ? JSON.parse(process.env.TUNE) : {};

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

const SIGMA_YAW = +process.env.SIGMA || 0.02, SIGMA_PITCH = 0.015;
const DT = 0.11, DETECT_LAG = 0.12, REACT = 0.35, STABLE = 4, GRACE = 2;

function run(mode, shotId, topSpeed) {
  const shot = SHOTS.find(s => s.id === shotId);
  const baseline = { pitch: 0.5 };
  const guide = createPoseGuide({ ...GUIDE_TUNING, ...OVR });
  const sign = shot.yaw[0] > 0 ? 1 : -1;
  let y = 0, pitchTrue = 0.5, t = 0, speed = 0;
  const cmds = []; // [applyAt, speed]
  const hist = [];
  let stable = 0, misses = 0, textChanges = 0, lastText = '', arrowFlips = 0, lastArrow = null, maxOver = 0;
  let overshootFrames = 0;
  while (t < 20) {
    t += DT;
    while (cmds.length && cmds[0][0] <= t) speed = cmds.shift()[1];
    y += speed * DT;
    hist.push(y);
    const seen = hist[Math.max(0, hist.length - 1 - Math.round(DETECT_LAG / DT))];
    const raw = { yaw: seen + gauss() * SIGMA_YAW, pitch: pitchTrue + gauss() * SIGMA_PITCH, roll: 0 };
    let check, text, tone, need, movingNow = false;
    if (mode === 'old') {
      check = checkPose(shot, raw, baseline);
      const c = poseCoach(shot, raw, baseline); text = c?.text; tone = c?.tone; need = poseGuidance(shot, raw, baseline);
    } else {
      const r = guide.step(shot, raw, baseline, t * 1000);
      check = r.check; text = r.text; tone = r.tone; need = r.need; movingNow = r.moving;
    }
    if (check.ok && movingNow) { misses = 0; } else if (check.ok) { stable++; misses = 0; } else if (++misses > GRACE || stable === 0) stable = 0;
    if (text && text !== lastText) textChanges++;
    if (text) lastText = text;
    const dir = need ? Math.sign(Math.round(need.dx * 100)) + ',' + Math.sign(Math.round(need.dy * 100)) : null;
    if (dir && lastArrow && dir !== lastArrow) arrowFlips++;
    if (dir) lastArrow = dir;
    const over = sign * y - Math.abs(sign > 0 ? shot.yaw[1] : shot.yaw[0]);
    if (over > 0) { maxOver = Math.max(maxOver, over); overshootFrames++; }
    if (stable >= STABLE) {
      const trueOk = sign * y >= (sign > 0 ? shot.yaw[0] : -shot.yaw[1]) && sign * y <= (sign > 0 ? shot.yaw[1] : -shot.yaw[0]);
      return { done: true, t, textChanges, arrowFlips, maxOver, overshootFrames, trueOk, y: sign * y };
    }
    // the student reacts to what they read
    let target = 0;
    if (check.ok) target = 0;
    else if (tone === 'little') target = topSpeed * (/more to the|और .* घूमें|Turn more/.test(text || '') || mode === 'old' ? 1 : 0.7);
    else if (tone === 'slow') target = /Good/.test(text) ? 0 : topSpeed * 0.3;
    else if (tone === 'stop') target = 0;
    else if (tone === 'much') target = /touch/.test(text || '') ? -topSpeed * 0.3 : -topSpeed * 0.6;
    else target = topSpeed * 0.5;
    cmds.push([t + REACT, sign * target]);
  }
  return { done: false, t, textChanges, arrowFlips, maxOver, overshootFrames, trueOk: false, y: sign * y };
}

for (const shotId of ['left', 'right']) {
  for (const topSpeed of [0.2, 0.35, 0.6]) {
    const out = {};
    for (const mode of ['old', 'new']) {
      seed = 999;
      const runs = Array.from({ length: 300 }, () => run(mode, shotId, topSpeed));
      const avg = k => runs.reduce((a, r) => a + (+r[k] || 0), 0) / runs.length;
      out[mode] = {
        done: (100 * runs.filter(r => r.done).length / runs.length).toFixed(0) + '%',
        sec: avg('t').toFixed(1),
        msgChanges: avg('textChanges').toFixed(1),
        arrowFlips: avg('arrowFlips').toFixed(1),
        overshoot_pct: (100 * runs.filter(r => r.overshootFrames > 0).length / runs.length).toFixed(0) + '%',
        meanOver: avg('maxOver').toFixed(3),
        trueInWindow: (100 * runs.filter(r => r.trueOk).length / runs.length).toFixed(0) + '%',
      };
    }
    console.log(`${shotId} @ speed ${topSpeed}/s`); console.table(out);
  }
}
