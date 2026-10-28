// What actually happens when a pipeline job runs: fetch the photo, ask the Modal models what they see (one request to
// the combined pool, or the three separate pools, or mocks), fit planes for the room's own existing scan regions, store
// the layers, write Room.fusion. server/routes/pipeline.js only decides whether this needs to run; this module is the
// "how".
//
// Region TOPOLOGY comes from the designer's own already-computed, already-reviewed scan (scan.metas + scan.labelMap -
// see public/js/lib/regions.js's buildRegions(), reproduced here server-side in regionsFromScan()), not from SAM 3's
// own instance boundaries: one authoritative region set and label map is shared by the existing Gemini pipeline and
// the fast renderer, with no separate id-matching layer to keep in sync. What SAM 3 contributes is its masks, which
// are KEPT now (server/lib/samLayer.js) instead of being boiled down to a score and dropped:
//   - a real per-region confidence in place of the flat default (scoreRegionsWithSamLayer)
//   - cleaner points to fit each plane on: the part of the region SAM agrees with, rugs and furniture left out
//     (cleanFitMask), which directly raises planarity and confidence
//   - a proposal to split a "wall" that is really several planes (planeSplit.js); the browser applies it
//   - the obstructions (rug, window, door, furniture) the browser carves out of the surface they stand on
const config = require("../config");
const Room = require("../models/Room");
const storageModule = require("./storage");
const pack = require("./pack");
const resample = require("./resample");
const fusion = require("./fusion");
const fusionStore = require("./fusionStore");
const samLayer = require("./samLayer");
const moge2 = require("./remoteModels/moge2");
const marigold = require("./remoteModels/marigold");
const sam3 = require("./remoteModels/sam3");
const analyze = require("./remoteModels/analyze");

function shouldMock(modelConfig) {
  if (config.pipeline.mock === "on") {
    return true;
  }
  if (config.pipeline.mock === "off") {
    return false;
  }
  return !modelConfig.url; // "auto"
}

// One combined request instead of three: when ANALYZE_URL is set and the pipeline is not mocked wholesale.
function useCombinedAnalysis() {
  return !!config.analyze.url && config.pipeline.mock !== "on";
}

// Which of the models a run will really call - for the server log.
function modelModes() {
  if (useCombinedAnalysis()) {
    return { analyze: "remote", sam3: "remote", moge2: "remote", marigold: "remote" };
  }
  return {
    sam3: config.sam3.url && config.pipeline.mock !== "on" ? "remote" : "skipped",
    moge2: shouldMock(config.moge2) ? "mock" : "remote",
    marigold: shouldMock(config.marigold) ? "mock" : "remote",
  };
}

const FUSION_KINDS = new Set(["wall", "floor", "ceiling"]);
const DEFAULT_MASK_SCORE = 0.75; // no independent detector score; the designer has already
// reviewed/corrected this scan, so a neutral, moderately trusting default - see
// scoreRegionsWithSamLayer() for what replaces it when SAM 3 ran.

// What stands in front of a wall, floor or ceiling: its pixels are not part of the plane, however the scan drew it.
const OBSTRUCTION_KINDS = ["rug", "window", "door", "furniture", "plant", "picture frame", "light fixture"];
const MIN_OBSTRUCTION_SCORE = 0.5;
// SAM's mask is used to clean a region's fit points only when it agrees with the region this well ...
const SAM_MATCH_IOU = 0.35;
// ... and only if what is left is still a fair share of the region (SAM may have found only a corner of a big wall).
const MIN_FIT_SHARE = 0.4;
const MIN_FIT_PIXELS = 200;

// {id, kind, label, score, mask}[] from the room's own saved scan - the same
// labelMap[pixel] === meta.index derivation buildRegions() does in the browser, so "which
// pixels are this region" never has two different answers depending on which code computed it.
function regionsFromScan(scan, labelMap) {
  const byIndex = new Map();
  (scan.metas || []).forEach(function (meta) {
    const kind = String(meta.kind || "").toLowerCase();
    if (!FUSION_KINDS.has(kind)) {
      return;
    }
    byIndex.set(meta.index, {
      id: meta.id,
      kind: kind,
      label: meta.label,
      score: DEFAULT_MASK_SCORE,
      mask: new Uint8Array(scan.width * scan.height),
      count: 0,
    });
  });
  for (let pixel = 0; pixel < labelMap.length; pixel += 1) {
    const region = byIndex.get(labelMap[pixel]);
    if (region) {
      region.mask[pixel] = 1;
      region.count += 1;
    }
  }
  return Array.from(byIndex.values()).filter(function (region) {
    return region.count > 0;
  });
}

