// The instant preview BEFORE the room has been understood in 3D.
//
// MoGe-2 + Marigold take a while on a cold GPU, and the designer should not stare at a blank photo when they tap a
// surface and pick a finish right after the scan. So until the pipeline's result is in (or if it fails), the preview runs
// on an ESTIMATE made from the scan alone:
//   - each wall / floor / ceiling gets the four corners of its outline (the convex hull's extreme points)
//   - the corners are a perspective view of a rectangle, and with a typical phone camera's field of view the rectangle's
//     proportions follow from them (Zhang & He, "Whiteboard scanning and image enhancement", 2007)
//   - a standard size is assumed for the real rectangle (a wall is 2.6 m high, a floor or ceiling 4 m across), which fixes
//     the scale of the tiles: right in proportion and perspective, roughly right in size
//   - the light comes from the photo itself, blurred so that only the lighting is left and not the old material's pattern
// The result has the same shape as the real thing (public/js/lib/fastrender/renderer.js's scene), with a homography per
// region instead of a fitted plane, so the same shaders draw both. When the pipeline finishes, the studio swaps the real
// scene in and the preview sharpens in place. It is marked "flagged" (confidence 0.6) so the studio keeps nudging toward
// the AI render for the final image, and its sizes are guesses, which is why it is called provisional.
import { applyHomography } from "./geometry.js";

export const ASSUMED_FOV_DEG = 62; // horizontal field of view of a phone's main camera across the photo's long side
export const WALL_HEIGHT_M = 2.6;
export const FLOOR_WIDTH_M = 4;
export const PROVISIONAL_CONFIDENCE = 0.6;
const MIN_QUAD_AREA_SHARE = 0.25; // of the bounding box, below this the outline is not a four-cornered shape

export function assumedIntrinsics(width, height) {
  const longest = Math.max(width, height);
  const f = longest / (2 * Math.tan((ASSUMED_FOV_DEG * Math.PI) / 360));
  return { fx: f, fy: f, cx: width / 2, cy: height / 2 };
}

