// Fusion: turns SAM 3's "where is each surface" + MoGe-2's "how big, which way" into, per
// region, a fitted plane, a real-world-scale tangent basis, and a confidence score. Pure math,
// no I/O - everything here is directly unit-testable with plain Node, and runFitRegions() below
// is the only thing that touches a worker_thread (see fusion.worker.js), so the CPU-heavy part
// (RANSAC + PCA, run once per region) never blocks the server's main event loop.
//
// Camera convention (pinhole, must match the browser renderer's shader and the MoGe-2 adapter
// exactly): X right, Y DOWN (image row direction), Z forward. A pixel (px, py) with depth d
// unprojects to camera-space P = ((px+0.5-cx)*d/fx, (py+0.5-cy)*d/fy, d). Because Y is down,
// "world up" is -Y: a floor's normal points close to (0,-1,0), a ceiling's close to (0,1,0).
// See server/lib/remoteModels/moge2.js's castBoxRoom(), which builds an exact synthetic room
// in this same convention as a ground-truth test fixture.
const path = require("path");

// ------------------------------------------------------------------ small vector helpers
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function length(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clampRange(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// A tiny deterministic PRNG (mulberry32) so fitRegions() always returns the same answer for
// the same input - no flaky tests, no surprise drift between two runs of the same scan.
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ mask helpers
// Shrinks a mask by `radius` pixels (separable box-erosion), so SAM's mild bleed across a
// silhouette edge (e.g. a wall mask overshooting a few px onto a sofa in front of it) is
// removed before it can pull a plane fit off course.
function erodeMask(mask, width, height, radius) {
  if (radius <= 0) {
    return mask;
  }
  const h = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let v = 1;
      for (let dx = -radius; dx <= radius && v; dx += 1) {
        const xx = x + dx;
        if (xx < 0 || xx >= width || mask[row + xx] === 0) {
          v = 0;
        }
      }
      h[row + x] = v;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let v = 1;
      for (let dy = -radius; dy <= radius && v; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height || h[yy * width + x] === 0) {
          v = 0;
        }
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

function countMaskPixels(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) {
      count += 1;
    }
  }
  return count;
}

// Unprojects every valid (mask=1, depth>0) pixel to a camera-space 3D point, deterministically
// stride-subsampled to at most maxSamples (RANSAC on every pixel of a large wall is wasted
// work). Returns the true valid-pixel count too (before subsampling), since that - not how
// many points RANSAC bothered to look at - is what "depth coverage" should measure.
function samplePoints(mask, width, height, depth, intrinsics, maxSamples) {
  const candidates = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] && depth[i] > 0) {
      candidates.push(i);
    }
  }
  const validCount = candidates.length;
  let chosen = candidates;
  if (candidates.length > maxSamples) {
    const stride = candidates.length / maxSamples;
    chosen = [];
    for (let k = 0; k < maxSamples; k += 1) {
      chosen.push(candidates[Math.floor(k * stride)]);
    }
  }
  const points = new Float64Array(chosen.length * 3);
  for (let k = 0; k < chosen.length; k += 1) {
    const i = chosen[k];
    const px = i % width;
    const py = (i - px) / width;
    const d = depth[i];
    points[k * 3] = ((px + 0.5 - intrinsics.cx) * d) / intrinsics.fx;
    points[k * 3 + 1] = ((py + 0.5 - intrinsics.cy) * d) / intrinsics.fy;
    points[k * 3 + 2] = d;
  }
  return { points: points, count: chosen.length, validCount: validCount };
}

