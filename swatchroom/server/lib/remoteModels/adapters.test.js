// Unit tests for moge2.js/marigold.js/sam3.js's normalize() functions - the boundary where
// each real server's actual response shape gets converted to the canonical shape fusion.js and
// the pipeline work with (see each adapter's own module comment). Run with:
//   node server/lib/remoteModels/adapters.test.js
const assert = require("node:assert/strict");
const { zipSync } = require("fflate");
const { PNG } = require("pngjs");
const moge2 = require("./moge2");
const marigold = require("./marigold");
const sam3 = require("./sam3");
const { scoreRegionsWithSam, iou } = require("../pipelineRunner");

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

function approx(a, b, eps) {
  return Math.abs(a - b) < (eps || 1e-3);
}

// Minimal .npy (v1.0) encoder - see npy.test.js for the same helper, used there to test the
// decoder directly; here it builds a full synthetic .npz response for moge2.normalize().
function encodeNpy(data, shape, dtype) {
  const shapeStr = shape.length === 1 ? "(" + shape[0] + ",)" : "(" + shape.join(", ") + ")";
  let header = "{'descr': '" + dtype + "', 'fortran_order': False, 'shape': " + shapeStr + ", }";
  const pad = (64 - ((10 + header.length + 1) % 64)) % 64;
  header += " ".repeat(pad) + "\n";
  const headerBytes = Buffer.from(header, "ascii");
  const magic = Buffer.from([0x93, ...Buffer.from("NUMPY", "ascii"), 1, 0]);
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16LE(headerBytes.length, 0);
  return Buffer.concat([magic, lenBuf, headerBytes, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
}

test("moge2.normalize(): size_hw, intrinsics scaling, masked-pixel zeroing", function () {
  const W = 8;
  const H = 6;
  const depth = new Float32Array(W * H).fill(3);
  depth[5] = Infinity; // simulates a masked-out pixel the server already marked invalid
  const mask = new Uint8Array(W * H).fill(1);
  mask[7] = 0; // simulates a masked-out pixel via the mask array instead
  const intrinsics = new Float32Array([0.9, 0, 0.5, 0, 1.2, 0.5, 0, 0, 1]);

  const npz = zipSync({
    "depth.npy": encodeNpy(depth, [H, W], "<f4"),
    "mask.npy": encodeNpy(mask, [H, W], "|b1"),
    "intrinsics.npy": encodeNpy(intrinsics, [3, 3], "<f4"),
    "size_hw.npy": encodeNpy(new Int32Array([H, W]), [2], "<i4"),
  });

  const result = moge2.normalize(Buffer.from(npz));
  assert.equal(result.width, W);
  assert.equal(result.height, H);
  assert.equal(result.depth[0], 3);
  assert.equal(result.depth[5], 0, "an Infinity depth value must become 0, not propagate");
  assert.equal(result.depth[7], 0, "a mask=0 pixel must become 0 regardless of its depth value");
  assert.ok(approx(result.intrinsics.fx, 0.9 * W));
  assert.ok(approx(result.intrinsics.fy, 1.2 * H));
  assert.ok(approx(result.intrinsics.cx, 0.5 * W));
  assert.ok(approx(result.intrinsics.cy, 0.5 * H));
  assert.equal(result.up, null);
});

test("moge2.normalize(): missing array throws a readable error, not a crash", function () {
  const npz = zipSync({ "depth.npy": encodeNpy(new Float32Array([1]), [1], "<f4") });
  assert.throws(function () {
    moge2.normalize(Buffer.from(npz));
  }, /mask|size_hw/i);
});

function grayPng(W, H, values) {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i += 1) {
    png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = values[i];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

test("marigold.normalize(): the shading PNG is gamma-2.2 encoded, so it is linearised (not read as linear light)", function () {
  const W = 3;
  const H = 2;
  const values = [255, 0, 128, 64, 200, 10];
  const zip = zipSync({
    "meta.json": Buffer.from(JSON.stringify({ outputs: ["albedo", "shading", "residual"] })),
    "shading.png": grayPng(W, H, values),
  });
  const result = marigold.normalize(Buffer.from(zip));
  assert.equal(result.width, W);
  assert.equal(result.height, H);
  for (let i = 0; i < values.length; i += 1) {
    // diffusers writes (value / max) ** (1 / 2.2); linear light is the inverse
    assert.ok(approx(result.shading[i], Math.pow(values[i] / 255, 2.2), 1e-3), "pixel " + i);
  }
  assert.ok(approx(result.shading[0], 1, 1e-3), "the brightest pixel stays 1");
  assert.ok(result.shading[2] < 0.25, "a mid-grey byte (128) is about 0.22 in linear light, not 0.5");
  assert.equal(result.residual, undefined, "no residual.png in the zip -> no residual layer");
});

test("marigold.normalize(): keeps the residual layer (specular highlights) when the server sends it", function () {
  const W = 2;
  const H = 2;
  const zip = zipSync({
    "meta.json": Buffer.from(JSON.stringify({ outputs: ["albedo", "shading", "residual"] })),
    "shading.png": grayPng(W, H, [255, 255, 255, 255]),
    "residual.png": grayPng(W, H, [0, 100, 200, 255]),
  });
  const result = marigold.normalize(Buffer.from(zip));
  assert.ok(result.residual instanceof Float32Array && result.residual.length === 4);
  assert.ok(approx(result.residual[0], 0) && approx(result.residual[3], 1, 1e-3));
  assert.ok(result.residual[2] > result.residual[1]);
});

test("marigold: a colour shading PNG is reduced to the luminance of the linear light (Rec. 709)", function () {
  const png = new PNG({ width: 1, height: 1 });
  png.data[0] = 255;
  png.data[1] = 0;
  png.data[2] = 0;
  png.data[3] = 255;
  const layer = marigold.linearLayerFromPng(PNG.sync.write(png));
  assert.ok(approx(layer.values[0], 0.2126, 1e-4), "pure red is 21% of white's luminance, got " + layer.values[0]);
});

test("marigold.normalize(): throws clearly when no shading-like output exists", function () {
  const zip = zipSync({
    "meta.json": Buffer.from(JSON.stringify({ outputs: ["albedo", "roughness", "metallicity"] })),
  });
  assert.throws(function () {
    marigold.normalize(Buffer.from(zip));
  }, /shading/i);
});

test("sam3.normalize(): flattens results[].instances[] into one detections[] list", function () {
  const W = 4;
  const H = 4;
  const maskPng = new PNG({ width: W, height: H });
  maskPng.data.fill(255); // all-inside mask
  const maskB64 = PNG.sync.write(maskPng).toString("base64");
  const raw = {
    image: { width: W, height: H },
    results: [
      { prompt: "wall", instances: [{ score: 0.8, box_xyxy: [0, 0, 4, 4], mask: { format: "png_base64", data: maskB64 } }] },
      { prompt: "floor", instances: [] },
    ],
  };
  const result = sam3.normalize(raw);
  assert.equal(result.width, W);
  assert.equal(result.detections.length, 1);
  assert.equal(result.detections[0].kind, "wall");
  assert.equal(result.detections[0].mask.length, W * H);
  assert.equal(result.detections[0].mask[0], 1);
});

test("iou(): identical, disjoint and partial-overlap masks", function () {
  assert.equal(iou(new Uint8Array([1, 1, 0, 0]), new Uint8Array([1, 1, 0, 0])), 1);
  assert.equal(iou(new Uint8Array([1, 1, 0, 0]), new Uint8Array([0, 0, 1, 1])), 0);
  assert.ok(approx(iou(new Uint8Array([1, 1, 0, 0]), new Uint8Array([0, 1, 1, 0])), 1 / 3, 1e-9));
});

test("scoreRegionsWithSam(): replaces score on a good IoU match, keeps default otherwise", function () {
  const W = 4;
  const H = 4;
  function colsMask(cols) {
    const m = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) {
      cols.forEach(function (x) {
        m[y * W + x] = 1;
      });
    }
    return m;
  }
  const regions = [
    { id: "r1", kind: "wall", score: 0.75, mask: colsMask([2, 3]) },
    { id: "r2", kind: "floor", score: 0.75, mask: colsMask([0]) },
  ];
  const samResult = {
    width: W,
    height: H,
    detections: [
      { kind: "wall", score: 0.93, mask: colsMask([2, 3]) },
      { kind: "ceiling", score: 0.99, mask: colsMask([0, 1]) },
    ],
  };
  const scored = scoreRegionsWithSam(regions, samResult, W, H);
  assert.ok(approx(scored[0].score, 0.93));
  assert.equal(scored[1].score, 0.75, "no matching SAM detection kind -> default kept");
  assert.equal(scoreRegionsWithSam(regions, null, W, H), regions, "null samResult is a no-op");
});

runAll();
