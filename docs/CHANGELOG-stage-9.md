# Stage 9 (part): the small items from the first review

Only these five items were done; the accessibility pass, the full regression run and the pre-sharing checks are still open. Stage 8 was left out.

Files changed: `frontend/css/tokens.css`, `components.css`, `admin.css`, `frontend/js/admin/home.js`, `frontend/js/faculty.js`, `today.js`, `attendance.js`, `scan-flow.js`, `app.js`, `frontend/student.html`, `backend/utils/socket-io.js`, `backend/routes/session.routes.js`, `attendance.routes.js`, `cctv.routes.js`. New: `frontend/js/live.js`.

## 1. Unused assets

Nothing refers to these four files (checked against every page, script, stylesheet, doc and the backend). I did not delete them, because a zip cannot carry a deletion and the college brand settings can point at any file in `icons/`. Remove them if you do not use them:

```
git rm "frontend/icons/mit-building (a_block_front).jpg" frontend/icons/mit-building.jpg frontend/icons/mit-building.webp "frontend/icons/mit_college(a block).webp"
```

That is 293 KB. (Only 18 files are in `icons`, `brand` and `fonts` together, so there was less to remove than the earlier 663 KB.)

## 2. Hard-coded colours in `admin.css`

None are left (no hex, no `rgb()`). They moved into `tokens.css`:

- `--on-red` and `--head-bg` (light and dark) now live there; `--on-red` was defined in `components.css`.
- `--scrim` for the white icon laid over a photo.
- `--sheet-*` for the timetable sheet, which copies the printed paper and so stays the same in light and dark mode (paper, ink, cell text, shared mark, "+" mark, add-button edge, Saturday row, header cells, hover accent, and the new / changed / removed outlines).
- Every pair was checked for contrast. One real fix came out of it: the "changed" outline was `#e08a00`, 2.7:1 on paper (below the 3:1 a graphic needs); it is `#b86200` now (4.4:1). Everything else passes. The project's own `audit:contrast` was not run (the tool is not in the zip).

## 3. Chart labels

Axis and value labels are 14px (they were 12px), and the chart's margins and label spacing grew to fit them. The chart is still drawn at the width it is shown at, so the text is a real 14px on a phone. I did not see the chart on screen (the test server has no analytics data), so look at it once on a phone.

## 4. Empty states

Most screens already had one. Added or improved:

- Faculty Extra form for a faculty with no classes in the timetable: it was a blank form; it now says there is nothing to take extra and to ask the admin office.
- The admin's plain grey "empty" lines are now a visible dashed box, and "No sessions in this period" says what to do.

## 5. Polling replaced by live updates

- **Student page** (`js/live.js`, new): the server now tells a student's page when a period opens, is submitted or is discarded, and when their own mark lands (QR, by hand or CCTV). The page asks for its schedule again within a third of a second (several notices become one refresh). It joins only its own class and student rooms, proved by its login token and read from the database, so a page cannot listen to anyone else's.
- **Today** checked every 20 to 60 seconds; with a live connection it is now a 5-minute safety net. **Attendance** refreshes on the same notices. After a dropped connection the page refreshes once on return.
- **Face check in progress**: asking "did the teacher close this?" every 5 seconds is now every 30 seconds while live, and a close from the teacher is noticed at once.
- **Falls back by itself**: if the socket library does not load or the connection is down, every page goes back to its old timers, so nothing depends on this working.
- **Left as polling on purpose:** the 3-second "how busy is the CCTV service" hint (optional, only during a scan of a few seconds), and the faculty roster's catch-up poll (it only runs when the live connection is down).

## Checked

- Server rooms with the real `socket-io.js` against a stand-in for the socket library: a valid student token joins its own rooms, a bad or missing one joins nothing, notices reach the right rooms once each.
- Browser: the student page asks to join with its token, becomes "live" only when the server confirms, three notices make one refresh, and a reconnect makes one catch-up refresh.
- Not run with the real socket.io package or a real browser-to-server connection (it is not installed here), so please try it once: start a session as faculty and watch a student's Today change without refreshing.
