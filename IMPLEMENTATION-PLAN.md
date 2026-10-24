# Smart Attendance Marker: stage-wise implementation plan

Branch reviewed: `faculty/arranged-feature`. Terms and formats used below are defined in `docs/GLOSSARY.md`.

## Status

| Stage | Scope | Status |
|---|---|---|
| 0 | Foundations: tokens, contrast audit, formatters, dialog helper, glossary | **Done** |
| 1 | Brand, homepage, login | **Done** |
| 2 | App shell: header, avatar menu, dialogs | **Done** |
| 3 | Faculty setup screen and its backend rules | **Done** |
| 4 | Faculty live session | **Done** |
| 5 | Student screens | **Done** |
| 6 | Face enrolment pipeline | **Built, needs a real-phone check** (`docs/CHANGELOG-stage-6.md`) |
| 7 | Admin | Planned |
| 8 | Subject catalog (research spike, optional) | Planned |
| 9 | Polish and QA | Planned |

Each stage ships as a zip of changed files plus a short changelog. Nothing in a later stage starts until the earlier one is reviewed.

## Working rules

- **One-viewport rule.** Homepage, login and the faculty setup screen must fit without scrolling at 100% zoom. Test matrix: 1366×768 (about 650px of page height in Chrome), 1920×1080, 390×844, 360×640, and an 800×1280 portrait tablet.
- **Tokens only.** New colours go into `tokens.css` and must pass `npm run audit:contrast`.
- **Formats.** Dates and times come from `frontend/js/format.js`. No `toLocaleDateString` or `toLocaleTimeString`.
- **Dialogs.** Close on outside click unless the dialog has `data-modal="strict"` (term wizard, one-time password dialog, forms with unsaved changes).
- **Tests.** `npm test` stays green. Pure logic gets a test file in `tests/`.

## Decisions still open

| Decision | Needed by | Default if not answered |
|---|---|---|
| Admin "Classes" table: keep as is, or rename to "Classrooms" and group rows by classroom (`DS/AIML-5D` as one row) | Stage 7 | Keep "Classes" until decided |
| Academic year start month for the term picker | Stage 7 | July |
| ~~Middle-aligned roster checkbox vs. a conventional side checkbox~~ | Stage 4 | Decided: conventional left checkbox, whole row tappable |

---

## Stage 0: Foundations (done)

- `frontend/js/format.js`: DD/MM/YYYY dates, `1:30 pm` times, same on every device. Migrated `faculty.js`, `today.js`, `today-logic.js`, `profile.js`, `admin/home.js`.
- `frontend/utils/dialog.js`: click-outside-to-close helper, not yet wired.
- `tools/contrast-audit.mjs` and `docs/contrast-audit.md`: 29 pairs, light and dark.
- Tokens: `--card-edge`, `--control-edge`, stronger `--shadow-sm`; two marginal text pairs fixed.
- `docs/GLOSSARY.md`, `tests/` (14 tests).
- Not changed: `admin/timetable.js` date format (it mirrors the printed sheet).

## Stage 1: Brand, homepage, login (done)

- **Name and logo.** "Smart Attendance Marker" everywhere. The mark is a QR code with one cell replaced by a red check; two alternates are kept in `docs/brand-alternates/`.
- **White-label.** College name, short name and logo come from `utils/brand-config.js`; no rebuild needed. See `docs/BRAND.md`.
- **Homepage.** New copy ("Scan. Verify. Present."), college name always visible in the header, campus photo blended into the page, solid role cards, fits one screen from 360×640 up.
- **Login.** Split layout on wide screens with a per-role illustration and one line of copy; form alone on phones. Eye icon inside the password field, a real theme switch, no repeated logo or banner.
- **Backgrounds and foregrounds** documented per page in `docs/BRAND.md`.
- **Titles, favicon, `theme-color`** updated (the app pages get `theme-color` with the Stage 2 header).
- **Deviation from the plan:** on login the campus photo only appears on screens at least 820px tall, because on shorter screens it would sit under the text.

## Stage 2: App shell (done)

