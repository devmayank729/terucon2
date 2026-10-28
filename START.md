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

## 2. Local scan models (terminal 2, optional)

Needed for the studio's Pick tool. Without them, scans fall back to Gemini outlines.

```bash
cd /Users/mayank/XTRA/terucon/swatchroom/python
python3 -m venv .venv && source .venv/bin/activate                                 # once
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu     # once
pip install -r requirements.txt                                                    # once
cd ../.. && npm run models                                                         # every time, venv active
```

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
