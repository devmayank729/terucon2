// Swapping the quick scan for the HD scan without losing the designer's place. The two scans come from different
// engines, so their regions have different ids and slightly different shapes; what the designer cares about is "the
// surface I was just looking at". Pure functions, tested in tests/hdswap.test.js.
import { regionAt } from "./regions.js";

// Which regions of `newScan` stand for the surfaces that were selected in `oldScan`.
//   tap: { x, y } (0..1) where the designer last tapped, or null
// A single selected surface that contains the last tap is followed by re-reading the NEW scan at that exact point
// (regionAt), the same lookup a tap does; anything else (several surfaces, a selection made from the list) is matched
// by overlap: each old surface goes to the new one that covers most of its pixels, if that is at least half of it.
export function remapSelection(oldScan, selectedIds, newScan, tap) {
  if (!oldScan || !newScan || !selectedIds || selectedIds.length === 0) {
    return [];
  }
  if (selectedIds.length === 1 && tap) {
    const oldRegion = regionAt(oldScan, tap.x, tap.y);
    if (oldRegion && oldRegion.id === selectedIds[0]) {
      const region = regionAt(newScan, tap.x, tap.y);
      if (region) {
        return [region.id];
      }
    }
  }
  const out = [];
  selectedIds.forEach(function (id) {
    const old = oldScan.regions.find(function (region) {
      return region.id === id;
    });
    if (!old) {
      return;
    }
    const votes = new Map();
    let total = 0;
    const sx = newScan.width / oldScan.width;
    const sy = newScan.height / oldScan.height;
    for (let y = old.bbox.y0; y < old.bbox.y1; y += 1) {
      for (let x = old.bbox.x0; x < old.bbox.x1; x += 1) {
        if (!old.mask[y * oldScan.width + x]) {
          continue;
        }
        total += 1;
        const nx = Math.min(newScan.width - 1, Math.floor((x + 0.5) * sx));
        const ny = Math.min(newScan.height - 1, Math.floor((y + 0.5) * sy));
        const index = newScan.labelMap[ny * newScan.width + nx];
        if (index) {
          votes.set(index, (votes.get(index) || 0) + 1);
        }
      }
    }
    let best = 0;
    let bestVotes = 0;
    votes.forEach(function (count, index) {
      if (count > bestVotes) {
        bestVotes = count;
        best = index;
      }
    });
    const region = best ? newScan.byIndex[best] : null;
    if (region && bestVotes >= total * 0.5 && out.indexOf(region.id) === -1) {
      out.push(region.id);
    }
  });
  return out;
}

// The HD scan is applied by itself only while swapping can cost the designer nothing: nothing edited, no finish chosen,
// nothing rendered, the plain select tool. In every other case it waits behind a tap.
export function canAutoApply(state, undoDepth) {
  return (
    undoDepth === 0 &&
    !state.itemId &&
    state.tool === "select" &&
    !state.render &&
    (!state.pick || state.pick.status === "idle") &&
    Object.keys(state.products || {}).length === 0
  );
}
