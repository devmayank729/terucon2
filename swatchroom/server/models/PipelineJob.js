// One run of the "understand this photo" pipeline: SAM 3 + MoGe-2 + Marigold-IID (called
// together, see server/lib/pipelineRunner.js), then fusion. The room's own record
// (Room.fusion) holds the result; this is just the job's status, polled by the browser while
// it runs (see server/routes/pipeline.js).
const mongoose = require("mongoose");

const Mixed = mongoose.Schema.Types.Mixed;

const pipelineJobSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    roomId: { type: String, required: true, index: true },
    versionId: { type: String, required: true },
    status: {
      type: String,
      enum: ["queued", "running", "done", "failed"],
      default: "queued",
    },
    // Which stage is running: "geometry" (the three remote models, slow, photo-level) or
    // "regions" (local plane fitting, fast, scan-level). See server/lib/fusion.js.
    stage: { type: String, default: "" },
    progress: {
      type: Mixed,
      default: function () {
        return { sam3: "pending", moge2: "pending", marigold: "pending", fusion: "pending" };
      },
    },
    error: { type: String, default: "" },
    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now, index: true },
    startedAt: { type: Number, default: null },
    finishedAt: { type: Number, default: null },
  },
  { minimize: false, versionKey: false },
);

module.exports = mongoose.model("PipelineJob", pipelineJobSchema);
