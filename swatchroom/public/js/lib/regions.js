// The surface map ("scan") of a photo.
// A scan is { width, height, labelMap: Uint16Array, regions: [...], byIndex: [], nextIndex }.
// labelMap holds a region index per pixel (0 = nothing). Each region carries its own pixel mask,
// bounding box, centroid, an anchor point well inside it, its share of the frame and a colour.

export const KINDS = [
  "wall",
  "floor",
  "ceiling",
  "window",
  "door",
  "furniture",
  "other",
];

export const KIND_INFO = {
  wall: { singular: "Wall", plural: "Walls", color: [122, 172, 230] },
  floor: { singular: "Floor", plural: "Floor", color: [240, 182, 90] },
  ceiling: { singular: "Ceiling", plural: "Ceiling", color: [185, 162, 240] },
  window: { singular: "Window", plural: "Windows", color: [104, 212, 194] },
  door: { singular: "Door", plural: "Doors", color: [242, 141, 178] },
  furniture: {
    singular: "Furniture",
    plural: "Furniture and built-ins",
    color: [150, 212, 120],
  },
  other: { singular: "Other", plural: "Other", color: [206, 188, 170] },
};

// Detections smaller than this share of the frame are dropped; regions that end up smaller
// than KEEP_SHARE after layering are dropped too.
const MIN_SHARE = 0.002;
const KEEP_SHARE = 0.0025;
// Furniture and decor below this share are tucked into "Small items" in the list.
export const SMALL_SHARE = 0.006;

function randomId(index) {
  return "r" + index + "-" + Math.random().toString(36).slice(2, 7);
}

// Work out a surface kind from a model's kind or label.
export function normaliseKind(kind, label) {
  const clean = String(kind || "")
    .toLowerCase()
    .trim();
  if (KINDS.indexOf(clean) !== -1) {
    return clean;
  }
  const text = (clean + " " + String(label || "")).toLowerCase();
  if (/\b(window|curtain|blind|drape|glazing|skylight)/.test(text)) {
    return "window";
  }
  if (/\b(door|doorway|entrance|gate)\b/.test(text)) {
    return "door";
  }
  if (/\bceiling\b/.test(text)) {
    return "ceiling";
  }
  if (
    /\b(sofa|couch|chair|table|bed|cabinet|wardrobe|shelf|shelves|counter|desk|tv|television|lamp|rug|carpet runner|stool|bench|dresser|console|ottoman|bookcase|kitchen|island|vanity|mirror|plant|artwork|painting|frame)/.test(
      text,
    )
  ) {
    return "furniture";
  }
  if (/\b(floor|flooring|ground)\b/.test(text)) {
    return "floor";
  }
  if (/\b(wall|partition|backsplash|column|pillar)\b/.test(text)) {
    return "wall";
  }
  return "other";
}

