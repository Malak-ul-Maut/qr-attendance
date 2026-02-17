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

// ----------------- Server Config -----------------
const app = express();

app.use(express.json());
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.use('/api/auth', authRouter);
app.use('/api/session', sessionRouter);
app.use('/api/attendance', attendanceRouter);
app.use('/api/students', studentRouter);

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

initializeSocket(server); // Initialize Socket.io server

// Serve frontend
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FRONTEND_DIR = path.join(__dirname, '../frontend');

// Cache models locally
app.use(
  '/utils/models',
  express.static(path.join(FRONTEND_DIR, 'utils/models'), {
    maxAge: '365d',
    immutable: true,
  }),
);

app.use(express.static(FRONTEND_DIR));

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
    return (
      Object.values(os.networkInterfaces())
        .flat()
        .find(details => details.family === 'IPv4' && !details.internal)
        ?.address || null
    );
  } catch (err) {
    return null;
  }
}
