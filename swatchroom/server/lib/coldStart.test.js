// Unit tests for coldStart.js: how a finished model call is split into cold start and processing,
// and what the owner-only snapshot reports. Run with:
//   node server/lib/coldStart.test.js
const assert = require("node:assert/strict");
const coldStart = require("./coldStart");

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push({ name: name, fn: fn });
}
async function runAll() {
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
}

// A registry on a clock the test moves by hand.
function fixture() {
  const time = { now: 1000000 };
  const registry = coldStart.createRegistry({
    now: function () {
      return time.now;
    },
  });
  return { time: time, registry: registry };
}

function response(headers) {
  return { headers: new Headers(headers) };
}

// A Modal-style response: Server-Timing from the container's stopwatch plus the telemetry headers.
function modalResponse(options) {
  return response({
    "server-timing": "decode;dur=40, queue;dur=0, gpu;dur=" + options.gpuMs + ", encode;dur=30, total;dur=" + options.totalMs,
    "x-gpu": options.gpu || "NVIDIA L4",
    "x-gpu-rank": String(options.rank === undefined ? 0 : options.rank),
    "x-container-requests": String(options.served),
    "x-container-age": String(options.age),
  });
}

test("parseServerTiming reads every metric and ignores junk", function () {
  const parsed = coldStart.parseServerTiming("decode;dur=12.5, queue;dur=0, gpu;dur=456.25, encode;dur=7, total;dur=480");
  assert.deepEqual(parsed, { decode: 12.5, queue: 0, gpu: 456.25, encode: 7, total: 480 });
  assert.deepEqual(coldStart.parseServerTiming(""), {});
  assert.deepEqual(coldStart.parseServerTiming(null), {});
  assert.deepEqual(coldStart.parseServerTiming("nonsense"), {});
});

test("classify: a warm container is never a cold start, however slow the model", function () {
  // 6.3 s of real diffusion work (Marigold's measured worst), container 10 minutes old, request 57
  const result = coldStart.classify({ wallMs: 7400, processMs: 6300, served: 57, ageS: 600 }, 600);
  assert.equal(result.cold, false);
  assert.equal(result.coldMs, 0);
  assert.equal(result.overheadMs, 1100);
});

test("classify: the first request on a container born for it is a cold start, minus the usual overhead", function () {
  // 14.8 s wall, 1.2 s of work, container is 14 s old when it answers -> it booted for this call
  const result = coldStart.classify({ wallMs: 14800, processMs: 1200, served: 1, ageS: 14 }, 600);
  assert.equal(result.cold, true);
  assert.equal(result.overheadMs, 13600);
  assert.equal(result.coldMs, 13000);
});

test("classify: the first request on a container that was already idle in the pool is NOT cold", function () {
  // min_containers keeps one running: its first request arrives when it is 40 minutes old
  const result = coldStart.classify({ wallMs: 3400, processMs: 900, served: 1, ageS: 2400 }, 600);
  assert.equal(result.cold, false);
});

test("classify: a snapshot restore (the fastest real one, 2.5 s) still counts", function () {
  const result = coldStart.classify({ wallMs: 3300, processMs: 500, served: 1, ageS: 3 }, 400);
  assert.equal(result.cold, true);
  assert.equal(result.coldMs, 2400);
});

test("classify: requests queued behind the same boot waited too", function () {
  const result = coldStart.classify({ wallMs: 12000, processMs: 800, served: 3, ageS: 11 }, 600);
  assert.equal(result.cold, true);
  assert.equal(result.coldMs, 10600);
});

test("classify: a first request with a small overhead is a network hop, not a boot", function () {
  const result = coldStart.classify({ wallMs: 1100, processMs: 400, served: 1, ageS: 1 }, 600);
  assert.equal(result.cold, false);
});

test("classify: without the blueprint's headers only a big gap counts", function () {
  assert.equal(coldStart.classify({ wallMs: 2500, processMs: 800, served: null, ageS: null }, 600).cold, false);
  const slow = coldStart.classify({ wallMs: 21000, processMs: 900, served: null, ageS: null }, 600);
  assert.equal(slow.cold, true);
  assert.equal(slow.coldMs, 19500);
});

test("classify: processing can never exceed the wall time", function () {
  const result = coldStart.classify({ wallMs: 1000, processMs: 5000, served: 9, ageS: 900 }, 600);
  assert.equal(result.overheadMs, 0);
  assert.equal(result.cold, false);
});

test("track: reads Server-Timing, the GPU and the container's telemetry off the response", async function () {
  const f = fixture();
  const value = await f.registry.track("moge2", "analyze", { roomId: "room-abc1" }, async function () {
    f.time.now += 14800;
    return { response: modalResponse({ totalMs: 1200, gpuMs: 1100, served: 1, age: 14, gpu: "NVIDIA A10G", rank: 1 }), value: "buffer" };
  });
  assert.equal(value, "buffer");
  const snapshot = f.registry.snapshot();
  const moge = snapshot.models.find(function (model) {
    return model.key === "moge2";
  });
  assert.equal(moge.last.cold, true);
  assert.equal(moge.last.coldMs, 13000);
  assert.equal(moge.last.processMs, 1200);
  assert.equal(moge.last.gpu, "NVIDIA A10G");
  assert.equal(moge.last.gpuRank, 1, "rank 1 = Modal fell back from the first-choice GPU");
  assert.equal(moge.last.roomId, "room-abc1");
  assert.equal(moge.state, "cold");
});

