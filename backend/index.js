const path = require('path');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const https = require('https');
const { Server } = require('socket.io');
const db = require('./db');
const fs = require('fs');
const os = require('os');
const express = require('express');
const app = express();


// HTTPS server
const options = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
};
const server = https.createServer(options, app);

const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));



// --------------- Functions ----------------
const sessions = {};
const activeTokens = {};

function generateShortCode(length = 8) {
    const chars = 'ABCDEFHIJKLMNOPQRSTUVWXYZ123456789';
    return Array.from({ length }, () => 
        chars[Math.floor(Math.random() * chars.length)]
    ).join('');
}

function createSessionToken(sessionId, courseId, expiresInSeconds) {
    const shortCode = generateShortCode();
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    activeTokens[shortCode] = { sessionId, courseId, expiresAt };
    setTimeout(() => delete activeTokens[shortCode], expiresInSeconds * 1000);
    return shortCode;
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


// ----------------- Sockets -----------------
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
    const table = 
        role === "student" ? "students" :
        role === "faculty" ? "faculty" :
        role === "admin" ? "admins" :
        null;

    if (!table) {
        return res.json({ ok:false, msg: "Invalid role" });
    }

    const query = `SELECT * FROM ${table} WHERE username = ? AND password = ?`;
    db.get(query, [username, password], (err, row) => {
        if (err) {
            console.error("DB login error:", err);
            return res.status(500).json({ ok:false, error: "db_error" });
        }
        
        if(!row) {
            return res.status(401).json({ ok:false, error: "invallid_credentials" });
        }

        return res.json({
            ok: true,
            role,
            loginId: row.id,
            name: row.name,
            subName: row.subjectName
        });
    });
});


// Start session: create sessionId, persist in-memory and DB, return a signed token
app.post('/api/session/start', (req, res) => {
    const { courseId, teacherId } = req.body;
    if (!courseId) return res.status(400).json({ ok:false, error:'missing_courseId' });

    const sessionId = 'sess_' + Math.random().toString(36).slice(2, 9);
    const startedAt = Date.now();
    sessions[sessionId] = { courseId, teacherId: teacherId || null, startedAt, acitve: true };
    
    // write to DB sessions table
    db.run(
        `INSERT OR REPLACE INTO sessions (sessionId, courseId, teacherId, startTime, status) VALUES (?, ?, ?, datetime('now'), 'active')`,
        [sessionId, courseId, teacherId || null],
        (err) => {
            if(err) console.error('Failed to insert session:', err);
        }
    );

    let token = createSessionToken(sessionId, courseId, 3);
    return res.json({ ok: true, sessionId, token, expiresIn: 3});
});


// Issue a fresh token for an existing sessionId
app.post('/api/session/token', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || !sessions[sessionId]) return res.status(400).json({ ok:false, error:'invalid'});

    const { courseId } = sessions[sessionId];
    let token = createSessionToken(sessionId, courseId, 3);
    return res.json({ ok:true, token, expiresIn: 3 });
});


