import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from '../helpers/studio.js';

// Behaviour of the instant preview AS THE WEBSITE SERVES IT: the studio's own browser files (swatchroom/public/js) with the overlay
// (site/overlays/studio/js) laid over them, exactly the file set a visitor's browser gets (tests/js/studio-overlay.test.js checks that
// the server really serves it so). Everything runs in Node, without a GPU: the maths, the scene building, the renderer against a fake
// backend that paints by the shaders' rules, the stage's state machine, and the backends against a fake GL / fake GPU device.
//
// 1. The first 28 tests are swatchroom/tests/fastrender.test.js, ported (the studio's own tests, which this repo does not edit).
//    25 are unchanged. 3 assert constants the overlay changes on purpose (the shading clamp, exposureFor's bounds, how smooth the
//    shading is) and now assert the new values; they are marked CHANGED below. A fourth assertion, inside the buildProvisionalScene
//    test, changed too (a head-on wall's size now comes from the level-camera guess, not from the fixed 2.6 m): it was hidden behind
//    the first failing assertion of that test, so the studio's own test run reports 3 failures, not 4 assertions.
// 2. The rest are new: what the overlay adds (the light colour, the highlight roll-off, the region-masked guided-filter light, the
//    level-camera prior, the soft edge, anisotropic filtering, the seam repair, the tint pass-through of previewScene.js).
//    The shaders themselves are checked pixel by pixel in a real browser by docs/design-studio-checks/render-preview/ (not here).
// Without site/overlays/studio/ (the overlay removed) this file skips itself.

const PUBLIC = path.join(PROJECT_ROOT, 'swatchroom', 'public');
const OVERLAY = path.join(PROJECT_ROOT, 'site', 'overlays', 'studio');
const skip = fs.existsSync(path.join(OVERLAY, 'manifest.json')) ? false : 'site/overlays/studio/ is not there: the overlay has been removed';
const t = (name, fn) => test(name, { skip }, fn);

// the file set a browser gets: the studio's js/ with the overlay's js/ over it (and a package.json so Node reads the files as modules)
const merged = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-overlay-merged-'));
fs.cpSync(path.join(PUBLIC, 'js'), path.join(merged, 'js'), { recursive: true });
if (!skip) fs.cpSync(path.join(OVERLAY, 'js'), path.join(merged, 'js'), { recursive: true, force: true });
fs.writeFileSync(path.join(merged, 'package.json'), '{ "type": "module" }\n');
test.after(() => fs.rmSync(merged, { recursive: true, force: true }));
const load = (rel) => import(pathToFileURL(path.join(merged, 'js', rel)).href);
const studioServer = createRequire(path.join(PROJECT_ROOT, 'swatchroom', 'server', 'index.js')); // the studio's server code, used as it is

const geometry = await load('lib/fastrender/geometry.js');
const provisional = await load('lib/fastrender/provisional.js');
const sizing = await load('lib/fastrender/sizing.js');
const lruModule = await load('lib/fastrender/lru.js');
const storeModule = await load('lib/fastrender/textureStore.js');
const rendererModule = await load('lib/fastrender/renderer.js');
const composerModule = await load('lib/previewScene.js');
const regions = await load('lib/regions.js');
const reasonModule = await load('lib/fastrender/previewReason.js');
const require_tiers = await load('lib/fastrender/tiers.js');
const webgl2Module = await load('lib/fastrender/webgl2.js');
const webgpuModule = await load('lib/fastrender/webgpu.js');
const fusion = studioServer('./lib/fusion.js');
const moge2 = studioServer('./lib/remoteModels/moge2.js');


// ---------------------------------------------------------------- canvas sizing
t("canvas size follows the screen: frame x devicePixelRatio, never above 2048, same aspect", function () {
  assert.deepEqual(sizing.previewCanvasSize(390, 260, 3), { width: 1170, height: 780 });
  assert.deepEqual(sizing.previewCanvasSize(390, 260, 1), { width: 390, height: 260 });
  const big = sizing.previewCanvasSize(1200, 800, 3); // 3600 x 2400 -> capped
  assert.equal(big.width, 2048);
  assert.ok(Math.abs(big.width / big.height - 1.5) < 0.01);
  const tall = sizing.previewCanvasSize(300, 700, 3); // 900 x 2100: the tall side is capped, not the wide one
  assert.equal(tall.height, 2048);
  assert.ok(tall.width < 2048);
  assert.deepEqual(sizing.previewCanvasSize(0, 0, 2), { width: 1, height: 1 });
  assert.equal(sizing.previewCanvasSize(100, 100, 0).width, 100, "a missing ratio counts as 1");
  assert.equal(sizing.MAX_PREVIEW_SIDE, 2048);
});

// ---------------------------------------------------------------- the maths
t("planeHomography(): picture point -> the plane's own metres, exact (ray / plane intersection)", function () {
  const K = { fx: 900, fy: 900, cx: 512, cy: 340 };
  const origin = [0.4, -0.3, 3.2];
  let normal = [0.25, -0.1, -0.96];
  const len = Math.hypot(...normal);
  normal = normal.map((v) => v / len);
  if (normal[0] * origin[0] + normal[1] * origin[1] + normal[2] * origin[2] > 0) {
    normal = normal.map((v) => -v);
  }
  const basis = fusion.buildUvBasis(normal, [0, -1, 0]);
  const h = geometry.planeHomography({ origin, normal, u: basis.u, v: basis.v }, K);
  let worst = 0;
  [[60, 80], [900, 120], [512, 600], [300, 330], [700, 500]].forEach(function ([px, py]) {
    const r = [(px - K.cx) / K.fx, (py - K.cy) / K.fy, 1];
    const t = (normal[0] * origin[0] + normal[1] * origin[1] + normal[2] * origin[2]) / (normal[0] * r[0] + normal[1] * r[1] + normal[2] * r[2]);
    const rel = r.map((v, i) => v * t - origin[i]);
    const u = rel[0] * basis.u[0] + rel[1] * basis.u[1] + rel[2] * basis.u[2];
    const v = rel[0] * basis.v[0] + rel[1] * basis.v[1] + rel[2] * basis.v[2];
    const got = geometry.applyHomography(h, px, py);
    worst = Math.max(worst, Math.abs(got[0] - u), Math.abs(got[1] - v));
  });
  assert.ok(worst < 1e-9, "worst error " + worst);
});

t("CHANGED: the shading multiplier is the shading over the surface's median, clamped to [0.2, 2.5] (was [0.35, 1.65]: that flattened the sun-to-shade contrast)", function () {
  assert.equal(geometry.normalisedShading(0.5, 0.5), 1);
  assert.equal(geometry.normalisedShading(0.05, 0.5), 0.2, "a deep shadow does not turn the finish black");
  assert.equal(geometry.normalisedShading(2, 0.5), 2.5, "a bright spot does not blow it out");
  assert.ok(Math.abs(geometry.normalisedShading(0.6, 0.5) - 1.2) < 1e-9);
  assert.equal(geometry.normalisedShading(0.4, 0), 1, "no median -> neutral");
  assert.equal(geometry.SHADING_MIN, 0.2);
  assert.equal(geometry.SHADING_MAX, 2.5);
  assert.ok(geometry.SHADING_MAX / geometry.SHADING_MIN > 10, "a surface can now keep a sun-to-shade ratio above 10:1 (the old clamp allowed 4.7:1)");
});

t("maskedMedian() reads only masked pixels, ignores zero depth-like holes, and samples big masks sparsely", function () {
  const values = new Float32Array([1, 2, 3, 100, 0, 5]);
  const mask = new Uint8Array([1, 1, 1, 0, 1, 1]);
  assert.equal(geometry.maskedMedian(values, mask), 2.5, "[1,2,3,5] -> 2.5; the 100 is outside the mask, the 0 is ignored");
  assert.equal(geometry.maskedMedian(values, new Uint8Array(6)), null);
  const big = new Float32Array(100000).fill(0.4);
  assert.ok(Math.abs(geometry.maskedMedian(big, new Uint8Array(100000).fill(1), 1000) - 0.4) < 1e-6);
});

t("CHANGED: exposureFor(): bounded to [0.45, 1.5] (was [0.7, 1.25]), exponent 0.6 (was 0.35), neutral near a mid-lit surface", function () {
  assert.ok(Math.abs(geometry.exposureFor(0.3) - 1) < 1e-9);
  assert.equal(geometry.exposureFor(0.001), 0.45);
  assert.equal(geometry.exposureFor(5), 1.5);
  assert.equal(geometry.exposureFor(null), 1);
  assert.equal(geometry.exposureFor(0), 1);
  // a dim room (a third of the reference light) now darkens a bright finish to about 0.52; the old curve held it at 0.7
  assert.ok(Math.abs(geometry.exposureFor(0.1) - Math.pow(1 / 3, 0.6)) < 1e-9 && geometry.exposureFor(0.1) < 0.55);
  let last = 0;
  [0.002, 0.01, 0.05, 0.1, 0.3, 0.6, 1, 2].forEach(function (light) {
    const e = geometry.exposureFor(light);
    assert.ok(e >= last && e >= 0.45 && e <= 1.5, "monotonic and bounded: " + light + " -> " + e);
    last = e;
  });
});

t("specularFor(): words decide - polished things catch highlights, matte ones do not", function () {
  assert.equal(geometry.specularFor({ name: "Gloss white tile", prompt: "" }), geometry.SPECULAR_GLOSSY);
  assert.equal(geometry.specularFor({ name: "Venetian plaster", sub: "Burnished, soft sheen", prompt: "polished" }), geometry.SPECULAR_GLOSSY);
  assert.equal(geometry.specularFor({ name: "Sand limewash", prompt: "matte, chalky" }), geometry.SPECULAR_MATTE);
  assert.equal(geometry.specularFor({ name: "Oak planks", prompt: "natural" }), geometry.SPECULAR_DEFAULT);
  assert.equal(geometry.specularFor(null), geometry.SPECULAR_DEFAULT);
});

