#!/usr/bin/env node
// Writes site/brand/preview.html: a local page (not served: the site only serves css, js, svg, png, webp, ico, json
// and webmanifest from this folder) for looking at the brand pieces. Open it straight from the folder:
//   node site/brand/build-preview.mjs && open site/brand/preview.html
// It replays loader.html inside frames, and shows the header-logo options, the favicon set and the share image.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// the loader refers to /brand/...; from this local page the same files are next to it
const loader = fs.readFileSync(path.join(here, 'loader.html'), 'utf8').replaceAll('/brand/', './').replaceAll('</script>', '<\\/script>');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Terucon brand preview</title>
<link rel="stylesheet" href="brand.css">
<style>
body{margin:0;background:#2a2118;color:#E1D4C2;font:14px/1.5 "Helvetica Neue",Helvetica,Arial,sans-serif;padding:24px}
h1{font:300 28px/1.2 Georgia,serif;margin:0 0 4px}h2{font:600 12px/1 sans-serif;letter-spacing:.2em;text-transform:uppercase;color:#A78D78;margin:34px 0 12px}
p.note{margin:0 0 14px;color:#BEB5A9;max-width:70ch}
.row{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
button{font:500 13px sans-serif;min-height:40px;padding:0 16px;border-radius:999px;border:1px solid #6E473B;background:#E1D4C2;color:#291C0E;cursor:pointer}
button.ghost{background:transparent;color:#E1D4C2}
label{font-size:13px;color:#BEB5A9;display:inline-flex;gap:6px;align-items:center}
.frame{border:1px solid #6E473B;border-radius:10px;overflow:hidden;background:#fff}
.frame iframe{display:block;border:0;background:#E1D4C2}
.cap{font-size:12px;color:#A78D78;margin-top:6px}
.sw{display:flex;flex-direction:column;align-items:flex-start;gap:14px;padding:16px 18px;border-radius:10px;min-width:300px}
.sw.dark{background:#1F150A}.sw.cream{background:#E1D4C2}.sw.white{background:#fff}
.sw small{font-size:11px;color:#8f7a68}
.h28{height:28px}.h36{height:36px}.h44{height:44px}
.rejected{height:36px;overflow:hidden;aspect-ratio:1325/(842*.835)}.rejected img{height:calc(36px/.835);display:block}
.mask{width:96px;height:96px;border-radius:50%;overflow:hidden;display:inline-block;background:#1F150A}
.mask img{width:100%;display:block}
.tab{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;font-size:13px}
</style></head><body>
<h1>Terucon brand preview</h1>
<p class="note">Everything here is read from the files next to this page. Nothing is served by the website. Re-run <code>node site/brand/build-preview.mjs</code> after changing loader.html.</p>

<h2>Loader</h2>
<p class="note">Each button reloads the frame with a fake page behind the loader. "Slow" opens after 5 s, "Fast" after 0.4 s. For the reduced-motion version turn on Reduce motion in the system settings (or the browser's Rendering panel) and replay.</p>
<div class="row" style="margin-bottom:12px">
<button data-play="slow">Slow page (5 s)</button><button data-play="fast">Fast page (0.4 s)</button><button data-play="never">Never opens (fails after 12 s)</button><button data-play="fail" class="ghost">Show the failure screen now</button>
<label><input type="checkbox" id="again"> Return visit (short version)</label>
</div>
<div class="row">
<div><div class="frame" style="width:390px"><iframe id="fm" width="390" height="700" title="Loader on a phone"></iframe></div><div class="cap">390 x 700</div></div>
<div><div class="frame" style="width:760px;max-width:100%"><iframe id="fd" width="760" height="470" title="Loader on a laptop"></iframe></div><div class="cap">760 x 470</div></div>
</div>

<h2>Header logo (emblem + wordmark, cropped from the real artwork)</h2>
<p class="note">Chosen: one line, emblem left, TERUCON right (logo-header-*.webp). On cream pages use <code>tc-logo--on-light</code> (dark pill). The stacked crop was rejected: its letters are about 7 px tall at a 36 px header.</p>
<div class="row">
<div class="sw dark"><small>on #1F150A</small>
<img class="tc-logo h28" src="logo-header-480.webp" alt="" style="width:auto"><img class="tc-logo h36" src="logo-header-480.webp" alt="" style="width:auto"><img class="tc-logo h44" src="logo-header-480.webp" alt="" style="width:auto"></div>
<div class="sw cream"><small>on #E1D4C2, plain (weak)</small>
<img class="tc-logo h28" src="logo-header-480.webp" alt="" style="width:auto"><img class="tc-logo h36" src="logo-header-480.webp" alt="" style="width:auto"><img class="tc-logo h44" src="logo-header-480.webp" alt="" style="width:auto"></div>
<div class="sw cream"><small>on #E1D4C2 with tc-logo--on-light</small>
<img class="tc-logo tc-logo--on-light h28" src="logo-header-480.webp" alt="" style="width:auto"><img class="tc-logo tc-logo--on-light h36" src="logo-header-480.webp" alt="" style="width:auto"><img class="tc-logo tc-logo--on-light h44" src="logo-header-480.webp" alt="" style="width:auto"></div>
<div class="sw white"><small>on white, with tc-logo--on-light</small>
<img class="tc-logo tc-logo--on-light h36" src="logo-header-480.webp" alt="" style="width:auto"></div>
<div class="sw dark"><small>rejected: stacked crop of the full lockup</small><div class="rejected"><img src="logo-full-1200.webp" alt=""></div></div>
</div>

<h2>Full lockup and mark</h2>
<div class="row">
<div class="sw dark"><img class="tc-logo tc-logo--full" src="logo-full-640.webp" alt=""></div>
<div class="sw cream"><img class="tc-logo tc-logo--full tc-logo--on-light" src="logo-full-640.webp" alt=""></div>
<div class="sw dark"><img class="tc-logo tc-logo--mark" src="logo-mark-256.webp" alt=""></div>
</div>

<h2>Favicon, app icons, share image</h2>
<div class="row">
<div class="tab" style="background:#fff;color:#222"><img src="favicon-32.png" width="16" height="16" alt="">Terucon India <img src="favicon-32.png" width="32" height="32" alt=""></div>
<div class="tab" style="background:#202124;color:#eee"><img src="favicon-32.png" width="16" height="16" alt="">Terucon India <img src="favicon-32.png" width="32" height="32" alt=""></div>
<div class="tab" style="background:#dee1e6;color:#222"><img src="favicon-32.png" width="16" height="16" alt="">Terucon India <img src="favicon-32.png" width="32" height="32" alt=""></div>
</div>
<div class="row" style="margin-top:14px;align-items:flex-end">
<div><img src="apple-touch-icon.png" width="120" style="border-radius:27px;display:block"><div class="cap">apple-touch-icon 180</div></div>
<div><img src="icon-192.png" width="120" style="border-radius:27px;display:block"><div class="cap">icon-192</div></div>
<div><img src="icon-512.png" width="120" style="display:block"><div class="cap">icon-512</div></div>
<div><span class="mask"><img src="icon-maskable-512.png" alt=""></span><div class="cap">maskable, circle crop</div></div>
<div><img src="og-image.jpg" width="360" style="display:block;border-radius:6px"><div class="cap">og-image 1200 x 630</div></div>
</div>

<script type="text/plain" id="loader-src">${loader}</script>
<script>
(function () {
  var src = document.getElementById('loader-src').textContent.split('<\\\\/script>').join('<' + '/script>');
  function page(mode, again) {
    var open = mode === 'slow' ? 5000 : mode === 'fast' ? 400 : null;
    var after = open !== null ? 'setTimeout(function(){TeruconLoader.done()},' + open + ');' : mode === 'fail' ? 'setTimeout(function(){TeruconLoader.fail()},700);' : '';
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
      '<body style="margin:0;background:#E1D4C2;color:#291C0E;font:16px Georgia,serif">' +
      '<script>try{sessionStorage.' + (again ? 'setItem("tc-ld","1")' : 'removeItem("tc-ld")') + '}catch(e){}<\\/script>' + src +
      '<main style="padding:48px 24px"><h1 style="font:300 40px/1.05 Georgia,serif;margin:0 0 16px">The page behind the loader</h1><p>This is what the visitor sees once the louvres open.</p><div style="height:220px;background:linear-gradient(135deg,#6E473B,#A78D78);margin-top:24px"></div></main>' +
      '<script>' + after + '<\\/script></body></html>';
  }
  function play(mode) {
    ['fm', 'fd'].forEach(function (id) {
      var f = document.getElementById(id), d = f.contentDocument;
      d.open(); d.write(page(mode, document.getElementById('again').checked)); d.close();
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-play]'), function (b) { b.addEventListener('click', function () { play(b.getAttribute('data-play')); }); });
  play('slow');
})();
</script>
</body></html>
`;
fs.writeFileSync(path.join(here, 'preview.html'), html);
console.log('wrote site/brand/preview.html', html.length, 'bytes');
