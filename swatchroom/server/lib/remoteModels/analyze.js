// The remote room analysis: MoGe-2 depth + Marigold lighting + SAM 3 masks for ONE photo in ONE request to ONE pool
// (modalBlueprint.py's VisionAll, POST /v1/analyze). Sibling of moge2.js / marigold.js / sam3.js, whose normalizers it
// reuses on the three parts of the zip it gets back. Used by server/lib/pipelineRunner.js (stage A) when ANALYZE_URL is
// set; without it the pipeline makes the three separate calls it always made.
//
// Why one call: every Modal pool bills its idle tail after the last request, so a photo that touches three pools pays
// three tails and three possible cold starts; one pool pays one. And the pool is the same one the scan's OneFormer
// call already woke, so by the time the room pipeline runs it is warm.
//
// Canonical output:
//   {
//     geometry: moge2.normalize()'s  { width, height, depth, intrinsics, up },
//     lighting: { width, height, shading: Float32Array (linear, relative), residual?: Float32Array },
//     sam:      sam3.normalize()'s  { width, height, detections },
//     meta:     { gpu, timing }                        what the server says about itself
//   }
const config = require("../../config");
const shared = require("./shared");
const coldStart = require("../coldStart");
const moge2 = require("./moge2");
const marigold = require("./marigold");
const sam3 = require("./sam3");
const { unzipSync } = require("fflate");

const NAME = "room analysis server";
const ENV_HINT = "ANALYZE_URL";

// multipart: image + max_side + prompt (repeated) + threshold + max_instances + resolution_level. Returns the zip.
async function call(imageBuffer, options) {
  const opts = options || {};
  const form = new FormData();
  form.append("image", new Blob([imageBuffer], { type: "image/jpeg" }), "photo.jpg");
  form.append("max_side", String(opts.maxSide || 1280));
  form.append("resolution_level", "9");
  (opts.prompts || sam3.SCENE_PROMPTS).forEach(function (prompt) {
    form.append("prompt", prompt);
  });
  form.append("threshold", "0.4");
  form.append("max_instances", String(sam3.MAX_INSTANCES));
  return coldStart.track("analyze", "analyze", opts.meta, async function () {
    const response = await shared.callMultipart(config.analyze, NAME, "", form, { signal: opts.signal }, ENV_HINT);
    return { response: response, value: Buffer.from(await response.arrayBuffer()) };
  });
}

function normalize(zipBuffer) {
  let entries;
  try {
    entries = unzipSync(new Uint8Array(zipBuffer));
  } catch (error) {
    throw shared.serviceError("The " + NAME + " did not return a readable .zip file.", 502);
  }
  function need(name) {
    if (!entries[name]) {
      throw shared.serviceError("The " + NAME + "'s response is missing " + name + ".", 502);
    }
    return entries[name];
  }
  let meta = {};
  try {
    meta = JSON.parse(Buffer.from(need("meta.json")).toString("utf8"));
  } catch (error) {
    if (error && error.status) {
      throw error;
    }
    throw shared.serviceError("The " + NAME + "'s meta.json is not readable.", 502);
  }
  const geometry = moge2.normalize(Buffer.from(need("geometry.npz")));
  const shading = marigold.linearLayerFromPng(need("shading.png"));
  const lighting = { width: shading.width, height: shading.height, shading: shading.values };
  if (entries["residual.png"]) {
    const residual = marigold.linearLayerFromPng(entries["residual.png"]);
    if (residual.width === shading.width && residual.height === shading.height) {
      lighting.residual = residual.values;
    }
  }
  let samJson;
  try {
    samJson = JSON.parse(Buffer.from(need("sam3.json")).toString("utf8"));
  } catch (error) {
    if (error && error.status) {
      throw error;
    }
    throw shared.serviceError("The " + NAME + "'s sam3.json is not readable.", 502);
  }
  return { geometry: geometry, lighting: lighting, sam: sam3.normalize(samJson), meta: meta };
}

async function analyze(imageBuffer, options) {
  return normalize(await call(imageBuffer, options));
}

// The three mocks together, in the same shape (PIPELINE_MOCK=on, or a development stack without ANALYZE_URL).
async function mock(imageBuffer, width, height) {
  return {
    geometry: await moge2.mock(imageBuffer, width, height),
    lighting: await marigold.mock(imageBuffer, width, height),
    sam: await sam3.mock(imageBuffer, width, height),
    meta: { mock: true },
  };
}

module.exports = { call: call, normalize: normalize, analyze: analyze, mock: mock };
