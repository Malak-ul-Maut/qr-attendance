// Draws the head-turn guide on a canvas and animates it. No DOM in here, so the same code runs
//   - in a Web Worker, on an OffscreenCanvas (the normal case: the page's main thread can be busy with the camera
//     and the animation still runs at full speed), or
//   - on the page itself, on a normal canvas (fallback for browsers without OffscreenCanvas).
//
// The picture is in VIDEO pixel coordinates (like the face box). The canvas element is flipped by CSS like the
// selfie preview, so a direction in image coordinates (poseGuidance in pose.js) points the right way on screen.
//
// What it draws: the surround dimmed, a ring of ticks round the face (the side to turn towards grows and glows and
// goes from amber to green as the head gets close), a floating arrow badge on the ring, and, once the pose is right,
// the ring filling green while the student holds still, then a tick badge.
//
// Detections arrive about 9 times a second. The renderer eases everything between them, so the guide moves at the
// display's frame rate and never jumps.

const RING_R = 112; // design units; the guide is drawn round a face about 190 units tall, then scaled to the real face
const FACE_UNITS = 190;
const TICK_LEN = 11;
const TAU = Math.PI * 2;
const AMBER = [255, 176, 32];
const GREEN = [52, 209, 122];
const STALE_MS = 1200; // no detection for this long: fade the guide out instead of leaving it stuck on screen

// Quality tiers. The renderer drops to a lighter one by itself when frames take too long (a weak phone).
const TIERS = [
  { ticks: 72, glow: true, ripple: true, resolution: 1 },
  { ticks: 48, glow: true, ripple: false, resolution: 0.8 },
  { ticks: 36, glow: false, ripple: false, resolution: 0.65 },
];

const clamp01 = v => Math.max(0, Math.min(1, v));
const ease = (current, target, dt, tau) => current + (target - current) * (1 - Math.exp(-dt / tau)); // frame-rate independent
const easeOutBack = x => { const c = 1.9; const p = x - 1; return 1 + (c + 1) * p * p * p + c * p * p; };
const angleDiff = (a, b) => Math.abs((((a - b + Math.PI) % TAU) + TAU) % TAU - Math.PI); // shortest distance, 0..PI
const rgb = (t, white, op) => {
  const r = AMBER[0] + (GREEN[0] - AMBER[0]) * t;
  const g = AMBER[1] + (GREEN[1] - AMBER[1]) * t;
  const b = AMBER[2] + (GREEN[2] - AMBER[2]) * t;
  const k = white; // 0 = the amber/green colour, 1 = white
  return `rgba(${Math.round(r + (255 - r) * k)},${Math.round(g + (255 - g) * k)},${Math.round(b + (255 - b) * k)},${op.toFixed(3)})`;
};

