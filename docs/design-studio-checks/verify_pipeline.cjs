// Verification script for docs/DESIGN_STUDIO_ARCHITECTURE.md.
//   Run:  node docs/design-studio-checks/verify_pipeline.cjs
// Runs the REAL swatchroom/server/routes/pipeline.js and lib/pipelineRunner.js with stubbed storage, database and model
// adapters, and counts what would have been called. NOTHING leaves this machine:
//   - every *_URL is pointed at a closed local port BEFORE config.js is loaded (dotenv never overwrites a variable that
//     is already set, so the real Modal addresses in swatchroom/.env are not used);
//   - global.fetch is replaced by a function that records the attempt and throws;
//   - Room / PipelineJob / storage / fusionStore / the four model adapters / fusion.runFitRegions are all stubbed.
const path = require("path");
const SR = path.resolve(__dirname, "../../swatchroom/server");

["ANALYZE_URL", "ONEFORMER_URL", "SAM3_URL", "MOGE2_URL", "MARIGOLD_URL"].forEach(function (name) {
  process.env[name] = "http://127.0.0.1:9/fake-" + name.toLowerCase();
});
process.env.MODEL_SERVICE_URL = "http://127.0.0.1:9";
process.env.MONGODB_URI = "mongodb://127.0.0.1:9/none";
process.env.PIPELINE_MOCK = "auto";
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "";
process.env.GOOGLE_APPLICATION_CREDENTIALS = "";

const blockedFetches = [];
global.fetch = async function (url) {
  blockedFetches.push(String(url));
  throw new Error("network blocked by the verification script");
};

const config = require(path.join(SR, "config.js"));
const Room = require(path.join(SR, "models/Room.js"));
const PipelineJob = require(path.join(SR, "models/PipelineJob.js"));
const storageModule = require(path.join(SR, "lib/storage.js"));
const fusionStore = require(path.join(SR, "lib/fusionStore.js"));
const fusion = require(path.join(SR, "lib/fusion.js"));
const pack = require(path.join(SR, "lib/pack.js"));
const analyze = require(path.join(SR, "lib/remoteModels/analyze.js"));
const moge2 = require(path.join(SR, "lib/remoteModels/moge2.js"));
const marigold = require(path.join(SR, "lib/remoteModels/marigold.js"));
const sam3 = require(path.join(SR, "lib/remoteModels/sam3.js"));
const eventLog = require(path.join(SR, "lib/eventLog.js"));
const pipelineRunner = require(path.join(SR, "lib/pipelineRunner.js"));

eventLog.log = function () {};
const realRun = pipelineRunner.run;
const queuedRuns = [];
function stubRunForRouteTests() {
  pipelineRunner.run = async function (roomId, versionId) {
    queuedRuns.push(versionId);
  };
}
function restoreRealRun() {
  pipelineRunner.run = realRun;
}

// ---------------------------------------------------------------- fake world
const W = 8;
const H = 6;
let doc; // the one fake Room document
let calls; // counters
let reports; // every report() patch the runner made
let jobsCreated;

function freshDoc(options) {
  return {
    _id: "room-test-0001",
    scan: {
      width: W,
      height: H,
      savedAt: options.scanSavedAt,
      metas: [{ index: 1, id: "floor-1", kind: "floor", label: "Floor" }],
    },
    fusion: options.fusion || undefined,
  };
}

function geometryFor(versionId) {
  return {
    versionId: versionId,
    computedAt: 1,
    width: W,
    height: H,
    camera: { fx: 10, fy: 10, cx: 4, cy: 3, up: null },
    depthFile: "room-test-0001/fusion/" + versionId + "/depth",
    shadingFile: "x",
    shadingFormat: "u16",
    residualFile: null,
    samFile: null,
    samSummary: null,
    modelVersions: {},
  };
}

function reset(options) {
  doc = freshDoc(options);
  calls = { analyze: 0, moge2: 0, marigold: 0, sam3: 0, fit: 0, saveGeometry: 0, saveRegions: 0, storageReads: [] };
  reports = [];
  jobsCreated = [];
  blockedFetches.length = 0;
}

// Room.findById: awaitable, and also chainable as .select().lean() (the route) ...
Room.findById = function () {
  const query = {
    select: function () {
      return query;
    },
    lean: function () {
      return query;
    },
    then: function (resolve, reject) {
      return Promise.resolve(doc).then(resolve, reject);
    },
  };
  return query;
};
Room.updateOne = async function (filter, update) {
  const set = (update && update.$set) || {};
  Object.keys(set).forEach(function (key) {
    if (key === "fusion.jobId" || key === "fusion.status") {
      doc.fusion = doc.fusion || {};
      doc.fusion[key.split(".")[1]] = set[key];
    }
  });
};
PipelineJob.create = async function (job) {
  jobsCreated.push(job);
  return job;
};
PipelineJob.updateOne = async function () {};
let activeJobStatus = null;
PipelineJob.findById = function () {
  return { lean: async () => (activeJobStatus ? { _id: "job-existing", status: activeJobStatus } : null) };
};

