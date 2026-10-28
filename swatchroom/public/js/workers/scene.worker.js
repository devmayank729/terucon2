// Scene worker: turns the class map from the model service into surfaces, off the main
// thread so the page stays responsive.
//   - classes are grouped (wall, floor, window, sofa...)
//   - edges are snapped to the photo with a guided filter (like tracing along a ruler)
//   - walls are split into planes using Gemini's outlines, which also name the surfaces
//   - specks are cleaned up
//
// Message in:  { id, width, height, classMap (Uint8Array buffer), classLabels, rgba, gemini, instanceMap? }
// Message out: { type: "result", id, result: { labelMap, metas } } or { type: "error", id, message }

// ------------------------------------------------------------------ ADE20K class groups

const WALL_CLASSES = ["wall", "column", "pillar", "partition", "screen"];
const FLOOR_CLASSES = ["floor", "flooring", "step", "stage"];
const CEILING_CLASSES = ["ceiling"];
const WINDOW_CLASSES = ["windowpane", "window", "skylight", "glass"];
// Outdoor things seen through a window count as window.
const OUTSIDE_CLASSES =
  "sky.tree.building.mountain.grass.sea.field.road.sidewalk.house.skyscraper.hill.palm.water.river.land.earth.sand.rock.fence.car.path.bridge.tower.streetlight.awning".split(
    ".",
  );
const CURTAIN_CLASSES = ["curtain", "blind", "shutter", "screen door"];
const DOOR_CLASSES = ["door", "double door", "gate"];
const FURNITURE_CLASSES =
  "bed.cabinet.sofa.table.chair.armchair.seat.desk.wardrobe.chest of drawers.counter.countertop.kitchen island.bookcase.shelf.coffee table.ottoman.stool.bench.swivel chair.television receiver.crt screen.monitor.screen.stove.refrigerator.sink.bathtub.toilet.shower.fireplace.buffet.cradle.rug.pool table.piano.case.dishwasher.oven.microwave.hood.washer.bar.booth.stairs.stairway.railing.bannister".split(
    ".",
  );
const FRIENDLY_NAMES = {
  "chest of drawers": "Chest of drawers",
  counter: "Kitchen counter",
  countertop: "Countertop",
  "kitchen island": "Kitchen island",
  "television receiver": "Television",
  "crt screen": "Screen",
  windowpane: "Window",
  "coffee table": "Coffee table",
  "swivel chair": "Chair",
  stove: "Cooktop",
  hood: "Chimney hood",
  rug: "Rug",
  curtain: "Curtains",
  blind: "Blinds",
  painting: "Artwork",
  light: "Light fitting",
  lamp: "Lamp",
  "double door": "Door",
};
const KINDS = {
  wall: "wall",
  floor: "floor",
  ceiling: "ceiling",
  window: "window",
  door: "door",
  furniture: "furniture",
  other: "other",
};

function lower(text) {
  return String(text || "")
    .trim()
    .toLowerCase();
}

function capitalise(text) {
  const clean = String(text || "").trim();
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

// How an ADE class becomes a surface group. split: merge (one region), walls (plane split),
// instances (one region per connected blob).
function groupForClass(className) {
  const name = lower(className);
  if (WALL_CLASSES.indexOf(name) !== -1) {
    return { key: "wall", kind: "wall", name: "Walls", split: "walls" };
  }
  if (FLOOR_CLASSES.indexOf(name) !== -1) {
    return { key: "floor", kind: "floor", name: "Floor", split: "merge" };
  }
  if (CEILING_CLASSES.indexOf(name) !== -1) {
    return { key: "ceiling", kind: "ceiling", name: "Ceiling", split: "merge" };
  }
  if (
    WINDOW_CLASSES.indexOf(name) !== -1 ||
    OUTSIDE_CLASSES.indexOf(name) !== -1
  ) {
    return {
      key: "window",
      kind: "window",
      name: "Window",
      split: "instances",
    };
  }
  if (CURTAIN_CLASSES.indexOf(name) !== -1) {
    return {
      key: "curtain:" + name,
      kind: "window",
      name: FRIENDLY_NAMES[name] || capitalise(name),
      split: "instances",
    };
  }
  if (DOOR_CLASSES.indexOf(name) !== -1) {
    return { key: "door", kind: "door", name: "Door", split: "instances" };
  }
  if (FURNITURE_CLASSES.indexOf(name) !== -1) {
    return {
      key: "f:" + name,
      kind: "furniture",
      name: FRIENDLY_NAMES[name] || capitalise(name),
      split: "instances",
    };
  }
  return {
    key: "o:" + name,
    kind: "other",
    name: FRIENDLY_NAMES[name] || capitalise(name),
    split: "instances",
  };
}

// ------------------------------------------------------------------ image maths

// Separable box filter of radius r (in place into out, using temp).
function boxFilter(source, width, height, radius, out, temp) {
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    let count = 0;
    for (let x = 0; x <= radius && x < width; x += 1) {
      sum += source[row + x];
      count += 1;
    }
    for (let x = 0; x < width; x += 1) {
      temp[row + x] = sum / count;
      const add = x + radius + 1;
      if (add < width) {
        sum += source[row + add];
        count += 1;
      }
      const remove = x - radius;
      if (remove >= 0) {
        sum -= source[row + remove];
        count -= 1;
      }
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y <= radius && y < height; y += 1) {
      sum += temp[y * width + x];
      count += 1;
    }
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / count;
      const add = y + radius + 1;
      if (add < height) {
        sum += temp[add * width + x];
        count += 1;
      }
      const remove = y - radius;
      if (remove >= 0) {
        sum -= temp[remove * width + x];
        count -= 1;
      }
    }
  }
  return out;
}

