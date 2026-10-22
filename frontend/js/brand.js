// brand.js - writes the names and logo from utils/brand-config.js into the page. Loaded with `defer`.
//
// Mark an element and it is filled in:
//   <span data-brand="product-name">      -> "Smart Attendance Marker"
//   <span data-brand="institute-name">    -> "Meerut Institute of Technology"
//   <span data-brand="institute-short">   -> "MIT Meerut"
//   <img  data-brand-logo>                -> the institute logo
// The HTML already holds the default text, so a page still reads correctly if this script never runs.
(function () {
  var b = window.BRAND || {};
  var product = (b.product && b.product.name) || 'Smart Attendance Marker';
  var inst = b.institute || {};

  // "Sign in as student | Smart Attendance Marker", or "Smart Attendance Marker | Meerut Institute of Technology"
  window.brandTitle = function (label) {
    return label ? label + ' | ' + product : inst.name ? product + ' | ' + inst.name : product;
  };

  var text = { 'product-name': product, 'institute-name': inst.name, 'institute-short': inst.short || inst.name };
  document.querySelectorAll('[data-brand]').forEach(function (el) {
    var value = text[el.getAttribute('data-brand')];
    if (value) el.textContent = value;
  });
  document.querySelectorAll('img[data-brand-logo]').forEach(function (img) {
    if (inst.logo) img.src = inst.logo;
  });
  var home = document.body && document.body.hasAttribute('data-home-title');
  if (home) document.title = window.brandTitle();
})();
