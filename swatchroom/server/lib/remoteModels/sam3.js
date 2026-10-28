// The remote SAM 3 server: "where is each surface?" Hits a Modal-hosted vision_stack.py's
// /v1/segment endpoint (sibling of moge2.js and marigold.js - same calling convention, see
// shared.js). Used only by the fusion pipeline (server/lib/pipelineRunner.js), to score the
// room's own existing scan regions (not to replace their topology - see pipelineRunner.js's
// module comment for why).
//
// Canonical output: {kind, label, score, box: [x0,y0,x1,y1] px, mask: Uint8Array}[], one entry
// per detected instance across all requested prompts, at the server's own (resized) image size
// - the caller is told that size via analyze()'s returned {width, height} so it can resample.
const config = require("../../config");
const shared = require("./shared");
const coldStart = require("../coldStart");
const { PNG } = require("pngjs");

const NAME = "SAM 3 server";
const ENV_HINT = "SAM3_URL";

// Surface kinds fusion fits planes for (server/lib/pipelineRunner.js's FUSION_KINDS) - fusion
// only cares about flat surfaces, never furniture.
const SURFACE_PROMPTS = ["wall", "floor", "ceiling"];

// What one SAM 3 call asks for in the room pipeline: the three surfaces PLUS the things that stand in front of them or hang on
// them. One image-encoder pass serves every prompt, so the extra concepts cost a decoder pass each (milliseconds), not a
// second call. The masks are KEPT (server/lib/samLayer.js): wall instances split a wall into planes, rug / window / door /
// furniture / plant / picture frame / light fixture instances are carved out of the wall and floor they stand on, and the
// tap-to-calibrate step snaps a region's edges to them - all without calling Modal again.
// The combined pool's /v1/analyze takes up to 12 prompts; the dedicated SAM 3 pool's /v1/segment only 8, so the separate
// path sends the first eight (the surfaces and the big obstructions).
const SCENE_PROMPTS = [
  "wall",
  "floor",
  "ceiling",
  "rug",
  "window",
  "door",
  "furniture",
  "plant",
  "picture frame",
  "light fixture",
];
const SEGMENT_ENDPOINT_PROMPTS = SCENE_PROMPTS.slice(0, 8);
// Instances kept per prompt: a room has a handful of walls but dozens of loose objects are not worth keeping.
const MAX_INSTANCES = 6;

// POST to SAM3_URL directly - the configured URL already IS the complete /v1/segment endpoint
// (each Modal service gets its own full domain; see moge2.js's call() for how this was
// confirmed), so nothing is appended to it.
// multipart fields: image + repeated prompt + threshold + max_instances + mask_format +
// max_side. Returns parsed JSON (unlike moge2/marigold, this endpoint's response is JSON, not
// binary).
async function call(imageBuffer, options) {
  const form = new FormData();
  form.append("image", new Blob([imageBuffer], { type: "image/jpeg" }), "photo.jpg");
  ((options && options.prompts) || SEGMENT_ENDPOINT_PROMPTS).forEach(function (prompt) {
    form.append("prompt", prompt);
  });
  form.append("threshold", String((options && options.threshold) || 0.4));
  form.append("max_instances", String((options && options.maxInstances) || MAX_INSTANCES));
  form.append("mask_format", "png");
  form.append("max_side", String((options && options.maxSide) || 1280));
  return coldStart.track("sam3", "analyze", options && options.meta, async function () {
    const response = await shared.callMultipart(config.sam3, NAME, "", form, {
      signal: options && options.signal,
    }, ENV_HINT);
    return { response: response, value: await response.json() };
  });
}

function decodeMask(base64Png, width, height) {
  const png = PNG.sync.read(Buffer.from(base64Png, "base64"));
  const out = new Uint8Array(width * height);
  const count = Math.min(out.length, png.width * png.height);
  for (let i = 0; i < count; i += 1) {
    out[i] = png.data[i * 4] >= 128 ? 1 : 0;
  }
  return out;
}

// Converts the real server's JSON response into the canonical shape above. This is the one
// function that needs to change if the deployed segment contract ever changes.
function normalize(raw) {
  const width = raw.image && raw.image.width;
  const height = raw.image && raw.image.height;
  if (!width || !height || !Array.isArray(raw.results)) {
    throw shared.serviceError(NAME + " did not return a usable response.", 502);
  }
  const detections = [];
  raw.results.forEach(function (group) {
    (group.instances || []).forEach(function (instance) {
      if (!instance.mask || instance.mask.format !== "png_base64") {
        return; // mask_format was "none"/"rle", or this instance genuinely has none
      }
      detections.push({
        kind: String(group.prompt || "").toLowerCase(),
        label: String(group.prompt || ""),
        score: Number(instance.score) || 0,
        box: Array.isArray(instance.box_xyxy) ? instance.box_xyxy : null,
        mask: decodeMask(instance.mask.data, width, height),
      });
    });
  });
  return { width: width, height: height, detections: detections };
}

async function analyze(imageBuffer, options) {
  return normalize(await call(imageBuffer, options));
}

// ---------------------------------------------------------------- mock (no SAM3_URL set)
//
// pipelineRunner.js doesn't call this at all when SAM3_URL is unset - the room's own scan
// regions are used as-is (see regionsFromScan()). Exported anyway so fusion-adjacent code and
// tests can exercise the "detections present" path without a real endpoint, the same way
// moge2.mock()/marigold.mock() do for their adapters.
async function mock(imageBuffer, width, height, options) {
  return { width: width, height: height, detections: [] };
}

module.exports = {
  call: call,
  normalize: normalize,
  analyze: analyze,
  mock: mock,
  decodeMask: decodeMask,
  SURFACE_PROMPTS: SURFACE_PROMPTS,
  SCENE_PROMPTS: SCENE_PROMPTS,
  SEGMENT_ENDPOINT_PROMPTS: SEGMENT_ENDPOINT_PROMPTS,
  MAX_INSTANCES: MAX_INSTANCES,
};
