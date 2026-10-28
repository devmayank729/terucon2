# Terucon site, Materials shop, My project and the Design Studio (Swatchroom)

Four pages that work as one site, an **Express** server that runs them, and the **Design Studio** ("Swatchroom 5") mounted in the same server.

| Part | Language | Where |
|---|---|---|
| The website: pages, shop, API, guards, tests, build tooling | JavaScript (Express 5) | `app.js`, `server/`, `tools/`, `tests/` |
| The pages as data: routes, links between pages, every patch made to the Claude Design exports | JSON | `site/` |
| The Design Studio: its routes and libraries, the browser code, the local scan models, the GPU blueprint | JavaScript, Python | `swatchroom/` (copied in unchanged; see its own `README.md`) |

| Page | Address when the server is running | Built from |
|---|---|---|
| Terucon website (landing page) | `/` | `pages_original/index.html` |
| Materials shop | `/materials` | `pages_original/market_place.html` |
| Design Studio ("Swatchroom") | `/design-studio` (also `/studio`, `/swatchroom`) | `swatchroom/terucon/Swatchroom.html` |
| My project (client dashboard) | `/my-project` | `pages_original/dashboard.html` |
| Project overview (what every part does, live status) | `/project-overview` | `docs/PROJECT_OVERVIEW.html` |
| Coming soon | `/coming-soon`, and any address that is no page | `pages/coming-soon.html` (written by hand) |

---

## How a visitor moves through the site

```
Landing page  /
  │  hero: [Start a project]  [Try it with your photo →]  [See the work]      (all of it also on a phone)
  │  the moment it opens, the website wakes the studio's GPU services (section "Cold start")
  │
  ├─► Design Studio  /design-studio   splash → (passcode) → add a room photo → tap a surface → pick a finish → render
  │       header, menu and footer lead on to: Materials · My project · Start a project (/#enquire) · the logo (/)
  ├─► Materials  /materials            shop, saved, cart, checkout (a demo)  ─ and on to the Design Studio, My project, home
  ├─► My project  /my-project          the client dashboard (a prototype)    ─ and on to Materials, the Design Studio, home
  └─► Start a project  /#enquire       the enquiry form on the landing page; afterwards "Try the Design Studio meanwhile"

An address that is no page (/careers, /about ...)  →  Coming soon (answered 404), with buttons to the Design Studio, Materials and home.
```

Every link is checked: `npm run check:links` (every same-site link in every page and the connections `site/site.json` requires) and the browser tests click through the whole path (`npm test -- --e2e`).

---

## Quick start

```bash
npm install                      # once: the website AND the Design Studio (they are one npm workspace)
cp .env.example .env             # optional: the website's own settings (port, ...)
npm start                        # builds any missing page, then serves http://localhost:8080
```

The Design Studio reads **its own** settings file, `swatchroom/.env` (copy `swatchroom/.env.example`): the database, the Google key, the GPU services and the studio passcode are there. The website's `.env` only holds where it listens and `STUDIO_WARMUP`.

The banner in the terminal says what is running:

```
Terucon server
  Site:              http://localhost:8080/
  Design Studio:     http://localhost:8080/design-studio  (Swatchroom, mounted from swatchroom/)
  Studio admin:      http://localhost:8080/admin
  Scan models:       start the local ones with "npm run models" in a second terminal (README, "The scan models")
  Project overview:  http://localhost:8080/project-overview
  Settings file:     /…/.env  (found)
  Studio settings:   /…/swatchroom/.env  (found)
  Cold start: the landing page and the studio page wake the studio's GPU services (STUDIO_WARMUP=off to stop)
  Press Ctrl+C to stop.
```

Open the pages through the server, not by double-clicking them: the links between pages are server addresses. The site listens on port **8080** (`PORT` in `.env`), not on the studio's old 3000, and, like the website always did, only on this computer (`HOST=127.0.0.1`).

---

## The Design Studio (Swatchroom)

*Photograph a room, tap a wall, floor, ceiling or piece of furniture, pick a finish, and Gemini renders that finish into the real photo. Only the chosen surface changes.* (`swatchroom/README.md` is the full description, `swatchroom/ARCHITECTURE.md` and `swatchroom/swatchflow.md` explain how it works.)

