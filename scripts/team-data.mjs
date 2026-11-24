// Moves the team's private data (database, face gallery, CCTV test clips) between a private Google Drive folder
// and this project, without ever putting it in git.
//
//   npm run team-data                 download the Drive folder (needs rclone) and install it into the project
//   npm run team-data -- pull         only download the Drive folder into ./team-data
//   npm run team-data -- install      only copy ./team-data into the project (use this after downloading the folder by hand)
//   npm run team-data -- bundle       owner: build ./team-data from the data on this machine
//   npm run team-data -- push         owner: upload ./team-data to the Drive folder
//
// Options:  --force          replace the local database and overwrite local gallery files / clips
//           --from <folder>  install from another folder, for example a Google Drive for desktop folder
//           --keep-cameras   bundle: keep the CCTV camera addresses (they contain a login; removed by default)
//
// Settings (.env):  TEAM_DATA_REMOTE      rclone remote, for example gdrive:
//                   TEAM_DATA_FOLDER_ID   id of the shared Drive folder (the last part of its web address)
//                   TEAM_DATA_DIR         where the downloaded copy lives, default ./team-data
//
// The folder in Drive has this layout, and `bundle` produces exactly this:
//   database.db   a single-file snapshot of the database
//   gallery/      face photos, one folder per student ("<id>_<first name>_<roll number>")
//   clips/        CCTV test videos
// The gallery folders are named after student ids, so the gallery only matches the database it was bundled with.
// Always bundle and install them together.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import sqlite3 from 'sqlite3';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'backend');
const LIVE_DB = path.join(BACKEND, 'db', 'database.db');
const VIDEO_FILE = /\.(avi|mp4|mkv|mov)$/i;

// Settings: the real environment wins over .env, the same order the server uses.
let fileEnv = {};
try {
  fileEnv = parseEnv(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
} catch {
  /* no .env yet: defaults apply */
}
const setting = name => process.env[name] ?? fileEnv[name] ?? '';

// Same lookup the server uses for gallery and clip paths (see resolveAssetPath in routes/cctv.js).
function resolveAssetPath(value, defaultRelative) {
  if (value && path.isAbsolute(value)) return value;
  const relative = value || defaultRelative;
  const fromBackend = path.resolve(BACKEND, relative);
  if (fs.existsSync(fromBackend)) return fromBackend;
  const fromRoot = path.resolve(ROOT, relative);
  if (fs.existsSync(fromRoot)) return fromRoot;
  return /^\.?[\\/]*backend[\\/]/i.test(relative) ? fromRoot : fromBackend;
}

const galleryDirs = [
  ...new Set([
    resolveAssetPath(setting('GALLERY_DIR'), 'data/gallery'),
    resolveAssetPath(setting('CCTV_GALLERY_DIR'), 'data/gallery'),
  ]),
];
const clipsDir = path.dirname(resolveAssetPath(setting('CCTV_TEST_CLIP'), 'recognition/f310.avi'));
const teamDir = path.resolve(ROOT, setting('TEAM_DATA_DIR') || 'team-data');

const args = process.argv.slice(2);
const command = args.find(a => !a.startsWith('--')) || 'all';
const force = args.includes('--force');
const keepCameras = args.includes('--keep-cameras');
const fromIndex = args.indexOf('--from');
const installSource = fromIndex >= 0 && args[fromIndex + 1] ? path.resolve(args[fromIndex + 1]) : teamDir;

const commands = {
  all: async () => {
    if (setting('TEAM_DATA_REMOTE')) pull();
    else console.log('TEAM_DATA_REMOTE is not set, so nothing was downloaded. Installing what is already in', rel(installSource));
    install();
  },
  pull: async () => pull(),
  install: async () => install(),
  bundle: async () => bundle(),
  push: async () => push(),
};
if (!commands[command]) fail(`Unknown command "${command}". Use: pull, install, bundle or push (or nothing, to pull and install).`);
await commands[command]();

// ---------------------------------------------------------------------------------------------------------------

function rcloneArgs(verb, from, to) {
  const folderId = setting('TEAM_DATA_FOLDER_ID');
  // "copy" never deletes anything on either side. --checksum compares Drive's MD5 so unchanged files are skipped.
  return [verb, from, to, '--checksum', '--progress', ...(folderId ? ['--drive-root-folder-id', folderId] : [])];
}

function runRclone(rcloneCommandArgs) {
  try {
    execFileSync('rclone', ['version'], { stdio: 'ignore' });
  } catch {
    fail(
      'rclone is not installed (or not on your PATH). It is the tool that signs in to Google Drive and downloads the folder.\n' +
        '  Windows: winget install Rclone.Rclone     macOS: brew install rclone     Linux: sudo apt install rclone\n' +
        'Then run `rclone config` once (see docs/TEAM.md). No rclone? Download the folder from the Drive website, unzip it into\n' +
        `${rel(teamDir)}, and run \`npm run team-data -- install\`.`,
    );
  }
  try {
    execFileSync('rclone', rcloneCommandArgs, { stdio: 'inherit' });
  } catch {
    fail('rclone stopped with an error (see above). Check TEAM_DATA_REMOTE / TEAM_DATA_FOLDER_ID and that your Google account has access to the folder.');
  }
}

function remote() {
  const value = setting('TEAM_DATA_REMOTE');
  if (!value) fail('Set TEAM_DATA_REMOTE in .env to the rclone remote name followed by a colon, for example gdrive:');
  return value;
}

function pull() {
  fs.mkdirSync(teamDir, { recursive: true });
  console.log(`Downloading from ${remote()} to ${rel(teamDir)} ...`);
  runRclone(rcloneArgs('copy', remote(), teamDir));
}

function push() {
  if (!fs.existsSync(teamDir)) fail(`${rel(teamDir)} does not exist. Run \`npm run team-data -- bundle\` first.`);
  console.log(`Uploading ${rel(teamDir)} to ${remote()} ...`);
  runRclone(rcloneArgs('copy', teamDir, remote()));
  console.log('Uploaded. Teammates can now run `npm run team-data`.');
}

function install() {
  if (!fs.existsSync(installSource)) fail(`Nothing to install: ${installSource} does not exist.`);
  const dbSource = path.join(installSource, 'database.db');
  const gallerySource = path.join(installSource, 'gallery');
  const clipsSource = path.join(installSource, 'clips');
  if (![dbSource, gallerySource, clipsSource].some(p => fs.existsSync(p)))
    fail(`${installSource} has no database.db, gallery/ or clips/ folder. If you downloaded a zip from Drive, check that it was unzipped one level up.`);

  if (fs.existsSync(dbSource)) {
    if (fs.existsSync(LIVE_DB) && !force) {
      console.log('database.db: kept your existing one. Use --force to replace it (anything only in your copy is lost).');
    } else {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(LIVE_DB + suffix, { force: true });
      fs.copyFileSync(dbSource, LIVE_DB);
      console.log('database.db: installed.');
    }
  }
  if (fs.existsSync(gallerySource)) {
    for (const target of galleryDirs) {
      const copied = copyMissing(gallerySource, target);
      console.log(`gallery: ${copied} new file(s) copied to ${rel(target)}${force ? ' (overwriting)' : ', existing files left alone'}.`);
    }
  }
  if (fs.existsSync(clipsSource)) {
    const copied = copyMissing(clipsSource, clipsDir);
    console.log(`clips: ${copied} new file(s) copied to ${rel(clipsDir)}.`);
  }
  console.log('Done. Start the server with `npm start`.');
}

// Copies a folder tree and returns how many files were written. Without --force, files that already exist are skipped.
function copyMissing(from, to) {
  let count = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) count += copyMissing(source, target);
    else if (force || !fs.existsSync(target)) {
      fs.copyFileSync(source, target);
      count += 1;
    }
  }
  return count;
}

