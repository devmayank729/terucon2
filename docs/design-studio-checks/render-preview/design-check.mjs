#!/usr/bin/env node
// node docs/design-studio-checks/render-preview/design-check.mjs [--designs DIR] [--out DIR] [--grids DIR]     (about a minute; needs Chrome and `npm install` at the top)
//
// Does a CATALOGUE DESIGN (the 800 x 1220 photograph of a sheet, a `texture` with previewTileWidthM / previewTileHeightM and a sheen, exactly as
// server/catalogue/studioFinishes.js textureOf() states it) draw in the instant preview, on every kind of surface it is offered for: a wall, a
// door and a cabinet front, and on a sofa (not a plane: the limit of the estimate)? Before 2026-11-05 none of them did: the designs had no
// `texture` and a door or a piece of furniture had no fit. It draws, in a real Chrome with the real WebGL2 backend (and WebGPU where this
// computer has it), the clinic photo with four hand-outlined surfaces (harness/design-scenes.json) with the overlay's modules (the ones the
// website serves) and writes one GRID-design-<id>.jpg per design. It calls no live service and needs no network.
//
//   --designs DIR   the folder of the designs' photographs, tipl-<code>.jpg. They are no longer files of this project (they are read from your Cloud
//                   Storage bucket by the website): by default they are taken out of the git history, where the last copy is (the parent of ad91318).
//   --out DIR       where the pictures go (default: a new folder under the system's temp directory); --grids DIR also copies the grids there
//
// What it asserts (exit code 1 if any fails): for every design and surface the renderer gave the surface a slot, the finish was applied, the canvas has
// painted pixels, and the painted pixels are not one flat colour (the design's own pattern is on the surface). What it cannot tell: whether the picture
// looks right. That is for the eyes: look at the grids.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { textureOf } from '../../../server/catalogue/studioFinishes.js';
import { REPO, makeGrid, makeWorkDir, openBrowser, renderScene, startHarnessServer } from './lib.mjs';

const { PNG } = createRequire(path.join(REPO, 'package.json'))('pngjs');
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const out = path.resolve(arg('out') || makeWorkDir('terucon-design-check-'));
const gridsDir = arg('grids') ? path.resolve(arg('grids')) : null;
fs.mkdirSync(out, { recursive: true });
if (gridsDir) fs.mkdirSync(gridsDir, { recursive: true });

// the designs' photographs
let designsDir = arg('designs') ? path.resolve(arg('designs')) : null;
if (!designsDir) {
  const local = path.join(REPO, 'media', 'materials');
  if (fs.existsSync(local) && fs.readdirSync(local).some((f) => /^tipl-.*\.jpg$/.test(f))) designsDir = local;
  else {
    const dir = path.join(out, 'designs');
    fs.mkdirSync(dir, { recursive: true });
    const tar = execFileSync('git', ['archive', 'ad91318^', 'media/materials'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dir], { input: tar });
    designsDir = path.join(dir, 'media', 'materials');
  }
}
const detail = JSON.parse(fs.readFileSync(path.join(REPO, 'catalogue', 'data', 'superbond-colour-detail.json'), 'utf8')).designs;

const DESIGNS = process.env.DESIGN_IDS ? process.env.DESIGN_IDS.split(',') : ['tipl-sb804', 'tipl-sb008', 'tipl-cmt6001', 'tipl-sb801']; // DESIGN_IDS=tipl-a,tipl-b draws other designs
const SURFACES = [
  ['wall', 'wall (right)'],
  ['door', 'door (left glass panel)'],
  ['furniture', 'cabinet front (reception desk)'],
  ['sofa', 'sofa (not a plane)'],
];
let failures = 0;
const check = (ok, what) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

/** How many pixels the render painted, and how much they vary (standard deviation of the luma). */
function paintStats(png) {
  const { data, width, height } = PNG.sync.read(png);
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 255) continue;
    const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    n += 1;
    sum += luma;
    sumSq += luma * luma;
  }
  const mean = n ? sum / n : 0;
  return { painted: n, share: +(n / (width * height)).toFixed(4), meanLuma: +mean.toFixed(1), lumaStdDev: +Math.sqrt(Math.max(0, (n ? sumSq / n : 0) - mean * mean)).toFixed(1) };
}

