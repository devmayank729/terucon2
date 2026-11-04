import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import jpeg from 'jpeg-js';
import { centeredAspectRect, HALF_HEIGHT, HALF_WIDTH, makeSeamlessTile, mirrorTile, shrink } from '../../server/lib/tileTexture.js';

// Turns a design's photograph into a texture the studio's instant preview can tile without a seam (target C1): see
// server/lib/tileTexture.js for why. mirrorTile is tested on raw pixels (an exact proof: tiling a 2x2 mirror block is
// seamless by construction); makeSeamlessTile is tested through a real JPEG round trip (jpeg-js encode -> this module ->
// jpeg-js decode), where "seamless" can only be checked within the lossy codec's own rounding.

function pixel(data, w, x, y) {
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

/** A synthetic RGBA buffer where every pixel's colour encodes its own (x, y): nothing in it is symmetric by accident. */
function gradientRGBA(w, h) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      data[i] = x % 256;
      data[i + 1] = y % 256;
      data[i + 2] = (x * 3 + y * 7) % 256;
      data[i + 3] = 255;
    }
  }
  return data;
}

describe('tileTexture: mirrorTile (exact, on raw pixels)', () => {
  const W = 6, H = 4;
  const src = gradientRGBA(W, H);
  const tile = mirrorTile(src, W, H);

  test('is twice the width and height of the crop', () => {
    assert.equal(tile.width, W * 2);
    assert.equal(tile.height, H * 2);
    assert.equal(tile.data.length, W * 2 * H * 2 * 4);
  });

  test('the top-left quadrant is the crop itself, untouched', () => {
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      assert.deepEqual(pixel(tile.data, tile.width, x, y), pixel(src, W, x, y), `(${x},${y})`);
    }
  });

  test('the horizontal fold (last column of the crop | first column of its mirror) matches exactly', () => {
    for (let y = 0; y < H; y += 1) {
      assert.deepEqual(pixel(tile.data, tile.width, W - 1, y), pixel(tile.data, tile.width, W, y), `row ${y}`);
    }
  });

  test('the horizontal wrap (the block\'s own left and right edge) matches exactly, so REPEAT tiling shows no seam', () => {
    for (let y = 0; y < H; y += 1) {
      assert.deepEqual(pixel(tile.data, tile.width, 0, y), pixel(tile.data, tile.width, tile.width - 1, y), `row ${y}`);
    }
  });

  test('the vertical fold and wrap match exactly, the same way', () => {
    for (let x = 0; x < W; x += 1) {
      assert.deepEqual(pixel(tile.data, tile.width, x, H - 1), pixel(tile.data, tile.width, x, H), `col ${x} fold`);
      assert.deepEqual(pixel(tile.data, tile.width, x, 0), pixel(tile.data, tile.width, x, tile.height - 1), `col ${x} wrap`);
    }
  });

  test('the far corners (where a horizontal and a vertical seam cross) match too', () => {
    const corners = [[0, 0], [tile.width - 1, 0], [0, tile.height - 1], [tile.width - 1, tile.height - 1]];
    const at = corners.map(([x, y]) => pixel(tile.data, tile.width, x, y));
    for (const c of at) assert.deepEqual(c, at[0]);
  });

  test('a 1x1 crop (the smallest possible) still tiles without throwing', () => {
    const one = mirrorTile(Buffer.from([10, 20, 30, 255]), 1, 1);
    assert.equal(one.width, 2);
    assert.equal(one.height, 2);
  });
});

