// Tests for what reaches the AI render: the measured 3D facts about a surface and how they are worded in the brief, the mobile
// canvas limits, and the rule that choosing a finish never starts an AI render. Run with:  node tests/render_bridge.test.js
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push({ name: name, fn: fn });
}

(async function () {
  const facts = await import("../public/js/lib/geometryFacts.js");
  const prompts = await import("../public/js/lib/prompts.js");
  const platform = await import("../public/js/lib/platform.js");
  const settings = await import("../public/js/lib/settings.js");
  const fusion = require("../server/lib/fusion.js");
  const moge2 = require("../server/lib/remoteModels/moge2.js");

  // a synthetic room with exact geometry: back wall 4.0 m wide and 2.6 m tall (eye 1.5 m above the floor, 1.1 m below the ceiling)
  const W = 320;
  const H = 200;
  const room = moge2.castBoxRoom(W, H, { roomWidth: 4, roomDepth: 5, fovDeg: 70, eyeHeight: 1.5, ceilingHeight: 1.1 });
  function regionOf(surfaceId, kind) {
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < mask.length; i += 1) {
      mask[i] = room.surface[i] === surfaceId ? 1 : 0;
    }
    return { id: "r" + surfaceId, kind: kind, mask: mask };
  }
  const fitted = fusion.fitRegions({
    width: W,
    height: H,
    depth: room.depth,
    intrinsics: room.intrinsics,
    up: null,
    regions: [
      Object.assign(regionOf(5, "wall"), { score: 0.9 }),
      Object.assign(regionOf(1, "floor"), { score: 0.9 }),
    ],
  });

  test("surfaceGeometry(): a wall's size in METRES comes out right (4.0 m x 2.6 m)", function () {
    const g = facts.surfaceGeometry(regionOf(5, "wall"), fitted.byId.r5, room.intrinsics, { width: W, height: H });
    assert.ok(g, "geometry found");
    assert.ok(Math.abs(g.widthM - 4.0) < 0.25, "width " + g.widthM);
    assert.ok(Math.abs(g.heightM - 2.6) < 0.2, "height " + g.heightM);
    assert.equal(g.orientation, "tall");
    assert.ok(Math.abs(g.normal[2] + 1) < 0.05, "faces the camera: " + g.normal);
    assert.ok(Math.abs(g.distanceM - 5) < 0.3, "5 m away: " + g.distanceM);
    assert.ok(Math.abs(g.fovDeg - 70) < 2, "field of view " + g.fovDeg);
  });

  test("surfaceGeometry(): a floor is wide x deep, and its normal points up (-y in the camera's y-down frame)", function () {
    const g = facts.surfaceGeometry(regionOf(1, "floor"), fitted.byId.r1, room.intrinsics, { width: W, height: H });
    assert.equal(g.orientation, "deep");
    assert.ok(g.normal[1] < -0.9, "up: " + g.normal);
    // the visible band of floor: the full 4 m across (2nd-98th percentile), and the stretch between the lowest visible floor and the back wall
    assert.ok(Math.abs(g.widthM - 4) < 0.4 && g.heightM > 1.2 && g.heightM < 2.5, g.widthM + " x " + g.heightM);
  });

  test("surfaceGeometry(): an estimate is not a measurement - provisional, unfitted and tiny regions give null", function () {
    const region = regionOf(5, "wall");
    assert.equal(facts.surfaceGeometry(region, { provisional: true, homography: [] }, room.intrinsics, { width: W, height: H }), null);
    assert.equal(facts.surfaceGeometry(region, undefined, room.intrinsics, { width: W, height: H }), null);
    assert.equal(facts.surfaceGeometry(region, fitted.byId.r5, null, { width: W, height: H }), null);
    const tiny = { id: "t", kind: "wall", mask: new Uint8Array(W * H) };
    tiny.mask[5] = 1;
    assert.equal(facts.surfaceGeometry(tiny, fitted.byId.r5, room.intrinsics, { width: W, height: H }), null);
  });

  test("geometryForImage(): the focal length is restated in the pixels of the image the model sees", function () {
    const g = facts.surfaceGeometry(regionOf(5, "wall"), fitted.byId.r5, room.intrinsics, { width: W, height: H });
    const forImage = facts.geometryForImage(g, 4, { previewShown: true });
    assert.equal(forImage.focalPxImage, Math.round(room.intrinsics.fx * 4));
    assert.equal(forImage.previewShown, true);
    assert.equal(facts.geometryForImage(null, 4), null);
  });

  const BASE = {
    width: 2048,
    height: 1365,
    crop: false,
    guide: true,
    label: "Back wall",
    kind: "wall",
    partCount: 1,
    box: { ymin: 100, xmin: 100, ymax: 900, xmax: 900 },
    areaShare: 0.4,
    centerX: 500,
    centerY: 500,
    item: null,
    style: "",
    notes: "",
  };
  const TILE = { id: "tile", name: "White tile", mode: "surface", prompt: "Tile it.", texture: { tileWidthM: 0.6, tileHeightM: 0.3 } };

  test("the brief states the measured geometry as a constraint: size, normal, tile repeat and focal length", function () {
    const g = facts.geometryForImage(facts.surfaceGeometry(regionOf(5, "wall"), fitted.byId.r5, room.intrinsics, { width: W, height: H }), 4, { previewShown: false });
    const brief = prompts.renderBrief(Object.assign({}, BASE, { item: TILE, geometry: g }));
    assert.match(brief, /Measured 3D Surface Geometry/);
    assert.match(brief, new RegExp(g.widthM + " m wide by " + g.heightM + " m tall"));
    assert.match(brief, /surface normal is \(-?\d+(\.\d+)?, -?\d+(\.\d+)?, -?\d+(\.\d+)?\) in camera space/);
    assert.match(brief, /Tile repeat scale must match 0\.6 m x 0\.3 m, with perspective foreshortening matching camera focal length \d+ px/);
    assert.match(brief, new RegExp("focal length " + g.focalPxImage + " px"));
    assert.ok(brief.indexOf("Image 3 carries a perspective-correct preview") === -1, "no preview claim when none was blended");
  });

  test("a floor is described as wide x deep; an untextured finish is sized from the real dimensions; the preview line only appears when it was blended", function () {
    const g = facts.geometryForImage(facts.surfaceGeometry(regionOf(1, "floor"), fitted.byId.r1, room.intrinsics, { width: W, height: H }), 2, { previewShown: true });
    const paint = { id: "paint", name: "Paint", mode: "surface", prompt: "Paint it." };
    const brief = prompts.renderBrief(Object.assign({}, BASE, { kind: "floor", item: paint, geometry: g }));
    assert.match(brief, /m deep;/);
    assert.match(brief, /Size the pattern, joints and details from these real dimensions/);
    assert.match(brief, /Image 3 carries a perspective-correct preview of this finish at 35% opacity/);
    assert.match(brief, /do not copy its colours or its edges/);
  });

  test("with no measurement the brief is exactly what it always was (no geometry paragraph)", function () {
    const plain = prompts.renderBrief(Object.assign({}, BASE, { item: TILE }));
    const withNull = prompts.renderBrief(Object.assign({}, BASE, { item: TILE, geometry: null }));
    assert.equal(plain, withNull);
    assert.ok(plain.indexOf("Measured 3D") === -1);
    assert.deepEqual(prompts.geometryLines({}), []);
  });

  test("the system prompt tells the model what Image 3 may carry", function () {
    assert.match(prompts.RENDER_SYSTEM_PROMPT, /perspective preview of the requested finish at partial opacity/);
  });

  // ---------------------------------------------------------------- mobile memory
  test("working canvases: iOS Safari is capped at 2560 px, other phones at 3072, desktops are not capped", function () {
    assert.equal(platform.workingCanvasSide(4096, { ios: true, mobile: true }), 2560);
    assert.equal(platform.workingCanvasSide(2048, { ios: true, mobile: true }), 2048, "a smaller request is kept");
    assert.equal(platform.workingCanvasSide(4096, { ios: false, mobile: true }), 3072);
    assert.equal(platform.workingCanvasSide(4096, { ios: false, mobile: false }), 4096);
    assert.equal(platform.IOS_CANVAS_SIDE, 2560);
  });

  test("releaseCanvas() frees a canvas's pixels and is safe on anything else", function () {
    const canvas = { width: 2560, height: 1920 };
    platform.releaseCanvas(canvas);
    assert.deepEqual([canvas.width, canvas.height], [0, 0]);
    assert.doesNotThrow(() => {
      platform.releaseCanvas(null);
      platform.releaseCanvas(undefined);
      platform.releaseCanvas("nope");
      platform.releaseCanvas({});
    });
  });

  test("device detection reads the user agent and touch points (no browser here: both are false)", function () {
    assert.equal(platform.isIosSafari(), false);
    assert.equal(platform.isMobile(), false);
  });

  // ---------------------------------------------------------------- choosing a finish never starts an AI render
  const sources = {};
  function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".js")) {
        sources[path.relative(path.join(__dirname, "../public/js"), full)] = fs.readFileSync(full, "utf8");
      }
    });
  }
  walk(path.join(__dirname, "../public/js"));
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("startRender() is called from exactly two places: the Render button and Ctrl/Cmd+Enter", function () {
    const calls = [];
    Object.keys(sources).forEach(function (file) {
      code(sources[file]).split("\n").forEach(function (line, index) {
        if (/\.startRender\(/.test(line)) {
          calls.push(file + ":" + (index + 1) + " " + line.trim());
        }
      });
    });
    assert.equal(calls.length, 2, calls.join("\n"));
    assert.ok(calls.every((c) => c.startsWith("views/studio.js")));
    const studio = code(sources["views/studio.js"]);
    assert.match(studio, /onRender: function \(\) \{\s*studio\.startRender\(\);/, "the Render button");
    assert.match(studio, /ctrlKey \|\| event\.metaKey\)[\s\S]{0,120}this\.startRender\(\)/, "Ctrl/Cmd+Enter");
  });

  test("the AI image call (generate with task 'image') exists only inside render.js, which only startRender() uses", function () {
    const users = Object.keys(sources).filter((file) => /task:\s*"image"/.test(code(sources[file])));
    assert.deepEqual(users, ["lib/render.js"]);
    const importers = Object.keys(sources).filter((file) => /from "\.\.?\/(lib\/)?render\.js"/.test(sources[file]));
    assert.deepEqual(importers, ["views/studio.js"]);
    const studio = code(sources["views/studio.js"]);
    const uses = studio.split("\n").filter((line) => /\b(prepareRender|renderOption)\(/.test(line));
    assert.equal(uses.length, 2, "prepareRender and renderOption are each called once, both inside startRender");
    const inStartRender = studio.slice(studio.indexOf("async startRender()"), studio.indexOf("cancelRender()"));
    assert.ok(/prepareRender\(input\)/.test(inStartRender) && /renderOption\(input, prepared\)/.test(inStartRender));
  });

  test("the instant preview path (stage.js, fastrender/) cannot reach the AI at all", function () {
    ["views/stage.js", "lib/previewScene.js", "lib/fastrender/renderer.js", "lib/fastrender/provisional.js"].forEach(function (file) {
      const text = code(sources[file]);
      assert.ok(!/startRender|prepareRender|renderOption|\/ai\/generate|lib\/ai\.js/.test(text), file + " must not touch the AI render");
    });
  });

  test("a sceneModel of 'b4' saved by an older version is migrated to the quantized B5; HD scan and SAM calibration default on", function () {
    const defaults = settings.defaultSettings();
    assert.equal(defaults.sceneModel, "b5-quant");
    assert.equal(defaults.useHdScan, true);
    assert.equal(defaults.samCalibrate, true);
    assert.ok(settings.SCENE_MODELS.some((m) => m.id === "b5-quant"));
  });

  test("saved settings are really migrated: b4 -> b5-quant, and the old preview threshold 0.45 -> 0.3 (a chosen value stays)", function () {
    const load = (saved) => {
      global.window = { localStorage: { getItem: () => JSON.stringify(saved), setItem: () => {} } };
      try {
        return settings.loadSettings();
      } finally {
        delete global.window;
      }
    };
    const old = load({ version: 8, sceneModel: "b4", fusionLowThreshold: 0.45 });
    assert.equal(old.sceneModel, "b5-quant");
    assert.equal(old.fusionLowThreshold, 0.3);
    assert.equal(old.useHdScan, true);
    const v9 = load({ version: 9, sceneModel: "b5-quant", fusionLowThreshold: 0.45 });
    assert.equal(v9.fusionLowThreshold, 0.3, "settings saved by the previous release of this work are fixed too");
    assert.equal(load({ version: 9, sceneModel: "b2", fusionLowThreshold: 0.6 }).fusionLowThreshold, 0.6, "a value the designer chose is kept");
    assert.equal(load({ version: 9, sceneModel: "b2" }).sceneModel, "b2", "a deliberate B2 stays");
  });

  test("the Gemini brief reads the raw fit (never the composed scene) and only a plane above the low threshold", function () {
    const fs = require("fs");
    const source = fs.readFileSync(__dirname + "/../public/js/views/studio.js", "utf8");
    const at = source.indexOf("surfaceGeometry(current, fit,");
    assert.ok(at > 0, "startRender passes the raw fit to surfaceGeometry");
    const around = source.slice(at - 700, at + 200);
    assert.match(around, /this\.fastScenePayload/, "the raw fused payload");
    assert.match(around, /fit\.confidence >= settings\.fusionLowThreshold/, "gated on the designer's low threshold");
    assert.doesNotMatch(around, /sceneComposer/, "never the composed scene, whose weak surfaces carry outline estimates");
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
