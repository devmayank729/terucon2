/**
 * Turns a photograph of a material sample into a texture the Design Studio's instant (browser-side, WebGPU/WebGL2)
 * preview can tile without a seam (target C1; used by server/catalogue/studioFinishes.js and server/routes/catalogueMedia.js
 * for the Terucon catalogue's 63 designs in the studio, added 2026-11-04).
 *
 * Why this exists: the studio only draws an instant preview for a catalog item that has `item.texture.url`
 * (swatchroom/public/js/lib/fastrender/tiers.js, canFastRenderItem) pointing at a texture that repeats cleanly
 * (swatchroom/public/js/data/catalog.js: "a photo of a sheet is not" tileable, so catalogue designs were given none
 * and always rendered with the AI only). A design's photograph is one sheet, photographed once: its left edge does not
 * match its right edge, so repeating it as-is would show a hard seam.
 *
 * The fix is a standard "mirror tile": crop a centred region (away from the photo's own edges, where a sample sheet is
 * most likely to show its border, a shadow or the background behind it), then lay the crop and three flips of it into a
 * 2x2 block (crop | flipped-left-right ; flipped-top-bottom | flipped-both). Repeating THAT block edge to edge is always
 * seamless, by construction: at the fold between two quadrants, both sides are a mirror of the same pixels (identical
 * colour, not just a close match); at the outer edge, the block's first column/row is the crop's own first column/row on
 * both sides of the join (the same proof, one flip further out). No photo content is invented: every pixel the result
 * shows came from the crop.
 *
 * Decode and encode are jpeg-js (pure JavaScript, no native build step, the same reasoning the studio's own package.json
 * chose pngjs for); cropping, flipping and resizing are plain pixel-array loops below. Never run against a real design
 * photograph here (no Cloud Storage credentials in this environment): verified against synthetic JPEGs only
 * (tests/js/tile-texture.test.js), which prove the seam equality above pixel for pixel, not whether a real marble or
 * wood-grain sample ends up LOOKING good tiled - that needs eyes on a real render (docs/CATALOGUE_STUDIO.md).
 */
import jpeg from 'jpeg-js';

export const HALF_WIDTH = 320;
export const HALF_HEIGHT = 224; // 320:224 = 10:7, the same aspect ratio the studio's own built-in textures use
const CROP_MARGIN = 0.12; // shrink the crop inward by this fraction on each side, away from a sample's own border/shadow
const JPEG_QUALITY = 86;

/** The largest centred rectangle of the given aspect ratio that fits inside width x height. */
export function centeredAspectRect(width, height, aspectW, aspectH) {
  const byWidth = { w: width, h: Math.round((width * aspectH) / aspectW) };
  const byHeight = { w: Math.round((height * aspectW) / aspectH), h: height };
  const rect = byWidth.h <= height ? byWidth : byHeight;
  return { x: Math.floor((width - rect.w) / 2), y: Math.floor((height - rect.h) / 2), w: rect.w, h: rect.h };
}

/** Shrinks a rectangle toward its own centre by `margin` on each side (0.12 keeps the middle 76%). */
export function shrink(rect, margin) {
  const dw = Math.round(rect.w * margin);
  const dh = Math.round(rect.h * margin);
  return { x: rect.x + dw, y: rect.y + dh, w: Math.max(1, rect.w - 2 * dw), h: Math.max(1, rect.h - 2 * dh) };
}

/** Copies an RGBA rectangle out of `src` (width `sw`) into a new, tightly-packed RGBA buffer. */
function cropRGBA(src, sw, rect) {
  const out = Buffer.alloc(rect.w * rect.h * 4);
  for (let row = 0; row < rect.h; row += 1) {
    const srcStart = ((rect.y + row) * sw + rect.x) * 4;
    src.copy(out, row * rect.w * 4, srcStart, srcStart + rect.w * 4);
  }
  return out;
}