describe('tileTexture: centeredAspectRect + shrink (keeping away from a sample\'s own edges)', () => {
  test('a square source gets a centred 10:7 rectangle, not the whole square', () => {
    const rect = centeredAspectRect(1000, 1000, 10, 7);
    assert.equal(rect.w, 1000);
    assert.equal(rect.h, 700);
    assert.equal(rect.y, 150); // (1000 - 700) / 2
    assert.equal(rect.x, 0);
  });

  test('an already-10:7 source is used in full, before shrinking', () => {
    const rect = centeredAspectRect(800, 560, 10, 7);
    assert.equal(rect.w, 800);
    assert.equal(rect.h, 560);
    assert.equal(rect.x, 0);
    assert.equal(rect.y, 0);
  });

  test('shrink moves every side inward and stays centred', () => {
    const rect = { x: 10, y: 10, w: 200, h: 100 };
    const inset = shrink(rect, 0.1);
    assert.equal(inset.w, 160); // 200 - 2*20
    assert.equal(inset.h, 80); // 100 - 2*10
    assert.equal(inset.x, 30); // 10 + 20
    assert.equal(inset.y, 20); // 10 + 10
    // still centred on the same middle point as the original rect
    assert.equal(rect.x + rect.w / 2, inset.x + inset.w / 2);
    assert.equal(rect.y + rect.h / 2, inset.y + inset.h / 2);
  });

  test('a tall, narrow source is cropped by height, not width', () => {
    const rect = centeredAspectRect(300, 2000, 10, 7);
    assert.equal(rect.w, 300);
    assert.equal(rect.h, 210);
  });
});

describe('tileTexture: makeSeamlessTile (through a real JPEG round trip)', () => {
  const CHANNEL_TOLERANCE = 18; // lossy JPEG quantization noise, not a seam: see server/lib/tileTexture.js's own doc comment

  function realJpeg(w, h) {
    return jpeg.encode({ data: gradientRGBA(w, h), width: w, height: h }, 90).data;
  }

  test('the output is a real, decodable JPEG at 2x the half-tile size', () => {
    const result = makeSeamlessTile(realJpeg(900, 700));
    assert.equal(result.width, HALF_WIDTH * 2);
    assert.equal(result.height, HALF_HEIGHT * 2);
    const decoded = jpeg.decode(result.buffer, { useTArray: true });
    assert.equal(decoded.width, result.width);
    assert.equal(decoded.height, result.height);
  });

  test('the horizontal and vertical seams are near-identical (within JPEG rounding), at every seam a REPEAT-tiled surface would show', () => {
    const result = makeSeamlessTile(realJpeg(1600, 1100));
    const decoded = jpeg.decode(result.buffer, { useTArray: true });
    const { width, height } = decoded;
    const close = (a, b, where) => {
      for (let c = 0; c < 3; c += 1) assert.ok(Math.abs(a[c] - b[c]) <= CHANNEL_TOLERANCE, `${where}: ${a} vs ${b}`);
    };
    for (let y = 0; y < height; y += 37) {
      close(pixel(decoded.data, width, 0, y), pixel(decoded.data, width, width - 1, y), `wrap row ${y}`);
      close(pixel(decoded.data, width, width / 2 - 1, y), pixel(decoded.data, width, width / 2, y), `fold row ${y}`);
    }
    for (let x = 0; x < width; x += 41) {
      close(pixel(decoded.data, width, x, 0), pixel(decoded.data, width, x, height - 1), `wrap col ${x}`);
      close(pixel(decoded.data, width, x, height / 2 - 1), pixel(decoded.data, width, x, height / 2), `fold col ${x}`);
    }
  });

  test('a photo smaller than the tile (upsized, not cropped away to nothing) still produces a full-size, decodable tile', () => {
    const result = makeSeamlessTile(realJpeg(120, 90));
    assert.equal(result.width, HALF_WIDTH * 2);
    const decoded = jpeg.decode(result.buffer, { useTArray: true });
    assert.equal(decoded.width, HALF_WIDTH * 2);
  });

  test('an extreme aspect ratio (a thin strip) still produces a correctly-sized tile, cropped to the swatch\'s own 10:7', () => {
    const result = makeSeamlessTile(realJpeg(2400, 300));
    assert.equal(result.width, HALF_WIDTH * 2);
    assert.equal(result.height, HALF_HEIGHT * 2);
  });

  test('a custom half-size and margin are honoured', () => {
    const result = makeSeamlessTile(realJpeg(800, 600), { halfWidth: 50, halfHeight: 40, margin: 0 });
    assert.equal(result.width, 100);
    assert.equal(result.height, 80);
  });
});
