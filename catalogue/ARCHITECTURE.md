# Catalogue engine: architecture and contract

This is the contract the Python package, the Modal app, the website's gateway and the browser pieces are all built against. If you find
that something here is wrong or cannot be done, **do not quietly work around it: say so in your report** (the owner of this file reconciles).

Serves `TARGETS.md`: **C3** (match an inspiration photo to catalogue materials), **C4** (point the camera at a material), **C7** (colour match;
the paint partner's palette does not exist yet), **C5** (text search is a building block), **D1** (the admin uploads the catalogue; the PDF
says "designs"). It is groundwork for A1 / C1 (a real catalogue).

## 1. Facts this design rests on (all from the notebook `terucon-cat-1.ipynb`, in its stored output)

| Fact | Where |
|---|---|
| The catalogue PDF is `Superbond colour image.pdf`: 69 pages, 167.7 MB, **no text layer** on the sampled pages. | cell 1 output |
| 69 items came out: one full-page image per page (`image_bbox` is the same `[26.833, 15.0, 568.166, 827.0]` for all). **One page is one design**: a big swatch with a small printed label (code, e.g. `SB804`, and name, e.g. `EMPEROR DARK`) **as pixels**, so the text-layer ID reader found nothing: all 69 are `UNMATCHED` (`product_id: None`), `id_bbox: None`. The label is readable in the picture; no code reads it. | cell 7 output + its figure |
| Pages 66 and 32 look like the same design (results #1 and #2 for the same query, both labelled SB804 EMPEROR DARK). Near-duplicate pages exist and nothing merges them. | cell 7 figure |
| Vector sizes: dino 3072, siglip 1152, color 396, vertex_mm 1408, text 768 (stored as float16, 6,796 numbers = 13,592 bytes per item). | cell 7 output |
| The only quality measurement: "self-retrieval under simulated phone capture", 40 queries: siglip_image recall@1 0.925 (recall@5 1.0), FUSED 0.925, dino_image 0.800, color_image 0.475. **It ran without `vertex_mm` and without the Gemini description.** The queries are distorted copies of the catalogue's own pages, **printed label strip and margin included**, so this measures robustness to distortion, not how well a photo of a real physical sample matches. Nobody has measured real photos. | cell 7 output, cell 6 `evaluate_self_retrieval` |
| `final_score` is **relative**: each signal is min-max normalised over the candidate pool (cell 6, `linear_score`), so the best item scores near 1 whatever the real similarity. It must never be shown as "98 % match". Raw cosine similarities are in `signals`. | cell 6 |
| Timings (T4 x2, Kaggle): 69 pages extracted in 59 s; local features 3.7 img/s; 69 Vertex image embeddings ~11 s; 69 Gemini captions ~65 s (one 429 retried); a photo query with the Gemini description ~6 s, a query without ~0.6 s each in the benchmark. | cell 7 output |
| Versions that ran: torch 2.11.0+cu128, transformers 5.16.1, PyMuPDF 2.0, OpenCV 4.14.0, google-genai 2.12.1 (faiss 1.15.1, not needed here). Models: `facebook/dinov2-large`, `google/siglip-so400m-patch14-384`, Vertex `multimodalembedding@001`, `gemini-2.5-flash` (captions), `gemini-embedding-001`. | cells 1, 2, 7 |

The notebook's exact `feature_versions` (what the Kaggle run stored next to every vector) are reproduced by `terucon_catalogue.config.compute_feature_versions`
(`tests/test_foundation_parity.py` proves it against the notebook's own code):

```
dino       facebook/dinov2-large|448|r512|w0.5,0.25,0.25|clahe1.5x8|v1
siglip     google/siglip-so400m-patch14-384|clahe1.5x8|v1
color      lab6x8x8|ab80|clahe2x8|s0.6|hw0.8|k3|m384|v1
vertex_mm  multimodalembedding@001|d1408|v1
text       gemini-embedding-001|d768|cap<12 hex>|v1      (the fingerprint depends on the prompts and the installed pydantic)
```

## 2. The one idea: compute, then a bundle, then one publisher

Every way of getting a catalogue in produces the same artifact and goes through the same publish code.

```
 (a) admin uploads a PDF / photos ──► Modal `ingest_job` ──┐
 (b) owner computes on Kaggle / locally (`compute`) ───────┼─►  BUNDLE  ──►  publish_bundle() ──►  MongoDB   items, jobs, releases, active pointer
 (c) the finished Kaggle run (state.sqlite + crops/) ──────┤  (a work_dir:      │               GCS       sources, crops, thumbs, state snapshot, RELEASES
     as it is today                                            │   state.sqlite     │               Modal     read-through cache of the active release
 (d) the same folder, uploaded by the owner to the bucket ─────┘   + crops/)        └─ validates BEFORE it writes anything
     under imports/..., read by Modal `import_bundle_fn`
```

* **Bundle** = the notebook's `work_dir`: `state.sqlite` (the notebook's schema, unchanged: `StateStore.SCHEMA`) and `crops/<pdfstem>_<sha8>/<item_id>.png`.
  A bundle written by the notebook has absolute Kaggle paths in `items.crop_filepath` / `source_pdf`; `bundle.py` reads both those and the
  bundle-relative paths this package writes.
* **Compute** runs wherever you like (Modal, Kaggle, your laptop). **Publish** needs only MongoDB + GCS credentials, no GPU and no torch.
  This is the owner's "store the data directly to the respective places, saving the compute" option: compute elsewhere, then `publish`.
* **Release** = an immutable snapshot a search service loads. Publishing builds a new release = the parent release's vectors + the bundle's.
  Making it live is a separate, explicit step (flip `catalogues.activeRelease`), so an admin can review first and roll back.
* **(d) A bundle that already sits in the bucket** (`bucket_import.py`, the Modal function `import_bundle_fn`, `modal run modal_app.py::import_bundle`): the
  owner uploads the notebook's output folder to `imports/<catalogue>/<name>/` themselves; nothing in this package fetches anything from Kaggle. The Modal
  function copies `state.sqlite` and the pictures into a temporary folder next to the bucket, runs the same `publish_bundle`, and then puts the new release
  on the Modal volume (`load_release` into `/cache`, then `volume.commit`). A catalogue is never created by accident: the catalogue must exist, or the
  command says `--create "<name>"`. The same seeding runs after an admin-upload job (`ingest_job_fn`) and on demand (`prime_fn`, `modal run modal_app.py::prime`).

## 3. Where each thing lives

| Thing | Home | Why |
|---|---|---|
| Original PDFs / photos | GCS `sources/<sha256>/<name>` | durable; the lineage check re-renders from the PDF |
| Crops (full size PNG), thumbnails (480 px JPEG) | GCS `crops/…`, `thumbs/…` | the browser loads them straight from GCS with signed URLs, never through the website |
| Release (vectors + compact item list) | GCS `releases/<catalogue>/<releaseId>/…` (**the durable copy**) | immutable, versioned, rollback is a pointer flip |
| Items, labels, hidden flags, jobs, releases, the active pointer | MongoDB (`terucon_` collections) | an admin edit shows at once: **search returns item ids, the website enriches them from MongoDB** |
| Release cache | Modal Volume `terucon-catalogue-cache` mounted at `/cache` | read-through cache of **releases only** (not pictures: the browser loads those from GCS), filled ahead of time by `import_bundle_fn`, `ingest_job_fn` and `prime_fn` and otherwise by the first search that needs a release; a cold container reads it and downloads nothing; **never the only copy** |
| Model weights | baked into the Modal image (like `swatchroom/modalBlueprint.py`) | fastest cold start; `HF_HUB_OFFLINE=1` at run time |
| Compute checkpoint | GCS `bundles/<catalogue>/<jobId>/state.sqlite` | a failed job can resume; SQLite never runs on a Volume |
| A finished bundle the owner uploaded | GCS `imports/<catalogue>/<name>/` | the input of `import_bundle_fn`; left in place after the import (a re-run changes nothing) |

The website host does no model work, no PDF parsing, never touches vectors, and never proxies images.

## 4. Data formats

### 4.1 Identifiers
`catalogueId` `^[a-z0-9][a-z0-9-]{1,38}$` · `jobId` `job-YYYYMMDDHHMMSS-xxxxxx` (6 hex) · `releaseId` `rel-YYYYMMDDHHMMSS-xxxxxx` · `itemId` the notebook's
`<pdfsha256[:12]>-p<page:04d>-i<index:02d>` · Mongo `_id` of an item `"<catalogueId>|<itemId>"`. Times are epoch milliseconds (numbers). All JSON field names are camelCase,
except the identifiers inside `signals` (`dino_image`, ...) and the pillar names (`dino`, `siglip`, `color`, `vertex_mm`, `text`), which are the notebook's.

### 4.2 GCS keys
Keys below are **relative**; the store prepends `CATALOGUE_GCS_PREFIX` (default `catalogue/`). Documents store relative keys.

```
uploads/<jobId>/<safeName>                       raw browser uploads (signed PUT); deleted after a successful job
sources/<sha256>/<safeName>                      the original PDF or photo, kept
crops/<catalogue>/<itemId>.png                   the crop exactly as the extractor wrote it (its sha256 is items.sha256_hash)
thumbs/<catalogue>/<itemId>.jpg                  longest side 480 px, JPEG quality 82, metadata stripped, deterministic
bundles/<catalogue>/<jobId>/state.sqlite         checkpoint / audit copy of the compute state
imports/<catalogue>/<name>/state.sqlite          a finished bundle the owner uploaded (the notebook's work_dir as it is: state.sqlite[-wal/-shm] and crops/**);
imports/<catalogue>/<name>/crops/**.png          folder names may contain spaces; only state files and pictures (and, with --with-pdf, PDFs) are read
releases/<catalogue>/<releaseId>/manifest.json
releases/<catalogue>/<releaseId>/items.json
releases/<catalogue>/<releaseId>/pillars/<pillar>.npy        float16, shape (n, dim), C order, rows L2-normalised
releases/<catalogue>/<releaseId>/pillars/<pillar>.ids.json   JSON array of itemIds, length n, the row order of the .npy
```

### 4.3 Release (written by `publish`, read by the search service)
`manifest.json`:
```json
{ "schema": 1, "releaseId": "rel-…", "catalogue": "superbond-colour", "createdAt": 1793000000000, "parent": null, "jobId": "job-…",
  "nItems": 69,
  "featureVersions": { "dino": "…", "siglip": "…", "color": "…", "vertex_mm": "…", "text": "…" },
  "pillars": { "dino": { "count": 69, "dim": 3072, "dtype": "float16", "file": "pillars/dino.npy", "idsFile": "pillars/dino.ids.json",
                         "sha256": "<of the .npy bytes>", "idsSha256": "<of the ids bytes>" } },
  "itemsFile": "items.json", "itemsSha256": "…", "package": { "name": "terucon_catalogue", "version": "0.1.0" } }
```
A pillar that has no vectors is simply absent from `pillars` and `featureVersions`. A pillar's `ids` may be shorter than `nItems` (an item can lack one pillar; the
notebook ranks such items last for that signal). `items.json` is an array sorted by `itemId` of
`{ "itemId", "productId": null|string, "page": int, "pdfSha256", "category": null|string, "finish": null|string, "dominantHex": [..], "proportions": [..] }`
(the columns the notebook's retrieval filters and de-duplicates on). Readers verify every sha256 before use and fail with a clear message.
A new release is built from its parent: items are keyed by `itemId` (the bundle's win), pillars are merged by `itemId`; **if the bundle's feature versions differ from
the parent's the publish refuses** (a catalogue never mixes vector versions).

### 4.4 MongoDB (collection names are prefixed `terucon_`; the website and the Python package use the same ones)
```
terucon_catalogues        { _id: catalogueId, name, kind: "materials"|"paint"|"exterior"|"other", note: string|null, createdAt, updatedAt,
                            activeRelease: releaseId|null, previousRelease: releaseId|null,
                            featureVersions: {…}|null, counts: { items: int, hidden: int } }   // items = ALL items of the live release, hidden = how many of them are hidden: the website shows items - hidden (fixed 2026-11-04: the publisher had written items = visible only, so a hidden item was subtracted twice)
terucon_catalogue_items   { _id: "<cat>|<itemId>", catalogue, itemId, status: "ok"|"hidden",
                            label: string|null,                                   // admin-set display name
                            productId: string|null, productIdSource: "pdf-text"|"admin"|null,
                            subtype: string|null, category: string|null, finish: string|null,    // from the Gemini profile (AI-written)
                            description: { grain, patternScale, colour, specular, feel, keywords: [..] }|null,
                            dominantHex: [..], proportions: [..],
                            captionModel: string|null, captionVersion: string|null,
                            source: { name, sha256, page, itemIndex, bbox: [4], idBbox: [4]|null, pageWidth, pageHeight, rotation,
                                      method, matchType, matchRelation, matchCost, inpainted: bool, pdfProductId: string|null },
                            images: { crop: { key, width, height, sha256, bytes }, thumb: { key, width, height, bytes } },
                            attributes: { },                                      // admin free-form (string/number/bool/null values); nothing reads it yet
                            shopImage: { key, width, height, bytes, sha256, uploadedAt }|absent,   // the 800 px picture of the design: bucket cards/<cat>/<itemId>.jpg (2026-11-04,
                                                                                  //   tools/publish-shop-images.js). OWNED BY THE WEBSITE: not in PUBLISHER_OWNED, so a re-ingest keeps it
                            studio: { look, colours: [..], pattern, grain, scale, sheen, relief, render, model, generatedAt, basis: "photo" }|absent,
                                                                                  // what Gemini SAW in the picture (appearance only; tools/describe-designs.js). Also website-owned.
                                                                                  // Read by server/catalogue/designs.js; see docs/CATALOGUE_STUDIO.md
                            releaseFirst: releaseId, jobId: string|null, createdAt, updatedAt }
terucon_catalogue_releases { _id: releaseId, catalogue, createdAt, createdBy: "ingest"|"cli"|"import", jobId: string|null, parent: releaseId|null,
                            nItems, featureVersions: {…}, pillars: { name: { count, dim } }, gcsPrefix: "releases/<cat>/<id>/", manifestSha256 }
terucon_catalogue_jobs    { _id: jobId, catalogue, kind: "pdf"|"photos", status: "draft"|"queued"|"running"|"succeeded"|"failed"|"cancelled",
                            stage: "waiting"|"fetch"|"extract"|"features"|"vertex_mm"|"captions"|"text_vectors"|"publish"|"release"|"done",
                            progress: { done, total, message }, sources: [ { key, name, bytes, sha256: string|null, kind: "pdf"|"image" } ],
                            options: { segmentPhotos: bool, captions: bool, activate: bool },
                            createdAt, startedAt, heartbeatAt, finishedAt, error: string|null, cancelRequested: bool, modalCallId: string|null,
                            log: [ { t, level: "info"|"warn"|"error", msg } ]  /* newest last, at most 200 */,
                            result: { items, pages, failedPages: [ { page, error } ], unmatchedIds: int, newItems, releaseId, warnings: [..] }|null }
```
Indexes: items `{catalogue, status}`, items `{catalogue, productId}` (partial: string), jobs `{status, createdAt}`, releases `{catalogue, createdAt}`.
**Title shown to a client** (computed when read, never stored): `label` → else `subtype` (marked "AI description") → else `Catalogue page <n>`.
**Product identity is nullable everywhere** (the real catalogue has none yet); `productId` comes only from the PDF's text layer or from an admin. Nothing here ever invents one.

### 4.5 One job at a time
A job may only start when no other job is `queued`/`running` (a job whose `heartbeatAt` is older than 10 minutes counts as dead). The Modal ingest function has `max_containers=1`.
Starting the same job again after a failure **resumes** it (restore `bundles/…/state.sqlite`, mark every page pending, re-extract: the notebook's `commit_page_result` keeps the
embeddings and captions of any item whose crop bytes did not change, so paid work is not repeated).

## 5. Search semantics (Python `search.py`, port of notebook cell 6)
* Signals and groups are the notebook's: `dino_image`→dino, `siglip_image`→mm, `color_image`→color, `vertex_mm_image`→mm, `text_from_photo`→text, `siglip_text`→mm, `text_query`→text, `vertex_mm_text`→mm.
  Group weights: photo `DEFAULT_PHOTO_WEIGHTS`, text `DEFAULT_TEXT_WEIGHTS`, renormalised over the signals that exist. Fusion `hybrid` (RRF + linear), `rrf_k` 60, lambda 0.5.
* **Exact search at any size** (every item scored; the notebook did the same below 50,000 items and used FAISS only above). No FAISS dependency.
* `profile` (photo queries): `fast` (default; dino + siglip + colour; **the only configuration with a measurement**), `balanced` (+ Vertex image embedding), `full` (+ Gemini description of the
  query photo and its embedding: seconds and money per query). Text queries use every text signal that is available; `profile` is ignored for them.
* `mode`: `look` (default) or `colour` (`weights = {"color": 1.0}`, colour signal only, no Vertex, no description).
* **Region ("point to find")**: `point=x,y` (0..1, relative to the sent image) with optional `radius` (default 0.12 = a square of 24 % of the shorter side centred on the point, clipped to the image) or `box=x0,y0,x1,y1`.
  A region query skips the notebook's card detection and 80 % centre crop (`preprocessing: "region"`). **This is new and unmeasured.**
* Without a region the notebook's preprocessing runs unchanged: card/sample quadrilateral → perspective-rectified, else 80 % centre crop; horizontal-flip TTA on.
* Filters: `category`, `finish` (comma lists) on `items.json`. De-duplication by `productId` as in the notebook (items with no productId are never merged: duplicates stay duplicates).
* The response carries raw per-signal cosine `sim` and `rank` next to the relative `finalScore`. No percentage is ever derived from `finalScore`.

## 6. HTTP between the website (Express) and Modal

Both apps authenticate with `Authorization: Bearer <key>` (a key in the Modal secret `terucon-catalogue-keys`, `API_KEYS=k1,k2`, compared in constant time; optional Modal proxy auth
headers `Modal-Key` / `Modal-Secret`). Errors are JSON `{"error": {"code": <http>, "status": "INVALID_ARGUMENT"|…, "message": "…", "reason": "<slug>"}}` with `Retry-After` on 429/503.

**Search app** (label `terucon-catalogue-search`; GPU class; models loaded once per container):
```
GET  /healthz                      -> { ok, ready, device, loadedReleases: [..], expectedFeatureVersions: {..}, containerAgeS }       (wakes the container)
POST /v1/search                    raw image bytes (Content-Type image/jpeg|image/png|image/webp, at most 8 MB)
     ?catalogue=<id>&release=<releaseId>&mode=look|colour&profile=fast|balanced|full&k=1..60
     &point=x,y&radius=0.12 | &box=x0,y0,x1,y1  &category=a,b &finish=a,b
POST /v1/search-text               { catalogue, release, text (<=300 chars), k, category?, finish? }
200 -> { ok: true, catalogue, release, mode, profile,
         query: { preprocessing: "perspective_rectified"|"center_crop"|"region"|"text", dominantHex: [..], signals: [names], weights: { name: w }, timingsMs: { prepare, encode, vertex, describe, fuse, total }, warnings: [..] },
         results: [ { rank, itemId, finalScore, rrfScore, linearScore, signals: { "<signalName>": { sim: number|null, rank: int } } } ] }
```
The service loads `release` on first use (GCS → `/cache`, sha256 verified, feature versions checked against its own encoder: a mismatch is `409 reason: "feature-version-mismatch"`; a release
missing from GCS is `409 reason: "release-missing"`; a photo that cannot be decoded `400 reason: "bad-image"`; the GPU queue full `503 reason: "busy"`). It never talks to MongoDB and never stores a query photo.

**Ingest app** (label `terucon-catalogue-ingest`; CPU only, cheap; the GPU work is a separate Modal function it spawns):
```
GET  /healthz                      -> { ok, version }
POST /v1/ingest        { jobId }   -> 202 { ok: true, callId }       (reads the job document from MongoDB, runs fetch → compute → publish; writes progress to the job)
POST /v1/ingest/cancel { jobId }   -> { ok: true }                    (sets cancelRequested; the job stops at the next safe point)
```

## 7. HTTP between the browser and the website

All routes need a signed-in, finished account (same rule as `/api/inspiration/*`: `ctx.auth.required()` / `resolve(req)` / `profileComplete`), unless sign-in is switched off for the site. Admin routes need
`Authorization: Bearer <AUTH_ADMIN_TOKEN>` exactly like `/api/auth/admin/*` (same limiter for wrong tokens; **404 when no token is configured**).
JSON bodies use `application/json` and the usual Origin rule; the one exception is `POST /api/catalogue/search`, whose body is raw image bytes (guards.js exempts exactly that path from the JSON rule, nothing else).

```
GET  /api/catalogue/status                                  -> { enabled, ready, reasons: ["off"|"modal-not-configured"|"database-unavailable"|"no-live-catalogue"], default: id|null,
                                                                 catalogues: [ { id, name, kind, items } ] (live ones only), limits: { maxPhotoBytes, maxSide: 1024 }, profile }
POST /api/catalogue/warm                                    -> 202 { ok: true }     wakes the search container; fire and forget; limited per account
POST /api/catalogue/search?catalogue=&mode=&k=&point=&radius=&box=&category=&finish=   body: image bytes
POST /api/catalogue/search-text                             { text, catalogue?, k?, category?, finish? }
   200 -> { ok: true, catalogue, release, mode, items: [ResultItem], query: { preprocessing, dominantHex, profile, signals: [..], timingsMs: { total } }, warnings: [..] }

ResultItem = { rank, itemId, catalogue, title, titleSource: "label"|"caption"|"page", productId: null|string, productIdSource: null|"pdf-text"|"admin",
               category, finish, subtype, dominantHex: [..], source: { name, page },
               image: { thumbUrl, fullUrl, width, height },              // signed GCS GET URLs, valid 1 hour; width/height are the crop's
               scores: { final, signals: { "<name>": { sim, rank } } },   // `final` is relative: never show it as a percentage
               attributes: { } }
```
Error `reason` slugs: `catalogue-off`, `not-ready`, `no-live-catalogue`, `too-large`, `bad-image`, `bad-request`, `rate-limited`, `busy`, `warming` (Modal still starting: the browser retries after `Retry-After`),
`modal-unavailable`, `modal-timeout`, `release-missing`, `feature-version-mismatch`, `unauthorized`.

Admin (Bearer admin token):
```
GET   /api/catalogue/admin/overview                         -> { catalogues: [ { …doc, live: bool } ], jobs: [ last 20 ], configured: { modal, gcs, database } }   (does not call Modal)
POST  /api/catalogue/admin/check                            -> { database, gcsSigning, modalSearch, modalIngest }     (pings both Modal apps: this WAKES them and is billed like any start)
POST  /api/catalogue/admin/catalogues                       { id, name, kind, note? }
POST  /api/catalogue/admin/uploads                          { catalogue, kind: "pdf"|"photos", options?, files: [ { name, size, type } ] }
        -> { jobId, expiresAt, uploads: [ { name, key, url, method: "PUT", headers: { "Content-Type": …, "x-goog-content-length-range": "0,<max>" } } ] }   job is created as `draft`
POST  /api/catalogue/admin/jobs                             { jobId }                      starts it (queued -> Modal /v1/ingest); 409 while another job runs
GET   /api/catalogue/admin/jobs  |  /jobs/:id               the job document(s), newest first / one
POST  /api/catalogue/admin/jobs/:id/cancel
GET   /api/catalogue/admin/catalogues/:id/items?status=ok|hidden&q=&limit=&after=       -> { items: [ {…doc, thumbUrl} ], next }
PATCH /api/catalogue/admin/catalogues/:id/items/:itemId     { label?, productId?, status?, attributes? }       validated; sets productIdSource "admin"
GET   /api/catalogue/admin/catalogues/:id/releases
POST  /api/catalogue/admin/catalogues/:id/releases/:releaseId/activate      (checks the release exists and has pillars; remembers the previous one for rollback)
```
Limits are **starting values chosen here, not measured**: search 60 / hour / account, text 120, warm 30, at most 6 searches in flight at once (more get `503 busy` + `Retry-After`), query photo at most 6 MB
(the browser sends about 100–400 KB), PDF at most 300 MB, photos at most 25 MB each and 200 per job. The per-account limits are admin-managed settings (`catalogue.*` in `server/auth/settings.js`), like `studio.limit.*`.
The browser downsizes every query photo to at most 1024 px on the long side, applies its EXIF orientation and re-encodes it as JPEG (this also drops GPS and other metadata); the encoders never use more than that.

## 8. Environment

The step-by-step set-up (bucket, CORS, two service accounts, MongoDB, Modal secrets, deploy, the website's `.env`) is `../docs/CATALOGUE_SETUP.md`; the website's variables are
`.env.example` section 8. Two traps worth repeating here: `MONGODB_DB` in the Modal secret **wins over** a database named in the URI and must be the database the
website's (the studio's) MongoDB connection uses; and `sentencepiece` is a runtime dependency (the SigLIP tokenizer), declared in `requirements.txt` and the image.

**Website `.env`** (all optional; with none of them the feature is off and the shop keeps its colour demo):
`CATALOGUE` (`on`|`off`, default `on`), `CATALOGUE_MODAL_SEARCH_URL`, `CATALOGUE_MODAL_INGEST_URL`, `CATALOGUE_MODAL_KEY`, `CATALOGUE_MODAL_PROXY_KEY`, `CATALOGUE_MODAL_PROXY_SECRET`,
`CATALOGUE_MODAL_TIMEOUT_MS` (60000: a cold start takes tens of seconds), `CATALOGUE_GCS_BUCKET`, `CATALOGUE_GCS_PREFIX` (`catalogue/`), `CATALOGUE_GCS_KEY_JSON` (the text of a service-account JSON key, used **only to sign URLs**: single-quoted in `.env`, or base64; `CATALOGUE_GCS_KEY_FILE`, a path to such a file, is the alternative and loses if both are set; use a
separate, least-privilege account: object read + create on the one bucket), `CATALOGUE_SEARCH_PROFILE` (`fast`).
**Python / Modal**: `MONGODB_URI` (+ `MONGODB_DB` when the URI has no database), `CATALOGUE_GCS_BUCKET`, `CATALOGUE_GCS_PREFIX`, `GCP_SERVICE_ACCOUNT_JSON` (or `GOOGLE_APPLICATION_CREDENTIALS`), `CATALOGUE_CACHE_DIR`,
`CATALOGUE_SEARCH_PROFILE`, plus the operational overrides in `config.load_config`. Modal secrets: `terucon-catalogue-keys` (`API_KEYS`), `terucon-catalogue-gcp` (`GCP_SERVICE_ACCOUNT_JSON`, `CATALOGUE_GCS_BUCKET`, `CATALOGUE_GCS_PREFIX`),
`terucon-catalogue-mongo` (`MONGODB_URI`, `MONGODB_DB`). The Modal service account needs read/write on the bucket and (as in the notebook) "Vertex AI User".

## 9. The Python package (`catalogue/terucon_catalogue/`, Python >= 3.11, **no import-time side effects**)

| Module | Owner | What |
|---|---|---|
| `util.py` `schema.py` `config.py` `state.py` `credentials.py` | **done** (verbatim from the notebook, parity-tested) | helpers, prompts + `MaterialProfile`, `PipelineConfig` + feature versions + `check_feature_versions`, `StateStore`, service-account loading. **Do not edit; report a needed change.** |
| `extract.py` `photos.py` `features.py` `encoders.py` `vertex.py` `captions.py` `pipeline.py` | **PY-A compute** | cell 3, cell 4, cell 2 `VertexGenAIManager`, cell 5, and `run_compute` |
| `search.py` `release_reader.py` `service.py` `http_app.py`, `../modal_app.py` | **PY-B search + Modal** | cell 6, the release reader, the service object, the FastAPI apps, the Modal definitions |
| `bucket_import.py` | **added 2026-11-01** | fetch a bundle from `imports/`, publish it, put the release on the volume (`fetch_bundle`, `run_bucket_import`, `seed_release_cache`, `seed_after_ingest`, `prime_volume`); logic only, `../modal_app.py` is the wiring; tested against fakes |
| `objectstore.py` `mongo.py` `bundle.py` `publish.py` `release_writer.py` `cli.py` `__main__.py`, `../requirements*.txt`, `../pyproject.toml` | **PY-C stores + publish + CLI** | GCS and local object stores, the MongoDB layer, bundle reading/validation, the publisher, the CLI |

Pinned interfaces (so the three owners can work at once; bodies are theirs):
```python
# pipeline.py (PY-A)
@dataclass class ComputeResult: work_dir: Path; pdfs: list[dict]; n_items: int; n_pages: int; failed_pages: list[dict]; unmatched: int; stages: dict; warnings: list[str]
def run_compute(cfg, *, pdfs: Sequence[Path], work_dir: Path, encoders=None, manager=None, progress=None, should_cancel=None,
                stages=("extract","features","vertex_mm","captions","text_vectors"), segment_photos: Iterable[Path] = ()) -> ComputeResult
#   progress(stage: str, done: int, total: int, message: str) -> None      should_cancel() -> bool (checked between batches; raise Cancelled)
# photos.py (PY-A):  wrap_photo_as_pdf(image_path, out_pdf) -> Path   (one page, the photo is the page's only image, bytes reproducible)

# objectstore.py (PY-C)  keys are relative (the store adds the prefix)
class ObjectStore(Protocol):
    def put_bytes(self, key, data: bytes, content_type=None, *, if_absent=False) -> bool
    def put_file(self, key, path, content_type=None, *, if_absent=False) -> bool
    def get_bytes(self, key) -> bytes;  def get_file(self, key, dest) -> Path;  def exists(self, key) -> bool;  def size(self, key) -> int | None
    def delete(self, key) -> None;  def list(self, prefix) -> list[str];  def signed_get_url(self, key, *, expires_s=3600) -> str
# classes: GcsObjectStore(bucket, prefix, service_account_info), LocalObjectStore(root, prefix)  (the fake used by every test)

# mongo.py (PY-C):  MongoCatalogueDb(uri, db_name=None)  and  MemoryCatalogueDb()  (same methods; the second is the test double)
#   get_catalogue / upsert_catalogue / set_active_release / upsert_items / count_items / get_job / update_job(id, fields) / append_job_log / insert_release / get_release / list_releases

# publish.py (PY-C)
@dataclass class PublishResult: release_id: str | None; n_items: int; n_new: int; activated: bool; warnings: list[str]; dry_run: bool
def publish_bundle(bundle_dir, *, catalogue: str, store, db, cfg, job_id=None, source_files: Mapping[str, Path] | None = None, activate=False, dry_run=False,
                   progress=None, created_by="ingest") -> PublishResult           # raises PublishError (with .problems) before writing anything when validation fails

# release_reader.py (PY-B)
class LoadedRelease: manifest: dict; items: list[dict]; pillars: dict[str, PillarMatrix]   # PillarMatrix(ids: list[str], matrix: np.ndarray float32 L2-normalised)
def load_release(store, catalogue, release_id, cache_dir, expected_versions: Mapping[str, str], cfg) -> LoadedRelease   # verifies sha256s and check_feature_versions
```
Rules for all Python code:
1. **Keep the notebook's algorithms verbatim.** Parametrise only what the foundation modules' `# PORT:` comments already list (Kaggle paths and secrets, the GPU count, pandas and parquet, FAISS, the renderer) plus what
   this file says is new. Anything else you change must be marked `# PORT:` with the reason and covered by a parity test against the notebook oracle (`tests/nb_oracle.py`), or explained in your report.
2. **No import-time side effects**: no pip, no logging configuration, no GPU/CUDA calls, no network, no reading of the environment at import. Heavy libraries (`torch`, `transformers`, `google.genai`, `pymongo`, `google.cloud.storage`)
   are imported inside the functions/classes that need them so that `import terucon_catalogue.<module>` is cheap and the publish path needs no torch.
3. **Verify, do not recall.** Library behaviour (PyMuPDF 2.0, transformers 5.16.1, google-genai 2.12.1, pymongo, google-cloud-storage, Modal 1.6.3) is checked against the installed packages
   (`inspect`, running a small example), not remembered.
4. **No real services.** Never read `.env`, `swatchroom/.env`, `swatchroom/keys/` or any credential, and never call real Modal / GCS / MongoDB / Vertex / Hugging Face. Tests use fakes. Do not download model weights.
   (`modal deploy`, real writes and weight downloads are for the owner; give the commands.)
5. Tests: `/private/tmp/claude-501/-Users-mayank-XTRA-terucon/6f65f536-a686-4326-a1d9-02402d305aee/scratchpad/venv312/bin/python -m pytest` run from `catalogue/` (Python 3.12 with the versions the notebook printed).
6. Report **Verified** (what ran, the command, the result) separately from **Not verified**. Do not claim what did not run.

## 10. What is deliberately not here
* The notebook's **Nano Banana renderer** (cell 7) is not ported: the request was retrieval. Say so if you want it.
* **No OCR / vision reading of the printed labels.** The code and name ARE in the picture, but reading them is new work with its own error rate; it is the owner's call (the admin can set a label and product code by hand).
* No prices (no price list exists), no paint palette (C7's palette does not exist), no studio integration (`swatchroom/` is never edited), no near-duplicate merging.
