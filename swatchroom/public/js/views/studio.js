// The studio: one room photo, its versions, its surface map, the catalogue and the renders.
// Layouts: wide (surfaces | photo | finishes), medium (photo | panel), narrow (photo + sheet).
//
// How it works, in one picture: `state` is the single notebook everything is written in.
// Actions change the notebook with set(); after each change the studio redraws from the
// notebook (on the next animation frame), and update() corrects only what differs on the page.

import { cx, h, isTyping, update } from "../core/dom.js";
import { icon } from "../core/icons.js";
import {
  postJson,
  getJson,
  getBlob,
  unpackBytes,
  unpackFloat32,
  unpackGzip,
  unpackUnit16,
} from "../core/api.js";
import { logModel, publicText } from "../core/modelLog.js";
import { Stage } from "./stage.js";
import { surfacesView } from "./surfaces.js";
import { finishGroups, finishHeader, finishesView, renderButton } from "./finishes.js";
import { revealCurrentVersion, versionsStrip } from "./versions.js";
import { emptyStage } from "./empty.js";
import {
  peekButton,
  renderProgress,
  stageToolbar,
  toolOptions,
} from "./stage-controls.js";
import {
  inspectorDialog,
  materialsDialog,
  productDialog,
  settingsDialog,
  shareDialog,
  shortcutsDialog,
  versionsDialog,
} from "./dialogs.js";
import {
  BottomSheet,
  isCoarsePointer,
  measureLayout,
  menu,
  modal,
  toasts,
} from "./ui.js";
import { findItem, findItemKind } from "../data/catalog.js";
import { detectSurfaces } from "../lib/detect.js";
import { prepareRender, releasePrepared, renderOption } from "../lib/render.js";
import { canUseFastRender, engineForcesGeminiOnly } from "../lib/fastrender/tiers.js";
import { lumaFromRgba } from "../lib/fastrender/geometry.js";
import { buildProvisionalScene } from "../lib/fastrender/provisional.js";
import { createSceneComposer } from "../lib/previewScene.js";
import { parseSamLayer, instancesOfKind } from "../lib/samLayer.js";
import {
  SNAP_CONFIDENCE,
  buildSamPrompts,
  fuseRegionWithSam,
  pickSamInstance,
} from "../lib/samCalibrate.js";
import { applyPlaneSplits, decodeSplits } from "../lib/planeSplit.js";
import { surfaceGeometry } from "../lib/geometryFacts.js";
import { releaseCanvas } from "../lib/platform.js";
import { measureSurface } from "../lib/measure.js";
import { buildSprites } from "../lib/sprites.js";
import { forgetResolvedModels } from "../lib/ai.js";
import {
  KIND_INFO,
  addRegionFromMask,
  addRegionFromOutline,
  deserialiseScan,
  emptyScan,
  paintRegion,
  reattachProducts,
  serialiseScan,
  setRegionKind,
  unionRegion,
} from "../lib/regions.js";
import { canAutoApply, remapSelection } from "../lib/hdSwap.js";
import {
  canvasAtMost,
  canvasToBase64,
  canvasToBlob,
  drawToCanvas,
  fitInside,
  loadImage,
  loadImageFile,
  maskCanvas,
  naturalSize,
  resizeMask,
  slugify,
} from "../lib/images.js";
import { recordScan } from "../lib/ownerTimings.js";
import { maskForTaps, preparePick, warmUpModels } from "../lib/vision.js";
import {
  materialsCsv,
  productHeadline,
  productName,
  productSpec,
} from "../lib/products.js";
import {
  beforeAfterImage,
  canShareFiles,
  designBoard,
  shareOrDownload,
} from "../lib/share.js";
import {
  deleteRoom,
  fileUrl,
  getFileBytes,
  listRooms,
  loadRoom,
  loadScan,
  newRoomId,
  putFile,
  saveRoom,
  saveScan,
} from "../lib/storage.js";

const PICK_IDLE = {
  status: "idle",
  message: "",
  points: [],
  preview: null,
  busy: false,
  key: "",
  engine: "service",
  engineLabel: "",
};
const RECENT_KEY = "swatchroom.recentFinishes.v1";
const COLOURS_KEY = "swatchroom.customColours.v1";
const ORIGINAL_MAX_SIDE = 4096;
// On a phone the original is capped lower and saved a little lighter: it goes up over mobile
// data, and a 12 MP photo is already more than the renders (2K) and the room pipeline (1280) use.
const PHONE_ORIGINAL_MAX_SIDE = 3072;
// The original waits this long after the scan starts before it is uploaded, so the scan's own
// (small) requests have the connection to themselves; it goes sooner if the scan ends first.
const ORIGINAL_UPLOAD_DELAY_MS = 2500;
// When the model service cannot read a photo for the local SAM (down, restarting, out of memory), the next taps do not each
// send it the whole photo again for this long: the scan's own outline is kept meanwhile.
const LOCAL_SAM_COOLDOWN_MS = 30000;
// Matches server/routes/pipeline.js's own ROOM_ID - a room with no id yet (not saved) simply
// never gets a pipeline run, rather than firing a request the server would just 400.
const ROOM_ID_RE = /^room-[a-z0-9-]{4,48}$/;
const ROOM_FIELDS = [
  "roomId",
  "photo",
  "versions",
  "currentId",
  "products",
  "notes",
  "style",
  "optionCount",
  "scanState",
];

function readList(key) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function writeList(key, list) {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch (error) {
    // storage is optional
  }
}

function displayUrl(version) {
  if (!version) {
    return "";
  }
  if (version.view === "raw") {
    return version.rawUrl;
  }
  return version.blendUrl || version.rawUrl;
}

function roomName(fileName) {
  const base = String(fileName || "Room")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return base.length > 0
    ? base.charAt(0).toUpperCase() + base.slice(1)
    : "Room";
}

function versionLabel(version) {
  if (!version) {
    return "";
  }
  return version.isOriginal
    ? "Original"
    : "v" + version.number + " " + version.title;
}

function idleScanState() {
  return { status: "idle", stage: "", error: "", engine: "", model: "" };
}

// A promise whose resolve is kept, to let something wait for an event that happens elsewhere.
function deferred() {
  const gate = {};
  gate.promise = new Promise(function (resolve) {
    gate.resolve = resolve;
  });
  return gate;
}

export class Studio {
  // root: the element the studio draws into. app: { settings, session, setSettings, signOut }
  constructor(root, app) {
    const studio = this;
    this.root = root;
    this.app = app;
    this.stage = new Stage();
    this.sheet = new BottomSheet();
    this.blobs = {};
    this.urls = [];
    this.counter = { version: 0, custom: 0 };
    this.undoStack = [];
    this.redoStack = [];
    this.scanController = null;
    this.pickCanvas = null;
    this.renderQueued = false;
    this.saveRoomTimer = 0;
    this.saveScanTimer = 0;
    this.saveWarned = false;
    this.progressTimer = 0;
    this.lastReveal = "";
    this.lastFinishKey = "";
    this.selectionCache = { scan: null, key: "", region: null };
    this.spritesCache = { scan: null, sprites: null };
    this.shareFiles = canShareFiles();
    this.destroyed = false;
    // The "understand this photo" pipeline (SAM 3 + MoGe-2 + Marigold-IID, server/lib/
    // pipelineRunner.js): which room+version the current result (if any) belongs to, and the
    // scene payload the fast renderer needs (see ensureFusion()/stage.js's maybeFastRender()).
    this.fusionPoll = 0;
    this.fusionRoomId = "";
    this.fusionRun = 0;
    this.fusionVersionId = "";
    this.fastScenePayload = null;
    // What the start-up gate learned: true = Modal's vision engine was warm, false = cold / unreachable / no answer in
    // 10 s, null = not asked. The scan races its engines differently for each (lib/segmentRace.js); it is updated
    // from real results (a OneFormer answer inside the window makes it true, a failure false).
    this.modalIsWarm = app.modalIsWarm === undefined ? null : app.modalIsWarm;
    // the photo's brightness at scan size (edges, exposure, the provisional light) and what is derived from it
    this.photoLightCache = null; // { key, value: {luma, linear} | null }
    this.sceneComposer = createSceneComposer(buildProvisionalScene);
    // SAM 3's stored instance masks for the current photo version, and the surfaces already checked against them
    this.samLayer = null;
    this.samLayerKey = "";
    this.calibrated = new WeakMap(); // scan -> Set of region ids already calibrated
    this.calibrating = new Map(); // region id -> Promise, so a render can wait for the mask it will send
    this.sharpRegions = new Set(); // region ids whose edge was snapped to SAM's (the render then grows the mask less)
    this.calibrationEmbeds = new Map(); // Pick key -> Promise: the local SAM has read this photo
    this.localSamDownUntil = 0; // after a failed read of a photo, no local SAM until this time (LOCAL_SAM_COOLDOWN_MS)
    this.calibrationCanvas = null;
    this.prefetchMemo = { key: "", urls: [] };
    this.fusionLoads = 0;
    this.scanRun = 0; // which runScan() an arriving HD scan belongs to
    this.pendingHd = null; // an HD scan that arrived before the quick one was shown
    this.lastTap = null; // {x, y} (0..1) of the last surface tap, to keep the designer's place across an HD swap

    this.state = {
      layout: { mode: "wide", width: 1200, height: 800 },
      coarse: isCoarsePointer(),
      // room
      roomId: null,
      roomCreatedAt: 0,
      photo: null,
      versions: [],
      currentId: null,
      // surfaces
      scan: null,
      scanState: idleScanState(),
      historyTick: 0,
      // the higher-accuracy scan that arrived after the designer started working on the quick one, waiting for a tap
      hdScan: null,
      // selection and catalogue
      hoverId: null,
      selectedIds: [],
      itemId: null,
      kindOverride: null,
      notes: {},
      style: "",
      optionCount: 1,
      customColors: readList(COLOURS_KEY),
      recentIds: readList(RECENT_KEY),
      // tools
      tool: "select",
      brushMode: "add",
      brushSize: 22,
      outlinePoints: [],
      pick: PICK_IDLE,
      pickExclude: false,
      // view
      showMap: false,
      compare: false,
      peek: false,
      sheetExpanded: false,
      immersive: false,
      // renders and products
      render: null,
      products: {},
      // dialogs and messages
      dialog: null,
      productId: null,
      inspectId: null,
      shareBusy: "",
      toasts: [],
      errorLog: [],
      dragOver: false,
      rooms: [],
      roomsState: "loading",
      roomsError: "",
      openingRoomId: null,
    };
    // Small view state that only the views read (which tab, what is typed in a search box...).
    this.ui = {
      menuOpen: "",
      finishQuery: "",
      finishTab: "All",
      showSmall: false,
      emptyDragging: false,
      settings: {},
      inspector: {},
      product: {},
      // {status: "checking"|"running"|"ready"|"error", progress, error} | null - see
      // ensureFusion(). Shown in Settings > Render so the pipeline's state is never invisible.
      fusion: null,
    };

    this.fileInput = h("input", {
      type: "file",
      accept: "image/*,.heic,.heif",
      class: "sr-visually-hidden",
      "data-input": "photo",
      onchange: function (event) {
        studio.addPhoto(event.target.files && event.target.files[0]);
        event.target.value = "";
      },
    });
    this.cameraInput = h("input", {
      type: "file",
      accept: "image/*",
      capture: "environment",
      class: "sr-visually-hidden",
      "data-input": "camera",
      onchange: function (event) {
        studio.addPhoto(event.target.files && event.target.files[0]);
        event.target.value = "";
      },
    });
    this.fileInput._live = true;
    this.cameraInput._live = true;

    this.onKeyDown = function (event) {
      studio.keyDown(event);
    };
    this.onDocumentPointer = function (event) {
      if (studio.ui.menuOpen && !event.target.closest("[data-menu]")) {
        studio.ui.menuOpen = "";
        studio.requestRender();
      }
    };
    this.onDocumentKey = function (event) {
      if (event.key === "Escape" && studio.ui.menuOpen) {
        studio.ui.menuOpen = "";
        studio.requestRender();
      }
    };
    window.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("pointerdown", this.onDocumentPointer, true);
    document.addEventListener("keydown", this.onDocumentKey);
    this.resizeObserver = new ResizeObserver(function () {
      studio.measure();
    });
    this.resizeObserver.observe(root);
    try {
      this.coarseQuery = window.matchMedia("(pointer: coarse)");
      this.onCoarseChange = function () {
        studio.set({ coarse: studio.coarseQuery.matches });
      };
      this.coarseQuery.addEventListener("change", this.onCoarseChange);
    } catch (error) {
      this.coarseQuery = null;
    }

    this.measure();
    this.render();
    this.scrollIntoView();
    this.refreshRooms();
    this.warmupTimer = setTimeout(function () {
      const settings = studio.app.settings;
      if (settings.segmentationEngine === "scene") {
        warmUpModels(settings.sceneModel);
      }
    }, 1200);
    if (
      this.app.session &&
      this.app.session.google &&
      !this.app.session.google.configured
    ) {
      console.warn(
        "[swatchroom] AI is off on the server:",
        this.app.session.google.problem || "no Google credentials configured",
      );
      this.toast("AI rendering is not set up on the server yet.", "info");
    }
  }

  destroy() {
    this.destroyed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("pointerdown", this.onDocumentPointer, true);
    document.removeEventListener("keydown", this.onDocumentKey);
    this.resizeObserver.disconnect();
    if (this.coarseQuery) {
      this.coarseQuery.removeEventListener("change", this.onCoarseChange);
    }
    clearTimeout(this.warmupTimer);
    clearInterval(this.progressTimer);
    this.stage.destroy();
    this.urls.forEach(function (url) {
      URL.revokeObjectURL(url);
    });
    this.applyImmersive(false);
  }

  // ------------------------------------------------------------------ state
  get settings() {
    return this.app.settings;
  }

