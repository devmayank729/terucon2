// Is the Modal pool warm? Answered from this server's own record of its last successful call to each pool, so
// asking costs nothing: a request to a pool that has scaled to zero boots a billed GPU, which is the last thing a
// page load should do. Every Modal call goes through this server (the browser never talks to Modal), so the clock
// is complete: a pool stays up for its scaledown window (SCALEDOWN_S in modalBlueprint.py, MODAL_SCALEDOWN_S here)
// after its last call and is stopped after that.
//
//   "warm"        a call succeeded less than (scaledown - margin) ago, or one is in flight right now
//   "cold"        the last successful call is older than that: the next call boots the pool
//   "unknown"     this server has not reached the pool since it started (a restart forgets the clock), treated as cold
//   "unconfigured" no URL is set for it
//
// The start-up gate (public/js/views/startupGate.js) only needs the answer for the pool the SCAN uses: OneFormer.
const config = require("../config");
const coldStart = require("./coldStart");
const remoteShared = require("./remoteModels/shared");

// The pools in the order the scan and the room pipeline use them.
const POOLS = ["oneformer", "analyze", "sam3", "moge2", "marigold"];

function classify(configured, warmth, settings) {
  if (!configured) {
    return { state: "unconfigured", warm: false, idleMs: null };
  }
  const limitMs = Math.max(0, settings.scaledownS - settings.warmMarginS) * 1000;
  if (warmth.lastOkAt === null) {
    return { state: warmth.inflight > 0 ? "waking" : "unknown", warm: false, idleMs: null };
  }
  if (warmth.inflight > 0 || warmth.idleMs < limitMs) {
    return { state: "warm", warm: true, idleMs: warmth.idleMs };
  }
  return { state: "cold", warm: false, idleMs: warmth.idleMs };
}

// registry: coldStart (or a test registry); modelConfigs/settings default to the live config.
function status(options) {
  const opts = options || {};
  const registry = opts.registry || coldStart;
  const configs = opts.configs || config;
  const settings = opts.settings || config.vision;
  const pools = {};
  POOLS.forEach(function (name) {
    const configured = !!(configs[name] && configs[name].url);
    pools[name] = Object.assign(
      { configured: configured },
      classify(configured, registry.warmth(name), settings),
    );
  });
  // The scan pool decides the gate. With only the dedicated pools deployed (no ANALYZE_URL) it is still OneFormer.
  const scan = pools.oneformer;
  return {
    mode: "passive",
    configured: scan.configured,
    warm: scan.warm,
    state: scan.state,
    idleMs: scan.idleMs,
    scaledownMs: settings.scaledownS * 1000,
    pools: pools,
  };
}

// The optional active probe (VISION_ACTIVE_WARMUP=on): one /healthz to the scan pool, only when the passive answer
// is not "warm", bounded by timeoutMs. Resolves { warm, probed } and records a successful probe as a call, so the
// clock stays true. Never rejects.
async function probe(options) {
  const opts = options || {};
  const modelConfig = opts.modelConfig || config.oneformer;
  const timeoutMs = opts.timeoutMs || 9000;
  const doFetch = opts.fetch || fetch;
  if (!modelConfig.url) {
    return { warm: false, probed: false };
  }
  let healthUrl;
  try {
    healthUrl = new URL("/healthz", modelConfig.url).href;
  } catch (error) {
    return { warm: false, probed: false };
  }
  try {
    const registry = opts.registry || coldStart;
    const answered = await registry.track("oneformer", "warmup", null, async function () {
      const answer = await doFetch(healthUrl, {
        headers: remoteShared.authHeaders(modelConfig),
        signal: AbortSignal.timeout(timeoutMs),
      });
      await answer.arrayBuffer();
      if (!answer.ok) {
        throw new Error("healthz answered " + answer.status);
      }
      return { response: answer, value: true };
    });
    return { warm: !!answered, probed: true };
  } catch (error) {
    return { warm: false, probed: true };
  }
}

module.exports = { status: status, probe: probe, classify: classify, POOLS: POOLS };
