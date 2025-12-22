const path = require('path');
const cors = require('cors');
const https = require('https');
const { Server } = require('socket.io');
const os = require('os');
const selfsigned = require('selfsigned');

// ----------------- Server Config -----------------
const express = require('express');
const app = express();
const utils = require('./utils');

app.use(express.json());
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/session', require('./routes/session.routes'));
app.use('/api/attendance', require('./routes/attendance.routes'));

initializeServer();

// ----------------- Functions ---------------------

async function initializeServer() {
  // Generate a self-signed certificate
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const pems = await selfsigned.generate(attrs, {
    algorithm: 'sha256',
  });

  // Create HTTPS server with the generated certificate
  const options = {
    key: pems.private,
    cert: pems.cert,
  };
  const server = https.createServer(options, app);

  // Initialize Socket.io server
  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.on('connection', socket => {
    socket.on('register_teacher', () => utils.teacherSockets.push(socket));
    socket.on('disconnect', () => {
      utils.teacherSockets = utils.teacherSockets.filter(
        s => s.id !== socket.id,
      );
    });
  });

  // Serve frontend
  const FRONTEND_DIR = path.join(__dirname, '../frontend');
  app.use(express.static(FRONTEND_DIR));

  // If someone hits a route that's not an API (fallback)
  app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'homepage.html'));
  });

  // Start server
  const serverIp = getServerIpAddress();
  const PORT = 4000;

  server.listen(PORT, () =>
    console.log(`🚀 Server running at https://${serverIp}:${PORT}`),
  );
}

function getServerIpAddress() {
  return (
    Object.values(os.networkInterfaces())
      .flat()
      .find(details => details.family === 'IPv4' && !details.internal)
      ?.address || null
  );
}