// "wall: back wall" -> "Back wall"; empty -> the kind's name.
export function cleanLabel(label, kind) {
  let text = String(label || "").trim();
  const prefixed = text.match(/^([a-z]+)\s*[:\-]\s*(.*)$/i);
  if (prefixed && KINDS.indexOf(prefixed[1].toLowerCase()) !== -1) {
    text = prefixed[2].trim();
  }
  if (text === "") {
    text = KIND_INFO[kind].singular;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The kind written as a "kind:" prefix in a label, or ''.
export function kindFromPrefix(label) {
  const match = String(label || "")
    .trim()
    .match(/^([a-z]+)\s*[:\-]/i);
  if (match && KINDS.indexOf(match[1].toLowerCase()) !== -1) {
    return match[1].toLowerCase();
  }
  return "";
}

function tint(color, step) {
  if (step === 0) {
    return color.slice();
  }
  const amounts = [0, -0.22, 0.2, -0.36, 0.34, -0.12, 0.12];
  const amount = amounts[step % amounts.length];
  return color.map(function (channel) {
    return Math.round(
      amount < 0 ? channel * (1 + amount) : channel + (255 - channel) * amount,
    );
  });
}

// Give regions of the same kind distinguishable shades of the kind colour, biggest first.
export function colourRegions(regions) {
  const seen = {};
  regions
    .slice()
    .sort(function (a, b) {
      return b.count - a.count;
    })
    .forEach(function (region) {
      const step = seen[region.kind] || 0;
      seen[region.kind] = step + 1;
      region.color = tint(KIND_INFO[region.kind].color, step);
    });
}

// "Sofa", "Sofa" -> "Sofa 1", "Sofa 2".
export function numberDuplicateLabels(regions) {
  const totals = {};
  regions.forEach(function (region) {
    const key = region.label.toLowerCase();
    totals[key] = (totals[key] || 0) + 1;
  });
  const used = {};
  regions.forEach(function (region) {
    const key = region.label.toLowerCase();
    if (totals[key] > 1) {
      used[key] = (used[key] || 0) + 1;
      region.label = region.label + " " + used[key];
    }
  });
}

// A point well inside the region (the deepest pixel of a coarse distance transform), used to
// place labels and cards.
function anchorPoint(region, width, height) {
  const scale = Math.min(1, 128 / Math.max(width, height));
  const gridWidth = Math.max(2, Math.round(width * scale));
  const gridHeight = Math.max(2, Math.round(height * scale));
  const distance = new Float32Array(gridWidth * gridHeight);
  for (let gy = 0; gy < gridHeight; gy += 1) {
    const y = Math.min(height - 1, Math.floor((gy + 0.5) / scale));
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x = Math.min(width - 1, Math.floor((gx + 0.5) / scale));
      distance[gy * gridWidth + gx] = region.mask[y * width + x] ? 1e6 : 0;
    }
  }
  function at(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= gridWidth || gy >= gridHeight) {
      return 0;
    }
    return distance[gy * gridWidth + gx];
  }
  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const index = gy * gridWidth + gx;
      if (distance[index] !== 0) {
        distance[index] = Math.min(
          distance[index],
          at(gx - 1, gy) + 3,
          at(gx, gy - 1) + 3,
          at(gx - 1, gy - 1) + 4,
          at(gx + 1, gy - 1) + 4,
        );
      }
    }
  }
  let best = -1;
  let anchorX = region.centroid.x;
  let anchorY = region.centroid.y;
  for (let gy = gridHeight - 1; gy >= 0; gy -= 1) {
    for (let gx = gridWidth - 1; gx >= 0; gx -= 1) {
      const index = gy * gridWidth + gx;
      if (distance[index] !== 0) {
        distance[index] = Math.min(
          distance[index],
          at(gx + 1, gy) + 3,
          at(gx, gy + 1) + 3,
          at(gx + 1, gy + 1) + 4,
          at(gx - 1, gy + 1) + 4,
        );
        if (distance[index] > best) {
          best = distance[index];
          anchorX = (gx + 0.5) / scale;
          anchorY = (gy + 0.5) / scale;
        }
      }
    }
  }
  return { x: anchorX, y: anchorY };
}