// Absorb connected blobs smaller than minSize into their most common neighbour.
// With protectZero, blobs are not absorbed into "nothing" when another neighbour exists.
function removeSpecks(labels, width, height, minSize, protectZero) {
  const total = width * height;
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  const members = new Int32Array(total);
  for (let start = 0; start < total; start += 1) {
    if (seen[start]) {
      continue;
    }
    const value = labels[start];
    let top = 0;
    let size = 0;
    stack[top++] = start;
    seen[start] = 1;
    const neighbours = new Map();
    while (top > 0) {
      const pixel = stack[--top];
      members[size++] = pixel;
      const x = pixel % width;
      const y = (pixel - x) / width;
      const around = [
        x > 0 ? pixel - 1 : -1,
        x < width - 1 ? pixel + 1 : -1,
        y > 0 ? pixel - width : -1,
        y < height - 1 ? pixel + width : -1,
      ];
      for (let step = 0; step < 4; step += 1) {
        const next = around[step];
        if (next < 0) {
          continue;
        }
        const nextValue = labels[next];
        if (nextValue === value) {
          if (!seen[next]) {
            seen[next] = 1;
            stack[top++] = next;
          }
        } else {
          neighbours.set(nextValue, (neighbours.get(nextValue) || 0) + 1);
        }
      }
    }
    if (size < minSize && neighbours.size > 0) {
      let replacement = value;
      let bestCount = -1;
      neighbours.forEach(function (count, neighbour) {
        if (protectZero && neighbour === 0 && neighbours.size > 1) {
          return;
        }
        if (count > bestCount) {
          bestCount = count;
          replacement = neighbour;
        }
      });
      for (let index = 0; index < size; index += 1) {
        labels[members[index]] = replacement;
      }
    }
  }
  return labels;
}

