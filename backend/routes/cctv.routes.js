import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { dbGet, dbRun } from '../utils/db.js';
import { galleryFolderName } from '../utils/gallery.js';
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
// Set CCTV_SPAWN_SERVICE=false if you run `python server.py` yourself (or on another machine).
const SPAWN_SERVICE = process.env.CCTV_SPAWN_SERVICE !== 'false';
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
const ANNOTATED_DIR = path.resolve(
  process.env.CCTV_ANNOTATED_DIR || path.resolve(__dirname, '../results'),
);
// Limit for one /run call, including any time spent waiting in the service's queue.
const RECOGNIZE_TIMEOUT_MS = Number(
  process.env.CCTV_RECOGNIZE_TIMEOUT_MS || 300_000,
);
console.log(
  `[cctv] per-request recognition timeout: ${RECOGNIZE_TIMEOUT_MS} ms`,
);

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
    const context = await getSessionContext(sessionCode);

    const allStudents = await getSessionStudents(sessionCode);

    if (allStudents.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: 'class_has_no_students' });
    }

    const roster = allStudents.map(student => ({
      student_id: student.id,
      name: student.name,
      gallery_folder: galleryFolderName(student),
    }));

    const annotatedPath = path.join(ANNOTATED_DIR, `${sessionCode}.jpg`);

    // Same room + same group of students = same cache. A room whose roster changes between
    // periods (a lab batch, a combined lecture) gets a separate cache for each roster
    // instead of rebuilding one cache over and over.
    const rosterHash = createHash('sha1')
      .update(allStudents.map(student => student.id).join(','))
      .digest('hex')
      .slice(0, 10);
    const cacheKey = context.room_number
      ? `${context.block}_${context.room_number}_${rosterHash}`
      : `timetable${context.timetable_id}_${rosterHash}`;

    // The roster travels inside the request, so there are no temp files to write or clean up.
    const output = await callRecognitionService({
      video: TEST_CLIP,
      roster,
      class_id: cacheKey,
      annotated_out: annotatedPath,
    });

    const present = output.present_students || [];

    // Save who the camera recognised. Faculty can still add or remove people before
    // submitting; finalize applies their final list on top of this.
    await markPresentByCctv(
      sessionCode,
      present.map(record => Number(record.student_id)),
    );

    console.log(
      `[cctv] ${sessionCode}: ${present.length}/${allStudents.length} present, ` +
        `${Date.now() - requestStartedAt} ms total ` +
        `(scan ${Math.round((output.elapsed_seconds || 0) * 1000)} ms, ` +
        `queue wait ${output.queue_wait_ms || 0} ms, stopped: ${output.stop_reason})`,
    );

    return res.json({
      ok: true,
      sessionCode,
      timetableId: context.timetable_id,
      presentStudents: present,
      students: allStudents.map(student => ({
        id: student.id,
        name: student.name,
        roll_number: student.roll_number,
      })),
      annotatedImage: output.annotated_image || null,
      timings: output.timings || null,
      python: {
        stdout: (output.log || []).join('\n'),
        stderr: '',
      },
    });
  } catch (error) {
    console.error('CCTV attendance failed:', error);
    const unavailable = error.code === 'cctv_service_unavailable';
    return res.status(unavailable ? 503 : 500).json({
      ok: false,
      error: unavailable
        ? 'cctv_service_unavailable'
        : 'cctv_processing_failed',
      message: error.message,
    });
  }
});

// First session row of the code, with its room (room can be empty for a one-off period).
function getSessionContext(sessionCode) {
  return dbGet(
    `
    SELECT
      sessions.id AS session_id,
      sessions.timetable_id,
      timetable.room_id,
      rooms.block,
      rooms.number AS room_number
    FROM sessions
    JOIN timetable ON timetable.id = sessions.timetable_id
    LEFT JOIN rooms ON rooms.id = timetable.room_id
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
      AND session_id IN (SELECT id FROM sessions WHERE session_code = ?)
    `,
    [...ids, sessionCode],
  );
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
    response = await fetch(`${SERVICE_URL}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal:
        RECOGNIZE_TIMEOUT_MS > 0
          ? AbortSignal.timeout(RECOGNIZE_TIMEOUT_MS)
          : undefined,
    });
  } catch (error) {
    if (error.name === 'TimeoutError') {
      // The service may still finish this scan in the background; we just stop waiting for it.
      throw new Error(`recognition timed out after ${RECOGNIZE_TIMEOUT_MS} ms`);
    }
    serviceReady = false; // connection refused/reset: it probably died and will be restarted
    throw serviceUnavailable(
      `recognition service is not reachable (${error.message})`,
    );
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `recognition service returned ${response.status}: ${body?.detail ?? response.statusText}`,
    );
  }
  return body;
}

startRecognitionService();

export default router;
