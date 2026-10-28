// "Who is live right now": one row per anonymous visitor (server/lib/visitor.js), updated on
// every studio page load and API call (server/lib/liveTracking.js). The TTL index drops a
// visitor automatically ~90s after their last activity, so a plain count of this collection
// *is* "how many people are live" - no separate cleanup job needed.
const mongoose = require("mongoose");

const liveVisitorSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    path: { type: String, default: "" },
    ip: { type: String, default: "" },
    lastSeen: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

liveVisitorSchema.index({ lastSeen: 1 }, { expireAfterSeconds: 90 });

module.exports = mongoose.model("LiveVisitor", liveVisitorSchema);