// Guided filter label refinement: for each label, filter its indicator image guided by the
// photo's brightness, then give every pixel to the label with the strongest response.
// Edges snap to real edges in the photo.
function guidedRefine(
  labels,
  labelCount,
  gray,
  width,
  height,
  radius,
  epsilon,
) {
  const total = width * height;
  const minX = new Int32Array(labelCount + 1).fill(width);
  const minY = new Int32Array(labelCount + 1).fill(height);
  const maxX = new Int32Array(labelCount + 1).fill(-1);
  const maxY = new Int32Array(labelCount + 1).fill(-1);
  for (let pixel = 0; pixel < total; pixel += 1) {
    const label = labels[pixel];
    if (!label) {
      continue;
    }
    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x < minX[label]) {
      minX[label] = x;
    }
    if (x > maxX[label]) {
      maxX[label] = x;
    }
    if (y < minY[label]) {
      minY[label] = y;
    }
    if (y > maxY[label]) {
      maxY[label] = y;
    }
  }
  const strongest = new Float32Array(total).fill(-Infinity);
  const result = new Uint16Array(labels);
  const pad = radius * 2 + 2;
  for (let label = 1; label <= labelCount; label += 1) {
    if (maxX[label] < 0) {
      continue;
    }
    const left = Math.max(0, minX[label] - pad);
    const top = Math.max(0, minY[label] - pad);
    const right = Math.min(width, maxX[label] + pad + 1);
    const bottom = Math.min(height, maxY[label] + pad + 1);
    const boxWidth = right - left;
    const boxHeight = bottom - top;
    const size = boxWidth * boxHeight;
    const guide = new Float32Array(size);
    const indicator = new Float32Array(size);
    for (let y = 0; y < boxHeight; y += 1) {
      const sourceRow = (y + top) * width + left;
      for (let x = 0; x < boxWidth; x += 1) {
        guide[y * boxWidth + x] = gray[sourceRow + x];
        indicator[y * boxWidth + x] = labels[sourceRow + x] === label ? 1 : 0;
      }
    }
    const temp = new Float32Array(size);
    const meanGuide = boxFilter(
      guide,
      boxWidth,
      boxHeight,
      radius,
      new Float32Array(size),
      temp,
    );
    const product = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
      product[index] = guide[index] * guide[index];
    }
    const meanGuideSquared = boxFilter(
      product,
      boxWidth,
      boxHeight,
      radius,
      new Float32Array(size),
      temp,
    );
    const meanIndicator = boxFilter(
      indicator,
      boxWidth,
      boxHeight,
      radius,
      new Float32Array(size),
      temp,
    );
    for (let index = 0; index < size; index += 1) {
      product[index] = guide[index] * indicator[index];
    }
    const meanCross = boxFilter(
      product,
      boxWidth,
      boxHeight,
      radius,
      new Float32Array(size),
      temp,
    );
    const slope = new Float32Array(size);
    const offset = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
      const variance =
        meanGuideSquared[index] - meanGuide[index] * meanGuide[index];
      const covariance =
        meanCross[index] - meanGuide[index] * meanIndicator[index];
      slope[index] = covariance / (variance + epsilon);
      offset[index] = meanIndicator[index] - slope[index] * meanGuide[index];
    }
    const meanSlope = boxFilter(
      slope,
      boxWidth,
      boxHeight,
      radius,
      product,
      temp,
    );
    const meanOffset = boxFilter(
      offset,
      boxWidth,
      boxHeight,
      radius,
      meanGuideSquared,
      temp,
    );
    for (let y = 0; y < boxHeight; y += 1) {
      for (let x = 0; x < boxWidth; x += 1) {
        const local = y * boxWidth + x;
        const pixel = (y + top) * width + left + x;
        const response = meanSlope[local] * guide[local] + meanOffset[local];
        if (response > strongest[pixel]) {
          strongest[pixel] = response;
          result[pixel] = label;
        }
      }
    }
  }
  return result;
}