// Build full region objects (mask, bbox, centroid, anchor, share) from metas + a label map.
// Regions with no pixels are dropped.
export function buildRegions(metas, labelMap, width, height) {
  const byIndex = [];
  metas.forEach(function (meta) {
    meta.mask = new Uint8Array(width * height);
    meta.count = 0;
    meta.minX = width;
    meta.minY = height;
    meta.maxX = -1;
    meta.maxY = -1;
    meta.sumX = 0;
    meta.sumY = 0;
    byIndex[meta.index] = meta;
  });
  for (let pixel = 0; pixel < labelMap.length; pixel += 1) {
    const index = labelMap[pixel];
    if (index === 0) {
      continue;
    }
    const region = byIndex[index];
    if (!region) {
      continue;
    }
    const x = pixel % width;
    const y = (pixel - x) / width;
    region.mask[pixel] = 1;
    region.count += 1;
    region.sumX += x;
    region.sumY += y;
    if (x < region.minX) {
      region.minX = x;
    }
    if (x > region.maxX) {
      region.maxX = x;
    }
    if (y < region.minY) {
      region.minY = y;
    }
    if (y > region.maxY) {
      region.maxY = y;
    }
  }
  const total = width * height;
  const regions = [];
  metas.forEach(function (region) {
    if (region.count === 0) {
      byIndex[region.index] = undefined;
      return;
    }
    region.areaShare = region.count / total;
    region.bbox = {
      x0: region.minX,
      y0: region.minY,
      x1: region.maxX + 1,
      y1: region.maxY + 1,
    };
    region.centroid = {
      x: region.sumX / region.count,
      y: region.sumY / region.count,
    };
    region.anchor = anchorPoint(region, width, height);
    regions.push(region);
  });
  return { regions: regions, byIndex: byIndex };
}

function metaOf(region) {
  return {
    id: region.id,
    index: region.index,
    label: region.label,
    kind: region.kind,
    source: region.source,
    color: region.color,
  };
}

// A scan from a label map and its metas (in-browser scene parsing).
export function scanFromLabelMap(labelMap, metas, width, height) {
  let highest = 0;
  const built = buildRegions(
    metas.map(function (meta) {
      if (meta.index > highest) {
        highest = meta.index;
      }
      return {
        id: randomId(meta.index),
        index: meta.index,
        label: meta.label,
        kind: meta.kind,
        source: meta.source,
      };
    }),
    labelMap,
    width,
    height,
  );
  numberDuplicateLabels(built.regions);
  colourRegions(built.regions);
  return {
    width: width,
    height: height,
    labelMap: labelMap,
    regions: built.regions,
    byIndex: built.byIndex,
    nextIndex: highest + 1,
  };
}

// A scan from separate detections ({label, kind, mask, count, source}), largest first so that
// smaller objects are layered on top of walls and floors.
export function scanFromMasks(detections, width, height) {
  const total = width * height;
  const usable = detections
    .filter(function (detection) {
      return detection && detection.count >= total * MIN_SHARE;
    })
    .sort(function (a, b) {
      return b.count - a.count;
    });
  let labelMap = new Uint16Array(total);
  usable.forEach(function (detection, position) {
    for (let pixel = 0; pixel < total; pixel += 1) {
      if (detection.mask[pixel]) {
        labelMap[pixel] = position + 1;
      }
    }
  });
  const visible = new Array(usable.length + 1).fill(0);
  for (let pixel = 0; pixel < total; pixel += 1) {
    visible[labelMap[pixel]] += 1;
  }
  const kept = usable.filter(function (detection, position) {
    return visible[position + 1] >= total * KEEP_SHARE;
  });
  labelMap = new Uint16Array(total);
  const metas = [];
  kept.forEach(function (detection, position) {
    const index = position + 1;
    for (let pixel = 0; pixel < total; pixel += 1) {
      if (detection.mask[pixel]) {
        labelMap[pixel] = index;
      }
    }
    metas.push({
      id: randomId(index),
      index: index,
      label: detection.label,
      kind: detection.kind,
      source: detection.source,
    });
  });
  const built = buildRegions(metas, labelMap, width, height);
  numberDuplicateLabels(built.regions);
  colourRegions(built.regions);
  return {
    width: width,
    height: height,
    labelMap: labelMap,
    regions: built.regions,
    byIndex: built.byIndex,
    nextIndex: kept.length + 1,
  };
}

export function emptyScan(width, height) {
  return scanFromMasks([], width, height);
}

