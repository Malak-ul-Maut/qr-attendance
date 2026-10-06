// Folder name of a student's face photos inside backend/gallery.
// roll_number can be NULL now, so the last part is left out in that case.
export function safePathPart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function galleryFolderName({ id, username, roll_number: rollNumber }) {
  const parts = [id, safePathPart(username)];
  if (rollNumber) parts.push(safePathPart(rollNumber));
  return parts.join('_');
}
