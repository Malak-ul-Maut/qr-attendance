# Stage 1: brand, homepage, login

Apply Stage 0 first: `components.css` here includes the Stage 0 colour changes.

## Added
- **Logo mark and favicon** (`frontend/brand/mark.svg`, `favicon.svg`). Alternates in `docs/brand-alternates/`.
- **White-label config** (`utils/brand-config.js`, `js/brand.js`). See `docs/BRAND.md`.
- **`css/brand.css`**: shared header, mark, college lockup and campus backdrop.
- **Theme switch** (`.theme-switch` in `components.css`): a real switch with `role="switch"` and `aria-checked`.
- **`icons/campus.webp`**: 89 KB, from the 2048px B-block photo. The old 1300px panorama was upscaled on large screens.
- **`tests/brand.test.mjs`** (3 tests). `npm test` now runs 17.

## Changed
- **Homepage**: new copy ("Scan. Verify. Present."), college name always in the header, campus photo blended into the page,
  solid role cards, fits one screen from 360×640 up.
- **Login**: split layout on wide screens (role illustration and one line of copy on the left); form alone on phones.
  The college logo and photo banner inside the card are gone. Eye icon replaces the "Show" text. Theme switch replaces
  the theme button. Fits one screen at every size tested.
- **Phones**: header becomes two rows (product and switch, then the full college name).
- **Page titles and favicon** on student, faculty and admin pages now use the product name.
- **`theme.js`** drives both the new switch and the older icon button (still used by the three app pages until Stage 2). It also
  keeps `<meta name="theme-color">` in step with the theme.
- **Glossary**: session type is "Extra".

## Checked
- Fit without scrolling: home and all three logins at 1366×657, 1920×950, 390×844, 360×640 and 800×1280, light and dark.
- 34 browser checks: switch state and persistence, keyboard (Space, Tab order), eye toggle, one illustration per role,
  titles, redirect without a role, white-label override, no console errors, no failed requests.
- `npm run audit:contrast`: 0 failures.

## Not in this stage
- The college name and theme switch in the **app** pages' headers move into the avatar menu in Stage 2.
- `theme-color` meta is on the homepage and login only; the app pages get it with the Stage 2 header.