  set(patch) {
    if (this.destroyed) {
      return;
    }
    const studio = this;
    Object.assign(this.state, patch);
    const keys = Object.keys(patch);
    if (
      keys.some(function (key) {
        return ROOM_FIELDS.indexOf(key) !== -1;
      })
    ) {
      this.scheduleRoomSave();
    }
    if (keys.indexOf("scan") !== -1) {
      this.scheduleScanSave();
    }
    if (keys.indexOf("immersive") !== -1) {
      this.applyImmersive(this.state.immersive);
    }
    if (keys.indexOf("render") !== -1) {
      clearInterval(this.progressTimer);
      if (this.state.render) {
        this.progressTimer = setInterval(function () {
          studio.requestRender();
        }, 500);
      }
    }
    this.requestRender();
  }

  setUi(patch) {
    Object.assign(this.ui, patch);
    this.requestRender();
  }

  requestRender() {
    if (this.renderQueued || this.destroyed) {
      return;
    }
    this.renderQueued = true;
    const studio = this;
    window.requestAnimationFrame(function () {
      studio.renderQueued = false;
      if (!studio.destroyed) {
        studio.render();
      }
    });
  }

  measure() {
    const next = measureLayout(this.root);
    const current = this.state.layout;
    if (
      current.mode !== next.mode ||
      Math.abs(current.width - next.width) >= 1 ||
      Math.abs(current.height - next.height) >= 1
    ) {
      this.set({ layout: next });
    }
  }

  // Bring the studio into view when it opens (the page may have been scrolled).
  scrollIntoView() {
    const host = this.root.closest("swatchroom-app");
    if (!host) {
      return;
    }
    const top = host.getBoundingClientRect().top + window.scrollY;
    const offset =
      parseFloat(getComputedStyle(host).getPropertyValue("--swr-top")) || 0;
    if (Math.abs(window.scrollY - (top - offset)) > 4) {
      window.scrollTo({ top: Math.max(0, top - offset), behavior: "auto" });
    }
  }

  // full-screen studio on phones: stop the page behind from scrolling
  applyImmersive(on) {
    const host = this.root.closest("swatchroom-app");
    if (host) {
      host.classList.toggle("is-immersive", on);
    }
    document.documentElement.classList.toggle("swr-immersive", on);
  }

  narrow() {
    return this.state.layout.mode === "narrow";
  }

  wantsFullScreen() {
    return this.narrow() || (this.state.coarse && window.innerHeight <= 520);
  }

  // ------------------------------------------------------------------ derived values
  version() {
    const state = this.state;
    return (
      state.versions.find(function (entry) {
        return entry.id === state.currentId;
      }) || null
    );
  }

  parentOf(version) {
    const state = this.state;
    return version && version.parentId
      ? state.versions.find(function (entry) {
          return entry.id === version.parentId;
        }) || null
      : null;
  }

  validIds() {
    const scan = this.state.scan;
    if (!scan) {
      return [];
    }
    return this.state.selectedIds.filter(function (id) {
      return scan.regions.some(function (region) {
        return region.id === id;
      });
    });
  }

  selectionKey() {
    return this.validIds().slice().sort().join("+");
  }

  selectedRegion() {
    const scan = this.state.scan;
    const key = this.selectionKey();
    if (this.selectionCache.scan === scan && this.selectionCache.key === key) {
      return this.selectionCache.region;
    }
    const region = scan && key ? unionRegion(scan, this.validIds()) : null;
    this.selectionCache = { scan: scan, key: key, region: region };
    return region;
  }

  sprites() {
    const scan = this.state.scan;
    if (this.spritesCache.scan !== scan) {
      this.spritesCache = {
        scan: scan,
        sprites: scan && scan.regions.length > 0 ? buildSprites(scan) : null,
      };
    }
    return this.spritesCache.sprites;
  }

  catalogKind() {
    const region = this.selectedRegion();
    return this.state.kindOverride || (region ? region.kind : "wall");
  }

  currentNotes() {
    return this.state.notes[this.selectionKey()] || "";
  }

  versionProducts(version) {
    const products = this.state.products;
    return version
      ? (version.productIds || [])
          .map(function (id) {
            return products[id];
          })
          .filter(Boolean)
      : [];
  }

  // The real model id is in the console (modelLog.js); the page only ever says "AI".
  modelName() {
    return "AI";
  }

  // ------------------------------------------------------------------ messages
  toast(message, tone, action) {
    const studio = this;
    const id = Date.now() + Math.random();
    const list = this.state.toasts
      .filter(function (entry) {
        return entry.message !== message;
      })
      .concat([
        { id: id, message: message, tone: tone || "error", action: action },
      ])
      .slice(-3);
    this.set({ toasts: list });
    if (tone === "info" || tone === "success") {
      setTimeout(function () {
        studio.dismissToast(id);
      }, 7000);
    }
  }

  dismissToast(id) {
    this.set({
      toasts: this.state.toasts.filter(function (entry) {
        return entry.id !== id;
      }),
    });
  }

  logError(context, error) {
    this.set({
      errorLog: this.state.errorLog
        .concat([
          {
            time: new Date().toLocaleTimeString(),
            context: context,
            message: error && error.message ? error.message : String(error),
            status:
              error && (error.status || error.httpStatus)
                ? error.status || error.httpStatus
                : 0,
            model: error && error.model ? error.model : "",
            apiMessage: error && error.apiMessage ? error.apiMessage : "",
          },
        ])
        .slice(-40),
    });
  }

  fail(context, error) {
    this.logError(context, error);
    this.toast(error && error.message ? error.message : String(error));
  }

  savingFailed(error) {
    this.logError("Saving", error);
    if (!this.saveWarned) {
      this.saveWarned = true;
      this.toast(
        "This room is not being saved: " +
          (error && error.message ? error.message : error),
      );
    }
  }

  track(url) {
    this.urls.push(url);
    return url;
  }

  // ------------------------------------------------------------------ saved rooms
  async refreshRooms() {
    try {
      const rooms = await listRooms();
      this.set({ rooms: rooms, roomsState: "ready", roomsError: "" });
    } catch (error) {
      this.set({ rooms: [], roomsState: "error", roomsError: error.message });
    }
  }

  // source: a blob URL, or a canvas/image that is already decoded (no second decode of a big photo).
  async makeThumb(source) {
    const image = typeof source === "string" ? await loadImage(source) : source;
    return canvasToBlob(canvasAtMost(image, 360), "image/jpeg", 0.8);
  }

  storeFile(name, value) {
    const roomId = this.state.roomId;
    if (!roomId) {
      return;
    }
    const studio = this;
    putFile(roomId + "/" + name, value).catch(function (error) {
      studio.savingFailed(error);
    });
  }

  // The room record is saved shortly after changes stop (like autosave in a text editor).
  scheduleRoomSave() {
    const studio = this;
    clearTimeout(this.saveRoomTimer);
    this.saveRoomTimer = setTimeout(function () {
      studio.saveRoomNow();
    }, 700);
  }

  saveRoomNow() {
    const state = this.state;
    if (!state.roomId || !state.photo || state.versions.length === 0) {
      return;
    }
    const savedProducts = {};
    Object.keys(state.products).forEach(function (key) {
      const product = state.products[key];
      const copy = Object.assign({}, product);
      delete copy.regionMask;
      delete copy.item;
      copy.itemId = product.item ? product.item.id : null;
      if (copy.status === "estimating") {
        copy.status = "failed";
        copy.error = "interrupted";
      }
      savedProducts[key] = copy;
    });
    const studio = this;
    saveRoom({
      id: state.roomId,
      name: roomName(state.photo.name),
      createdAt: state.roomCreatedAt || Date.now(),
      photo: state.photo,
      versions: state.versions.map(function (entry) {
        const copy = Object.assign({}, entry);
        delete copy.rawUrl;
        delete copy.blendUrl;
        return copy;
      }),
      currentId: state.currentId,
      products: savedProducts,
      notes: state.notes,
      style: state.style,
      optionCount: state.optionCount,
      counter: this.counter,
      scanEngine: state.scanState.engine,
      scanModel: state.scanState.model,
    }).catch(function (error) {
      studio.savingFailed(error);
    });
  }

  scheduleScanSave() {
    const studio = this;
    clearTimeout(this.saveScanTimer);
    this.saveScanTimer = setTimeout(function () {
      studio.saveScanNow();
    }, 1200);
  }

  // Same write scheduleScanSave() debounces, but immediate and awaitable. ensureFusion() needs
  // this: /pipeline/analyze reads the scan straight from Mongo, and until this save lands the
  // server sees no scan at all, so it 400s with "Scan this room before analysing it." (on a
  // rescan of a room that already had an older saved scan, it would 200 against that stale
  // scan instead - no error, just wrong geometry). Resolves to whether the save succeeded, so a
  // caller can skip queuing a pipeline run against data the server doesn't have yet.
  saveScanNow() {
    clearTimeout(this.saveScanTimer);
    const state = this.state;
    if (!state.roomId || !state.scan) {
      return Promise.resolve(false);
    }
    const studio = this;
    return saveScan(state.roomId, serialiseScan(state.scan)).then(
      function () {
        return true;
      },
      function (error) {
        studio.savingFailed(error);
        return false;
      },
    );
  }

  resetRoomState() {
    if (this.scanController) {
      this.scanController.abort();
    }
    this.undoStack = [];
    this.redoStack = [];
    this.pickCanvas = null;
    this.scanRun += 1; // an HD scan still on its way belongs to the room that was just left
    this.lastTap = null;
    this.photoLightCache = null;
    this.samLayer = null;
    this.samLayerKey = "";
    this.calibrating = new Map();
    this.sharpRegions = new Set();
    this.calibrationEmbeds = new Map();
    this.calibrationCanvas = null;
    this.fastScenePayload = null;
    this.ui.finishQuery = "";
    this.ui.finishTab = "All";
    this.set({
      hdScan: null,
      scan: null,
      scanState: idleScanState(),
      selectedIds: [],
      hoverId: null,
      itemId: null,
      kindOverride: null,
      notes: {},
      products: {},
      tool: "select",
      pick: PICK_IDLE,
      outlinePoints: [],
      compare: false,
      peek: false,
      showMap: false,
      sheetExpanded: false,
      historyTick: 0,
    });
  }

  async openRoom(id) {
    if (this.state.render) {
      this.toast("Wait for the current render to finish first.", "info");
      return;
    }
    this.set({ openingRoomId: id });
    try {
      const record = await loadRoom(id);
      if (!record) {
        this.toast(
          "That room could not be found. It may have been deleted.",
          "info",
        );
        this.refreshRooms();
        return;
      }
      clearTimeout(this.saveRoomTimer);
      this.resetRoomState();
      // Photos and renders load straight from the server when they are shown.
      const restored = (record.versions || []).map(function (entry) {
        const rawUrl = fileUrl(id + "/" + entry.id + "/raw");
        const blendUrl = entry.isOriginal
          ? rawUrl
          : fileUrl(id + "/" + entry.id + "/blend");
        return Object.assign({}, entry, { rawUrl: rawUrl, blendUrl: blendUrl });
      });
      if (restored.length === 0) {
        throw new Error("The saved photos for this room are missing.");
      }
      const restoredProducts = {};
      const savedProducts = record.products || {};
      await Promise.all(
        Object.keys(savedProducts).map(async function (key) {
          const saved = savedProducts[key];
          let mask = null;
          try {
            mask = await getFileBytes(id + "/mask/" + saved.id);
          } catch (error) {
            mask = null;
          }
          restoredProducts[saved.id] = Object.assign({}, saved, {
            item: findItem(saved.itemId),
            regionMask: mask ? mask : new Uint8Array(saved.maskW * saved.maskH),
          });
        }),
      );
      this.blobs = {};
      this.counter = record.counter || {
        version: restored.length - 1,
        custom: 0,
      };
      const savedScan = await loadScan(record);
      this.set({
        roomId: id,
        roomCreatedAt: record.createdAt,
        photo: record.photo,
        versions: restored,
        currentId: restored.some(function (entry) {
          return entry.id === record.currentId;
        })
          ? record.currentId
          : restored[0].id,
        products: restoredProducts,
        notes: record.notes || {},
        style: record.style || "",
        optionCount: record.optionCount || 1,
        dialog: null,
        immersive: this.wantsFullScreen() ? true : this.state.immersive,
      });
      if (savedScan) {
        const restoredScan = deserialiseScan(savedScan);
        this.set({
          scan: restoredScan,
          scanState: {
            status: restoredScan.regions.length > 0 ? "done" : "empty",
            stage: "",
            error: "",
            engine: savedScan.engine || "",
            model: savedScan.model || "",
          },
        });
        if (restoredScan.regions.length > 0) {
          this.ensureFusion(id, this.state.currentId);
        }
      } else {
        this.runScan(displayUrl(restored[0]));
      }
    } catch (error) {
      this.fail("Open room", error);
    } finally {
      this.set({ openingRoomId: null });
    }
  }

  async removeRoom(id) {
    if (!window.confirm("Delete this saved room from the server?")) {
      return;
    }
    try {
      await deleteRoom(id);
    } catch (error) {
      this.fail("Delete room", error);
    }
    this.refreshRooms();
  }

  // ------------------------------------------------------------------ detection
  // source: the photo as a canvas that is already decoded, when the caller has one (a new photo);
  // otherwise it is decoded from `url`.
  async scanImage(url, source) {
    const image = source || (await loadImage(url));
    const natural = naturalSize(image);
    const size = fitInside(
      natural.width,
      natural.height,
      this.settings.analysisMaxSide,
    );
    const canvas = drawToCanvas(image, size.width, size.height);
    return {
      canvas: canvas,
      imageData: canvas
        .getContext("2d")
        .getImageData(0, 0, size.width, size.height),
    };
  }