async function bundle() {
  if (!fs.existsSync(LIVE_DB)) fail('There is no backend/db/database.db on this machine to bundle.');
  fs.rmSync(teamDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(teamDir, 'clips'), { recursive: true });

  // One consistent file, even if the server is running and the database is in WAL mode.
  const dbTarget = path.join(teamDir, 'database.db');
  const source = await open(LIVE_DB, sqlite3.OPEN_READONLY);
  await run(source, 'VACUUM INTO ?', [dbTarget]);
  await close(source);
  if (!keepCameras) {
    const copy = await open(dbTarget, sqlite3.OPEN_READWRITE);
    await run(copy, 'UPDATE rooms SET camera_url = NULL');
    await run(copy, 'VACUUM');
    await close(copy);
  }

  const gallerySource = galleryDirs.find(dir => fs.existsSync(dir));
  let galleryFiles = 0;
  if (gallerySource) galleryFiles = copyAll(gallerySource, path.join(teamDir, 'gallery'));

  let clips = 0;
  if (fs.existsSync(clipsDir)) {
    for (const name of fs.readdirSync(clipsDir).filter(n => VIDEO_FILE.test(n))) {
      fs.copyFileSync(path.join(clipsDir, name), path.join(teamDir, 'clips', name));
      clips += 1;
    }
  }

  fs.writeFileSync(
    path.join(teamDir, 'bundle-info.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), galleryFiles, clips, cameraAddressesIncluded: keepCameras }, null, 2) + '\n',
  );
  console.log(`Bundled into ${rel(teamDir)}: database.db, ${galleryFiles} gallery file(s), ${clips} clip(s).`);
  console.log(keepCameras ? 'Camera addresses (with logins) are INCLUDED.' : 'Camera addresses were removed from the copy.');
  console.log('Upload that folder to Drive by hand, or run `npm run team-data -- push`.');
}

function copyAll(from, to) {
  let count = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) count += copyAll(source, target);
    else {
      fs.copyFileSync(source, target);
      count += 1;
    }
  }
  return count;
}

function rel(p) {
  return path.relative(ROOT, p) || '.';
}
function fail(message) {
  console.error(message);
  process.exit(1);
}
function open(file, mode) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, mode, err => (err ? reject(err) : resolve(db)));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, err => (err ? reject(err) : resolve())));
}
function close(db) {
  return new Promise((resolve, reject) => db.close(err => (err ? reject(err) : resolve())));
}
