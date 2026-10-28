// The admin dashboard (public/admin.html): its own sign-in (server/lib/adminAuth.js,
// independent of the studio passcode), generation/scan/pick/pipeline logs
// (server/lib/eventLog.js), how many people are live right now (server/lib/liveTracking.js)
// and the same model/service health checks Settings > Check uses (server/lib/healthChecks.js).
//
//   POST   /api/admin/login     { email, password } -> signed cookie
//   DELETE /api/admin/login     sign out
//   GET    /api/admin/me        whether this browser is signed in
//   GET    /api/admin/overview  counts for the dashboard's stat cards
//   GET    /api/admin/models    Google / model service / pipeline / database health
//   GET    /api/admin/live      visitors active in the last ~90s
//   GET    /api/admin/logs      paginated generation/scan/pick/pipeline log
//   GET    /api/admin/coldstart cold start vs processing for each model service - what the
//                               owner-only dot in the studio reads (server/lib/coldStart.js)
const express = require("express");
const config = require("../config");
const adminAuth = require("../lib/adminAuth");
const coldStart = require("../lib/coldStart");
const healthChecks = require("../lib/healthChecks");
const liveTracking = require("../lib/liveTracking");
const EventLog = require("../models/EventLog");
const Room = require("../models/Room");

const router = express.Router();
const LOG_TYPES = ["generate", "scan", "pick", "pipeline"];
const DAY_MS = 86400000;

router.post(
  "/login",
  express.json({ limit: "4kb" }),
  function (request, response) {
    if (!adminAuth.allowAttempt(request)) {
      response.status(429).json({
        error: "Too many wrong attempts. Wait ten minutes and try again.",
      });
      return;
    }
    const body = request.body || {};
    if (!adminAuth.checkCredentials(body.email, body.password)) {
      adminAuth.recordFailure(request);
      response.status(401).json({ error: "That email or password is not right." });
      return;
    }
    adminAuth.setCookie(request, response);
    response.json({ signedIn: true });
  },
);

router.delete("/login", function (request, response) {
  adminAuth.clearCookie(response);
  response.json({ signedIn: false });
});

router.get("/me", function (request, response) {
  response.json({ signedIn: adminAuth.isSignedIn(request) });
});

// Everything past this point needs the admin cookie.
router.use(adminAuth.requireAdmin);

router.get("/overview", async function (request, response) {
  const since = new Date(Date.now() - DAY_MS);
  const [liveNow, generationsToday, generationsTotal, errorsToday, roomsTotal] =
    await Promise.all([
      liveTracking.count(),
      EventLog.countDocuments({ createdAt: { $gte: since } }),
      EventLog.countDocuments(),
      EventLog.countDocuments({ createdAt: { $gte: since }, status: "error" }),
      Room.countDocuments(),
    ]);
  response.json({
    liveNow: liveNow,
    generationsToday: generationsToday,
    generationsTotal: generationsTotal,
    errorsToday: errorsToday,
    roomsTotal: roomsTotal,
    posthogEnabled: !!config.posthog.key,
  });
});

// The model panel polls this every 30 seconds, so by default it never calls Modal: the pools' state is read from this
// server's own record (healthChecks.passivePoolStatus). "?probe=1" (the Probe button) really calls each pool, which
// starts the ones that have scaled to zero and bills for it.
const POOLS = [
  ["oneformer", "OneFormer (scan)", "oneformer", "ONEFORMER_URL"],
  ["analyze", "Room analysis (SAM 3 + MoGe-2 + Marigold, one request)", "analyze", "ANALYZE_URL"],
  ["sam3", "SAM 3 (room pipeline)", "sam3", "SAM3_URL"],
  ["moge2", "MoGe-2 (room pipeline)", "moge2", "MOGE2_URL"],
  ["marigold", "Marigold-IID (room pipeline)", "marigold", "MARIGOLD_URL"],
];

router.get("/models", async function (request, response) {
  const probe = request.query.probe === "1";
  const [google, modelService, database] = await Promise.all([
    healthChecks.googleCheck(),
    healthChecks.modelServiceCheck(),
    healthChecks.databaseCheck(),
  ]);
  const pools = await Promise.all(
    POOLS.map(async function (entry) {
      const modelConfig = config[entry[2]];
      const result = probe
        ? await healthChecks.pipelineModelCheck(entry[1], modelConfig, entry[3])
        : healthChecks.passivePoolStatus(entry[0], modelConfig, entry[3]);
      return Object.assign({ name: entry[1] }, result);
    }),
  );
  response.json({
    probed: probe,
    results: [
      Object.assign({ name: "Google / Vertex AI" }, google),
      Object.assign({ name: "Model service (Python)" }, modelService),
    ]
      .concat(pools)
      .concat([Object.assign({ name: "MongoDB" }, database)]),
  });
});

// Never cached: the dot polls this while a scan is running.
router.get("/coldstart", function (request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.json(coldStart.snapshot());
});

router.get("/live", async function (request, response) {
  const visitors = await liveTracking.list(100);
  response.json({
    count: visitors.length,
    visitors: visitors.map(function (visitor) {
      return {
        id: visitor._id.slice(0, 8),
        path: visitor.path,
        lastSeen: visitor.lastSeen,
      };
    }),
  });
});

router.get("/logs", async function (request, response) {
  const query = {};
  if (LOG_TYPES.indexOf(request.query.type) !== -1) {
    query.type = request.query.type;
  }
  if (request.query.status === "ok" || request.query.status === "error") {
    query.status = request.query.status;
  }
  const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 50));
  const before = Number(request.query.before);
  if (Number.isFinite(before) && before > 0) {
    query.createdAt = { $lt: new Date(before) };
  }
  const logs = await EventLog.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  response.json({
    logs: logs.map(function (entry) {
      return {
        id: String(entry._id),
        type: entry.type,
        action: entry.action,
        model: entry.model,
        roomId: entry.roomId,
        status: entry.status,
        statusCode: entry.statusCode,
        durationMs: entry.durationMs,
        error: entry.error,
        visitorId: (entry.visitorId || "").slice(0, 8),
        createdAt: entry.createdAt,
      };
    }),
  });
});

module.exports = router;
