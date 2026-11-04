#!/usr/bin/env node
// ONE COMMAND:   node docs/design-studio-checks/render-preview/run-all.mjs        (under a minute; needs Chrome and `npm install` at the top)
//   --out DIR      where the pictures go (default: a new folder under the system's temp directory; nothing is written into the project)
//   --grids DIR    also copy the four GRID-*.jpg there
//   PORT=8801      the port of the check's own little server (default: any free one)
//
// Draws the SAME hand-masked photos two ways in a real browser, with the real WebGL2 and WebGPU backends:
//   real      the studio's own preview code (swatchroom/public/js/lib/fastrender/)
//   overlay   the improved preview code the website serves (site/overlays/studio/)
// each with the studio's own "estimate" geometry (what a photo gets before the room analysis is back: provisional.js on the masks) and with
// a hand-built level-camera plane (a stand-in for a good fit; the real fused fit needs the live GPU services and is NOT covered here).
// Prints the light measurements and the WebGL2 vs WebGPU differences, and writes the pictures. See README.md for what they mean.
import fs from 'node:fs';
import path from 'node:path';
import { HERE, REPO, lightMetrics, makeGrid, makeWorkDir, openBrowser, pixelDiff, renderScene, startHarnessServer } from './lib.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const out = path.resolve(arg('out') || makeWorkDir());
const gridsDir = arg('grids') ? path.resolve(arg('grids')) : null;
fs.mkdirSync(out, { recursive: true });
if (gridsDir) fs.mkdirSync(gridsDir, { recursive: true });

const JOBS = [
  { scene: 'lobby', surface: 'floor', tex: 'oak-planks', photo: 'p02-lobby.jpg' },
  { scene: 'clinic', surface: 'floor', tex: 'oak-planks', photo: 'p04-clinic.jpg' },
  { scene: 'lobby', surface: 'wall', tex: 'brick', photo: 'p02-lobby.jpg' },
  { scene: 'clinic', surface: 'wall', tex: 'limewash', photo: 'p04-clinic.jpg' },
];
const ROOTS = ['real', 'overlay'];
const LABEL = { real: 'REAL (the studio\'s own)', overlay: 'OVERLAY (the website\'s)' };

const server = await startHarnessServer({ port: Number(process.env.PORT) || 0 });
const browser = await openBrowser(out);
const summary = { out, origin: server.origin, jobs: [] };
const problems = [];
try {
  for (const job of JOBS) {
    const name = `${job.scene}-${job.surface}`;
    const photo = fs.readFileSync(path.join(REPO, 'media', job.photo));
    const shots = {};
    const record = { name, tex: job.tex, light: {}, parity: {} };
    for (const root of ROOTS) {
      for (const geom of ['estimate', 'plane']) {
        const shot = await renderScene(browser, { origin: server.origin, query: { root, scene: job.scene, surface: job.surface, geom, tex: job.tex, backend: 'webgl2' } });
        shots[`${root}-${geom}`] = shot;
        fs.writeFileSync(path.join(out, `${name}-${root}-${geom}.png`), shot.frame);
        fs.writeFileSync(path.join(out, `${name}-${root}-${geom}.overlay.png`), shot.overlay);
        problems.push(...shot.problems.map((p) => `${name} ${root} ${geom}: ${p}`));
        if (geom === 'plane') record.light[root] = lightMetrics(photo, shot.frame, shot.overlay);
      }
    }
    // WebGL2 against WebGPU, for the surfaces drawn on the hand-built plane (a backend may not exist on this computer)
    for (const root of ROOTS) {
      try {
        const gpu = await renderScene(browser, { origin: server.origin, query: { root, scene: job.scene, surface: job.surface, geom: 'plane', tex: job.tex, backend: 'webgpu' } });
        fs.writeFileSync(path.join(out, `${name}-${root}-plane-webgpu.overlay.png`), gpu.overlay);
        record.parity[root] = { backend: gpu.info.backend, ...pixelDiff(shots[`${root}-plane`].overlay, gpu.overlay) };
        problems.push(...gpu.problems.map((p) => `${name} ${root} webgpu: ${p}`));
      } catch (error) {
        record.parity[root] = { skipped: String(error.message).slice(0, 200) };
      }
    }
    const grid = await makeGrid(browser, [
      { label: `${LABEL.real}, estimate geometry`, png: shots['real-estimate'].frame },
      { label: `${LABEL.overlay}, estimate geometry`, png: shots['overlay-estimate'].frame },
      { label: `${LABEL.real}, hand-built plane (stand-in for a good fit)`, png: shots['real-plane'].frame },
      { label: `${LABEL.overlay}, hand-built plane`, png: shots['overlay-plane'].frame },
    ]);
    fs.writeFileSync(path.join(out, `GRID-${name}.jpg`), grid);
    if (gridsDir) fs.writeFileSync(path.join(gridsDir, `GRID-${name}.jpg`), grid);
    summary.jobs.push(record);

    console.log(`\n${name} (${job.tex})`);
    for (const root of ROOTS) console.log(`  light, ${root.padEnd(7)}`, JSON.stringify(record.light[root]));
    for (const root of ROOTS) console.log(`  WebGL2 vs WebGPU, ${root.padEnd(7)}`, JSON.stringify(record.parity[root]));
  }
} finally {
  await browser.close();
  await server.close();
}
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
if (problems.length) console.log(`\nwarnings or errors the pages logged (${problems.length}):\n  ${problems.join('\n  ')}`);
else console.log('\nthe pages logged no console warnings or errors');
console.log(`\ndone. pictures: ${out}`);
