import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTo, clampBox, fitView, invert, limitPan, mapRect, matrixFor, MAX_ZOOM, MIN_SIDE, moveBox, nextTurn, outputSize, PRESETS, ratioBox, reshapeBox, resizeBox, toScreen, turnedSize, zoomAbout } from '../../site/inspiration/geometry.js';

// Inspiration import (C3): the arithmetic behind the crop screen. No page involved.

const near = (a, b, eps = 1e-6, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} is not ${b}`);
const inside = (box, W, H, what = '') => {
  assert.ok(box.x >= -1e-6 && box.y >= -1e-6, `${what} starts outside: ${JSON.stringify(box)}`);
  assert.ok(box.x + box.w <= W + 1e-6 && box.y + box.h <= H + 1e-6, `${what} ends outside ${W}x${H}: ${JSON.stringify(box)}`);
};

// a repeatable random generator, so a failure can be replayed
let seed = 12345;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

test('turning and mirroring: every corner lands on a corner of the turned picture, and the turn can be undone', () => {
  const W = 400;
  const H = 300;
  for (const flip of [false, true]) {
    for (const rot of [0, 90, 180, 270]) {
      const M = matrixFor(rot, flip, W, H);
      const size = turnedSize(W, H, rot);
      for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H]]) {
        const p = applyTo(M, x, y);
        assert.ok([0, size.w].some((v) => Math.abs(p.x - v) < 1e-9) && [0, size.h].some((v) => Math.abs(p.y - v) < 1e-9), `rot ${rot} flip ${flip}: (${x},${y}) -> (${p.x},${p.y})`);
      }
      const back = applyTo(invert(M), ...Object.values(applyTo(M, 123, 77)));
      near(back.x, 123, 1e-9, `rot ${rot} flip ${flip} x`);
      near(back.y, 77, 1e-9, `rot ${rot} flip ${flip} y`);
    }
  }
  // where the top-left of the photo goes
  assert.deepEqual(applyTo(matrixFor(90, false, W, H), 0, 0), { x: H, y: 0 }, 'a quarter turn clockwise sends the top-left to the top-right');
  assert.deepEqual(applyTo(matrixFor(0, true, W, H), 0, 0), { x: W, y: 0 }, 'mirrored: the top-left goes to the top-right');
  assert.deepEqual(applyTo(matrixFor(180, false, W, H), 0, 0), { x: W, y: H });
  assert.deepEqual(applyTo(matrixFor(270, false, W, H), 0, 0), { x: 0, y: W });
  assert.throws(() => matrixFor(45, false, W, H), RangeError);
  assert.deepEqual(turnedSize(400, 300, 90), { w: 300, h: 400 });
});

test('a rectangle keeps meaning the same part of the photo through a turn and back', () => {
  const W = 400;
  const H = 300;
  const box = { x: 40, y: 30, w: 120, h: 90 };
  for (const flip of [false, true]) {
    for (const rot of [90, 180, 270]) {
      const M = matrixFor(rot, flip, W, H);
      const turned = mapRect(M, box);
      near(turned.w * turned.h, box.w * box.h, 1e-9, 'area');
      const again = mapRect(invert(M), turned);
      for (const key of ['x', 'y', 'w', 'h']) near(again[key], box[key], 1e-9, `${rot}/${flip} ${key}`);
    }
  }
});

test('a free box: edges move, stay inside the photo and never get smaller than the minimum', () => {
  const W = 1000;
  const H = 600;
  const start = { x: 200, y: 100, w: 400, h: 300 };
  const r = (handle, dx, dy) => resizeBox(start, handle, dx, dy, { W, H });
  assert.deepEqual(r('e', 100, 0), { x: 200, y: 100, w: 500, h: 300 });
  assert.deepEqual(r('w', -100, 0), { x: 100, y: 100, w: 500, h: 300 });
  assert.deepEqual(r('s', 0, 50), { x: 200, y: 100, w: 400, h: 350 });
  assert.deepEqual(r('nw', -50, -50), { x: 150, y: 50, w: 450, h: 350 });
  assert.deepEqual(r('e', 5000, 0), { x: 200, y: 100, w: 800, h: 300 }, 'stops at the photo\'s edge');
  assert.deepEqual(r('w', -5000, 0), { x: 0, y: 100, w: 600, h: 300 });
  assert.equal(r('e', -5000, 0).w, MIN_SIDE, 'cannot be squeezed away');
  assert.equal(r('n', 0, 5000).h, MIN_SIDE);
  assert.equal(r('se', -5000, -5000).w, MIN_SIDE);
});

test('a locked shape: the corners and edges keep the ratio, stay inside, and stop at the photo\'s edge', () => {
  for (const ratio of [1, 4 / 3, 3 / 2, 16 / 9, 3 / 4, 2 / 3, 9 / 16]) {
    for (let n = 0; n < 400; n += 1) {
      const W = 300 + Math.floor(rnd() * 5000);
      const H = 300 + Math.floor(rnd() * 5000);
      const start = ratioBox(W, H, ratio, { x: rnd() * W, y: rnd() * H });
      const small = { ...start, w: start.w * (0.3 + rnd() * 0.7), h: 0 };
      small.h = small.w / ratio;
      small.x = Math.min(start.x + rnd() * 50, W - small.w);
      small.y = Math.min(start.y + rnd() * 50, H - small.h);
      for (const handle of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
        const box = resizeBox(small, handle, (rnd() - 0.5) * 2 * W, (rnd() - 0.5) * 2 * H, { ratio, W, H });
        inside(box, W, H, `${handle} ratio ${ratio.toFixed(2)}`);
        near(box.w / box.h, ratio, 1e-6, `${handle} ratio`);
        assert.ok(box.w >= Math.min(MIN_SIDE, W, H) - 1e-6 || box.h >= Math.min(MIN_SIDE, W, H) - 1e-6, `${handle} too small: ${JSON.stringify(box)}`);
      }
    }
  }
});

test('a locked corner drag: the opposite corner stays where it was', () => {
  const start = { x: 100, y: 100, w: 320, h: 240 };
  const box = resizeBox(start, 'se', 80, 10, { ratio: 4 / 3, W: 2000, H: 2000 });
  near(box.x, 100, 1e-9);
  near(box.y, 100, 1e-9);
  near(box.w / box.h, 4 / 3, 1e-9);
  const nw = resizeBox(start, 'nw', -40, -40, { ratio: 4 / 3, W: 2000, H: 2000 });
  near(nw.x + nw.w, 420, 1e-9);
  near(nw.y + nw.h, 340, 1e-9);
});

test('presets: the biggest box of a shape, a box reshaped around its middle, and the clamps', () => {
  const full = ratioBox(1200, 800, 1);
  assert.deepEqual(full, { x: 200, y: 0, w: 800, h: 800 });
  assert.deepEqual(ratioBox(1200, 800, 16 / 9), { x: 0, y: (800 - 675) / 2, w: 1200, h: 675 });
  assert.deepEqual(ratioBox(1000, 1000, 9 / 16), { x: (1000 - 562.5) / 2, y: 0, w: 562.5, h: 1000 });
  for (let n = 0; n < 300; n += 1) {
    const W = 200 + rnd() * 4000;
    const H = 200 + rnd() * 4000;
    const ratio = PRESETS.filter((p) => typeof p.ratio === 'number')[Math.floor(rnd() * 7)].ratio;
    const before = clampBox({ x: rnd() * W, y: rnd() * H, w: 50 + rnd() * W, h: 50 + rnd() * H }, W, H);
    const after = reshapeBox(before, W, H, ratio);
    inside(after, W, H, 'reshaped');
    near(after.w / after.h, ratio, 1e-6, 'reshaped ratio');
    const around = ratioBox(W, H, ratio, { x: rnd() * W, y: rnd() * H });
    inside(around, W, H, 'ratioBox');
    near(around.w / around.h, ratio, 1e-6, 'ratioBox ratio');
  }
  assert.deepEqual(moveBox({ x: 10, y: 10, w: 100, h: 100 }, -50, 5000, 400, 300), { x: 0, y: 200, w: 100, h: 100 });
  assert.deepEqual(clampBox({ x: -30, y: 500, w: 5000, h: 10 }, 400, 300), { x: 0, y: 252, w: 400, h: MIN_SIDE });
});

test('the saved size: the box\'s own, shrunk to the long-side limit, never enlarged', () => {
  assert.deepEqual(outputSize({ x: 0, y: 0, w: 8000, h: 6000 }, 4096), { w: 4096, h: 3072, scale: 0.512 });
  assert.deepEqual(outputSize({ x: 0, y: 0, w: 1200, h: 800 }, 4096), { w: 1200, h: 800, scale: 1 });
  assert.deepEqual(outputSize({ x: 0, y: 0, w: 3000, h: 5000 }, 3072), { w: 1843, h: 3072, scale: 3072 / 5000 });
  assert.deepEqual(outputSize({ x: 0, y: 0, w: 0.2, h: 0.2 }, 4096), { w: 1, h: 1, scale: 1 });
});

test('the view: fitted with room round it, zoom keeps the point under the pointer, pan cannot lose the photo', () => {
  const view = fitView(4000, 3000, 900, 600, 30);
  near(view.k, Math.min(840 / 4000, 540 / 3000), 1e-12);
  near(view.ox + (4000 * view.k) / 2, 450, 1e-9, 'centred across');
  near(view.oy + (3000 * view.k) / 2, 300, 1e-9, 'centred down');

  const fit = view.k;
  const zoomed = zoomAbout(view, 2, 300, 200, fit);
  near(zoomed.k, fit * 2, 1e-12);
  // the point of the photo that was under (300, 200) still is
  const under = (v) => ({ x: (300 - v.ox) / v.k, y: (200 - v.oy) / v.k });
  near(under(zoomed).x, under(view).x, 1e-6);
  near(under(zoomed).y, under(view).y, 1e-6);
  near(zoomAbout(view, 0.01, 0, 0, fit).k, fit, 1e-12, 'cannot zoom out past the fit');
  near(zoomAbout(view, 1e6, 0, 0, fit).k, fit * MAX_ZOOM, 1e-12, 'cannot zoom in forever');

  const lost = limitPan({ ...zoomed, ox: -99999, oy: 99999 }, 4000, 3000, 900, 600);
  assert.ok(lost.ox <= 56 && lost.ox >= 900 - 4000 * zoomed.k - 56);
  assert.ok(lost.oy <= 56);
  const small = limitPan({ ...view, ox: 5, oy: 5 }, 4000, 3000, 900, 600);
  near(small.ox, view.ox, 1e-9, 'a picture smaller than the stage is centred');
  const s = toScreen(view, { x: 100, y: 200, w: 300, h: 400 });
  near(s.x, view.ox + 100 * view.k);
  near(s.h, 400 * view.k);
});

test('rotate and flip as the person sees them: a quarter turn turns the screen, a flip mirrors the screen, whatever came before', () => {
  const W = 400;
  const H = 300;
  const probes = [[0, 0], [400, 0], [123, 77], [399, 299]];
  for (const flip of [false, true]) {
    for (const rot of [0, 90, 180, 270]) {
      const before = { rot, flip };
      const M = matrixFor(rot, flip, W, H);
      const size = turnedSize(W, H, rot);
      // a quarter turn clockwise of the screen: (x, y) -> (height - y, x)
      const cw = nextTurn(before, 'cw');
      const Mcw = matrixFor(cw.rot, cw.flip, W, H);
      const ccw = nextTurn(before, 'ccw');
      const Mccw = matrixFor(ccw.rot, ccw.flip, W, H);
      const flipped = nextTurn(before, 'flip');
      const Mflip = matrixFor(flipped.rot, flipped.flip, W, H);
      for (const [x, y] of probes) {
        const p = applyTo(M, x, y);
        const a = applyTo(Mcw, x, y);
        near(a.x, size.h - p.y, 1e-9, `cw ${rot}/${flip} x`);
        near(a.y, p.x, 1e-9, `cw ${rot}/${flip} y`);
        const b = applyTo(Mccw, x, y);
        near(b.x, p.y, 1e-9, `ccw ${rot}/${flip} x`);
        near(b.y, size.w - p.x, 1e-9, `ccw ${rot}/${flip} y`);
        const c = applyTo(Mflip, x, y);
        near(c.x, size.w - p.x, 1e-9, `flip ${rot}/${flip} x`);
        near(c.y, p.y, 1e-9, `flip ${rot}/${flip} y`);
      }
    }
  }
  assert.deepEqual(nextTurn(nextTurn({ rot: 90, flip: true }, 'flip'), 'flip'), { rot: 90, flip: true }, 'flipping twice is no flip');
  assert.throws(() => nextTurn({ rot: 0, flip: false }, 'sideways'), RangeError);
});
