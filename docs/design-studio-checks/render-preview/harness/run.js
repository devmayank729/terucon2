// The page of the render-preview check (docs/design-studio-checks/render-preview/README.md): the studio's fastrender modules, fed a real photo,
// hand-drawn masks and a chosen geometry, drawn by the real WebGL2 or WebGPU backend, then read back as PNG.
//   root=real      the studio's own modules (swatchroom/public/js/lib/fastrender/), served by the check's own server
//   root=overlay   the improved ones (site/overlays/studio/), the unchanged files taken from the studio, as the website serves them
//   modules=/js/lib/fastrender/   load the modules from this address instead (the check against a running website: site-check.mjs)
const q = new URLSearchParams(location.search);
const root = q.get("root") || "real";
const modulesBase = q.get("modules") || `/${root}/`;
const sceneName = q.get("scene") || "lobby";
const surface = q.get("surface") || "floor";
const geom = q.get("geom") || "estimate";          // estimate (the real provisional.js) | plane (hand-built level-camera planes)
const backendName = q.get("backend") || "webgl2";  // webgl2 | webgpu
const tex = q.get("tex") || "oak-planks";
const dpr = Number(q.get("dpr") || 1);
const frameW = Number(q.get("fw") || 1536);
const camH = q.get("camh") ? Number(q.get("camh")) : null;
const pitchDeg = Number(q.get("pitch") || 0);       // camera pitched down (+) by this many degrees, plane geometry only
const noPhoto = q.get("nophoto") === "1";
const SIZES = { "oak-planks": [1.79, 1.25], herringbone: [1.35, 0.945], terrazzo: [1.4, 1.0], statuario: [1.6, 1.12], kota: [1.8, 1.26], slate: [1.8, 1.2], brick: [1.31, 0.84], limewash: [1.4, 1.0], porcelain: [2.4, 1.68], teak: [1.47, 1.03], "black-oak": [1.47, 1.03], "walnut-slats": [1.2, 0.85], "paint-chalk": [0.5, 0.35], "microcement-floor": [1.4, 1.0], checker: [1.6, 1.12], "stacked-stone": [1.6, 1.12] };
const NAMES = { "oak-planks": "Light oak planks", porcelain: "Large-format porcelain tile", terrazzo: "Terrazzo", teak: "Teak planks" };
const R = (f) => import(`${modulesBase}${f}`);
const log = (m) => { document.getElementById("log").textContent += m + "\n"; };

