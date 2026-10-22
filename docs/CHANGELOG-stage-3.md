# Stage 3: faculty setup screen

Apply Stages 0 to 2 first. This zip holds only the files that changed.

## Changed files
`backend/routes/session.routes.js`, `frontend/faculty.html`, `frontend/css/faculty.css`, `frontend/js/faculty.js`.

## Screen
- **Two columns on desktop.** Left: date, session type, then the period (Regular) or classes, subject and periods (Extra).
  Right: room, attendance method, Start. One column on phones.
- **Title** reads "Pick a class" (muted) until something is chosen, then the subject's name.
- **Date chip** `Thu, 22/10/2026` with previous and next day arrows (Sundays are skipped). Tapping the date opens the
  browser's own calendar through a hidden date input, so the text is DD/MM/YYYY on every device. It sits on the same row as
  the session type.
- **Room chip** `Room F-307 · change`. The real `<select>` sits invisibly on top, so it opens the phone's own list. Once you
  choose a room yourself it stays chosen when you change the period or class; changing the date resets it.
- **Start session** is one fixed label (the method is already shown next to it). When it is off, the reason is written
  beside it: "Pick a class", "Pick a subject", "Pick a period" or "No class on this date".
- **Periods** in Regular show `11:10 am – 12:00 pm` (from `format.js`); on phones they show the start time, with the full
  range as a tooltip. "Now" is a green dot on phones.
- **Extra** (was "Arranged"): classes are toggle chips, periods are a compact grid (`P3`, start time, and a word under it for
  Borrow, Taken, Combined, Resume or Yours). A line under the grid explains what a borrowed period means and why
  greyed-out periods are unavailable. Picking two or more classes takes them together; that replaces Merge.

## Backend
- **Bug fixed: `/arranged/slots`.** A timetable row with no faculty (TRAINING, PLACEMENT PREP, PROJECT) used to count as
  another faculty's period, so it said "Borrow from another faculty". Rows with no faculty, or whose subject takes no
  attendance, are now free (the note says `Free (TRAINING, no attendance)`). On your database, CSE 5A on Monday 19/10/2026,
  periods 6 to 8: before, all three said Borrow; now all three are Free.
- **`POST /arranged` had the same assumption.** It now ignores those rows too, so a free period becomes a plain Extra
  session (no timetable row) instead of a "borrowed" one on a row with nobody in it.
- **Removed:** `GET /merge-options`, and `mergeClassIds` from `POST /start` and `startSessions()`.
  `session_classes.merged` stays in the schema; it is still written as 0.

## Removed from the page
The merge box, the "Pick a class and start taking attendance" line, the "Start QR session" / "Start CCTV session" label,
the Class slot / Arranged wording.

## Checked
- Ran the real route code against your `database.db` (a copy) and drove the real page in Chromium:
  30 interaction checks (date chip, Sunday skipping, placeholder and reasons, room chip, Extra with one and two classes,
  borrow note, start requests, live view opens), 0 failures, no script errors.
- One viewport, no scrolling, light and dark:

| Size | Regular | Extra |
|---|---|---|
| 1366×650 | fits | fits |
| 1920×1080 | fits | fits |
| 800×1280 | fits | fits |
| 390×844 | fits | **scrolls about 90 px** |
| 360×640 | fits | **scrolls about 210 px** |

## Not done, and why
- **Extra on a phone scrolls.** It has four controls (classes, subject, eight periods, then room, method and Start) where
  Regular has one. Making it fit at 360×640 would mean hiding the times or the subject, which I did not want to do without
  asking. Say if you want that.
- **`npm test` and `npm run audit:contrast` were not run here** (the zip has no `tests/` or `tools/`). No new colours were
  added; everything uses existing tokens.
- Substituting for a colleague's class is still blocked (known limit in the plan, a later "Substitute" flow).
- The live session bar still prints times as `10:00 - 10:50`; that is Stage 4.
