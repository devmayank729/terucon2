# Terucon site, Materials shop, My project and the Design Studio

Four pages that work as one site, an **Express** server that runs it, and a **Python model service** behind the Design Studio.

| Part | Language | Where |
|---|---|---|
| The website: pages, shop, API, Google proxy, guards, tests, build tooling | JavaScript (Express 5) | `app.js`, `server/`, `tools/`, `tests/` |
| The pages as data: routes, links between pages, every patch made to the Claude Design exports | JSON | `site/` |
| The models: Gemini detection, SAM, edge snapping, evaluation, fine-tuning | Python | `model/` |

The server

* keeps your **Google Cloud credentials in `.env`** (they never reach the browser),
* finds the surfaces in a photo for the **Design Studio** with **Gemini on Vertex AI** (done by the Python service),
* and, **optionally**, sharpens their edges with a **SAM** model. Everything works without SAM, and the website works without the Python service.

| Page | Address when the server is running | Built from |
|---|---|---|
| Terucon website | `/` | `pages_original/index.html` |
| Materials shop | `/materials` | `pages_original/market_place.html` |
| Design Studio ("Swatchroom") | `/design-studio` | `pages_original/Swatchroom.html` |
| My project (client dashboard) | `/my-project` | `pages_original/dashboard.html` |
| Project overview (what every part does, live status) | `/project-overview` | `docs/PROJECT_OVERVIEW.html` |

---

## Quick start

```bash
npm install                              # Express
npm run setup:model                      # optional, once: Python packages for the model service (Pillow, OpenCV, Flask, ...)
cp .env.example .env                     # (already done if .env exists)
#  open .env and paste your Google credentials (section 1 below)
npm start
```

Open **http://localhost:8080**. The banner in the terminal tells you what is configured:

```
Terucon server
  Site:              http://localhost:8080/
  Design Studio:     http://localhost:8080/design-studio
  Project overview:  http://localhost:8080/project-overview
  Settings file:     /…/.env  (found)
  Google: Vertex AI as swatchroom@my-project.iam.gserviceaccount.com  (project my-project, location global)
  SAM: off (optional; set SAM_ENABLED=true to use it)
  Segmentation: engine=auto, edge refinement=on, contour
  Model service: Python, started with the server
  Press Ctrl+C to stop.

10:46:39  [model] ready at http://127.0.0.1:37531  (SAM: off)
```

Open the pages through the server, not by double-clicking them. The static pages work from disk, but from a
`file://` address the Design Studio's in-browser vision worker failed to start (observed in Chrome), which silently
dropped it to a much coarser fallback. The Studio now says so on its key screen.

The Python service is started and stopped by `npm start`; see section 6 for running it yourself, on another machine, or not at all.

---

## 1. Credentials: `.env`

Everything secret goes in **`.env`** (next to `package.json`). It is git-ignored and the server refuses to serve it.
The variable names are the same as in `terucon_backend/.env`, so values paste straight across.

**Option A, recommended: a service account for Vertex AI**

