// Shared health probes for the model service and the room pipeline's three remote models
// (SAM 3, MoGe-2, Marigold-IID), plus MongoDB. Used by both server/routes/session.js
// (Settings > Check, which also probes the designer's chosen Gemini models) and
// server/routes/admin.js (the dashboard's "model status" panel, which doesn't know about any
// particular Gemini model choice, just whether the pipeline and storage are healthy).
const mongoose = require("mongoose");
const config = require("../config");
const db = require("../db");
const googleToken = require("../google/token");
const Room = require("../models/Room");
const remoteShared = require("./remoteModels/shared");

async function googleCheck() {
  try {
    googleToken.invalidate();
    await googleToken.getToken();
    const google = googleToken.describe();
    return {
      status: "ok",
      detail:
        "Access token issued" +
        (google.clientEmail ? " for " + google.clientEmail : "") +
        " on project " +
        (await googleToken.projectId()) +
        ".",
    };
  } catch (error) {
    return { status: "error", detail: error.message };
  }
}

async function modelServiceCheck() {
  try {
    const headers = config.models.key
      ? { "X-Model-Key": config.models.key }
      : {};
    const answer = await fetch(config.models.url + "/health", {
      headers: headers,
      signal: AbortSignal.timeout(5000),
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
// configured endpoint. Cold GPU containers can take a while to start, so this uses a generous
// timeout and words a timeout as "still starting", not as broken.
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
      signal: AbortSignal.timeout(45000),
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

// What the dashboard shows for a Modal pool WITHOUT calling it: this server's own record of its last call (warmth.js).
// A /healthz request to a pool that has scaled to zero boots a billed GPU, and the dashboard asks every 30 seconds, so
// asking for real would keep every GPU running for as long as the tab is open. The owner presses "Probe" when they
// really want to know (pipelineModelCheck above does the real call).
function passivePoolStatus(poolKey, modelConfig, envHint) {
  const warmth = require("./warmth");
  if (!modelConfig.url) {
    return { status: "warn", detail: "Not configured (optional). Set " + envHint + " in .env." };
  }
  const pool = warmth.status().pools[poolKey];
  if (pool.state === "warm") {
    return {
      status: "ok",
      detail: "Warm: last call succeeded " + Math.round(pool.idleMs / 1000) + " s ago (not called just now).",
    };
  }
  if (pool.state === "waking") {
    return { status: "warn", detail: "Starting up: a call is in flight (a cold start can take a while)." };
  }
  if (pool.state === "cold") {
    return {
      status: "warn",
      detail:
        "Idle: last call " + Math.round(pool.idleMs / 60000) + " min ago, so the pool has scaled to zero. The next photo starts it (a cold start).",
    };
  }
  return {
    status: "warn",
    detail: "Not called since this server started, so its state is unknown. Press Probe to start it and check (bills a GPU).",
  };
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

module.exports = {
  googleCheck: googleCheck,
  modelServiceCheck: modelServiceCheck,
  pipelineModelCheck: pipelineModelCheck,
  passivePoolStatus: passivePoolStatus,
  databaseCheck: databaseCheck,
};
