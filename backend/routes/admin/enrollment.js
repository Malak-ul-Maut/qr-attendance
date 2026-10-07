import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbAll, dbRun } from '../../utils/db.js';
import { galleryFolderName } from '../../utils/gallery.js';
import { wrap } from './common.js';

const router = express.Router();
const GALLERY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../gallery');

function photoCount(student) {
  try {
    return fs.readdirSync(path.join(GALLERY_DIR, galleryFolderName(student))).length;
  } catch {
    return 0;
  }
}

// Active students with their class and whether a face template exists.
router.get('/', wrap(async (req, res) => {
  const rows = await dbAll(`
    SELECT s.id, s.name, s.username, s.roll_number, (s.face_embedding IS NOT NULL) AS enrolled,
           sm.class_id AS classId, c.academic_session AS session,
           CASE WHEN c.id IS NULL THEN '' ELSE b.abbr || ' ' || c.semester || c.section END AS classLabel
    FROM students s
    LEFT JOIN students_mapping sm ON sm.id = (
      SELECT sm2.id FROM students_mapping sm2 JOIN classes c2 ON c2.id = sm2.class_id
      WHERE sm2.student_id = s.id
      ORDER BY c2.academic_session DESC, c2.semester DESC, sm2.id DESC LIMIT 1)
    LEFT JOIN classes c ON c.id = sm.class_id
    LEFT JOIN branches b ON b.id = c.branch_id
    WHERE s.active = 1
    ORDER BY s.name`);
  const students = rows.map(r => ({
    ...r,
    enrolled: Boolean(r.enrolled),
    photos: photoCount({ id: r.id, username: r.username, roll_number: r.roll_number }),
  }));
  res.json({ ok: true, students });
}));

// Clears the face template so the student has to upload photos again.
router.post('/:id/reset', wrap(async (req, res) => {
  await dbRun(`UPDATE students SET face_embedding = NULL WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
}));

export default router;
