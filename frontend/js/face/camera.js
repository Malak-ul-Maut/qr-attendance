// Opens the camera so that it can never hang silently.
//
// Every step has a time limit and a way out:
//   permission prompt  -> waits as long as the person needs, but says what it is waiting for
//   camera granted but no stream -> after a few seconds, tries again with plainer settings
//   stream but no picture -> the same
//   still nothing -> throws a CameraError with a code that errors.js can explain
//
// The <video> element must be VISIBLE while this runs: some browsers do not start playing (or deliver frames
// from) a video that is display:none.

export class CameraError extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code; // 'stalled' | 'no_picture' | the original DOMException name
    this.cause = cause;
  }
}

const GRANTED_STALL_MS = [8000, 6000, 6000]; // per attempt: permission already given, yet getUserMedia has not answered
const PROMPT_WAIT_MS = 90000; // waiting for the person to answer the permission prompt
const FIRST_FRAME_MS = 6000; // stream is open, no picture yet

const wait = ms => new Promise(r => setTimeout(r, ms));

function timeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new CameraError('stalled')), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function permissionState() {
  try { return (await navigator.permissions.query({ name: 'camera' })).state; } catch { return 'unknown'; }
}

function stopStream(stream) {
  stream?.getTracks().forEach(track => track.stop());
}

// Resolves true once the video shows a real picture (videoWidth > 0 and a frame has been decoded).
function firstFrame(video, ms) {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (done) return; done = true; clearTimeout(timer); video.removeEventListener('loadeddata', check); video.removeEventListener('playing', check); resolve(ok); };
    const check = () => { if (video.videoWidth > 0 && video.readyState >= 2) finish(true); };
    const timer = setTimeout(() => finish(video.videoWidth > 0), ms);
    video.addEventListener('loadeddata', check);
    video.addEventListener('playing', check);
    check();
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(check);
  });
}

// facingMode: 'user' (selfie) | 'environment'. Resolves to { stream, track }.
// onWaiting(text) is called when the page should tell the person what it is waiting for.
export async function openCamera(video, { facingMode = 'user', onWaiting = () => {}, ideal = { width: 1280, height: 960 } } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('NotSupportedError');
  const attempts = [
    { video: { facingMode, width: { ideal: ideal.width }, height: { ideal: ideal.height } } },
    { video: { facingMode } },
    { video: true },
  ];
  let lastError = new CameraError('stalled');
  for (let i = 0; i < attempts.length; i++) {
    let stream = null;
    try {
      const state = await permissionState();
      if (state === 'prompt') onWaiting('Allow the camera when your browser asks.');
      const limit = state === 'prompt' ? PROMPT_WAIT_MS : GRANTED_STALL_MS[i];
      const request = navigator.mediaDevices.getUserMedia(attempts[i]);
      let abandoned = false;
      // If the browser answers after we gave up, close that stream, or the camera light stays on for ever.
      request.then(late => { if (abandoned) stopStream(late); }, () => {});
      try {
        stream = await timeout(request, limit);
      } catch (error) {
        abandoned = true;
        throw error;
      }
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      video.play?.().catch(() => {}); // autoplay is also set in the HTML; a rejected play() is not fatal
      if (!(await firstFrame(video, FIRST_FRAME_MS))) throw new CameraError('no_picture');
      return { stream, track: stream.getVideoTracks()[0] };
    } catch (error) {
      lastError = error;
      video.srcObject = null;
      stopStream(stream);
      // These will not get better by retrying with other settings.
      if (['NotAllowedError', 'SecurityError', 'PermissionDeniedError', 'NotFoundError', 'DevicesNotFoundError'].includes(error?.name)) throw error;
      onWaiting('The camera is slow to start. Trying again…');
      await wait(400); // let the OS release the camera before asking again
    }
  }
  throw lastError instanceof CameraError ? lastError : new CameraError('stalled', lastError);
}

// Resolves when the video has a NEW frame to look at. Resolves false if none arrives within ms
// (a frozen camera), so the caller can stop instead of waiting for ever.
export function nextFrame(video, ms = 3000) {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (done) return; done = true; clearTimeout(timer); resolve(ok); };
    const timer = setTimeout(() => finish(false), ms);
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(() => finish(true));
    else requestAnimationFrame(() => finish(true));
  });
}

export function stopCamera(video) {
  stopStream(video.srcObject);
  video.srcObject = null;
}
