// Unit tests for the words and the colour of the owner's dot (public/js/lib/ownerSummary.js): which
// state wins when services disagree, how a cold start is worded next to processing time, and that a
// recent cold start stays visible after warm calls follow it. Run with:
//   node tests/owner.test.js
const assert = require("node:assert/strict");

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push({ name: name, fn: fn });
}

function model(key, label, state, extra) {
  return Object.assign({ key: key, label: label, configured: true, state: state, inflight: [], last: null, lastCold: null }, extra || {});
}
function call(extra) {
  return Object.assign(
    { kind: "analyze", status: "ok", error: "", agoMs: 4000, wallMs: 3000, processMs: 900, overheadMs: 2100, cold: false, coldMs: 0, loadMs: 0, gpu: "", gpuRank: null, device: "" },
    extra || {},
  );
}

(async function () {
  const s = await import("../public/js/lib/ownerSummary.js");

  test("seconds / ago / shortGpu", function () {
    assert.equal(s.seconds(420), "420 ms");
    assert.equal(s.seconds(1234), "1.2 s");
    assert.equal(s.seconds(12400), "12 s");
    assert.equal(s.ago(12000), "12 s ago");
    assert.equal(s.ago(3 * 60 * 1000), "3 min ago");
    assert.equal(s.shortGpu("NVIDIA A100-SXM4-40GB"), "A100");
    assert.equal(s.shortGpu("NVIDIA L4"), "L4");
  });

  test("overallState: the worst state wins, unconfigured services are ignored", function () {
    const snapshot = {
      models: [
        model("scene", "Scene model", "warm"),
        model("sam3", "SAM 3", "cold-now"),
        model("moge2", "MoGe-2", "error"),
        model("marigold", "Marigold-IID", "unknown", { configured: false }),
      ],
    };
    assert.equal(s.overallState(snapshot), "cold-now");
    snapshot.models[1].state = "warm";
    assert.equal(s.overallState(snapshot), "error");
    snapshot.models[2].state = "warm";
    assert.equal(s.overallState(snapshot), "warm");
  });

  test("overallState: idle next to warm is warm, idle alone is idle, nothing seen is unknown", function () {
    assert.equal(s.overallState({ models: [model("a", "A", "idle"), model("b", "B", "warm")] }), "warm");
    assert.equal(s.overallState({ models: [model("a", "A", "idle"), model("b", "B", "idle")] }), "idle");
    assert.equal(s.overallState({ models: [model("a", "A", "unknown")] }), "unknown");
    assert.equal(s.overallState(null), "unknown");
  });

  test("a cold start in the last two minutes keeps the dot amber after warm calls, then lets go", function () {
    const warm = call({ cold: false });
    const young = model("moge2", "MoGe-2", "warm", { last: warm, lastCold: call({ cold: true, coldMs: 6900, agoMs: 40000 }) });
    assert.equal(s.overallState({ models: [young] }), "cold");
    const old = model("moge2", "MoGe-2", "warm", { last: warm, lastCold: call({ cold: true, coldMs: 6900, agoMs: 3 * 60 * 1000 }) });
    assert.equal(s.overallState({ models: [old] }), "warm");
  });

  test("describeModel: a waking container is described as waiting, not processing", function () {
    const line = s.describeModel(model("sam3", "SAM 3", "cold-now", { inflight: [{ kind: "warmup", elapsedMs: 4200 }] }));
    assert.equal(line.state, "cold-now");
    assert.match(line.text, /waking up, 4\.2 s so far/);
  });

  test("describeModel: cold start and processing are separate numbers, a fallback GPU is flagged", function () {
    const line = s.describeModel(
      model("moge2", "MoGe-2", "cold", {
        last: call({ cold: true, coldMs: 13000, processMs: 1200, gpu: "NVIDIA A10G", gpuRank: 1, agoMs: 8000 }),
      }),
    );
    assert.equal(line.fallback, true);
    assert.match(line.text, /cold start 13 s/);
    assert.match(line.text, /processing 1\.2 s/);
    assert.match(line.text, /A10G \(fallback\)/);
    assert.match(line.text, /8 s ago/);
  });

  test("describeModel: first-choice GPU is not called a fallback; a warm-up has no processing time", function () {
    const line = s.describeModel(
      model("sam3", "SAM 3", "warm", { last: call({ kind: "warmup", processMs: null, gpu: "NVIDIA L40S", gpuRank: 0 }) }),
    );
    assert.equal(line.fallback, false);
    assert.doesNotMatch(line.text, /processing/);
    assert.match(line.text, /warm-up/);
    assert.match(line.text, /L40S/);
    assert.doesNotMatch(line.text, /fallback/);
  });

  test("describeModel: the scene service's cold start is a model load; failures say why", function () {
    const scene = s.describeModel(model("scene", "Scene model", "cold", { last: call({ kind: "segment", cold: true, coldMs: 3800, processMs: 4400, device: "cpu" }) }));
    assert.match(scene.text, /model load 3\.8 s/);
    assert.match(scene.text, /cpu/);
    const failed = s.describeModel(model("sam3", "SAM 3", "error", { last: call({ status: "error", error: "rejected the API key (401)" }) }));
    assert.match(failed.text, /failed: rejected the API key/);
  });

  test("describeModel: after warm calls, the latest cold start is still listed", function () {
    const line = s.describeModel(
      model("marigold", "Marigold-IID", "warm", {
        last: call({ cold: false, processMs: 1700 }),
        lastCold: call({ cold: true, coldMs: 9400, agoMs: 50000 }),
      }),
    );
    assert.equal(line.state, "cold");
    assert.match(line.text, /warm/);
    assert.match(line.text, /cold start 9\.4 s 50 s ago/);
  });

  test("headline says it is waiting, not processing", function () {
    const waking = { models: [model("sam3", "SAM 3", "cold-now"), model("moge2", "MoGe-2", "cold-now")] };
    assert.match(s.headline(waking), /Cold start under way: SAM 3, MoGe-2.*waiting, not processing/);
    const recent = {
      models: [
        model("moge2", "MoGe-2", "warm", { last: call({}), lastCold: call({ cold: true, coldMs: 6900, agoMs: 30000 }) }),
        model("sam3", "SAM 3", "warm", { last: call({}), lastCold: call({ cold: true, coldMs: 3100, agoMs: 30000 }) }),
      ],
    };
    const text = s.headline(recent);
    assert.match(text, /Cold start of 6\.9 s \(MoGe-2, 30 s ago\)/);
    assert.match(text, /not processing time; the containers are warm now/);
    assert.match(s.headline({ models: [model("a", "A", "warm")] }), /^Warm:/);
    assert.match(s.headline({ models: [model("a", "A", "idle")] }), /next call may have to cold-start/);
    assert.match(s.headline({ models: [model("a", "A", "error")] }), /A failed on its last call/);
    assert.match(s.headline(null), /No calls seen yet/);
  });

  test("describeScan splits the time and notes the model and the AI run together", function () {
    const text = s.describeScan({ totalMs: 18400, prepMs: 300, segmentMs: 5600, segmentLoadMs: 3800, outlinesMs: 12100, buildMs: 400 });
    assert.match(text, /^Last scan 18 s: /);
    assert.match(text, /photo 300 ms/);
    assert.match(text, /scene model 5\.6 s \(3\.8 s of it loading the model\)/);
    assert.match(text, /AI outlines 12 s/);
    assert.match(text, /model and AI run together/);
    assert.equal(s.describeScan(null), "");
  });

  test("describeScan names the model that actually answered, and a B5 that fell back to B4", function () {
    const base = { totalMs: 9000, segmentMs: 3000 };
    assert.match(
      s.describeScan(Object.assign({}, base, { segmentModel: "nvidia/segformer-b5-finetuned-ade-640-640", segmentEngine: "local", segmentPrecision: "fp32", segmentDevice: "mps" })),
      /scene model SegFormer-B5 \(fp32, mps\) 3\.0 s/,
    );
    assert.match(
      s.describeScan(Object.assign({}, base, { segmentModel: "nvidia/segformer-b4-finetuned-ade-512-512", segmentEngine: "local", segmentPrecision: "fp32", segmentDevice: "cpu", segmentFellBackFrom: "nvidia/segformer-b5-finetuned-ade-640-640" })),
      /SegFormer-B4 \(fp32, cpu, B5 could not load\)/,
    );
    assert.match(
      s.describeScan(Object.assign({}, base, { segmentModel: "oneformer_ade20k_swin_large", segmentEngine: "remote" })),
      /scene model OneFormer \(Modal\) 3\.0 s/,
    );
  });

  test("a service that is not set up is described, with the .env name to set", function () {
    const off = { key: "oneformer", label: "OneFormer", configured: false, state: "unknown", inflight: [], last: null, lastCold: null };
    const line = s.describeModel(off);
    assert.match(line.text, /not set up: add ONEFORMER_URL to \.env/);
    assert.equal(line.state, "unknown");
    assert.ok(s.SHOWN_WHEN_OFF.oneformer && s.SHOWN_WHEN_OFF.analyze);
    // it must not colour the dot
    assert.equal(s.overallState({ models: [off, model("scene", "Scene model", "warm")] }), "warm");
  });

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
