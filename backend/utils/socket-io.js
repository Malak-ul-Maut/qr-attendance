import { Server } from 'socket.io';
import utils from './in-memory-db.js';

export function initializeSocket(server) {
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
}
