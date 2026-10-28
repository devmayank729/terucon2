# Swatchroom 5 (Terucon edition)

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

## Folder layout

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

## What you need

- Node.js 20 or newer
- MongoDB 7 or newer (installed locally, or a free MongoDB Atlas cluster)
- Python 3.10 or newer. A GPU is optional: on a normal CPU a scan takes about 6 seconds and
  preparing a photo for Pick about 5 seconds (each tap after that is instant)
- A Google Cloud project with Vertex AI (see below)

## Setting up

### 1. Google Cloud key

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

### 2. Server (Node.js + Express + MongoDB)

```sh
npm install
cp .env.example .env        # then edit .env: MONGODB_URI, GOOGLE_APPLICATION_CREDENTIALS...
npm start                   # http://localhost:3000
```

### 3. Model service (Python)

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

### 4. Open it

- `http://localhost:3000/` the Terucon page with the studio inside
- `http://localhost:3000/studio` the studio on its own

Open **Settings → Check** once: it tests the Google key, every model, the Python service and
MongoDB, and says in plain words what is missing.

## Putting it online

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

## Admin dashboard

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

## The Terucon page

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

## How a render travels

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

## API

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

## Models

| Job | Model | Falls back to |
| --- | --- | --- |
| Render the finish | `gemini-3.1-flash-image` | `gemini-3.1-flash-lite-image` |
| Outlines, names, measurements | `gemini-3.8-flash` | 3.7, 3.6, 3, 3.5 Flash |
| Find surfaces | SegFormer-B5 (INT8 where fast) in the Python service, raced against OneFormer (Swin-L, ADE20K) on Modal | Gemini outlines |
| Pick tool | SlimSAM-50, in the Python service | |

`gemini-2.5-flash` is only used by the optional "Pixel masks" detection settings; Google
retired it on Vertex AI on 20 October 2026, so the default is "Outlines".

## Tests

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