function iou(maskA, maskB) {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < maskA.length; i += 1) {
    const a = maskA[i] !== 0;
    const b = maskB[i] !== 0;
    if (a || b) {
      union += 1;
      if (a && b) {
        intersection += 1;
      }
    }
  }
  return union > 0 ? intersection / union : 0;
}

// Replaces each scan region's DEFAULT_MASK_SCORE with a real detector score wherever a SAM 3 detection of the same
// kind overlaps it well (IoU >= 0.3 - loose on purpose: SAM 3's and SegFormer/Gemini's own boundaries for "the same
// wall" are drawn independently and will not match pixel-for-pixel). Matches by overlap, not id, so it survives the two
// systems disagreeing slightly on exactly where an edge falls. Regions with no good match keep the default - this is a
// confidence refinement, not a requirement. samResult is sam3.normalize()'s {width, height, detections} (at SAM's own
// image size); scoreRegionsWithSamLayer() below is the same thing for a stored layer on the scan's grid.
function scoreRegionsWithSam(regions, samResult, scanWidth, scanHeight) {
  if (!samResult || samResult.detections.length === 0) {
    return regions;
  }
  const resized = samResult.detections.map(function (detection) {
    return {
      kind: detection.kind,
      score: detection.score,
      mask: resample.resampleNearest(
        detection.mask,
        samResult.width,
        samResult.height,
        scanWidth,
        scanHeight,
        Uint8Array,
      ),
    };
  });
  return scoreAgainst(regions, resized);
}

function scoreRegionsWithSamLayer(regions, layer) {
  if (!layer || layer.instances.length === 0) {
    return regions;
  }
  return scoreAgainst(regions, layer.instances);
}

function scoreAgainst(regions, instances) {
  return regions.map(function (region) {
    let best = null;
    instances.forEach(function (instance) {
      if (instance.kind !== region.kind) {
        return;
      }
      const overlap = iou(region.mask, instance.mask);
      if (overlap >= 0.3 && (!best || overlap > best.overlap)) {
        best = { overlap: overlap, score: instance.score };
      }
    });
    return best ? Object.assign({}, region, { score: best.score }) : region;
  });
}

function maskCount(mask) {
  return fusion.countMaskPixels(mask);
}

// The pixels to fit this region's plane on. The scan's region is the designer's, SAM's instances are a second opinion:
//   1. keep the part of the region that same-kind SAM instances cover (instances that match it at IoU >= 0.35, or that
//      lie mostly inside it): trims ragged edges that would drag the plane
//   2. drop what stands in front of it (rug, window, door, furniture instances), grown by a pixel
// Each step is only taken if a fair share of the region survives it, so a SAM miss can never starve the fit; with no SAM
// layer the region is returned untouched. fitRegions() erodes the result by 2 px afterwards, as before.
function cleanFitMask(region, layer, width, height) {
  if (!layer || layer.instances.length === 0) {
    return region.mask;
  }
  const total = region.count || maskCount(region.mask);
  const floorPixels = Math.max(MIN_FIT_PIXELS, MIN_FIT_SHARE * total);

  const matched = new Uint8Array(region.mask.length);
  let anyMatch = false;
  layer.instances.forEach(function (instance) {
    if (instance.kind !== region.kind) {
      return;
    }
    let inter = 0;
    for (let i = 0; i < region.mask.length; i += 1) {
      if (region.mask[i] && instance.mask[i]) {
        inter += 1;
      }
    }
    const union = total + instance.area - inter;
    const overlap = union > 0 ? inter / union : 0;
    const inside = instance.area > 0 ? inter / instance.area : 0;
    if (overlap >= SAM_MATCH_IOU || inside >= 0.6) {
      anyMatch = true;
      for (let i = 0; i < matched.length; i += 1) {
        if (instance.mask[i]) {
          matched[i] = 1;
        }
      }
    }
  });

  let candidate = region.mask;
  if (anyMatch) {
    const cut = new Uint8Array(region.mask.length);
    for (let i = 0; i < cut.length; i += 1) {
      cut[i] = region.mask[i] && matched[i] ? 1 : 0;
    }
    if (maskCount(cut) >= floorPixels) {
      candidate = cut;
    }
  }

  const blocked = new Uint8Array(region.mask.length);
  let anyBlocked = false;
  layer.instances.forEach(function (instance) {
    if (OBSTRUCTION_KINDS.indexOf(instance.kind) === -1 || instance.score < MIN_OBSTRUCTION_SCORE) {
      return;
    }
    anyBlocked = true;
    for (let i = 0; i < blocked.length; i += 1) {
      if (instance.mask[i]) {
        blocked[i] = 1;
      }
    }
  });
  if (anyBlocked) {
    // grow by one pixel: a mask edge sits ON the object's silhouette, the pixel beside it is still object
    const grown = growMask(blocked, width, height);
    const carved = new Uint8Array(candidate.length);
    for (let i = 0; i < carved.length; i += 1) {
      carved[i] = candidate[i] && !grown[i] ? 1 : 0;
    }
    if (maskCount(carved) >= floorPixels) {
      candidate = carved;
    }
  }
  return candidate;
}

