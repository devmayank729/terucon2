// Tap-to-calibrate: when the designer taps a surface, the region the scan drew is selected at once (zero wait) and, in the
// background, its outline is checked against SAM and tightened. The scene model and the edge snapping get a surface almost
// right; SAM, asked about exactly this surface, gets its edges right, and also knows the rug, the sofa and the picture
// frame that stand on it.
//
// Where SAM's answer comes from, in order, WITHOUT calling Modal (the instance masks were stored by the room pipeline):
//   1. the stored SAM 3 instances (the "SAM layer") - nothing to call at all
//   2. the model service's SlimSAM (python/pick.py), prompted with the prompts built by buildSamPrompts() below
// and the fusion rules are the same for both: fuseRegionWithSam().
//
// Pure functions on masks, unit-tested in tests/sam.test.js.
import { carveOccluders } from "./occlusion.js";
import { countSet, dilate, distanceInside, maskIou } from "./morph.js";

// Above this confidence SAM's edge is trusted over the scan's.
export const SNAP_CONFIDENCE = 0.8;
// SAM's mask must overlap the region at least this much (IoU) to be about the same surface at all.
export const MIN_AGREEMENT_IOU = 0.35;
// ... and the edge fix may change at most this share of the region, or SAM probably found something else.
export const MAX_CHANGE_SHARE = 0.35;
// Edge snapping only trims a region where SAM covers at least this share of it.
const MIN_SAM_COVER = 0.5;

// ---------------------------------------------------------------- choosing SAM's instance
// The stored instance of the region's kind that is this surface: the one under the tap that overlaps the region best, or
// else simply the best overlap. -> { instance, iou, underTap } | null
export function pickSamInstance(region, tap, instances, width, height) {
  const px = tap ? Math.min(width - 1, Math.max(0, Math.floor(tap.x * width))) : -1;
  const py = tap ? Math.min(height - 1, Math.max(0, Math.floor(tap.y * height))) : -1;
  let best = null;
  instances.forEach(function (instance) {
    if (instance.kind !== region.kind) {
      return;
    }
    const iou = maskIou(region.mask, instance.mask);
    if (iou < MIN_AGREEMENT_IOU) {
      return;
    }
    const underTap = px >= 0 && instance.mask[py * width + px] === 1;
    const better =
      !best ||
      (underTap && !best.underTap) ||
      (underTap === best.underTap && iou > best.iou);
    if (better) {
      best = { instance: instance, iou: iou, underTap: underTap };
    }
  });
  return best;
}

// ---------------------------------------------------------------- the fusion
// candidate: { mask: Uint8Array, score: 0..1, source: "sam3" | "slimsam" }
// layer: the SAM layer (for the occluders) or null; labelMap: the scan's, so a mask is only ever GROWN into pixels nobody
// owns (SAM never takes a pixel from the window or the sofa next to the wall).
// -> { mask, changed, reason, source, stats: { iou, removed, added, carved, snapped } }
export function fuseRegionWithSam(input) {
  const { region, candidate, layer, labelMap, width, height } = input;
  const original = region.mask;
  const total = countSet(original);
  const unchanged = function (reason, extra) {
    return Object.assign(
      { mask: original, changed: false, reason: reason, source: candidate ? candidate.source : "", stats: { iou: 0, removed: 0, added: 0, carved: 0, snapped: false } },
      extra || {},
    );
  };
  if (total === 0) {
    return unchanged("empty");
  }

  let working = original;
  const stats = { iou: 0, removed: 0, added: 0, carved: 0, snapped: false };
  const side = Math.min(width, height);

  if (candidate && candidate.mask) {
    stats.iou = maskIou(original, candidate.mask);
    if (stats.iou < MIN_AGREEMENT_IOU) {
      return unchanged("disagree", { stats: stats });
    }
    if (candidate.score >= SNAP_CONFIDENCE) {
      const band = Math.max(2, Math.round(side * 0.006)); // SAM's edge is trusted to within this much of where the scan has it
      const reach = Math.max(band * 2, Math.round(side * 0.02)); // spillover is looked for this close to SAM's edge
      const covered = countSet(original.map((v, i) => (v && candidate.mask[i] ? 1 : 0)));
      const growS = dilate(candidate.mask, width, height, band);
      const nearS = dilate(candidate.mask, width, height, reach);
      const nearR = dilate(original, width, height, band);
      const snapped = new Uint8Array(original.length);
      let removed = 0;
      let added = 0;
      const mayTrim = covered / total >= MIN_SAM_COVER;
      for (let i = 0; i < snapped.length; i += 1) {
        if (original[i]) {
          // spillover: in the region, SAM says it is not this surface, and it is right next to where SAM's surface ends
          if (mayTrim && !growS[i] && nearS[i]) {
            removed += 1;
          } else {
            snapped[i] = 1;
          }
        } else if (candidate.mask[i] && nearR[i] && labelMap && labelMap[i] === 0) {
          snapped[i] = 1; // SAM's surface runs on just past the scan's edge, over pixels no region owns
          added += 1;
        }
      }
      if (removed + added <= MAX_CHANGE_SHARE * total) {
        working = snapped;
        stats.removed = removed;
        stats.added = added;
        stats.snapped = true;
      }
    }
  }

  // what stands in front: holes, whichever source supplied the edge
  if (layer) {
    const carved = carveOccluders(working, layer, width, height);
    if (carved.removed > 0) {
      working = carved.mask;
      stats.carved = carved.removed;
    }
  }

  const difference = stats.removed + stats.added + stats.carved;
  if (difference < Math.max(20, 0.0005 * total)) {
    return unchanged(candidate ? "already-sharp" : "no-sam", { stats: stats });
  }
  return {
    mask: working,
    changed: true,
    reason: stats.snapped ? "snapped" : "carved",
    source: candidate ? candidate.source : "",
    stats: stats,
  };
}

