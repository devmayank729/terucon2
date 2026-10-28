# How to run Terucon

A short guide: what the folders do, how they fit together, and how to start the project.
For the full reference (the studio's settings, the cold start and what it costs, deployment) see the main `README.md`.
For a map of every file, the API, the settings and the request flows, open `/project-overview` on the running site
(or `docs/PROJECT_OVERVIEW.html` straight from disk).

---

## 1. What this project is

Four web pages that work as one site, an Express server behind them, and the Design Studio ("Swatchroom") mounted in that server.

| Page | Address (server running) | Built from |
|---|---|---|
| Terucon website (landing page) | `/` | `pages_original/index.html` |
| Materials shop | `/materials` | `pages_original/market_place.html` |
| Design Studio | `/design-studio` | `swatchroom/terucon/Swatchroom.html` |
| My project (client dashboard) | `/my-project` | `pages_original/dashboard.html` |
| Coming soon (any address that is no page) | `/coming-soon` | `pages/coming-soon.html` |

* **JavaScript (Express) runs the website.** It serves the pages and photos, and loads the Design Studio into the same process.
* **The Design Studio is its own project, kept in `swatchroom/`** exactly as it was built. It has its own settings file
  (`swatchroom/.env`), its own database (MongoDB), calls Google (Gemini) for the renders with its own key, and uses GPU services
  on Modal plus a small Python service for the scan. The website only mounts it and links to it.
* **The pages are data.** `site/site.json` lists the pages and their routes; `site/patches/*.json` describes every change made
  to the Claude Design exports (links, menu entries, the hero button, the wake-up script). `npm run build:site` applies them.
* **The landing page wakes the studio's GPU services** as it opens, because they need 10-45 seconds to start from sleep (README, "Cold start").

---

## 2. Folder flow

```
Terucon/
├─ app.js                  ← START HERE: the Express server (npm start)
├─ package.json            ← npm scripts: start, models, build:site, test, ... (swatchroom/ is an npm workspace)
├─ .env                    ← the website's settings: port and the wake-up switch (never committed, never served)
│
├─ server/                 ← Express modules (JavaScript)
│   ├─ config/                .env reader and settings
│   ├─ lib/                   site map, errors, logging, and swatchroom.js (loads the Design Studio)
│   ├─ middleware/            host / origin / content-type guards, headers
│   └─ routes/                pages (and Coming soon), /media, /api/*, the studio wake-up
│
├─ site/                   ← the website as JSON
│   ├─ site.json              pages, routes, aliases, connections between pages
│   ├─ components.json        shared HTML snippets (menu cards, footer links, the hero button)
│   └─ patches/               one JSON file per page + snippets/ (the injected code)
├─ pages_original/         ← untouched Claude Design exports of the landing page, shop and dashboard
├─ pages/                  ← the four built pages (generated, do not edit by hand) and coming-soon.html (written by hand)
├─ media/                  ← photos and videos used by the website
│
├─ swatchroom/             ← the DESIGN STUDIO, copied in unchanged
│   ├─ server/                its routes and libraries (rooms, Gemini, scans, the cold-start bookkeeping)
│   ├─ public/                its browser code, fonts and textures
│   ├─ python/                the local scan models (SegFormer, SlimSAM)
│   ├─ modalBlueprint.py      the GPU services on Modal
│   ├─ terucon/Swatchroom.html  the Claude Design export of the studio's page
│   ├─ .env  .env.example     the studio's settings (database, Google key, GPU services, passcode)
│   └─ README.md  ARCHITECTURE.md  DEPLOY.md  its own guides
│
├─ tools/                  ← JavaScript tooling: build-site, check-links, build-overview, run-tests
├─ tests/                  ← JavaScript tests, browser tests (e2e), a dev stack on throw-away settings
└─ docs/                   ← this guide and the project overview
```

### How a request moves

**Opening a page:** browser → Express (`server/routes/pages.js`) → looks the address up in `site/site.json` → sends `pages/*.html`.
Photos come from `media/`. An address that is no page gets `pages/coming-soon.html` (status 404).

**Opening the Design Studio:** the page `/design-studio` loads the studio's script `/js/swatchroom-app.js`; the studio shows its
"Powered by Terucon India" splash while it asks `/api/vision/warmup` whether the GPU services are awake, then (if a passcode is
set) asks for it, then opens. Everything the studio does after that goes to its own `/api/*` routes.

**The cold start:** landing page (or studio page) → `POST /api/studio/warmup` → Express → the studio's wake-up code → `/healthz` of
the scan service and of the room-analysis service, in the background, skipping any that are already awake.

**Scanning a photo and rendering a finish** (the studio's own flow, `swatchroom/README.md`): the photo goes to `/api/vision/segment`
(the local model and OneFormer on Modal race; the first answer is shown at once); a render goes to `/api/ai/generate`, where the
server adds the Google key and calls Gemini on Vertex AI. The key never reaches the browser.

**Updating a page:** put the new Claude Design export in `pages_original/` (same file name), then run `npm run build:site`.
It applies the JSON patches in `site/patches/` and writes the four pages to `pages/`. It fails loudly, naming the step, if the
new export no longer matches a patch. Change the patch JSON (not the built page) if you want a different result;
edits made directly to `pages/*.html` are lost on the next build. (The studio's page export is `swatchroom/terucon/Swatchroom.html`.)

---

## 3. Run it

You need Node 20 or newer. For the studio's local scan models you also need Python 3.10+; the site and the studio run without them.

```bash
cd Terucon
npm install                                  # the website and the Design Studio, in one go
cp .env.example .env                         # skip if .env already exists (optional: the defaults work)
npm start
```

Open **http://localhost:8080** and use the site through that address, not by double-clicking the HTML files.

The Design Studio needs its own settings in `swatchroom/.env` (copy `swatchroom/.env.example` if it is not there):
`MONGODB_URI`, `GOOGLE_APPLICATION_CREDENTIALS` (the key goes in `swatchroom/keys/`), the Modal URLs and keys, and `STUDIO_PASSCODE`.
The terminal prints a banner that says whether that file was found, and then what the studio found (database, Google key, models).
Stop everything with `Ctrl+C`.

`npm start` first runs `node tools/build-site.js --if-missing`, which builds any page that is missing from `pages/`.

### The scan models (optional, a second terminal)

```bash
cd swatchroom/python && python3 -m venv .venv && source .venv/bin/activate        # once
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu    # once (CPU build)
pip install -r requirements.txt                                                    # once
cd ../.. && npm run models                                                         # every time, with the environment active
```

Without them the studio still scans (Gemini outlines, OneFormer on Modal when set up); the Pick tool needs them.

### Try it without credentials

```bash
node tests/dev/stack.mjs --port 8765 --passcode letmein
```

This runs the real site with the real Design Studio mounted, against two mock GPU services, with no database and no Google key
("AI off" in the studio). Open the address it prints; the passcode is `letmein`. It copies the code into a temp folder and runs
there, so it never reads your `.env` files or reaches your services. It is a test rig, not for real work.

---

## 4. Tests

```bash
npm test                          # site build check, link check, overview check, JavaScript tests (about a minute, no credentials)
npm test -- --e2e                 # + the browser tests (needs Chrome): the whole path with real clicks, the cold start, the studio's start-up
npm run test:js                   # only the website's JavaScript tests
npm run test:swatchroom           # the Design Studio's own unit tests
```

The browser tests need their one dependency once: `cd tests/e2e && npm install`.

---

## 5. If something goes wrong

| What you see | What to do |
|---|---|
| `Could not start on port 8080` | Another program uses the port. Change `PORT` in `.env` and start again. |
| `Cannot find module 'mongoose'` | Run `npm install` in the project folder (the studio's packages come with it). |
| The banner says `Studio settings … NOT FOUND` | Copy `swatchroom/.env.example` to `swatchroom/.env` and fill it in. |
| `/design-studio` asks for a passcode | `STUDIO_PASSCODE` is set in `swatchroom/.env`. Give people the passcode, or remove it to open the studio to everyone. |
| The studio says "AI off" | No Google key yet: `GOOGLE_APPLICATION_CREDENTIALS` in `swatchroom/.env`. In the studio, Settings → Check says what is missing. |
| `MongoDB is not reachable … Retrying` | `MONGODB_URI` in `swatchroom/.env` (with Atlas, allow this machine's address). The studio opens, but rooms cannot be saved. |
| `Scan model service … is not running` | Start the local models (section 3), or ignore it: scans fall back to Gemini outlines. |
| `421 Unexpected Host header` | You opened the site by an address the server does not know. Use `localhost` or add the name to `ALLOWED_HOSTS`. |
| `npm run build:site` says a step "matched 0 times" | The re-exported page changed. Update that step in `site/patches/<page>.json` (it fails on purpose instead of half-patching). |
| The aluminium support frame on My project has no photo | That page asks for `media/materials/fx-mill.jpg`, which was never exported. Add the file to `media/materials/`. (Every other material photo is embedded in the page.) |
