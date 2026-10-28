// Cold start vs processing, for the owner only (read through GET /api/admin/coldstart, which needs
// the admin cookie - see routes/admin.js and the dot in public/js/views/ownerDot.js).
//
// A GPU container that has scaled to zero takes a few seconds (snapshot restore) to tens of seconds
// (fresh boot, or the first boot on a fallback GPU type) to come back. That wait is not processing:
// the model did not run slowly, nothing was running. This module times every call to the model
// services and splits the wait into the two, so a slow scan or analysis can be read at a glance.
//
// Per call the Node server knows the wall time (request sent -> body read). The Modal blueprint
// (modalBlueprint.py) adds what only the container can know: Server-Timing (time spent working),
// x-container-requests (1 = the first request that container ever served), x-container-age and
// x-gpu / x-gpu-rank (which GPU, and which entry of the preference list - rank 1+ is a fallback).
//   overhead = wall - processing           network + queue + container start
//   cold     = a fresh container served this call and the overhead is bigger than a network hop
//   coldMs   = overhead - what a warm call's overhead usually is (median of recent warm calls)
// Nothing here is written anywhere: it is a live view that starts empty when the server restarts.
const config = require("../config");

const LABELS = {
  scene: "Scene model",
  oneformer: "OneFormer",
  analyze: "Room analysis",
  sam3: "SAM 3",
  moge2: "MoGe-2",
  marigold: "Marigold-IID",
};

// A first request on a container that was born for it pays at least a snapshot restore (2.5 s is the
// fastest the audit measured), so 1.5 s of overhead already means a boot rather than a network hop.
const FIRST_REQUEST_COLD_MS = 1500;
// Several requests can queue behind one boot: only the first is "request 1", the rest waited too.
const BOOT_WITH_COMPANY_MS = 4000;
// A blueprint deployed before the telemetry headers existed: judge by timing alone, conservatively.
const UNKNOWN_COLD_MS = 6000;
// The Python scene service: beyond its own work (model load included) a wait this long means the
// whole service was asleep (a sleeping host), not the network.
const SERVICE_WAKE_MS = 8000;
const SCENE_LOAD_COLD_MS = 400;
const DEFAULT_WARM_OVERHEAD_MS = 600;
const BASELINE_SAMPLES = 7;
// No call for this long: the containers have probably been scaled down (Modal's default is 5 min).
const IDLE_AFTER_MS = 5 * 60 * 1000;
const RECENT_LIMIT = 40;
// An in-flight call that has waited this long without an answer is very likely a container boot.
const WARMUP_COLD_NOW_MS = 2000;
const CALL_COLD_NOW_MS = 12000;

function finite(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readHeader(headers, name) {
  if (!headers) {
    return null;
  }
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value === undefined ? null : value;
  }
  const key = Object.keys(headers).find(function (candidate) {
    return candidate.toLowerCase() === name;
  });
  return key ? headers[key] : null;
}

// "decode;dur=12.3, queue;dur=0.1, gpu;dur=456, encode;dur=7, total;dur=480" -> {decode: 12.3, ...}
function parseServerTiming(header) {
  const out = {};
  String(header || "").replace(
    /([A-Za-z_][\w-]*)\s*;\s*dur=([0-9.]+)/g,
    function (match, name, duration) {
      out[name.toLowerCase()] = Number(duration);
      return match;
    },
  );
  return out;
}

