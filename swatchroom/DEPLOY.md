# Deploying Swatchroom on Render

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

## What you need before you start

- This repo pushed to GitHub or GitLab.
- A MongoDB Atlas cluster (the free M0 tier works) and its connection string. **Atlas blocks all
  connections by default** - under Network Access, add `0.0.0.0/0`, or get `swatchroom`'s actual
  outbound IP ranges from its service page's **Connect > Outbound** tab in Render and allow only
  those.
- A Google Cloud service-account key with Vertex AI access, as a JSON file (see the README's
  "Google Cloud key" section for how to create one).

## 1. Create the Blueprint

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

## 2. If you skipped anything in step 1

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

## 3. Build & start commands (already in `render.yaml`, for reference)

**swatchroom** (Node)
- Build: `npm install`
- Start: `npm start`
- Health check: `/api/session`

**swatchroom-models** (Python, root dir `python/`)
- Build: `pip install --upgrade pip && pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu && pip install -r requirements.txt`
- Start: `uvicorn app:app --host 0.0.0.0 --port $PORT`
- Health check: `/health`

## 4. Verify it actually works

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

## Troubleshooting

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

## Skipping the model service

The scene scan engine falls back to Gemini automatically if the model service is unreachable
(`fallbackToGemini` defaults to on in Settings) - but the **Pick tool has no fallback**; it
always needs SlimSAM via the model service and simply won't work without it.

If that trade-off is fine, drop to Starter's $7/mo alone:
1. In `render.yaml`, delete the `swatchroom-models` service block and the
   `MODEL_SERVICE_URL`/`MODEL_SERVICE_KEY` `fromService` entries under `swatchroom`, then push.
2. In the Render Dashboard, manually delete the now-unmanaged `swatchroom-models` service too -
   removing it from `render.yaml` does **not** delete it or stop billing for it; Render only
   stops managing it and will recreate it on the next sync if you don't delete it yourself.

## Modal GPUs: one pool, cold starts and the owner's dot

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

## Notes

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
