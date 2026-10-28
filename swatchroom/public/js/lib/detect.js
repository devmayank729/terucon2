// Surface detection. Two engines:
//   scene   SegFormer in the model service (recommended), with Gemini outlines splitting walls
//           into planes and naming surfaces
//   gemini  Gemini alone: outlines (or legacy pixel masks from gemini-2.5-flash)
// When the chosen engine fails, Gemini outlines are used instead (if allowed in Settings).

import { generate, isGeminiError, parseJsonText, readResponse } from "./ai.js";
import {
  KINDS,
  cleanLabel,
  kindFromPrefix,
  normaliseKind,
  polygonMask,
  scanFromLabelMap,
  scanFromMasks,
} from "./regions.js";
import { loadImage, makeCanvas } from "./images.js";
import { buildSurfaces, encodeForSegmentation, segmentBlob } from "./vision.js";
import { raceSegmentation } from "./segmentRace.js";

const MASK_PROMPT =
  'Give the segmentation masks for the architectural surfaces and main interior elements in this room photo: every visible wall plane as a separate item (left wall, back wall, right wall, partial walls), the ceiling, the floor, each window, each door, and large furniture or built-ins (sofa, bed, wardrobe, cabinets, kitchen counter, TV unit, dining table, rug). Output a JSON list of segmentation masks where each entry contains the 2D bounding box in the key "box_2d", the segmentation mask in key "mask", and the text label in the key "label". Start every label with its type followed by a colon, using one of: wall, floor, ceiling, window, door, furniture, other. Examples: "wall: back wall", "wall: left wall with switchboard", "floor: tiled floor", "ceiling", "window: large sliding window", "furniture: grey fabric sofa". Use descriptive labels. Do not return more than 24 items.';

// Two prompts for the same call:
//   OUTLINE_PROMPT         the outlines ARE the surfaces (the Gemini-only scan, which is also the
//                          fallback when the scene model is down): follow the real edges closely
//   ASSIST_OUTLINE_PROMPT  the outlines only help the scene model: which wall plane a pixel belongs
//                          to and what a surface is called; the pixel-accurate edges come from the
//                          scene model and the edge snapping. The scan waits for the model to WRITE
//                          the polygons, so this one asks for few points and few items (4-8 points
//                          does that job as well as 48, in a fraction of the output).
export const OUTLINE_PROMPT = [
  "You are segmenting a room photograph for an interior designer who will restyle each surface.",
  "Return every visible architectural surface and main element:",
  "- each wall plane separately (left wall, back wall, right wall, partial or angled walls)",
  "- the ceiling and the floor",
  "- each window and each door",
  "- large furniture and built-ins (sofa, bed, wardrobe, cabinets, kitchen counter, TV unit, dining table, rug)",
  "",
  "For each item give:",
  '- "label": a short descriptive name, like "back wall with window" or "light oak floor"',
  '- "kind": one of wall, floor, ceiling, window, door, furniture, other',
  '- "polygon": the outline as a list of [y, x] points, each value normalised to 0-1000 (origin at the top-left of the image). Use 10-48 points. Follow the real edges closely: room corners, the wall/ceiling and wall/floor lines, and window or door frames.',
  "",
  "Polygons may overlap. Draw each wall, floor and ceiling over its full extent, including the parts hidden behind furniture; objects in front (windows, doors, furniture) are listed separately and will be layered on top. Return at most 24 items.",
].join("\n");

