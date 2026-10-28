// Tests for planeSplit.js against a synthetic box room whose walls are known exactly (moge2.castBoxRoom labels every
// pixel with the face it hit). Run with:  node server/lib/planeSplit.test.js
const assert = require("node:assert/strict");
const moge2 = require("./remoteModels/moge2");
const planeSplit = require("./planeSplit");

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

const W = 240;
const H = 160;
// surface ids from castBoxRoom: 1 floor, 2 ceiling, 3 left wall, 4 right wall, 5 back wall
const room = moge2.castBoxRoom(W, H, { roomWidth: 4, roomDepth: 5, fovDeg: 70 });

function maskOf(ids) {
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = ids.indexOf(room.surface[i]) !== -1 ? 1 : 0;
  }
  return mask;
}

function inputFor(wallIds, samIds) {
  return {
    width: W,
    height: H,
    depth: room.depth,
    intrinsics: room.intrinsics,
    regions: [{ id: "wall-1", kind: "wall", mask: maskOf(wallIds) }],
    sam: (samIds || []).map(function (ids, index) {
      return { id: "wall-" + (index + 1), kind: "wall", score: 0.9 - index * 0.01, mask: maskOf(ids) };
    }),
  };
}

// How many of the region's pixels ended up in the part the truth says they belong to (parts are numbered left->right).
function accuracy(proposal, truthIdsInOrder) {
  let right = 0;
  let total = 0;
  for (let i = 0; i < proposal.partMap.length; i += 1) {
    const part = proposal.partMap[i];
    if (!part) {
      continue;
    }
    total += 1;
    if (truthIdsInOrder[part - 1].indexOf(room.surface[i]) !== -1) {
      right += 1;
    }
  }
  return right / total;
}

test("two walls of a corner in one region, SAM sees both: split in two along the true corner", function () {
  const proposals = planeSplit.proposeWallSplits(inputFor([3, 5], [[3], [5]]));
  assert.equal(proposals.length, 1);
  const p = proposals[0];
  assert.equal(p.parts.length, 2);
  assert.equal(p.source, "sam");
  assert.ok(Math.abs(p.angleDeg - 90) < 6, "the walls are 90 degrees apart, got " + p.angleDeg);
  assert.ok(accuracy(p, [[3], [5]]) > 0.97, "left part is the left wall, right part the back wall: " + accuracy(p, [[3], [5]]));
});

test("SAM's ragged masks (one bleeds across the corner) still give the corner at the real line", function () {
  const left = maskOf([3]);
  const back = maskOf([5]);
  // the left instance wrongly claims the first 12 columns of the back wall too
  let cornerX = 0;
  for (let x = 0; x < W; x += 1) {
    if (room.surface[(H >> 1) * W + x] === 5) {
      cornerX = x;
      break;
    }
  }
  for (let y = 0; y < H; y += 1) {
    for (let x = cornerX; x < cornerX + 12; x += 1) {
      left[y * W + x] = 1;
    }
  }
  const input = inputFor([3, 5], []);
  input.sam = [
    { id: "a", kind: "wall", score: 0.95, mask: left },
    { id: "b", kind: "wall", score: 0.9, mask: back },
  ];
  const p = planeSplit.proposeWallSplits(input)[0];
  assert.ok(p, "still a split");
  assert.ok(accuracy(p, [[3], [5]]) > 0.95, "geometry decides the seam, not SAM's edge: " + accuracy(p, [[3], [5]]));
});

test("without SAM, sequential RANSAC on the depth finds the same two planes", function () {
  const p = planeSplit.proposeWallSplits(inputFor([3, 5], []))[0];
  assert.ok(p, "split found without SAM");
  assert.equal(p.source, "ransac");
  assert.ok(accuracy(p, [[3], [5]]) > 0.95, "accuracy " + accuracy(p, [[3], [5]]));
});

test("three walls in one region: three parts, numbered left to right", function () {
  const p = planeSplit.proposeWallSplits(inputFor([3, 5, 4], [[3], [5], [4]]))[0];
  assert.ok(p);
  assert.equal(p.parts.length, 3);
  assert.ok(accuracy(p, [[3], [5], [4]]) > 0.95, "accuracy " + accuracy(p, [[3], [5], [4]]));
});

test("one flat wall that SAM happens to see as two pieces is NOT split", function () {
  const back = maskOf([5]);
  const leftHalf = new Uint8Array(back);
  const rightHalf = new Uint8Array(back);
  const middle = Math.floor(W / 2);
  for (let i = 0; i < back.length; i += 1) {
    if (i % W >= middle) {
      leftHalf[i] = 0;
    } else {
      rightHalf[i] = 0;
    }
  }
  const input = inputFor([5], []);
  input.sam = [
    { id: "l", kind: "wall", score: 0.9, mask: leftHalf },
    { id: "r", kind: "wall", score: 0.9, mask: rightHalf },
  ];
  assert.equal(planeSplit.proposeWallSplits(input).length, 0, "same plane, same orientation: merged back into one");
});

test("a single flat wall with depth noise is not split", function () {
  const noisy = new Float32Array(room.depth);
  let seed = 12345;
  for (let i = 0; i < noisy.length; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    noisy[i] *= 1 + ((seed / 4294967296) - 0.5) * 0.01; // +-0.5% depth noise
  }
  const input = inputFor([5], []);
  input.depth = noisy;
  assert.equal(planeSplit.proposeWallSplits(input).length, 0);
});

test("floor and ceiling regions are never split, and tiny walls are left alone", function () {
  const input = inputFor([1], []);
  input.regions[0].kind = "floor";
  assert.equal(planeSplit.proposeWallSplits(input).length, 0);
  const small = inputFor([3], []);
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      mask[y * W + x] = 1;
    }
  }
  small.regions[0].mask = mask;
  assert.equal(planeSplit.proposeWallSplits(small).length, 0);
});

test("two walls that meet at less than minAngleDeg are not split", function () {
  const p = planeSplit.proposeWallSplits(inputFor([3, 5], [[3], [5]]), { minAngleDeg: 100 });
  assert.equal(p.length, 0);
});

runAll();