**How it is attached.** `swatchroom/` is the Swatchroom project copied in exactly as it was built (nothing in it was edited). The website

* loads its Express app into the same process (`server/lib/swatchroom.js`) and mounts it after the website's own routes, so `/`, `/materials` and the other pages stay the website's and the studio keeps its own `/api/*`, `/js`, `/css`, `/fonts`, `/textures` and `/admin`;
* does what the studio's own `start()` does for a process of its own: connects MongoDB (and keeps trying), marks pipeline jobs that a restart cut short as failed, and prints the model set-up;
* builds the page **around** the studio from the studio's own Claude Design export, `swatchroom/terucon/Swatchroom.html`, with the site's links added by `site/patches/studio.json`. The studio inside that page is the studio's own code, loaded from `/js/swatchroom-app.js`; the build leaves it alone;
* lets the studio's photo and render uploads (raw image bytes) through the website's JSON-only API guard, and keeps its cross-origin check (`server/middleware/guards.js`);
* reads the studio's settings from `swatchroom/.env` into the process environment when the studio loads, and takes the website's own view of the environment **before** that, so the studio's `PORT`, `HOST`, ... can never become the website's.

**What the studio needs** (all in `swatchroom/.env`; `swatchroom/.env.example` documents every line):

| Needs | For | Without it |
|---|---|---|
| MongoDB (`MONGODB_URI`, Atlas or local) | saving rooms, photos and renders | the studio opens, but rooms cannot be saved |
| A Google service-account key with Vertex AI (`GOOGLE_APPLICATION_CREDENTIALS`, key in `swatchroom/keys/`) | the renders and Gemini's outlines | the studio shows "AI off" |
| The Modal GPU services (`ONEFORMER_URL`, `ANALYZE_URL`, ... and their keys) | the HD scan and the room analysis | the scan runs on the local model only; the room analysis is mocked |
| The local scan models (Python, below) | the local scan, the Pick tool | scans use Gemini outlines only; the Pick tool does not work |
| `STUDIO_PASSCODE` | keeping the studio (and your Google bill) closed | anyone who can open the page can use the studio |

**The passcode.** With `STUDIO_PASSCODE` set, a first-time visitor meets a "Sign in to the studio" screen after the splash. The landing page invites everybody to "Try it with your photo", so decide on purpose: share the passcode with the people who should use it, or leave `STUDIO_PASSCODE` out of `swatchroom/.env` to open the studio to everyone (anyone can then spend your Google project and Modal GPUs).

**The owner's dashboard** is `/admin` (its own sign-in: `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `swatchroom/.env`; when they are unset the studio uses `admin@terucon.in` / `admin@123`, so set them before the site is online). It shows who is live, the generations and scans, the status of every service and the cold start of each GPU service.

### Cold start: the landing page wakes the GPUs

The studio's GPU services (on Modal) scale to zero when nobody uses them, and a sleeping one needs **10–45 s** to wake (the studio's own estimate; its audit measured 9–24 s for a normal restore, `swatchroom/swatchflow.md` Part 6). The studio, on its own, wakes them only when a photo is scanned. This website starts them earlier:

1. The landing page and the studio page send `POST /api/studio/warmup` the moment they open (a script in the page head, `site/patches/snippets/warmup.js`; about 100 ms after the navigation starts, at most once a minute per browser tab). It sends nothing on the other pages.
2. The server starts the **scan** service (OneFormer) and the **room-analysis** service(s) using the studio's own wake-up code, so the studio's record of what is warm is the one the start-up check reads. A service that is already warm or already starting is skipped, so repeat visits cost nothing.
3. It answers at once; the wake-up goes on in the server whether or not the visitor stays. The studio's start-up check then finds the services starting ("waking") or warm, and the scan uses them.

This route is the website's own, not behind the studio's passcode, so a visitor who has not signed in yet wakes the services too.

