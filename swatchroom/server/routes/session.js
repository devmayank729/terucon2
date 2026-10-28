// Studio sign-in (optional passcode) and the Settings > Check report.
//   GET    /api/session   what the studio needs to know before it opens
//   POST   /api/session   { passcode } -> signed cookie
//   DELETE /api/session   sign out
//   POST   /api/check     test Google, the model service, the pipeline's three remote models
//                         (SAM 3, MoGe-2, Marigold-IID) and MongoDB
const express = require("express");
const mongoose = require("mongoose");
const config = require("../config");
const access = require("../lib/access");
const adminAuth = require("../lib/adminAuth");
const db = require("../db");
const googleToken = require("../google/token");
const vertex = require("../google/vertex");
const Room = require("../models/Room");
const remoteShared = require("../lib/remoteModels/shared");

const router = express.Router();
const packageInfo = require("../../package.json");

router.get("/session", async function (request, response) {
  const google = googleToken.describe();
  response.json({
    version: packageInfo.version,
    passcodeRequired: !!config.passcode,
    signedIn: access.isSignedIn(request),
    // Whether THIS browser is signed in at /admin (its own cookie, see lib/adminAuth.js). Only
    // the owner's browser turns the cold-start dot on (public/js/views/ownerDot.js); for anyone
    // else it is false and the dot's code never runs, and what it would show is behind the
    // admin-only /api/admin/coldstart.
    owner: adminAuth.isSignedIn(request),
    // This route is public (it runs before sign-in), so it only says whether AI is usable,
    // never which Google project or service account the server runs as.
    google: { configured: google.configured, problem: google.problem },
    location: config.google.location,
    // The "understand this photo" pipeline's three remote models (server/lib/pipelineRunner.js).
    pipeline: {
      oneformer: !!config.oneformer.url,
      analyze: !!config.analyze.url,
      sam3: !!config.sam3.url,
      moge2: !!config.moge2.url,
      marigold: !!config.marigold.url,
      mock: config.pipeline.mock,
    },
    database: db.status().connected,
  });
});

router.post(
  "/session",
  express.json({ limit: "4kb" }),
  function (request, response) {
    if (!config.passcode) {
      response.json({ signedIn: true });
      return;
    }
    if (!access.allowAttempt(request)) {
      response.status(429).json({
        error: "Too many wrong passcodes. Wait ten minutes and try again.",
      });
      return;
    }
    const given = request.body ? String(request.body.passcode || "") : "";
    if (!access.checkPasscode(given)) {
      access.recordFailure(request);
      response
        .status(401)
        .json({ error: "That passcode is not right.", code: "passcode" });
      return;
    }
    access.setCookie(request, response);
    response.json({ signedIn: true });
  },
);

router.delete("/session", function (request, response) {
  access.clearCookie(response);
  response.json({ signedIn: !config.passcode });
});

async function modelServiceCheck() {
  try {
    const headers = config.models.key
      ? { "X-Model-Key": config.models.key }
      : {};
    const answer = await fetch(config.models.url + "/health", {
      headers: headers,
      signal: AbortSignal.timeout(90000),
    });
    if (!answer.ok) {
      return {
        status: "error",
        detail: "The model service answered " + answer.status + ".",
      };
    }
    const health = await answer.json();
    const loaded = (health.sceneLoaded || [])
      .map(function (id) {
        return id.split("/").pop();
      })
      .concat(
        health.pickLoaded ? [String(health.pickModel).split("/").pop()] : [],
      );
    return {
      status: health.device === "cpu" ? "warn" : "ok",
      detail:
        "Running on " +
        health.device +
        (health.device === "cpu"
          ? " (works; a GPU makes scans and Pick a few times faster)"
          : "") +
        ". " +
        (loaded.length
          ? "Loaded: " + loaded.join(", ") + "."
          : "Models load on first use."),
    };
  } catch (error) {
    return {
      status: "error",
      detail:
        "Not reachable at " +
        config.models.url +
        ". Start it with: cd python && uvicorn app:app --port 8001. Gemini outlines are used meanwhile.",
    };
  }
}

