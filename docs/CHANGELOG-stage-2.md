# Stage 2: app shell

Apply Stages 0 and 1 first. `faculty.js`, `profile.js` and `components.css` here already include their changes.

## Added
- **Avatar menu** (`js/account-menu.js`) on the student, faculty and admin pages: initials button, then a panel with name and
  role, the dark-mode switch, **Change password** (student only) and **Log out**. Escape, a click outside or tabbing away closes it.
- **Live session chip** in the faculty header: `● LIVE  DBMS · CSE 5A + CSE 5B  18 / 62`. It shows on every tab while a session runs
  and opens the Session tab when tapped. On phones it shrinks to `LIVE 18 / 62`.
- **Dialog behaviour set in the HTML** (`data-modal`): nothing = closes on outside click; `guard` = closes only while nothing has been
  typed, otherwise the dialog shakes; `strict` = never closes on outside click. See `utils/dialog.js`.
- **Page behind an open dialog no longer scrolls.**
- **`tools/remove-unused-assets.mjs`**: lists (and with `--delete` removes) files in `frontend/icons` that nothing refers to.
- **Tests**: 11 more (`npm test` now runs 28).

## Changed
- **Header** on all three pages: product mark and name, the college logo (short name on wide screens), avatar. The "Hi, X" and
  "Welcome, X" text, the Log out button and the old theme button are gone from the header.
- **Nav icons** are inline SVG, one different icon per tab, and take the tab's colour (the active tab is now fully red).
  Student: home, check-circle, user. Faculty: QR, history. Admin: home, sliders, calendar, face-scan.
- **Student Profile** no longer has its own "Session / Log out" card; the menu is the one place to log out.
- **`theme.js`** handles clicks on the whole document, so controls added later (the menu) work. It exposes `window.syncThemeControls()`.
- **`.alert-warning`** moved from `faculty.css` to `components.css`.
- `brand.css` phone rules are scoped to the public header so they cannot touch the app header.
- Page `<meta name="theme-color">` added to the three app pages. Dead header rules removed from `admin.css`.

## Which dialogs do what
| Behaviour | Dialogs |
|---|---|
| Closes on outside click | Admin: detail, photos, print. Faculty: discard, submit, add manually |
| `guard`: closes unless edited | Admin: add/edit, split, import, publish, timetable cell, delete |
| `strict`: never | Admin: term wizard, one-time password |

The student page has no `<dialog>` elements (its scan and photo screens are full-screen overlays), so it does not load the helper.

## Not done, and why
- **Redundant ARIA roles on admin tables: left alone.** My first review called them redundant. They are harmless, and removing
  them has no benefit for anyone, so it is not worth the risk.
- **Change password for faculty and admin: not in the menu.** There is no such feature in the backend yet; only students have one.
- **Student "Change password"** opens the form on the Profile tab until Stage 5 turns it into a dialog.
- **Live chip with a real session: not exercised.** The chip's layout, show/hide and phone size were checked, and its data comes from
  the same `renderSessionHeader()` that feeds the session bar. Starting a session needs the backend.
- The older `.theme-toggle` button styles stay in `components.css` for now; nothing uses them.

## Cleaning up the icons folder
`node tools/remove-unused-assets.mjs` on your project lists 21 files, 663 KB: the old nav icons (home, courses, student, timetable,
history), `dark-theme`, `feedback`, `fullscreen`, `hamburger-menu`, `logout`, `logout-black`, `teacher`, `view-password`, and the
old campus photos and logo. Run it, read the list, then `--delete`.

Two of those are originals you may want to keep somewhere outside the website folder first:
`mit-logo.png` (2599 px logo master) and `mit-building (b block).jpg` (the source of `campus.webp`).

## Checked
- 88 browser checks across the three pages: avatar and initials, open, close (Escape, outside, Tab), theme switch, Log out,
  Change password routing, nav icons and active colour, header contents, every dialog policy, scroll lock, nudge.
- The Stage 1 fit and interaction checks still pass on the combined tree.
- 28 unit tests, contrast audit 0 failures.
- One bug found and fixed during checking: the admin menu printed a stray "null" where Change password would be.
