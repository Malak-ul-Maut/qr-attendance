// The on-camera guide for the enrolment poses (see guide-renderer.js for what it looks like).
//
// This file is the page side. It puts a canvas over the preview and hands the drawing to a Web Worker
// (OffscreenCanvas), so the animation stays smooth while the main thread is busy with the camera. If the browser
// cannot do that (no OffscreenCanvas, no module workers, or the worker fails), the same renderer runs on the page.
//
//   const guide = createTurnGuide(wrapper);
//   guide.update({ face, video, state, need, fraction });   // state 'guide' | 'ok'
//   guide.hide();  guide.destroy();
import { createRenderer } from './guide-renderer.js';
import { deviceTier } from './perf.js';

const WORKER_READY_MS = 4000; // no 'ready' from the worker by then: use the page instead

export function createTurnGuide(wrapper, { debug = false } = {}) {
  const reduced = !!matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const maxDpr = deviceTier() === 'low' ? 1.25 : 2;
  let canvas = null;
  let worker = null;
  let local = null;
  let lastTarget = null;
  let lastState = '';
  let readyTimer = 0;
  let stats = null;

  const size = () => {
    const rect = wrapper.getBoundingClientRect();
    return { cssW: rect.width || 320, cssH: rect.height || 240, dpr: window.devicePixelRatio || 1 };
  };

  function newCanvas() {
    canvas?.remove();
    canvas = document.createElement('canvas');
    canvas.className = 'turn-guide';
    canvas.setAttribute('aria-hidden', 'true');
    wrapper.append(canvas);
  }

  function mountLocal() {
    clearTimeout(readyTimer);
    worker?.terminate();
    worker = null;
    newCanvas(); // a canvas that was handed to a worker cannot be drawn on here, so use a fresh one
    local = createRenderer(canvas, { reduced, maxDpr, onStats: debug ? s => { stats = { ...s, where: 'page' }; } : null });
    const { cssW, cssH, dpr } = size();
    local.resize(cssW, cssH, dpr);
    if (lastTarget) local.setTarget(lastTarget);
  }

  function mountWorker() {
    newCanvas();
    try {
      if (typeof OffscreenCanvas === 'undefined' || typeof canvas.transferControlToOffscreen !== 'function' || typeof Worker === 'undefined') throw new Error('no OffscreenCanvas');
      const offscreen = canvas.transferControlToOffscreen();
      worker = new Worker(new URL('./guide.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') clearTimeout(readyTimer);
        else if (data.type === 'stats') stats = { ...data, where: 'worker' };
        else if (data.type === 'error') { console.warn('[guide] worker error, drawing on the page instead:', data.message); mountLocal(); }
      };
      worker.onerror = () => mountLocal(); // the script did not load or crashed
      readyTimer = setTimeout(mountLocal, WORKER_READY_MS);
      const { cssW, cssH, dpr } = size();
      worker.postMessage({ type: 'init', canvas: offscreen, cssW, cssH, dpr, reduced, maxDpr, debug }, [offscreen]);
    } catch {
      mountLocal();
    }
  }

  const send = message => { if (worker) worker.postMessage(message); };

  // Keep the drawing size right when the window turns, resizes or the picture changes size.
  let resizeQueued = false;
  const onResize = () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      const { cssW, cssH, dpr } = size();
      if (worker) send({ type: 'resize', cssW, cssH, dpr }); else local?.resize(cssW, cssH, dpr);
    });
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  observer?.observe(wrapper);
  window.addEventListener('orientationchange', onResize);

  // A hidden tab gets no frames anyway; stop the animation loop so it costs nothing.
  const onVisibility = () => { if (worker) send({ type: 'paused', paused: document.hidden }); else local?.setPaused(document.hidden); };
  document.addEventListener('visibilitychange', onVisibility);

  mountWorker();

  return {
    update({ face, video, state, need = null, fraction = 0 }) {
      if (!video.videoWidth || !video.videoHeight) return;
      const { x1, y1, x2, y2 } = face.box;
      const target = { type: 'target', box: { x1, y1, x2, y2 }, vw: video.videoWidth, vh: video.videoHeight, state, need, fraction };
      lastTarget = target;
      if (worker) worker.postMessage(target); else local?.setTarget(target);
      if (state === 'ok' && lastState !== 'ok') navigator.vibrate?.(10); // a small tap: "that's the pose" (not available in a worker)
      lastState = state === 'ok' ? 'ok' : 'guide';
    },
    hide() {
      lastTarget = null;
      lastState = '';
      if (worker) send({ type: 'hide' }); else local?.hide();
    },
    // For checking performance: { avgDrawMs, avgFrameMs, tier, where } once the debug option is on.
    get stats() { return stats; },
    get runsInWorker() { return !!worker; },
    destroy() {
      clearTimeout(readyTimer);
      observer?.disconnect();
      window.removeEventListener('orientationchange', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      worker?.terminate();
      local?.stop();
      canvas?.remove();
    },
  };
}