// Rebuild a scan after its label map changed, keeping ids, labels, kinds and colours.
function withLabelMap(scan, labelMap) {
  const built = buildRegions(
    scan.regions.map(metaOf),
    labelMap,
    scan.width,
    scan.height,
  );
  built.regions.forEach(function (region) {
    if (!region.color) {
      region.color = [200, 200, 200];
    }
  });
  return Object.assign({}, scan, {
    labelMap: labelMap,
    regions: built.regions,
    byIndex: built.byIndex,
  });
}

// Brush: add pixels to a region, erase them from it, or replace it with exactly these pixels.
export function paintRegion(scan, regionId, pixels, mode) {
  const region = scan.regions.find(function (candidate) {
    return candidate.id === regionId;
  });
  if (!region) {
    return scan;
  }
  const labelMap = new Uint16Array(scan.labelMap);
  for (let pixel = 0; pixel < labelMap.length; pixel += 1) {
    if (
      mode === "replace" &&
      labelMap[pixel] === region.index &&
      !pixels[pixel]
    ) {
      labelMap[pixel] = 0;
    }
    if (pixels[pixel]) {
      if (mode === "erase") {
        if (labelMap[pixel] === region.index) {
          labelMap[pixel] = 0;
        }
      } else {
        labelMap[pixel] = region.index;
      }
    }
  }
  return withLabelMap(scan, labelMap);
}

// Add a new region from a pixel mask. Its kind is borrowed from whatever it mostly covered.
// Returns { scan, regionId } or null when the mask is tiny.
export function addRegionFromMask(scan, pixels, label) {
  let covered = 0;
  const votes = {};
  for (let pixel = 0; pixel < pixels.length; pixel += 1) {
    if (!pixels[pixel]) {
      continue;
    }
    covered += 1;
    const under = scan.labelMap[pixel];
    votes[under] = (votes[under] || 0) + 1;
  }
  if (covered < 16) {
    return null;
  }
  let winner = 0;
  let winnerVotes = 0;
  Object.keys(votes).forEach(function (key) {
    if (votes[key] > winnerVotes) {
      winnerVotes = votes[key];
      winner = Number(key);
    }
  });
  const underneath = winner ? scan.byIndex[winner] : null;
  const labelMap = new Uint16Array(scan.labelMap);
  const index = scan.nextIndex;
  for (let pixel = 0; pixel < labelMap.length; pixel += 1) {
    if (pixels[pixel]) {
      labelMap[pixel] = index;
    }
  }
  const metas = scan.regions.map(metaOf);
  const meta = {
    id: randomId(index),
    index: index,
    label: label,
    kind: underneath ? underneath.kind : "other",
    source: "custom",
  };
  metas.push(meta);
  const built = buildRegions(metas, labelMap, scan.width, scan.height);
  colourRegions(built.regions);
  return {
    scan: Object.assign({}, scan, {
      labelMap: labelMap,
      regions: built.regions,
      byIndex: built.byIndex,
      nextIndex: index + 1,
    }),
    regionId: meta.id,
  };
}

// Fill a polygon into a pixel mask. Points are [a, b] pairs in 0-1000 units; order says
// whether a is x ('xy') or y ('yx').
export function polygonMask(points, width, height, order) {
  const mask = new Uint8Array(width * height);
  if (!Array.isArray(points) || points.length < 3) {
    return { mask: mask, count: 0 };
  }
  const xs = [];
  const ys = [];
  points.forEach(function (point) {
    if (!Array.isArray(point) || point.length < 2) {
      return;
    }
    const first = Math.min(1000, Math.max(0, Number(point[0]) || 0));
    const second = Math.min(1000, Math.max(0, Number(point[1]) || 0));
    xs.push(((order === "xy" ? first : second) / 1000) * width);
    ys.push(((order === "xy" ? second : first) / 1000) * height);
  });
  const corners = xs.length;
  if (corners < 3) {
    return { mask: mask, count: 0 };
  }
  let count = 0;
  const crossings = [];
  for (let y = 0; y < height; y += 1) {
    const lineY = y + 0.5;
    crossings.length = 0;
    for (
      let current = 0, previous = corners - 1;
      current < corners;
      previous = current, current += 1
    ) {
      const y1 = ys[previous];
      const y2 = ys[current];
      if ((y1 <= lineY && y2 > lineY) || (y2 <= lineY && y1 > lineY)) {
        crossings.push(
          xs[previous] +
            ((lineY - y1) / (y2 - y1)) * (xs[current] - xs[previous]),
        );
      }
    }
    crossings.sort(function (a, b) {
      return a - b;
    });
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const start = Math.max(0, Math.ceil(crossings[pair] - 0.5));
      const end = Math.min(width - 1, Math.floor(crossings[pair + 1] - 0.5));
      for (let x = start; x <= end; x += 1) {
        mask[y * width + x] = 1;
        count += 1;
      }
    }
  }
  return { mask: mask, count: count };
}

