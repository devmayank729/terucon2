// The instant preview BEFORE the room has been understood in 3D.
//
// MoGe-2 + Marigold take a while on a cold GPU, and the designer should not stare at a blank photo when they tap a
// surface and pick a finish right after the scan. So until the pipeline's result is in (or if it fails), the preview runs
// on an ESTIMATE made from the scan alone:
//   - each wall / floor / ceiling (and, since the catalogue designs are offered on them, each door, piece of furniture and "other"
//     object: see ESTIMATED_KINDS) gets the four corners of its outline (the convex hull's extreme points)
//   - the corners are a perspective view of a rectangle, and with a typical phone camera's field of view the rectangle's
//     proportions follow from them (Zhang & He, "Whiteboard scanning and image enhancement", 2007)
//   - a standard size is assumed for the real rectangle (a wall is 2.6 m high, a floor or ceiling 4 m across), which fixes
//     the scale of the tiles: right in proportion and perspective, roughly right in size
//   - the light comes from the photo itself, blurred so that only the lighting is left and not the old material's pattern
// The result has the same shape as the real thing (public/js/lib/fastrender/renderer.js's scene), with a homography per
// region instead of a fitted plane, so the same shaders draw both. When the pipeline finishes, the studio swaps the real
// scene in and the preview sharpens in place. It is marked "flagged" (confidence 0.6) so the studio keeps nudging toward
// the AI render for the final image, and its sizes are guesses, which is why it is called provisional.
import { applyHomography, planeHomography } from "./geometry.js";

export const ASSUMED_FOV_DEG = 62; // horizontal field of view of a phone's main camera across the photo's long side
export const WALL_HEIGHT_M = 2.6;
export const DOOR_HEIGHT_M = 2.1;
export const FURNITURE_HEIGHT_M = 0.9;
export const OTHER_HEIGHT_M = 1;
export const FLOOR_WIDTH_M = 4;
export const PROVISIONAL_CONFIDENCE = 0.6;
const MIN_QUAD_AREA_SHARE = 0.25; // of the bounding box, below this the outline is not a four-cornered shape

// The kinds of surface the estimate covers. The room's real fit (MoGe-2's plane fit, on the server: swatchroom/server/lib/
// pipelineRunner.js) covers only the first three, so before this a door, a cabinet or a sofa never had an instant preview, whatever
// finish was picked. The others are treated as UPRIGHT surfaces: a plane standing on the floor, facing the camera, at the distance
// of the object's foot. That is exact for a door or a cabinet front and a fair stand-in for a sofa, a bed or a table (the pattern
// is not foreshortened along a seat or a table top); the estimate is flagged (PROVISIONAL_CONFIDENCE), so the studio keeps pointing
// to the AI render for the finished picture. A window is not in the list: its finishes add curtains and blinds in front of it.
export const ESTIMATED_KINDS = ["wall", "floor", "ceiling", "door", "furniture", "other"];
export function isEstimatedKind(kind) {
  return ESTIMATED_KINDS.indexOf(kind) !== -1;
}
// The assumed real height of an upright surface, used when there is no level-camera prior for it (the four-corner estimate)
const UPRIGHT_HEIGHT_M = { wall: WALL_HEIGHT_M, door: DOOR_HEIGHT_M, furniture: FURNITURE_HEIGHT_M, other: OTHER_HEIGHT_M };

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

// DRAFT: a level-camera prior for floors, ceilings and head-on walls, used instead of the four-corner estimate below.
// Why: the four corners are the hull's extreme points. A floor that runs out of the frame on the left and the right (almost
// every floor) has a hull that is a plain rectangle, so the estimate was a flat, perspective-free poster 4 m wide (measured:
// the vanishing term of its homography is ~1e-6); and a wall with furniture in front of it has a hull whose corners are
// picked from the furniture's cut-out, which shears the mapping (bricks sloping 15 degrees on a head-on wall).
// The prior: the camera is CAMERA_HEIGHT_M above the floor and looks (nearly) horizontally; the floor / ceiling are planes
// at that height / CEILING_HEIGHT_M, a head-on wall is a plane standing on the floor at the row where the wall meets it.
// It gives real perspective and a real scale from one assumed number, but it is a prior, not a measurement.
export const CAMERA_HEIGHT_M = 1.5;
export const CEILING_HEIGHT_M = 2.6;
const HORIZON_MARGIN = 0.06; // of the picture's height

