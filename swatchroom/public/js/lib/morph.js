// Small mask morphology on Uint8Array masks (1 = inside), O(pixels) whatever the radius: a square window slid with running
// counts, one axis at a time. Used to snap, grow and carve surface masks (samCalibrate.js, occlusion.js, render.js).

function windowCount(mask, width, height, radius, horizontal) {
  const out = new Uint16Array(width * height);
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const stride = horizontal ? 1 : width;
  const lineStride = horizontal ? width : 1;
  for (let line = 0; line < lines; line += 1) {
    const base = line * lineStride;
    let count = 0;
    for (let k = 0; k <= radius && k < length; k += 1) {
      count += mask[base + k * stride] ? 1 : 0;
    }
    for (let i = 0; i < length; i += 1) {
      out[base + i * stride] = count;
      const add = i + radius + 1;
      if (add < length) {
        count += mask[base + add * stride] ? 1 : 0;
      }
      const remove = i - radius;
      if (remove >= 0) {
        count -= mask[base + remove * stride] ? 1 : 0;
      }
    }
  }
  return out;
}

// Pixels within `radius` (Chebyshev distance) of a set pixel.
export function dilate(mask, width, height, radius) {
  if (radius <= 0) {
    return mask.slice();
  }
  const horizontal = windowCount(mask, width, height, radius, true);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = horizontal[i] ? 1 : 0;
  }
  const vertical = windowCount(out, width, height, radius, false);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = vertical[i] ? 1 : 0;
  }
  return out;
}

// Pixels whose whole (2r+1)-square neighbourhood is set (pixels outside the picture count as unset).
export function erode(mask, width, height, radius) {
  if (radius <= 0) {
    return mask.slice();
  }
  const inverted = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) {
    inverted[i] = mask[i] ? 0 : 1;
  }
  // a frame of "unset" around the picture so the border erodes like any other edge
  const padded = pad(inverted, width, height, radius, 1);
  const grown = dilate(padded.data, padded.width, padded.height, radius);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      out[y * width + x] = grown[(y + radius) * padded.width + x + radius] ? 0 : 1;
    }
  }
  return out;
}

function pad(mask, width, height, margin, value) {
  const w = width + 2 * margin;
  const h = height + 2 * margin;
  const data = new Uint8Array(w * h).fill(value);
  for (let y = 0; y < height; y += 1) {
    data.set(mask.subarray(y * width, y * width + width), (y + margin) * w + margin);
  }
  return { data: data, width: w, height: h };
}

export function countSet(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) {
      count += 1;
    }
  }
  return count;
}

// |A & B| / |A | B|
export function maskIou(a, b) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] !== 0;
    const y = b[i] !== 0;
    if (x || y) {
      union += 1;
      if (x && y) {
        inter += 1;
      }
    }
  }
  return union > 0 ? inter / union : 0;
}

// Distance (in pixels, chessboard metric) from each set pixel to the nearest unset one (or the picture's edge); 0 for
// unset pixels. Two-pass chamfer, exact for the chessboard metric.
export function distanceInside(mask, width, height) {
  const INF = 1e6;
  const d = new Float32Array(width * height);
  for (let i = 0; i < d.length; i += 1) {
    d[i] = mask[i] ? INF : 0;
  }
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : d[y * width + x]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (d[i] !== 0) {
        d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1, at(x + 1, y - 1) + 1);
      }
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (d[i] !== 0) {
        d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1, at(x - 1, y + 1) + 1);
      }
    }
  }
  return d;
}