**What it costs.** A started service is billed until it has been idle for about five minutes (`SCALEDOWN_S` in `swatchroom/modalBlueprint.py`), even for a visitor who never uploads a photo. The studio's authors left this out of their own design for that reason (`swatchroom/DEPLOY.md`, "Nothing wakes a GPU because a page opened"); here it is on purpose. Bots and crawlers that run the page's script count as visitors, and because the route has to work for people who have not signed in, anyone who calls it every few minutes can keep the services awake: what it costs is bounded by the services' idle time, not by how often it is called, and it needs a spending limit on the Modal side to be capped. `STUDIO_WARMUP=off` in `.env` restores the studio's own behaviour (wake on scan) without any other change.

### The scan models (local Python)

The studio's local scan (SegFormer-B5) and its Pick tool (SlimSAM) are a small Python service that `npm start` does **not** start. Once:

```bash
cd swatchroom/python
python3 -m venv .venv && source .venv/bin/activate
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu    # CPU build; with an NVIDIA GPU install the CUDA build instead
pip install -r requirements.txt
```

Then, in a second terminal with that environment active, from the project folder: `npm run models` (it runs `uvicorn app:app --host 127.0.0.1 --port 8001`, where `MODEL_SERVICE_URL` in `swatchroom/.env` points). The models download from Hugging Face on first use (about 340 MB for SegFormer-B5, about 100 MB for SlimSAM). Without the service the studio still scans (Gemini outlines, and OneFormer when configured); the Pick tool needs it. Settings → Check inside the studio tests the Google key, every model, this service and MongoDB.

---

## Settings

| File | Holds |
|---|---|
| `.env` (from `.env.example`) | `HOST`, `PORT`, `ALLOWED_HOSTS`, `STUDIO_WARMUP`. Re-read when it changes; only `HOST` and `PORT` need a restart. A variable set in your terminal wins over the file. `TERUCON_ENV_FILE` points at another file (the tests use it). |
| `swatchroom/.env` (from `swatchroom/.env.example`) | everything of the Design Studio (above). Read when the server starts. |

Both are git-ignored and never served; keep them (and `swatchroom/keys/`) out of chat, issues and commits.

---

## The pages as JSON, and how they connect