// Outline tool: points are [x, y] in 0-1 units.
export function addRegionFromOutline(scan, points, label) {
  const filled = polygonMask(
    points.map(function (point) {
      return [point[0] * 1000, point[1] * 1000];
    }),
    scan.width,
    scan.height,
    "xy",
  );
  if (filled.count < 16) {
    return null;
  }
  return addRegionFromMask(scan, filled.mask, label);
}

export function setRegionKind(scan, regionId, kind) {
  const regions = scan.regions.map(function (region) {
    if (region.id === regionId) {
      return Object.assign({}, region, { kind: kind });
    }
    return region;
  });
  const byIndex = [];
  regions.forEach(function (region) {
    byIndex[region.index] = region;
  });
  colourRegions(regions);
  return Object.assign({}, scan, { regions: regions, byIndex: byIndex });
}

export function renameRegion(scan, regionId, label) {
  const regions = scan.regions.map(function (region) {
    if (region.id === regionId) {
      return Object.assign({}, region, { label: label });
    }
    return region;
  });
  const byIndex = [];
  regions.forEach(function (region) {
    byIndex[region.index] = region;
  });
  return Object.assign({}, scan, { regions: regions, byIndex: byIndex });
}

export function regionAt(scan, x, y) {
  if (!scan || scan.regions.length === 0) {
    return null;
  }
  const px = Math.min(scan.width - 1, Math.max(0, Math.floor(x * scan.width)));
  const py = Math.min(
    scan.height - 1,
    Math.max(0, Math.floor(y * scan.height)),
  );
  const index = scan.labelMap[py * scan.width + px];
  return (index && scan.byIndex[index]) || null;
}

export function isSmallRegion(region) {
  return (
    (region.kind === "furniture" || region.kind === "other") &&
    region.areaShare < SMALL_SHARE
  );
}

