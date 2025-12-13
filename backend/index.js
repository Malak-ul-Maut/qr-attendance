const path = require('path');
const cors = require('cors');
const https = require('https');
const { Server } = require('socket.io');
const db = require('./db');
const fs = require('fs');
const os = require('os');
const express = require('express');



// --------------- Functions ----------------
const sessions = {};
const activeTokens = {};

function createSessionToken(sessionId, section, expiresInSeconds) {
    const token = Math.random().toString(36).slice(2);
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    activeTokens[token] = { sessionId, section, expiresAt };
    
    setTimeout(() => delete activeTokens[token], expiresInSeconds * 1000);
    return token;
}

function getServerIpAddress() {
  const networkInterfaces = os.networkInterfaces();
  for (const interfaceName in networkInterfaces) {
    const addresses = networkInterfaces[interfaceName];
    for (const address of addresses) {
      // Filter for IPv4 addresses that are not internal (loopback)
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }
  return null;
}


// ----------------- Server initialization -----------------
const app = express();
app.use(express.json());
app.use(cors({ 
  origin: '*', 
  methods: ['GET', 'POST'], 
  allowedHeaders: ['Content-Type', 'Authorization'] 
}));

const options = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
};
const server = https.createServer(options, app);


// Initialize Socket.io server
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

let teacherSockets = [];
io.on('connection', socket => {
    socket.on('register_teacher', () => teacherSockets.push(socket));
    socket.on('disconnect', () => {
        teacherSockets = teacherSockets.filter(s => s.id !== socket.id);
    });
});



// --------------- API Routes ----------------

// User login
app.post('/api/login', (req,res) => {
    const { username, password, role } = req.body;

    db.get(`SELECT * FROM users WHERE username = ? AND password = ? AND role = ?`, 
        [username, password, role], 
        (err, row) => {
        if (err) return res.status(500).json({ ok:false, error: "db_error: " + err });
        if(!row) return res.status(401).json({ ok:false, error: "invallid_credentials" });

        return res.json({
            ok: true,
            name: row.name,
            username: row.username,
            subName: row.subjectName
        });
    });
});


// Start session
app.post('/api/session/start', (req, res) => {
    const { section, teacherId } = req.body;
    const sessionId = 'sess_' + Math.random().toString(36).slice(2);
    sessions[sessionId] = { section, teacherId, acitve: true };

    db.run(
        `INSERT OR REPLACE INTO sessions (sessionId, section, teacherId, status) VALUES (?, ?, ?, 'active')`,
        [sessionId, section, teacherId],
        (err) => {
            if(err) console.error('Failed to insert session:', err);
        }
    );

    let token = createSessionToken(sessionId, section, 3);
    return res.json({ ok: true, sessionId, token});
});


// Issue a fresh token for an existing sessionId
app.post('/api/session/token', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || !sessions[sessionId]) return res.status(400).json({ ok:false, error:'invalid'});

    const { section } = sessions[sessionId];
    let token = createSessionToken(sessionId, section, 3);
    return res.json({ ok:true, token});
});


// Verify student scan
app.post('/api/session/verify', (req, res) => {
  const { studentId, studentName, token, cameraFingerprint } = req.body;
  if (!studentId || !token || !cameraFingerprint) 
    return res.status(400).json({ ok: false, error: 'missing_fields' });

  if (!activeTokens[token])
    return res.status(400).json({ ok: false, error: 'invalid_or_expired_token' });

  const { sessionId, section } = activeTokens[token];

  db.get(
    `SELECT * FROM attendance WHERE (studentId = ? OR cameraFingerprint = ?) AND sessionId = ?`, 
    [studentId, cameraFingerprint, sessionId],
    (err, row) => {
      if (err) return res.status(500).json({ ok: false, error: err });
    
      if (row) {
        if (row.studentId === studentId) 
          return res.status(400).json({ ok: false, error: 'already_marked'});
        if (row.cameraFingerprint === cameraFingerprint) 
          return res.status(400).json({ ok: false, error: 'duplicate_device_entry'});
      }

      db.run(
        `INSERT INTO attendance (studentid, studentName, section, sessionId, cameraFingerprint) VALUES (?, ?, ?, ?, ?)`,
        [studentId, studentName, section, sessionId, cameraFingerprint],
        () => {
          teacherSockets.forEach(sock => sock.emit('attendance_update', { 
            studentId, 
            studentName, 
            section, 
            sessionId, 
            time: new Date().toLocaleTimeString()
          }));
          return res.json({ ok:true, message: 'Attendance recorded', sessionId });
        }
      );
    }
  );
});


// Finalize attendance
app.post('/api/session/finalize', (req, res) => {
  const { sessionId, keepStudentIds } = req.body;
  sessions[sessionId].active = false;
  const placeholders = keepStudentIds.map(()=> '?').join(','); // '?,?,?,?,....,?'

  if (keepStudentIds.length === 0) {
    teacherSockets.forEach(sock => sock.emit('session_finalized', { sessionId }));
    return res.json({ ok:true, message:'Finalized (no students kept)'});
  }

  db.run(
    `UPDATE sessions SET endTime = datetime('now'), status = 'ended' WHERE sessionId = ?`, [sessionId]
  );
  
  db.run(
    `UPDATE attendance SET removed = 0 WHERE sessionId = ? AND studentId IN (${placeholders})`, 
    [sessionId, ...keepStudentIds], 
    () => {
    return res.json({ ok:true, message:'Finalized', keptCount: keepStudentIds.length });
  });
});



// -------------- Server config----------------

// Serve frontend
const FRONTEND_DIR = path.join(__dirname, '../frontend');
app.use(express.static((FRONTEND_DIR)));


// If someone hits a route that's not an API (fallback)
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'homepage.html'));
});


// Start server
const serverIp = getServerIpAddress();
const PORT = 4000;

server.listen(PORT, () =>
  console.log(`🚀 Server running at https://${serverIp}:${PORT}`));