// The photo with its surface overlays, and every pointer gesture on it.
//
// Mouse: hover shows the surface, click selects (Shift/Ctrl adds), wheel zooms, Space-drag or
//        middle-drag pans, left-drag pans when zoomed in.
// Touch: tap selects (a magnifier follows the finger once it rests or drags, and the surface under
//        its centre is chosen on lift), a longer press adds or removes a surface from the
//        selection, pinch zooms, one finger pans when zoomed in, double-tap zooms in or back to fit.
// While a gesture runs, the frame moves with a CSS transform only (like sliding a printed
// photo under a magnifier); the overlay is redrawn once when the gesture ends.
//
// The Stage owns its element. The studio calls stage.update(props) on every render.

import { cx, h, isTyping, live, update } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { swatchMarkup } from "./swatch.js";
import { SELECT_RGB, antsPattern } from "../lib/sprites.js";
import { loopsToPath } from "../lib/outlines.js";
import { KIND_INFO, regionAt } from "../lib/regions.js";
import { makeCanvas } from "../lib/images.js";
import { createFastRenderer } from "../lib/fastrender/renderer.js";
import { previewCanvasSize } from "../lib/fastrender/sizing.js";

const MAX_ZOOM = 8;
const MAX_CANVAS = 4096;
// Outline widths in screen (CSS) pixels: a thin line in the surface's colour on a darker casing, so
// it reads on a white wall and on a dark floor alike, at any zoom and pixel density.
const EDGE_CORE = 1.1;
const EDGE_CASING = 2.6;
const ANTS_WIDTH = 2.6;
const ANTS_DASH = 5;
// Overlays bigger than about 2.4k x 2.4k are stroked directly instead of through a cached bitmap.
const MAX_EDGE_CACHE_PIXELS = 6000000;

function pathOf(part) {
  if (!part.path && part.loops) {
    part.path = loopsToPath(part.loops);
  }
  return part.path;
}
const CARD_WIDTH = 272;
const TAP_SLOP = 8;
// Touch: pressing and holding (or dragging) shows a magnifier loupe above the finger, so a thin moulding, a pillar or a strip
// of floor can be aimed at precisely; lifting the finger selects what was under the crosshair. Holding STILL for the longer
// time below instead adds the surface to the selection (the touch version of Shift-click).
const LOUPE_HOLD_MS = 220;
const LOUPE_SIZE = 124; // CSS px, the loupe's diameter
const LOUPE_ZOOM = 2.5;
const LOUPE_OFFSET = 70; // CSS px between the finger and the loupe's centre
const LONG_PRESS_MS = 650;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function reducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (error) {
    return false;
  }
}

function vibrate(milliseconds) {
  try {
    if (navigator.vibrate) {
      navigator.vibrate(milliseconds);
    }
  } catch (error) {
    // not supported
  }
}

