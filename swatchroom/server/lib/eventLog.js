// "How many people did what generation": one EventLog row per generate/scan/pick/pipeline
// request, read back by the admin dashboard (server/routes/admin.js). Writing a log entry
// must never be able to break or slow down the request it describes, so this is always
// fire-and-forget.
const EventLog = require("../models/EventLog");

function log(entry) {
  EventLog.create({
    type: entry.type,
    action: String(entry.action || "").slice(0, 80),
    model: String(entry.model || "").slice(0, 120),
    roomId: String(entry.roomId || "").slice(0, 80),
    status: entry.status === "error" ? "error" : "ok",
    statusCode: Number(entry.statusCode) || 0,
    durationMs: Math.max(0, Math.round(Number(entry.durationMs) || 0)),
    error: String(entry.error || "").slice(0, 300),
    visitorId: String(entry.visitorId || "").slice(0, 64),
    ip: String(entry.ip || "").slice(0, 80),
  }).catch(function () {});
}

// Wraps a route handler: times it, logs ok/error afterwards, re-throws so Express's own error
// handler still runs. `describe(request, response)` returns the {action, model, roomId} the
// log line should carry (roomId often only known after reading the body).
function instrument(type, describe, handler) {
  return async function (request, response, next) {
    const startedAt = Date.now();
    try {
      await handler(request, response, next);
      const described = describe(request, response) || {};
      log({
        type: type,
        action: described.action,
        model: described.model,
        roomId: described.roomId,
        status: response.statusCode >= 400 ? "error" : "ok",
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
        error: response.statusCode >= 400 ? described.error || "" : "",
        visitorId: request.visitorId,
        ip: request.ip,
      });
    } catch (error) {
      const described = describe(request, response) || {};
      log({
        type: type,
        action: described.action,
        model: described.model,
        roomId: described.roomId,
        status: "error",
        statusCode: (error && error.status) || 500,
        durationMs: Date.now() - startedAt,
        error: (error && error.message) || "Server error.",
        visitorId: request.visitorId,
        ip: request.ip,
      });
      throw error;
    }
  };
}

module.exports = { log: log, instrument: instrument };
