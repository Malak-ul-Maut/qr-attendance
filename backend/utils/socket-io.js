import { Server } from 'socket.io';
import { dbAll, dbGet } from './db.js';
import { readToken } from './auth-token.js';
import { facultyUsernameFromToken } from './faculty-auth.js';
import { peekTicket } from './scan-tickets.js';
import { closeFeed, currentFrame, startPushing, FRAME_LIFETIME_MS } from './qr-feed.js';

let io;
export function initializeSocket(server) {
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.on('connection', socket => {
    // Faculty (and a student whose scan is running) listen to one session.
    socket.on('join_session', sessionCode => {
      socket.join(sessionCode);
    });

    // A student's page asks to hear about their own class and their own marks, so it does not have to keep asking.
    // The login token proves who they are; the rooms come from the database, never from what the page says.
    socket.on('join_student', async token => {
      try {
        const { claims } = readToken({ get: () => `Bearer ${token}` });
        if (claims?.role !== 'student') return;
        const student = await dbGet(`SELECT id FROM students WHERE username = ? AND active = 1`, [claims.username]);
        if (!student) return;
        socket.join(`student:${student.id}`);
        for (const row of await dbAll(`SELECT DISTINCT class_id FROM students_mapping WHERE student_id = ?`, [student.id]))
          socket.join(`class:${row.class_id}`);
        socket.emit('student_joined');
      } catch {
        // not signed in or the database is busy: the page keeps checking now and then instead
      }
    });

    // The faculty screen asks for the rotating QR. Only the faculty who owns the open QR session gets frames.
    // The reply carries the first frame so the screen is never blank while it waits for the next push.
    socket.on('qr_subscribe', async (request, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const { sessionCode, token } = request || {};
        const username = facultyUsernameFromToken(token);
        if (!username) return reply({ ok: false, error: 'faculty_login_required' });
        const owned = await dbGet(
          `SELECT 1 AS found FROM sessions
           JOIN faculties ON faculties.id = sessions.faculty_id
           WHERE sessions.session_code = ? AND faculties.username = ?
             AND sessions.method = 'qr' AND sessions.end_time IS NULL LIMIT 1`,
          [String(sessionCode ?? ''), username],
        );
        if (!owned) return reply({ ok: false, error: 'session_ended' });
        socket.join(`qr:${sessionCode}`);
        startPushing(io, sessionCode);
        reply({ ok: true, code: currentFrame(sessionCode), lifetimeMs: FRAME_LIFETIME_MS });
      } catch {
        reply({ ok: false, error: 'database_error' });
      }
    });

    socket.on('qr_unsubscribe', sessionCode => socket.leave(`qr:${sessionCode}`));

    // A student who passed the QR step listens for "the teacher closed this class" with the ticket, not the session code.
    socket.on('watch_ticket', async (request, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const { token, ticket } = request || {};
        const { claims } = readToken({ get: () => `Bearer ${token}` });
        if (claims?.role !== 'student') return reply({ ok: false });
        const held = peekTicket(ticket, claims.username);
        if (!held) return reply({ ok: false });
        socket.join(`watch:${held.sessionCode}`);
        reply({ ok: true });
      } catch {
        reply({ ok: false });
      }
    });

    socket.on('disconnect', () => {
      console.log('Disconnected');
    });
  });
  return io;
}

export function getIO() {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
}

// Tell student pages that something they show has changed (a period started, ended or was discarded; a mark landed).
// The page then asks for its schedule again. Never throws: a missed notice only means the page's slow check finds it.
export function notifyClasses(classIds = []) {
  try {
    for (const id of new Set(classIds.filter(Boolean))) io?.to(`class:${id}`).emit('schedule_changed');
  } catch {
    // see above
  }
}
export function notifyStudents(studentIds = []) {
  try {
    for (const id of new Set(studentIds.filter(Boolean))) io?.to(`student:${id}`).emit('schedule_changed');
  } catch {
    // see above
  }
}

// A session was submitted or discarded: faculty screens and students mid-check hear about it, and its QR stops.
export function announceSessionEnd(sessionCode) {
  closeFeed(sessionCode);
  try {
    io?.to(`qr:${sessionCode}`).emit('qr_ended');
    io?.to(sessionCode).emit('session_finalized', { sessionCode });
    io?.to(`watch:${sessionCode}`).emit('session_ended'); // no session code: students never learn it
  } catch {
    // a missed notice only means the page's slow check finds it
  }
}