function growMask(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (
        mask[index] ||
        (x > 0 && mask[index - 1]) ||
        (x < width - 1 && mask[index + 1]) ||
        (y > 0 && mask[index - width]) ||
        (y < height - 1 && mask[index + width])
      ) {
        out[index] = 1;
      }
    }
  }
  return out;
}

async function loadLabelMap(roomId, width, height) {
  const buffer = await storageModule.storage().getBuffer(roomId + "/scan/labels");
  if (!buffer || buffer.length !== width * height * 2) {
    throw new Error("The saved surface map is missing or does not match its own size.");
  }
  return new Uint16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
}

// Stage A: what the Modal models say about the photo - photo-level, expensive, cached by photo version.
// With ANALYZE_URL that is ONE request to ONE pool (a cold start and an idle tail, not three); otherwise the three
// pools are called together (Promise.all - they are independent and this is most of the pipeline's latency).
async function askModels(photo, scanW, scanH, callOptions, wantSam, report) {
  if (useCombinedAnalysis()) {
    await report({ stage: "geometry", progress: { moge2: "running", marigold: "running", sam3: "running" } });
    const answer = await analyze.analyze(photo, callOptions);
    await report({ progress: { moge2: "done", marigold: "done", sam3: "done" } });
    return {
      mode: "analyze",
      geometryRaw: answer.geometry,
      lightingRaw: answer.lighting,
      samResult: answer.sam,
    };
  }
  await report({
    stage: "geometry",
    progress: { moge2: "running", marigold: "running", sam3: wantSam ? "running" : "skipped" },
  });
  const [geometryRaw, lightingRaw, samResult] = await Promise.all([
    shouldMock(config.moge2) ? moge2.mock(photo, scanW, scanH) : moge2.analyze(photo, callOptions),
    shouldMock(config.marigold) ? marigold.mock(photo, scanW, scanH) : marigold.analyze(photo, callOptions),
    wantSam ? sam3.analyze(photo, callOptions) : Promise.resolve(null),
  ]);
  await report({ progress: { moge2: "done", marigold: "done", sam3: wantSam ? "done" : "skipped" } });
  return { mode: "separate", geometryRaw: geometryRaw, lightingRaw: lightingRaw, samResult: samResult };
}

