// Turns the server's cold-start snapshot (GET /api/admin/coldstart, built by server/lib/coldStart.js)
// and the last scan's timings (lib/ownerTimings.js) into the few words and the one colour the owner's
// dot shows. No DOM here, so it can be tested on its own (tests/owner.test.js).

// Worst first: what the dot's colour reports when several services disagree.
const STATE_ORDER = ["cold-now", "error", "cold", "warm", "idle", "unknown"];
// A cold start stays on the dot (steady amber) this long after it ended, even though the container
// is warm by then: the usual reason to look is "why was that slow?", a few seconds after the fact.
const RECENT_COLD_MS = 2 * 60 * 1000;

function recentCold(model) {
  return model.lastCold && model.lastCold.agoMs <= RECENT_COLD_MS
    ? model.lastCold
    : null;
}

// The state of one service as the dot sees it: warm, but with a cold start in the last two minutes,
// reads as cold.
export function modelState(model) {
  if ((model.state === "warm" || model.state === "idle") && recentCold(model)) {
    return "cold";
  }
  return model.state;
}

export function seconds(ms) {
  if (!Number.isFinite(ms)) {
    return "";
  }
  if (ms < 950) {
    return Math.round(ms) + " ms";
  }
  return (ms / 1000).toFixed(ms < 9950 ? 1 : 0) + " s";
}

export function ago(ms) {
  if (!Number.isFinite(ms)) {
    return "";
  }
  const total = Math.round(ms / 1000);
  if (total < 90) {
    return total + " s ago";
  }
  if (total < 5400) {
    return Math.round(total / 60) + " min ago";
  }
  return Math.round(total / 3600) + " h ago";
}

// "NVIDIA A100-SXM4-40GB" -> "A100", "NVIDIA L4" -> "L4"
export function shortGpu(name) {
  return String(name || "")
    .replace(/^NVIDIA\s+/i, "")
    .split("-")[0]
    .trim();
}

// The state the dot is drawn in, from every configured service.
//   cold-now  a container is waking up right now (amber, pulsing)
//   error     the last call failed (red)
//   cold      the last call had to wait for a cold start (amber)
//   warm      the last calls were served by warm containers (green)
//   idle      nothing for a few minutes: the next call may cold-start (grey)
//   unknown   nothing seen yet (grey ring)
export function overallState(snapshot) {
  const models = ((snapshot && snapshot.models) || []).filter(function (model) {
    return model.configured;
  });
  let best = "unknown";
  models.forEach(function (model) {
    const state = modelState(model);
    if (STATE_ORDER.indexOf(state) !== -1 && STATE_ORDER.indexOf(state) < STATE_ORDER.indexOf(best)) {
      best = state;
    }
  });
  // idle and warm mixed together is still warm: the idle one just has not been called lately
  return best;
}

// One line per service: { state, name, text, fallback }.
export function describeModel(model) {
  if (!model.configured) {
    const variable = SHOWN_WHEN_OFF[model.key];
    return {
      state: "unknown",
      name: model.label,
      text: "not set up" + (variable ? ": add " + variable + " to .env (see DEPLOY.md)" : ""),
      fallback: false,
    };
  }
  const last = model.last;
  const waiting = model.inflight && model.inflight.length ? model.inflight[0] : null;
  const gpu = last && last.gpu ? shortGpu(last.gpu) : "";
  const fallback = !!(last && Number.isFinite(last.gpuRank) && last.gpuRank >= 1);
  const parts = [];
  if (model.state === "cold-now" && waiting) {
    parts.push(
      (waiting.kind === "warmup" ? "waking up, " : "waiting for a container, ") +
        seconds(waiting.elapsedMs) +
        " so far",
    );
  } else if (!last) {
    parts.push("no calls yet");
  } else if (last.status === "error") {
    parts.push("failed: " + (last.error || "error"));
  } else {
    const what = { warmup: "warm-up", analyze: "analysis", segment: "scan" }[last.kind] || last.kind;
    if (last.cold) {
      parts.push(
        (model.key === "scene" ? "model load " : "cold start ") + seconds(last.coldMs),
      );
    } else {
      parts.push("warm");
    }
    if (last.processMs !== null && last.processMs !== undefined) {
      parts.push("processing " + seconds(last.processMs));
    }
    parts.push(what);
    if (gpu) {
      parts.push(gpu + (fallback ? " (fallback)" : ""));
    } else if (last.device) {
      parts.push(last.device);
    }
    parts.push(ago(last.agoMs));
  }
  // The latest cold start is worth keeping in view after warm calls have followed it.
  const cold = recentCold(model);
  if (cold && !(last && last.cold)) {
    parts.push(
      (model.key === "scene" ? "model load " : "cold start ") +
        seconds(cold.coldMs) +
        " " +
        ago(cold.agoMs),
    );
  }
  return {
    state: modelState(model),
    name: model.label,
    text: parts.join(" · "),
    fallback: fallback,
  };
}

