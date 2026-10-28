// The ONLY place that writes Room.fusion - never the public PUT /api/rooms/:id route (whose
// cleanRecord() whitelist in server/routes/rooms.js deliberately does not include "fusion"),
// so a browser request can never forge pipeline results. Used only by
// server/lib/pipelineRunner.js.
const Room = require("../models/Room");

async function saveGeometry(roomId, geometry) {
  await Room.updateOne(
    { _id: roomId },
    { $set: { "fusion.geometry": geometry, "fusion.status": "ready", "fusion.error": "" } },
  );
}

async function saveRegions(roomId, regions) {
  await Room.updateOne(
    { _id: roomId },
    { $set: { "fusion.regions": regions, "fusion.status": "ready", "fusion.error": "" } },
  );
}

async function saveError(roomId, message) {
  await Room.updateOne(
    { _id: roomId },
    { $set: { "fusion.status": "error", "fusion.error": String(message || "") } },
  );
}

module.exports = { saveGeometry: saveGeometry, saveRegions: saveRegions, saveError: saveError };
