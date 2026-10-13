// A rough guess of how strong this device is, so heavy things can be turned down on a weak phone and left alone
// on a laptop. Only a starting point: the guide also measures itself and steps down if it is slow (guide-renderer.js).

let cached = null;

// 'low' | 'high'
export function deviceTier() {
  if (cached) return cached;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 4; // GB, Chrome only; other browsers report nothing
  const phone = matchMedia?.('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 700;
  cached = cores <= 4 || memory <= 3 || phone ? 'low' : 'high';
  return cached;
}

// The camera size to ask for. The saved photos are at most 960 px on the long side, so a phone gains nothing from
// decoding a 1920 px preview 30 times a second.
export function cameraSize() {
  return deviceTier() === 'low' ? { width: 1280, height: 960 } : { width: 1920, height: 1440 };
}
