// Downloads the heavy files that are not kept in the repo (see assets.manifest.json at the repo root).
//
//   npm run assets                      the face-engine files for the browser pages + the CCTV models
//   npm run assets -- --scope=frontend  only one group (frontend | backend | all)
//   npm run assets -- --check           only report what is missing or wrong; download nothing
//   npm run assets -- --update-hashes   after you add a file by hand: record its size and sha256 in the manifest
//   npm run assets -- --all             also the optional files
//
// frontend files go to ../frontend/<path> (the source/dev pages serve them from there), backend files to
// ../backend/models/<file>. Already-correct files are skipped, so running this again is cheap.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = path.join(ROOT, 'assets.manifest.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const scope = (args.find(a => a.startsWith('--scope=')) || '--scope=all').slice(8);

export const destination = asset =>
  path.join(ROOT, asset.scope === 'frontend' ? 'frontend' : 'backend/models', asset.path);

const sha256 = file =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });

async function state(asset) {
  const file = destination(asset);
  if (!fs.existsSync(file)) return 'missing';
  if (asset.bytes && fs.statSync(file).size !== asset.bytes) return 'wrong size';
  if (asset.sha256 && (await sha256(file)) !== asset.sha256) return 'wrong hash';
  return 'ok';
}

function sourceOf(asset) {
  if (asset.url) return asset.url;
  if (asset.scope === 'frontend') return `${manifest.frontendBaseUrl.replace(/\/+$/, '')}/${asset.path}`;
  return null;
}

async function download(asset, url) {
  const file = destination(asset);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(part));
  const size = fs.statSync(part).size;
  const hash = await sha256(part);
  if ((asset.bytes && size !== asset.bytes) || (asset.sha256 && hash !== asset.sha256)) {
    fs.rmSync(part, { force: true });
    throw new Error(`${asset.path} came down as ${size} bytes / ${hash.slice(0, 12)}…, which is not the file the manifest describes`);
  }
  fs.renameSync(part, file);
  return { size, hash };
}

const wanted = manifest.assets.filter(a => (scope === 'all' || a.scope === scope) && (flag('all') || !a.optional));
let problems = 0;

if (flag('update-hashes')) {
  for (const asset of wanted) {
    const file = destination(asset);
    if (!fs.existsSync(file)) {
      console.log(`skip    ${asset.path} (not on disk)`);
      continue;
    }
    asset.bytes = fs.statSync(file).size;
    asset.sha256 = await sha256(file);
    console.log(`hashed  ${asset.path}  ${asset.bytes} bytes`);
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  process.exit(0);
}

for (const asset of wanted) {
  const status = await state(asset);
  if (status === 'ok') {
    console.log(`ok      ${asset.path}`);
    continue;
  }
  if (flag('check')) {
    console.log(`${status.padEnd(7)} ${asset.path}`);
    problems++;
    continue;
  }
  const url = sourceOf(asset);
  if (!url) {
    console.log(`manual  ${asset.path} (no download address in the manifest)`);
    problems++;
    continue;
  }
  try {
    process.stdout.write(`get     ${asset.path} ... `);
    const { size } = await download(asset, url);
    console.log(`${(size / 1048576).toFixed(1)} MB`);
  } catch (error) {
    console.log(`FAILED  ${error.message}`);
    problems++;
  }
}
process.exit(problems ? 1 : 0);
