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
| Finder (find a material from a photo, a spot on it, a colour or words) | `/finder` | `pages/finder.html` (written by hand), `site/catalogue-ui/finder.js` |
| Catalogue admin (upload, processing, labels, live release) | `/admin/catalogue` | `pages/admin-catalogue.html` (written by hand), `site/catalogue-ui/admin.js` |
| Coming soon | `/coming-soon`, and any address that is no page | `pages/coming-soon.html` (written by hand) |

---

## How a visitor moves through the site

```
Landing page  /                      (open to everybody)
  │  hero: [Start a project]  [Try it with your photo →]  [See the work]      (all of it also on a phone)
  │  the moment it opens, the website wakes the studio's GPU services (section "Cold start")
  │
  │  Leaving the landing page for any other page → /login?next=…   sign in or create an account:
  │     e-mail or mobile number → one-time code → (new people) name, other contact, firm → on to the page they asked for
  │     or Google One Tap. Header link: "Sign in", then "Account" (/account: details, sign out, delete account).
  │
  ├─► Design Studio  /design-studio   splash → add a room photo → tap a surface → pick a finish → render
  │       header, menu and footer lead on to: Materials · My project · Start a project (/#enquire) · the logo (/)
  ├─► Materials  /materials            shop, saved, cart, checkout (a demo)  ─ and on to the Design Studio, My project, home  (members)
  ├─► My project  /my-project          the client dashboard (a prototype)    ─ and on to Materials, the Design Studio, home  (members)
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

The Design Studio reads **its own** settings file, `swatchroom/.env` (copy `swatchroom/.env.example`): the database, the Google key and the GPU services are there. The website's `.env` only holds where it listens and `STUDIO_WARMUP`.

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
| `STUDIO_REQUIRE_PASSCODE=on` + `STUDIO_PASSCODE` | closing the studio behind a passcode (off by default) | nobody is asked for a passcode; the protections in "Keeping the open studio safe" apply instead |

**The passcode is off.** Visitors from the landing page's "Try it with your photo" go straight into the studio. The website switches the studio's own `STUDIO_PASSCODE` (in `swatchroom/.env` or the environment) off before the studio reads its settings, so a passcode left in that file does nothing. To bring it back, set `STUDIO_REQUIRE_PASSCODE=on` in the website's `.env` (and keep `STUDIO_PASSCODE` in `swatchroom/.env`) and restart; the protections below are then not used.

### Keeping the open studio safe

With no passcode, nothing but the website's own checks stands between a stranger and the studio's costs and data. The studio itself keeps every visitor's rooms in one pile and has no rate limit, so `server/lib/studioShield.js` (in the website, in front of the studio; nothing in `swatchroom/` is changed) adds:

- **Rooms belong to the browser that made them.** Each browser gets a private random id in an HttpOnly cookie (`terucon_owner`). The room list shows only your rooms; opening, changing or deleting someone else's room gets the studio's own "That room is not saved here.", so a stranger cannot tell a room exists. The owners are kept in a separate MongoDB collection, `room_owners`; the studio's rooms and photos are not touched. **Rooms saved before this was switched on have no owner and are hidden from everybody** (they are still in the database). A visitor who clears cookies or changes device no longer sees their rooms: rooms are tied to the browser, not to a person.
- **Rate limits** per browser, per hour, on the routes that cost money or write data: Gemini (60), scans (60), room analysis (40), Settings > Check (10), room saves (600). One network address gets 4 times a browser's allowance, so clearing cookies does not give a new one. A visitor over the limit sees "Please wait a few minutes and try again" (HTTP 429). **These numbers are starting values chosen when this was built, not measured**: change them with `STUDIO_LIMIT_*` (`.env.example`, section 3) if real visitors reach them. They are kept in memory, so a restart clears them and two server instances would not share them.
- **Behind a proxy (Render) set `TRUST_PROXY=1`** (`render.yaml` does). Without it the site sees the proxy's address for everyone, so the per-address limit is one shared bucket and HTTPS cannot be detected.
- **Headers**: no other site can show the pages in a frame (`X-Frame-Options`, `frame-ancestors`), and HTTPS responses carry HSTS. There is deliberately no stricter Content-Security-Policy: the pages are Claude Design bundles built from inline scripts, which one would break.
- At start the banner warns when `/admin` still has its built-in password (`ADMIN_PASSWORD`) or `SESSION_SECRET` is unset.

What this does **not** do: it does not stop one determined person with many addresses from using up Google or GPU spend (put a spending limit on the Google and Modal side), and the room-analysis job routes identify a job or a room by an unguessable id, not by owner.

### Analytics (PostHog)

Every page (home, Materials, Design Studio, My project, Coming soon) and the studio itself send events to PostHog once there is a project key: `POSTHOG_KEY` in the website's `.env`, or, left blank, the studio's own `POSTHOG_KEY` in `swatchroom/.env`, so the pages and the studio land in one project. Each page's script (`site/patches/snippets/analytics.js`) asks `GET /api/analytics` for the key, so no key is written into the pages.

- **Recorded**: page views and leaves, a `cta_click` for every link and button (its words and where it goes; on My project only where it goes), a `form_submit` for every form (never what was typed), page speed, script errors, and the studio's own events. Every event carries `page_type` (home, materials, studio, dashboard, coming-soon) and `visitor_id` (the studio's `swr_vid`, which is also what the studio's server events use, so browser and server events can be joined).
- **Session replay** (`POSTHOG_REPLAY`, default on) masks every letter and every field and blocks photos, canvases and videos, so a room photo is never recorded. It also has to be switched on in the PostHog project. You may need a cookie notice for it; that is your decision, not something the site shows.
- A browser that sends Do Not Track or Global Privacy Control is not recorded.
- **Nothing is sent when the site is opened as `localhost`**, so your own test clicks do not fill the real project. `POSTHOG_ON_LOCALHOST=on` lifts that. The `/admin` page and the project overview are not tracked.
- The studio's server-side events (`generation`, `generation_failed`) were already sent by the studio itself; they keep working.

**The owner's dashboard** is `/admin` (its own sign-in: `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `swatchroom/.env`; when they are unset the studio uses `admin@terucon.in` / `admin@123`, so set them before the site is online). It shows who is live, the generations and scans, the status of every service and the cold start of each GPU service.

