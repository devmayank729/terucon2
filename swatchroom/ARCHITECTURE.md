# Swatchroom architecture (code-verified)

Every statement below was read from this repo's code (file and line named next to it) or checked
with a read-only command (listed in "Verification log" at the end). Where something could not be
checked, it is in "Not verified". Nothing here was timed. No live Modal, Google or Atlas endpoint was
called; the browser runs used an isolated local stack (see Part 3a and the log).

> **Update 2026-10-26.** Everything below this box was written on 2026-10-25 and has been corrected where this update
> changed it (marked "2026-10-26"). The instant-preview fix of 2026-10-25 is now part of a larger rework; the old
> findings (Part 3a's bugs 1 and 2) are still true of the code as it was.
>
> ### What changed, in one page
>
> **Modal is called as little as possible, and never because a page opened.**
> - `modalBlueprint.py` gains `VisionAll`: all four models (MoGe-2, Marigold *lighting* only, SAM 3, OneFormer) in ONE
>   container behind one URL (`/v1/analyze`, `/v1/oneformer` = `/v1/parse`, and every old route). `VISION_LAYOUT=both|combined|split`
>   (default `both`: your four URLs keep working). One photo = one cold start + one idle tail instead of up to four.
>   Checked offline: `tests/modal_blueprint.test.py` drives the real FastAPI apps with fake engines; the union of the four
>   images' pins resolves (`uv pip compile`). **Not run on a GPU or deployed.**
> - The room analysis is one request (`server/lib/remoteModels/analyze.js` -> zip with depth, shading, residual, SAM masks).
> - The scan's OneFormer request is the wake-up for that pool; `server/lib/wake.js` boots the *other* pools (separate
>   layout only) in the same wave when a photo is scanned. `GET /api/vision/warmup` answers "is Modal warm?" from the
>   server's own record of its last call (`server/lib/warmth.js`), without calling Modal. The old page-load ping
>   (`warmupPipeline()` in `swatchroom-app.js`) and the admin dashboard's 30-second `/healthz` polling (which kept every GPU
>   up while the tab was open) are gone; the dashboard shows the same passive state with an explicit Probe button.
> - Measured in the isolated browser harness (fake Modal, real server and browser): a whole session = 1 cold start,
>   exactly one `/v1/oneformer` and one `/v1/analyze` request, zero `/healthz`, also after an HD swap, a plane split, a
>   re-fit, taps, calibrations, finishes and reloads.
>
> **Scan.** `python/scene.py` serves SegFormer-B5 (`?model=b5-quant`, default). INT8 is used only where a timed pass at load
> shows it faster (x86); torch's ARM kernels measured *slower* than fp32 here, so Apple Silicon stays fp32. INT8 agreed with
> fp32 on 98.3-99.4% of pixels (measured on B4, the only SegFormer whose weights could be downloaded here: Hugging Face's CDN
> refused the B5 download with a 403, so B5 could not be measured at first; later the same day it downloaded and was measured on this Mac: see the 2026-10-26 evening log). The browser races it against OneFormer (`segmentRace.js`,
> `startupGate.js`, splash in `swatchroom-app.js`): see "Part 1". ADE20K names differ between the two models for ten classes
> (OneFormer says "tv", SegFormer "television receiver"), which would have turned furniture into "other": translated by
> `server/lib/ade20k.js`.
>
> **Instant preview.** The canvas follows the screen (frame x devicePixelRatio, at most 2048 px); every surface is a
> homography (scan px -> metres) from its fitted plane, or, before the room is analysed, from its outline's four corners
> (`fastrender/provisional.js`); 5-tap joint-bilateral edges guided by the photo; shading divided by the surface's median
> (clamped 0.35-1.65) after fixing a decoding bug (Marigold's PNGs are max-normalised gamma 2.2, the adapter read them as
> linear); highlights from Marigold's residual; mip-mapped textures, an LRU texture cache with prefetch (synchronous when
> cached). Picking a finish never reaches the AI (`tests/render_bridge.test.js` reads the source to prove it; the harness
> counts the requests).
>
> **SAM.** SAM 3's masks (ten prompts, one call) are stored per photo version and used for: a cleaner plane fit
> (`pipelineRunner.cleanFitMask`), wall-plane splits (`server/lib/planeSplit.js`, applied by the browser), tap-to-calibrate and
> rug / furniture / picture carve-outs (`public/js/lib/samCalibrate.js`, `occlusion.js`). A calibration never calls Modal:
> stored masks first, the local SlimSAM second. OneFormer's panoptic model merges every "stuff" class, so it can NOT separate
> wall planes (it does separate doors, windows and furniture); planes come from SAM 3 + depth.
>
> **AI render.** The brief now carries the measured geometry (size in metres, normal, distance, field of view, tile repeat,
> focal length in Image 1's pixels) and Image 3 blends the live preview at 35% inside the outline; the mask grows 0.2%
> instead of 0.4% where SAM's edge was trusted. Verified numerically in the harness; **the quality of Gemini's output with
> these additions was not evaluated (no Gemini call was made).**
>
> **Phones.** Working canvases are capped at 2560 px on iOS Safari (3072 on other phones) and released after use; a touch
> magnifier (2.5x, 70 px above the finger, hold 220 ms or drag; lift to select; hold 650 ms to add a surface).
>
> **Not verified:** a real Modal deployment, real MoGe-2 / Marigold / SAM 3 / OneFormer output (so how convincing the preview
> looks with real depth and shading, and the specular thresholds, are unproven), SegFormer-B5 and INT8 speed on x86, a real
> iOS Safari, a live Gemini render.

## Direct answers: what is sent to Gemini (read from the code)

1. **Image layers** (`render.js:115-140`). Exactly three `inlineData` parts, in this order:
   1. the photo, or a crop of it: `image/jpeg`, quality 0.92;
   2. a black/white mask of the selected region, same pixel size as image 1: `image/png`;
   3. a guide image, the same photo/crop with the region tinted magenta and edged in solid magenta:
      `image/jpeg`, quality 0.90. It is left out only when the **requested** image-model id contains
      `lite` (`render.js:48`, `:129`). If the server later falls back to a lite model after a 404, the
      guide has already been built and is still sent.
   The server appends the text brief as the last part of the same user turn
   (`vertex.js:403`) and sends the system prompt separately as `systemInstruction`. In the very last
   fallback body (after HTTP 400s) the system prompt is merged into that user text instead
   (`vertex.js:438-446`).
2. **When a crop is sent instead of the whole photo** (`framing.js:13-68`; box = the region's
   `bbox` in scan pixels, scaled to the working image; W, H = working image size; r = the *nearest
   standard* ratio to W:H from `1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9`, not W/H itself):
   - no `bbox` -> no crop (`:21`);
   - box area > 0.22 * W * H -> no crop (`:32`);
   - otherwise cropH = max(1.6 * boxH, 1.6 * boxW / r, 0.5 * H, 0.5 * W / r) and cropW = cropH * r
     (`:37-43`);
   - cropW > 0.82 * W **or** cropH > 0.82 * H -> no crop (`:44`);
   - otherwise the crop is centred on the box, clamped to the image, and scaled by
     max(1, 1280 / max(cropW, cropH)) (`:57`).
   So a crop is sent only for a surface covering at most 22% of the frame whose context crop still
   fits inside 82% of the frame. Everything else sends the whole photo, downscaled to
   `uploadMaxSide` (default 2048) (`render.js:47`, `:70-71`).
3. **Depth, MoGe-2, Marigold, 3D matrices in the payload: none** *(as of 2026-10-25; since 2026-10-26 the brief carries measured
   geometry as text and Image 3 carries the preview blend, see the update above)*. Evidence, not just a search:
   - the payload is built from three canvases (`sendCanvas`, `sendMask`, `guideImage(...)`) plus
     strings (`brief`, `systemPrompt`) and two scalars (`aspectRatio`, `imageSize`)
     (`render.js:141-171`);
   - `studio.startRender()` hands `prepareRender` only `settings, scan, region, versionUrl, item,
     style, notes, signal` (`studio.js:1828-1836`); no depth, shading or fusion object is passed;
   - `render.js` imports, transitively, only 9 files (`ai.js`, `api.js`, `modelLog.js`, `images.js`,
     `framing.js`, `prompts.js`, `regions.js`, `settings.js`); none of them is a fusion, depth or
     fast-render module (import graph walked by script);
   - on the server, `routes/ai.js` passes `parts` through unchanged (`readContents` only checks for
     a non-empty array) and takes `brief`, `systemPrompt`, `aspectRatio`, `imageSize`
     (`routes/ai.js:43-48`, `:66-84`); it and `vertex.js` import only config, token, vertex, event
     log and PostHog code, so the server adds nothing of its own;
   - the only 3D-sounding words that reach Gemini are in the text of the system prompt (rules 2, 3
     and 8) and in the optional outline polygon and box coordinates, which are 2D image coordinates.

## The short version

There are **two separate ways** a finish gets onto a photo, and they use different models:

| | **AI render** (Gemini "Nano Banana") | **Instant preview** (GPU shader in the browser) |
| --- | --- | --- |
| Works in | 2D: it edits the pixels of a flat image | 3D: it places a texture on a plane measured in metres |
| Input | photo (or context crop) + black/white mask + magenta guide + text brief | saved depth (MoGe-2) + saved shading (Marigold) + fitted planes + a catalogue texture |
| Models involved | Gemini image model only | MoGe-2, Marigold-IID, SAM 3 (run once per photo, earlier) |
| Surfaces | any | wall, floor, ceiling only (`pipelineRunner.js:47`) |
| Catalogue items | any | only items with a tileable texture (`tiers.js:34`) |
| Network when you pick a finish | yes | none |
| Saved as a result | yes (two versions) | **no**: it is an on-screen overlay only |

**MoGe-2 and Marigold are not sent to, and do not feed, Nano Banana** *(2026-10-26: their measurements now reach it as words in the brief and as the preview blended into Image 3; the pixels of depth and shading are still not sent)*. `render.js`, `prompts.js`,
`ai.js`, `framing.js`, `routes/ai.js` and `google/vertex.js` contain no reference to depth,
shading, fusion, MoGe, Marigold or the fast renderer (searched; the only depth-like hits are
`depth_m` in the measurement schema, `prompts.js:143`, `:168`).

"Saved as a result: no" for the preview: `readPixelsAsBlob`, the only function that could export
the preview canvas, is never called outside `public/js/lib/fastrender/` (searched). The Settings
text agrees: "Low-confidence surfaces, and every saved render, still use AI"
(`public/js/views/dialogs.js:349`).

## Part 1: Upload and scan (finds the surfaces you can click)

Entry: `Studio.runScan()` (`public/js/views/studio.js:908`). It first fires a GPU warm-up ping
(`studio.js:914`), then:

1. The photo is drawn to a canvas of at most `analysisMaxSide` = 1024 px (`settings.js:82`,
   `studio.js:889`) and JPEG-encoded at quality 0.82 (`studio.js:956`).
2. `detectSurfaces()` -> `detectWithScene()` (`public/js/lib/detect.js`). Two jobs start
   together *(2026-10-26: the segmentation is a race between the local model and OneFormer, see `segmentRace.js`; the
   description of the local model below is the default `b5-quant` since then)*:
   - **SegFormer**: `segmentBlob()` -> `POST /api/vision/segment?model=b5-quant` (was `b4`) -> Express forwards to
     the Python service `POST /scene/segment` (`python/app.py`). The Python side caps images at
     2048 px (`app.py:31`). Model: `nvidia/segformer-b4-finetuned-ade-512-512` (`scene.py:22-26`),
     read in overlapping tiles of 512 px (`scene.py` docstring). The reply is a per-pixel class map
     (gzip + base64) with the class names.
   - **Gemini outlines**: `outlinesForNaming()` (`detect.js:358`), only if `useGeminiAssist` (default
     `true`, `settings.js:77`). The photo goes to a Gemini text model (`polygonModel`
     `gemini-3.8-flash`, `settings.js:81`) asking for polygons. It is started *before* SegFormer's
     result is awaited (`detect.js:420`), so they run in parallel. After 45 s
     (`ASSIST_DEADLINE_MS`, `detect.js:87`) the scan carries on without it and shows a toast.
3. `buildSurfaces()` runs `public/js/workers/scene.worker.js` in a Web Worker:
   1. **Group classes** into kinds: wall, floor, ceiling, window, door, furniture, other
      (`scene.worker.js:13-118`).
   2. **Remove specks** smaller than 0.12% of the image (min 24 px), then a **guided filter**
      (edge-aware, guided by the photo's grayscale) snaps class borders to real edges
      (`scene.worker.js:524-541`, `:237`).
   3. **Split walls into planes** only if Gemini returned **at least 2 wall outlines**
      (`scene.worker.js:629`): each wall pixel goes to the smallest wall polygon containing it,
      the assignment is flood-filled into wall pixels no polygon reached, then borders are
      snapped again. With fewer than 2 wall outlines the walls stay as connected blobs, named
      "Walls" (one blob) or "Wall 1, Wall 2..." (`:719-746`).
   4. **Arbitration**: a floor/ceiling/wall blob that is >= 60% inside a Gemini polygon of a
      different kind and <= 15% inside any same-kind polygon becomes that other kind
      (`:807-812`). Furniture outlines are also pulled out of the ceiling region (`:830-899`).
   5. **Naming**: each region takes the label of the Gemini outline overlapping it with
      IoU >= 0.3 (`:909-960`). Touching regions with the same kind and Gemini name are merged
      (`:1008-1072`).
4. Result: a `scan` = `{width, height, labelMap (region index per pixel), regions[]}`; each region
   gets `mask`, `bbox`, `centroid`, `areaShare` (`public/js/lib/regions.js`, `buildRegions` ~`:203`).
5. **The lines you see** are vector outlines traced from each region's mask
   (`public/js/lib/outlines.js`). **A tap selects a region** by reading the label map at the tapped
   pixel: `regionAt()` (`regions.js:578`), called from `stage.js:1082`.

Fallbacks: if the Python service fails and `fallbackToGemini` is on (default `true`), the scan is
redone from Gemini polygons alone (`detect.js:464-486`).

**The scan never calls Modal** *(until 2026-10-25; since 2026-10-26 the scan sends one request to OneFormer on Modal when
`ONEFORMER_URL` is set, and `runScan` asks the server to wake the pipeline's pools only when a photo is being scanned)*.

The Pick tool (tap any object) is separate: SlimSAM (`nielsr/slimsam-50-uniform`) in the Python
service (`python/pick.py`).

## Part 2: "Understand this photo" pipeline (after the scan, once per photo version)

Trigger: `ensureFusion()` in `studio.js`, called (a) after a scan finishes and the scan has been
saved (`studio.js:997-1011`) and (b) when a saved room with a saved scan is opened
(`studio.js:861-863`). It posts `POST /api/pipeline/analyze` -> job queue
(`server/routes/pipeline.js`) -> `server/lib/pipelineRunner.js`. The browser polls
`GET /api/pipeline/jobs/:id` every 4 s (`studio.js:1161`). If this room+version already has a
result, nothing is recomputed (`pipelineRunner.js:268-275`).

**Stage A: three Modal GPU services, called together** (`Promise.all`, `pipelineRunner.js:169`):

| Model | Endpoint and request | What the code keeps | Adapter |
| --- | --- | --- | --- |
| MoGe-2 | `/v1/geometry`; `resolution_level` 9, `max_side` 1280, `include=depth,mask,intrinsics`, float32 | **depth in metres** per pixel (0 where the mask is false) + intrinsics fx, fy, cx, cy. No up vector (`up: null`) | `server/lib/remoteModels/moge2.js` |
| Marigold-IID | `/v1/decompose`; `model=lighting`, `ensemble=1`, `seed=0` | **only the shading image**, reduced to one brightness value per pixel with Rec. 601 weights (0.299 R + 0.587 G + 0.114 B). The colour/albedo output is not used | `remoteModels/marigold.js` (`normalize`) |
| SAM 3 | `/v1/segment`; prompts "wall", "floor", "ceiling" *(2026-10-26: ten prompts, in the combined `/v1/analyze`)* | instance masks, used **only** to replace each scan region's default confidence 0.75 with SAM's score where masks overlap (IoU >= 0.3). Not stored *(2026-10-26: stored as `fusion/<version>/sam`, see the update)* | `remoteModels/sam3.js`, `pipelineRunner.js:99-136` |

Depth and shading are resampled to the scan's pixel grid and stored per photo version
(`pipelineRunner.js:176-196`). Region shapes come from the existing scan, not from SAM 3
(`pipelineRunner.js:1-16`).

**Stage B: local math in Node, no network** (`fusion.js`, run in a worker thread):
for every wall/floor/ceiling region of the scan:
1. Erode the mask by 2 px (`fusion.js:504`).
2. Unproject pixels to 3D with depth + intrinsics: `P = ((px+0.5-cx)*d/fx, (py+0.5-cy)*d/fy, d)`;
   at most 4000 sampled points (`fusion.js:97-122`, `:509`).
3. **RANSAC plane fit**, 300 iterations, inlier tolerance 2% of mean depth clamped to 1-5 cm,
   then a PCA refit over the inliers (`fusion.js:207-341`).
4. Build an in-plane (u, v) frame in metres (`fusion.js:348`).
5. **Confidence** = weighted geometric mean of four scores (`fusion.js:469-475`):
   mask score^0.2 x planarity^0.35 x geometric-consistency^0.25 x depth-coverage^0.2.
   Geometric consistency compares fitted normals with what the kinds imply (floor vs wall ~90 deg,
   floor vs ceiling ~180 deg, wall vs wall ~90 deg; `fusion.js:385-401`). Depth coverage is 0 if
   fewer than 150 valid depth pixels (`fusion.js:461`).
6. Tier: `< 0.45` "gemini-only", `0.45-0.70` "flagged", `>= 0.70` "fast"
   (`fusion.js:477`; thresholds are live settings, `settings.js:96-99`).

This is the "3D" in the project: after Stage B each wall/floor/ceiling is a plane with a normal,
an origin and a metre-scaled (u, v) frame, instead of just a patch of pixels.

When `MOGE2_URL` or `MARIGOLD_URL` is empty (and `PIPELINE_MOCK` is `auto`), that model is mocked
with synthetic data instead (`pipelineRunner.js:28-36`, `config.js:147-150`). **In this checkout's
`.env` all three URLs are set and `PIPELINE_MOCK` is not set**, so the real endpoints are called.

## Part 3a: Instant preview (3D path, in the browser)

Every one of these must be true (`studio.js:2442-2456`, `fastrender/tiers.js`):
- render engine is "Instant + AI" (`renderEngine: "auto"`, `settings.js:94`)
- the pipeline result for this photo is loaded and ready
- exactly one surface is selected and a finish is picked
- that surface has a fitted plane and confidence >= 0.45
- the catalogue item has `texture.url`
- the browser has WebGPU or WebGL2 (`fastrender/device.js`)

Then `stage.js` `maybeFastRender()` (`stage.js:457`) -> `fastrender/renderer.js`:
- `uploadScene()` once per photo/scan: label map, depth, shading, camera, planes to the GPU.
- `setMaterial()` per finish tap: rebinds one texture layer (640x448 tile, `renderer.js:19-20`).
  No network.
- The fragment shader (`shaders/swap.glsl.js`; WGSL twin) for each pixel: skip if no region, no
  material, depth <= 0 or selection alpha <= 0; otherwise rebuild the 3D point from depth,
  project it onto the region's plane to get (u, v) in metres, sample the texture at u/tileWidth,
  v/tileHeight (so scale and perspective are real), then `lit = materialColor.rgb * shadingValue`,
  convert to sRGB, write to a transparent canvas stacked over the photo.

So **MoGe-2 supplies perspective and real-world scale, Marigold supplies the lighting
multiplier**. This is the only place either is used.

### Why it never showed, and the fix (verified in the real studio)

**Bug 1: the alpha map was never filled.**
- Both GPU backends create the alpha texture **filled with zeros** every time `uploadScene()` runs
  (`webgl2.js:102`, `webgpu.js:128-133`), and both shaders return a transparent pixel when alpha <= 0
  (`swap.glsl.js`, `swap.wgsl.js:82-83`).
- `setAlpha()` existed but the studio never called it; its only caller was the dev page
  `public/fastrender-test.html:73` (alpha = 1 everywhere). The studio's scene payload
  (`studio.js:1213-1219`) has no alpha. `git log -S setAlpha` shows it only in the first commit.

**Bug 2: the canvas had the wrong size** *(2026-10-26: superseded: the canvas now follows the screen and the shaders read the scan's textures through normalised coordinates)*.
- Both shaders read the label, depth, shading and alpha textures at the canvas pixel `(x, y)` and
  unproject with scan-pixel intrinsics, and WebGL2 sets `gl.viewport(0, 0, sceneW, sceneH)`
  (`webgl2.js:178`). So the drawing buffer must equal the scan's size.
- `stage.js` sized it to the on-screen frame x devicePixelRatio (648x432 on the test desktop, against
  a 1024x683 scan), so even with alpha fixed the preview would have been misplaced and clipped.
  The dev page never showed this because it sets the canvas to the scene's size itself.
- Measured before the fix: `canvasPx [648, 432]` vs `scanPx [1024, 683]`.

**Fix (uncommitted).**
- `renderer.js`: new `setAlphaFromMask(mask)` (1 inside a region's own mask, 0 elsewhere); the
  facade remembers the scene size so a wrong-sized mask is refused.
- `stage.js` `maybeFastRender()`:
  1. the canvas drawing buffer is set to `scene.scan.width x scene.scan.height` (CSS already
     stretches it over the photo, `.sr-frame-overlay { width: 100%; height: 100% }`);
  2. after every `uploadScene()` the material key and alpha owner are reset, because the upload
     zeroes alpha and drops every material assignment;
  3. alpha is set to the selected region's mask **before** the render that follows `setMaterial`;
  4. going directly from surface A to surface B now clears A first (before, A was cleared only when
     the selection became empty, which would have left A's preview on screen once alpha worked);
  5. a guard for `fastScene` becoming null while the renderer was still starting.

**Measured in the real studio** (isolated stack: in-memory MongoDB, the server's own box-room mock
for depth/shading since `PIPELINE_MOCK=on`, Gemini outlines replaced by `tests/polys.json`, headless
Google Chrome; no live Atlas, Modal or Google). Steps: upload photo, scan, tap the floor, pick
"Light oak planks", tap the back wall, pick "Brick", tap the floor again. `readback` = pixels of
the preview canvas read in the same task as `render()`; `screenshot diff` = the photo frame with the
preview canvas hidden vs shown (reduced motion on, so the animated selection outline does not count).

| Run | Backend | Preview painted (floor / wall) | Painted outside the selected surface | Screenshot diff inside the selected surface |
| --- | --- | --- | --- | --- |
| Before fix, desktop DPR 1 | WebGPU | **0 / 0** | n/a | 0 changed pixels |
| After, desktop DPR 1 | WebGPU | 112,816 / 195,627 (= each surface's area) | 0 | 99.998% / 100% |
| After, desktop DPR 1, WebGL2 forced | WebGL2 | 112,816 / 195,627 | 0 | 99.998% / 100% |
| After, phone 390x844 DPR 3 | WebGPU | 112,816 / 195,627 | 0 | 100% / 100% |
| After, phone DPR 3, WebGL2 forced | WebGL2 | 112,816 / 195,627 | 0 | 100% / 100% |
| After, phone DPR 3, portrait photo (684x1024 scan) | WebGPU | 113,133 / 195,946 | 0 | 100% / 100% |

Switching check: after tapping the wall, the floor's pixels in the canvas were 0 in every run
(`insideOtherRegion: 0`). In all runs the pipeline was `ready`, all four fused surfaces matched the
browser's region ids (`hasRegion: true`), confidences were 0.695 (floor), 0.885 (wall) on the
landscape photo and 0.942 / 0.715 on the portrait one, so the default 0.45 threshold was not
changed.

Looking at the screenshots (not just counting pixels): the preview fills exactly the dashed
selection outline and the selection outline stays on top. **It does not look realistic in this
test**: the floor planks smear toward the bottom edge and the brick shows converging lines at the
top. That is expected here because the "depth" is a synthetic box room, not this photo's real
geometry, and the shading is a synthetic gradient. Realism with real MoGe-2/Marigold output is
**not** verified.

Other limits: the preview is drawn at the scan's resolution (at most 1024 px on the long side,
`analysisMaxSide`) and stretched by CSS, so it is softer than the photo on large or high-DPI
screens; the fix left the region edge hard *(2026-10-26: no longer true, edges are joint-bilateral filtered)*. Earlier experiment that found bug 1
(test page with and without `setAlpha`, WebGL2 under software rendering): back-wall centre pixel
`rgba(106,62,46,255)` with alpha set, `rgba(0,0,0,0)` without.

Settings > Render shows "This room: ..." and "Instant preview backend in this browser: ..."
(`dialogs.js:378-385`) if the preview still does not appear for your own photos: it also needs the
pipeline to be `ready`, confidence >= 0.45 for that surface, a textured finish and one selected
surface.

## Part 3b: AI render (2D path, Gemini)

Trigger: the Render button or Ctrl/Cmd+Enter -> `Studio.startRender()` (`studio.js:1776`; keyboard
`:2166-2172`; button `:2813`). Choosing a finish alone does not start it.
Code: `prepareRender()` / `renderOption()` in `public/js/lib/render.js`.

What Gemini receives (`render.js:115-140`, `framing.js`, `prompts.js`):
1. **Image 1, the photo**: the whole photo **or** a context crop, exact rule in "Direct answers"
   above (`framing.js:13-68`). Whole photo: downscaled to at most `uploadMaxSide` (default 2048) on
   the long side, **also for 4K renders**; 4096 px is only the working canvas the crop is cut from
   and the result is pasted into (`render.js:44-47`, `:70-71`). JPEG quality 0.92.
2. **Image 2, mask**: black/white PNG, same size, region grown by ~0.4% of the short side.
3. **Image 3, guide** (skipped when the requested model id contains `lite`): the photo with the
   region tinted magenta and edged in solid magenta; JPEG quality 0.90.
4. **Text brief** (`prompts.js:38-134`): image size, whether Image 1 is a crop, the target's
   label and kind, its box (0-1000 and pixels), an outline polygon (if `sendPolygon` and the target
   is not a union of regions; with a crop it is re-expressed relative to the crop,
   `render.js:85-88`), area share, centre (both also relative to the crop), the task (replace / add / restyle / remove / custom), the
   product's name and prompt text, room style, your notes.
5. **System prompt** (`prompts.js:3-24`): 10 rules, including: change only the target area, follow
   the surface's plane and perspective, match existing light direction/falloff/shadows, keep
   objects in front in front, correct real-world scale, return the same framing.

So depth and lighting reach Gemini only as **words in rules 2, 3, 8** and as whatever Gemini
infers from the 2D photo. No MoGe-2 or Marigold data is attached.

Server (`routes/ai.js` -> `google/vertex.js`): adds the Google token, builds `generateContent`
(`vertex.js:400-448`: `systemInstruction` + user parts [photo, mask, guide, brief] +
`responseModalities ["TEXT","IMAGE"]` + `imageConfig {aspectRatio, imageSize}`), and
degrades the body step by step on HTTP 400. On 404 it walks
`gemini-nano-banana-2.1 -> gemini-3.1-flash-image -> gemini-3.1-flash-lite-image`
(`vertex.js:29-33`) and remembers the working id for 7 days.

Which model is "Nano Banana": the default `imageModel` is `gemini-3.1-flash-image`
(`settings.js:84`, UI label "Fast"). A code comment calls it "the faster Nano Banana 2"
(`settings.js:127`). `gemini-nano-banana-2.1` is the UI's "Mask-aware" option
(`settings.js:13-15`).

After the answer (`render.js:173-217`): decode the last returned image; `alignOutput()` finds the
scale/shift that maps it back onto what was sent; `placeOutput()` pastes it into the
full-resolution photo (inside the crop rectangle if a crop was used); `blendIntoBase()` makes a
second version through a feathered mask so pixels outside the mask equal the original. Both
are saved.

## Your two statements, checked

1. *"Upload, scan, lines appear, I click and select."* **Correct.** (Part 1.)
2. *"Only the cropped piece goes to Nano Banana, with depth/lighting from Marigold and MoGe-2."*
   **Partly wrong.**
   - What goes to Gemini is the photo or a generous context crop, plus mask, guide and text.
     It is not an isolated cut-out, and it is not always cropped (crop only when the surface is
     small: <= 22% of the frame). (Part 3b.)
   - MoGe-2 and Marigold output is **not** in that request. They feed the separate instant
     preview. (Parts 2 and 3a.)

## Verification log (what I actually ran or read)

| Check | Result |
| --- | --- |
| `grep` for fusion/depth/shading/marigold/moge in `render.js`, `prompts.js`, `ai.js`, `framing.js`, `routes/ai.js`, `vertex.js` | no matches except `depth_m` in the measurement schema |
| `grep` for `readPixelsAsBlob` outside `fastrender/` | no callers: preview is not saved |
| `.env` keys present (names only; values not copied here) | `SAM3_URL`, `MOGE2_URL`, `MARIGOLD_URL` and their keys set; `PIPELINE_MOCK` not set; `MODEL_SERVICE_URL` set to a local address; `POSTHOG_KEY` set |
| `modalBlueprint.py` vs `/Users/mayank/XTRA/modalDeployment/vision_stack.py` | byte-identical (`diff` empty). Repo file modified 2026-10-25 21:37, deployed-copy file 21:58 |
| `modal app list` (read-only) | `vision-stack` deployed (created 2026-10-24 05:06) plus a second `vision-stack` stopped 2026-10-25 21:55-21:56 (looks like a `modal run` self-test) |
| `modal app history` for the deployed app | v1 2026-10-24 05:06, v2 2026-10-24 05:09, **v3 2026-10-25 21:59 IST**, all by `mayankrohillam729`, client 1.6.2 |
| GPU lists in `modalBlueprint.py:81-83` | MoGe-2 and Marigold `L4, A10, L40S, A100-40GB`; SAM 3 `L40S, A100-40GB, A10, L4` |
| Catalogue textures (`node` import of `catalog.js`, files checked on disk) | textured items per kind: wall 30/38, floor 16/20, ceiling 6/16, window 4/11, door 0/5, furniture 9/10, other 2/3; no texture file missing |
| `grep setAlpha` across `public/`, plus `git log -S setAlpha` | defined in 3 files, called only from `fastrender-test.html`; never from the studio |
| Headless Chromium run of `fastrender-test.html` with and without its `setAlpha` call | with: pixels painted; without: every probed pixel `rgba(0,0,0,0)` |
| Real studio, isolated stack, BEFORE the fix (WebGPU, desktop DPR 1) | all gates pass (`hasRegion` true, material assigned) yet 0 pixels painted and 0 changed screenshot pixels; canvas 648x432 vs scan 1024x683 |
| Real studio, AFTER the fix: desktop DPR 1 (WebGPU and forced WebGL2), phone DPR 3 (WebGPU and forced WebGL2), portrait phone DPR 3 | painted pixels equal each surface's area, 0 outside it, floor cleared when the wall is selected (table in Part 3a) |
| Driver mistakes found and discarded | one batch of four runs silently ignored its flags (zsh does not word-split `$cfg`) and was thrown away; the first portrait run tapped a hint `<p>` instead of the stage, so it never selected the wall; both were re-run correctly |
| Import graph of `render.js` (script) | 9 files, none a fusion/depth/fast-render/studio module |
| `npm test` after the fix | still 62/62 pass (the tests do not cover the studio-to-renderer path) |
| `git status` | `renderer.js` and `stage.js` modified (the fix), `ARCHITECTURE.md` new; nothing committed |
| `npm test` (offline unit tests, no network) | all pass: 11 + 6 + 7 + 19 + 11 + 8 = 62 cases (fusion, .npy parsing, remote-model adapters, cold-start classification, owner-dot wording, vector outlines) |
| Files read in full | `pipelineRunner.js`, `fusion.js`, `scene.worker.js`, `render.js`, `prompts.js` (render part), `tiers.js`, `renderer.js`, `webgl2.js`, `webgpu.js`, `swap.glsl.js`, `swap.wgsl.js`, `framing.js` (crop, guide, helpers), `vertex.js` (all request building and error paths), `routes/ai.js`, `public/js/lib/ai.js` (head), `settings.js` (head), `python/app.py` (segment), `detect.js` (scene path) |

## Verification log, 2026-10-26 (what was run; nothing touched live Modal, Google or Atlas)

| Check | Result |
| --- | --- |
| `npm test` | 12 Node suites, 171 cases, all pass; with a Python that has torch / transformers / fastapi / modal / httpx the two Python suites pass too (30 + 24 checks) |
| Blueprint HTTP layer (`tests/modal_blueprint.test.py`) | `/v1/analyze` zip, `/v1/oneformer` = `/v1/parse`, `/healthz` ready flag, layouts, unloaded-checkpoint 422: all pass with fake engines |
| Dependency resolution of the combined image | `uv pip compile --python-version 3.12` of the four images' pins together: no conflicts |
| Scene service (`tests/scene_service.test.py`) | "b5-quant" resolves to B5 (it used to fall through to B4), buffers reused, `?model=` query and form, default model |
| INT8 vs fp32 (B4, cached weights) | 98.30% / 99.41% pixel agreement on the two test photos; INT8 on Apple Silicon (qnnpack) 9-220 s vs fp32 5-6 s, so it is not used there |
| Isolated browser harness (in-memory MongoDB, fake combined Modal pool, fake local model service, the real server, Google Chrome with a 390x844 DPR 3 phone) | Five scenarios (A-E, 107 checks), all pass: cold Modal with OneFormer first; local first then HD banner and automatic swap; provisional -> fused preview with no blank frame, pixel areas, surface A -> B, SAM calibration, plane split, loupe via CDP touch, Render request contents; the 10 s gate, warm gate, guide blend, iOS caps, admin panel passivity, WebGPU; warm + slow OneFormer, specular highlight, mask grow |
| The NEW server against the OLD Modal deployment (scenario F: three separate pools, SAM 3 refusing more than 8 prompts, no OneFormer, no `/v1/analyze`) | passes (12 checks): landing wakes nothing; the scan uses the local model only, no OneFormer request, no HD banner; the analysis goes through the separate path with one geometry, one decompose and one segment call (at most 8 prompts), each pool got one `/healthz` (the scan's wake-up) and booted once. So the server can be deployed before Modal is redeployed; it just does not get OneFormer or the single-call analysis until then |
| Finish swap with the texture in memory (scenario G, headless Chrome on an Apple Silicon Mac, WebGL2, 390x844 at DPR 3) | pointer-down -> the studio calls `setMaterial`: 15-17 ms (the studio batches picks into the next animation frame); `setMaterial` + `render` submission: 0.0-0.2 ms (JS and command submission, **not** GPU completion: `gl.finish` does not wait in Chrome); pointer-down -> first changed frame a per-frame probe sees: 31-49 ms. So the renderer's own work is far below 16 ms, the whole tap-to-pixels path is two to three frames. Not measured on a phone |
| B5 failing to load (scene service) | `tests/scene_service.test.py`: a B5 that cannot be downloaded or loaded is answered by B4 (`fellBackFrom` in the response, not retried for 5 minutes), and a service with less than `SCENE_B5_MIN_GB` (3) of memory does not try B5 at all |
| Bugs the browser run found that no unit test had | the HD banner shrank to a 5-line pill (CSS `left: 50%`); the preview snapshot for the AI guide was taken after the studio had hidden the preview; a temporal-dead-zone error in the calibration promise |

## Verification log, 2026-10-26 evening (after "nothing changed, the preview is still not visible")

| Check | Result |
| --- | --- |
| What was running on the designer's machine | `node server/index.js` on :3000 serving the NEW client code; **no Python model service running** (nothing on 127.0.0.1:8001); `.env` has no `ONEFORMER_URL` / `ANALYZE_URL`, only the three old Modal URLs; the deployed Modal file is still the old three-model one. So: no OneFormer call can happen, and the scan model shown depends on which Python process (if any) was started and from which code |
| The service from the repo's own `python/.venv` (Python 3.9, torch 2.8, transformers 4.57) | the new code imports and runs there: `b5-quant` answers with `nvidia/segformer-b5-finetuned-ade-640-640`, fp32 on MPS, 2.9 s for a 1920x1281 photo (B4: 1.6 s warm) |
| B5 weights | now present in the local Hugging Face cache (`pytorch_model.bin`, 339 MB) |
| Instant preview, real B5 scan + synthetic depth, desktop 1440x900 @2x and phone 390x844 @3x, WebGPU and WebGL2, real Apple GPU (M5, Metal) | visible on the page in compositor screenshots (not only canvas reads), for landscape, portrait, 12 MP and EXIF-rotated photos |
| Instant preview with REAL data (real B5 scan, real MoGe-2 depth, real Marigold-IID shading for the test photo, run locally on MPS) | floor, ceiling and the right wall preview; **the biggest wall (a wall with a TV niche) scored fusion confidence 0.425, under the 0.45 cut-off, and got no preview at all (silently); furniture, curtains and windows have no fitted plane and get none either** |
| Fix | planar surfaces (wall / floor / ceiling) with a weak fit (below `fusionLowThreshold`, default now 0.3, was 0.45; migrated for saved settings) are drawn from the outline-based estimate instead of being left blank; furniture, curtains and windows still go to the AI render by design. Re-run with real data: every wall, the floor and the ceiling preview (back wall: 11% of the frame changed) |
| New visibility for the designer | the server prints at start what it will do (scan service reachable? old build? ONEFORMER_URL / ANALYZE_URL set?); the owner dot lists OneFormer and Room analysis as "not set up: add ONEFORMER_URL to .env" and names the model that answered the last scan, with "B5 could not load" when it fell back |
| Test suites | `npm test`: 12 Node suites pass (owner 13, fastrender 25, render_bridge 16 now include the new cases) and the two Python suites; browser scenarios A-F pass |

## Not verified

- **That Modal v3 contains exactly the current file.** The history shows a deploy one minute after
  `vision_stack.py` was written and that file equals the repo file, which is consistent with it, but
  the history does not show file contents. I did not call `/healthz` or any endpoint, since that
  would start a billed GPU container.
- **What the real MoGe-2 / Marigold / SAM 3 endpoints return today.** The tests use fixtures and
  mocks; I made no live call. The Marigold adapter picks the first output whose name matches
  `shad` (`marigold.js` `findShadingName`), so which output is used depends on the endpoint's
  `meta.json`.
- **Any timing.** `swatchflow.md` Part 6 itself marks its SegFormer/Gemini timings as unverified.
- **Realism of the instant preview with real MoGe-2/Marigold output.** The browser runs used the
  server's synthetic box-room depth and gradient shading, so placement and masking are verified, how
  convincing the result looks is not (the screenshots look smeared, as expected for fake geometry).
- **The Gemini render's visual quality**: no Gemini call was made (Google credentials were blank in the
  test stack); only the request construction was read.
- **SegFormer-B5 on a Linux CPU / on Render.** On Apple Silicon (MPS, fp32) B5 answers a 1920 px photo in 2.9 s (measured through the real service); on a Linux CPU its speed and memory are not measured. B4 in fp32 peaked at 1.6 GB
  resident (about 350 MB of it torch and transformers), B5 is bigger, so the service only loads B5 where its memory limit
  is at least `SCENE_B5_MIN_GB` (3) and otherwise answers with B4; that threshold is a cautious guess, not a measurement.
- **Real iOS Safari / a real GPU**: runs were headless Google Chrome on this Mac (WebGPU and forced
  WebGL2). Behaviour on other devices is unverified.
- **Parts of the code I did not read line by line**: most of `studio.js` and `stage.js` (only the
  fast-render, scan, render-trigger and selection paths), `images.js` beyond the mask and aspect-ratio
  helpers, `sprites.js`, `server/routes/rooms.js`, `jobs.js`, `coldStart.js`.
- **Your `.env` values are correct** (URLs reachable, keys valid): only their presence was checked.