// A virtual region covering several regions, used to render one finish on all of them at once.
export function unionRegion(scan, regionIds) {
  const parts = scan.regions.filter(function (region) {
    return regionIds.indexOf(region.id) !== -1;
  });
  if (parts.length === 0) {
    return null;
  }
  if (parts.length === 1) {
    return parts[0];
  }
  const mask = new Uint8Array(scan.width * scan.height);
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  const box = { x0: scan.width, y0: scan.height, x1: 0, y1: 0 };
  parts.forEach(function (part) {
    box.x0 = Math.min(box.x0, part.bbox.x0);
    box.y0 = Math.min(box.y0, part.bbox.y0);
    box.x1 = Math.max(box.x1, part.bbox.x1);
    box.y1 = Math.max(box.y1, part.bbox.y1);
    for (let y = part.bbox.y0; y < part.bbox.y1; y += 1) {
      for (let x = part.bbox.x0; x < part.bbox.x1; x += 1) {
        const pixel = y * scan.width + x;
        if (part.mask[pixel] && !mask[pixel]) {
          mask[pixel] = 1;
          count += 1;
          sumX += x;
          sumY += y;
        }
      }
    }
  });
  // The kind covering the most pixels decides which catalog is shown.
  const areaByKind = {};
  parts.forEach(function (part) {
    areaByKind[part.kind] = (areaByKind[part.kind] || 0) + part.count;
  });
  let kind = parts[0].kind;
  Object.keys(areaByKind).forEach(function (candidate) {
    if (areaByKind[candidate] > areaByKind[kind]) {
      kind = candidate;
    }
  });
  const sameKind = Object.keys(areaByKind).length === 1;
  const allOfKind =
    sameKind &&
    scan.regions.filter(function (region) {
      return region.kind === kind;
    }).length === parts.length;
  const label =
    allOfKind && parts.length > 1
      ? "All " + KIND_INFO[kind].plural.toLowerCase()
      : joinLabels(parts);
  const largest = parts.slice().sort(function (a, b) {
    return b.count - a.count;
  })[0];
  return {
    id:
      "u:" +
      parts
        .map(function (part) {
          return part.id;
        })
        .join("+"),
    isUnion: true,
    partIds: parts.map(function (part) {
      return part.id;
    }),
    index: -1,
    label: label,
    kind: kind,
    mask: mask,
    count: count,
    areaShare: count / (scan.width * scan.height),
    bbox: box,
    centroid: { x: sumX / Math.max(1, count), y: sumY / Math.max(1, count) },
    anchor: largest.anchor,
    color: largest.color,
  };
}

function joinLabels(parts) {
  const names = parts.map(function (part) {
    return part.label;
  });
  if (names.length <= 2) {
    return names.join(" and ");
  }
  return names.slice(0, 2).join(", ") + " and " + (names.length - 2) + " more";
}

// ---------------------------------------------------------------- outline tracing

const NEIGHBOURS = [
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
];

function directionIndex(dx, dy) {
  for (let index = 0; index < NEIGHBOURS.length; index += 1) {
    if (NEIGHBOURS[index][0] === dx && NEIGHBOURS[index][1] === dy) {
      return index;
    }
  }
  return 0;
}

function largestComponent(mask, width, height) {
  const labels = new Int32Array(width * height);
  let bestLabel = 0;
  let bestSize = 0;
  let next = 0;
  const stack = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) {
      continue;
    }
    next += 1;
    let size = 0;
    stack.push(start);
    labels[start] = next;
    while (stack.length > 0) {
      const pixel = stack.pop();
      size += 1;
      const x = pixel % width;
      const y = (pixel - x) / width;
      for (let step = 0; step < 8; step += 1) {
        const nx = x + NEIGHBOURS[step][0];
        const ny = y + NEIGHBOURS[step][1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          continue;
        }
        const neighbour = ny * width + nx;
        if (mask[neighbour] && !labels[neighbour]) {
          labels[neighbour] = next;
          stack.push(neighbour);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = next;
    }
  }
  const out = new Uint8Array(width * height);
  for (let pixel = 0; pixel < out.length; pixel += 1) {
    if (labels[pixel] === bestLabel && bestLabel !== 0) {
      out[pixel] = 1;
    }
  }
  return out;
}

// Moore-neighbour contour trace of the first blob found.
function traceContour(mask, width, height) {
  let first = -1;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (mask[pixel]) {
      first = pixel;
      break;
    }
  }
  if (first === -1) {
    return [];
  }
  const startX = first % width;
  const startY = (first - startX) / width;
  function inside(x, y) {
    return (
      x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1
    );
  }
  const points = [[startX, startY]];
  let x = startX;
  let y = startY;
  let backX = startX - 1;
  let backY = startY;
  const limit = width * height * 4;
  for (let step = 0; step < limit; step += 1) {
    const from = directionIndex(backX - x, backY - y);
    let moved = false;
    for (let turn = 1; turn <= 8; turn += 1) {
      const direction = (from + turn) % 8;
      const nx = x + NEIGHBOURS[direction][0];
      const ny = y + NEIGHBOURS[direction][1];
      if (inside(nx, ny)) {
        const previous = (from + turn - 1) % 8;
        backX = x + NEIGHBOURS[previous][0];
        backY = y + NEIGHBOURS[previous][1];
        x = nx;
        y = ny;
        moved = true;
        break;
      }
    }
    if (
      !moved ||
      (x === startX && y === startY && backX === startX - 1 && backY === startY)
    ) {
      break;
    }
    points.push([x, y]);
  }
  return points;
}