// ---------------------------------------------------------------- outline -> four corners
// Andrew's monotone chain; points: [[x, y], ...] -> hull vertices, counter-clockwise on screen (y down) or clockwise,
// whichever; only the set matters here.
export function convexHull(points) {
  const sorted = points
    .slice()
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]))
    .filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
  if (sorted.length < 3) {
    return sorted;
  }
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  sorted.forEach(function (p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  });
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// The extreme points of a mask: for every row its leftmost and rightmost pixel, for every column its top and bottom one.
export function extremePoints(mask, width, height, bbox) {
  const points = [];
  const x0 = bbox ? bbox.x0 : 0;
  const x1 = bbox ? bbox.x1 : width;
  const y0 = bbox ? bbox.y0 : 0;
  const y1 = bbox ? bbox.y1 : height;
  for (let y = y0; y < y1; y += 1) {
    let left = -1;
    let right = -1;
    for (let x = x0; x < x1; x += 1) {
      if (mask[y * width + x]) {
        if (left < 0) {
          left = x;
        }
        right = x;
      }
    }
    if (left >= 0) {
      points.push([left, y + 0.5], [right + 1, y + 0.5]);
    }
  }
  for (let x = x0; x < x1; x += 1) {
    let top = -1;
    let bottom = -1;
    for (let y = y0; y < y1; y += 1) {
      if (mask[y * width + x]) {
        if (top < 0) {
          top = y;
        }
        bottom = y;
      }
    }
    if (top >= 0) {
      points.push([x + 0.5, top], [x + 0.5, bottom + 1]);
    }
  }
  return points;
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

// -> { tl, tr, bl, br } each [x, y] in scan pixels, or null for an outline that is not a quadrilateral at all.
// A convex hull's extreme points along the two diagonals are the corners of a trapezoid / rectangle seen in perspective.
export function quadFromMask(mask, width, height, bbox) {
  const hull = convexHull(extremePoints(mask, width, height, bbox));
  if (hull.length < 3) {
    return null;
  }
  const pick = (score) =>
    hull.reduce((best, p) => (score(p) > score(best) ? p : best), hull[0]);
  const quad = {
    tl: pick((p) => -(p[0] + p[1])),
    tr: pick((p) => p[0] - p[1]),
    br: pick((p) => p[0] + p[1]),
    bl: pick((p) => p[1] - p[0]),
  };
  const ring = [quad.tl, quad.tr, quad.br, quad.bl];
  const distinct = new Set(ring.map((p) => p[0] + "," + p[1])).size;
  const box = bbox ? (bbox.x1 - bbox.x0) * (bbox.y1 - bbox.y0) : width * height;
  if (distinct < 4 || polygonArea(ring) < MIN_QUAD_AREA_SHARE * box) {
    return null;
  }
  return quad;
}

// ---------------------------------------------------------------- the proportions of the real rectangle
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// width / height of the rectangle whose perspective image is `quad`, for a camera with focal length f (pixels) and its
// principal point at (cx, cy). Zhang & He 2007. Falls back to the quad's plain pixel proportions if the maths degenerates
// (a quad that is nearly a parallelogram makes a denominator vanish).
export function rectangleAspect(quad, intrinsics) {
  const { fx, cx, cy } = intrinsics;
  const m = (p) => [p[0] - cx, p[1] - cy, 1];
  const m1 = m(quad.tl);
  const m2 = m(quad.tr);
  const m3 = m(quad.bl);
  const m4 = m(quad.br);
  const plain = () => {
    const w = (Math.hypot(quad.tr[0] - quad.tl[0], quad.tr[1] - quad.tl[1]) + Math.hypot(quad.br[0] - quad.bl[0], quad.br[1] - quad.bl[1])) / 2;
    const h = (Math.hypot(quad.bl[0] - quad.tl[0], quad.bl[1] - quad.tl[1]) + Math.hypot(quad.br[0] - quad.tr[0], quad.br[1] - quad.tr[1])) / 2;
    return h > 0 ? w / h : 1;
  };
  const d2 = dot3(cross3(m2, m4), m3);
  const d3 = dot3(cross3(m3, m4), m2);
  if (Math.abs(d2) < 1e-9 || Math.abs(d3) < 1e-9) {
    return plain();
  }
  const k2 = dot3(cross3(m1, m4), m3) / d2;
  const k3 = dot3(cross3(m1, m4), m2) / d3;
  const n2 = sub([k2 * m2[0], k2 * m2[1], k2 * m2[2]], m1);
  const n3 = sub([k3 * m3[0], k3 * m3[1], k3 * m3[2]], m1);
  const a2 = [n2[0] / fx, n2[1] / fx, n2[2]];
  const a3 = [n3[0] / fx, n3[1] / fx, n3[2]];
  const l2 = Math.hypot(a2[0], a2[1], a2[2]);
  const l3 = Math.hypot(a3[0], a3[1], a3[2]);
  const ratio = l3 > 0 ? l2 / l3 : NaN;
  return Number.isFinite(ratio) && ratio > 0.05 && ratio < 40 ? ratio : plain();
}

// 3x3 homography (9 numbers, row-major) that maps each src[i] to dst[i]; four point pairs. Gaussian elimination.
export function homographyFromPoints(src, dst) {
  const a = [];
  for (let i = 0; i < 4; i += 1) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 8; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
        pivot = row;
      }
    }
    if (Math.abs(a[pivot][col]) < 1e-12) {
      return null;
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = 0; row < 8; row += 1) {
      if (row === col) {
        continue;
      }
      const factor = a[row][col] / a[col][col];
      for (let k = col; k < 9; k += 1) {
        a[row][k] -= factor * a[col][k];
      }
    }
  }
  const h = [];
  for (let i = 0; i < 8; i += 1) {
    h.push(a[i][8] / a[i][i]);
  }
  h.push(1);
  return h;
}