function polygonMask(points, width, height) {
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
    // outlines come as [y, x]
    xs.push((second / 1000) * width);
    ys.push((first / 1000) * height);
  });
  if (xs.length < 3) {
    return { mask: mask, count: 0 };
  }
  let count = 0;
  const crossings = [];
  for (let y = 0; y < height; y += 1) {
    const lineY = y + 0.5;
    crossings.length = 0;
    for (
      let current = 0, previous = xs.length - 1;
      current < xs.length;
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

// 4-connected components of pixels where test(pixel) is true.
function components(test, width, height) {
  const total = width * height;
  const labels = new Int32Array(total);
  const sizes = [0];
  const stack = new Int32Array(total);
  let next = 0;
  for (let start = 0; start < total; start += 1) {
    if (labels[start] || !test(start)) {
      continue;
    }
    next += 1;
    let top = 0;
    let size = 0;
    stack[top++] = start;
    labels[start] = next;
    while (top > 0) {
      const pixel = stack[--top];
      size += 1;
      const x = pixel % width;
      const y = (pixel - x) / width;
      if (x > 0 && !labels[pixel - 1] && test(pixel - 1)) {
        labels[pixel - 1] = next;
        stack[top++] = pixel - 1;
      }
      if (x < width - 1 && !labels[pixel + 1] && test(pixel + 1)) {
        labels[pixel + 1] = next;
        stack[top++] = pixel + 1;
      }
      if (y > 0 && !labels[pixel - width] && test(pixel - width)) {
        labels[pixel - width] = next;
        stack[top++] = pixel - width;
      }
      if (y < height - 1 && !labels[pixel + width] && test(pixel + width)) {
        labels[pixel + width] = next;
        stack[top++] = pixel + width;
      }
    }
    sizes.push(size);
  }
  return { labels: labels, sizes: sizes };
}

// Like components(), but two neighbouring pixels only join when keyOf() gives the same non-zero value for both. Used
// with an instance map (OneFormer's panoptic segment ids): two sofas side by side, or a door next to a window of the
// same class group, stay two regions even though their pixels touch.
function componentsByKey(keyOf, width, height) {
  const total = width * height;
  const labels = new Int32Array(total);
  const sizes = [0];
  const stack = new Int32Array(total);
  let next = 0;
  for (let start = 0; start < total; start += 1) {
    const key = keyOf(start);
    if (labels[start] || !key) {
      continue;
    }
    next += 1;
    let top = 0;
    let size = 0;
    stack[top++] = start;
    labels[start] = next;
    while (top > 0) {
      const pixel = stack[--top];
      size += 1;
      const x = pixel % width;
      const y = (pixel - x) / width;
      if (x > 0 && !labels[pixel - 1] && keyOf(pixel - 1) === key) {
        labels[pixel - 1] = next;
        stack[top++] = pixel - 1;
      }
      if (x < width - 1 && !labels[pixel + 1] && keyOf(pixel + 1) === key) {
        labels[pixel + 1] = next;
        stack[top++] = pixel + 1;
      }
      if (y > 0 && !labels[pixel - width] && keyOf(pixel - width) === key) {
        labels[pixel - width] = next;
        stack[top++] = pixel - width;
      }
      if (y < height - 1 && !labels[pixel + width] && keyOf(pixel + width) === key) {
        labels[pixel + width] = next;
        stack[top++] = pixel + width;
      }
    }
    sizes.push(size);
  }
  return { labels: labels, sizes: sizes };
}

function outlineLabel(outline) {
  let text = String(outline.label || outline.name || "").trim();
  const prefixed = text.match(/^([a-z]+)\s*[:\-]\s*(.*)$/i);
  if (prefixed) {
    text = prefixed[2].trim();
  }
  return capitalise(text);
}

function outlineKind(outline) {
  const kind = lower(outline.kind);
  if (kind) {
    return kind;
  }
  const prefixed = String(outline.label || "").match(/^([a-z]+)\s*:/i);
  return prefixed ? prefixed[1].toLowerCase() : "other";
}

// ------------------------------------------------------------------ scene building

function buildScene(input) {
  const width = input.width;
  const height = input.height;
  const total = width * height;
  const gray = input.gray;
  const options = Object.assign(
    {
      radiusScale: 0.006,
      epsilon: 0.0025,
      speckleShare: 0.0012,
      instanceShare: 0.003,
      wallPlaneShare: 0.01,
    },
    input.options || {},
  );

  // 1. classes -> groups
  const groups = [null];
  const groupByKey = {};
  const groupOfClass = new Uint16Array(input.classLabels.length + 1);
  input.classLabels.forEach(function (className, position) {
    const group = groupForClass(className);
    if (!groupByKey[group.key]) {
      groupByKey[group.key] = groups.length;
      groups.push(group);
    }
    groupOfClass[position + 1] = groupByKey[group.key];
  });
  let grouped = new Uint16Array(total);
  for (let pixel = 0; pixel < total; pixel += 1) {
    grouped[pixel] = groupOfClass[input.classMap[pixel]] || 0;
  }
  const speckSize = Math.max(24, Math.round(total * options.speckleShare));
  removeSpecks(grouped, width, height, speckSize);
  if (gray) {
    const radius = Math.max(
      3,
      Math.round(Math.max(width, height) * options.radiusScale),
    );
    grouped = guidedRefine(
      grouped,
      groups.length - 1,
      gray,
      width,
      height,
      radius,
      options.epsilon,
    );
    removeSpecks(grouped, width, height, speckSize);
  }

  // 2. Gemini outlines (optional) used for wall planes, names and arbitration
  const outlines = [];
  if (Array.isArray(input.gemini)) {
    input.gemini.forEach(function (outline) {
      if (!outline || typeof outline !== "object") {
        return;
      }
      const filled = polygonMask(
        outline.polygon || outline.points,
        width,
        height,
      );
      if (filled.count >= total * 0.002) {
        outlines.push({
          kind: outlineKind(outline),
          label: outlineLabel(outline),
          mask: filled.mask,
          count: filled.count,
        });
      }
    });
  }

  const regionMap = new Uint16Array(total);
  const metas = [];
  function addMeta(label, kind, source) {
    const index = metas.length + 1;
    metas.push({ index: index, label: label, kind: kind, source: source });
    return index;
  }

  // 3. groups -> regions
  for (let groupIndex = 1; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    let groupSize = 0;
    for (let pixel = 0; pixel < total; pixel += 1) {
      if (grouped[pixel] === groupIndex) {
        groupSize += 1;
      }
    }
    if (groupSize === 0) {
      continue;
    }
    if (group.split === "merge") {
      if (groupSize < total * options.instanceShare) {
        continue;
      }
      const index = addMeta(group.name, group.kind, "scene");
      for (let pixel = 0; pixel < total; pixel += 1) {
        if (grouped[pixel] === groupIndex) {
          regionMap[pixel] = index;
        }
      }
      continue;
    }
    if (group.split === "walls") {
      splitWalls(groupIndex);
      continue;
    }
    // One region per object. With an instance map the objects are the model's own instances; without, they are the
    // connected blobs of the class group.
    const blobs = input.instanceMap
      ? componentsByKey(
          function (pixel) {
            return grouped[pixel] === groupIndex ? input.instanceMap[pixel] + 1 : 0;
          },
          width,
          height,
        )
      : components(
          function (pixel) {
            return grouped[pixel] === groupIndex;
          },
          width,
          height,
        );
    const indexOfBlob = {};
    for (let blob = 1; blob < blobs.sizes.length; blob += 1) {
      if (blobs.sizes[blob] >= total * options.instanceShare) {
        indexOfBlob[blob] = addMeta(group.name, group.kind, input.instanceMap ? "scene+instances" : "scene");
      }
    }
    for (let pixel = 0; pixel < total; pixel += 1) {
      const blob = blobs.labels[pixel];
      if (blob && indexOfBlob[blob]) {
        regionMap[pixel] = indexOfBlob[blob];
      }
    }
  }

  // Wall pixels are split into planes using Gemini's wall outlines (each pixel goes to the
  // smallest outline covering it, then planes grow into uncovered wall pixels).
  function splitWalls(groupIndex) {
    const wallOutlines = outlines.filter(function (outline) {
      return outline.kind === "wall";
    });
    if (wallOutlines.length >= 2) {
      const plane = new Int16Array(total).fill(-1);
      const queue = new Int32Array(total);
      let head = 0;
      let tail = 0;
      for (let pixel = 0; pixel < total; pixel += 1) {
        if (grouped[pixel] !== groupIndex) {
          continue;
        }
        let chosen = -1;
        let chosenSize = Infinity;
        for (let outline = 0; outline < wallOutlines.length; outline += 1) {
          if (
            wallOutlines[outline].mask[pixel] &&
            wallOutlines[outline].count < chosenSize
          ) {
            chosen = outline;
            chosenSize = wallOutlines[outline].count;
          }
        }
        if (chosen !== -1) {
          plane[pixel] = chosen;
          queue[tail++] = pixel;
        }
      }
      while (head < tail) {
        const pixel = queue[head++];
        const x = pixel % width;
        const y = (pixel - x) / width;
        const around = [
          x > 0 ? pixel - 1 : -1,
          x < width - 1 ? pixel + 1 : -1,
          y > 0 ? pixel - width : -1,
          y < height - 1 ? pixel + width : -1,
        ];
        for (let step = 0; step < 4; step += 1) {
          const next = around[step];
          if (next < 0 || plane[next] !== -1 || grouped[next] !== groupIndex) {
            continue;
          }
          plane[next] = plane[pixel];
          queue[tail++] = next;
        }
      }
      let planes = new Uint16Array(total);
      for (let pixel = 0; pixel < total; pixel += 1) {
        if (plane[pixel] !== -1) {
          planes[pixel] = plane[pixel] + 1;
        }
      }
      removeSpecks(
        planes,
        width,
        height,
        Math.round(total * options.wallPlaneShare),
        true,
      );
      if (gray) {
        // snap plane borders to the room corners
        const radius = Math.max(4, Math.round(Math.max(width, height) * 0.022));
        const snapped = guidedRefine(
          planes,
          wallOutlines.length,
          gray,
          width,
          height,
          radius,
          options.epsilon,
        );
        for (let pixel = 0; pixel < total; pixel += 1) {
          if (planes[pixel] && snapped[pixel]) {
            planes[pixel] = snapped[pixel];
          }
        }
      }
      const indexOfPlane = {};
      for (let pixel = 0; pixel < total; pixel += 1) {
        const planeNumber = planes[pixel];
        if (planeNumber && grouped[pixel] === groupIndex) {
          if (!indexOfPlane[planeNumber]) {
            indexOfPlane[planeNumber] = addMeta(
              wallOutlines[planeNumber - 1].label || "Wall",
              "wall",
              "scene+gemini",
            );
          }
          regionMap[pixel] = indexOfPlane[planeNumber];
        }
      }
    }
    // wall pixels no outline reached: one region per blob
    const blobs = components(
      function (pixel) {
        return grouped[pixel] === groupIndex && regionMap[pixel] === 0;
      },
      width,
      height,
    );
    const kept = [];
    for (let blob = 1; blob < blobs.sizes.length; blob += 1) {
      if (blobs.sizes[blob] >= total * options.instanceShare) {
        kept.push(blob);
      }
    }
    const indexOfBlob = {};
    kept.forEach(function (blob, position) {
      const name =
        kept.length === 1 && wallOutlines.length < 2
          ? "Walls"
          : "Wall " + (position + 1);
      indexOfBlob[blob] = addMeta(name, "wall", "scene");
    });
    for (let pixel = 0; pixel < total; pixel += 1) {
      const blob = blobs.labels[pixel];
      if (blob && indexOfBlob[blob]) {
        regionMap[pixel] = indexOfBlob[blob];
      }
    }
  }

  // 4. Arbitration: a blob of floor/ceiling/wall that Gemini clearly calls something else
  // (60%+ inside another kind's outline, under 15% inside its own) becomes that thing.
  if (outlines.length > 0) {
    const architectural = { floor: true, ceiling: true, wall: true };
    const metaCount = metas.length;
    for (let metaIndex = 1; metaIndex <= metaCount; metaIndex += 1) {
      const meta = metas[metaIndex - 1];
      if (!architectural[meta.kind]) {
        continue;
      }
      const blobs = components(
        function (pixel) {
          return regionMap[pixel] === metaIndex;
        },
        width,
        height,
      );
      if (blobs.sizes.length <= 2 && meta.kind !== "wall") {
        continue;
      }
      const hits = [];
      for (let blob = 0; blob < blobs.sizes.length; blob += 1) {
        hits.push(new Int32Array(outlines.length));
      }
      for (let pixel = 0; pixel < total; pixel += 1) {
        const blob = blobs.labels[pixel];
        if (blob) {
          for (let outline = 0; outline < outlines.length; outline += 1) {
            if (outlines[outline].mask[pixel]) {
              hits[blob][outline] += 1;
            }
          }
        }
      }
      let biggest = 0;
      for (let blob = 1; blob < blobs.sizes.length; blob += 1) {
        if (blobs.sizes[blob] > blobs.sizes[biggest]) {
          biggest = blob;
        }
      }
      for (let blob = 1; blob < blobs.sizes.length; blob += 1) {
        const size = blobs.sizes[blob];
        if (size < total * options.instanceShare) {
          continue;
        }
        let sameKind = 0;
        let otherOutline = -1;
        let otherHits = 0;
        for (let outline = 0; outline < outlines.length; outline += 1) {
          const count = hits[blob][outline];
          if (outlines[outline].kind === meta.kind) {
            sameKind += count;
          } else if (count > otherHits) {
            otherHits = count;
            otherOutline = outline;
          }
        }
        const isMainBlob = blob === biggest && meta.kind !== "wall";
        if (
          otherOutline !== -1 &&
          !isMainBlob &&
          otherHits >= size * 0.6 &&
          sameKind <= size * 0.15
        ) {
          const winner = outlines[otherOutline];
          const index = addMeta(
            winner.label || capitalise(winner.kind),
            KINDS[winner.kind] || "other",
            "gemini-arbitration",
          );
          for (let pixel = 0; pixel < total; pixel += 1) {
            if (blobs.labels[pixel] === blob) {
              regionMap[pixel] = index;
            }
          }
        }
      }
    }
  }

  // 5. Cabinet undersides read as ceiling: pull furniture outlines out of the ceiling.
  if (outlines.length > 0 && gray) {
    const ceiling = metas.find(function (meta) {
      return meta.kind === "ceiling";
    });
    const ceilingOutlines = outlines.filter(function (outline) {
      return outline.kind === "ceiling";
    });
    if (ceiling) {
      outlines.forEach(function (outline) {
        if (outline.kind !== "furniture" && outline.kind !== "other") {
          return;
        }
        let claimed = 0;
        let ceilingSize = 0;
        const take = new Uint8Array(total);
        for (let pixel = 0; pixel < total; pixel += 1) {
          if (regionMap[pixel] !== ceiling.index) {
            continue;
          }
          ceilingSize += 1;
          if (!outline.mask[pixel]) {
            continue;
          }
          let alsoCeiling = false;
          for (let other = 0; other < ceilingOutlines.length; other += 1) {
            if (ceilingOutlines[other].mask[pixel]) {
              alsoCeiling = true;
              break;
            }
          }
          if (!alsoCeiling) {
            take[pixel] = 1;
            claimed += 1;
          }
        }
        if (claimed < total * 0.005 || claimed < ceilingSize * 0.2) {
          return;
        }
        const index = addMeta(
          outline.label || "Cabinets",
          outline.kind,
          "gemini-arbitration",
        );
        const twoLabel = new Uint16Array(total);
        for (let pixel = 0; pixel < total; pixel += 1) {
          if (regionMap[pixel] === ceiling.index) {
            twoLabel[pixel] = take[pixel] ? 2 : 1;
          }
        }
        const radius = Math.max(
          3,
          Math.round(Math.max(width, height) * options.radiusScale),
        );
        const snapped = guidedRefine(
          twoLabel,
          2,
          gray,
          width,
          height,
          radius,
          options.epsilon,
        );
        for (let pixel = 0; pixel < total; pixel += 1) {
          if (twoLabel[pixel] && snapped[pixel] === 2) {
            regionMap[pixel] = index;
          }
        }
      });
    }
  }

  removeSpecks(
    regionMap,
    width,
    height,
    Math.max(speckSize, Math.round(total * options.instanceShare)),
    true,
  );

  // 6. Names: give each region the label of the outline that overlaps it best (IoU >= 0.3).
  if (outlines.length > 0) {
    const sizes = new Int32Array(metas.length + 1);
    for (let pixel = 0; pixel < total; pixel += 1) {
      sizes[regionMap[pixel]] += 1;
    }
    const overlaps = outlines.map(function (outline) {
      const counts = new Int32Array(metas.length + 1);
      for (let pixel = 0; pixel < total; pixel += 1) {
        if (outline.mask[pixel]) {
          counts[regionMap[pixel]] += 1;
        }
      }
      return counts;
    });
    const matches = [];
    metas.forEach(function (meta) {
      if (meta.kind === "wall" && meta.source === "scene+gemini") {
        return;
      }
      outlines.forEach(function (outline, outlineIndex) {
        const compatible =
          outline.kind === meta.kind ||
          (meta.kind === "other" && outline.kind === "furniture") ||
          (meta.kind === "furniture" && outline.kind === "other");
        if (!compatible || !outline.label) {
          return;
        }
        const shared = overlaps[outlineIndex][meta.index];
        const union = outline.count + sizes[meta.index] - shared;
        const iou = union > 0 ? shared / union : 0;
        if (iou >= 0.3) {
          matches.push({ meta: meta, outlineIndex: outlineIndex, iou: iou });
        }
      });
    });
    matches.sort(function (a, b) {
      return b.iou - a.iou;
    });
    const usedOutline = {};
    const named = {};
    const metaOfOutline = {};
    matches.forEach(function (match) {
      if (usedOutline[match.outlineIndex] || named[match.meta.index]) {
        return;
      }
      usedOutline[match.outlineIndex] = true;
      named[match.meta.index] = true;
      metaOfOutline[match.outlineIndex] = match.meta;
      match.meta.label = outlines[match.outlineIndex].label;
      match.meta.source = match.meta.source + "+gemini";
    });
    // A small unnamed furniture fragment touching a named piece, mostly inside its outline,
    // takes that piece's name (e.g. a sofa arm detected separately).
    const touching = {};
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = y * width + x;
        const here = regionMap[pixel];
        if (!here) {
          continue;
        }
        const right = x + 1 < width ? regionMap[pixel + 1] : 0;
        const below = y + 1 < height ? regionMap[pixel + width] : 0;
        if (right && right !== here) {
          touching[here + ":" + right] = true;
          touching[right + ":" + here] = true;
        }
        if (below && below !== here) {
          touching[here + ":" + below] = true;
          touching[below + ":" + here] = true;
        }
      }
    }
    metas.forEach(function (meta) {
      if (meta.kind !== "furniture" || named[meta.index]) {
        return;
      }
      Object.keys(metaOfOutline).forEach(function (outlineIndex) {
        const owner = metaOfOutline[outlineIndex];
        if (owner.kind !== "furniture" || owner.index === meta.index) {
          return;
        }
        const inside =
          overlaps[outlineIndex][meta.index] / Math.max(1, sizes[meta.index]);
        const muchSmaller = sizes[meta.index] < sizes[owner.index] * 0.35;
        if (
          inside >= 0.8 &&
          muchSmaller &&
          touching[meta.index + ":" + owner.index]
        ) {
          meta.label = owner.label;
          meta.source += "+gemini";
          named[meta.index] = true;
        }
      });
    });
  }

  // 7. Merge touching regions that ended up with the same kind and Gemini name.
  const parent = metas.map(function (meta) {
    return meta.index;
  });
  parent.unshift(0);
  function root(index) {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  }
  function sameName(a, b) {
    return (
      a.kind + "|" + a.label.toLowerCase() ===
      b.kind + "|" + b.label.toLowerCase()
    );
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const here = regionMap[pixel];
      if (!here) {
        continue;
      }
      const others = [
        x + 1 < width ? regionMap[pixel + 1] : 0,
        y + 1 < height ? regionMap[pixel + width] : 0,
      ];
      for (let step = 0; step < 2; step += 1) {
        const other = others[step];
        if (!other || other === here) {
          continue;
        }
        const a = metas[here - 1];
        const b = metas[other - 1];
        const unnamedSceneWall = a.kind === "wall" && a.source === "scene";
        if (
          !unnamedSceneWall &&
          sameName(a, b) &&
          a.source.indexOf("gemini") !== -1 &&
          b.source.indexOf("gemini") !== -1
        ) {
          const rootA = root(here);
          const rootB = root(other);
          if (rootA !== rootB) {
            parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
          }
        }
      }
    }
  }
  let merged = false;
  for (let index = 1; index < parent.length; index += 1) {
    if (root(index) !== index) {
      merged = true;
    }
  }
  if (merged) {
    for (let pixel = 0; pixel < total; pixel += 1) {
      if (regionMap[pixel]) {
        regionMap[pixel] = root(regionMap[pixel]);
      }
    }
  }
  const used = new Uint8Array(metas.length + 1);
  for (let pixel = 0; pixel < total; pixel += 1) {
    used[regionMap[pixel]] = 1;
  }
  return {
    labelMap: regionMap,
    metas: metas.filter(function (meta) {
      return used[meta.index];
    }),
  };
}

