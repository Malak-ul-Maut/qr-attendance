// Live updates for the student page. The server tells the page when something it shows has changed (a period opened,
// ended or was discarded, or the student's own mark landed), so the page no longer has to ask every 20 to 60 seconds.
//   - liveJoined(): true while the connection is up and the server knows who this student is.
//   - 'student:schedule-changed' (a window event): the schedule or the marks changed; refresh what is on screen.
//   - liveSocket: the same connection, for the scan flow to listen to its own session.
// If the library did not load or the connection is down, liveJoined() is false and the pages go back to checking on
// their own timers, so nothing depends on this working.
import { getCurrentUser } from '../utils/storage.js';

export const liveSocket = typeof io === 'function' ? io(window.API_BASE || location.origin) : null;
let joined = false;
let everJoined = false;
export const liveJoined = () => joined && Boolean(liveSocket?.connected);

if (liveSocket) {
  let timer = 0;
  const changed = () => {
    clearTimeout(timer); // several notices in a row (a whole class marked at once) become one refresh
    timer = setTimeout(() => window.dispatchEvent(new CustomEvent('student:schedule-changed')), 300);
  };
  liveSocket.on('connect', () => {
    joined = false;
    const token = getCurrentUser()?.token;
    if (token) liveSocket.emit('join_student', token);
  });
  liveSocket.on('student_joined', () => {
    joined = true;
    if (everJoined) changed(); // back after a drop: whatever happened meanwhile is missing
    everJoined = true;
  });
  liveSocket.on('disconnect', () => { joined = false; });
  liveSocket.on('schedule_changed', changed);
}
