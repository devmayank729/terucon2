// Tests for the instant preview, without a GPU: the maths (homography from a plane, the light normalisation), the
// provisional geometry made from a scan alone, the canvas sizing, the texture cache, and the renderer facade and the
// stage's state machine driven against a fake backend that "paints" by the same rules the shaders use (a pixel is painted
// only where it has a region with a finish AND the alpha map allows it). Run with:  node tests/fastrender.test.js
const assert = require("node:assert/strict");

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push({ name: name, fn: fn });
}

(async function () {
  const geometry = await import("../public/js/lib/fastrender/geometry.js");
  const provisional = await import("../public/js/lib/fastrender/provisional.js");
  const sizing = await import("../public/js/lib/fastrender/sizing.js");
  const lruModule = await import("../public/js/lib/fastrender/lru.js");
  const storeModule = await import("../public/js/lib/fastrender/textureStore.js");
  const rendererModule = await import("../public/js/lib/fastrender/renderer.js");
  const composerModule = await import("../public/js/lib/previewScene.js");
  const regions = await import("../public/js/lib/regions.js");
  const fusion = require("../server/lib/fusion.js");
  const moge2 = require("../server/lib/remoteModels/moge2.js");

  // ---------------------------------------------------------------- canvas sizing
  test("canvas size follows the screen: frame x devicePixelRatio, never above 2048, same aspect", function () {
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
  test("planeHomography(): picture point -> the plane's own metres, exact (ray / plane intersection)", function () {
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

  test("the shading multiplier is the shading over the surface's median, clamped to [0.35, 1.65]", function () {
    assert.equal(geometry.normalisedShading(0.5, 0.5), 1);
    assert.equal(geometry.normalisedShading(0.05, 0.5), 0.35, "a deep shadow does not turn the finish black");
    assert.equal(geometry.normalisedShading(2, 0.5), 1.65, "a bright spot does not blow it out");
    assert.ok(Math.abs(geometry.normalisedShading(0.6, 0.5) - 1.2) < 1e-9);
    assert.equal(geometry.normalisedShading(0.4, 0), 1, "no median -> neutral");
  });

  test("maskedMedian() reads only masked pixels, ignores zero depth-like holes, and samples big masks sparsely", function () {
    const values = new Float32Array([1, 2, 3, 100, 0, 5]);
    const mask = new Uint8Array([1, 1, 1, 0, 1, 1]);
    assert.equal(geometry.maskedMedian(values, mask), 2.5, "[1,2,3,5] -> 2.5; the 100 is outside the mask, the 0 is ignored");
    assert.equal(geometry.maskedMedian(values, new Uint8Array(6)), null);
    const big = new Float32Array(100000).fill(0.4);
    assert.ok(Math.abs(geometry.maskedMedian(big, new Uint8Array(100000).fill(1), 1000) - 0.4) < 1e-6);
  });

  test("exposureFor(): gentle, bounded, neutral near a mid-lit surface", function () {
    assert.ok(Math.abs(geometry.exposureFor(0.3) - 1) < 1e-9);
    assert.equal(geometry.exposureFor(0.001), 0.7);
    assert.equal(geometry.exposureFor(5), 1.25);
    assert.equal(geometry.exposureFor(null), 1);
  });

  test("specularFor(): words decide - polished things catch highlights, matte ones do not", function () {
    assert.equal(geometry.specularFor({ name: "Gloss white tile", prompt: "" }), geometry.SPECULAR_GLOSSY);
    assert.equal(geometry.specularFor({ name: "Venetian plaster", sub: "Burnished, soft sheen", prompt: "polished" }), geometry.SPECULAR_GLOSSY);
    assert.equal(geometry.specularFor({ name: "Sand limewash", prompt: "matte, chalky" }), geometry.SPECULAR_MATTE);
    assert.equal(geometry.specularFor({ name: "Oak planks", prompt: "natural" }), geometry.SPECULAR_DEFAULT);
    assert.equal(geometry.specularFor(null), geometry.SPECULAR_DEFAULT);
  });

  test("lumaFromRgba(): perceptual luma for edges, linear luminance for exposure", function () {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255]);
    const { luma, linear } = geometry.lumaFromRgba(rgba, 3, 1);
    assert.ok(Math.abs(luma[0] - 1) < 1e-6 && luma[1] === 0);
    assert.ok(Math.abs(luma[2] - 128 / 255) < 1e-3);
    assert.ok(Math.abs(linear[2] - 0.2158) < 0.01, "mid grey (128) is about 22% in linear light: " + linear[2]);
  });

  // ---------------------------------------------------------------- the provisional geometry
  test("provisional: a perspective wall quad gives its true proportions, even with a guessed focal length", function () {
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

  test("provisional: quadFromMask() finds the four corners of a trapezoid floor", function () {
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

  test("provisional: buildProvisionalScene() covers wall / floor / ceiling, marks them flagged, keeps only the lighting", function () {
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
    for (let x = 20; x < 140; x += 1) {
      wiggle = Math.max(wiggle, Math.abs(scene.shading[row + x] - scene.shading[row + x + 1]));
    }
    assert.ok(wiggle < 0.02, "shading is smooth where the photo flickers: " + wiggle);
    assert.ok(scene.shading[row + 20] > scene.shading[row + 140], "but the light falloff is kept");
    assert.ok(scene.luma === light.luma, "the edge guide stays sharp");
    // a wall is 2.6 m tall, a floor 4 m across
    const wall = scan.regions.find((r) => r.kind === "wall");
    assert.equal(scene.fusionRegions[wall.id].sizeM.height, provisional.WALL_HEIGHT_M);
  });

  // ---------------------------------------------------------------- the texture cache
  test("lru: the least recently used entry goes first; reading counts as use; peek does not", function () {
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

  test("textureStore: loads once, serves from memory synchronously, evicts and CLOSES the oldest, retries failures", async function () {
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

  test("textureStore.prefetch(): starts only what is neither loaded nor on its way, never throws", async function () {
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

  test("renderer: setAlphaFromMask() = 1 inside the mask, 0 outside; a wrong-sized mask is refused", async function () {
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

  test("renderer: setMaterial() is SYNCHRONOUS once the texture is in memory (prefetch), so a pick draws in the same frame", async function () {
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

  test("renderer: the region data carries each surface's homography, light median and exposure", async function () {
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

  test("renderer: updateLabels() replaces only the label map; a different-sized scan is refused", async function () {
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

  test("renderer: textures beyond the cache size are evicted and closed", async function () {
    const { renderer, closed } = await makeRenderer({ cacheSize: 2 });
    renderer.uploadScene(sceneFor(twoSurfaceScan()));
    renderer.prefetch(["/t/1.png", "/t/2.png", "/t/3.png"]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(renderer.cacheSize(), 2);
    assert.equal(closed.length, 1);
  });

  // ---------------------------------------------------------------- the stage's state machine
  // Stage.runFastRender() driven without a DOM: a stand-in `this` with the stage's own fields.
  const stageModule = await import("../public/js/views/stage.js");
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

  test("stage: tapping a surface and picking a finish paints exactly that surface, in the same call when the texture is cached", async function () {
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

  test("stage: surface A -> surface B directly leaves no ghost of A (finish AND alpha cleared)", async function () {
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

  test("stage: an upload (scene change) resets the bookkeeping and the finish is re-applied from cache with no blank frame", async function () {
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

  test("stage: a refined outline (same geometry, new scan) updates the labels only and re-reads the new mask", async function () {
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

  test("stage: a scene that vanishes mid-way (null) is ignored, and turning the engine off takes the preview down", async function () {
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

  test("the scene composer keeps identities stable and borrows an estimate for surfaces the real fit does not know", function () {
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

  test("a weak fit (below the threshold) gets the outline estimate instead of leaving the surface without a preview", function () {
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

  for (const entry of pending) {
    try {
      await entry.fn();
      passed += 1;
      console.log("PASS " + entry.name);
    } catch (error) {
      console.error("FAIL " + entry.name);
      console.error(error);
      process.exitCode = 1;
    }
  }
  console.log("\n" + passed + "/" + pending.length + " test case(s) passed");
})();