t("lumaFromRgba(): perceptual luma for edges, linear luminance for exposure", function () {
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255]);
  const { luma, linear } = geometry.lumaFromRgba(rgba, 3, 1);
  assert.ok(Math.abs(luma[0] - 1) < 1e-6 && luma[1] === 0);
  assert.ok(Math.abs(luma[2] - 128 / 255) < 1e-3);
  assert.ok(Math.abs(linear[2] - 0.2158) < 0.01, "mid grey (128) is about 22% in linear light: " + linear[2]);
});

// ---------------------------------------------------------------- the provisional geometry
t("provisional: a perspective wall quad gives its true proportions, even with a guessed focal length", function () {
  const f = 800;
  const cx = 512;
  const cy = 340;
  const yaw = (35 * Math.PI) / 180;
  const corners = [[-1.5, -1.3], [1.5, -1.3], [-1.5, 1.3], [1.5, 1.3]].map(([x, y]) => {
    const X = [x * Math.cos(yaw), y, x * Math.sin(yaw) + 4.0];
    return [(f * X[0]) / X[2] + cx, (f * X[1]) / X[2] + cy];
  });
  const quad = { tl: corners[0], tr: corners[1], bl: corners[2], br: corners[3] };
  const exact = provisional.rectangleAspect(quad, { fx: f, fy: f, cx, cy });
  assert.ok(Math.abs(exact - 3 / 2.6) < 1e-6, "exact with the right focal length: " + exact);
  const guessed = provisional.assumedIntrinsics(1024, 680);
  const near = provisional.rectangleAspect(quad, { fx: guessed.fx, fy: guessed.fx, cx, cy });
  assert.ok(Math.abs(near / (3 / 2.6) - 1) < 0.05, "within 5% with the assumed 62 degree field of view: " + near);
});

t("provisional: quadFromMask() finds the four corners of a trapezoid floor", function () {
  const W = 200;
  const H = 120;
  const mask = new Uint8Array(W * H);
  for (let y = 60; y < 120; y += 1) {
    const inset = Math.round(((119 - y) / 60) * 50); // far edge (top) narrower
    for (let x = inset; x < W - inset; x += 1) {
      mask[y * W + x] = 1;
    }
  }
  const quad = provisional.quadFromMask(mask, W, H, { x0: 0, y0: 60, x1: W, y1: 120 });
  assert.ok(quad, "a trapezoid has a quad");
  assert.ok(quad.tl[1] <= 62 && quad.tr[1] <= 62, "top corners on the far edge");
  assert.ok(quad.tl[0] > 40 && quad.tr[0] < 160, "the far edge is narrower than the near edge");
  assert.ok(quad.bl[1] >= 118 && quad.br[1] >= 118);
  assert.ok(quad.bl[0] < 5 && quad.br[0] > 195);
});

t("CHANGED: provisional: buildProvisionalScene() covers wall / floor / ceiling, marks them flagged, keeps only the lighting (a smoothness bound of 0.03, and a head-on wall is sized by the level-camera guess)", function () {
  const W = 160;
  const H = 100;
  const labelMap = new Uint16Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      labelMap[y * W + x] = y < 15 ? 1 : y >= 70 ? 3 : x < 100 ? 2 : 4;
    }
  }
  const scan = regions.scanFromLabelMap(
    labelMap,
    [
      { index: 1, label: "Ceiling", kind: "ceiling", source: "scene" },
      { index: 2, label: "Wall", kind: "wall", source: "scene" },
      { index: 3, label: "Floor", kind: "floor", source: "scene" },
      { index: 4, label: "Sofa", kind: "furniture", source: "scene" },
    ],
    W,
    H,
  );
  // the photo: a high-frequency checker (the OLD floor pattern) on top of a smooth left-to-right light gradient
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    const x = i % W;
    const y = Math.floor(i / W);
    const checker = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 1 : 0.6;
    const v = Math.round(255 * checker * (0.5 + 0.5 * (1 - x / W)));
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  const light = geometry.lumaFromRgba(rgba, W, H);
  const scene = provisional.buildProvisionalScene(scan, light);
  assert.equal(scene.kind, "provisional");
  const kinds = Object.keys(scene.fusionRegions).map((id) => scan.regions.find((r) => r.id === id).kind).sort();
  assert.deepEqual(kinds, ["ceiling", "floor", "wall"], "no sofa");
  Object.values(scene.fusionRegions).forEach(function (r) {
    assert.equal(r.confidence, provisional.PROVISIONAL_CONFIDENCE);
    assert.equal(r.tier, "flagged");
    assert.equal(r.homography.length, 9);
    assert.ok(r.homography.every(Number.isFinite));
  });
  assert.equal(scene.depth, null);
  // the shading is the light only: the checker (period 8 px) is blurred away, the gradient stays
  const row = 40 * W;
  let wiggle = 0;
  let flicker = 0;
  for (let x = 20; x < 140; x += 1) {
    wiggle = Math.max(wiggle, Math.abs(scene.shading[row + x] - scene.shading[row + x + 1]));
    flicker = Math.max(flicker, Math.abs(light.linear[row + x] - light.linear[row + x + 1]));
  }
  // CHANGED (was < 0.02): the edge-preserving light keeps the 8 px period at 0.022 here, a strong checker being "an edge" to it;
  // that is still 26 times smoother than the photo itself (0.58)
  assert.ok(wiggle < 0.03, "shading is smooth where the photo flickers: " + wiggle);
  assert.ok(wiggle < flicker / 10, "and at least 10 times smoother than the photo: " + wiggle + " vs " + flicker);
  assert.ok(scene.shading[row + 20] > scene.shading[row + 140], "but the light falloff is kept");
  assert.ok(scene.luma === light.luma, "the edge guide stays sharp");
  // CHANGED (was: "a wall is 2.6 m tall"): this wall is head-on (its top edge is level), so its size now comes from the level-camera
  // guess: the camera is CAMERA_HEIGHT_M above the floor and looks level, the wall stands where the floor meets it (row 70), so its
  // height is CAMERA_HEIGHT_M * (rows it spans) / (rows below the horizon) = 1.5 * 55 / 20 = 4.125 m. This synthetic picture is not a
  // believable room (the wall is 10 m away); the point is that the number follows the picture, not a constant. A wall the guess does
  // not fit (a slanted top edge) still gets 2.6 m: see "the level-camera guess" below.
  const wall = scan.regions.find((r) => r.kind === "wall");
  assert.ok(Math.abs(scene.fusionRegions[wall.id].sizeM.height - (provisional.CAMERA_HEIGHT_M * 55) / 20) < 1e-9, "" + scene.fusionRegions[wall.id].sizeM.height);
  assert.ok(Math.abs(scene.fusionRegions[wall.id].sizeM.width - (100 * provisional.CAMERA_HEIGHT_M) / 20) < 1e-9, "100 columns at the same scale: 7.5 m");
});

// ---------------------------------------------------------------- the texture cache
t("lru: the least recently used entry goes first; reading counts as use; peek does not", function () {
  const evicted = [];
  const cache = lruModule.createLru(3, (key) => evicted.push(key));
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  cache.get("a"); // a is now the newest
  cache.peek("b"); // not a use
  cache.set("d", 4);
  assert.deepEqual(evicted, ["b"]);
  assert.deepEqual(cache.keys(), ["c", "a", "d"]);
  cache.delete("a");
  assert.deepEqual(evicted, ["b", "a"]);
});

t("textureStore: loads once, serves from memory synchronously, evicts and CLOSES the oldest, retries failures", async function () {
  const loads = [];
  const closed = [];
  let failNext = false;
  const store = storeModule.createTextureStore(async function (url) {
    loads.push(url);
    if (failNext) {
      failNext = false;
      throw new Error("offline");
    }
    return { url: url, close: () => closed.push(url) };
  }, 2);
  assert.equal(store.peek("/t/a.png"), undefined);
  const a1 = await store.get("/t/a.png");
  assert.equal(store.peek("/t/a.png"), a1, "now it is synchronous");
  await store.get("/t/a.png");
  assert.deepEqual(loads, ["/t/a.png"], "one load");
  const both = await Promise.all([store.get("/t/b.png"), store.get("/t/b.png")]);
  assert.equal(both[0], both[1], "two callers share one load");
  assert.deepEqual(loads, ["/t/a.png", "/t/b.png"]);
  await store.get("/t/c.png"); // over the limit of 2: the oldest (a) is closed
  assert.deepEqual(closed, ["/t/a.png"]);
  assert.equal(store.size, 2);
  failNext = true;
  await assert.rejects(store.get("/t/d.png"), /offline/);
  await store.get("/t/d.png"); // a failed load is not cached as a dead end
  assert.equal(loads.filter((u) => u === "/t/d.png").length, 2);
});

t("textureStore.prefetch(): starts only what is neither loaded nor on its way, never throws", async function () {
  const loads = [];
  const store = storeModule.createTextureStore(async function (url) {
    loads.push(url);
    if (url === "/bad") throw new Error("404");
    return { url: url };
  }, 10);
  await store.get("/t/a.png");
  assert.equal(store.prefetch(["/t/a.png", "/t/b.png", "/t/b.png", "/bad", "", null]), 2);
  assert.equal(store.prefetch(["/t/b.png"]), 0, "b is already on its way");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(loads.sort(), ["/bad", "/t/a.png", "/t/b.png"]);
  assert.ok(store.peek("/t/b.png"));
});