// ---------------------------------------------------------------- one region
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// -> { homography: [9] (scan px -> metres), widthM, heightM, quad } for one wall / floor / ceiling region
export function provisionalRegion(region, scan, intrinsics) {
  const bbox = region.bbox;
  let quad = quadFromMask(region.mask, scan.width, scan.height, bbox);
  let aspect;
  if (quad) {
    aspect = rectangleAspect(quad, intrinsics);
  } else {
    // not a four-cornered shape: treat its bounding box as the rectangle (an affine mapping, no perspective)
    quad = {
      tl: [bbox.x0, bbox.y0],
      tr: [bbox.x1, bbox.y0],
      bl: [bbox.x0, bbox.y1],
      br: [bbox.x1, bbox.y1],
    };
    aspect = (bbox.x1 - bbox.x0) / Math.max(1, bbox.y1 - bbox.y0);
  }
  let widthM;
  let heightM;
  if (region.kind === "wall") {
    heightM = WALL_HEIGHT_M;
    widthM = clamp(aspect * heightM, 0.5, 12);
  } else {
    widthM = FLOOR_WIDTH_M;
    heightM = clamp(widthM / aspect, 1, 14);
  }
  let homography = homographyFromPoints(
    [quad.tl, quad.tr, quad.bl, quad.br],
    [
      [0, 0],
      [widthM, 0],
      [0, heightM],
      [widthM, heightM],
    ],
  );
  if (!homography || !applyHomography(homography, (bbox.x0 + bbox.x1) / 2, (bbox.y0 + bbox.y1) / 2)) {
    homography = [widthM / Math.max(1, bbox.x1 - bbox.x0), 0, 0, 0, heightM / Math.max(1, bbox.y1 - bbox.y0), 0, 0, 0, 1];
  }
  return { homography: homography, widthM: widthM, heightM: heightM, quad: quad };
}

// ---------------------------------------------------------------- the light
// Box blur of radius r, separable, edges clamped. Lighting is what is left of a photo once the old material's pattern
// (planks, grout, brush marks) has been blurred away.
export function boxBlur(source, width, height, radius) {
  const r = Math.max(1, Math.round(radius));
  const temp = new Float32Array(source.length);
  const out = new Float32Array(source.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let k = -r; k <= r; k += 1) {
      sum += source[row + clamp(k, 0, width - 1)];
    }
    for (let x = 0; x < width; x += 1) {
      temp[row + x] = sum / (2 * r + 1);
      sum += source[row + clamp(x + r + 1, 0, width - 1)] - source[row + clamp(x - r, 0, width - 1)];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let k = -r; k <= r; k += 1) {
      sum += temp[clamp(k, 0, height - 1) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / (2 * r + 1);
      sum += temp[clamp(y + r + 1, 0, height - 1) * width + x] - temp[clamp(y - r, 0, height - 1) * width + x];
    }
  }
  return out;
}

// ---------------------------------------------------------------- the scene
// scan: the studio's scan (width, height, labelMap, regions with mask / bbox / kind / id). photo: { luma, linear } from
// geometry.lumaFromRgba() at the scan's size. -> a scene for renderer.uploadScene(), kind "provisional".
export function buildProvisionalScene(scan, photo) {
  const intrinsics = assumedIntrinsics(scan.width, scan.height);
  const fusionRegions = {};
  scan.regions.forEach(function (region) {
    if (region.kind !== "wall" && region.kind !== "floor" && region.kind !== "ceiling") {
      return;
    }
    if (region.areaShare < 0.004) {
      return;
    }
    const estimate = provisionalRegion(region, scan, intrinsics);
    fusionRegions[region.id] = {
      provisional: true,
      homography: estimate.homography,
      sizeM: { width: estimate.widthM, height: estimate.heightM },
      confidence: PROVISIONAL_CONFIDENCE,
      tier: "flagged",
    };
  });
  return {
    kind: "provisional",
    scan: scan,
    fusionRegions: fusionRegions,
    depth: null,
    // the lighting alone: the photo's linear luminance with the surface's own texture blurred out
    shading: boxBlur(photo.linear, scan.width, scan.height, Math.max(scan.width, scan.height) * 0.03),
    residual: null,
    luma: photo.luma,
    photoLinear: photo.linear,
    intrinsics: intrinsics,
  };
}