async function main() {
  const defs = await (await fetch("/h/" + (q.get("scenes") || "scenes.json"))).json();
  const def = defs[sceneName];
  const { createFastRenderer } = await R("renderer.js");
  const { createWebGL2Backend } = await R("webgl2.js");
  const { createWebGPUBackend } = await R("webgpu.js");
  const geo = await R("geometry.js");
  const prov = await R("provisional.js");
  const { previewCanvasSize } = await R("sizing.js");

  let img = new Image(); img.src = def.photo; await img.decode();
  let photoSrc = def.photo;
  if (q.get("oldpattern") === "checker") { // stress test: the OLD floor carries a strong black/white checker (drawn into the photo before the light is estimated)
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const fl = def.regions.find((r) => r.kind === "floor"); g.save(); g.beginPath(); fl.polys[0].forEach((pt, i) => (i ? g.lineTo(pt[0], pt[1]) : g.moveTo(pt[0], pt[1]))); g.closePath(); g.clip();
    for (let y = 700; y < 1024; y += 56) for (let x = 0; x < 1536; x += 112) { g.fillStyle = "rgba(10,10,10,0.75)"; g.fillRect(x + ((y / 56) % 2 ? 56 : 0), y, 56, 56); }
    g.restore(); photoSrc = c.toDataURL("image/png"); img = new Image(); img.src = photoSrc; await img.decode();
  }
  const frameH = Math.round(frameW * def.h / def.w);
  const frame = document.getElementById("frame");
  frame.style.width = frameW + "px"; frame.style.height = frameH + "px";
  const photoEl = document.getElementById("photo"); photoEl.src = photoSrc; photoEl.style.width = "100%"; photoEl.style.height = "100%";
  if (noPhoto) photoEl.style.visibility = "hidden";

  // ---- the scan (what the studio's scan gives): label map + regions with mask/bbox/kind/id, at <=1024 px
  const SW = 1024, SH = Math.round(1024 * def.h / def.w), k = SW / def.w;
  const polyPath = (ctx, pts) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0] * k, p[1] * k) : ctx.moveTo(p[0] * k, p[1] * k))); ctx.closePath(); };
  const ellipse = (s) => { const [cx, cy, rx, ry] = s.split(":")[1].split(",").map(Number); const pts = []; for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); } return pts; };
  const labelMap = new Uint16Array(SW * SH);
  const regions = def.regions.map((r, i) => {
    const c = new OffscreenCanvas(SW, SH), ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff"; r.polys.forEach((p) => { polyPath(ctx, p); ctx.fill(); });
    ctx.globalCompositeOperation = "destination-out";
    (r.holes || []).forEach((h) => { polyPath(ctx, typeof h === "string" ? ellipse(h) : h); ctx.fill(); });
    const d = ctx.getImageData(0, 0, SW, SH).data;
    const mask = new Uint8Array(SW * SH); let count = 0, x0 = SW, y0 = SH, x1 = 0, y1 = 0;
    for (let p = 0; p < mask.length; p++) if (d[p * 4 + 3] > 127) { mask[p] = 1; count++; const x = p % SW, y = (p / SW) | 0; if (x < x0) x0 = x; if (x >= x1) x1 = x + 1; if (y < y0) y0 = y; if (y >= y1) y1 = y + 1; labelMap[p] = i + 1; }
    return { id: r.id, index: i + 1, kind: r.kind, mask, count, areaShare: count / (SW * SH), bbox: { x0, y0, x1, y1 } };
  });
  const scan = { width: SW, height: SH, labelMap, regions };

  // ---- the photo's own light, at scan size (exactly what studio.js photoLightFor does)
  const pc = new OffscreenCanvas(SW, SH), pctx = pc.getContext("2d", { willReadFrequently: true });
  pctx.drawImage(img, 0, 0, SW, SH);
  const light = geo.lumaFromRgba(pctx.getImageData(0, 0, SW, SH).data, SW, SH);

  // ---- the scene
  const tb0 = performance.now(); let scene = prov.buildProvisionalScene(scan, light); const buildMs = performance.now() - tb0;       // estimate = the real function, nothing hand-written
  const info = { root, modulesBase, geom, estimate: {}, buildProvisionalSceneMs: +buildMs.toFixed(1), regionsInScan: regions.length };
  regions.forEach((r) => { const f = scene.fusionRegions[r.id]; if (f) info.estimate[r.id] = { sizeM: f.sizeM, h6: f.homography[6], h7: f.homography[7] }; });
  if (geom === "mock") {
    // What a deploy with NO Modal URLs gets (PIPELINE_MOCK=auto, swatchroom/server/lib/remoteModels/moge2.js castBoxRoom + marigold.js syntheticShading):
    // planes of a synthetic 4 m x 5 m box room seen by a 60-degree camera 1.5 m above the floor, and a left-to-right gradient as "the room's light".
    const f = SW / (2 * Math.tan((60 * Math.PI) / 360));
    const intr = { fx: f, fy: f, cx: SW / 2, cy: SH / 2 };
    const fusionRegions = {};
    regions.forEach((r) => {
      if (r.kind === "floor") fusionRegions[r.id] = { confidence: 0.9, tier: "fast", plane: { origin: [0, 1.5, 0], normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] } };
      else if (r.kind === "wall") fusionRegions[r.id] = { confidence: 0.9, tier: "fast", plane: { origin: [0, 0, 5], normal: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] } };
    });
    const shading = new Float32Array(SW * SH);
    for (let py = 0; py < SH; py++) { const vert = 1 - 0.15 * Math.abs(py / SH - 0.5) * 2; for (let px = 0; px < SW; px++) shading[py * SW + px] = (0.75 + 0.5 * (1 - px / SW)) * vert; }
    scene = { kind: "fused", scan, fusionRegions, depth: null, shading, residual: null, luma: light.luma, photoLinear: light.linear, tint: light.tint, intrinsics: intr, geometryKey: "harness-mock" };
  }
  if (geom === "plane") {
    const intr = prov.assumedIntrinsics(SW, SH);
    const h = camH ?? def.cameraHeightM, p = (pitchDeg * Math.PI) / 180;
    const cp = Math.cos(p), sp = Math.sin(p);
    const fusionRegions = {};
    regions.forEach((r) => {
      const d = def.regions[r.index - 1];
      if (r.kind === "floor") {
        // camera at height h above the floor, pitched DOWN by p; camera axes in world coords: x=(1,0,0) y(down)=(0,-cp,-sp) z(fwd)=(0,-sp,cp)
        fusionRegions[r.id] = { confidence: 0.9, tier: "fast", plane: { origin: [0, h * cp, h * sp], normal: [0, -cp, -sp], u: [1, 0, 0], v: [0, -sp, cp] } };
      } else if (r.kind === "wall") {
        const yb = (d.frontalFromFloorY || 752) * k;                       // wall base row in scan px
        const ry = (yb - intr.cy) / intr.fy;
        const t = h / (cp * ry + sp);                                      // ray scale to the floor
        const D = t * (cp - sp * ry);                                      // horizontal distance of that floor point = the wall's distance
        fusionRegions[r.id] = { confidence: 0.9, tier: "fast", plane: { origin: [0, -D * sp, D * cp], normal: [0, sp, -cp], u: [1, 0, 0], v: [0, cp, sp] } };
        info.wallDistanceM = D;
      }
    });
    scene = { kind: "fused", scan, fusionRegions, depth: null, shading: scene.shading, residual: null, luma: light.luma, photoLinear: light.linear, tint: light.tint, intrinsics: intr, geometryKey: "harness" };
  }

  if (q.get("tint") === "0") scene.tint = null;
  info.tint = light.tint ? light.tint.map((v) => +v.toFixed(3)) : null;
  // ---- renderer (forced backend), canvas sized like the studio does
  const canvas = document.getElementById("ov");
  const size = previewCanvasSize(frameW, frameH, dpr);
  canvas.width = size.width; canvas.height = size.height;
  let backend;
  if (backendName === "webgpu") {
    const { createRenderDevice } = await R("device.js");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "premultiplied" });
    backend = createWebGPUBackend(device, context, format);
  } else {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    backend = createWebGL2Backend(gl);
  }
  const renderer = await createFastRenderer(canvas, { backend });
  renderer.uploadScene(scene);
  const region = regions.find((r) => r.id === surface);
  renderer.setAlphaFromMask(region.mask);
  const size2 = SIZES[tex] || [1.4, 1.0];
  // texurl=<address>: a catalogue design's photograph, stated the way the website states it (previewTileWidthM / previewTileHeightM and sheen,
  // NOT tileWidthM / tileHeightM: see design-check.mjs); without it the studio's own texture <tex> with its own tile size
  const item = q.get("texurl")
    ? { id: tex, name: tex, texture: { url: q.get("texurl"), previewTileWidthM: Number(q.get("tilew") || 1.22), previewTileHeightM: Number(q.get("tileh") || 0.854), ...(q.get("sheen") ? { sheen: q.get("sheen") } : {}) } }
    : { id: tex, name: NAMES[tex] || tex, texture: { url: "/textures/" + tex + ".png", tileWidthM: size2[0], tileHeightM: size2[1] } };
  const ok = await renderer.setMaterial(region.id, item, Number(q.get("rot") || 0));
  const t0 = performance.now();
  renderer.render();
  info.ok = ok; info.backend = renderer.kind; info.canvas = size; info.hasRegion = renderer.hasRegion(region.id);
  const blob = await renderer.readPixelsAsBlob("image/png");
  const fr = new FileReader(); const dataUrl = await new Promise((res) => { fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  window.__prov = prov; window.__scanObj = scan; window.__intr = prov.assumedIntrinsics(SW, SH);
  window.__overlayPng = dataUrl; window.__info = info; window.__scan = { SW, SH };
  log(JSON.stringify(info));
  document.title = "done";
}
main().catch((e) => { document.getElementById("log").textContent += "ERROR " + e.stack; document.title = "error"; console.error(e); });
