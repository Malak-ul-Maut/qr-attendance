// Runs the head-turn guide's drawing and animation on its own thread, on a canvas handed over by the page
// (OffscreenCanvas). The page only sends it small messages; it never waits for a frame to be drawn.
//
// Messages in:  { type:'init', canvas, cssW, cssH, dpr, reduced, maxDpr, debug }
//               { type:'resize', cssW, cssH, dpr }
//               { type:'target', box, vw, vh, state, need, fraction }
//               { type:'captured' }   (the photo was taken: celebrate)
//               { type:'hide' }   { type:'paused', paused }
// Messages out: { type:'ready' }   { type:'stats', ... }   { type:'tier', tier }
import { createRenderer } from './guide-renderer.js';

let renderer = null;

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      renderer = createRenderer(data.canvas, {
        reduced: data.reduced,
        mirrored: data.mirrored,
        maxDpr: data.maxDpr,
        onStats: data.debug ? stats => postMessage({ type: 'stats', ...stats }) : null,
        onTier: tier => postMessage({ type: 'tier', tier }),
      });
      renderer.resize(data.cssW, data.cssH, data.dpr);
      postMessage({ type: 'ready' });
    } else if (!renderer) {
      return;
    } else if (data.type === 'resize') renderer.resize(data.cssW, data.cssH, data.dpr);
    else if (data.type === 'target') renderer.setTarget(data);
    else if (data.type === 'captured') renderer.markCaptured();
    else if (data.type === 'hide') renderer.hide();
    else if (data.type === 'paused') renderer.setPaused(data.paused);
  } catch (error) {
    postMessage({ type: 'error', message: String(error?.message || error) });
  }
};
