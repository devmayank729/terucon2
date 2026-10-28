// Tests for the start-up gate (public/js/lib/startupGate.js: the "Powered by Terucon India" splash, 10 s at most),
// the segmentation race between the local SegFormer-B5 and OneFormer on Modal (public/js/lib/segmentRace.js), and the
// HD-scan swap that keeps the designer's selection (public/js/lib/hdSwap.js). Pure logic, run on a fake clock, so ten
// seconds take no time. Run with:  node tests/startup_race.test.js
const assert = require("node:assert/strict");

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push({ name: name, fn: fn });
}

// A clock and timers the test moves by hand.
function fakeClock() {
  const state = { now: 0, nextId: 1, timers: [] };
  return {
    state: state,
    now: function () {
      return state.now;
    },
    setTimer: function (fn, ms) {
      const id = state.nextId++;
      state.timers.push({ id: id, at: state.now + ms, fn: fn });
      return id;
    },
    clearTimer: function (id) {
      state.timers = state.timers.filter(function (timer) {
        return timer.id !== id;
      });
    },
    // advance by ms, firing timers in order, letting promise callbacks run between them
    advance: async function (ms) {
      const target = state.now + ms;
      for (;;) {
        state.timers.sort(function (a, b) {
          return a.at - b.at;
        });
        const next = state.timers[0];
        if (!next || next.at > target) {
          break;
        }
        state.timers.shift();
        state.now = next.at;
        next.fn();
        await flush();
      }
      state.now = target;
      await flush();
    },
  };
}
async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}
function deferred() {
  const d = {};
  d.promise = new Promise(function (resolve, reject) {
    d.resolve = resolve;
    d.reject = reject;
  });
  return d;
}

