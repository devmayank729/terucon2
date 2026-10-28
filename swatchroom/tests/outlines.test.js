// Unit tests for the vector outlines (public/js/lib/outlines.js): that a region's border comes back as
// closed, smooth, correctly oriented loops that sit on the region's real edge. Run with:
//   node tests/outlines.test.js
const assert = require("node:assert/strict");

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push({ name: name, fn: fn });
}

function makeMap(width, height, paint) {
  const map = new Uint16Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      map[y * width + x] = paint(x, y) || 0;
    }
  }
  return map;
}
function boxOf(map, width, height, index) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (map[y * width + x] === index) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  return { x0: x0, y0: y0, x1: x1 + 1, y1: y1 + 1 };
}
function area(loop) {
  let sum = 0;
  const count = loop.length / 2;
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count;
    sum += loop[i * 2] * loop[j * 2 + 1] - loop[j * 2] * loop[i * 2 + 1];
  }
  return sum / 2;
}

(async function () {
  const { traceLoops } = await import("../public/js/lib/outlines.js");

  test("a rectangle is one clockwise loop with the rectangle's area and few points", function () {
    const W = 80;
    const H = 80;
    const map = makeMap(W, H, (x, y) => (x >= 10 && x < 40 && y >= 20 && y < 50 ? 1 : 0));
    const loops = traceLoops(map, 1, W, H, boxOf(map, W, H, 1));
    assert.equal(loops.length, 1);
    // corners are cut by about a pixel (see MAX_SHIFT in outlines.js): well under 3% of a 30 x 30 square
    assert.ok(Math.abs(area(loops[0]) - 900) < 27, "area " + area(loops[0]));
    assert.ok(area(loops[0]) > 0, "outer borders run clockwise on screen");
    assert.ok(loops[0].length / 2 <= 24, "a rectangle needs few points, got " + loops[0].length / 2);
    // every point lies on or very near the rectangle's border
    for (let i = 0; i < loops[0].length; i += 2) {
      const x = loops[0][i];
      const y = loops[0][i + 1];
      assert.ok(x >= 9.2 && x <= 40.8 && y >= 19.2 && y <= 50.8, "point " + x + "," + y + " is off the rectangle");
    }
  });

  test("a hole is its own loop, running the other way, so evenodd fills a ring correctly", function () {
    const W = 100;
    const H = 100;
    const map = makeMap(W, H, (x, y) => {
      const outer = x >= 10 && x < 70 && y >= 10 && y < 70;
      const hole = x >= 30 && x < 50 && y >= 30 && y < 50;
      return outer && !hole ? 1 : 0;
    });
    const loops = traceLoops(map, 1, W, H, boxOf(map, W, H, 1));
    assert.equal(loops.length, 2);
    const areas = loops.map(area).sort((a, b) => a - b);
    assert.ok(Math.abs(areas[0] + 400) < 20, "hole area " + areas[0]);
    assert.ok(Math.abs(areas[1] - 3600) < 30, "outer area " + areas[1]);
  });

  test("a circle's loop stays within a pixel of the true circle and is smooth", function () {
    const W = 120;
    const H = 120;
    const map = makeMap(W, H, (x, y) => ((x + 0.5 - 60) ** 2 + (y + 0.5 - 60) ** 2 <= 30 * 30 ? 1 : 0));
    const loops = traceLoops(map, 1, W, H, boxOf(map, W, H, 1));
    assert.equal(loops.length, 1);
    let worst = 0;
    for (let i = 0; i < loops[0].length; i += 2) {
      worst = Math.max(worst, Math.abs(Math.hypot(loops[0][i] - 60, loops[0][i + 1] - 60) - 30));
    }
    assert.ok(worst < 0.8, "worst deviation " + worst);
    assert.ok(loops[0].length / 2 < 120, "simplified, got " + loops[0].length / 2 + " points");
    assert.ok(Math.abs(area(loops[0]) - Math.PI * 900) < 40);
  });

  test("a shallow slope has no leftover one-pixel staircase", function () {
    const W = 200;
    const H = 60;
    // a boundary rising 1 pixel every 10 pixels
    const map = makeMap(W, H, (x, y) => (y >= 40 - Math.floor(x / 10) ? 1 : 0));
    const loops = traceLoops(map, 1, W, H, boxOf(map, W, H, 1));
    const top = loops.find((loop) => area(loop) > 0);
    // Walk along every segment of the loop: wherever it runs along the slope it must stay within
    // 0.9 px of the straight line y = 40.5 - x/10 (a plain staircase is up to 0.5 px off it, and
    // the simplification leaves very few points on such a line, so test the segments, not points).
    let checked = 0;
    const count = top.length / 2;
    for (let i = 0; i < count; i += 1) {
      const j = (i + 1) % count;
      const ax = top[i * 2];
      const ay = top[i * 2 + 1];
      const bx = top[j * 2];
      const by = top[j * 2 + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      for (let s = 0; s <= steps; s += 1) {
        const x = ax + ((bx - ax) * s) / steps;
        const y = ay + ((by - ay) * s) / steps;
        if (x > 15 && x < W - 15 && y > 22 && y < 38) {
          assert.ok(Math.abs(y - (40.5 - x / 10)) < 0.9, "at " + x.toFixed(1) + "," + y.toFixed(1) + " the outline is off the slope");
          checked += 1;
        }
      }
    }
    assert.ok(checked >= 100, "only " + checked + " samples on the slope were checked");
    assert.ok(count <= 20, "the slope should collapse to a few points (a raw staircase is 40), got " + count);
  });

  test("two blocks that touch only at a corner are two loops, and tracing terminates", function () {
    const W = 40;
    const H = 40;
    const map = makeMap(W, H, (x, y) => {
      if (x >= 5 && x < 15 && y >= 5 && y < 15) return 1;
      if (x >= 15 && x < 25 && y >= 15 && y < 25) return 1;
      return 0;
    });
    const loops = traceLoops(map, 1, W, H, boxOf(map, W, H, 1));
    assert.equal(loops.length, 2);
    // a 10 x 10 block is small enough for the corner cuts to show: within 20%
    loops.forEach((loop) => assert.ok(Math.abs(area(loop) - 100) < 20, "area " + area(loop)));
  });

  test("a region on the frame's edge is closed along the edge; an empty region has no loops", function () {
    const W = 30;
    const H = 30;
    const map = makeMap(W, H, (x, y) => (y >= 10 ? 1 : 0));
    const loops = traceLoops(map, 1, W, H, { x0: 0, y0: 10, x1: W, y1: H });
    assert.equal(loops.length, 1);
    assert.ok(Math.abs(area(loops[0]) - 30 * 20) < 25);
    assert.deepEqual(traceLoops(map, 7, W, H, { x0: 0, y0: 0, x1: W, y1: H }), []);
  });

  test("specks too small to see are dropped", function () {
    const W = 30;
    const H = 30;
    const map = makeMap(W, H, (x, y) => (x === 10 && y === 10 ? 1 : 0));
    assert.deepEqual(traceLoops(map, 1, W, H, { x0: 10, y0: 10, x1: 11, y1: 11 }), []);
  });

  test("a full 1024 x 768 map of twenty regions traces in well under a quarter second", function () {
    const W = 1024;
    const H = 768;
    // twenty wobbly blobs on a grid
    const map = makeMap(W, H, (x, y) => {
      const cx = Math.floor(x / 205);
      const cy = Math.floor(y / 192);
      const centerX = cx * 205 + 102;
      const centerY = cy * 192 + 96;
      const wobble = 70 + 12 * Math.sin(Math.atan2(y - centerY, x - centerX) * 5);
      return Math.hypot(x - centerX, y - centerY) < wobble ? 1 + cy * 5 + cx : 0;
    });
    const started = process.hrtime.bigint();
    let loopCount = 0;
    for (let index = 1; index <= 20; index += 1) {
      loopCount += traceLoops(map, index, W, H, boxOf(map, W, H, index)).length;
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(loopCount, 20);
    assert.ok(ms < 250, "took " + Math.round(ms) + " ms");
    console.log("   (20 regions traced in " + Math.round(ms) + " ms)");
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