1. Google Cloud console → *IAM → Service accounts* → create one, give it **Vertex AI User**.
2. Enable the **Vertex AI API** (`aiplatform.googleapis.com`) and billing on the project.
3. *Keys → Add key → JSON*. Open the file and paste **all of it on one line, inside single quotes**:

   ```
   GCP_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"my-project","private_key":"-----BEGIN PRIVATE KEY-----\n…","client_email":"…"}'
   GOOGLE_CLOUD_PROJECT=my-project            # the short project id (optional: it is read from the key)
   GOOGLE_CLOUD_LOCATION=global
   ```

   Or leave the JSON out and set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`.

**Option B: a Gemini API key** from Google AI Studio: `GEMINI_API_KEY=…` (leave Option A blank).
You will need to set `SWATCHROOM_IMAGE_MODEL` to an image model your key can use.

Save the file and **reload the page**; `.env` is re-read whenever it changes (by the Express server and by the Python service, SAM included). Restart only to change `HOST`, `PORT` or the `MODEL_*` settings.
A variable exported in your terminal wins over the file.

Things the server checks for you: a key pasted into `GOOGLE_CLOUD_PROJECT` (it is used, with a warning to move it),
invalid JSON, a key whose `token_uri` is not Google's, a model name your project cannot use (the next one is tried and
the studio says which), and a clock that is wrong (Google rejects the token).

---

## 2. SAM, optional

SAM does one job: it corrects the rough outlines Gemini draws near their own edges, and its boundary then counts as
extra evidence for the edge snapping described in section 3. **Off by default; the Design Studio works fully without it**
(Gemini + contour snapping, then the in-browser parser as a last resort). It helps when Gemini's outlines are rough (from about
2% off, clearly); with very good outlines it can make edges worse, so leave it off if you trust them to within about 1% (see section 3).

| You have | Set in `.env` | Notes |
|---|---|---|
| Just this computer | `SAM_ENABLED=true` | SAM 2.1 on the CPU. `pip install -r model/requirements-sam.txt` first (PyTorch + transformers). First start downloads ~180 MB. About 3 s per photo. |
| A GPU computer | `SAM_ENABLED=true`, `SAM_BACKEND=sam3`, `SAM_CHECKPOINT`, `SAM_REPO_DIR`, `HF_TOKEN` | Meta SAM 3, through the official `sam3` package (`build_sam3_image_model`, `Sam3Processor`). It is text-prompted, so for each kind ("wall", "floor", …) it finds every instance and each Gemini outline takes the instance that agrees with it best. |
| A GPU somewhere else | `SAM_ENABLED=true`, `SAM_REMOTE_URL=https://gpu-box:8080/api/sam`, `SAM_REMOTE_KEY=…` | Run this same project on the GPU machine with `HOST=0.0.0.0` and `SAM_SERVER_KEY` set to the same key (or only its Python service, `cd model && python -m terucon_model`, and point at `…/sam`). Any server answering `/health`, `/segment`, `/refine` also works. |

Watch the terminal for `SAM: ready`. In the Design Studio, *Settings → Detection → Automatic* shows the live state, and the
Pick tool uses the server's SAM for clicks (falling back to the in-browser SlimSAM while the model loads).

---

## 3. How the Design Studio finds surfaces

```
photo ─► Gemini (Vertex AI)  names every surface and draws a rough outline        (kinds: wall, floor, ceiling,
            │                                                                       window, door, furniture, other;
            │                                                                       interior or exterior/façade)
            ├─ SAM on?  ─► SAM corrects each outline, only near the outline's own edge
            ▼
        contour snapping: every boundary of every surface (outer edges and holes) slides along its normal onto the
            │             photo's real edge, paying for every pixel it moves, so a good outline barely changes and a bad
            │             one is pulled in. Surfaces SAM did not agree with are snapped from their outline alone.
            ▼
        layering (structure below, windows and doors above, furniture on top) ─► clean-up ─► label map ─► the Studio
```

* **Automatic** (default) uses the server engine (Express asks the Python service); if it fails (quota, key, network, or the service is not running) the **in-browser scene parser** runs, and
  if that fails Gemini-in-the-browser. Every fallback is announced; the footer always names what produced the surfaces.
* The Express server also forwards the Studio's other Gemini calls (renders, quantity estimates), so in server mode **the page never
  talks to Google itself**; the end-to-end tests assert this. (Served without the server, the Studio still works the old way:
  key screen, browser-direct calls, in-browser detection; this was re-tested.)
* Outdoor photos used to come out as one giant "Window" (see below). Both the server engine and the in-browser parser now
  treat buildings as **Facade**, the ground as **Ground**, and leave sky, trees, plants and vehicles out of the list.

### What was wrong, and how much better it is (measured)

**1. Outdoor photos were nearly unusable.** The in-browser parser mapped `building`, `house`, `sky`, `tree`, `road`… to
**Window**. On your office-building render that made **93%** of the image one "Window" (**78%** on the school-gate photo).
Scored against exact ground truth (SegFormer-B4 on ADE20K validation photos, same model, only the class mapping differs):

| Photos | Per-surface IoU, old mapping | new mapping |
|---|---|---|
| 30 exterior (buildings) | **0.057** (wall 0.03, floor 0.02 pixel IoU) | **0.607** (wall 0.90, floor 0.83) |
| 30 interior | 0.592 | 0.592, identical: no change where it already worked |

