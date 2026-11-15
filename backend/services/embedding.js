// face_embedding is a BLOB holding the descriptor as little-endian float32 numbers
// (512 numbers = 2048 bytes). The app sends and receives plain number arrays.
export function encodeEmbedding(descriptor) {
  let values = descriptor;
  if (typeof values === 'string') {
    try {
      values = JSON.parse(values);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(values) || values.length === 0) return null;
  const numbers = values.map(Number);
  if (numbers.some(value => !Number.isFinite(value))) return null;
  const buffer = Buffer.alloc(numbers.length * 4);
  numbers.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

export function decodeEmbedding(raw) {
  const buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.length);
  const values = [];
  for (let offset = 0; offset + 4 <= buffer.length; offset += 4) {
    values.push(buffer.readFloatLE(offset));
  }
  return values;
}
