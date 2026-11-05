#!/usr/bin/env node
// One picture, for trying things out:
//   node docs/design-studio-checks/render-preview/render.mjs OUT.png key=value ...
// writes OUT.png (the photo with the finish drawn over it) and OUT.overlay.png (the canvas alone), and prints what the page reported.
// Keys (harness/run.js): root=real|overlay  scene=lobby|clinic|lobby-diag  surface=floor|wall  geom=estimate|plane|mock  tex=<a name from swatchroom/public/textures>
//   backend=webgl2|webgpu  rot=<degrees>  dpr=<device pixel ratio>  fw=<frame width>  pitch=<camera pitch, plane>  camh=<camera height m, plane>
//   tint=0 (draw without the light colour)  oldpattern=checker (stress: a strong checker on the old floor)
// Example:  node docs/design-studio-checks/render-preview/render.mjs /tmp/a.png root=overlay scene=clinic surface=wall tex=limewash geom=estimate
import fs from 'node:fs';
import path from 'node:path';
import { makeWorkDir, openBrowser, renderScene, startHarnessServer } from './lib.mjs';

const [, , out, ...pairs] = process.argv;
if (!out || /=/.test(out)) {
  console.error('usage: node render.mjs OUT.png key=value ...   (see the top of this file)');
  process.exit(2);
}
const query = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
const work = makeWorkDir();
const server = await startHarnessServer({ port: Number(process.env.PORT) || 0 });
const browser = await openBrowser(work);
try {
  const shot = await renderScene(browser, { origin: server.origin, query });
  fs.writeFileSync(out, shot.frame);
  fs.writeFileSync(out.replace(/\.png$/, '') + '.overlay.png', shot.overlay);
  console.log(JSON.stringify(shot.info));
  if (shot.problems.length) console.log('the page logged:\n  ' + shot.problems.join('\n  '));
  console.log(`wrote ${path.resolve(out)}`);
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(work, { recursive: true, force: true });
}
