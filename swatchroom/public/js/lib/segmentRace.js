// Scene parsing is a race between two engines, and the designer gets whichever finishes first:
//   local   the quantized SegFormer-B5 in the model service (always there, a few seconds on a CPU)
//   remote  OneFormer on Modal (more accurate, fast when its GPU is warm, a cold start when it is not)
//
// Who starts when:
//   Modal known cold or not answering the start-up gate (modalIsWarm === false)  -> both start NOW
//   Modal warm (or unknown)  -> remote starts now; local joins only if remote has not answered in remoteDelayMs (2.5 s)
// The first engine to produce a result is `first`, and the scan is built from it at once so the designer can start
// tapping. If that engine was the local one and the remote one arrives later, `upgrade` resolves with the remote
// result so the caller can build the higher-accuracy scan in the background and offer it ("HD Surface Scan Ready").
// If remote wins, the local request is cancelled (it only costs CPU on the model service) and there is no upgrade.
//
// A request is never cancelled just because the other one won first when it is the REMOTE one: that call carries the
// work the room pipeline will reuse, and Modal bills it either way.
//
// Pure of the DOM, the network and the clock: `local(signal)` and `remote(signal)` are functions returning promises.

export const REMOTE_HEAD_START_MS = 2500;

function abortError() {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

// options: { local, remote, modalIsWarm, remoteDelayMs, signal, setTimer, clearTimer, onEvent }
//   local/remote: (signal) => Promise<result>, or null when that engine is not available
//   onEvent({ type, ... }): "start" { engine }, "result" { engine }, "error" { engine, error }, "skip" { engine }
// -> { first: Promise<{ engine, result }>, upgrade: Promise<{ engine, result } | null>, cancel() }
export function raceSegmentation(options) {
  const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer || ((id) => clearTimeout(id));
  const delay = options.remoteDelayMs === undefined ? REMOTE_HEAD_START_MS : options.remoteDelayMs;
  const emit = options.onEvent || function () {};
  const cold = options.modalIsWarm === false;

  const runs = {
    local: { fn: options.local, controller: new AbortController(), started: false, state: "idle", result: null, error: null },
    remote: { fn: options.remote, controller: new AbortController(), started: false, state: "idle", result: null, error: null },
  };
  let timerId = 0;
  let winner = null;
  let cancelled = false;
  let resolveFirst;
  let rejectFirst;
  let resolveUpgrade;
  const first = new Promise(function (resolve, reject) {
    resolveFirst = resolve;
    rejectFirst = reject;
  });
  const upgrade = new Promise(function (resolve) {
    resolveUpgrade = resolve;
  });

  function other(engine) {
    return engine === "local" ? "remote" : "local";
  }

  function conclude() {
    // called after every settlement: decides first / upgrade / failure
    if (cancelled) {
      return;
    }
    const local = runs.local;
    const remote = runs.remote;
    if (!winner) {
      const done = [local, remote].filter(function (run) {
        return run.state === "ok";
      });
      if (done.length > 0) {
        // the earliest finisher is the one that settled first; runs settle one at a time, so the first "ok" seen here
        const engine = done[0] === local ? "local" : "remote";
        winner = engine;
        resolveFirst({ engine: engine, result: runs[engine].result });
        if (engine === "remote") {
          if (local.started && local.state === "running") {
            local.controller.abort(); // the remote answer is all the designer needs; stop spending the model service's CPU
          }
          resolveUpgrade(null);
        } else if (!remote.fn || remote.state === "failed" || remote.state === "skipped") {
          resolveUpgrade(null);
        }
        return;
      }
      const stillPossible = [local, remote].some(function (run) {
        return run.fn && (run.state === "running" || run.state === "idle");
      });
      if (!stillPossible) {
        const failed = [local, remote].filter(function (run) {
          return run.state === "failed";
        });
        const error = (failed.length && (failed[0].error || (failed[1] && failed[1].error))) || new Error("No scene model is available.");
        rejectFirst(error);
        resolveUpgrade(null);
      }
      return;
    }
    // a winner exists: resolve the upgrade when the loser settles
    if (winner === "local") {
      if (remote.state === "ok") {
        resolveUpgrade({ engine: "remote", result: remote.result });
      } else if (remote.state === "failed" || remote.state === "skipped" || !remote.fn) {
        resolveUpgrade(null);
      }
    }
  }

  function start(engine) {
    const run = runs[engine];
    if (cancelled || run.started || !run.fn) {
      return;
    }
    run.started = true;
    run.state = "running";
    emit({ type: "start", engine: engine });
    let promise;
    try {
      promise = Promise.resolve(run.fn(run.controller.signal));
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(
      function (result) {
        if (run.controller.signal.aborted && engine === "local" && winner === "remote") {
          run.state = "skipped";
          return;
        }
        run.state = "ok";
        run.result = result;
        emit({ type: "result", engine: engine });
        if (engine === "remote") {
          clearTimer(timerId);
        }
        conclude();
      },
      function (error) {
        run.state = run.controller.signal.aborted && engine === "local" && winner === "remote" ? "skipped" : "failed";
        run.error = error;
        if (run.state === "failed") {
          emit({ type: "error", engine: engine, error: error });
        }
        if (engine === "remote") {
          clearTimer(timerId);
          // remote is out: the local engine must not keep waiting for its head start to run out
          start("local");
        }
        conclude();
      },
    );
  }

  function cancel() {
    if (cancelled) {
      return;
    }
    cancelled = true;
    clearTimer(timerId);
    runs.local.controller.abort();
    runs.remote.controller.abort();
    rejectFirst(abortError());
    resolveUpgrade(null);
  }

  if (options.signal) {
    if (options.signal.aborted) {
      cancel();
    } else {
      options.signal.addEventListener("abort", cancel, { once: true });
    }
  }

  if (!cancelled) {
    if (!runs.remote.fn) {
      emit({ type: "skip", engine: "remote" });
      runs.remote.state = "skipped";
      start("local");
    } else if (!runs.local.fn) {
      emit({ type: "skip", engine: "local" });
      runs.local.state = "skipped";
      start("remote");
    } else if (cold) {
      start("remote");
      start("local");
    } else {
      start("remote");
      timerId = setTimer(function () {
        if (!winner) {
          start("local");
        }
      }, delay);
    }
  }

  // never leave a rejection unhandled when the caller only awaits one of the promises
  first.catch(function () {});
  return { first: first, upgrade: upgrade, cancel: cancel, runs: runs };
}