### Cold start: the landing page wakes the GPUs

The studio's GPU services (on Modal) scale to zero when nobody uses them, and a sleeping one needs **10–45 s** to wake (the studio's own estimate; its audit measured 9–24 s for a normal restore, `swatchroom/swatchflow.md` Part 6). The studio, on its own, wakes them only when a photo is scanned. This website starts them earlier:

1. The landing page and the studio page send `POST /api/studio/warmup` the moment they open (a script in the page head, `site/patches/snippets/warmup.js`; about 100 ms after the navigation starts, at most once a minute per browser tab). It sends nothing on the other pages.
2. The server starts the **scan** service (OneFormer) and the **room-analysis** service(s) using the studio's own wake-up code, so the studio's record of what is warm is the one the start-up check reads. A service that is already warm or already starting is skipped, so repeat visits cost nothing.
3. It answers at once; the wake-up goes on in the server whether or not the visitor stays. The studio's start-up check then finds the services starting ("waking") or warm, and the scan uses them.

This route is the website's own, so any visitor wakes the services.

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

## Sign-in, accounts and the CRM

Every page but the landing page needs an account (`/materials`, `/design-studio`, `/my-project`, `/account`), and so do the Design Studio's costly and private routes (`/api/ai`, `/api/rooms`, `/api/vision`, `/api/pipeline`, `/api/check`). A visitor without one is sent to `/login?next=<where they were going>`, however the address is written (aliases, capitals, encoded letters: the gate is applied after the path is decoded). The code is in `server/auth/` and `server/routes/auth*.js`.