// ------------------------------------------------------------------ plane fitting
// Cyclic Jacobi eigenvalue decomposition of a symmetric 3x3 matrix - robust for the
// near-isotropic / repeated-eigenvalue cases a closed-form cubic solve handles badly.
function symmetricEigen3x3(a00, a01, a02, a11, a12, a22) {
  const A = [
    [a00, a01, a02],
    [a01, a11, a12],
    [a02, a12, a22],
  ];
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep += 1) {
    let p = 0;
    let q = 1;
    let max = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > max) {
      max = Math.abs(A[0][2]);
      p = 0;
      q = 2;
    }
    if (Math.abs(A[1][2]) > max) {
      max = Math.abs(A[1][2]);
      p = 1;
      q = 2;
    }
    if (max < 1e-12) {
      break;
    }
    const app = A[p][p];
    const aqq = A[q][q];
    const apq = A[p][q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    A[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    A[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    A[p][q] = 0;
    A[q][p] = 0;
    const r = 3 - p - q;
    const arp = A[r][p];
    const arq = A[r][q];
    A[r][p] = c * arp - s * arq;
    A[p][r] = A[r][p];
    A[r][q] = s * arp + c * arq;
    A[q][r] = A[r][q];
    for (let i = 0; i < 3; i += 1) {
      const vip = V[i][p];
      const viq = V[i][q];
      V[i][p] = c * vip - s * viq;
      V[i][q] = s * vip + c * viq;
    }
  }
  return {
    eigenvalues: [A[0][0], A[1][1], A[2][2]],
    eigenvectors: [
      [V[0][0], V[1][0], V[2][0]],
      [V[0][1], V[1][1], V[2][1]],
      [V[0][2], V[1][2], V[2][2]],
    ],
  };
}

function smallestEigenvector3x3(xx, xy, xz, yy, yz, zz) {
  const eig = symmetricEigen3x3(xx, xy, xz, yy, yz, zz);
  let minIndex = 0;
  for (let i = 1; i < 3; i += 1) {
    if (eig.eigenvalues[i] < eig.eigenvalues[minIndex]) {
      minIndex = i;
    }
  }
  const v = eig.eigenvectors[minIndex];
  const len = length(v) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

// RANSAC plane fit + PCA refit over the winning inlier set. The inlier threshold is relative
// to mean depth (monocular metric-depth error scales with distance - a fixed cm tolerance is
// too strict far away and too loose up close).
function fitPlaneRANSAC(points, count, options) {
  const opts = options || {};
  const iterations = opts.iterations || 300;
  const rng = opts.rng || makeRng(1);
  const empty = { origin: [0, 0, 0], normal: [0, 0, 1], inlierRatio: 0, rmsResidualM: Infinity, sampleCount: count, tau: 1 };
  if (count < 3) {
    return empty;
  }

  let depthSum = 0;
  for (let k = 0; k < count; k += 1) {
    depthSum += points[k * 3 + 2];
  }
  const meanDepth = depthSum / count;
  const tau = clampRange(0.02 * meanDepth, 0.01, 0.05);

  let bestInliers = 0;
  let bestNormal = null;
  let bestOrigin = null;
  for (let iter = 0; iter < iterations; iter += 1) {
    const i0 = (rng() * count) | 0;
    const i1 = (rng() * count) | 0;
    const i2 = (rng() * count) | 0;
    if (i0 === i1 || i1 === i2 || i0 === i2) {
      continue;
    }
    const ax = points[i0 * 3];
    const ay = points[i0 * 3 + 1];
    const az = points[i0 * 3 + 2];
    const b = [points[i1 * 3] - ax, points[i1 * 3 + 1] - ay, points[i1 * 3 + 2] - az];
    const c = [points[i2 * 3] - ax, points[i2 * 3 + 1] - ay, points[i2 * 3 + 2] - az];
    const n = cross(b, c);
    const nlen = length(n);
    if (nlen < 1e-9) {
      continue;
    }
    const nx = n[0] / nlen;
    const ny = n[1] / nlen;
    const nz = n[2] / nlen;
    let inliers = 0;
    for (let k = 0; k < count; k += 1) {
      const dx = points[k * 3] - ax;
      const dy = points[k * 3 + 1] - ay;
      const dz = points[k * 3 + 2] - az;
      if (Math.abs(dx * nx + dy * ny + dz * nz) <= tau) {
        inliers += 1;
      }
    }
    if (inliers > bestInliers) {
      bestInliers = inliers;
      bestNormal = [nx, ny, nz];
      bestOrigin = [ax, ay, az];
    }
  }
  if (!bestNormal) {
    return empty;
  }

  const inlierIdx = [];
  for (let k = 0; k < count; k += 1) {
    const dx = points[k * 3] - bestOrigin[0];
    const dy = points[k * 3 + 1] - bestOrigin[1];
    const dz = points[k * 3 + 2] - bestOrigin[2];
    if (Math.abs(dx * bestNormal[0] + dy * bestNormal[1] + dz * bestNormal[2]) <= tau) {
      inlierIdx.push(k);
    }
  }

  let ox = 0;
  let oy = 0;
  let oz = 0;
  for (let j = 0; j < inlierIdx.length; j += 1) {
    const k = inlierIdx[j];
    ox += points[k * 3];
    oy += points[k * 3 + 1];
    oz += points[k * 3 + 2];
  }
  const n = inlierIdx.length;
  ox /= n;
  oy /= n;
  oz /= n;

  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (let j = 0; j < inlierIdx.length; j += 1) {
    const k = inlierIdx[j];
    const dx = points[k * 3] - ox;
    const dy = points[k * 3 + 1] - oy;
    const dz = points[k * 3 + 2] - oz;
    xx += dx * dx;
    xy += dx * dy;
    xz += dx * dz;
    yy += dy * dy;
    yz += dy * dz;
    zz += dz * dz;
  }
  xx /= n;
  xy /= n;
  xz /= n;
  yy /= n;
  yz /= n;
  zz /= n;

  let normal = smallestEigenvector3x3(xx, xy, xz, yy, yz, zz);
  // Orient the normal to face back toward the camera (origin is at (0,0,0) in camera space,
  // so "faces the camera" means normal·planeOrigin <= 0) - otherwise the sign is whatever the
  // winning 3-point cross product happened to produce, which breaks the antiparallel/
  // perpendicular checks in crossRegionConsistency() below.
  if (normal[0] * ox + normal[1] * oy + normal[2] * oz > 0) {
    normal = [-normal[0], -normal[1], -normal[2]];
  }

  let residSum = 0;
  for (let j = 0; j < inlierIdx.length; j += 1) {
    const k = inlierIdx[j];
    const dx = points[k * 3] - ox;
    const dy = points[k * 3 + 1] - oy;
    const dz = points[k * 3 + 2] - oz;
    const dist = dx * normal[0] + dy * normal[1] + dz * normal[2];
    residSum += dist * dist;
  }

  return {
    origin: [ox, oy, oz],
    normal: normal,
    inlierRatio: n / count,
    rmsResidualM: Math.sqrt(residSum / n),
    sampleCount: count,
    tau: tau,
  };
}

// ------------------------------------------------------------------ UV basis
// Builds an orthonormal in-plane (U,V) tangent frame, in metres, from a fitted normal.
// Degenerate when the normal is nearly parallel to upGuess (the floor/ceiling case, where
// cross(up, normal) collapses toward zero) - swaps in camera-forward as the reference axis
// instead. Missing this special case means NaN UVs on every floor/ceiling region.
function buildUvBasis(normal, upGuess) {
  const up = upGuess || [0, -1, 0];
  const alignment = Math.abs(normal[0] * up[0] + normal[1] * up[1] + normal[2] * up[2]);
  const reference = alignment > 0.9 ? [0, 0, 1] : up;
  let u = cross(reference, normal);
  let ulen = length(u);
  if (ulen < 1e-9) {
    u = cross([1, 0, 0], normal);
    ulen = length(u) || 1;
  }
  u = [u[0] / ulen, u[1] / ulen, u[2] / ulen];
  const v = cross(normal, u);
  return { u: u, v: v };
}

// ------------------------------------------------------------------ confidence
function normalizeKind(kind) {
  const k = String(kind || "").toLowerCase();
  if (k.indexOf("floor") !== -1) {
    return "floor";
  }
  if (k.indexOf("ceiling") !== -1) {
    return "ceiling";
  }
  if (k.indexOf("wall") !== -1 || k.indexOf("facade") !== -1) {
    return "wall";
  }
  return k;
}

function angleBetweenDeg(a, b) {
  const dot = clampRange(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  return Math.acos(dot) * (180 / Math.PI);
}

// What angle two region kinds should meet at, if both are real flat surfaces of a room. Wide
// tolerances: rooms aren't always rectangular.
function kindPairExpectation(kindA, kindB) {
  const a = normalizeKind(kindA);
  const b = normalizeKind(kindB);
  if ((a === "floor" && b === "wall") || (a === "wall" && b === "floor")) {
    return { target: 90, tolerance: 35 };
  }
  if ((a === "ceiling" && b === "wall") || (a === "wall" && b === "ceiling")) {
    return { target: 90, tolerance: 35 };
  }
  if ((a === "floor" && b === "ceiling") || (a === "ceiling" && b === "floor")) {
    return { target: 180, tolerance: 35 };
  }
  if (a === "wall" && b === "wall") {
    return { target: 90, tolerance: 45 };
  }
  return null;
}

// Only meaningful once a real "up" vector exists (not just buildUvBasis's default guess).
function absoluteExpectation(kind) {
  const k = normalizeKind(kind);
  if (k === "floor") {
    return 0;
  }
  if (k === "ceiling") {
    return 180;
  }
  if (k === "wall") {
    return 90;
  }
  return null;
}

// Needs no absolute reference frame at all: compares each pair of already-fitted regions'
// normals against what their kinds should geometrically imply (floor-vs-wall ~90°,
// floor-vs-ceiling ~antiparallel, wall-vs-wall ~90°). Works whether or not the geometry
// adapter exposes a gravity/up vector. When `up` is known, it's folded in as one more signal
// per region rather than replacing the pairwise check.
function crossRegionConsistency(fitted, up) {
  const pairScores = fitted.map(function () {
    return [];
  });
  for (let i = 0; i < fitted.length; i += 1) {
    for (let j = i + 1; j < fitted.length; j += 1) {
      const expectation = kindPairExpectation(fitted[i].kind, fitted[j].kind);
      if (!expectation) {
        continue;
      }
      const angle = angleBetweenDeg(fitted[i].fit.normal, fitted[j].fit.normal);
      const score = clamp01(1 - Math.abs(angle - expectation.target) / expectation.tolerance);
      pairScores[i].push(score);
      pairScores[j].push(score);
    }
  }
  return fitted.map(function (entry, index) {
    const list = pairScores[index].slice();
    if (up) {
      const target = absoluteExpectation(entry.kind);
      if (target !== null) {
        const angle = angleBetweenDeg(entry.fit.normal, up);
        list.push(clamp01(1 - Math.abs(angle - target) / 35));
      }
    }
    // No comparable neighbour and no up vector: neither confirms nor contradicts the fit.
    if (list.length === 0) {
      return 0.65;
    }
    return list.reduce(function (sum, value) {
      return sum + value;
    }, 0) / list.length;
  });
}

function scoreDepthCoverage(validCount, maskPixelCount) {
  // A "perfect" plane fit from a handful of lucky points isn't trustworthy regardless of fit
  // quality, so this is a hard floor, not just a ratio.
  if (validCount < 150 || maskPixelCount <= 0) {
    return 0;
  }
  return clamp01(validCount / maskPixelCount);
}

// Weighted geometric mean, not a plain average: one genuinely bad sub-score should drag the
// total down, not get diluted by three fine ones.
function combineConfidence(subScores) {
  const m = Math.max(1e-6, subScores.maskScore);
  const p = Math.max(1e-6, subScores.planarity);
  const s = Math.max(1e-6, subScores.semanticGeometric);
  const d = Math.max(1e-6, subScores.depthCoverage);
  return Math.pow(m, 0.2) * Math.pow(p, 0.35) * Math.pow(s, 0.25) * Math.pow(d, 0.2);
}

function tierFor(confidence, lowThreshold, highThreshold) {
  if (confidence < lowThreshold) {
    return "gemini-only";
  }
  if (confidence < highThreshold) {
    return "flagged";
  }
  return "fast";
}

// ------------------------------------------------------------------ top-level
// input: {width, height, depth: Float32Array, intrinsics:{fx,fy,cx,cy}, up: [x,y,z]|null,
//         regions: [{id, kind, label, mask: Uint8Array, score}], lowThreshold?, highThreshold?}
// output: {byId: {"<regionId>": {plane, confidence, subScores, sampleCount, inlierRatio,
//                                 rmsResidualM, tier}}}
function fitRegions(input) {
  const width = input.width;
  const height = input.height;
  const depth = input.depth;
  const intrinsics = input.intrinsics;
  const up = Array.isArray(input.up) && input.up.length === 3 ? input.up : null;
  const upGuessForBasis = up || [0, -1, 0];
  const lowThreshold = input.lowThreshold != null ? input.lowThreshold : 0.45;
  const highThreshold = input.highThreshold != null ? input.highThreshold : 0.7;
  const regions = input.regions || [];

  const erodedMasks = regions.map(function (region) {
    return erodeMask(region.mask, width, height, 2);
  });

  const fitted = regions.map(function (region, index) {
    const eroded = erodedMasks[index];
    const sampled = samplePoints(eroded, width, height, depth, intrinsics, 4000);
    const fit = fitPlaneRANSAC(sampled.points, sampled.count, { iterations: 300, rng: makeRng(1) });
    const basis = buildUvBasis(fit.normal, upGuessForBasis);
    return {
      id: region.id,
      kind: region.kind,
      score: region.score,
      fit: fit,
      basis: basis,
      validCount: sampled.validCount,
      maskPixelCount: countMaskPixels(eroded),
    };
  });

  const semanticScores = crossRegionConsistency(fitted, up);

  const byId = {};
  fitted.forEach(function (entry, index) {
    const maskScore = clamp01(entry.score);
    const planarity = clamp01(entry.fit.inlierRatio * clamp01(1 - entry.fit.rmsResidualM / (entry.fit.tau || 1)));
    const semanticGeometric = semanticScores[index];
    const depthCoverage = scoreDepthCoverage(entry.validCount, entry.maskPixelCount);
    const subScores = { maskScore: maskScore, planarity: planarity, semanticGeometric: semanticGeometric, depthCoverage: depthCoverage };
    const confidence = combineConfidence(subScores);
    byId[entry.id] = {
      plane: { origin: entry.fit.origin, normal: entry.fit.normal, u: entry.basis.u, v: entry.basis.v },
      confidence: confidence,
      subScores: subScores,
      sampleCount: entry.fit.sampleCount,
      inlierRatio: entry.fit.inlierRatio,
      rmsResidualM: entry.fit.rmsResidualM,
      tier: tierFor(confidence, lowThreshold, highThreshold),
    };
  });

  return { byId: byId };
}

// Runs fitRegions() on its own thread (see fusion.worker.js) so a large scan's RANSAC/PCA pass
// never blocks the main event loop that's also serving every other request. Pure compute
// boundary: the worker touches no database and no network, only workerData in, postMessage out.
function runFitRegions(input) {
  const { Worker } = require("worker_threads");
  return new Promise(function (resolve, reject) {
    const worker = new Worker(path.join(__dirname, "fusion.worker.js"), { workerData: input });
    worker.once("message", function (message) {
      worker.terminate();
      if (message && message.ok) {
        resolve(message.regions);
      } else {
        reject(new Error((message && message.error) || "Fusion worker failed."));
      }
    });
    worker.once("error", function (error) {
      reject(error);
    });
  });
}

module.exports = {
  erodeMask: erodeMask,
  countMaskPixels: countMaskPixels,
  samplePoints: samplePoints,
  symmetricEigen3x3: symmetricEigen3x3,
  smallestEigenvector3x3: smallestEigenvector3x3,
  fitPlaneRANSAC: fitPlaneRANSAC,
  buildUvBasis: buildUvBasis,
  crossRegionConsistency: crossRegionConsistency,
  combineConfidence: combineConfidence,
  fitRegions: fitRegions,
  runFitRegions: runFitRegions,
  makeRng: makeRng,
};
