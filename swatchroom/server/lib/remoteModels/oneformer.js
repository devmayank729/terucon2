// The remote OneFormer server: "what is every pixel of this room?" Swin-L trained on ADE20K (150 classes), hosted by
// modalBlueprint.py (POST /v1/oneformer, the same handler as /v1/parse; on the combined pool it sits next to MoGe-2,
// Marigold and SAM 3). It is the high-accuracy engine of the SCAN, racing the local quantized SegFormer-B5
// (public/js/lib/segmentRace.js); sibling of sam3.js / moge2.js / marigold.js with the same calling convention
// (shared.js).
//
// Canonical output:
//   {
//     width, height,
//     labelMap:   Uint8Array[width*height]     ADE20K class id (0-149) per pixel - the semantic task
//     classes:    [{id, label, pixels, fraction}]   the classes that occur, biggest first
//     segmentMap: Uint8Array[width*height]|null    panoptic segment id per pixel (0 = void). Stuff classes (wall, floor,
//                                                  ceiling...) are ONE segment per class; every window, door and
//                                                  piece of furniture is its own
//     segments:   [{id, labelId, label, isThing, score, area, box:[x0,y0,x1,y1]}]
//   }
// The wall planes of a room are NOT separated here (a panoptic model merges a "stuff" class), they come from SAM 3 +
// MoGe-2 depth in the room pipeline (server/lib/planeSplit.js).
const config = require("../../config");
const shared = require("./shared");
const coldStart = require("../coldStart");
const { PNG } = require("pngjs");

const NAME = "OneFormer server";
const ENV_HINT = "ONEFORMER_URL";

// POST to ONEFORMER_URL as it is (the complete /v1/oneformer endpoint, see sam3.js's call()).
// multipart: image + task (repeated) + max_side + tta. Returns parsed JSON.
async function call(imageBuffer, options) {
  const opts = options || {};
  const form = new FormData();
  form.append("image", new Blob([imageBuffer], { type: "image/jpeg" }), "photo.jpg");
  form.append("task", "semantic");
  if (opts.panoptic !== false) {
    form.append("task", "panoptic");
  }
  form.append("max_side", String(opts.maxSide || config.oneformer.maxSide));
  form.append("mask_format", "none");
  form.append("tta", opts.tta !== undefined ? String(!!opts.tta) : String(!!config.oneformer.tta));
  return coldStart.track("oneformer", "segment", opts.meta, async function () {
    const response = await shared.callMultipart(config.oneformer, NAME, "", form, {
      signal: opts.signal,
    }, ENV_HINT);
    return { response: response, value: await response.json() };
  });
}

// A single-channel 8-bit PNG (the server writes label maps with cv2.imencode) -> Uint8Array. pngjs hands back RGBA, so
// the value is the red byte.
function decodeIdMap(base64Png, width, height, what) {
  let png;
  try {
    png = PNG.sync.read(Buffer.from(base64Png, "base64"));
  } catch (error) {
    throw shared.serviceError(NAME + " sent a " + what + " that is not a readable PNG.", 502);
  }
  if (png.width !== width || png.height !== height) {
    throw shared.serviceError(
      NAME + " sent a " + what + " of " + png.width + "x" + png.height + " for a " + width + "x" + height + " photo.",
      502,
    );
  }
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = png.data[i * 4];
  }
  return out;
}

// Converts the real server's JSON into the canonical shape above. This is the one function that has to change if the
// deployed /v1/oneformer contract ever changes.
function normalize(raw) {
  const width = raw && raw.image && raw.image.width;
  const height = raw && raw.image && raw.image.height;
  const semantic = raw && raw.results && raw.results.semantic;
  if (!width || !height || !semantic || !semantic.label_map || semantic.label_map.format !== "png_base64") {
    throw shared.serviceError(NAME + " did not return a usable semantic map.", 502);
  }
  const result = {
    width: width,
    height: height,
    labelMap: decodeIdMap(semantic.label_map.data, width, height, "semantic map"),
    classes: (semantic.classes || []).map(function (entry) {
      return { id: entry.id, label: String(entry.label || ""), pixels: entry.pixels, fraction: entry.fraction };
    }),
    segmentMap: null,
    segments: [],
  };
  const panoptic = raw.results.panoptic;
  if (panoptic && panoptic.segment_map && panoptic.segment_map.format === "png_base64") {
    result.segmentMap = decodeIdMap(panoptic.segment_map.data, width, height, "segment map");
    result.segments = (panoptic.segments || []).map(function (segment) {
      return {
        id: segment.id,
        labelId: segment.label_id,
        label: String(segment.label || ""),
        isThing: !!segment.isthing,
        score: Number(segment.score) || 0,
        area: Number(segment.area) || 0,
        box: Array.isArray(segment.box_xyxy) ? segment.box_xyxy : null,
      };
    });
  }
  return result;
}

async function segment(imageBuffer, options) {
  return normalize(await call(imageBuffer, options));
}

// A stand-in with the same shape, for tests and a development stack without ONEFORMER_URL: ceiling on top, a back
// wall, a floor at the bottom and one "door" in the wall. (ADE20K ids: wall 0, floor 3, ceiling 5, door 14.)
function mock(width, height) {
  const labelMap = new Uint8Array(width * height);
  const segmentMap = new Uint8Array(width * height);
  const ceilingEnd = Math.floor(height * 0.2);
  const floorStart = Math.floor(height * 0.7);
  const doorLeft = Math.floor(width * 0.4);
  const doorRight = Math.floor(width * 0.55);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (y < ceilingEnd) {
        labelMap[i] = 5;
        segmentMap[i] = 1;
      } else if (y >= floorStart) {
        labelMap[i] = 3;
        segmentMap[i] = 3;
      } else if (x >= doorLeft && x < doorRight && y > height * 0.35) {
        labelMap[i] = 14;
        segmentMap[i] = 4;
      } else {
        labelMap[i] = 0;
        segmentMap[i] = 2;
      }
    }
  }
  return {
    width: width,
    height: height,
    labelMap: labelMap,
    classes: [],
    segmentMap: segmentMap,
    segments: [
      { id: 1, labelId: 5, label: "ceiling", isThing: false, score: 0.9, area: 0, box: null },
      { id: 2, labelId: 0, label: "wall", isThing: false, score: 0.9, area: 0, box: null },
      { id: 3, labelId: 3, label: "floor", isThing: false, score: 0.9, area: 0, box: null },
      { id: 4, labelId: 14, label: "door", isThing: true, score: 0.9, area: 0, box: null },
    ],
  };
}

module.exports = {
  call: call,
  normalize: normalize,
  segment: segment,
  mock: mock,
  decodeIdMap: decodeIdMap,
};
