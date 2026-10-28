// The remote Marigold-IID server: "paint or light?" - splits a photo into colour (albedo) and
// light (shading) layers, such that original ≈ albedo × shading. Hits a Modal-hosted
// vision_stack.py's /v1/decompose endpoint (sibling of moge2.js and sam3.js - same calling
// convention, see shared.js).
//
// Canonical output every caller (server/lib/fusion.js, the browser renderer) works with:
//   {
//     width, height,
//     shading: Float32Array[width*height],  // per-pixel light intensity, 0..1, luminance of
//                                               the server's "shading" visualization PNG
//                                               (see the colour-space note below)
//   }
//
// Colour-space note: the real server can return *colour* shading (the "lighting" checkpoint's
// diffuse-shading target can carry a light tint, not just intensity), but this adapter reduces
// it to luminance rather than carrying RGB through the renderer. Threading a 3-channel shading
// texture through fusion.js's storage, the shader (both WGSL and GLSL) and both GPU backends is
// a real, broader change - deliberately deferred.
//
// ENCODING (read from diffusers' MarigoldImageProcessor.visualize_intrinsics, which writes the PNGs the server
// sends): the "lighting" checkpoint declares shading and residual as prediction_space "linear" with up_to_scale
// true, so each PNG is  (value / max(value)) ** (1 / 2.2)  - max-normalised and gamma-encoded. Reading the PNG
// bytes as if they were linear light (what this adapter did until the "linear-v2" encoding below) makes every
// shading value too bright by a power of 2.2. The value kept here is the linear, relative one:
// (byte / 255) ** 2.2, brightest pixel of the photo = 1. Its absolute scale is unknown by construction, which is
// why the renderer divides by each surface's own median (public/js/lib/fastrender/).
const config = require("../../config");
const shared = require("./shared");
const coldStart = require("../coldStart");
const { unzipSync } = require("fflate");
const { PNG } = require("pngjs");

const NAME = "Marigold-IID server";
const ENV_HINT = "MARIGOLD_URL";

// POST to MARIGOLD_URL directly - the configured URL already IS the complete /v1/decompose
// endpoint (each Modal service gets its own full domain; see moge2.js's call() for how this
// was confirmed), so nothing is appended to it.
// multipart fields: image + model + steps + ensemble + resolution + seed + max_side + raw.
// Returns the raw (unparsed) response body: a zip of PNGs + meta.json, not JSON.
async function call(imageBuffer, options) {
  const form = new FormData();
  form.append("image", new Blob([imageBuffer], { type: "image/jpeg" }), "photo.jpg");
  // "lighting" (not "appearance"): its targets are albedo + diffuse shading + residual, which
  // is the decomposition this renderer needs. "appearance" gives roughness/metallicity instead
  // of shading and is not useful here.
  form.append("model", "lighting");
  form.append("ensemble", "1"); // latency over quality - see the module comment
  // A fixed seed: the pipeline caches geometry/lighting per photo version forever (see
  // server/lib/pipelineRunner.js), so this never needs to be reproduced mid-session, but a
  // fixed seed still means re-analysing the same photo twice gives the same result.
  form.append("seed", "0");
  form.append("raw", "false"); // only the rendered PNGs are needed, not the raw float tensor
  return coldStart.track("marigold", "analyze", options && options.meta, async function () {
    const response = await shared.callMultipart(config.marigold, NAME, "", form, {
      signal: options && options.signal,
    }, ENV_HINT);
    return { response: response, value: Buffer.from(await response.arrayBuffer()) };
  });
}

function decodePng(bytes) {
  return PNG.sync.read(Buffer.from(bytes));
}

// Picks the shading-like output from whatever names meta.json actually lists, rather than
// assuming an exact filename this adapter can't verify without the real server - the targets
// come from the "lighting" checkpoint's own `target_properties`, not from this code.
function findShadingName(names) {
  const exact = names.find(function (name) {
    return name === "shading";
  });
  if (exact) {
    return exact;
  }
  return names.find(function (name) {
    return /shad/i.test(name);
  });
}

