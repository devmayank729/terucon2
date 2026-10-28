// Swatchroom server: serves the studio (plain HTML, CSS and JavaScript from public/), keeps
// rooms in MongoDB, calls Gemini on Vertex AI with the server's Google key, and forwards
// photos to the Python model service for the local models.
const fs = require("fs");
const path = require("path");
const express = require("express");
const config = require("./config");
const db = require("./db");
const access = require("./lib/access");
const googleToken = require("./google/token");
const visitor = require("./lib/visitor");
const liveTracking = require("./lib/liveTracking");
const bootReport = require("./lib/bootReport");

const app = express();
const publicDir = path.join(__dirname, "..", "public");

app.disable("x-powered-by");
// TRUST_PROXY: how many proxies (nginx, Caddy...) sit in front, or a list of their addresses.
const trustProxy = process.env.TRUST_PROXY || "loopback";
app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

// Basic hardening headers. The studio loads nothing from other sites.
app.use(function (request, response, next) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader(
    "Permissions-Policy",
    "camera=(self), microphone=(), geolocation=()",
  );
  next();
});

// Tags every request with an anonymous visitor id (server/lib/visitor.js), used by the admin
// dashboard's "live now" count and generation log - independent of, and unaffected by, the
// studio passcode below.
app.use(visitor.tagVisitor);

// ------------------------------------------------------------------ API
app.use("/api", require("./routes/session"));
// The admin dashboard has its own sign-in (server/lib/adminAuth.js) and must stay reachable
// even when a studio passcode is set - mounted before access.requireAccess on purpose.
app.use("/api/admin", require("./routes/admin"));
app.use("/api", access.requireAccess);
app.use("/api", function (request, response, next) {
  liveTracking.touch(request.visitorId, request.path, request.ip);
  next();
});
app.use("/api/ai", require("./routes/ai"));
app.use("/api/rooms", require("./routes/rooms"));
app.use("/api", require("./routes/vision"));
app.use("/api", require("./routes/pipeline"));

app.use("/api", function (request, response) {
  response.status(404).json({ error: "No such API route." });
});

// ------------------------------------------------------------------ pages
// "/" is the Terucon page with the studio inside, when it has been built (see README);
// "/studio" is always the studio on its own.
function sendStudio(request, response) {
  liveTracking.touch(request.visitorId, request.path, request.ip);
  response.sendFile(path.join(publicDir, "index.html"));
}

app.get("/", function (request, response) {
  liveTracking.touch(request.visitorId, "/", request.ip);
  if (config.terucon.page && fs.existsSync(config.terucon.page)) {
    response.sendFile(config.terucon.page);
    return;
  }
  sendStudio(request, response);
});
app.get("/studio", sendStudio);
// The admin dashboard page itself (public/admin.html handles its own sign-in via
// /api/admin/*); visiting it doesn't count as a studio visitor being "live".
app.get("/admin", function (request, response) {
  response.sendFile(path.join(publicDir, "admin.html"));
});
app.get("/favicon.ico", function (request, response) {
  response.redirect(301, "/favicon.svg");
});

app.use(
  express.static(publicDir, {
    index: false,
    setHeaders: function (response, filePath) {
      if (/\.(woff2)$/.test(filePath)) {
        response.setHeader(
          "Cache-Control",
          "public, max-age=31536000, immutable",
        );
      } else {
        response.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

// ------------------------------------------------------------------ errors
// Readable JSON for the studio; the details stay in the server log.
app.use(function (error, request, response, next) {
  const status =
    error.status ||
    error.statusCode ||
    (error.type === "entity.too.large" ? 413 : 500);
  if (status >= 500) {
    console.error(
      new Date().toISOString(),
      request.method,
      request.path,
      error,
    );
  }
  if (response.headersSent) {
    next(error);
    return;
  }
  let message =
    error.expose === false ? "Server error." : error.message || "Server error.";
  if (status === 413) {
    message = "That upload is too large for the server.";
  }
  if (
    status === 500 &&
    /MongoServerSelectionError|MongoNotConnected|buffering timed out/i.test(
      String(error),
    )
  ) {
    message =
      "The database is not reachable. Check that MongoDB is running (MONGODB_URI).";
  }
  response.status(status).json({ error: message });
});

// A restart loses the in-process pipeline queue's state (see server/lib/jobs.js): any job
// still marked "queued" or "running" from before the restart is actually gone. Mark those
// failed so the browser's status poll stops waiting on them; the designer just re-triggers
// analysis, which is cheap (server/lib/pipelineRunner.js skips whatever Stage A/B work is
// already cached on the room).
async function reconcileStaleJobs() {
  try {
    const PipelineJob = require("./models/PipelineJob");
    await PipelineJob.updateMany(
      { status: { $in: ["queued", "running"] } },
      { $set: { status: "failed", error: "Interrupted by a server restart.", finishedAt: Date.now() } },
    );
  } catch (error) {
    // best-effort; the database connection retry loop below will surface real DB problems
  }
}

// MongoDB may start after the server (for example with docker compose): keep trying.
async function connectDatabase() {
  try {
    await db.connect();
    console.log("MongoDB connected:", db.status().database);
    reconcileStaleJobs();
  } catch (error) {
    console.error(
      "MongoDB is not reachable at " +
        config.mongoUri +
        " (" +
        error.message +
        "). Retrying in 15 seconds; the studio opens meanwhile but cannot save rooms.",
    );
    setTimeout(connectDatabase, 15000);
  }
}

async function start() {
  connectDatabase();
  const google = googleToken.describe();
  if (!google.configured) {
    console.warn(
      google.problem ||
        "No Google key: set GOOGLE_APPLICATION_CREDENTIALS in .env to enable Gemini.",
    );
  }
  app.listen(config.port, config.host, function () {
    console.log(
      "Swatchroom is running on http://localhost:" +
        config.port +
        (config.passcode ? " (passcode on)" : ""),
    );
    bootReport.print();
  });
}

if (require.main === module) {
  start();
}

module.exports = app;
