// Region boundaries as smooth vector loops, so outlines can be drawn crisp at the screen's own pixel
// density and at any zoom instead of being a low-resolution bitmap scaled up (which on a phone
// showed as blocky, near-invisible lines).
//
// traceLoops() walks the pixel edges between a region and everything else, links them into closed
// loops (the outer border and one loop for every hole), smooths the staircase and simplifies it. The
// loops are in scan pixels, as [x0, y0, x1, y1, ...], with the region on the right-hand side of the
// direction of travel (outer borders run clockwise on screen, holes counter-clockwise), so they fill
// correctly with the "evenodd" rule and with "nonzero" alike.

// The border of a region is a staircase of one-pixel steps. Eight [1 2 1] passes (a Gaussian of
// about 2 steps) flatten steps of one pixel on slopes down to roughly 1 in 12; no point may end up
// more than MAX_SHIFT from where the pixel edges put it, which is plenty to iron out a staircase
// (its steps are half a pixel off the line) but keeps a room, window or door corner sharp instead
// of rounding it off. The simplification then drops what is left within 0.45 px.
const SMOOTH_PASSES = 8;
const MAX_SHIFT = 1;
const SIMPLIFY_TOLERANCE = 0.45;
const MIN_LOOP_AREA = 6;

// Ramer-Douglas-Peucker on an open polyline stored as [x, y, x, y, ...]; returns the kept points.
function simplifyOpen(points, count, tolerance) {
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack = [0, count - 1];
  while (stack.length > 0) {
    const last = stack.pop();
    const first = stack.pop();
    const ax = points[first * 2];
    const ay = points[first * 2 + 1];
    const dx = points[last * 2] - ax;
    const dy = points[last * 2 + 1] - ay;
    const length = Math.hypot(dx, dy);
    let farthest = -1;
    let farthestDistance = tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const px = points[index * 2] - ax;
      const py = points[index * 2 + 1] - ay;
      const distance =
        length === 0
          ? Math.hypot(px, py)
          : Math.abs(dx * py - dy * px) / length;
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthest = index;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push(first, farthest, farthest, last);
    }
  }
  const out = [];
  for (let index = 0; index < count; index += 1) {
    if (keep[index]) {
      out.push(points[index * 2], points[index * 2 + 1]);
    }
  }
  return out;
}

// A closed loop: simplify as an open line that starts and ends on the same point, with the start
// moved to the point farthest from the first so the cut does not fall in the middle of a feature.
function simplifyClosed(points, tolerance) {
  const count = points.length / 2;
  if (count < 4) {
    return points.slice();
  }
  let split = 0;
  let best = -1;
  for (let index = 1; index < count; index += 1) {
    const distance = Math.hypot(
      points[index * 2] - points[0],
      points[index * 2 + 1] - points[1],
    );
    if (distance > best) {
      best = distance;
      split = index;
    }
  }
  function slice(from, to) {
    const part = [];
    for (let index = from; index <= to; index += 1) {
      const at = index % count;
      part.push(points[at * 2], points[at * 2 + 1]);
    }
    return part;
  }
  const first = slice(0, split);
  const second = slice(split, count);
  second.push(points[0], points[1]);
  const a = simplifyOpen(first, first.length / 2, tolerance);
  const b = simplifyOpen(second, second.length / 2, tolerance);
  // drop the duplicated join points
  return a.concat(b.slice(2, b.length - 2));
}

function signedArea(points) {
  let area = 0;
  const count = points.length / 2;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    area +=
      points[index * 2] * points[next * 2 + 1] -
      points[next * 2] * points[index * 2 + 1];
  }
  return area / 2;
}