export const ASSIST_OUTLINE_PROMPT = [
  "You are segmenting a room photograph for an interior designer who will restyle each surface.",
  "Return every visible architectural surface and the main elements:",
  "- each wall plane separately (left wall, back wall, right wall, partial or angled walls)",
  "- the ceiling and the floor",
  "- each window and each door",
  "- large furniture and built-ins (sofa, bed, wardrobe, cabinets, kitchen counter, TV unit, dining table, rug)",
  "",
  "For each item give:",
  '- "label": a short name of 2-4 words, like "back wall with window" or "light oak floor"',
  '- "kind": one of wall, floor, ceiling, window, door, furniture, other',
  '- "polygon": the outline as a list of [y, x] points, each value an integer normalised to 0-1000 (origin at the top-left of the image). Use as few points as the shape needs: 4-8 for a wall, the ceiling, the floor, a window or a door, up to 16 for furniture. Put points on room corners, on the wall/ceiling and wall/floor lines and on window or door corners; never add points along a straight edge.',
  "",
  "Polygons may overlap. Draw each wall, floor and ceiling over its full extent, including the parts hidden behind furniture; objects in front (windows, doors, furniture) are listed separately and will be layered on top. Skip small decor (cushions, plates, lamps, plants, pictures). Return at most 16 items, largest first.",
].join("\n");

const OUTLINE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      label: { type: "STRING" },
      kind: { type: "STRING", enum: KINDS },
      polygon: {
        type: "ARRAY",
        items: { type: "ARRAY", items: { type: "INTEGER" } },
      },
    },
    required: ["label", "kind", "polygon"],
  },
};

// Output caps for the outline call (thinking tokens count against them). The assist answer is about
// 2k tokens, so 8k is plenty and stops a degenerate answer (an endless run of near-identical points
// is a known way for a model to lose minutes) at a fraction of the old 16k cap; a cut-off list is
// still usable (parseJsonText closes it, and the prompt asks for the largest items first).
const OUTLINE_MAX_TOKENS = 16384;
const ASSIST_MAX_TOKENS = 8192;
// How long the scan waits for the AI outlines before it carries on without them (walls stay one
// piece and surfaces keep the scene model's generic names). Measured from when the call started.
const ASSIST_DEADLINE_MS = 45000;

function listFrom(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    const keys = ["masks", "regions", "items", "segments", "objects"];
    for (let index = 0; index < keys.length; index += 1) {
      if (Array.isArray(value[keys[index]])) {
        return value[keys[index]];
      }
    }
  }
  return [];
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function boxFrom(entry) {
  const raw = entry && (entry.box_2d || entry.box || entry.bbox);
  if (!Array.isArray(raw) || raw.length !== 4) {
    return null;
  }
  const values = raw.map(function (value) {
    return clamp(Number(value) || 0, 0, 1000);
  });
  const box = {
    ymin: Math.min(values[0], values[2]),
    ymax: Math.max(values[0], values[2]),
    xmin: Math.min(values[1], values[3]),
    xmax: Math.max(values[1], values[3]),
  };
  if (box.ymax - box.ymin < 2 || box.xmax - box.xmin < 2) {
    return null;
  }
  return box;
}

function boxMask(entry, width, height) {
  const box = boxFrom(entry);
  if (!box) {
    return null;
  }
  const mask = new Uint8Array(width * height);
  let count = 0;
  const left = Math.floor((box.xmin / 1000) * width);
  const top = Math.floor((box.ymin / 1000) * height);
  const right = Math.min(width, Math.ceil((box.xmax / 1000) * width));
  const bottom = Math.min(height, Math.ceil((box.ymax / 1000) * height));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      mask[y * width + x] = 1;
      count += 1;
    }
  }
  return { mask: mask, count: count };
}

