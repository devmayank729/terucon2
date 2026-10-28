// A saved room: the photo's name and size, its versions, the materials used in them, and the
// surface map. Images are not stored here; they are files in GridFS (see routes/rooms.js).
const mongoose = require("mongoose");

const Mixed = mongoose.Schema.Types.Mixed;

const roomSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, default: "Room" },
    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now, index: true },
    photo: { type: Mixed, default: null },
    versions: { type: [Mixed], default: [] },
    currentId: { type: String, default: "" },
    products: { type: Mixed, default: {} },
    notes: { type: Mixed, default: {} },
    style: { type: String, default: "" },
    optionCount: { type: Number, default: 1 },
    counter: { type: Mixed, default: null },
    scanEngine: { type: String, default: "" },
    scanModel: { type: String, default: "" },
    // Surface map details; the label map itself is the GridFS file "<room>/scan/labels".
    scan: { type: Mixed, default: null },
    // What the pipeline worked out about this photo: geometry (from SAM 3 + MoGe-2 +
    // Marigold-IID, expensive, keyed to a photo version) and regions (fitted planes per
    // surface, cheap local math, keyed to a scan). Written only by server/lib/fusionStore.js,
    // never by the PUT below, so a browser request can never forge it. See server/lib/fusion.js.
    // No default: pipeline.js and fusionStore.js both write this with a dotted $set
    // ("fusion.jobId", "fusion.status", ...), and MongoDB cannot create a field inside a
    // sibling that already holds a literal null - only inside one that is absent entirely.
    fusion: { type: Mixed },
  },
  { minimize: false, versionKey: false },
);

roomSchema.methods.summary = function () {
  return {
    id: this._id,
    name: this.name,
    updatedAt: this.updatedAt,
    createdAt: this.createdAt,
    versionCount: Array.isArray(this.versions) ? this.versions.length : 1,
  };
};

module.exports = mongoose.model("Room", roomSchema);