// The sentence at the top of the card.
export function headline(snapshot) {
  const state = overallState(snapshot);
  const models = ((snapshot && snapshot.models) || []).filter(function (model) {
    return model.configured;
  });
  if (state === "cold-now") {
    const waking = models.filter(function (model) {
      return model.state === "cold-now";
    });
    return "Cold start under way: " + waking.map(function (model) {
      return model.label;
    }).join(", ") + ". This is waiting, not processing.";
  }
  if (state === "error") {
    const failed = models.find(function (model) {
      return model.state === "error";
    });
    return (failed ? failed.label : "A service") + " failed on its last call.";
  }
  if (state === "cold") {
    // the longest recent cold start: the services start in parallel, so that is the wait you felt
    const worst = models
      .filter(function (model) {
        return recentCold(model) || (model.last && model.last.cold);
      })
      .map(function (model) {
        return { label: model.label, cold: recentCold(model) || model.last };
      })
      .reduce(function (best, item) {
        return !best || item.cold.coldMs > best.cold.coldMs ? item : best;
      }, null);
    const stillWaking = models.some(function (model) {
      return model.state === "cold-now";
    });
    return (
      "Cold start of " +
      (worst ? seconds(worst.cold.coldMs) : "?") +
      " (" +
      (worst ? worst.label : "") +
      (worst && Number.isFinite(worst.cold.agoMs) ? ", " + ago(worst.cold.agoMs) : "") +
      "). That wait was not processing time" +
      (stillWaking ? "." : "; the containers are warm now.")
    );
  }
  if (state === "warm") {
    return "Warm: the last calls were served by running containers.";
  }
  if (state === "idle") {
    return "Idle for a while: the next call may have to cold-start.";
  }
  return "No calls seen yet.";
}

// "SegFormer-B5 (fp32, mps)", "OneFormer (Modal)", "SegFormer-B4 (B5 could not load)": which model actually answered
export function modelName(timings) {
  const raw = String((timings && timings.segmentModel) || "");
  if (!raw) {
    return "";
  }
  const id = raw.split("/").pop();
  let name = id;
  const segformer = /segformer-(b\d)/i.exec(id);
  if (segformer) {
    name = "SegFormer-" + segformer[1].toUpperCase();
  } else if (/oneformer/i.test(id)) {
    name = "OneFormer";
  }
  const detail = [];
  if (timings.segmentEngine === "remote") {
    detail.push("Modal");
  } else if (timings.segmentPrecision) {
    detail.push(timings.segmentPrecision);
  }
  if (timings.segmentDevice && timings.segmentEngine !== "remote") {
    detail.push(timings.segmentDevice);
  }
  if (timings.segmentFellBackFrom) {
    detail.push(String(timings.segmentFellBackFrom).split("/").pop().replace(/^segformer-(b\d).*$/i, "$1").toUpperCase() + " could not load");
  }
  return name + (detail.length ? " (" + detail.join(", ") + ")" : "");
}

// Services that are not set up are normally left out of the card; these two are shown, because without them the scan has no
// HD model and every photo wakes the separate GPU pools, and nothing else on screen says so.
export const SHOWN_WHEN_OFF = {
  oneformer: "ONEFORMER_URL",
  analyze: "ANALYZE_URL",
};

// "Last scan 18.4 s: photo 0.3 s, scene model 5.6 s, AI outlines 12.1 s (these two run together), edges 0.4 s"
export function describeScan(timings) {
  if (!timings || !Number.isFinite(timings.totalMs)) {
    return "";
  }
  const parts = [];
  if (Number.isFinite(timings.prepMs)) {
    parts.push("photo " + seconds(timings.prepMs));
  }
  if (Number.isFinite(timings.segmentMs)) {
    parts.push(
      "scene model " +
        (modelName(timings) ? modelName(timings) + " " : "") +
        seconds(timings.segmentMs) +
        (timings.segmentLoadMs >= 400
          ? " (" + seconds(timings.segmentLoadMs) + " of it loading the model)"
          : ""),
    );
  }
  if (Number.isFinite(timings.outlinesMs)) {
    parts.push("AI outlines " + seconds(timings.outlinesMs));
  }
  if (Number.isFinite(timings.buildMs)) {
    parts.push("edges " + seconds(timings.buildMs));
  }
  const together =
    Number.isFinite(timings.segmentMs) && Number.isFinite(timings.outlinesMs)
      ? " (model and AI run together)"
      : "";
  return "Last scan " + seconds(timings.totalMs) + ": " + parts.join(", ") + together;
}