async function runGeometry(room, versionId, report) {
  const scanW = room.scan.width;
  const scanH = room.scan.height;

  const photo = await storageModule.storage().getBuffer(room._id + "/" + versionId + "/raw");
  if (!photo) {
    throw new Error("The photo for this version was not found in storage.");
  }

  // SAM 3 is a refinement, not a requirement (see the module comment) - only called when actually configured, rather
  // than mocked like the other two, since there is nothing useful for a mock to contribute here on its own.
  const wantSam = !!config.sam3.url && config.pipeline.mock !== "on";

  // meta tags each timed call with the room, for the owner-only cold-start view (coldStart.js).
  const callOptions = { meta: { roomId: String(room._id) } };
  const asked = await askModels(photo, scanW, scanH, callOptions, wantSam, report);
  const geometryRaw = asked.geometryRaw;
  const lightingRaw = asked.lightingRaw;

  // Put every layer on exactly the scan's own pixel grid, and scale the intrinsics to match - a pinhole camera's
  // fx/fy/cx/cy scale linearly with resolution.
  const scaleX = scanW / geometryRaw.width;
  const scaleY = scanH / geometryRaw.height;
  const depth = resample.resampleNearest(geometryRaw.depth, geometryRaw.width, geometryRaw.height, scanW, scanH);
  const intrinsics = {
    fx: geometryRaw.intrinsics.fx * scaleX,
    fy: geometryRaw.intrinsics.fy * scaleY,
    cx: geometryRaw.intrinsics.cx * scaleX,
    cy: geometryRaw.intrinsics.cy * scaleY,
  };
  const shading = resample.resampleBilinear(lightingRaw.shading, lightingRaw.width, lightingRaw.height, scanW, scanH);
  const residual = lightingRaw.residual
    ? resample.resampleBilinear(lightingRaw.residual, lightingRaw.width, lightingRaw.height, scanW, scanH)
    : null;

  const base = room._id + "/fusion/" + versionId + "/";
  const store = storageModule.storage();
  const depthFile = base + "depth";
  const shadingFile = base + "shading";
  await store.putBuffer(depthFile, pack.packFloat32(depth), { contentType: "application/octet-stream" });
  await store.putBuffer(shadingFile, pack.packUnit16(shading), { contentType: "application/octet-stream" });
  let residualFile = null;
  if (residual) {
    residualFile = base + "residual";
    await store.putBuffer(residualFile, pack.packUnit16(residual), { contentType: "application/octet-stream" });
  }
  let layer = null;
  let samFile = null;
  if (asked.samResult) {
    layer = samLayer.build(asked.samResult.detections, asked.samResult.width, asked.samResult.height, scanW, scanH);
    samFile = base + "sam";
    await store.putBuffer(samFile, samLayer.pack(layer), { contentType: "application/octet-stream" });
  }

  const geometry = {
    versionId: versionId,
    computedAt: Date.now(),
    width: scanW,
    height: scanH,
    camera: {
      fx: intrinsics.fx,
      fy: intrinsics.fy,
      cx: intrinsics.cx,
      cy: intrinsics.cy,
      up: geometryRaw.up || null,
    },
    depthFile: depthFile,
    shadingFile: shadingFile,
    // shading and residual are linear relative light (marigold.js ENCODING), stored as 16-bit; a room analysed before
    // this has neither field and holds float32 gamma-encoded shading (studio.js converts it on load)
    shadingEncoding: marigold.SHADING_ENCODING,
    shadingFormat: "u16",
    residualFile: residualFile,
    samFile: samFile,
    samSummary: layer ? summarizeLayer(layer) : null,
    modelVersions: {
      moge2: asked.mode === "analyze" ? "remote" : shouldMock(config.moge2) ? "mock" : "remote",
      marigold: asked.mode === "analyze" ? "remote" : shouldMock(config.marigold) ? "mock" : "remote",
      sam3: asked.samResult ? "remote" : "skipped",
      via: asked.mode,
    },
  };
  await fusionStore.saveGeometry(room._id, geometry);
  return { geometry: geometry, depth: depth, layer: layer };
}

function summarizeLayer(layer) {
  const kinds = {};
  layer.instances.forEach(function (instance) {
    kinds[instance.kind] = (kinds[instance.kind] || 0) + 1;
  });
  return { count: layer.instances.length, kinds: kinds };
}

// A split proposal as stored in Room.fusion.regions.splits: the part map gzipped (a few hundred bytes for a clean
// corner) so it fits in the document, plus the facts a log or the owner might want.
function storableSplits(splits) {
  return (splits || []).map(function (split) {
    return {
      regionId: split.regionId,
      map: pack.packUint8(split.partMap).toString("base64"),
      parts: split.parts.map(function (part) {
        return { index: part.index, area: part.area, normal: part.normal, inlierRatio: part.inlierRatio };
      }),
      angleDeg: split.angleDeg,
      source: split.source,
    };
  });
}

