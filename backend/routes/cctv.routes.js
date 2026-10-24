import express from 'express';
import { spawn } from 'child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomBytes } from 'crypto';
import { dbAll, dbGet, dbRun } from '../utils/db.js';
import {
  CCTV_CROP,
  galleryFolderName,
  galleryFolderPath,
  isEligibleForCctv,
  cropFileName,
  planCropUpdate,
  hasGalleryPhotos,
  safePathPart,
} from '../utils/gallery.js';
import {
  getSessionRows,
  getSessionStudents,
  isSessionEnded,
} from '../utils/timetable.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The face models now live in a long-running Python service (server.py) that is started once,
// together with this Node server, instead of a new recognize.py process per request.
const SERVICE_SCRIPT =
  process.env.CCTV_SERVICE_SCRIPT || path.resolve(__dirname, '../server.py');
const SERVICE_URL = process.env.CCTV_SERVICE_URL || 'http://127.0.0.1:8765';
// Set CCTV_SPAWN_SERVICE=false (or 0) to avoid loading the memory-heavy Python service at Node startup.
const SPAWN_SERVICE = !['false', '0'].includes(
  (process.env.CCTV_SPAWN_SERVICE || '').toLowerCase(),
);
// How long the first request may wait for the service to finish loading its models.
const SERVICE_STARTUP_WAIT_MS = Number(
  process.env.CCTV_SERVICE_STARTUP_WAIT_MS || 120_000,
);
// path.resolve turns a relative value (e.g. CCTV_TEST_CLIP=./backend/f310.avi) into an absolute
// path based on the folder Node was started from. This matters now: the Python service runs from
// the backend folder, so a relative path sent to it would be resolved from the wrong place.
const TEST_CLIP = path.resolve(
  process.env.CCTV_TEST_CLIP || path.resolve(__dirname, '../f310.avi'),
);
// Where the video comes from:
//   'clip' (default) - always the recorded test clip above (the original behaviour)
//   'auto'           - the room's camera_url (an rtsp:// address) when it has one, else the clip
//   'live'           - always the room's camera_url; a room without one is reported as an error
const CCTV_SOURCE = ['clip', 'auto', 'live'].includes(
  (process.env.CCTV_SOURCE || '').toLowerCase(),
)
  ? process.env.CCTV_SOURCE.toLowerCase()
  : 'clip';
const isLiveUrl = value => /^rtsps?:\/\//i.test(String(value || '').trim());

const ANNOTATED_DIR = path.resolve(
  process.env.CCTV_ANNOTATED_DIR || path.resolve(__dirname, '../results'),
);
// Face crops from the scans of a CCTV session wait here (NOT inside the folder that is served to browsers)
// until the faculty submits the session. Only crops of students on the final list join their gallery.
const CROP_STAGING_DIR = path.resolve(
  process.env.CCTV_CROPS_DIR || path.resolve(__dirname, '../crop-staging'),
);
const STAGING_MAX_AGE_MS = 3 * 24 * 3600 * 1000; // sessions that were never submitted are cleaned up after 3 days
const MAX_CCTV_CROPS = Number(process.env.CCTV_MAX_GALLERY_CROPS || 8); // per student; at the cap a better crop replaces the worst
// A crop the camera matched on its own is only saved when the match was this strong. A crop the faculty named by
// hand ("who is this?") is always saved: a person looked at it.
const GROW_MIN_SCORE = Number(process.env.CCTV_GROW_MIN_SCORE || 0.35);
// A crop whose face is narrower than this many pixels (in the full camera frame) is never added: it would be a
// tiny face blown up to 112x112, and such blurry crops make look-alikes score higher against each other.
const MIN_GROW_FACE_PX = Number(process.env.CCTV_GROW_MIN_FACE_PX || 30);
// CCTV_GROW_GALLERY=off stops submitted sessions from adding crops to galleries at all. (Crops already saved in the
// galleries as cctv_*.png keep being used for matching: move them out of the student folders to stop that too.)
const GROW_GALLERY = !['0', 'false', 'off', 'no'].includes(String(process.env.CCTV_GROW_GALLERY || 'on').toLowerCase());
// A crop whose picture score (face width x sharpness) is below this is never added. 0 = off until you have seen the
// numbers: the staging index (crop-staging/<session>/index.dat) lists them.
const GROW_MIN_QUALITY = Number(process.env.CCTV_GROW_MIN_QUALITY || 0);
const CROP_FILE = /^\d{14}_t\d+\.png$/;