// SAM 3, MoGe-2 and Marigold-IID (server/lib/pipelineRunner.js) share one shape: a
// {url,key,authHeader} config block and a /healthz sibling at the same domain as the
// configured endpoint (each is its own full /v1/... URL - see moge2.js's call() for how that
// was confirmed - so /healthz is derived by replacing the path, not by appending to it).
// Cold GPU containers can take a while to start, so this uses a generous timeout and words a
// timeout as "still starting", not as broken.
async function pipelineModelCheck(name, modelConfig, envHint) {
  if (!modelConfig.url) {
    return {
      status: "warn",
      detail: "Not configured (optional). Set " + envHint + " in .env.",
    };
  }
  let healthUrl;
  try {
    healthUrl = new URL("/healthz", modelConfig.url).href;
  } catch (error) {
    return { status: "error", detail: modelConfig.url + " is not a valid URL." };
  }
  try {
    const answer = await fetch(healthUrl, {
      headers: remoteShared.authHeaders(modelConfig),
      signal: AbortSignal.timeout(90000),
    });
    if (!answer.ok) {
      return {
        status: "error",
        detail: healthUrl + " answered " + answer.status + ".",
      };
    }
    const health = await answer.json();
    return {
      status: "ok",
      detail:
        "Reachable" +
        (health.gpu ? " (" + health.gpu + ")" : "") +
        (health.gpu_active != null
          ? ", " + health.gpu_active + " active, " + health.gpu_waiting + " waiting"
          : "") +
        ".",
    };
  } catch (error) {
    const timedOut = error && error.name === "TimeoutError";
    return {
      status: "error",
      detail: timedOut
        ? "No answer within 45s - a cold GPU container can take a while to start; try again shortly."
        : "Not reachable at " + healthUrl + ".",
    };
  }
}

async function databaseCheck() {
  const state = db.status();
  if (!state.connected) {
    return {
      status: "error",
      detail:
        "MongoDB is not connected" + (state.error ? ": " + state.error : "."),
    };
  }
  let detail = "Connected to " + state.database + ".";
  try {
    const rooms = await Room.countDocuments();
    const stats = await mongoose.connection.db
      .collection("files.files")
      .aggregate([{ $group: { _id: null, bytes: { $sum: "$length" } } }])
      .toArray();
    const megabytes = stats.length ? Math.round(stats[0].bytes / 1048576) : 0;
    detail +=
      " " +
      rooms +
      " room" +
      (rooms === 1 ? "" : "s") +
      " saved, " +
      megabytes +
      " MB of photos and renders.";
  } catch (error) {
    detail += " Could not count rooms: " + error.message;
  }
  return { status: "ok", detail: detail };
}

router.post(
  "/check",
  access.requireAccess,
  express.json({ limit: "10kb" }),
  async function (request, response) {
    const settings = request.body || {};
    const location = /^[a-z0-9-]{2,40}$/.test(settings.location || "")
      ? settings.location
      : config.google.location;
    const results = [];
    function add(name, result) {
      results.push(Object.assign({ name: name }, result));
    }
    let signedIn = false;
    try {
      googleToken.invalidate();
      await googleToken.getToken();
      const google = googleToken.describe();
      add("Google sign-in", {
        status: "ok",
        detail:
          "Access token issued" +
          (google.clientEmail ? " for " + google.clientEmail : "") +
          " on project " +
          (await googleToken.projectId()) +
          ".",
      });
      signedIn = true;
    } catch (error) {
      add("Google sign-in", { status: "error", detail: error.message });
    }
    function modelId(value) {
      return /^[a-z0-9][a-z0-9.\-]{2,80}$/.test(String(value || ""))
        ? value
        : "";
    }
    if (signedIn) {
      const imageModel = modelId(settings.imageModel);
      if (imageModel) {
        add(
          "Render model (" + imageModel + ")",
          await vertex.probeModel(location, imageModel, true),
        );
      }
      const insightModel = modelId(settings.insightModel);
      if (settings.estimateQuantities && insightModel) {
        add(
          "Measuring model (" + insightModel + ")",
          await vertex.probeModel(location, insightModel, false),
        );
      }
      const polygonModel = modelId(settings.polygonModel);
      if (
        polygonModel &&
        (settings.useGeminiAssist ||
          settings.fallbackToGemini ||
          settings.segmentationEngine === "gemini")
      ) {
        add(
          "Outline model (" + polygonModel + ")",
          await vertex.probeModel(location, polygonModel, false),
        );
      }
      const maskModel = modelId(settings.maskModel);
      if (
        maskModel &&
        settings.segmentationEngine === "gemini" &&
        settings.geminiEngine !== "polygon"
      ) {
        const result = await vertex.probeModel(location, maskModel, false);
        if (result.status === "error") {
          result.status = "warn";
        }
        add("Mask model (" + maskModel + ")", result);
      }
    }
    add("Model service (Python)", await modelServiceCheck());
    if (config.oneformer.url) {
      add("OneFormer (scan)", await pipelineModelCheck("OneFormer", config.oneformer, "ONEFORMER_URL"));
    }
    if (config.analyze.url) {
      add("Room analysis (one request)", await pipelineModelCheck("Room analysis", config.analyze, "ANALYZE_URL"));
    }
    add("SAM 3 (room pipeline)", await pipelineModelCheck("SAM 3", config.sam3, "SAM3_URL"));
    add("MoGe-2 (room pipeline)", await pipelineModelCheck("MoGe-2", config.moge2, "MOGE2_URL"));
    add(
      "Marigold-IID (room pipeline)",
      await pipelineModelCheck("Marigold-IID", config.marigold, "MARIGOLD_URL"),
    );
    add("Saved rooms (MongoDB)", await databaseCheck());
    response.json({ results: results });
  },
);

module.exports = router;
