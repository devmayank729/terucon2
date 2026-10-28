// Pure functions deciding whether a surface can render through the fast (WebGPU/WebGL2) path.
// No DOM, no GPU - two independent axes have to both allow it: whether a renderer exists at
// all in this browser (device.js), and whether THIS surface's own fused geometry is trusted
// enough (the confidence bands below). Kept pure and framework-free so it is trivially
// testable and so the studio's state/set()/update() loop can call it on every render without
// worrying about side effects.

// Confidence -> tier, from the designer's own live threshold settings
// (public/js/lib/settings.js: fusionLowThreshold, fusionHighThreshold) - not baked in at
// pipeline time, so changing the thresholds in Settings never needs a re-run; it just
// re-reads the same stored confidence under new bands.
export function regionTier(confidence, settings) {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return "gemini-only";
  }
  const low =
    settings && typeof settings.fusionLowThreshold === "number" ? settings.fusionLowThreshold : 0.3;
  const high =
    settings && typeof settings.fusionHighThreshold === "number"
      ? settings.fusionHighThreshold
      : 0.7;
  if (confidence < low) {
    return "gemini-only";
  }
  if (confidence < high) {
    return "flagged";
  }
  return "fast";
}

// A catalog item can only ever go through the fast path if it has a real tileable texture
// (public/js/data/catalog.js, authored by scripts/build-textures.js) - motifs and rugs never
// do, by design, regardless of how good the room's geometry is.
export function canFastRenderItem(item) {
  return !!(item && item.texture && item.texture.url);
}

// Both axes have to allow it: a working renderer in this browser, a fast-renderable item, and
// a surface whose fused geometry isn't flagged as untrustworthy.
export function canUseFastRender(rendererAvailable, confidence, item, settings) {
  return (
    !!rendererAvailable &&
    canFastRenderItem(item) &&
    regionTier(confidence, settings) !== "gemini-only"
  );
}

// The fast preview is shown, but the UI should nudge toward "Render with AI" rather than treat
// it as a finished result (settings.js's RENDER_ENGINES "auto" mode, studio.js's preview path).
export function shouldNudgeForPolish(rendererAvailable, confidence, item, settings) {
  return (
    canUseFastRender(rendererAvailable, confidence, item, settings) &&
    regionTier(confidence, settings) === "flagged"
  );
}

export function engineForcesGeminiOnly(settings) {
  return !!settings && settings.renderEngine === "gemini-only";
}
