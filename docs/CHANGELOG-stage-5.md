# Stage 5: Student screens

Files changed: `frontend/student.html`, `frontend/js/today.js`, `today-logic.js`, `attendance.js`, `profile.js`, `app.js`, `frontend/css/student.css`. New: `frontend/js/password-dialog.js`. No backend change: the dated records use the existing `/api/student/attendance?subject=`.

## What changed

- **Header and greeting.** Nothing left of "Hi, X" in the header; the time-based greeting stays. The line under it now holds only the class chips (class, home room, batch).
- **Today title.** `Today · Fri, 23 Oct` with the Today / Week switch beside it (it wraps under the title only if the screen is too narrow). In Week view the title is `This week · 19 Oct – 23 Oct`.
- **Slot card.** One header grid, `[P3] Subject ........ 9:30 am – 10:20 am`. The time is `nowrap`, so it never drops to a second line (the `flex-wrap` on `.class-head` is gone). The room is shown only when it differs from the class's home room.
- **Double lecture.** One card with a "Double · P3–P4" badge and a blue stripe down the left edge. One status chip for the card; one chip per period, labelled (`P3: Present`, `P4: Absent`), only when the two periods are in different states.
- **Featured ("Now") card and double lectures** use a two-row header (tag and time on the first row, subject at full width below), so a long subject name is not squeezed into a narrow column.
- **Week view** uses the same header grid with a fixed tag column, so periods line up from one day to the next (checked). Doubles keep the stripe.
- **Attendance tab.**
  - The ring is coloured by status (green above 75%, amber close to it, red below it), and the sentence beside it still says the same in words.
  - Each subject opens to its dated records, newest first: date, period and time, and Present (how and when) or Absent. They load when opened, 20 at a time with "Show more", and re-read after a refresh.
- **Password.**
  - Profile has a "Password" row (with a note while it is still the default) instead of the inline form.
  - One dialog serves the avatar menu, the Profile row, the "Finish setting up" card, and first sign-in. It has show/hide eyes inside the fields and a live checklist: at least 8 characters, not your username, roll number or "password", different from the current one, both new passwords match. Save stays off until all are met.
  - On first sign-in it opens once by itself with a **Later** button (**Cancel** when opened on request). It never closes on an outside click.
  - The old redirect to the Profile tab is gone.

## Checked

Chromium at 360×640, 390×844, 800×1280, 1366×650 and 1920×1080: nothing sticks out sideways on any tab and times never wrap. Today and Week with a day that has every state (marked, missed, open, waiting, upcoming, not tracked, not on the list, a double with the same state, a double with mixed states). Attendance and the password dialog against the real student routes (dated records from real sessions, wrong current password, successful change, no automatic dialog on the next visit). A script computing WCAG contrast on every visible text element (4.5:1, or 3:1 for large text) plus the ring and stripe colours found no failures in light or dark on Today, Week, Attendance, Profile and the dialog.

## Stage 4 changes made with it

Add manually now has the checkbox on the left. Full screen is split in two halves (QR and live roster). See `docs/CHANGELOG-stage-4.md`.

## Limits

- The Today states were tested with a stand-in for the schedule response (to get every state on one screen); Attendance, Profile and the password change ran against the real routes.
- The password rules in the checklist mirror the server's (length, default, username, roll number, unchanged), but the server stays the authority and its message is shown if it disagrees.
- Not run: `npm test` and the project's own `npm run audit:contrast`; `tests/` and `tools/` are not in the zip you sent.
- Faculty and admin still have no change-password feature (needs a backend change).