// Verify attendance (student scan)
app.post('/api/session/verify', (req, res) => {
    const { studentId, token, cameraFingerprint } = req.body;
    if (!studentId || !token) 
        return res.status(400).json({ ok: false, error: 'missing_fields' });

    const entry = activeTokens[token];
    if (!entry)
        return res.status(400).json({ ok: false, error: 'invalid_or_expired_token' });
    
    if (Date.now() > entry.expiresAt) {
        delete activeTokens[token];
        return res.status(400).json({ ok: false, error: 'token_expired' });
    }

    const { sessionId, courseId } = entry;
    if (!sessions[sessionId] || sessions[sessionId].active === false) {
        return res.status(400).json({ ok:false, error:'session_inactive' });
    }

    if (!cameraFingerprint) return res.status(400).json({ ok:false, error:'no_camera_device_detected' });

    db.get(
        `SELECT * FROM attendance WHERE (studentId = ? OR cameraFingerprint = ?) AND sessionId = ?`, 
        [studentId, cameraFingerprint, sessionId],
        (err, row) => {
            if (err) {
                console.error("DB Error (duplicate check):", err);
                return res.status(500).json({ ok: false, error: 'db_error'});
            }
            if (row) {
                if (row.studentId === studentId) {
                    return res.status(400).json({ ok: false, error: 'already_marked'});
                }
                if (row.cameraFingerprint === cameraFingerprint) {
                    return res.status(400).json({ ok: false, error: 'duplicate_device_entry'});
                }
            }

            db.run(
                `INSERT INTO attendance (studentid, courseId, sessionId, cameraFingerprint, verified) VALUES (?, ?, ?, ?, ?)`,
                [studentId, courseId, sessionId, cameraFingerprint, 1],
                (err) => {
                    if (err) {
                        console.error('DB Error (insert):', err);
                        return res.status(500).json({ ok: false, error: 'db_error' });
                    }
                    console.log(`✔ Attendance recorded: ${studentId} in ${courseId} (session ${sessionId}) via cameraId ${cameraFingerprint}`);

                    teacherSockets.forEach(sock => sock.emit('attendance_update', {
                        studentId,
                        courseId,
                        sessionId,
                        time: new Date().toLocaleTimeString(),
                    }));
                    res.json({ ok:true, message: 'Attendance recorded', sessionId });
                }
            );
        }
    );
});


// End session
app.post('/api/session/end', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || !sessions[sessionId]) return res.status(400).json({ ok: false, error: 'invalid_session' });

    db.run(
        `UPDATE sessions SET endTime = datetime('now'), status = 'ended' WHERE sessionId = ?`,
        [sessionId],
        (err) => {
            if (err) console.error('Failed to update session endTime:', err);
        }
    );

    // Fetch attendance rows for that session (for teacher review)
    db.all(
        `SELECT id, studentId, courseId, timestamp, verified, finalized, removed FROM attendance WHERE sessionId = ?`, 
        [sessionId],
        (err, rows) => {
            if (err) {
                console.error('DB Error (fetching attendance on end):', err);
                return res.status(500).json({ ok:false, error:'db_error' });
            }
            
            return res.json({ ok:true, sessionId, records: rows });
        }
    );
});

// Finalize attendance
app.post('/api/session/finalize', (req, res) => {
    try{
        const { sessionId, keepStudentIds } = req.body;
        if(!sessionId || !Array.isArray(keepStudentIds)) return res.status(400).json({ ok:false, error:'missing_fields' });

        sessions[sessionId].active = false;
        
        // 1) mark all removed by default
        db.run(
            `UPDATE attendance SET removed = 1, finalized = 0 WHERE sessionId = ?`,
            [sessionId],
            (err) => {
                if (err) {
                    console.error('DB Error (while marking removed):', err);
                    return res.status(500).json({ ok:false, error:'db_error' });
                }

                if (keepStudentIds.length ===0) {
                    teacherSockets.forEach(sock => sock.emit('session_finalized', { sessionId }));
                    return res.json({ ok:true, message:'Finalized (no students kept)'});
                }

                // 2) For the kept ids set removed=0, finalized=1
                const placeholders = keepStudentIds.map(()=> '?').join(',');
                const sql = `UPDATE attendance SET removed = 0, finalized = 1 WHERE sessionId = ? AND studentId IN (${placeholders})`;
                db.run(sql, [sessionId, ...keepStudentIds], function (err2) {
                    if (err2) {
                        console.error('DB Error (while finalizing keep):', err2);
                        return res.status(500).json({ ok:false, error:'db_error' });
                    }

                    teacherSockets.forEach(sock => sock.emit('session_finalized', { sessionId, kept: keepStudentIds }));
                    return res.json({ ok:true, message:'Finalized', keptCount: keepStudentIds.length });
                });
            }
        );
    } catch (ex) {
        console.error('Unexpected finalize error:', ex);
        return res.status(500).json({ ok:false, error:'server_error' });
    }
});


// -------------- Serve frontend & start server ----------------
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static((FRONTEND_DIR)));

// If someone hits a route that's not an API(fallback)
app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'homepage.html'));
});

const serverIp = getServerIpAddress();
const PORT = 4000;

server.listen(PORT, () =>
    console.log(`🚀 Server running at https://${serverIp}:${PORT}`));