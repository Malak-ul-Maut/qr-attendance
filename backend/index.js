require('dotenv').config();
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));

// In-memory sessions map: sessionId -> { courseId, teacherId, startedAt, active }
const sessions = {};


// --------------- Functions ----------------
const activeTokens = {};

function generateShortCode(length = 8) {
    const chars = 'ABCDEGHIJKLMNOPQRSTUVWXYZ123456789';
    return Array.from({ length}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function createSessionToken(sessionId, courseId, expiresInSeconds) {
    const shortCode = generateShortCode();
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    activeTokens[shortCode] = { sessionId, courseId, expiresAt };
    setTimeout(() => delete activeTokens[shortCode], expiresInSeconds * 1000);
    return shortCode;
}

function verifySessionToken(token) {
    try { 
        return jwt.verify(token, JWT_SECRET); 
    } catch (e) {
         return null; 
    }
}


// ----------------- Sockets -----------------
let teacherSockets = [];

io.on('connection', socket => {
    socket.on('register_teacher', () => {
        teacherSockets.push(socket);
        console.log('Teacher registered:', socket.id);
    });

    socket.on('disconnect', () => {
        teacherSockets = teacherSockets.filter(s => s.id !== socket.id);
        console.log('Client disconnected:', socket.id);
    });
});


// --------------- API Routes ----------------

// Teacher login
app.post('/api/login', (req,res) => {
    const { username, password } = req.body;
    if (username === 'teacher' && password === 'pass' ) {
        return res.json({ ok: true, teacherId: 'T1' });
    } return res.status(401).json({ ok: false, error: 'invalid_credentials' });
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

    if (cameraFingerprint) {
        db.get(
            `SELECT * FROM attendance WHERE sessionId = ? AND cameraFingerprint = ?`,
            [sessionId, cameraFingerprint],
            (err, row) => {
                if (err) {
                    console.error("DB Error (camera check):", err);
                    return res.status(500).json({ ok: false, error: 'db_error'});
                }
                if (row) {
                    return res.status(400).json({ ok: false, error: 'duplicate_device_entry'});
                }

                db.get(
                    `SELECT * FROM attendance WHERE sessionId = ? AND studentId = ?`,
                    [sessionId, studentId],
                    (err, row2) => {
                        if (err) {
                            console.error("DB Error (student check):", err);
                            return res.status(500).json({ ok: false, error: 'db_error' });
                        }
                        if (row2) {
                            return res.status(400).json({ ok: false, error: 'already_marked' });
                        }

                        db.run(
                            `INSERT INTO attendance (studentid, courseId, sessionId, cameraFingerprint, verified) VALUES (?, ?, ?, ?, ?)`,
                            [studentId, courseId, sessionId, cameraFingerprint, 1],
                            function (err) {
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
                        )
                    }
                )
            }
        )
    } else {
        db.run(
            `INSERT INTO attendance (studentId, courseId, sessionId, verified) VALUES (?, ?, ?, ?)`,
            [studentId, courseId, sessionId, 1],
            function (err) {
                if (err) {
                    console.error('DB Error:', err);
                    return res.status(500).json({ ok: false, error: 'db_error'});  
                }

                console.log(`✓ Attendance recorded: ${studentId} in ${courseId} (session ${sessionId})`);
                
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
});

// End session
app.post('/api/session/end', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || !sessions[sessionId]) return res.status(400).json({ ok: false, error: 'invalid_session' });

    sessions[sessionId].active = false;

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
            // Notify teachers that session ended
            teacherSockets.forEach(sock => sock.emit('session_ended', { sessionId }));
            
            return res.json({ ok:true, sessionId, records: rows });
        }
    );
});

// Finalize attendance
app.post('/api/session/finalize', (req, res) => {
    try{
        const { sessionId, keepStudentIds } = req.body;
        if(!sessionId || !Array.isArray(keepStudentIds)) return res.status(400).json({ ok:false, error:'missing_fields' });
        
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
const FRONTEND_DIR = 'qr-attendance/frontend';
app.use(express.static((FRONTEND_DIR)));

// If someone hits a route that's not an API(fallback)
app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'student.html'));
});

server.listen(PORT, () =>
    console.log(`🚀 Server running at http://192.168.1.9:${PORT}`)
);