// Gemini 2.5 masks come as a PNG for the bounding box only.
async function boxPngMask(entry, width, height, canvas) {
  const box = boxFrom(entry);
  if (!box) {
    return null;
  }
  const left = Math.floor((box.xmin / 1000) * width);
  const top = Math.floor((box.ymin / 1000) * height);
  const right = Math.min(width, Math.ceil((box.xmax / 1000) * width));
  const bottom = Math.min(height, Math.ceil((box.ymax / 1000) * height));
  const boxWidth = right - left;
  const boxHeight = bottom - top;
  if (boxWidth < 2 || boxHeight < 2) {
    return null;
  }
  const mask = new Uint8Array(width * height);
  let count = 0;
  let data = typeof entry.mask === "string" ? entry.mask.trim() : "";
  if (data !== "") {
    if (data.indexOf("data:") !== 0) {
      data = "data:image/png;base64," + data;
    }
    let image = null;
    try {
      image = await loadImage(data);
    } catch (error) {
      image = null;
    }
    if (image) {
      canvas.width = boxWidth;
      canvas.height = boxHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.clearRect(0, 0, boxWidth, boxHeight);
      context.imageSmoothingEnabled = true;
      context.drawImage(image, 0, 0, boxWidth, boxHeight);
      const pixels = context.getImageData(0, 0, boxWidth, boxHeight).data;
      for (let y = 0; y < boxHeight; y += 1) {
        for (let x = 0; x < boxWidth; x += 1) {
          const offset = (y * boxWidth + x) * 4;
          if (pixels[offset + 3] > 0 && pixels[offset] > 127) {
            mask[(top + y) * width + (left + x)] = 1;
            count += 1;
          }
        }
      }
    }
  }
  return { mask: mask, count: count };
}

function photoContents(job, prompt) {
  return [
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: job.imageBase64 } },
        { text: prompt },
      ],
    },
  ];
}

async function geminiMasks(job) {
  const answer = await generate(
    {
      task: "masks",
      model: job.maskModel,
      location: job.location,
      contents: photoContents(job, MASK_PROMPT),
    },
    job.signal,
  );
  const entries = listFrom(
    parseJsonText(readResponse(answer.response).texts.join("\n")),
  );
  const canvas = makeCanvas(1, 1);
  const detections = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    let filled = await boxPngMask(entry, job.width, job.height, canvas);
    if (filled && filled.count === 0) {
      filled = boxMask(entry, job.width, job.height);
    }
    if (!filled) {
      continue;
    }
    const label = entry.label || entry.name || "";
    const kind = normaliseKind(kindFromPrefix(label), label);
    detections.push({
      label: cleanLabel(label, kind),
      kind: kind,
      mask: filled.mask,
      count: filled.count,
      source: "mask",
    });
  }
  return detections;
}

// Raw outline entries from Gemini: [{ label, kind, polygon: [[y, x], ...] }]. assist: the compact
// version for naming and wall planes next to the scene model (see ASSIST_OUTLINE_PROMPT); without it
// the detailed version for when the outlines are the surfaces themselves.
export async function geminiOutlines(job, assist) {
  const answer = await generate(
    {
      task: "json",
      model: job.polygonModel,
      location: job.location,
      contents: photoContents(job, assist ? ASSIST_OUTLINE_PROMPT : OUTLINE_PROMPT),
      schema: OUTLINE_SCHEMA,
      maxTokens: assist ? ASSIST_MAX_TOKENS : OUTLINE_MAX_TOKENS,
    },
    job.signal,
  );
  return {
    outlines: listFrom(
      parseJsonText(readResponse(answer.response).texts.join("\n")),
    ),
    model: answer.model,
  };
}

function outlinesToDetections(outlines, width, height) {
  const detections = [];
  outlines.forEach(function (entry) {
    if (!entry || typeof entry !== "object") {
      return;
    }
    let filled = polygonMask(
      entry.polygon || entry.points,
      width,
      height,
      "yx",
    );
    if (filled.count === 0) {
      filled = boxMask(entry, width, height);
    }
    if (!filled) {
      return;
    }
    const label = entry.label || entry.name || "";
    const kind = normaliseKind(entry.kind || kindFromPrefix(label), label);
    detections.push({
      label: cleanLabel(label, kind),
      kind: kind,
      mask: filled.mask,
      count: filled.count,
      source: "polygon",
    });
  });
  return detections;
}

function stage(job, text) {
  if (job.onStage) {
    job.onStage(text);
  }
}