storageModule.storage = function () {
  return {
    getBuffer: async function (key) {
      calls.storageReads.push(key);
      if (/\/raw$/.test(key)) return Buffer.from("fake-jpeg");
      if (/scan\/labels$/.test(key)) {
        const labels = new Uint16Array(W * H).fill(1);
        return Buffer.from(labels.buffer);
      }
      if (/\/depth$/.test(key)) return pack.packFloat32(new Float32Array(W * H).fill(2));
      return null;
    },
    putBuffer: async function () {
      return { size: 1 };
    },
  };
};
fusionStore.saveGeometry = async function (roomId, geometry) {
  calls.saveGeometry += 1;
  doc.fusion = Object.assign({}, doc.fusion, { geometry: geometry, status: "ready" });
};
fusionStore.saveRegions = async function (roomId, regions) {
  calls.saveRegions += 1;
  doc.fusion = Object.assign({}, doc.fusion, { regions: regions, status: "ready" });
};
fusionStore.saveError = async function () {};
fusion.runFitRegions = async function () {
  calls.fit += 1;
  return { byId: {}, splits: [] };
};

const fakeGeometryRaw = {
  width: W,
  height: H,
  depth: new Float32Array(W * H).fill(2),
  intrinsics: { fx: 10, fy: 10, cx: 4, cy: 3 },
  up: null,
};
const fakeLighting = { width: W, height: H, shading: new Float32Array(W * H).fill(0.5) };
analyze.analyze = async function () {
  calls.analyze += 1;
  return { geometry: fakeGeometryRaw, lighting: fakeLighting, sam: { width: W, height: H, detections: [] }, meta: {} };
};
moge2.analyze = async function () {
  calls.moge2 += 1;
  return fakeGeometryRaw;
};
marigold.analyze = async function () {
  calls.marigold += 1;
  return fakeLighting;
};
sam3.analyze = async function () {
  calls.sam3 += 1;
  return { width: W, height: H, detections: [] };
};

