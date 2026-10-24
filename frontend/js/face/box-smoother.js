// Smooths the face box that is drawn over the preview, so it glides instead of jumping a few pixels on every
// detection. Only the drawing uses it; the photo checks use the detector's own box. No DOM.
export function createBoxSmoother(alpha = 0.55) {
  let box = null;
  return {
    push(next) {
      box = box
        ? { x1: box.x1 + alpha * (next.x1 - box.x1), y1: box.y1 + alpha * (next.y1 - box.y1), x2: box.x2 + alpha * (next.x2 - box.x2), y2: box.y2 + alpha * (next.y2 - box.y2) }
        : { x1: next.x1, y1: next.y1, x2: next.x2, y2: next.y2 };
      return box;
    },
    get box() { return box; },
    reset() { box = null; },
  };
}
