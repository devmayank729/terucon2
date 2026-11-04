// (The loader runs from a blob address, where a bare "/path" cannot be resolved: both imports are made absolute with new URL, as the export's own loader does.)
// Terucon: the catalogue's designs are added to the studio's finish list first (site/catalogue-ui/studio-finishes.js, waits at most 4 s), then the studio starts, whatever happened.
(function () {
  var begin = function () { return import(new URL("/js/swatchroom-app.js", window.location.href).href); };
  import(new URL("/catalogue-ui/assets/studio-finishes.js", window.location.href).href).then(function (mod) { return mod.addCatalogueFinishes(); }).catch(function () {}).then(begin);
})();