**How a person signs in.** One box takes an e-mail address or a mobile number (the page works out which). A six-digit code is sent; the same answer comes back whether or not the address has an account, so the form cannot be used to find out who is registered. After a right code an existing account signs in and a new one is made, and the person fills in **name, the other contact detail (mobile number or e-mail address) and firm** (or ticks "I am not part of a firm"). **That other contact detail is confirmed with a second code before the sign-up counts as finished** (wherever that way of sending is available; the setting `signup.confirmSecondContact` turns it off), because only a confirmed detail can sign anybody in: a number that was merely typed would, at the next sign-in, start a second, empty account. A business e-mail address gives a **firm name to start from**, labelled as a suggestion; setting `firm.lookup` chooses between `off`, `domain` (guessed from the address) and `website` (also read from the firm's own site, with SSRF protection). **Google One Tap** (and the Google button) creates the account at once from Google's name and verified e-mail, then asks for phone and firm. Signing in again always needs a new code (or Google). `/account` has the details, **sign out** (this device, or everywhere), confirming or changing an e-mail / number with a code, and **delete account**, which needs a fresh code sent to a confirmed address, deletes the saved Design Studio rooms and photos, and clears what waits for the CRM.

**What to set (`.env`, section 5 and 6 of `.env.example`).** At least: `AUTH_SECRET` (32+ random characters), `AUTH_ADMIN_TOKEN`, a way to send codes (`AUTH_EMAIL_PROVIDER=smtp` with `AUTH_SMTP_*` and `AUTH_EMAIL_FROM`, and/or `AUTH_SMS_PROVIDER=twilio|webhook`, and/or `AUTH_GOOGLE_CLIENT_ID`), and on Render `TRUST_PROXY=1`. Without a secret or a way in, **sign-in does not run and says so** (the banner, `/api/health` as coarse reason codes, the sign-in page): nobody is let in by accident. **On your own computer nothing needs setting up**: a sender you did not name is the console one, which prints the codes in the terminal (`[development] e-mail code for ... (login): 123456`), and it is refused on a server reachable from the network or with `NODE_ENV=production`. If no MongoDB is running locally, add `AUTH_STORE=memory`. Accounts live in the studio's MongoDB (collections `terucon_*`) when the studio is mounted, else in memory (`AUTH_STORE`).

**Rate limits and the other rules are managed through the admin API, not `.env`.** `GET /api/auth/admin/settings` lists every setting with its value, default, bounds and a label (enough to draw a form); `PUT` changes them (`{"settings": {"limits.otpStartPerIpPerHour": 20}}`, `null` puts one back). Every value has hard bounds, so a bad save cannot set a limit to 0 or to a billion. They apply on the next request. The same API reads the security log (`/events`), shows what is missing (`/status`), lifts a lock (`/unlock`) and looks after the CRM queue. It needs `Authorization: Bearer <AUTH_ADMIN_TOKEN>` and does not exist (404) without one. The admin panel itself is not built; this is what it will call. **The Design Studio's own rate limits are admin-managed too**: `studio.limit.*` in the same API, with what is in `.env` (`STUDIO_LIMIT_*`) as the starting value and a saved value winning at once. The settings: sign-up open or closed, whether the second contact detail is confirmed at sign-up, which ways in are on, throw-away e-mail domains, the countries allowed for text messages (default `91` only), code lifetime and tries, wait between codes, codes per address / network / day (e-mails and texts have a site-wide daily ceiling), wrong codes before a lock, session idle and maximum days, firm look-up mode, and the CRM module and field names.

**CRM (Zoho).** A finished sign-up is queued and a background loop sends it to Zoho CRM (upsert by e-mail into Leads, `Last_Name` and `Company` always filled; later changes update the same record; `crm.deleteOnAccountDelete` decides whether deleting an account also deletes the Zoho record, default no). Retries back off when Zoho is slow or rate limiting. **With the Zoho settings blank (`ZOHO_DC`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`) nothing is lost: sign-ups wait in the queue and go out once the credentials are in `.env`** (no restart needed). The queue holds no personal data (it names the account; the account is read when the job runs).

**Security, in one place.** Codes are stored only as an HMAC keyed with `AUTH_SECRET`; sessions as the SHA-256 of a random 256-bit cookie token; five tries per code counted atomically, wrong guesses counted across codes with a lock; one verified address belongs to at most one account (what a person merely typed is an unproved claim, never a way in); the cookie is `HttpOnly`, `SameSite=Lax`, and `__Host-` and `Secure` on HTTPS; every `/api/auth` call is JSON-only, same-site, uncacheable and counted per network address (IPv6 per /64); Google's token is checked with `node:crypto` (RS256 only, audience, issuer, expiry, verified e-mail, one-use nonce bound to the browser); the firm look-up connects only to public addresses, checked as the connection is made. `tests/js/auth-attacks.test.js` is the written-down security pass: every attack that was tried against the running server, kept so it cannot come back. **One real hole found there is fixed**: the studio's router ignores capitals while every protection in front of it did not, so `/API/rooms/...` slid past the rate limits, room ownership and the JSON / Origin guards (`server/middleware/canonical.js`).

**Rooms belong to the account**, not the browser: they follow the person to another device, a second person on a shared computer sees nothing of the first, and deleting the account deletes them. Rooms saved before sign-in existed (owned by a browser cookie) are hidden, as rooms from before the shield already were.

**Not verified against live services:** no real mail server, text-message gateway, Google, Zoho or MongoDB was called. They were tested against pretend servers (an SMTP server with real TLS and STARTTLS, Twilio and webhook calls, Zoho and Google responses, an in-memory stand-in for MongoDB). To check the real MongoDB in one command: `AUTH_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm run test:js` (a throw-away database, dropped afterwards). The Zoho delete call is written from memory (its docs page could not be read); it only runs if `crm.deleteOnAccountDelete` is switched on.

## Inspiration import: paste a link, crop, send to the Design Studio

Target C3 of the quotation. A visitor pastes the address of a photo, a Pinterest pin or board, or any web page with a picture, into the shop's search box, the shop assistant's box or the **Inspiration** page (`/inspiration`); a popup asks **"Import this photo?"**; on yes the picture is fetched and a crop screen opens (shapes, turn, mirror, zoom, a locked-shape box with eight handles; works by mouse, touch and keyboard); the cropped photo then opens in the Design Studio as a new photo, through the studio's own photo input, so the studio carries on exactly as with any photo. Nothing in `swatchroom/` was changed for this.

**What an address becomes** (`site/inspiration/sources.js`, one list used by the browser to ask the question and by the server, which decides again). A site gallery-dl has a profile for is read by **gallery-dl** (`python/gallery_resolve.py`) with that site's own options: Pinterest (pin, board, board section, `pin.it` links), Unsplash, Pexels, Flickr, Behance, Imgur, Wikimedia Commons. A link to a picture file is fetched as it is. Any other web page gives **its own named main picture** (`og:image` and its relatives), and the answer says it is approximate. Instagram, Facebook and X show nothing without a sign-in, so the answer says so and offers an upload instead; no sign-in is attempted for anyone. A profile or other page of a known site is refused with a message rather than guessed at.

**Set up gallery-dl once**, from the project folder: `python3 -m venv python/.venv && python/.venv/bin/pip install -r python/requirements.txt` (gallery-dl is pinned there; the Dockerfile does the same). Without it, picture links and web pages still work and the other sites say "not set up" (`GET /api/inspiration/status` and the page show which). Settings: section 7 of `.env.example` (`INSPIRATION_IMPORT`, `INSPIRATION_LIMIT`, `INSPIRATION_TIMEOUT_SECONDS`, `INSPIRATION_MAX_FILE_MB`, `IMPORTER_PYTHON`, `IMPORTER_SCRIPT`). To try one address by hand: `python/.venv/bin/python -m gallery_dl --config-ignore -j <address>`.

**How it is kept safe** (the visitor chooses the address, so the server fetches what a stranger names): the browser never names a picture address, only one-use **tokens** that belong to the account, last 15 minutes and stand for an address the server worked out itself; every fetch (`server/lib/inspiration/safeFetch.js`) is https on port 443 to a **public** address only, the name resolved once inside the connection (no DNS rebinding), IP addresses and internal names refused, redirects followed by hand and checked again at every hop, with size and time limits and an honest user agent; gallery-dl runs without a shell, with a bare environment, and only the one extractor the registry names (it also has extractors that fetch whatever they are given: those are refused); what comes back is judged by its first bytes (JPEG, PNG, WebP, GIF, AVIF; HTML, SVG and HEIC are refused whatever they are called) and its size in pixels, and only pictures on each site's own hosts are taken. 30 new addresses an hour per account (90 per network address), three at a time. All three API routes need a signed-in, finished account. `tests/js/inspiration-*.test.js` hold the attacks and the contract with the installed gallery-dl (`inspiration-gallery-contract.test.js`: every address shape reaches the intended extractor and every option is one the extractor reads; it runs offline and skips without `python/.venv`).

**Not verified here:** no live Pinterest (its addresses and metadata are covered from gallery-dl's own code, not from a real pin: run `python/.venv/bin/python python/gallery_resolve.py '{"url":"<a real pin>","allow":["pinterest:pin"],"options":{"videos":false,"stories":false},"limit":3,"seconds":40}'` to check one); Unsplash, Pexels, Flickr, Behance and Imgur likewise only against gallery-dl's code. Wikimedia Commons, a plain picture link and an ordinary web page were run live through the real server and Chrome. The `Dockerfile`'s Python step has not been built. HEIC photos cannot be opened by most browsers (the upload path says so). The first, Pinterest-only importer (`server/lib/pinterestImport.js`, `python/pinterest_board.py`) is no longer used and was left in place, with its tests, for you to remove.

## Catalogue: find a material from a photo (Finder, catalogue admin)

Targets C3, C4, C5, C7 and D1. A visitor points the camera at a material (or uploads a photo, taps a spot, picks colour only, or types words) on `/finder` and gets the closest designs in the catalogue, with pictures. The catalogue is made from the owner's PDF or photos: the models (DINOv2, SigLIP) run on **Modal**, the pictures and the releases (vectors) live in a **Google Cloud bucket**, the items in the studio's **MongoDB**, and the releases are also kept on a **Modal volume** so a search container downloads nothing. The website only forwards small requests and signs picture links; it does no model work. The contract is `catalogue/ARCHITECTURE.md`.

**It is off until you set it up.** Everything, step by step (bucket, CORS, two service accounts, MongoDB, the Modal secrets, deploy, the `.env` settings, how to bring in your own files that you uploaded to the bucket, and how to check it): **`docs/CATALOGUE_SETUP.md`**. The settings are `.env.example` section 8 (in the root `.env`, not `swatchroom/.env`). No extra server to run: the Modal app is deployed once.

**Tested against fakes only** (a local folder as the bucket, an in-memory database, a fake Modal), plus one run of the real DINOv2 and SigLIP weights on a Mac's CPU over a synthetic six-page PDF. **Never run** on a live Modal account, bucket or MongoDB, nor on the real catalogue.

## Settings

| File | Holds |
|---|---|
| `.env` (from `.env.example`) | `HOST`, `PORT`, `ALLOWED_HOSTS`, `STUDIO_WARMUP`. Re-read when it changes; only `HOST` and `PORT` need a restart. A variable set in your terminal wins over the file. `TERUCON_ENV_FILE` points at another file (the tests use it). |
| `swatchroom/.env` (from `swatchroom/.env.example`) | everything of the Design Studio (above). Read when the server starts. |

Both are git-ignored and never served; keep them (and `swatchroom/keys/`) out of chat, issues and commits.

---

## The pages as JSON, and how they connect

* **`site/site.json` is the site.** Per page: its route, the export it is built from, the built file, aliases (`/index.html`, `/Terucon Swatchroom.html`, `/studio`, `/swatchroom`, … redirect permanently to the route), per-page response headers, and a `connections` matrix: which pages each page must link to. The old design-time names (`Design Studio.dc.html`, `Terucon Home v2.html`, …) redirect to the right page. A name that differs only by capitals or a trailing slash (`/Materials`, `/materials/`) redirects to the page too. The Express server, the page build, the link checker and the project overview all read this one file. Its `docs` section holds the pages that are not built from an export: the project overview, the Coming soon page, and the sign-in and account pages. A page's `access` (`public`, or `signed-in` for members only) and, for the hand-written ones, a `csp` live here too.
* **Every change made to the Claude Design exports is JSON, not code.** `site/patches/<page>.json` is an ordered list of anchored steps (relink, insert after / before, replace once, replace all, edit an asset); `site/components.json` holds the shared HTML snippets (header link, menu card, footer link, the hero button); the injected JavaScript is kept as real files in `site/patches/snippets/`. Every anchor must match exactly once or the build fails loudly, naming the page and the step. Format: `site/patches/README.md`.
* **Links between pages are routes** (`/materials`, `/design-studio`, `/my-project`, `/`). Added entry points: *Materials* and *My project* on the website; *My project* on the shop and the studio; *Try it with your photo* in the landing page's hero.
* **A page that does not exist yet** shows `pages/coming-soon.html` with a 404 status (browsers asking for HTML at an address with no file extension; files, `/api` and `/media` keep a plain 404). To point a button at something that is still being built, link it to `/coming-soon`.
* Two dead "Media brief" links (a design-review pill pointing at files that were never exported) are switched off with the page's own `mediaGuides` setting.
* Saved items and the cart live in `localStorage`, so they are shared across pages **when served from one address**.
* **The pristine exports** are in `pages_original/` (and the studio's in `swatchroom/terucon/`). `npm run build:site` rebuilds `pages/` from them. If you export a page again from Claude Design, drop it into `pages_original/` under the same name and run it again; it fails loudly if the page changed in a way the patches cannot follow. For the studio page, re-export it with the studio's own script (`npm run terucon-page -w swatchroom -- /absolute/path/to/export.html`; it runs inside `swatchroom/`) and rebuild. `npm run check:site` tests without writing.

The dashboard is still a front-end prototype with a demo project ("Rao Dental Studio"); it links to everything, but it does not yet receive data from the shop or the studio.

---

## Speed, caching and compression

The four big pages (landing page, shop, studio page, dashboard) are exported as one self-extracting file each. `node tools/build-dist.js` (`npm run build:dist`) unpacks them once into `dist/` (git-ignored): plain pages with `<link>` / `<script src>` / `<img src>` to content-hashed files under `/assets/`, each with brotli and gzip copies made at build time. The server answers from `dist/` when `dist/manifest.json` exists, and from `pages/*.html` exactly as before when it does not (a fresh checkout, the tests). The start-up banner says which, and warns when `pages/` is newer than `dist/`.

| What | Cache | Compression |
|---|---|---|
| `/`, `/materials`, `/design-studio`, `/my-project` | `no-cache` (members' pages `private, no-cache`), strong `ETag`, `If-None-Match` gives 304 | the `.br` / `.gz` copy the browser accepts (br first); `Vary: Accept-Encoding` |
| `/assets/*` | one year, `immutable` (the file names carry a hash of the content) | `.br` / `.gz` copies of js, css, svg, json; images and fonts are already compressed |
| `/brand/*`, `/favicon.ico`, `/site.webmanifest` | one day, then served stale for up to a week while the browser checks | on the fly |
| `/media/*` | one week (`max-age=604800`); the photos and videos are **not** content-hashed, so not longer | none (already compressed); Range requests work for the videos |
| the hand-written pages, `/api/*`, the studio's `/js` and `/css` | `no-cache` with validators (`/api` is `no-store`) | on the fly (brotli, else gzip) when over 1 KB |
| the studio's `/textures/*` | one week (the studio itself sends `no-cache`); its fonts are a year | none |

The full table, with the file that sets each rule, is the comment at the top of `app.js`.

* **Rebuild:** `npm run build:dist` after any change to `pages/`, `site/brand/`, `site/optimized/` or `site/vendor/`; `npm run check:dist` says whether `dist/` is current. `npm start` builds it only when it is missing (`prestart`); the Dockerfile builds it on every image build and stops if the build fails.
* **Verify** (against a running server; for the live site use its address):

```bash
curl -sI -H 'Accept-Encoding: br' http://localhost:8080/ | grep -i -E 'content-encoding|etag|vary|cache-control|content-length'
curl -sI http://localhost:8080/ | grep -i content-length                                  # the same page, not compressed: compare the sizes
curl -sI -H 'Accept-Encoding: br' -H 'If-None-Match: "<the etag from above>"' http://localhost:8080/ | head -1    # 304 Not Modified
curl -sI -H 'Accept-Encoding: br' http://localhost:8080/assets/<a file name from dist/assets>                       # immutable, content-encoding br
curl -sI -H 'Accept-Encoding: br' http://localhost:8080/css/swatchroom.css                                         # the studio's css, compressed on the fly
```

* The files under `/assets/` are public (they are not behind sign-in; only the HTML of the members' pages is). The names are not guessable but they are not secret either.
* A failure on the server shows `pages/error.html` to a browser and a JSON body to everything else; nothing of the error is shown, the detail is in the server log. An error nobody caught is logged, the server finishes the requests in flight and exits with code 1 so Render starts a new one. The server keeps connections open for 65 s (`keepAliveTimeout`) for Render's router.

---

## Layout

```
app.js                       the Express server: `npm start` (createApp / startServer are exported for tests)
server/                      config/ (.env, settings), lib/ (site map, errors, logging, the Design Studio loader),
                             middleware/ (guards, headers, one spelling of /api), routes/ (pages and Coming soon, media, api, docs, the studio wake-up,
                             sign-in and its admin API, the inspiration import), lib/inspiration/ (safe fetching, picture checks, tokens), auth/ (accounts, one-time codes, sessions, Google, the firm look-up, the Zoho queue,
                             the settings the admin panel will manage; providers/ for SMTP and text messages)
site/                        site.json (the site map), components.json, patches/ (one JSON file per page + snippets/),
                             inspiration/ (the browser side of the inspiration import: paste question, crop screen, hand-over)
python/                      the website's own Python (gallery-dl, for the inspiration import): gallery_resolve.py, requirements.txt
pages_original/              the three pristine Claude Design exports (landing page, shop, dashboard)
pages/                       the four built pages (generated by tools/build-site.js) and coming-soon.html, login.html, account.html, inspiration.html (by hand)
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
| `/design-studio` asks for a passcode | `STUDIO_REQUIRE_PASSCODE=on` is set (see "The passcode is off" above). |
| Every page sends me to `/login`, and the sign-in page says it is not available | The banner (and `/api/health`) say why: usually no `AUTH_SECRET`, no way to send a code or no Google client id, or MongoDB not connected yet. Fix `.env` and reload; for a quick look on this computer set `AUTH_EMAIL_PROVIDER=console` and `AUTH_SECRET`. |
| Nobody on the real site can sign in, or "too many requests" for everybody | Behind Render (or any proxy) set `TRUST_PROXY=1`: without it every visitor looks like the same address and shares one limit. |
| A person is locked ("too many wrong codes") | `POST /api/auth/admin/unlock` with their address, or wait out `limits.lockMinutes`. |
| New sign-ups do not reach Zoho | `GET /api/auth/admin/status` shows the queue and what is missing; the Zoho settings in `.env` (section 6). Jobs wait, nothing is lost. |
| A visitor says their saved rooms are gone | Rooms belong to the browser that made them ("Keeping the open studio safe"): a new browser, device or cleared cookies means a new, empty list. Rooms from before the shield have no owner and are hidden. |
| Visitors get "Please wait a few minutes" | They reached a `STUDIO_LIMIT_*`. Raise it in `.env`; behind a proxy check `TRUST_PROXY` so visitors are not counted as one address. |
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

* **The enquiry form sends nothing.** "Start a project" (the header pill, the hero, the footer circle, the menu) leads to the form at the end of the landing page. Filling it in and pressing "Send enquiry" shows "Enquiry received… a project lead will call you within one working day", but the page makes **no request at all** (checked: no network call, no form action), so the enquiry is lost. It needs a destination of your choosing (an email address, a CRM, WhatsApp); nothing was invented here. (Sign-ups made through the sign-in go to the CRM queue; the enquiry form is a separate thing and is still not connected.)
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