// Limit for one /run call, including any time spent waiting in the service's queue.
const RECOGNIZE_TIMEOUT_MS = Number(
  process.env.CCTV_RECOGNIZE_TIMEOUT_MS || 300_000,
);

// Chooses the video for a session (see CCTV_SOURCE). Returns { video, live } or { error }.
function pickVideoSource(context) {
  const clip = { video: TEST_CLIP, live: false };
  if (CCTV_SOURCE === 'clip') return clip;
  const url = String(context.camera_url || '').trim();
  if (!url)
    return CCTV_SOURCE === 'live' ? { error: 'no_camera_configured' } : clip;
  if (!isLiveUrl(url)) {
    return CCTV_SOURCE === 'live' ? { error: 'invalid_camera_url' } : clip;
  }
  return { video: url, live: true };
}

// Opens the session's camera connection ahead of time, so the first "Run attendance" does not
// have to wait for it. Fire and forget: it never fails or delays the caller.
export async function warmSessionCamera(sessionCode) {
  if (CCTV_SOURCE === 'clip') return;
  try {
    const context = await getSessionContext(sessionCode);
    const url = String(context?.camera_url || '').trim();
    if (!isLiveUrl(url)) return;
    await fetch(`${SERVICE_URL}/stream/warm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (error) {
    console.warn(`[cctv] could not warm the camera: ${error.message}`);
  }
}

// Closes the session's camera connection once the session is finalized - unless another CCTV
// session in the same room is still open. Fire and forget, like warmSessionCamera.
export async function releaseSessionCamera(sessionCode) {
  if (CCTV_SOURCE === 'clip') return;
  try {
    const context = await getSessionContext(sessionCode);
    const url = String(context?.camera_url || '').trim();
    if (!context || !isLiveUrl(url)) return;
    const stillOpen = await dbGet(
      `
      SELECT 1 AS open FROM sessions
      WHERE sessions.room_id = ? AND sessions.method = 'cctv'
        AND sessions.end_time IS NULL AND sessions.session_code != ?
      LIMIT 1
      `,
      [context.room_id, sessionCode],
    );
    if (stillOpen) return;
    await fetch(`${SERVICE_URL}/stream/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (error) {
    console.warn(`[cctv] could not release the camera: ${error.message}`);
  }
}

// How long the last few scans took (seconds, as the faculty experienced them, including any wait in the queue).
// The page shows the median as "usually about N s" while a scan runs. Kept in memory: it starts over with the server.
const recentScanSeconds = [];
function rememberScanSeconds(seconds) {
  recentScanSeconds.push(seconds);
  if (recentScanSeconds.length > 10) recentScanSeconds.shift();
}
function typicalScanSeconds() {
  if (recentScanSeconds.length === 0) return null;
  const sorted = [...recentScanSeconds].sort((a, b) => a - b);
  return Math.max(1, Math.round(sorted[Math.floor(sorted.length / 2)]));
}

// How many classes are being scanned right now, and how long a scan usually takes (the page shows both while a scan runs).
router.get('/queue', async (req, res) => {
  const idle = { ok: true, activeScans: 0, waiting: 0, typicalSeconds: typicalScanSeconds() };
  if (!serviceReady) return res.json(idle);
  try {
    const response = await fetch(`${SERVICE_URL}/queue`, {
      signal: AbortSignal.timeout(1500),
    });
    const body = await response.json();
    return res.json({
      ok: true,
      activeScans: body.active_scans || 0,
      waiting: body.waiting_for_models || 0,
      typicalSeconds: typicalScanSeconds(),
    });
  } catch {
    return res.json(idle);
  }
});

// Run the current CCTV recognizer against the selected class.
router.post('/run', async (req, res) => {
  const { sessionCode } = req.body;

  if (!sessionCode) {
    return res.status(400).json({ ok: false, error: 'missing_session_code' });
  }

  const requestStartedAt = Date.now();

  try {
    // A CCTV session represents exactly one camera (one room). Its students are the ones
    // the session was opened for: the linked classes, narrowed by batch.
    const sessionRows = await getSessionRows(sessionCode);
    if (sessionRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'session_not_found' });
    }
    if (isSessionEnded(sessionRows)) {
      return res.status(400).json({ ok: false, error: 'session_ended' });
    }
    if (sessionRows.some(row => row.method !== 'cctv')) {
      return res.status(400).json({ ok: false, error: 'session_method_mismatch' });
    }
    const context = await getSessionContext(sessionCode);

    const source = pickVideoSource(context);
    if (source.error) {
      return res.status(400).json({ ok: false, error: source.error });
    }

    const allStudents = await getSessionStudents(sessionCode);

    if (allStudents.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: 'class_has_no_students' });
    }

    // Searched for: students whose self-enrolled photos an admin approved, and students who never used the app but
    // whose gallery folder already holds photos (taken by hand, from the I-Card ...). Pending and rejected
    // enrolments are left out, and so is anyone with no photos. The rest stay absent until the teacher marks them.
    const statusById = new Map(
      (
        await dbAll(
          `SELECT id, face_status FROM students WHERE id IN (${allStudents.map(() => '?').join(',')})`,
          allStudents.map(student => student.id),
        )
      ).map(row => [row.id, row.face_status]),
    );
    const searchable = allStudents.filter(student => isEligibleForCctv(statusById.get(student.id), student));
    // if (searchable.length === 0) {
    //   return res.status(400).json({ ok: false, error: 'no_approved_photos' });
    // }

    const roster = searchable.map(student => ({
      student_id: student.id,
      name: student.name,
      gallery_folder: galleryFolderName(student),
    }));

    const annotatedPath = path.join(ANNOTATED_DIR, `${sessionCode}.jpg`);

    // Same room + same group of students = same cache. A room whose roster changes between
    // periods (a lab batch, a combined lecture) gets a separate cache for each roster
    // instead of rebuilding one cache over and over.
    const rosterHash = createHash('sha1')
      .update(searchable.map(student => student.id).join(','))
      .digest('hex')
      .slice(0, 10);
    const cacheKey = context.room_number
      ? `${context.block}_${context.room_number}_${rosterHash}`
      : `session${context.session_id}_${rosterHash}`;

    // The roster travels inside the request, so there are no temp files to write or clean up.
    const output = await callRecognitionService({
      video: source.video,
      roster,
      class_id: cacheKey,
      annotated_out: annotatedPath,
      crops_dir: path.join(CROP_STAGING_DIR, safePathPart(sessionCode)),
    });

    // The scan can take minutes. If the faculty submitted meanwhile, the result must not change a closed session.
    if (isSessionEnded(await getSessionRows(sessionCode))) {
      return res.status(400).json({ ok: false, error: 'session_ended' });
    }

    const present = output.present_students || [];
    const faces = output.faces || [];
    await recordScanFaces(sessionCode, faces).catch(error =>
      console.warn(`[cctv] could not remember the face crops: ${error.message}`),
    );

    // Save who the camera recognised. Faculty can still add or remove people before
    // submitting; finalize applies their final list on top of this.
    await markPresentByCctv(
      sessionCode,
      present.map(record => Number(record.student_id)),
    );

    rememberScanSeconds((Date.now() - requestStartedAt) / 1000);
    console.log(
      `[cctv] ${sessionCode}: ${present.length}/${allStudents.length} present, ` +
        `${Date.now() - requestStartedAt} ms total ` +
        `(scan ${Math.round((output.elapsed_seconds || 0) * 1000)} ms, ` +
        `queue wait ${output.queue_wait_ms || 0} ms, ${source.live ? 'live camera' : 'test clip'}, ` +
        `stopped: ${output.stop_reason})`,
    );

    return res.json({
      ok: true,
      sessionCode,
      source: source.live ? 'live' : 'clip',
      stopReason: output.stop_reason || null,
      timetableId: context.timetable_id,
      presentStudents: present,
      students: allStudents.map(student => ({
        id: student.id,
        name: student.name,
        roll_number: student.roll_number,
      })),
      annotatedImage: output.annotated_image || null,
      facesDetected: output.faces_detected ?? null,
      faceCounts: output.face_counts || null,
      timings: output.timings || null,
      python: {
        stdout: (output.log || []).join('\n'),
        stderr: '',
      },
    });
  } catch (error) {
    console.error('CCTV attendance failed:', error);
    const unavailable = error.code === 'cctv_service_unavailable';
    const cameraDown = error.code === 'camera_unreachable';
    return res.status(unavailable ? 503 : cameraDown ? 502 : 500).json({
      ok: false,
      error: unavailable
        ? 'cctv_service_unavailable'
        : cameraDown
          ? 'camera_unreachable'
          : 'cctv_processing_failed',
      message: error.message,
    });
  }
});

