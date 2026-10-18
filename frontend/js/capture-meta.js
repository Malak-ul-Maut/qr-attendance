// What is saved next to every enrolment photo, so the server-side analysis (scripts/bakeoff.py) can split results by
// pose, lighting, face size and device WITHOUT asking anyone to enrol again. No DOM here, so it can be tested alone.

// Brightness statistics of a face region. `rgba` is ImageData.data (w*h*4 bytes) of a small crop of the face.
//   mean, std : overall brightness 0..255 and its spread (flat light = low std)
//   lr        : (left half - right half) / mean, in IMAGE terms. Near 0 = even; |lr| > 0.25 = clearly lit from one side
//   tb        : (top half - bottom half) / mean. Positive = lit from above (ceiling light)
//   clipped / crushed : share of pixels nearly white (>245) / nearly black (<10)
export function lumaStats(rgba, w, h) {
  const n = w * h;
  if (!n || rgba.length < n * 4) return null;
  let sum = 0,
    sumSq = 0,
    left = 0,
    right = 0,
    top = 0,
    bottom = 0,
    clipped = 0,
    crushed = 0;
  let nLeft = 0,
    nRight = 0,
    nTop = 0,
    nBottom = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      sum += l;
      sumSq += l * l;
      if (x < w / 2) {
        left += l;
        nLeft++;
      } else {
        right += l;
        nRight++;
      }
      if (y < h / 2) {
        top += l;
        nTop++;
      } else {
        bottom += l;
        nBottom++;
      }
      if (l > 245) clipped++;
      if (l < 10) crushed++;
    }
  }
  const mean = sum / n;
  const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
  const safe = mean > 1 ? mean : 1;
  return {
    mean: round(mean, 1),
    std: round(Math.sqrt(Math.max(0, sumSq / n - mean * mean)), 1),
    lr: round((left / Math.max(nLeft, 1) - right / Math.max(nRight, 1)) / safe),
    tb: round((top / Math.max(nTop, 1) - bottom / Math.max(nBottom, 1)) / safe),
    clipped: round(clipped / n),
    crushed: round(crushed / n),
  };
}

const norm = (v, size) => Math.round((v / size) * 10000) / 10000;

// The metadata object for one saved photo. `candidate` is what the capture loop remembered about the frame:
// { sharpness, light, facePx, pose, landmarks:[{x,y}x5], box:{x1,y1,x2,y2}, video:{w,h}, luma }.
// Coordinates are stored as fractions of the camera frame (0..1), so they do not depend on the saved image size.
export function buildPhotoMeta({
  shot,
  rank,
  candidate,
  now = new Date(),
  userAgent = '',
}) {
  const { video, pose } = candidate;
  const meta = {
    shot: shot.id,
    rank,
    sharpness: candidate.sharpness,
    yaw: pose.yaw,
    pitch: pose.pitch,
    roll: pose.roll,
    light: candidate.light,
    facePx: candidate.facePx,
    optional: !!shot.optional,
    lighting: shot.lighting ?? null,
    luma: candidate.luma ?? null,
    mirrored: false, // the saved picture is the raw camera frame, not the mirrored preview
    capturedAt: now.toISOString(),
    ua: String(userAgent).slice(0, 120),
  };
  if (video && video.w > 0 && video.h > 0) {
    meta.video = [video.w, video.h];
    if (candidate.landmarks?.length === 5)
      meta.landmarks = candidate.landmarks.map(p => [
        norm(p.x, video.w),
        norm(p.y, video.h),
      ]);
    if (candidate.box)
      meta.box = [
        norm(candidate.box.x1, video.w),
        norm(candidate.box.y1, video.h),
        norm(candidate.box.x2, video.w),
        norm(candidate.box.y2, video.h),
      ];
  }
  return meta;
}