// Stage B: local math only (no remote calls), scan-level, cheap, re-run on every rescan and brush edit. `layer`, when
// given, is the SAM layer stored by the Stage A run for this photo version (or the one that just ran).
async function runRegions(room, depth, intrinsics, up, layer, report) {
  await report({ stage: "regions", progress: { fusion: "running" } });
  const scan = room.scan;
  const labelMap = await loadLabelMap(room._id, scan.width, scan.height);
  let regions = regionsFromScan(scan, labelMap);
  if (regions.length === 0) {
    throw new Error("The scan has no wall, floor or ceiling regions to fit planes for.");
  }
  regions = scoreRegionsWithSamLayer(regions, layer);
  const wallInstances = layer
    ? layer.instances.filter(function (instance) {
        return instance.kind === "wall";
      })
    : [];
  const fitted = await fusion.runFitRegions({
    width: scan.width,
    height: scan.height,
    depth: depth,
    intrinsics: intrinsics,
    up: up,
    // fitRegions()'s own defaults (0.45/0.70) match public/js/lib/settings.js's defaults for
    // the same two numbers. The stored "tier" is a convenience default; the renderer re-derives
    // it from the stored "confidence" and the designer's own live threshold settings (see
    // public/js/lib/fastrender/tiers.js), so changing the thresholds never needs a re-run.
    regions: regions.map(function (region) {
      return {
        id: region.id,
        kind: region.kind,
        score: region.score,
        mask: cleanFitMask(region, layer, scan.width, scan.height),
      };
    }),
    // walls that are really several planes: judged on the designer's own region masks, not the cleaned ones
    splitInput: {
      width: scan.width,
      height: scan.height,
      depth: depth,
      intrinsics: intrinsics,
      regions: regions
        .filter(function (region) {
          return region.kind === "wall";
        })
        .map(function (region) {
          return { id: region.id, kind: region.kind, mask: region.mask };
        }),
      sam: wallInstances.map(function (instance) {
        return { id: instance.id, kind: instance.kind, score: instance.score, mask: instance.mask };
      }),
    },
  });
  const stored = { byId: fitted.byId, splits: storableSplits(fitted.splits) };
  await fusionStore.saveRegions(room._id, Object.assign({ computedForScanAt: scan.savedAt }, stored));
  await report({ progress: { fusion: "done" } });
}

async function loadStoredLayer(geometry) {
  if (!geometry || !geometry.samFile) {
    return null;
  }
  try {
    const buffer = await storageModule.storage().getBuffer(geometry.samFile);
    return buffer ? samLayer.unpack(buffer) : null;
  } catch (error) {
    return null; // a missing or unreadable layer only means the plain region masks are used
  }
}

// Runs whatever Stage A/B work is actually needed for this room+version. `report(patch)` is
// the job queue's status callback (see server/lib/jobs.js, server/routes/pipeline.js).
async function run(roomId, versionId, report) {
  const room = await Room.findById(roomId);
  if (!room) {
    throw new Error("That room is not saved here.");
  }
  if (!room.scan || !room.scan.width) {
    throw new Error("Scan this room before analysing it.");
  }

  const existing = room.fusion || {};
  const needsGeometry = !existing.geometry || existing.geometry.versionId !== versionId;
  const needsRegions =
    needsGeometry || !existing.regions || existing.regions.computedForScanAt !== room.scan.savedAt;

  if (!needsGeometry && !needsRegions) {
    return;
  }

  let depth;
  let intrinsics;
  let up;
  let layer = null;
  if (needsGeometry) {
    const geometryResult = await runGeometry(room, versionId, report);
    depth = geometryResult.depth;
    intrinsics = geometryResult.geometry.camera;
    up = geometryResult.geometry.camera.up;
    layer = geometryResult.layer;
  } else {
    const buffer = await storageModule.storage().getBuffer(existing.geometry.depthFile);
    depth = pack.unpackFloat32(buffer);
    intrinsics = existing.geometry.camera;
    up = existing.geometry.camera.up;
    layer = await loadStoredLayer(existing.geometry);
  }

  if (needsRegions) {
    await runRegions(room, depth, intrinsics, up, layer, report);
  }
}

module.exports = {
  run: run,
  modelModes: modelModes,
  regionsFromScan: regionsFromScan,
  scoreRegionsWithSam: scoreRegionsWithSam,
  scoreRegionsWithSamLayer: scoreRegionsWithSamLayer,
  cleanFitMask: cleanFitMask,
  storableSplits: storableSplits,
  useCombinedAnalysis: useCombinedAnalysis,
  iou: iou,
};