// ---------------------------------------------------------------- the renderer facade against a fake GPU
function fakeBackend() {
  const state = { uploads: 0, labelUpdates: 0, renders: 0, layers: [], alpha: null, regions: [], labels: null, width: 0, height: 0 };
  return {
    state: state,
    kind: "fake",
    maxRegions: 16,
    uploadScene: function (scene) {
      state.uploads += 1;
      state.width = scene.width;
      state.height = scene.height;
      state.labels = scene.labelMap;
      state.alpha = new Float32Array(scene.width * scene.height); // an upload zeroes the alpha map, like both GPU backends
      state.lastScene = scene;
      state.regions = [];
    },
    setLabels: function (labels) {
      state.labelUpdates += 1;
      state.labels = labels;
    },
    setAlpha: function (alpha) {
      state.alpha = alpha;
    },
    setRegions: function (list) {
      state.regions = list;
    },
    setMaterialLayer: function (layer, bitmap) {
      state.layers[layer] = bitmap.url;
    },
    render: function () {
      state.renders += 1;
      // what the shaders would paint: a region with a finish, and the alpha map allowing the pixel
      let painted = 0;
      const byRegion = {};
      for (let i = 0; i < state.labels.length; i += 1) {
        const label = state.labels[i];
        if (label > 0 && state.regions[label - 1] && state.regions[label - 1].active && state.alpha[i] > 0) {
          painted += 1;
          byRegion[label] = (byRegion[label] || 0) + 1;
        }
      }
      state.painted = painted;
      state.paintedByLabel = byRegion;
    },
    readPixelsAsBlob: async () => null,
    destroy: () => {},
  };
}

const W = 60;
const H = 40;
function twoSurfaceScan() {
  const labelMap = new Uint16Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      labelMap[y * W + x] = y < 25 ? 1 : 2; // wall above, floor below
    }
  }
  return regions.scanFromLabelMap(
    labelMap,
    [
      { index: 1, label: "Wall", kind: "wall", source: "scene" },
      { index: 2, label: "Floor", kind: "floor", source: "scene" },
    ],
    W,
    H,
  );
}
function sceneFor(scan, key) {
  const room = moge2.castBoxRoom(W, H, { roomWidth: 4, roomDepth: 5 });
  const planes = {};
  scan.regions.forEach(function (r, i) {
    const normal = r.kind === "floor" ? [0, -1, 0] : [0, 0, -1];
    const origin = r.kind === "floor" ? [0, 1.5, 3] : [0, 0, 5];
    const basis = fusion.buildUvBasis(normal, [0, -1, 0]);
    planes[r.id] = { plane: { origin: origin, normal: normal, u: basis.u, v: basis.v }, confidence: 0.9 };
  });
  return {
    kind: "fused",
    geometryKey: key || "g1",
    scan: scan,
    fusionRegions: planes,
    depth: room.depth,
    shading: new Float32Array(W * H).fill(0.5),
    residual: null,
    luma: new Float32Array(W * H).fill(0.5),
    photoLinear: new Float32Array(W * H).fill(0.3),
    intrinsics: room.intrinsics,
  };
}
const ITEM = (id) => ({ id: id, name: id, texture: { url: "/textures/" + id + ".png", tileWidthM: 0.6, tileHeightM: 0.4 } });

async function makeRenderer(extra) {
  const backend = fakeBackend();
  const closed = [];
  const renderer = await rendererModule.createFastRenderer({}, Object.assign({
    backend: backend,
    loadTexture: async (url) => ({ url: url, close: () => closed.push(url) }),
  }, extra || {}));
  return { renderer: renderer, backend: backend, closed: closed };
}

t("renderer: setAlphaFromMask() = 1 inside the mask, 0 outside; a wrong-sized mask is refused", async function () {
  const { renderer, backend } = await makeRenderer();
  const scan = twoSurfaceScan();
  renderer.uploadScene(sceneFor(scan));
  assert.ok(backend.state.alpha.every((v) => v === 0), "an upload zeroes the alpha map");
  const floor = scan.regions.find((r) => r.kind === "floor");
  assert.equal(renderer.setAlphaFromMask(floor.mask), true);
  let inside = 0;
  for (let i = 0; i < floor.mask.length; i += 1) {
    assert.equal(backend.state.alpha[i], floor.mask[i] ? 1 : 0);
    inside += floor.mask[i];
  }
  assert.ok(inside > 0);
  assert.equal(renderer.setAlphaFromMask(new Uint8Array(5)), false);
  assert.equal(renderer.setAlphaFromMask(null), false);
  renderer.clearAlpha();
  assert.ok(backend.state.alpha.every((v) => v === 0));
});

