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
  const along = (p, axis) =>
    (p.x - eyeMid.x) * axis.x + (p.y - eyeMid.y) * axis.y;
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

// The detector sometimes fires on things that are not faces (a ceiling fan, a lamp). A real face has its
// landmarks in a fixed arrangement: eyes level and apart, nose below the eyes, mouth below the nose.
// Returns true when the five landmarks (and the box around them) are arranged like a face.
//
// `relax` (0..1) loosens the limits for poses where a real face is NOT arranged like a frontal one: a wide
// head turn (the eyes get close together, the box gets narrow) or a deep chin-down (eyes, nose and mouth bunch up
// vertically). 0 = the strict frontal check. A face that is clearly turned (the nose well off the middle of the
// eyes) is relaxed a little automatically, so a turn never needs the shot to say so.
const PLAUSIBLE = {
  //                         strict  fully relaxed
  eyeRatioMin: [0.25, 0.14], // eye distance / box width
  eyeRatioMax: [0.75, 0.8],
  mouthWider: [1.4, 1.9], // mouth width may be this many times the eye distance
  vertMin: [0.2, 0.1], // (mouth - eyes) / box height
  vertMax: [0.75, 0.88],
  roll: [40, 40], // degrees: a turn or a chin-down does not tilt the eye line, so this is never loosened
  aspectMin: [0.5, 0.33], // box width / height
  aspectMax: [1.4, 1.6],
  noseBelowMouth: [0, 0.06], // how far (share of box height) the nose may sit below the mouth line
};
const lerp = (pair, k) => pair[0] + (pair[1] - pair[0]) * k;

export function plausibleFace(face, relax = 0) {
  const [le, re, nose, lm, rm] = face.landmarks;
  const eyeDist = re.x - le.x;
  const boxWidth = face.box.x2 - face.box.x1;
  const boxHeight = face.box.y2 - face.box.y1;
  if (!(eyeDist > 0) || boxWidth <= 0 || boxHeight <= 0) return false;
  const turned = Math.abs(nose.x - (le.x + re.x) / 2) / eyeDist > 0.25;
  const k = Math.min(1, Math.max(relax, turned ? 0.5 : 0));
  const eyeY = (le.y + re.y) / 2;
  const mouthY = (lm.y + rm.y) / 2;
  const mouthWidth = rm.x - lm.x;
  const rollDeg = (Math.abs(Math.atan2(re.y - le.y, re.x - le.x)) * 180) / Math.PI;
  const vertical = (mouthY - eyeY) / boxHeight;
  const aspect = boxWidth / boxHeight;
  return (
    eyeY < nose.y &&
    nose.y < mouthY + lerp(PLAUSIBLE.noseBelowMouth, k) * boxHeight && // top to bottom: eyes, nose, mouth
    eyeDist / boxWidth > lerp(PLAUSIBLE.eyeRatioMin, k) &&
    eyeDist / boxWidth < lerp(PLAUSIBLE.eyeRatioMax, k) &&
    mouthWidth > 0 &&
    mouthWidth < eyeDist * lerp(PLAUSIBLE.mouthWider, k) &&
    vertical > lerp(PLAUSIBLE.vertMin, k) &&
    vertical < lerp(PLAUSIBLE.vertMax, k) &&
    rollDeg < lerp(PLAUSIBLE.roll, k) &&
    aspect > lerp(PLAUSIBLE.aspectMin, k) &&
    aspect < lerp(PLAUSIBLE.aspectMax, k)
  );
}

// Per shot (all optional): `threshold` is the detector's confidence limit (default SHOT_DEFAULTS.threshold) and
// `relax` is passed to plausibleFace(). The wide turns and the deep chin-down are where the detector's confidence
// drops and the five landmarks stop looking like a frontal face, so those three ask for less of both; the plausibility
// check is what keeps a ceiling fan out when the confidence limit is lower. The target angles are unchanged.
export const SHOT_DEFAULTS = { threshold: 0.7, relax: 0 };
export const shotThreshold = shot => shot.threshold ?? SHOT_DEFAULTS.threshold;
export const shotRelax = shot => shot.relax ?? SHOT_DEFAULTS.relax;

