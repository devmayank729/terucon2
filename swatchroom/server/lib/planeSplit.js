// When one "wall" region of the scan is really two or three walls. The scene model labels every wall pixel "wall";
// without a Gemini outline per wall the scan keeps all the walls of a room that touch each other as ONE region, and one
// finish then gets painted across a corner as if it were a flat sheet. This finds the planes a region is made of:
//
//   1. seeds: the pieces of the region that SAM 3 sees as separate wall instances (or, without SAM, the two dominant
//      planes of a sequential RANSAC on the depth)
//   2. a plane is fitted to each seed (the same RANSAC + PCA fusion.js uses), seeds on the same plane are merged
//   3. every pixel of the region goes to the plane it is closest to IN 3D, so the seam between two walls lands on the
//      real corner line (the intersection of the planes) however ragged SAM's mask edges are
//   4. a majority filter removes speckle along the seam, slivers are absorbed, the final planes must be flat enough
//      and must differ in orientation by at least minAngleDeg, otherwise there is no split
//
// Pure math on typed arrays, no I/O; the pipeline calls it from the fusion worker (fusion.worker.js). The result is a
// PROPOSAL: server/lib/pipelineRunner.js stores it next to the planes, and the browser (public/js/lib/planeSplit.js)
// applies it to the scan it owns, because region ids and the label map belong to the browser.
const fusion = require("./fusion");

const MIN_REGION_SHARE = 0.015; // a wall smaller than 1.5% of the photo is not worth splitting
const MIN_SEED_PIXELS = 300; // valid depth pixels a seed needs for a trustworthy plane
const SEED_SHARE = 0.1; // ... and at least this share of the region's valid depth pixels
const MERGE_ANGLE_DEG = 12; // two seeds whose planes are closer than this in angle ...
const MERGE_OFFSET_FRACTION = 0.04; // ... and in position (as a fraction of the mean depth) are one plane
const MIN_PART_SHARE = 0.04; // a part smaller than this share of the region is a sliver and is absorbed
const MIN_PART_PIXELS = 600;
const MIN_INLIER_RATIO = 0.55; // a final part must be at least this flat
const SMOOTH_RADIUS = 3;
const SMOOTH_PASSES = 2;

function angleDeg(a, b) {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return (Math.acos(dot) * 180) / Math.PI;
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function intersect(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    out[i] = a[i] && b[i] ? 1 : 0;
  }
  return out;
}

function pixelCount(mask) {
  return fusion.countMaskPixels(mask);
}

function validDepthMask(mask, depth) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) {
    out[i] = mask[i] && depth[i] > 0 ? 1 : 0;
  }
  return out;
}

function fitMaskPlane(mask, input, seed) {
  const sampled = fusion.samplePoints(mask, input.width, input.height, input.depth, input.intrinsics, 4000);
  const fit = fusion.fitPlaneRANSAC(sampled.points, sampled.count, { iterations: 200, rng: fusion.makeRng(seed || 1) });
  return { fit: fit, validCount: sampled.validCount, points: sampled.points, count: sampled.count };
}

// Seeds from SAM: the part of the region's valid-depth pixels each wall instance claims. Instances overlap now and then
// (SAM happily returns a "wall" and a bigger "wall"), so a pixel goes to the highest-scoring instance that has it.
function samSeeds(valid, samInstances) {
  const sorted = samInstances.slice().sort(function (a, b) {
    return (b.score || 0) - (a.score || 0);
  });
  const claimed = new Uint8Array(valid.length);
  const seeds = [];
  sorted.forEach(function (instance) {
    const seed = new Uint8Array(valid.length);
    let count = 0;
    for (let i = 0; i < valid.length; i += 1) {
      if (valid[i] && instance.mask[i] && !claimed[i]) {
        seed[i] = 1;
        count += 1;
      }
    }
    if (count > 0) {
      for (let i = 0; i < seed.length; i += 1) {
        if (seed[i]) {
          claimed[i] = 1;
        }
      }
      seeds.push({ mask: seed, count: count });
    }
  });
  return seeds;
}

// Seeds without SAM: the dominant plane, then the dominant plane of what it leaves over.
function ransacSeeds(valid, input, validTotal) {
  const first = fitMaskPlane(valid, input, 1);
  if (first.fit.inlierRatio === 0) {
    return [];
  }
  const tau = first.fit.tau;
  const inliers = new Uint8Array(valid.length);
  const rest = new Uint8Array(valid.length);
  const { fx, fy, cx, cy } = input.intrinsics;
  const n = first.fit.normal;
  const o = first.fit.origin;
  for (let i = 0; i < valid.length; i += 1) {
    if (!valid[i]) {
      continue;
    }
    const x = i % input.width;
    const y = (i - x) / input.width;
    const d = input.depth[i];
    const px = ((x + 0.5 - cx) * d) / fx;
    const py = ((y + 0.5 - cy) * d) / fy;
    const distance = Math.abs((px - o[0]) * n[0] + (py - o[1]) * n[1] + (d - o[2]) * n[2]);
    if (distance <= tau * 1.5) {
      inliers[i] = 1;
    } else {
      rest[i] = 1;
    }
  }
  const leftover = pixelCount(rest);
  const seeds = [{ mask: inliers, count: pixelCount(inliers) }];
  if (leftover >= Math.max(MIN_SEED_PIXELS, SEED_SHARE * validTotal)) {
    seeds.push({ mask: rest, count: leftover });
  }
  return seeds;
}

