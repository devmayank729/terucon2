import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { CatalogueClientError } from '../../site/catalogue-ui/client.js';
import { ASSETS } from '../../server/routes/catalogueUi.js';
import { buildRegions, createOverlay, friendlyLabel, largestInnerRect, nameRegions, patchFor, segmentPhoto } from '../../site/catalogue-ui/regions.js';

// The outlining that the shop's "Find it from a photo" and the Finder's "Search the whole photo" share (targets C4, A1): the model's answer, the regions made
// from it, the patch cut for one region, and the painting over the photo. Pure code, so it is checked here without a browser; the browser tests
// (tests/e2e/run.mjs, "Finder page: ..." and "shop: Find it from a photo") run the same code on a real page.
// (surfaces.js touches `window` only when its module is evaluated: a one-line stand-in lets it load here)
globalThis.window ??= globalThis;
const surfaces = await import('../../site/catalogue-ui/surfaces.js'); // the shop's dialog still exports what it always did, now from regions.js

const W = 100;
const H = 80;
const LABELS = ['wall', 'floor, flooring', 'sky', 'person'];

/** wall (1) on the left third, floor (2) in the bottom quarter, sky (3) top right, a person (4) in the middle, a 3 x 3 speck of floor in the sky. */
function sampleMap() {
  const cm = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let c = 1;
      if (y >= 60) c = 2;
      else if (x >= 33) c = y < 30 ? 3 : 4;
      cm[y * W + x] = c;
    }
  }
  for (let y = 5; y < 8; y += 1) for (let x = 60; x < 63; x += 1) cm[y * W + x] = 2;
  return cm;
}

test('the regions are the connected pieces of each kind: sky and people and specks are left out, the rest are named and boxed', () => {
  const { ids, regions } = buildRegions(W, H, sampleMap(), LABELS);
  assert.deepEqual(regions.map((r) => r.label).sort(), ['Floor', 'Wall'], 'sky (a kind that is never offered), a person and a 3 x 3 speck are not regions');
  const wall = regions.find((r) => r.label === 'Wall');
  assert.deepEqual(wall.box, [0, 0, 33, 60]);
  assert.equal(wall.area, 33 * 60);
  assert.equal(ids[10 * W + 10], wall.id);
  assert.equal(ids[10 * W + 50], 0, 'a pixel of the sky belongs to no region');
  const floor = regions.find((r) => r.label === 'Floor');
  assert.deepEqual(floor.box, [0, 60, 100, 80]);
});

test('two pieces of one kind are told apart by where they are, and a lone piece keeps its plain name', () => {
  const cm = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) cm[y * W + x] = x < 30 || x >= 70 ? 1 : 2;
  const { regions } = buildRegions(W, H, cm, ['wall', 'floor, flooring']);
  nameRegions(regions, W);
  assert.deepEqual(regions.map((r) => r.label).sort(), ['Floor', 'Left wall', 'Right wall']);
  assert.equal(friendlyLabel('windowpane, window'), 'Window');
  assert.equal(friendlyLabel(''), 'Surface');
});

test('the patch of a region is the biggest clean rectangle inside it, a little inside its edge', () => {
  const { ids, regions } = buildRegions(W, H, sampleMap(), LABELS);
  const wall = regions.find((r) => r.label === 'Wall');
  assert.deepEqual(largestInnerRect(ids, W, H, wall.id), [0, 0, 33, 60]);
  const { rect, clean } = patchFor(ids, W, H, wall);
  assert.equal(clean, true);
  assert.deepEqual(rect, [1, 2, 32, 58], 'four percent in from each side of the rectangle');
  // an L-shaped region: its box is mostly something else, so the patch is the biggest rectangle inside it, not the box
  const l = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) l[y * W + x] = x < 20 || y >= 60 ? 1 : 0;
  const built = buildRegions(W, H, l, ['wall']);
  assert.deepEqual(built.regions[0].box, [0, 0, 100, 80]);
  assert.deepEqual(patchFor(built.ids, W, H, built.regions[0]), { rect: [4, 61, 96, 79], clean: true });
  // a thin stripe has no rectangle worth searching: its own box is used, and the caller is told the match will be rougher
  const stripe = new Uint8Array(W * H);
  for (let y = 0; y < 60; y += 1) for (let x = 10; x < 13; x += 1) stripe[y * W + x] = 1;
  const thin = buildRegions(W, H, stripe, ['wall']);
  assert.deepEqual(patchFor(thin.ids, W, H, thin.regions[0]), { rect: [10, 2, 13, 58], clean: false });
});

// ---- the call to the models

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const photo = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
const answer = (w = 4, h = 2, labels = ['wall', 'floor']) => ({ width: w, height: h, classMap: zlib.gzipSync(Buffer.from(new Uint8Array(w * h).fill(1))).toString('base64'), classLabels: labels });

test('segmentPhoto sends the JPEG to OneFormer through the studio route and unpacks the class map', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return json(200, answer()); };
  const seg = await segmentPhoto(photo);
  assert.equal(calls[0].url, '/api/vision/segment?model=oneformer');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'image/jpeg');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(seg.width, 4);
  assert.deepEqual([...seg.classMap], new Array(8).fill(1));
  assert.equal(seg.instanceMap, null);
  assert.deepEqual(seg.labels, ['wall', 'floor']);
});

