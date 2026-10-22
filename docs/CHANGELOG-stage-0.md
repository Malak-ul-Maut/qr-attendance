# Stage 0: foundations

## Added
- `frontend/js/format.js`: one date and time formatter (DD/MM/YYYY, `1:30 pm`), the same on every device.
- `frontend/utils/dialog.js`: click-outside-to-close for `<dialog>`. Not wired into any page yet (Stage 2).
- `tools/contrast-audit.mjs` (`npm run audit:contrast`): checks 29 colour pairs in light and dark. Writes `docs/contrast-audit.md` with `--md`.
- `tests/` (`npm test`): 14 tests for the formatter and the dialog helper.
- `docs/GLOSSARY.md`: terms, formats and writing rules.

## Changed
- **Colours** (`tokens.css`): new `--card-edge` and `--control-edge`; stronger `--shadow-sm`; `--warning-600` and the dark `--red-50` adjusted. Two text pairs that were just under 4.5:1 now pass.
- Applied to: `.card`, `.input`, `.btn-secondary`, `.segmented`, `.icon-btn`, student `.slider-icon`, faculty `.slot-body`, admin `.adm-table-wrap`, `.adm-state`, `.adm-term`, `.adm-seg`.
- **Dates and times** now come from `format.js` in `faculty.js`, `today.js`, `today-logic.js`, `profile.js` and `admin/home.js`. Visible effect: numeric dates are DD/MM/YYYY, and times are `10:42 am` instead of whatever the device's locale printed.

## Not changed
- `admin/timetable.js` keeps its own date format because it prints the timetable sheet ("w.e.f. 05 Oct 2026").
- Old faculty History entries keep the time text they were saved with.

## Moved to Stage 2
- The avatar-menu component. It needs the real header markup to be built against.