// ---------------------------------------------------------------- prompts for SlimSAM (the local model)
// Points of the deepest interior of a mask: greedy picks of the biggest chessboard-distance values, at least
// `separation` pixels apart. -> [[x, y], ...]
export function distancePeaks(mask, width, height, count, separation, avoid) {
  const distance = distanceInside(mask, width, height);
  const candidates = [];
  const step = Math.max(2, Math.round(Math.min(width, height) / 160));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const d = distance[y * width + x];
      if (d > 1) {
        candidates.push([x, y, d]);
      }
    }
  }
  candidates.sort((a, b) => b[2] - a[2]);
  const chosen = [];
  const far = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= separation;
  for (let i = 0; i < candidates.length && chosen.length < count; i += 1) {
    const c = candidates[i];
    if ((avoid || []).every((a) => far(c, a)) && chosen.every((p) => far(c, p))) {
      chosen.push([c[0], c[1]]);
    }
  }
  return chosen;
}

// The neighbours of a region by how much of its edge they share. -> [{ region, contact }] biggest first
export function neighbourRegions(scan, region) {
  const { width, height, labelMap } = scan;
  const contact = new Map();
  const mask = region.mask;
  for (let y = region.bbox.y0; y < region.bbox.y1; y += 1) {
    for (let x = region.bbox.x0; x < region.bbox.x1; x += 1) {
      const i = y * width + x;
      if (!mask[i]) {
        continue;
      }
      const around = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1];
      for (let k = 0; k < 4; k += 1) {
        const q = around[k];
        if (q >= 0 && !mask[q] && labelMap[q] !== 0) {
          contact.set(labelMap[q], (contact.get(labelMap[q]) || 0) + 1);
        }
      }
    }
  }
  return Array.from(contact.entries())
    .map(([index, count]) => ({ region: scan.byIndex[index], contact: count }))
    .filter((entry) => entry.region)
    .sort((a, b) => b.contact - a.contact);
}

// The prompts SlimSAM gets for a tap on `region`, in photo pixels:
//   positive: the tap itself and 2-3 points from the deepest interior of the region (distance-transform peaks)
//   negative: the middle of up to two neighbouring regions of another kind (a window, the furniture), and points just
//             outside the region's bounding box
//   box:      the region's bounding box
// -> { points: [[x, y]...], labels: [1|0...], box: [x0, y0, x1, y1] }
export function buildSamPrompts(scan, region, tap) {
  const { width, height } = scan;
  const bbox = region.bbox;
  const diagonal = Math.hypot(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0);
  let start = tap
    ? [Math.min(width - 1, Math.max(0, Math.round(tap.x * width))), Math.min(height - 1, Math.max(0, Math.round(tap.y * height)))]
    : null;
  if (!start || !region.mask[start[1] * width + start[0]]) {
    // no tap (the surface was picked from the list), or the tap is no longer on this surface (the scan was replaced since):
    // the deepest point of the region stands in for it
    start = [Math.round(region.anchor.x), Math.round(region.anchor.y)];
  }
  const points = [start];
  const labels = [1];
  distancePeaks(region.mask, width, height, 3, Math.max(8, diagonal * 0.2), [start]).forEach(function (peak) {
    points.push(peak);
    labels.push(1);
  });
  neighbourRegions(scan, region)
    .filter((entry) => entry.region.kind !== region.kind)
    .slice(0, 2)
    .forEach(function (entry) {
      points.push([Math.round(entry.region.anchor.x), Math.round(entry.region.anchor.y)]);
      labels.push(0);
    });
  const outside = [
    [bbox.x0 - 3, Math.round((bbox.y0 + bbox.y1) / 2)],
    [bbox.x1 + 3, Math.round((bbox.y0 + bbox.y1) / 2)],
    [Math.round((bbox.x0 + bbox.x1) / 2), bbox.y0 - 3],
    [Math.round((bbox.x0 + bbox.x1) / 2), bbox.y1 + 3],
  ].filter(function (p) {
    return p[0] >= 0 && p[1] >= 0 && p[0] < width && p[1] < height && !region.mask[p[1] * width + p[0]];
  });
  outside.slice(0, 2).forEach(function (p) {
    points.push(p);
    labels.push(0);
  });
  return { points: points, labels: labels, box: [bbox.x0, bbox.y0, bbox.x1, bbox.y1] };
}
