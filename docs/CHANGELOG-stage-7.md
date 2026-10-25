# Stage 7: Admin

Files changed: `frontend/admin.html`, `frontend/css/admin.css`, `frontend/js/admin/master.js`, `enrollment.js`, `timetable.js`, `backend/routes/admin/master.js`, `enrollment.js`.

## Decisions you gave

- **Classes stays "Classes"** (no rename), but its rows are **classrooms**: section, home room and the class(es) taught in it. DS and AIML in 5D are one row, `5D · F-403`, with `AIML, DS` in the Classes column. Students are summed; each class in the room keeps its own Edit and Delete on its own line. A class with no home room is a row of its own.
- **The academic year starts in July.** It is one constant (`ACADEMIC_YEAR_START_MONTH` in `master.js`).

## What changed

- **Term wizard.** An academic-year list and an ODD / EVEN choice replace the session list and the "Other" box. Only the current term and later ones are offered (the current year plus two); in the current year the finished term is switched off. The current term comes from the server's date.
- **Year of passing.** In the student form it is a short list, worked out from the chosen class (`session start + course length − year of study + 1`: Sem 5 in 2026-27 gives 2028, marked "from the class") with the year before and two after, for a student repeating a year. With no class chosen it lists this year and the next five, so final-year students in an even term are not left out. An existing student keeps the stored year until someone changes it.
- **Faculty abbreviation.** While typing, a message says "AMG is already used by Mr. Amit Girdharwal" or "ZZQ is free". Saving a taken one now returns a clear 409 naming the owner, shown under the field (letters are compared without case, so `amg` and `AMG` count as the same).
- **Credentials.** Username and password share a row, with the eye inside the password field. The Generate button is gone from the form: leaving the password blank on a new person still generates one for the hand-over. New: **Reset password** on every student and faculty row (confirm, then the hand-over dialog shows the new one once), and **Generate passwords** on the students' bulk bar, which makes new passwords for the selected students and downloads a CSV (name, roll number, username, password).
- **Print timetable** opens with every classroom ticked and "All classrooms" ticked.
- **Face photos.** The grid shows one photo per pose (the sharpest), captioned with the pose; runner-up frames from older uploads are hidden and counted ("2 extra frames… not shown"). An **"i"** beside Check explains what the check looks at, in the words of `enroll_qa.py` (one clear face of at least 90 px, sharp and good quality, same person across photos, matches the reference photo, at least 4 usable photos, bonus poses never counted against the student). If those limits change in `enroll_qa.py`, change the numbers in `QA_POINTS` in `enrollment.js`.

## A bug found and fixed on the way

Adding or editing a student or faculty member in Setup failed outright: the form's `password` field was written to a column that does not exist (the table has `password_hash`). It is mapped now. This was the case for every create and edit, not only ones with a password.

## Checked

Route level: create with a blank password (a password is generated and stored), duplicate abbreviation on create and edit, the live check (including editing a person's own abbreviation), password reset. Browser, once, against the real data: the Classes table (real data gives `5D · F-403`, `AIML, DS`), the student form (one row, eye inside, no Generate, 2028 from Sem 5 in 2026-27), the live abbreviation check, the wizard's year and term controls (no "Other").

## Not checked, and things to know

- Not run in a browser: the Reset password and Generate passwords dialogs and the CSV download, the "i" popover, the face-photo grid, and the print dialog default. The password endpoint is tested; the rest is straightforward code but unproven.
- Generate passwords is on students only (faculty are few; use Reset password on their row).
- **Passwords are stored and compared as plain text** in the database (the login route says hashing "comes later"). The new CSV is plain text too, and so is every password you hand over. Worth doing before real use.
- The admin pages' own tests and `npm run audit:contrast` were not run (`tests/` and `tools/` are not in the zip).