Now: Facade 44% + Ground 10% on the office building; Facade, two boundary walls, Ground 27%, Door and signboards on the
gate photo; sky, trees and vehicles are left out of the surface list. Outdoor photos are recognised automatically
(29 of 30 here).

**2. Opened from disk, the in-browser vision worker could not start**, so the Studio silently used coarse Gemini outlines
only. Use the server (it now also enables multi-threading for the in-browser fallback), and the key screen warns you when
a page is opened from a file.

**3. Edge precision.** Gemini's outlines are only good to a few percent of the frame, so how close the final edge lands to the real
one decides whether a finish spills onto the next surface or stops short of its edge. This was audited on ADE20K validation
photos with exact ground truth (method and caveats below). Four things were wrong:

* **Refining could make a good outline worse.** Given an outline within 0.5% of the real edge, the old SAM correction *lowered*
  boundary F1 (-0.076 [-0.101, -0.050] against the outline, over all 160 photos) and the old watershed was no better than leaving
  the outline alone (-0.016 [-0.037, +0.005]). Given the exact outline, the watershed lost 0.10 IoU and 0.23 boundary F1.
* **Surfaces SAM did not agree with got nothing.** SAM refuses an outline when its best mask overlaps it by less than 0.45 IoU:
  6%, 11%, 21% and 32% of the outlines at 0.5%, 1.2%, 2.5% and 4% error (the worst outlines are the ones refused; tuning photos). As soon as SAM accepted
  any outline, edge snapping was skipped for the whole photo, so the refused ones stayed exactly as drawn.
* **The watershed could not be right for every outline.** Its seeds (each outline eroded by a fixed distance) were either too
  small to fix a rough outline or large enough to wreck a good one; no seed size was good at every error level, and its edges
  came out ragged.
* **SAM is not an oracle on walls and floors.** Prompted with the *true* mask, SAM 2.1 small reaches IoU 0.78 and boundary F1 0.59 (floors 0.64 / 0.49) on these
  surfaces (tuning photos), less than an outline that is only 0.5% off. It is excellent on crisp straight edges and weak at deciding what a
  surface is, which is why its answer is only trusted near the outline.

What replaces the watershed is **contour snapping** (`model/terucon_model/segment/snap.py`). Every boundary of a surface (outer edges
and holes) is resampled and each point may slide along its normal. Sliding costs something (a pull back to the outline, a price
for bending); what pays for it is evidence in the photo: a colour change across the boundary, pixels that look like the surface
on its side and like its surroundings on the other, SAM's boundary, and the photo's own frame (a ceiling or wall that runs to the
edge should not stop a few pixels short of it). Dynamic programming picks the cheapest set of slides, so a good outline barely
moves and a bad one is pulled onto the real edge. Surfaces SAM refused are snapped from their outline alone, so nothing is left
raw. It works at a capped resolution (so a 1536 px photo behaves like a 768 px one), a surface that cannot be processed keeps its
outline, and `EDGE_METHOD=watershed` brings the old method back.

How much better, measured through the same code the server runs (`model/eval/refine_eval.py`). "Outline error" is how far the
simulated outline sits from the true edge (below), cells are **mean IoU / boundary F1**: IoU says how much of the surface's area
is right, boundary F1 how many edge pixels lie within 0.4% of the image diagonal (about 5 px on a 1024 px photo) of a real edge.

*60 photos used for nothing else; outlines that drift and jitter* (226 surfaces), mean IoU / boundary F1:

| route | 0.5% | 1.2% | 2.5% | 4% |
|---|---|---|---|---|
| raw outline | 0.892 / 0.756 | 0.811 / 0.447 | 0.691 / 0.273 | 0.578 / 0.187 |
| edge snapping before (watershed) | 0.882 / 0.709 | 0.845 / 0.603 | 0.726 / 0.402 | 0.598 / 0.253 |
| **edge snapping now (contour)** | 0.891 / 0.762 | 0.846 / 0.625 | 0.753 / 0.467 | 0.622 / 0.313 |
| SAM before | 0.862 / 0.637 | 0.841 / 0.607 | 0.760 / 0.478 | 0.652 / 0.334 |
| **SAM now (SAM + contour)** | 0.862 / 0.656 | 0.844 / 0.635 | 0.784 / 0.558 | 0.682 / 0.426 |