t("renderer: setMaterial() is SYNCHRONOUS once the texture is in memory (prefetch), so a pick draws in the same frame", async function () {
  const { renderer, backend } = await makeRenderer();
  const scan = twoSurfaceScan();
  renderer.uploadScene(sceneFor(scan));
  const floor = scan.regions.find((r) => r.kind === "floor");
  const item = ITEM("oak");
  renderer.prefetch([item.texture.url]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(renderer.isCached(item.texture.url), true);
  const before = backend.state.layers.length;
  renderer.setMaterial(floor.id, item, 0); // NOT awaited
  assert.ok(backend.state.layers.length > before && backend.state.layers.includes(item.texture.url), "the layer was uploaded before the call returned");
  assert.equal(backend.state.regions.find((r) => r.active) !== undefined, true);
  // a texture that is not in memory takes the async path
  const cold = ITEM("brick");
  const started = backend.state.layers.length;
  const promise = renderer.setMaterial(floor.id, cold, 0);
  assert.equal(backend.state.layers.includes(cold.texture.url), false, "not yet: it has to be fetched");
  assert.equal(await promise, true);
  assert.ok(backend.state.layers.includes(cold.texture.url));
});

t("renderer: the region data carries each surface's homography, light median and exposure", async function () {
  const { renderer, backend } = await makeRenderer();
  const scan = twoSurfaceScan();
  renderer.uploadScene(sceneFor(scan));
  assert.equal(backend.state.regions.length, 2);
  backend.state.regions.forEach(function (r) {
    assert.equal(r.h.length, 9);
    assert.ok(r.h.every(Number.isFinite));
    assert.ok(Math.abs(r.medianShading - 0.5) < 1e-9, "median of the shading layer: " + r.medianShading);
    assert.ok(r.exposure >= 0.7 && r.exposure <= 1.25);
    assert.equal(r.active, false, "no finish yet");
  });
  // a provisional scene (a homography instead of a plane, no depth) uploads too, with depth = 1 everywhere
  const prov = { kind: "provisional", scan: scan, fusionRegions: {}, depth: null, shading: null, residual: null, luma: null, intrinsics: { fx: 50, fy: 50, cx: 30, cy: 20 } };
  scan.regions.forEach((r) => (prov.fusionRegions[r.id] = { homography: [1, 0, 0, 0, 1, 0, 0, 0, 1], confidence: 0.6 }));
  renderer.uploadScene(prov);
  assert.ok(backend.state.lastScene.depth.every((v) => v === 1), "the shader's depth check passes without a depth map");
  assert.equal(renderer.sceneKind(), "provisional");
});

t("renderer: updateLabels() replaces only the label map; a different-sized scan is refused", async function () {
  const { renderer, backend } = await makeRenderer();
  const scan = twoSurfaceScan();
  renderer.uploadScene(sceneFor(scan));
  const edited = regions.paintRegion(scan, scan.regions.find((r) => r.kind === "wall").id, (() => {
    const m = new Uint8Array(W * H);
    for (let i = 0; i < W * 20; i += 1) m[i] = 1;
    return m;
  })(), "replace");
  assert.equal(renderer.updateLabels(edited), true);
  assert.equal(backend.state.uploads, 1, "no second upload");
  assert.equal(backend.state.labelUpdates, 1);
  const wallSlot = 1;
  let wallPixels = 0;
  backend.state.labels.forEach((l) => (wallPixels += l === wallSlot ? 1 : 0));
  assert.equal(wallPixels, W * 20, "the new outline is what the shader reads");
  assert.equal(renderer.updateLabels({ width: 10, height: 10, labelMap: new Uint16Array(100), regions: [] }), false);
});

t("renderer: textures beyond the cache size are evicted and closed", async function () {
  const { renderer, closed } = await makeRenderer({ cacheSize: 2 });
  renderer.uploadScene(sceneFor(twoSurfaceScan()));
  renderer.prefetch(["/t/1.png", "/t/2.png", "/t/3.png"]);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(renderer.cacheSize(), 2);
  assert.equal(closed.length, 1);
});

// ---------------------------------------------------------------- the stage's state machine
// Stage.runFastRender() driven without a DOM: a stand-in `this` with the stage's own fields.
const stageModule = await load("views/stage.js");
global.window = { devicePixelRatio: 3 };
function fakeStage(renderer, props) {
  const stage = Object.create(stageModule.Stage.prototype);
  Object.assign(stage, {
    props: props,
    fastRenderer: renderer,
    fastGeometryKey: null,
    fastScanToken: null,
    fastMaterialKey: "",
    fastAssignedRegion: null,
    fastAlphaKey: "",
    fastPrefetchToken: null,
    maskTokens: new WeakMap(),
    maskCounter: 0,
  });
  stage.frameRect = () => ({ width: 390, height: 260, left: 0, top: 0 });
  return stage;
}
const canvas = () => ({ width: 0, height: 0 });

t("stage: tapping a surface and picking a finish paints exactly that surface, in the same call when the texture is cached", async function () {
  const { renderer, backend } = await makeRenderer();
  const scan = twoSurfaceScan();
  const scene = sceneFor(scan);
  const floor = scan.regions.find((r) => r.kind === "floor");
  renderer.prefetch([ITEM("oak").texture.url]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const props = { fastEnabled: true, fastScene: scene, fastMaterial: { regionId: floor.id, item: ITEM("oak"), rotation: 0, mask: floor.mask } };
  const stage = fakeStage(renderer, props);
  const c = canvas();
  const rendersBefore = backend.state.renders;
  stage.runFastRender(renderer, c);
  assert.ok(backend.state.renders > rendersBefore, "rendered synchronously, no await");
  assert.deepEqual({ w: c.width, h: c.height }, { w: 1170, h: 780 }, "canvas sized for a 3x phone, not the 60x40 scan");
  let floorPixels = 0;
  floor.mask.forEach((v) => (floorPixels += v));
  assert.equal(backend.state.painted, floorPixels, "painted = the selected surface's own area");
  assert.deepEqual(Object.keys(backend.state.paintedByLabel), ["2"], "nothing on the wall");
});

t("stage: surface A -> surface B directly leaves no ghost of A (finish AND alpha cleared)", async function () {
  const { renderer, backend } = await makeRenderer();
  const scan = twoSurfaceScan();
  const scene = sceneFor(scan);
  const floor = scan.regions.find((r) => r.kind === "floor");
  const wall = scan.regions.find((r) => r.kind === "wall");
  renderer.prefetch([ITEM("oak").texture.url, ITEM("brick").texture.url]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const props = { fastEnabled: true, fastScene: scene, fastMaterial: { regionId: floor.id, item: ITEM("oak"), rotation: 0, mask: floor.mask } };
  const stage = fakeStage(renderer, props);
  stage.runFastRender(renderer, canvas());
  assert.ok(backend.state.painted > 0);
  // tap the wall and pick brick (one step: the studio never passes through "nothing selected")
  stage.props = Object.assign({}, props, { fastMaterial: { regionId: wall.id, item: ITEM("brick"), rotation: 0, mask: wall.mask } });
  stage.runFastRender(renderer, canvas());
  assert.deepEqual(Object.keys(backend.state.paintedByLabel), ["1"], "only the wall is painted");
  assert.equal(backend.state.paintedByLabel[2], undefined, "the floor's pixels are gone from the canvas");
  // and deselecting clears everything
  stage.props = Object.assign({}, props, { fastMaterial: null });
  stage.runFastRender(renderer, canvas());
  assert.equal(backend.state.painted, 0);
});

t("stage: an upload (scene change) resets the bookkeeping and the finish is re-applied from cache with no blank frame", async function () {
  const { renderer, backend } = await makeRenderer();
  const scan = twoSurfaceScan();
  const floor = scan.regions.find((r) => r.kind === "floor");
  renderer.prefetch([ITEM("oak").texture.url]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const provisionalLike = sceneFor(scan, "provisional-1");
  const props = { fastEnabled: true, fastScene: provisionalLike, fastMaterial: { regionId: floor.id, item: ITEM("oak"), rotation: 0, mask: floor.mask } };
  const stage = fakeStage(renderer, props);
  stage.runFastRender(renderer, canvas());
  const paintedBefore = backend.state.painted;
  const rendersBefore = backend.state.renders;
  // the real geometry arrives: another geometryKey, uploadScene() zeroes alpha and drops assignments...
  stage.props = Object.assign({}, props, { fastScene: sceneFor(scan, "fused-1") });
  stage.runFastRender(renderer, canvas());
  assert.equal(backend.state.uploads, 2);
  assert.equal(backend.state.painted, paintedBefore, "...but the same pixels are painted again in the same call");
  assert.equal(backend.state.renders - rendersBefore, 1, "one render, so no frame shows an empty overlay");
});

t("stage: a refined outline (same geometry, new scan) updates the labels only and re-reads the new mask", async function () {
  const { renderer, backend } = await makeRenderer();
  const scan = twoSurfaceScan();
  const floor = scan.regions.find((r) => r.kind === "floor");
  renderer.prefetch([ITEM("oak").texture.url]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const scene = sceneFor(scan);
  const props = { fastEnabled: true, fastScene: scene, fastMaterial: { regionId: floor.id, item: ITEM("oak"), rotation: 0, mask: floor.mask } };
  const stage = fakeStage(renderer, props);
  stage.runFastRender(renderer, canvas());
  const before = backend.state.painted;
  // SAM trims 3 rows off the floor: paintRegion gives a new scan and a new mask for the same region id
  const trimmed = new Uint8Array(floor.mask);
  for (let i = 0; i < W * 28; i += 1) trimmed[i] = 0;
  const edited = regions.paintRegion(scan, floor.id, trimmed, "replace");
  const floor2 = edited.regions.find((r) => r.id === floor.id);
  stage.props = Object.assign({}, props, {
    fastScene: Object.assign({}, scene, { scan: edited }),
    fastMaterial: { regionId: floor.id, item: ITEM("oak"), rotation: 0, mask: floor2.mask },
  });
  stage.runFastRender(renderer, canvas());
  assert.equal(backend.state.uploads, 1, "heavy textures are not re-uploaded");
  assert.equal(backend.state.labelUpdates, 1);
  assert.ok(backend.state.painted < before, "the live texture snapped to the sharper edge: " + backend.state.painted + " < " + before);
  let area = 0;
  floor2.mask.forEach((v) => (area += v));
  assert.equal(backend.state.painted, area);
});

t("stage: a scene that vanishes mid-way (null) is ignored, and turning the engine off takes the preview down", async function () {
  const { renderer, backend } = await makeRenderer();
  const scan = twoSurfaceScan();
  const floor = scan.regions.find((r) => r.kind === "floor");
  renderer.prefetch([ITEM("oak").texture.url]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const props = { fastEnabled: true, fastScene: sceneFor(scan), fastMaterial: { regionId: floor.id, item: ITEM("oak"), rotation: 0, mask: floor.mask } };
  const stage = fakeStage(renderer, props);
  stage.fastCanvasElement = canvas();
  stage.runFastRender(renderer, canvas());
  assert.ok(backend.state.painted > 0);
  stage.props = Object.assign({}, props, { fastScene: null });
  assert.doesNotThrow(() => stage.runFastRender(renderer, canvas()), "a null scene during async start-up must not throw");
  stage.props = Object.assign({}, props, { fastEnabled: false });
  stage.maybeFastRender();
  assert.equal(backend.state.painted, 0, "switching the engine off clears the canvas");
});

t("the scene composer keeps identities stable and borrows an estimate for surfaces the real fit does not know", function () {
  const scan = twoSurfaceScan();
  let builds = 0;
  const composer = composerModule.createSceneComposer(function (s) {
    builds += 1;
    const fusionRegions = {};
    s.regions.forEach((r) => (fusionRegions[r.id] = { homography: [1, 0, 0, 0, 1, 0, 0, 0, 1], confidence: 0.6, provisional: true }));
    return { kind: "provisional", scan: s, fusionRegions: fusionRegions };
  });
  const light = { luma: new Float32Array(W * H), linear: new Float32Array(W * H) };
  assert.equal(composer.compose(scan, null, null), null, "no photo light yet: nothing to draw on");
  const p1 = composer.compose(scan, null, light);
  assert.equal(p1.kind, "provisional");
  assert.equal(composer.compose(scan, null, light), p1, "same inputs, same object");
  assert.equal(builds, 1);
  // a real fit that knows only the wall
  const wall = scan.regions.find((r) => r.kind === "wall");
  const floor = scan.regions.find((r) => r.kind === "floor");
  const fused = { kind: "fused", geometryKey: "fused-1", scan: scan, fusionRegions: { [wall.id]: { plane: {}, confidence: 0.9 } }, luma: null };
  const mixed = composer.compose(scan, fused, light);
  assert.ok(mixed.fusionRegions[wall.id].plane, "the wall keeps its real plane");
  assert.ok(mixed.fusionRegions[floor.id].provisional, "the floor borrows the estimate");
  assert.notEqual(mixed.geometryKey, "fused-1", "a different set of surfaces is a different geometry");
  assert.equal(composer.compose(scan, fused, light), mixed);
  // a scan edit that keeps every id: same geometry key, new scan object -> the stage only swaps labels
  const edited = regions.paintRegion(scan, floor.id, floor.mask, "replace");
  const after = composer.compose(edited, fused, light);
  assert.equal(after.geometryKey, mixed.geometryKey);
  assert.equal(after.scan, edited);
});

t("a weak fit (below the threshold) gets the outline estimate instead of leaving the surface without a preview", function () {
  const scan = twoSurfaceScan();
  const composer = composerModule.createSceneComposer(function (s) {
    const fusionRegions = {};
    s.regions.forEach((r) => (fusionRegions[r.id] = { homography: [1, 0, 0, 0, 1, 0, 0, 0, 1], confidence: 0.6, provisional: true }));
    return { kind: "provisional", scan: s, fusionRegions: fusionRegions };
  });
  const light = { luma: new Float32Array(W * H), linear: new Float32Array(W * H) };
  const wall = scan.regions.find((r) => r.kind === "wall");
  const floor = scan.regions.find((r) => r.kind === "floor");
  const fused = { kind: "fused", geometryKey: "fused-2", scan: scan, fusionRegions: { [wall.id]: { plane: {}, confidence: 0.425 }, [floor.id]: { plane: {}, confidence: 0.86 } }, luma: null };
  const strict = composer.compose(scan, fused, light, 0.45);
  assert.ok(strict.fusionRegions[wall.id].provisional, "0.425 is below 0.45: the wall is drawn from the outline estimate, not left blank");
  assert.ok(strict.fusionRegions[floor.id].plane, "a good fit is kept");
  const lenient = composer.compose(scan, fused, light, 0.3);
  assert.ok(lenient.fusionRegions[wall.id].plane, "0.425 is fine when the threshold is 0.3");
  assert.notEqual(strict, lenient, "a different threshold is a different composition");
  assert.equal(composer.compose(scan, fused, light, 0.3), lenient, "same inputs, same object");
});

// ---------------------------------------------------------------- why the preview is not drawn
t("previewReason: says nothing until a surface AND a finish are chosen, and nothing when the preview is drawn", function () {
  const ok = { hasSurface: true, hasItem: true, selectedCount: 1, hasScene: true, itemHasTexture: true, fit: { confidence: 0.8 }, lowThreshold: 0.3 };
  assert.equal(reasonModule.previewReason(null), null);
  assert.equal(reasonModule.previewReason(Object.assign({}, ok, { hasItem: false })), null);
  assert.equal(reasonModule.previewReason(Object.assign({}, ok, { hasSurface: false })), null);
  assert.equal(reasonModule.previewReason(ok), null);
  assert.equal(reasonModule.previewReason(Object.assign({}, ok, { fit: { confidence: 0.3 } })), null, "at the threshold it is still drawn");
});

t("previewReason: each silent no-draw case now has its own reason, in the order the studio meets them", function () {
  const ok = { hasSurface: true, hasItem: true, selectedCount: 1, hasScene: true, itemHasTexture: true, fit: { confidence: 0.8 }, lowThreshold: 0.3 };
  const code = (patch) => (reasonModule.previewReason(Object.assign({}, ok, patch)) || {}).code;
  assert.equal(code({ engineOff: true, hasScene: false }), "engine-off");
  assert.equal(code({ selectedCount: 3 }), "many-surfaces");
  assert.equal(code({ selectedCount: 2, busy: true }), "many-surfaces");
  assert.equal(code({ busy: true }), "busy");
  assert.equal(code({ rendererFailed: true, hasScene: false }), "no-gpu");
  assert.equal(code({ hasScene: false }), "not-ready");
  assert.equal(code({ itemHasTexture: false }), "no-texture");
  assert.equal(code({ fit: undefined }), "no-fit"); // a chair, bed, window: only wall, floor and ceiling are fitted
  assert.equal(code({ fit: { confidence: 0.29 } }), "weak-fit");
  assert.equal(code({ fit: { confidence: NaN } }), "weak-fit");
  // every reason carries words a visitor can read
  ["engine-off", "many-surfaces", "busy", "no-gpu", "not-ready", "no-texture", "no-fit", "weak-fit"].forEach(function (c) {
    const patch = { "engine-off": { engineOff: true }, "many-surfaces": { selectedCount: 2 }, busy: { busy: true }, "no-gpu": { rendererFailed: true }, "not-ready": { hasScene: false }, "no-texture": { itemHasTexture: false }, "no-fit": { fit: undefined }, "weak-fit": { fit: { confidence: 0.1 } } }[c];
    const reason = reasonModule.previewReason(Object.assign({}, ok, patch));
    assert.ok(reason.text.length > 30 && !/gemini|moge|sam 3|marigold/i.test(reason.text), c + ": " + reason.text);
  });
});

t("previewReason agrees with tiers.canUseFastRender for every combination the studio can produce", function () {
  const tiers = require_tiers;
  const items = [{ texture: { url: "/t.png" } }, { texture: null }];
  const fits = [undefined, { confidence: 0.1 }, { confidence: 0.3 }, { confidence: 0.5 }, { confidence: 0.9 }];
  items.forEach(function (item) {
    fits.forEach(function (fit) {
      const settings = { fusionLowThreshold: 0.3, fusionHighThreshold: 0.7 };
      const drawn = tiers.canUseFastRender(true, fit ? fit.confidence : NaN, item, settings);
      const reason = reasonModule.previewReason({ hasSurface: true, hasItem: true, selectedCount: 1, hasScene: true, itemHasTexture: tiers.canFastRenderItem(item), fit: fit, lowThreshold: 0.3 });
      assert.equal(reason === null, drawn, JSON.stringify({ item: !!item.texture, fit: fit }));
    });
  });
});

// ================================================================ NEW: what the overlay adds
// ---------------------------------------------------------------- 1. the light colour
t("the light colour: lumaFromRgba() also returns the photo's mean colour as linear RGB at luminance 1, each channel kept within [0.55, 1.7]; luma and linear are unchanged", function () {
  const photo = (r, g, b, n = 64) => {
    const rgba = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i += 1) rgba.set([r, g, b, 255], i * 4);
    return geometry.lumaFromRgba(rgba, n, 1);
  };
  const grey = photo(128, 128, 128);
  grey.tint.forEach((c) => assert.ok(Math.abs(c - 1) < 1e-6, "a grey room has no colour cast: " + grey.tint));
  const warm = photo(190, 170, 150);
  assert.ok(warm.tint[0] > 1 && warm.tint[2] < 1 && warm.tint[0] > warm.tint[1] && warm.tint[1] > warm.tint[2], "a warm room: " + warm.tint);
  assert.ok(Math.abs(0.2126 * warm.tint[0] + 0.7152 * warm.tint[1] + 0.0722 * warm.tint[2] - 1) < 1e-6, "luminance 1, so the tint changes colour and not brightness");
  const red = photo(255, 0, 0);
  assert.deepEqual(red.tint, [1.7, 0.55, 0.55], "an extreme room is clamped, never to black or to a single channel");
  assert.deepEqual(photo(0, 0, 0).tint, [1, 1, 1], "a black photo has no colour to report");
  // luma / linear are what they were (the sRGB table must give the same numbers as the formula)
  assert.ok(Math.abs(warm.linear[0] - (0.2126 * geometry.srgbToLinear(190) + 0.7152 * geometry.srgbToLinear(170) + 0.0722 * geometry.srgbToLinear(150))) < 1e-6);
  assert.ok(Math.abs(warm.luma[0] - (0.2126 * 190 + 0.7152 * 170 + 0.0722 * 150) / 255) < 1e-6);
});

t("the light colour reaches the GPU backend mixed 30% toward white (TINT_STRENGTH), and white when the scene has none", async function () {
  const { renderer, backend } = await makeRenderer();
  const scan = twoSurfaceScan();
  renderer.uploadScene(sceneFor(scan));
  assert.deepEqual(backend.state.lastScene.tint, [1, 1, 1], "no tint in the scene: white");
  renderer.uploadScene(Object.assign(sceneFor(scan, "g2"), { tint: [1.5, 1, 0.7] }));
  const mixed = backend.state.lastScene.tint;
  [1.15, 1, 0.91].forEach((expected, i) => assert.ok(Math.abs(mixed[i] - expected) < 1e-9, "channel " + i + ": " + mixed[i]));
  // the same, from the estimate path: buildProvisionalScene() carries the photo's tint, and a photo without one gives none
  const light = { luma: new Float32Array(W * H).fill(0.5), linear: new Float32Array(W * H).fill(0.3), tint: [1.2, 1, 0.8] };
  assert.deepEqual(provisional.buildProvisionalScene(scan, light).tint, [1.2, 1, 0.8]);
  assert.equal(provisional.buildProvisionalScene(scan, { luma: light.luma, linear: light.linear }).tint, null);
  renderer.uploadScene(provisional.buildProvisionalScene(scan, light));
  [1.06, 1, 0.94].forEach((expected, i) => assert.ok(Math.abs(backend.state.lastScene.tint[i] - expected) < 1e-9));
});

t("previewScene.js passes the light colour on: the real fit's own, else the photo's, else none (the fused path and the estimate path)", async function () {
  const scan = twoSurfaceScan();
  const wall = scan.regions.find((r) => r.kind === "wall");
  const floor = scan.regions.find((r) => r.kind === "floor");
  const light = { luma: new Float32Array(W * H).fill(0.5), linear: new Float32Array(W * H).fill(0.3), tint: [1.2, 1, 0.8] };
  const noLight = { luma: light.luma, linear: light.linear };
  const fit = (extra) => Object.assign({ kind: "fused", geometryKey: "g", scan: scan, fusionRegions: { [wall.id]: { plane: {}, confidence: 0.9 }, [floor.id]: { plane: {}, confidence: 0.9 } }, luma: null }, extra);
  const composer = () => composerModule.createSceneComposer(provisional.buildProvisionalScene);
  assert.deepEqual(composer().compose(scan, fit(), light).tint, [1.2, 1, 0.8], "the fused path takes the photo's light colour");
  assert.deepEqual(composer().compose(scan, fit({ tint: [1, 1.1, 1] }), light).tint, [1, 1.1, 1], "the fit's own wins");
  assert.equal(composer().compose(scan, fit(), noLight).tint, null, "neither: none");
  assert.equal(composer().compose(scan, fit(), null).tint, null, "no photo light at all: none");
  assert.deepEqual(composer().compose(scan, null, light).tint, [1.2, 1, 0.8], "the estimate path");
  // and all the way to the backend, for a fused scene whose floor borrows the estimate (a weak fit)
  const { renderer, backend } = await makeRenderer();
  const mixedScene = composer().compose(scan, fit({ fusionRegions: { [wall.id]: { plane: {}, confidence: 0.9 }, [floor.id]: { plane: {}, confidence: 0.1 } } }), light, 0.3);
  assert.ok(mixedScene.fusionRegions[floor.id].provisional, "the floor borrowed the estimate");
  assert.deepEqual(mixedScene.tint, [1.2, 1, 0.8]);
  const planes = sceneFor(scan, "g9");
  renderer.uploadScene(Object.assign({}, planes, { tint: composer().compose(scan, planes, light).tint }));
  [1.06, 1, 0.94].forEach((expected, i) => assert.ok(Math.abs(backend.state.lastScene.tint[i] - expected) < 1e-9, "fused scene to the backend, channel " + i));
});

// ---------------------------------------------------------------- 2. the light of a surface
function singleRegionScan(width, height, kind, mask) {
  const labelMap = new Uint16Array(width * height);
  const kinds = [{ index: 1, label: "Floor", kind: kind, source: "scene" }];
  if (mask) {
    for (let i = 0; i < labelMap.length; i += 1) labelMap[i] = mask[i] ? 1 : 2;
    kinds.push({ index: 2, label: "Window", kind: "window", source: "scene" });
  } else {
    labelMap.fill(1);
  }
  return regions.scanFromLabelMap(labelMap, kinds, width, height);
}

t("the light of a surface is read inside that surface only: a window or lamp beside it does not leak in (the old whole-photo blur let it)", function () {
  const w = 120;
  const h = 80;
  const mask = new Uint8Array(w * h);
  const linear = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      mask[y * w + x] = x < 60 ? 1 : 0;
      linear[y * w + x] = x < 60 ? 0.2 : 6.0; // a dim floor next to a window 30 times brighter
    }
  }
  const scan = singleRegionScan(w, h, "floor", mask);
  const shading = provisional.regionShading(scan, linear);
  const old = provisional.boxBlur(linear, w, h, Math.max(w, h) * 0.03);
  let leak = 0;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < 60; x += 1) leak = Math.max(leak, Math.abs(shading[y * w + x] - 0.2));
  assert.ok(leak < 1e-4, "inside the floor the light is the floor's own, right up to the window: max error " + leak);
  assert.ok(old[40 * w + 58] > 1, "the old blur put " + old[40 * w + 58].toFixed(2) + " there instead of 0.2");
  assert.equal(shading[40 * w + 100], old[40 * w + 100], "outside the painted surfaces nothing changed (those pixels are never drawn)");
  // a tiny region (under 0.4% of the picture) and kinds that are never painted keep the old blur too
  const lm = new Uint16Array(w * h).fill(1);
  const windowScan = regions.scanFromLabelMap(lm, [{ index: 1, label: "Window", kind: "window", source: "scene" }], w, h);
  assert.deepEqual(provisional.regionShading(windowScan, linear), old);
});

t("...and it keeps the sun / shadow edge the old blur erased, flattens the old finish's grain, and keeps a smooth fall-off (1024 x 683, the scan size)", function () {
  const w = 1024;
  const h = 683;
  const edge = w / 2;
  const scan = singleRegionScan(w, h, "floor");
  const linear = new Float32Array(w * h);
  const ramp = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const grain = Math.floor(x / 3) % 2 ? 1.12 : 0.88; // old plank / grout detail, +-12%, 6 px period
      linear[y * w + x] = (x < edge ? 0.1 : 0.4) * grain; // a shadow edge: 4 to 1
      ramp[y * w + x] = 0.5 - (0.4 * x) / (w - 1); // a soft fall-off toward the far wall
    }
  }
  const shading = provisional.regionShading(scan, linear);
  const old = provisional.boxBlur(linear, w, h, Math.max(w, h) * 0.03);
  const row = Math.floor(h / 2) * w;
  const across = (a, d) => a[row + edge + d] / a[row + edge - d - 1];
  assert.ok(across(shading, 6) > 3, "6 px either side of the shadow edge the light still differs 3x or more (true: 4x): " + across(shading, 6).toFixed(2));
  assert.ok(across(old, 6) < 1.5, "the old blur had turned it into " + across(old, 6).toFixed(2) + "x");
  let grain = 0;
  let rawGrain = 0;
  for (let x = 60; x < edge - 60; x += 1) {
    grain = Math.max(grain, Math.abs(shading[row + x + 1] - shading[row + x]) / shading[row + x]);
    rawGrain = Math.max(rawGrain, Math.abs(linear[row + x + 1] - linear[row + x]) / linear[row + x]);
  }
  assert.ok(rawGrain > 0.25 && grain < 0.005, "the old finish's grain is gone from the light: " + grain.toFixed(4) + " (photo: " + rawGrain.toFixed(2) + ")");
  const smooth = provisional.regionShading(scan, ramp);
  let worst = 0;
  for (let x = 40; x < w - 40; x += 1) worst = Math.max(worst, Math.abs(smooth[row + x] / ramp[row + x] - 1));
  assert.ok(worst < 0.01, "a gradual fall-off is kept to within 1%: " + worst.toFixed(4));
});

