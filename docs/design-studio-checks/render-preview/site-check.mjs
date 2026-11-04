#!/usr/bin/env node
// node docs/design-studio-checks/render-preview/site-check.mjs [--out DIR]       (about half a minute; needs Chrome and `npm install` at the top)
//
// Does the REAL WEBSITE serve the improved preview, and does it draw what the check's own server draws? Starts the website the way the browser
// tests do (tests/dev/stack.mjs: the real website code with the real studio mounted, mock GPU services, no database, no Google key, nothing
// real reachable) twice, once with STUDIO_PREVIEW_OVERLAY=on (the default) and once with =off, and for each:
//   1. fetches the 14 module addresses of the preview and compares their bytes with the overlay / the studio (sha256 against manifest.json);
//   2. opens /design-studio in Chrome and lists which of those files the studio really loads at start-up, with the marker header and any console errors;
//   3. draws the four hand-masked scenes in Chrome from the modules the WEBSITE serves (the harness page is handed to the browser by this script, but
//      /js/lib/..., /textures and /media come from the website) and compares every picture with the same scene drawn from the check's own server:
//        overlay on  -> must equal `overlay`;   overlay off -> must equal `real`;   and `on` must differ from `off`.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { startStack } from '../../../tests/dev/stack.mjs';
import { REPO, makeWorkDir, openBrowser, pixelDiff, renderScene, startHarnessServer } from './lib.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const out = path.resolve(arg('out') || makeWorkDir('terucon-site-check-'));
fs.mkdirSync(out, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'site', 'overlays', 'studio', 'manifest.json'), 'utf8'));
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const SCENES = [['lobby', 'floor', 'oak-planks'], ['clinic', 'floor', 'oak-planks'], ['lobby', 'wall', 'brick'], ['clinic', 'wall', 'limewash']];
const GEOMS = ['estimate', 'plane'];
let failures = 0;
const check = (ok, what) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