*The same photos, outlines that are too fat or too thin (bias 1, 2, 3 = about 0.3-1%, 1-2%, 2-4% of the short side)* (226 surfaces), mean IoU / boundary F1:

| route | bias 1 | bias 2 | bias 3 |
|---|---|---|---|
| raw outline | 0.881 / 0.690 | 0.783 / 0.136 | 0.699 / 0.131 |
| edge snapping before (watershed) | 0.885 / 0.718 | 0.835 / 0.576 | 0.709 / 0.220 |
| **edge snapping now (contour)** | 0.891 / 0.748 | 0.849 / 0.537 | 0.779 / 0.397 |
| SAM before | 0.865 / 0.629 | 0.833 / 0.578 | 0.773 / 0.395 |
| **SAM now (SAM + contour)** | 0.864 / 0.649 | 0.841 / 0.613 | 0.800 / 0.520 |

*Held-out and fresh photos together (100 photos, 355 surfaces), drifting outlines: change in mean IoU / boundary F1, with a 95% interval from resampling whole photos*

| change | 0.5% | 1.2% | 2.5% | 4% |
|---|---|---|---|---|
| no SAM: now against before | IoU +0.006 [-0.001, +0.013]<br>bF1 +0.039 [+0.021, +0.057] | IoU +0.003 [-0.005, +0.011]<br>bF1 +0.028 [+0.007, +0.050] | IoU +0.035 [+0.026, +0.045]<br>bF1 +0.091 [+0.069, +0.114] | IoU +0.028 [+0.020, +0.036]<br>bF1 +0.078 [+0.062, +0.095] |
| SAM: now against before | IoU -0.002 [-0.004, +0.001]<br>bF1 +0.017 [+0.012, +0.023] | IoU +0.002 [-0.002, +0.005]<br>bF1 +0.027 [+0.019, +0.034] | IoU +0.026 [+0.019, +0.032]<br>bF1 +0.090 [+0.078, +0.101] | IoU +0.032 [+0.025, +0.037]<br>bF1 +0.105 [+0.093, +0.118] |
| no SAM: now against the raw outline | IoU +0.003 [-0.003, +0.009]<br>bF1 +0.036 [+0.014, +0.057] | IoU +0.040 [+0.031, +0.048]<br>bF1 +0.217 [+0.189, +0.246] | IoU +0.071 [+0.061, +0.080]<br>bF1 +0.231 [+0.206, +0.259] | IoU +0.048 [+0.041, +0.055]<br>bF1 +0.157 [+0.139, +0.176] |
| SAM: now against the raw outline | IoU -0.023 [-0.032, -0.015]<br>bF1 -0.054 [-0.085, -0.025] | IoU +0.043 [+0.032, +0.055]<br>bF1 +0.242 [+0.204, +0.277] | IoU +0.107 [+0.094, +0.119]<br>bF1 +0.336 [+0.305, +0.371] | IoU +0.111 [+0.098, +0.125]<br>bF1 +0.278 [+0.251, +0.305] |
| SAM against no SAM (both now) | IoU -0.026 [-0.034, -0.019]<br>bF1 -0.091 [-0.114, -0.068] | IoU +0.004 [-0.004, +0.012]<br>bF1 +0.025 [+0.003, +0.044] | IoU +0.036 [+0.027, +0.045]<br>bF1 +0.106 [+0.086, +0.124] | IoU +0.063 [+0.052, +0.074]<br>bF1 +0.121 [+0.101, +0.141] |

*Held-out and fresh photos together (100 photos, 355 surfaces), fat or thin outlines: change in mean IoU / boundary F1, with a 95% interval from resampling whole photos*

