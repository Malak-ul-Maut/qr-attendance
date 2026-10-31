import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import compression from 'compression';
import https from 'https';
import os from 'os';
import selfsigned from 'selfsigned';
import { fileURLToPath } from 'url';

import hostTunnel from './utils/host-tunnel.js';
import { precompressed, staticHeaders } from './utils/static-fast.js';
import { initializeSocket } from './utils/socket-io.js';
import authRouter from './routes/auth.routes.js';
import sessionRouter from './routes/session.routes.js';
import attendanceRouter from './routes/attendance.routes.js';
import studentRouter from './routes/students.routes.js';
import studentSelfRouter from './routes/student.routes.js';
import facultyRouter from './routes/faculty.routes.js';
import adminRouter from './routes/admin.routes.js';
import cctvRouter from './routes/cctv.routes.js';

// ----------------- Server Config -----------------
const app = express();

// No COOP/COEP headers on purpose. They were only there to give ONNX Runtime several WASM threads, which for the
// face models is slower than one thread (measured), and they make every page and file stricter (a cross-origin
// image, script or frame without a CORP header is blocked). The face models run in a worker, single threaded.
//
// upgrade-insecure-requests: if any page ever asks for an http:// address, the browser asks for https:// instead.
// (Chrome's own automatic upgrade skips hosts that are IP addresses, which is what this server is opened on.)
app.use((req, res, next) => {
  res.set('Content-Security-Policy', 'upgrade-insecure-requests');
  next();
});

// gzip for HTML, JS, CSS, SVG and API JSON. Images and the .onnx models are skipped automatically (already compressed).
// Files that have a ready-made .br next to them are served by precompressed() below instead.
app.use(compression());

app.use(express.json({ limit: '35mb' }));
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    // The two extra headers are sent by pages hosted elsewhere (utils/runtime-config.js) to skip the free
    // ngrok / zrok warning pages.
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning', 'skip_zrok_interstitial'],
    // Lets the browser remember the permission check for a day (browsers cap it, Chrome at 2 hours), so a page
    // on another address does not send an extra OPTIONS request before every API call.
    maxAge: 86400,
  }),
);

app.use('/api/auth', authRouter);
app.use('/api/session', sessionRouter);
app.use('/api/attendance', attendanceRouter);
app.use('/api/students', studentRouter); // admin-only, plus the session roster the faculty page reads
app.use('/api/student', studentSelfRouter); // a signed-in student's own data
app.use('/api/faculty', facultyRouter);
app.use('/api/admin', adminRouter);
app.use('/api/attendance/cctv', cctvRouter);

// ------------------ Initialize server ---------------------

const attrs = [{ name: 'commonName', value: 'localhost' }];
const pems = await selfsigned.generate(attrs, {
  algorithm: 'sha256',
});

const options = {
  key: pems.private,
  cert: pems.cert,
};
const server = https.createServer(options, app);

const io = initializeSocket(server); // Initialize Socket.io server

// Serve frontend
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FRONTEND_DIR = path.join(__dirname, '../frontend');

// Which copy of the frontend to serve. `npm run build` makes ../frontend-dist (bundled, hashed, brotli files).
// It is used only when you start the server with SERVE_DIST=1, so an old build can never hide your edits by accident.
const SRC_DIR = FRONTEND_DIR;
const DIST_DIR = path.join(__dirname, '../frontend-dist');
const useDist = process.env.SERVE_DIST === '1' && fs.existsSync(path.join(DIST_DIR, 'student.html'));
if (process.env.SERVE_DIST === '1' && !useDist)
  console.warn('SERVE_DIST=1 but frontend-dist/ is missing. Run `npm run build`. Serving ../frontend instead.');
const WEB_DIR = useDist ? DIST_DIR : SRC_DIR;
// The source pages load the face models from this server. They are not kept in the repo any more.
if (!useDist) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets.manifest.json'), 'utf8'));
    const missing = manifest.assets.filter(
      a => a.scope === 'frontend' && !a.optional && !fs.existsSync(path.join(FRONTEND_DIR, a.path)),
    );
    if (missing.length)
      console.warn(`Face-engine files are missing (${missing.map(a => path.basename(a.path)).join(', ')}). Run: npm run assets`);
  } catch {
    // no manifest: nothing to check
  }
}
console.log(`Serving the frontend from ${useDist ? 'frontend-dist (built)' : 'frontend (source)'}`);

// Ready-made brotli files, when the browser accepts them (the 11 MB .wasm drops to about 2.5 MB).
app.use(precompressed(WEB_DIR));

// Face models: not "immutable": if a model file is ever replaced, bump VERSION in js/face/engine.js and
// phones fetch the new file once. Cache rules for everything else live in utils/static-fast.js.
app.use(express.static(WEB_DIR, { setHeaders: staticHeaders(WEB_DIR) }));

app.use('/results', express.static(path.join(__dirname, 'results')));

// Anything that looks like a file (has an extension) and was not found above is a real 404. It used to get the
// home page with status 200, so a missing model or script arrived as HTML and failed with a confusing error.
app.get(/^\/[^?]*\.[A-Za-z0-9]+$/, (req, res) =>
  res.status(404).type('text/plain').send('Not found'),
);

// If someone hits a route that's not an API (fallback)
app.get(/^\/(?!api).*/, (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(WEB_DIR, 'homepage.html'));
});

// --------------- Start server --------------
const serverIp = getServerIpAddress() || 'localhost';
const PORT = process.env.PORT || 4000;

server.listen(PORT, '0.0.0.0', () =>
  console.log(`🚀 Server running at https://${serverIp}:${PORT}`),
);

// Host tunnel online
const url = `https://localhost:${PORT}`;
hostTunnel(url);

function getServerIpAddress() {
  try {
    const interfaces = Object.entries(os.networkInterfaces()).flatMap(
      ([name, addresses]) =>
        (addresses || [])
          .filter(details => details.family === 'IPv4' && !details.internal)
          .map(details => ({ name, address: details.address })),
    );

    return (
      interfaces.find(({ name }) => /wi-?fi|wireless/i.test(name))?.address ||
      interfaces[0]?.address ||
      null
    );
  } catch (err) {
    return null;
  }
}