// Converts the real server's zip response into the canonical shape above. This is the one
// function that needs to change if the deployed decompose contract ever changes.
function normalize(zipBuffer) {
  let entries;
  try {
    entries = unzipSync(new Uint8Array(zipBuffer));
  } catch (error) {
    throw shared.serviceError(NAME + " did not return a readable .zip file.", 502);
  }
  let meta;
  try {
    meta = JSON.parse(Buffer.from(entries["meta.json"]).toString("utf8"));
  } catch (error) {
    throw shared.serviceError(NAME + "'s response is missing a readable meta.json.", 502);
  }
  const names = Array.isArray(meta.outputs) ? meta.outputs : [];
  const shadingName = findShadingName(names);
  const shadingBytes = shadingName && entries[shadingName + ".png"];
  if (!shadingBytes) {
    throw shared.serviceError(
      NAME + "'s response had no shading-like output among: " + names.join(", ") + ".",
      502,
    );
  }
  const layer = linearLayerFromPng(shadingBytes);
  const out = { width: layer.width, height: layer.height, shading: layer.values };
  const residualName = names.find(function (name) {
    return name === "residual";
  });
  if (residualName && entries[residualName + ".png"]) {
    const residual = linearLayerFromPng(entries[residualName + ".png"]);
    if (residual.width === layer.width && residual.height === layer.height) {
      out.residual = residual.values;
    }
  }
  return out;
}

// One of the max-normalised, gamma-2.2 encoded visualisation PNGs -> linear relative luminance, 0..1 (see ENCODING
// above). Linearises each channel first, then weighs them (Rec. 709), because averaging gamma-encoded values is not
// the luminance of the light.
const LINEAR_FROM_BYTE = new Float32Array(256);
for (let byte = 0; byte < 256; byte += 1) {
  LINEAR_FROM_BYTE[byte] = Math.pow(byte / 255, 2.2);
}
function linearLayerFromPng(pngBytes) {
  const png = decodePng(pngBytes);
  const values = new Float32Array(png.width * png.height);
  for (let i = 0; i < values.length; i += 1) {
    values[i] =
      0.2126 * LINEAR_FROM_BYTE[png.data[i * 4]] +
      0.7152 * LINEAR_FROM_BYTE[png.data[i * 4 + 1]] +
      0.0722 * LINEAR_FROM_BYTE[png.data[i * 4 + 2]];
  }
  return { width: png.width, height: png.height, values: values };
}

// How the shading values stored for a photo version were encoded. Rooms analysed before this change hold the
// gamma-encoded bytes as if they were linear; the browser converts those on load (studio.js loadFusionResult).
const SHADING_ENCODING = "linear-v2";

async function analyze(imageBuffer, options) {
  return normalize(await call(imageBuffer, options));
}

// ---------------------------------------------------------------- mock (no MARIGOLD_URL set)
//
// A smooth, synthetic shading field (soft one-sided falloff, as if lit from a window on the
// left) - not derived from the real photo's pixels, which would need a JPEG/PNG photo decoder
// this project otherwise has no use for. Good enough to exercise the full data flow and the
// renderer's albedo-times-shading multiply end to end; not a claim about what Marigold-IID
// will actually return.
function syntheticShading(width, height) {
  const shading = new Float32Array(width * height);
  for (let py = 0; py < height; py += 1) {
    const vertical = 1 - 0.15 * Math.abs(py / height - 0.5) * 2; // slightly brighter mid-height
    for (let px = 0; px < width; px += 1) {
      const horizontal = 0.75 + 0.5 * (1 - px / width); // brighter toward the left (the "window")
      shading[py * width + px] = horizontal * vertical;
    }
  }
  return shading;
}

async function mock(imageBuffer, width, height) {
  return { width: width, height: height, shading: syntheticShading(width, height), residual: null };
}

module.exports = {
  call: call,
  normalize: normalize,
  analyze: analyze,
  mock: mock,
  linearLayerFromPng: linearLayerFromPng,
  SHADING_ENCODING: SHADING_ENCODING,
};