| change | bias 1 | bias 2 | bias 3 |
|---|---|---|---|
| no SAM: now against before | IoU -0.001 [-0.009, +0.006]<br>bF1 +0.019 [-0.002, +0.038] | IoU +0.011 [+0.001, +0.020]<br>bF1 -0.028 [-0.053, -0.001] | IoU +0.074 [+0.061, +0.088]<br>bF1 +0.209 [+0.174, +0.243] |
| SAM: now against before | IoU -0.003 [-0.006, +0.000]<br>bF1 +0.019 [+0.013, +0.027] | IoU +0.007 [+0.000, +0.014]<br>bF1 +0.035 [+0.019, +0.052] | IoU +0.029 [+0.022, +0.037]<br>bF1 +0.141 [+0.121, +0.163] |
| no SAM: now against the raw outline | IoU +0.010 [+0.002, +0.016]<br>bF1 +0.061 [+0.032, +0.089] | IoU +0.068 [+0.057, +0.079]<br>bF1 +0.448 [+0.415, +0.483] | IoU +0.090 [+0.077, +0.102]<br>bF1 +0.306 [+0.272, +0.341] |
| SAM: now against the raw outline | IoU -0.010 [-0.019, -0.001]<br>bF1 -0.015 [-0.047, +0.015] | IoU +0.064 [+0.051, +0.075]<br>bF1 +0.525 [+0.489, +0.561] | IoU +0.116 [+0.100, +0.132]<br>bF1 +0.439 [+0.399, +0.481] |
| SAM against no SAM (both now) | IoU -0.020 [-0.029, -0.012]<br>bF1 -0.076 [-0.098, -0.055] | IoU -0.004 [-0.012, +0.004]<br>bF1 +0.078 [+0.055, +0.102] | IoU +0.026 [+0.016, +0.037]<br>bF1 +0.133 [+0.105, +0.165] |

How the outlines were simulated, since Gemini cannot be called here: `drift` takes each true surface, simplifies it to 14-40
points and drifts and jitters them by the shown share of the image diagonal; `bias` makes it too fat or too thin by a fairly
constant 0.3-4% of the short side and traces it with few coarse points (how a language model tends to draw). The first model was
used to choose the settings (60 photos, "tuning set"); the second was added afterwards as a cross-check. The 40 "held-out" photos
were looked at once during development (an early version of the snapping lost a strip along the photo frame; the hint came from
them, the diagnosis and the fix from the tuning photos); the 60 "fresh" photos were run only with the final settings and are the
cleanest numbers above.

**A flaw in the earlier measurements, found and removed.** ADE20K's labels are missing along the photo frame: in nearly every
photo the outermost ring of pixels is unlabelled (about 20% of it carries a surface label, against about 69% a few pixels in).
Scored naively, a mask that correctly runs to the frame loses edge recall and one that stops a few pixels short is rewarded. The
earlier table in this README was scored that way: it showed the earlier watershed's boundary F1 at 0.5% error as 0.644 instead of
0.715, and the new frame handling (which makes masks reach the frame, as they should) would read 0.690 instead of 0.750 (tuning
photos, no SAM). The tool now ignores a 1% margin around the frame (`--frame-margin`, 0 scores everything), and every number here
is scored that way.

What this does and does not show:

* It measures **edge precision given outlines**, not whether Gemini finds the right surfaces. The simulated outlines know which
  pixels belong to which surface; a real Gemini answer can also miss a wall split or mislabel something. Treat the tables as "how
  much of a rough outline each route recovers", not as the accuracy you will see.
* **Where it is not better.**
  * *No SAM, outlines consistently 1-2% of the short side too fat or too thin* (bias 2): the old watershed placed edges better
    (boundary F1 -0.028 [-0.053, -0.001], although IoU is +0.011). A weaker pull back to the outline would fix that case, but costs
    accuracy on good outlines; the setting is a compromise.
  * *SAM still hurts a good outline.* At 0.5% error the SAM routes score below the raw outline (IoU -0.023, boundary F1 -0.054 [-0.085,
    -0.025]) and below snapping without SAM (IoU -0.026, boundary F1 -0.091); the earlier SAM route was further below the raw outline in boundary F1.
    Against snapping alone, SAM is about level at 1.2% error (boundary F1 +0.025 [+0.003, +0.044]) and clearly better from 2.5%
    (IoU +0.036, boundary F1 +0.106). Without SAM the new snapping is level with or slightly above the raw outline at 0.5% (IoU +0.003,
    boundary F1 +0.036), so if you trust Gemini's outlines to within about 1%, leave SAM off.
  * *Below about 2% error the gain is in the edges, not the area:* the IoU intervals at 0.5% and 1.2% include zero. Above it IoU
    improves as well (about +0.03 at 2.5% and 4%).
  * *Exact outlines come out slightly changed:* IoU 0.92-0.95 and boundary F1 0.84-0.90 without SAM (the old snapping: 0.89-0.94 and
    0.74-0.85; the old and new SAM routes about 0.87-0.92 and 0.65-0.78).
  * *Thin structures.* ADE's surfaces contain no furniture or railings, so `model/eval/thin_scenes.py` checks them on 12 synthetic
    scenes with exact truth: contour snapping matched or beat the watershed on walls, floors, windows and doors; on furniture with thin
    legs its IoU was slightly lower (0.88 against 0.90) and its boundary F1 slightly higher (0.98 against 0.97); and it recovered
    less of a railing made of nine 5 px bars (IoU 0.33 against 0.50), because the gaps between the bars lie beyond its reach. Real
    furniture and "other" items are unmeasured.
