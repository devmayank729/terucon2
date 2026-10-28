// The models that read the photo, through this server. The browser never talks to them directly: it sends photos here
// and the server forwards them, like a reception desk passing documents to the right office.
//
//   POST /api/vision/segment?model=b5-quant   raw photo -> class per pixel, the LOCAL quantized SegFormer-B5 (Python)
//   POST /api/vision/segment?model=oneformer  raw photo -> the same shape from OneFormer on Modal (+ instance ids)
//   POST /api/vision/pick/embed?key=...   raw photo  -> prepares Pick for that photo
//   POST /api/vision/pick/mask            { key, points, labels, box? } -> mask
//   GET  /api/vision/warmup               is the Modal pool the scan uses warm? (answered without calling Modal)
//   POST /api/vision/warmup               { what, model } load a local model ahead of the first request
//   GET  /api/vision/health
const express = require("express");
const config = require("../config");
const coldStart = require("../lib/coldStart");
const warmth = require("../lib/warmth");
const wake = require("../lib/wake");
const oneformer = require("../lib/remoteModels/oneformer");
const sceneNormalize = require("../lib/sceneNormalize");

const router = express.Router();
const rawPhoto = express.raw({
  type: ["image/*", "application/octet-stream"],
  limit: config.limits.file,
});

function serviceError(message, status) {
  const error = new Error(message);
  error.status = status || 502;
  return error;
}

function modelHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  if (config.models.key) {
    headers["X-Model-Key"] = config.models.key;
  }
  return headers;
}

async function readAnswer(response, what) {
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  if (!response.ok) {
    const detail = body && (body.detail || body.error || body.message);
    throw serviceError(
      what +
        " failed (" +
        response.status +
        ")" +
        (detail
          ? ": " +
            (typeof detail === "string" ? detail : JSON.stringify(detail))
          : "."),
      response.status === 409 ? 409 : 502,
    );
  }
  return body;
}

async function callModels(path, options, what) {
  let response;
  try {
    response = await fetch(config.models.url + path, options);
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw error;
    }
    throw serviceError(
      "The model service is not running at " +
        config.models.url +
        ". Start it with: cd python && uvicorn app:app --port 8001",
      503,
    );
  }
  return readAnswer(response, what);
}

function photoForm(request, fields) {
  if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
    throw serviceError("No photo was sent.", 400);
  }
  const form = new FormData();
  const type = String(request.headers["content-type"] || "image/jpeg");
  form.append("image", new Blob([request.body], { type: type }), "photo.jpg");
  Object.keys(fields).forEach(function (name) {
    form.append(name, fields[name]);
  });
  return form;
}

function abortOnClose(response) {
  const controller = new AbortController();
  response.on("close", function () {
    if (!response.writableEnded) {
      controller.abort();
    }
  });
  return controller.signal;
}

// OneFormer on Modal, answered in the shape python/app.py's /scene/segment sends (classMap + classLabels, so
// scene.worker.js reads either engine), plus what only OneFormer has: the id of the individual window / door / piece of
// furniture each pixel belongs to. Ids are translated to SegFormer's class names (lib/ade20k.js) so the scene worker
// groups them the same way.
async function segmentWithOneFormer(request, response) {
  if (!config.oneformer.url) {
    throw serviceError("No OneFormer is configured. Set ONEFORMER_URL in .env.", 404);
  }
  if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
    throw serviceError("No photo was sent.", 400);
  }
  const startedAt = Date.now();
  // This request wakes OneFormer's pool; the pools the room pipeline will need boot in the same wave.
  wake.wake({ scanUsesOneFormer: true });
  const result = await oneformer.segment(request.body, {
    signal: abortOnClose(response),
    meta: { kind: "scan" },
  });
  const scene = sceneNormalize.toSceneSchema(result.labelMap);
  const things = result.segments.filter(function (segment) {
    return segment.isThing;
  });
  const wallMs = Date.now() - startedAt;
  response.json({
    width: result.width,
    height: result.height,
    classMap: sceneNormalize.packBytes(scene.classMap),
    classLabels: scene.classLabels,
    classIds: scene.classIds,
    instanceMap: result.segmentMap
      ? sceneNormalize.packBytes(sceneNormalize.thingInstanceMap(result.segmentMap, result.segments))
      : null,
    instances: things.map(function (segment) {
      return { id: segment.id, labelId: segment.labelId, label: segment.label, score: segment.score, area: segment.area };
    }),
    model: "oneformer_ade20k_swin_large",
    device: "modal",
    tiles: 1,
    ms: wallMs,
    loadMs: 0,
    inferMs: wallMs,
  });
}