// ---------------------------------------------------------------- 3. the level-camera guess for floors, ceilings and head-on walls
const PRIOR_W = 160;
const PRIOR_H = 100;
function shapeRegion(kind, x0, y0, x1, y1, topEdge) {
  const mask = new Uint8Array(PRIOR_W * PRIOR_H);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const top = topEdge ? topEdge(x) : y0;
      if (y >= top) mask[y * PRIOR_W + x] = 1;
    }
  }
  return { id: kind, kind: kind, mask: mask, bbox: { x0: x0, y0: y0, x1: x1, y1: y1 }, areaShare: (mask.reduce((a, b) => a + b, 0)) / (PRIOR_W * PRIOR_H) };
}
// where a picture point lands on a plane, derived from the camera's pose in world coordinates (Y up, Z forward) and not from the
// module's plane algebra: the camera is `h` above the floor and pitched down by p; the floor / ceiling is a horizontal plane
// (signedHeight = h for the floor, -(ceiling - h) for the ceiling), a head-on wall is a vertical plane at forward distance D.
function ray(x, y, intr, p) {
  const a = (x - intr.cx) / intr.fx;
  const b = (y - intr.cy) / intr.fy;
  return { a: a, b: b, cp: Math.cos(p), sp: Math.sin(p) };
}
const onHorizontalPlane = (x, y, intr, p, signedHeight) => {
  const r = ray(x, y, intr, p);
  const t = signedHeight / (r.b * r.cp + r.sp);
  return [t * r.a, t * (r.cp - r.b * r.sp)]; // sideways, forward
};
const onHeadOnWall = (x, y, intr, p, distance) => {
  const r = ray(x, y, intr, p);
  const t = distance / (r.cp - r.b * r.sp);
  return [t * r.a, t * (r.b * r.cp + r.sp)]; // sideways, DOWN from eye level
};
const near = (got, want, what) => assert.ok(Math.abs(got - want) <= 1e-6 * Math.max(1, Math.abs(want)), what + ": " + got + " vs " + want);

