// The start-up gate: the "Powered by Terucon India" splash stays up until the server has said whether the Modal vision
// engine is warm, and never longer than 10 seconds.
//
//   modalIsWarm === true   Modal answered inside the window and its pool is live: the scan may trust OneFormer to be
//                          quick (it still races the local SegFormer, see segmentRace.js)
//   modalIsWarm === false  the answer was "cold / unknown / unreachable", or none came within 10.0 s: the scan runs
//                          the local model AND Modal at once
//
// The question is GET /api/vision/warmup. By default the server answers it from its own record of its last Modal call
// (server/lib/warmth.js), which is instant and never wakes a billed GPU, so the gate normally closes after its short
// minimum (the splash would flash otherwise). With VISION_ACTIVE_WARMUP=on the server really pings a cold pool, the
// request then takes as long as the pool needs, and this gate is what stops that from holding the designer: at
// maxMs it gives up, records "not warm" and opens the studio.
//
// Pure of the DOM and of the clock (both injected) so tests can run a 10-second gate in no time.

export const GATE_MAX_MS = 10000;
export const GATE_MIN_MS = 1200;

// How far along the progress bar is, 0..1, `elapsedMs` into a gate of `maxMs`. Eases out toward 0.92 so it always keeps
// moving but never claims to be done before the gate is: it jumps to 1 when the gate closes.
export function progressAt(elapsedMs, maxMs) {
  const t = Math.min(1, Math.max(0, elapsedMs / maxMs));
  return 0.92 * (1 - Math.pow(1 - t, 2.2));
}

// What the splash says at this point of the wait.
export function statusAt(elapsedMs, answered) {
  if (answered) {
    return "Ready";
  }
  if (elapsedMs < 2500) {
    return "Initializing 3D AI Vision Engine...";
  }
  if (elapsedMs < 6000) {
    return "Warming up the surface models...";
  }
  return "Still starting the vision engine, almost there...";
}

// options:
//   check()        -> Promise<{ configured?: boolean, warm: boolean }>   (rejects when the server cannot be reached)
//   maxMs, minMs   defaults GATE_MAX_MS / GATE_MIN_MS
//   now()          -> ms           (default performance.now)
//   setTimer(fn, ms) / clearTimer(id)   (default setTimeout / clearTimeout)
//   onTick({ elapsedMs, progress, status })   called every tickMs and once more when the gate closes
//   tickMs         default 100
// -> Promise<{ modalIsWarm, reason, elapsedMs }>
//   reason: "warm" | "cold" | "unconfigured" | "timeout" | "error"
export function runStartupGate(options) {
  const maxMs = options.maxMs || GATE_MAX_MS;
  const minMs = Math.min(options.minMs === undefined ? GATE_MIN_MS : options.minMs, maxMs);
  const now = options.now || (() => performance.now());
  const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer || ((id) => clearTimeout(id));
  const tickMs = options.tickMs || 100;
  const onTick = options.onTick || function () {};
  const startedAt = now();

  return new Promise(function (resolve) {
    let settled = false;
    let answered = null; // { modalIsWarm, reason }
    let tickId = 0;
    let deadlineId = 0;
    let minId = 0;

    function elapsed() {
      return Math.max(0, now() - startedAt);
    }

    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer(tickId);
      clearTimer(deadlineId);
      clearTimer(minId);
      const ms = elapsed();
      onTick({ elapsedMs: ms, progress: 1, status: statusAt(ms, true) });
      resolve({ modalIsWarm: result.modalIsWarm, reason: result.reason, elapsedMs: Math.round(ms) });
    }

    // an answer is held until the minimum has passed, so the splash is never a one-frame flash
    function settleWhenAllowed() {
      if (settled || !answered) {
        return;
      }
      const wait = minMs - elapsed();
      if (wait <= 0) {
        finish(answered);
      } else {
        clearTimer(minId);
        minId = setTimer(function () {
          finish(answered);
        }, wait);
      }
    }

    function tick() {
      if (settled) {
        return;
      }
      const ms = elapsed();
      onTick({ elapsedMs: ms, progress: progressAt(ms, maxMs), status: statusAt(ms, !!answered) });
      tickId = setTimer(tick, tickMs);
    }
    tick();

    // the hard limit: whatever Modal is doing, the designer is never held longer than maxMs
    deadlineId = setTimer(function () {
      finish({ modalIsWarm: false, reason: "timeout" });
    }, maxMs);

    let promise;
    try {
      promise = Promise.resolve(options.check());
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(
      function (status) {
        if (settled) {
          return;
        }
        if (status && status.configured === false) {
          answered = { modalIsWarm: false, reason: "unconfigured" };
        } else if (status && status.warm) {
          answered = { modalIsWarm: true, reason: "warm" };
        } else {
          answered = { modalIsWarm: false, reason: "cold" };
        }
        settleWhenAllowed();
      },
      function () {
        if (!settled) {
          answered = { modalIsWarm: false, reason: "error" };
          settleWhenAllowed();
        }
      },
    );
  });
}
