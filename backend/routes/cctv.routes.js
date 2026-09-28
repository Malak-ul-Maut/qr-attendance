import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../utils/db.js';
import { getIO } from '../utils/socket-io.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RECOGNIZE_SCRIPT =
  process.env.CCTV_RECOGNIZE_SCRIPT ||
  path.resolve(__dirname, '../recognize.py');
const TEST_CLIP =
  process.env.CCTV_TEST_CLIP || path.resolve(__dirname, '../f310.avi');
const ANNOTATED_DIR =
  process.env.CCTV_ANNOTATED_DIR || path.resolve(__dirname, '../results');
const RECOGNIZE_TIMEOUT_MS = Number(
  process.env.CCTV_RECOGNIZE_TIMEOUT_MS || 60_000,
);

// Run the current CCTV recognizer against the selected class.
router.post('/run', async (req, res) => {
  const { sessionCode } = req.body;

  if (!sessionCode) {
    return res.status(400).json({ ok: false, error: 'missing_session_code' });
  }

  try {
    // A CCTV session must represent exactly one camera.
    const context = await getSessionContext(sessionCode);
    if (!context) {
      return res.status(404).json({ ok: false, error: 'session_not_found' });
    }

    const allStudents = await getStudentsForRoom(context.room_id);

    if (allStudents.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: 'class_has_no_students' });
    }

    const roster = allStudents.map(student => ({
      student_id: student.id,
      name: student.name,
      gallery_folder: `${student.id}_${student.username}_${student.roll_number}`,
    }));

    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'cctv-attendance-'),
    );
    const rosterPath = path.join(tempDir, 'roster.json');
    const resultPath = path.join(tempDir, 'result.json');
    const annotatedPath = path.join(ANNOTATED_DIR, `${sessionCode}.jpg`);

    await fs.writeFile(rosterPath, JSON.stringify(roster, null, 2), 'utf8');

    // Stable per room: everyone sharing a room shares one cache, whatever period it is.
    const cacheKey = `${context.block}_${context.room_number}`;

    const args = [
      RECOGNIZE_SCRIPT,
      '--video',
      TEST_CLIP,
      '--students-json',
      rosterPath,
      '--class-id',
      cacheKey,
      '--json-out',
      resultPath,
      '--annotated-out',
      annotatedPath,
    ];

    const result = await runPython(args, RECOGNIZE_TIMEOUT_MS);
    console.log(result);
    const output = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    console.log(output);

    const present = output.present_students || [];

    await fs.rm(tempDir, { recursive: true, force: true });

    return res.json({
      ok: true,
      sessionCode,
      timetableId: context.timetable_id,
      presentStudents: present,
      students: allStudents.map(student => ({
        id: student.id,
        name: student.name,
      })),
      annotatedImage: output.annotated_image || null,
      python: {
        stdout: result.stdout,
        stderr: result.stderr,
      },
    });
  } catch (error) {
    console.error('CCTV attendance failed:', error);
    return res.status(500).json({
      ok: false,
      error: 'cctv_processing_failed',
      message: error.message,
    });
  }
});

function getSessionContext(sessionCode) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT
        sessions.id AS session_id,
        sessions.timetable_id,
        timetable.room_id,
        rooms.block,
        rooms.room_number
      FROM sessions
      JOIN timetable ON timetable.id = sessions.timetable_id
      JOIN rooms on rooms.id = timetable.room_id
      WHERE sessions.session_code = ?
      LIMIT 1
      `,
      [sessionCode],
      (err, row) => (err ? reject(err) : resolve(row)),
    );
  });
}

// Everyone whose class shares this room (classes.room_id) - covers a solo class and a combined
// lecture the same way, since a solo class is just a room with one class in it.
function getStudentsForRoom(roomId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        students.id,
        students.roll_number,
        students.class_id,
        users.username,
        users.name
      FROM students
      JOIN classes ON classes.id = students.class_id
      JOIN users ON users.id = students.user_id
      WHERE classes.room_id = ?
      ORDER BY students.class_id, students.id
      `,
      [roomId],
      (err, rows) => (err ? reject(err) : resolve(rows)),
    );
  });
}

function runPython(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const python = process.env.CCTV_PYTHON || 'python';
    const child = spawn(python, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Without this, a hung recognize.py (a stuck camera read, a slow first-time model
    // download) leaves the HTTP request open indefinitely.
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : null;

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`recognize.py timed out after ${timeoutMs}ms`));
      }
      if (code !== 0) {
        return reject(
          new Error(
            `recognize.py exited with code ${code}: ${stderr || stdout}`,
          ),
        );
      }
      resolve({ stdout, stderr });
    });
  });
}

export default router;