async function detectWithGemini(job, notes) {
  const engine = job.geminiEngine || "polygon";
  if (engine === "mask" || engine === "auto") {
    try {
      stage(job, "Asking AI for surface masks");
      const scan = scanFromMasks(await geminiMasks(job), job.width, job.height);
      if (scan.regions.length > 0 || engine === "mask") {
        scan.engine = "gemini-mask";
        scan.model = job.maskModel;
        scan.notes = notes;
        return scan;
      }
      console.warn("[swatchroom] mask model found no usable surfaces:", job.maskModel);
      notes.push("AI masks found no usable surfaces, so outlines were used.");
    } catch (error) {
      if ((error && error.name === "AbortError") || engine === "mask") {
        throw error;
      }
      console.warn("[swatchroom] mask model failed, using outlines:", job.maskModel, error);
      const reason =
        isGeminiError(error) && error.status === 404
          ? "AI pixel masks are no longer available"
          : "AI masks failed: " + error.message;
      notes.push(reason + ". Switched to AI outlines.");
    }
  }
  stage(job, "Tracing surfaces with AI");
  const answer = await geminiOutlines(job);
  const scan = scanFromMasks(
    outlinesToDetections(answer.outlines, job.width, job.height),
    job.width,
    job.height,
  );
  scan.engine = "gemini-outline";
  scan.model = answer.model;
  scan.notes = notes;
  return scan;
}

// Phase durations for the owner-only dot (job.timings is filled in only when the studio passes one).
function timed(job, name, started) {
  if (job.timings) {
    job.timings[name] = Math.round(performance.now() - started);
  }
}

// Gemini outlines used alongside the scene or SAM engines. Failure is not fatal, and neither is
// being slow: after ASSIST_DEADLINE_MS the scan carries on without them.
async function outlinesForNaming(job, notes) {
  if (!job.useGeminiAssist) {
    return null;
  }
  // Its own controller, so only this call is cancelled at the deadline (not the whole scan), while
  // the designer's own cancel still stops everything.
  const controller = new AbortController();
  let timedOut = false;
  function relay() {
    controller.abort();
  }
  if (job.signal) {
    if (job.signal.aborted) {
      controller.abort();
    } else {
      job.signal.addEventListener("abort", relay, { once: true });
    }
  }
  const timer = setTimeout(function () {
    timedOut = true;
    controller.abort();
  }, ASSIST_DEADLINE_MS);
  const started = performance.now();
  try {
    const answer = await geminiOutlines(
      Object.assign({}, job, { signal: controller.signal }),
      true,
    );
    job.assistModel = answer.model;
    return answer.outlines;
  } catch (error) {
    if (error && error.name === "AbortError" && !timedOut) {
      throw error;
    }
    if (timedOut) {
      console.warn(
        "[swatchroom] outline assist gave up after",
        ASSIST_DEADLINE_MS,
        "ms",
      );
      notes.push(
        "AI took too long to split walls and name surfaces, so the scan went ahead without it. Rescan to try again.",
      );
      return null;
    }
    console.warn("[swatchroom] outline assist failed:", job.polygonModel, error);
    notes.push(
      "AI could not split walls or name surfaces (" +
        error.message +
        "). Detection still ran.",
    );
    return null;
  } finally {
    clearTimeout(timer);
    if (job.signal) {
      job.signal.removeEventListener("abort", relay);
    }
    timed(job, "outlinesMs", started);
  }
}

// What the scan says about the engine that produced it: "segformer-b5-finetuned-ade-640-640 on cpu (int8) + gemini..."
function sceneModelText(segmented, fallbackName, outlines, job) {
  const precision = segmented.precision && segmented.precision !== "fp32" ? " (" + segmented.precision + ")" : "";
  return (
    String(segmented.model || fallbackName).split("/").pop() +
    " on " +
    segmented.device +
    precision +
    (outlines ? " + " + (job.assistModel || job.polygonModel) : "")
  );
}