(async function () {
  const gateModule = await import("../public/js/lib/startupGate.js");
  const raceModule = await import("../public/js/lib/segmentRace.js");
  const swapModule = await import("../public/js/lib/hdSwap.js");
  const regions = await import("../public/js/lib/regions.js");
  const { runStartupGate, GATE_MAX_MS, GATE_MIN_MS, progressAt, statusAt } = gateModule;
  const { raceSegmentation } = raceModule;

  function gate(clock, check, extra) {
    const ticks = [];
    const promise = runStartupGate(
      Object.assign(
        {
          check: check,
          now: clock.now,
          setTimer: clock.setTimer,
          clearTimer: clock.clearTimer,
          onTick: function (t) {
            ticks.push(t);
          },
        },
        extra || {},
      ),
    );
    let result = null;
    promise.then(function (r) {
      result = r;
    });
    return { promise: promise, ticks: ticks, result: function () { return result; } };
  }

  // ---------------------------------------------------------------- the 10-second gate
  test("the gate is 10.0 s at most and shows the splash for a short minimum", function () {
    assert.equal(GATE_MAX_MS, 10000);
    assert.ok(GATE_MIN_MS >= 800 && GATE_MIN_MS <= 2000);
  });

  test("Modal answers 'warm' at once: the splash waits only its minimum, then modalIsWarm is true", async function () {
    const clock = fakeClock();
    const g = gate(clock, () => Promise.resolve({ configured: true, warm: true }));
    await clock.advance(300);
    assert.equal(g.result(), null, "still within the minimum display time");
    await clock.advance(GATE_MIN_MS);
    assert.deepEqual(
      { warm: g.result().modalIsWarm, reason: g.result().reason },
      { warm: true, reason: "warm" },
    );
    assert.ok(g.result().elapsedMs <= GATE_MIN_MS + 200, "closed at the minimum, not later: " + g.result().elapsedMs);
  });

  test("a cold or unknown answer also ends the wait quickly, with modalIsWarm false", async function () {
    const clock = fakeClock();
    const g = gate(clock, () => Promise.resolve({ configured: true, warm: false, state: "unknown" }));
    await clock.advance(GATE_MIN_MS + 50);
    assert.equal(g.result().modalIsWarm, false);
    assert.equal(g.result().reason, "cold");
  });

  test("no answer within 10.0 s: the splash is dismissed AT 10 s and modalIsWarm is false", async function () {
    const clock = fakeClock();
    const never = deferred();
    const g = gate(clock, () => never.promise);
    await clock.advance(9990);
    assert.equal(g.result(), null, "not before 10 s");
    await clock.advance(20);
    assert.equal(g.result().modalIsWarm, false);
    assert.equal(g.result().reason, "timeout");
    assert.ok(g.result().elapsedMs >= 9990 && g.result().elapsedMs <= 10100, "elapsed " + g.result().elapsedMs);
    // a late 'warm' answer after the gate closed changes nothing
    never.resolve({ warm: true });
    await clock.advance(50);
    assert.equal(g.result().modalIsWarm, false);
  });

  test("an answer at 9.9 s still counts; the server being unreachable is 'not warm', not a hang", async function () {
    const clock = fakeClock();
    const late = deferred();
    const g = gate(clock, () => late.promise);
    await clock.advance(9900);
    late.resolve({ configured: true, warm: true });
    await clock.advance(10);
    assert.equal(g.result().modalIsWarm, true);

    const clock2 = fakeClock();
    const g2 = gate(clock2, () => Promise.reject(new Error("offline")));
    await clock2.advance(GATE_MIN_MS + 50);
    assert.equal(g2.result().modalIsWarm, false);
    assert.equal(g2.result().reason, "error");
  });

  test("with no Modal engine configured the gate says so (reason 'unconfigured') and the race stays local", async function () {
    const clock = fakeClock();
    const g = gate(clock, () => Promise.resolve({ configured: false, warm: false }));
    await clock.advance(GATE_MIN_MS + 50);
    assert.equal(g.result().reason, "unconfigured");
    assert.equal(g.result().modalIsWarm, false);
  });

  test("progress only ever moves forward, stays under 100% until the gate closes, then jumps to 100%", async function () {
    let last = -1;
    for (let ms = 0; ms <= 10000; ms += 250) {
      const p = progressAt(ms, 10000);
      assert.ok(p >= last && p < 1, "progress at " + ms + " is " + p);
      last = p;
    }
    const clock = fakeClock();
    const g = gate(clock, () => Promise.resolve({ configured: true, warm: true }));
    await clock.advance(GATE_MIN_MS + 100);
    assert.equal(g.ticks[g.ticks.length - 1].progress, 1);
    assert.equal(g.ticks[g.ticks.length - 1].status, "Ready");
    assert.match(statusAt(0, false), /Initializing 3D AI Vision Engine/);
  });

  // ---------------------------------------------------------------- the race
  function engines(clock) {
    const local = deferred();
    const remote = deferred();
    const log = [];
    return {
      local: local,
      remote: remote,
      log: log,
      options: function (extra) {
        return Object.assign(
          {
            local: function (signal) {
              log.push("local-start");
              signal.addEventListener("abort", function () {
                log.push("local-aborted");
                local.reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
              });
              return local.promise;
            },
            remote: function (signal) {
              log.push("remote-start");
              signal.addEventListener("abort", function () {
                log.push("remote-aborted");
              });
              return remote.promise;
            },
            setTimer: clock.setTimer,
            clearTimer: clock.clearTimer,
          },
          extra || {},
        );
      },
    };
  }

  test("Modal known cold (modalIsWarm false): BOTH engines start at once", async function () {
    const clock = fakeClock();
    const e = engines(clock);
    raceSegmentation(e.options({ modalIsWarm: false }));
    await flush();
    assert.deepEqual(e.log.sort(), ["local-start", "remote-start"]);
  });

  test("Modal warm: only OneFormer starts; the local model joins only if it has not answered in 2.5 s", async function () {
    const clock = fakeClock();
    const e = engines(clock);
    raceSegmentation(e.options({ modalIsWarm: true }));
    await clock.advance(2400);
    assert.deepEqual(e.log, ["remote-start"]);
    await clock.advance(200);
    assert.deepEqual(e.log, ["remote-start", "local-start"], "2.5 s passed with no OneFormer answer: race both");
  });

  test("Modal warm and fast (< 2.5 s): the local model is never started", async function () {
    const clock = fakeClock();
    const e = engines(clock);
    const race = raceSegmentation(e.options({ modalIsWarm: true }));
    await clock.advance(800);
    e.remote.resolve({ model: "oneformer" });
    const first = await race.first;
    assert.equal(first.engine, "remote");
    await clock.advance(5000);
    assert.deepEqual(e.log, ["remote-start"]);
    assert.equal(await race.upgrade, null);
  });

  test("local B5 first, OneFormer later: the scan is built from B5 at once and OneFormer arrives as the upgrade", async function () {
    const clock = fakeClock();
    const e = engines(clock);
    const race = raceSegmentation(e.options({ modalIsWarm: false }));
    let upgraded = null;
    race.upgrade.then(function (u) {
      upgraded = u;
    });
    e.local.resolve({ model: "segformer-b5" });
    const first = await race.first;
    assert.equal(first.engine, "local");
    assert.equal(upgraded, null, "no upgrade yet");
    e.remote.resolve({ model: "oneformer" });
    await flush();
    assert.equal(upgraded.engine, "remote");
    assert.equal(upgraded.result.model, "oneformer");
    assert.ok(e.log.indexOf("remote-aborted") === -1, "the Modal request is never cancelled when local wins");
  });

  test("OneFormer first while the local model is mid-way: the local request is cancelled, there is no upgrade", async function () {
    const clock = fakeClock();
    const e = engines(clock);
    const race = raceSegmentation(e.options({ modalIsWarm: false }));
    e.remote.resolve({ model: "oneformer" });
    const first = await race.first;
    assert.equal(first.engine, "remote");
    await flush();
    assert.ok(e.log.indexOf("local-aborted") !== -1, "local CPU work is stopped");
    assert.equal(await race.upgrade, null);
  });

  test("OneFormer fails quickly (Modal down): the local model starts at once, no waiting for the 2.5 s", async function () {
    const clock = fakeClock();
    const e = engines(clock);
    const events = [];
    const race = raceSegmentation(e.options({ modalIsWarm: true, onEvent: (event) => events.push(event.type + ":" + event.engine) }));
    await clock.advance(100);
    e.remote.reject(new Error("503"));
    await flush();
    assert.ok(e.log.indexOf("local-start") !== -1);
    e.local.resolve({ model: "segformer-b5" });
    const first = await race.first;
    assert.equal(first.engine, "local");
    assert.equal(await race.upgrade, null);
    assert.ok(events.indexOf("error:remote") !== -1, "the failure is reported so modalIsWarm can be set to false");
  });

  test("no remote engine configured: local only, no upgrade", async function () {
    const clock = fakeClock();
    const e = engines(clock);
    const race = raceSegmentation(e.options({ remote: null, modalIsWarm: true }));
    e.local.resolve({ model: "segformer-b5" });
    assert.equal((await race.first).engine, "local");
    assert.equal(await race.upgrade, null);
    assert.deepEqual(e.log, ["local-start"]);
  });

  test("both engines fail: the scan fails with an error (so the Gemini fallback can take over)", async function () {
    const clock = fakeClock();
    const e = engines(clock);
    const race = raceSegmentation(e.options({ modalIsWarm: false }));
    e.remote.reject(new Error("modal down"));
    e.local.reject(new Error("model service down"));
    await assert.rejects(race.first, /down/);
  });

  test("the designer cancelling the scan stops both engines", async function () {
    const clock = fakeClock();
    const e = engines(clock);
    const controller = new AbortController();
    const race = raceSegmentation(e.options({ modalIsWarm: false, signal: controller.signal }));
    controller.abort();
    await assert.rejects(race.first, (error) => error.name === "AbortError");
    assert.ok(e.log.indexOf("local-aborted") !== -1 && e.log.indexOf("remote-aborted") !== -1);
  });

  // ---------------------------------------------------------------- swapping in the HD scan
  const W = 40;
  const H = 30;
  function scanWith(split) {
    // left half region A, right half region B; `split` moves the boundary
    const labelMap = new Uint16Array(W * H);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        labelMap[y * W + x] = x < split ? 1 : 2;
      }
    }
    return regions.scanFromLabelMap(
      labelMap,
      [
        { index: 1, label: "Wall A", kind: "wall", source: "scene" },
        { index: 2, label: "Wall B", kind: "wall", source: "scene" },
      ],
      W,
      H,
    );
  }

  test("the HD swap follows the last tap: the region under (lastTapX, lastTapY) in the NEW scan is selected", function () {
    const quick = scanWith(20);
    const hd = scanWith(30); // the HD scan draws the wall boundary further right
    const tap = { x: 0.6, y: 0.5 }; // x=24: wall B in the quick scan, wall A in the HD scan
    const selectedQuick = regions.regionAt(quick, tap.x, tap.y);
    assert.equal(selectedQuick.label, "Wall B");
    const ids = swapModule.remapSelection(quick, [selectedQuick.id], hd, tap);
    assert.equal(ids.length, 1);
    assert.equal(hd.regions.find((r) => r.id === ids[0]).label, "Wall A", "re-read through regionAt on the new scan");
  });

  test("without a tap (selection made from the list) the swap matches by overlap; a vanished surface is dropped", function () {
    const quick = scanWith(20);
    const hd = scanWith(22);
    const a = quick.regions.find((r) => r.label === "Wall A");
    const ids = swapModule.remapSelection(quick, [a.id], hd, null);
    assert.equal(hd.regions.find((r) => r.id === ids[0]).label, "Wall A");
    assert.deepEqual(swapModule.remapSelection(quick, [], hd, null), []);
    assert.deepEqual(swapModule.remapSelection(quick, ["no-such-region"], hd, null), []);
  });

  test("auto-apply only while swapping costs nothing: nothing edited, no finish, no products, select tool", function () {
    const calm = { itemId: null, tool: "select", render: null, pick: { status: "idle" }, products: {} };
    assert.equal(swapModule.canAutoApply(calm, 0), true);
    assert.equal(swapModule.canAutoApply(calm, 2), false, "edits in the undo history");
    assert.equal(swapModule.canAutoApply(Object.assign({}, calm, { itemId: "oak" }), 0), false, "a finish is chosen");
    assert.equal(swapModule.canAutoApply(Object.assign({}, calm, { products: { p1: {} } }), 0), false);
    assert.equal(swapModule.canAutoApply(Object.assign({}, calm, { tool: "brush" }), 0), false);
  });

  // run
  for (const entry of pending) {
    try {
      await entry.fn();
      passed += 1;
      console.log("PASS " + entry.name);
    } catch (error) {
      console.error("FAIL " + entry.name);
      console.error(error);
      process.exitCode = 1;
    }
  }
  console.log("\n" + passed + "/" + pending.length + " test case(s) passed");
})();
