import { Server } from 'socket.io';
import { dbAll, dbGet } from './db.js';
import { readToken } from './auth-token.js';

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