// The scene engine is a race (lib/segmentRace.js): the local quantized SegFormer-B5 and OneFormer on Modal, and the scan
// is built from whichever answers first so the designer can start tapping at once. If the local one won and OneFormer
// arrives later, the higher-accuracy scan is built in the background from the SAME Gemini outlines (no second Gemini
// call) and handed to job.onUpgrade(hdScan); the studio offers it as "HD Surface Scan Ready".
//   job.remoteScene   true when the server has OneFormer configured
//   job.modalIsWarm   what the start-up gate learned (true / false / null)
//   job.onUpgrade     (hdScan) => void
//   job.onRaceEvent   ({ type: "start" | "result" | "error" | "skip", engine }) => void
async function detectWithScene(job, notes) {
  const naming = outlinesForNaming(job, notes);
  stage(job, "Parsing the room");
  const segmentStarted = performance.now();
  const blob = await encodeForSegmentation(job.canvas);
  const race = raceSegmentation({
    local: function (signal) {
      return segmentBlob(blob, job.sceneModel, signal);
    },
    remote: job.remoteScene
      ? function (signal) {
          return segmentBlob(blob, "oneformer", signal);
        }
      : null,
    modalIsWarm: job.modalIsWarm,
    signal: job.signal,
    onEvent: job.onRaceEvent,
  });
  const winner = await race.first;
  const segmented = winner.result;
  if (segmented.fellBackFrom) {
    notes.push(
      "The model service could not load SegFormer-B5 (its terminal says why), so SegFormer-B4 scanned this photo.",
    );
  }
  timed(job, "segmentMs", segmentStarted);
  if (job.timings) {
    job.timings.segmentLoadMs = segmented.loadMs || 0;
    job.timings.segmentDevice = segmented.device || "";
    job.timings.segmentEngine = winner.engine;
    job.timings.segmentModel = segmented.model || "";
    job.timings.segmentPrecision = segmented.precision || "";
    job.timings.segmentFellBackFrom = segmented.fellBackFrom || "";
  }
  stage(
    job,
    job.useGeminiAssist
      ? "Splitting walls and naming surfaces"
      : "Refining edges",
  );
  const outlines = await naming;
  if (job.signal && job.signal.aborted) {
    const aborted = new Error("Aborted");
    aborted.name = "AbortError";
    throw aborted;
  }
  stage(job, "Refining edges");
  const buildStarted = performance.now();
  const built = await buildSurfaces(segmented, job.imageData, outlines);
  timed(job, "buildMs", buildStarted);
  const scan = scanFromLabelMap(
    built.labelMap,
    built.metas,
    job.width,
    job.height,
  );
  scan.engine = "scene";
  scan.model = sceneModelText(segmented, job.sceneModel, outlines, job);

  scan.notes = notes;
  if (winner.engine === "local" && job.onUpgrade) {
    race.upgrade
      .then(async function (upgrade) {
        if (!upgrade || (job.signal && job.signal.aborted)) {
          return;
        }
        const hdBuilt = await buildSurfaces(upgrade.result, job.imageData, outlines);
        const hdScan = scanFromLabelMap(hdBuilt.labelMap, hdBuilt.metas, job.width, job.height);
        hdScan.engine = "scene";
        hdScan.model = sceneModelText(upgrade.result, "oneformer", outlines, job);
        hdScan.notes = [];
        job.onUpgrade(hdScan);
      })
      .catch(function (error) {
        console.warn("[swatchroom] the HD scan could not be built:", error);
      });
  }
  return scan;
}

// Run detection for one photo version. Returns a scan with .engine, .model and .notes.
export async function detectSurfaces(job) {
  const engine = job.engine || "scene";
  const notes = [];
  if (engine === "gemini") {
    return detectWithGemini(job, notes);
  }
  try {
    return await detectWithScene(job, notes);
  } catch (error) {
    if ((error && error.name === "AbortError") || !job.fallbackToGemini) {
      throw error;
    }
    console.warn("[swatchroom] scene model service failed, falling back to AI outlines:", error);
    notes.push(
      "The model service failed (" +
        error.message +
        "). AI outlines were used instead.",
    );
    return detectWithGemini(
      Object.assign({}, job, { geminiEngine: "polygon" }),
      notes,
    );
  }
}