* **`site/site.json` is the site.** Per page: its route, the export it is built from, the built file, aliases (`/index.html`, `/Terucon Swatchroom.html`, `/studio`, `/swatchroom`, … redirect permanently to the route), per-page response headers, and a `connections` matrix: which pages each page must link to. The old design-time names (`Design Studio.dc.html`, `Terucon Home v2.html`, …) redirect to the right page. A name that differs only by capitals or a trailing slash (`/Materials`, `/materials/`) redirects to the page too. The Express server, the page build, the link checker and the project overview all read this one file. Its `docs` section holds the pages that are not built from an export: the project overview and the Coming soon page.
* **Every change made to the Claude Design exports is JSON, not code.** `site/patches/<page>.json` is an ordered list of anchored steps (relink, insert after / before, replace once, replace all, edit an asset); `site/components.json` holds the shared HTML snippets (header link, menu card, footer link, the hero button); the injected JavaScript is kept as real files in `site/patches/snippets/`. Every anchor must match exactly once or the build fails loudly, naming the page and the step. Format: `site/patches/README.md`.
* **Links between pages are routes** (`/materials`, `/design-studio`, `/my-project`, `/`). Added entry points: *Materials* and *My project* on the website; *My project* on the shop and the studio; *Try it with your photo* in the landing page's hero.
* **A page that does not exist yet** shows `pages/coming-soon.html` with a 404 status (browsers asking for HTML at an address with no file extension; files, `/api` and `/media` keep a plain 404). To point a button at something that is still being built, link it to `/coming-soon`.
* Two dead "Media brief" links (a design-review pill pointing at files that were never exported) are switched off with the page's own `mediaGuides` setting.
* Saved items and the cart live in `localStorage`, so they are shared across pages **when served from one address**.
* **The pristine exports** are in `pages_original/` (and the studio's in `swatchroom/terucon/`). `npm run build:site` rebuilds `pages/` from them. If you export a page again from Claude Design, drop it into `pages_original/` under the same name and run it again; it fails loudly if the page changed in a way the patches cannot follow. For the studio page, re-export it with the studio's own script (`npm run terucon-page -w swatchroom -- /absolute/path/to/export.html`; it runs inside `swatchroom/`) and rebuild. `npm run check:site` tests without writing.

The dashboard is still a front-end prototype with a demo project ("Rao Dental Studio"); it links to everything, but it does not yet receive data from the shop or the studio.

---

## Layout

```
app.js                       the Express server: `npm start` (createApp / startServer are exported for tests)
server/                      config/ (.env, settings), lib/ (site map, errors, logging, the Design Studio loader),
                             middleware/ (guards, headers), routes/ (pages and Coming soon, media, api, docs, the studio wake-up)
site/                        site.json (the site map), components.json, patches/ (one JSON file per page + snippets/)
pages_original/              the three pristine Claude Design exports (landing page, shop, dashboard)
pages/                       the four built pages (generated by tools/build-site.js) and coming-soon.html (by hand)
media/                       photos and videos used by the website (the only files /media/ will serve)
swatchroom/                  the Design Studio, copied in unchanged: server/ (routes, libraries), public/ (browser code, fonts, textures),
                             python/ (local scan models), modalBlueprint.py (GPU services), terucon/Swatchroom.html (its page export),
                             its own tests, README.md, ARCHITECTURE.md, DEPLOY.md
tools/                       build-site.js, bundle.js, check-links.js, build-overview.js, run-tests.js
tests/                       js/ (node:test), e2e/ (Chrome), dev/ (the whole site on throw-away settings), helpers/, fixtures/
docs/                        HOW_TO_RUN.md (short run guide) and PROJECT_OVERVIEW.html (generated map of the project)
.env  .env.example           the website's settings / the documented template
```

## Tests

```bash
npm test                          # site build check, link check, overview check, JavaScript tests (about a minute; no credentials, no GPU, no database)
npm test -- --e2e                 # + Chrome: the whole path with real clicks (desktop and phone), the cold start, the studio's start-up and sign-in
npm run test:js                   # only the website's JavaScript tests
npm run test:swatchroom           # the Design Studio's own unit tests (they never call Modal, Google or a database)
```

The browser tests need their one dependency once: `cd tests/e2e && npm install`. `node tests/dev/stack.mjs --port 8765 --passcode letmein` runs the whole site on throw-away settings (the real code, the studio mounted, mock GPU services, no database and no Google key) so the flow can be tried without credentials; it copies the code into a temp folder, so it can never read your `.env` files or reach your services.

## Troubleshooting

| You see | Do |
|---|---|
| "Could not start on port 8080" | Change `PORT` in `.env`. |
| `Cannot find module 'mongoose'` (or another package) | `npm install` in the project folder: the Design Studio's packages are installed with the website's. |
| The banner says `Studio settings: … NOT FOUND` | Copy `swatchroom/.env.example` to `swatchroom/.env` and fill it in. |
| `/design-studio` asks for a passcode | `STUDIO_PASSCODE` is set in `swatchroom/.env` (see "The passcode" above). |
| The studio says **AI off** | No Google key: `GOOGLE_APPLICATION_CREDENTIALS` (or `GOOGLE_SERVICE_ACCOUNT_JSON`) in `swatchroom/.env`. Settings → Check in the studio says what is missing. |
| The terminal says `MongoDB is not reachable … Retrying` | `MONGODB_URI` in `swatchroom/.env`. With Atlas, allow this machine's address under Network Access. The studio opens meanwhile but cannot save rooms. |
| `studio  Scan model service at http://127.0.0.1:8001: it is not running` | Start the local models: "The scan models" above. |
| The first scan after a quiet spell is slow | A GPU service was asleep (10–45 s). Check `STUDIO_WARMUP` (default on) and the cold-start dot (sign in at `/admin`, then open the studio). |
| `421 Unexpected Host header` | You opened the site by an address the server does not know. Use `localhost` or add the name to `ALLOWED_HOSTS`. |
| The site does not open from a phone on the same Wi-Fi | The studio on its own listened on every address; the site listens only on this computer. Set `HOST=0.0.0.0` in `.env` and restart, then open `http://<this computer's address>:8080`. Anyone on that network can then open the site, and the studio is protected only by its passcode. |
| `npm run build:site` fails with "matched 0 times" | A re-exported page changed; update that step in `site/patches/<page>.json`. |
| The aluminium support frame on My project has no photo | That page asks for `media/materials/fx-mill.jpg`, which was never exported. Add the file to `media/materials/`. |

## Known gaps (found by clicking every button)

Every button and link of the four pages was activated in Chrome, on a desktop and a phone screen (about 600 elements, with the shop's and the dashboard's own sub-pages): every one that navigates reaches a real page (none ends at a 404 or at Coming soon), and none is dead; the controls that seem to do nothing are the option that is already selected, a native file picker ("Take a photo"), or a drag-only slider. What is left is not about wiring:

* **The enquiry form sends nothing.** "Start a project" (the header pill, the hero, the footer circle, the menu) leads to the form at the end of the landing page. Filling it in and pressing "Send enquiry" shows "Enquiry received… a project lead will call you within one working day", but the page makes **no request at all** (checked: no network call, no form action), so the enquiry is lost. It needs a destination of your choosing (an email address, a CRM, WhatsApp); nothing was invented here.
* **Placeholders from the exports**: the phone number `+91 00000 00000` (the "Call us", "Call Rohan" and footer links), the WhatsApp number `910000000000` ("Message us", "WhatsApp"), and the footer's LinkedIn and Instagram links, which point at those sites' front pages.
* **The dashboard reaches the Design Studio from one place**: its "My design" view. Every dashboard view links to the website and the shop. The link there used to read "Open the full design studio (for advanced users)"; it now reads "Open the Design Studio".

## What could not be verified here

* **No real service was called.** The cold start, the guards, the uploads and the studio's start-up were tested with the studio's own code against mock GPU services, with no database, no Google key and no local model service. The real Modal pools were not woken, the real MongoDB was not connected and nothing was rendered at Google. The first real run is the real test: open the landing page, then the studio, and read the terminal and `/admin`.
* **The local Python models were not run** from their new location (no virtual environment exists there; yours was not copied, it cannot be moved). The studio's own Python tests are skipped without one.
* **`render.yaml` and the `Dockerfile` have not been deployed.** `render.yaml` combines the studio's own blueprint with this site's; the dependency install of the image was checked (`npm ci --omit=dev` with only the three package files).
* **The placeholders on the pages are as they were exported**: the phone number `+91 00000 00000` and the WhatsApp number `910000000000` are placeholders, and the footer's LinkedIn and Instagram links point at those sites' front pages. They need the real values from the owner; nothing was invented to replace them.

---

## Deploying to Render

`render.yaml` defines two services; the studio's own guide, `swatchroom/DEPLOY.md`, explains every setting (its service names differ: `swatchroom` there is `terucon` here, `swatchroom-models` is `terucon-models`).

| Service | What it is | Plan |
|---|---|---|
| `terucon` | the website **and** the Design Studio in one Node process, built from the `Dockerfile` | Starter |
| `terucon-models` | the studio's local scan models (Python), from `swatchroom/python` | Standard (needs about 2 GB for torch) |

1. Push the project to GitHub. `.env`, `swatchroom/.env`, `swatchroom/keys/` and key files are git-ignored (and left out of the Docker image); keep them out.
2. Render: **New > Blueprint**, pick the repo. Fill in the variables marked `sync: false`: `MONGODB_URI` (Render has no managed MongoDB; use Atlas and allow its connections), `GOOGLE_SERVICE_ACCOUNT_JSON` (or a Secret File and `GOOGLE_APPLICATION_CREDENTIALS`), `STUDIO_PASSCODE`, `ADMIN_EMAIL` / `ADMIN_PASSWORD`, and the Modal URLs and keys you use.
3. After the deploy, `https://<service>.onrender.com/api/health` should show `"studio":{"running":true,"database":true}`; then open `/design-studio` and the studio's Settings → Check.
4. `STUDIO_WARMUP` is `on` in the blueprint; set it to `off` to wake the GPUs only on a scan.