t("the level-camera guess: the assumed heights, and a floor / ceiling lands where a camera 1.5 m up, looking level, would put it", function () {
  assert.equal(provisional.CAMERA_HEIGHT_M, 1.5);
  assert.equal(provisional.CEILING_HEIGHT_M, 2.6);
  const intr = provisional.assumedIntrinsics(PRIOR_W, PRIOR_H);
  const scan = { width: PRIOR_W, height: PRIOR_H, labelMap: new Uint16Array(PRIOR_W * PRIOR_H), regions: [] };
  // floor in the lower part: the horizon stays at the picture's centre (pitch 0)
  const floor = shapeRegion("floor", 0, 70, PRIOR_W, PRIOR_H);
  scan.regions = [floor];
  const flat = provisional.provisionalRegion(floor, scan, intr);
  assert.equal(flat.quad, undefined, "this is the guess, not the four-corner estimate");
  [[10, 72], [80, 85], [150, 99], [40, 71]].forEach(function ([x, y]) {
    const [u, v] = geometry.applyHomography(flat.homography, x, y);
    const [wu, wv] = onHorizontalPlane(x, y, intr, 0, provisional.CAMERA_HEIGHT_M);
    near(u, wu, "floor u at " + x + "," + y);
    near(v, wv, "floor v at " + x + "," + y);
  });
  assert.ok(Math.abs(flat.homography[7]) > 1e-3, "real perspective: the old four-corner estimate of a floor that runs off both sides had ~1e-6 here");
  // the nearer a row, the smaller its metres per pixel (the far floor is stretched): the old poster had one scale for the whole floor
  const near1 = geometry.applyHomography(flat.homography, 80, 99)[1] - geometry.applyHomography(flat.homography, 80, 98)[1];
  const far1 = geometry.applyHomography(flat.homography, 80, 72)[1] - geometry.applyHomography(flat.homography, 80, 71)[1];
  assert.ok(Math.abs(far1) > 4 * Math.abs(near1), "one row covers about five times more floor at the back (row 72) than at the front (row 99): " + far1 + " vs " + near1);
  // a floor that starts above the picture's centre pushes the horizon up (6% of the height above its top row), i.e. pitches the camera down
  const high = shapeRegion("floor", 0, 35, PRIOR_W, PRIOR_H);
  scan.regions = [high];
  const pitched = provisional.provisionalRegion(high, scan, intr);
  const p = Math.atan((intr.cy - (35 - 0.06 * PRIOR_H)) / intr.fy);
  assert.ok(p > 0.1, "a pitch of " + ((p * 180) / Math.PI).toFixed(1) + " degrees");
  [[10, 40], [80, 70], [150, 99]].forEach(function ([x, y]) {
    const [u, v] = geometry.applyHomography(pitched.homography, x, y);
    const [wu, wv] = onHorizontalPlane(x, y, intr, p, provisional.CAMERA_HEIGHT_M);
    near(u, wu, "pitched floor u at " + x + "," + y);
    near(v, wv, "pitched floor v at " + x + "," + y);
  });
  // a ceiling is a plane 2.6 - 1.5 = 1.1 m above the camera
  const ceiling = shapeRegion("ceiling", 0, 0, PRIOR_W, 15);
  scan.regions = [ceiling];
  const top = provisional.provisionalRegion(ceiling, scan, intr);
  assert.equal(top.quad, undefined);
  [[10, 2], [80, 8], [150, 14]].forEach(function ([x, y]) {
    const [u, v] = geometry.applyHomography(top.homography, x, y);
    const [wu, wv] = onHorizontalPlane(x, y, intr, 0, -(provisional.CEILING_HEIGHT_M - provisional.CAMERA_HEIGHT_M));
    near(u, wu, "ceiling u at " + x + "," + y);
    near(v, wv, "ceiling v at " + x + "," + y);
  });
  // sizes are the extent of the bounding box on the plane
  const corners = [geometry.applyHomography(flat.homography, 0, 70), geometry.applyHomography(flat.homography, PRIOR_W, PRIOR_H)];
  near(flat.widthM, Math.abs(corners[1][0] - corners[0][0]), "floor widthM");
  near(flat.heightM, Math.abs(corners[1][1] - corners[0][1]), "floor heightM");
});