// First session row of the code, with the room it is REALLY held in (the faculty can pick a different room than
// the timetable's; an arranged class has no timetable row at all). The room's camera is the one used.
function getSessionContext(sessionCode) {
  return dbGet(
    `
    SELECT
      sessions.id AS session_id,
      sessions.timetable_id,
      sessions.room_id,
      rooms.block,
      rooms.number AS room_number,
      rooms.camera_url
    FROM sessions
    LEFT JOIN rooms ON rooms.id = sessions.room_id
    WHERE sessions.session_code = ?
    ORDER BY sessions.id
    LIMIT 1
    `,
    [sessionCode],
  );
}

// Marks recognised students present with method 'cctv'. Students who are already marked
// are left alone, and ids that are not in this session match nothing.
async function markPresentByCctv(sessionCode, studentIds) {
  const ids = [...new Set(studentIds)].filter(id => Number.isSafeInteger(id));
  if (ids.length === 0) return;
  const marks = ids.map(() => '?').join(', ');
  await dbRun(
    `
    UPDATE attendance
    SET marked_at = datetime('now'), method = 'cctv'
    WHERE marked_at IS NULL
      AND student_id IN (${marks})
      AND session_id IN (SELECT id FROM sessions WHERE session_code = ? AND end_time IS NULL)
    `,
    [...ids, sessionCode],
  );
}

