import { poseGuidance, poseCoach, SHOTS } from '../frontend/js/pose.js';
import { createPoseGuide } from '../frontend/js/pose-guide.js';
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const baseline = { pitch: 0.5 };
const rows = {};
for (const [id, yaw, dp] of [['left', 0.08, 0], ['down-left', 0.2, 0.045], ['front', 0.05, 0.03], ['left', 0.10, 0]]) {
  const shot = SHOTS.find(s => s.id === id);
  const old = { dirs: 0, texts: 0 }, nu = { dirs: 0, texts: 0 };
  const g = createPoseGuide(); let lo = null, lt = null, ln = null, lnt = null;
  for (let i = 0; i < 300; i++) { // a student holding nearly still, 33 s
    const raw = { yaw: yaw + gauss() * 0.02, pitch: 0.5 + dp + gauss() * 0.015, roll: 0 };
    const n = poseGuidance(shot, raw, baseline); const a = n ? Math.round(Math.atan2(n.dy, n.dx) / (Math.PI / 4)) : null;
    if (a !== null && lo !== null && a !== lo) old.dirs++; if (a !== null) lo = a;
    const c = poseCoach(shot, raw, baseline)?.text; if (c && lt && c !== lt) old.texts++; if (c) lt = c;
    const r = g.step(shot, raw, baseline, i * 110);
    const a2 = r.need ? Math.round(Math.atan2(r.need.dy, r.need.dx) / (Math.PI / 4)) : null;
    if (a2 !== null && ln !== null && a2 !== ln) nu.dirs++; if (a2 !== null) ln = a2;
    if (r.text && lnt && r.text !== lnt) nu.texts++; if (r.text) lnt = r.text;
  }
  rows[`${id} yaw=${yaw} dPitch=${dp}`] = { old_arrowDirChanges: old.dirs, new_arrowDirChanges: nu.dirs, old_msgChanges: old.texts, new_msgChanges: nu.texts };
}
console.table(rows);