function median(values) {
  if (!values.length) {
    return null;
  }
  const sorted = values.slice().sort(function (a, b) {
    return a - b;
  });
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Splits one finished call into overhead and, when a fresh container served it, cold start.
// sample: { wallMs, processMs, served, ageS } - served/ageS come from the blueprint's headers and
// are null for a deployment that predates them. baselineMs: a warm call's usual overhead.
function classify(sample, baselineMs) {
  const baseline = Number.isFinite(baselineMs) ? baselineMs : DEFAULT_WARM_OVERHEAD_MS;
  const wallMs = Math.max(0, Number(sample.wallMs) || 0);
  const processMs = Number.isFinite(sample.processMs) ? Math.min(sample.processMs, wallMs) : 0;
  const overheadMs = wallMs - processMs;
  const served = finite(sample.served);
  const ageS = finite(sample.ageS);
  // A container that was born for this call is no older than the call took (plus clock slack); one
  // that was already idle in the pool is far older, and its first request is not a cold start.
  const young = ageS === null ? null : ageS <= wallMs / 1000 + 2;
  let cold;
  if (served !== null) {
    cold =
      served === 1
        ? young !== false && overheadMs >= FIRST_REQUEST_COLD_MS
        : young === true && overheadMs >= BOOT_WITH_COMPANY_MS;
  } else {
    cold = overheadMs >= UNKNOWN_COLD_MS;
  }
  return {
    cold: cold,
    overheadMs: Math.round(overheadMs),
    coldMs: cold ? Math.round(Math.max(0, overheadMs - baseline)) : 0,
  };
}

function summarize(sample, now) {
  if (!sample) {
    return null;
  }
  return {
    kind: sample.kind,
    status: sample.status,
    error: sample.error || "",
    endedAt: sample.endedAt,
    agoMs: Math.max(0, now - sample.endedAt),
    wallMs: Math.round(sample.wallMs),
    processMs: sample.processMs === null ? null : Math.round(sample.processMs),
    overheadMs: sample.overheadMs,
    cold: !!sample.cold,
    coldMs: sample.coldMs || 0,
    loadMs: sample.loadMs || 0,
    gpu: sample.gpu || "",
    gpuRank: sample.gpuRank,
    roomId: sample.roomId || "",
    device: sample.device || "",
  };
}

function createRegistry(options) {
  const clock = (options && options.now) || Date.now;
  const isConfigured = (options && options.configured) || function () {
    return true;
  };
  const models = {};
  const recent = [];
  let counter = 0;

  function entry(model) {
    if (!models[model]) {
      models[model] = {
        inflight: new Map(),
        last: null,
        lastCold: null,
        lastOkAt: null, // when the last call that really reached the service ended (see isWarm())
        warm: {}, // kind -> recent warm overheads (ms)
        warmWall: {}, // kind -> wall time of the last warm call (ms)
      };
    }
    return models[model];
  }

  function baselineFor(held, kind) {
    return median(held.warm[kind] || []);
  }

  function record(held, sample) {
    held.last = sample;
    if (sample.status === "ok") {
      held.lastOkAt = sample.endedAt;
    }
    if (sample.cold) {
      held.lastCold = sample;
    } else if (sample.status === "ok") {
      const list = held.warm[sample.kind] || (held.warm[sample.kind] = []);
      list.push(sample.overheadMs);
      if (list.length > BASELINE_SAMPLES) {
        list.shift();
      }
      held.warmWall[sample.kind] = sample.wallMs;
    }
    recent.unshift(sample);
    if (recent.length > RECENT_LIMIT) {
      recent.pop();
    }
  }

  // Starts timing one call. finish(response, extra) with the fetch Response (its headers carry the
  // container's telemetry) once the body has been read; fail(error) when it threw.
  function begin(model, kind, meta) {
    const held = entry(model);
    counter += 1;
    const id = counter;
    const startedAt = clock();
    held.inflight.set(id, { id: id, kind: kind, startedAt: startedAt });
    let settled = false;
    function settle() {
      if (settled) {
        return false;
      }
      settled = true;
      held.inflight.delete(id);
      return true;
    }
    return {
      id: id,
      finish: function (response, extra) {
        if (!settle()) {
          return null;
        }
        const endedAt = clock();
        const headers = response && response.headers;
        const timing = parseServerTiming(readHeader(headers, "server-timing"));
        const sample = Object.assign({}, meta || {}, {
          id: id,
          model: model,
          kind: kind,
          status: "ok",
          error: "",
          startedAt: startedAt,
          endedAt: endedAt,
          wallMs: endedAt - startedAt,
          processMs: Number.isFinite(timing.total) ? timing.total : null,
          timing: timing,
          gpu: readHeader(headers, "x-gpu") || "",
          gpuRank: finite(readHeader(headers, "x-gpu-rank")),
          served: finite(readHeader(headers, "x-container-requests")),
          ageS: finite(readHeader(headers, "x-container-age")),
        }, extra || {});
        Object.assign(sample, classify(sample, baselineFor(held, kind)));
        record(held, sample);
        return sample;
      },
      fail: function (error) {
        if (!settle()) {
          return null;
        }
        const endedAt = clock();
        const sample = Object.assign({}, meta || {}, {
          id: id,
          model: model,
          kind: kind,
          status: "error",
          error: String((error && error.message) || "failed").slice(0, 200),
          startedAt: startedAt,
          endedAt: endedAt,
          wallMs: endedAt - startedAt,
          processMs: null,
          overheadMs: 0,
          cold: false,
          coldMs: 0,
          timing: {},
          gpu: "",
          gpuRank: null,
          served: null,
          ageS: null,
        });
        record(held, sample);
        return sample;
      },
    };
  }

  // Runs one call to a model service: perform() resolves { response, value } - the response only
  // for its headers, the value is what the caller wants. The wall time includes reading the body.
  async function track(model, kind, meta, perform) {
    const handle = begin(model, kind, meta);
    let result;
    try {
      result = await perform();
    } catch (error) {
      handle.fail(error);
      throw error;
    }
    handle.finish(result.response);
    return result.value;
  }

  // The Python scene service reports its own model-load time; a load is its cold start.
  function noteScene(fields) {
    const held = entry("scene");
    const endedAt = clock();
    const wallMs = Math.max(0, Number(fields.wallMs) || 0);
    const loadMs = Math.max(0, Number(fields.loadMs) || 0);
    const processMs = Math.max(0, Number(fields.processMs) || 0);
    const overheadMs = Math.max(0, wallMs - processMs - loadMs);
    const woke = overheadMs >= SERVICE_WAKE_MS;
    const cold = loadMs >= SCENE_LOAD_COLD_MS || woke;
    const baseline = baselineFor(held, "segment");
    const sample = {
      id: (counter += 1),
      model: "scene",
      kind: "segment",
      status: "ok",
      error: "",
      startedAt: endedAt - wallMs,
      endedAt: endedAt,
      wallMs: wallMs,
      processMs: processMs,
      overheadMs: Math.round(overheadMs),
      loadMs: Math.round(loadMs),
      cold: cold,
      coldMs: cold
        ? Math.round(loadMs + (woke ? Math.max(0, overheadMs - (baseline === null ? DEFAULT_WARM_OVERHEAD_MS : baseline)) : 0))
        : 0,
      timing: {},
      gpu: "",
      gpuRank: null,
      served: null,
      ageS: null,
      device: String(fields.device || ""),
    };
    record(held, sample);
    return sample;
  }

  function stateOf(held, now) {
    let coldNow = false;
    held.inflight.forEach(function (call) {
      const elapsed = now - call.startedAt;
      if (call.kind === "warmup") {
        coldNow = coldNow || elapsed >= WARMUP_COLD_NOW_MS;
        return;
      }
      const usual = held.warmWall[call.kind];
      const limit = Math.max(CALL_COLD_NOW_MS, usual ? usual * 2 + 4000 : 0);
      coldNow = coldNow || elapsed >= limit;
    });
    if (coldNow) {
      return "cold-now";
    }
    if (!held.last) {
      return "unknown";
    }
    if (held.last.status === "error") {
      return "error";
    }
    if (now - held.last.endedAt > IDLE_AFTER_MS) {
      return "idle";
    }
    return held.last.cold ? "cold" : "warm";
  }

  function snapshot() {
    const now = clock();
    return {
      now: now,
      idleAfterMs: IDLE_AFTER_MS,
      models: Object.keys(LABELS).map(function (key) {
        const held = entry(key);
        const inflight = [];
        held.inflight.forEach(function (call) {
          inflight.push({ kind: call.kind, elapsedMs: now - call.startedAt });
        });
        return {
          key: key,
          label: LABELS[key],
          configured: !!isConfigured(key),
          state: stateOf(held, now),
          inflight: inflight,
          last: summarize(held.last, now),
          lastCold: summarize(held.lastCold, now),
        };
      }),
      recent: recent.slice(0, 12).map(function (sample) {
        return Object.assign({ model: sample.model }, summarize(sample, now));
      }),
    };
  }

  // What this server knows about a service WITHOUT calling it: every call to a Modal pool goes through this
  // server, and a pool stays up for its scaledown window after the last one, so "how long ago did my last call
  // succeed" answers "is it still warm". null lastOkAt = this server has not reached it since it started.
  function warmth(model) {
    const held = entry(model);
    const now = clock();
    return {
      lastOkAt: held.lastOkAt,
      idleMs: held.lastOkAt === null ? null : Math.max(0, now - held.lastOkAt),
      inflight: held.inflight.size,
    };
  }

  function reset() {
    Object.keys(models).forEach(function (key) {
      delete models[key];
    });
    recent.length = 0;
  }

  return {
    begin: begin,
    track: track,
    noteScene: noteScene,
    snapshot: snapshot,
    warmth: warmth,
    reset: reset,
  };
}

const registry = createRegistry({
  configured: function (key) {
    if (key === "scene") {
      return true;
    }
    return !!(config[key] && config[key].url);
  },
});

module.exports = {
  begin: registry.begin,
  track: registry.track,
  noteScene: registry.noteScene,
  snapshot: registry.snapshot,
  warmth: registry.warmth,
  createRegistry: createRegistry,
  classify: classify,
  parseServerTiming: parseServerTiming,
  LABELS: LABELS,
};
