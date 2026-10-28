// Studio settings, kept in this browser (each designer can have their own).
// The Google key and the passcode live on the server, in .env.

const SETTINGS_KEY = "swatchroom.settings.v1";
const SETTINGS_VERSION = 10;

export const IMAGE_MODELS = [
  {
    id: "gemini-3.1-flash-image",
    name: "Fast",
    note: "Recommended. Fastest full-quality edits, lower latency",
  },
  {
    id: "gemini-nano-banana-2.1",
    name: "Mask-aware",
    note: "Mask-aware edits at 2K or 4K, higher latency",
  },
  {
    id: "gemini-3-pro-image",
    name: "Highest fidelity",
    note: "Highest fidelity, slowest",
  },
  {
    id: "gemini-3.1-flash-lite-image",
    name: "Draft",
    note: "Quick drafts only, 1K output",
  },
];

// Scene models run in the Python model service.
export const SCENE_MODELS = [
  {
    id: "b2",
    name: "Fast",
    note: "Quickest, good for a server without a GPU",
  },
  {
    id: "b4",
    name: "Detailed",
    note: "Sharper edges",
  },
  {
    id: "b5-quant",
    name: "Maximum, quantized",
    note: "SegFormer-B5 with INT8 weights on a CPU (fp16 on a GPU): the finest local model at a fraction of the cost (recommended)",
  },
  {
    id: "b5",
    name: "Maximum, full precision",
    note: "The same model without quantization; slowest",
  },
];

// How a material swap gets rendered.
export const RENDER_ENGINES = [
  {
    id: "auto",
    name: "Instant + AI",
    note: "Recommended. Swap finishes instantly from the saved photo understanding; low-confidence surfaces and final renders still use AI",
  },
  {
    id: "gemini-only",
    name: "AI only",
    note: "Every swap is an AI render, the way every render worked before this feature existed",
  },
];

export const LOCATIONS = [
  "global",
  "us-central1",
  "europe-west4",
  "asia-south1",
  "asia-southeast1",
];

export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    location: "global",
    segmentationEngine: "scene",
    sceneModel: "b5-quant",
    // Race OneFormer on Modal against the local model, and offer its more accurate scan when it arrives later
    useHdScan: true,
    // When a surface is selected, tighten its outline to SAM's and cut out the rugs / furniture standing on it
    samCalibrate: true,
    useGeminiAssist: true,
    fallbackToGemini: true,
    geminiEngine: "polygon",
    maskModel: "gemini-2.5-flash",
    polygonModel: "gemini-3.8-flash",
    analysisMaxSide: 1024,
    hideSmallSurfaces: true,
    imageModel: "gemini-3.1-flash-image",
    renderSize: "2K",
    sendPolygon: true,
    uploadMaxSide: 2048,
    estimateQuantities: true,
    insightModel: "gemini-3.8-flash",
    areaUnit: "sqft",
    currency: "₹",
    // Instant local rendering (WebGPU/WebGL2, from the saved photo understanding) vs always
    // using Gemini, the way every render worked before this setting existed.
    renderEngine: "auto",
    // Below this, a surface's fitted plane is not trusted: the preview uses the outline-based estimate for it instead of the
    // plane (it is still shown, flagged as approximate). 0.45 was too strict: with real MoGe-2 depth a wall with a TV niche
    // scored 0.43 and had no preview at all.
    fusionLowThreshold: 0.3,
    // Below this (but above the low threshold), the fast render is shown but nudged toward
    // "Render with AI" rather than trusted silently.
    fusionHighThreshold: 0.7,
  };
}

// Bring settings saved by older versions up to date.
function migrate(saved) {
  const next = Object.assign({}, saved);
  if (!next.version || next.version < 4) {
    if (next.geminiEngine === "auto" || next.geminiEngine === "mask") {
      next.geminiEngine = "polygon";
    }
    ["polygonModel", "insightModel"].forEach(function (field) {
      if (!next[field] || /^gemini-(2\.|3\.5-flash)/.test(next[field])) {
        next[field] = "gemini-3.8-flash";
      }
    });
  }
  if (!next.version || next.version < 5) {
    // Models moved from the browser to the server.
    const match = /segformer-(b[245])/.exec(String(next.sceneModel || ""));
    next.sceneModel = match ? match[1] : "b4";
    delete next.preferGpu;
    delete next.samUrl;
    delete next.samKey;
    delete next.samAuthHeader;
    delete next.autosave;
  }
  if (!next.version || next.version < 6) {
    // Nano Banana 2.1 was the default; switch to the faster Nano Banana 2 for lower latency.
    if (next.imageModel === "gemini-nano-banana-2.1") {
      next.imageModel = "gemini-3.1-flash-image";
    }
  }
  if (!next.version || next.version < 8) {
    // The SAM 3.1 server (a separate, optional alternate scan/Pick engine) was removed.
    if (next.segmentationEngine === "sam") {
      next.segmentationEngine = "scene";
    }
    delete next.samPrompts;
    delete next.samThreshold;
    delete next.clickSelect;
  }
  if (!next.version || next.version < 9) {
    // SegFormer-B5 (INT8 on a CPU) replaced B4 as the default local scene model
    if (next.sceneModel === "b4" || !next.sceneModel) {
      next.sceneModel = "b5-quant";
    }
    if (next.useHdScan === undefined) {
      next.useHdScan = true;
    }
    if (next.samCalibrate === undefined) {
      next.samCalibrate = true;
    }
  }
  if (!next.version || next.version < 10) {
    // the old default (0.45) switched the preview off for ordinary walls; a value the designer chose themselves is kept
    if (next.fusionLowThreshold === 0.45) {
      next.fusionLowThreshold = 0.3;
    }
  }
  next.version = SETTINGS_VERSION;
  return next;
}

export function loadSettings() {
  const defaults = defaultSettings();
  try {
    const text = window.localStorage.getItem(SETTINGS_KEY);
    if (!text) {
      return defaults;
    }
    return Object.assign(defaults, migrate(JSON.parse(text)));
  } catch (error) {
    return defaults;
  }
}

export function saveSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    // storage is optional
  }
}

// The 4K option only exists on Nano Banana 2.1 and Pro; Lite is capped at 1K.
export function renderSizeFor(settings) {
  const model = String(settings.imageModel || "");
  if (model.indexOf("lite") !== -1) {
    return "";
  }
  if (
    settings.renderSize === "4K" &&
    (model.indexOf("nano-banana") !== -1 || model.indexOf("pro") !== -1)
  ) {
    return "4K";
  }
  return "2K";
}