// The loops around the pixels of `labelMap` that equal `index`, inside bbox {x0, y0, x1, y1}
// (x1/y1 exclusive). Returns an array of Float32Array.
export function traceLoops(labelMap, index, width, height, bbox) {
  const bx = Math.max(0, bbox.x0 - 1);
  const by = Math.max(0, bbox.y0 - 1);
  const ex = Math.min(width, bbox.x1 + 1);
  const ey = Math.min(height, bbox.y1 + 1);
  const gridWidth = ex - bx;
  const gridHeight = ey - by;
  const stride = gridWidth + 1; // corner points per row
  const corners = stride * (gridHeight + 1);
  // Up to two edges leave a corner (two region pixels touching diagonally).
  const first = new Int32Array(corners).fill(-1);
  const second = new Int32Array(corners).fill(-1);

  function inside(x, y) {
    return (
      x >= 0 &&
      y >= 0 &&
      x < width &&
      y < height &&
      labelMap[y * width + x] === index
    );
  }
  function add(from, to) {
    if (first[from] === -1) {
      first[from] = to;
    } else {
      second[from] = to;
    }
  }
  // Region on the right-hand side of every edge: along the top going right, down the right side,
  // back along the bottom, up the left side.
  let edges = 0;
  for (let gy = 0; gy < gridHeight; gy += 1) {
    const y = by + gy;
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x = bx + gx;
      if (!inside(x, y)) {
        continue;
      }
      const topLeft = gy * stride + gx;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + stride;
      const bottomRight = bottomLeft + 1;
      if (!inside(x, y - 1)) {
        add(topLeft, topRight);
        edges += 1;
      }
      if (!inside(x + 1, y)) {
        add(topRight, bottomRight);
        edges += 1;
      }
      if (!inside(x, y + 1)) {
        add(bottomRight, bottomLeft);
        edges += 1;
      }
      if (!inside(x - 1, y)) {
        add(bottomLeft, topLeft);
        edges += 1;
      }
    }
  }
  if (edges === 0) {
    return [];
  }

  const loops = [];
  for (let start = 0; start < corners; start += 1) {
    while (first[start] !== -1) {
      // Walk one loop, taking a right turn where two edges leave a corner so that diagonal
      // neighbours stay separate loops.
      const midpoints = [];
      let from = start;
      let previousDx = 0;
      let previousDy = 0;
      let guard = edges + 4;
      while (guard > 0) {
        guard -= 1;
        let to = first[from];
        if (to === -1) {
          break;
        }
        if (second[from] !== -1) {
          // choose between first[from] and second[from]: prefer the right turn
          const rightDx = -previousDy;
          const rightDy = previousDx;
          const toX = (to % stride) - (from % stride);
          const toY = Math.floor(to / stride) - Math.floor(from / stride);
          const otherTo = second[from];
          const otherX = (otherTo % stride) - (from % stride);
          const otherY = Math.floor(otherTo / stride) - Math.floor(from / stride);
          const takeSecond =
            (otherX === rightDx && otherY === rightDy) ||
            (!(toX === rightDx && toY === rightDy) &&
              otherX * previousDx + otherY * previousDy >
                toX * previousDx + toY * previousDy);
          if (takeSecond) {
            to = otherTo;
            second[from] = first[from];
          }
          first[from] = second[from];
          second[from] = -1;
        } else {
          first[from] = -1;
        }
        const fx = from % stride;
        const fy = Math.floor(from / stride);
        const tx = to % stride;
        const ty = Math.floor(to / stride);
        previousDx = tx - fx;
        previousDy = ty - fy;
        // the middle of the pixel edge: where the true border runs, give or take half a pixel
        midpoints.push(bx + (fx + tx) / 2, by + (fy + ty) / 2);
        from = to;
        if (from === start) {
          break;
        }
      }
      const count = midpoints.length / 2;
      if (count < 4) {
        continue;
      }
      // Smooth the staircase: passes of a [1 2 1] average around the closed loop.
      let current = midpoints;
      for (let pass = 0; pass < SMOOTH_PASSES; pass += 1) {
        const next = new Array(current.length);
        for (let at = 0; at < count; at += 1) {
          const before = (at + count - 1) % count;
          const after = (at + 1) % count;
          next[at * 2] =
            (current[before * 2] + 2 * current[at * 2] + current[after * 2]) / 4;
          next[at * 2 + 1] =
            (current[before * 2 + 1] +
              2 * current[at * 2 + 1] +
              current[after * 2 + 1]) /
            4;
        }
        current = next;
      }
      for (let at = 0; at < count; at += 1) {
        const shiftX = current[at * 2] - midpoints[at * 2];
        const shiftY = current[at * 2 + 1] - midpoints[at * 2 + 1];
        const shift = Math.hypot(shiftX, shiftY);
        if (shift > MAX_SHIFT) {
          current[at * 2] = midpoints[at * 2] + (shiftX * MAX_SHIFT) / shift;
          current[at * 2 + 1] = midpoints[at * 2 + 1] + (shiftY * MAX_SHIFT) / shift;
        }
      }
      const simple = simplifyClosed(current, SIMPLIFY_TOLERANCE);
      if (simple.length >= 6 && Math.abs(signedArea(simple)) >= MIN_LOOP_AREA) {
        loops.push(Float32Array.from(simple));
      }
    }
  }
  return loops;
}

// The loops as a Path2D in scan coordinates (draw it under a scale transform).
export function loopsToPath(loops) {
  const path = new Path2D();
  loops.forEach(function (loop) {
    path.moveTo(loop[0], loop[1]);
    for (let at = 2; at < loop.length; at += 2) {
      path.lineTo(loop[at], loop[at + 1]);
    }
    path.closePath();
  });
  return path;
}