// opts: { reduced, maxDpr, onStats(stats)|null, onTier(tier)|null }
export function createRenderer(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const schedule = cb => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(() => cb(performance.now()), 16));
  const cancel = id => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

  let tierIndex = 0;
  let tier = TIERS[0];
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let vw = 0;
  let vh = 0;
  let paused = false;
  let running = false;
  let rafId = 0;
  let lastFrame = 0;
  let lastTargetAt = 0;

  // `cur` is what is on screen, `tgt` is where it is heading.
  const cur = { x: 0, y: 0, scale: 1, angle: 0, alpha: 0, guideMix: 0, badgeR: RING_R + 50, strength: 1, doneAt: -1 };
  const tgt = { visible: false, mode: 'none', x: 0, y: 0, scale: 1, angle: 0, badgeR: RING_R + 50, strength: 1, done: false };
  let ticks = makeTicks(tier.ticks);
  let first = true; // the first placement jumps instead of easing from (0, 0)

  function makeTicks(n) {
    return { n, len: new Float32Array(n).fill(1), op: new Float32Array(n).fill(0.35), col: new Float32Array(n), white: new Float32Array(n).fill(1),
      tLen: new Float32Array(n).fill(1), tOp: new Float32Array(n).fill(0.35), tCol: new Float32Array(n), tWhite: new Float32Array(n).fill(1) };
  }

  // Backing-store size follows how big the picture is on screen (CSS px x devicePixelRatio, capped), not the camera
  // resolution: a phone showing a 360 px wide preview does not need a 1920 px canvas.
  function applySize() {
    if (!cssW || !vw || !vh) return;
    const pixelRatio = Math.min(dpr, opts.maxDpr ?? 2) * tier.resolution;
    const width = Math.max(64, Math.round(cssW * pixelRatio));
    const height = Math.max(64, Math.round((width * vh) / vw));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }

  function setTier(index) {
    tierIndex = index;
    tier = TIERS[index];
    ticks = makeTicks(tier.ticks);
    applySize();
    opts.onTier?.(index);
  }

  function resize(width, height, ratio) {
    cssW = width;
    cssH = height;
    dpr = ratio || 1;
    applySize();
  }

  // t: { box:{x1,y1,x2,y2}, vw, vh, state:'guide'|'ok', need:{dx,dy,strength}|null, fraction }
  function setTarget(t) {
    const now = performance.now();
    lastTargetAt = now;
    if (t.vw !== vw || t.vh !== vh) { vw = t.vw; vh = t.vh; applySize(); }
    const { box } = t;
    tgt.x = (box.x1 + box.x2) / 2;
    tgt.y = (box.y1 + box.y2) / 2;
    tgt.scale = Math.max((box.y2 - box.y1) / FACE_UNITS, 0.2);
    tgt.visible = true;
    const n = ticks.n;
    const ok = t.state === 'ok';
    if (ok) {
      tgt.mode = 'ok';
      const filled = Math.round(clamp01(t.fraction) * n);
      const done = t.fraction >= 1;
      if (done && !tgt.done) cur.doneAt = now;
      tgt.done = done;
      for (let i = 0; i < n; i++) {
        const on = i < filled;
        ticks.tLen[i] = on ? 1.5 : 1;
        ticks.tOp[i] = on ? 1 : 0.35;
        ticks.tCol[i] = 1;
        ticks.tWhite[i] = on ? 0 : 1;
      }
    } else if (t.need) {
      tgt.mode = 'guide';
      tgt.done = false;
      let angle = Math.atan2(t.need.dy, t.need.dx);
      angle += Math.round((tgt.angle - angle) / TAU) * TAU; // the equivalent angle closest to the current one: no long spins
      tgt.angle = angle;
      tgt.strength = t.need.strength;
      const closeness = 1 - t.need.strength; // 0 far .. 1 nearly there
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i / n) * TAU;
        const near = Math.exp(-((angleDiff(a, angle) / 0.5) ** 2)); // 1 on the side to turn towards, fading to 0 around it
        ticks.tLen[i] = 1 + 1.3 * near;
        ticks.tOp[i] = 0.32 + 0.68 * near;
        ticks.tCol[i] = Math.min(1, closeness * 1.4) * near;
        ticks.tWhite[i] = 0;
      }
      // keep the badge inside the picture: near an edge, tuck it in towards the ring
      const pad = 40 * tgt.scale;
      let r = RING_R + 50;
      while (r > RING_R - 6) {
        const px = tgt.x + Math.cos(angle) * r * tgt.scale;
        const py = tgt.y + Math.sin(angle) * r * tgt.scale;
        if (px > pad && px < vw - pad && py > pad && py < vh - pad) break;
        r -= 4;
      }
      tgt.badgeR = r;
    } else {
      tgt.mode = 'none';
    }
    if (first) {
      first = false;
      Object.assign(cur, { x: tgt.x, y: tgt.y, scale: tgt.scale, angle: tgt.angle, badgeR: tgt.badgeR });
      ticks.len.set(ticks.tLen); ticks.op.set(ticks.tOp); ticks.col.set(ticks.tCol); ticks.white.set(ticks.tWhite);
    }
    wake();
  }

  function hide() {
    tgt.visible = false;
    tgt.mode = 'none';
    tgt.done = false;
    first = true;
    wake();
  }

  function setPaused(value) {
    paused = value;
    if (paused) stop(); else wake();
  }

  function wake() {
    if (running || paused) return;
    running = true;
    lastFrame = performance.now();
    rafId = schedule(frame);
  }
  function stop() {
    running = false;
    cancel(rafId);
  }

  // ---- animation ----
  let statFrames = 0;
  let statDraw = 0;
  let statDt = 0;
  let slowWindows = 0;

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
    lastFrame = now;
    if (tgt.visible && performance.now() - lastTargetAt > STALE_MS) tgt.visible = false; // detections stopped
    step(dt);
    const t0 = performance.now();
    draw(now);
    const drawMs = performance.now() - t0;

    // Weak phone? Measure what drawing costs and the real frame gap over ~45 frames; step down a tier if either is bad.
    statFrames++; statDraw += drawMs; statDt += dt * 1000;
    if (statFrames >= 45) {
      const avgDraw = statDraw / statFrames;
      const avgDt = statDt / statFrames;
      slowWindows = avgDraw > 5 || avgDt > 45 ? slowWindows + 1 : 0;
      opts.onStats?.({ at: Date.now(), avgDrawMs: +avgDraw.toFixed(2), avgFrameMs: +avgDt.toFixed(1), tier: tierIndex, frames: statFrames });
      if (slowWindows >= 2 && tierIndex < TIERS.length - 1) { setTier(tierIndex + 1); slowWindows = 0; }
      statFrames = 0; statDraw = 0; statDt = 0;
    }

    const settled = !tgt.visible && cur.alpha < 0.003;
    if (settled) { running = false; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    rafId = schedule(frame);
  }

  function step(dt) {
    const snap = opts.reduced ? 1e-4 : 1; // reduced motion: no easing, just show the state
    const e = (c, t, tau) => ease(c, t, dt, tau * snap);
    cur.x = e(cur.x, tgt.x, 0.07);
    cur.y = e(cur.y, tgt.y, 0.07);
    cur.scale = e(cur.scale, tgt.scale, 0.09);
    cur.angle = e(cur.angle, tgt.angle, 0.1);
    cur.badgeR = e(cur.badgeR, tgt.badgeR, 0.12);
    cur.strength = e(cur.strength, tgt.strength, 0.15);
    cur.alpha = e(cur.alpha, tgt.visible ? 1 : 0, tgt.visible ? 0.1 : 0.16);
    cur.guideMix = e(cur.guideMix, tgt.visible && tgt.mode === 'guide' ? 1 : 0, 0.12);
    for (let i = 0; i < ticks.n; i++) {
      ticks.len[i] = e(ticks.len[i], ticks.tLen[i], 0.1);
      ticks.op[i] = e(ticks.op[i], ticks.tOp[i], 0.1);
      ticks.col[i] = e(ticks.col[i], ticks.tCol[i], 0.12);
      ticks.white[i] = e(ticks.white[i], ticks.tWhite[i], 0.08);
    }
  }

  // ---- drawing ----
  function draw(now) {
    const W = canvas.width;
    const H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (cur.alpha < 0.003 || !vw) return;
    const k = W / vw;
    ctx.globalAlpha = cur.alpha;

    // the surround, dimmed: one big rectangle with a round hole on the face
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const hole = (RING_R - 6) * cur.scale;
    ctx.beginPath();
    ctx.rect(0, 0, vw, vh);
    ctx.moveTo(cur.x + hole, cur.y);
    ctx.arc(cur.x, cur.y, hole, 0, TAU);
    ctx.fillStyle = 'rgba(6,8,12,0.5)';
    ctx.fill('evenodd');

    // everything else in design units, centred on the face
    const s = k * cur.scale;
    ctx.setTransform(s, 0, 0, s, k * cur.x, k * cur.y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const n = ticks.n;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * TAU;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const len = TICK_LEN * ticks.len[i];
      const x0 = cos * RING_R;
      const y0 = sin * RING_R;
      const x1 = cos * (RING_R + len);
      const y1 = sin * (RING_R + len);
      if (tier.glow && ticks.len[i] > 1.25) { // a wider, faint stroke under the tick looks like a glow and is far cheaper than a blur
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        ctx.lineWidth = 11; ctx.strokeStyle = rgb(ticks.col[i], ticks.white[i], ticks.op[i] * 0.22); ctx.stroke();
      }
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      ctx.lineWidth = 4.5; ctx.strokeStyle = rgb(ticks.col[i], ticks.white[i], ticks.op[i]); ctx.stroke();
    }

    if (cur.guideMix > 0.01) drawBadge(now);
    if (tgt.done || (cur.doneAt >= 0 && tgt.mode === 'ok')) drawDone(now);
    ctx.globalAlpha = 1;
  }

  function drawBadge(now) {
    const dur = 1.5 - 0.6 * cur.strength; // far: quick pulse. close: slow and gentle
    const phase = ((now / 1000) / dur) % 1;
    const wave = opts.reduced ? 0.5 : 0.5 - 0.5 * Math.cos(phase * TAU);
    ctx.save();
    ctx.globalAlpha = cur.alpha * cur.guideMix * (0.6 + 0.4 * cur.strength);
    ctx.rotate(cur.angle);
    ctx.translate(cur.badgeR + (opts.reduced ? 0 : -4 + 14 * wave), 0);
    if (tier.ripple && !opts.reduced) {
      ctx.beginPath(); ctx.arc(0, 0, 28 * (1 + 0.7 * phase), 0, TAU);
      ctx.lineWidth = 3; ctx.strokeStyle = `rgba(255,176,32,${(0.8 * (1 - phase)).toFixed(3)})`; ctx.stroke();
    }
    if (tier.glow) { ctx.beginPath(); ctx.arc(0, 0, 31, 0, TAU); ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(255,176,32,0.25)'; ctx.stroke(); }
    ctx.beginPath(); ctx.arc(0, 0, 29, 0, TAU);
    ctx.fillStyle = 'rgba(16,18,24,0.78)'; ctx.fill();
    ctx.lineWidth = 3.5; ctx.strokeStyle = '#ffb020'; ctx.stroke();
    for (const [x, delay] of [[-7, 0], [7, 0.18]]) {
      const w = opts.reduced ? 1 : 0.35 + 0.65 * (0.5 - 0.5 * Math.cos((((phase - delay) % 1) + 1) % 1 * TAU));
      ctx.beginPath(); ctx.moveTo(x - 5, -9); ctx.lineTo(x + 4, 0); ctx.lineTo(x - 5, 9);
      ctx.lineWidth = 4.5; ctx.strokeStyle = `rgba(255,255,255,${w.toFixed(3)})`; ctx.stroke();
    }
    ctx.restore();
  }

  function drawDone(now) {
    const progress = clamp01((now - cur.doneAt) / 350);
    const pop = tgt.done ? (cur.doneAt < 0 ? 1 : easeOutBack(progress)) : 0;
    if (pop <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = cur.alpha * clamp01(pop);
    ctx.translate(0, RING_R + 6);
    ctx.scale(pop, pop);
    if (tier.glow) { ctx.beginPath(); ctx.arc(0, 0, 30, 0, TAU); ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(52,209,122,0.3)'; ctx.stroke(); }
    ctx.beginPath(); ctx.arc(0, 0, 27, 0, TAU);
    ctx.fillStyle = '#2f9e44'; ctx.fill();
    ctx.lineWidth = 3.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-11, 1); ctx.lineTo(-3, 10); ctx.lineTo(12, -9);
    ctx.lineWidth = 6; ctx.stroke();
    ctx.restore();
  }

  return { setTarget, hide, resize, setPaused, stop, getTier: () => tierIndex };
}