// ---------------------------------------------------------------- helpers
const router = require(path.join(SR, "routes/pipeline.js"));
function analyzeHandler() {
  const layer = router.stack.find(function (l) {
    return l.route && l.route.path === "/pipeline/analyze" && l.route.methods.post;
  });
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
async function postAnalyze(versionId) {
  let out = null;
  const res = {
    statusCode: 200,
    status: function (n) {
      this.statusCode = n;
      return this;
    },
    json: function (x) {
      out = x;
    },
  };
  await analyzeHandler()({ body: { roomId: "room-test-0001", versionId: versionId } }, res);
  return out;
}
async function runRunner(versionId) {
  reports = [];
  await pipelineRunner.run("room-test-0001", versionId, async function (patch) {
    reports.push(JSON.parse(JSON.stringify(patch)));
  });
}
function summary() {
  return JSON.stringify({
    analyze: calls.analyze,
    moge2: calls.moge2,
    marigold: calls.marigold,
    sam3: calls.sam3,
    planeFit: calls.fit,
    saveGeometry: calls.saveGeometry,
    saveRegions: calls.saveRegions,
    blockedFetchAttempts: blockedFetches.length,
  });
}
function line(title) {
  console.log("\n--- " + title);
}

(async function main() {
  console.log("combined analysis in use (ANALYZE_URL set, mock != on):", pipelineRunner.useCombinedAnalysis());
  stubRunForRouteTests(); // the route tests only look at what the route DECIDES; the queued jobs must not run for real

  // ---------------- 1. what POST /api/pipeline/analyze decides
  line("ROUTE 1: geometry for v0 saved, regions fitted for the current scan, ask for v0");
  reset({ scanSavedAt: 1000, fusion: { geometry: geometryFor("v0"), regions: { computedForScanAt: 1000 }, status: "ready" } });
  console.log("answer:", JSON.stringify(await postAnalyze("v0")), "| jobs created:", jobsCreated.length);

  line("ROUTE 2: same, but the scan was saved again since the fit (scan.savedAt 2000 vs fitted-for 1000)");
  reset({ scanSavedAt: 2000, fusion: { geometry: geometryFor("v0"), regions: { computedForScanAt: 1000 }, status: "ready" } });
  const r2 = await postAnalyze("v0");
  console.log("answer:", JSON.stringify(r2), "| jobs created:", jobsCreated.length, "| job versionId:", jobsCreated[0] && jobsCreated[0].versionId);

  line("ROUTE 3: ask for a RENDER version 'v1-ab12' while the stored geometry belongs to v0");
  reset({ scanSavedAt: 1000, fusion: { geometry: geometryFor("v0"), regions: { computedForScanAt: 1000 }, status: "ready" } });
  const r3 = await postAnalyze("v1-ab12");
  console.log("answer:", JSON.stringify(r3), "| jobs created:", jobsCreated.length, "| job versionId:", jobsCreated[0] && jobsCreated[0].versionId);

  line("ROUTE 4: a job for this room is already running; the same request again");
  reset({ scanSavedAt: 2000, fusion: { geometry: geometryFor("v0"), regions: { computedForScanAt: 1000 }, status: "pending", jobId: "job-existing" } });
  activeJobStatus = "running";
  const r4 = await postAnalyze("v0");
  activeJobStatus = null;
  console.log("answer:", JSON.stringify(r4), "| NEW jobs created:", jobsCreated.length);

  line("ROUTE 5: job 1 has saved its geometry (so fusion.status is already 'ready') but is still running stage B; a second request arrives");
  reset({ scanSavedAt: 2000, fusion: { geometry: geometryFor("v0"), regions: { computedForScanAt: 1000 }, status: "ready", jobId: "job-existing" } });
  activeJobStatus = "running";
  const r5 = await postAnalyze("v0");
  activeJobStatus = null;
  console.log("answer:", JSON.stringify(r5), "| NEW jobs created:", jobsCreated.length, "(the 'already running' check only looks at fusion.status === 'pending')");

  await new Promise((resolve) => setTimeout(resolve, 200)); // let the queue hand its (stubbed) jobs over
  console.log("\n(route tests queued these versions; the stub ran none of them for real:", JSON.stringify(queuedRuns) + ")");
  restoreRealRun();

  // ---------------- 2. what a job then does
  line("RUNNER A (like the screenshot's 2nd job): geometry for v0 cached, scan saved since");
  reset({ scanSavedAt: 2000, fusion: { geometry: geometryFor("v0"), regions: { computedForScanAt: 1000 }, status: "ready" } });
  await runRunner("v0");
  console.log("calls:", summary());
  console.log("what it reported:", JSON.stringify(reports));
  console.log("model keys ever reported (sam3/moge2/marigold):", JSON.stringify(reports.filter((r) => r.progress && (r.progress.sam3 || r.progress.moge2 || r.progress.marigold))));

  line("RUNNER B (like the 1st job): a photo version with NO stored geometry, combined analysis");
  reset({ scanSavedAt: 1000, fusion: undefined });
  await runRunner("v0");
  console.log("calls:", summary());
  console.log("what it reported:", JSON.stringify(reports));
  const distinct = [];
  const state = { status: "running", stage: "", progress: { sam3: "pending", moge2: "pending", marigold: "pending", fusion: "pending" } };
  reports.forEach(function (patch) {
    if (patch.stage !== undefined) state.stage = patch.stage;
    if (patch.progress) Object.assign(state.progress, patch.progress);
    distinct.push(JSON.stringify([state.stage, state.progress]));
  });
  console.log("distinct (stage, progress) states one full job passes through after 'running':", new Set(distinct).size);

  line("RUNNER C: ask the runner for the RENDER version 'v1-ab12' when v0's geometry is stored");
  reset({ scanSavedAt: 1000, fusion: { geometry: geometryFor("v0"), regions: { computedForScanAt: 1000 }, status: "ready" } });
  await runRunner("v1-ab12");
  console.log("calls:", summary());
  console.log("geometry slot now belongs to:", doc.fusion.geometry.versionId, "| photo read:", calls.storageReads.filter((k) => /raw$/.test(k)).join(","));
  stubRunForRouteTests();
  console.log("then ask for v0 again ->", JSON.stringify(await postAnalyze("v0")), "(a job means the single geometry slot has to be recomputed)");
  await new Promise((resolve) => setTimeout(resolve, 200));
  restoreRealRun();

  line("RUNNER D: separate pools (ANALYZE_URL cleared at run time), no stored geometry");
  const savedAnalyzeUrl = config.analyze.url;
  config.analyze.url = "";
  reset({ scanSavedAt: 1000, fusion: undefined });
  console.log("combined analysis in use:", pipelineRunner.useCombinedAnalysis());
  await runRunner("v0");
  console.log("calls:", summary());
  config.analyze.url = savedAnalyzeUrl;

  // ---------------- 3. who gets woken (fake hosts that differ, like the two Modal function labels in the local .env)
  line("WAKE: which pools a ping goes to, with ONEFORMER and ANALYZE on different hosts");
  const wake = require(path.join(SR, "lib/wake.js"));
  config.oneformer.url = "http://host-oneformer.invalid/v1/parse";
  config.analyze.url = "http://host-all.invalid/v1/analyze";
  const names = (list) => list.map((t) => t.name);
  console.log("scan starting (POST /api/pipeline/warmup, reason=scan):", JSON.stringify(names(wake.targets({ scanUsesOneFormer: true }))));
  console.log("page open (POST /api/studio/warmup -> swatchroom.warm()):", JSON.stringify(names(wake.targets({ pools: [["oneformer", config.oneformer], ...wake.pipelinePools()], scanUsesOneFormer: false }))));
  config.oneformer.url = "http://host-all.invalid/v1/parse";
  console.log("same host for both  | scan:", JSON.stringify(names(wake.targets({ scanUsesOneFormer: true }))), "| page open:", JSON.stringify(names(wake.targets({ pools: [["oneformer", config.oneformer], ...wake.pipelinePools()], scanUsesOneFormer: false }))));

  console.log("\nTotal fetch attempts blocked over the whole run (anything that would have left this machine):", blockedFetches.length);
})().catch(function (error) {
  console.error("SCRIPT FAILED:", error);
  process.exit(1);
});