const server = await startHarnessServer({ port: Number(process.env.PORT) || 0, extraMaps: [['/media/materials/', [designsDir]]] });
const browser = await openBrowser(out);
const summary = { out, designsDir, designs: [] };
try {
  for (const id of DESIGNS) {
    if (!fs.existsSync(path.join(designsDir, `${id}.jpg`))) {
      check(false, `${id}: no photograph in ${designsDir}`);
      continue;
    }
    const studio = detail[id.toUpperCase()];
    const texture = textureOf({ id, studio }); // exactly what the website's server states for this design: address (with ?tone= for a bold design), tile size, sheen
    console.log(`\n${id}  (${studio ? `${studio.pattern}, ${studio.sheen}, ${studio.scale}` : 'not described'}) texture: ${texture.url}`);
    const shots = [];
    const record = { id, sheen: studio?.sheen ?? null, surfaces: {} };
    for (const [surface, label] of SURFACES) {
      const query = { root: 'overlay', scenes: 'design-scenes.json', scene: 'clinic-designs', surface, geom: 'estimate', tex: id, texurl: texture.url, backend: 'webgl2', ...(texture.sheen ? { sheen: texture.sheen } : {}) };
      const shot = await renderScene(browser, { origin: server.origin, query });
      fs.writeFileSync(path.join(out, `${id}-${surface}.png`), shot.frame);
      fs.writeFileSync(path.join(out, `${id}-${surface}.overlay.png`), shot.overlay);
      const stats = paintStats(shot.overlay);
      record.surfaces[surface] = { ok: shot.info.ok, hasRegion: shot.info.hasRegion, sizeM: shot.info.estimate?.[surface]?.sizeM ?? null, ...stats, problems: shot.problems };
      check(shot.info.hasRegion === true && shot.info.ok === true, `${surface}: the renderer gave the surface a slot (hasRegion ${shot.info.hasRegion}) and applied the finish (ok ${shot.info.ok})`);
      check(stats.share > 0.005, `${surface}: painted ${stats.painted} pixels (${(100 * stats.share).toFixed(1)} % of the canvas)`);
      check(stats.lumaStdDev > 4, `${surface}: not one flat colour (luma standard deviation ${stats.lumaStdDev})`);
      check(shot.problems.length === 0, `${surface}: the page logged no warning or error${shot.problems.length ? `: ${shot.problems.join(' | ')}` : ''}`);
      shots.push({ label: `${label}`, png: shot.frame });
    }
    // WebGPU on the same wall and door, where this computer has it (the two backends should agree: shaders/swap.glsl.js and swap.wgsl.js)
    for (const surface of ['wall', 'door']) {
      try {
        const gpu = await renderScene(browser, { origin: server.origin, query: { root: 'overlay', scenes: 'design-scenes.json', scene: 'clinic-designs', surface, geom: 'estimate', tex: id, texurl: texture.url, backend: 'webgpu', ...(texture.sheen ? { sheen: texture.sheen } : {}) } });
        const stats = paintStats(gpu.overlay);
        record.surfaces[surface].webgpu = { ok: gpu.info.ok, painted: stats.painted };
        check(gpu.info.ok === true && stats.painted > 0, `${surface}: WebGPU draws it too (${stats.painted} pixels)`);
      } catch (error) {
        record.surfaces[surface].webgpu = { skipped: String(error.message).slice(0, 120) };
        console.log(`  --   ${surface}: WebGPU not available here (${String(error.message).slice(0, 80)})`);
      }
    }
    const grid = await makeGrid(browser, shots);
    fs.writeFileSync(path.join(out, `GRID-design-${id}.jpg`), grid);
    if (gridsDir) fs.writeFileSync(path.join(gridsDir, `GRID-design-${id}.jpg`), grid);
    summary.designs.push(record);
  }
  // what the studio's OWN preview code does with the same finish (the "before"): no fit for a door or a piece of furniture
  console.log('\nthe studio\'s own preview code (root=real) with the same finish, for the record:');
  for (const [surface] of SURFACES) {
    try {
      const shot = await renderScene(browser, { origin: server.origin, query: { root: 'real', scenes: 'design-scenes.json', scene: 'clinic-designs', surface, geom: 'estimate', tex: 'tipl-sb804', texurl: '/media/materials/tipl-sb804.jpg', backend: 'webgl2', sheen: 'gloss' } });
      console.log(`  ${surface.padEnd(10)} has a slot: ${shot.info.hasRegion}, finish applied: ${shot.info.ok}, painted pixels: ${paintStats(shot.overlay).painted}`);
      summary.studioOwn = { ...summary.studioOwn, [surface]: { hasRegion: shot.info.hasRegion, ok: shot.info.ok, painted: paintStats(shot.overlay).painted } };
    } catch (error) {
      console.log(`  ${surface.padEnd(10)} the page failed: ${String(error.message).slice(0, 140)}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'}. pictures: ${out}`);
process.exit(failures ? 1 : 0);