export class Stage {
  constructor() {
    const stage = this;
    this.element = live(h("div", { class: "sr-well" }));
    this.props = null;
    this.state = {
      box: { width: 0, height: 0 },
      view: { zoom: 1, x: 0, y: 0 },
      cursorPoint: null,
      divider: 50,
      spaceHeld: false,
      strokeTick: 0,
      cardProductId: null,
    };
    this.frameElement = null;
    this.canvasElement = null;
    this.fastCanvasElement = null;
    // Instant preview (WebGPU/WebGL2) over the room pipeline's saved geometry/lighting - see
    // maybeFastRender() below. null until a scene actually needs it (most of the time today,
    // since it needs a real pipeline result); everything else in Stage works exactly as before
    // regardless of whether any of this ever activates.
    this.fastRenderer = null;
    this.fastRendererPromise = null;
    this.fastGeometryKey = null; // which geometry (fused or provisional) is uploaded to the renderer
    this.fastScanToken = null; // which scan's label map is uploaded
    this.fastMaterialKey = "";
    this.fastAssignedRegion = null;
    this.fastAlphaKey = ""; // whose mask (region + the exact mask array) is in the renderer's alpha map right now
    this.fastPrefetchToken = null;
    this.maskTokens = new WeakMap();
    this.maskCounter = 0;
    this.tipElement = null;
    // the touch magnifier (see showLoupe()): one element kept for the stage's life, shown and moved without a re-render
    this.loupeCanvas = h("canvas", { class: "sr-loupe-canvas" });
    this.loupeElement = live(
      h("div", { key: "loupe", class: "sr-loupe", "aria-hidden": "true", style: { display: "none" } }, this.loupeCanvas),
    );
    this.loupeShown = false;
    this.ants = null;
    this.pointers = new Map();
    this.gesture = null;
    this.liveView = null;
    this.stroke = null;
    this.lastTap = null;
    this.hoverId = null;
    this.wheelTimer = 0;
    this.cardTimer = 0;
    this.cardHold = false;
    this.pickPreviewCanvas = null;
    this.pickPreviewSource = null;
    this.drawDeps = null;
    this.drawFrame = 0;
    this.edgeCache = null;
    this.lastFit = "";
    this.lastHoverProductId = undefined;

    const well = this.element;
    well.addEventListener("pointerdown", function (event) {
      stage.onPointerDown(event);
    });
    well.addEventListener("pointermove", function (event) {
      stage.onPointerMove(event);
    });
    well.addEventListener("pointerup", function (event) {
      stage.onPointerUp(event);
    });
    well.addEventListener("pointercancel", function (event) {
      stage.onPointerUp(event);
    });
    well.addEventListener("pointerleave", function (event) {
      stage.onPointerLeave(event);
    });
    well.addEventListener("dblclick", function (event) {
      stage.onDoubleClick(event);
    });
    well.addEventListener("contextmenu", function (event) {
      if (stage.props && stage.props.coarse) {
        event.preventDefault();
      }
    });
    well.addEventListener(
      "wheel",
      function (event) {
        stage.onWheel(event);
      },
      { passive: false },
    );
    this.resizeObserver = new ResizeObserver(function () {
      stage.measure();
    });
    this.resizeObserver.observe(well);
    this.onKeyDown = function (event) {
      stage.keyDown(event);
    };
    this.onKeyUp = function (event) {
      if (event.code === "Space" && stage.state.spaceHeld) {
        stage.setState({ spaceHeld: false });
      }
    };
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  destroy() {
    this.resizeObserver.disconnect();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    if (this.drawFrame) {
      window.cancelAnimationFrame(this.drawFrame);
    }
    if (this.fastRenderer) {
      this.fastRenderer.destroy();
      this.fastRenderer = null;
    }
  }

  setState(patch) {
    Object.assign(this.state, patch);
    if (this.props) {
      this.render();
    }
  }

  update(props) {
    const fitKey =
      props.imageWidth + "x" + props.imageHeight + ":" + props.fitSignal;
    if (fitKey !== this.lastFit) {
      this.lastFit = fitKey;
      this.state.view = { zoom: 1, x: 0, y: 0 };
    }
    this.props = props;
    this.render();
  }

  measure() {
    const rect = this.element.getBoundingClientRect();
    const box = this.state.box;
    if (
      Math.abs(box.width - rect.width) < 0.5 &&
      Math.abs(box.height - rect.height) < 0.5
    ) {
      return;
    }
    this.setState({ box: { width: rect.width, height: rect.height } });
  }

  // ------------------------------------------------------------------ geometry
  geometry() {
    const props = this.props;
    const box = this.state.box;
    const narrow = props.layout === "narrow";
    const padSide = narrow ? 6 : 20;
    const padTop = narrow ? 6 : 64;
    const padBottom = narrow ? 6 : 20;
    // In the medium layout the tool panel floats over the right edge of the stage; fit and
    // centre the photo in what it leaves uncovered instead of under it.
    const inset = props.layout === "medium" ? props.rightInset || 0 : 0;
    const availWidth = Math.max(40, box.width - inset - padSide * 2);
    const availHeight = Math.max(40, box.height - padTop - padBottom);
    const fit = props.imageWidth
      ? Math.min(
          availWidth / props.imageWidth,
          availHeight / props.imageHeight,
          2,
        )
      : 1;
    return {
      padSide: padSide,
      padTop: padTop,
      availWidth: availWidth,
      availHeight: availHeight,
      baseWidth: Math.floor(props.imageWidth * fit),
      baseHeight: Math.floor(props.imageHeight * fit),
      boxWidth: box.width - inset,
    };
  }

  clampView(next) {
    const g = this.geometry();
    const width = g.baseWidth * next.zoom;
    const height = g.baseHeight * next.zoom;
    const maxX = Math.max(0, (width - g.availWidth) / 2 + g.padSide);
    const maxY = Math.max(0, (height - g.availHeight) / 2 + g.padSide);
    return {
      zoom: next.zoom,
      x: clamp(next.x, -maxX, maxX),
      y: clamp(next.y, -maxY, maxY),
    };
  }

  rectFor(current) {
    const g = this.geometry();
    const width = Math.round(g.baseWidth * current.zoom);
    const height = Math.round(g.baseHeight * current.zoom);
    return {
      width: width,
      height: height,
      left: Math.round((g.boxWidth - width) / 2 + current.x),
      top: Math.round(g.padTop + (g.availHeight - height) / 2 + current.y),
    };
  }

  committed() {
    return this.clampView(this.state.view);
  }

  frameRect() {
    return this.rectFor(this.committed());
  }

  // Zoom so the image point under (px, py) stays put. px/py are relative to the well.
  zoomAt(current, nextZoom, px, py) {
    const g = this.geometry();
    const zoom = clamp(nextZoom, 1, MAX_ZOOM);
    const rect = this.rectFor(current);
    const u = (px - rect.left) / rect.width;
    const v = (py - rect.top) / rect.height;
    const width = g.baseWidth * zoom;
    const height = g.baseHeight * zoom;
    const left = px - u * width;
    const top = py - v * height;
    if (zoom === 1) {
      return { zoom: 1, x: 0, y: 0 };
    }
    return this.clampView({
      zoom: zoom,
      x: left - (g.boxWidth - width) / 2,
      y: top - g.padTop - (g.availHeight - height) / 2,
    });
  }

  currentView() {
    return this.liveView || this.committed();
  }

  // Move the frame with a transform only (no redraw).
  applyLive(next) {
    this.liveView = next;
    const element = this.frameElement;
    if (!element) {
      return;
    }
    const frame = this.frameRect();
    const target = this.rectFor(next);
    const scale = target.width / Math.max(1, frame.width);
    element.style.transform =
      "translate(" +
      (target.left - frame.left) +
      "px, " +
      (target.top - frame.top) +
      "px) scale(" +
      scale +
      ")";
  }

  setView(view) {
    this.liveView = null;
    if (this.frameElement) {
      this.frameElement.style.transform = "";
    }
    this.setState({ view: view });
  }

  commitLive() {
    if (this.liveView) {
      this.setView(this.liveView);
    }
  }

  zoomBy(factor) {
    const g = this.geometry();
    const base = this.currentView();
    this.setView(
      this.zoomAt(
        base,
        base.zoom * factor,
        g.boxWidth / 2,
        g.padTop + g.availHeight / 2,
      ),
    );
  }

  fitView() {
    this.setView({ zoom: 1, x: 0, y: 0 });
  }

  // ------------------------------------------------------------------ wheel + keys
  onWheel(event) {
    if (!this.props || !this.props.imageWidth) {
      return;
    }
    if (event.target.closest(".sr-sheet, .sr-tool-options, .sr-toasts")) {
      return;
    }
    event.preventDefault();
    const rect = this.element.getBoundingClientRect();
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0018));
    const base = this.currentView();
    this.applyLive(
      this.zoomAt(
        base,
        base.zoom * factor,
        event.clientX - rect.left,
        event.clientY - rect.top,
      ),
    );
    clearTimeout(this.wheelTimer);
    const stage = this;
    this.wheelTimer = setTimeout(function () {
      stage.commitLive();
    }, 140);
  }

  keyDown(event) {
    if (!this.props || !this.element.isConnected) {
      return;
    }
    if (
      isTyping(event.target) ||
      document.querySelector("swatchroom-app dialog[open]")
    ) {
      return;
    }
    if (event.code === "Space" && !event.repeat) {
      event.preventDefault();
      this.setState({ spaceHeld: true });
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (event.key === "0" || event.key === "f" || event.key === "F") {
      this.fitView();
    }
    if (event.key === "=" || event.key === "+") {
      this.zoomBy(1.25);
    }
    if (event.key === "-" || event.key === "_") {
      this.zoomBy(0.8);
    }
  }

  // ------------------------------------------------------------------ overlay drawing
  pickPreview() {
    const preview = this.props.pickPreview;
    if (!preview) {
      this.pickPreviewCanvas = null;
      this.pickPreviewSource = null;
      return null;
    }
    if (this.pickPreviewSource === preview) {
      return this.pickPreviewCanvas;
    }
    const canvas = makeCanvas(preview.width, preview.height);
    const context = canvas.getContext("2d");
    const pixels = context.createImageData(preview.width, preview.height);
    for (let index = 0; index < preview.mask.length; index += 1) {
      if (!preview.mask[index]) {
        continue;
      }
      const offset = index * 4;
      pixels.data[offset] = 92;
      pixels.data[offset + 1] = 214;
      pixels.data[offset + 2] = 228;
      pixels.data[offset + 3] = 120;
    }
    context.putImageData(pixels, 0, 0);
    this.pickPreviewCanvas = canvas;
    this.pickPreviewSource = preview;
    return canvas;
  }

  // ------------------------------------------------------------------ fast render (instant
  // preview from the room pipeline's saved geometry/lighting - public/js/lib/fastrender/)
  //
  // A transparent WebGPU/WebGL2 canvas stacked between the photo and the selection overlay
  // (see the "fastrender" canvas above). Lazily created the first time a scene actually shows
  // up in props (most of the time that is never, since it needs a real pipeline result - see
  // studio.js's ensureFusion()); until then this whole section is inert and every other part of
  // Stage behaves exactly as it did before this feature existed.
  ensureFastRenderer() {
    if (this.fastRenderer || this.fastRendererPromise) {
      return this.fastRendererPromise;
    }
    const canvas = this.fastCanvasElement;
    if (!canvas) {
      return Promise.resolve(null);
    }
    const stage = this;
    this.fastRendererPromise = createFastRenderer(canvas)
      .then(function (renderer) {
        stage.fastRenderer = renderer;
        return renderer;
      })
      .catch(function () {
        stage.fastRenderer = null;
        return null;
      });
    return this.fastRendererPromise;
  }

  // Called on every render() pass (like maybeDraw()). Cheap when there is nothing to do: the very first check
  // (props.fastEnabled && props.fastScene) is false until the room has a scan to preview on.
  //
  // THE CONTRACT. Picking a finish (or tapping another surface while a finish is chosen) changes props.fastMaterial; this
  // function then paints it in the SAME call whenever the texture is already in memory (renderer.prefetch() keeps the
  // visible catalogue loaded), so the preview appears on the next animation frame with no network request. It never starts
  // a Gemini render: that is studio.startRender(), reached only from the Render button / Ctrl+Enter.
  maybeFastRender() {
    const props = this.props;
    const canvas = this.fastCanvasElement;
    if (!canvas || !props) {
      return;
    }
    if (!props.fastEnabled || !props.fastScene) {
      this.clearFastPreview();
      return;
    }
    if (this.fastRenderer) {
      this.runFastRender(this.fastRenderer, canvas);
      return;
    }
    const stage = this;
    this.ensureFastRenderer().then(function (renderer) {
      if (!renderer || stage.fastCanvasElement !== canvas || !stage.props) {
        return; // neither WebGPU nor WebGL2 works here, or the stage moved on meanwhile
      }
      stage.runFastRender(renderer, canvas);
    });
  }

  // Nothing to preview any more (engine switched off, scene gone): take down whatever is on the canvas.
  clearFastPreview() {
    if (this.fastRenderer && (this.fastAssignedRegion || this.fastAlphaKey)) {
      if (this.fastAssignedRegion) {
        this.fastRenderer.clearMaterial(this.fastAssignedRegion);
      }
      this.fastRenderer.clearAlpha();
      this.fastRenderer.render();
    }
    this.fastAssignedRegion = null;
    this.fastAlphaKey = "";
    this.fastGeometryKey = null;
    this.fastScanToken = null;
    this.fastMaterialKey = "";
  }

  // A number that identifies one particular mask array, so "the same region but a refined mask" is noticed.
  maskToken(mask) {
    if (!mask) {
      return 0;
    }
    let token = this.maskTokens.get(mask);
    if (!token) {
      this.maskCounter += 1;
      token = this.maskCounter;
      this.maskTokens.set(mask, token);
    }
    return token;
  }

  runFastRender(renderer, canvas) {
    const props = this.props;
    const scene = props ? props.fastScene : null;
    if (!scene) {
      return; // the scene went away while the renderer was starting
    }
    const frame = this.frameRect();
    if (frame.width === 0) {
      return;
    }
    let changed = false;
    // The drawing buffer follows the SCREEN, not the 1024 px scan: frame width x device pixel ratio, at most 2048 px. The
    // shaders read the scan's textures through normalised coordinates, so any size works, and a 3x phone gets a sharp edge
    // instead of a staircase of 3 px steps. (CSS stretches it over the photo: `width: 100%` on .sr-frame-overlay.)
    const size = previewCanvasSize(frame.width, frame.height, window.devicePixelRatio || 1);
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width;
      canvas.height = size.height;
      changed = true;
    }
    if (this.fastGeometryKey !== scene.geometryKey) {
      // new geometry (the first scene, the fused one replacing the provisional one, another photo): upload everything.
      // uploadScene() zeroes the alpha map and drops every material assignment, so the bookkeeping resets with it, and the
      // material below is assigned again in this same call - from the texture cache, so there is no blank frame between.
      this.fastGeometryKey = scene.geometryKey;
      this.fastScanToken = scene.scan;
      this.fastAssignedRegion = null;
      this.fastAlphaKey = "";
      this.fastMaterialKey = "";
      renderer.uploadScene(scene);
      changed = true;
    } else if (this.fastScanToken !== scene.scan) {
      // same geometry, new outlines (a refined edge, the HD scan): only the label map is replaced
      this.fastScanToken = scene.scan;
      this.fastAlphaKey = "";
      if (!renderer.updateLabels(scene.scan)) {
        this.fastGeometryKey = scene.geometryKey;
        this.fastAssignedRegion = null;
        this.fastMaterialKey = "";
        renderer.uploadScene(scene);
      }
      changed = true;
    }
    if (props.fastPrefetch && props.fastPrefetch !== this.fastPrefetchToken) {
      this.fastPrefetchToken = props.fastPrefetch;
      renderer.prefetch(props.fastPrefetch);
    }

    const material = props.fastMaterial;
    const usable = !!material && renderer.hasRegion(material.regionId);
    // Only one surface previews at a time: take the previous one down COMPLETELY (its finish and the part of the alpha map
    // that let it paint) before showing another, so tapping surface B right after surface A leaves no ghost of A behind.
    if (this.fastAssignedRegion && (!usable || material.regionId !== this.fastAssignedRegion)) {
      renderer.clearMaterial(this.fastAssignedRegion);
      renderer.clearAlpha();
      this.fastAssignedRegion = null;
      this.fastAlphaKey = "";
      this.fastMaterialKey = "";
      changed = true;
    }
    let pending = null;
    if (usable) {
      // The shaders paint only where the alpha map is above 0, and uploadScene() leaves it all zeros: allow exactly the
      // selected surface's own pixels (with a rug, a sofa... carved out, if the studio has found some).
      const alphaKey = material.regionId + ":" + this.maskToken(material.mask);
      if (this.fastAlphaKey !== alphaKey && renderer.setAlphaFromMask(material.mask)) {
        this.fastAlphaKey = alphaKey;
        changed = true;
      }
      const materialKey = material.regionId + "|" + material.item.id + "|" + (material.rotation || 0);
      if (this.fastMaterialKey !== materialKey) {
        this.fastMaterialKey = materialKey;
        this.fastAssignedRegion = material.regionId;
        const url = material.item.texture && material.item.texture.url;
        const stage = this;
        const ready = renderer.setMaterial(material.regionId, material.item, material.rotation);
        if (url && renderer.isCached(url)) {
          changed = true; // already applied, synchronously: drawn below in this very call
        } else {
          pending = ready.then(function (applied) {
            if (applied && stage.fastMaterialKey === materialKey && stage.fastRenderer === renderer) {
              renderer.render();
            }
          });
        }
      }
    }
    if (changed) {
      renderer.render();
    }
    return pending;
  }

  // For the AI render: the instant preview as it is on screen right now, as a PNG, or null when none is showing. The
  // studio blends it into the guide image it sends Gemini so the tile perspective and the room's shading are visible there.
  async previewSnapshot() {
    if (!this.fastRenderer || !this.fastAssignedRegion || !this.fastCanvasElement) {
      return null;
    }
    try {
      return await this.fastRenderer.readPixelsAsBlob("image/png");
    } catch (error) {
      return null;
    }
  }

  // Is a 3D instant preview of `regionId` drawn on the photo at this moment? (provisional: only an estimate)
  previewState() {
    if (!this.fastRenderer || !this.fastAssignedRegion) {
      return null;
    }
    return { regionId: this.fastAssignedRegion, kind: this.fastRenderer.sceneKind() };
  }

  // The size, in device pixels, the overlay's drawing buffer has to be for a frame on this screen.
  overlaySize(frame) {
    const ratio = Math.min(
      window.devicePixelRatio || 1,
      MAX_CANVAS / Math.max(frame.width, frame.height),
    );
    return {
      ratio: ratio,
      width: Math.max(1, Math.round(frame.width * ratio)),
      height: Math.max(1, Math.round(frame.height * ratio)),
    };
  }

  // Redraw the overlay when something it shows has changed (like a React effect).
  maybeDraw() {
    const props = this.props;
    const frame = this.frameRect();
    // Whatever else happens to the canvas (a new element, a reset buffer), a blank or wrongly
    // sized overlay is always redrawn, even when none of the inputs below changed.
    const canvas = this.canvasElement;
    const size = this.overlaySize(frame);
    const intact =
      !!canvas && canvas.width === size.width && canvas.height === size.height;
    const deps = [
      frame.width,
      frame.height,
      props.sprites,
      props.hoverId,
      (props.selectedIds || []).join("|"),
      props.showMap,
      props.scanning,
      props.tool,
      props.outlinePoints,
      this.state.cursorPoint,
      this.comparing(),
      this.peeking(),
      props.pickPoints,
      props.pickPreview,
      this.state.strokeTick,
      props.brushSize,
      props.brushMode,
    ];
    if (intact && this.drawDeps && deps.length === this.drawDeps.length) {
      let same = true;
      for (let index = 0; index < deps.length; index += 1) {
        if (deps[index] !== this.drawDeps[index]) {
          same = false;
          break;
        }
      }
      if (same) {
        return;
      }
    }
    this.drawDeps = deps;
    this.startDrawing(frame);
  }

  comparing() {
    return !!this.props.compareUrl && this.props.compare;
  }

  peeking() {
    return !!this.props.compareUrl && this.props.peek && !this.props.compare;
  }

  startDrawing(frame) {
    if (this.drawFrame) {
      window.cancelAnimationFrame(this.drawFrame);
      this.drawFrame = 0;
    }
    const canvas = this.canvasElement;
    if (!canvas || frame.width === 0) {
      return;
    }
    const props = this.props;
    const stage = this;
    const scan = props.scan;
    const sprites = props.sprites;
    const tool = props.tool || "select";
    const comparing = this.comparing();
    const peeking = this.peeking();
    const cursorPoint = this.state.cursorPoint;
    const overlay = this.overlaySize(frame);
    const ratio = overlay.ratio;
    if (canvas.width !== overlay.width || canvas.height !== overlay.height) {
      canvas.width = overlay.width;
      canvas.height = overlay.height;
    }
    const context = canvas.getContext("2d");
    if (!this.ants) {
      const scratch = makeCanvas(1, 1);
      this.ants = {
        canvas: scratch,
        context: scratch.getContext("2d"),
        pattern: null,
      };
      this.ants.pattern = antsPattern(this.ants.context);
    }
    const ants = this.ants;
    const selectedIds = props.selectedIds || [];
    const selected = selectedIds
      .map(function (id) {
        return sprites ? sprites.regions[id] : null;
      })
      .filter(Boolean);
    const hovered =
      sprites &&
      props.hoverId &&
      selectedIds.indexOf(props.hoverId) === -1 &&
      tool === "select"
        ? sprites.regions[props.hoverId]
        : null;
    const animate =
      selected.length > 0 && !reducedMotion() && !comparing && !peeking;
    const pickPreview = tool === "pick" ? this.pickPreview() : null;
    let lastDraw = 0;

    function drawPart(image, bbox, scaleX, scaleY) {
      context.drawImage(
        image,
        bbox.x0 * scaleX,
        bbox.y0 * scaleY,
        (bbox.x1 - bbox.x0) * scaleX,
        (bbox.y1 - bbox.y0) * scaleY,
      );
    }

    // A selected surface: a faint fill (evenodd, so holes stay clear) and ants marching along its
    // border: a dark casing with gold dashes over it, so the line reads on any photo.
    function drawSelected(part, time) {
      const path = pathOf(part);
      if (!path) {
        return;
      }
      const sx = canvas.width / sprites.width;
      const sy = canvas.height / sprites.height;
      const unit = ratio / ((sx + sy) / 2); // one screen pixel, in scan pixels
      context.save();
      context.setTransform(sx, 0, 0, sy, 0, 0);
      context.lineJoin = "round";
      context.fillStyle = "rgba(" + SELECT_RGB.join(",") + ", 0.23)";
      context.fill(path, "evenodd");
      context.lineWidth = ANTS_WIDTH * unit;
      context.strokeStyle = "rgba(28, 24, 18, 0.92)";
      context.stroke(path);
      const dash = ANTS_DASH * unit;
      context.setLineDash([dash, dash]);
      context.lineDashOffset = animate ? -((time / 55) * unit) % (dash * 2) : 0;
      context.strokeStyle = "rgb(" + SELECT_RGB.join(",") + ")";
      context.stroke(path);
      context.restore();
    }

    function draw(time) {
      if (animate && time - lastDraw < 45) {
        stage.drawFrame = window.requestAnimationFrame(draw);
        return;
      }
      lastDraw = time;
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (!comparing && !peeking && sprites) {
        const scaleX = canvas.width / sprites.width;
        const scaleY = canvas.height / sprites.height;
        context.imageSmoothingEnabled = true;
        if (props.showMap) {
          context.drawImage(sprites.map, 0, 0, canvas.width, canvas.height);
        } else if (!props.scanning) {
          context.globalAlpha =
            props.hoverId || selected.length > 0 ? 0.45 : 0.92;
          stage.drawEdges(context, sprites, canvas.width, canvas.height, ratio);
          context.globalAlpha = 1;
        }
        if (hovered) {
          drawPart(hovered.hover, hovered.bbox, scaleX, scaleY);
        }
        const offset = animate ? (time / 70) % 12 : 0;
        selected.forEach(function (part) {
          if (part.loops) {
            // crisp: the fill and the marching ants are vectors, drawn at the screen's own density
            drawSelected(part, time);
            return;
          }
          drawPart(part.select, part.bbox, scaleX, scaleY);
          const edge = part.edge;
          if (
            ants.canvas.width !== edge.width ||
            ants.canvas.height !== edge.height
          ) {
            ants.canvas.width = edge.width;
            ants.canvas.height = edge.height;
          }
          ants.context.globalCompositeOperation = "copy";
          ants.context.drawImage(edge, 0, 0);
          ants.context.globalCompositeOperation = "source-in";
          if (ants.pattern.setTransform) {
            ants.pattern.setTransform(new DOMMatrix([1, 0, 0, 1, offset, 0]));
          }
          ants.context.fillStyle = ants.pattern;
          ants.context.fillRect(0, 0, edge.width, edge.height);
          ants.context.globalCompositeOperation = "source-over";
          context.imageSmoothingEnabled = false;
          drawPart(ants.canvas, part.bbox, scaleX, scaleY);
          context.imageSmoothingEnabled = true;
        });
      }
      if (stage.stroke && stage.stroke.preview) {
        context.globalAlpha = 0.55;
        context.drawImage(
          stage.stroke.preview,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        context.globalAlpha = 1;
      }
      if (tool === "pick") {
        if (pickPreview) {
          context.drawImage(pickPreview, 0, 0, canvas.width, canvas.height);
        }
        (props.pickPoints || []).forEach(function (point) {
          context.beginPath();
          context.arc(
            point[0] * canvas.width,
            point[1] * canvas.height,
            7 * ratio,
            0,
            Math.PI * 2,
          );
          context.fillStyle = point[2]
            ? "rgb(120, 220, 150)"
            : "rgb(240, 120, 110)";
          context.fill();
          context.lineWidth = 2 * ratio;
          context.strokeStyle = "#1d1e20";
          context.stroke();
        });
      }
      if (tool === "brush" && cursorPoint && scan) {
        const radius = ((props.brushSize || 24) / scan.width) * canvas.width;
        context.beginPath();
        context.arc(
          cursorPoint[0] * canvas.width,
          cursorPoint[1] * canvas.height,
          radius,
          0,
          Math.PI * 2,
        );
        context.lineWidth = 1.5 * ratio;
        context.strokeStyle =
          props.brushMode === "erase"
            ? "rgb(240, 140, 120)"
            : "rgb(210, 174, 109)";
        context.stroke();
      }
      if (tool === "outline") {
        const points = (props.outlinePoints || []).slice();
        if (cursorPoint && !props.coarse) {
          points.push(cursorPoint);
        }
        if (points.length > 0) {
          context.save();
          context.lineWidth = 2 * ratio;
          context.strokeStyle = "rgb(210, 174, 109)";
          context.fillStyle = "rgba(210, 174, 109, 0.18)";
          context.setLineDash([6 * ratio, 4 * ratio]);
          context.beginPath();
          points.forEach(function (point, index) {
            if (index === 0) {
              context.moveTo(point[0] * canvas.width, point[1] * canvas.height);
            } else {
              context.lineTo(point[0] * canvas.width, point[1] * canvas.height);
            }
          });
          if (points.length > 2) {
            context.closePath();
            context.fill();
          }
          context.stroke();
          context.setLineDash([]);
          (props.outlinePoints || []).forEach(function (point, index) {
            context.beginPath();
            context.arc(
              point[0] * canvas.width,
              point[1] * canvas.height,
              (index === 0 ? 6 : 4) * ratio,
              0,
              Math.PI * 2,
            );
            context.fillStyle = index === 0 ? "rgb(210, 174, 109)" : "#fff";
            context.fill();
          });
          context.restore();
        }
      }
      if (animate) {
        stage.drawFrame = window.requestAnimationFrame(draw);
      } else {
        stage.drawFrame = 0;
      }
    }
    draw(performance.now());
  }

  // Strokes the thin outline of every surface onto `context` (a canvas of width x height) from the
  // vector loops (lib/outlines.js).
  paintEdges(context, sprites, width, height, ratio) {
    const sx = width / sprites.width;
    const sy = height / sprites.height;
    const unit = ratio / ((sx + sy) / 2); // one screen pixel, in scan pixels
    const parts = sprites.order
      .map(function (id) {
        return sprites.regions[id];
      })
      .filter(Boolean);
    context.save();
    context.setTransform(sx, 0, 0, sy, 0, 0);
    context.lineJoin = "round";
    context.lineCap = "round";
    const traced = parts.filter(function (part) {
      return part.loops;
    });
    // every casing first, so one surface's casing never covers its neighbour's line
    context.strokeStyle = "rgba(24, 18, 12, 0.34)";
    context.lineWidth = EDGE_CASING * unit;
    traced.forEach(function (part) {
      context.stroke(pathOf(part));
    });
    context.lineWidth = EDGE_CORE * unit;
    traced.forEach(function (part) {
      context.strokeStyle = "rgb(" + part.color.join(",") + ")";
      context.stroke(pathOf(part));
    });
    // a surface that could not be traced keeps its bitmap edge
    context.setTransform(1, 0, 0, 1, 0, 0);
    parts.forEach(function (part) {
      if (!part.loops) {
        context.drawImage(
          part.edge,
          part.bbox.x0 * sx,
          part.bbox.y0 * sy,
          (part.bbox.x1 - part.bbox.x0) * sx,
          (part.bbox.y1 - part.bbox.y0) * sy,
        );
      }
    });
    context.restore();
  }

  // Draws every surface's outline onto the overlay. Normally that is one drawImage of a bitmap the
  // size of the overlay, painted once per scan and size (so a frame of the marching ants costs
  // almost nothing); a very large overlay, a phone zoomed right in, skips the bitmap (it would
  // cost as much memory again) and strokes the vectors directly.
  drawEdges(context, sprites, width, height, ratio) {
    if (width * height > MAX_EDGE_CACHE_PIXELS) {
      this.edgeCache = null;
      this.paintEdges(context, sprites, width, height, ratio);
      return;
    }
    let cache = this.edgeCache;
    if (
      !cache ||
      cache.sprites !== sprites ||
      cache.width !== width ||
      cache.height !== height ||
      cache.ratio !== ratio
    ) {
      const layer = makeCanvas(width, height);
      this.paintEdges(layer.getContext("2d"), sprites, width, height, ratio);
      cache = {
        sprites: sprites,
        width: width,
        height: height,
        ratio: ratio,
        canvas: layer,
      };
      this.edgeCache = cache;
    }
    context.drawImage(cache.canvas, 0, 0);
  }

  // ------------------------------------------------------------------ the touch magnifier
  // A round 2.5x magnifier above the finger showing the photo at the point under it, a crosshair on that exact pixel, and
  // the outline of the surface that point belongs to (the gold dashes of a selection), so the designer sees what a lift of
  // the finger would pick. Pure drawing: it changes no state and costs one small canvas draw per move.
  showLoupe(clientX, clientY) {
    const frame = this.frameElement;
    const image = frame ? frame.querySelector(".sr-frame-image") : null;
    if (!frame || !image || !image.naturalWidth) {
      return;
    }
    const well = this.element.getBoundingClientRect();
    const radius = LOUPE_SIZE / 2;
    let left = clientX - well.left;
    let top = clientY - well.top - LOUPE_OFFSET;
    if (top - radius < 4) {
      // no room above the finger (the top of the screen): beside it instead, away from the nearer edge
      top = clientY - well.top - 30;
      left += left > well.width / 2 ? -(LOUPE_OFFSET + radius * 0.5) : LOUPE_OFFSET + radius * 0.5;
    }
    left = clamp(left, radius + 4, Math.max(radius + 4, well.width - radius - 4));
    top = clamp(top, radius + 4, Math.max(radius + 4, well.height - radius - 4));
    const element = this.loupeElement;
    element.style.display = "block";
    element.style.transform = "translate(" + (left - radius) + "px, " + (top - radius) + "px)";
    this.loupeShown = true;
    this.drawLoupe(clientX, clientY, image);
  }

  drawLoupe(clientX, clientY, image) {
    const frame = this.frameElement.getBoundingClientRect();
    const canvas = this.loupeCanvas;
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    const pixels = Math.round(LOUPE_SIZE * ratio);
    if (canvas.width !== pixels || canvas.height !== pixels) {
      canvas.width = pixels;
      canvas.height = pixels;
    }
    const context = canvas.getContext("2d");
    const nx = clamp((clientX - frame.left) / frame.width, 0, 1);
    const ny = clamp((clientY - frame.top) / frame.height, 0, 1);
    // the part of the photo that fills the loupe: LOUPE_SIZE / LOUPE_ZOOM screen pixels around the finger
    const span = LOUPE_SIZE / LOUPE_ZOOM;
    const sw = (span / frame.width) * image.naturalWidth;
    const sh = (span / frame.height) * image.naturalHeight;
    const sx = nx * image.naturalWidth - sw / 2;
    const sy = ny * image.naturalHeight - sh / 2;
    context.clearRect(0, 0, pixels, pixels);
    context.fillStyle = "#1c1812";
    context.fillRect(0, 0, pixels, pixels);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, sx, sy, sw, sh, 0, 0, pixels, pixels);
    // the outline of the surface under the crosshair
    const props = this.props;
    const scan = props && props.scan;
    const sprites = props && props.sprites;
    if (scan && sprites) {
      const region = regionAt(scan, nx, ny);
      const part = region ? sprites.regions[region.id] : null;
      const path = part && part.loops ? pathOf(part) : null;
      if (path) {
        const k = pixels / ((sw / image.naturalWidth) * scan.width); // loupe pixels per scan pixel
        context.save();
        context.setTransform(k, 0, 0, k, -(sx / image.naturalWidth) * scan.width * k, -(sy / image.naturalHeight) * scan.height * k);
        context.lineJoin = "round";
        context.fillStyle = "rgba(" + SELECT_RGB.join(",") + ", 0.2)";
        context.fill(path, "evenodd");
        context.lineWidth = (2.6 * ratio) / k;
        context.strokeStyle = "rgba(28, 24, 18, 0.9)";
        context.stroke(path);
        context.lineWidth = (1.3 * ratio) / k;
        context.strokeStyle = "rgb(" + SELECT_RGB.join(",") + ")";
        context.setLineDash([(5 * ratio) / k, (4 * ratio) / k]);
        context.stroke(path);
        context.restore();
      }
    }
    // crosshair on the exact pixel
    const c = pixels / 2;
    const arm = 11 * ratio;
    const gap = 3 * ratio;
    context.lineCap = "round";
    [["rgba(28, 24, 18, 0.9)", 3.2 * ratio], ["rgba(255, 250, 242, 0.98)", 1.4 * ratio]].forEach(function (style) {
      context.strokeStyle = style[0];
      context.lineWidth = style[1];
      context.beginPath();
      context.moveTo(c - arm, c);
      context.lineTo(c - gap, c);
      context.moveTo(c + gap, c);
      context.lineTo(c + arm, c);
      context.moveTo(c, c - arm);
      context.lineTo(c, c - gap);
      context.moveTo(c, c + gap);
      context.lineTo(c, c + arm);
      context.stroke();
    });
  }

  hideLoupe() {
    if (this.loupeShown) {
      this.loupeShown = false;
      this.loupeElement.style.display = "none";
    }
  }

  // ------------------------------------------------------------------ pointer helpers
  pointFromEvent(event) {
    const rect = this.frameElement.getBoundingClientRect();
    return [
      clamp((event.clientX - rect.left) / rect.width, 0, 1),
      clamp((event.clientY - rect.top) / rect.height, 0, 1),
      event.clientX - rect.left,
      event.clientY - rect.top,
    ];
  }

  wellPoint(clientX, clientY) {
    const rect = this.element.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  insideFrame(event) {
    const rect = this.frameElement.getBoundingClientRect();
    return (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    );
  }

  paintStroke(from, to) {
    const stroke = this.stroke;
    const scan = this.props.scan;
    if (!stroke || !scan) {
      return;
    }
    const radius = this.props.brushSize || 24;
    const x0 = from[0] * scan.width;
    const y0 = from[1] * scan.height;
    const x1 = to[0] * scan.width;
    const y1 = to[1] * scan.height;
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(1, radius / 3)),
    );
    const context = stroke.preview.getContext("2d");
    context.fillStyle =
      this.props.brushMode === "erase"
        ? "rgb(240, 120, 110)"
        : "rgb(210, 174, 109)";
    for (let step = 0; step <= steps; step += 1) {
      const centerX = x0 + ((x1 - x0) * step) / steps;
      const centerY = y0 + ((y1 - y0) * step) / steps;
      const left = Math.max(0, Math.floor(centerX - radius));
      const right = Math.min(scan.width - 1, Math.ceil(centerX + radius));
      const top = Math.max(0, Math.floor(centerY - radius));
      const bottom = Math.min(scan.height - 1, Math.ceil(centerY + radius));
      for (let y = top; y <= bottom; y += 1) {
        for (let x = left; x <= right; x += 1) {
          if (
            (x - centerX) * (x - centerX) + (y - centerY) * (y - centerY) <=
            radius * radius
          ) {
            stroke.mask[y * scan.width + x] = 1;
          }
        }
      }
      context.beginPath();
      context.arc(centerX, centerY, radius, 0, Math.PI * 2);
      context.fill();
    }
    this.setState({ strokeTick: this.state.strokeTick + 1 });
  }

  cancelLongPress() {
    const gesture = this.gesture;
    if (gesture && gesture.longPressTimer) {
      clearTimeout(gesture.longPressTimer);
      gesture.longPressTimer = 0;
    }
  }

  cancelLoupe() {
    const gesture = this.gesture;
    if (gesture && gesture.loupeTimer) {
      clearTimeout(gesture.loupeTimer);
      gesture.loupeTimer = 0;
    }
    if (gesture) {
      gesture.loupe = false;
    }
    this.hideLoupe();
  }

  startPinch() {
    this.cancelLoupe();
    this.cancelLongPress();
    if (this.stroke) {
      this.stroke = null;
      this.setState({ strokeTick: this.state.strokeTick + 1 });
    }
    const points = Array.from(this.pointers.values());
    const distance = Math.hypot(
      points[0].x - points[1].x,
      points[0].y - points[1].y,
    );
    const middle = this.wellPoint(
      (points[0].x + points[1].x) / 2,
      (points[0].y + points[1].y) / 2,
    );
    this.gesture = {
      type: "pinch",
      startDistance: Math.max(1, distance),
      startMiddle: middle,
      startView: this.currentView(),
    };
  }

  startPan(clientX, clientY) {
    this.gesture = {
      type: "pan",
      startX: clientX,
      startY: clientY,
      startView: this.currentView(),
    };
  }

  updateHover(event) {
    const props = this.props;
    const scan = props.scan;
    if (props.scanning || !scan || !this.frameElement) {
      return;
    }
    const point = this.pointFromEvent(event);
    const region = this.insideFrame(event)
      ? regionAt(scan, point[0], point[1])
      : null;
    const id = region ? region.id : null;
    if (id !== this.hoverId) {
      this.hoverId = id;
      props.onHover(id);
    }
    if (this.tipElement) {
      const frame = this.frameRect();
      const flipX = point[2] > frame.width - 220;
      const flipY = point[3] > frame.height - 80;
      this.tipElement.style.transform =
        "translate(" +
        (point[2] + (flipX ? -16 : 16)) +
        "px, " +
        (point[3] + (flipY ? -16 : 16)) +
        "px) translate(" +
        (flipX ? "-100%" : "0") +
        ", " +
        (flipY ? "-100%" : "0") +
        ")";
    }
  }

  handleTap(event, point) {
    const props = this.props;
    const tool = props.tool || "select";
    if (props.scanning) {
      return;
    }
    if (tool === "outline") {
      const points = props.outlinePoints || [];
      if (points.length >= 3) {
        const frame = this.frameRect();
        const first = points[0];
        if (
          Math.hypot(
            (first[0] - point[0]) * frame.width,
            (first[1] - point[1]) * frame.height,
          ) < (props.coarse ? 22 : 12)
        ) {
          props.onOutlineFinish();
          return;
        }
      }
      props.onOutlinePoint([point[0], point[1]]);
      return;
    }
    if (tool === "pick") {
      const exclude = event.shiftKey || event.altKey || props.pickExclude;
      props.onPickTap(point[0], point[1], !exclude);
      return;
    }
    if (tool === "brush" && props.selectedIds.length === 1) {
      return;
    }
    const region = regionAt(props.scan, point[0], point[1]);
    props.onSelect(
      region ? region.id : null,
      event.shiftKey || event.ctrlKey || event.metaKey,
      [point[0], point[1]],
    );
  }

  // ------------------------------------------------------------------ pointer events
  onPointerDown(event) {
    const props = this.props;
    if (!props || !this.frameElement || !props.imageWidth) {
      return;
    }
    // Presses on the floating controls belong to them, not to the photo underneath.
    if (
      event.target.closest(
        ".sr-product-card, .sr-zoom, .sr-stage-float, .sr-stage-toolbar, .sr-tool-options, .sr-render-progress, .sr-toasts, input, select, label, button:not(.sr-compare-knob)",
      )
    ) {
      return;
    }
    try {
      this.element.setPointerCapture(event.pointerId);
    } catch (error) {
      // capture can fail for synthetic events
    }
    this.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      type: event.pointerType,
    });
    if (this.pointers.size === 2) {
      this.startPinch();
      return;
    }
    if (this.pointers.size > 2) {
      return;
    }
    const tool = props.tool || "select";
    const scan = props.scan;
    const isMouse = event.pointerType === "mouse";
    if (
      isMouse &&
      (event.button === 1 || (event.button === 0 && this.state.spaceHeld))
    ) {
      event.preventDefault();
      this.startPan(event.clientX, event.clientY);
      return;
    }
    if (isMouse && event.button !== 0) {
      return;
    }
    if (this.comparing() && this.insideFrame(event)) {
      this.gesture = { type: "compare" };
      this.setState({
        divider: Math.round(this.pointFromEvent(event)[0] * 1000) / 10,
      });
      return;
    }
    const point = this.pointFromEvent(event);
    if (
      tool === "brush" &&
      scan &&
      props.selectedIds.length === 1 &&
      this.insideFrame(event)
    ) {
      this.stroke = {
        mask: new Uint8Array(scan.width * scan.height),
        preview: makeCanvas(scan.width, scan.height),
        last: point,
        mode: props.brushMode || "add",
      };
      this.gesture = { type: "brush", startTime: performance.now() };
      this.state.cursorPoint = [point[0], point[1]];
      this.paintStroke(point, point);
      return;
    }
    const gesture = {
      type: "press",
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startTime: performance.now(),
      moved: false,
      longPressed: false,
      longPressTimer: 0,
      loupe: false,
      loupeTimer: 0,
      inside: this.insideFrame(event),
    };
    const stage = this;
    // touch aiming: after LOUPE_HOLD_MS of holding still, the magnifier appears (select, pick and outline tools)
    if (
      !isMouse &&
      gesture.inside &&
      scan &&
      !props.scanning &&
      (tool === "select" || tool === "pick" || tool === "outline")
    ) {
      gesture.loupeTimer = setTimeout(function () {
        gesture.loupeTimer = 0;
        if (stage.gesture !== gesture || gesture.moved) {
          return;
        }
        gesture.loupe = true;
        stage.showLoupe(gesture.lastX, gesture.lastY);
      }, LOUPE_HOLD_MS);
    }
    if (
      !isMouse &&
      tool === "select" &&
      gesture.inside &&
      scan &&
      !props.scanning
    ) {
      gesture.longPressTimer = setTimeout(function () {
        gesture.longPressTimer = 0;
        if (gesture.moved || stage.gesture !== gesture) {
          return;
        }
        const region = regionAt(scan, point[0], point[1]);
        if (region) {
          gesture.longPressed = true;
          stage.cancelLoupe();
          vibrate(12);
          stage.props.onSelect(region.id, true, [point[0], point[1]]);
        }
      }, LONG_PRESS_MS);
    }
    this.gesture = gesture;
  }

  onPointerMove(event) {
    const props = this.props;
    if (!props) {
      return;
    }
    if (this.pointers.has(event.pointerId)) {
      this.pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        type: event.pointerType,
      });
    }
    const gesture = this.gesture;
    if (gesture && gesture.type === "pinch" && this.pointers.size >= 2) {
      const points = Array.from(this.pointers.values());
      const distance = Math.hypot(
        points[0].x - points[1].x,
        points[0].y - points[1].y,
      );
      const middle = this.wellPoint(
        (points[0].x + points[1].x) / 2,
        (points[0].y + points[1].y) / 2,
      );
      const zoomed = this.zoomAt(
        gesture.startView,
        gesture.startView.zoom * (distance / gesture.startDistance),
        gesture.startMiddle.x,
        gesture.startMiddle.y,
      );
      if (zoomed.zoom === 1) {
        this.applyLive({ zoom: 1, x: 0, y: 0 });
      } else {
        this.applyLive(
          this.clampView({
            zoom: zoomed.zoom,
            x: zoomed.x + middle.x - gesture.startMiddle.x,
            y: zoomed.y + middle.y - gesture.startMiddle.y,
          }),
        );
      }
      return;
    }
    if (gesture && gesture.type === "pan") {
      this.applyLive(
        this.clampView({
          zoom: gesture.startView.zoom,
          x: gesture.startView.x + event.clientX - gesture.startX,
          y: gesture.startView.y + event.clientY - gesture.startY,
        }),
      );
      return;
    }
    if (!this.frameElement) {
      return;
    }
    const tool = props.tool || "select";
    if (gesture && gesture.type === "compare") {
      this.setState({
        divider: Math.round(this.pointFromEvent(event)[0] * 1000) / 10,
      });
      return;
    }
    if (gesture && gesture.type === "brush") {
      const point = this.pointFromEvent(event);
      this.state.cursorPoint = [point[0], point[1]];
      this.paintStroke(this.stroke.last, point);
      this.stroke.last = point;
      return;
    }
    if (gesture && gesture.type === "press") {
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      if (gesture.loupe) {
        // aiming: the loupe follows the finger, and nothing else (no pan, no long press) happens
        this.showLoupe(event.clientX, event.clientY);
        return;
      }
      const moved = Math.hypot(
        event.clientX - gesture.startX,
        event.clientY - gesture.startY,
      );
      if (moved > TAP_SLOP) {
        gesture.moved = true;
        this.cancelLongPress();
        if (gesture.loupeTimer) {
          clearTimeout(gesture.loupeTimer);
          gesture.loupeTimer = 0;
        }
        if (
          this.currentView().zoom > 1 &&
          (tool === "select" || tool === "pick" || tool === "outline")
        ) {
          this.cancelLoupe();
          this.startPan(event.clientX, event.clientY);
        } else if (
          event.pointerType !== "mouse" &&
          gesture.inside &&
          this.props.scan &&
          (tool === "select" || tool === "pick" || tool === "outline")
        ) {
          // dragging at fit zoom has nothing else to do on a phone: it aims
          gesture.loupe = true;
          this.showLoupe(event.clientX, event.clientY);
        }
      }
      return;
    }
    // plain hover with a mouse or pen
    if (event.pointerType !== "touch") {
      if (event.target.closest(".sr-product-card")) {
        return;
      }
      if (tool !== "select") {
        if (this.hoverId !== null) {
          this.hoverId = null;
          props.onHover(null);
        }
        const point = this.pointFromEvent(event);
        this.setState({
          cursorPoint: this.insideFrame(event) ? [point[0], point[1]] : null,
        });
        return;
      }
      this.updateHover(event);
    }
  }

  onPointerUp(event) {
    const props = this.props;
    this.pointers.delete(event.pointerId);
    const gesture = this.gesture;
    if (!gesture || !props) {
      return;
    }
    if (gesture.type === "pinch") {
      if (this.pointers.size < 2) {
        const liveView = this.liveView;
        this.commitLive();
        const remaining = Array.from(this.pointers.values());
        this.gesture = null;
        if (remaining.length === 1) {
          this.startPan(remaining[0].x, remaining[0].y);
          this.gesture.startView = liveView || this.currentView();
        }
      }
      return;
    }
    if (this.pointers.size > 0) {
      return;
    }
    this.gesture = null;
    const tool = props.tool || "select";
    if (gesture.type === "pan") {
      this.commitLive();
      return;
    }
    if (gesture.type === "compare") {
      return;
    }
    if (gesture.type === "brush") {
      const stroke = this.stroke;
      this.stroke = null;
      if (event.pointerType === "touch") {
        this.state.cursorPoint = null;
      }
      this.setState({ strokeTick: this.state.strokeTick + 1 });
      if (stroke && event.type !== "pointercancel") {
        props.onBrushStroke(stroke.mask, stroke.mode);
      }
      return;
    }
    if (gesture.type === "press") {
      this.cancelLongPress();
      const aimed = gesture.loupe;
      if (gesture.loupeTimer) {
        clearTimeout(gesture.loupeTimer);
        gesture.loupeTimer = 0;
      }
      this.hideLoupe();
      if (aimed && event.type !== "pointercancel" && !gesture.longPressed && this.insideFrame(event)) {
        // lifting the finger after aiming picks what the crosshair was on
        this.handleTap(event, this.pointFromEvent(event));
        return;
      }
      if (
        event.type === "pointercancel" ||
        gesture.moved ||
        gesture.longPressed
      ) {
        return;
      }
      if (performance.now() - gesture.startTime > 700) {
        return;
      }
      if (!gesture.inside) {
        if (tool === "select") {
          props.onSelect(null, false);
        }
        return;
      }
      const point = this.pointFromEvent(event);
      // double-tap to zoom (touch, select tool)
      if (event.pointerType === "touch" && tool === "select") {
        const last = this.lastTap;
        const now = performance.now();
        if (
          last &&
          now - last.time < 320 &&
          Math.hypot(event.clientX - last.x, event.clientY - last.y) < 30
        ) {
          this.lastTap = null;
          const position = this.wellPoint(event.clientX, event.clientY);
          const base = this.currentView();
          this.setView(
            base.zoom > 1.2
              ? { zoom: 1, x: 0, y: 0 }
              : this.zoomAt(base, 2.5, position.x, position.y),
          );
          return;
        }
        this.lastTap = { time: now, x: event.clientX, y: event.clientY };
      }
      this.handleTap(event, point);
    }
  }

  onPointerLeave(event) {
    if (event.pointerType !== "touch" && !this.gesture && this.props) {
      this.hoverId = null;
      this.props.onHover(null);
      if (this.state.cursorPoint) {
        this.setState({ cursorPoint: null });
      }
    }
  }

  onDoubleClick(event) {
    if (event.target.closest(".sr-tool-options, .sr-stage-toolbar, button")) {
      return;
    }
    if (this.props && this.props.tool === "outline") {
      this.props.onOutlineFinish();
    }
  }

  onDividerKey(event) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      this.setState({ divider: Math.max(0, this.state.divider - 5) });
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      this.setState({ divider: Math.min(100, this.state.divider + 5) });
    }
  }

  // ------------------------------------------------------------------ product card (mouse)
  updateCard(hoverProduct) {
    const id = hoverProduct ? hoverProduct.id : null;
    if (id === this.lastHoverProductId) {
      return;
    }
    this.lastHoverProductId = id;
    clearTimeout(this.cardTimer);
    const stage = this;
    if (hoverProduct) {
      this.state.cardProductId = hoverProduct.id;
    } else {
      this.cardTimer = setTimeout(function () {
        if (!stage.cardHold) {
          stage.setState({ cardProductId: null });
        }
      }, 260);
    }
  }

  // ------------------------------------------------------------------ render
  render() {
    const props = this.props;
    const stage = this;
    const state = this.state;
    const scan = props.scan;
    const tool = props.tool || "select";
    const comparing = this.comparing();
    const peeking = this.peeking();
    const committed = this.committed();
    const frame = this.rectFor(committed);
    const productsByRegion = props.productsByRegion || {};
    const hoverProduct =
      !props.coarse &&
      props.hoverId &&
      tool === "select" &&
      !comparing &&
      !peeking &&
      !props.scanning
        ? productsByRegion[props.hoverId] || null
        : null;
    this.updateCard(hoverProduct);
    let card = null;
    Object.keys(productsByRegion).forEach(function (regionId) {
      if (productsByRegion[regionId].id === state.cardProductId) {
        card = { product: productsByRegion[regionId], regionId: regionId };
      }
    });
    const cardRegion =
      card && scan
        ? scan.regions.find(function (region) {
            return (
              region.id ===
              (props.hoverId && productsByRegion[props.hoverId] === card.product
                ? props.hoverId
                : card.regionId)
            );
          })
        : null;
    let cardStyle = null;
    if (card && cardRegion && frame.width > 0) {
      const anchorX = (cardRegion.anchor.x / scan.width) * frame.width;
      const anchorY = (cardRegion.anchor.y / scan.height) * frame.height;
      cardStyle = {
        left: clamp(
          anchorX - CARD_WIDTH / 2,
          8,
          Math.max(8, frame.width - CARD_WIDTH - 8),
        ),
        top: clamp(anchorY - 70, 8, Math.max(8, frame.height - 200)),
        width: CARD_WIDTH,
      };
    }
    const hoverRegion =
      scan && props.hoverId
        ? scan.regions.find(function (region) {
            return region.id === props.hoverId;
          })
        : null;
    const showTip =
      !props.coarse &&
      hoverRegion &&
      tool === "select" &&
      !comparing &&
      !peeking &&
      !props.scanning &&
      !hoverProduct &&
      !card;

    let cursor = "default";
    if (state.spaceHeld || (this.gesture && this.gesture.type === "pan")) {
      cursor = "grab";
    } else if (tool === "outline" || tool === "pick") {
      cursor = "crosshair";
    } else if (tool === "brush") {
      cursor = "none";
    } else if (comparing) {
      cursor = "ew-resize";
    } else if (hoverRegion) {
      cursor = "pointer";
    } else if (committed.zoom > 1) {
      cursor = "grab";
    }

    this.element.className = cx(
      "sr-well",
      props.layout === "narrow" && "is-narrow",
    );

    const frameChildren = [
      h("img", {
        key: "image",
        class: "sr-frame-image",
        src: props.imageUrl,
        alt: "",
        draggable: "false",
      }),
    ];
    if (comparing) {
      frameChildren.push(
        h("img", {
          key: "compare-image",
          class: "sr-frame-image",
          src: props.compareUrl,
          alt: "",
          draggable: "false",
          style: { clipPath: "inset(0 " + (100 - state.divider) + "% 0 0)" },
        }),
        h(
          "div",
          {
            key: "divider",
            class: "sr-compare-divider",
            style: { left: state.divider + "%" },
          },
          h("button", {
            type: "button",
            class: "sr-compare-knob",
            role: "slider",
            "aria-label": "Before and after divider",
            "aria-valuemin": "0",
            "aria-valuemax": "100",
            "aria-valuenow": String(Math.round(state.divider)),
            onkeydown: function (event) {
              stage.onDividerKey(event);
            },
          }),
        ),
        h(
          "span",
          { key: "tag-left", class: "sr-compare-tag sr-compare-tag-left" },
          props.compareLabel || "Before",
        ),
        h(
          "span",
          { key: "tag-right", class: "sr-compare-tag sr-compare-tag-right" },
          "After",
        ),
      );
    }
    if (peeking) {
      frameChildren.push(
        h("img", {
          key: "peek-image",
          class: "sr-frame-image",
          src: props.compareUrl,
          alt: "",
          draggable: "false",
        }),
        h(
          "span",
          { key: "tag-left", class: "sr-compare-tag sr-compare-tag-left" },
          props.compareLabel || "Before",
        ),
      );
    }
    frameChildren.push(
      // Below the selection/sprite overlay (painted after it, see below) so a hover/selection
      // highlight always stays visible on top of an instant material preview.
      h("canvas", {
        key: "fastrender",
        class: "sr-frame-overlay sr-frame-fast",
        "aria-hidden": "true",
        ref: function (element) {
          stage.fastCanvasElement = element;
        },
      }),
      h("canvas", {
        key: "overlay",
        class: "sr-frame-overlay",
        "aria-hidden": "true",
        ref: function (element) {
          stage.canvasElement = element;
        },
      }),
    );
    if (props.showMap && scan && !comparing && !peeking && !props.scanning) {
      frameChildren.push(
        h(
          "div",
          { key: "map-labels", class: "sr-map-labels", "aria-hidden": "true" },
          scan.regions.map(function (region) {
            return h(
              "span",
              {
                key: region.id,
                class: "sr-map-label",
                style: {
                  left: (region.anchor.x / scan.width) * 100 + "%",
                  top: (region.anchor.y / scan.height) * 100 + "%",
                },
              },
              h("span", {
                class: "sr-dot",
                style: { background: "rgb(" + region.color.join(",") + ")" },
              }),
              region.label,
            );
          }),
        ),
      );
    }
    if (props.scanning) {
      frameChildren.push(
        h(
          "div",
          { key: "veil", class: "sr-scan-veil", "aria-live": "polite" },
          h("div", { class: "sr-scan-sweep" }),
          h(
            "div",
            { class: "sr-scan-label" },
            props.scanStage || "Mapping surfaces",
          ),
        ),
      );
    }
    frameChildren.push(
      h(
        "div",
        {
          key: "tip",
          class: cx("sr-hover-tip", showTip && "is-visible"),
          "aria-hidden": "true",
          ref: function (element) {
            stage.tipElement = element;
          },
        },
        hoverRegion
          ? [
              h("span", {
                class: "sr-dot",
                style: {
                  background: "rgb(" + hoverRegion.color.join(",") + ")",
                },
              }),
              h(
                "span",
                { class: "sr-hover-tip-text" },
                h("strong", null, hoverRegion.label),
                h(
                  "span",
                  null,
                  KIND_INFO[hoverRegion.kind].singular +
                    ", " +
                    (hoverRegion.areaShare * 100).toFixed(
                      hoverRegion.areaShare < 0.1 ? 1 : 0,
                    ) +
                    "% of frame",
                ),
              ),
            ]
          : null,
      ),
    );
    if (card && cardStyle) {
      const product = card.product;
      frameChildren.push(
        h(
          "div",
          {
            key: "card",
            class: "sr-product-card",
            style: cardStyle,
            onmouseenter: function () {
              stage.cardHold = true;
              clearTimeout(stage.cardTimer);
            },
            onmouseleave: function () {
              stage.cardHold = false;
              stage.cardTimer = setTimeout(function () {
                stage.setState({ cardProductId: null });
              }, 200);
            },
          },
          h(
            "div",
            { class: "sr-product-card-head" },
            product.item
              ? h("span", {
                  class: "sr-product-card-swatch",
                  html: swatchMarkup(
                    product.item.swatch,
                    product.item.id,
                    "card",
                  ),
                })
              : h(
                  "span",
                  { class: "sr-product-card-swatch" },
                  h("span", { class: "sr-custom-chip" }),
                ),
            h(
              "span",
              { class: "sr-product-card-titles" },
              h(
                "span",
                { class: "sr-product-card-category" },
                props.productCategory(product),
              ),
              h(
                "strong",
                { class: "sr-product-card-name" },
                product.item ? product.item.name : "Custom edit",
              ),
            ),
          ),
          h(
            "p",
            { class: "sr-product-card-about" },
            product.item ? product.item.about : product.notes,
          ),
          h(
            "p",
            { class: "sr-product-card-qty" },
            h("span", null, "Quantity"),
            props.productHeadline(product),
          ),
          h(
            "button",
            {
              type: "button",
              class: "sr-product-card-more",
              onclick: function () {
                props.onOpenProduct(product.id);
              },
            },
            "View details ",
            icon("chevron-right", 14),
          ),
        ),
      );
    }

    const children = [
      h(
        "div",
        {
          key: "frame",
          class: cx("sr-frame", props.scanning && "is-scanning"),
          style: {
            width: frame.width,
            height: frame.height,
            left: frame.left,
            top: frame.top,
            cursor: cursor,
          },
          role: "img",
          "aria-label":
            props.versionLabel + ". Surfaces can also be chosen from the list.",
          ref: function (element) {
            stage.frameElement = element;
          },
        },
        frameChildren,
      ),
    ];
    if (!props.coarse) {
      children.push(
        h(
          "div",
          {
            key: "zoom",
            class: "sr-zoom",
            role: "group",
            "aria-label": "Zoom",
          },
          h(
            "button",
            {
              type: "button",
              class: "sr-icon-button sr-icon-button-small",
              "aria-label": "Zoom out (-)",
              disabled: committed.zoom <= 1,
              onclick: function () {
                stage.zoomBy(0.8);
              },
            },
            icon("minus", 14),
          ),
          h(
            "button",
            {
              type: "button",
              class: "sr-zoom-value",
              title: "Fit to screen (0)",
              onclick: function () {
                stage.fitView();
              },
            },
            committed.zoom === 1
              ? "Fit"
              : Math.round(committed.zoom * 100) + "%",
          ),
          h(
            "button",
            {
              type: "button",
              class: "sr-icon-button sr-icon-button-small",
              "aria-label": "Zoom in (+)",
              disabled: committed.zoom >= MAX_ZOOM,
              onclick: function () {
                stage.zoomBy(1.25);
              },
            },
            icon("plus", 14),
          ),
        ),
      );
    }
    if (props.coarse && committed.zoom > 1) {
      children.push(
        h(
          "button",
          {
            key: "fit",
            type: "button",
            class: "sr-stage-float sr-fit-chip",
            onclick: function () {
              stage.fitView();
            },
          },
          icon("maximize", 14),
          " Fit",
        ),
      );
    }
    children.push(
      h("div", { key: "slot", class: "sr-stage-slot" }, props.children),
    );
    children.push(this.loupeElement);
    update(this.element, children);
    // The update rewrote the frame's style; keep a gesture's transform while it runs.
    if (this.liveView) {
      this.applyLive(this.liveView);
    }
    this.maybeDraw();
    this.maybeFastRender();
  }
}
