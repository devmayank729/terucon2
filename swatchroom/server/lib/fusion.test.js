// Unit tests for fusion.js, run with: node server/lib/fusion.test.js (plain Node, no test
// framework - consistent with this project's style; tests/ is Playwright end-to-end coverage
// of the studio itself, a different concern).
//
// The key fixture is moge2.js's castBoxRoom(): a synthetic room with exact, known geometry
// (floor/ceiling/left wall/right wall/back wall, each an exact plane with a known normal), so
// these tests check fitRegions() against ground truth, not just "it didn't throw."
const assert = require("node:assert/strict");
const fusion = require("./fusion");
const moge2 = require("./remoteModels/moge2");

let passed = 0;
const pending = [];

// Queues the test instead of running it immediately, so async tests (the worker_threads one)
// are properly awaited one at a time - a synchronous try/catch around fn() would miss a
// rejection that happens after fn()'s first `await`.
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

function angleDeg(a, b) {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return (Math.acos(dot) * 180) / Math.PI;
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function len3(a) {
  return Math.sqrt(dot3(a, a));
}

test("smallestEigenvector3x3 recovers the flat axis of a planar distribution", function () {
  // Points exactly in the Z=0 plane: zero Z-variance, so the smallest eigenvector is (0,0,±1).
  const v = fusion.smallestEigenvector3x3(1, 0.3, 0, 2, 0, 0);
  assert.ok(Math.abs(Math.abs(v[2]) - 1) < 1e-6, "expected |z|≈1, got " + v);
  assert.ok(Math.abs(v[0]) < 1e-6 && Math.abs(v[1]) < 1e-6, "expected x,y≈0, got " + v);
});

test("erodeMask(radius=1) shrinks a 5x5 square to exactly 3x3", function () {
  const mask = new Uint8Array(9 * 9);
  for (let y = 2; y < 7; y += 1) {
    for (let x = 2; x < 7; x += 1) {
      mask[y * 9 + x] = 1;
    }
  }
  const eroded = fusion.erodeMask(mask, 9, 9, 1);
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 9; x += 1) {
      const expected = y >= 3 && y <= 5 && x >= 3 && x <= 5 ? 1 : 0;
      assert.equal(eroded[y * 9 + x], expected, "mismatch at (" + x + "," + y + ")");
    }
  }
});

// ---------------------------------------------------------------- synthetic box room
const W = 480;
const H = 360;
const room = moge2.castBoxRoom(W, H, {});

function maskFor(surfaceId) {
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i += 1) {
    if (room.surface[i] === surfaceId) {
      mask[i] = 1;
    }
  }
  return mask;
}

const TRUE_NORMALS = {
  floor: [0, -1, 0],
  ceiling: [0, 1, 0],
  left: [1, 0, 0],
  right: [-1, 0, 0],
  back: [0, 0, -1],
};

const baseRegions = [
  { id: "floor", kind: "floor", score: 0.9, mask: maskFor(1) },
  { id: "ceiling", kind: "ceiling", score: 0.9, mask: maskFor(2) },
  { id: "left", kind: "wall", score: 0.9, mask: maskFor(3) },
  { id: "right", kind: "wall", score: 0.9, mask: maskFor(4) },
  { id: "back", kind: "wall", score: 0.9, mask: maskFor(5) },
];

const baseInput = {
  width: W,
  height: H,
  depth: room.depth,
  intrinsics: room.intrinsics,
  up: room.up,
  regions: baseRegions,
};

const result = fusion.fitRegions(baseInput);

