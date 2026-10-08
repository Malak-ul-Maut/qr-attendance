// Head pose from the five face landmarks, and the list of photos a student takes when enrolling.
// No DOM here, so it can be tested on its own.
//
// Landmarks are [leftEye, rightEye, nose, leftMouth, rightMouth] in image coordinates, "left" meaning
// the left of the IMAGE. The enrolment preview is mirrored like a selfie, so "your left" on screen
// is also your own left.
//
// The numbers are ratios, not degrees, and are rough: they came from a simple 3D face model
// (see tests/student-ui/pose.test.mjs), not from measuring real faces. Tune WINDOWS on real phones.

// rollRef: the eye-line angle (radians) measured on the student's FRONT photo, i.e. how the phone is held.
// Without it (the first photo) the axes follow the eye line itself, which is right for a frontal face.
// With it, the axes stay fixed: when the head is turned AND tilted down, the eye line really does tilt,
// and following it would hide the turn (the simple model in the test showed a turn of 20 degrees with
// the chin down 25 degrees dropping to a ratio near zero).
export function estimatePose(landmarks, rollRef = null) {
  const [le, re, nose, lm, rm] = landmarks;
  const dx = re.x - le.x;
  const dy = re.y - le.y;
  const eyeDist = Math.hypot(dx, dy);
  if (eyeDist < 1e-6) return null;
  const roll = Math.atan2(dy, dx);
  const angle = rollRef === null ? roll : rollRef;
  const u = { x: Math.cos(angle), y: Math.sin(angle) };
  const v = { x: -u.y, y: u.x };
  const eyeMid = { x: (le.x + re.x) / 2, y: (le.y + re.y) / 2 };
  const mouthMid = { x: (lm.x + rm.x) / 2, y: (lm.y + rm.y) / 2 };
  const along = (p, axis) => (p.x - eyeMid.x) * axis.x + (p.y - eyeMid.y) * axis.y;
  const mouthDown = along(mouthMid, v);
  if (mouthDown < 1e-6) return null;
  return {
    roll,
    // + when the nose moves towards the image's right, which is the person turning to THEIR left
    yaw: along(nose, u) / eyeDist,
    // nose position between the eyes (0) and the mouth (1). Chin down makes it larger.
    pitch: along(nose, v) / mouthDown,
  };
}

// yaw: allowed window of the yaw ratio. dPitch: allowed window of (pitch - the student's own front pitch).
export const SHOTS = [
  { id: 'front', title: 'Look straight at the camera', hint: 'Phone at eye level, light on your face.', yaw: [-0.07, 0.07], dPitch: [-0.07, 0.07], template: true },
  { id: 'left', title: 'Turn your head slightly to your left', hint: 'About a quarter turn. Keep looking at the screen.', yaw: [0.12, 0.32], dPitch: [-0.08, 0.08], template: true },
  { id: 'right', title: 'Turn your head slightly to your right', hint: 'About a quarter turn. Keep looking at the screen.', yaw: [-0.32, -0.12], dPitch: [-0.08, 0.08], template: true },
  { id: 'down', title: 'Lower your chin a little', hint: 'Like glancing down at your notes.', yaw: [-0.08, 0.08], dPitch: [0.06, 0.2], template: true },
  { id: 'down-left', title: 'Chin down, and turn slightly to your left', hint: 'Like looking at your desk from the right side of the room.', yaw: [0.1, 0.3], dPitch: [0.06, 0.2], template: false },
  { id: 'down-right', title: 'Chin down, and turn slightly to your right', hint: 'Like looking at your desk from the left side of the room.', yaw: [-0.3, -0.1], dPitch: [0.06, 0.2], template: false },
  { id: 'front2', title: 'Look straight again, relaxed', hint: 'Natural face, one more time.', yaw: [-0.07, 0.07], dPitch: [-0.07, 0.07], template: true },
];
export const GLASSES_OFF_SHOT = { id: 'no-glasses', title: 'Take your glasses off and look straight', hint: 'Just this one photo without them.', yaw: [-0.07, 0.07], dPitch: [-0.07, 0.07], template: true };
export const shotsFor = wearsGlasses => (wearsGlasses ? [...SHOTS, GLASSES_OFF_SHOT] : SHOTS);

// Sanity range for the very first photo, when the student's own front pitch is not known yet.
const FIRST_PITCH = [0.35, 0.85];

// { ok: true } or { ok: false, hint }. `baseline` is { pitch, roll } measured on the first photo (null before it).
export function checkPose(shot, pose, baseline) {
  if (!pose) return { ok: false, hint: 'Keep your whole face in view.' };
  const [yawMin, yawMax] = shot.yaw;
  const wantsLeft = yawMin > 0;
  const wantsRight = yawMax < 0;

  if (pose.yaw < yawMin) {
    if (wantsLeft) return { ok: false, hint: 'Turn a little more to your left.' };
    if (wantsRight) return { ok: false, hint: 'Turned too far. Turn back a little to your left.' };
    return { ok: false, hint: 'Turn a little to your right, to face the camera.' };
  }
  if (pose.yaw > yawMax) {
    if (wantsRight) return { ok: false, hint: 'Turn a little more to your right.' };
    if (wantsLeft) return { ok: false, hint: 'Turned too far. Turn back a little to your right.' };
    return { ok: false, hint: 'Turn a little to your left, to face the camera.' };
  }

  if (baseline === null) {
    if (pose.pitch < FIRST_PITCH[0] || pose.pitch > FIRST_PITCH[1])
      return { ok: false, hint: 'Hold the phone at eye level and look straight at it.' };
    return { ok: true };
  }
  const d = pose.pitch - baseline.pitch;
  const [pMin, pMax] = shot.dPitch;
  const wantsDown = pMin > 0;
  if (d < pMin) return { ok: false, hint: wantsDown ? 'Lower your chin a little more.' : 'Lower your chin a little, to look straight.' };
  if (d > pMax) return { ok: false, hint: wantsDown ? 'Not that far. Raise your chin a little.' : 'Raise your chin a little, to look straight.' };
  return { ok: true };
}

// Mean of unit vectors, scaled back to unit length. Returns a plain array.
export function averageTemplate(vectors) {
  const size = vectors[0].length;
  const sum = new Float64Array(size);
  for (const v of vectors) for (let i = 0; i < size; i++) sum[i] += v[i];
  let norm = 0;
  for (let i = 0; i < size; i++) norm += sum[i] * sum[i];
  norm = Math.sqrt(norm);
  return Array.from(sum, x => x / norm);
}

export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