// The camera pitch (radians, + = looking down) that puts the horizon row above the highest floor pixel (or the lowest ceiling
// pixel), and at the picture's centre when nothing forces it elsewhere.
function pitchFor(scan, intrinsics) {
  let horizon = intrinsics.cy;
  scan.regions.forEach(function (region) {
    if (region.kind === "floor" && region.areaShare >= 0.004) {
      horizon = Math.min(horizon, region.bbox.y0 - HORIZON_MARGIN * scan.height);
    }
  });
  return Math.atan((intrinsics.cy - horizon) / intrinsics.fy);
}

// camera axes in world coordinates (Y up, Z forward), camera pitched down by p: x = (1,0,0), y (down) = (0,-cos p,-sin p), z (forward) = (0,-sin p,cos p)
function levelPlane(kind, p, intrinsics) {
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  if (kind === "floor") {
    return { origin: [0, CAMERA_HEIGHT_M * cp, CAMERA_HEIGHT_M * sp], normal: [0, -cp, -sp], u: [1, 0, 0], v: [0, -sp, cp] };
  }
  const c = CEILING_HEIGHT_M - CAMERA_HEIGHT_M; // the ceiling's height above the camera
  return { origin: [0, -c * cp, -c * sp], normal: [0, cp, sp], u: [1, 0, 0], v: [0, -sp, cp] };
}

function wallPlaneFromBase(baseRow, p, intrinsics) {
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const ry = (baseRow - intrinsics.cy) / intrinsics.fy;
  const t = CAMERA_HEIGHT_M / (cp * ry + sp); // the ray through the wall's foot meets the floor here
  if (!(t > 0)) {
    return null; // the foot is at or above the horizon: no floor under it
  }
  const distance = t * (cp - sp * ry); // horizontal distance of the wall
  return { origin: [0, -distance * sp, distance * cp], normal: [0, sp, -cp], u: [1, 0, 0], v: [0, cp, sp] };
}

// -> { homography, widthM, heightM, prior: true } or null (use the four-corner estimate)
function priorRegion(region, scan, intrinsics, p) {
  let plane = null;
  const horizonRow = intrinsics.cy - intrinsics.fy * Math.tan(p);
  if (region.kind === "floor" || region.kind === "ceiling") {
    // the plane only exists on its own side of the horizon (a ceiling that dips below it, or a floor above it: no prior)
    if (region.kind === "floor" ? region.bbox.y0 <= horizonRow : region.bbox.y1 >= horizonRow) {
      return null;
    }
    plane = levelPlane(region.kind, p, intrinsics);
  } else if (region.kind === "furniture" || region.kind === "other") {
    // not a rectangle, so no head-on test: a plane standing on the floor at the row where the object meets it (null when that row
    // is at or above the horizon: a wall cabinet, a hanging lamp, a camera looking up)
    plane = wallPlaneFromBase(region.bbox.y1, p, intrinsics);
  } else if (region.kind === "wall" || region.kind === "door") {
    // only a wall (or a door in it) that faces the camera: with a level camera, verticals stay vertical for every wall, but the horizontal edges
    // of a head-on wall are horizontal in the picture (those of an oblique wall slope toward the horizon). Use the top edge of
    // the outline; if that is the picture's own border, the bottom edge; if both are cut off, there is nothing to go on.
    const bbox = region.bbox;
    const quad = quadFromMask(region.mask, scan.width, scan.height, bbox);
    if (!quad) {
      return null;
    }
    const tolerance = 0.03 * scan.height;
    let horizontal;
    if (bbox.y0 > 1) {
      horizontal = Math.abs(quad.tl[1] - quad.tr[1]) <= tolerance;
    } else if (bbox.y1 < scan.height - 1) {
      horizontal = Math.abs(quad.bl[1] - quad.br[1]) <= tolerance;
    } else {
      return null;
    }
    if (!horizontal) {
      return null;
    }
    plane = wallPlaneFromBase(bbox.y1, p, intrinsics);
  }
  if (!plane) {
    return null;
  }
  const homography = planeHomography(plane, intrinsics);
  const corners = [
    applyHomography(homography, region.bbox.x0, region.bbox.y0),
    applyHomography(homography, region.bbox.x1, region.bbox.y1),
  ];
  if (!corners[0] || !corners[1]) {
    return null;
  }
  return { homography: homography, widthM: Math.abs(corners[1][0] - corners[0][0]), heightM: Math.abs(corners[1][1] - corners[0][1]) };
}

