// Runs the CPU-heavy part of fusion.js (RANSAC plane fitting, PCA refit, confidence scoring)
// on its own thread, so it never blocks the main thread that's also serving every other
// request. Pure compute only: no database, no network, no config - everything it needs comes
// in on workerData, everything it produces goes out over postMessage. fitRegions() itself (the
// actual math) is unit-tested directly in fusion.js, without a worker.
//
// When workerData.splitInput is present it also looks for wall regions that are really several planes
// (planeSplit.js) and returns them as `splits` next to the fitted planes: same thread, same depth map, so the
// pipeline does not pay for a second pass over the photo.
const { parentPort, workerData } = require("worker_threads");
const { fitRegions } = require("./fusion");
const { proposeWallSplits } = require("./planeSplit");

try {
  const regions = fitRegions(workerData);
  if (workerData.splitInput) {
    regions.splits = proposeWallSplits(workerData.splitInput);
  }
  parentPort.postMessage({ ok: true, regions: regions });
} catch (error) {
  parentPort.postMessage({ ok: false, error: (error && error.message) || String(error) });
}
