// Why the instant preview is NOT drawn for what is selected right now, in words - or null when it is drawn, or when there
// is nothing to preview yet (no surface selected, no finish picked). Pure: no DOM, no GPU, no imports, so it can be tested
// and loaded on its own like tiers.js.
//
// OVERLAY COPY (site/overlays/studio/): only the "no-fit" wording differs from the studio's own file, because the outline estimate now also
// covers doors, furniture and other objects (provisional.js ESTIMATED_KINDS).
//
// Before this, every "no" below was silent: the studio simply showed nothing and the finish only appeared after the AI
// render, which read as "the preview works sometimes". The decisions themselves are unchanged (they are tiers.js's and
// studio.js's); this only says which one applied. The order is the order the studio would hit them.
//
// input: {
//   engineOff        Settings > Render is "AI only"
//   selectedCount    how many surfaces are selected
//   hasSurface       a surface is selected (selectedRegion)
//   hasItem          a finish is picked
//   busy             an AI render is running
//   hasScene         the scene to draw on exists (the photo's light is loaded)
//   itemHasTexture   the picked finish has a tileable texture (tiers.canFastRenderItem)
//   fit              the surface's entry in scene.fusionRegions ({confidence}) or undefined
//   lowThreshold     settings.fusionLowThreshold
//   rendererFailed   WebGPU and WebGL2 both unavailable in this browser (stage.js found out)
// }
// -> null | { code, text }
export function previewReason(input) {
  const i = input || {};
  if (!i.hasSurface || !i.hasItem) {
    return null; // nothing to preview yet: not a "no"
  }
  if (i.engineOff) {
    return { code: "engine-off", text: "Instant preview is switched off in Settings > Render, so this finish renders with AI only." };
  }
  if (i.selectedCount !== 1) {
    return { code: "many-surfaces", text: "Instant preview works on one surface at a time. Select a single surface." };
  }
  if (i.busy) {
    return { code: "busy", text: "Instant preview is paused while an AI render is running." };
  }
  if (i.rendererFailed) {
    return {
      code: "no-gpu",
      text: "This browser has neither WebGPU nor WebGL2 available, so there is no instant preview here; finishes render with AI.",
    };
  }
  if (!i.hasScene) {
    return { code: "not-ready", text: "Instant preview is not ready yet: the photo is still being prepared." };
  }
  if (!i.itemHasTexture) {
    return {
      code: "no-texture",
      text: "This finish adds or restyles an object, so it has no instant preview. Use Render to see it.",
    };
  }
  if (!i.fit) {
    return {
      code: "no-fit",
      text: "Instant preview covers walls, floors, ceilings, doors and furniture. This surface (a window, or one too small to outline) has no fit, so use Render to see the finish.",
    };
  }
  const low = typeof i.lowThreshold === "number" ? i.lowThreshold : 0.3;
  if (typeof i.fit.confidence !== "number" || Number.isNaN(i.fit.confidence) || i.fit.confidence < low) {
    return {
      code: "weak-fit",
      text: "The 3D fit for this surface is too uncertain for an instant preview. Use Render to see the finish.",
    };
  }
  return null;
}