* **Speed.** Contour snapping costs about 0.03 s per outline: 0.28 s in total for 7 outlines on a 1024x768 photo (the watershed:
  0.17 s) and 1.1 s for 25 outlines on a 1536 px photo (the watershed: 1.6 s there, because the new method works at a capped
  resolution). Snapping has an 8 s budget per photo; surfaces it does not reach keep their outline and the scan says so. SAM itself
  still costs about 4 s per photo on a CPU.
* **How the settings were chosen.** The pull back to the outline, the reach, the weights (including how strongly the frame of the photo
  attracts a boundary) and the band SAM may move an edge were chosen on the 60 tuning photos with the drift model, then checked with
  the bias model; nothing was changed after the fresh photos were run. A pass over the settings on the tuning photos after the scoring
  flaw above was fixed left the SAM settings as they were and moved the no-SAM pull from 0.8 to 0.7.
* **"Automatic" is not proven better than "In the browser only" on interiors.** That comparison needs live Gemini. For reference
  the in-browser parser alone scores 0.592 / 0.507 per surface on the interior photos (single 512 px pass; the browser
  version tiles and flips, so it is a little better). If interior outlines from the server look worse to you, pick
  *Settings → Detection → In the browser only*; the façade fix applies there too.
* The tool scores `pipeline.sharpen`; `segment_image` then drops surfaces that end up under 0.25% of the frame, which the scores do not
  include (the effect is tiny).
* The photo sets behind these tables are not in the repo (they were built from the ADE20K validation shards in a scratch folder).
  `model/eval/ade_subset.py` builds comparable sets, and its `--skip` option picks photos you have not looked at; the numbers will differ a little
  on other photos, and a new round should use photos nobody has tuned on.
* Gemini cannot be called without credentials, so none of the above exercised it.

