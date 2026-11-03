// Verification for docs/DESIGN_STUDIO_ARCHITECTURE.md: the pure browser-side modules, loaded from the real files.
//   Run:  node docs/design-studio-checks/verify_preview.mjs
// previewScene.js and fastrender/tiers.js have no imports, so they can be loaded unchanged through a data: URL.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../swatchroom/public/js/lib") + "/";
async function load(file) {
  const source = fs.readFileSync(ROOT + file, "utf8");
  if (/^\s*import\s/m.test(source)) throw new Error(file + " has imports: cannot load it standalone");
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
}
const { createSceneComposer } = await load("previewScene.js");
const { regionTier, canUseFastRender, canFastRenderItem } = await load("fastrender/tiers.js");

const scan = {
  regions: [
    { id: "floor-1", kind: "floor", areaShare: 0.3 },
    { id: "wall-1", kind: "wall", areaShare: 0.2 },
    { id: "wall-2", kind: "wall", areaShare: 0.15 },
    { id: "sofa", kind: "furniture", areaShare: 0.1 },
  ],
};
const light = { luma: new Float32Array(4), linear: new Float32Array(4) };
const estimate = (s, l) => ({
  kind: "provisional",
  geometryKey: "provisional-key",
  scan: s,
  fusionRegions: { "floor-1": { confidence: 0.6, estimate: true }, "wall-1": { confidence: 0.6, estimate: true }, "wall-2": { confidence: 0.6, estimate: true } },
});
const composer = createSceneComposer(estimate);
const show = (label, scene) =>
  console.log(label.padEnd(66), scene ? "key=" + scene.geometryKey + " | regions=" + JSON.stringify(Object.fromEntries(Object.entries(scene.fusionRegions).map(([id, f]) => [id, f.estimate ? "ESTIMATE" : "fit " + f.confidence]))) : "null (nothing to draw)");

console.log("== previewScene.compose(scan, fused, photoLight, weakBelow)");
show("analysis not arrived (fused=null), photo light loaded", composer.compose(scan, null, light, 0.3));
show("analysis not arrived, photo light NOT loaded yet", createSceneComposer(estimate).compose(scan, null, null, 0.3));
const fusedGood = { kind: "fused", geometryKey: "fused:room:v0:1", fusionRegions: { "floor-1": { confidence: 0.9 }, "wall-1": { confidence: 0.8 }, "wall-2": { confidence: 0.75 } }, luma: null, photoLinear: null };
show("analysis arrived, every wall/floor fit trusted", composer.compose(scan, fusedGood, light, 0.3));
const fusedWeak = { ...fusedGood, fusionRegions: { ...fusedGood.fusionRegions, "wall-1": { confidence: 0.2 } } };
show("analysis arrived, wall-1 scored 0.2 (< 0.3)", composer.compose(scan, fusedWeak, light, 0.3));
const fusedMissing = { ...fusedGood, fusionRegions: { "floor-1": { confidence: 0.9 }, "wall-1": { confidence: 0.8 } } };
show("analysis arrived, wall-2 has no fit (split/outlined after the fit)", composer.compose(scan, fusedMissing, light, 0.3));
const f2 = { ...fusedGood, geometryKey: "fused:room:v0:2" };
show("regions-only refit finished -> payload reloaded (key counter 1 -> 2)", composer.compose(scan, f2, light, 0.3));

console.log("\n== tiers.regionTier / canUseFastRender (defaults 0.3 / 0.7)");
const settings = { fusionLowThreshold: 0.3, fusionHighThreshold: 0.7 };
[[0.9, "fast"], [0.6, "flagged"], [0.45, "flagged"], [0.29, "gemini-only"], [NaN, "gemini-only"], [undefined, "gemini-only"]].forEach(([c, want]) => {
  const got = regionTier(c, settings);
  console.log("confidence", String(c).padEnd(10), "->", got.padEnd(12), got === want ? "ok" : "MISMATCH (expected " + want + ")");
});
const textured = { texture: { url: "/t.jpg" } };
console.log("textured item, confidence 0.6 ->", canUseFastRender(true, 0.6, textured, settings));
console.log("motif/rug without texture, confidence 0.9 ->", canUseFastRender(true, 0.9, { texture: null }, settings), "(canFastRenderItem:", canFastRenderItem({ texture: null }) + ")");
console.log("furniture region: no fit -> confidence NaN ->", canUseFastRender(true, NaN, textured, settings));