  // extras (a new photo): { source, uploadGate, uploaded } - the decoded photo to scan, the gate that
  // holds the original's upload until the scan's requests are away, and the promise of that upload.
  async runScan(url, extras) {
    const studio = this;
    const settings = this.settings;
    const uploadGate = extras && extras.uploadGate;
    // A photo is being scanned, so the Modal pools the room pipeline will need start now, in the same wave as the scan
    // (the server wakes only the cold ones; throttled and fire-and-forget). Opening the page never does this.
    if (this.app.warmup) {
      this.app.warmup();
    }
    if (this.scanController) {
      this.scanController.abort();
    }
    const controller = new AbortController();
    this.scanController = controller;
    const run = (this.scanRun += 1);
    this.lastTap = null;
    this.undoStack = [];
    this.redoStack = [];
    this.set({
      hdScan: null,
      selectedIds: [],
      hoverId: null,
      tool: "select",
      pick: PICK_IDLE,
      historyTick: 0,
      scanState: {
        status: "running",
        stage: "Preparing photo",
        error: "",
        engine: "",
        model: "",
      },
    });
    let width = 0;
    let height = 0;
    const started = performance.now();
    const timings = {};
    try {
      const prepared = await this.scanImage(url, extras && extras.source);
      timings.prepMs = Math.round(performance.now() - started);
      width = prepared.canvas.width;
      height = prepared.canvas.height;
      const session = this.app.session || {};
      const result = await detectSurfaces({
        location: settings.location,
        engine: settings.segmentationEngine,
        geminiEngine: settings.geminiEngine,
        sceneModel: settings.sceneModel,
        // OneFormer on Modal, raced against the local model (lib/segmentRace.js): only when the server has it and
        // the designer has not switched it off in Settings
        remoteScene: !!(session.pipeline && session.pipeline.oneformer) && settings.useHdScan !== false,
        modalIsWarm: this.modalIsWarm,
        onRaceEvent: function (event) {
          if (event.engine !== "remote" || run !== studio.scanRun) {
            return;
          }
          if (event.type === "result") {
            studio.noteModalWarm(true);
          } else if (event.type === "error") {
            studio.noteModalWarm(false);
          }
        },
        onUpgrade: function (hdScan) {
          studio.offerHdScan(hdScan, run);
        },
        useGeminiAssist: settings.useGeminiAssist,
        fallbackToGemini: settings.fallbackToGemini,
        maskModel: settings.maskModel,
        polygonModel: settings.polygonModel,
        imageBase64: canvasToBase64(prepared.canvas, "image/jpeg", 0.82),
        canvas: prepared.canvas,
        imageData: prepared.imageData,
        width: width,
        height: height,
        signal: controller.signal,
        timings: timings,
        onStage: function (stage) {
          if (!controller.signal.aborted) {
            studio.set({
              scanState: Object.assign({}, studio.state.scanState, {
                stage: stage,
              }),
            });
          }
        },
      });
      if (controller.signal.aborted) {
        return;
      }
      this.set({
        scan: result,
        products: reattachProducts(this.state.products, result),
        scanState: {
          status: result.regions.length === 0 ? "empty" : "done",
          stage: "",
          error: "",
          engine: result.engine,
          model: result.model,
        },
      });
      result.notes.forEach(function (note) {
        studio.toast(note, "info");
        studio.logError("Detection", { message: note });
      });
      logModel("scan", { engine: result.engine, model: result.model });
      if (this.pendingHd && this.pendingHd.run === run) {
        const waiting = this.pendingHd;
        this.pendingHd = null;
        this.offerHdScan(waiting.hdScan, waiting.run);
      }
      timings.totalMs = Math.round(performance.now() - started);
      recordScan(timings);
      if (uploadGate) {
        uploadGate.resolve(); // the scan's requests are done: the original can go up now
      }
      if (result.regions.length > 0) {
        // Flush the debounced scan save first: /pipeline/analyze reads the scan from the
        // database, and firing it before the save lands is what causes the 400s above (or,
        // on a rescan, queues a pipeline run against the previous, stale scan).
        const saved = await this.saveScanNow();
        // The room pipeline reads the original from the server too: on a slow connection the
        // upload can still be running when the scan is done, and without it the run would fail
        // with "The photo for this version was not found in storage".
        const photoSent = extras && extras.uploaded ? await extras.uploaded : true;
        if (saved && photoSent && !controller.signal.aborted) {
          // Forget the previous run for this photo: ensureFusion() skips a room+version it has
          // already analysed, but a rescan means the saved regions no longer match the scan.
          this.fusionVersionId = "";
          this.ensureFusion(this.state.roomId, this.state.currentId);
        }
      }
    } catch (error) {
      if (error && error.name === "AbortError") {
        return;
      }
      if (width > 0) {
        this.set({ scan: emptyScan(width, height) });
      }
      this.logError("Detection", error);
      this.set({
        scanState: {
          status: "error",
          stage: "",
          error: error.message,
          engine: "",
          model: "",
        },
      });
    } finally {
      if (uploadGate) {
        uploadGate.resolve(); // however the scan ended, the photo still has to be saved
      }
    }
  }

  // ------------------------------------------------------------------ HD scan (segmentRace.js)
  // The local model answered first and OneFormer on Modal answered later: its scan (built from the same Gemini outlines)
  // is more accurate. It replaces the quick scan by itself while that costs the designer nothing (nothing edited, no
  // finish chosen); otherwise a banner offers it, and one tap swaps it in.
  noteModalWarm(value) {
    this.modalIsWarm = !!value;
    if (this.app.setModalWarm) {
      this.app.setModalWarm(value);
    }
  }

  noteTap(point) {
    if (point && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
      this.lastTap = { x: point[0], y: point[1] };
    }
  }

  offerHdScan(hdScan, run) {
    if (this.destroyed || run !== this.scanRun) {
      return;
    }
    if (!this.state.scan || this.state.scanState.status !== "done") {
      // the quick scan is not on screen yet (the HD one was ready before runScan() finished): hold it until it is
      this.pendingHd = { hdScan: hdScan, run: run };
      return;
    }
    if (canAutoApply(this.state, this.undoStack.length)) {
      this.applyHdScan(hdScan, true);
      return;
    }
    this.set({ hdScan: hdScan });
  }

  dismissHdScan() {
    this.set({ hdScan: null });
  }

  applyHdScan(hdScan, automatic) {
    const hd = hdScan || this.state.hdScan;
    const current = this.state.scan;
    if (!hd || !current || this.state.render) {
      return;
    }
    const selectedIds = remapSelection(current, this.validIds(), hd, this.lastTap);
    if (!automatic) {
      this.undoStack.push(current); // a swap the designer asked for can be undone
      if (this.undoStack.length > 30) {
        this.undoStack.shift();
      }
      this.redoStack = [];
    }
    this.set({
      scan: hd,
      hdScan: null,
      products: reattachProducts(this.state.products, hd),
      selectedIds: selectedIds,
      hoverId: null,
      historyTick: this.state.historyTick + 1,
      scanState: Object.assign({}, this.state.scanState, { engine: hd.engine, model: hd.model }),
    });
    this.toast("Switched to the HD surface scan.", "success");
    // the planes were fitted to the quick scan's regions: fit them again to these (local maths, Modal is not called)
    if (this.state.roomId && this.state.currentId) {
      const studio = this;
      this.saveScanNow().then(function (saved) {
        if (saved && !studio.destroyed && studio.state.scan === hd) {
          studio.fusionVersionId = "";
          studio.ensureFusion(studio.state.roomId, studio.state.currentId);
        }
      });
    }
  }

  rescan() {
    const version = this.version();
    if (version && !this.state.render) {
      this.runScan(displayUrl(version));
    }
  }

  // ------------------------------------------------------------------ the "understand this
  // photo" pipeline (SAM 3 + MoGe-2 + Marigold-IID, server/lib/pipelineRunner.js)
  //
  // Lets a finish selection preview instantly from real geometry/lighting instead of only ever
  // waiting on a Gemini render (public/js/lib/fastrender/, consumed by stage.js). Entirely
  // additive: nothing here ever throws into a caller, and every failure just leaves
  // this.fastScenePayload null, which stage.js already treats as "nothing to preview" - the
  // existing Gemini render flow is never affected by anything in this section.
  // True once a newer ensureFusion() call, a room switch or a rescan has replaced the run that
  // captured `run`, so its in-flight polls and loads must not write their results.
  fusionStale(roomId, versionId, run) {
    return (
      this.fusionRoomId !== roomId ||
      this.fusionVersionId !== versionId ||
      this.fusionRun !== run
    );
  }

  ensureFusion(roomId, versionId) {
    if (!ROOM_ID_RE.test(roomId || "") || !versionId) {
      return;
    }
    if (
      this.fusionRoomId === roomId &&
      this.fusionVersionId === versionId &&
      this.ui.fusion &&
      (this.ui.fusion.status === "ready" ||
        this.ui.fusion.status === "checking" ||
        this.ui.fusion.status === "running")
    ) {
      return; // already current, or already in flight for this exact room+version
    }
    if (this.fusionPoll) {
      clearTimeout(this.fusionPoll);
      this.fusionPoll = 0;
    }
    this.fusionRoomId = roomId;
    this.fusionVersionId = versionId;
    const run = (this.fusionRun += 1);
    // The previous result stays on screen while a new one is worked out FOR THE SAME PHOTO (a rescan, the HD scan swapped
    // in): the preview keeps its real geometry, and regions the old fit does not know borrow an estimate meanwhile
    // (lib/previewScene.js). A different photo drops it.
    if (
      this.fastScenePayload &&
      (this.fastScenePayload.roomId !== roomId || this.fastScenePayload.versionId !== versionId)
    ) {
      this.fastScenePayload = null;
      this.samLayer = null;
    }
    this.ui.fusion = { status: "checking", progress: null, error: "" };
    this.requestRender();
    const studio = this;
    postJson("/pipeline/analyze", { roomId: roomId, versionId: versionId })
      .then(function (answer) {
        if (studio.fusionStale(roomId, versionId, run)) {
          return; // superseded by a later scan/room switch while this was in flight
        }
        if (answer && answer.status === "ready") {
          return studio.loadFusionResult(roomId, versionId, run);
        }
        if (answer && answer.jobId) {
          studio.pollFusionJob(roomId, versionId, answer.jobId, run);
        }
      })
      .catch(function (error) {
        console.warn("[swatchroom] pipeline/analyze failed:", error);
        if (!studio.fusionStale(roomId, versionId, run)) {
          studio.ui.fusion = {
            status: "error",
            progress: null,
            error: (error && error.message) || "Could not start the room pipeline.",
          };
          studio.requestRender();
        }
      });
  }

  pollFusionJob(roomId, versionId, jobId, run) {
    const studio = this;
    this.ui.fusion = { status: "running", progress: null, error: "" };
    this.requestRender();
    let lastReport = "";
    function tick() {
      if (studio.fusionStale(roomId, versionId, run)) {
        return; // superseded
      }
      getJson("/pipeline/jobs/" + jobId)
        .then(function (job) {
          if (studio.fusionStale(roomId, versionId, run)) {
            return;
          }
          const report = JSON.stringify([job.status, job.stage, job.progress, job.error]);
          if (report !== lastReport) {
            lastReport = report;
            logModel("room pipeline", {
              job: jobId,
              status: job.status,
              stage: job.stage,
              progress: job.progress,
              error: job.error,
            });
          }
          if (job.status === "done") {
            return studio.loadFusionResult(roomId, versionId, run);
          }
          if (job.status === "failed") {
            studio.ui.fusion = {
              status: "error",
              progress: job.progress || null,
              error: publicText(job.error || "The room pipeline failed."),
            };
            studio.requestRender();
            return;
          }
          studio.ui.fusion = {
            status: job.status || "running",
            progress: job.progress || null,
            error: "",
          };
          studio.requestRender();
          studio.fusionPoll = setTimeout(tick, 1500);
        })
        .catch(function () {
          // A transient blip polling the job: keep trying quietly rather than surfacing every
          // hiccup as an error (the job itself is still running server-side regardless).
          if (!studio.fusionStale(roomId, versionId, run)) {
            studio.fusionPoll = setTimeout(tick, 4000);
          }
        });
    }
    tick();
  }

  // The textures of the finishes the list shows right now (the first few of the current kind / tab / search), so picking
  // one is instant. The same array object is returned until the list changes, which is how the stage knows to ask once.
  prefetchUrls(kind) {
    const state = this.state;
    const tab = this.ui.finishTab;
    const groups = finishGroups(kind, this.ui.finishQuery || "", state.customColors, state.recentIds);
    const urls = [];
    groups.forEach(function (group) {
      if (tab !== "All" && group.group !== tab) {
        return;
      }
      group.items.forEach(function (item) {
        if (item.texture && item.texture.url && urls.length < 14 && urls.indexOf(item.texture.url) === -1) {
          urls.push(item.texture.url);
        }
      });
    });
    const key = urls.join("|");
    if (this.prefetchMemo.key !== key) {
      this.prefetchMemo = { key: key, urls: urls };
    }
    return this.prefetchMemo.urls;
  }

  // ------------------------------------------------------------------ the photo's light
  // The photo's brightness at the scan's size, once per photo: it lets the preview's soft edges snap to real edges, gives
  // each surface its exposure, and is the whole light of the provisional preview. Returns it if it is ready, else null (and
  // starts loading it; the studio redraws when it arrives).
  photoLightKey(scan) {
    const version = this.version();
    return (
      (this.state.roomId || "") + "|" + (version ? version.id + ":" + version.view : "") + "|" + scan.width + "x" + scan.height
    );
  }