router.post("/vision/segment", rawPhoto, async function (request, response) {
  const model = String(request.query.model || "b4").slice(0, 80);
  if (model === "oneformer") {
    await segmentWithOneFormer(request, response);
    return;
  }
  const startedAt = Date.now();
  const answer = await callModels(
    "/scene/segment",
    {
      method: "POST",
      headers: modelHeaders(),
      body: photoForm(request, { model: model }),
      signal: abortOnClose(response),
    },
    "Scene parsing",
  );
  // The service says how long it spent loading the model (its cold start) and how long on the
  // photo itself; the owner-only dot shows the split (server/lib/coldStart.js).
  coldStart.noteScene({
    wallMs: Date.now() - startedAt,
    processMs: answer && answer.inferMs !== undefined ? answer.inferMs : answer && answer.ms,
    loadMs: answer && answer.loadMs,
    device: answer && answer.device,
  });
  response.json(answer);
});

router.post("/vision/pick/embed", rawPhoto, async function (request, response) {
  const key = String(request.query.key || "").slice(0, 120);
  if (!key) {
    throw serviceError("The Pick tool needs a photo key.", 400);
  }
  const answer = await callModels(
    "/pick/embed",
    {
      method: "POST",
      headers: modelHeaders(),
      body: photoForm(request, { key: key }),
      signal: abortOnClose(response),
    },
    "Preparing the Pick tool",
  );
  response.json(answer);
});

router.post(
  "/vision/pick/mask",
  express.json({ limit: "200kb" }),
  async function (request, response) {
    const body = request.body || {};
    const forwarded = {
      key: String(body.key || ""),
      points: Array.isArray(body.points) ? body.points.slice(0, 40) : [],
      labels: Array.isArray(body.labels) ? body.labels.slice(0, 40) : [],
    };
    // An optional box prompt [x0, y0, x1, y1] in photo pixels: the tap-to-calibrate step sends the surface's box.
    if (
      Array.isArray(body.box) &&
      body.box.length === 4 &&
      body.box.every(function (value) {
        return Number.isFinite(Number(value));
      })
    ) {
      forwarded.box = body.box.map(Number);
    }
    const answer = await callModels(
      "/pick/mask",
      {
        method: "POST",
        headers: modelHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(forwarded),
      },
      "Pick",
    );
    response.json(answer);
  },
);

// Is the Modal pool the scan uses warm? Answered from this server's own record of its last call to it (lib/warmth.js),
// so it costs nothing and never wakes a billed GPU: the page asks this the moment it loads, whether or not the visitor
// ever uploads a photo. (VISION_ACTIVE_WARMUP=on additionally sends one /healthz when the pool looks cold.)
router.get("/vision/warmup", async function (request, response) {
  let status = warmth.status();
  if (config.vision.activeWarmup && status.configured && !status.warm) {
    const probed = await warmth.probe({ timeoutMs: 9000 });
    status = Object.assign(warmth.status(), { mode: "probe", probed: probed.probed });
  }
  response.setHeader("Cache-Control", "no-store");
  response.json(status);
});

router.post(
  "/vision/warmup",
  express.json({ limit: "10kb" }),
  async function (request, response) {
    const body = request.body || {};
    const answer = await callModels(
      "/warmup",
      {
        method: "POST",
        headers: modelHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          what: body.what === "pick" ? "pick" : "scene",
          model: String(body.model || "b4").slice(0, 80),
        }),
      },
      "Loading the models",
    );
    response.json(answer);
  },
);

router.get("/vision/health", async function (request, response) {
  const answer = await callModels(
    "/health",
    { headers: modelHeaders(), signal: AbortSignal.timeout(90000) },
    "Model service",
  );
  response.json(answer);
});

module.exports = router;
