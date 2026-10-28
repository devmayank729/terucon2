// The shared facade studio.js/stage.js actually import - picks WebGPU or WebGL2 (device.js), and owns the translation from
// app data (the room's scan + fusion geometry + catalog items) into what either GPU backend needs (webgl2.js, webgpu.js
// share one interface; see each for the per-pixel algorithm in shaders/swap.wgsl.js / swap.glsl.js).
//
// Speeds, on purpose:
//   uploadScene()   expensive (new textures, a full label-map remap) - once per photo version, scan or geometry change
//   updateLabels()  cheap  - the scan's outlines changed (a refined edge, the HD scan) but the geometry did not
//   setAlphaFromMask()  cheap - which surface may be painted; before every render() of a changed selection
//   setMaterial()   cheap (rebind one texture-array layer + a few floats), and SYNCHRONOUS when the texture is already in
//                   memory (prefetch()), so picking a finish draws on the next frame with no network round trip
//
// A scene (what uploadScene takes) is { kind: "fused" | "provisional", scan, fusionRegions, depth, shading, residual, luma,
// photoLinear, intrinsics }:
//   fusionRegions[regionId]  { plane: {origin, normal, u, v} } from MoGe-2's fit, or { homography: [9] } estimated from the
//                            surface's outline (provisional.js); only regions present here ever get a GPU slot
//   depth / residual         optional (a provisional scene has neither)
//   shading                  linear light, Marigold's (relative) or the blurred photo's
//   luma                     the photo's brightness, to snap soft edges to real ones
//   photoLinear              the photo's linear luminance, for the exposure of each surface
import { createRenderDevice } from "./device.js";
import { createWebGL2Backend } from "./webgl2.js";
import { createWebGPUBackend } from "./webgpu.js";
import { createTextureStore } from "./textureStore.js";
import { exposureFor, maskedMedian, planeHomography, specularFor } from "./geometry.js";

// Every layer of the material texture array must share one size. Half the native 1280x896 textures
// scripts/build-textures.js writes (same 10:7 aspect, so UV = (U/tileWidthM, V/tileHeightM) samples them with no
// distortion) - plenty for a tiled, usually-partial-screen surface, at a sixth of the GPU memory.
const MATERIAL_TILE_WIDTH = 640;
const MATERIAL_TILE_HEIGHT = 448;
// decoded textures kept in memory (1.1 MB each): fewer on a phone
const TEXTURE_CACHE_DESKTOP = 48;
const TEXTURE_CACHE_PHONE = 24;

async function createBackend(canvas) {
  const device = await createRenderDevice(canvas);
  if (device.kind === "webgpu") {
    return createWebGPUBackend(device.device, device.context, device.format);
  }
  if (device.kind === "webgl2") {
    return createWebGL2Backend(device.context);
  }
  return null;
}

// Fetches, decodes and resizes a catalog item's texture to the shared material-array tile size.
async function loadMaterialBitmap(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Could not load the texture at " + url + " (" + response.status + ").");
  }
  const blob = await response.blob();
  const raw = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(MATERIAL_TILE_WIDTH, MATERIAL_TILE_HEIGHT);
  const context = canvas.getContext("2d");
  context.drawImage(raw, 0, 0, MATERIAL_TILE_WIDTH, MATERIAL_TILE_HEIGHT);
  raw.close();
  return createImageBitmap(canvas);
}

function phoneLike() {
  try {
    return (navigator.maxTouchPoints || 0) > 0 || window.innerWidth < 768;
  } catch (error) {
    return false;
  }
}

