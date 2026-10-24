# Stage 4: Faculty live session

Files changed: `frontend/faculty.html`, `frontend/js/faculty.js`, `frontend/css/faculty.css`, `backend/routes/session.routes.js`, `backend/schema.sql`.

## What changed

- **Session bar.** One compact card replaces the old header: subject large, then `CSE · Sem 5 · A · F-307 · 9:30 am – 10:20 am`, tags (Extra, Borrowed, Double · P3–P4), merged classes as chips with their own counts, and the present count (`24/59`) on the right. The date is added only when it is not today. Times now use `format.js`.
- **Roster.** On wide screens the live view is exactly window height, so the roster fills the space and has the only scroll. Rows are compact (44 px), two columns once the panel is wide enough, roll number on the second line, remove/undo as an icon (44 px on touch screens). On phones the page scrolls and the Discard / Submit bar sticks above the tab bar.
- **Discard.** Danger-styled button at the opposite end from Submit. The confirm dialog states the count ("18 students marked present will be removed"). The server accepts `force` only together with `confirmMarked`; if more students were marked since, it refuses (`marks_changed`) and the dialog shows the new count. Every discard, with or without marks, writes a row to `session_discard_log` (who, when, how many, class, subject). Only before submit.
- **Students' Today tab.** Discard deletes the attendance rows, so Today stops showing "marked" on its next refresh (it polls). Checked against the real `/schedule` route.
- **QR panel.** The "QR refreshes automatically" line is gone. A warning appears over the QR only if refreshing fails. The code is drawn at the screen's real pixel density with a whole number of pixels per square, and redraws on any resize. Full screen: two equal halves, the QR in one and the live roster in the other, with the present count on top; the search, add, discard, submit and remove controls are hidden while presenting.
- **Add manually.** The dialog is a flex column, so only the list scrolls. The "Tick the students…" line is gone. Search and Select all share a row. Rows have separators, a tinted selected state and a drawn check mark, and the whole row is tappable.
- **Reliability.**
  - `GET /api/session/active`: a refresh reopens the running session (QR, marks, who was taken off). Only sessions started in the last 12 hours come back, so a forgotten session from days ago does not reopen on every load.
  - `GET /api/session/history` and `/history/:code`: History is now server-side, with a detail dialog (absent and present lists, how and when each was marked). `localStorage` history is gone.
  - socket.io loads with `<script defer src="/socket.io/socket.io.js">`; `io(...)` is guarded. If the library is missing or the connection drops, the list re-reads from the server every 8 seconds, and after a reconnect it catches up, so nobody goes missing.

## Decisions I made (easy to reverse)

- **Checkbox on the left** (conventional), then the name, with the roll number at the right. Roll first, checkbox in the middle is gone.
- **Full screen is split in two halves** (QR left, live roster right), stacked on an upright phone. Controls are hidden so nothing is changed by accident while projecting.
- **Add manually** closes on outside click, except once someone is ticked (then it only nudges), so a stray click cannot throw the choices away.
- **Taken-off students** are kept in the browser per session, so a refresh does not bring them back.
- The "leave this page?" prompt is kept.

## Not done / limits

- CCTV after a refresh: the running session reopens with its marks and a "Scan again" button, and shows the last picture if the server still has it. It does not re-scan on its own.
- The student Today tab refreshes by polling, so it updates within its polling interval, not instantly. Instant updates belong with Stage 5.
- A forgotten open session older than 12 hours is not offered for resume (there is still no screen to finish it).
- Not run: the real socket.io server (tested with a stand-in that fires the same events), and the contrast audit and `npm test` (`tools/` and `tests/` are not in the zip you sent).
- `backend/routes/session.routes.js` still sends the manual-add time with `toLocaleTimeString` (server side, not shown in the UI).

## Checked

Backend: 26 route checks (resume, discard rules, audit row, history). Browser (Chromium): live view fits 1366×650 and 1920×1080 with no page scroll; no sideways scroll at 800×1280, 390×844, 360×640; light and dark; resume after refresh; discard with late scans; submit then History detail; full screen; no-socket fallback.

Housekeeping: the zip you sent contains `.env` and `database.db`. Keep them out of the repo you share (Stage 9 item), and rotate anything in `.env` if it was already shared.