t("the level-camera guess: a head-on wall stands where it meets the floor; a slanted wall, or a ceiling that reaches below the horizon, keeps the old four-corner estimate", function () {
  const intr = provisional.assumedIntrinsics(PRIOR_W, PRIOR_H);
  const scan = { width: PRIOR_W, height: PRIOR_H, labelMap: new Uint16Array(PRIOR_W * PRIOR_H), regions: [] };
  const floor = shapeRegion("floor", 0, 70, PRIOR_W, PRIOR_H);
  const wall = shapeRegion("wall", 10, 15, 110, 70);
  scan.regions = [floor, wall];
  const head = provisional.provisionalRegion(wall, scan, intr);
  assert.equal(head.quad, undefined, "level top edge: the guess");
  const distance = (provisional.CAMERA_HEIGHT_M * intr.fy) / (70 - intr.cy); // the ray through the wall's foot (row 70) meets the floor here
  [[12, 17], [60, 40], [108, 69]].forEach(function ([x, y]) {
    const [u, v] = geometry.applyHomography(head.homography, x, y);
    const [wu, wv] = onHeadOnWall(x, y, intr, 0, distance);
    near(u, wu, "wall u at " + x + "," + y);
    near(v, wv, "wall v at " + x + "," + y);
  });
  near(geometry.applyHomography(head.homography, 60, 70)[1], provisional.CAMERA_HEIGHT_M, "the foot of the wall is one camera height below eye level");
  // a wall whose top edge slopes (seen at an angle) is not head-on: the old estimate, which sizes it by the 2.6 m ceiling height
  const slanted = shapeRegion("wall", 20, 20, 140, 70, (x) => 20 + ((x - 20) / 120) * 20);
  scan.regions = [floor, slanted];
  const oblique = provisional.provisionalRegion(slanted, scan, intr);
  assert.ok(oblique.quad, "the four-corner estimate is used");
  assert.equal(provisional.buildProvisionalScene(Object.assign({}, scan, { regions: [floor, slanted] }), { luma: new Float32Array(PRIOR_W * PRIOR_H), linear: new Float32Array(PRIOR_W * PRIOR_H).fill(0.3) }).fusionRegions.wall.sizeM.height, provisional.WALL_HEIGHT_M);
  // a ceiling that dips below the horizon cannot be a plane above the camera
  const lowCeiling = shapeRegion("ceiling", 0, 0, PRIOR_W, 60);
  scan.regions = [lowCeiling];
  assert.ok(provisional.provisionalRegion(lowCeiling, scan, intr).quad, "no guess: the old estimate");
  // a wall cut off at both the top and the bottom of the picture has nothing to go on either
  const tall = shapeRegion("wall", 10, 0, 110, PRIOR_H);
  scan.regions = [tall];
  assert.ok(provisional.provisionalRegion(tall, scan, intr).quad);
});

// ---------------------------------------------------------------- 4. the shaders
const glslModule = await load("lib/fastrender/shaders/swap.glsl.js");
const wgslModule = await load("lib/fastrender/shaders/swap.wgsl.js");
const GLSL = glslModule.SWAP_FRAGMENT_GLSL;
const WGSL = wgslModule.SWAP_WGSL;
const numberIn = (source, pattern, what) => {
  const m = source.match(pattern);
  assert.ok(m, "not found in the shader: " + what);
  return Number(m[1]);
};

t("shaders: both clamp the light to the same range as geometry.js (it is written in three places and they must agree)", function () {
  assert.equal(numberIn(GLSL, /const float SHADING_MIN = ([\d.]+);/, "GLSL SHADING_MIN"), geometry.SHADING_MIN);
  assert.equal(numberIn(GLSL, /const float SHADING_MAX = ([\d.]+);/, "GLSL SHADING_MAX"), geometry.SHADING_MAX);
  assert.equal(numberIn(WGSL, /const SHADING_MIN = ([\d.]+);/, "WGSL SHADING_MIN"), geometry.SHADING_MIN);
  assert.equal(numberIn(WGSL, /const SHADING_MAX = ([\d.]+);/, "WGSL SHADING_MAX"), geometry.SHADING_MAX);
});

t("shaders: the highlight roll-off is the same smooth curve in both, continuous at its knee and approaching 1 without reaching it", function () {
  const glsl = GLSL.match(/if \(peak > ([\d.]+)\) \{\s*lit \*= \(([\d.]+) \+ ([\d.]+) \* \(1\.0 - exp\(-\(peak - ([\d.]+)\) \/ ([\d.]+)\)\)\) \/ peak;/);
  const wgsl = WGSL.match(/if \(peak > ([\d.]+)\) \{\s*lit = lit \* \(\(([\d.]+) \+ ([\d.]+) \* \(1\.0 - exp\(-\(peak - ([\d.]+)\) \/ ([\d.]+)\)\)\) \/ peak\);/);
  assert.ok(glsl && wgsl, "the roll-off is in both shaders");
  assert.deepEqual(glsl.slice(1), wgsl.slice(1), "the same numbers in GLSL and WGSL");
  const [knee, base, span, knee2, width] = glsl.slice(1).map(Number);
  assert.deepEqual([knee, base, knee2], [0.85, 0.85, 0.85]);
  assert.ok(Math.abs(base + span - 1) < 1e-12 && width === span, "the curve ends at 1 (full white), reached asymptotically");
  const out = (peak) => (peak <= knee ? peak : base + span * (1 - Math.exp(-(peak - knee2) / width)));
  assert.equal(out(0.85), 0.85, "continuous at the knee: nothing below it changes");
  assert.ok(Math.abs((out(0.85 + 1e-6) - out(0.85)) / 1e-6 - 1) < 1e-4, "and with the same slope (no visible kink)");
  let last = 0;
  [0.5, 0.85, 0.9, 1, 1.5, 3, 10, 100].forEach(function (peak) {
    const o = out(peak);
    assert.ok(o > last || (o === 1 && last === 1), "monotonic: " + peak + " -> " + o);
    assert.ok(o <= 1 && o <= peak, "never above 1 (and never brightens): " + peak + " -> " + o);
    last = o;
  });
  assert.ok(out(1) < 0.95 && out(100) > 0.999, "a pale finish in full sun (peak 1.0) is pulled to " + out(1).toFixed(3) + " and a blown-out one still stays white");
});

t("shaders: the light colour is a uniform in both, multiplied into the lit colour, and the WGSL block has it where the backend writes it (floats 5, 6, 7)", function () {
  assert.match(GLSL, /uniform vec4 u_tint;/);
  assert.match(GLSL, /vec3 lit = material \* lightScale \* u_tint\.rgb \+ vec3\(highlight\);/);
  const struct = WGSL.match(/struct Globals \{([^}]*)\};/);
  assert.ok(struct, "the Globals block");
  const fields = struct[1].replace(/\/\/.*$/gm, "").split(",").map((f) => f.trim().split(":")[0].trim()).filter(Boolean);
  assert.deepEqual(fields, ["sceneWidth", "sceneHeight", "canvasWidth", "canvasHeight", "regionCount", "tintR", "tintG", "tintB"]);
  assert.match(WGSL, /var lit = material \* lightScale \* vec3<f32>\(globals\.tintR, globals\.tintG, globals\.tintB\) \+ vec3<f32>\(highlight, highlight, highlight\);/);
});

t("shaders: a pixel with no finish of its own borrows the label of a neighbour that has one (4 neighbours), so the soft edge works on both sides of a boundary", function () {
  const common = (source) => {
    assert.match(source, /ownActive/, "the own-label test");
    assert.match(source, /labelId = owner;/, "the borrowed label is used from there on");
    assert.match(source, /regionData\[\(other - 1\) \* 5 \+ 3\]\.z > 0\.5/, "only a neighbour that is painted counts");
    assert.match(source, /regionData\[\(labelId - 1\) \* 5 \+ 3\]\.z > 0\.5/, "the pixel's own label counts only when it is painted");
  };
  common(GLSL);
  common(WGSL);
  assert.match(GLSL, /for \(int k = 0; k < 4; k\+\+\)/);
  assert.match(WGSL, /for \(var k = 0; k < 4; k = k \+ 1\)/);
  for (const source of [GLSL, WGSL]) {
    for (const d of ["(1, 0)", "(-1, 0)", "(0, 1)", "(0, -1)"]) assert.ok(source.includes(d), "the neighbour " + d);
    assert.ok(source.indexOf("owner == 0") > -1 && /return|fragColor = vec4\(0\.0\)/.test(source));
  }
});

// ---------------------------------------------------------------- 5. the backends, against a fake GL and a fake GPU
function fakeGl({ maxAnisotropy = 16, anisotropic = true } = {}) {
  const calls = [];
  const constant = (name) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 100003, 7) + 1000;
  const target = { canvas: { width: 100, height: 60 }, calls: calls };
  return new Proxy(target, {
    get(t0, prop) {
      if (prop in t0) return t0[prop];
      if (typeof prop === "symbol") return undefined;
      if (/^[A-Z0-9_]+$/.test(prop)) return constant(prop);
      return (...args) => {
        calls.push([prop, ...args]);
        if (prop === "getShaderParameter" || prop === "getProgramParameter") return true;
        if (prop === "getUniformLocation") return { name: args[1] };
        if (prop === "getParameter") return maxAnisotropy;
        if (prop === "getExtension") return args[0] === "EXT_texture_filter_anisotropic" && anisotropic ? { TEXTURE_MAX_ANISOTROPY_EXT: 34046, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 34047 } : null;
        return {};
      };
    },
  });
}
const REGION = { h: [1, 0, 0, 0, 1, 0, 0, 0, 1], invTileWidthM: 1, invTileHeightM: 1, cosRot: 1, sinRot: 0, materialLayer: 0, active: true, medianShading: 1, exposure: 1, specStrength: 0 };
const smallScene = (extra) => Object.assign({ width: 4, height: 3, labelMap: new Uint16Array(12).fill(1), depth: new Float32Array(12).fill(1), shading: new Float32Array(12).fill(1), residual: new Float32Array(12), luma: new Float32Array(12).fill(0.5) }, extra);