- **Header** on all three pages: product mark, college logo, and an avatar button. "Hi, X" / "Welcome, X", the Log out button and the old theme button are gone from the header.
- **Avatar menu:** name and role, dark-mode switch, Change password (student only), Log out.
- **Faculty live chip** in the header while a session runs (`● LIVE · DBMS · CSE 5A · 18/62`), opens the Session tab.
- **Nav:** one different inline icon per tab, coloured with the tab (active tab fully red).
- **Dialogs:** click outside closes by default; `guard` forms only while untouched (otherwise they shake); the term wizard and password dialog never close that way. Page behind a dialog does not scroll.
- `.alert-warning` moved to `components.css`; `tools/remove-unused-assets.mjs` lists unused icon files (663 KB on the current project).
- **Dropped:** removing the table ARIA roles. They are harmless and removing them gains nothing.
- **Left for later stages:** change password for faculty and admin needs a backend feature; the student's form becomes a dialog in Stage 5; the live chip's data has not been run against a real session.

## Stage 3: Faculty setup screen (needs backend changes)

**Goal:** a short setup screen that fits one viewport.

- **Layout.** Two columns on desktop (when and what on the left; room, method and start on the right). Single column on mobile.
- **Placeholder.** Show "Pick a class" until a slot is chosen, then the subject name. Do not list every subject up front.
- **Date control.** A chip showing `Tue, 20/10/2026` with previous and next day arrows and a full-size tap target. A native date input cannot show DD/MM/YYYY on every device, so the chip opens the native picker through a hidden input. Sits on the same row as session type.
- **Room** collapses to a "Room F-307 · change" chip.
- **Start button** says "Start session". When disabled it shows a short reason next to it.
- **Merge** is removed from Regular. The second session type, named **Extra**, covers extra classes, borrowed periods and merged classes, and only offers classes the faculty teaches. This removes `/merge-options` and the merge box.
- **Bug fix, `/arranged/slots`.** Any row with a different `faculty_id` is treated as a lender, so a NULL faculty (TRAINING, PLACEMENT PREP) becomes "Borrow from another faculty". Treat NULL-faculty rows and subjects that do not take attendance as free. Check `POST /arranged` for the same assumption.
- **Known limit:** restricting to classes the faculty teaches blocks substituting for a colleague's class. Revisit later as a separate "Substitute" flow.

## Stage 4: Faculty live session

**Goal:** more students visible, less chrome.

- **Session bar.** One compact bar: subject large, then `CSE · Sem 5 · A · F-307 · 10:00–10:50`, merged classes as chips, present count on the right (`18/62`). It replaces the "welcome, X" block.
- **Roster** fills the freed height with one internal scroll. Compact rows, two columns on wide screens.
- **Discard.** A dedicated button with danger styling, kept apart from Submit.
  - Allow discard when students are already marked: today the server refuses with `session_has_marks` (409). Add a force option behind a confirm dialog that states the count ("18 students marked present will be removed").
  - Write an audit-log row (who, when, how many).
  - Make the students' Today tab reflect it.
  - Only before submit. Editing a submitted session is a separate feature.
- **QR panel.** Remove the "QR refreshes automatically" line but keep a visible warning if refreshing fails. Fullscreen QR fills about the whole viewport, redraws crisply on resize, and keeps the present count visible.
- **Add manually dialog.**
  - Fix the two scrollbars: the dialog is a flex column and only the list scrolls.
  - Remove the "Tick the students…" line.
  - Search and select-all on one row.
  - Rows get separators, a tinted selected state with a check, and the whole row is tappable. Checkbox in the middle column (see open decisions).
  - Closes on outside click.
- **Reliability (from the first review).**
  - Resume a live session after a refresh (add an active-session endpoint).
  - Server-side History with a detail view, replacing `localStorage`.
  - Guard `io(...)` and load socket.io with a normal `<script defer>` instead of `document.write`.

## Stage 5: Student screens

**Goal:** consistent cards and clear periods.