/** Nearest-neighbour resize of an RGBA buffer. Simple and deterministic: this is a small swatch crop, not a photograph to admire at full size. */
function resizeNearestRGBA(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const from = (sy * sw + sx) * 4;
      const to = (y * dw + x) * 4;
      out[to] = src[from];
      out[to + 1] = src[from + 1];
      out[to + 2] = src[from + 2];
      out[to + 3] = src[from + 3];
    }
  }
  return out;
}

/** A new RGBA buffer with every row reversed left to right. */
function flipHorizontal(src, w, h) {
  const out = Buffer.alloc(src.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const from = (y * w + x) * 4;
      const to = (y * w + (w - 1 - x)) * 4;
      out[to] = src[from];
      out[to + 1] = src[from + 1];
      out[to + 2] = src[from + 2];
      out[to + 3] = src[from + 3];
    }
  }
  return out;
}

/** A new RGBA buffer with every column reversed top to bottom. */
function flipVertical(src, w, h) {
  const out = Buffer.alloc(src.length);
  const rowBytes = w * 4;
  for (let y = 0; y < h; y += 1) {
    src.copy(out, (h - 1 - y) * rowBytes, y * rowBytes, (y + 1) * rowBytes);
  }
  return out;
}

/** Pastes a `w`x`h` RGBA block into `dest` (stride `dw`) with its top-left corner at (x, y). */
function paste(dest, dw, block, w, h, x, y) {
  for (let row = 0; row < h; row += 1) {
    const from = row * w * 4;
    const to = ((y + row) * dw + x) * 4;
    block.copy(dest, to, from, from + w * 4);
  }
}

/**
 * Builds the seamless 2x2 mirror block from one crop. Exported mainly for the test: it is the geometric core of
 * makeSeamlessTile, kept pixel-pure (no JPEG) so the seam proof does not depend on decode/encode fidelity.
 * @returns {{data: Buffer, width: number, height: number}} an RGBA buffer, width/height = 2x the crop's.
 */
export function mirrorTile(cropData, cropW, cropH) {
  const width = cropW * 2;
  const height = cropH * 2;
  const out = Buffer.alloc(width * height * 4);
  const right = flipHorizontal(cropData, cropW, cropH);
  const bottom = flipVertical(cropData, cropW, cropH);
  const both = flipVertical(right, cropW, cropH);
  paste(out, width, cropData, cropW, cropH, 0, 0);
  paste(out, width, right, cropW, cropH, cropW, 0);
  paste(out, width, bottom, cropW, cropH, 0, cropH);
  paste(out, width, both, cropW, cropH, cropW, cropH);
  return { data: out, width, height };
}

/**
 * The full pipeline: a JPEG photograph in, a seamlessly-tileable JPEG out.
 * @param {Buffer} jpegBuffer the design's own photograph (any size)
 * @param {{halfWidth?: number, halfHeight?: number, margin?: number, quality?: number}} [opts]
 * @returns {{buffer: Buffer, width: number, height: number}}
 */
export function makeSeamlessTile(jpegBuffer, opts) {
  const o = opts || {};
  const halfWidth = o.halfWidth || HALF_WIDTH;
  const halfHeight = o.halfHeight || HALF_HEIGHT;
  const margin = typeof o.margin === 'number' ? o.margin : CROP_MARGIN;
  const quality = o.quality || JPEG_QUALITY;

  const decoded = jpeg.decode(jpegBuffer, { useTArray: true, maxMemoryUsageInMB: 512 });
  const full = { x: 0, y: 0, w: decoded.width, h: decoded.height };
  const rect = shrink(centeredAspectRect(decoded.width, decoded.height, halfWidth, halfHeight), margin);
  const cropped = cropRGBA(Buffer.from(decoded.data), decoded.width, rect.w && rect.h ? rect : full);
  const resized = resizeNearestRGBA(cropped, rect.w, rect.h, halfWidth, halfHeight);
  const tile = mirrorTile(resized, halfWidth, halfHeight);
  const encoded = jpeg.encode({ data: tile.data, width: tile.width, height: tile.height }, quality);
  return { buffer: encoded.data, width: tile.width, height: tile.height };
}