test('segmentPhoto says why it failed, with the HTTP status, so a page can word it: not signed in, rate limited, the service down, no connection, gave up', async () => {
  const fail = async (response) => {
    globalThis.fetch = async () => { if (response instanceof Error) throw response; return response; };
    return segmentPhoto(photo).then(() => assert.fail('it should have failed'), (error) => error);
  };
  let e = await fail(json(401, { error: 'Please sign in to use the Design Studio.', code: 'auth-required' }));
  assert.ok(e instanceof CatalogueClientError);
  assert.deepEqual([e.reason, e.status], ['unauthorized', 401]);
  e = await fail(json(429, { error: 'The studio has been used a lot', code: 'rate-limit' }));
  assert.deepEqual([e.reason, e.status], ['segment', 429]);
  e = await fail(json(503, { error: 'Scene parsing is not available' }));
  assert.deepEqual([e.reason, e.status], ['segment', 503]);
  e = await fail(json(404, { error: 'No OneFormer is configured. Set ONEFORMER_URL in .env.' }));
  assert.equal(e.status, 404);
  e = await fail(new TypeError('fetch failed'));
  assert.equal(e.reason, 'network');
  e = await fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  assert.equal(e.reason, 'timeout');
  e = await fail(json(200, { width: 4, height: 2 }));
  assert.equal(e.reason, 'segment', 'an answer without a class map is refused');
  e = await fail(json(200, { ...answer(), width: 5 }));
  assert.equal(e.reason, 'segment', 'a class map of the wrong size is refused');
});

// ---- the overlay

/** A canvas as far as createOverlay needs one: a size, a box on the screen, and an image it paints into. */
function fakeCanvas(box = { left: 0, top: 0, width: 200, height: 160 }) {
  const painted = { data: null };
  return {
    painted,
    getBoundingClientRect: () => box,
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: (image) => { painted.data = Uint8ClampedArray.from(image.data); },
    }),
  };
}
const alphaAt = (canvas, x, y) => canvas.painted.data[(y * W + x) * 4 + 3];

test('the overlay says which region is under a point of the screen, whatever size the canvas is shown at', () => {
  const { ids, regions } = buildRegions(W, H, sampleMap(), LABELS);
  const canvas = fakeCanvas({ left: 10, top: 20, width: 200, height: 160 }); // shown at twice its size, 10 px right and 20 px down
  const map = createOverlay(canvas, { ids, w: W, h: H, regions });
  assert.equal(canvas.width, W);
  assert.equal(canvas.height, H);
  assert.equal(map.regionAt(10 + 20, 20 + 20).label, 'Wall');
  assert.equal(map.regionAt(10 + 100, 20 + 150).label, 'Floor');
  assert.equal(map.regionAt(10 + 140, 20 + 40), null, 'the sky is not an item');
  assert.equal(map.regionAt(5, 25), null, 'outside the canvas');
});

test('the shop dialog paints only what is hovered or selected; the Finder also tints every item and draws the edges between them', () => {
  const { ids, regions } = buildRegions(W, H, sampleMap(), LABELS);
  const wall = regions.find((r) => r.label === 'Wall');
  const floor = regions.find((r) => r.label === 'Floor');
  // without `base`: as the shop has always been
  const bare = fakeCanvas();
  const shop = createOverlay(bare, { ids, w: W, h: H, regions });
  shop.paint(null, null);
  assert.equal(alphaAt(bare, 10, 10), 0);
  shop.paint(wall, null);
  assert.equal(alphaAt(bare, 10, 10), 95, 'hovered');
  shop.paint(null, wall);
  assert.equal(alphaAt(bare, 10, 10), 120, 'selected');
  assert.equal(alphaAt(bare, 50, 70), 0, 'the floor is not lit');
  // with `base`
  const canvas = fakeCanvas();
  const map = createOverlay(canvas, { ids, w: W, h: H, regions, base: true });
  map.paint(null, null);
  assert.equal(alphaAt(canvas, 10, 10), 46, 'the wall is tinted');
  assert.equal(alphaAt(canvas, 50, 70), 46, 'the floor is tinted');
  assert.equal(alphaAt(canvas, 50, 40), 0, 'the person is not an item: nothing drawn');
  assert.equal(alphaAt(canvas, 32, 10), 235, 'the right edge of the wall is drawn');
  assert.equal(alphaAt(canvas, 10, 59), 235, 'the wall meets the floor: an edge');
  assert.equal(alphaAt(canvas, 0, 10), 46, 'the border of the picture is not an edge');
  map.paint(floor, wall);
  assert.equal(alphaAt(canvas, 10, 10), 150, 'selected, stronger than the tint');
  assert.equal(alphaAt(canvas, 50, 70), 115, 'hovered, stronger than the tint');
  assert.equal(alphaAt(canvas, 32, 10), 235, 'an edge stays an edge under a highlight');
});

test('the shop dialog and the Finder get the same functions from one module, and the new file is in the list the server serves', () => {
  for (const name of ['buildRegions', 'nameRegions', 'largestInnerRect', 'patchFor', 'friendlyLabel']) assert.equal(typeof surfaces[name], 'function', name);
  assert.equal(surfaces.buildRegions, buildRegions);
  assert.equal(surfaces.patchFor, patchFor);
  assert.ok(ASSETS.includes('regions.js'), 'server/routes/catalogueUi.js must list regions.js, or surfaces.js and finder.js cannot import it');
});
