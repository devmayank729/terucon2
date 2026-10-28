// Resizes a single-channel array from one resolution to another (Float32Array by default; pass
// Uint8Array as OutputType to resample a binary mask instead - used to put MoGe-2's depth,
// Marigold-IID's shading, and SAM 3's detection masks, each at whatever resolution that service
// actually worked at, onto exactly the photo's own scan.width x scan.height grid, so everything
// lines up pixel-for-pixel with scan.labelMap with no alignment logic needed downstream.
function resampleNearest(src, srcWidth, srcHeight, dstWidth, dstHeight, OutputType) {
  if (srcWidth === dstWidth && srcHeight === dstHeight) {
    return src;
  }
  const out = new (OutputType || Float32Array)(dstWidth * dstHeight);
  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;
  for (let y = 0; y < dstHeight; y += 1) {
    const sy = Math.min(srcHeight - 1, Math.floor((y + 0.5) * scaleY));
    const srcRow = sy * srcWidth;
    const dstRow = y * dstWidth;
    for (let x = 0; x < dstWidth; x += 1) {
      const sx = Math.min(srcWidth - 1, Math.floor((x + 0.5) * scaleX));
      out[dstRow + x] = src[srcRow + sx];
    }
  }
  return out;
}

// Depth should never be resampled by blending (averaging a near pixel and a far pixel across
// an object's silhouette produces a value that is physically nowhere) - that's what
// resampleNearest() above is for. This one is for genuinely smooth, no-discontinuity data
// (Marigold-IID's shading layer), where bilinear gives a visibly cleaner result.
function resampleBilinear(src, srcWidth, srcHeight, dstWidth, dstHeight) {
  if (srcWidth === dstWidth && srcHeight === dstHeight) {
    return src;
  }
  const out = new Float32Array(dstWidth * dstHeight);
  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;
  for (let y = 0; y < dstHeight; y += 1) {
    const sy = Math.min(srcHeight - 1.001, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcHeight - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dstWidth; x += 1) {
      const sx = Math.min(srcWidth - 1.001, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcWidth - 1, x0 + 1);
      const fx = sx - x0;
      const v00 = src[y0 * srcWidth + x0];
      const v10 = src[y0 * srcWidth + x1];
      const v01 = src[y1 * srcWidth + x0];
      const v11 = src[y1 * srcWidth + x1];
      const top = v00 + (v10 - v00) * fx;
      const bottom = v01 + (v11 - v01) * fx;
      out[y * dstWidth + x] = top + (bottom - top) * fy;
    }
  }
  return out;
}

module.exports = { resampleNearest: resampleNearest, resampleBilinear: resampleBilinear };