  photoLightFor(scan) {
    const key = this.photoLightKey(scan);
    if (this.photoLightCache && this.photoLightCache.key === key) {
      return this.photoLightCache.value;
    }
    const version = this.version();
    if (!version) {
      return null;
    }
    const studio = this;
    const entry = { key: key, value: null, promise: null };
    this.photoLightCache = entry;
    entry.promise = loadImage(displayUrl(version)).then(function (image) {
      const canvas = drawToCanvas(image, scan.width, scan.height);
      const data = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, scan.width, scan.height);
      const light = lumaFromRgba(data.data, scan.width, scan.height);
      releaseCanvas(canvas);
      if (studio.photoLightCache === entry) {
        entry.value = light;
        studio.requestRender();
      }
      return light;
    });
    entry.promise.catch(function () {
      // no photo light: the preview simply has no edge guidance and a neutral exposure
    });
    return null;
  }

  async photoLightAsync(scan) {
    this.photoLightFor(scan);
    const entry = this.photoLightCache;
    try {
      return entry && entry.promise ? await entry.promise : entry ? entry.value : null;
    } catch (error) {
      return null;
    }
  }

  async loadFusionResult(roomId, versionId, run) {
    try {
      const answer = await getJson("/rooms/" + roomId);
      const fusion = answer.room && answer.room.fusion;
      if (this.fusionStale(roomId, versionId, run)) {
        return; // superseded
      }
      if (
        !fusion ||
        !fusion.geometry ||
        !fusion.regions ||
        fusion.geometry.versionId !== versionId
      ) {
        this.ui.fusion = {
          status: "error",
          progress: null,
          error: "The room pipeline finished but left no usable result.",
        };
        this.requestRender();
        return;
      }
      const geometry = fusion.geometry;
      const base = "/rooms/" + roomId + "/files/fusion/" + versionId + "/";
      const [depthBlob, shadingBlob, residualBlob, samBlob] = await Promise.all([
        getBlob(base + "depth"),
        getBlob(base + "shading"),
        geometry.residualFile ? getBlob(base + "residual") : Promise.resolve(null),
        geometry.samFile ? getBlob(base + "sam") : Promise.resolve(null),
      ]);
      if (this.fusionStale(roomId, versionId, run)) {
        return;
      }
      if (!depthBlob || !shadingBlob) {
        this.ui.fusion = {
          status: "error",
          progress: null,
          error: "The room pipeline's saved depth/shading layers could not be read.",
        };
        this.requestRender();
        return;
      }
      // Shading is linear relative light. Rooms analysed before that stored float32 bytes that were really gamma-2.2
      // encoded; those are converted here (value ** 2.2) so old rooms light correctly too.
      const [depth, shading, residual] = await Promise.all([
        unpackFloat32(depthBlob),
        geometry.shadingFormat === "u16"
          ? unpackUnit16(shadingBlob)
          : unpackFloat32(shadingBlob).then(function (values) {
              for (let i = 0; i < values.length; i += 1) {
                values[i] = Math.pow(values[i], 2.2);
              }
              return values;
            }),
        residualBlob ? unpackUnit16(residualBlob) : Promise.resolve(null),
      ]);
      let layer = null;
      if (samBlob) {
        try {
          layer = parseSamLayer(await unpackGzip(samBlob));
        } catch (error) {
          layer = null; // an unreadable SAM layer only means the plain region masks are used
        }
      }
      const light = await this.photoLightAsync(this.state.scan);
      if (this.fusionStale(roomId, versionId, run)) {
        return;
      }
      this.fusionLoads += 1;
      this.samLayer = layer;
      this.fastScenePayload = {
        kind: "fused",
        roomId: roomId,
        versionId: versionId,
        geometryKey: "fused:" + roomId + ":" + versionId + ":" + this.fusionLoads,
        scan: this.state.scan,
        fusionRegions: fusion.regions.byId || {},
        depth: depth,
        shading: shading,
        residual: residual,
        luma: light ? light.luma : null,
        photoLinear: light ? light.linear : null,
        intrinsics: geometry.camera,
      };
      this.ui.fusion = { status: "ready", progress: null, error: "" };
      this.requestRender();
      await this.applyStoredSplits(fusion.regions.splits, run, roomId, versionId);
    } catch (error) {
      if (!this.fusionStale(roomId, versionId, run)) {
        this.ui.fusion = {
          status: "error",
          progress: null,
          error: (error && error.message) || "Could not load the room pipeline result.",
        };
        this.requestRender();
      }
    }
  }

  // A wall the room analysis found to be several planes becomes several surfaces, so a finish is laid on one wall at a time
  // instead of across a corner. Only while that costs the designer nothing: the scan unedited, and no finish or product on
  // the wall. It goes into the history (Undo puts the wall back) and the planes are fitted again for the new surfaces.
  async applyStoredSplits(stored, run, roomId, versionId) {
    if (!stored || stored.length === 0 || this.undoStack.length > 0 || !this.state.scan) {
      return;
    }
    const scan = this.state.scan;
    const decoded = await decodeSplits(stored, unpackBytes);
    if (this.fusionStale(roomId, versionId, run) || this.state.scan !== scan) {
      return;
    }
    const state = this.state;
    const products = state.products;
    const busyRegions = {};
    Object.keys(products).forEach(function (key) {
      (products[key].regionIds || [products[key].regionId]).forEach(function (id) {
        busyRegions[id] = true;
      });
    });
    const usable = decoded.filter(function (split) {
      if (busyRegions[split.regionId]) {
        return false;
      }
      return !(state.itemId && state.selectedIds.indexOf(split.regionId) !== -1);
    });
    if (usable.length === 0) {
      return;
    }
    const next = applyPlaneSplits(scan, usable);
    if (next === scan) {
      return;
    }
    this.pushScan(next);
    const planes = usable.reduce((total, split) => total + split.parts, 0);
    this.toast(
      usable.length === 1
        ? "This wall is " + usable[0].parts + " planes, so it is now " + usable[0].parts + " surfaces."
        : usable.length + " walls were split into " + planes + " planes.",
      "info",
      { label: "Undo", run: () => this.undo() },
    );
    const studio = this;
    this.saveScanNow().then(function (saved) {
      if (saved && !studio.destroyed && studio.state.scan === next) {
        studio.fusionVersionId = "";
        studio.ensureFusion(studio.state.roomId, studio.state.currentId);
      }
    });
  }

  // ------------------------------------------------------------------ photos
  async addPhoto(file) {
    if (!file) {
      return;
    }
    if (this.state.render) {
      this.toast(
        "Wait for the current render to finish before changing the photo.",
        "info",
      );
      return;
    }
    try {
      // Start waking the GPU containers before anything else: the photo still has to be decoded,
      // resized and scanned, which is time the cold start can use.
      if (this.app.warmup) {
        this.app.warmup();
      }
      const image = await loadImageFile(file);
      const phone = this.isPhone();
      const canvas = canvasAtMost(
        image,
        phone ? PHONE_ORIGINAL_MAX_SIDE : ORIGINAL_MAX_SIDE,
      );
      const blob = await canvasToBlob(canvas, "image/jpeg", phone ? 0.9 : 0.93);
      const url = this.track(URL.createObjectURL(blob));
      const id = newRoomId();
      clearTimeout(this.saveRoomTimer);
      this.resetRoomState();
      this.counter = { version: 0, custom: 0 };
      this.blobs = { v0: { raw: blob, blend: null } };
      const original = {
        id: "v0",
        number: 0,
        parentId: null,
        title: "Original",
        subtitle: file.name || "Photo",
        rawUrl: url,
        blendUrl: url,
        view: "blend",
        isOriginal: true,
        width: canvas.width,
        height: canvas.height,
        request: null,
        productIds: [],
      };
      this.set({
        roomId: id,
        roomCreatedAt: Date.now(),
        photo: {
          name: file.name || "Photo",
          width: canvas.width,
          height: canvas.height,
        },
        versions: [original],
        currentId: "v0",
        immersive: this.wantsFullScreen() ? true : this.state.immersive,
      });
      const studio = this;
      // The scan's own requests (a JPEG of about 150 KB each) go first; the original, which can be
      // megabytes, follows once they are away or the scan ends - it would otherwise share a phone's
      // slow uplink with them and make the scan wait for it. The thumbnail comes from the canvas
      // that is already decoded.
      const gate = deferred();
      setTimeout(gate.resolve, ORIGINAL_UPLOAD_DELAY_MS);
      const uploaded = gate.promise
        .then(function () {
          return putFile(id + "/v0/raw", blob);
        })
        .then(function () {
          return studio.makeThumb(canvas);
        })
        .then(function (thumb) {
          return putFile(id + "/thumb", thumb);
        })
        .then(
          function () {
            return true;
          },
          function (error) {
            studio.savingFailed(error);
            return false;
          },
        );
      this.runScan(url, { source: canvas, uploadGate: gate, uploaded: uploaded });
    } catch (error) {
      this.fail("Upload", error);
    }
  }

  // A phone-sized screen with touch: where uploads go over mobile data and memory is tight.
  isPhone() {
    return (
      !!this.state.coarse &&
      Math.min(window.innerWidth, window.innerHeight) < 600
    );
  }

  choosePhoto() {
    this.fileInput.click();
  }

  takePhoto() {
    this.cameraInput.click();
  }

  closeRoom() {
    if (this.state.render) {
      this.toast("Wait for the current render to finish first.", "info");
      return;
    }
    this.saveRoomNow();
    clearTimeout(this.saveRoomTimer);
    this.resetRoomState();
    this.set({
      roomId: null,
      photo: null,
      versions: [],
      currentId: null,
      immersive: false,
    });
    this.refreshRooms();
  }

  // ------------------------------------------------------------------ surface edits
  pushScan(next) {
    const scan = this.state.scan;
    if (!next || !scan) {
      return;
    }
    this.undoStack.push(scan);
    if (this.undoStack.length > 30) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.set({ scan: next, historyTick: this.state.historyTick + 1 });
  }

  keepValidSelection(next) {
    this.set({
      selectedIds: this.state.selectedIds.filter(function (id) {
        return next.regions.some(function (region) {
          return region.id === id;
        });
      }),
    });
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) {
      return;
    }
    this.redoStack.push(this.state.scan);
    this.set({ scan: previous, historyTick: this.state.historyTick + 1 });
    this.keepValidSelection(previous);
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) {
      return;
    }
    this.undoStack.push(this.state.scan);
    this.set({ scan: next, historyTick: this.state.historyTick + 1 });
    this.keepValidSelection(next);
  }

  itemFitsKind(id, kind) {
    if (!id || /^paint-custom-/.test(id)) {
      return true;
    }
    return findItemKind(id) === kind;
  }

  selectRegion(id, additive) {
    const tool = this.state.tool;
    if (tool === "outline" || tool === "pick") {
      return;
    }
    if (!id) {
      if (!additive) {
        this.set({ selectedIds: [] });
      }
      return;
    }
    const validIds = this.validIds();
    let next;
    if (additive) {
      next =
        validIds.indexOf(id) === -1
          ? validIds.concat([id])
          : validIds.filter(function (other) {
              return other !== id;
            });
    } else {
      next = [id];
    }
    this.applySelection(next);
  }

  // ------------------------------------------------------------------ tap to calibrate (lib/samCalibrate.js)
  // The tapped surface is selected at once from the scan; in the background SAM is asked about exactly this surface and its
  // outline is tightened to SAM's, and rugs, furniture, windows and pictures standing on it are cut out as holes. SAM's
  // answer comes from the SAM 3 masks the room analysis stored (no call to anything), or, until those exist, from the
  // model service's SlimSAM on the CPU server - never from Modal. The new mask goes into the scan itself, so the outline on
  // the photo, the instant preview and the AI render's mask all agree.
  calibrateSelection(regionId) {
    if (this.settings.samCalibrate === false || !this.state.scan) {
      return null;
    }
    const scan = this.state.scan;
    const region = scan.regions.find(function (candidate) {
      return candidate.id === regionId;
    });
    if (!region || region.isUnion || ["wall", "floor", "ceiling"].indexOf(region.kind) === -1) {
      return null;
    }
    let done = this.calibrated.get(scan);
    if (!done) {
      done = new Set();
      this.calibrated.set(scan, done);
    }
    if (done.has(regionId)) {
      return null;
    }
    done.add(regionId);
    const studio = this;
    const tap = this.lastTap;
    const work = async function () {
      let candidate = null;
      const layer = studio.samLayer;
      if (layer) {
        const hit = pickSamInstance(region, tap, instancesOfKind(layer, region.kind), scan.width, scan.height);
        if (hit) {
          candidate = { mask: hit.instance.mask, score: hit.instance.score, source: "sam3" };
        }
      } else {
        candidate = await studio.localSamCandidate(scan, region, tap);
      }
      if (studio.destroyed || studio.state.scan !== scan) {
        return; // the scan was replaced while SAM was thinking
      }
      const result = fuseRegionWithSam({
        region: region,
        candidate: candidate,
        layer: layer,
        labelMap: scan.labelMap,
        width: scan.width,
        height: scan.height,
      });
      if (candidate && candidate.score >= SNAP_CONFIDENCE && result.reason !== "disagree") {
        studio.sharpRegions.add(regionId);
      }
      if (!result.changed) {
        return;
      }
      const next = paintRegion(scan, regionId, result.mask, "replace");
      if (next !== scan) {
        // Not an undo step of its own: it is the scan being made right, not an edit the designer made.
        studio.calibrated.set(next, studio.calibrated.get(scan));
        studio.set({ scan: next });
      }
    };
    // .finally() (not a try/finally inside work) so that `promise` exists when it runs, however fast work() is
    const promise = work()
      .catch(function (error) {
        console.warn("[swatchroom] surface calibration skipped:", error);
      })
      .finally(function () {
        if (studio.calibrating.get(regionId) === promise) {
          studio.calibrating.delete(regionId);
        }
      });
    this.calibrating.set(regionId, promise);
    return promise;
  }

  // SlimSAM on the model service, prompted with the tap, interior points, neighbours and the box. null when it cannot help
  // (service down, Pick not available): the scan's own outline is simply kept.
  async localSamCandidate(scan, region, tap) {
    const version = this.version();
    if (!version || Date.now() < this.localSamDownUntil) {
      return null;
    }
    const key = (this.state.roomId || "room") + ":" + version.id + ":" + scan.width + "x" + scan.height;
    let ready = this.calibrationEmbeds.get(key);
    if (!ready) {
      const studio = this;
      ready = (async function () {
        const image = await loadImage(displayUrl(version));
        const canvas = drawToCanvas(image, scan.width, scan.height);
        studio.calibrationCanvas = canvas;
        await preparePick(canvas, key);
      })();
      this.calibrationEmbeds.set(key, ready);
      ready.catch(function () {
        studio.calibrationEmbeds.delete(key); // try again, but not on every tap: see LOCAL_SAM_COOLDOWN_MS
        studio.localSamDownUntil = Date.now() + LOCAL_SAM_COOLDOWN_MS;
      });
    }
    try {
      await ready;
      const prompts = buildSamPrompts(scan, region, tap);
      const answer = await maskForTaps(key, prompts.points, prompts.labels, this.calibrationCanvas, prompts.box);
      if (answer.width !== scan.width || answer.height !== scan.height) {
        return null;
      }
      return { mask: answer.mask, score: answer.score, source: "slimsam" };
    } catch (error) {
      return null;
    }
  }

  applySelection(next) {
    const patch = { selectedIds: next, kindOverride: null };
    const scan = this.state.scan;
    if (scan && next.length > 0) {
      const region = unionRegion(scan, next);
      if (region && !this.itemFitsKind(this.state.itemId, region.kind)) {
        patch.itemId = null;
      }
    }
    if (this.narrow() && next.length > 0 && this.state.tool === "select") {
      patch.sheetExpanded = false;
    }
    this.set(patch);
    if (next.length === 1 && this.state.tool === "select") {
      this.calibrateSelection(next[0]);
    }
  }

  toggleSurfaceFromList(id, additive) {
    if (additive) {
      this.selectRegion(id, true);
      return;
    }
    const validIds = this.validIds();
    if (validIds.length === 1 && validIds[0] === id) {
      this.set({ selectedIds: [] });
      return;
    }
    this.selectRegion(id, false);
  }

  selectAllOfKind() {
    const scan = this.state.scan;
    const region = this.selectedRegion();
    if (!scan || !region) {
      return;
    }
    this.applySelection(
      scan.regions
        .filter(function (other) {
          return other.kind === region.kind;
        })
        .map(function (other) {
          return other.id;
        }),
    );
  }

  changeCatalogKind(kind) {
    const scan = this.state.scan;
    if (!scan || !this.selectedRegion()) {
      return;
    }
    const validIds = this.validIds();
    if (validIds.length === 1) {
      this.pushScan(setRegionKind(scan, validIds[0], kind));
      this.set({ kindOverride: null });
    } else {
      this.set({ kindOverride: kind });
    }
    if (!this.itemFitsKind(this.state.itemId, kind)) {
      this.set({ itemId: null });
    }
  }

  changeTool(next) {
    if (!this.state.scan && next !== "select") {
      return;
    }
    const patch = { hoverId: null, outlinePoints: [], tool: next };
    if (next !== "pick") {
      patch.pick = PICK_IDLE;
    }
    if (next === "outline") {
      patch.selectedIds = [];
    }
    const validIds = this.validIds();
    if (next === "brush" && validIds.length > 1) {
      patch.selectedIds = [validIds[0]];
    }
    this.set(patch);
    if (next === "pick") {
      this.startPick();
    }
  }

  finishOutline() {
    const scan = this.state.scan;
    if (!scan) {
      return;
    }
    const points = this.state.outlinePoints;
    if (points.length < 3) {
      this.toast("Tap at least three points around the surface.", "info");
      return;
    }
    this.counter.custom += 1;
    const result = addRegionFromOutline(
      scan,
      points,
      "Custom area " + this.counter.custom,
    );
    this.set({ outlinePoints: [], tool: "select" });
    if (!result) {
      this.toast(
        "That outline is too small. Tap at least three points around the surface.",
        "info",
      );
      return;
    }
    this.pushScan(result.scan);
    this.set({ selectedIds: [result.regionId], itemId: null });
    const status = this.state.scanState.status;
    if (status === "error" || status === "empty") {
      this.set({
        scanState: Object.assign({}, this.state.scanState, { status: "done" }),
      });
    }
  }

  brushStroke(mask, mode) {
    const validIds = this.validIds();
    if (this.state.scan && validIds.length === 1) {
      this.pushScan(paintRegion(this.state.scan, validIds[0], mask, mode));
    }
  }

  // ------------------------------------------------------------------ Pick (SlimSAM, in the
  // model service)
  setPick(patch, onlyForKey) {
    if (onlyForKey && this.state.pick.key !== onlyForKey) {
      return;
    }
    this.set({ pick: Object.assign({}, this.state.pick, patch) });
  }

  async startPick() {
    const scan = this.state.scan;
    const version = this.version();
    if (!scan || !version) {
      return;
    }
    const key =
      (this.state.roomId || "room") +
      ":" +
      version.id +
      ":" +
      scan.width +
      "x" +
      scan.height;
    this.set({
      pick: Object.assign({}, PICK_IDLE, {
        status: "loading",
        message: "Loading the Pick tool",
        key: key,
        engineLabel: "",
      }),
    });
    this.setPick(
      {
        engine: "service",
        engineLabel: "SlimSAM on the server",
        message: "Preparing the photo for Pick",
      },
      key,
    );
    try {
      const image = await loadImage(displayUrl(version));
      const canvas = drawToCanvas(image, scan.width, scan.height);
      this.pickCanvas = canvas;
      await preparePick(canvas, key);
      this.setPick({ status: "ready", message: "" }, key);
    } catch (error) {
      this.logError("Pick", error);
      this.setPick(
        {
          status: "error",
          message: "The Pick tool could not start: " + error.message,
        },
        key,
      );
    }
  }

  async updatePick(points) {
    const scan = this.state.scan;
    const state = this.state.pick;
    if (!scan || state.status !== "ready") {
      return;
    }
    if (points.length === 0) {
      this.setPick({ points: [], preview: null, busy: false });
      return;
    }
    this.setPick({ points: points, busy: true });
    try {
      const pixelPoints = points.map(function (point) {
        return [point[0] * scan.width, point[1] * scan.height];
      });
      const labels = points.map(function (point) {
        return point[2] ? 1 : 0;
      });
      const answer = await maskForTaps(
        state.key,
        pixelPoints,
        labels,
        this.pickCanvas,
      );
      this.setPick({
        points: points,
        preview: { mask: answer.mask, width: answer.width, height: answer.height },
        busy: false,
      });
    } catch (error) {
      this.logError("Pick", error);
      this.setPick({ busy: false, status: "ready" });
      this.toast("Pick failed: " + error.message);
    }
  }

  pickTap(x, y, positive) {
    const state = this.state.pick;
    if (state.status !== "ready" || state.busy) {
      return;
    }
    this.updatePick(state.points.concat([[x, y, positive]]));
  }

  acceptPick(replace) {
    const scan = this.state.scan;
    const state = this.state.pick;
    if (!scan || !state.preview) {
      return;
    }
    const mask = resizeMask(
      state.preview.mask,
      state.preview.width,
      state.preview.height,
      scan.width,
      scan.height,
    );
    const validIds = this.validIds();
    if (replace && validIds.length === 1) {
      this.pushScan(paintRegion(scan, validIds[0], mask, "replace"));
    } else {
      this.counter.custom += 1;
      const result = addRegionFromMask(
        scan,
        mask,
        "Selected area " + this.counter.custom,
      );
      if (!result) {
        this.toast("That selection is too small.", "info");
        return;
      }
      this.pushScan(result.scan);
      this.set({ selectedIds: [result.regionId], itemId: null });
    }
    this.set({ pick: PICK_IDLE, tool: "select" });
  }

  // ------------------------------------------------------------------ products
  changeProduct(id, changes) {
    const current = this.state.products;
    if (!current[id]) {
      return;
    }
    const next = Object.assign({}, current);
    next[id] = Object.assign({}, current[id], changes);
    this.set({ products: next });
  }

  async estimate(productIds, newVersion, region, item) {
    const studio = this;
    const scan = this.state.scan;
    const settings = this.settings;
    try {
      const image = await loadImage(displayUrl(newVersion));
      const canvas = canvasAtMost(image, settings.uploadMaxSide);
      const mask = maskCanvas(
        region.mask,
        scan.width,
        scan.height,
        canvas.width,
        canvas.height,
        0,
      );
      const measure = await measureSurface({
        location: settings.location,
        model: settings.insightModel,
        imageBase64: canvasToBase64(canvas, "image/jpeg", 0.88),
        maskBase64: canvasToBase64(mask, "image/png"),
        regionLabel: region.label,
        kind: region.kind,
        productName: item ? item.name : "Custom edit",
        productSub: item ? item.sub : "",
      });
      productIds.forEach(function (id) {
        studio.changeProduct(id, {
          measure: measure,
          status: "ready",
          renderedDescription: measure.renderedDescription,
        });
      });
    } catch (error) {
      this.logError("Quantity estimate", error);
      productIds.forEach(function (id) {
        studio.changeProduct(id, { status: "failed", error: error.message });
      });
    }
  }

  rememberFinish(id) {
    if (!id) {
      return;
    }
    const next = [id]
      .concat(
        this.state.recentIds.filter(function (other) {
          return other !== id;
        }),
      )
      .slice(0, 12);
    writeList(RECENT_KEY, next);
    this.set({ recentIds: next });
  }

  addCustomColour(hex) {
    const clean = String(hex).toUpperCase();
    const next = [clean]
      .concat(
        this.state.customColors.filter(function (other) {
          return other !== clean;
        }),
      )
      .slice(0, 6);
    writeList(COLOURS_KEY, next);
    this.set({
      customColors: next,
      itemId: "paint-custom-" + clean.replace("#", "").toLowerCase(),
    });
  }

  // ------------------------------------------------------------------ rendering
  async startRender() {
    const studio = this;
    const state = this.state;
    const settings = this.settings;
    let scan = state.scan;
    let region = this.selectedRegion();
    const base = this.version();
    if (!scan || !region || !base || state.render) {
      return;
    }
    const item = state.itemId ? findItem(state.itemId) : null;
    const noteText = this.currentNotes();
    if (!item && noteText.trim() === "") {
      this.toast(
        "Choose a finish from the catalogue or describe the change in the notes.",
        "info",
      );
      return;
    }
    if (!settings.imageModel) {
      this.toast("Choose a render model in Settings first.", "info");
      return;
    }
    // The instant preview is hidden while a render runs, so what it looks like NOW has to be captured before the render
    // state is set below (the canvas is read at this call; the encoding finishes later). It goes into the guide image.
    let previewShot = null;
    const shown = this.stage.previewState();
    if (shown && shown.kind === "fused" && shown.regionId === region.id && !region.isUnion) {
      previewShot = this.stage.previewSnapshot();
    }
    const controller = new AbortController();
    const label =
      (item ? item.name : "Custom edit") + " on " + region.label.toLowerCase();
    const count = state.optionCount;
    const style = state.style;
    const modelName = this.modelName();
    const patch = {
      compare: false,
      peek: false,
      render: {
        label: label,
        startedAt: Date.now(),
        controller: controller,
        total: count,
        done: 0,
        stage: "Preparing the photo",
      },
    };
    if (this.narrow()) {
      patch.sheetExpanded = false;
    }
    this.set(patch);
    this.rememberFinish(item ? item.id : null);
    function updateRender(changes) {
      if (studio.state.render) {
        studio.set({ render: Object.assign({}, studio.state.render, changes) });
      }
    }
    let prepared = null;
    try {
      // A surface that was tapped a moment ago may still be having its edge sharpened: wait for it, so the mask that is
      // sent is the calibrated one (rugs and furniture cut out, edge on SAM's line)...
      const parts = region.partIds || [region.id];
      const waiting = parts
        .map(function (id) {
          return studio.calibrating.get(id);
        })
        .filter(Boolean);
      if (waiting.length > 0) {
        await Promise.all(waiting);
      }
      // from here on the surface is the calibrated one (its mask is what the render, the saved product and the blend use)
      region = this.selectedRegion() || region;
      scan = this.state.scan;
      const current = region;
      // ... and the 3D facts about the surface, if the room has been analysed: its real size, which way it faces, the
      // camera's field of view, and the instant preview exactly as it is on screen (blended into the guide image).
      const fusedScene = this.fastScenePayload;
      let geometry = null;
      let preview = null;
      if (
        fusedScene &&
        fusedScene.roomId === state.roomId &&
        fusedScene.versionId === state.currentId &&
        !current.isUnion
      ) {
        // a plane the preview does not trust (below the designer's low threshold) is not told to Gemini as a measurement either;
        // the preview and the brief read the raw fit here, never the composed scene with its outline estimates
        const fit = fusedScene.fusionRegions[current.id];
        const trusted = fit && typeof fit.confidence === "number" && fit.confidence >= settings.fusionLowThreshold;
        geometry = trusted ? surfaceGeometry(current, fit, fusedScene.intrinsics, this.state.scan) : null;
        if (geometry && previewShot) {
          preview = await previewShot;
        }
      }
      const input = {
        settings: settings,
        scan: scan,
        region: current,
        versionUrl: displayUrl(base),
        item: item,
        style: style,
        notes: noteText,
        signal: controller.signal,
        geometry: geometry,
        preview: preview,
        sharpEdges: !current.isUnion && this.sharpRegions.has(current.id),
      };
      prepared = await prepareRender(input);
      updateRender({ stage: modelName });
      const runs = [];
      for (let index = 0; index < count; index += 1) {
        runs.push(
          renderOption(input, prepared).then(function (result) {
            updateRender({
              done: studio.state.render ? studio.state.render.done + 1 : 0,
            });
            return result;
          }),
        );
      }
      const settled = await Promise.allSettled(runs);
      const surfaceLike = item
        ? item.mode === "surface" || item.mode === "restyle"
        : ["wall", "floor", "ceiling"].indexOf(region.kind) !== -1;
      const products = this.state.products;
      const keepProducts = (base.productIds || []).filter(function (id) {
        const product = products[id];
        if (!product) {
          return false;
        }
        const ids = product.regionIds || [product.regionId];
        return !ids.some(function (other) {
          return (region.partIds || [region.id]).indexOf(other) !== -1;
        });
      });
      const measuring =
        settings.estimateQuantities &&
        !(item && productSpec(item).qty.type === "none");
      const newVersions = [];
      const newProducts = {};
      const problems = [];
      for (let index = 0; index < settled.length; index += 1) {
        const outcome = settled[index];
        if (outcome.status !== "fulfilled") {
          if (!(outcome.reason && outcome.reason.name === "AbortError")) {
            problems.push(outcome.reason);
          }
          continue;
        }
        const result = outcome.value;
        this.counter.version += 1;
        const number = this.counter.version;
        const versionId =
          "v" + number + "-" + Math.random().toString(36).slice(2, 6);
        const newProductId =
          "p" + number + "-" + Math.random().toString(36).slice(2, 6);
        this.blobs[versionId] = {
          raw: result.rawBlob,
          blend: result.blendBlob,
        };
        this.storeFile(versionId + "/raw", result.rawBlob);
        this.storeFile(versionId + "/blend", result.blendBlob);
        newProducts[newProductId] = {
          id: newProductId,
          regionId: (region.partIds || [region.id])[0],
          regionIds: region.partIds || [region.id],
          regionLabel: region.label,
          regionKind: region.kind,
          regionMask: region.mask,
          maskW: scan.width,
          maskH: scan.height,
          item: item,
          notes: noteText,
          versionId: versionId,
          versionNumber: number,
          measure: null,
          override: {},
          rate: 0,
          status: measuring ? "estimating" : "ready",
          renderedDescription: "",
        };
        this.storeFile("mask/" + newProductId, region.mask);
        newVersions.push({
          id: versionId,
          number: number,
          parentId: base.id,
          title: item ? item.name : "Custom edit",
          subtitle: region.label,
          rawUrl: this.track(URL.createObjectURL(result.rawBlob)),
          blendUrl: this.track(URL.createObjectURL(result.blendBlob)),
          view: result.framingWarning || !surfaceLike ? "raw" : "blend",
          isOriginal: false,
          framingWarning: result.framingWarning,
          width: base.width,
          height: base.height,
          productIds: keepProducts.concat([newProductId]),
          request: {
            model: result.model,
            location: settings.location,
            aspectRatio: prepared.aspectRatio,
            imageSize: prepared.imageSize,
            regionLabel: region.label,
            regionKind: region.kind,
            itemName: item ? item.name : "",
            mode: item ? item.mode : "custom",
            style: style,
            notes: noteText,
            box: prepared.box,
            polygon: prepared.polygon,
            systemPrompt: prepared.systemPrompt,
            prompt: prepared.brief,
            inputSize: prepared.inputSize,
            outputSize: result.rawWidth + " x " + result.rawHeight,
            durationMs: result.durationMs,
            attempt: result.attempt,
            modelText: result.modelText,
            usage: result.usage,
            basedOn: base.isOriginal ? "Original" : "Version " + base.number,
          },
        });
      }
      if (newVersions.length > 0) {
        this.set({
          products: Object.assign({}, this.state.products, newProducts),
          versions: this.state.versions.concat(newVersions),
          currentId: newVersions[0].id,
        });
        if (
          newVersions.some(function (entry) {
            return entry.framingWarning;
          })
        ) {
          this.toast(
            'The render changed more than the selected surface, so the full output is shown. Switch to "Selection only" to lock it to the mask.',
            "info",
          );
        }
        if (newVersions.length > 1) {
          this.toast(
            newVersions.length + " options are ready in the versions strip.",
            "success",
          );
        }
        if (measuring) {
          this.estimate(Object.keys(newProducts), newVersions[0], region, item);
        }
        this.makeThumb(newVersions[0].blendUrl)
          .then(function (thumb) {
            studio.storeFile("thumb", thumb);
          })
          .catch(function () {});
      }
      if (controller.signal.aborted) {
        this.toast("Render cancelled.", "info");
      } else if (problems.length > 0) {
        this.fail("Render", problems[0]);
      }
    } catch (error) {
      if (error && error.name === "AbortError") {
        this.toast("Render cancelled.", "info");
      } else {
        this.fail("Render", error);
      }
    } finally {
      releasePrepared(prepared);
      this.set({ render: null });
    }
  }

  cancelRender() {
    const render = this.state.render;
    if (render && render.controller) {
      render.controller.abort();
    }
  }

  changeView(view) {
    const version = this.version();
    if (!version || version.isOriginal) {
      return;
    }
    this.set({
      versions: this.state.versions.map(function (entry) {
        return entry.id === version.id
          ? Object.assign({}, entry, { view: view })
          : entry;
      }),
    });
  }

  stepVersion(direction) {
    const versions = this.state.versions;
    const version = this.version();
    if (versions.length < 2 || !version) {
      return;
    }
    const index = versions.findIndex(function (entry) {
      return entry.id === version.id;
    });
    const next =
      versions[Math.min(versions.length - 1, Math.max(0, index + direction))];
    if (next) {
      this.set({ currentId: next.id, compare: false });
    }
  }

  selectVersion(id) {
    this.set({ currentId: id, compare: false });
  }

  // ------------------------------------------------------------------ exports
  fileBase() {
    const photo = this.state.photo;
    return (photo && slugify(photo.name.replace(/\.[^.]+$/, ""))) || "room";
  }

  async exportAs(kind) {
    const version = this.version();
    const photo = this.state.photo;
    if (!version) {
      return;
    }
    const parent = this.parentOf(version);
    this.set({ shareBusy: kind });
    try {
      const name = version.isOriginal
        ? "original"
        : "v" +
          version.number +
          "-" +
          slugify(version.title + " " + version.subtitle);
      let outcome = "";
      if (kind === "image") {
        const blobs = this.blobs[version.id] || {};
        let blob =
          version.view === "raw" || version.isOriginal
            ? blobs.raw
            : blobs.blend || blobs.raw;
        if (!blob) {
          blob = await (
            await fetch(displayUrl(version), { credentials: "same-origin" })
          ).blob();
        }
        outcome = await shareOrDownload(
          blob,
          this.fileBase() + "-" + name + ".jpg",
          photo ? roomName(photo.name) : "Room",
        );
      } else if (kind === "pair" && parent) {
        const blob = await beforeAfterImage(
          displayUrl(parent),
          displayUrl(version),
          version.title,
        );
        outcome = await shareOrDownload(
          blob,
          this.fileBase() + "-" + name + "-before-after.jpg",
          "Before and after",
        );
      } else if (kind === "board") {
        const original = this.state.versions[0];
        const blob = await designBoard({
          beforeUrl: displayUrl(original),
          afterUrl: displayUrl(version),
          products: this.versionProducts(version),
          title: photo ? roomName(photo.name) : "Design board",
          areaUnit: this.settings.areaUnit,
        });
        outcome = await shareOrDownload(
          blob,
          this.fileBase() + "-" + name + "-board.jpg",
          "Design board",
        );
      } else if (kind === "csv") {
        const blob = new Blob(
          ["﻿" + materialsCsv(this.versionProducts(version))],
          {
            type: "text/csv;charset=utf-8",
          },
        );
        outcome = await shareOrDownload(
          blob,
          this.fileBase() + "-" + name + "-materials.csv",
          "Materials",
        );
      }
      if (outcome === "downloaded") {
        this.toast("Saved to your downloads.", "success");
      }
    } catch (error) {
      this.fail("Export", error);
    } finally {
      this.set({ shareBusy: "" });
    }
  }

  // ------------------------------------------------------------------ settings dialog
  async runChecks() {
    this.ui.settings = Object.assign({}, this.ui.settings, {
      checking: true,
      checks: [],
    });
    this.requestRender();
    try {
      const answer = await postJson("/check", this.settings);
      // Real model names and server details go to the console; the page shows scrubbed text.
      const results = answer.results || [];
      console.info("[swatchroom] health check:", results);
      this.ui.settings = Object.assign({}, this.ui.settings, {
        checks: results.map(function (entry) {
          return Object.assign({}, entry, {
            name: publicText(entry.name),
            detail: publicText(entry.detail),
          });
        }),
      });
    } catch (error) {
      this.ui.settings = Object.assign({}, this.ui.settings, {
        checks: [
          { name: "Swatchroom server", status: "error", detail: error.message },
        ],
      });
    } finally {
      this.ui.settings = Object.assign({}, this.ui.settings, {
        checking: false,
      });
      this.requestRender();
    }
  }


  // ------------------------------------------------------------------ keyboard
  keyDown(event) {
    if (!this.root.isConnected) {
      return;
    }
    const state = this.state;
    const region = this.selectedRegion();
    const version = this.version();
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      if (region && !state.render) {
        event.preventDefault();
        this.startRender();
      }
      return;
    }
    if (
      isTyping(event.target) ||
      document.querySelector("swatchroom-app dialog[open]")
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === "y") {
      event.preventDefault();
      this.redo();
      return;
    }
    if (event.key === "Escape") {
      if (state.tool !== "select") {
        this.changeTool("select");
      } else if (state.compare) {
        this.set({ compare: false });
      } else if (this.validIds().length > 0) {
        this.set({ selectedIds: [] });
      }
      return;
    }
    if (event.key === "Enter") {
      if (state.tool === "pick" && state.pick.preview) {
        event.preventDefault();
        this.acceptPick(false);
      } else if (state.tool === "outline") {
        event.preventDefault();
        this.finishOutline();
      }
      return;
    }
    if (event.key === "Backspace" && state.tool === "outline") {
      event.preventDefault();
      this.set({ outlinePoints: state.outlinePoints.slice(0, -1) });
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const scan = state.scan;
    if (key === "v") {
      this.changeTool("select");
    }
    if (key === "w" && scan && !state.render) {
      this.changeTool("pick");
    }
    if (key === "b" && scan && !state.render) {
      this.changeTool("brush");
    }
    if (key === "l" && scan && !state.render) {
      this.changeTool("outline");
    }
    if (key === "m" && scan) {
      this.set({ showMap: !state.showMap });
    }
    if (key === "c" && this.parentOf(version)) {
      this.set({ compare: !state.compare });
    }
    if (key === "a" && region) {
      this.selectAllOfKind();
    }
    if (key === "p" && state.photo) {
      this.set({ dialog: "materials" });
    }
    if (key === "[") {
      this.stepVersion(-1);
    }
    if (key === "]") {
      this.stepVersion(1);
    }
    if (key === "?") {
      this.set({ dialog: "shortcuts" });
    }
    if (key === "/") {
      const search = this.root.querySelector('[data-search="finishes"]');
      if (search) {
        event.preventDefault();
        search.focus();
      }
    }
  }

  // ------------------------------------------------------------------ drag and drop
  onDragOver(event) {
    if (
      event.dataTransfer &&
      Array.prototype.indexOf.call(event.dataTransfer.types, "Files") !== -1
    ) {
      event.preventDefault();
      if (!this.state.dragOver) {
        this.set({ dragOver: true });
      }
    }
  }

  onDrop(event) {
    event.preventDefault();
    this.set({ dragOver: false });
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) {
      this.addPhoto(file);
    }
  }

  // ------------------------------------------------------------------ finishes panel state
  // The search and the tab reset when another surface or kind is chosen; the panel scrolls
  // back to the top so the first finishes show.
  syncFinishPanel(region, kind) {
    const key = region ? region.id + "|" + kind : "";
    if (key !== this.lastFinishKey) {
      this.lastFinishKey = key;
      this.ui.finishQuery = "";
      this.ui.finishTab = "All";
      this.pendingFinishScroll = "top";
    }
  }

  applyFinishScroll() {
    const mode = this.pendingFinishScroll;
    if (!mode) {
      return;
    }
    this.pendingFinishScroll = "";
    this.root
      .querySelectorAll('[data-scroll="finishes"]')
      .forEach(function (box) {
        box.scrollLeft = 0;
        if (mode === "tab") {
          const tools = box.querySelector("[data-finish-tools]");
          box.scrollTop =
            tools && box.contains(tools) && box.classList.contains("is-column")
              ? Math.min(box.scrollTop, tools.offsetTop)
              : 0;
        } else {
          box.scrollTop = 0;
        }
      });
  }

  // ------------------------------------------------------------------ render
  hint() {
    const state = this.state;
    const coarse = state.coarse;
    if (!state.photo) {
      return "Add a room photo to begin.";
    }
    if (state.scanState.status === "running") {
      return "Mapping surfaces. The first scan loads the detection model on the server; later scans are quicker.";
    }
    if (state.tool === "outline") {
      return coarse
        ? "Outline: tap points around the surface, then Finish."
        : "Outline: click points around the surface, Enter or double-click to finish, Esc to cancel.";
    }
    if (state.tool === "brush") {
      return "Brush: drag to add or erase pixels on the selected surface. Ctrl+Z undoes.";
    }
    if (state.tool === "pick") {
      return coarse
        ? "Pick: tap inside the thing you want."
        : "Pick: click inside the thing you want, Shift-click to exclude. Enter keeps it.";
    }
    if (state.compare) {
      return "Drag the divider to compare. C or Esc leaves compare.";
    }
    if (state.render) {
      return (
        "Rendering with " +
        this.modelName() +
        ". You can keep browsing versions."
      );
    }
    if (this.selectedRegion()) {
      return coarse
        ? "Pick a finish and render. Long-press another surface to add it."
        : "Pick a finish and render (Ctrl+Enter). Shift-click adds surfaces, A selects every surface of this kind.";
    }
    if (state.scan && state.scan.regions.length > 0) {
      return coarse
        ? "Tap a surface to restyle it. Pinch to zoom."
        : "Click a surface to restyle it. Scroll to zoom, Space-drag to pan.";
    }
    if (
      state.scanState.status === "error" ||
      state.scanState.status === "empty"
    ) {
      return "Scan again, or mark surfaces by hand with Pick or Outline.";
    }
    return "";
  }

  render() {
    const studio = this;
    const state = this.state;
    const settings = this.settings;
    const session = this.app.session || {};
    const google = session.google || {};
    const layout = state.layout;
    const narrow = layout.mode === "narrow";
    const wide = layout.mode === "wide";
    const coarse = state.coarse;
    const photo = state.photo;
    const version = this.version();
    const parent = this.parentOf(version);
    const scan = state.scan;
    const validIds = this.validIds();
    const selectedRegion = this.selectedRegion();
    const selectedRegions = validIds
      .map(function (id) {
        return scan.regions.find(function (region) {
          return region.id === id;
        });
      })
      .filter(Boolean);
    const catalogKind = this.catalogKind();
    const versionProducts = this.versionProducts(version);
    const productsByRegion = {};
    const productRegions = {};
    versionProducts.forEach(function (product) {
      (product.regionIds || [product.regionId]).forEach(function (id) {
        if (id) {
          productsByRegion[id] = product;
          productRegions[id] = productName(product);
        }
      });
    });
    let currentProduct = null;
    if (validIds.length > 0) {
      const first = productsByRegion[validIds[0]];
      if (
        first &&
        validIds.every(function (id) {
          return productsByRegion[id] === first;
        })
      ) {
        currentProduct = first;
      }
    }
    const busy = !!state.render;
    const modelName = this.modelName();
    const showFinishes =
      !!selectedRegion && (state.tool === "select" || state.tool === "brush");
    const shortScreen = layout.height > 0 && layout.height < 560;
    const hint = this.hint();
    if (selectedRegion) {
      this.syncFinishPanel(selectedRegion, catalogKind);
    } else {
      this.syncFinishPanel(null, "");
    }

    // ---------------------------------------------------------------- instant preview (fast render in the browser;
    // see ensureFusion() above, lib/previewScene.js and stage.js's maybeFastRender()). rendererAvailable is passed as true
    // here because stage.js already degrades safely on its own when neither WebGPU nor WebGL2 exists.
    //
    // It paints on the next frame after a surface is tapped and a finish picked, with no network request when the texture
    // is in memory, and it NEVER starts an AI render: that is startRender(), reached only from the Render button and
    // Ctrl/Cmd+Enter. Before the room has been analysed in 3D the scene is an estimate made from the scan's outlines
    // (provisional, marked "flagged"); when the analysis arrives it is replaced by the real planes in place.
    const fastEnabled = !engineForcesGeminiOnly(settings);
    const fused =
      this.fastScenePayload &&
      this.fastScenePayload.roomId === state.roomId &&
      this.fastScenePayload.versionId === state.currentId
        ? this.fastScenePayload
        : null;
    let fastScene = null;
    if (fastEnabled && scan && version && scan.regions.length > 0) {
      fastScene = this.sceneComposer.compose(scan, fused, this.photoLightFor(scan), settings.fusionLowThreshold);
    }
    let fastMaterial = null;
    if (fastScene && !busy && validIds.length === 1 && selectedRegion && state.itemId) {
      const previewItem = findItem(state.itemId);
      const regionFusion = fastScene.fusionRegions[selectedRegion.id];
      const confidence = regionFusion ? regionFusion.confidence : NaN;
      if (canUseFastRender(true, confidence, previewItem, settings)) {
        fastMaterial = {
          regionId: selectedRegion.id,
          item: previewItem,
          rotation: 0,
          // the surface's own mask: SAM-sharpened, with rugs / furniture / pictures cut out (calibrateSelection)
          mask: selectedRegion.mask,
        };
      }
    }
    const fastPrefetch = fastScene && selectedRegion ? this.prefetchUrls(catalogKind) : null;

    // ---------------------------------------------------------------- top bar
    const menuItems = [
      {
        label: "New photo",
        icon: icon("image-plus", 16),
        onSelect: function () {
          studio.choosePhoto();
        },
      },
      {
        label: "Take a photo",
        icon: icon("camera", 16),
        hidden: !coarse,
        onSelect: function () {
          studio.takePhoto();
        },
      },
      {
        label: "Saved rooms",
        icon: icon("folder-open", 16),
        onSelect: function () {
          studio.refreshRooms();
          studio.set({ dialog: "rooms" });
        },
      },
      {
        label: "Materials",
        icon: icon("clipboard-list", 16),
        hidden: !photo || !narrow,
        onSelect: function () {
          studio.set({ dialog: "materials" });
        },
      },
      {
        label: state.immersive ? "Exit full screen" : "Full screen",
        icon: icon(state.immersive ? "minimize-2" : "maximize-2", 16),
        hidden: wide,
        onSelect: function () {
          studio.set({ immersive: !state.immersive });
        },
      },
      {
        label: "Keyboard shortcuts",
        icon: icon("keyboard", 16),
        hint: "?",
        hidden: coarse,
        onSelect: function () {
          studio.set({ dialog: "shortcuts" });
        },
      },
      {
        label: "Settings",
        icon: icon("settings", 16),
        hidden: !narrow,
        onSelect: function () {
          studio.set({ dialog: "settings" });
        },
      },
      { divider: true, key: "divider-1", hidden: !session.passcodeRequired },
      {
        label: "Sign out",
        icon: icon("log-out", 16),
        hidden: !session.passcodeRequired,
        onSelect: function () {
          studio.app.signOut();
        },
      },
    ];

    const bar = h(
      "header",
      { class: "sr-bar" },
      h(
        "button",
        {
          type: "button",
          class: "sr-wordmark sr-wordmark-button",
          title: photo ? "Back to rooms" : null,
          onclick: photo
            ? function () {
                studio.closeRoom();
              }
            : null,
        },
        "Swatch",
        h("em", null, "room"),
      ),
      photo && !narrow
        ? h(
            "span",
            { class: "sr-bar-file sr-truncate", title: photo.name },
            roomName(photo.name),
          )
        : null,
      photo && narrow && version
        ? h(
            "button",
            {
              type: "button",
              class: "sr-version-chip",
              "aria-label": "Versions, showing " + versionLabel(version),
              onclick: function () {
                studio.set({ dialog: "versions" });
              },
            },
            h("span", { class: "sr-truncate" }, versionLabel(version)),
            state.versions.length > 1
              ? h(
                  "span",
                  { class: "sr-count-pill" },
                  String(state.versions.length),
                )
              : null,
            icon("chevron-down", 14),
          )
        : null,
      h("span", { class: "sr-bar-spacer" }),
      !narrow
        ? h(
            "span",
            {
              class: cx("sr-connection", !google.configured && "is-off"),
              title: google.configured
                ? "AI rendering is connected"
                : "AI rendering is not set up on the server",
            },
            h("span", { class: "sr-connection-dot", "aria-hidden": "true" }),
            h(
              "span",
              { class: "sr-truncate" },
              google.configured ? "AI connected" : "AI off",
            ),
          )
        : null,
      photo && !narrow
        ? h(
            "button",
            {
              type: "button",
              class: "sr-button sr-button-quiet sr-button-bar",
              onclick: function () {
                studio.choosePhoto();
              },
            },
            icon("image-plus", 16),
            " New photo",
          )
        : null,
      photo
        ? h(
            "button",
            {
              type: "button",
              class: narrow
                ? "sr-icon-button"
                : "sr-button sr-button-quiet sr-button-bar",
              "aria-label": this.shareFiles ? "Share" : "Export",
              onclick: function () {
                studio.set({ dialog: "share" });
              },
            },
            icon("share-2", 16),
            !narrow ? (this.shareFiles ? " Share" : " Export") : null,
          )
        : null,
      !narrow
        ? h(
            "button",
            {
              type: "button",
              class: cx(
                "sr-icon-button",
                state.errorLog.length > 0 && "has-dot",
              ),
              "aria-label": "Settings",
              onclick: function () {
                studio.set({ dialog: "settings" });
              },
            },
            icon("settings", 18),
          )
        : null,
      menu({
        id: "more",
        label: "More",
        icon: icon("ellipsis", 18),
        items: menuItems,
        open: this.ui.menuOpen === "more",
        onToggle: function (open) {
          studio.setUi({ menuOpen: open ? "more" : "" });
        },
        buttonClass: cx(
          "sr-icon-button",
          narrow && state.errorLog.length > 0 && "has-dot",
        ),
      }),
    );

    // ---------------------------------------------------------------- floating controls
    const stageChildren = [];
    if (version) {
      stageChildren.push(
        stageToolbar({
          layout: layout.mode,
          version: version,
          canCompare: !!parent,
          compare: state.compare,
          onToggleCompare: function () {
            studio.set({ compare: !state.compare });
          },
          onViewChange: function (view) {
            studio.changeView(view);
          },
          onInspect: function () {
            if (version.request) {
              studio.set({ inspectId: version.id });
            }
          },
          parentLabel: parent
            ? parent.isOriginal
              ? "the original"
              : "v" + parent.number
            : "",
          productCount: versionProducts.length,
          onOpenMaterials: function () {
            studio.set({ dialog: "materials" });
          },
        }),
      );
    }
    if (parent && !state.compare) {
      stageChildren.push(
        peekButton({
          active: state.peek,
          parentLabel: parent.isOriginal ? "the original" : "v" + parent.number,
          onPeek: function (value) {
            if (studio.state.peek !== value) {
              studio.set({ peek: value });
            }
          },
        }),
      );
    }
    if (state.render) {
      stageChildren.push(
        renderProgress({
          render: state.render,
          raised: state.tool !== "select",
          modelName: modelName,
          onCancel: function () {
            studio.cancelRender();
          },
        }),
      );
    }
    stageChildren.push(
      toolOptions({
        tool: state.tool,
        coarse: coarse,
        selectedLabel:
          validIds.length === 1 && selectedRegion ? selectedRegion.label : "",
        brushMode: state.brushMode,
        onBrushMode: function (mode) {
          studio.set({ brushMode: mode });
        },
        brushSize: state.brushSize,
        onBrushSize: function (size) {
          studio.set({ brushSize: size });
        },
        onUndo: function () {
          studio.undo();
        },
        onRedo: function () {
          studio.redo();
        },
        canUndo: this.undoStack.length > 0,
        canRedo: this.redoStack.length > 0,
        pick: state.pick,
        pickExclude: state.pickExclude,
        onPickExclude: function (value) {
          studio.set({ pickExclude: value });
        },
        onPickAccept: function () {
          studio.acceptPick(false);
        },
        onPickReplace: function () {
          studio.acceptPick(true);
        },
        onPickUndo: function () {
          studio.updatePick(state.pick.points.slice(0, -1));
        },
        outlinePoints: state.outlinePoints,
        onOutlineUndo: function () {
          studio.set({ outlinePoints: state.outlinePoints.slice(0, -1) });
        },
        onOutlineFinish: function () {
          studio.finishOutline();
        },
        onCancel: function () {
          studio.changeTool("select");
        },
      }),
    );
    if (state.hdScan && !state.render) {
      stageChildren.push(
        h(
          "div",
          { key: "hd-banner", class: "sr-hd-banner", role: "status" },
          h("span", { class: "sr-hd-dot", "aria-hidden": "true" }),
          h(
            "button",
            {
              type: "button",
              class: "sr-hd-banner-apply",
              style: { flex: "1", border: "0", background: "transparent", textAlign: "left", padding: "0" },
              onclick: function () {
                studio.applyHdScan(null, false);
              },
            },
            "HD Surface Scan Ready (Higher Accuracy) - Tap to Apply",
          ),
          h(
            "button",
            {
              type: "button",
              class: "sr-hd-banner-dismiss",
              "aria-label": "Dismiss",
              onclick: function () {
                studio.dismissHdScan();
              },
            },
            icon("x", 16),
          ),
        ),
      );
    }
    stageChildren.push(
      toasts(state.toasts, function (id) {
        studio.dismissToast(id);
      }),
    );

    // ---------------------------------------------------------------- panels
    const finishesProps = {
      region: selectedRegion,
      selectedRegions: selectedRegions,
      onToggleRegion: function (id) {
        studio.selectRegion(id, true);
      },
      catalogKind: catalogKind,
      short: shortScreen,
      onCatalogKindChange: function (kind) {
        studio.changeCatalogKind(kind);
      },
      itemId: state.itemId,
      onSelectItem: function (id) {
        studio.set({ itemId: studio.state.itemId === id ? null : id });
      },
      customColors: state.customColors,
      onAddCustomColor: function (hex) {
        studio.addCustomColour(hex);
      },
      recentIds: state.recentIds,
      currentProduct: currentProduct,
      onOpenProduct: function (id) {
        studio.set({ productId: id });
      },
      productHeadline: function (product) {
        return productHeadline(product, settings.areaUnit);
      },
      onClose: function () {
        studio.set({ selectedIds: [] });
      },
      notes: this.currentNotes(),
      onNotesChange: function (text) {
        const next = Object.assign({}, studio.state.notes);
        next[studio.selectionKey()] = text;
        studio.set({ notes: next });
      },
      style: state.style,
      onStyleChange: function (value) {
        studio.set({ style: value });
      },
      optionCount: state.optionCount,
      onOptionCountChange: function (value) {
        studio.set({ optionCount: value });
      },
      onRender: function () {
        studio.startRender();
      },
      rendering: busy,
      scanReady: !!scan,
      coarse: coarse,
      modelName: modelName,
      baseLabel: version
        ? version.isOriginal
          ? "the original photo"
          : "version " + version.number
        : "",
      query: this.ui.finishQuery,
      tab: this.ui.finishTab,
      onQuery: function (text) {
        studio.ui.finishQuery = text;
        studio.ui.finishTab = "All";
        studio.requestRender();
      },
      onTab: function (name) {
        studio.ui.finishTab = name;
        studio.pendingFinishScroll = "tab";
        studio.requestRender();
      },
    };

    const surfacesProps = {
      hasPhoto: !!photo,
      scan: scan,
      scanState: state.scanState,
      hoverId: state.hoverId,
      selectedIds: validIds,
      onHover: function (id) {
        if (studio.state.hoverId !== id) {
          studio.set({ hoverId: id });
        }
      },
      onSelect: function (id, additive) {
        studio.toggleSurfaceFromList(id, additive);
      },
      onSelectMany: function (ids) {
        studio.applySelection(ids);
      },
      onRescan: function () {
        studio.rescan();
      },
      tool: state.tool,
      onTool: function (tool) {
        studio.changeTool(tool);
      },
      showMap: state.showMap,
      onToggleMap: function () {
        studio.set({ showMap: !state.showMap });
      },
      busy: busy,
      productRegions: productRegions,
      hideSmall: settings.hideSmallSurfaces,
      coarse: coarse,
      onUndo: function () {
        studio.undo();
      },
      onRedo: function () {
        studio.redo();
      },
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      showSmall: this.ui.showSmall,
      onToggleSmall: function () {
        studio.setUi({ showSmall: !studio.ui.showSmall });
      },
    };

    // phone sheet sizes
    const barHeight = 52;
    const finishesPeek = 286;
    const surfacesPeek =
      state.scanState.status === "running"
        ? 168
        : scan && scan.regions.length > 0
          ? 214
          : 176;
    const sheetMode = showFinishes ? "finishes" : "surfaces";
    const peekHeight = sheetMode === "finishes" ? finishesPeek : surfacesPeek;
    const fullHeight = Math.max(
      peekHeight + 60,
      layout.height - barHeight - 56,
    );

    let sheetNode = null;
    if (narrow && photo) {
      const onExpandedChange = function (value) {
        studio.set({ sheetExpanded: value });
      };
      if (sheetMode === "finishes") {
        this.sheet.update({
          label: "Finishes",
          expanded: state.sheetExpanded,
          onExpandedChange: onExpandedChange,
          peekHeight: peekHeight,
          fullHeight: fullHeight,
          header: finishHeader({
            region: selectedRegion,
            subtitle:
              validIds.length > 1
                ? validIds.length + " surfaces"
                : (selectedRegion.areaShare * 100).toFixed(
                    selectedRegion.areaShare < 0.1 ? 1 : 0,
                  ) + "% of frame",
            kind: catalogKind,
            multi: validIds.length > 1,
            onKindChange: function (kind) {
              studio.changeCatalogKind(kind);
            },
            onClose: function () {
              studio.set({ selectedIds: [] });
            },
            editingShape: state.tool === "brush",
            onEditShape:
              validIds.length === 1 && !selectedRegion.isUnion
                ? function () {
                    studio.changeTool(
                      studio.state.tool === "brush" ? "select" : "brush",
                    );
                  }
                : null,
          }),
          footer: renderButton(
            finishesProps,
            state.itemId ? findItem(state.itemId) : null,
          ),
          body: finishesView(
            Object.assign({}, finishesProps, {
              variant: state.sheetExpanded ? "expanded" : "peek",
            }),
          ),
        });
      } else {
        this.sheet.update({
          label: "Surfaces",
          expanded: state.sheetExpanded,
          onExpandedChange: onExpandedChange,
          peekHeight: peekHeight,
          fullHeight: fullHeight,
          header: h(
            "div",
            { class: "sr-sheet-title-row" },
            h(
              "div",
              { class: "sr-sheet-titles" },
              h(
                "h2",
                { class: "sr-sheet-title" },
                "Surfaces",
                scan && scan.regions.length > 0
                  ? h(
                      "span",
                      { class: "sr-count" },
                      String(scan.regions.length),
                    )
                  : null,
              ),
              h("span", { class: "sr-sheet-subtitle sr-truncate" }, hint),
            ),
          ),
          footer: null,
          body: surfacesView(
            Object.assign({}, surfacesProps, {
              variant: state.sheetExpanded ? "column" : "peek",
            }),
          ),
        });
      }
      sheetNode = this.sheet.element;
    }

    let rightPanel = null;
    if (layout.mode === "medium" && photo) {
      rightPanel = h(
        "aside",
        {
          key: "panel-right",
          class: "sr-panel sr-panel-right",
          "aria-label": showFinishes ? "Finishes" : "Surfaces",
        },
        showFinishes
          ? finishesView(
              Object.assign({}, finishesProps, { variant: "column" }),
            )
          : surfacesView(
              Object.assign({}, surfacesProps, { variant: "column" }),
            ),
      );
    } else if (wide && showFinishes) {
      rightPanel = h(
        "aside",
        {
          key: "panel-right",
          class: "sr-panel sr-panel-right",
          "aria-label": "Finishes",
        },
        finishesView(Object.assign({}, finishesProps, { variant: "column" })),
      );
    }

    // ---------------------------------------------------------------- stage
    let stageNode = null;
    if (photo && version) {
      this.stage.update({
        layout: layout.mode,
        // Matches .is-medium .sr-panel-right in swatchroom.css (width + its 12px margins).
        rightInset: Math.min(360, Math.max(280, layout.width * 0.38)) + 24,
        coarse: coarse,
        imageUrl: displayUrl(version),
        imageWidth: photo.width,
        imageHeight: photo.height,
        fitSignal: state.roomId,
        versionLabel: version.isOriginal
          ? "Original photo"
          : "Version " + version.number + ", " + version.title,
        compareUrl: parent ? displayUrl(parent) : "",
        compareLabel: parent
          ? parent.isOriginal
            ? "Original"
            : "v" + parent.number
          : "",
        compare: state.compare,
        peek: state.peek,
        scan: scan,
        sprites: this.sprites(),
        hoverId: state.hoverId,
        selectedIds: validIds,
        onHover: function (id) {
          if (studio.state.hoverId !== id) {
            studio.set({ hoverId: id });
          }
        },
        onSelect: function (id, additive, point) {
          studio.noteTap(point);
          studio.selectRegion(id, additive);
        },
        showMap: state.showMap,
        tool: state.tool,
        brushMode: state.brushMode,
        brushSize: state.brushSize,
        onBrushStroke: function (mask, mode) {
          studio.brushStroke(mask, mode);
        },
        outlinePoints: state.outlinePoints,
        onOutlinePoint: function (point) {
          studio.set({
            outlinePoints: studio.state.outlinePoints.concat([point]),
          });
        },
        onOutlineFinish: function () {
          studio.finishOutline();
        },
        pickPoints: state.pick.points,
        pickPreview: state.pick.preview,
        pickExclude: state.pickExclude,
        onPickTap: function (x, y, positive) {
          studio.pickTap(x, y, positive);
        },
        scanning: state.scanState.status === "running",
        scanStage: state.scanState.stage,
        productsByRegion: productsByRegion,
        productHeadline: function (product) {
          return productHeadline(product, settings.areaUnit);
        },
        productCategory: function (product) {
          return productSpec(product.item).category;
        },
        onOpenProduct: function (id) {
          studio.set({ productId: id });
        },
        fastEnabled: fastEnabled,
        fastScene: fastScene,
        fastMaterial: fastMaterial,
        fastPrefetch: fastPrefetch,
        children: stageChildren,
      });
      stageNode = this.stage.element;
    }

    const emptyProps = {
      coarse: coarse,
      rooms: state.rooms,
      roomsState: state.roomsState,
      roomsError: state.roomsError,
      openingId: state.openingRoomId,
      thumbUrl: function (roomId) {
        return fileUrl(roomId + "/thumb");
      },
      onFile: function (file) {
        studio.addPhoto(file);
      },
      onPick: function () {
        studio.choosePhoto();
      },
      onCamera: function () {
        studio.takePhoto();
      },
      onOpenRoom: function (id) {
        studio.openRoom(id);
      },
      onDeleteRoom: function (id) {
        studio.removeRoom(id);
      },
      dragging: this.ui.emptyDragging,
      onDragging: function (value) {
        studio.setUi({ emptyDragging: value });
      },
    };

    const body = h(
      "div",
      { class: "sr-body" },
      wide && photo
        ? h(
            "aside",
            {
              key: "panel-left",
              class: "sr-panel sr-panel-left",
              "aria-label": "Surfaces",
            },
            surfacesView(
              Object.assign({}, surfacesProps, { variant: "column" }),
            ),
          )
        : null,
      h(
        "section",
        { key: "center", class: "sr-center", "aria-label": "Photo" },
        h(
          "div",
          { class: "sr-stage" },
          !photo ? emptyStage(emptyProps) : null,
          stageNode,
          state.dragOver
            ? h(
                "div",
                { class: "sr-drop-veil" },
                "Drop to start with this photo",
              )
            : null,
        ),
        photo && !narrow
          ? versionsStrip({
              versions: state.versions,
              currentId: state.currentId,
              displayUrl: displayUrl,
              onSelect: function (id) {
                studio.selectVersion(id);
              },
              onShare: function () {
                studio.set({ dialog: "share" });
              },
              canShareFiles: this.shareFiles,
            })
          : null,
      ),
      rightPanel,
      sheetNode,
    );

    const status =
      !narrow && photo
        ? h(
            "footer",
            { class: "sr-status" },
            h("span", { class: "sr-status-hint" }, hint),
            h(
              "span",
              { class: "sr-status-meta" },
              state.scanState.model ? h("span", null, "Surfaces scanned") : null,
              h("span", null, "Renders by AI"),
            ),
          )
        : null;

    // ---------------------------------------------------------------- dialogs
    const inspectVersion =
      state.versions.find(function (entry) {
        return entry.id === state.inspectId;
      }) || null;
    const product = state.productId
      ? state.products[state.productId] || null
      : null;
    const dialogs = [
      settingsDialog(
        {
          open: state.dialog === "settings",
          settings: settings,
          server: session,
          errorLog: state.errorLog,
          fusionStatus: this.ui.fusion,
          fastRendererKind: this.stage.fastRenderer ? this.stage.fastRenderer.kind : null,
          onChange: function (next) {
            studio.app.setSettings(next);
            studio.requestRender();
          },
          onClose: function () {
            studio.set({ dialog: null });
          },
          onCheck: function () {
            studio.runChecks();
          },
          onForgetModels: function () {
            forgetResolvedModels()
              .then(function () {
                studio.toast(
                  "Model choices reset. The next request tries the newest model first.",
                  "info",
                );
              })
              .catch(function (error) {
                studio.fail("Settings", error);
              });
          },
          onSignOut: function () {
            studio.set({ dialog: null });
            studio.app.signOut();
          },
        },
        this.ui.settings,
        function (patch) {
          studio.ui.settings = Object.assign({}, studio.ui.settings, patch);
          studio.requestRender();
        },
      ),
      inspectorDialog(
        {
          version: inspectVersion,
          onClose: function () {
            studio.set({ inspectId: null });
          },
        },
        this.ui.inspector,
        function (patch) {
          studio.ui.inspector = Object.assign({}, studio.ui.inspector, patch);
          studio.requestRender();
        },
      ),
      shortcutsDialog({
        open: state.dialog === "shortcuts",
        onClose: function () {
          studio.set({ dialog: null });
        },
      }),
      productDialog(
        {
          product: product,
          onClose: function () {
            studio.set({ productId: null });
          },
          onChange: function (id, changes) {
            studio.changeProduct(id, changes);
          },
          areaUnit: settings.areaUnit,
          currency: settings.currency,
        },
        this.ui.product,
        function (patch) {
          studio.ui.product = Object.assign({}, studio.ui.product, patch);
          studio.requestRender();
        },
      ),
      materialsDialog({
        open: state.dialog === "materials" && !state.productId,
        onClose: function () {
          studio.set({ dialog: null });
        },
        products: versionProducts,
        areaUnit: settings.areaUnit,
        currency: settings.currency,
        versionLabel: version
          ? version.isOriginal
            ? "the original"
            : "v" + version.number
          : "",
        onOpenProduct: function (id) {
          studio.set({ productId: id });
        },
        onExportCsv: function () {
          studio.exportAs("csv");
        },
        onBoard: function () {
          studio.exportAs("board");
        },
      }),
      shareDialog({
        open: state.dialog === "share",
        onClose: function () {
          studio.set({ dialog: null });
        },
        canShareFiles: this.shareFiles,
        hasParent: !!parent,
        hasRenders: state.versions.length > 1,
        productCount: versionProducts.length,
        busy: state.shareBusy,
        onExport: function (kind) {
          studio.exportAs(kind);
        },
      }),
      versionsDialog({
        open: state.dialog === "versions",
        onClose: function () {
          studio.set({ dialog: null });
        },
        versions: state.versions,
        currentId: state.currentId,
        displayUrl: displayUrl,
        onSelect: function (id) {
          studio.selectVersion(id);
        },
      }),
      modal({
        key: "rooms",
        open: state.dialog === "rooms",
        onClose: function () {
          studio.set({ dialog: null });
        },
        title: "Saved rooms",
        titleId: "sr-rooms-title",
        size: "small",
        // Built only while the dialog is open: modal() draws nothing otherwise, but creating the list's <img> elements
        // starts their downloads, so a closed dialog would fetch every room's thumbnail again on every re-render.
        body:
          state.dialog !== "rooms"
            ? null
            : state.rooms.length === 0
              ? h(
                  "p",
                  { class: "sr-sheet-text" },
                  state.roomsState === "error"
                    ? "Saved rooms could not be loaded: " + state.roomsError
                    : "No saved rooms yet. Rooms are saved on the server automatically as you work.",
                )
              : emptyStage(Object.assign({}, emptyProps, { roomsOnly: true })),
      }),
    ];

    this.root.className = "swr-root";
    update(this.root, [
      h(
        "div",
        {
          key: "studio",
          class: cx(
            "sr-studio",
            "is-" + layout.mode,
            photo && "has-photo",
            showFinishes && "has-finishes",
            state.immersive && "is-immersive",
          ),
          style:
            narrow && photo ? { "--sr-sheet-peek": peekHeight + "px" } : null,
          ondragover: function (event) {
            studio.onDragOver(event);
          },
          ondragleave: function (event) {
            if (event.currentTarget === event.target) {
              studio.set({ dragOver: false });
            }
          },
          ondrop: function (event) {
            studio.onDrop(event);
          },
        },
        bar,
        body,
        status,
        this.fileInput,
        this.cameraInput,
        dialogs,
      ),
    ]);

    this.applyFinishScroll();
    const revealKey = state.currentId + "|" + state.versions.length;
    if (revealKey !== this.lastReveal) {
      this.lastReveal = revealKey;
      revealCurrentVersion(this.root);
    }
  }
}