// options (for tests and unusual hosts): { backend, loadTexture, cacheSize }
// Resolves to null if this browser can run neither WebGPU nor WebGL2 - the caller's job is to fall back to the existing
// Gemini pipeline entirely when that happens (see tiers.js).
export async function createFastRenderer(canvas, options) {
  const opts = options || {};
  const backend = opts.backend || (await createBackend(canvas));
  if (!backend) {
    return null;
  }
  const store = createTextureStore(
    opts.loadTexture || loadMaterialBitmap,
    opts.cacheSize || (phoneLike() ? TEXTURE_CACHE_PHONE : TEXTURE_CACHE_DESKTOP),
  );

  // Per region id: its static facts (homography, the light's median, exposure) and, once assigned, the live finish
  // {item, rotation}. slotOf is the region's fixed index (0-based) into the backend's fixed-size region array and the
  // material texture array's layers - assigned once in uploadScene(), stable until the next one.
  let info = new Map();
  let slotOf = new Map();
  let assignments = new Map();
  let indexToRegionId = new Map();
  let scene = null;
  let sceneSize = 0; // scan.width * scan.height of the uploaded scene
  let sceneKind = "";

  function packRegionsForBackend() {
    const list = [];
    slotOf.forEach(function (slot, regionId) {
      const facts = info.get(regionId);
      const assignment = assignments.get(regionId);
      const rotation = assignment ? assignment.rotation || 0 : 0;
      list[slot] = {
        h: facts.homography,
        invTileWidthM: assignment ? 1 / assignment.item.texture.tileWidthM : 0,
        invTileHeightM: assignment ? 1 / assignment.item.texture.tileHeightM : 0,
        cosRot: Math.cos(rotation),
        sinRot: Math.sin(rotation),
        materialLayer: slot,
        active: !!assignment,
        medianShading: facts.medianShading,
        exposure: facts.exposure,
        specStrength: assignment ? specularFor(assignment.item) : 0,
      };
    });
    // Every slot 0..max must have an entry (a region can be mid-geometry-only, no finish chosen yet).
    for (let i = 0; i < list.length; i += 1) {
      if (!list[i]) {
        list[i] = {
          h: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          invTileWidthM: 0,
          invTileHeightM: 0,
          cosRot: 1,
          sinRot: 0,
          materialLayer: i,
          active: false,
          medianShading: 1,
          exposure: 1,
          specStrength: 0,
        };
      }
    }
    return list;
  }

  // The scan's label map with each wall / floor / ceiling region that has a slot renumbered to slot + 1 (0 = nothing to
  // paint there).
  function remapLabels(scan) {
    const remapped = new Uint16Array(scan.width * scan.height);
    const slotOfIndex = new Map();
    scan.regions.forEach(function (region) {
      if (slotOf.has(region.id)) {
        slotOfIndex.set(region.index, slotOf.get(region.id) + 1);
      }
    });
    for (let pixel = 0; pixel < scan.labelMap.length; pixel += 1) {
      const slot = slotOfIndex.get(scan.labelMap[pixel]);
      if (slot) {
        remapped[pixel] = slot;
      }
    }
    return remapped;
  }

  function uploadScene(next) {
    const scan = next.scan;
    info = new Map();
    slotOf = new Map();
    assignments = new Map();
    indexToRegionId = new Map();
    scene = next;
    sceneKind = next.kind || "fused";
    sceneSize = scan.width * scan.height;
    const total = sceneSize;

    const shading = next.shading || new Float32Array(total).fill(1);
    let nextSlot = 0;
    scan.regions.forEach(function (region) {
      const fused = next.fusionRegions[region.id];
      if (!fused || nextSlot >= backend.maxRegions) {
        return; // not a surface the geometry covers, or more than the shader holds at once - rare, graceful
      }
      let homography = fused.homography;
      if (!homography && fused.plane) {
        homography = planeHomography(fused.plane, next.intrinsics);
      }
      if (!homography) {
        return;
      }
      slotOf.set(region.id, nextSlot);
      nextSlot += 1;
      indexToRegionId.set(region.index, region.id);
      info.set(region.id, {
        homography: homography,
        // a region with no mask array (a bare test fixture) just gets neutral light
        medianShading: (region.mask && maskedMedian(shading, region.mask)) || 1,
        exposure: next.photoLinear && region.mask ? exposureFor(maskedMedian(next.photoLinear, region.mask)) : 1,
      });
    });

    backend.uploadScene({
      width: scan.width,
      height: scan.height,
      labelMap: remapLabels(scan),
      depth: next.depth || new Float32Array(total).fill(1),
      shading: shading,
      residual: next.residual || new Float32Array(total),
      luma: next.luma || new Float32Array(total).fill(0.5),
    });
    backend.setRegions(packRegionsForBackend());
  }

  // The scan's outlines changed but the geometry did not (a refined edge, an HD scan with the same regions): re-read the
  // label map only. Resolves false if the scan has another size than the uploaded scene.
  function updateLabels(scan) {
    if (!scene || scan.width * scan.height !== sceneSize) {
      return false;
    }
    backend.setLabels(remapLabels(scan));
    return true;
  }

  // The "which pixels may be painted" map. Both shaders return a transparent pixel wherever it is 0, and uploadScene()
  // resets it to all zeros - so until something calls setAlpha() or setAlphaFromMask() after an upload, the preview paints
  // nothing at all.
  function setAlpha(alphaFloat32) {
    backend.setAlpha(alphaFloat32);
  }

  // 1 inside `mask` (a Uint8Array at the scene's size, e.g. a scan region's own mask), 0 everywhere else. Resolves false and
  // does nothing if the size is wrong.
  function setAlphaFromMask(mask) {
    if (!mask || mask.length !== sceneSize) {
      return false;
    }
    const alpha = new Float32Array(mask.length);
    for (let i = 0; i < mask.length; i += 1) {
      alpha[i] = mask[i] ? 1 : 0;
    }
    backend.setAlpha(alpha);
    return true;
  }

  function clearAlpha() {
    if (sceneSize > 0) {
      backend.setAlpha(new Float32Array(sceneSize));
    }
  }

  function applyMaterial(regionId, item, rotation, bitmap) {
    backend.setMaterialLayer(slotOf.get(regionId), bitmap, MATERIAL_TILE_WIDTH, MATERIAL_TILE_HEIGHT);
    assignments.set(regionId, { item: item, rotation: rotation || 0 });
    backend.setRegions(packRegionsForBackend());
  }

  // Assigns a catalog item to a region. Resolves false (no-op) if this region never got a GPU slot (no fused plane -
  // canUseFastRender() in tiers.js should already have kept the caller from reaching here) or the item has no texture
  // (motif/rug - always Gemini, see tiers.js). When the texture is already in memory everything happens before this
  // returns, so the caller can render() in the same frame; otherwise it is fetched first.
  function setMaterial(regionId, item, rotation) {
    if (!slotOf.has(regionId) || !item || !item.texture || !item.texture.url) {
      return Promise.resolve(false);
    }
    const generation = scene;
    const cached = store.peek(item.texture.url);
    if (cached) {
      applyMaterial(regionId, item, rotation, cached);
      return Promise.resolve(true);
    }
    return store.get(item.texture.url).then(function (bitmap) {
      if (scene !== generation || !slotOf.has(regionId)) {
        return false; // the scene changed while the fetch was in flight
      }
      applyMaterial(regionId, item, rotation, bitmap);
      return true;
    });
  }

  function clearMaterial(regionId) {
    if (!assignments.has(regionId)) {
      return;
    }
    assignments.delete(regionId);
    backend.setRegions(packRegionsForBackend());
  }

  function hasRegion(regionId) {
    return slotOf.has(regionId);
  }

  // Start loading these textures (in the order given) so that picking one of them later is instant.
  function prefetch(urls) {
    return store.prefetch(urls);
  }

  function isCached(url) {
    return store.has(url);
  }

  function render() {
    backend.render();
  }

  // Draws and reads the canvas in the same call: a WebGPU canvas keeps its picture only until the frame is presented, so a
  // read some time after render() can come back blank.
  function readPixelsAsBlob(mimeType, quality) {
    backend.render();
    return backend.readPixelsAsBlob(mimeType, quality);
  }

  function destroy() {
    backend.destroy();
  }

  return {
    kind: backend.kind,
    uploadScene: uploadScene,
    updateLabels: updateLabels,
    setAlpha: setAlpha,
    setAlphaFromMask: setAlphaFromMask,
    clearAlpha: clearAlpha,
    setMaterial: setMaterial,
    clearMaterial: clearMaterial,
    hasRegion: hasRegion,
    prefetch: prefetch,
    isCached: isCached,
    render: render,
    readPixelsAsBlob: readPixelsAsBlob,
    sceneKind: function () {
      return sceneKind;
    },
    cacheSize: function () {
      return store.size;
    },
    destroy: destroy,
  };
}
