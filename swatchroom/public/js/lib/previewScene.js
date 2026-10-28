// Chooses what the instant preview draws on: the REAL scene (MoGe-2's planes + Marigold's light, once the room pipeline has
// finished) or, until then and for any surface the real fit does not cover, the PROVISIONAL one estimated from the scan's
// outlines alone (lib/fastrender/provisional.js). The stage re-uploads everything to the GPU whenever the scene's
// `geometryKey` changes, so this module's job is to keep that key and the object identities STABLE: the same inputs give
// the same object, a new scan with the same geometry gives a new object with the same key (the stage then replaces only the
// label map).
//
//   const composer = createSceneComposer(buildProvisionalScene);
//   composer.compose(scan, fusedPayloadOrNull, photoLightOrNull, weakBelow)  ->  scene | null
//
// weakBelow (settings.fusionLowThreshold): a wall / floor / ceiling whose fitted plane scores below it is NOT left without a
// preview (the studio used to switch the preview off for it, silently): it gets the outline-based estimate instead, which is
// flagged as approximate. Measured with real MoGe-2 depth: a wall with a TV niche scored 0.43 and had no preview at all.
//
// fused: { kind: "fused", geometryKey, scan, fusionRegions, depth, shading, residual, luma, photoLinear, intrinsics }
// photoLight: { luma, linear } at the scan's size, from fastrender/geometry.js lumaFromRgba()
export function createSceneComposer(buildProvisional) {
  let provisional = null; // { scan, light, scene }
  let composed = null; // { fused, scan, light, weakBelow, scene }

  function provisionalFor(scan, light) {
    if (!light) {
      return null;
    }
    if (provisional && provisional.scan === scan && provisional.light === light) {
      return provisional.scene;
    }
    const scene = buildProvisional(scan, light);
    provisional = { scan: scan, light: light, scene: scene };
    return scene;
  }

  function compose(scan, fused, light, weakBelow) {
    if (!scan || scan.regions.length === 0) {
      return null;
    }
    if (!fused) {
      return provisionalFor(scan, light);
    }
    if (composed && composed.fused === fused && composed.scan === scan && composed.light === light && composed.weakBelow === weakBelow) {
      return composed.scene;
    }
    // surfaces of THIS scan the fit knows nothing about (outlined or split after the fit): borrow the estimate for them
    const missing = scan.regions.filter(function (region) {
      if (!(region.kind === "wall" || region.kind === "floor" || region.kind === "ceiling") || region.areaShare < 0.004) {
        return false;
      }
      const fit = fused.fusionRegions[region.id];
      return !fit || (Number.isFinite(weakBelow) && typeof fit.confidence === "number" && fit.confidence < weakBelow);
    });
    let fusionRegions = fused.fusionRegions;
    let geometryKey = fused.geometryKey;
    let extra = null;
    if (missing.length > 0) {
      const estimate = provisionalFor(scan, light);
      if (estimate) {
        extra = {};
        missing.forEach(function (region) {
          if (estimate.fusionRegions[region.id]) {
            extra[region.id] = estimate.fusionRegions[region.id];
          }
        });
        const ids = Object.keys(extra).sort();
        if (ids.length > 0) {
          fusionRegions = Object.assign({}, fused.fusionRegions, extra); // the estimate replaces a weak fit
          geometryKey = fused.geometryKey + "+" + ids.join(",");
        }
      }
    }
    const scene = Object.assign({}, fused, {
      scan: scan,
      fusionRegions: fusionRegions,
      geometryKey: geometryKey,
      luma: fused.luma || (light && light.luma) || null,
      photoLinear: fused.photoLinear || (light && light.linear) || null,
    });
    composed = { fused: fused, scan: scan, light: light, weakBelow: weakBelow, scene: scene };
    return scene;
  }

  return { compose: compose };
}
