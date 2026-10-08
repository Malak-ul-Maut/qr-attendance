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
