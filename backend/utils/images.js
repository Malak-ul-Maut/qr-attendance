// Decoding of images sent as data URLs (JPEG, PNG or WebP only, 10 MB each at most).
const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// The first bytes of the file must match the type it claims to be.
function looksLike(mime, b) {
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === 'image/png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (mime === 'image/webp')
    return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

// Returns { buffer, extension } or null.
export function decodeUploadedImage(image) {
  if (!image || typeof image.dataUrl !== 'string') return null;
  const match = image.dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
  if (!looksLike(match[1], buffer)) return null;
  return { buffer, extension: EXTENSIONS[match[1]] };
}
