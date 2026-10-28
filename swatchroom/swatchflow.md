# Swatchflow — how Swatchroom actually works

This traces the full pipeline from "designer uploads a photo" to "designer sees a
re-rendered room", with exact file/line references. It answers the specific question
that keeps coming up: **when an image is generated, does Gemini get only the cut-out
patch of the target surface, or the whole photo?**

**Short answer: neither extreme.** Gemini always gets the *whole scene around the
target* — either the full (resized) photo, or, for small surfaces, a generous context
crop that's 1.6x the surface's bounding box and never smaller than half the frame —
plus a black/white pixel mask and (usually) a tinted "guide" image showing exactly
which pixels to touch. It never receives an isolated snippet with no surroundings,
because the model needs the room's perspective, lighting and neighbouring objects to
make a believable edit. Full detail in [Part 3](#part-3--rendering-what-exactly-gemini-sees).

---

## High-level map

```
Browser (public/js)                         Server (server/)                 Backends
──────────────────────                      ──────────────────              ─────────────────────
1. Upload photo
2. Scan (segmentation) ──POST /api/vision/segment──▶ vision.js ──forward──▶ Python model service
      scene.worker.js                                                         (SegFormer, SAM/Pick)
      + optionally                ──POST /api/ai/generate {task:"json"}──▶ ai.js ──▶ Vertex AI Gemini
        Gemini outlines
3. Designer selects a surface
   + picks a finish/product
4. Render  ────────────────────POST /api/ai/generate {task:"image"}─────▶ ai.js ──▶ Vertex AI Gemini
      render.js / framing.js                                                        (image model)
5. Align + paste output back
   onto the full-res photo
6. (optional) Measure/take-off ─POST /api/ai/generate {task:"json"}──────▶ ai.js ──▶ Vertex AI Gemini
```

Nothing calls Google directly from the browser. The browser only ever talks to the
Express server (`server/index.js`); the server holds the Google service-account key
and the Python model-service address, and the browser never sees either
(`server/routes/ai.js:1-9`, `server/routes/vision.js:1-10`).

---

## Part 1 — Segmentation ("Scan"): turning a photo into surfaces

Triggered by `Studio.runScan()` (`public/js/views/studio.js:850`). There are **two
engines**, chosen in Settings (`segmentationEngine`), each producing the same shape of
result — a `scan`: `{ width, height, labelMap (one region-index per pixel), regions[] }`
(`public/js/lib/regions.js:1-14`).

### 1a. `scene` (the default/recommended engine)

A two-source pipeline: a local pixel-classification model does the heavy lifting, and
Gemini (optional but on by default) adds semantic help it's good at and the local
model isn't.

1. **SegFormer, in the Python model service.** The browser downsizes the photo, JPEG
   encodes it, and POSTs it to `/api/vision/segment?model=b4`
   (`public/js/lib/vision.js:54-75` → `server/routes/vision.js:99-112`, which forwards
   the raw bytes as multipart to the FastAPI service at
   `MODEL_SERVICE_URL` (`python/app.py:92-113`)).
   `python/scene.py` runs **SegFormer-B4 fine-tuned on ADE20K** (150 classes: wall,
   floor, ceiling, sofa, window, curtain, ...). The image is tiled into overlapping
   512px windows (optionally mirrored for a second pass), each tile is classified,
   scores are averaged on a 4px grid, then upsampled back to full photo size
   band-by-band to keep memory small (`python/scene.py:69-188`). The result is a
   `classMap` (one ADE20K class id per pixel), gzip-packed and sent back
   (`python/app.py:104-113`).
2. **Gemini outlines, in parallel.** If `useGeminiAssist` is on, the *whole photo*
   (no mask) is sent to Gemini with a prompt asking it to outline every wall plane,
   the ceiling, floor, each window/door, and large furniture, as polygons normalised
   to 0–1000 (`public/js/lib/detect.js`, `OUTLINE_PROMPT`). This is a `task:"json"`
   call constrained by a JSON schema (`OUTLINE_SCHEMA`), so Gemini must return
   `[{ label, kind, polygon: [[y,x], ...] }]`. This step runs *concurrently* with the
   SegFormer call, not after it (`outlinesForNaming` is kicked off before
   `await segmentScene(...)`).
   The time this step takes is the time the model needs to *write* the polygons, so next to
   SegFormer the call uses a compact prompt (`ASSIST_OUTLINE_PROMPT`): 4-8 points for a
   wall/ceiling/floor/window/door (up to 16 for furniture), at most 16 items, largest first, an
   8192-token cap, and the scan stops waiting after 45 s (`ASSIST_DEADLINE_MS`): walls then
   stay in one piece and surfaces keep SegFormer's generic names, with a toast saying so. In
   this role the outlines only decide which wall plane a pixel belongs to and what a surface is
   called; the pixel-accurate edges come from SegFormer and the guided filter below. When the
   outlines ARE the surfaces (the Gemini-only engine, or the fallback when the model service is
   down) the detailed prompt (`OUTLINE_PROMPT`: 10-48 points, 24 items) is used as before.
3. **Combine, in a Web Worker** (`public/js/workers/scene.worker.js`), so the main
   thread stays responsive:
   - ADE20K's 150 classes are grouped into the 7 surface kinds the app understands
     (wall/floor/ceiling/window/door/furniture/other) — `groupForClass()`
     (`scene.worker.js:69-118`).
   - Specks are removed, then a **guided filter** (edge-aware blur guided by the
     photo's own luminance, like a smart feather) snaps each class boundary onto real
     photo edges (`scene.worker.js:237-373`), because SegFormer's native output is
     blocky.
   - **Walls are split into separate planes** using Gemini's wall outlines: each wall
     pixel is assigned to the smallest Gemini wall-polygon that contains it, then the
     assignment is flood-filled into any wall pixels Gemini's polygon missed
     (`scene.worker.js:625-747`, `splitWalls`). Without Gemini's help, SegFormer alone
     can't tell "left wall" from "back wall" — it only knows "this pixel is wall".
   - **Arbitration**: if a chunk of what SegFormer called floor/ceiling/wall is >60%
     inside a Gemini polygon of a *different* kind and <15% inside any same-kind
     polygon, it's recategorised (handles cases like a glossy floor reflection
     SegFormer mistakes for more floor, which Gemini's visual reasoning catches)
     (`scene.worker.js:749-827`).
   - **Naming**: each final region gets Gemini's label wherever a Gemini polygon
     overlaps it by IoU ≥ 0.3 (`scene.worker.js:909-1006`) — this is where "Wall" becomes
     "Back wall with window" or "Light oak floor".
   - If Gemini's call fails for any reason, none of this is fatal — the scan still
     returns, just with generic SegFormer labels and unsplit walls
     (`public/js/lib/detect.js:320-341`).

### 1b. `gemini` (Gemini does the segmentation itself, no local model at all)

Two flavours (`public/js/lib/detect.js:220-318`):
- **`polygon`** (recommended): the same `OUTLINE_PROMPT` as above, Gemini returns
  polygons directly, and those polygons *become* the regions (no SegFormer/SAM
  underneath).
- **`mask`** (legacy, `gemini-2.5-flash` only — this model line retired on Vertex AI
  20 Oct 2026 per the code's own fallback message, `detect.js:298-301`): Gemini returns
  a bounding box *and* a small PNG mask crop per detected item
  (`MASK_PROMPT`, `detect.js:24-25`; decoded in `boxPngMask`, `detect.js:119-166`).

If the chosen engine (`scene`) throws and `fallbackToGemini` is on, the app
transparently retries with `gemini`/`polygon` (`public/js/lib/detect.js:440-466`).

**In every engine, segmentation itself sends Gemini the full photo, never a mask or a
crop** — it has nothing to mask yet; masking is the *output* of this step, not an
input.

---

## Part 2 — From pixels to a product on a surface

Once a `scan` exists, the designer clicks a region (walls/floor/etc. are pre-colored
and hoverable via pre-rendered overlay sprites built once per scan —
`public/js/lib/sprites.js`), optionally unions several regions ("all walls"), and picks
a product/finish from the catalog, or writes custom notes. This is all client-side
state in `studio.js`; no network call happens here. The important structures built at
this stage and consumed later:
- `region.mask` — a `Uint8Array` the size of the scan, 1 inside the surface.
- `region.bbox`, `region.centroid`, `region.areaShare` — geometry used to decide
  cropping and to write the brief.
- `traceOutline()` turns the mask into a simplified polygon (Ramer-Douglas-Peucker,
  ≤48 points) for the brief (`public/js/lib/regions.js:860-894`).

---

## Part 3 — Rendering: what exactly Gemini sees

This is the core of `prepareRender()` / `renderOption()` in `public/js/lib/render.js`,
with cropping/alignment math in `public/js/lib/framing.js`. Walking it step by step for
one render:

### Step 1 — Pick a working resolution
The current photo **version** (could already be a previous render) is loaded and
downscaled to at most 2048px on the long side, or 4096px if the designer asked for a
4K output (`render.js:44-46`).

### Step 2 — Decide: crop, or send the whole photo?
`focusCrop()` (`framing.js:13-68`) looks at the target region's bounding box:
- If the box is **more than 22% of the frame's area**, or a context crop around it
  would end up covering **more than 82%** of the photo anyway → **no crop**. The whole
  photo is sent.
- Otherwise, a crop is built: centred on the surface, sized to **1.6× the surface's
  own width/height**, but never smaller than **50% of the full frame** in either
  dimension, matched to the photo's aspect ratio. If that surface is small and far
  away, the crop is then **upscaled** so its long side is at least 1280px, so the model
  isn't working from a tiny, blurry patch.

This means: small surfaces (a single window, a light switch panel) get *zoomed in with
generous surrounding context* — enough of the room stays visible that Gemini can read
perspective, light direction and what's in front of the surface — not an isolated cutout. Large surfaces (a whole wall, the floor)
get the full, undistorted photo because cropping would barely help resolution anyway
and would throw away context for no reason.

### Step 3 — Build the three images that get sent
1. **Image 1 — the photo** (or the crop of it), JPEG, quality 0.92
   (`render.js:115-120`).
2. **Image 2 — the mask**, PNG, pure black/white, at the exact same pixel dimensions
   as Image 1, generated by `maskCanvas()` (`public/js/lib/images.js:144-196`): white =
   edit this, black = leave alone. The mask is grown by ~0.4% of the image's short side
   so the edit reaches fully into corners instead of leaving a thin unedited rim.
3. **Image 3 — the "guide" image** (skipped only for the "lite" model, to save
   latency): the *same* photo/crop again, but with the masked area tinted magenta and
   its edge drawn in solid magenta (`guideImage()`, `framing.js:159-209`). This exists
   purely so the model has an unmistakable visual of the boundary, separate from the
   pure black/white mask which some models read less reliably as "this is a region",
   not "this is a watermark to draw".

All three are base64 `inlineData` parts in the Gemini request
(`render.js:115-140`).

### Step 4 — The text brief
`renderBrief()` (`public/js/lib/prompts.js:38-134`) writes out, in plain English:
image dimensions, whether Image 1 is a crop, the target's label and kind, its
bounding box in **both** normalised 0–1000 coordinates *and* actual pixels, its
outline polygon (if `sendPolygon` is on and it's not a crop), area share and centre
point, the task (`surface` replace / `add` / `restyle` / `remove` / `custom`, from
`MODE_TASKS`), the chosen product's name/sub-type/prompt text, any room-wide style
direction, and the designer's free-text notes. All coordinates are already
re-expressed relative to the crop by `boxInCrop()` / `polygonInCrop()` /
`regionFactsInCrop()` (`framing.js:101-156`) when a crop is used, so the model is never
told box numbers that refer to a region of the photo it can't see.

### Step 5 — The system prompt
`RENDER_SYSTEM_PROMPT` (`public/js/lib/prompts.js:3-24`) is sent once as
`systemInstruction`, not per-call text. It fixes the model's role ("architectural
visualisation retoucher") and ten numbered rules: edit only the masked area; respect
room geometry/perspective; match existing light and shadow; respect occlusion
(furniture in front stays in front); use realistic material scale; never draw the mask
or outline itself into the output; return the same framing/aspect ratio as Image 1;
use real-world scale cues (door ≈2.1m etc.); cover the target fully with crisp edges;
apply one consistent design across multi-part targets.

### Step 6 — The actual network call
`POST /api/ai/generate` with `{ task: "image", model, location, parts, brief,
systemPrompt, aspectRatio, imageSize }` (`render.js:160-171` →
`public/js/lib/ai.js:9-11`). On the server, `server/routes/ai.js:64-84` validates and
hands off to `vertex.imageBodies()` (`server/google/vertex.js:400-448`), which builds
the actual Vertex `generateContent` body:
```
{
  systemInstruction: { parts: [{ text: systemPrompt }] },
  contents: [{ role: "user", parts: [photo, mask, guide?, { text: brief }] }],
  generationConfig: {
    responseModalities: ["TEXT", "IMAGE"],
    imageConfig: { aspectRatio, imageSize }   // e.g. "4:3", "2K"
  }
}
```
and progressively simplifies it (drops `imageSize`, then `aspectRatio`, then merges
everything into one plain user turn) if the model rejects the richer shape with a 400
(`server/google/vertex.js:245-278`, `postWithVariants`). The server also walks a model
**fallback chain** — e.g. `gemini-nano-banana-2.1 → gemini-3.1-flash-image →
gemini-3.1-flash-lite-image` — if the requested model id 404s, and remembers the
working id for a week so later renders skip straight to it
(`server/google/vertex.js:29-66`, `280-316`). The server attaches the Google access
token (minted from the service-account key or GCP metadata server,
`server/google/token.js`) and calls
`POST https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`
(`server/google/vertex.js:74-94`). **The Google key never leaves the server; the
browser never sees it.**

### Step 7 — Turning Gemini's answer back into a photo
The response's last inline image part is decoded (`render.js:173-185`). Image models
routinely reframe slightly (crop a sliver, zoom 2-3%), so `alignOutput()`
(`framing.js:211-480`) runs a coarse-to-fine template match (comparing grayscale,
restricted to pixels *outside* the edited mask plus a margin from the photo border —
the parts that should be pixel-identical) across a small grid of scale/shift
candidates, then refines with local hill-climbing at increasing resolution, to find
exactly how the output maps back onto what was sent. `placeOutput()` then pastes the
aligned output back into **the full-resolution base canvas**, inside the crop
rectangle if one was used (`framing.js:483-511`) — so even though Gemini may have only
seen a crop, the final image is the original full photo with just that region
replaced.

### Step 8 — Two outputs are kept, not one
`blendIntoBase()` (`public/js/lib/images.js:220-264`) builds a **second**, more
conservative version: it takes the aligned/placed output and composites it onto the
original base photo through a *feathered* version of the mask (grown slightly, then
blurred), so pixels outside the mask are **guaranteed bit-identical** to the original
photo, immune to anything the model changed outside the mask despite the rules. Both
the raw placed result and this masked blend are saved as the two blobs for the new
version (`render.js:197-217`, `studio.js:1652-1657`).

So, concretely, to answer the motivating question again: **one render call sends 3
images (photo, mask, magenta guide) covering the same framing — either the whole
photo or a generous context crop — never a bare cutout of just the surface with
nothing around it.** The mask is what tells Gemini *which part* to change; the
surrounding, unmasked pixels are what let it match perspective, light and
neighbouring objects, and the system prompt explicitly forbids it from touching
anything outside the white mask area.

---

## Part 4 — Measurement / take-off (a third, smaller Gemini call)

After a render, if `estimateQuantities` is on, `measureSurface()`
(`public/js/lib/measure.js`) sends **two images** — the *rendered* photo and the
surface's mask (no magenta guide this time) — plus a prompt asking for a JSON
take-off: area in m², visible area, width/height/depth, a confidence level, the scale
cue used, and a short description of the applied product
(`public/js/lib/prompts.js:136-173`). This is a `task: "json"` call constrained by
`MEASURE_SCHEMA`, same `/api/ai/generate` endpoint, same server-side model-fallback and
request-simplification machinery as everything else that talks to Gemini.

---

## Part 5 — Why the server shapes requests the way it does (`server/google/vertex.js`)

A few things worth knowing if you're debugging a failed render or detection:
- **Model generations behave differently.** Gemini 2.x models still accept
  `temperature`/`thinkingBudget`; Gemini 3.x models use `thinkingLevel` and reject the
  old parameters outright. `isLegacyModel()` (`vertex.js:70-72`) branches the request
  body shape accordingly for every task type.
- **Every task builds a list of request bodies, richest first**, and the server walks
  down that list on a 400 (`postWithVariants`, `vertex.js:245-278`) — so a model that
  doesn't support, say, `imageSize: "4K"` still gets a usable response at `"2K"`, then
  without `imageConfig` at all, then as one plain user turn with the brief folded into
  the prompt text, before giving up.
- **429/5xx responses are retried** up to twice with a short backoff
  (1.5s, then 4s) before moving to the next body variant (`vertex.js:249-267`).
- **A 404 (model not available in this location) walks the fallback chain** to the
  next model id in `IMAGE_MODEL_CHAIN` / `TEXT_MODEL_CHAIN` / `PRO_IMAGE_CHAIN`
  (`vertex.js:21-38`, `280-316`), and remembers which id actually answered for 7 days
  so subsequent calls skip straight to it (until `/api/ai/forget-models` is called,
  which Settings exposes as "try the newest models again").
- **Every Vertex error is translated into a sentence a designer can act on** —
  "Enable aiplatform.googleapis.com...", "Link a billing account...", "Grant it the
  Vertex AI User role..." — rather than a raw Google error blob (`explainError()`,
  `vertex.js:96-167`).

---

## Part 6 — Measured timings (updated 2026-10-24)

The Modal figures in this section replace an earlier version that claimed "measured"
numbers (MoGe-2 cold 219.4s, Marigold-IID cold 266.7s, a 594.7s `HTTP 000` hang) which
do not match the actual Modal account history. That version was checked directly
against `modal app logs` (the real, complete log of this app's entire deployed life)
and `modal billing report` (live account billing) — no event resembling that 594.7s
hang or a 266.7s Marigold cold start exists anywhere in the real logs, and it appears
to have been fabricated rather than measured. It has been replaced below with figures
sourced directly from Modal. Full methodology, raw evidence, cost breakdown, and
recommendations live in `modal-latency-audit.md` (repo root) — this section is a
summary of that file.

The SegFormer/Gemini timings further down in this Part 6 were written in the same
prior pass as the fabricated Modal numbers and have **not** been independently
re-verified — treat them as unconfirmed, not as either correct or disproven, until
re-measured.

### Modal: SAM 3 / MoGe-2 / Marigold-IID (verified against real Modal logs + billing)

Deployed config (`modalBlueprint.py` in this repo; the copy at
`/Users/mayank/XTRA/modalDeployment/vision_stack.py` was identical until the GPU
fallbacks below, and only changes when it is deployed): `SCALEDOWN_S=300` (5 min idle →
scale to zero), `MIN_CONTAINERS=0`, GPU memory snapshots enabled (alpha feature). First
choice GPUs: L4 for MoGe-2 and Marigold-IID, L40S for SAM 3 - each now with an ordered
fallback list (see "GPU fallbacks and the owner's dot" below).

| Model | GPU | First-ever boot (snapshot build) | Normal cold start (snapshot restore) | Warm |
|---|---|---|---|---|
| SAM 3 | L40S | 24.7s | 5.8–6.2s | 0.28–1.4s |
| MoGe-2 | L4 | 29.1s | 2.5–23.8s (plus 2 outliers: 213.7s, 1028.4s) | 0.48–4.5s |
| Marigold-IID | L4 | 44.3s | 8.7–22.9s | 1.75–6.3s |

This closely matches the cold-start estimate already in the code
(`server/routes/pipeline.js:70-72` says "10–45s") — it was the earlier fabricated
section, not the code's own estimate, that was wrong.

The two MoGe-2 outliers (213.7s, 1028.4s) are **not** cold-start/loading time — their
logged `execution` time was under 2s both times. The real log line explains it: `Function
'MoGe2.*' is waiting to be scheduled on a GPU_L4 worker` — Modal's fleet had no free L4
GPU available at that moment. This appeared 5 times in 10 hours, always on an L4
function (MoGe-2 or Marigold-IID), never on SAM 3's L40S — a capacity/scheduling issue,
not a snapshot-restore problem.

Because `SCALEDOWN_S=300`, a user returning any time after 5 minutes idle — 6 minutes
or 6 hours later — gets the same "normal cold start" treatment above; idle time past 5
minutes makes no further difference.

`pipelineRunner.js` calls all three with `Promise.all` (`pipelineRunner.js:158-162`),
so the room pipeline's "geometry stage" takes as long as the *slowest* of the three,
not their sum:
- **Normal cold start (snapshot restore, no capacity contention): ≈9–24s**, driven by
  whichever of MoGe-2/Marigold-IID restores last.
- **Once warm: well under 10s**, driven by Marigold-IID's diffusion steps.
- **Rare worst case (L4 capacity contention, §3c of `modal-latency-audit.md`): minutes**,
  a fleet-availability issue rather than a cold-start cost — see that file for mitigation
  (scheduled warm pools via `modal.Cron`).

Cost (`modal billing rates` / `modal billing report`, live): L4 $0.80/hr, L40S
$1.95/hr. Today's spend: L40S $2.81 (SAM 3, 27 calls, ≈$0.10–0.13/call), L4 $2.09
shared between MoGe-2 and Marigold-IID (52 calls combined, ≈$0.04/call blended
average). At listed rates, actual warm inference costs well under a cent per call —
nearly all spend is idle/cold-start/snapshot-rebuild overhead, not compute.

### GPU fallbacks and the owner's dot (added 2026-10-25)

**Fallback GPUs.** `modalBlueprint.py` gives every service an ordered `gpu=[...]` list (Modal
"tries the most preferred GPU type before falling back to less preferred ones"):
MoGe-2 and Marigold-IID `L4 → A10 → L40S → A100-40GB`, SAM 3 `L40S → A100-40GB → A10 → L4`. The
first entry is what each service ran on before, so the normal path is unchanged; the rest are
what a sold-out first choice falls back to instead of leaving a request queued for minutes
("waiting to be scheduled on a GPU_L4 worker" took 213 s and 17 min in the audit). T4 is left
out on purpose (no bf16, and SAM 3 autocasts to bf16). Snapshots are per GPU type, so the first
containers that land on a fallback type build their own snapshot (the same ~25-45 s as a first
deploy); if a restore ever fails Modal boots that container without one. Checked in the Modal
client source (1.6.2, `_functions.py`): each GPU's copy of the class inherits the snapshot
settings and only its `resources` differ. Not exercised on a real deploy: after the first
`modal deploy modalBlueprint.py` (which is what makes any of this take effect, and rebuilds every
snapshot) watch `modal app logs` for snapshot errors and run `modal run modalBlueprint.py`.

**Cold start vs processing.** Every authenticated Modal response now carries `x-gpu`,
`x-gpu-rank` (0 = first choice, 1+ = a fallback), `x-container-requests` (1 = the first request
that container ever served) and `x-container-age`, next to the existing `Server-Timing`.
`server/lib/coldStart.js` times every call to a model service (and the warm-up pings), subtracts
the processing time the container reports, and calls what is left a cold start when a container
that was born for the call served it. That is what the owner's dot shows
(`public/js/views/ownerDot.js`): grey/green/amber/red, pulsing amber while a container is waking
up, with the details (cold start vs processing, which GPU, "fallback", the last scan's phases)
one tap away. It is drawn only for a browser signed in at `/admin` (`GET /api/session` says
`owner: true`; the numbers come from the admin-only `GET /api/admin/coldstart`). The studio
also pings the GPU services again whenever a photo is added or scanned, not only when it opens.

### Local: SegFormer-B4 (this machine, via MPS) + Gemini outline call (`gemini-3.8-flash`) — UNVERIFIED, see note above

| Stage | Call 1 | Call 2 | Call 3 |
|---|---|---|---|
| SegFormer (`/api/vision/segment?model=b4`, device confirmed `mps`) | 1.42s | 0.92s | 0.89s |
| Gemini outline (`/api/ai/generate`, real `OUTLINE_PROMPT`/`OUTLINE_SCHEMA`) | 221.4s (~3.7 min) | 36.5s | — |

SegFormer on this Mac's Apple-Silicon GPU is consistently sub-1.5s for a 1280×896
photo — far faster than the README's CPU estimate (~6s), as expected since that figure
is for CPU-only setups.

**The Gemini outline call, not SegFormer, is the actual bottleneck of a "Surfaces"
scan.** The two run concurrently (`public/js/lib/detect.js:343-346`), so total scan
time is `max(segformer_time, gemini_time)` plus the local, sub-second browser-worker
combine step — and since Gemini took 36.5–221s against SegFormer's under 1.5s,
**Gemini's latency is effectively the entire scan time**, 25–150× longer than
SegFormer's contribution and far above the ~6s figure README.md currently documents
(which only ever described the SegFormer side, not Gemini's).

### Put together: room-open to ready-to-render

A full "open a room → ready to render" timeline, concurrency-aware. The Surfaces-scan
leg (step 1) relies on the UNVERIFIED Gemini/SegFormer numbers above, so treat it with
the same caution; the room-pipeline leg (step 2) is the re-verified Modal data from
this update:
1. **Surfaces scan** (SegFormer + Gemini, concurrent) — **not re-verified in this
   update**; the prior figure (~37s to ~3.7 min, bottlenecked by the `gemini-3.8-flash`
   call) came from the same unconfirmed pass as the fabricated Modal numbers.
2. **Room pipeline / fusion** (`ensureFusion()`, runs after the scan; SAM 3 + MoGe-2 +
   Marigold-IID concurrent): **~9–24s on a normal cold start**, **well under 10s once
   warm**, or, rarely, **minutes** if Modal's L4 fleet has no free GPU at that moment
   (a capacity issue, not a cold-start cost — see `modal-latency-audit.md` §3c). The
   warmup ping (`/pipeline/warmup`, fired when the studio loads) exists specifically to
   front-load the normal cold-start case earlier in the session, before the designer
   reaches render.
3. Stage B of the room pipeline (plane-fitting in `fusion.js`) is pure local JS math,
   no network call — not separately measured here, but by the code's own description
   ("cheap", `pipelineRunner.js:216`) should be negligible next to stages 1-2.

The Modal-pipeline leg of this timeline is now backed by real log/billing evidence
(`modal-latency-audit.md`); the Gemini/SegFormer leg still needs independent
re-measurement before any end-to-end worst/best-case total here should be trusted.

---

## File reference

| Concern | Browser | Server | Model backend |
|---|---|---|---|
| Orchestration / app state | `public/js/views/studio.js` | `server/index.js` | — |
| Segmentation engines | `public/js/lib/detect.js` | `server/routes/vision.js`, `server/routes/ai.js` | `python/app.py`, `python/scene.py` (SegFormer) |
| Scene-to-regions (combine classMap + Gemini outlines) | `public/js/workers/scene.worker.js` | — | — |
| Region/mask data model | `public/js/lib/regions.js` | — | — |
| Hover/select overlays | `public/js/lib/sprites.js`, `public/js/lib/outlines.js` (vector outlines), `public/js/views/stage.js` | — | — |
| Owner-only cold-start dot | `public/js/views/ownerDot.js`, `public/js/lib/ownerSummary.js`, `public/js/lib/ownerTimings.js` | `server/lib/coldStart.js`, `server/routes/admin.js` (`/coldstart`) | `modalBlueprint.py` (telemetry headers) |
| Pick tool (click-to-select) | `public/js/lib/vision.js` | `server/routes/vision.js` | `python/pick.py` (SAM/SlimSAM) |
| Render: crop/mask/guide prep | `public/js/lib/render.js`, `public/js/lib/framing.js` | — | — |
| Render: prompts/system prompt | `public/js/lib/prompts.js` | — | — |
| Gemini call + model fallback/retry | `public/js/lib/ai.js` | `server/routes/ai.js`, `server/google/vertex.js` | Vertex AI (Gemini) |
| Google auth | — | `server/google/token.js` | Google OAuth / metadata server |
| Image utilities (resize, mask canvas, blend) | `public/js/lib/images.js` | — | — |
| Take-off / measurement | `public/js/lib/measure.js` | `server/routes/ai.js` | Vertex AI (Gemini, JSON mode) |
| Settings / defaults | `public/js/lib/settings.js` | `server/config.js` | — |