// yaw: allowed window of the yaw ratio. dPitch: allowed window of (pitch - the student's own front pitch).
// short: the two-language label shown big on screen (the long `title`/`hint` are kept for the review and for tests).
// Most CCTV faces are seen from slightly above and nearly front-on, so most shots are close to frontal; 'high'
// (phone raised above the eyes, looking up at it) gives the camera's own downward view.
export const SHOTS = [
  {
    id: 'front',
    title: 'Look straight at the camera',
    hint: 'Phone at eye level, light on your face.',
    short: 'Look straight · सीधे देखें',
    yaw: [-0.07, 0.07],
    dPitch: [-0.07, 0.07],
    template: true,
  },
  {
    id: 'left',
    title: 'Turn your head slightly to your left',
    hint: 'About a quarter turn. Keep looking at the screen.',
    short: '← A little left · थोड़ा बाएँ',
    yaw: [0.12, 0.32],
    dPitch: [-0.08, 0.08],
    template: true,
  },
  {
    id: 'right',
    title: 'Turn your head slightly to your right',
    hint: 'About a quarter turn. Keep looking at the screen.',
    short: 'A little right · थोड़ा दाएँ →',
    yaw: [-0.32, -0.12],
    dPitch: [-0.08, 0.08],
    template: true,
  },
  {
    id: 'down',
    title: 'Lower your chin a little',
    hint: 'Like glancing down at your notes.',
    short: '↓ Chin down · ठुड्डी नीचे',
    yaw: [-0.08, 0.08],
    dPitch: [0.06, 0.2],
    template: true,
  },
  {
    id: 'high',
    title: 'Raise the phone above your eyes and look up at it',
    hint: 'Like the classroom camera, which looks down on you. Keep your eyes open.',
    short: '↑ Phone up high · फ़ोन ऊपर',
    yaw: [-0.08, 0.08],
    dPitch: [-0.2, -0.06],
    template: false,
  },
  {
    id: 'down-left',
    title: 'Chin down, and turn slightly to your left',
    hint: 'Like looking at your desk from the right side of the room.',
    short: '↙ Down and left · नीचे + बाएँ',
    yaw: [0.1, 0.3],
    dPitch: [0.06, 0.2],
    template: false,
  },
  {
    id: 'down-right',
    title: 'Chin down, and turn slightly to your right',
    hint: 'Like looking at your desk from the left side of the room.',
    short: 'Down and right · नीचे + दाएँ ↘',
    yaw: [-0.3, -0.1],
    dPitch: [0.06, 0.2],
    template: false,
  },
  {
    id: 'front2',
    title: 'Look straight again, relaxed',
    hint: 'Natural face, one more time.',
    short: 'Straight again · फिर सीधे',
    yaw: [-0.07, 0.07],
    dPitch: [-0.07, 0.07],
    template: true,
  },
  {
    id: 'left-wide',
    title: 'Turn your head well to your left',
    hint: 'Further than before, but you can still see the screen. Skip if it is hard.',
    short: '⇇ Turn more left · और बाएँ',
    yaw: [0.34, 0.55],
    dPitch: [-0.1, 0.1],
    threshold: 0.5,
    relax: 0.8,
  },
  {
    id: 'right-wide',
    title: 'Turn your head well to your right',
    hint: 'Further than before, but you can still see the screen. Skip if it is hard.',
    short: 'Turn more right · और दाएँ ⇉',
    yaw: [-0.55, -0.34],
    dPitch: [-0.1, 0.1],
    threshold: 0.5,
    relax: 0.8,
  },
  {
    id: 'down-deep',
    title: 'Look down at your desk, as if writing',
    hint: 'Chin well down. Your eyes may look half closed, that is fine.',
    short: '⇣ Look at your desk · मेज़ की ओर',
    yaw: [-0.1, 0.1],
    dPitch: [0.2, 0.34],
    threshold: 0.5,
    relax: 0.8,
  },
];
export const GLASSES_OFF_SHOT = {
  id: 'no-glasses',
  title: 'Take your glasses off and look straight',
  hint: 'Just this one photo without them.',
  short: 'Glasses off · चश्मा हटाएँ',
  yaw: [-0.07, 0.07],
  dPitch: [-0.07, 0.07],
  template: true,
};
export const shotsFor = wearsGlasses =>
  wearsGlasses ? [...SHOTS, GLASSES_OFF_SHOT] : SHOTS;

// Sanity range for the very first photo, when the student's own front pitch is not known yet.
const FIRST_PITCH = [0.35, 0.85];

