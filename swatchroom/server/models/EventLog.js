// One line in the admin dashboard's log: a generation, scan, Pick or pipeline request, who
// made it (by anonymous visitor id - see server/lib/visitor.js) and how it went. Written by
// server/lib/eventLog.js, read by server/routes/admin.js. Kept for 30 days (TTL index below),
// since this is an activity log, not a record anyone needs forever.
const mongoose = require("mongoose");

const eventLogSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["generate", "scan", "pick", "pipeline"],
      required: true,
      index: true,
    },
    action: { type: String, default: "" }, // task/stage name, e.g. "image", "json", "analyze"
    model: { type: String, default: "" },
    roomId: { type: String, default: "" },
    status: { type: String, enum: ["ok", "error"], required: true, index: true },
    statusCode: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    error: { type: String, default: "" },
    visitorId: { type: String, default: "" },
    ip: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now }, // indexed below, with the TTL
  },
  { versionKey: false },
);

eventLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model("EventLog", eventLogSchema);