- **Header and greeting.** Remove "Hi, X" from the header; keep the time-based greeting.
- **Today title.** "Today · Tue, 20 Oct" with the Today/Week switch beside it. Move the date out of the top.
- **Slot card.** Grid layout `[P3] Subject … time`, with the time never wrapping to a second line (the cause is `flex-wrap` on `.class-head`). Show the room only when it differs from the home room.
- **Double lecture.** One card with a "Double · P3–P4" badge and a stripe. Per-period chips appear only when the two periods have different states.
- **Week view** reuses the same row grid so days line up.
- **Attendance tab.** Colour the ring by status (it is always green now). Add dated records.
- **Profile.** A "Password" row that opens a change-password dialog with show/hide and a live rules checklist. It opens once automatically on first sign-in, with a "Later" option.
- Contrast check on all cards in light and dark.

## Stage 6: Face enrolment pipeline (test on an older phone)

**Goal:** responsive sliders, no dropped face, smaller upload.

- **Slider lag.** Measure first with the existing debug stats. Likely causes, in order:
  1. The display pose uses a One-Euro filter at 1.1 Hz, which is heavy smoothing.
  2. The capture loop is sequential (detect, assess, then up to 110 ms sleep) on single-thread WASM.
  3. `assessFrame` reads pixels every frame.

  Fixes: a lighter, velocity-predicted display pose separate from the steadier acceptance pose; light checks every third frame; `requestVideoFrameCallback`.
- **Dropped bounding box at extreme angles.** Three things can drop the face: the 0.7 detector threshold, `plausibleFace()` (assumes a near-frontal face), and the loop resetting everything on a single lost frame. Log which gate fires, then: lower threshold and yaw-aware plausibility on wide and deep shots, a grace window of about 400 ms, smoothing of the drawn box. Target angles stay as they are.
- **Text.** English-only status lines; the bilingual pose name stays the only Hindi. Remove directional hints ("more to the left", "chin down") from the visible UI and keep them as screen-reader-only announcements. Keep non-directional hints (light, distance, only one face).
- **Photos.** One photo per pose is uploaded. Both frames can still feed the embedding average.
- **Upload progress ring** using `XMLHttpRequest` (`fetch` cannot report upload progress), with retry.
- Remove the "What the camera saw" line (`enroll.js:249`); keep it behind `?debug=1`.

## Stage 7: Admin

- **Term wizard.** Year select plus ODD/EVEN. Offer only the current and future terms. No "Other". Academic-year start month defaults to July.
- **Year of passing.** Default derived from the class: `start year + ceil((9 − semester) / 2)`, so Sem 5 in 2026-27 gives 2028. Show a restricted dropdown to override. A fixed "current year +1 to +4" range would exclude final-year students in an even term.
- **Faculty abbreviation.** Live uniqueness check and a clear message on a 409. The database already enforces `UNIQUE`; the form just does not say so until save.
- **Credentials.** Username and password on one row, with the eye icon inside the password field. Remove Generate from the edit form. Add bulk "Generate passwords" with a CSV download. Keep a row-level **Reset password** action, because the login page tells students to ask the admin.
- **Terminology.** Apply the glossary decision on "Classes" vs "Classrooms".
- **Print timetable** defaults to all classrooms (`printAll.checked = false` at `timetable.js:501` becomes `true`).
- **Face photos.** An "i" popover on Check, with text taken from what `enroll_qa.py` actually checks. Show one photo per pose in the grid.

## Stage 8: Subject catalog (research spike, optional)

- A per-university catalog (university, course, branch, semester, then subject code, name, abbreviation, credits, L-T-P, whether it takes attendance), imported from a reviewed one-time extraction rather than scraped live.
- A catalog importer in the Setup wizard.
- Later: a faculty-subject mapping used as defaults in the timetable pickers.

## Stage 9: Polish and QA

- Accessibility pass: keyboard, focus order, labels, reduced motion.
- Remaining small items from the first review: unused assets, hard-coded hex colours in `admin.css`, 12px chart labels, empty states, polling replaced by socket updates where possible.
- Regression run on the full viewport matrix in light and dark.
- Before sharing the repo: make sure `.env`, `database.db`, `database.db-wal` and `database.db-shm` are not committed, and rotate anything in `.env` if they were.
