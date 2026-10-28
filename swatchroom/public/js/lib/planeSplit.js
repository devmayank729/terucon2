// Applying the room pipeline's "this wall is really two planes" proposals (server/lib/planeSplit.js) to the scan, which the
// browser owns. A proposal says: wall region R is several planes, here is a part map (0 outside R, 1..k) numbered left to
// right. Applying it turns each part after the first into a region of its own (new id, new label index) and keeps the
// first part as R itself, so everything attached to R (selection, products) stays valid.
import { colourRegions, numberDuplicateLabels, buildRegions } from "./regions.js";

const POSITION_NAMES = {
  2: ["left", "right"],
  3: ["left", "middle", "right"],
};

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

// -> a new scan (same width / height, label map with the splits, regions rebuilt) or the same scan if nothing applies.
// splits: [{ regionId, partMap: Uint8Array, parts: n }] (partMap at the scan's size). Splits for regions that are gone, or
// whose map does not fit the scan, are ignored.
export function applyPlaneSplits(scan, splits) {
  const labelMap = new Uint16Array(scan.labelMap);
  let nextIndex = scan.nextIndex;
  const metas = scan.regions.map((region) => ({
    id: region.id,
    index: region.index,
    label: region.label,
    kind: region.kind,
    source: region.source,
    color: region.color,
  }));
  let applied = 0;
  splits.forEach(function (split) {
    const region = scan.regions.find((candidate) => candidate.id === split.regionId);
    if (!region || split.partMap.length !== labelMap.length || split.parts < 2) {
      return;
    }
    const names = POSITION_NAMES[split.parts] || [];
    const base = region.label.replace(/^walls?\s*\d*$/i, "Wall");
    const baseMeta = metas.find((meta) => meta.id === region.id);
    const created = [];
    for (let part = 2; part <= split.parts; part += 1) {
      const index = nextIndex++;
      created.push(index);
      metas.push({
        id: "r" + index + "-" + randomSuffix(),
        index: index,
        label: names[part - 1] ? base + ", " + names[part - 1] : base + " " + part,
        kind: region.kind,
        source: "planes",
        color: region.color,
      });
    }
    baseMeta.label = names[0] ? base + ", " + names[0] : base + " 1";
    baseMeta.source = "planes";
    for (let i = 0; i < labelMap.length; i += 1) {
      if (labelMap[i] === region.index) {
        const part = split.partMap[i];
        if (part >= 2 && part <= split.parts) {
          labelMap[i] = created[part - 2];
        }
      }
    }
    applied += 1;
  });
  if (applied === 0) {
    return scan;
  }
  const built = buildRegions(metas.map((meta) => Object.assign({}, meta)), labelMap, scan.width, scan.height);
  numberDuplicateLabels(built.regions);
  colourRegions(built.regions);
  return Object.assign({}, scan, {
    labelMap: labelMap,
    regions: built.regions,
    byIndex: built.byIndex,
    nextIndex: nextIndex,
  });
}

// The proposals Room.fusion.regions.splits holds (server/lib/pipelineRunner.js storableSplits): the part map is gzip +
// base64. -> [{ regionId, partMap, parts }]
export async function decodeSplits(stored, unpackBytes) {
  const out = [];
  for (const entry of stored || []) {
    try {
      out.push({
        regionId: entry.regionId,
        partMap: await unpackBytes(entry.map),
        parts: (entry.parts || []).length,
        angleDeg: entry.angleDeg,
      });
    } catch (error) {
      // an unreadable proposal is simply not applied
    }
  }
  return out;
}
