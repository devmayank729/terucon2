// Tests for the server side of the scan and the room pipeline's new parts: OneFormer's answer turned into the scene
// schema, class-name translation, the passive "is Modal warm" clock, wake-on-intent, the combined analysis zip, the SAM
// layer that is now KEPT, and the cleaner points planes are fitted on. Nothing here calls Modal or any network.
// Run with:  node server/lib/vision.test.js
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { zipSync } = require("fflate");
const { PNG } = require("pngjs");

const coldStart = require("./coldStart");
const warmth = require("./warmth");
const wake = require("./wake");
const sceneNormalize = require("./sceneNormalize");
const { ADE20K_NAMES } = require("./ade20k");
const samLayer = require("./samLayer");
const oneformer = require("./remoteModels/oneformer");
const analyze = require("./remoteModels/analyze");
const sam3 = require("./remoteModels/sam3");
const pipelineRunner = require("./pipelineRunner");
const pack = require("./pack");

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push({ name: name, fn: fn });
}
async function runAll() {
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
}

function grayPng(width, height, valueAt) {
  const png = new PNG({ width: width, height: height });
  for (let i = 0; i < width * height; i += 1) {
    const v = valueAt(i);
    png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

// ---------------------------------------------------------------- class names
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../tests/fixtures/ade20k_names.json"), "utf8"));

test("ade20k.js is SegFormer's 150 names, in order", function () {
  assert.equal(ADE20K_NAMES.length, 150);
  ADE20K_NAMES.forEach(function (name, id) {
    assert.equal(name, String(fixture.segformer[id]).trim(), "class " + id);
  });
});

test("OneFormer and SegFormer share the 150 classes in the same order; only ten names are spelled differently", function () {
  const different = [];
  for (let id = 0; id < 150; id += 1) {
    const one = String(fixture.oneformer[id]).split(",")[0].trim();
    if (one !== ADE20K_NAMES[id]) {
      different.push(id + ":" + ADE20K_NAMES[id] + "->" + one);
    }
  }
  assert.equal(different.length, 10, different.join(", "));
  // the ones the scene worker would have misfiled: a television is furniture, a bathtub is furniture
  assert.ok(different.some((entry) => /television receiver->tv/.test(entry)));
  assert.ok(different.some((entry) => /bathtub->tub/.test(entry)));
});

test("through the translation table every class lands in the same scene-worker group as with SegFormer", function () {
  // groupForClass lives in a worker file with no exports: evaluate the part of it that defines the class tables
  const source = fs.readFileSync(path.join(__dirname, "../../public/js/workers/scene.worker.js"), "utf8");
  const head = source.slice(0, source.indexOf("// ------------------------------------------------------------------ image maths"));
  const groupForClass = new Function(head + "; return groupForClass;")();
  let misfiled = 0;
  for (let id = 0; id < 150; id += 1) {
    const viaTable = groupForClass(ADE20K_NAMES[id]);
    const segformer = groupForClass(String(fixture.segformer[id]));
    assert.equal(viaTable.key, segformer.key, "class " + id);
    // and prove the table matters: OneFormer's own short name would have been filed differently for some
    const raw = groupForClass(String(fixture.oneformer[id]).split(",")[0].trim());
    if (raw.key !== segformer.key) {
      misfiled += 1;
    }
  }
  assert.ok(misfiled >= 4, "without the table " + misfiled + " classes would be filed wrongly (tv, tub, rail, street lamp...)");
});

test("toSceneSchema(): 1-based compact class numbers and the labels that occur, like python/app.py", function () {
  const labelMap = new Uint8Array([0, 0, 3, 3, 14, 5, 150, 255]);
  const scene = sceneNormalize.toSceneSchema(labelMap);
  assert.deepEqual(scene.classIds, [0, 3, 5, 14]);
  assert.deepEqual(scene.classLabels, ["wall", "floor", "ceiling", "door"]);
  assert.deepEqual(Array.from(scene.classMap), [1, 1, 2, 2, 4, 3, 0, 0]);
});

test("thingInstanceMap(): objects keep their own id, wall / floor / sky pixels are 0", function () {
  const segmentMap = new Uint8Array([1, 1, 2, 3, 3, 0]);
  const segments = [
    { id: 1, isThing: false },
    { id: 2, isThing: true },
    { id: 3, isThing: true },
  ];
  assert.deepEqual(Array.from(sceneNormalize.thingInstanceMap(segmentMap, segments)), [0, 0, 2, 3, 3, 0]);
});

test("packBytes() round-trips through gzip + base64", function () {
  const original = new Uint8Array([1, 2, 3, 250, 0, 0, 0, 0]);
  const restored = new Uint8Array(require("zlib").gunzipSync(Buffer.from(sceneNormalize.packBytes(original), "base64")));
  assert.deepEqual(Array.from(restored), Array.from(original));
});

// ---------------------------------------------------------------- the OneFormer adapter
test("oneformer.normalize(): decodes the semantic map, the classes and the panoptic segments", function () {
  const W = 6;
  const H = 4;
  const semantic = grayPng(W, H, (i) => (i < 12 ? 0 : 3));
  const panoptic = grayPng(W, H, (i) => (i < 12 ? 1 : 2));
  const result = oneformer.normalize({
    image: { width: W, height: H },
    results: {
      semantic: {
        label_map: { format: "png_base64", data: semantic.toString("base64") },
        classes: [{ id: 0, label: "wall", pixels: 12, fraction: 0.5 }],
      },
      panoptic: {
        segment_map: { format: "png_base64", data: panoptic.toString("base64") },
        segments: [
          { id: 1, label_id: 0, label: "wall", isthing: false, score: 0.9, area: 12, box_xyxy: [0, 0, 6, 2] },
          { id: 2, label_id: 14, label: "door", isthing: true, score: 0.8, area: 12, box_xyxy: [0, 2, 6, 4] },
        ],
      },
    },
  });
  assert.equal(result.width, W);
  assert.equal(result.labelMap[0], 0);
  assert.equal(result.labelMap[23], 3);
  assert.equal(result.segmentMap[23], 2);
  assert.equal(result.segments[1].isThing, true);
  assert.equal(result.segments[1].labelId, 14);
});

test("oneformer.normalize(): a map of the wrong size or a missing map is a clear 502, not garbage", function () {
  const bad = grayPng(3, 3, () => 0);
  assert.throws(
    () =>
      oneformer.normalize({
        image: { width: 6, height: 4 },
        results: { semantic: { label_map: { format: "png_base64", data: bad.toString("base64") }, classes: [] } },
      }),
    /3x3 for a 6x4/,
  );
  assert.throws(() => oneformer.normalize({ image: { width: 6, height: 4 }, results: {} }), /semantic map/);
});

test("oneformer.mock(): same shape, a ceiling, a wall, a door and a floor", function () {
  const mock = oneformer.mock(40, 30);
  const scene = sceneNormalize.toSceneSchema(mock.labelMap);
  ["wall", "floor", "ceiling", "door"].forEach((label) => assert.ok(scene.classLabels.indexOf(label) !== -1, label));
});

// ---------------------------------------------------------------- the passive warm clock
function registryAt(time) {
  return coldStart.createRegistry({ now: () => time.now });
}
function okCall(registry, model, time, workMs) {
  const handle = registry.begin(model, "segment", null);
  time.now += workMs;
  handle.finish({ headers: new Headers({}) });
}
const SETTINGS = { scaledownS: 300, warmMarginS: 20 };
const CONFIGS = {
  oneformer: { url: "https://x--vision-all.modal.run/v1/oneformer" },
  analyze: { url: "https://x--vision-all.modal.run/v1/analyze" },
  sam3: { url: "" },
  moge2: { url: "" },
  marigold: { url: "" },
};

test("warmth: never called since the server started -> unknown (treated as cold), never 'warm'", function () {
  const time = { now: 1000000 };
  const status = warmth.status({ registry: registryAt(time), configs: CONFIGS, settings: SETTINGS });
  assert.equal(status.state, "unknown");
  assert.equal(status.warm, false);
  assert.equal(status.configured, true);
  assert.equal(status.mode, "passive");
});

test("warmth: warm for scaledown minus the margin after the last successful call, then cold", function () {
  const time = { now: 1000000 };
  const registry = registryAt(time);
  okCall(registry, "oneformer", time, 900);
  time.now += 100 * 1000;
  assert.equal(warmth.status({ registry, configs: CONFIGS, settings: SETTINGS }).warm, true);
  time.now += 179 * 1000; // 279 s since: inside 300 - 20
  assert.equal(warmth.status({ registry, configs: CONFIGS, settings: SETTINGS }).warm, true);
  time.now += 2 * 1000; // 281 s: the pool is about to be stopped, do not plan on it
  const status = warmth.status({ registry, configs: CONFIGS, settings: SETTINGS });
  assert.equal(status.warm, false);
  assert.equal(status.state, "cold");
});

test("warmth: a failed call does not make a pool look warm; a call in flight counts as waking", function () {
  const time = { now: 1000000 };
  const registry = registryAt(time);
  registry.begin("oneformer", "segment", null).fail(new Error("503"));
  assert.equal(warmth.status({ registry, configs: CONFIGS, settings: SETTINGS }).state, "unknown");
  registry.begin("oneformer", "segment", null);
  assert.equal(warmth.status({ registry, configs: CONFIGS, settings: SETTINGS }).state, "waking");
});

test("warmth: no ONEFORMER_URL -> unconfigured, which the start-up gate turns into 'local only'", function () {
  const time = { now: 0 };
  const configs = Object.assign({}, CONFIGS, { oneformer: { url: "" } });
  const status = warmth.status({ registry: registryAt(time), configs: configs, settings: SETTINGS });
  assert.equal(status.configured, false);
  assert.equal(status.state, "unconfigured");
});

test("asking for the status never calls Modal (the registry is read, nothing is fetched)", function () {
  let fetched = 0;
  const original = global.fetch;
  global.fetch = function () {
    fetched += 1;
    return Promise.reject(new Error("must not be called"));
  };
  try {
    warmth.status({ registry: registryAt({ now: 0 }), configs: CONFIGS, settings: SETTINGS });
  } finally {
    global.fetch = original;
  }
  assert.equal(fetched, 0);
});

test("warmth.probe(): only an explicit probe sends /healthz, and a success is recorded so the clock stays true", async function () {
  const time = { now: 5000 };
  const registry = registryAt(time);
  const calls = [];
  const result = await warmth.probe({
    registry: registry,
    modelConfig: { url: "https://x--vision-all.modal.run/v1/oneformer", key: "k", authHeader: "bearer" },
    fetch: async function (url, init) {
      calls.push([url, init.headers.Authorization]);
      return { ok: true, headers: new Headers({}), arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });
  assert.deepEqual(calls, [["https://x--vision-all.modal.run/healthz", "Bearer k"]]);
  assert.equal(result.warm, true);
  assert.equal(registry.warmth("oneformer").lastOkAt !== null, true);
});

// ---------------------------------------------------------------- wake on intent
test("wake.targets(): the combined pool is covered by the scan's own OneFormer call - nothing else to wake", function () {
  const time = { now: 0 };
  const list = wake.targets({
    registry: registryAt(time),
    settings: SETTINGS,
    scanUsesOneFormer: true,
    oneformer: CONFIGS.oneformer,
    pools: [["analyze", CONFIGS.analyze]],
  });
  assert.deepEqual(list, []);
});

test("wake.targets(): separate pools are woken together, once each, and warm or starting ones are skipped", function () {
  const time = { now: 1000000 };
  const registry = registryAt(time);
  const pools = [
    ["sam3", { url: "https://x--vision-sam3.modal.run/v1/segment" }],
    ["moge2", { url: "https://x--vision-moge2.modal.run/v1/geometry" }],
    ["marigold", { url: "https://x--vision-marigold.modal.run/v1/decompose" }],
  ];
  const oneformerConfig = { url: "https://x--vision-oneformer.modal.run/v1/oneformer" };
  let names = wake.targets({ registry, settings: SETTINGS, scanUsesOneFormer: true, oneformer: oneformerConfig, pools }).map((t) => t.name);
  assert.deepEqual(names, ["sam3", "moge2", "marigold"], "three cold pools, woken in one wave");
  okCall(registry, "moge2", time, 500); // moge2 just answered: warm
  registry.begin("marigold", "warmup", null); // marigold is booting right now
  names = wake.targets({ registry, settings: SETTINGS, scanUsesOneFormer: true, oneformer: oneformerConfig, pools }).map((t) => t.name);
  assert.deepEqual(names, ["sam3"]);
});

test("wake.wake(): sends one /healthz per cold pool and nothing else", function () {
  const time = { now: 0 };
  const urls = [];
  const names = wake.wake({
    registry: registryAt(time),
    settings: SETTINGS,
    scanUsesOneFormer: false,
    pools: [["analyze", { url: "https://x--vision-all.modal.run/v1/analyze", key: "", authHeader: "bearer" }]],
    fetch: async function (url) {
      urls.push(url);
      return { ok: true, headers: new Headers({}), arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });
  assert.deepEqual(names, ["analyze"]);
  assert.deepEqual(urls, ["https://x--vision-all.modal.run/healthz"]);
});

// ---------------------------------------------------------------- the combined analysis zip
function npy(data, shape, dtype) {
  const shapeStr = shape.length === 1 ? "(" + shape[0] + ",)" : "(" + shape.join(", ") + ")";
  let header = "{'descr': '" + dtype + "', 'fortran_order': False, 'shape': " + shapeStr + ", }";
  const pad = (64 - ((10 + header.length + 1) % 64)) % 64;
  header += " ".repeat(pad) + "\n";
  const headerBytes = Buffer.from(header, "ascii");
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16LE(headerBytes.length, 0);
  return Buffer.concat([
    Buffer.from([0x93, ...Buffer.from("NUMPY", "ascii"), 1, 0]),
    lenBuf,
    headerBytes,
    Buffer.from(data.buffer, data.byteOffset, data.byteLength),
  ]);
}

function analysisZip(W, H, extra) {
  const maskPng = grayPng(W, H, (i) => (i % W < W / 2 ? 255 : 0)).toString("base64");
  const entries = {
    "meta.json": Buffer.from(JSON.stringify({ image: { width: W, height: H }, services: ["moge2", "marigold", "sam3"] })),
    "geometry.npz": Buffer.from(
      zipSync({
        "depth.npy": npy(new Float32Array(W * H).fill(2.5), [H, W], "<f4"),
        "mask.npy": npy(new Uint8Array(W * H).fill(1), [H, W], "|b1"),
        "intrinsics.npy": npy(new Float32Array([0.9, 0, 0.5, 0, 1.2, 0.5, 0, 0, 1]), [3, 3], "<f4"),
        "size_hw.npy": npy(new Int32Array([H, W]), [2], "<i4"),
      }),
    ),
    "shading.png": grayPng(W, H, () => 200),
    "residual.png": grayPng(W, H, (i) => (i === 0 ? 255 : 0)),
    "sam3.json": Buffer.from(
      JSON.stringify({
        image: { width: W, height: H },
        results: [
          { prompt: "wall", instances: [{ score: 0.9, box_xyxy: [0, 0, W / 2, H], mask: { format: "png_base64", data: maskPng } }] },
          { prompt: "rug", instances: [] },
        ],
      }),
    ),
  };
  return Buffer.from(zipSync(Object.assign(entries, extra || {})));
}

test("analyze.normalize(): geometry, linear shading + residual and SAM masks from ONE zip", function () {
  const result = analyze.normalize(analysisZip(8, 6));
  assert.equal(result.geometry.width, 8);
  assert.equal(result.geometry.depth[0], 2.5);
  assert.ok(Math.abs(result.geometry.intrinsics.fx - 0.9 * 8) < 1e-3);
  assert.ok(Math.abs(result.lighting.shading[0] - Math.pow(200 / 255, 2.2)) < 1e-3, "shading is linearised");
  assert.ok(Math.abs(result.lighting.residual[0] - 1) < 1e-3 && result.lighting.residual[1] === 0);
  assert.equal(result.sam.detections.length, 1);
  assert.equal(result.sam.detections[0].kind, "wall");
  assert.equal(result.sam.detections[0].mask[0], 1);
  assert.equal(result.sam.detections[0].mask[7], 0);
});

test("analyze.normalize(): a zip missing a part, or not a zip, is a clear 502", function () {
  assert.throws(() => analyze.normalize(Buffer.from("nope")), /readable \.zip/);
  const partial = Buffer.from(zipSync({ "meta.json": Buffer.from("{}") }));
  assert.throws(() => analyze.normalize(partial), /missing geometry\.npz/);
});

// ---------------------------------------------------------------- the SAM layer (kept, not thrown away)
function detection(kind, score, W, H, fn) {
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = fn(i % W, Math.floor(i / W)) ? 1 : 0;
  }
  return { kind: kind, label: kind, score: score, mask: mask };
}

test("samLayer: build() resamples to the scan grid, drops dust and weak masks, caps instances per kind", function () {
  const detections = [
    detection("wall", 0.9, 200, 100, (x) => x < 100),
    detection("wall", 0.3, 200, 100, (x) => x >= 100), // below the score floor
    detection("rug", 0.8, 200, 100, (x, y) => x === 3 && y === 3), // one pixel: dust
    detection("sofa", 0.9, 200, 100, () => true), // not a kind the pipeline keeps
  ];
  const layer = samLayer.build(detections, 200, 100, 400, 200);
  assert.equal(layer.width, 400);
  assert.equal(layer.instances.length, 1);
  assert.equal(layer.instances[0].kind, "wall");
  assert.equal(layer.instances[0].mask.length, 400 * 200);
  assert.equal(layer.instances[0].area, 200 * 200);
  assert.deepEqual(layer.instances[0].box, [0, 0, 200, 200]);
});

test("samLayer: pack() / unpack() keep every mask bit exactly, in a small gzip file", function () {
  const W = 37;
  const H = 23; // not a multiple of 8 on purpose
  const layer = samLayer.build(
    [detection("wall", 0.9, W, H, (x, y) => (x * 7 + y * 3) % 5 < 3), detection("floor", 0.7, W, H, (x, y) => y > 12)],
    W,
    H,
    W,
    H,
  );
  const packed = samLayer.pack(layer);
  const restored = samLayer.unpack(packed);
  assert.equal(restored.instances.length, 2);
  restored.instances.forEach(function (instance, index) {
    assert.equal(instance.kind, layer.instances[index].kind);
    assert.equal(instance.score, Math.round(layer.instances[index].score * 1000) / 1000);
    assert.deepEqual(Array.from(instance.mask), Array.from(layer.instances[index].mask));
  });
  assert.ok(packed.length < W * H, "gzip'd masks are small: " + packed.length + " bytes");
  assert.throws(() => samLayer.unpack(require("zlib").gzipSync(Buffer.from("not a layer"))), /not a SAM layer/);
});

// ---------------------------------------------------------------- cleaner points to fit planes on
function regionFrom(W, H, id, kind, fn) {
  const mask = new Uint8Array(W * H);
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (fn(i % W, Math.floor(i / W))) {
      mask[i] = 1;
      count += 1;
    }
  }
  return { id: id, kind: kind, mask: mask, count: count };
}
function layerFrom(W, H, specs) {
  return {
    width: W,
    height: H,
    instances: specs.map(function (spec, index) {
      const d = detection(spec.kind, spec.score, W, H, spec.fn);
      let area = 0;
      d.mask.forEach((v) => (area += v));
      return { id: spec.kind + "-" + index, kind: spec.kind, label: spec.kind, score: spec.score, area: area, box: [0, 0, W, H], mask: d.mask };
    }),
  };
}

test("cleanFitMask(): keeps the part of the region SAM agrees with and drops a rug lying on the floor", function () {
  const W = 100;
  const H = 80;
  // the scan's floor region bleeds 10 columns past where SAM says the floor ends
  const floor = regionFrom(W, H, "floor", "floor", (x, y) => y >= 40 && x < 100);
  const layer = layerFrom(W, H, [
    { kind: "floor", score: 0.9, fn: (x, y) => y >= 40 && x < 90 },
    { kind: "rug", score: 0.8, fn: (x, y) => x >= 30 && x < 60 && y >= 50 && y < 70 },
  ]);
  const fit = pipelineRunner.cleanFitMask(floor, layer, W, H);
  assert.equal(fit[45 * W + 95], 0, "the ragged edge SAM does not call floor is out");
  assert.equal(fit[60 * W + 45], 0, "the rug is out");
  assert.equal(fit[45 * W + 10], 1, "plain floor stays");
  assert.equal(fit[75 * W + 80], 1, "plain floor stays");
});

test("cleanFitMask(): never starves the fit - a SAM miss or an over-eager mask falls back to the region", function () {
  const W = 100;
  const H = 80;
  const wall = regionFrom(W, H, "wall", "wall", (x) => x < 100);
  assert.equal(pipelineRunner.cleanFitMask(wall, null, W, H), wall.mask, "no SAM layer: untouched");
  const tiny = layerFrom(W, H, [{ kind: "wall", score: 0.9, fn: (x, y) => x < 5 && y < 5 }]);
  assert.equal(pipelineRunner.cleanFitMask(wall, tiny, W, H), wall.mask, "SAM found only a corner: region kept whole");
  const huge = layerFrom(W, H, [{ kind: "furniture", score: 0.9, fn: () => true }]);
  assert.equal(pipelineRunner.cleanFitMask(wall, huge, W, H), wall.mask, "an obstruction covering everything is ignored");
});

test("scoreRegionsWithSamLayer(): a region SAM sees well gets SAM's score, others keep the default", function () {
  const W = 20;
  const H = 10;
  const wall = regionFrom(W, H, "w", "wall", (x) => x < 10);
  const floor = regionFrom(W, H, "f", "floor", (x) => x >= 10);
  wall.score = floor.score = 0.75;
  const layer = layerFrom(W, H, [{ kind: "wall", score: 0.93, fn: (x) => x < 10 }]);
  const scored = pipelineRunner.scoreRegionsWithSamLayer([wall, floor], layer);
  assert.ok(Math.abs(scored[0].score - 0.93) < 1e-9);
  assert.equal(scored[1].score, 0.75);
});

test("storableSplits(): the part map is gzip + base64 so it fits in the room document", function () {
  const map = new Uint8Array(1000).fill(1);
  map.fill(2, 500);
  const stored = pipelineRunner.storableSplits([
    { regionId: "r1", partMap: map, parts: [{ index: 1, area: 500, normal: [0, 0, -1], inlierRatio: 0.9, origin: [0, 0, 1] }], angleDeg: 88, source: "sam" },
  ]);
  assert.equal(stored[0].regionId, "r1");
  assert.deepEqual(Array.from(pack.unpackUint8(Buffer.from(stored[0].map, "base64"))), Array.from(map));
  assert.equal(stored[0].parts[0].origin, undefined, "only the facts the browser needs are stored");
  assert.deepEqual(pipelineRunner.storableSplits(undefined), []);
});

test("16-bit layers (shading, residual) round-trip within 1/65535", function () {
  const values = new Float32Array([0, 0.001, 0.25, 0.5, 0.9999, 1, 1.4, -0.2]);
  const back = pack.unpackUnit16(pack.packUnit16(values));
  [0, 0.001, 0.25, 0.5, 0.9999, 1, 1, 0].forEach(function (expected, i) {
    assert.ok(Math.abs(back[i] - expected) < 2e-5, i + ": " + back[i]);
  });
});

test("sam3 adapter: ten scene prompts for the combined call, the first eight for the dedicated endpoint's cap", function () {
  assert.equal(sam3.SCENE_PROMPTS.length, 10);
  assert.deepEqual(sam3.SCENE_PROMPTS.slice(0, 7), ["wall", "floor", "ceiling", "rug", "window", "door", "furniture"]);
  assert.equal(sam3.SEGMENT_ENDPOINT_PROMPTS.length, 8);
  assert.ok(sam3.SCENE_PROMPTS.indexOf("picture frame") !== -1 && sam3.SCENE_PROMPTS.indexOf("plant") !== -1);
});

runAll();
