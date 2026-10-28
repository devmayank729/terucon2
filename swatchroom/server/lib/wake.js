// Waking Modal pools on purpose - and only ever on INTENT (a photo is being scanned), never because a page loaded.
//
// A pool that has scaled to zero takes a cold start to answer, and every pool bills from the moment it boots. The scan
// itself already wakes the pool OneFormer lives on (its request IS the wake). The room pipeline that follows needs the
// other models, so when the scan starts the pools the pipeline will call are woken in the same wave instead of one after
// the other: one cold-start wait instead of two, while the designer is still looking at the scan.
//
// Nothing here pings a pool that is already warm (warmth.js), one that is booting right now (a call in flight), or the
// pool the scan request itself is about to call. With the combined pool (ANALYZE_URL on the same domain as
// ONEFORMER_URL) there is nothing left to wake: the scan call covers it.
const config = require("../config");
const coldStart = require("./coldStart");
const warmth = require("./warmth");
const remoteShared = require("./remoteModels/shared");

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (error) {
    return "";
  }
}

// The pools the room pipeline will call, as [name, modelConfig].
function pipelinePools() {
  if (config.analyze.url) {
    return [["analyze", config.analyze]];
  }
  return [
    ["sam3", config.sam3],
    ["moge2", config.moge2],
    ["marigold", config.marigold],
  ];
}

// -> [{ name, modelConfig }] to ping now. options.scanUsesOneFormer: the scan request is going to the OneFormer pool.
function targets(options) {
  const opts = options || {};
  const registry = opts.registry || coldStart;
  const settings = opts.settings || config.vision;
  const pools = opts.pools || pipelinePools();
  const scanOrigin = opts.scanUsesOneFormer ? originOf((opts.oneformer || config.oneformer).url) : "";
  const seen = new Set();
  const out = [];
  pools.forEach(function (entry) {
    const name = entry[0];
    const modelConfig = entry[1];
    if (!modelConfig.url || config.pipeline.mock === "on") {
      return;
    }
    const origin = originOf(modelConfig.url);
    if (!origin || seen.has(origin) || (scanOrigin && origin === scanOrigin)) {
      return;
    }
    const state = warmth.classify(true, registry.warmth(name), settings);
    if (state.warm || state.state === "waking") {
      return;
    }
    seen.add(origin);
    out.push({ name: name, modelConfig: modelConfig });
  });
  return out;
}

// Fire-and-forget /healthz to each target; returns the names woken. Failures are logged, never thrown.
function wake(options) {
  const opts = options || {};
  const registry = opts.registry || coldStart;
  const doFetch = opts.fetch || fetch;
  return targets(opts).map(function (target) {
    let healthUrl;
    try {
      healthUrl = new URL("/healthz", target.modelConfig.url).href;
    } catch (error) {
      return null;
    }
    registry
      .track(target.name, "warmup", null, async function () {
        const answer = await doFetch(healthUrl, {
          headers: remoteShared.authHeaders(target.modelConfig),
          signal: AbortSignal.timeout(90000),
        });
        await answer.arrayBuffer();
        return { response: answer, value: null };
      })
      .catch(function (error) {
        console.warn("Warm-up ping to " + target.name + " failed:", error.message);
      });
    return target.name;
  }).filter(Boolean);
}

module.exports = { targets: targets, wake: wake, pipelinePools: pipelinePools, originOf: originOf };