const harness = await startHarnessServer({ port: Number(process.env.PORT) || 0 });
const browser = await openBrowser(out);
try {
  // the same scenes drawn from the check's own server: the references
  const local = {};
  for (const root of ['real', 'overlay']) {
    for (const [scene, surface, tex] of SCENES) {
      for (const geom of GEOMS) local[`${root}/${scene}-${surface}-${geom}`] = (await renderScene(browser, { origin: harness.origin, query: { root, scene, surface, geom, tex, backend: 'webgl2' } })).overlay;
    }
  }

  const sites = {};
  for (const mode of ['on', 'off']) {
    console.log(`\n== the website with STUDIO_PREVIEW_OVERLAY=${mode}`);
    const stack = await startStack({ port: mode === 'on' ? Number(process.env.SITE_PORT_ON) || 0 : Number(process.env.SITE_PORT_OFF) || 0, bootMs: 100, warmup: 'off', env: { AUTH_REQUIRED: 'off', STUDIO_PREVIEW_OVERLAY: mode } });
    try {
      console.log(`   ${stack.base}`);
      // 1. the bytes
      const files = Object.keys(manifest.upstream);
      let overlaid = 0;
      let studios = 0;
      for (const file of files) {
        const r = await fetch(`${stack.base}/${file}`);
        const bytes = Buffer.from(await r.arrayBuffer());
        const marker = r.headers.get('x-terucon-overlay');
        const isOverlaid = file in manifest.overlay;
        const expected = mode === 'on' && isOverlaid ? manifest.overlay[file] : manifest.upstream[file];
        const ok = r.status === 200 && sha(bytes) === expected && (marker !== null) === (mode === 'on' && isOverlaid) && r.headers.get('cache-control') === 'no-cache';
        if (ok) (mode === 'on' && isOverlaid ? (overlaid += 1) : (studios += 1));
        else check(false, `/${file}: status ${r.status}, marker ${marker}, cache-control ${r.headers.get('cache-control')}, sha ${sha(bytes).slice(0, 12)} (wanted ${expected.slice(0, 12)})`);
      }
      check(overlaid + studios === files.length, `${files.length} module addresses answered: ${overlaid} from the overlay (with the marker), ${studios} the studio's own (no marker), all with Cache-Control: no-cache`);
      check(mode === 'on' ? overlaid === Object.keys(manifest.overlay).length : overlaid === 0, mode === 'on' ? 'all 8 overlaid files came from the overlay' : 'none came from the overlay');

      // 2. the studio boots
      const page = await browser.newPage();
      const loaded = [];
      const problems = [];
      page.on('pageerror', (e) => problems.push(`script error: ${String(e).slice(0, 200)}`));
      page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`console error: ${m.text().slice(0, 200)}`));
      page.on('response', async (r) => {
        const url = new URL(r.url());
        if (r.status() >= 400 && !/\/favicon\.ico$|\/api\/vision\/warmup$|\/api\/rooms/.test(url.pathname)) problems.push(`http ${r.status()} ${url.pathname}`);
        if (/\/js\/lib\/(fastrender\/|previewScene)/.test(url.pathname)) loaded.push({ path: url.pathname, status: r.status(), marker: r.headers()['x-terucon-overlay'] ?? null, sha: sha(await r.buffer().catch(() => Buffer.alloc(0))).slice(0, 12) });
      });
      await page.goto(`${stack.base}/design-studio`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => /Add a room photo/.test(document.body.innerText), { timeout: 30000 });
      await new Promise((r) => setTimeout(r, 1500));
      await page.close();
      console.log('   the studio page opened ("Add a room photo" is on screen) and loaded these preview files at start-up:');
      for (const l of loaded.sort((a, b) => a.path.localeCompare(b.path))) console.log(`     ${l.status} ${l.path}  ${l.sha}  ${l.marker ? `[X-Terucon-Overlay: ${l.marker}]` : '[the studio\'s own]'}`);
      check(loaded.length > 0 && loaded.every((l) => l.status === 200 && (l.marker !== null) === (mode === 'on' && l.path.replace(/^\//, '') in manifest.overlay)), 'every preview file the studio loaded is the one expected for this setting');
      check(problems.length === 0, `no console errors, script errors or failed requests from the studio page${problems.length ? ': ' + problems.join('; ') : ''}`);

      // 3. the pictures
      let same = 0;
      let total = 0;
      const drawn = {};
      let sawOverlayScripts = 0;
      let sawStudioScripts = 0;
      const drawProblems = [];
      for (const [scene, surface, tex] of SCENES) {
        for (const geom of GEOMS) {
          const shot = await renderScene(browser, { origin: stack.base, fromSite: true, query: { root: 'site', modules: '/js/lib/fastrender/', scene, surface, geom, tex, backend: 'webgl2' } });
          drawProblems.push(...shot.problems);
          for (const s of shot.scripts) if (s.url.startsWith('/js/lib/fastrender/')) (s.overlay ? (sawOverlayScripts += 1) : (sawStudioScripts += 1));
          drawn[`${scene}-${surface}-${geom}`] = shot.overlay;
          fs.writeFileSync(path.join(out, `site-${mode}-${scene}-${surface}-${geom}.overlay.png`), shot.overlay);
          const want = local[`${mode === 'on' ? 'overlay' : 'real'}/${scene}-${surface}-${geom}`];
          const d = pixelDiff(want, shot.overlay);
          total += 1;
          if (d.maxDiff === 0 && d.onlyInA === 0 && d.onlyInB === 0) same += 1;
          else console.log(`     ${scene}-${surface}-${geom}: differs from the check's own render: ${JSON.stringify(d)}`);
        }
      }
      check(same === total, `${total} pictures drawn from the modules the website serves (WebGL2) are pixel-identical to the same scenes drawn from ${mode === 'on' ? 'the overlay' : 'the studio\'s own files'} by the check's own server (${same}/${total})`);
      check(mode === 'on' ? sawOverlayScripts > 0 : sawOverlayScripts === 0, `while drawing, the browser fetched ${sawOverlayScripts} module responses with the overlay marker and ${sawStudioScripts} without`);
      check(drawProblems.length === 0, `no console errors or failed requests while drawing${drawProblems.length ? ': ' + [...new Set(drawProblems)].join('; ') : ''}`);
      sites[mode] = drawn;
    } finally {
      await stack.stop();
    }
  }
  let differing = 0;
  for (const key of Object.keys(sites.on)) if (pixelDiff(sites.on[key], sites.off[key]).maxDiff > 8) differing += 1;
  check(differing === Object.keys(sites.on).length, `the switch matters: all ${differing} of ${Object.keys(sites.on).length} pictures differ (by more than 8 levels somewhere) between overlay on and off`);
} finally {
  await browser.close();
  await harness.close();
}
console.log(failures ? `\n${failures} check(s) FAILED. pictures: ${out}` : `\nall checks passed. pictures: ${out}`);
process.exit(failures ? 1 : 0);
