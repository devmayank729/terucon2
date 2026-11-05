# Design Studio (Swatchroom): what it calls, when, and why it behaves the way it does

**Verified edition, 2026-11-03.** Written against repository commit `9c75c37` (working tree clean when this started). `swatchroom/` has a single git commit ("merged swatchroom and main website"), so the code read here is the code that is deployed from this repo. **Nothing under `swatchroom/` was changed** (it is a verbatim copy of your separate project).

This file has two parts:

- **Part A (sections 1 to 12)** is new. It answers your questions, and every statement carries an evidence tag. Section 12 was added later (2026-11-05): the website now serves an improved copy of the studio's instant-preview code, which changes what sections 3.5 and 7 describe.
- **Part B (appendices A to F)** is a copy of the six existing guides in `swatchroom/`, unchanged except that heading levels were shifted to fit under this file. They are older writing: section 10 lists where they are out of date or contradict what was verified today.

## Contents

- [0. How to read the evidence tags](#0-how-to-read-the-evidence-tags)
- [1. Your questions, answered shortly](#1-your-questions-answered-shortly)
- [2. The architecture](#2-the-architecture)
- [3. Who calls whom, action by action](#3-who-calls-whom-action-by-action)
- [4. The "understand this photo" job in detail](#4-the-understand-this-photo-job-in-detail)
- [5. A photo opened from history](#5-a-photo-opened-from-history)
- [6. Why picking a design can take time](#6-why-picking-a-design-can-take-time)
- [7. Why it can look 2D first and 3D later](#7-why-it-can-look-2d-first-and-3d-later)
- [8. Your console screenshot, line by line](#8-your-console-screenshot-line-by-line)
- [9. How to see for yourself what is happening](#9-how-to-see-for-yourself-what-is-happening)
- [10. Where the older guides are out of date](#10-where-the-older-guides-are-out-of-date)
- [11. What was verified, and what was not](#11-what-was-verified-and-what-was-not)
- [12. The instant preview's quality overlay: the website's preview is not the standalone studio's](#12-the-instant-previews-quality-overlay-the-websites-preview-is-not-the-standalone-studios)
- Appendices A to F: the six existing guides, copied

---

## 0. How to read the evidence tags

| Tag | Meaning |
|---|---|
| **[CODE]** | Read in the source, with a `file:line` you can open. Paths are relative to the project root; lines are as of commit `9c75c37`. |
| **[RAN]** | Executed today by a script in `docs/design-studio-checks/` against the real route, runner and browser modules, with every database, storage, model and network call stubbed (see section 11). |
| **[LOG]** | Taken from something you pasted: your screenshot, or the Render log recorded in `TARGETS.md`. |
| **[DOC]** | Taken from an older guide in `swatchroom/` or from `README.md`; not re-checked unless a **[CODE]** or **[RAN]** tag sits next to it. |
| **[NOT RUN]** | Reasoned from the code only. The behaviour was **not** reproduced in a browser or against a live service. |

Two limits apply to the whole document. **No live service was called** (no Modal, Gemini, MongoDB or Render), and **no browser was driven**. I did not measure any latency today. Where a number appears, its source is named. (**Section 12, added 2026-11-05, is the exception to the second and third limits**: it ran Chrome and timed one function. It still called no live service.)

---

## 1. Your questions, answered shortly

### Q1. What is the exact architecture? How many calls, to whom?

One Node server serves the website and runs the Design Studio's server code in the same process **[CODE: `server/lib/swatchroom.js:1-20`]**. The browser only ever talks to that server. The server talks to: MongoDB (rooms, jobs, files), Gemini on Vertex AI (outlines, renders, measurements), Modal GPU services (OneFormer for the scan; MoGe-2, Marigold and SAM 3 for the "understand this photo" job), and a local Python service (SegFormer-B5 and the Pick tool's SlimSAM). **The browser never calls Modal or Gemini directly** **[CODE: `swatchroom/server/routes/vision.js:1-3`, `swatchroom/server/routes/ai.js:1-3`]**.

For one **new photo**, with the configuration of this checkout's `.env` (names and layout only, section 2.3), the calls that leave the server are:

| To | How many | What for |
|---|---|---|
| Modal, OneFormer service | 1 request | the scan (what is every pixel: wall, floor, window...) |
| Local Python service | 1 request (may be cancelled if OneFormer answers first) | the same scan, locally |
| Gemini | 1 request (more only on errors) | outlines: names surfaces, splits walls |
| Modal, "VisionAll" service | 1 request | MoGe-2 + Marigold + SAM 3 together |
| MongoDB / file storage | many small reads and writes | rooms, files, job status |

Plus, around it: 0 to 2 `/healthz` wake-up pings to Modal when the page opens or the scan starts (section 3.1), and one request to your own server every 1.5 seconds while the job runs (section 8). Section 3 lists every action. **[CODE]** and **[RAN]** for the counts; details there.

### Q2. I upload a photo and it calls OneFormer. When are MoGe, SAM and the rest called?

- **Upload and scan:** OneFormer (Modal) and the local SegFormer race each other, and Gemini draws outlines at the same time. **MoGe-2, Marigold and SAM 3 are not part of the scan** **[CODE: `swatchroom/public/js/lib/detect.js:440-470`]**.
- **After the scan is saved**, the browser asks `POST /api/pipeline/analyze`. If the server does not already hold depth for **this exact photo version**, it queues a job, and the job makes **one** request to the `ANALYZE_URL` service, which runs MoGe-2, Marigold (lighting only) and SAM 3 together **[CODE: `pipelineRunner.js:40-42,277-288`]**. **[RAN]**: with `ANALYZE_URL` set, one fresh job = 1 call to `analyze`, 0 to the separate MoGe-2, Marigold and SAM 3 adapters.
- If `ANALYZE_URL` is **not** set, the same job makes three parallel requests to the three separate services **[RAN]** (1 each). In your local `.env` all five URLs are set, so the three separate ones (`SAM3_URL`, `MOGE2_URL`, `MARIGOLD_URL`) are **never used by the pipeline** while `ANALYZE_URL` is set.
- **They are never called** when you hover, tap a surface, pick a finish, press Render, switch versions, or open the history list.
- They **are** called again when the photo version being analysed has no stored depth: a new photo, or a saved room whose current version is a *render* (section 5).

### Q3. What happens when a photo is loaded from history?

The saved record, the saved scan and its label map are read from MongoDB. **No scan runs: no OneFormer, no SegFormer, no Gemini outline** **[CODE: `studio.js:839-931`]**. Then the studio calls `ensureFusion`, which asks the server. The server answers "ready" (nothing to do) only if two things are true: the stored depth belongs to the version being opened, and the plane fits were made for the scan as last saved **[CODE: `routes/pipeline.js:139-146`]**, **[RAN]**. Then the browser downloads the stored layers (depth, shading, residual, SAM masks) and uploads them to the GPU. Three cases found in the code do something else; all three are in section 5:

1. The scan was saved again since the last fit (any edit, including the automatic edge correction after you tap a surface) → a **local refit job, no Modal** **[RAN]**.
2. The room's saved current version is a **render**, not the original → a **fresh Modal analysis of that render image** **[RAN]** (server side), and the new depth overwrites the old (the room keeps one slot).
3. The same room is reopened straight after it was open → the studio can skip the load and stay on the estimate **[CODE, NOT RUN]**.

### Q4. Why does loading a selected design onto the object take noticeable time? Does it call MoGe again?

**Picking a finish never calls MoGe, Marigold, SAM, OneFormer or Gemini** **[CODE: `stage.js:473-479`, the comment "THE CONTRACT"]**. The instant preview is drawn by your GPU from data already in the browser. The wait comes from other things (section 6): the finish's texture image not yet in memory (only the first 14 of the list are prefetched), the GPU renderer being created on first use, the scene being uploaded to the GPU, the photo's light still being decoded, a tap-time edge correction, or the analysis not having finished yet. If you mean the **Render** button, that is a Gemini image request (the one step that is slow because it is an AI generation).

### Q5. Sometimes I tap the floor and a design, it looks 2D, and after a while it feels 3D. Why?

Because the studio shows an **estimate first and the real 3D fit later**. Until the room analysis has arrived (and for any surface whose fit is weak or missing), the preview is built from the surface's outline alone: four corners, an assumed 62° camera, a 2.6 m wall and a 4 m wide floor **[CODE: `fastrender/provisional.js:1-21`]**. When the analysis arrives, the real planes replace it "in place" **[CODE: `previewScene.js:1-16`]**. **[RAN]**: the selection rule behaves exactly so (section 7). A second cause, also from the code: after you make a render, the 3D data no longer matches the current version, so the preview stays on the estimate for that version **[CODE, NOT RUN]**.

### Q6. Why does the console show so many lines, even though one job had completed?

Two reasons, both from the code and your screenshot (section 8):

1. A line is printed **each time the job's status, stage or progress changes**, not once per poll and not once per job **[CODE: `studio.js:1294-1304`]**.
2. Your screenshot shows **two different jobs**: `job-mw0nvkma-3f0979ce` and `job-mw0nw8kd-cba644ef`, created 31.0 seconds apart (the id contains the creation time). The second job ran only the **local plane-fitting stage**; it did **not** call Modal. Its `sam3 / moge2 / marigold: 'pending'` is just the default label that is never updated because those models were not run **[RAN]**.

Which action started the second job (a wall split, the HD scan swap, or something else) cannot be told from the screenshot. Section 8 says how to tell.

---

## 2. The architecture

### 2.1 The pieces

```
                      Your browser (the Studio: swatchroom/public/js, drawn into /design-studio)
                        │   only ever talks to ↓
                        ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  ONE Node process (app.js): the website + the Studio's server  │
        │   server/lib/swatchroom.js mounts swatchroom/server/index.js   │
        │   /api/session /api/rooms /api/vision /api/pipeline /api/ai    │
        └──┬──────────────┬──────────────┬──────────────┬───────────────┘
           │              │              │              │
           ▼              ▼              ▼              ▼
     MongoDB (rooms,   Gemini on     Modal GPU       Local Python service
     jobs) + file      Vertex AI     services        (swatchroom/python,
     storage (GridFS   (outlines,    OneFormer       port 8001): SegFormer-B5
     or GCS bucket)    render,       VisionAll:      scan + SlimSAM "Pick"
                       measure)      MoGe-2+Marigold
                                     +SAM 3(+OneFormer)
```

| Piece | Where it is | What it does | Needed? |
|---|---|---|---|
| Studio (browser) | `swatchroom/public/js/` | Scan building, selection, instant preview on the GPU (WebGPU or WebGL2), render requests | yes |
| Studio server | `swatchroom/server/` | Routes, job queue, plane fitting, storage, Gemini and Modal clients | yes |
| Website wrapper | `server/lib/swatchroom.js`, `server/routes/studio.js`, `site/patches/` | Mounts the studio, switches its passcode off, wakes the GPUs when the landing or studio page opens | yes |
| MongoDB | `MONGODB_URI` | `Room` documents, `PipelineJob` documents, and (GridFS driver) the files | yes for saving rooms |
| File storage | `STORAGE_DRIVER` (default `gridfs`; `gcs` possible) | Photos, renders, masks, scan labels, depth, shading, SAM layer | yes |
| Gemini (Vertex AI) | `swatchroom/server/google/vertex.js` | Outlines for the scan, the AI render, the quantity estimate | needed for outlines, Render and estimates |
| Modal: OneFormer | `ONEFORMER_URL` | High-accuracy scene parsing for the scan | optional |
| Modal: VisionAll | `ANALYZE_URL` | MoGe-2 + Marigold + SAM 3 in one request | optional (see below) |
| Modal: the three separate pools | `SAM3_URL`, `MOGE2_URL`, `MARIGOLD_URL` | The same three models, one request each | only used when `ANALYZE_URL` is unset |
| Local Python service | `MODEL_SERVICE_URL` | SegFormer-B5 scan (a quantised model) and the Pick tool's SlimSAM | optional |
| PostHog | `POSTHOG_KEY` | Analytics, only if the key is set | optional |

**What each model is for** (as the code uses it):

- **OneFormer** (Swin-L, ADE20K): says, for every pixel, which of 150 classes it is, plus separate ids for each window, door and piece of furniture. It is the scan's raw material. It **cannot** separate two wall planes, because it merges every "wall" into one segment **[CODE: `remoteModels/oneformer.js:1-20`]**.
- **SegFormer-B5** (local): the same job without the per-object ids; default `b5-quant`, falls back to B4 if B5 cannot load **[CODE: `swatchroom/python/scene.py:29-39`]**.
- **Gemini outlines**: names the surfaces and proposes polygons, so that walls can be split and surfaces labelled **[CODE: `detect.js:254-266`]**.
- **MoGe-2**: depth in metres and the camera, which turn each wall, floor and ceiling into a measured plane.
- **Marigold-IID** (lighting only): a shading layer (and a residual for highlights), used to light the instant preview.
- **SAM 3**: instance masks for ten prompts: wall, floor, ceiling, rug, window, door, furniture, plant, picture frame, light fixture; at most 6 instances each **[CODE: `remoteModels/sam3.js:29-43`]**. Used to score each region, clean the points a plane is fitted to, propose wall splits, and later to correct a surface's edge when you tap it **[CODE: `pipelineRunner.js:1-16`]**.
- **SlimSAM** (local): powers the Pick tool (tap any object the scan missed). For the automatic edge correction after a tap it is used only when the SAM 3 masks are not stored yet (section 3.4).

### 2.2 What is stored, and under which key

| Stored | Where | Key |
|---|---|---|
| Room record (versions, products, notes, current version) | MongoDB `Room` | `room-…` id |
| Scan details (size, region list, `savedAt`) | `Room.scan` | **`savedAt` is set to "now" on every scan save** **[CODE: `swatchroom/server/routes/rooms.js:162`]** |
| Scan label map | file | `<room>/scan/labels` |
| Original photo; each render's raw and blended image | file | `<room>/v0/raw`; `<room>/<version>/raw` and `/blend` |
| Mask per product, thumbnail | file | `<room>/mask/<product>`; `<room>/thumb` |
| Depth, shading, residual, SAM layer (gzip) | file | `<room>/fusion/<version>/depth`, `shading`, `residual`, `sam` |
| Camera, file names, which version the depth belongs to | `Room.fusion.geometry` | **one slot per room**, with a single `versionId` |
| Fitted planes per region, wall splits, which scan they were fitted for | `Room.fusion.regions` | `computedForScanAt` = the scan's `savedAt` at fit time |
| Job status | MongoDB `PipelineJob` | `job-<time in base 36>-<8 hex>` |

**[CODE: `pipelineRunner.js:337-355,414-467`, `models/Room.js`, `models/PipelineJob.js`, `fusionStore.js`]**.

### 2.3 Which Modal services this checkout is set up to use

From a names-only check of `.env` and `swatchroom/.env` (no values were printed; only the Modal function label, the part after `--` in the address):

| Variable | Set? | Modal function label | Used by the pipeline? |
|---|---|---|---|
| `ONEFORMER_URL` | yes | `vision-oneformer` | yes, by the scan |
| `ANALYZE_URL` | yes | `vision-all` | yes, by the analysis job |
| `SAM3_URL` | yes | `vision-sam3` | **no** while `ANALYZE_URL` is set |
| `MOGE2_URL` | yes | `vision-moge2` | **no** while `ANALYZE_URL` is set |
| `MARIGOLD_URL` | yes | `vision-marigold` | **no** while `ANALYZE_URL` is set |
| `MODEL_SERVICE_URL` | yes, a local address | n/a | the local Python service |

Both `.env` files showed the same. **This is your Mac's configuration.** The Render site's values were not visible to me; `TARGETS.md` records only that `MODEL_SERVICE_URL` there is the local default address and that `ONEFORMER_URL` is present **[LOG via `TARGETS.md` C1]**.

Consequence worth knowing: because `ONEFORMER_URL` and `ANALYZE_URL` point at **two different Modal services**, a fresh photo can wake **two** GPU containers (two possible cold starts, two idle tails). The older guides describe the combined service as "one cold start, one idle tail", which holds only when both URLs point at the same `vision-all` service. **[RAN]** (`wake.targets` with two different hosts: a scan wakes `analyze`; page open wakes `oneformer` and `analyze`. With the same host: scan wakes nothing extra, page open wakes one.)

---

## 3. Who calls whom, action by action

Notation: `Browser → Server` is a request to your own server; `Server → X` leaves it.

### 3.1 Opening the landing page or the studio page

1. `Browser → Server`: `POST /api/studio/warmup {from}`, at most once a minute per tab **[CODE: `site/patches/snippets/warmup.js:17-24`]**. Controlled by `STUDIO_WARMUP` (default on) **[CODE: `server/config/settings.js:86`]**.
2. `Server → Modal`: `GET /healthz` on the OneFormer service and on each service the pipeline would call (`analyze`, or the three separate ones), **skipping any that is warm or already waking** **[CODE: `server/lib/swatchroom.js:140-141`, `swatchroom/server/lib/wake.js:25-60`]**. 90-second timeout. This sends no photo, but **it starts a GPU container, which is billed until it has been idle for the scale-down window (300 s by default)**, even if the visitor never uploads **[CODE comments: `wake.js:1-12`, `routes/studio.js:1-12`; `README.md` "Cold start"]**.
3. **[RAN]**: with two different hosts (as your `.env` layout): page open pings 2 services; a scan start pings 1 (`analyze`; OneFormer is woken by the scan request itself). With one shared host: 1 and 0.

This is the website's own addition. The studio's own design wakes GPUs only when a photo is scanned; older guides say "nothing wakes on page load" (section 10).

### 3.2 The studio starting up

| Call | To | Note |
|---|---|---|
| `GET /api/session` | your server | settings the browser needs (which engines exist, analytics key) **[CODE: `routes/session.js:37-42`]** |
| `GET /api/vision/warmup` | your server | **answers from the server's own record of its last Modal call; does not call Modal** (unless `VISION_ACTIVE_WARMUP=on`) **[CODE: `routes/vision.js:230-239`]**. The start-up splash waits for it, at most 10 s **[CODE: `startupGate.js:17`]** |
| `GET /api/rooms` | your server → MongoDB | the 60 newest rooms for the history list; thumbnails load only when the list is shown **[CODE: `routes/rooms.js` list route; `empty.js` lazy `<img>`]** |
| `POST /api/vision/warmup` (after 1.2 s) | your server → **local Python service** | loads the scan model ahead of the first request **[CODE: `studio.js:402-407`, `lib/vision.js:175-181`]**. Not Modal |

### 3.3 Uploading a new photo

In order (the numbers are the order of the code, not of time: 3 to 5 overlap):

1. `POST /api/pipeline/warmup {reason:"scan"}`, at most once per 20 s **[CODE: `swatchroom-app.js:212-219`, `studio.js:1574`]** → the server pings the services not yet warm (section 3.1, item 3).
2. The browser decodes the photo, draws it at most **1024 px** on the long side (`analysisMaxSide`) as a JPEG at quality 0.82 for the scan **[CODE: `settings.js:80-96`, `studio.js` `runScan`]**. The original (re-encoded, capped at 4096 px, 3072 on phones) is uploaded **after the scan's own requests are away, or after 2.5 s** **[CODE: `studio.js:133-139`]**.
3. **Scan race** **[CODE: `lib/segmentRace.js`]**:
   - `POST /api/vision/segment?model=oneformer` → `Server → Modal OneFormer` (semantic + panoptic, `tta` off by default) **[CODE: `routes/vision.js:108-146`, `remoteModels/oneformer.js:30-40`]**. Only if `ONEFORMER_URL` is set and "HD scan" is not switched off in Settings.
   - `POST /api/vision/segment?model=b5-quant` → `Server → local Python service`.
   - **Who starts when:** if the start-up check said Modal is cold, not set up, unreachable, or gave no answer in 10 s (`modalIsWarm === false`) → both start now. If it said warm (or has not been asked) → OneFormer starts now and the local one only if OneFormer has not answered within **2.5 s** **[CODE: `segmentRace.js:18,35`, `startupGate.js`]**. If OneFormer wins, the local request is cancelled.
   - The first engine to answer builds the scan, so you can tap at once. If the local one won and OneFormer answers later, the more accurate "HD scan" is built from the same outlines (no second Gemini call) and is **applied automatically if nothing was edited yet, otherwise offered with a banner** **[CODE: `detect.js:500-516`, `studio.js:1159-1193`]**.
   - If the model service is down (the 503 you saw on Render), the local engine fails and OneFormer alone carries the scan **[CODE: `segmentRace.js` failure path]**. If both fail, the studio falls back to Gemini outlines alone **[CODE: `detect.js:521-544`]**.
4. In parallel: `POST /api/ai/generate {task:"json"}` → `Server → Vertex AI`: the outline request (`polygonModel`, default `gemini-3.8-flash`). After **45 s** the scan carries on without it **[CODE: `detect.js:88,254-266`]**. Default on (`useGeminiAssist`).
5. The scan is built in a Web Worker in the browser (no network).
6. `PUT /api/rooms/:id/scan` (and `PUT …/files/scan/labels`), then `PUT /api/rooms/:id` (record, 700 ms debounce) **[CODE: `studio.js:767-797`, `lib/storage.js:60-96`]**.
7. `POST /api/pipeline/analyze` → the job (section 4). The browser polls `GET /api/pipeline/jobs/:id` **every 1.5 s** until done **[CODE: `studio.js:1322`]**.
8. When the job is done: `GET /api/rooms/:id` and `GET …/files/fusion/<version>/depth|shading|residual|sam` (three or four files) → the browser uploads them to the GPU **[CODE: `studio.js:1409-1505`]**.

**Totals for one new photo** (this checkout's layout; **[RAN]** for the Modal pipeline numbers, **[CODE]** for the rest): Modal inference requests **2** (1 OneFormer + 1 analyze); local Python **1**; Gemini **1**; wake-up `/healthz` pings **0 to 2** (0 if already warm).

### 3.4 Tapping a surface

The tapped region is selected **at once** from the scan. In the background the studio corrects its edge **[CODE: `studio.js:1765-1834`, `lib/samCalibrate.js:1-12`]**:

- If the SAM 3 masks of this photo version are already loaded (the analysis has finished) → they are used. **No call at all.**
- Otherwise → the local SlimSAM: `POST /api/vision/pick/embed` once per photo (the service reads the photo; the code's own comment says "a few seconds on a CPU") and `POST /api/vision/pick/mask` per surface **[CODE: `studio.js:1838-1870`, `lib/vision.js`]**. **Local Python service only; never Modal.** If that service is down, it is skipped and the scan's own outline is kept (a cooldown stops it retrying on every tap).
- If the edge changes, the corrected mask goes into the scan (`studio.js:1815-1820`). Any change to the scan **schedules a scan save 1.2 s later** **[CODE: `studio.js:458-460,767-773`]**, and every save stamps a new `savedAt` **[CODE: `rooms.js:162`]**. This matters in section 5.

### 3.5 Choosing a finish (the instant preview)

`maybeFastRender` / `runFastRender` **[CODE: `stage.js:480-624`]**. **No model call.** Network: at most one image fetch for the finish's texture, if it is not in memory. See section 6 for what takes time. **On the website the preview code is the overlay's, not the studio's own, for 8 of its files (section 12): the file names above are right, the contents of those 8 are not what `swatchroom/` holds.**

### 3.6 The Render button (or Ctrl+Enter)

**[CODE: `studio.js:2216-2484`]**

1. If a tapped surface is still being edge-corrected, the render waits for it **[CODE: `studio.js:2276-2290`]**.
2. For each of `optionCount` options (your screenshot shows Options 1, 2, 3): `POST /api/ai/generate {task:"image"}` → Vertex AI, **in parallel** **[CODE: `studio.js:2249,2326-2337`]**. The request carries: the photo or a context crop, a black/white mask, a magenta guide image (left out when the chosen image model's id contains `lite`, `render.js:85,156`), and a text brief; the brief includes the measured size, normal and field of view of the surface when the 3D data matches (section 7.4).
3. **Per Vertex request:** normally 1. On errors the server retries 429/5xx up to 3 times per request body, simplifies the body on HTTP 400, and moves to the next model id on HTTP 404 (image chain `gemini-nano-banana-2.1` → `gemini-3.1-flash-image` → `gemini-3.1-flash-lite-image`) **[CODE: `google/vertex.js:22-33,247-316`]**. So one browser call can become several Google calls.
4. After the images: one more `POST /api/ai/generate {task:"json"}` for the quantity estimate (`estimateQuantities`, default on), once per Render action, not per option **[CODE: `studio.js:2144-2182,2459-2462`]**.
5. Files written: `<version>/raw`, `<version>/blend`, `mask/<product>`, `thumb`, then the room record. **No Modal call.**

### 3.7 Which code paths can reach Modal at all

| Path | When | Billed GPU? |
|---|---|---|
| `routes/vision.js:108` (OneFormer scan) | every scan, if `ONEFORMER_URL` set | yes |
| `pipelineRunner.askModels` (`analyze`, or `moge2`/`marigold`/`sam3`) | only inside a job that needs depth | yes |
| `wake.wake` (`/healthz`) | page open (website), scan start | starts a container |
| `session.js` `pipelineModelCheck`, admin "Probe" | only when a person presses Check or Probe | starts a container |
| `warmth.probe` | only with `VISION_ACTIVE_WARMUP=on` | starts a container |

**[CODE: `pipelineRunner.js:277-300`, `wake.js`, `routes/session.js:134-160`, `routes/admin.js:82-110`, `warmth.js:60-100`]**. Everything else in the studio, including Settings → Render's status line, reads this server's **own record** of past calls.

---

## 4. The "understand this photo" job in detail

**[CODE: `routes/pipeline.js`, `lib/pipelineRunner.js`, `lib/jobs.js`]**; the decisions below were **[RAN]**.

**Step 0: the route decides whether a job is needed** (`routes/pipeline.js:139-166`):

- `needsGeometry` = no stored geometry, **or its `versionId` differs from the version asked for**.
- `needsRegions` = `needsGeometry`, or no stored regions, or regions were fitted for a different `scan.savedAt`.
- Neither → answers `{status:"ready"}`, no job. **[RAN]** (route case 1).
- A job for the room is already queued or running → answers with **its** id; no second job. **[RAN]** (route case 4). **But this check only looks at `fusion.status === "pending"`** (`routes/pipeline.js:150`), and the runner sets that field to `"ready"` as soon as Stage A has saved the geometry (`fusionStore.js:10`). **A request that arrives while Stage B is still running therefore creates a second job** **[RAN]** (route case 5). The window is short (Stage B is local maths), but it is real.
- Otherwise it creates a `PipelineJob`, and the in-process queue runs it (at most 2 at a time, `PIPELINE_CONCURRENCY`) **[CODE: `config.js:183`]**.

**Stage A, `runGeometry` (only if `needsGeometry`):**
one `analyze` request (or three), then depth, shading, residual and the SAM layer are resampled to the scan's grid, written to storage, and the geometry record is saved **[CODE: `pipelineRunner.js:302-394`]**. Status reports: `stage:"geometry"` with `sam3/moge2/marigold` `running`, then `done`.

**Stage B, `runRegions` (if `needsRegions`):**
local maths on the server: for every wall, floor and ceiling region, unproject pixels with the depth, RANSAC-fit a plane, score it, and propose wall splits **[CODE: `pipelineRunner.js:414-466`; `fusion.js`]**. Status reports: `stage:"regions"`, `fusion` `running`, then `done`. **No network.**

**When geometry is already stored for this version, Stage A is skipped and the stored depth and SAM layer are read from storage** **[CODE: `pipelineRunner.js:505-520`]**.

**[RAN] results** (counts of calls with stubbed adapters; nothing left the machine; 0 `fetch` attempts were made):

| Case | `analyze` | MoGe-2 / Marigold / SAM 3 (separate) | Plane fit | What the job reported |
|---|---|---|---|---|
| **A.** geometry for `v0` stored; scan saved since | **0** | 0 / 0 / 0 | 1 | only `stage:"regions"`, `fusion:running`, then `fusion:done`. `sam3/moge2/marigold` are **never reported** |
| **B.** no stored geometry (new photo), combined analysis | **1** | 0 / 0 / 0 | 1 | `geometry` + three `running`, three `done`, `regions` + `fusion` `running`, `done` |
| **C.** ask for a render version `v1-ab12` while `v0` is stored | **1** (on `v1-ab12/raw`) | 0 / 0 / 0 | 1 | the geometry slot now belongs to `v1-ab12`; asking for `v0` again queues **another** job |
| **D.** no stored geometry, `ANALYZE_URL` unset | 0 | **1 / 1 / 1** | 1 | same as B |

**Which statuses exist.** `PipelineJob` starts with `sam3/moge2/marigold/fusion` all `"pending"` **[CODE: `models/PipelineJob.js:22-27`]**. Only Stage A rewrites the first three. So `pending` next to `stage: "regions"` means "this stage was skipped", not "a model call is waiting".

---

## 5. A photo opened from history

**[CODE: `studio.js:839-931`]**, server decisions **[RAN]**, client-side decisions **[NOT RUN]** where marked.

**The normal path.**

1. `GET /api/rooms/:id` (the record) and the scan's label file. A missing scan → the studio runs a normal scan instead (section 3.3) on the room's first version **[CODE: `studio.js:924`]**.
2. `ensureFusion(roomId, currentId)` → `POST /api/pipeline/analyze`.
3. If "ready": `GET /api/rooms/:id` again plus the 3 or 4 `fusion/<version>/…` files, then the GPU upload **[CODE: `studio.js:1409-1505`]**. **No model call of any kind.**
4. Until step 3 finishes, any surface you tap is previewed from the **estimate** (section 7).

**Case 1: the scan was saved after the last fit.** Every scan save sets a new `savedAt`; the plane fits remember the `savedAt` they were made for. So after **any** scan change since the last fit (a surface edge corrected automatically after a tap, a paint or brush edit, the HD scan swap, a wall split) the next open finds the fits stale and queues **a job that runs Stage B only**: no Modal, a few seconds of server CPU, then the same downloads and a second GPU upload **[RAN]** (route case 2, runner case A). This is the most likely reason a history open still shows a job. Its cost is local only.

**Case 2: the saved current version is a render.** The room keeps **one** depth slot with **one** `versionId`. A photo's original is `v0`; each render is `v<n>-xxxx`. `ensureFusion` is called with the room's saved `currentId` **[CODE: `studio.js:921`]**. If the last thing you looked at was a render, the server sees a different version than the stored depth, so it **analyses that render's image again on Modal and overwrites the slot** **[RAN]** (route case 3, runner case C). Asking for `v0` afterwards queues yet another job, so alternating between versions across sessions can repeat the Modal call. Whether this is intended or not is a question for the studio's authors; **the code does it.**

**Case 3: the same room reopened right away** **[CODE, NOT RUN]**. `resetRoomState` clears the preview data but not `fusionRoomId`, `fusionVersionId` or `ui.fusion` (`studio.js:799-837`), and `ensureFusion` returns immediately when the room, the version and a status of ready / checking / running are all unchanged (`studio.js:1224-1232`). The rooms list does not stop you opening the room that is already open (`views/empty.js:62-72`). So "close room, open the same room" or "Saved rooms → the same room" with the same current version can leave the preview on the estimate with nothing reloading it. I did not reproduce this in a browser; treat it as a suspected gap until someone does.

**Switching to another version inside a session.** `selectVersion` / `stepVersion` only change `currentId` (`studio.js:2507-2525`); nothing starts a job. The 3D data is used only while its `versionId` equals `currentId` (`studio.js:2935`), so on any render version the preview falls back to the estimate (section 7).

---

## 6. Why picking a design can take time

**[CODE]** unless marked. I measured none of these.

| What happens | Where | Notes |
|---|---|---|
| **The finish's texture is not in memory.** The studio fetches the image, decodes it and resizes it to 640 × 448 | `renderer.js:29-30,47-58,247-266` | The studio prefetches only the first **14** textures of the list you are looking at (current kind, tab and search) `studio.js:1337-1357`. Any other pick waits for a network fetch. With the texture in memory the pick is drawn on the next frame with no request |
| **The GPU renderer is created on first use** (WebGPU, or WebGL2) | `stage.js:452-471` | once per page |
| **The scene is uploaded to the GPU** (labels, depth, shading, camera, planes) | `stage.js:562,572` | on the first draw, and **again every time the scene's `geometryKey` changes**: when the real analysis replaces the estimate, and after each refit job (the key includes a counter, `studio.js:1476-1482`) |
| **The photo's own light has not been decoded yet** | `studio.js:1370-1397`, `previewScene.js:22` | until it is ready the estimate cannot be built: **no preview is drawn at all** **[RAN]** (`compose` returns null) |
| **Edge correction after the tap** | section 3.4 | With no stored SAM masks it asks the local Python service; the preview's edge can move when that answers |
| **The analysis has not finished** | section 4 | the preview is an estimate, then is swapped (section 7) |
| **The Render button** | section 3.6 | a Gemini image generation. The time is Gemini's, plus the retries and model fallbacks above. Each `ai:image` console line prints its `ms` |

A number that exists: in headless Chrome on an Apple Silicon Mac, with the texture already in memory, pointer-down to the first changed frame took 31 to 49 ms **[DOC: `swatchroom/ARCHITECTURE.md`, 2026-10-26 evening log, scenario G]**. That is the best case. It was not measured on a phone or with a texture that had to be fetched.

---

## 7. Why it can look 2D first and 3D later

### 7.1 The two kinds of preview

| | Estimate ("provisional") | Real fit ("fused") |
|---|---|---|
| Built from | the surface's outline only: four corner points, a **62°** assumed camera, a **2.6 m** wall height, a **4 m** wide floor; light taken from the photo itself, blurred | MoGe-2 depth and camera (real metres and perspective), Marigold shading |
| Marked as | "flagged", confidence **0.6** | confidence from the plane fit |
| When | before the analysis is loaded, for a surface the fit does not cover or scores below **0.3**, and on a render version | once the job is done and its layers are loaded, for a version whose id matches |

**[CODE: `fastrender/provisional.js:1-21`, `previewScene.js:1-16`, `settings.js:107-110`, `fastrender/tiers.js:12-30`]**. That is the studio's own estimate. The website's overlay changes how the estimate's geometry and light are made (a level-camera guess for floors, ceilings and head-on walls instead of the four corners; the light read inside each surface instead of one blur), see section 12.

### 7.2 What the selection rule does (executed)

**[RAN]** with the real `previewScene.js` and `tiers.js` (the estimator is a stand-in: the choice between estimate and fit is the real code):

```
analysis not arrived (fused=null), photo light loaded      → estimate for every region
analysis not arrived, photo light NOT loaded yet           → null: nothing is drawn
analysis arrived, every fit trusted                        → real fit  (key fused:…:1)
analysis arrived, one wall scored 0.2 (< 0.3)              → that wall: estimate, others real (key …+wall-1)
analysis arrived, a wall has no fit (split/outlined later) → that wall: estimate (key …+wall-2)
a refit job finished and the payload was reloaded          → key changes (…:1 → …:2): full GPU re-upload
confidence 0.9 / 0.6 / 0.29 / none  → fast / flagged / gemini-only / gemini-only
furniture (no fit → no confidence)  → no instant preview; the AI render only
```

### 7.3 The sequence you can see, in order

1. Photo uploaded and scanned. No analysis yet. Tap the floor, pick a design: **estimate** (after the photo's light has been decoded).
2. The job finishes, the layers download: the scene is **replaced in place by the real fit**. This is the moment it "starts to feel 3D": proportions, perspective and shading change.
3. If the scan then changes (HD scan swap, wall split) and a refit job runs, regions the old fit did not know **borrow the estimate** until the refit has loaded; then the scene is replaced again.
4. When the tap-time edge correction changes the surface's mask, the outline and the painted area change slightly (the preview's label map and alpha are replaced, `stage.js:562-598`).

### 7.4 After a render, it can stay on the estimate **[CODE, NOT RUN]**

A render adds a new version (`v<n>-xxxx`) and makes it current (`studio.js:2442`). Nothing starts a job for it. The 3D data is accepted only when its `versionId` equals the current version (`studio.js:2933-2936`), so on that version `fused` is empty and the estimate is used. The **same gate** also stops the next Render from sending measured geometry and the preview blend to Gemini (`studio.js:2296-2301`). Settings → Render's "This room: …" line shows the last job's state, not whether the current version matches, so it can read "ready" while the preview is on the estimate (`dialogs.js:392`).

How to tell which case you are in: select the **Original** version, wait until Settings → Render says the room is ready, then tap the floor and pick a design. Compare with the same on a render version.

---

## 8. Your console screenshot, line by line

The screenshot shows `[swatchroom] model in use: room pipeline {…}` from `modelLog.js:39`, written by `studio.js:1296`.

**Why a line appears.** The browser polls the job every 1.5 s (4 s after a network error), and prints a line **only when the combination status, stage, progress, error has changed since the last line** **[CODE: `studio.js:1283-1304,1322,1328`]**. So the number of lines is the number of distinct states the job was seen in. The server reports these states for a full job **[RAN]**: `queued`; `running` with no stage yet; `geometry` with the three models running; `geometry` with the three done; `regions` with fusion running; `regions` with fusion done (which lasts an instant, until the job is marked done); `done`. That is **up to seven lines** for a full job, and **up to five** for a regions-only one (`queued`, `running`, `regions`/running, `regions`/done, `done`). A poll every 1.5 s can miss a short state, so you see fewer.

**What your screenshot contains** (only the lines visible):

| # | Job | status | stage | progress |
|---|---|---|---|---|
| 1 | (cut off, top) | running | geometry | (not visible) |
| 2 | `job-mw0nvkma-3f0979ce` | running | regions | sam3, moge2, marigold **done**; fusion **running** |
| 3 | `job-mw0nvkma-3f0979ce` | **done** | regions | all four **done** |
| 4 | `job-mw0nw8kd-cba644ef` | running | *(empty)* | all four **pending** |
| 5 | `job-mw0nw8kd-cba644ef` | running | regions | sam3, moge2, marigold **pending**; fusion running |

- **Job 1** was a full job: it called the models (line 1 is its geometry stage) and finished (line 3).
- **Job 2** is a **different job**. The id carries the server's creation time in base 36 **[CODE: `routes/pipeline.js:88-90`]**; decoded: job 1 at `2026-11-03T12:25:49.090Z`, job 2 at `2026-11-03T12:26:20.125Z`, **31.0 s apart** **[computed from your screenshot]**. Job 1's `done` line (line 3) was printed **before** job 2's first line. A job's polling chain is dropped the moment `ensureFusion` is called again (`studio.js:1210-1218,1240`), so a `done` line can only be printed while no newer job has been requested. So job 2 was requested after job 1 had been seen done. (The server-side duplicate check does not by itself guarantee that; see section 4, route case 5.)
- **Job 2 ran only the local stage**: it jumped to `stage: regions` with the three model keys still `pending`, which is exactly what a regions-only job reports **[RAN]** (runner case A). **It did not call Modal.** "Pending" is the untouched default, not a waiting request.

**What can start a second job on the same photo.** `ensureFusion` has **four** call sites in total **[CODE]**: after a scan finishes (`studio.js:1095`), on opening a room (`:921`), after the HD scan is swapped in (`:1189`), and after a wall split is applied (`:1553`). The scan, HD-swap and split calls first clear the "already done" guard (`fusionVersionId = ""`); the open does not. Since job 1 had already finished, the two likely ones are:

- **The HD scan swap** (OneFormer answered after the local scan; toast "Switched to the HD surface scan."). This needs the local engine to have answered first. On the Render site, where the local service answered 503, the local engine fails and no swap happens.
- **A wall split** applied from the analysis result (toast "This wall is N planes, so it is now N surfaces." with an Undo button).

**I cannot tell which of the two it was, or whether this screenshot is from your Mac or Render.** If you saw a toast, the text says which. The `[swatchroom] model in use: scan {engine, model}` line also shows whether the scan came from `scene` and which model.

**The calls you see in the Network tab** (filter `/api/`): the `GET /api/pipeline/jobs/job-…` repeats are your browser asking your own server how the job is going (one per 1.5 s while it runs: a 25 s job is about 17 requests). They read one document in MongoDB. **They are not calls to Modal.**

---

## 9. How to see for yourself what is happening

| You want to know | Look at |
|---|---|
| Did a model run? | Network tab, filter `/api/pipeline/analyze`: the answer is `{"status":"ready"}` (nothing run) or `{"jobId":…}`. A job id then `jobs/<id>` polling. In the **server log**, a line `[pipeline] room-… analysed in N ms` marks each finished job; a regions-only job is much faster than one that called Modal |
| Which Modal calls happened? | Server log; the owner dot (sign in at `/admin`, open the studio) lists cold start versus processing per call **[DOC: `swatchflow.md` Part 6; `coldStart.js`]** |
| What the scan used | Console: `[swatchroom] model in use: scan {engine, model}` |
| Gemini calls and times | Console: `[swatchroom] model in use: ai:json {…, ms}` (outlines, estimate) and `ai:image {…, ms}` (render). Server log: `[ai] image ok: requested …, used …, (attempt N, N ms)` **[CODE: `lib/ai.js:12-19`, `routes/ai.js:107-114`]** |
| The state of this room's analysis | Settings → Render → "This room: …" (reads the last job; section 7.4) |
| Why the preview looks flat | Is it the Original or a render version? Is "This room" ready? Did a toast say the scan was swapped or a wall split? (sections 5, 7) |

---

## 10. Where the older guides are out of date

Each row was checked today against the code. The appendices below are left exactly as they were.

| Older statement | Where | What the code says today |
|---|---|---|
| The browser polls the job "every 4 s (`studio.js:1161`)" | Appendix A, Part 2 | **Every 1.5 s**; 4 s only after a network error (`studio.js:1322,1328`) |
| `ensureFusion` is triggered "(a) after a scan … (b) when a saved room … is opened" | Appendix A, Part 2 | **Four** call sites: after a scan (`:1095`), on opening a room (`:921`), after the HD scan swap (`:1189`), after a wall split (`:1553`) |
| "Nothing wakes on page load; only a scan asks for a wake-up" (`UPGRADE_SUMMARY.md:55`); "Nothing wakes a GPU because a page opened" (`DEPLOY.md:156`); "never because a page opened" (`ARCHITECTURE.md:14`) | Appendices E, D, A | True of the studio on its own. **The website adds a wake-up when the landing or studio page opens** (`STUDIO_WARMUP`, default on; section 3.1; `README.md` "Cold start") |
| "`/pipeline/warmup` fires silently on studio open" | Appendix B §7; Appendix C Part 6 | It no longer does: it is sent when a photo is added or scanned, throttled to once per 20 s (`swatchroom-app.js:212-219`). Page-open wake-up is the website's `/api/studio/warmup` |
| "`modalBlueprint.py` in this repo is also empty (0 bytes)" | Appendix B §0 | It is 106,074 bytes today |
| "One photo = one cold start and one idle tail" | Appendix A update box; Appendix E §3 | Only when `ONEFORMER_URL` and `ANALYZE_URL` point at the **same** Modal service. In this checkout they are two services (section 2.3) |
| Part 2: SAM 3 "Not stored" / three prompts | Appendix A, Part 2 table | Already marked as changed in its own update box: masks are stored, ten prompts. Confirmed (`sam3.js:29-43`, `pipelineRunner.js:324-336`) |
| Modal cold-start and warm timings | Appendices B and C | From the **2026-10-24 log of the old three-pool deployment**. Not re-measured for the current deployment (a VisionAll service exists since 2026-10-26 in the file; its deployment was never confirmed by me) |
| SegFormer and Gemini timings, "Put together" total | Appendix C, Part 6 | The file itself marks them **unverified**, and Appendix B §0 says an earlier version of that section was not real. Nothing here re-measures them |
| Line numbers in Appendix A (for example `studio.js:997-1011`, `:1161`, `stage.js:457`) | Appendix A | Moved; use the ones in sections 3 to 8 |
| "Part 3a: Instant preview (3D path, in the browser)": the shader, the clamp 0.35 to 1.65, the exposure bounds, the four-corner estimate | Appendix A, Part 3a | True of the studio's own files in `swatchroom/`. **On the website 8 of those files are served in an improved version** (clamp 0.2 to 2.5, exposure 0.45 to 1.5, a level-camera guess, the light read inside each surface, a light colour, a soft edge on both sides, anisotropic filtering, seam repair): section 12 |

---

## 11. What was verified, and what was not

### 11.1 How it was verified

- **Read:** `studio.js` (ensureFusion, polling, history, scan save, calibration, versions, render, preview gates), `stage.js` (fast render), `previewScene.js`, `fastrender/{provisional,tiers,textureStore,renderer}.js`, `detect.js`, `segmentRace.js`, `startupGate.js`, `swatchroom-app.js`, `lib/{ai,vision,storage,settings}.js`, and on the server `routes/{pipeline,vision,ai,rooms,session}.js`, `lib/{pipelineRunner,jobs,wake,warmth,fusionStore,pack}.js`, `remoteModels/*.js`, `google/vertex.js`, `config.js`, `models/{Room,PipelineJob}.js`, plus the website's `server/lib/swatchroom.js`, `server/routes/studio.js` and `site/patches/snippets/warmup.js`. All six existing `.md` guides were read.
- **Run, with everything stubbed** (`docs/design-studio-checks/`):
  - `verify_pipeline.cjs` loads the **real** `routes/pipeline.js` and `lib/pipelineRunner.js`. Before the studio's `config.js` is loaded, every `*_URL` is pointed at a closed local port and `fetch` is replaced by a function that throws and counts; the database models, storage, `fusionStore`, `fusion.runFitRegions` and the four model adapters are stubbed. Result: 5 route decisions, 4 runner cases, and the wake-up targets (sections 4, 2.3, 3.1). **0 fetch attempts were made.** A first version of the script gave wrong counts because jobs queued by one test kept running in the background into the next; it was fixed by stubbing the runner during the route tests, and the counts above are from the fixed version.
  - `verify_preview.mjs` loads the **real** `previewScene.js` and `fastrender/tiers.js` and checks the selection rule (section 7.2). The outline estimator is a stand-in.
  - Run them with `node docs/design-studio-checks/verify_pipeline.cjs` and `node docs/design-studio-checks/verify_preview.mjs`.
- **Names-only look at `.env`** (section 2.3). No secret was printed.
- **Decoded** the two job ids from your screenshot (section 8).

### 11.2 Not verified

- **Anything live.** No call to Modal, Gemini, MongoDB, PostHog or your Render site. So: whether a Modal service answers, how long it takes, what it returns, what it costs.
- **Any browser behaviour.** The client-side claims (sections 5 case 3, 6, 7.3, 7.4) come from reading the code and from running the pure modules. **I did not open the studio.** In particular: the same-room reopen gap (5, case 3) and the "stays on the estimate after a render" behaviour (7.4) are **suspected from the code, not reproduced**.
- **Which action started your second job** (section 8), and **whether the screenshot came from your Mac or from Render**.
- **Your Render settings.** Only your Mac's `.env` layout was read. Whether the live site has `ANALYZE_URL`, a shared or separate pool, or `STUDIO_WARMUP` on is not known to me beyond what `TARGETS.md` records.
- **The Modal deployment itself.** That a `vision-all` service is deployed, that its `/v1/analyze` has the shape the adapter expects, and that the snapshot and GPU lists behave as the file says were not checked. I read the file's routes only (`/v1/analyze`, `/v1/parse`, `/v1/oneformer`, `/v1/geometry`, `/v1/decompose`, `/v1/segment`, `/healthz`), not its deployment.
- **Latency of anything.** I measured none. The only figures quoted are labelled with their source.
- **Whether the gaps in sections 5 and 7.4 are intended.** The studio is a verbatim copy of your separate project; if they are defects, the fix belongs there, not in `swatchroom/` here.

### 11.3 The one-paragraph version

A photo costs two Modal inference requests (OneFormer for the scan, one combined request for MoGe-2, Marigold and SAM 3 for the depth), one Gemini request for outlines, and one local Python request, plus wake-up pings. Everything after that (tapping, picking, hovering, history opens that find saved depth for the same version, refits, wall splits, the HD scan swap, polling) is your server, your database and your GPU, not Modal. The things that can call Modal again are a new photo and opening a room whose saved current version is a render. The "2D, then 3D" look is an estimate being replaced by the real fit, and it can stay on the estimate after a render. The many console lines are state changes of two separate jobs, and the second was local only.

---

## 12. The instant preview's quality overlay: the website's preview is not the standalone studio's

*Added 2026-11-05. Evidence tags as in section 0. Everything below was run with no live service (no Modal, Google, MongoDB); the browser runs used Chrome 156 on one Apple M5 Mac.*

**In one paragraph.** You said the instant preview's lighting, texture and fitting looked low quality. Eight (since 2026-11-05 nine, section 12.9) of the studio's browser files (the 3D draw of a finish on your photo) are now served from improved copies in `site/overlays/studio/`, **ahead of** the studio's own copies of the same addresses. `swatchroom/` itself is **not edited** by this (`git status swatchroom` is clean, and 13 of the 14 preview files the overlay depends on are byte-identical to your original folder, checked with `diff -rq` on 2026-11-05; the 14th, `fastrender/previewReason.js`, is the 2026-11-04 edit you approved, which your original does not have). The consequence you must keep in mind: **the website's instant preview is no longer the standalone studio's.** The same photo and finish are drawn differently on the website and in your own Swatchroom project, until you take the patch (12.7) into your project.

### 12.1 What is served, and from where

The studio's page imports its modules by relative address (`/js/views/stage.js` imports `../lib/fastrender/renderer.js`, and so on), so they are fetched from `/js/lib/...` **[CODE: `swatchroom/public/js/views/stage.js:20-21`, `studio.js:51-55`, `lib/geometryFacts.js:5`]**. In a real browser the studio loads all 14 preview files at start-up from these addresses and nothing else **[RAN: `render-preview/site-check.mjs`, section 12.3]**.

| Address | Served from | What changed |
|---|---|---|
| `/js/lib/fastrender/geometry.js` | **overlay** | shading clamp, exposure bounds, the photo's light colour; (2026-11-05, 12.9) a finish's own tile size and sheen, the crop and the tone flattening of a photograph |
| `/js/lib/fastrender/provisional.js` | **overlay** | the light read inside each surface; the level-camera guess; (2026-11-05, 12.9) the estimate for doors, furniture and other objects |
| `/js/lib/fastrender/renderer.js` | **overlay** | the light colour passed on; seam repair of the finish's tile image; (2026-11-05, 12.9) the loader for a catalogue design's photograph, the tile size, slots for walls first |
| `/js/lib/fastrender/shaders/swap.glsl.js` | **overlay** | soft edge on both sides; light colour; highlight roll-off; new clamp |
| `/js/lib/fastrender/shaders/swap.wgsl.js` | **overlay** | the same, for WebGPU |
| `/js/lib/fastrender/webgl2.js` | **overlay** | the light-colour uniform; 8x anisotropic filtering |
| `/js/lib/fastrender/webgpu.js` | **overlay** | the light colour in the globals block; 8x anisotropic sampler |
| `/js/lib/previewScene.js` | **overlay** | passes the light colour through for a fitted scene; (2026-11-05, 12.9) borrows the estimate for every kind it covers |
| `/js/lib/fastrender/previewReason.js` | **overlay** (since 2026-11-05) | only the wording of "no-fit" |
| `/js/lib/fastrender/{device,lru,sizing,textureStore,tiers}.js` | the studio, unchanged | (the overlaid files import them) |
| every other `/js/...`, `/css`, `/fonts`, `/textures`, `/api` | the studio, unchanged | |

**How [CODE: `app.js`, `server/middleware/studioOverlay.js`].** `app.use('/js', overlay)` sits just before `app.use(studio.app)`. Like the website's other files (and as `tests/js/server-startup.test.js` requires: the website never uses `express.static`) the overlay is served from a **fixed list of names**, the files found in `site/overlays/studio/js/` when the server starts, by `res.sendFile`: a GET or HEAD whose path is exactly one of them is answered, anything else (a miss, another method, `..`, the manifest next to the folder) falls through to the studio. The headers are the studio's own policy for its `/js` files: `Cache-Control: no-cache` plus the weak ETag and Last-Modified that Express's file sending adds, so a browser asks each time and gets a cheap 304, and the same `Content-Type` as the studio's own files (a test compares them). Overlaid answers carry `X-Terucon-Overlay: studio-preview` (the studio's own never do), which is how a browser test tells them apart. The header table in `app.js` has the line. With no `site/overlays/` folder it is a silent no-op, which is also why every other studio test (whose throw-away project has none) runs the studio's own files.

### 12.2 What the four fixes change

The instant preview, in order **[CODE: `fastrender/*`, `previewScene.js`]**: the scan's masks and the photo's light (`geometry.lumaFromRgba`) make a scene (the estimate, `provisional.js`, or the real fit, `previewScene.js` choosing between them, section 7); `renderer.uploadScene` packs each surface's homography, its median light and its exposure; the shader, per pixel, takes the surface's own pattern of light divided by its median (clamped), multiplies it into the finish's texture (sampled in perspective), applies exposure and a highlight, converts to sRGB.

**Fix 1: lighting.**

* The clamp on that "light divided by median" was 0.35 to 1.65 (so a surface could keep at most a 4.7 : 1 sun-to-shade range); it is now **0.2 to 2.5** (12.5 : 1), in `geometry.js` and in both shaders (a test keeps the three equal).
* `exposureFor` (how far a dim or bright room moves a finish) had exponent 0.35 and bounds 0.7 to 1.25; it is now **0.6 and 0.45 to 1.5**. A room with a third of the reference light darkens a finish to 0.52 (it was held at 0.7).
* The **estimate's light** (the part before the room analysis arrives, and for surfaces the fit does not cover) was the whole photo blurred once with a box of radius 3% of the long side (about 30 px on the 1024 px scan). That erased the sun and shadow edges that carry a room's look, and mixed the brightness of the neighbours (a cove light, a window, a dark sofa) into a surface's edge. It is now a **guided filter** (He, Sun, Tang 2010) on log luminance, computed **inside each wall, floor or ceiling region with that region's mask as the weights**, so nothing outside the region contributes. Detail finer than about 4 px (plank grain, grout: the old finish) is removed first, detail weaker than about 25% in luminance is flattened, stronger edges stay. Outside the painted surfaces the old blur is kept (those pixels are never drawn).
* The **colour of the room's light**: `lumaFromRgba` also returns the photo's mean colour as linear RGB scaled to luminance 1, each channel kept within 0.55 to 1.7. The renderer applies **30%** of it and the shader multiplies it into the lit colour (the 30% is a value chosen by eye: 60% gave peach floors on both test photos).
* **Highlight roll-off**: when the brightest channel of the lit colour passes 0.85 it is pulled toward 1 along `0.85 + 0.15 (1 - e^(-(p - 0.85)/0.15))`, scaling all three channels together so the hue stays (a sunbeam on a pale finish used to clip each channel on its own into flat white or flat yellow).

**Fix 2: edges and filtering.**

* A pixel that has no painted region of its own (outside every region, or in a region that has no finish yet: the wall beside a painted floor) now **takes the label of a painted 4-neighbour**, so the soft alpha edge the shader already had can fade on **both** sides of a boundary; before it could only fade inward, which left a one-scan-pixel staircase along every edge. In both shaders.
* **8x anisotropic filtering** of the finish: WebGL2 asks for `min(8, what the GPU allows)` where `EXT_texture_filter_anisotropic` exists; the WebGPU sampler has `maxAnisotropy: 8` (with all three filters linear, which that needs). The shader already hands the GPU the exact, very unequal footprint of a floor receding in perspective; without anisotropy the far floor was filtered over a square of the longer side and turned to mush.

**Fix 3: a level-camera guess for the estimate's geometry.** The estimate used the four extreme points of a surface's outline as a quadrilateral. A floor that runs off both sides of the picture (nearly every floor) has a rectangular outline, so its estimate was a flat poster **4 m wide with no perspective**; a wall with furniture in front has corners taken from the furniture's cut-out, which shears the mapping (bricks sloping about 15 degrees on a head-on wall). Now, for a **floor, a ceiling and a head-on wall**, the estimate assumes the camera is **1.5 m above the floor and looks (nearly) level** (the horizon is put 6% of the picture's height above the floor's top row, and never below the picture's centre), the ceiling is **2.6 m** high, and a head-on wall stands where it meets the floor. That gives real perspective and a real scale from two assumed numbers; it is a **guess, not a measurement**. It is used only where it can hold: a floor or ceiling on its own side of the horizon, and a wall whose top edge is level to within 3% of the picture's height (the bottom edge if the top is cut by the picture's border); everything else keeps the old four-corner estimate. It does not touch the real fit.

* **[RAN, by me, on the studio's own function and the overlay's]** for a floor mask that runs across the whole picture (1024 x 683, top at 62%): the studio's estimate has a vanishing term of 8e-22 (a flat poster: 4.00 m wide, 1.01 m deep, the same metres per row at the near and the far end); the overlay's has -1.2e-3, and one picture row covers **17 times more floor at the back than at the front**.
* One number changes meaning: a head-on wall's `sizeM` is now what the camera guess gives (4.1 m high for the test scene in `studio-overlay-behaviour.test.js`), not the constant `WALL_HEIGHT_M` 2.6. `sizeM` is not read anywhere outside `provisional.js` **[CODE: grep of `swatchroom/public/js`]**; only the homography draws.

**Fix 4: texture seams.** The studio's finish textures (`swatchroom/public/textures/`, 67 files) are not seamless: the drafter's sheet of eight of them tiled 2 x 2 (oak planks, teak, brick, kota, herringbone, checker, terrazzo, slate), which I looked at on 2026-11-05, shows a visible seam at the tile borders on seven (not on brick); I did not look at the other 59. On load, within 12% of each border, the tile is cross-faded into a copy of itself shifted by half a tile, which is continuous across those borders (smoothstep weights, the middle untouched). It **hides the line; it cannot repair a pattern whose structure is cut at the border (it ghosts there)**, so the real fix is seamless files, which this does not provide.

### 12.3 What was measured

**Tests (Node, no GPU) [RAN]:**

* `tests/js/studio-overlay-behaviour.test.js`, **44 tests**, run against the file set a browser gets (the studio's `public/js` with the overlay laid over it): **28 are the studio's own `swatchroom/tests/fastrender.test.js`, ported** (it is not edited): 25 unchanged and passing, **3 changed on purpose** (below), and **16 new**: the light colour (3: the maths, the 30% reaching the backend, `previewScene.js` passing it on for the fitted path, the estimate path and a weak fit that borrows the estimate), the light read inside a surface (2: no leak from a window 30 times brighter; the sun/shade edge, the old finish's grain and a smooth fall-off at the real scan size), the level-camera guess (2, against an independent derivation from the camera's pose in world coordinates), the shaders (4: the clamp equal to `geometry.js`, the roll-off curve, the light colour wiring including where WGSL's block puts it, the label borrowing in both sources), the backends against a fake GL and a fake GPU device (3: `u_tint` on every draw; anisotropy 8, less where the GPU allows less, none without the extension; the WebGPU sampler and the globals block), the seam repair through the real texture loader (1), and one that fails when the studio's own test list gains a test that is not ported (1). With the overlay left out, 17 of the 44 fail (the 3 changed ones and 14 of the 16 new; the clamp-parity test and the list check pass either way), so the tests do tell the two apart.
* The three changed tests assert, in the studio's file, the old values on purpose: *"the shading multiplier … clamped to [0.35, 1.65]"*; *"exposureFor(): gentle, bounded"* (0.7 and 1.25); *"provisional: buildProvisionalScene() … keeps only the lighting"*, whose bound "shading is smooth where the photo flickers" (0.02) now reads 0.022, still 26 times smoother than the photo's own 0.58, and which hides a **fourth** assertion behind the first: "a wall is 2.6 m tall" no longer holds for a head-on wall (4.125 m in that synthetic scene). The studio's own test run therefore reports 3 failures for 4 changed assertions. The studio's tests test `swatchroom/`'s own files, which are unchanged, so `npm run test:swatchroom` still passes as before.
* `tests/js/studio-overlay.test.js`, **13 tests**: the guard (12.6, including that a stray `.DS_Store` breaks nothing), the bytes and headers served (every overlaid address returns the overlay's bytes, the studio's content type and cache policy, validators, 304, HEAD, br and gzip; 11 other studio files return the studio's own bytes with the same kind of headers and no marker; misses, other methods, traversal and the manifest are not served), the switch (the env file, read on the next request), the silent no-op without the folder.
* `tests/js/server-studio-parity.test.js`: one added test says its project has no overlay, so it still compares the studio's own files with the studio's own files (it **cannot** notice the overlay: it compares other files).

**Browser, real WebGL2 and WebGPU [RAN]: `docs/design-studio-checks/render-preview/`** (`run-all.mjs` and `site-check.mjs`; the README there says what the pictures are). Four hand-masked surfaces on two photos (`media/p02-lobby.jpg`, `p04-clinic.jpg`), the studio's own estimate geometry and a hand-built plane, studio code against overlay:

| surface | how closely the render's light follows the photo's (1 = same) | sun/shade ratio, photo / studio / overlay |
|---|---|---|
| lobby floor, oak | 0.796 to 0.958 | 3.44 / 2.62 / 2.76 |
| clinic floor, oak | 0.912 to 0.983 | 4.52 / 3.98 / 4.33 |
| lobby wall, brick | 0.478 to 0.821 | 2.18 / 2.39 / 2.19 |
| clinic wall, limewash | 0.502 to 0.861 | 1.70 / 1.55 / 1.63 |

* **WebGL2 against WebGPU**, same scene, the overlay's code: at most 1 level of 255 apart, on no pixel more than 8 (the studio's code: identical).
* **The website serves what that draws**: with the real website started on throw-away settings (`tests/dev/stack.mjs`), the 14 module addresses return the manifest's bytes (8 overlay with the marker, 6 the studio's; since 2026-11-05: 9 and 5), the studio page opens and loads exactly those files at start-up with no console error, and 8 pictures drawn from the modules the website serves are **pixel-identical** (0 difference) to the same scenes drawn by the check's own server; with `STUDIO_PREVIEW_OVERLAY=off` the same 8 equal the studio's own, and all 8 differ between on and off.
* The 16 pictures (4 surfaces x studio/overlay x estimate/plane) are pixel-identical to the reference pictures the drafter of the fixes had made earlier on the same computer.
* **The studio still starts and its pages load cleanly with the overlay on** [RAN]: `tests/e2e/run.mjs` with `E2E_ONLY=studio` (26 tests: the studio opens inside the site, its splash and sign-in, the cold start, the camera, the header over the studio, TeruBot in the studio, the catalogue finishes, the loader and its motion) and `E2E_ONLY="Design Studio"` (5 tests, including "secrets and source code are never served"), **31 of 31 passed**, against the final middleware (the 26 started just before a three-line skip of hidden files such as `.DS_Store` was added to it, and a banner sentence changed afterwards; the 5 ran after the skip). The dev stack copies `site/`, so the overlay was served (site-check.mjs shows the markers). Those tests fail on any console error or failed request of a page. None of them draws an instant preview (it needs a scan).
* **Cost:** `buildProvisionalScene()` (once per scan) 9 ms with the studio's code, 27 to 34 ms with the overlay's, in Chrome on that Mac at the 1024 px scan. Not measured on a phone.

### 12.4 Honest negatives

* **The light colour is the least certain change.** It reads the photo's mean colour, which mixes the room's light with the colour of its biggest surfaces; a room that is mostly one strong colour is tinted wrongly (hence the clamp and the 30%). On both test photos it makes the floors warmer; whether you like that is yours to judge by eye.
* **The old finish can ghost through** on a strong pattern: the light is estimated from the photo, and a pattern with more than about 25% luminance contrast reads as light. `render.mjs ... oldpattern=checker` draws the worst case.
* **The level-camera guess was never tried on a real fused fit** (it replaces only the estimate), nor on a scan model's real masks (the masks are hand-drawn), and its two numbers (1.5 m, 2.6 m) are assumptions. A floor whose top edge is just below the horizon gets an enormous depth (a synthetic floor starting at row 35 of a 100-row picture comes out 31 m deep); only the homography draws, but a photo taken from a very high or very low camera will be off.
* **The seam repair hides a line, it does not fix a texture.** Ghosting where a pattern is cut at the border; seamless texture files are the real fix. It runs on every texture load, a full-tile read and write of pixels on the CPU: not timed.
* **A fourth assertion changed in the studio's tests** besides the three you were told about (12.3).
* **The website's preview now differs from your own Swatchroom's**, and `server-studio-parity.test.js` will not say so (12.8).
* **More work per scan**: the estimate takes three to four times as long as it did (12.3).

### 12.5 What was not verified

* **A real phone** (the overlay was only drawn in desktop Chrome; a phone's GPU, memory and `EXT_texture_filter_anisotropic` support may differ; the CPU cost of the estimate and of the seam repair on a phone).
* **Any GPU but the Apple M5** it was run on, and WebGPU on anything else. The drafter and I used the same computer.
* **A real fused fit** (live Modal, MoGe-2, Marigold) or a real scan model's masks; **the studio's other 59 textures** (only the eight of the sheet were looked at; Terucon's own catalogue designs have no instant preview at all, `docs/CATALOGUE_STUDIO.md`); **the studio's own interface around the preview** (`tests/e2e/run.mjs` proves the studio still starts and its pages load cleanly with the overlay on; no browser test draws a preview, because a scan needs the live models). Whether the result looks better to you on your own photos: **not asked of anyone yet**.

### 12.6 When `swatchroom/` is copied in again (the guard)

`site/overlays/studio/manifest.json` records the SHA-256 of **every** file in `swatchroom/public/js/lib/fastrender/` (13) and of `previewScene.js`, as they were when the overlay was merged with them (including the six the overlay does not replace, because the overlaid files depend on their interfaces), and of the 8 overlay files. **`tests/js/studio-overlay.test.js` fails, naming the file, if any of them differs:**

> upstream changed js/lib/fastrender/webgl2.js (an overlaid file: its improvements must be merged into the studio's new version): re-merge the overlay, then update the manifest with `node tools/studio-overlay-manifest.js`

(`upstream removed` and `upstream added` likewise; `node tools/studio-overlay-manifest.js --check` prints the same without running the tests.) A second test checks that every name the studio's files import from an overlaid module is still exported by the overlay. To merge: run `--check`; for each overlaid file the studio changed, take the studio's new file, apply the overlay's change to it (`docs/design-studio-checks/instant-preview-quality.patch` is exactly that change, the 9 files as a diff; `git apply --3way` helps), copy the result into `site/overlays/studio/js/...`; run the two overlay test files; run `node docs/design-studio-checks/render-preview/run-all.mjs` and look at the grids; then write the manifest. **Without this, a re-copy would silently put the old preview back in front of any change you made in your project.** If none of the 14 files changed, a re-copy needs nothing. (Guard failure was shown on purpose: one hash in the manifest was altered and the test failed with the message above; restored.)

### 12.7 The switch, and taking it out

* **`STUDIO_PREVIEW_OVERLAY=off`** in the website's `.env` (default **on**; `.env.example` and the settings table have it) serves the studio's own files again. It is read on every request, so saving `.env` is enough; a browser shows the other version on its next load (no stale copy: the validators differ). The start-up banner says which one is on. Use it to compare, or to roll back without deleting anything.
* **To remove it for good:** delete `site/overlays/studio/`. With no folder the middleware does nothing and the overlay tests skip themselves; the lines in `app.js` that mention the overlay (`grep -n -i overlay app.js`: the import, the two that make and mount it, the one in `app.locals`, the banner's), `server/middleware/studioOverlay.js`, `tools/studio-overlay-manifest.js`, the two `tests/js/studio-overlay*.test.js` and `docs/design-studio-checks/render-preview/` may then go too.
* **What this means for the standalone studio:** nothing in `swatchroom/` changed, so nothing there needs undoing. To get the same preview in your own project: `docs/design-studio-checks/instant-preview-quality.patch` (its header says how to apply it and which three of the studio's tests then need their numbers updated).

### 12.8 The website's preview is not the standalone studio's

Everything the studio's own documents (`swatchroom/ARCHITECTURE.md` and Appendix A here) say about the instant preview describes `swatchroom/`'s files. On the website, 9 of them are replaced as in 12.1 (8 until 2026-11-05). `tests/js/server-studio-parity.test.js` proves that the studio's **other** files and its API behave the same mounted as alone; its project folder has no overlay and it compares other files, so it will not notice that the preview differs. That is by design and has two safeguards: the overlay's own tests (12.3, 12.6), and this section.

### 12.9 Catalogue designs in the preview, and doors, furniture and other objects (added 2026-11-05)

*You reported that the newer items (the 63 catalogue designs) could not be drawn instantly with WebGL, and asked that every item support both the instant preview and the Gemini render. The full account (causes, what is built, what was tried and rejected, what cannot have a preview, what was and was not verified) is in `docs/CATALOGUE_STUDIO.md`, section "The instant preview (WebGL2 / WebGPU) of a design". The part that belongs to the overlay:*

* **A ninth file is served from the overlay:** `js/lib/fastrender/previewReason.js` (only the wording of "no-fit": the studio's reason codes are untouched, and the studio's own test of it asserts codes, not wording). The manifest (`node tools/studio-overlay-manifest.js`) now lists 9 overlay files; `tests/js/studio-overlay.test.js` pins 9.
* **geometry.js** gains `tileSizeOf` (a finish may state `previewTileWidthM` / `previewTileHeightM`, which only the preview reads: the studio quotes `tileWidthM` / `tileHeightM` to the render model as measured, `swatchroom/public/js/lib/prompts.js:61-71`), `textureCrop`, `isPhotographUrl` (a picture under `/media/`), `flattenTone` / `toneRadiusOf`, and `specularFor` now takes a finish's stated sheen first.
* **renderer.js** loads a design's photograph: refuses the website's "picture not available" SVG tile (HTTP 200 with `X-Terucon-Picture: unavailable`), crops to the tile's 10:7 instead of stretching, flattens the light drift of a photograph and then repairs the seam as before (the studio's own textures are not flattened), reads the tile size with `tileSizeOf`, and gives walls, floors and ceilings the GPU slots first (16 in all).
* **provisional.js / previewScene.js:** `ESTIMATED_KINDS` = wall, floor, ceiling, **door, furniture, other**. A door (level top edge), furniture and "other" get an upright plane standing on the floor at the object's foot (the same level-camera guess as a head-on wall); otherwise the four-corner estimate with an assumed height (door 2.1 m, furniture 0.9 m, other 1 m, wall 2.6 m as before). A window is not covered. `regionShading` reads each of these surfaces' light inside its own mask. The composer borrows the estimate for any covered kind the room's real fit does not know, which is every door, piece of furniture and "other" object, since the server's plane fit is wall, floor and ceiling only.
* **What the AI render receives is unchanged for the studio's own finishes.** For a catalogue design the guess of the tile size is not told to the model (a test runs the studio's real `prompts.js`).
* **Evidence:** 16 new overlay behaviour tests (60 in `studio-overlay-behaviour.test.js`, was 44; 3 of the studio's ported tests are marked CHANGED as before, and one of them, the provisional-scene test, changed again: a sofa is now covered, and the smoothness check is limited to the wall's own columns because the sofa is a surface of its own); the real-Chrome check `docs/design-studio-checks/render-preview/design-check.mjs` (8 designs x wall, door, cabinet front, sofa; WebGL2, and WebGPU on wall and door; the studio's own code gives no slot to the last three); `site-check.mjs` (the website serves the 9 overlay files, all checks passed). **The patch for your own Swatchroom project** (`docs/design-studio-checks/instant-preview-quality.patch`) was regenerated: it now changes 9 files and applies cleanly to the website's copy of the studio's files (`git apply --check` run on a throw-away copy; the result equals the overlay).
* **Not verified:** the full click path in the studio's real page with a real scan; a real phone; the other 55 designs; the loader against the real picture route; the new rule-13 sentence against live Gemini.

---

# Part B: the existing guides, copied

The six files below are copied from `swatchroom/` **unchanged**, except that heading levels are shifted down so they nest under these appendix titles. They were written between 2026-10-24 and 2026-10-26 by earlier sessions. Section 10 lists the statements in them that no longer hold.

---

## Appendix A: `swatchroom/ARCHITECTURE.md`

*Architecture (code-verified), written 2026-10-25 and updated 2026-10-26. Copied on 2026-11-03: 452 lines, 39667 bytes, sha256 starts `09be2fca949c1400`. Only the heading levels were changed (shifted down two). Read it together with section 10.*

### Swatchroom architecture (code-verified)

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

#### Direct answers: what is sent to Gemini (read from the code)

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

#### The short version

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

#### Part 1: Upload and scan (finds the surfaces you can click)

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

#### Part 2: "Understand this photo" pipeline (after the scan, once per photo version)

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

#### Part 3a: Instant preview (3D path, in the browser)

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

##### Why it never showed, and the fix (verified in the real studio)

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

#### Part 3b: AI render (2D path, Gemini)

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

#### Your two statements, checked

1. *"Upload, scan, lines appear, I click and select."* **Correct.** (Part 1.)
2. *"Only the cropped piece goes to Nano Banana, with depth/lighting from Marigold and MoGe-2."*
   **Partly wrong.**
   - What goes to Gemini is the photo or a generous context crop, plus mask, guide and text.
     It is not an isolated cut-out, and it is not always cropped (crop only when the surface is
     small: <= 22% of the frame). (Part 3b.)
   - MoGe-2 and Marigold output is **not** in that request. They feed the separate instant
     preview. (Parts 2 and 3a.)

#### Verification log (what I actually ran or read)

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

#### Verification log, 2026-10-26 (what was run; nothing touched live Modal, Google or Atlas)

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

#### Verification log, 2026-10-26 evening (after "nothing changed, the preview is still not visible")

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

#### Not verified

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

---

## Appendix B: `swatchroom/modal-latency-audit.md`

*Modal GPU latency audit, 2026-10-24 (the old three-pool deployment). Copied on 2026-11-03: 224 lines, 11904 bytes, sha256 starts `b65982b63dc81254`. Only the heading levels were changed (shifted down two). Read it together with section 10.*

### Modal GPU latency audit — SAM3 / MoGe-2 / Marigold-IID (2026-10-24)

Everything in this file is sourced from one of three places, each marked explicitly:
- **[LOG]** — `modal app logs ap-PZWqb6L53J9Y8Zq0mCjbXJ --since 12h`, the real, complete log
  history of the `vision-stack` app's entire deployed life (~10 hours at time of writing).
- **[BILLING]** — `modal billing rates` / `modal billing report --show-resources`, live account data.
- **[CODE]** — `/Users/mayank/XTRA/modalDeployment/vision_stack.py`, the actual deployed blueprint
  (the repo's own `modalBlueprint.py` is a 0-byte empty stub, not this).
- **[DOCS]** — Modal's current public documentation, checked live, with links.
- **[EST]** — an explicit estimate/inference, never presented as measured.

No number below is invented. Where a figure could not be verified, that is stated instead of
guessing.

---

#### 0. Known-bad data: don't trust `swatchflow.md` Part 6

`swatchflow.md`'s "Part 6 — Measured timings" section (an **uncommitted** diff, not in any
commit) claims real timed HTTP calls producing:
- MoGe-2 cold start: 219.4s
- Marigold-IID cold start: 266.7s
- A MoGe-2 request that hung 594.7s and failed with `HTTP 000`

None of this matches the real log history pulled directly from Modal **[LOG]**. No 594.7s hang,
no `HTTP 000` failure, and no 266.7s Marigold event exists anywhere in the actual 12-hour log.
The file also asserts Marigold was the slowest/worst model — the real logs show the opposite
(MoGe-2, not Marigold, produced the only catastrophic outliers, and for a different reason than
"cold start" — see §3). This section appears fabricated by a prior session and should be reverted
or replaced with the numbers in this file.

`modalBlueprint.py` in this repo is also empty (0 bytes) — the real blueprint lives at
`/Users/mayank/XTRA/modalDeployment/vision_stack.py`.

---

#### 1. Real deployed config **[CODE]**

| Setting | Value | Meaning |
|---|---|---|
| `SCALEDOWN_S` | **300s (5 min)** | idle time before a container is torn down |
| `MIN_CONTAINERS` | 0 | nothing kept warm by default |
| `BUFFER_CONTAINERS` | 0 | no idle burst-absorber container |
| `MAX_CONTAINERS` | 6 | per service |
| `STARTUP_TIMEOUT_S` | 900 | max time allowed to boot |
| `REQUEST_TIMEOUT_S` | 300 | max time allowed per request |
| `GPU_SNAPSHOT` | True | alpha feature; `enable_memory_snapshot` + `enable_gpu_snapshot` |
| GPUs | MoGe-2: **L4**, Marigold-IID: **L4**, SAM3: **L40S** | |

---

#### 2. Question: cold start if the user returns 6 hours after last use

Because `SCALEDOWN_S = 300`, the container is already dead **5 minutes** after the last call —
long before 6 hours. Arriving 6 hours later is operationally identical to arriving 6 minutes
later: both restore from the saved GPU snapshot. Modal does not document snapshot expiry tied to
idle duration — only redeploys invalidate a snapshot **[DOCS]**. There is no extra "long idle"
penalty beyond the normal cold-start-from-snapshot cost below.

---

#### 3. Measured cold-start latency **[LOG]**

##### 3a. First-ever boot (snapshot built from scratch — happens once per service per deploy)

| Model | GPU | Measured |
|---|---|---|
| SAM3 | L40S | 24.7s |
| MoGe-2 | L4 | 29.1s |
| Marigold-IID | L4 | 44.3s |

Matches the code's own comment in `server/routes/pipeline.js:70-72` ("10–45s") closely.

##### 3b. Normal cold start (restoring from an existing snapshot — the common case)

| Model | GPU | Measured range |
|---|---|---|
| SAM3 | L40S | 5.8s – 6.2s |
| MoGe-2 | L4 | 2.5s – 23.8s |
| Marigold-IID | L4 | 8.7s – 22.9s |

(Also seen via bare `/healthz` restores across all three services: 6.3s–49.8s.)

##### 3c. The real tail risk: L4 GPU capacity queueing, not cold start

Two MoGe-2 requests took **213.7s** and **1028.4s (17 min)** respectively — but their logged
`execution` time was under 2 seconds both times. The model loaded and ran fine; the delay was
Modal's fleet having no free L4 GPU at that moment, stated explicitly in the log:

```
Function 'MoGe2.*' is waiting to be scheduled on a GPU_L4 worker.
We are actively working on acquiring more capacity for your workload.
```

This message appeared **5 times** in 10 hours, always on an L4 function (MoGe-2 or
Marigold-IID), **never once** on SAM3's L40S. This is a capacity/scheduling issue specific to L4
in this account/region at that time — distinct from, and far larger than, snapshot-restore cold
start.

---

#### 4. Measured warm latency (container already running) **[LOG]**

| Model | Warm latency range | Notes |
|---|---|---|
| SAM3 | 0.28s – 1.4s | fast single forward pass |
| MoGe-2 | 0.48s – 4.5s | scales with image size |
| Marigold-IID | 1.75s – 6.3s | heaviest — real diffusion steps, not overhead |

---

#### 5. Cost **[BILLING]**

Rates: **L4 = $0.80/hr, L40S = $1.95/hr**.

Today's completed-hour cost breakdown (dashboard's $6.48 includes the current in-progress hour,
not yet in this report — explains the small gap vs. the $6.28 below):

| Resource | Cost today | Attribution |
|---|---|---|
| L40S | $2.81 | SAM3 only (27 calls) |
| L4 | $2.09 | MoGe-2 + Marigold-IID shared (52 calls combined) |
| CPU | $0.77 | shared across all 3 |
| Memory | $0.61 | shared across all 3 |
| **Total** | **$6.28** | |

**Cost per call:**
- SAM3 ≈ **$0.10–0.13/call** (L40S cost ÷ 27 calls, plus an **[EST]** proportional CPU/mem share
  — Modal's billing API does not break CPU/mem down per function, so this split is an estimate).
- MoGe-2 + Marigold-IID blended ≈ **$0.04/call average [EST]** — cannot be cleanly separated
  between the two models on shared L4 without per-function billing data.

**Key finding:** at listed GPU rates, actual inference compute for a warm call costs well under a
cent (e.g., Marigold's ~3s avg execution × $0.80/hr ≈ $0.0007). **Nearly all of the $6.28 is
idle/cold-start/snapshot-rebuild overhead, not inference** — that is where the optimization
leverage is.

---

#### 6. Recommendations

1. **Scheduled warm pools (highest leverage).** Modal supports `modal.Cron`-triggered
   `function.autoscaler.update(min_containers=N)` to keep 1 container warm during business hours
   and drop to 0 overnight **[DOCS: modal.com/docs/guide/scale.md]**. This removes cold starts
   entirely during active hours for a bounded, predictable idle cost. Caveat: a redeploy resets to
   the static decorator default, so this must be re-applied after every `modal deploy`.
2. **The L4 capacity-queueing tail (§3c) is the real threat, not snapshot restore.** Restores are
   already fine (6–32s, matching the code's own expectation). The 17-minute outlier is a
   shared-fleet capacity issue specific to L4. A scheduled warm pool (#1) makes this rare in
   practice. A fallback GPU list on the `Function`/`gpu=` parameter may also be possible — not
   independently confirmed in this pass, verify against Modal's `Function` reference before
   relying on it.
3. **6 "Creating GPU memory snapshot" (full rebuild) events occurred in 10 hours**, against an
   expected baseline of 3 (one per service). Rebuilds are slower (25–44s) than restores (6–32s)
   and happen on every redeploy. Worth confirming these 3 extra rebuilds came from code
   redeploys during testing and not something recurring in production.
4. `SCALEDOWN_S = 300` is reasonable as-is. Since overhead dominates cost far more than compute
   does, stretching it to 600–900s is cheap insurance against repeat cold starts within one
   session (extra 5–10 idle minutes costs ~$0.13–0.33 on L4, ~$0.33–0.49 on L40S).
5. `GPU_SNAPSHOT` (still **alpha**, not GA, per Modal's docs) is already doing its job — restores
   land within the code's own expected 10–45s window. No change needed here.

---

#### 7. Hiding cold start from the user

**What already exists** (verified by reading the actual code, not assumed):
- `/pipeline/warmup` fires silently on studio open (`public/js/swatchroom-app.js`),
  fire-and-forget, 90s timeout. Explicitly designed to be invisible — the code comment says
  "Settings > Check already shows real connectivity status."
- `ensureFusion()` in `public/js/views/studio.js` does track real status
  (`checking` → `running` → `ready`) but it's surfaced only in **Settings > Render**, a panel a
  designer may never open — not as a visible banner on the main canvas.
- The aggregate `/check` endpoint (`server/routes/session.js`, `pipelineModelCheck()`) gives a
  worded, non-alarming timeout message ("cold GPU container can take a while to start; try again
  shortly") but only on a manual Settings check (45s timeout per model).

**Recommendations:**
- Pair the scheduled warm pool (§6.1) with firing `warmupPipeline()` even earlier (e.g. on the
  room-list screen, not just on studio open) to buy more lead time against the rare true-cold
  case.
- Surface `ui.fusion.status === "running"` as a visible banner on the main studio canvas
  ("Preparing 3D geometry — first use can take up to a minute"), not just in Settings — this is
  the gap between "we silently warm it" and "the user sees a stall with no explanation."

---

#### 8. What was not verified / explicit gaps

- No official Modal documentation gives L4-vs-L40S-specific capacity benchmark numbers; the L4
  queueing issue in §3c is this account's real observed behavior, not a documented general rule.
- Whether billing accrues during the "waiting to be scheduled" queue time (§3c) itself, versus
  only once a container actually starts running, was not confirmed against Modal's billing docs.
- Fallback GPU lists (e.g. `gpu=["L4","A10G"]`) were not independently confirmed against Modal's
  current `Function` reference — flagged in §6.2, verify before relying on it.
- The per-call cost split between MoGe-2 and Marigold-IID (§5) is an estimate, not an exact
  figure — Modal's billing report does not break cost down below "resource type" (GPU/CPU/Memory)
  within an app.

---

#### 9. Update 2026-10-25: fallback GPUs and cold-start visibility

- **Fallback GPU lists are confirmed and implemented** (this closes the open point in §6.2 and
  §8). Modal's docs: "Modal respects the ordering of this list and will try to allocate the most
  preferred GPU type before falling back to less preferred ones" (`gpu=["H100", "A100-40GB:2"]`
  is their example); the installed client (1.6.2) accepts `gpu: str | list[str]` on `App.cls`
  and `run_function`. `modalBlueprint.py` now lists MoGe-2/Marigold `L4, A10, L40S, A100-40GB`
  and SAM 3 `L40S, A100-40GB, A10, L4`. Not documented by Modal and therefore not claimed: how
  long it waits for the first choice before falling back. The valid name for the 24 GB Ampere card
  is `A10` (not `A10G`) in Modal's current GPU list.
- GPU snapshots are per GPU type ("GPU Functions need 2-3 snapshots per GPU type"), the
  client's container runtime exits with a sentinel code that makes Modal retry a failed GPU
  snapshot restore without a snapshot, and (client source, `_functions.py`) every GPU's copy of
  the class carries `checkpointing_enabled` and the `enable_gpu_snapshot` option, with only
  `resources` overridden per GPU. So a fallback type should cost one slower first boot, not
  errors. Modal's docs say nothing about snapshots together with a GPU list, and none of this has
  run on a real deploy yet: watch `modal app logs` after the first one.
- The container now reports `x-gpu`, `x-gpu-rank`, `x-container-requests`, `x-container-age`
  (and `/healthz` the same); `server/lib/coldStart.js` turns that plus `Server-Timing` into
  cold start vs processing, shown to the owner only (see swatchflow.md).
- Still open: `MIN_CONTAINERS` / a scheduled warm pool (§6.1) costs an idle GPU and is left at 0;
  `VISION_MIN_CONTAINERS=1 modal deploy modalBlueprint.py` turns it on for a deploy without
  editing the file (`VISION_SCALEDOWN_S` likewise).

---

## Appendix C: `swatchroom/swatchflow.md`

*Swatchflow: how Swatchroom works (scan, render, timings). Copied on 2026-11-03: 469 lines, 29709 bytes, sha256 starts `ae8b3d8b19194741`. Only the heading levels were changed (shifted down two). Read it together with section 10.*

### Swatchflow — how Swatchroom actually works

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

#### High-level map

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

#### Part 1 — Segmentation ("Scan"): turning a photo into surfaces

Triggered by `Studio.runScan()` (`public/js/views/studio.js:850`). There are **two
engines**, chosen in Settings (`segmentationEngine`), each producing the same shape of
result — a `scan`: `{ width, height, labelMap (one region-index per pixel), regions[] }`
(`public/js/lib/regions.js:1-14`).

##### 1a. `scene` (the default/recommended engine)

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

##### 1b. `gemini` (Gemini does the segmentation itself, no local model at all)

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

#### Part 2 — From pixels to a product on a surface

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

#### Part 3 — Rendering: what exactly Gemini sees

This is the core of `prepareRender()` / `renderOption()` in `public/js/lib/render.js`,
with cropping/alignment math in `public/js/lib/framing.js`. Walking it step by step for
one render:

##### Step 1 — Pick a working resolution
The current photo **version** (could already be a previous render) is loaded and
downscaled to at most 2048px on the long side, or 4096px if the designer asked for a
4K output (`render.js:44-46`).

##### Step 2 — Decide: crop, or send the whole photo?
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

##### Step 3 — Build the three images that get sent
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

##### Step 4 — The text brief
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

##### Step 5 — The system prompt
`RENDER_SYSTEM_PROMPT` (`public/js/lib/prompts.js:3-24`) is sent once as
`systemInstruction`, not per-call text. It fixes the model's role ("architectural
visualisation retoucher") and ten numbered rules: edit only the masked area; respect
room geometry/perspective; match existing light and shadow; respect occlusion
(furniture in front stays in front); use realistic material scale; never draw the mask
or outline itself into the output; return the same framing/aspect ratio as Image 1;
use real-world scale cues (door ≈2.1m etc.); cover the target fully with crisp edges;
apply one consistent design across multi-part targets.

##### Step 6 — The actual network call
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

##### Step 7 — Turning Gemini's answer back into a photo
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

##### Step 8 — Two outputs are kept, not one
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

#### Part 4 — Measurement / take-off (a third, smaller Gemini call)

After a render, if `estimateQuantities` is on, `measureSurface()`
(`public/js/lib/measure.js`) sends **two images** — the *rendered* photo and the
surface's mask (no magenta guide this time) — plus a prompt asking for a JSON
take-off: area in m², visible area, width/height/depth, a confidence level, the scale
cue used, and a short description of the applied product
(`public/js/lib/prompts.js:136-173`). This is a `task: "json"` call constrained by
`MEASURE_SCHEMA`, same `/api/ai/generate` endpoint, same server-side model-fallback and
request-simplification machinery as everything else that talks to Gemini.

---

#### Part 5 — Why the server shapes requests the way it does (`server/google/vertex.js`)

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

#### Part 6 — Measured timings (updated 2026-10-24)

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

##### Modal: SAM 3 / MoGe-2 / Marigold-IID (verified against real Modal logs + billing)

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

##### GPU fallbacks and the owner's dot (added 2026-10-25)

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

##### Local: SegFormer-B4 (this machine, via MPS) + Gemini outline call (`gemini-3.8-flash`) — UNVERIFIED, see note above

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

##### Put together: room-open to ready-to-render

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

#### File reference

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

---

## Appendix D: `swatchroom/DEPLOY.md`

*Deploying Swatchroom on Render, and the Modal notes. Copied on 2026-11-03: 209 lines, 14550 bytes, sha256 starts `abd6715ce9664320`. Only the heading levels were changed (shifted down two). Read it together with section 10.*

### Deploying Swatchroom on Render

`render.yaml` at the repo root defines two services. Render reads it automatically when you
create a Blueprint.

| Service | What it is | Plan | Why |
| --- | --- | --- | --- |
| `swatchroom` | The Node/Express app: studio, API, admin dashboard | Starter ($7/mo, 512MB) | Needs very little RAM |
| `swatchroom-models` | The Python model service (SegFormer + SlimSAM) | Standard ($25/mo, 2GB) | CPU-only on Render, needs ~2GB RAM for torch + the models |

So this blueprint costs **~$32/mo** minimum, on top of your MongoDB and Google Cloud usage.
The models service is optional - see "Skipping the model service" below if you want to cut the
$25/mo and just run on Starter.

MongoDB is **not** created by the blueprint - Render has no managed MongoDB. Use a MongoDB Atlas
connection string (or your own), set as `MONGODB_URI`.

#### What you need before you start

- This repo pushed to GitHub or GitLab.
- A MongoDB Atlas cluster (the free M0 tier works) and its connection string. **Atlas blocks all
  connections by default** - under Network Access, add `0.0.0.0/0`, or get `swatchroom`'s actual
  outbound IP ranges from its service page's **Connect > Outbound** tab in Render and allow only
  those.
- A Google Cloud service-account key with Vertex AI access, as a JSON file (see the README's
  "Google Cloud key" section for how to create one).

#### 1. Create the Blueprint

1. On [dashboard.render.com](https://dashboard.render.com): **New > Blueprint**, pick the repo.
   Render reads `render.yaml` and shows both services.
2. Render asks you to fill in every variable marked `sync: false` **right here, before you
   create anything** - `MONGODB_URI`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `STUDIO_PASSCODE`,
   `ADMIN_EMAIL`/`ADMIN_PASSWORD`, `POSTHOG_KEY`, and the pipeline's `SAM3_URL`/`KEY` etc. if you
   have them. Paste what you have now:
   - `MONGODB_URI`: your Atlas connection string.
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: the whole key file's contents, pasted as **one line**.
   - `STUDIO_PASSCODE`: a long passcode - without this, anyone with the URL can use (and spend)
     your Google project.
   - Everything else can be left blank and set later from each service's Environment page -
     Render only prompts for these values at Blueprint creation, not on later updates.
3. Review the proposed changes and click **Deploy Blueprint**. Render creates and deploys both
   services.

`SESSION_SECRET`, `MODEL_SERVICE_URL`, `MODEL_SERVICE_KEY`, `SECURE_COOKIES`, `TRUST_PROXY`,
`VERTEX_LOCATION` and `POSTHOG_HOST` are already wired up by the blueprint - nothing to do there.
`MODEL_SERVICE_URL`/`KEY` point at the `swatchroom-models` service automatically via Render's
`fromService`.

#### 2. If you skipped anything in step 1

Open the **swatchroom** service > **Environment**, fill in what's missing, and save with
**Save and deploy** (not **Save only**, which saves the values but doesn't use them until the
next deploy).

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | Your MongoDB Atlas connection string |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The whole service-account JSON key, pasted as one line |
| `STUDIO_PASSCODE` | A long passcode |

**Easier alternative for the Google key:** instead of pasting JSON into an env var, open
**Environment > Secret Files**, add a file (e.g. `gcp-key.json`) with the key's contents, and set
`GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/gcp-key.json`. **Also delete/clear
`GOOGLE_SERVICE_ACCOUNT_JSON`** if you set one - the server checks it first and ignores
`GOOGLE_APPLICATION_CREDENTIALS` while it's set (`server/config.js`).

Optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@terucon.in` / `admin@123` | Admin dashboard sign-in (`/admin`) - **change the password here before sharing the URL** |
| `POSTHOG_KEY` | unset (disabled) | PostHog analytics - paste your project API key to enable |
| `ONEFORMER_URL`/`KEY`, `ANALYZE_URL`/`KEY` | unset | The combined Modal pool (see "Modal GPUs" below): OneFormer for the scan, and the whole room analysis in one request |
| `SAM3_URL`/`KEY`, `MOGE2_URL`/`KEY`, `MARIGOLD_URL`/`KEY` | unset (mocked) | The room pipeline's three separate Modal-hosted models (used when `ANALYZE_URL` is not set) |
| `GOOGLE_CLOUD_PROJECT` | from the key's own `project_id` | Only set this if you want a different project than the key belongs to |

#### 3. Build & start commands (already in `render.yaml`, for reference)

**swatchroom** (Node)
- Build: `npm install`
- Start: `npm start`
- Health check: `/api/session`

**swatchroom-models** (Python, root dir `python/`)
- Build: `pip install --upgrade pip && pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu && pip install -r requirements.txt`
- Start: `uvicorn app:app --host 0.0.0.0 --port $PORT`
- Health check: `/health`

#### 4. Verify it actually works

`/api/session` passes Render's health check the moment the Node process is up, **even if MongoDB
or Google aren't configured** - the server intentionally starts and keeps serving either way (it
retries MongoDB in the background, and Gemini calls just fail until a key is set). A green
status on Render does not mean the studio actually works. So after deploying, check for real:

1. Open `https://<swatchroom-service>.onrender.com/studio`, go to **Settings > Check**, and
   confirm Google sign-in, the model service, and MongoDB all report ok. (If you deliberately
   skipped the model service - see below - its row is expected to show an error.)
2. Open `https://<swatchroom-service>.onrender.com/admin` (sign in with `ADMIN_EMAIL`/
   `ADMIN_PASSWORD`, defaults `admin@terucon.in` / `admin@123`) and check its "Model & service
   status" panel too.
3. `https://<swatchroom-service>.onrender.com/` is the Terucon page with the studio embedded.

#### Troubleshooting

- **The service logs say `MongoDB is not reachable at ... Retrying in 15 seconds`, and rooms
  don't save**: almost always the Atlas IP allowlist - add `0.0.0.0/0` under Network Access, or
  the specific ranges from the "what you need" section above.
- **Settings > Check fails on "Google sign-in"**: the key usually isn't valid JSON, or got
  mangled when pasted as a single line (stray newlines, smart quotes from a text editor). Use
  the Secret File approach above instead - it avoids this entirely (and remember to clear
  `GOOGLE_SERVICE_ACCOUNT_JSON` when you switch to it).
- **`swatchroom-models` deploy fails or crashes with an out-of-memory error**: Standard's 2GB is
  the minimum that reliably fits torch + SegFormer + SlimSAM; don't drop it to Starter.
- **Scans are slow (~6s on CPU per the README)**: Render has no GPU plans. Either accept it, or
  point `MODEL_SERVICE_URL` at your own GPU box instead - the studio falls back to Gemini
  outlines automatically if the model service is ever unreachable, so it's safe to leave unset
  too.

#### Skipping the model service

The scene scan engine falls back to Gemini automatically if the model service is unreachable
(`fallbackToGemini` defaults to on in Settings) - but the **Pick tool has no fallback**; it
always needs SlimSAM via the model service and simply won't work without it.

If that trade-off is fine, drop to Starter's $7/mo alone:
1. In `render.yaml`, delete the `swatchroom-models` service block and the
   `MODEL_SERVICE_URL`/`MODEL_SERVICE_KEY` `fromService` entries under `swatchroom`, then push.
2. In the Render Dashboard, manually delete the now-unmanaged `swatchroom-models` service too -
   removing it from `render.yaml` does **not** delete it or stop billing for it; Render only
   stops managing it and will recreate it on the next sync if you don't delete it yourself.

#### Modal GPUs: one pool, cold starts and the owner's dot

`modalBlueprint.py` runs MoGe-2, Marigold-IID, SAM 3 and OneFormer on Modal. Changes to that file reach
Modal only when you deploy it, and **nothing in this repo deploys or runs anything on Modal for you**:

```sh
modal deploy modalBlueprint.py        # app "vision-stack": prints the URLs, incl. https://<ws>--vision-all.modal.run
modal run modalBlueprint.py           # optional, bills a few GPU-minutes: self-test of every model on real GPUs
python modalBlueprint.py prime        # optional, right after a deploy: create the GPU snapshots now, not on a user's photo
```

(`/Users/mayank/XTRA/modalDeployment/vision_stack.py` is the copy you deploy from; keep it equal to `modalBlueprint.py`.)

**What costs money, and what this stack does about it.** A Modal pool bills from the moment its container boots until
`SCALEDOWN_S` (300 s) after its last request, so what costs is the number of *pools woken* and how often, not the
number of requests.
- **One pool instead of four.** `VISION_LAYOUT=both` (default) deploys `VisionAll` (all four models in one container, label
  `vision-all`, one snapshot, one idle tail) next to the four dedicated pools, so your current URLs keep working. Point
  `ONEFORMER_URL` and `ANALYZE_URL` at it (see `.env.example`) and a photo costs one cold start and one idle tail: the
  scan's OneFormer request boots it, and the room analysis (`/v1/analyze`: MoGe-2 + Marigold lighting + SAM 3 with ten
  prompts, one request) finds it warm. Once you have switched, `VISION_LAYOUT=combined modal deploy` removes the four old
  pools (their URLs stop working); `VISION_LAYOUT=split` is the layout before this change.
- **Nothing wakes a GPU because a page opened.** The start-up gate asks `GET /api/vision/warmup`, which the server answers
  from its own record of its last Modal call (`server/lib/warmth.js`): no Modal request. `POST /api/pipeline/warmup` only
  does anything when a photo is being scanned, and only for pools that are cold and not already starting. The admin
  dashboard's model panel used to call every pool's `/healthz` every 30 s (keeping all GPUs up for as long as the tab was
  open); it now shows the same passive state, and only its **Probe Modal now** button really calls them.
- **No second call for the same photo.** SAM 3's masks are stored with the depth and shading (`fusion/<version>/sam`), so
  tap-to-calibrate, rug / furniture carve-outs, plane splits and re-fits after an edit all read them instead of calling
  Modal again. The scan's HD swap and the plane re-fit are local maths.
- **Knobs.** `VISION_SCALEDOWN_S` (idle seconds, default 300; lower = cheaper but a visitor's second photo a few minutes
  later cold-starts again), `VISION_MIN_CONTAINERS`, `VISION_GPU_TIER=economy` (L4-first), `VISION_ACTIVE_WARMUP=on` (the
  literal "ping Modal when the page opens", which boots a GPU for every visitor who lands cold; off by default).

- **Fallback GPUs.** Every service has an ordered GPU list (`SERVICES` at the top of the file).
  Modal takes the first type it can get and falls back down the list, instead of leaving a request
  queued behind a sold-out pool. The first entry is what each service ran on before, so nothing
  changes while it is available. The first containers that land on a *fallback* type build their own
  GPU snapshot (a slower boot, about as long as the first boot after a deploy), then restore fast.
- **Cold start vs processing.** A container that has scaled to zero takes seconds to tens of seconds
  to come back; that wait is not processing. The dot below tells the two apart.
- **Keeping one warm.** `VISION_MIN_CONTAINERS=1 modal deploy modalBlueprint.py` keeps one container
  per service running (no cold start, one idle GPU per service billed all day);
  `VISION_SCALEDOWN_S=600` stretches the idle time before a container stops (default 300).
- **The owner's dot.** A 7-pixel dot in the top-right corner of the studio, shown only in a browser
  that is signed in at `/admin` (it is drawn from `GET /api/session` saying `owner: true`, and its
  numbers come from the admin-only `GET /api/admin/coldstart`, so nobody else can see or fetch them).
  On your phone: open `/admin` once, sign in (the sign-in lasts 7 days), then open the studio.
  Grey = nothing seen / idle, green = warm, amber = a cold start in the last two minutes, pulsing amber
  = a container is waking up right now, red = a call failed. Tap it for the details: cold start vs
  processing time per model, which GPU answered (and "fallback" when it was not the first choice), and
  where the last scan's time went.
- **Python scene service (Render).** It starts loading SegFormer-B5 in the background as soon as it
  boots (`SCENE_PRELOAD=b5-quant` by default, `off` disables it), so the first photo after a deploy does not
  wait for the model; `/scene/segment` reports `loadMs` (that wait) separately from `inferMs`, and `precision`
  (`int8` / `fp16` / `fp32`) for what actually ran. `b5-quant` uses dynamic INT8 weights only where a timed pass at
  load shows INT8 is faster (x86 CPUs); on ARM, including Apple Silicon, torch's INT8 kernels measured *slower* than
  fp32 here, so it stays fp32. The first load downloads about 340 MB. Memory: B4 in fp32 peaked at 1.6 GB resident when measured here (torch and
  transformers are ~350 MB of that); B5 is larger (on Apple Silicon MPS it answers a 1920 px photo in 2.9 s; its memory on a Linux CPU is not measured), so the service
  only loads B5 when its memory limit is at least `SCENE_B5_MIN_GB` (3 by default) and otherwise answers with B4 and says
  so (`fellBackFrom` in the response). The same fallback covers a B5 download or load that fails. On Render's 2 GB
  Standard plan that means B4; choose a 4 GB plan for B5, and leave the other models to load on first use.

#### Notes

- **Sleeping**: only Render's *Free* plan spins services down on inactivity. Starter and
  Standard (what this blueprint uses) never sleep - `swatchroom-models`'s first *model* use
  after a fresh deploy still has to load SegFormer/SlimSAM into memory (a few seconds);
  the studio loads the scan model in the background shortly after it opens (`POST /api/vision/warmup`,
  the local service only, never Modal).
- **Admin dashboard data**: generation/scan/pick/pipeline logs are kept for 30 days
  (`server/models/EventLog.js`'s TTL index); "live now" means active in the last ~90 seconds
  (`server/models/LiveVisitor.js`). Both live in the same MongoDB as rooms, no extra setup.
- **Changing the admin password later**: it's read from `ADMIN_EMAIL`/`ADMIN_PASSWORD` at
  start-up (`server/config.js`), defaulting to `admin@terucon.in` / `admin@123` when unset - no
  code change needed, just set the env vars on Render with **Save and deploy**.

---

## Appendix E: `swatchroom/UPGRADE_SUMMARY.md`

*The 2026-10-26 upgrade summary. Copied on 2026-11-03: 128 lines, 13312 bytes, sha256 starts `8d345032aa9085f5`. Only the heading levels were changed (shifted down two). Read it together with section 10.*

### Swatchroom upgrade: what was done, what is running, what you still have to do

Written 2026-10-26. Nothing described here is committed or deployed: it is all in your working tree
(82 changed or new paths). No `modal deploy` / `modal run` was ever executed, no live Modal endpoint was called, and the
repo's `.env` (live Atlas / Modal / Vertex) was never used to start anything for testing.

Longer, file-by-file detail is in `ARCHITECTURE.md`; deployment detail is in `DEPLOY.md`.

---

#### 1. Your three observations, answered

| You saw | Why | What changed / what you must do |
| --- | --- | --- |
| **SegFormer-B4 is still used locally** | The code now asks the Python service for `b5-quant`, but the service must be **started from this checkout**. When I looked, **no Python service was running at all** (nothing on `127.0.0.1:8001`), so I cannot tell which of three things you saw: (a) an **old service process** (the old code silently treated the unknown name `b5-quant` as B4; fixed in `python/scene.py`), (b) the **first-run B5 download** (the cache shows a B5 download running 12:47-12:54 today, probably the new service preloading; until it finishes the first scan waits or is answered by B4), or (c) the **new fallback**: if B5 cannot be downloaded or loaded the service answers with B4 and prints why in the Python terminal. Look at that terminal and at the owner dot's "Last scan" line (it says "B5 could not load" in case (c)). With the repo's own `python/.venv` (Python 3.9, torch 2.8) the new service answers `b5-quant` with **real SegFormer-B5, fp32 on Apple's MPS, 2.9 s for a 1920 px photo** (measured). B5's weights (339 MB) are now in your local Hugging Face cache. | **Restart the service from this checkout:** `cd python && .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8001` (the repo's own venv; `npm run models` uses whichever uvicorn is first on your PATH), wait until `http://127.0.0.1:8001/health` lists `...segformer-b5...` under `sceneLoaded` (about 45 s), then reload the studio tab (hard refresh). New: the server now **prints at start** whether the service is reachable, whether it is an old build, and which model it will use; the owner dot's "Last scan" line names the model that actually answered ("SegFormer-B5 (fp32, mps)"), and says "B5 could not load" if it fell back to B4. |
| **OneFormer is never called** | Two things have to be true and neither is: (1) **`ONEFORMER_URL` (and `ANALYZE_URL`) are not in your `.env`** (only the three old `SAM3_URL` / `MOGE2_URL` / `MARIGOLD_URL` are), so the browser never starts the OneFormer side of the race; (2) **OneFormer does not exist on Modal yet**: your deployed `/Users/mayank/XTRA/modalDeployment/vision_stack.py` is still the old three-model file. I did not deploy, because a deploy builds images on Modal and changes what you pay for. | Deploy the new blueprint, then put the two URLs in `.env` (steps in section 4). I can run the deploy for you if you say so. New: the server start-up message says "ONEFORMER_URL is not set ... OneFormer is never called", and the owner dot lists **OneFormer** and **Room analysis** as "not set up: add ONEFORMER_URL to .env". |
| **The WebGL preview is not visible** | I could not reproduce "never visible": in a real-GPU browser (Apple M5, Metal) the preview is visible on the page, desktop and phone, WebGPU and WebGL2, for landscape, portrait, 12 MP and EXIF-rotated photos. But testing with **real MoGe-2 depth and real Marigold shading** (generated locally for the test photo) found a real bug: after the room analysis arrives, a surface whose fitted plane scored below 0.45 got **no preview at all, silently**. The biggest wall (a wall with a TV niche) scored **0.425**; furniture, curtains and windows have no fitted plane. Only the floor, ceiling and some walls previewed. | **Fixed:** walls, floors and ceilings with a weak fit now fall back to the outline-based estimate (shown, approximate) instead of nothing; the threshold default is 0.3 (was 0.45) and your saved settings are migrated. Re-checked with the real data: every wall, the floor and the ceiling now preview. **Still by design:** furniture, curtains and windows are not planes, so picking a finish for them shows no instant preview; the "Render" button (Gemini) does those. |

If after restarting the service and hard-refreshing you still do not see it, look at the browser console and the
owner dot (open `/admin` once, sign in, open the studio) and tell me what the card says; I could not see your browser.

---

#### 2. What was built (the six workstreams)

1. **OneFormer on Modal + local B5.** `modalBlueprint.py`: `/v1/parse` with `/v1/oneformer` alias and `/healthz`;
   `server/lib/remoteModels/oneformer.js`; `server/lib/ade20k.js` translates the ten class names where OneFormer and
   SegFormer disagree ("tv" vs "television receiver"...). Local: `python/scene.py` serves SegFormer-B5 (`?model=b5-quant`,
   default), INT8 only where a timed pass shows it is faster (x86; Apple Silicon stays fp32 because torch's ARM INT8
   measured 30-40x slower), fp16 on CUDA. New: if B5 cannot load, B4 answers and says so (`fellBackFrom`); B5 is only
   loaded where the memory limit is at least `SCENE_B5_MIN_GB` (3), because B4 alone peaked at 1.6 GB.
2. **Splash + 10 s gate + race.** "Powered by Terucon India" splash, strict 10 s gate that records `modalIsWarm`;
   `segmentRace.js` runs local B5 and OneFormer together when Modal is cold, remote first when warm; the late HD scan is
   offered as "HD Surface Scan Ready (Higher Accuracy) - Tap to Apply" (auto-applied when nothing was edited yet).
3. **Instant preview (WebGPU / WebGL2).** Canvas follows the screen (DPR, at most 2048 px); every surface is a homography
   from its fitted plane, or from its outline before the room is analysed; 5-tap joint-bilateral edges; shading divided by the
   surface median (clamped 0.35-1.65); specular from Marigold's residual; mip-mapped textures; LRU texture cache with
   prefetch so a pick draws on the next frame; never starts a Gemini render. A real decoding bug was fixed on the way
   (Marigold's PNGs are max-normalised gamma 2.2; the old code read them as linear).
4. **SAM 3 / SlimSAM.** SAM masks are stored per photo version and reused for tap-to-calibrate, rug / furniture /
   picture carve-outs, wall-plane splits (OneFormer's panoptic output cannot separate wall planes) and refits; calibrated masks
   grow 0.2% for the Gemini mask.
5. **Geometry into the AI render.** Surface size in metres, normal, distance and field of view go into the Gemini brief;
   the live preview is blended at 35% into the guide image.
6. **Mobile.** iOS canvas cap 2560 px (3072 on other phones) with canvases released after use; touch magnifier
   (2.5x, 70 px above the finger, hold 220 ms or drag; a longer 650 ms press adds a surface to the selection).

#### 3. Modal cost design (your hard rule: wake Modal as little as possible)

- `VisionAll`: MoGe-2, Marigold (lighting only), SAM 3 and OneFormer in **one** container behind one URL
  (`/v1/analyze` returns one zip). One photo = one cold start and one idle tail, instead of up to four pools.
  `VISION_LAYOUT=both|combined|split`; default `both` keeps your old URLs working (five classes deployed,
  `min_containers` 0 everywhere).
- "Is Modal warm?" is answered from the server's own record of its last Modal call; `/api/vision/warmup` never calls Modal.
  Nothing wakes on page load; only a scan asks for a wake-up. The admin dashboard no longer pings every pool every 30 s
  (it has an explicit Probe button).
- Measured in the isolated browser harness: a whole session = one cold start, one `/v1/oneformer`, one `/v1/analyze`,
  zero `/healthz`, also after the HD swap, plane splits, refits, taps and calibrations.
- The new server also works against the OLD Modal deployment (tested): separate pools, at most 8 SAM prompts, no OneFormer.
  So the server can be deployed before Modal is redeployed.

#### 4. What you have to do

```bash
# 1. restart the local scan service from this checkout, wait for B5 to appear in /health
cd python && .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8001      # the repo's own venv; `npm run models` uses whatever uvicorn is first on PATH
curl -s http://127.0.0.1:8001/health        # sceneLoaded must list segformer-b5..., defaultModel must be b5-quant

# 2. restart the Node server (it prints what it will do at start: look for the [models] lines)
npm start                                    # then hard-refresh the studio tab (settings migrate automatically)

# 3. OneFormer + single-call analysis: deploy the new Modal file (costs money to build; I did NOT run this)
cd /Users/mayank/XTRA/modalDeployment
cp vision_stack.py vision_stack.py.bak
cp /Users/mayank/XTRA/terucon_swatchroom_demo/swarchroom-v5/swatchroom/modalBlueprint.py vision_stack.py
modal deploy vision_stack.py
# 4. put the two URLs printed by the deploy (the vision-all app) into .env, restart npm start:
#    ONEFORMER_URL=<.../v1/oneformer>   ANALYZE_URL=<.../v1/analyze>   (keys: see .env.example)
```

If `ANALYZE_URL` stays unset, every scanned photo still wakes the three separate pools. On Render's 2 GB plan the service
answers with B4 (memory guard); choose a 4 GB plan for B5.

#### 5. Verification (what was actually run)

| What | Result |
| --- | --- |
| `npm test` | 12 Node suites and the 2 Python suites pass (Python suites need a venv with torch/transformers/fastapi/modal/httpx, otherwise they SKIP; run with `PYTHON=<venv python> npm test`) |
| Isolated browser harness (in-memory MongoDB, fake Modal, real server, Chrome on a real Apple GPU, phone and desktop) | scenarios A-F pass: cold Modal with OneFormer first; local first then HD banner/auto-swap; provisional -> fused preview with zero blank frames; the 10 s gate; warm + slow OneFormer; the new server against the old Modal deployment |
| Real data end to end (real B5 scan, real MoGe-2 depth, real Marigold shading, test photo, run on this Mac) | found and fixed the weak-fit bug above; all walls/floor/ceiling preview afterwards |
| Real B5 through your venv's service | 2.9 s per 1920 px photo on MPS; answers `b5-quant` with B5 |
| Finish swap latency (texture in memory) | renderer work about 0.1-0.2 ms (command submission); pointer-down to first changed frame 31-49 ms (the studio batches the pick into the next animation frame). "Under 16 ms" holds for the renderer, not for tap-to-pixels |

The harness lives in the Claude session scratchpad
(`/private/tmp/claude-501/-Users-mayank-XTRA-terucon-swatchroom-demo-swarchroom-v5-swatchroom/aa53a449-04a1-466f-94b7-1333568e7026/scratchpad/harness`),
not in the repo, so it will disappear with the temp directory.

#### 6. Not verified (honest limits)

- No real Modal deploy or GPU run; real **SAM 3** output (gated weights) was never seen, only MoGe-2 and Marigold were run for real.
  OneFormer's real output has never been seen.
- B5 on a Linux CPU / Render (speed, memory); INT8 on x86; the 3 GB memory threshold is a cautious guess.
- A real iPhone / iOS Safari; any browser other than Chrome.
- Gemini render quality with the new brief and guide image (no Gemini call was made).
- Your actual browser session: I could not see it. If something still looks wrong, send the owner-dot card text and the console.

#### 7. Where I departed from your spec

- The Modal route is `/v1/parse`, with `/v1/oneformer` as an alias.
- The landing-page "ping" is replaced by a passive check (an active probe exists behind `VISION_ACTIVE_WARMUP=on`).
- OneFormer's panoptic output cannot split wall planes, so wall splits come from SAM 3 + depth.
- Long-press multi-select moved from 480 to 650 ms (the magnifier starts at 220 ms).
- INT8 is skipped on ARM.
- Instant preview for furniture / curtains / windows is not provided (not planes); those go through the AI render.

#### 8. Changed and new files (all uncommitted)

New: `ARCHITECTURE.md`, `UPGRADE_SUMMARY.md`; client `public/js/lib/{geometryFacts,hdSwap,morph,occlusion,planeSplit,platform,previewScene,samCalibrate,samLayer,segmentRace,startupGate}.js`,
`public/js/lib/fastrender/{geometry,lru,provisional,sizing,textureStore}.js`, `public/js/views/splash.js`; server
`server/lib/{ade20k,bootReport,planeSplit,samLayer,sceneNormalize,wake,warmth}.js`, `server/lib/remoteModels/{analyze,oneformer}.js`;
tests `tests/{fastrender,render_bridge,sam,startup_race}.test.js`, `tests/{modal_blueprint,scene_service}.test.py`, `tests/fixtures/`,
`server/lib/{planeSplit,vision}.test.js`, `scripts/run-python-tests.js`.
Changed: `modalBlueprint.py`, `python/{app,scene,pick}.py`, `server/{config,index}.js`, `server/lib/{coldStart,fusion.worker,healthChecks,pack,pipelineRunner}.js`,
`server/lib/remoteModels/{marigold,sam3}.js`, `server/routes/{admin,pipeline,session,vision}.js`, the studio client (`swatchroom-app.js`, `views/{stage,studio,dialogs}.js`,
`lib/{detect,vision,render,prompts,framing,images,settings,ownerSummary}.js`, `views/ownerDot.js`, fast-render renderer and shaders, `workers/scene.worker.js`, `core/api.js`, CSS),
`.env.example`, `render.yaml`, `DEPLOY.md`, `README.md`, `package.json`.

Stray files you may want to delete: `/Users/mayank/XTRA/modalDeployment/0` and `/Users/mayank/XTRA/modalDeployment/3+,` (empty, created Oct 25; I did not touch them).

---

## Appendix F: `swatchroom/README.md`

*The studio's own README. Copied on 2026-11-03: 242 lines, 12713 bytes, sha256 starts `a77baa6eb5cb8b32`. Only the heading levels were changed (shifted down two). Read it together with section 10.*

### Swatchroom 5 (Terucon edition)

Photograph a room, tap a wall, floor, ceiling or piece of furniture, pick a finish, and
Gemini renders that finish into the real photo. Only the chosen surface changes.

This version is built on a plain, familiar stack:

| Part | Technology | What it does |
| --- | --- | --- |
| Front end | HTML, CSS, JavaScript (no framework, no build step) | The studio in the browser: photo, surfaces, finishes, gestures, exports |
| Server | Node.js + Express | Serves the pages, holds the Google key, calls Gemini, saves rooms, forwards photos to the models |
| Database | MongoDB (+ GridFS for images) | Saved rooms: versions, materials, surface maps, photos and renders |
| Local models | Python (FastAPI + PyTorch) | SegFormer-B5 scene parsing (finds the surfaces, INT8 where it is fast) and SlimSAM (the Pick tool, tap-to-calibrate) |

Think of it as a restaurant. The browser is the dining room where the designer works. Express
is the waiter: it takes every order, keeps the Google key in its pocket and never hands it to
the table. MongoDB is the pantry where finished dishes (rooms) are kept. The Python service is
the specialist chef for the local models, and Gemini is the outside bakery the waiter calls
for renders.

#### Folder layout

```
server/            Express server
  index.js           app setup, pages, error handling
  config.js          reads .env
  db.js              MongoDB connection and the GridFS "files" bucket
  models/Room.js     the room record (Mongoose)
  routes/session.js  passcode sign-in and Settings > Check
  routes/ai.js       Gemini requests (renders, outlines, measurements)
  routes/rooms.js    saved rooms and their files
  routes/vision.js   forwards photos to the Python service
  google/token.js    service-account sign-in (JWT -> access token)
  google/vertex.js   Vertex AI calls with model fallbacks and retries
  lib/access.js      optional studio passcode (signed cookie)
public/            what the browser loads (plain files, served as they are)
  index.html         the studio on its own page (/studio)
  css/               swatchroom.css (all styles), fonts.css
  js/swatchroom-app.js   registers <swatchroom-app>
  js/core/           dom.js (builds and updates the page), api.js (talks to the server), icons.js
  js/views/          studio.js (state and layout), stage.js (photo and gestures), finishes, surfaces,
                     dialogs, gate (passcode screen), swatch.js (procedural material swatches)
  js/lib/            detection, rendering, framing, regions, products, sharing, storage...
  js/workers/        scene.worker.js (turns the class map into surfaces off the main thread)
  js/data/           finish catalogue and quantity rules
python/            the model service
  app.py             FastAPI endpoints
  scene.py           SegFormer-B5 (INT8 on x86), read in overlapping tiles with reused buffers
  pick.py            SlimSAM for the Pick tool
terucon/           the Terucon page served at "/" (built from the Claude Design export)
scripts/           build-terucon-page.js
tests/             Playwright walk-throughs and a mock of Google's endpoints
```

#### What you need

- Node.js 20 or newer
- MongoDB 7 or newer (installed locally, or a free MongoDB Atlas cluster)
- Python 3.10 or newer. A GPU is optional: on a normal CPU a scan takes about 6 seconds and
  preparing a photo for Pick about 5 seconds (each tap after that is instant)
- A Google Cloud project with Vertex AI (see below)

#### Setting up

##### 1. Google Cloud key

Replace `PROJECT_ID` and run:

```sh
gcloud services enable aiplatform.googleapis.com --project PROJECT_ID

gcloud iam service-accounts create swatchroom \
  --project PROJECT_ID --display-name "Swatchroom"

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member "serviceAccount:swatchroom@PROJECT_ID.iam.gserviceaccount.com" \
  --role roles/aiplatform.user

mkdir -p keys
gcloud iam service-accounts keys create keys/swatchroom-key.json \
  --iam-account swatchroom@PROJECT_ID.iam.gserviceaccount.com
```

The key stays on the server (`keys/` is ignored by git). If key creation is blocked, the
organisation policy `iam.disableServiceAccountKeyCreation` is on and an admin has to allow it.
On Cloud Run you can skip the key file and set `GOOGLE_USE_METADATA_SERVER=true`.

##### 2. Server (Node.js + Express + MongoDB)

```sh
npm install
cp .env.example .env        # then edit .env: MONGODB_URI, GOOGLE_APPLICATION_CREDENTIALS...
npm start                   # http://localhost:3000
```

##### 3. Model service (Python)

```sh
cd python
python -m venv .venv
source .venv/bin/activate              # Windows: .venv\Scripts\activate
# CPU only (smaller download):
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8001
```

With an NVIDIA GPU, install the CUDA build of PyTorch from pytorch.org instead of the CPU
line; the service picks the GPU automatically (`MODEL_DEVICE=cpu|cuda|mps` forces one). The
models download from Hugging Face on first use (about 340 MB for SegFormer B5, 250 MB for B4, 100 MB for
B2, about 100 MB for SlimSAM) and are cached after that.

##### 4. Open it

- `http://localhost:3000/` the Terucon page with the studio inside
- `http://localhost:3000/studio` the studio on its own

Open **Settings → Check** once: it tests the Google key, every model, the Python service and
MongoDB, and says in plain words what is missing.

#### Putting it online

- Set `STUDIO_PASSCODE` and `SESSION_SECRET` in `.env`. Without a passcode anyone who can open
  the page can use the Google project (and its bill).
- Serve it over https (nginx or Caddy in front), with `TRUST_PROXY=1` and `SECURE_COOKIES=true`.
- Keep the Python service on `127.0.0.1`, or on a separate GPU machine with the same
  `MODEL_SERVICE_KEY` set on both sides.
- Keep both processes running with a process manager, for example
  `pm2 start server/index.js --name swatchroom` and
  `pm2 start "uvicorn app:app --host 127.0.0.1 --port 8001" --name swatchroom-models --cwd python`.
- Back up MongoDB: rooms, photos and renders are all in the database.

Deploying to [Render](https://render.com) specifically: see `render.yaml` and **DEPLOY.md** for
the exact service settings, build/start commands and environment variables.

#### Admin dashboard

`/admin` (`public/admin.html`, `server/routes/admin.js`) - its own sign-in, independent of the
studio passcode above, defaulting to `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `.env`
(`admin@terucon.in` / `admin@123` when unset - change this before putting the studio online).
It shows:

- How many people are live right now (`server/models/LiveVisitor.js`, a ~90s heartbeat)
- Generations, scans, Pick tool uses and pipeline runs, who made them and how they went
  (`server/models/EventLog.js`, kept 30 days)
- Google / model service / room pipeline / MongoDB status - the same checks as Settings > Check

- Cold start vs processing for each model service (`server/lib/coldStart.js`), also shown as a tiny
  dot in the corner of the studio for a browser signed in here: see "The owner's dot" in DEPLOY.md

PostHog analytics (`public/js/lib/analytics.js` in the browser, `server/lib/posthogClient.js`
on the server) turn on automatically once `POSTHOG_KEY` is set in `.env`; leave it blank to
disable analytics entirely.

#### The Terucon page

`terucon/Swatchroom.html` is the page from Claude Design, with its studio swapped for a tiny
loader that imports `/js/swatchroom-app.js` from this server. When the page is redesigned,
export it from Claude Design and run:

```sh
npm run terucon-page -- path/to/exported/Swatchroom.html
```

The `<swatchroom-app>` element also works on any other page served by this server. On a page
served from another site, point it at the server: `<swatchroom-app server="https://studio.example.com">`
and load `https://studio.example.com/js/swatchroom-app.js` as a module (the server must then
allow that site; same-site hosting is simpler).

#### How a render travels

1. The designer taps a surface and a finish. The browser cuts the photo, the mask and a guide
   image to size (in `public/js/lib/render.js`).
2. It posts them to `POST /api/ai/generate`. The server adds the Google token, picks the
   request shape for the model, and calls Vertex AI, falling back to an older model if the
   newest one is not enabled and retrying on quota errors.
3. The browser places the result back on the photo, keeps a "selection only" version, and
   saves both to `PUT /api/rooms/:id/files/...` (GridFS). The room record follows a moment later.

A scan is a race between two engines: the photo goes to `POST /api/vision/segment?model=b5-quant`
(Express forwards it to the Python service, SegFormer-B5 labels every pixel) and, when `ONEFORMER_URL`
is set, to `?model=oneformer` (OneFormer on Modal, more accurate, with its own object instances). The
first to answer is built into surfaces by a worker in the browser (using Gemini's outlines to split walls
into planes) and shown at once; if OneFormer is the later one, its scan is built in the background and
offered as "HD Surface Scan Ready - Tap to Apply" (or swapped in silently while nothing has been edited).
Which engine starts when is decided by the start-up gate's `modalIsWarm` (`public/js/lib/segmentRace.js`).

#### API

| Method and path | Purpose |
| --- | --- |
| `GET /api/session` | Server facts the studio needs (passcode on, Google project, which pipeline models are configured) |
| `POST /api/session` / `DELETE /api/session` | Sign in with the passcode / sign out |
| `POST /api/check` | Settings > Check |
| `POST /api/ai/generate` | Gemini: `task` = `json`, `masks` or `image` |
| `POST /api/ai/forget-models` | Try the newest models again |
| `GET /api/rooms`, `GET/PUT/DELETE /api/rooms/:id` | Saved rooms |
| `PUT /api/rooms/:id/scan` | Surface-map details (labels are the file `scan/labels`) |
| `PUT/GET /api/rooms/:id/files/<name>` | Photos, renders, masks, thumbnail |
| `POST /api/vision/segment?model=b5-quant\|oneformer` | Scene parsing (photo as the body): the local quantized SegFormer-B5 or OneFormer on Modal, same answer shape |
| `POST /api/vision/pick/embed?key=...`, `POST /api/vision/pick/mask` | The Pick tool |
| `GET /api/vision/warmup` | Is the Modal pool warm? Answered from the server's own record, never calls Modal |
| `GET /api/vision/health`, `POST /api/vision/warmup` | Model service status and preloading (the local Python service) |

#### Models

| Job | Model | Falls back to |
| --- | --- | --- |
| Render the finish | `gemini-3.1-flash-image` | `gemini-3.1-flash-lite-image` |
| Outlines, names, measurements | `gemini-3.8-flash` | 3.7, 3.6, 3, 3.5 Flash |
| Find surfaces | SegFormer-B5 (INT8 where fast) in the Python service, raced against OneFormer (Swin-L, ADE20K) on Modal | Gemini outlines |
| Pick tool | SlimSAM-50, in the Python service | |

`gemini-2.5-flash` is only used by the optional "Pixel masks" detection settings; Google
retired it on Vertex AI on 20 October 2026, so the default is "Outlines".

#### Tests

`tests/` drives the real studio in Chromium against a mock of Google's token and Vertex AI
endpoints (MongoDB and the Python models are real).

```sh
cd tests && npm install && npx playwright install chromium && node make-test-key.js
python3 mock_google.py 8790 &          # needs numpy and Pillow
# in the project folder: add the lines from tests/.env.test to .env, then npm start
node flow.js phone http://localhost:3000/studio         # phone, phoneSmall, phoneLand, tablet, laptop, smallLaptop
node tools_flow.js laptop http://localhost:3000/studio  # outline, brush, Pick, exports, settings check, reopen a room
```

Unit tests that need nothing running: `npm test` (fusion, .npy, the Modal adapters, cold-start
classification, the words of the owner's dot, the vector outlines, the OneFormer / analyze adapters and the
passive warm-up clock, wall-plane splitting, the start-up gate and the scan race, SAM calibration, the instant
preview's maths / texture cache / stage state machine, the AI-render brief, and - when the Python packages are
installed, otherwise skipped - the Modal blueprint's HTTP layer and the local scene service). None of them calls
Modal, Google or a database.

Put two room photos in `tests/` first: `room-land.jpg` and `room-port.jpg`. Screenshots go to
`tests/shots-new` and `tests/shots-tools`.

Tested sizes: 360×740 and 390×844 phones, 844×390 phone landscape, 820×1180 tablet, 1280×720
and 1440×900 laptops, on the studio page and the Terucon page, with and without a passcode,
and with the model service switched off (scans fall back to Gemini outlines).
