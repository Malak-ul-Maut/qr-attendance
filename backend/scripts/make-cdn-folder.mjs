// Makes ../../cdn-assets: the three big face-engine files, in the folder layout the pages expect.
//   node scripts/make-cdn-folder.mjs
// Push that folder's contents to a PUBLIC GitHub repo, tag it v1, and jsDelivr serves it:
//   https://cdn.jsdelivr.net/gh/<user>/<repo>@v1/utils/models/det_500m.onnx
// Then build with --assets=https://cdn.jsdelivr.net/gh/<user>/<repo>@v1
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'cdn-assets');
const FILES = ['utils/ort/ort-wasm-simd-threaded.wasm', 'utils/models/det_500m.onnx', 'utils/models/w600k_mbf.onnx'];
fs.rmSync(OUT, { recursive: true, force: true });
for (const f of FILES) {
  fs.mkdirSync(path.dirname(path.join(OUT, f)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'frontend', f), path.join(OUT, f));
  console.log(`  ${f}  ${(fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(1)} MB`);
}
console.log('Made cdn-assets/. jsDelivr serves GitHub files up to 20 MB each; the largest here is under that.');