// { ok: true } or { ok: false, hint }. `baseline` is { pitch, roll } measured on the first photo (null before it).
export function checkPose(shot, pose, baseline) {
  if (!pose) return { ok: false, hint: 'Keep your whole face in view.' };
  const [yawMin, yawMax] = shot.yaw;
  const wantsLeft = yawMin > 0;
  const wantsRight = yawMax < 0;

  if (pose.yaw < yawMin) {
    if (wantsLeft)
      return { ok: false, hint: 'Turn a little more to your left.' };
    if (wantsRight)
      return {
        ok: false,
        hint: 'Turned too far. Turn back a little to your left.',
      };
    return {
      ok: false,
      hint: 'Turn a little to your right, to face the camera.',
    };
  }
  if (pose.yaw > yawMax) {
    if (wantsRight)
      return { ok: false, hint: 'Turn a little more to your right.' };
    if (wantsLeft)
      return {
        ok: false,
        hint: 'Turned too far. Turn back a little to your right.',
      };
    return {
      ok: false,
      hint: 'Turn a little to your left, to face the camera.',
    };
  }

  if (baseline === null) {
    if (pose.pitch < FIRST_PITCH[0] || pose.pitch > FIRST_PITCH[1])
      return {
        ok: false,
        hint: 'Hold the phone at eye level and look straight at it.',
      };
    return { ok: true };
  }
  const d = pose.pitch - baseline.pitch;
  const [pMin, pMax] = shot.dPitch;
  const wantsDown = pMin > 0;
  const wantsUp = pMax < 0;
  if (d < pMin)
    return {
      ok: false,
      hint: wantsDown
        ? 'Lower your chin a little more.'
        : wantsUp
          ? 'Not that high. Lower the phone a little.'
          : 'Lower your chin a little, to look straight.',
    };
  if (d > pMax)
    return {
      ok: false,
      hint: wantsDown
        ? 'Not that far. Raise your chin a little.'
        : wantsUp
          ? 'Raise the phone a little higher and look up at it.'
          : 'Raise your chin a little, to look straight.',
    };
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

// Which way the student must move their head, in IMAGE coordinates (x to the image's right, y down), so the
// on-screen guide can point the right way. The overlay is mirrored by CSS exactly like the video, so a vector
// given here points the correct way on the student's screen without any flipping.
//   dx: -1..1  (+ = nose has to move towards the image's right, i.e. turn to THEIR left)
//   dy: -1..1  (+ = nose has to move down, i.e. lower the chin)
//   strength: 0..1, how far off they are (0 = inside the window)
// Returns null when there is nothing to say (no pose, or already inside the window).
const GUIDE_YAW_SPAN = 0.22; // yaw error that counts as "far"
const GUIDE_PITCH_SPAN = 0.14; // pitch error that counts as "far"
export function poseGuidance(shot, pose, baseline) {
  if (!pose) return null;
  const toWindow = (value, [min, max]) =>
    value < min ? min - value : value > max ? max - value : 0;
  const yawNeed = toWindow(pose.yaw, shot.yaw);
  const pitchNeed = baseline
    ? toWindow(pose.pitch - baseline.pitch, shot.dPitch)
    : toWindow(pose.pitch, FIRST_PITCH);
  const dx = Math.max(-1, Math.min(1, yawNeed / GUIDE_YAW_SPAN));
  const dy = Math.max(-1, Math.min(1, pitchNeed / GUIDE_PITCH_SPAN));
  const strength = Math.min(1, Math.hypot(dx, dy));
  if (strength === 0) return null;
  return { dx, dy, strength };
}

// How far the head has turned, as a small gauge per axis, so the student sees "how much", not just "which way".
// Each axis is { pos, from, to, status } on a 0..1 scale where [from, to] is the target band (always in the middle
// third, so the band is easy to hit) and pos is where the head is now (it can go a little outside 0..1).
//   status: 'ok'     inside the band
//           'little' not turned enough yet
//           'much'   turned past the band
//           'off'    this pose is "straight" (or the first photo) and the head is to one side of it
// pos grows towards the image's right for yaw and downwards for pitch, like poseGuidance, so on the mirrored
// preview the dot moves the way the head moves.
// An axis is null when it has nothing to say: the pose is "straight" on that axis and the head is straight.
function meterAxis(value, [lo, hi], directional) {
  const width = Math.max(hi - lo, 0.1);
  const min = lo - 1.2 * width;
  const span = hi + 1.2 * width - min;
  let status = 'ok';
  if (value < lo || value > hi) {
    if (!directional || (lo <= 0 && hi >= 0))
      status = 'off'; // a "straight" pose: being to either side is simply off
    else if (lo > 0)
      status = value < lo ? 'little' : 'much'; // the pose is on the positive side: below the band is not enough
    else status = value > hi ? 'little' : 'much'; // the pose is on the negative side: above the band is not enough
  }
  const wantsOffCentre = directional && (lo > 0 || hi < 0);
  if (status === 'ok' && !wantsOffCentre) return null;
  return {
    pos: (value - min) / span,
    from: (lo - min) / span,
    to: (hi - min) / span,
    status,
  };
}

export function poseMeters(shot, pose, baseline) {
  if (!pose) return null;
  const yaw = meterAxis(pose.yaw, shot.yaw, true);
  const pitch = baseline
    ? meterAxis(pose.pitch - baseline.pitch, shot.dPitch, true)
    : meterAxis(pose.pitch, FIRST_PITCH, false); // the first photo has no "straight" yet, only a sane range
  return { yaw, pitch };
}

// One short, kind sentence saying how much to move.
// { text, tone, directional } where tone is 'little' | 'much' | 'off'. `directional` is true when the sentence names a
// direction (left, right, chin, higher...): the page does not print those (the arrow and the gauge already show the
// way) and only reads them out to screen readers. Null when the pose is right or there is no pose.
export function poseCoach(shot, pose, baseline) {
  const meters = poseMeters(shot, pose, baseline);
  if (!meters) return null;
  // how far each axis is from the middle of its band, so the axis that is further off is the one to talk about
  const miss = axis =>
    axis && axis.status !== 'ok'
      ? Math.abs(axis.pos - (axis.from + axis.to) / 2)
      : 0;
  const yawMiss = miss(meters.yaw);
  const pitchMiss = miss(meters.pitch);
  if (yawMiss === 0 && pitchMiss === 0) return null;
  const say = (tone, text, directional = true) => ({ tone, text, directional });

  if (yawMiss >= pitchMiss) {
    const { status } = meters.yaw;
    const left = shot.yaw[0] > 0;
    if (status === 'little')
      return say('little', left ? 'A bit more to the left' : 'A bit more to the right');
    if (status === 'much') return say('much', 'Too far, turn back a little');
    // a "straight" pose and the head is to one side: which side is it on?
    return say('off', pose.yaw < shot.yaw[0] ? 'Turn a little to your left' : 'Turn a little to your right');
  }
  const { status } = meters.pitch;
  const up = baseline && shot.dPitch[1] < 0; // the "phone up high" pose
  if (!baseline) return say('off', 'Phone at eye level, look straight', false);
  if (status === 'little')
    return say('little', up ? 'Raise the phone a bit more' : 'Chin down a little more');
  if (status === 'much')
    return say('much', up ? 'Too high, lower it a little' : 'Too low, lift your chin a little');
  return say('off', pose.pitch - baseline.pitch < shot.dPitch[0] ? 'Lower your chin a little' : 'Raise your chin a little');
}

// Where the nose should be on screen for this shot: an ellipse (centre x, y, radii rx, ry, tilt angle) in image
// coordinates. The student sees a ring and a dot (their nose) and just moves the dot into the ring - no reading.
export function targetNose(landmarks, shot, baseline) {
  const [le, re, , lm, rm] = landmarks;
  const dx = re.x - le.x;
  const dy = re.y - le.y;
  const eyeDist = Math.hypot(dx, dy);
  const angle = baseline ? baseline.roll : Math.atan2(dy, dx);
  const u = { x: Math.cos(angle), y: Math.sin(angle) };
  const v = { x: -u.y, y: u.x };
  const eyeMid = { x: (le.x + re.x) / 2, y: (le.y + re.y) / 2 };
  const mouthMid = { x: (lm.x + rm.x) / 2, y: (lm.y + rm.y) / 2 };
  const mouthDown =
    (mouthMid.x - eyeMid.x) * v.x + (mouthMid.y - eyeMid.y) * v.y;
  const yawMid = (shot.yaw[0] + shot.yaw[1]) / 2;
  const yawTol = (shot.yaw[1] - shot.yaw[0]) / 2;
  const [lo, hi] = baseline ? shot.dPitch : FIRST_PITCH;
  const pitchMid = (baseline ? baseline.pitch : 0) + (lo + hi) / 2;
  const pitchTol = (hi - lo) / 2;
  return {
    x: eyeMid.x + u.x * yawMid * eyeDist + v.x * pitchMid * mouthDown,
    y: eyeMid.y + u.y * yawMid * eyeDist + v.y * pitchMid * mouthDown,
    rx: Math.max(yawTol * eyeDist, 1),
    ry: Math.max(pitchTol * mouthDown, 1),
    angle,
  };
}
