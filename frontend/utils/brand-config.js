// brand-config.js - the only file to edit to put another college's name and logo on the site.
//
// A plain script (not a module) loaded in <head> before js/brand.js. Nothing here needs a rebuild: change the
// text, drop the logo into frontend/icons/, and reload. The product name and mark stay the same for every college.
window.BRAND = {
  product: {
    name: 'Smart Attendance Marker',
  },
  institute: {
    name: 'Meerut Institute of Technology',
    short: 'MIT Meerut', // shown where the full name does not fit (phones)
    logo: 'icons/new-logo.webp', // path from the page, so keep logos in icons/
  },
};