// Union-find merge of seeds that lie on the same plane; returns clusters of {mask, plane}.
function clusterSeeds(seeds, input) {
  const planes = seeds.map(function (seed, index) {
    return fitMaskPlane(seed.mask, input, index + 7);
  });
  const parent = seeds.map(function (seed, index) {
    return index;
  });
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  for (let i = 0; i < seeds.length; i += 1) {
    for (let j = i + 1; j < seeds.length; j += 1) {
      const a = planes[i].fit;
      const b = planes[j].fit;
      if (a.inlierRatio === 0 || b.inlierRatio === 0) {
        continue;
      }
      const meanDepth = (a.origin[2] + b.origin[2]) / 2;
      const offset = Math.abs(dot3(a.normal, [b.origin[0] - a.origin[0], b.origin[1] - a.origin[1], b.origin[2] - a.origin[2]]));
      if (angleDeg(a.normal, b.normal) < MERGE_ANGLE_DEG && offset < Math.max(0.05, MERGE_OFFSET_FRACTION * meanDepth)) {
        parent[find(j)] = find(i);
      }
    }
  }
  const groups = new Map();
  seeds.forEach(function (seed, index) {
    const root = find(index);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root).push(index);
  });
  const clusters = [];
  groups.forEach(function (members) {
    let mask = seeds[members[0]].mask;
    if (members.length > 1) {
      mask = new Uint8Array(mask.length);
      members.forEach(function (index) {
        for (let i = 0; i < mask.length; i += 1) {
          if (seeds[index].mask[i]) {
            mask[i] = 1;
          }
        }
      });
    }
    const plane = members.length > 1 ? fitMaskPlane(mask, input, 31) : planes[members[0]];
    if (plane.fit.inlierRatio > 0) {
      clusters.push({ mask: mask, plane: plane.fit, count: pixelCount(mask) });
    }
  });
  return clusters;
}

// Majority filter on a label image, inside `region` only (labels 1..k, 0 = outside).
function smoothLabels(labels, region, width, height, radius, passes) {
  let current = labels;
  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Uint8Array(current.length);
    const votes = new Uint32Array(256);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!region[index]) {
          continue;
        }
        const seen = [];
        for (let dy = -radius; dy <= radius; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) {
            continue;
          }
          for (let dx = -radius; dx <= radius; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) {
              continue;
            }
            const label = current[yy * width + xx];
            if (label) {
              if (votes[label] === 0) {
                seen.push(label);
              }
              votes[label] += 1;
            }
          }
        }
        let best = current[index];
        let bestVotes = best ? votes[best] : 0;
        for (let s = 0; s < seen.length; s += 1) {
          if (votes[seen[s]] > bestVotes) {
            bestVotes = votes[seen[s]];
            best = seen[s];
          }
        }
        next[index] = best;
        for (let s = 0; s < seen.length; s += 1) {
          votes[seen[s]] = 0;
        }
      }
    }
    current = next;
  }
  return current;
}

// Gives every region pixel that has no label yet the label of the nearest labelled pixel (multi-source BFS, 4-neighbour).
function fillUnlabelled(labels, region, width, height) {
  const queue = [];
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i]) {
      queue.push(i);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const index = queue[head++];
    const x = index % width;
    const y = (index - x) / width;
    const label = labels[index];
    const around = [
      x > 0 ? index - 1 : -1,
      x < width - 1 ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y < height - 1 ? index + width : -1,
    ];
    for (let k = 0; k < 4; k += 1) {
      const next = around[k];
      if (next >= 0 && region[next] && !labels[next]) {
        labels[next] = label;
        queue.push(next);
      }
    }
  }
}