// ---------------------------------------------------------------------------
// Face crops: "who is this?" answers and the gallery that grows from them
// ---------------------------------------------------------------------------
// While a session is open, index.dat in its staging folder remembers every face the scans reported
// ({ faces: { cropFile: { status, student_id, score, width_px, quality } } }).
// When the faculty submits, finalize calls growGalleryFromSession with the final list of present students.

const stagingDirFor = sessionCode => path.join(CROP_STAGING_DIR, safePathPart(sessionCode));

async function readIndex(sessionCode, dir = stagingDirFor(sessionCode)) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'index.dat'), 'utf8'));
    return { faces: parsed.faces || {} };
  } catch {
    return { faces: {} };
  }
}

async function writeIndex(sessionCode, index) {
  const dir = stagingDirFor(sessionCode);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'index.dat');
  await fs.writeFile(`${target}.tmp`, JSON.stringify(index));
  await fs.rename(`${target}.tmp`, target); // swapped in whole, so a crash never leaves half a file
}

// One queue per session, so two quick requests (a scan and a "who is this?") never overwrite each other's changes.
const indexQueues = new Map();
function withIndex(sessionCode, change) {
  const previous = indexQueues.get(sessionCode) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const index = await readIndex(sessionCode);
    const result = await change(index);
    await writeIndex(sessionCode, index);
    return result;
  });
  indexQueues.set(sessionCode, next);
  return next;
}

function recordScanFaces(sessionCode, faces) {
  const saved = faces.filter(face => face.crop_file && CROP_FILE.test(face.crop_file));
  if (saved.length === 0) return Promise.resolve();
  return withIndex(sessionCode, index => {
    for (const face of saved) {
      index.faces[face.crop_file] = {
        status: face.status,
        student_id: face.student_id ?? null,
        score: face.score ?? null,
        width_px: face.width_px ?? null,
        quality: face.crop_score ?? null, // face width x sharpness of the saved crop: higher = a better picture
      };
    }
  });
}

