// One render: the selected surface(s) of a photo version + a finish -> 1 to 3 new versions.
// The images are prepared here in the browser; the server sends them to Gemini.
//
// Steps per option:
//  1. Base canvas of the version (2048 px, or 4096 px for 4K renders).
//  2. For small surfaces, a close crop around them (more pixels on target).
//  3. Send photo + mask (+ a magenta guide image) + brief to the image model.
//  4. Align the returned image back onto the input (models sometimes reframe a little).
//  5. Keep two results: the full output, and a "selection only" blend where every pixel outside
//     the (feathered) mask is the original.

import { generate, noImageMessage, readResponse } from "./ai.js";
import { geometryForImage } from "./geometryFacts.js";
import { releaseCanvas, workingCanvasSide } from "./platform.js";
import {
  base64ToBlob,
  blendIntoBase,
  canvasAtMost,
  canvasToBase64,
  canvasToBlob,
  drawToCanvas,
  loadImage,
  maskCanvas,
  nearestAspectRatio,
} from "./images.js";
import {
  alignOutput,
  aspectChanged,
  boxInCrop,
  cutCrop,
  focusCrop,
  guideImage,
  placeOutput,
  polygonInCrop,
  regionFactsInCrop,
} from "./framing.js";
import { RENDER_SYSTEM_PROMPT, renderBrief } from "./prompts.js";
import { regionBox, traceOutline } from "./regions.js";
import { renderSizeFor } from "./settings.js";

// How far the mask is grown past the surface's edge, as a share of the photo's short side. Models bleed a little past a mask,
// so it is grown a touch; where the edge was SAM-sharpened (samCalibrate.js) it is already right, and 0.2% is enough.
export const MASK_GROW_SHARE = 0.004;
export const MASK_GROW_SHARE_SHARP = 0.002;

// The instant preview (a PNG of the preview canvas, which covers the whole photo) as a canvas the size of what is sent:
// cropped like the photo when the render is a close crop, resized when the whole photo is sent.
async function previewCanvasFor(blob, base, crop, sendCanvas) {
  const url = URL.createObjectURL(blob);
  let image;
  try {
    image = await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const full = drawToCanvas(image, base.width, base.height);
  let sent;
  if (crop) {
    sent = cutCrop(full, crop, crop.outWidth, crop.outHeight, false);
  } else if (full.width === sendCanvas.width && full.height === sendCanvas.height) {
    return full;
  } else {
    sent = drawToCanvas(full, sendCanvas.width, sendCanvas.height);
  }
  releaseCanvas(full);
  return sent;
}

// Prepare everything that is the same for every option of one render.
//   input.region     the surface; its mask is already the calibrated one (SAM-sharpened edge, rugs / furniture carved out)
//   input.sharpEdges the edge was snapped to SAM's, so the mask only needs a thin grow
//   input.geometry   what the room pipeline measured about this surface (lib/geometryFacts.js surfaceGeometry()) or null
//   input.preview    a PNG Blob of the instant 3D preview as it is on screen, or null
export async function prepareRender(input) {
  const settings = input.settings;
  const scan = input.scan;
  const region = input.region;
  const size = renderSizeFor(settings);
  // On an iPhone / iPad the several working canvases of a 4K render do not fit in WebKit's canvas memory, so the working
  // size is capped there (and, less tightly, on any phone); the result is still placed in the photo at this size.
  const workSide = workingCanvasSide(size === "4K" ? 4096 : settings.uploadMaxSide || 2048);
  const versionImage = await loadImage(input.versionUrl);
  const base = canvasAtMost(versionImage, workSide);
  const sendSide = Math.min(settings.uploadMaxSide || 2048, workSide);
  const lite = String(settings.imageModel || "").indexOf("lite") !== -1;
  const growShare = input.sharpEdges ? MASK_GROW_SHARE_SHARP : MASK_GROW_SHARE;

  const crop = focusCrop(
    region,
    scan.width,
    scan.height,
    base.width,
    base.height,
  );
  const fullMask = maskCanvas(
    region.mask,
    scan.width,
    scan.height,
    base.width,
    base.height,
    Math.round(Math.min(base.width, base.height) * growShare),
  );
  let sendCanvas;
  let sendMask;
  if (crop) {
    sendCanvas = cutCrop(base, crop, crop.outWidth, crop.outHeight, false);
    sendMask = cutCrop(fullMask, crop, crop.outWidth, crop.outHeight, true);
    releaseCanvas(fullMask);
  } else if (Math.max(base.width, base.height) > sendSide) {
    sendCanvas = canvasAtMost(base, sendSide);
    sendMask = maskCanvas(
      region.mask,
      scan.width,
      scan.height,
      sendCanvas.width,
      sendCanvas.height,
      Math.round(Math.min(sendCanvas.width, sendCanvas.height) * growShare),
    );
    releaseCanvas(fullMask);
  } else {
    sendCanvas = base;
    sendMask = fullMask;
  }

  const outline =
    settings.sendPolygon && !region.isUnion
      ? polygonInCrop(traceOutline(region, scan.width, scan.height, 48), crop)
      : null;
  const box = boxInCrop(regionBox(region, scan.width, scan.height), crop);
  const facts = crop
    ? regionFactsInCrop(region, scan.width, scan.height, crop)
    : {
        centerX: (region.centroid.x / scan.width) * 1000,
        centerY: (region.centroid.y / scan.height) * 1000,
        areaShare: region.areaShare,
      };
  // the 3D facts, in the pixels of the image the model will see
  let guidePreview = null;
  if (!lite && input.preview && input.geometry) {
    try {
      guidePreview = await previewCanvasFor(input.preview, base, crop, sendCanvas);
    } catch (error) {
      guidePreview = null; // the guide simply falls back to the plain tint
    }
  }
  const pixelsPerScanPixel = crop
    ? (base.width / scan.width) * (crop.outWidth / crop.w)
    : (base.width / scan.width) * (sendCanvas.width / base.width);
  const geometry = input.geometry
    ? geometryForImage(input.geometry, pixelsPerScanPixel, { previewShown: !!guidePreview })
    : null;
  const brief = renderBrief({
    width: sendCanvas.width,
    height: sendCanvas.height,
    crop: !!crop,
    guide: !lite,
    geometry: geometry,
    label: region.label,
    kind: region.kind,
    partCount: region.isUnion ? region.partIds.length : 1,
    box: box,
    polygon: outline,
    areaShare: facts.areaShare,
    centerX: facts.centerX,
    centerY: facts.centerY,
    item: input.item,
    style: input.style,
    notes: input.notes,
  });
  const aspectRatio = nearestAspectRatio(sendCanvas.width, sendCanvas.height);
  const parts = [
    {
      inlineData: {
        mimeType: "image/jpeg",
        data: canvasToBase64(sendCanvas, "image/jpeg", 0.92),
      },
    },
    {
      inlineData: {
        mimeType: "image/png",
        data: canvasToBase64(sendMask, "image/png"),
      },
    },
  ];
  if (!lite) {
    const guide = guideImage(sendCanvas, sendMask, guidePreview);
    parts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: canvasToBase64(guide, "image/jpeg", 0.9),
      },
    });
    releaseCanvas(guide);
  }
  releaseCanvas(guidePreview);
  return {
    base: base,
    crop: crop,
    sendCanvas: sendCanvas,
    sendMask: sendMask,
    parts: parts,
    brief: brief,
    aspectRatio: aspectRatio,
    imageSize: size,
    box: box,
    polygon: outline,
    systemPrompt: RENDER_SYSTEM_PROMPT,
    inputSize: base.width + " x " + base.height,
    geometry: geometry,
    guideHadPreview: !!guidePreview,
  };
}