t("webgl2: every draw sends the light colour as u_tint (white by default, the new one after a new upload)", function () {
  const gl = fakeGl();
  const backend = webgl2Module.createWebGL2Backend(gl);
  backend.uploadScene(smallScene({ tint: [1.15, 1, 0.91] }));
  backend.setRegions([REGION]);
  backend.setMaterialLayer(0, {}, 8, 8);
  assert.ok(gl.calls.some((c) => c[0] === "getUniformLocation" && c[2] === "u_tint"), "the program's own uniform is looked up by the name the GLSL declares");
  gl.calls.length = 0;
  backend.render();
  const tints = () => gl.calls.filter((c) => c[0] === "uniform4f" && c[1].name === "u_tint");
  assert.deepEqual(tints().map((c) => c.slice(2)), [[1.15, 1, 0.91, 1]]);
  backend.uploadScene(smallScene());
  backend.render();
  assert.deepEqual(tints().at(-1).slice(2), [1, 1, 1, 1], "a scene without a tint is drawn white");
  backend.uploadScene(smallScene({ tint: [0.9, 1, 1.2] }));
  backend.render();
  assert.deepEqual(tints().at(-1).slice(2), [0.9, 1, 1.2, 1]);
});

t("webgl2: the material array asks for 8x anisotropic filtering (less where the GPU allows less, none where the browser has no such extension)", function () {
  const anisoCalls = (gl) => gl.calls.filter((c) => c[0] === "texParameterf");
  let gl = fakeGl({ maxAnisotropy: 16 });
  webgl2Module.createWebGL2Backend(gl).setMaterialLayer(0, {}, 8, 8);
  assert.deepEqual(anisoCalls(gl).map((c) => c.slice(2)), [[34046, 8]], "capped at 8 on a GPU that allows 16");
  gl = fakeGl({ maxAnisotropy: 4 });
  webgl2Module.createWebGL2Backend(gl).setMaterialLayer(0, {}, 8, 8);
  assert.deepEqual(anisoCalls(gl).map((c) => c.slice(2)), [[34046, 4]], "a GPU limited to 4 gets 4");
  gl = fakeGl({ anisotropic: false });
  webgl2Module.createWebGL2Backend(gl).setMaterialLayer(0, {}, 8, 8);
  assert.deepEqual(anisoCalls(gl), [], "no extension: nothing asked for, nothing broken");
});

function fakeGpu() {
  const writes = [];
  const samplers = [];
  const buffers = [];
  const anything = () => new Proxy(function () {}, { get: (t0, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : prop === "mipLevelCount" ? 1 : anything()), apply: () => anything() });
  const device = {
    addEventListener() {},
    createShaderModule: () => anything(),
    createSampler(descriptor) {
      samplers.push(descriptor);
      return anything();
    },
    createBuffer(descriptor) {
      const buffer = { descriptor: descriptor };
      buffers.push(buffer);
      return buffer;
    },
    createRenderPipeline: () => anything(),
    createTexture: () => anything(),
    createBindGroup: () => anything(),
    createCommandEncoder: () => anything(),
    queue: {
      writeBuffer(buffer, offset, data) {
        writes.push({ buffer: buffer, data: Array.from(data) });
      },
      writeTexture() {},
      submit() {},
    },
  };
  return { device: device, writes: writes, samplers: samplers, buffers: buffers, context: { canvas: { width: 100, height: 60 }, getCurrentTexture: () => anything() } };
}

t("webgpu: the sampler asks for 8x anisotropy (all three filters linear, which that needs), and the light colour is written at floats 5-7 of the globals block", function () {
  const saved = { GPUBufferUsage: globalThis.GPUBufferUsage, GPUTextureUsage: globalThis.GPUTextureUsage };
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 };
  try {
    const gpu = fakeGpu();
    const backend = webgpuModule.createWebGPUBackend(gpu.device, gpu.context, "bgra8unorm");
    const sampler = gpu.samplers[0];
    assert.equal(sampler.maxAnisotropy, 8);
    assert.deepEqual([sampler.magFilter, sampler.minFilter, sampler.mipmapFilter], ["linear", "linear", "linear"]);
    const globals = gpu.buffers[0];
    assert.equal(globals.descriptor.size, 32, "the first buffer is the 8-float globals block");
    backend.uploadScene(smallScene({ tint: [1.15, 1, 0.91] }));
    const last = () => gpu.writes.filter((w) => w.buffer === globals).at(-1).data;
    const f32 = Math.fround;
    assert.deepEqual(last(), [4, 3, 100, 60, 0, f32(1.15), 1, f32(0.91)], "scene size, canvas size, region count, then the tint");
    backend.uploadScene(smallScene());
    assert.deepEqual(last().slice(5), [1, 1, 1], "a scene without a tint is drawn white");
    backend.setRegions([REGION]);
    backend.uploadScene(smallScene({ tint: [0.9, 1, 1.2] }));
    backend.render();
    assert.deepEqual(last().slice(5), [f32(0.9), 1, f32(1.2)], "and render() writes it again (the canvas may have been resized)");
  } finally {
    Object.assign(globalThis, saved);
    if (saved.GPUBufferUsage === undefined) delete globalThis.GPUBufferUsage;
    if (saved.GPUTextureUsage === undefined) delete globalThis.GPUTextureUsage;
  }
});

// ---------------------------------------------------------------- 6. the seam repair on the catalogue textures
t("textures: the tile is cross-faded into a half-tile-shifted copy of itself near its borders, so a repeating tile has no hard seam, and its middle is untouched", async function () {
  const TW = 640;
  const TH = 448;
  const source = { pixels: new Uint8ClampedArray(TW * TH * 4), close() {} };
  for (let y = 0; y < TH; y += 1) {
    for (let x = 0; x < TW; x += 1) {
      // a smooth picture whose borders do not match: red climbs 0..255 left to right, green 0..255 top to bottom (a hard seam on all four sides when tiled)
      source.pixels.set([Math.round((255 * x) / (TW - 1)), Math.round((255 * y) / (TH - 1)), 128, 255], (y * TW + x) * 4);
    }
  }
  const saved = { fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      this.pixels = new Uint8ClampedArray(w * h * 4);
    }
    getContext() {
      const canvas = this;
      return {
        drawImage: (image) => canvas.pixels.set(image.pixels),
        getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(canvas.pixels) }),
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (image) => canvas.pixels.set(image.data),
      };
    }
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, blob: async () => ({ isBlob: true }) });
  globalThis.createImageBitmap = async (what) => (what && what.isBlob ? source : { pixels: new Uint8ClampedArray(what.pixels), close() {} });
  try {
    const backend = fakeBackend();
    let layer = null;
    backend.setMaterialLayer = (index, bitmap, w, h) => (layer = { bitmap: bitmap, w: w, h: h });
    const renderer = await rendererModule.createFastRenderer({}, { backend: backend }); // the real texture loader
    const scan = twoSurfaceScan();
    renderer.uploadScene(sceneFor(scan));
    assert.equal(await renderer.setMaterial(scan.regions.find((r) => r.kind === "floor").id, ITEM("oak"), 0), true);
    assert.deepEqual([layer.w, layer.h], [TW, TH]);
    const px = (x, y, c) => layer.bitmap.pixels[(y * TW + x) * 4 + c];
    const src = (x, y, c) => source.pixels[(y * TW + x) * 4 + c];
    // before: the seam when tiled (the right edge next to the left edge) was the whole range
    assert.equal(Math.abs(src(TW - 1, 200, 0) - src(0, 200, 0)), 255);
    assert.equal(Math.abs(src(300, TH - 1, 1) - src(300, 0, 1)), 255);
    // after: the two edges match to within a few levels, on every row and column
    let worst = 0;
    for (let y = 0; y < TH; y += 1) worst = Math.max(worst, Math.abs(px(TW - 1, y, 0) - px(0, y, 0)));
    for (let x = 0; x < TW; x += 1) worst = Math.max(worst, Math.abs(px(x, TH - 1, 1) - px(x, 0, 1)));
    assert.ok(worst <= 3, "left/right and top/bottom edges now meet: worst step " + worst);
    // no step inside the cross-faded band is larger than a few levels either (it is a fade, not a new seam)
    let step = 0;
    for (let x = 0; x < TW - 1; x += 1) step = Math.max(step, Math.abs(px(x + 1, 200, 0) - px(x, 200, 0)));
    assert.ok(step <= 6, "largest step between neighbours along a row: " + step);
    // the middle (beyond 12% of the tile from every border) is exactly the picture, and nothing else about it changed
    for (const [x, y] of [[100, 70], [320, 224], [500, 380], [559, 391]]) for (let c = 0; c < 3; c += 1) assert.equal(px(x, y, c), src(x, y, c), "interior " + x + "," + y + " channel " + c);
    for (let i = 3; i < layer.bitmap.pixels.length; i += 4) assert.equal(layer.bitmap.pixels[i], 255, "opaque");
    assert.equal(px(5, 5, 2), 128, "a channel that was constant stays constant");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});

// ---------------------------------------------------------------- 7. the soft edge needs the scene to survive a label change; and the ported set stays complete
t("the studio's own test list is still the one ported here (a new test upstream must be ported or waived, not forgotten)", function () {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "swatchroom", "tests", "fastrender.test.js"), "utf8");
  const upstream = [...source.matchAll(/^\s*test\(\s*("(?:[^"\\]|\\.)*")/gm)].map((m) => JSON.parse(m[1]));
  const mine = fs.readFileSync(new URL(import.meta.url), "utf8");
  // the names of the three tests whose expectations the overlay changes on purpose (the fourth assertion is inside the third)
  const renamed = new Map([
    ["the shading multiplier is the shading over the surface's median, clamped to [0.35, 1.65]", "CHANGED: the shading multiplier is the shading over the surface's median"],
    ["exposureFor(): gentle, bounded, neutral near a mid-lit surface", "CHANGED: exposureFor(): bounded"],
    ["provisional: buildProvisionalScene() covers wall / floor / ceiling, marks them flagged, keeps only the lighting", "CHANGED: provisional: buildProvisionalScene() covers wall / floor / ceiling"],
  ]);
  assert.equal(upstream.length, 28, "the studio's test file has 28 tests: " + upstream.length);
  for (const name of upstream) {
    const needle = JSON.stringify(name);
    if (renamed.has(name)) assert.ok(mine.includes('t("' + renamed.get(name)), "ported as CHANGED: " + name);
    else assert.ok(mine.includes("t(" + needle), "not ported: " + name);
  }
});
