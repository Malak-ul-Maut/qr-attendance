# Brand and white-labelling

## What is fixed, what changes per college

| Fixed for every college | Set per college |
|---|---|
| Product name: **Smart Attendance Marker** | College name, short name and logo |
| Logo mark (`frontend/brand/mark.svg`, inline in the page headers) | Everything in `frontend/utils/brand-config.js` |
| Colours, type and layout | |

## Putting another college on the site

1. Drop the college logo into `frontend/icons/` (a transparent or white-background image; it is shown on a white chip).
2. Edit `frontend/utils/brand-config.js`:

```js
window.BRAND = {
  product: { name: 'Smart Attendance Marker' },
  institute: {
    name: 'Example College of Engineering',
    short: 'Example CE',          // used on phones where the full name will not fit
    logo: 'icons/example-logo.webp',
  },
};
```

3. Reload. No build step. `js/brand.js` fills every element marked `data-brand="institute-name"`,
   `data-brand="institute-short"`, `data-brand="product-name"` and `<img data-brand-logo>`, and builds the page titles.

`npm test` checks that the file has every field and that the logo it names exists.

## The mark

A QR code with one cell replaced by a red check: the three finder squares are ink (they follow light and dark), and
the checked cell is the brand red. It reads as "QR attendance" at a glance and still holds at 24px.

- In pages: inline SVG, classes `mk-ring`, `mk-dot`, `mk-cell`, `mk-tick` in `css/brand.css`.
- As a file: `brand/mark.svg` (light backgrounds) and `brand/favicon.svg` (switches to light ink in a dark browser tab).
- Two alternates were drawn and are kept in `docs/brand-alternates/`: a viewfinder with a check, and a face in a
  viewfinder with a check badge.

Do not recolour the check cell or put the mark on a red background.

## Backgrounds and foregrounds

| Page | Background | Foreground | Why |
|---|---|---|---|
| Homepage | Page colour with the campus photo rising from the bottom right | Text on the plain page colour; role cards are solid with a visible edge | No text sits on the photo |
| Login (wide) | Plain page colour; campus photo fades in at the bottom left only on screens at least 820px tall | Illustration and copy above it; form in a solid card | The photo never sits under text |
| Login (phone) | Plain page colour | Form in a solid card | Keeps the form quiet on a small screen |
| App pages (student, faculty, admin) | Plain page colour | Solid cards with the Stage 0 edges | Content first |

The campus photo's sky is almost white. In light mode it is multiplied into the page colour so the sky disappears
and no rectangle shows; in dark mode it is dimmed to a low-opacity backdrop.