// -> { homography: [9] (scan px -> metres), widthM, heightM, quad } for one region of an estimated kind (ESTIMATED_KINDS)
export function provisionalRegion(region, scan, intrinsics) {
  const prior = priorRegion(region, scan, intrinsics, pitchFor(scan, intrinsics));
  if (prior) {
    return prior;
  }
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
  if (UPRIGHT_HEIGHT_M[region.kind]) {
    heightM = UPRIGHT_HEIGHT_M[region.kind];
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

// DRAFT: the light of ONE region, edge-preserving and confined to that region. The old estimate blurred the whole photo with
// one box (radius 3% of the long side), which (a) erased the sun / shadow edges that carry most of a room's look and (b) mixed
// the brightness of the neighbouring surfaces (a cove light, a window, a dark sofa) into the surface's edge. Here: a guided
// filter (He, Sun, Tang 2010, the guide is the image itself) on log luminance, computed with the region's mask as weights so
// nothing outside the region contributes. Detail weaker than ~sqrt(EPS) (plank grain, grout, brush marks: the OLD material)
// is flattened, edges stronger than that (a sunbeam, a shadow, the fall-off toward a window) stay sharp.
const GUIDE_EPS = 0.25 * 0.25; // log-luminance variance below this is flattened (~25%: old grain, grout), above it is kept
const GUIDE_RADIUS = 8; // scan pixels
const PRE_BLUR = 4; // scan pixels: detail finer than about this is the old finish's pattern, not the light
function maskedGuided(linear, region, width, height, out) {
  const pad = GUIDE_RADIUS * 2 + 2;
  const x0 = Math.max(0, region.bbox.x0 - pad);
  const y0 = Math.max(0, region.bbox.y0 - pad);
  const x1 = Math.min(width, region.bbox.x1 + pad);
  const y1 = Math.min(height, region.bbox.y1 + pad);
  const w = x1 - x0;
  const h = y1 - y0;
  const m = new Float32Array(w * h);
  const I = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const src = (y + y0) * width + (x + x0);
      m[y * w + x] = region.mask[src] ? 1 : 0;
      I[y * w + x] = Math.log(Math.max(linear[src], 1e-3));
    }
  }
  // fine, regular detail (wood slats, grout lines, plank grain: all the OLD finish) is removed first by a small masked blur, so
  // that the edge test below only has to tell a sunbeam from a shadow, not from a pattern a few pixels wide
  const preM = boxBlur(m, w, h, PRE_BLUR);
  const preI = boxBlur(I.map((v, i) => v * m[i]), w, h, PRE_BLUR);
  for (let i = 0; i < I.length; i += 1) {
    if (m[i] && preM[i] > 1e-4) {
      I[i] = preI[i] / preM[i];
    }
  }
  const Im = new Float32Array(w * h);
  const II = new Float32Array(w * h);
  for (let i = 0; i < m.length; i += 1) {
    Im[i] = I[i] * m[i];
    II[i] = I[i] * I[i] * m[i];
  }
  const r = GUIDE_RADIUS;
  const sw = boxBlur(m, w, h, r);
  const sI = boxBlur(Im, w, h, r);
  const sII = boxBlur(II, w, h, r);
  const a = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  for (let i = 0; i < a.length; i += 1) {
    const weight = Math.max(sw[i], 1e-4);
    const mean = sI[i] / weight;
    const variance = Math.max(0, sII[i] / weight - mean * mean);
    a[i] = (variance / (variance + GUIDE_EPS)) * m[i];
    b[i] = (mean - (variance / (variance + GUIDE_EPS)) * mean) * m[i];
  }
  const sa = boxBlur(a, w, h, r);
  const sb = boxBlur(b, w, h, r);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (m[i]) {
        const weight = Math.max(sw[i], 1e-4);
        out[(y + y0) * width + (x + x0)] = Math.exp((sa[i] / weight) * I[i] + sb[i] / weight);
      }
    }
  }
}

export function regionShading(scan, linear) {
  // outside every surface that will be painted, the old whole-photo blur (those pixels are never drawn)
  const out = boxBlur(linear, scan.width, scan.height, Math.max(scan.width, scan.height) * 0.03);
  scan.regions.forEach(function (region) {
    if (isEstimatedKind(region.kind) && region.areaShare >= 0.004 && region.mask) {
      maskedGuided(linear, region, scan.width, scan.height, out);
    }
  });
  return out;
}

// ---------------------------------------------------------------- the scene
// scan: the studio's scan (width, height, labelMap, regions with mask / bbox / kind / id). photo: { luma, linear } from
// geometry.lumaFromRgba() at the scan's size. -> a scene for renderer.uploadScene(), kind "provisional".
export function buildProvisionalScene(scan, photo) {
  const intrinsics = assumedIntrinsics(scan.width, scan.height);
  const fusionRegions = {};
  scan.regions.forEach(function (region) {
    if (!isEstimatedKind(region.kind)) {
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
    shading: regionShading(scan, photo.linear),
    residual: null,
    luma: photo.luma,
    photoLinear: photo.linear,
    tint: photo.tint || null,
    intrinsics: intrinsics,
  };
}