function distanceToSegment(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]);
  }
  return (
    Math.abs(
      dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0],
    ) / length
  );
}

// Ramer-Douglas-Peucker simplification.
function simplify(points, tolerance) {
  if (points.length < 3) {
    return points.slice();
  }
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const ranges = [[0, points.length - 1]];
  while (ranges.length > 0) {
    const range = ranges.pop();
    let farthest = 0;
    let farthestIndex = -1;
    for (let index = range[0] + 1; index < range[1]; index += 1) {
      const distance = distanceToSegment(
        points[index],
        points[range[0]],
        points[range[1]],
      );
      if (distance > farthest) {
        farthest = distance;
        farthestIndex = index;
      }
    }
    if (farthest > tolerance && farthestIndex !== -1) {
      keep[farthestIndex] = 1;
      ranges.push([range[0], farthestIndex]);
      ranges.push([farthestIndex, range[1]]);
    }
  }
  return points.filter(function (point, index) {
    return keep[index] === 1;
  });
}

// Outline of a region as [x, y] points in 0-1000 units (at most maxPoints).
export function traceOutline(region, width, height, maxPoints) {
  const limit = maxPoints || 48;
  const scale = Math.min(1, 220 / Math.max(width, height));
  const gridWidth = Math.max(4, Math.round(width * scale));
  const gridHeight = Math.max(4, Math.round(height * scale));
  const grid = new Uint8Array(gridWidth * gridHeight);
  for (let gy = 0; gy < gridHeight; gy += 1) {
    const y = Math.min(height - 1, Math.floor((gy + 0.5) / scale));
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x = Math.min(width - 1, Math.floor((gx + 0.5) / scale));
      grid[gy * gridWidth + gx] = region.mask[y * width + x];
    }
  }
  const contour = traceContour(
    largestComponent(grid, gridWidth, gridHeight),
    gridWidth,
    gridHeight,
  );
  if (contour.length < 3) {
    return [];
  }
  let tolerance = 1.2;
  let simple = simplify(contour, tolerance);
  while (simple.length > limit && tolerance < 40) {
    tolerance *= 1.4;
    simple = simplify(contour, tolerance);
  }
  return simple.map(function (point) {
    return [
      Math.round(((point[0] + 0.5) / gridWidth) * 1000),
      Math.round(((point[1] + 0.5) / gridHeight) * 1000),
    ];
  });
}

// Bounding box of a region in 0-1000 units.
export function regionBox(region, width, height) {
  return {
    ymin: Math.round((region.bbox.y0 / height) * 1000),
    xmin: Math.round((region.bbox.x0 / width) * 1000),
    ymax: Math.round((region.bbox.y1 / height) * 1000),
    xmax: Math.round((region.bbox.x1 / width) * 1000),
  };
}