test("track: a failed call is recorded as an error and re-thrown", async function () {
  const f = fixture();
  await assert.rejects(
    f.registry.track("sam3", "analyze", null, async function () {
      f.time.now += 300;
      throw new Error("The SAM 3 server rejected the API key (401).");
    }),
    /rejected the API key/,
  );
  const sam = f.registry.snapshot().models.find(function (model) {
    return model.key === "sam3";
  });
  assert.equal(sam.state, "error");
  assert.match(sam.last.error, /API key/);
  assert.equal(sam.inflight.length, 0, "a failed call must not stay in flight");
});

test("the warm overhead baseline learns from warm calls, so coldMs is not inflated by a slow network", async function () {
  const f = fixture();
  async function call(wall, served, age) {
    return f.registry.track("marigold", "analyze", null, async function () {
      f.time.now += wall;
      return { response: modalResponse({ totalMs: 3000, gpuMs: 2800, served: served, age: age }), value: null };
    });
  }
  // five warm calls whose overhead (wall - 3000) is 2000 ms: a slow link and a big zip
  for (let i = 0; i < 5; i += 1) {
    await call(5000, 10 + i, 500 + i);
  }
  await call(25000, 1, 20); // then a boot: 22 s of overhead, 2 s of which is the usual download
  const marigold = f.registry.snapshot().models.find(function (model) {
    return model.key === "marigold";
  });
  assert.equal(marigold.last.cold, true);
  assert.equal(marigold.last.overheadMs, 22000);
  assert.equal(marigold.last.coldMs, 20000);
});

test("snapshot: a warm-up ping that has not answered after 2 s is a cold start in progress", function () {
  const f = fixture();
  const handle = f.registry.begin("sam3", "warmup");
  f.time.now += 1500;
  assert.equal(f.registry.snapshot().models[1].state, "unknown", "1.5 s is still a normal wait");
  f.time.now += 800;
  const snapshot = f.registry.snapshot();
  const sam = snapshot.models.find(function (model) {
    return model.key === "sam3";
  });
  assert.equal(sam.state, "cold-now");
  assert.equal(sam.inflight[0].kind, "warmup");
  assert.equal(sam.inflight[0].elapsedMs, 2300);
  handle.finish(modalResponse({ totalMs: 0, gpuMs: 0, served: 1, age: 2 }));
  const after = f.registry.snapshot().models.find(function (model) {
    return model.key === "sam3";
  });
  assert.equal(after.state, "cold", "answered after 2.3 s on a brand-new container");
  assert.equal(after.inflight.length, 0);
});

test("snapshot: a real analyse call is only 'cold now' after it has waited far longer than a warm one", function () {
  const f = fixture();
  f.registry.begin("moge2", "analyze");
  f.time.now += 9000;
  assert.notEqual(f.registry.snapshot().models.find((m) => m.key === "moge2").state, "cold-now");
  f.time.now += 4000;
  assert.equal(f.registry.snapshot().models.find((m) => m.key === "moge2").state, "cold-now");
});

test("snapshot: idle after five quiet minutes, warm right after a normal call", async function () {
  const f = fixture();
  await f.registry.track("moge2", "analyze", null, async function () {
    f.time.now += 1800;
    return { response: modalResponse({ totalMs: 900, gpuMs: 800, served: 12, age: 700 }), value: null };
  });
  const find = function () {
    return f.registry.snapshot().models.find((m) => m.key === "moge2");
  };
  assert.equal(find().state, "warm");
  f.time.now += 5 * 60 * 1000 + 1;
  assert.equal(find().state, "idle");
  assert.ok(find().last.agoMs > 5 * 60 * 1000);
});

test("noteScene: loading the model on first use is the scene service's cold start", function () {
  const f = fixture();
  const sample = f.registry.noteScene({ wallMs: 9200, processMs: 4100, loadMs: 3800, device: "cpu" });
  assert.equal(sample.cold, true);
  assert.equal(sample.coldMs, 3800);
  assert.equal(sample.overheadMs, 1300);
  const scene = f.registry.snapshot().models.find((m) => m.key === "scene");
  assert.equal(scene.state, "cold");
  assert.equal(scene.last.loadMs, 3800);
  assert.equal(scene.last.device, "cpu");
});

test("noteScene: a loaded model with ordinary latency is warm", function () {
  const f = fixture();
  const sample = f.registry.noteScene({ wallMs: 5200, processMs: 4400, loadMs: 0, device: "cpu" });
  assert.equal(sample.cold, false);
  assert.equal(sample.coldMs, 0);
});

test("noteScene: a service that was asleep (huge gap beyond its own work) is cold even with the model loaded", function () {
  const f = fixture();
  const sample = f.registry.noteScene({ wallMs: 41000, processMs: 4300, loadMs: 0, device: "cpu" });
  assert.equal(sample.cold, true);
  assert.equal(sample.coldMs, 36100);
});

test("snapshot: lists the newest calls first and caps the list", async function () {
  const f = fixture();
  for (let i = 0; i < 20; i += 1) {
    f.time.now += 10;
    f.registry.noteScene({ wallMs: 100 + i, processMs: 90, loadMs: 0, device: "cpu" });
  }
  const snapshot = f.registry.snapshot();
  assert.equal(snapshot.recent.length, 12);
  assert.equal(snapshot.recent[0].wallMs, 119);
  assert.equal(snapshot.recent[0].model, "scene");
});

runAll();
