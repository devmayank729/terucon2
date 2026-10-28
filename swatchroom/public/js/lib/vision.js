// The local models, through the server: scene parsing and the Pick tool run in the Python
// model service; turning the class map into surfaces runs in a worker in this browser.

import {
  ApiError,
  getJson,
  postJson,
  sendBytes,
  unpackBytes,
} from "../core/api.js";
import { canvasToBlob } from "./images.js";

let worker = null;
let nextJob = 0;
const waiting = new Map();

function getWorker() {
  if (worker) {
    return worker;
  }
  worker = new Worker(new URL("../workers/scene.worker.js", import.meta.url), {
    name: "swatchroom-scene",
  });
  worker.onmessage = function (event) {
    const data = event.data;
    const job = waiting.get(data.id);
    if (!job) {
      return;
    }
    waiting.delete(data.id);
    if (data.type === "result") {
      job.resolve(data.result);
    } else {
      job.reject(new Error(data.message));
    }
  };
  worker.onerror = function (event) {
    const problem = new Error(
      "The surface worker stopped: " +
        (event.message || "unknown error") +
        ". Reload the page and try again.",
    );
    waiting.forEach(function (job) {
      job.reject(problem);
    });
    waiting.clear();
    worker = null;
  };
  return worker;
}

// Step 1: a model labels every pixel (wall, floor, sofa...). The photo is encoded once and can be sent to more than
// one engine (the scan races the local model against OneFormer on Modal, lib/segmentRace.js).
// The service shrinks the photo to the model's own size anyway, so a lighter JPEG costs nothing in accuracy and is a
// third of the bytes to send from a phone.
export function encodeForSegmentation(canvas) {
  return canvasToBlob(canvas, "image/jpeg", 0.85);
}

// blob: from encodeForSegmentation(). model: "b5-quant" (the local default), "b5", "b4", "b2" -> the Python service;
// "oneformer" -> OneFormer on Modal, through the same server route. Resolves to
// { classMap, classLabels, width, height, device, model, ms, loadMs, instanceMap? } - the same shape for every engine.
export async function segmentBlob(blob, model, signal) {
  const answer = await sendBytes(
    "POST",
    "/vision/segment?model=" + encodeURIComponent(model || "b5-quant"),
    blob,
    "image/jpeg",
    signal,
  );
  const classMap = await unpackBytes(answer.classMap);
  if (classMap.length !== answer.width * answer.height) {
    throw new Error("The model service sent a class map of the wrong size.");
  }
  let instanceMap = null;
  if (answer.instanceMap) {
    instanceMap = await unpackBytes(answer.instanceMap);
    if (instanceMap.length !== classMap.length) {
      instanceMap = null; // a wrong-sized instance map is dropped, the class map alone is still a valid scan
    }
  }
  return {
    classMap: classMap,
    classLabels: answer.classLabels,
    instanceMap: instanceMap,
    width: answer.width,
    height: answer.height,
    device: answer.device,
    model: answer.model,
    precision: answer.precision || "",
    // set when the service answered with a smaller model than asked for (B5 could not be loaded)
    fellBackFrom: answer.fellBackFrom || "",
    // How long the service spent on the photo, and on getting the model ready first (its cold
    // start), as it measured them.
    ms: answer.ms || 0,
    loadMs: answer.loadMs || 0,
  };
}

// canvas: the photo at analysis size. Resolves to { classMap, classLabels, width, height, device }.
export async function segmentScene(canvas, model, signal) {
  return segmentBlob(await encodeForSegmentation(canvas), model, signal);
}

// Step 2: classes become surfaces (in a worker). outlines: Gemini's outlines, or null.
export function buildSurfaces(segmented, imageData, outlines) {
  nextJob += 1;
  const id = "job" + nextJob;
  const classMap = segmented.classMap.slice();
  const pixels = new Uint8ClampedArray(imageData.data);
  const instanceMap = segmented.instanceMap ? segmented.instanceMap.slice() : null;
  return new Promise(function (resolve, reject) {
    waiting.set(id, { resolve: resolve, reject: reject });
    const transfer = [classMap.buffer, pixels.buffer];
    if (instanceMap) {
      transfer.push(instanceMap.buffer);
    }
    getWorker().postMessage(
      {
        id: id,
        width: segmented.width,
        height: segmented.height,
        classMap: classMap.buffer,
        classLabels: segmented.classLabels,
        rgba: pixels.buffer,
        gemini: outlines || null,
        instanceMap: instanceMap ? instanceMap.buffer : null,
      },
      transfer,
    );
  });
}

// Pick, step 1: the model service reads the photo once (a few seconds on a CPU).
export async function preparePick(canvas, key) {
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
  return sendBytes(
    "POST",
    "/vision/pick/embed?key=" + encodeURIComponent(key),
    blob,
    "image/jpeg",
  );
}

// Pick, step 2: a mask for the taps. points are in pixels of the prepared photo.
// If the service has forgotten the photo (it keeps the last few), prepare it again.
// box (optional): [x0, y0, x1, y1] in the same pixels, a box prompt SAM combines with the points.
export async function maskForTaps(key, points, labels, canvasForRetry, box) {
  const body = { key: key, points: points, labels: labels };
  if (box) {
    body.box = box;
  }
  let answer;
  try {
    answer = await postJson("/vision/pick/mask", body);
  } catch (error) {
    if (
      !(error instanceof ApiError && error.httpStatus === 409) ||
      !canvasForRetry
    ) {
      throw error;
    }
    await preparePick(canvasForRetry, key);
    answer = await postJson("/vision/pick/mask", body);
  }
  return {
    mask: await unpackBytes(answer.mask),
    width: answer.width,
    height: answer.height,
    score: answer.score,
  };
}

// Load the LOCAL scene model ahead of the first scan (the Python service; nothing on Modal). Errors are ignored.
export function warmUpModels(model) {
  return postJson("/vision/warmup", { what: "scene", model: model }).catch(
    function () {
      return null;
    },
  );
}

export function modelHealth() {
  return getJson("/vision/health");
}