// One wall region -> a split proposal, or null. input: the fitRegions() fields (width, height, depth, intrinsics).
function splitRegion(region, input, samInstances, options) {
  const opts = options || {};
  const minAngle = opts.minAngleDeg || 20;
  const total = input.width * input.height;
  const regionPixels = pixelCount(region.mask);
  if (regionPixels < total * MIN_REGION_SHARE) {
    return null;
  }
  // Erode first: depth next to a silhouette is the least trustworthy, and a seed is only a seed.
  const core = fusion.erodeMask(region.mask, input.width, input.height, 3);
  const valid = validDepthMask(core, input.depth);
  const validTotal = pixelCount(valid);
  if (validTotal < MIN_SEED_PIXELS * 2) {
    return null;
  }

  let seeds = samSeeds(valid, samInstances || []).filter(function (seed) {
    return seed.count >= Math.max(MIN_SEED_PIXELS, SEED_SHARE * validTotal);
  });
  let source = "sam";
  if (seeds.length < 2) {
    seeds = ransacSeeds(valid, input, validTotal);
    source = "ransac";
  }
  if (seeds.length < 2) {
    return null;
  }
  const clusters = clusterSeeds(seeds, input);
  if (clusters.length < 2) {
    return null;
  }

  // Closest plane in 3D for every pixel of the region.
  const labels = new Uint8Array(total);
  const { fx, fy, cx, cy } = input.intrinsics;
  for (let i = 0; i < total; i += 1) {
    if (!region.mask[i] || !(input.depth[i] > 0)) {
      continue;
    }
    const x = i % input.width;
    const y = (i - x) / input.width;
    const d = input.depth[i];
    const px = ((x + 0.5 - cx) * d) / fx;
    const py = ((y + 0.5 - cy) * d) / fy;
    let best = 0;
    let bestDistance = Infinity;
    for (let c = 0; c < clusters.length; c += 1) {
      const n = clusters[c].plane.normal;
      const o = clusters[c].plane.origin;
      const distance = Math.abs((px - o[0]) * n[0] + (py - o[1]) * n[1] + (d - o[2]) * n[2]);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = c + 1;
      }
    }
    labels[i] = best;
  }
  fillUnlabelled(labels, region.mask, input.width, input.height);
  let parts = smoothLabels(labels, region.mask, input.width, input.height, SMOOTH_RADIUS, SMOOTH_PASSES);

  // Absorb slivers: relabel a too-small part with the labels around it.
  const counts = new Array(clusters.length + 1).fill(0);
  for (let i = 0; i < parts.length; i += 1) {
    counts[parts[i]] += 1;
  }
  const keep = [];
  for (let c = 1; c <= clusters.length; c += 1) {
    if (counts[c] >= Math.max(MIN_PART_PIXELS, MIN_PART_SHARE * regionPixels)) {
      keep.push(c);
    }
  }
  if (keep.length < 2) {
    return null;
  }
  if (keep.length < clusters.length) {
    const survivors = new Uint8Array(parts.length);
    for (let i = 0; i < parts.length; i += 1) {
      survivors[i] = keep.indexOf(parts[i]) !== -1 ? parts[i] : 0;
    }
    fillUnlabelled(survivors, region.mask, input.width, input.height);
    parts = survivors;
  }

  // Final planes, on the eroded part, must be flat and must disagree about orientation.
  const finals = keep.map(function (label) {
    const mask = new Uint8Array(total);
    for (let i = 0; i < total; i += 1) {
      mask[i] = parts[i] === label ? 1 : 0;
    }
    const eroded = fusion.erodeMask(mask, input.width, input.height, 2);
    const fit = fitMaskPlane(eroded, input, label + 100);
    let sumX = 0;
    let count = 0;
    for (let i = 0; i < total; i += 1) {
      if (mask[i]) {
        sumX += i % input.width;
        count += 1;
      }
    }
    return { label: label, fit: fit.fit, area: count, centroidX: count ? sumX / count : 0 };
  });
  if (finals.some(function (entry) { return entry.fit.inlierRatio < MIN_INLIER_RATIO; })) {
    return null;
  }
  let widest = 0;
  for (let i = 0; i < finals.length; i += 1) {
    for (let j = i + 1; j < finals.length; j += 1) {
      widest = Math.max(widest, angleDeg(finals[i].fit.normal, finals[j].fit.normal));
    }
  }
  if (widest < minAngle) {
    return null;
  }

  // Parts are numbered left to right, so "left wall" / "right wall" names stay true to the photo.
  finals.sort(function (a, b) {
    return a.centroidX - b.centroidX;
  });
  const renumber = new Uint8Array(clusters.length + 1);
  finals.forEach(function (entry, index) {
    renumber[entry.label] = index + 1;
  });
  const map = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    map[i] = parts[i] ? renumber[parts[i]] : 0;
  }
  return {
    regionId: region.id,
    partMap: map,
    parts: finals.map(function (entry, index) {
      return {
        index: index + 1,
        area: entry.area,
        normal: entry.fit.normal,
        origin: entry.fit.origin,
        inlierRatio: entry.fit.inlierRatio,
      };
    }),
    angleDeg: widest,
    source: source,
  };
}

// input: { width, height, depth, intrinsics, regions: [{id, kind, mask}], sam: [{id, kind, score, mask}] | null }
// -> proposals for the wall regions that are several planes.
function proposeWallSplits(input, options) {
  const walls = (input.regions || []).filter(function (region) {
    return region.kind === "wall";
  });
  const samWalls = (input.sam || []).filter(function (instance) {
    return instance.kind === "wall";
  });
  const out = [];
  walls.forEach(function (region) {
    const proposal = splitRegion(region, input, samWalls, options);
    if (proposal) {
      out.push(proposal);
    }
  });
  return out;
}

module.exports = {
  proposeWallSplits: proposeWallSplits,
  splitRegion: splitRegion,
  smoothLabels: smoothLabels,
  fillUnlabelled: fillUnlabelled,
};
