import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Where every student's face photos live: one folder per student.
export const GALLERY_DIR =
  process.env.GALLERY_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../gallery');

// Photos the student took in the app (self_1.jpg ...), crops saved from confirmed CCTV scans
// (cctv_<time>_<n>.png), and anything else an admin put in the folder (an I-Card photo, photos taken by hand).
export const SELF_PHOTO = /^self_\d+\.(jpg|png|webp)$/;
export const CCTV_CROP = /^cctv_.+\.png$/i;
export const IMAGE_FILE = /\.(jpe?g|png|webp|bmp)$/i;

// Folder name of a student's face photos inside backend/gallery.
// roll_number can be NULL now, so the last part is left out in that case.
export function safePathPart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function galleryFolderName({ id, name, roll_number: rollNumber }) {
  const firstName = String(name || '')
    .split(' ')[0]
    .toLowerCase();

  const cleanFirstName = safePathPart(firstName);
  const cleanRollNumber = safePathPart(rollNumber || '');

  return `${id}_${cleanFirstName}_${cleanRollNumber}`;
}

export function galleryFolderPath(student) {
  return path.join(GALLERY_DIR, galleryFolderName(student));
}

// Names of the image files in the student's folder (empty when there is no folder).
export function listGalleryImages(student) {
  try {
    return fs.readdirSync(galleryFolderPath(student)).filter(name => IMAGE_FILE.test(name));
  } catch {
    return [];
  }
}

// Photos an admin put in the student's folder by hand (taken in person, from the I-Card ...): any image that is
// neither one the student took in the app (self_*) nor a CCTV crop. Such a student counts as enrolled for the CCTV
// camera without using the app. Saved CCTV crops never count on their own, because they are only ever added to a
// student who had photos to begin with; app photos do not count because they need the admin's approval first.
export function hasGalleryPhotos(student) {
  return listGalleryImages(student).some(name => !CCTV_CROP.test(name) && !SELF_PHOTO.test(name));
}

// Is this student looked for in CCTV footage? Approved app photos: yes. No app submission (or a rejected one) but
// hand-added photos in the folder: yes. A submission still waiting for review: no.
export function isEligibleForCctv(faceStatus, student) {
  if (faceStatus === 'approved') return true;
  return (!faceStatus || faceStatus === 'rejected') && hasGalleryPhotos(student);
}

// ---- saved CCTV crops: which ones to keep ----
// A crop's file name carries its picture score (face width in pixels x sharpness of the aligned crop; higher = more
// real detail), e.g. cctv_1760000000000_ab12_q12345.png = score 1234.5. Crops without it (older ones) count as 0,
// so they are the first to be replaced. Quality is used rather than similarity: it says how good the picture is
// without caring who it resembles, so the gallery cannot drift towards "more of the same".
export function cropQuality(name) {
  const match = /_q(\d+)\.png$/i.exec(name);
  return match ? Number(match[1]) / 10 : 0;
}

export function cropFileName(quality, now = Date.now(), suffix = '') {
  const tenths = Number.isFinite(quality) ? Math.max(0, Math.round(quality * 10)) : 0;
  return `cctv_${now}_${suffix}_q${tenths}.png`;
}

// existing: the cctv_ file names already in the student's folder. Below the cap the new crop is simply added. At the
// cap it replaces the WORST existing crop, but only if it is better than that one (ties keep the older picture).
// Returns { add: boolean, remove: file name or null }.
export function planCropUpdate(existing, newQuality, cap) {
  if (existing.length < cap) return { add: true, remove: null };
  const worst = existing.reduce((low, name) => (cropQuality(name) < cropQuality(low) ? name : low));
  return newQuality > cropQuality(worst) ? { add: true, remove: worst } : { add: false, remove: null };
}
