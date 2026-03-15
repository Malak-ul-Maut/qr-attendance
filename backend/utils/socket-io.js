import { Server } from 'socket.io';
import utils from './in-memory-db.js';

let io;
export function initializeSocket(server) {
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.on('connection', socket => {
    socket.on('join_session', sessionId => {
      socket.join(sessionId);
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