Object.keys(TRUE_NORMALS).forEach(function (id) {
  test("fitRegions(" + id + "): normal, residual, confidence, tier, UV basis", function () {
    const region = result.byId[id];
    assert.ok(region, "region missing from result");
    const angle = angleDeg(region.plane.normal, TRUE_NORMALS[id]);
    assert.ok(angle < 2, "normal off by " + angle.toFixed(3) + " degrees");
    assert.ok(region.inlierRatio > 0.95, "inlierRatio too low: " + region.inlierRatio);
    assert.ok(region.rmsResidualM < 0.01, "rmsResidualM too high: " + region.rmsResidualM);
    assert.ok(region.confidence > 0.7, "confidence too low: " + region.confidence);
    assert.equal(region.tier, "fast");

    const u = region.plane.u;
    const v = region.plane.v;
    const n = region.plane.normal;
    assert.ok(Math.abs(len3(u) - 1) < 1e-6, "|u| != 1");
    assert.ok(Math.abs(len3(v) - 1) < 1e-6, "|v| != 1");
    assert.ok(Math.abs(dot3(u, n)) < 1e-6, "u not perpendicular to normal");
    assert.ok(Math.abs(dot3(v, n)) < 1e-6, "v not perpendicular to normal");
    assert.ok(Math.abs(dot3(u, v)) < 1e-6, "u not perpendicular to v");
    assert.ok([...u, ...v, ...n, ...region.plane.origin].every(Number.isFinite), "NaN in plane data");
  });
});

test("fitRegions is deterministic across repeated runs on the same input", function () {
  const again = fusion.fitRegions(baseInput);
  Object.keys(TRUE_NORMALS).forEach(function (id) {
    assert.deepEqual(result.byId[id], again.byId[id]);
  });
});

test("a genuinely non-planar region gets a real confidence penalty", function () {
  const floorMask = maskFor(1);
  const leftMask = maskFor(3);
  const badMask = new Uint8Array(W * H);
  for (let i = 0; i < badMask.length; i += 1) {
    if ((i % 2 === 0 && floorMask[i]) || (i % 2 === 1 && leftMask[i])) {
      badMask[i] = 1;
    }
  }
  const badResult = fusion.fitRegions(
    Object.assign({}, baseInput, {
      regions: baseRegions.concat([{ id: "bad", kind: "wall", score: 0.9, mask: badMask }]),
    }),
  );
  const bad = badResult.byId.bad;
  assert.ok(bad.inlierRatio < 0.9, "expected a real planarity penalty, got " + bad.inlierRatio);
  assert.notEqual(bad.tier, "fast");
});

test("a region with too few valid points is forced to gemini-only", function () {
  const floorMask = maskFor(1);
  const tinyMask = new Uint8Array(W * H);
  let set = 0;
  for (let i = 0; i < tinyMask.length && set < 50; i += 1) {
    if (floorMask[i]) {
      tinyMask[i] = 1;
      set += 1;
    }
  }
  const tinyResult = fusion.fitRegions(
    Object.assign({}, baseInput, {
      regions: [{ id: "tiny", kind: "floor", score: 0.9, mask: tinyMask }],
    }),
  );
  const tiny = tinyResult.byId.tiny;
  assert.equal(tiny.subScores.depthCoverage, 0);
  assert.equal(tiny.tier, "gemini-only");
});

test("runFitRegions (worker_threads) matches the direct call", async function () {
  const small = { width: 320, height: 240, regions: null };
  const smallRoom = moge2.castBoxRoom(small.width, small.height, {});
  function smallMask(id) {
    const mask = new Uint8Array(small.width * small.height);
    for (let i = 0; i < mask.length; i += 1) {
      if (smallRoom.surface[i] === id) {
        mask[i] = 1;
      }
    }
    return mask;
  }
  const smallInput = {
    width: small.width,
    height: small.height,
    depth: smallRoom.depth,
    intrinsics: smallRoom.intrinsics,
    up: smallRoom.up,
    regions: [
      { id: "floor", kind: "floor", score: 0.9, mask: smallMask(1) },
      { id: "back", kind: "wall", score: 0.9, mask: smallMask(5) },
    ],
  };
  const direct = fusion.fitRegions(smallInput);
  const viaWorker = await fusion.runFitRegions(smallInput);
  assert.deepEqual(direct, viaWorker);
});

runAll();
