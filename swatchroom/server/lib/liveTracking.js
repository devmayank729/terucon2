// "How many people are live": server/models/LiveVisitor.js holds one row per visitor with a
// TTL that expires ~90s after their last activity, so counting the collection is enough -
// nothing here has to notice when someone leaves.
const LiveVisitor = require("../models/LiveVisitor");

// Fire-and-forget: a missed heartbeat just means that visitor drops off the live list a
// little early, never worth failing or slowing down the request that triggered it.
function touch(visitorId, path, ip) {
  if (!visitorId) {
    return;
  }
  LiveVisitor.updateOne(
    { _id: visitorId },
    { $set: { path: String(path || "").slice(0, 200), ip: String(ip || "").slice(0, 80), lastSeen: new Date() } },
    { upsert: true },
  ).catch(function () {});
}

async function count() {
  try {
    return await LiveVisitor.countDocuments();
  } catch (error) {
    return 0;
  }
}

async function list(limit) {
  try {
    return await LiveVisitor.find()
      .sort({ lastSeen: -1 })
      .limit(limit || 50)
      .lean();
  } catch (error) {
    return [];
  }
}

module.exports = { touch: touch, count: count, list: list };
