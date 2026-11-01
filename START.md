# Starting Terucon

Quick commands. Full guide: `docs/HOW_TO_RUN.md`. Full reference: `README.md`.

Needs Node 20 or newer. Python 3.10+ is only needed for the optional scan models.

## 1. Website and Design Studio (terminal 1)

```bash
cd /Users/mayank/XTRA/terucon
npm install
npm start
```

Open http://localhost:8080 (not the HTML files directly). Stop with `Ctrl+C`.

The root `.env` is optional (the defaults work): `cp .env.example .env`.
The studio's settings live in `swatchroom/.env` (copy `swatchroom/.env.example` if missing).

**Signing in on your own computer.** Every page but the landing page asks you to sign in. On your computer that needs nothing set up: the one-time codes are printed in the terminal where `npm start` runs (look for `[development] e-mail code for you@example.com (login): 123456`). Two things can still get in the way:
* **No local MongoDB running?** Accounts are kept in the studio's MongoDB, so every page says sign-in is not available. Add `AUTH_STORE=memory` to `.env` (accounts then disappear when you stop the server), or start MongoDB.
* The banner when the server starts says what is missing (`Sign-in: ...`).
To send real e-mails or texts, to use Google, or to connect Zoho, see `README.md` ("Sign-in, accounts and the CRM") and sections 5 and 6 of `.env.example`.

## 2. Local scan models (terminal 2, optional)

Needed for the studio's Pick tool. Without them, scans fall back to Gemini outlines.

```bash
cd /Users/mayank/XTRA/terucon/swatchroom/python
python3 -m venv .venv && source .venv/bin/activate                                 # once
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu     # once
pip install -r requirements.txt                                                    # once
cd ../.. && npm run models                                                         # every time, venv active
```

## 2b. Inspiration import: paste a link, crop, send to the studio (optional, once)

Needs Python 3.9+ for gallery-dl, which reads Pinterest, Unsplash, Pexels, Flickr, Behance, Imgur and Wikimedia Commons. Picture links and ordinary web pages work without it; the sites above then say "not set up".

```bash
cd /Users/mayank/XTRA/terucon
python3 -m venv python/.venv && python/.venv/bin/pip install -r python/requirements.txt    # once; then restart npm start
```

Try it: open http://localhost:8080/inspiration, or paste a link into the Materials search box. To check one address by hand: `python/.venv/bin/python -m gallery_dl --config-ignore -j <address>`. See `README.md` ("Inspiration import").

## 2c. Catalogue: Finder and catalogue admin (optional, set up once; nothing to keep running)

The Finder (`/finder`) and the catalogue admin (`/admin/catalogue`) need a Modal app, a Google Cloud bucket and the studio's MongoDB. No extra terminal: the Modal app is deployed once and sleeps when idle. Until it is set up `/finder` says the catalogue is not switched on. Step by step: `docs/CATALOGUE_SETUP.md`; the settings: `.env.example` section 8. To bring in the notebook's output you uploaded to the bucket yourself: `cd catalogue && modal run modal_app.py::import_bundle --catalogue <id> --key imports/<id>/<name> --activate --create "<name>"`.

## 3. Pages

| Page | Address |
|---|---|
| Landing page | http://localhost:8080/ |
| Materials shop | http://localhost:8080/materials |
| Design Studio | http://localhost:8080/design-studio |
| My project | http://localhost:8080/my-project |

## 4. Other commands

```bash
npm run dev          # server with auto-restart on changes
npm run build:site   # rebuild pages/ from pages_original/ and site/patches/
npm test             # site build check, link check, overview check, JS tests
npm test -- --e2e    # plus browser tests (needs Chrome; once: cd tests/e2e && npm install)

# try it with no credentials (mock GPU services, no database, studio passcode "letmein" switched on for the test)
node tests/dev/stack.mjs --port 8765 --passcode letmein
```

## 5. Quick fixes

| Problem | Fix |
|---|---|
| `Could not start on port 8080` | Change `PORT` in `.env` |
| `Cannot find module 'mongoose'` | Run `npm install` in the project folder |
| Studio says "AI off" | Check `GOOGLE_APPLICATION_CREDENTIALS` in `swatchroom/.env` |
| `MongoDB is not reachable` | Check `MONGODB_URI` in `swatchroom/.env` |
| `Scan model service … is not running` | Start step 2, or ignore (Gemini fallback) |
| `421 Unexpected Host header` | Use `localhost`, or add the name to `ALLOWED_HOSTS` |