// After the faculty submits a CCTV session: the crops of students who are on the FINAL list (so a person confirmed
// them) are added to those students' galleries, so the next scan has pictures taken by this very camera.
// One crop per student per session: the best picture (highest face width x sharpness). Never throws into
// the caller's request: the attendance is already saved.
export async function growGalleryFromSession(sessionCode, finalStudentIds) {
  // Take the staging folder for ourselves first (after any write in progress), so a second call - a double click on
  // Submit - finds nothing and cannot add a second crop for the same student.
  await (indexQueues.get(sessionCode) || Promise.resolve()).catch(() => {});
  const dir = `${stagingDirFor(sessionCode)}.done-${randomBytes(4).toString('hex')}`;
  try {
    await fs.rename(stagingDirFor(sessionCode), dir);
  } catch {
    return { added: 0 }; // nothing was scanned, or another call already took it
  }
  indexQueues.delete(sessionCode);
  if (!GROW_GALLERY) {
    await fs.rm(dir, { recursive: true, force: true });
    return { added: 0 };
  }
  const index = await readIndex(sessionCode, dir);
  const finalIds = new Set(finalStudentIds.map(Number));
  const best = new Map(); // studentId -> { file, quality }: the clearest crop of this student in this session
  const offer = (studentId, file, quality) => {
    if (quality < GROW_MIN_QUALITY) return;
    const current = best.get(studentId);
    if (!current || quality > current.quality) best.set(studentId, { file, quality });
  };
  for (const [file, face] of Object.entries(index.faces)) {
    const quality = face.quality ?? 0;
    if (face.status === 'matched' && face.student_id && (face.score ?? 0) >= GROW_MIN_SCORE && (face.width_px ?? 99) >= MIN_GROW_FACE_PX) {
      offer(Number(face.student_id), file, quality);
    }
  }
  let added = 0;
  for (const [studentId, { file, quality }] of best) {
    if (!finalIds.has(studentId)) continue; // the faculty took this student off the list
    const student = await dbGet(
      `SELECT id, name, roll_number, face_status FROM students WHERE id = ?`,
      [studentId],
    );
    if (!student || !isEligibleForCctv(student.face_status, student)) continue;
    const folder = galleryFolderPath(student);
    await fs.mkdir(folder, { recursive: true });
    // A new crop is added while there is room. When the student already has the maximum, it replaces the worst
    // one - but only if it scores higher; otherwise the old ones stay.
    const existing = (await fs.readdir(folder)).filter(name => CCTV_CROP.test(name));
    const plan = planCropUpdate(existing, quality, MAX_CCTV_CROPS);
    if (!plan.add) continue;
    // copied under a temporary name, then renamed, so a scan reading the folder never meets a half-written picture
    const finalName = path.join(folder, cropFileName(quality, Date.now(), randomBytes(2).toString('hex')));
    await fs.copyFile(path.join(dir, file), `${finalName}.part`);
    await fs.rename(`${finalName}.part`, finalName);
    if (plan.remove) await fs.rm(path.join(folder, plan.remove), { force: true });
    added++;
  }
  await fs.rm(dir, { recursive: true, force: true });
  if (added) console.log(`[cctv] ${sessionCode}: ${added} confirmed face crop(s) added to galleries`);
  return { added };
}

async function cleanOldStaging() {
  try {
    for (const name of await fs.readdir(CROP_STAGING_DIR)) {
      const full = path.join(CROP_STAGING_DIR, name);
      const stat = await fs.stat(full);
      if (Date.now() - stat.mtimeMs > STAGING_MAX_AGE_MS) await fs.rm(full, { recursive: true, force: true });
    }
  } catch {
    // no staging folder yet: nothing to clean
  }
}
void cleanOldStaging();