// Use Gemini outline names for SAM / scene regions they overlap well (IoU >= 0.3, same kind).
export function applyOutlineNames(scan, outlines) {
  const total = scan.width * scan.height;
  const sizes = new Int32Array(scan.nextIndex + 1);
  for (let pixel = 0; pixel < total; pixel += 1) {
    sizes[scan.labelMap[pixel]] += 1;
  }
  const matches = [];
  outlines.forEach(function (outline, entryIndex) {
    if (!outline || typeof outline !== "object") {
      return;
    }
    const filled = polygonMask(
      outline.polygon || outline.points,
      scan.width,
      scan.height,
      "yx",
    );
    if (filled.count < total * 0.002) {
      return;
    }
    const kind = normaliseKind(
      outline.kind || kindFromPrefix(outline.label),
      outline.label,
    );
    const overlap = new Int32Array(scan.nextIndex + 1);
    for (let pixel = 0; pixel < total; pixel += 1) {
      if (filled.mask[pixel]) {
        overlap[scan.labelMap[pixel]] += 1;
      }
    }
    scan.regions.forEach(function (region) {
      if (region.kind !== kind) {
        return;
      }
      const union = filled.count + sizes[region.index] - overlap[region.index];
      const iou = union > 0 ? overlap[region.index] / union : 0;
      if (iou >= 0.3) {
        matches.push({
          region: region,
          entryIndex: entryIndex,
          iou: iou,
          label: cleanLabel(outline.label, kind),
        });
      }
    });
  });
  matches.sort(function (a, b) {
    return b.iou - a.iou;
  });
  const usedEntries = {};
  const usedRegions = {};
  matches.forEach(function (match) {
    if (usedEntries[match.entryIndex] || usedRegions[match.region.id]) {
      return;
    }
    usedEntries[match.entryIndex] = true;
    usedRegions[match.region.id] = true;
    match.region.label = match.label;
  });
  numberDuplicateLabels(scan.regions);
}

// After a rescan, products point at region ids that no longer exist. Re-attach each product
// to the new region that best covers its saved mask.
export function reattachProducts(products, scan) {
  const next = {};
  let changed = false;
  Object.keys(products).forEach(function (key) {
    const product = products[key];
    const ids = product.regionIds || [product.regionId];
    const stillThere = ids.every(function (id) {
      return scan.regions.some(function (region) {
        return region.id === id;
      });
    });
    if (stillThere) {
      next[key] = product;
      return;
    }
    const votes = new Int32Array(scan.nextIndex + 1);
    for (let pixel = 0; pixel < scan.width * scan.height; pixel += 1) {
      const x = pixel % scan.width;
      const y = (pixel - x) / scan.width;
      const mx = Math.min(
        product.maskW - 1,
        Math.floor((x / scan.width) * product.maskW),
      );
      const my = Math.min(
        product.maskH - 1,
        Math.floor((y / scan.height) * product.maskH),
      );
      if (product.regionMask[my * product.maskW + mx]) {
        votes[scan.labelMap[pixel]] += 1;
      }
    }
    let best = 0;
    for (let index = 1; index < votes.length; index += 1) {
      if (votes[index] > votes[best]) {
        best = index;
      }
    }
    const region = best ? scan.byIndex[best] : null;
    next[key] = Object.assign({}, product, {
      regionId: region ? region.id : null,
      regionIds: region ? [region.id] : [],
    });
    changed = true;
  });
  return changed ? next : products;
}

// Compact form for saving in IndexedDB (masks are rebuilt from the label map on load).
export function serialiseScan(scan) {
  return {
    width: scan.width,
    height: scan.height,
    nextIndex: scan.nextIndex,
    labelMap: scan.labelMap,
    metas: scan.regions.map(metaOf),
    engine: scan.engine || "",
    model: scan.model || "",
  };
}

export function deserialiseScan(saved) {
  const labelMap =
    saved.labelMap instanceof Uint16Array
      ? saved.labelMap
      : new Uint16Array(saved.labelMap);
  const built = buildRegions(
    saved.metas.map(function (meta) {
      return Object.assign({}, meta);
    }),
    labelMap,
    saved.width,
    saved.height,
  );
  built.regions.forEach(function (region) {
    if (!region.color) {
      region.color = KIND_INFO[region.kind]
        ? KIND_INFO[region.kind].color.slice()
        : [200, 200, 200];
    }
  });
  return {
    width: saved.width,
    height: saved.height,
    labelMap: labelMap,
    regions: built.regions,
    byIndex: built.byIndex,
    nextIndex: saved.nextIndex,
    engine: saved.engine,
    model: saved.model,
  };
}