// Gives the working canvases of a finished render back to the browser (see releaseCanvas). The studio calls it when every
// option of one render is done.
export function releasePrepared(prepared) {
  if (!prepared) {
    return;
  }
  [prepared.sendMask, prepared.sendCanvas, prepared.base].forEach(function (canvas) {
    releaseCanvas(canvas);
  });
}

// Render one option. Resolves to blobs for the full output and the selection-only blend.
export async function renderOption(input, prepared) {
  const started = performance.now();
  const answer = await generate(
    {
      task: "image",
      model: input.settings.imageModel,
      location: input.settings.location,
      parts: prepared.parts,
      brief: prepared.brief,
      systemPrompt: prepared.systemPrompt,
      aspectRatio: prepared.aspectRatio,
      imageSize: prepared.imageSize,
    },
    input.signal,
  );
  const parsed = readResponse(answer.response);
  if (parsed.images.length === 0) {
    throw new Error(noImageMessage(parsed, answer.model));
  }
  const last = parsed.images[parsed.images.length - 1];
  const outputBlob = await base64ToBlob(last.data, last.mimeType);
  const outputUrl = URL.createObjectURL(outputBlob);
  let output;
  try {
    output = await loadImage(outputUrl);
  } finally {
    URL.revokeObjectURL(outputUrl);
  }
  const alignment = alignOutput(prepared.sendCanvas, output, prepared.sendMask);
  const placed = placeOutput(prepared.base, output, alignment, prepared.crop);
  const framingWarning = alignment.skip
    ? !prepared.crop &&
      aspectChanged(
        prepared.sendCanvas.width,
        prepared.sendCanvas.height,
        output.naturalWidth,
        output.naturalHeight,
      )
    : alignment.err > 0.62;
  const blended = blendIntoBase(
    prepared.base,
    placed,
    input.region.mask,
    input.scan.width,
    input.scan.height,
  );
  const rawBlob = await canvasToBlob(placed, "image/jpeg", 0.95);
  const blendBlob = await canvasToBlob(blended, "image/jpeg", 0.95);
  // both are encoded: free their pixels now rather than whenever the garbage collector gets to them
  releaseCanvas(placed);
  releaseCanvas(blended);
  return {
    rawBlob: rawBlob,
    blendBlob: blendBlob,
    framingWarning: framingWarning,
    rawWidth: output.naturalWidth,
    rawHeight: output.naturalHeight,
    durationMs: Math.round(performance.now() - started),
    modelText: parsed.texts.join("\n").trim(),
    attempt: answer.attempt,
    usage: parsed.usage,
    model: answer.model,
  };
}
