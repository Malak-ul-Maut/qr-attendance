import express from 'express';
import path from 'path';
import cors from 'cors';
import https from 'https';
import os from 'os';
import selfsigned from 'selfsigned';
import { fileURLToPath } from 'url';

import hostTunnel from './utils/host-tunnel.js';
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

app.use(express.json({ limit: '35mb' }));
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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

// Face models: the folder is utils/models. Not "immutable": if a model file is ever replaced, bump VERSION in
// js/face/engine.js and phones fetch the new file once.
app.use(
  '/utils/models',
  express.static(path.join(FRONTEND_DIR, 'utils/models'), {
    maxAge: '7d',
  }),
);

// Cache the self-hosted ONNX Runtime files (loader + WASM) in the browser for a year.
app.use(
  '/utils/ort',
  express.static(path.join(FRONTEND_DIR, 'utils/ort'), {
    maxAge: '365d',
    immutable: true,
  }),
);

app.use(express.static(FRONTEND_DIR));

app.use('/results', express.static(path.join(__dirname, 'results')));

// Anything that looks like a file (has an extension) and was not found above is a real 404. It used to get the
// home page with status 200, so a missing model or script arrived as HTML and failed with a confusing error.
app.get(/^\/[^?]*\.[A-Za-z0-9]+$/, (req, res) =>
  res.status(404).type('text/plain').send('Not found'),
);

// If someone hits a route that's not an API (fallback)
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'homepage.html'));
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
