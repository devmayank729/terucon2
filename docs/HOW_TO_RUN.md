# How to run Terucon

A short guide: what the folders do, how they fit together, and how to start the project.
For the full reference (every setting, how the segmentation works, test results) see the main `README.md`.
For a map of every file, the API, the settings and the request flows, open `/project-overview` on the running site
(or `docs/PROJECT_OVERVIEW.html` straight from disk).

---

## 1. What this project is

Four web pages that work as one site, an Express server behind them, and a small Python service for the models.

| Page | Address (server running) | Built from |
|---|---|---|
| Terucon website | `/` | `pages_original/index.html` |
| Materials shop | `/materials` | `pages_original/market_place.html` |
| Design Studio | `/design-studio` | `pages_original/Swatchroom.html` |
| My project (client dashboard) | `/my-project` | `pages_original/dashboard.html` |

* **JavaScript (Express) runs the website.** It serves the pages and photos, keeps your Google credentials private
  (the browser never sees them), forwards the Design Studio's render requests to Google, and starts the Python service.
* **Python runs the models.** Finding the surfaces in a photo (Gemini outlines, optional SAM, edge snapping) lives in `model/`
  as an internal service that Express talks to. Evaluation and fine-tuning also live there.
* **The pages are data.** `site/site.json` lists the pages and their routes; `site/patches/*.json` describes every change made
  to the Claude Design exports (links, menu entries, the Design Studio's server mode). `npm run build:site` applies them.

The site works without the Python service: scanning a photo then falls back to the Design Studio's in-browser parser.

---

## 2. Folder flow

```
Terucon_2/
├─ app.js                  ← START HERE: the Express server (npm start)
├─ package.json            ← npm scripts: start, model, build:site, test, ...
├─ .env                    ← your private settings and Google credentials (never committed, never served)
│
├─ server/                 ← Express modules (JavaScript)
│   ├─ config/                .env reader and settings
│   ├─ lib/                   Google sign-in, Gemini/Vertex client, site map
│   ├─ middleware/            host / origin / content-type guards, headers
│   ├─ routes/                pages, /media, /api/*
│   └─ model/                 starts and supervises the Python service, proxies requests to it
│
├─ site/                   ← the website as JSON
│   ├─ site.json              pages, routes, aliases, connections between pages
│   ├─ components.json        shared HTML snippets (menu cards, footer links)
│   └─ patches/               one JSON file per page + snippets/ (the injected code)
├─ pages_original/         ← untouched Claude Design exports (the source for the build)
├─ pages/                  ← the four built pages (generated, do not edit by hand)
├─ media/                  ← photos and videos used by the website
│
├─ model/                  ← PYTHON: everything about the models
│   ├─ terucon_model/         the service: segment/ (photo → surfaces), sam/ (optional SAM), Google client
│   ├─ eval/                  accuracy measurements on ground-truth photos
│   ├─ finetune/              where fine-tuning code and notes live
│   └─ tests/                 Python tests + a mock Google
│
├─ tools/                  ← JavaScript tooling: build-site, check-links, build-overview, run-tests
├─ tests/                  ← JavaScript tests, browser tests (e2e), a dev stack with a mock Google
└─ docs/                   ← this guide and the project overview
```

### How a request moves

**Opening a page:** browser → Express (`server/routes/pages.js`) → looks the address up in `site/site.json` → sends `pages/*.html`.
Photos come from `media/`.

**Scanning a photo in the Design Studio:**

```
browser ─► /api/segment ─► Express (checks Google is set up, streams the photo on)
                          ─► Python model service  /segment
                             1. detect.py       Gemini names the surfaces and outlines them roughly
                             2. sam_refine.py   (only if SAM is on) SAM corrects each outline near its edge
                             3. snap.py         every boundary slides onto the photo's real edge
                             4. refine.py       surfaces are layered and cleaned
                          ◄─ labelled surfaces back to the browser
```

**Rendering a finish:** browser → `/api/vertex/generate` → Express (`server/lib/vertex.js`, `googleAuth.js`) → Google → image back.
The credentials stay inside the server the whole time.

**Updating a page:** put the new Claude Design export in `pages_original/` (same file name), then run `npm run build:site`.
It applies the JSON patches in `site/patches/` and writes the four pages to `pages/`. It fails loudly, naming the step, if the
new export no longer matches a patch. Change the patch JSON (not the built page) if you want a different result;
edits made directly to `pages/*.html` are lost on the next build.

---

## 3. Run it

You need Node 20 or newer. For scanning photos you also need Python 3.10+ (tested on 3.13); the site runs without it.

```bash
cd Terucon_2
npm install                                  # Express
npm run setup:model                          # Python packages for the model service (once; optional)
cp .env.example .env                         # skip if .env already exists
npm start
```

Open **http://localhost:8080** and use the site through that address, not by double-clicking the HTML files
(from `file://` the Design Studio's in-browser vision worker can fail to start, and the links between pages are server addresses).

The terminal prints a banner that says whether Google credentials were found and whether the model service is up.
Stop everything with `Ctrl+C` (the Python service stops with it).

`npm start` first runs `node tools/build-site.js --if-missing`, which builds any page that is missing from `pages/`.

### Add your Google credentials (needed for scanning and rendering)

Open `.env` and fill in **one** of these. The file explains each line.

* `GCP_SERVICE_ACCOUNT_JSON` (or `GOOGLE_APPLICATION_CREDENTIALS`) plus `GOOGLE_CLOUD_PROJECT`: Vertex AI with a service account. Recommended.
* `GEMINI_API_KEY`: a Google AI Studio key.

Save and reload the page; `.env` is re-read automatically. Only `HOST`, `PORT` and the `MODEL_*` settings need a restart.
`.env` is git-ignored: never paste its contents into chat, issues or commits.

### The Python model service

| You want | Do |
|---|---|
| The normal setup | nothing: `npm start` starts it (`MODEL_SERVICE=auto`) and stops it again |
| To run it by hand, with its own log window | `MODEL_SERVICE=external` and `MODEL_SERVICE_URL=http://127.0.0.1:8081` in `.env`, then `npm run model` in a second terminal |
| To run it on a GPU machine | on that machine: `cd model && MODEL_HOST=0.0.0.0 MODEL_SERVICE_KEY=... python -m terucon_model`; here: `MODEL_SERVICE=external`, `MODEL_SERVICE_URL=https://that-machine:8081`, the same `MODEL_SERVICE_KEY` |
| To switch it off | `MODEL_SERVICE=off` (the Design Studio uses its in-browser parser) |

### Try it without credentials

```bash
node tests/dev/stack.mjs --port 8765
```

This runs the real site and the real Python service against a fake Google, so the whole Design Studio (scan and render) can be tried
for free using the built-in synthetic room. Open the address it prints. It is a test rig, not for real work.

### Optional: SAM for sharper edges

Everything works without it. To turn it on: `pip install -r model/requirements-sam.txt`, set `SAM_ENABLED=true` in `.env`,
and restart. The first start downloads about 180 MB.

---

## 4. Tests

```bash
npm test                          # site build check, link check, overview check, JavaScript tests, Python tests (~1 min, no credentials, no GPU)
npm test -- --e2e                 # + the browser tests (needs Chrome; starts the real site against a mock Google)
npm run test:js                   # only the JavaScript tests
npm run test:model                # only the Python tests
```

The browser tests need their one dependency once: `cd tests/e2e && npm install`.

---

## 5. If something goes wrong

| What you see | What to do |
|---|---|
| `Could not start on port 8080` | Another program uses the port. Change `PORT` in `.env` and start again. |
| The banner says `.env NOT FOUND` | Run `cp .env.example .env` next to `package.json`. |
| Banner says `Google: not configured` / scans fail | No credentials yet. Fill in `.env` (see above), or use `tests/dev/stack.mjs` to try the Studio. |
| `Model service: unavailable` in the banner | The message says why. Usually: `npm run setup:model` (Python packages missing), or set `PYTHON` in `.env` to the interpreter that has them. The website works meanwhile. |
| The Design Studio says "The Terucon server engine failed" | The model service is down or Google refused; the note names the reason, and the in-browser parser was used instead. |
| `421 Unexpected Host header` | You opened the site by an address the server does not know. Use `localhost` or add the name to `ALLOWED_HOSTS`. |
| `npm run build:site` says a step "matched 0 times" | The re-exported page changed. Update that step in `site/patches/<page>.json` (it fails on purpose instead of half-patching). |
| The aluminium support frame on My project has no photo | That page asks for `media/materials/fx-mill.jpg`, which was never exported. Add the file to `media/materials/`. (Every other material photo is embedded in the page.) |
