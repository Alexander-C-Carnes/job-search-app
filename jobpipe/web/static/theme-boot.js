// Applies the saved look before the first paint, so the page doesn't flash another theme.
// The looks themselves (stylesheets and feedback moments) are in theme.js; this only reads the choice.
(function () {
  var look = null;
  try { look = localStorage.getItem("jobpipe-theme"); } catch (e) { /* storage blocked: use the default */ }
  document.documentElement.dataset.theme = /^[a-z]+$/.test(look || "") ? look : "sorbet";
})();