function grayFromRgba(rgba, width, height) {
  const gray = new Float32Array(width * height);
  for (
    let pixel = 0, offset = 0;
    pixel < gray.length;
    pixel += 1, offset += 4
  ) {
    gray[pixel] =
      (0.299 * rgba[offset] +
        0.587 * rgba[offset + 1] +
        0.114 * rgba[offset + 2]) /
      255;
  }
  return gray;
}

self.onmessage = function (event) {
  const job = event.data;
  try {
    const gray = job.rgba
      ? grayFromRgba(new Uint8ClampedArray(job.rgba), job.width, job.height)
      : null;
    const result = buildScene({
      width: job.width,
      height: job.height,
      classMap: new Uint8Array(job.classMap),
      classLabels: job.classLabels,
      gray: gray,
      gemini: job.gemini || null,
      options: job.options || null,
      // optional: panoptic segment id per pixel (0 = none) for the "thing" classes, from OneFormer
      instanceMap: job.instanceMap ? new Uint8Array(job.instanceMap) : null,
    });
    self.postMessage({ type: "result", id: job.id, result: result }, [
      result.labelMap.buffer,
    ]);
  } catch (error) {
    self.postMessage({
      type: "error",
      id: job.id,
      message: error && error.message ? error.message : String(error),
    });
  }
};