Reproduce (from `model/`): `eval/ade_subset.py` (build the photo set), `eval/refine_eval.py --sam [--noise bias]`,
`eval/sam_oracle.py` (SAM's own limits and refusals), `eval/segformer_baseline.py`.

---

## 4. The pages as JSON, and how they connect

* **`site/site.json` is the site.** Per page: its route, the pristine export it is built from, the built file, aliases (`/index.html`,
  `/Terucon Swatchroom.html`, … redirect permanently to the route), per-page response headers (the Studio gets the
  cross-origin-isolation headers its in-browser models need), and a `connections` matrix: which pages each page must link to.
  The old design-time names (`Design Studio.dc.html`, `Terucon Home v2.html`, …) redirect to the right page. The Express
  server, the page build, the link checker and the project overview all read this one file.
* **Every change made to the Claude Design exports is JSON, not code.** `site/patches/<page>.json` is an ordered list of anchored
  steps (relink, insert after / before, replace once, replace all, patch a JS string inside the app); `site/components.json`
  holds the shared HTML snippets (header link, menu card, footer link); the larger injected JavaScript is kept as real files in
  `site/patches/snippets/`. Every anchor must match exactly once or the build fails loudly, naming the page and the step.
  Format: `site/patches/README.md`.
* **Links between pages are routes** (`/materials`, `/design-studio`, `/my-project`, `/`). Added entry points: *Materials* and *My project*
  on the website; *My project* on the shop and the Studio. `npm run check:links` verifies every same-site link and the connections matrix.
* Two dead "Media brief" links (a design-review pill pointing at files that were never exported) are switched off with the
  page's own `mediaGuides` setting.
* Saved items and the cart live in `localStorage`, so they are shared across pages **when served from one address**
  (another reason to use the server).
* **The pristine exports are in `pages_original/`.** `npm run build:site` rebuilds `pages/` from them. If you export a page
  again from Claude Design, drop it into `pages_original/` under the same name and run it again; it fails loudly if the page
  changed in a way the patches cannot follow. `npm run check:site` tests without writing.

The dashboard is still a front-end prototype with a demo project ("Rao Dental Studio"); it links to everything, but it does
not yet receive data from the shop or the Studio.

---

## 5. Layout

```
app.js                       the Express server: `npm start` (createApp / startServer are exported for tests)
server/                      Express modules: config/ (.env, settings), lib/ (Google sign-in, Vertex client, site map),
                             middleware/ (guards), routes/ (pages, media, api, model proxy, docs), model/ (starts and watches the Python service)
site/                        site.json (the site map), components.json, patches/ (one JSON file per page + snippets/)
pages_original/              the four pristine Claude Design exports
pages/                       the four built pages (generated by tools/build-site.js)
media/                       photos and videos used by the website (the only files /media/ will serve)
model/                       PYTHON, everything about the models
  terucon_model/             the service (Flask): app.py, config.py, google_auth.py, vertex.py,
    segment/                   detect.py (Gemini), snap.py (contour snapping), sam_refine.py, refine.py (layering, the earlier watershed), pipeline.py
    sam/                       backends.py (SAM 2/1, SAM 3, remote), manager.py
  eval/                      ground-truth evaluation of the segmentation
  finetune/                  home for fine-tuning code and notes
  tests/                     Python tests, mock_google.py, a stand-alone mock-Google server
tools/                       build-site.js, bundle.js, check-links.js, build-overview.js, run-model.js, run-tests.js
tests/                       js/ (node:test), e2e/ (Chrome), dev/ (the whole site against a mock Google), helpers/, fixtures/
docs/                        HOW_TO_RUN.md (short run guide) and PROJECT_OVERVIEW.html (generated map of the project)
.env  .env.example           your settings / the documented template
```

## 6. Running the pieces

```
Browser ─► Express :8080 ─► Google (renders: /api/vertex/generate)
              │
              └─► Python model service (127.0.0.1, free port)  ─► Google (Gemini detection) / SAM
```

* `MODEL_SERVICE=auto` (default): `npm start` finds a Python that has the service's packages (`PYTHON`, `model/.venv`, `.venv`, `python3`, `python`),
  starts `python -m terucon_model` on a free port with a random shared key, shows its log lines prefixed `[model]`, restarts it with back-off
  if it crashes, and stops it when you stop the site (even after `kill -9`).
* `MODEL_SERVICE=external`: you run `npm run model` (or the service on a GPU machine) and set `MODEL_SERVICE_URL` (and `MODEL_SERVICE_KEY`).
* `MODEL_SERVICE=off`, or Python missing: the website is complete; `/api/segment` answers 503 with the reason and the Design Studio uses its
  in-browser parser (and says so).
* Express sends the browser's photo to the service as a stream (no re-encoding), so a 4096 px photo costs nothing extra.
* Two small Google clients exist on purpose: JavaScript signs in for renders, Python signs in for detection. They read the same `.env`,
  and a shared test fixture (`tests/fixtures/env-cases.json`) runs against both so they cannot drift apart.

## 7. Tests

```bash
npm test                          # site build check, link check, overview check, JavaScript tests, Python tests (no credentials, no GPU)
npm test -- --e2e                 # + Chrome: links, Studio scan + render, secrets not served
npm run test:js                   # only JavaScript (server, build, overview)
npm run test:model                # only Python (service, config, Google client, segmentation, snapping)
TERUCON_HEAVY_TESTS=1 npm run test:model     # + real SAM 2 on the CPU
cd tests/e2e && npm install && npm run test:sam   # + real SAM 2 and the Pick tool in the browser
```

`node tests/dev/stack.mjs` starts the real site and the real Python service against a **mock Google**, handy for working on the UI without spending anything.

## 8. Troubleshooting

| You see | Do |
|---|---|
| "The Terucon server is running but has no Google credentials yet" | Fill in `.env` (section 1), reload the page. |
| "The Vertex AI API is turned off for project …" | Enable `aiplatform.googleapis.com`, wait a minute. |
| "…is not allowed to call …" | Give the service account **Vertex AI User**. |
| "… is not available in location …" / 404 | `GOOGLE_CLOUD_LOCATION=global`, or set the model in `.env`. The terminal shows each model tried. |
| "Google rejected the token time" | Fix the computer's clock (automatic date and time). |
| "GCP_SERVICE_ACCOUNT_JSON … not valid JSON" | The whole key on one line, in **single** quotes. |
| "Could not start on port 8080" | Change `PORT` in `.env`. |
| "Model service: unavailable …" in the banner | The line says why. Missing packages: `npm run setup:model`. Wrong Python: set `PYTHON` in `.env`. The website works meanwhile. |
| `SAM: error …` in the banner or Settings | The message says why: missing `torch`/`transformers` (install `model/requirements-sam.txt`), a gated model (`HF_TOKEN`), no GPU for SAM 3. |
| Edges look worse than before on some photos | Set `EDGE_METHOD=watershed` in `.env` (the earlier method) and reload; `EDGE_REFINE=false` switches edge snapping off. The footer names what ran. |
| "Edge snapping was skipped for … outlines" | It ran out of its 8 s budget or hit an error on those surfaces; they keep the outline as drawn. The terminal says why. |
| Surfaces look coarse | Look at the footer ("Surfaces by …"). "SegFormer … on WASM" means the in-browser fallback ran; check the notes toast and the terminal (`[model]` lines) for why the server engine failed. |
| `npm run build:site` fails with "matched 0 times" | A re-exported page changed; update that step in `site/patches/<page>.json`. |

The terminal prints one line per Google call (Express) and per scan (`[model]`): status, time, model, Google's own error message; never images or keys.

## 9. What could not be verified here

* **No live Google calls were made** (no credentials on this machine). Both Google clients (JavaScript for renders, Python for detection) are tested
  against a mock that checks the RS256 token request, Vertex's URL and headers, retries, error pass-through, structured-output fallbacks and model
  fallbacks; model names (`gemini-3.8-flash`, `gemini-nano-banana-2.1`) are the Studio's own defaults and were not confirmed against Vertex.
  The first real run is the real test: run one scan and one render and read the terminal.
* **SAM 3** (the `sam3` backend and its text-prompt route) was written to match your earlier Kaggle benchmark scripts (since removed from `media/`; they are in git history, commits
  `cb72a6b` and `48f7886`) and tested only with a
  stand-in of the same shape, not run (it needs a CUDA GPU and the gated checkpoint). SAM 2.1 on CPU was run for real
  (tests, evaluation, browser).
* **Contour snapping and the numbers above were measured on simulated outlines**, never on Gemini's own, and on ADE20K photos (interiors and
  buildings), which contain no furniture or railings. Tell me if real scans disagree with the tables.
* `gemini-2.5-flash`, the only Gemini model that returned pixel masks, retires on Vertex AI on 20 Oct 2026; the new pipeline
  does not depend on it.

---

## Deploying to Render

`Dockerfile` and `render.yaml` run Express and the Python model service in one web service.

1. Push the project to GitHub (`.env` and `service-account*.json` are git-ignored; keep them out).
2. Render: **New > Blueprint**, pick the repo. It reads `render.yaml`.
3. In the service's **Environment > Secret Files**, add a file named `service-account.json` and paste the whole key JSON. It is mounted at `/etc/secrets/service-account.json`, which `render.yaml` already points `GOOGLE_APPLICATION_CREDENTIALS` at.
4. Set `GOOGLE_CLOUD_PROJECT` if the key's project is not the one to bill. The service account needs `roles/aiplatform.user`.
5. After deploy, `https://<your-service>.onrender.com/api/health` should show `"google":true`.

Locally the same file works with no settings at all: save the key as `service-account.json` in the project folder (or `credentials/service-account.json`).
