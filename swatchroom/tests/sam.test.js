// Tests for what the browser does with SAM's masks: tap-to-calibrate (public/js/lib/samCalibrate.js), the foreground
// carve-outs (occlusion.js), morphology (morph.js), reading the stored SAM layer (samLayer.js) against the server's writer
// (server/lib/samLayer.js), and applying wall-plane splits to the scan (planeSplit.js). Run with:  node tests/sam.test.js
const assert = require("node:assert/strict");

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push({ name: name, fn: fn });
}

const W = 120;
const H = 80;

function maskOf(fn) {
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = fn(i % W, Math.floor(i / W)) ? 1 : 0;
  }
  return mask;
}
function count(mask) {
  let n = 0;
  mask.forEach((v) => (n += v ? 1 : 0));
  return n;
}
function instance(kind, score, fn) {
  const mask = maskOf(fn);
  return { id: kind + "-1", kind: kind, label: kind, score: score, area: count(mask), box: [0, 0, W, H], mask: mask };
}

(async function () {
  const regions = await import("../public/js/lib/regions.js");
  const calibrate = await import("../public/js/lib/samCalibrate.js");
  const occlusion = await import("../public/js/lib/occlusion.js");
  const morph = await import("../public/js/lib/morph.js");
  const clientLayer = await import("../public/js/lib/samLayer.js");
  const planeSplit = await import("../public/js/lib/planeSplit.js");
  const serverLayer = require("../server/lib/samLayer.js");

  // A room: ceiling on top, a left wall, a right wall, a floor, and a window in the right wall.
  function roomScan() {
    const labelMap = new Uint16Array(W * H);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        let label = 0;
        if (y < 10) label = 1; // ceiling
        else if (y >= 60) label = 4; // floor
        else if (x < 60) label = 2; // left wall
        else label = 3; // right wall
        if (x >= 80 && x < 100 && y >= 25 && y < 45) label = 5; // window in the right wall
        labelMap[y * W + x] = label;
      }
    }
    return regions.scanFromLabelMap(
      labelMap,
      [
        { index: 1, label: "Ceiling", kind: "ceiling", source: "scene" },
        { index: 2, label: "Left wall", kind: "wall", source: "scene" },
        { index: 3, label: "Right wall", kind: "wall", source: "scene" },
        { index: 4, label: "Floor", kind: "floor", source: "scene" },
        { index: 5, label: "Window", kind: "window", source: "scene" },
      ],
      W,
      H,
    );
  }
  const byLabel = (scan, label) => scan.regions.find((r) => r.label === label);

  // ---------------------------------------------------------------- morphology
  test("dilate / erode: a square grows and shrinks by the radius, in O(pixels)", function () {
    const square = maskOf((x, y) => x >= 40 && x < 60 && y >= 30 && y < 50); // 20 x 20
    assert.equal(count(morph.dilate(square, W, H, 3)), 26 * 26);
    assert.equal(count(morph.erode(square, W, H, 3)), 14 * 14);
    assert.equal(count(morph.erode(maskOf(() => true), W, H, 2)), (W - 4) * (H - 4), "the picture border erodes too");
    assert.equal(count(morph.dilate(square, W, H, 0)), 400);
  });

  test("distanceInside(): chessboard distance from the edge, and maskIou()", function () {
    const square = maskOf((x, y) => x >= 40 && x < 60 && y >= 30 && y < 50);
    const d = morph.distanceInside(square, W, H);
    assert.equal(d[30 * W + 40], 1);
    assert.equal(d[40 * W + 50], 10);
    assert.equal(d[0], 0);
    assert.equal(morph.maskIou(square, square), 1);
    assert.equal(morph.maskIou(square, maskOf(() => false)), 0);
  });

  // ---------------------------------------------------------------- fusing SAM with the scan's region
  test("confident SAM: spillover past SAM's edge is trimmed, a sliver SAM adds over unowned pixels is taken", function () {
    const scan = roomScan();
    const floor = byLabel(scan, "Floor");
    // the scan's floor runs 6 px too far up (into the wall); SAM says the floor starts at y = 60
    const sloppy = Object.assign({}, floor, { mask: maskOf((x, y) => y >= 54) });
    const candidate = { mask: maskOf((x, y) => y >= 60), score: 0.93, source: "sam3" };
    const result = calibrate.fuseRegionWithSam({ region: sloppy, candidate: candidate, layer: null, labelMap: scan.labelMap, width: W, height: H });
    assert.equal(result.changed, true);
    assert.equal(result.reason, "snapped");
    assert.equal(result.mask[56 * W + 30], 0, "the spillover onto the wall is gone");
    assert.equal(result.mask[70 * W + 30], 1, "the floor itself stays");
    assert.ok(result.stats.removed > 0 && result.stats.snapped);
  });

  test("unconfident SAM (below 0.8) does not move the edge", function () {
    const scan = roomScan();
    const floor = byLabel(scan, "Floor");
    const sloppy = Object.assign({}, floor, { mask: maskOf((x, y) => y >= 54) });
    const candidate = { mask: maskOf((x, y) => y >= 60), score: 0.6, source: "slimsam" };
    const result = calibrate.fuseRegionWithSam({ region: sloppy, candidate: candidate, layer: null, labelMap: scan.labelMap, width: W, height: H });
    assert.equal(result.changed, false);
    assert.equal(result.mask, sloppy.mask);
  });

  test("SAM that is about something else (IoU under 0.35) is ignored", function () {
    const scan = roomScan();
    const floor = byLabel(scan, "Floor");
    const candidate = { mask: maskOf((x, y) => y < 8 && x < 20), score: 0.99, source: "sam3" };
    const result = calibrate.fuseRegionWithSam({ region: floor, candidate: candidate, layer: null, labelMap: scan.labelMap, width: W, height: H });
    assert.equal(result.changed, false);
    assert.equal(result.reason, "disagree");
  });

  test("an edge fix that would change more than 35% of the region is refused", function () {
    const scan = roomScan();
    const floor = byLabel(scan, "Floor"); // y >= 60 (20 rows)
    // SAM covers the floor and 12 more rows above it: plenty of 'unowned' growth is impossible (labelMap says wall)
    const candidate = { mask: maskOf((x, y) => y >= 60 && x < 80), score: 0.95, source: "sam3" };
    const result = calibrate.fuseRegionWithSam({ region: floor, candidate: candidate, layer: null, labelMap: scan.labelMap, width: W, height: H });
    // removing the right fifth of the floor SAM did not mention is not 'spillover near SAM's edge' beyond reach, and is too much anyway
    assert.ok(count(result.mask) >= 0.65 * count(floor.mask), "most of the floor is kept: " + count(result.mask));
  });

  test("a rug on the floor and a picture on the wall become holes (carved from the region), whichever source gave the edge", function () {
    const scan = roomScan();
    const floor = byLabel(scan, "Floor");
    const layer = {
      width: W,
      height: H,
      instances: [
        instance("rug", 0.8, (x, y) => x >= 30 && x < 60 && y >= 65 && y < 75),
        instance("floor", 0.9, (x, y) => y >= 60),
      ],
    };
    const result = calibrate.fuseRegionWithSam({ region: floor, candidate: null, layer: layer, labelMap: scan.labelMap, width: W, height: H });
    assert.equal(result.changed, true);
    assert.equal(result.reason, "carved");
    assert.equal(result.mask[70 * W + 45], 0, "the rug is a hole");
    assert.equal(result.mask[70 * W + 10], 1, "the floor beside it is not");
    assert.ok(result.stats.carved >= 30 * 10);
  });

  test("occluders: a lamp far from the surface does not cut it, a weak detection does not, a 'sofa' covering the wall is refused", function () {
    const wall = maskOf((x, y) => x < 60 && y >= 10 && y < 60);
    const layer = {
      width: W,
      height: H,
      instances: [
        instance("furniture", 0.9, (x, y) => x >= 100 && x < 110 && y >= 20 && y < 30), // elsewhere
        instance("rug", 0.3, (x, y) => x >= 10 && x < 30 && y >= 20 && y < 40), // weak
      ],
    };
    assert.equal(occlusion.carveOccluders(wall, layer, W, H).removed, 0);
    const swallow = { width: W, height: H, instances: [instance("furniture", 0.9, (x, y) => x < 60 && y >= 10 && y < 60)] };
    assert.equal(occlusion.carveOccluders(wall, swallow, W, H).removed, 0, "cutting out 100% of the wall is SAM being wrong");
    const real = { width: W, height: H, instances: [instance("furniture", 0.9, (x, y) => x >= 10 && x < 30 && y >= 30 && y < 55)] };
    const carved = occlusion.carveOccluders(wall, real, W, H);
    assert.ok(carved.removed >= 20 * 25 && carved.mask[40 * W + 20] === 0);
  });

  // ---------------------------------------------------------------- choosing SAM's instance, building prompts
  test("pickSamInstance(): the instance under the tap that matches the region best; kinds must match", function () {
    const scan = roomScan();
    const left = byLabel(scan, "Left wall");
    const instances = [
      instance("wall", 0.9, (x, y) => x < 60 && y >= 10 && y < 60), // the left wall
      instance("wall", 0.95, (x, y) => x >= 60 && y >= 10 && y < 60), // the right wall
      instance("floor", 0.99, (x, y) => y >= 60),
    ];
    const hit = calibrate.pickSamInstance(left, { x: 0.2, y: 0.5 }, instances, W, H);
    assert.equal(hit.instance, instances[0]);
    assert.equal(hit.underTap, true);
    assert.equal(calibrate.pickSamInstance(left, null, [instances[2]], W, H), null, "a floor instance is not a wall");
  });

  test("buildSamPrompts(): the tap + interior peaks positive, neighbouring other-kind regions + points outside the box negative, the box", function () {
    const scan = roomScan();
    const right = byLabel(scan, "Right wall");
    const prompts = calibrate.buildSamPrompts(scan, right, { x: 0.55, y: 0.3 });
    assert.deepEqual(prompts.points[0], [66, 24], "the exact tap first");
    assert.equal(prompts.labels[0], 1);
    const positives = prompts.labels.filter((l) => l === 1).length;
    assert.ok(positives >= 3 && positives <= 4, "the tap + 2-3 peaks, got " + positives);
    const negatives = prompts.points.filter((p, i) => prompts.labels[i] === 0);
    assert.ok(negatives.length >= 2);
    negatives.forEach((p) => assert.equal(right.mask[p[1] * W + p[0]], 0, "a negative point is never inside the region: " + p));
    prompts.points.forEach((p, i) => {
      if (prompts.labels[i] === 1) {
        assert.equal(right.mask[p[1] * W + p[0]], 1, "a positive point is inside the region: " + p);
      }
    });
    assert.deepEqual(prompts.box, [right.bbox.x0, right.bbox.y0, right.bbox.x1, right.bbox.y1]);
    assert.ok(prompts.points.length <= 12);
    // a tap that is not on the region any more (on the window, say) or no tap at all: the region's deepest point stands in
    const onWindow = calibrate.buildSamPrompts(scan, right, { x: 0.7, y: 0.4 });
    assert.deepEqual(onWindow.points[0], [Math.round(right.anchor.x), Math.round(right.anchor.y)]);
    assert.deepEqual(calibrate.buildSamPrompts(scan, right, null).points[0], onWindow.points[0]);
  });

  // ---------------------------------------------------------------- the stored layer
  test("the browser reads exactly what the server wrote (bit-packed masks, header)", function () {
    const layer = serverLayer.build(
      [
        { kind: "wall", label: "wall", score: 0.9, mask: maskOf((x) => x < 50) },
        { kind: "rug", label: "rug", score: 0.7, mask: maskOf((x, y) => x > 70 && y > 50) },
      ],
      W,
      H,
      W,
      H,
    );
    const gunzipped = new Uint8Array(require("zlib").gunzipSync(serverLayer.pack(layer)));
    const parsed = clientLayer.parseSamLayer(gunzipped);
    assert.equal(parsed.instances.length, 2);
    parsed.instances.forEach((p, i) => {
      assert.equal(p.kind, layer.instances[i].kind);
      assert.deepEqual(Array.from(p.mask), Array.from(layer.instances[i].mask));
    });
    assert.equal(clientLayer.instancesOfKind(parsed, "rug").length, 1);
    assert.throws(() => clientLayer.parseSamLayer(new Uint8Array(20)), /not a SAM layer/);
  });

  // ---------------------------------------------------------------- applying plane splits
  test("applyPlaneSplits(): one wall region becomes left and right walls; the first keeps the original id", function () {
    const labelMap = new Uint16Array(W * H);
    labelMap.fill(1);
    const scan = regions.scanFromLabelMap(labelMap, [{ index: 1, label: "Walls", kind: "wall", source: "scene" }], W, H);
    const original = scan.regions[0];
    const partMap = maskOf((x) => x >= 70);
    for (let i = 0; i < partMap.length; i += 1) {
      partMap[i] = partMap[i] ? 2 : 1;
    }
    const next = planeSplit.applyPlaneSplits(scan, [{ regionId: original.id, partMap: partMap, parts: 2 }]);
    assert.equal(next.regions.length, 2);
    const first = next.regions.find((r) => r.id === original.id);
    assert.ok(first, "the first part keeps the region's id, so selection and products stay attached");
    assert.match(first.label, /left/i);
    const second = next.regions.find((r) => r.id !== original.id);
    assert.match(second.label, /right/i);
    assert.equal(second.kind, "wall");
    assert.equal(count(first.mask) + count(second.mask), W * H);
    assert.equal(first.mask[10], 1);
    assert.equal(second.mask[100], 1);
    assert.ok(next.nextIndex > scan.nextIndex);
    // splits for a region that no longer exists, or a map of the wrong size, change nothing
    assert.equal(planeSplit.applyPlaneSplits(scan, [{ regionId: "gone", partMap: partMap, parts: 2 }]), scan);
    assert.equal(planeSplit.applyPlaneSplits(scan, [{ regionId: original.id, partMap: new Uint8Array(5), parts: 2 }]), scan);
  });

  test("decodeSplits(): reads the stored gzip + base64 part maps and skips a broken one", async function () {
    const map = new Uint8Array(100).fill(1);
    map.fill(2, 50);
    const stored = require("../server/lib/pipelineRunner").storableSplits([
      { regionId: "a", partMap: map, parts: [{ index: 1 }, { index: 2 }], angleDeg: 80, source: "sam" },
    ]);
    const unpack = async (b64) => new Uint8Array(require("zlib").gunzipSync(Buffer.from(b64, "base64")));
    const decoded = await planeSplit.decodeSplits(stored.concat([{ regionId: "bad", map: "!!!", parts: [] }]), unpack);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].parts, 2);
    assert.deepEqual(Array.from(decoded[0].partMap), Array.from(map));
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
