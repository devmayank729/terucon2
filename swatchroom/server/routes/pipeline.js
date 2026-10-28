// The "understand this photo" pipeline: MoGe-2 + Marigold-IID, fused into per-surface planes
// and a confidence score (server/lib/fusion.js), so every later material swap can render
// instantly in the browser. The slow part happens here, once per photo; server/lib/
// pipelineRunner.js does the actual work, this file just queues it and reports status.
//
//   POST /api/pipeline/analyze    { roomId, versionId } -> { status: "ready" }
//                                                           or { jobId, status: "queued" }
//   GET  /api/pipeline/jobs/:jobId                       -> { id, status, stage, progress, error }
const crypto = require("crypto");
const express = require("express");
const config = require("../config");
const Room = require("../models/Room");
const PipelineJob = require("../models/PipelineJob");
const jobsModule = require("../lib/jobs");
const pipelineRunner = require("../lib/pipelineRunner");
const fusionStore = require("../lib/fusionStore");
const eventLog = require("../lib/eventLog");
const wake = require("../lib/wake");

const router = express.Router();
const ROOM_ID = /^room-[a-z0-9-]{4,48}$/;
const VERSION_ID = /^[A-Za-z0-9._-]{1,80}$/;
const ACTIVE_STATUSES = ["queued", "running"];

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

// Merges a status patch onto a PipelineJob, including partial progress.* updates (so two
// progress reports in a row - {moge2:"running"} then {moge2:"done"} - never clobber each
// other's other keys the way a flat $set of the whole "progress" object would).
async function onStatus(jobId, patch) {
  const set = { updatedAt: Date.now() };
  Object.keys(patch || {}).forEach(function (key) {
    if (key === "progress" && patch.progress && typeof patch.progress === "object") {
      Object.keys(patch.progress).forEach(function (sub) {
        set["progress." + sub] = patch.progress[sub];
      });
    } else {
      set[key] = patch[key];
    }
  });
  try {
    await PipelineJob.updateOne({ _id: jobId }, { $set: set });
  } catch (error) {
    // best-effort status tracking - never let a status write crash the job itself
  }
}

const queue = jobsModule.createQueue({
  concurrency: config.pipeline.concurrency,
  onStatus: onStatus,
  handler: async function (jobId, payload, report) {
    const startedAt = Date.now();
    try {
      await pipelineRunner.run(payload.roomId, payload.versionId, report);
      await report({ status: "done", finishedAt: Date.now() });
      console.log(
        "[pipeline] " + payload.roomId + " analysed in " + (Date.now() - startedAt) + "ms",
        pipelineRunner.modelModes(),
      );
      eventLog.log({
        type: "pipeline",
        action: "analyze",
        roomId: payload.roomId,
        status: "ok",
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = (error && error.message) || "The pipeline failed.";
      console.warn("[pipeline] " + payload.roomId + " failed after " + (Date.now() - startedAt) + "ms: " + message);
      await fusionStore.saveError(payload.roomId, message).catch(function () {});
      eventLog.log({
        type: "pipeline",
        action: "analyze",
        roomId: payload.roomId,
        status: "error",
        durationMs: Date.now() - startedAt,
        error: message,
      });
      throw error; // jobs.js's own catch reports {status:"failed", error} on the job itself
    }
  },
});

function newJobId() {
  return "job-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
}

// Modal's GPU containers scale to zero when idle, so the first real request after a while can take 10-45s just to
// cold-start. The browser calls this when a photo is added or scanned (public/js/views/studio.js), NOT when the page
// opens: a cold start is billed from the first second, and most visitors who open the page never upload a photo. So
// that cold start happens while the scan runs rather than after the designer picks a finish, only the pools the room
// pipeline will really call are woken, only those that are not already warm or booting, and not the pool the scan's own
// OneFormer request is about to wake (server/lib/wake.js). Responds immediately - the pings are fire-and-forget; each
// is timed by server/lib/coldStart.js, which is how the owner-only dot knows a cold start is under way and how long it
// took. Settings > Check is the place to see whether they actually came up.
router.post(
  "/pipeline/warmup",
  express.json({ limit: "1kb" }),
  function (request, response) {
    const reason = String((request.body && request.body.reason) || "");
    if (reason !== "scan") {
      // anything but "a photo is being scanned" (a page load, an old cached client) wakes nothing
      response.json({ warming: [], reason: "not-needed" });
      return;
    }
    response.json({ warming: wake.wake({ scanUsesOneFormer: !!config.oneformer.url }) });
  },
);

router.post(
  "/pipeline/analyze",
  express.json({ limit: "4kb" }),
  async function (request, response) {
    const body = request.body || {};
    const roomId = String(body.roomId || "");
    const versionId = String(body.versionId || "");
    if (!ROOM_ID.test(roomId)) {
      throw badRequest("That is not a room id.");
    }
    if (!VERSION_ID.test(versionId)) {
      throw badRequest("That is not a version id.");
    }
    const room = await Room.findById(roomId).select("scan fusion").lean();
    if (!room) {
      response.status(404).json({ error: "That room is not saved here." });
      return;
    }
    if (!room.scan || !room.scan.width) {
      throw badRequest("Scan this room before analysing it.");
    }

    const existing = room.fusion || {};

    // Already have everything this room+version+scan needs - nothing to queue.
    const needsGeometry = !existing.geometry || existing.geometry.versionId !== versionId;
    const needsRegions =
      needsGeometry || !existing.regions || existing.regions.computedForScanAt !== room.scan.savedAt;
    if (!needsGeometry && !needsRegions) {
      response.json({ status: "ready" });
      return;
    }

    // A job for this exact work is already in flight - hand back its id instead of queueing a
    // duplicate (the browser can call this more than once, e.g. after a rescan that lands
    // while a brush-edit refit from a moment earlier is still running).
    if (existing.jobId && existing.status === "pending") {
      const activeJob = await PipelineJob.findById(existing.jobId).lean();
      if (activeJob && ACTIVE_STATUSES.indexOf(activeJob.status) !== -1) {
        response.json({ jobId: activeJob._id, status: activeJob.status });
        return;
      }
    }

    const jobId = newJobId();
    await PipelineJob.create({ _id: jobId, roomId: roomId, versionId: versionId, status: "queued" });
    await Room.updateOne(
      { _id: roomId },
      { $set: { "fusion.jobId": jobId, "fusion.status": "pending" } },
    );
    queue.enqueue(jobId, { roomId: roomId, versionId: versionId });
    response.json({ jobId: jobId, status: "queued" });
  },
);

router.get("/pipeline/jobs/:jobId", async function (request, response) {
  const jobId = String(request.params.jobId || "");
  const job = await PipelineJob.findById(jobId).lean();
  if (!job) {
    response.status(404).json({ error: "That pipeline job is not known." });
    return;
  }
  response.json({
    id: job._id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    error: job.error,
  });
});

module.exports = router;