// ---------------------------------------------------------------------------
// Enrolment photo check (runs in the Python service with the CCTV models)
// ---------------------------------------------------------------------------
// Checks the photos in a student's gallery folder and saves the report on the student, for the admin who
// approves them. Slow (several seconds), so callers do not wait for it.
export async function refreshEnrolmentQa(student) {
  if (!serviceReady) await waitForService();
  const response = await fetch(`${SERVICE_URL}/enroll/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder: galleryFolderName(student) }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`photo check returned ${response.status}: ${body?.detail ?? response.statusText}`);
  await dbRun(`UPDATE students SET face_qa = ?, face_qa_at = datetime('now') WHERE id = ?`, [
    JSON.stringify(body),
    student.id,
  ]);
  return body;
}

// ---------------------------------------------------------------------------
// Python recognition service (server.py)
// ---------------------------------------------------------------------------

let serviceProcess = null; // the python child we started (null if we did not / it has stopped)
let serviceReady = false; // true once /health has answered; reset if the service goes away
let restartTimer = null;
let shuttingDown = false;

function serviceUnavailable(message) {
  const error = new Error(message);
  error.code = 'cctv_service_unavailable';
  return error;
}

// Forward each line the service prints to our console, tagged so it is easy to spot.
function forwardLines(stream) {
  let unfinished = '';
  stream.on('data', chunk => {
    const lines = (unfinished + chunk.toString()).split(/\r?\n/);
    unfinished = lines.pop(); // the last piece may be a half-written line
    for (const line of lines) {
      if (line) console.log(`[cctv-service] ${line}`);
    }
  });
}

function scheduleRestart() {
  if (shuttingDown || restartTimer) return;
  console.error('[cctv-service] stopped unexpectedly - restarting in 3 s');
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startRecognitionService();
  }, 3000);
}

// Start server.py (models load in the background; requests wait for it via waitForService).
// Called once when this module is loaded, i.e. at Node server startup. Safe to call again.
export function startRecognitionService() {
  if (!SPAWN_SERVICE || serviceProcess) return;

  const python = process.env.CCTV_PYTHON || 'python';
  const child = spawn(python, [SERVICE_SCRIPT], {
    cwd: path.dirname(SERVICE_SCRIPT),
    windowsHide: true,
    env: {
      ...process.env,
      CCTV_SERVICE_PORT: new URL(SERVICE_URL).port || '8765',
      // The service quits by itself when we exit (it watches the pipe on its stdin).
      CCTV_EXIT_WITH_PARENT: '1',
      // Without these, Python holds its output back when it is piped, and logs arrive late.
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    },
  });
  serviceProcess = child;
  console.log(`[cctv-service] starting: ${python} ${SERVICE_SCRIPT}`);

  forwardLines(child.stdout);
  forwardLines(child.stderr);
  child.on('error', error => {
    console.error(`[cctv-service] could not start: ${error.message}`);
    if (serviceProcess === child) serviceProcess = null;
    serviceReady = false;
    scheduleRestart();
  });
  child.on('close', code => {
    console.error(`[cctv-service] exited with code ${code}`);
    if (serviceProcess === child) serviceProcess = null;
    serviceReady = false;
    scheduleRestart();
  });
}

process.once('exit', () => {
  shuttingDown = true;
  if (serviceProcess) serviceProcess.kill();
});

// Poll /health until the models have finished loading (or give up after the startup limit).
async function waitForService() {
  const deadline = Date.now() + SERVICE_STARTUP_WAIT_MS;
  for (;;) {
    try {
      const response = await fetch(`${SERVICE_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        serviceReady = true;
        return;
      }
    } catch {
      // not up yet - keep waiting
    }
    if (Date.now() > deadline) {
      throw serviceUnavailable(
        `recognition service did not become ready within ${SERVICE_STARTUP_WAIT_MS} ms`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function callRecognitionService(payload) {
  if (!serviceReady) await waitForService();

  let response;
  try {
    response = await new Promise((resolve, reject) => {
      let settled = false;
      let timeout = null;
      const finish = callback => value => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback(value);
      };
      const resolveOnce = finish(resolve);
      const rejectOnce = finish(reject);
      const serviceUrl = new URL(`${SERVICE_URL}/run`);
      const requestService =
        serviceUrl.protocol === 'https:' ? httpsRequest : httpRequest;
      // Node fetch has a fixed 300 s headers timeout, shorter than the configurable scan limit.
      const request = requestService(
        serviceUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        serviceResponse => {
          const chunks = [];
          serviceResponse.on('data', chunk => chunks.push(chunk));
          serviceResponse.on('error', rejectOnce);
          serviceResponse.on('end', () => {
            let body = null;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              // Keep the existing behavior for a non-JSON service response.
            }
            resolveOnce({
              ok:
                serviceResponse.statusCode >= 200 &&
                serviceResponse.statusCode < 300,
              status: serviceResponse.statusCode,
              statusText: serviceResponse.statusMessage,
              json: async () => body,
            });
          });
        },
      );
      if (RECOGNIZE_TIMEOUT_MS > 0) {
        timeout = setTimeout(() => {
          const error = new Error(
            `recognition timed out after ${RECOGNIZE_TIMEOUT_MS} ms`,
          );
          error.name = 'TimeoutError';
          request.destroy(error);
        }, RECOGNIZE_TIMEOUT_MS);
      }
      request.on('error', rejectOnce);
      request.end(JSON.stringify(payload));
    });
  } catch (error) {
    if (error.name === 'TimeoutError') {
      // The service may still finish this scan in the background; we just stop waiting for it.
      throw new Error(`recognition timed out after ${RECOGNIZE_TIMEOUT_MS} ms`);
    }
    serviceReady = false; // connection refused/reset: it probably died and will be restarted
    const reason = error.cause?.code || error.cause?.message || error.message; // e.g. ECONNREFUSED, ECONNRESET
    throw serviceUnavailable(`recognition service is not reachable (${reason})`);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = new Error(
      `recognition service returned ${response.status}: ${body?.detail ?? response.statusText}`,
    );
    // 502 = the camera itself could not be reached (offline, wrong login, no frames)
    if (response.status === 502) failure.code = 'camera_unreachable';
    throw failure;
  }
  return body;
}

startRecognitionService();

export default router;
