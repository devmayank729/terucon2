# Terucon model service

Everything about the models lives here, in Python: finding the surfaces in a photo (Gemini names and outlines them, an
optional SAM model sharpens the outlines, contour snapping slides every boundary onto the photo's real edge), the SAM
backends, the evaluation scripts that measured all of it, and the place for fine-tuning.

It runs as a small internal HTTP service. The website (Express, in the folder above) starts it as a child process and
forwards `/api/segment` and `/api/sam/*` to it; the website works without it (the Design Studio falls back to its
in-browser parser). You can also run it by itself: on a GPU box, in a notebook workflow, or just to poke at it.

```
model/
  terucon_model/        the package: __main__ app config envfile google_auth vertex   segment/ sam/
  eval/                 ground-truth evaluation (ADE20K), thin-structure scenes, SAM oracle
  finetune/             where fine-tuning goes (README only for now)
  tests/                unit + service + process tests, a mock Google (also runnable as its own process)
  requirements.txt      Flask, requests, google-auth, numpy, pillow, opencv
  requirements-sam.txt  + PyTorch and transformers, for SAM on this machine
```

## Run it alone

```bash
cd model
python -m venv .venv && source .venv/bin/activate        # optional but tidy; the website also finds model/.venv/bin/python
pip install -r requirements.txt                          # add requirements-sam.txt for SAM on this machine
cp ../.env.example ../.env                               # skip if the project already has a .env (see below)
python -m terucon_model
```

It must be started from this folder (`model/`) because the package is not installed anywhere. It reads the project's
`.env` (the file one level up), so the Google credentials are pasted once for the website and the model service alike.
Run with `MODEL_PORT=0` to get any free port. What you see:

```
Terucon model service 2.0.0
  Settings file:  /…/Terucon_2/.env  (found)
  Google: Vertex AI as swatchroom@my-project.iam.gserviceaccount.com  (project my-project, location global)
  SAM: off (optional; set SAM_ENABLED=true to use it)
  Segmentation: engine=auto, edge refinement=on, contour
  Listening on:   localhost:8081
  Press Ctrl+C to stop.
TERUCON_MODEL_READY http://127.0.0.1:8081
```

The human text is on **stderr**; stdout carries exactly one line, `TERUCON_MODEL_READY http://127.0.0.1:<port>`, printed
(and flushed) only after the socket is bound, with the real port. That line is what the website waits for. Log lines
(`segment 960x720  ok  …`, `google  gemini-…  ok  …`) go to stderr. SIGTERM and SIGINT shut it down cleanly.

```bash
curl -s http://127.0.0.1:8081/health
{"ok":true,"service":"terucon-model","version":"2.0.0","google":{"configured":true,"mode":"vertex","error":""},"sam":{"enabled":false,"status":"off",…},"segmentation":{"engine":"auto","edgeRefine":true,"edgeMethod":"contour","analysisMaxSide":1536}}
```

## Settings

Same `.env`, same variable names as the website; the real process environment wins over the file; the file is
re-read whenever it changes (no restart for credentials, models, segmentation, SAM settings, `ALLOWED_HOSTS` or the keys). Only `MODEL_HOST`
(which decides whether the Host check applies), `MODEL_PORT`, `MODEL_PARENT_PID` and `TERUCON_ENV_FILE` are read once, at start. A key given in the
process environment, which is how the website passes `MODEL_SERVICE_KEY` to the service it starts, wins over one in the file.

| Variable | Meaning |
|---|---|
| `TERUCON_ENV_FILE` | the env file to read. Default `<project root>/.env`; a relative path is relative to the project root. Comes from the process environment (it cannot name itself in the file). |
| `MODEL_HOST`, `MODEL_PORT` | where to listen. Defaults `127.0.0.1` and `8081`. `MODEL_PORT=0` = any free port (the website always starts it that way). |
| `MODEL_SERVICE_KEY` | optional shared secret. When set, every request must carry it in the header `X-Terucon-Model-Key`. |
| `MODEL_PARENT_PID` | when set, the service exits within about 3 seconds of that process disappearing (the website sets it to its own pid, so a `kill -9` of the website leaves no orphan). |
| `ALLOWED_HOSTS` | extra `Host` header values to accept (see Guards). |
| `GCP_SERVICE_ACCOUNT_JSON`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GEMINI_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI` | Google, exactly as in `.env.example`. Only the detection step calls Google from here (the Design Studio's renders go through the website's own Google client). |
| `SWATCHROOM_DETECT_MODEL` | the Gemini model that finds the surfaces (default `gemini-3.8-flash`; if a project cannot use it, a list of newer/older ones is tried and the response says which). |
| `SEGMENTATION_ENGINE`, `EDGE_REFINE`, `EDGE_METHOD`, `ANALYSIS_MAX_SIDE` | how surfaces are found (`contour` snapping by default, `watershed` as the earlier fallback). |
| `SAM_ENABLED`, `SAM_BACKEND`, `SAM_MODEL_ID`, `SAM_DEVICE`, `SAM_PRELOAD`, `SAM_MAX_SIDE`, `HF_TOKEN`, `SAM_CHECKPOINT`, `SAM_REPO_DIR`, `SAM_REMOTE_URL`, `SAM_REMOTE_KEY`, `SAM_REMOTE_AUTH_HEADER`, `SAM_SERVER_KEY` | the optional SAM model, see below. |
| `TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS`, `TERUCON_VERTEX_API_BASE` | tests only: point Google calls at a local mock. Without the first, a key whose `token_uri` is not googleapis.com is refused. |

The `.env` parser here and the website's are two implementations of one specification; `tests/fixtures/env-cases.json`
(one level up) holds the shared cases, and both test suites run them.

## Routes

All bodies are JSON. Every error, from a guard, a missing route or a failed scan, has one shape:
`{"error":{"code":<http status>,"status":"<GOOGLE_STYLE_STATUS>","message":"<plain language>"}}`.

| Route | What |
|---|---|
| `GET /health` | what is configured and how SAM is doing; never contains a secret |
| `POST /segment` | `{image: <base64 JPEG/PNG, up to 4096 px>, options?: {useSam, edgeRefine, model, location, hint}}` -> `{ok, width, height, labelMap:{encoding,data}, metas, scene, engine, model, notes, hints, timings, sam:{used,imageId}}`. 503 `FAILED_PRECONDITION` when Google is not configured (without calling anything), Google's own status when Gemini refuses, 422 when it finds no surfaces. |
| `GET /sam/health` | `{status, model, backend, device, interactive, text_prompts, error}` |
| `POST /sam/refine` | click(s) or a box -> mask (the Pick tool). `{image or image_id, points, labels, box}`; 409 when the cached `image_id` is gone (send the image again). |
| `POST /sam/segment` | text concepts -> masks; 501 for backends that only take clicks and boxes (SAM 2). |

These are the old `/api/segment` and `/api/sam/*` of the Flask server with the `/api` prefix dropped, and request and
response bodies unchanged. The service serves no pages and sends no CORS headers.

### Guards (every request, in this order)

1. **Host** must be `localhost`, `127.0.0.1` or `[::1]` (any port), or listed in `ALLOWED_HOSTS` (a name, or `name:port`), else 421. Skipped when
   `MODEL_HOST` is `0.0.0.0` or `::` (a service listening on every interface cannot know its own names; the key is what protects it, and the
   start-up banner warns when none is set).
2. **Key**: with `MODEL_SERVICE_KEY` set, `X-Terucon-Model-Key` must match (constant-time comparison), else 401 `UNAUTHENTICATED`.
   The `/sam/*` routes additionally accept `SAM_SERVER_KEY`, as `x-api-key` or `Authorization: Bearer <key>`, either one of the two being enough.
3. A POST/PUT/PATCH/DELETE must be `application/json`, else 415.
4. A body over 80 MB is 413 (decided from `Content-Length` before the route runs).

The guards run before routing, so a stranger without the key gets 401 for a route that does not exist as well.
Unknown routes are a JSON 404, a wrong method a JSON 405 (with `Allow`), and an unexpected failure a JSON 500 that leaks nothing.

## SAM: this machine, a GPU, or somewhere else

SAM does one job: it corrects the rough outlines Gemini draws near their own edges, and its boundary counts as extra
evidence for the edge snapping. **Off by default**; scans work without it. Details and measurements are in the project README (sections 2 and 3).

| You have | Set in `.env` | Notes |
|---|---|---|
| Just this computer | `SAM_ENABLED=true` | SAM 2.1 on the CPU. `pip install -r requirements-sam.txt` first. The first start downloads about 180 MB. Loading happens in the background, `/health` shows `sam.status` going `loading` -> `ready`, and the service answers meanwhile. |
| A GPU computer | `SAM_ENABLED=true`, `SAM_BACKEND=sam3`, `SAM_CHECKPOINT`, `SAM_REPO_DIR`, `HF_TOKEN` | Meta SAM 3 through the official `sam3` package. Text-prompted. Written to match the earlier benchmark scripts, never run here (needs CUDA and the gated checkpoint). |
| A GPU somewhere else | on the client: `SAM_ENABLED=true`, `SAM_REMOTE_URL=http://gpu-box:8081/sam`, `SAM_REMOTE_KEY=<key>` | On the GPU box run **this service on its own**: `MODEL_HOST=0.0.0.0 SAM_ENABLED=true SAM_SERVER_KEY=<key> python -m terucon_model`. The remote client sends the key as a bearer token (or `x-api-key` with `SAM_REMOTE_AUTH_HEADER=x-api-key`), which is what `/sam/*` accepts as `SAM_SERVER_KEY`. Google credentials are not needed on that box: only `/segment` calls Google. |

Two things to know about the remote setup. The service speaks plain HTTP: the key travels in clear text, so use a private network, an SSH tunnel
or a TLS proxy in front. A full website on the GPU box is the other option (`SAM_REMOTE_URL=https://gpu-box:8080/api/sam`): there the website checks `SAM_SERVER_KEY`
on `/api/sam/*` and forwards to its own model service. That part is the website's behaviour and is not tested from this folder.

The website talking to a model service that runs elsewhere (not SAM only) is the website's `MODEL_SERVICE=external`, `MODEL_SERVICE_URL`,
`MODEL_SERVICE_KEY`; the same key must be set on the service.

## Evaluation

`eval/` holds the scripts that produced the numbers in the project README. They import the same `terucon_model.segment` code the service runs and work from
`model/`, from the project root, or from anywhere (each puts `model/` on `sys.path` itself).

| Script | What | Needs |
|---|---|---|
| `eval/ade_subset.py` | builds the ground-truth photo set from an ADE20K validation shard | `pip install pyarrow`, the parquet file (183 MB) |
| `eval/refine_eval.py` | IoU and boundary F1 of every route (raw outline, contour snapping, earlier watershed, SAM) on degraded ground-truth outlines | the set above; `--sam` also needs `requirements-sam.txt` |
| `eval/sam_oracle.py` | SAM's ceiling when prompted from the true masks, and how often the agreement check refuses an outline | the set above, SAM |
| `eval/segformer_baseline.py` | the in-browser SegFormer engine and its class mapping, on the same set | the set above, PyTorch and transformers |
| `eval/thin_scenes.py [accuracy\|speed\|both]` | thin structures (chair legs, railings) and speed on synthetic scenes | nothing: no download, about 10 s for `accuracy` |

Run any of them with `--help`. They were copied with only their import paths changed (plus `ade_subset.py` importing pyarrow after the arguments are parsed, and `thin_scenes.py` printing its usage for an unknown mode); `thin_scenes.py accuracy` prints identical results from the old and the new location.

## Tests

From the project root:

```bash
python -m unittest discover -s model/tests -t model          # npm run test:model does the same
```

or `cd model && python -m unittest discover -s tests`. No credentials, no GPU, no network: Google is a mock, SAM is a stand-in. About 35 s.

| File | What |
|---|---|
| `test_snap.py` | contour snapping on small synthetic photos with exact ground truth |
| `test_segmentation.py` | `/segment` and `/sam/*` through Flask's test client against the mock Google and fake SAMs (edge snapping, SAM agreement, model chain, structured-output fallbacks, SAM 3 style text prompts, hot reload) |
| `test_config.py` | the `.env` parser and `Settings`, driven by the shared `tests/fixtures/env-cases.json`, plus `TERUCON_ENV_FILE` and the `MODEL_*` variables |
| `test_vertex_client.py` | the Google client called directly: retries, `Retry-After`, 401 refresh, the 504 that is not retried, the 330 s cap, rejected-key and clock messages, API-key mode |
| `test_service.py` | every guard, the 404/405/413/415/500 shapes, `/health`, `/segment` without Google, both ways of authenticating `/sam/*`, a real `RemoteBackend` talking to the service, `serve()` |
| `test_process.py` | really spawns `python -m terucon_model` (cwd `model/`, explicit environment, temp env file, port 0): the READY line, `/health` over HTTP with and without the key, SIGTERM/SIGINT, the parent watchdog (including a SIGKILLed, unreaped parent), and a scan against `mock_google_server.py` |

`TERUCON_HEAVY_TESTS=1` adds one test that downloads and runs the real SAM 2.1 on the CPU. No test can touch the real `.env`:
`tests/support.py` turns an attempt into a failure, and every app and process is built from a temp env file and an explicit environment.

### The mock Google as a process

```bash
python model/tests/mock_google_server.py [--port 0] [--jitter 14]
MOCK_GOOGLE_READY base=http://127.0.0.1:41233 sa=/tmp/terucon-mock-google-ab12cd/service-account.json
```

It makes a throw-away service-account key whose `token_uri` points at itself (the token endpoint verifies the RS256 signature), answers Gemini the way the
synthetic room photo needs (outlines for detection, a tinted copy for renders, JSON for quantity estimates), and serves until it is killed (SIGTERM removes the key).
`GET <base>/__calls` lists what it was asked. To use it, start the website or this service with `GOOGLE_APPLICATION_CREDENTIALS=<sa>`,
`TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS=1` and `TERUCON_VERTEX_API_BASE=<base>`. `--jitter` sets how far its outlines drift from the true ones (0-1000 scale; 0 = exact).

## What is not verified

* No call to real Google was made from here: the Google path is tested against the mock only (it checks the RS256 request, Vertex's URL and headers, retries, error
  pass-through and the model and request-shape fallbacks).
* No real SAM weights were run in this migration. SAM 2.1 on the CPU was run for real when the code was written (the heavy test and `eval/` do it again on request);
  SAM 3 was never run (CUDA and a gated checkpoint).
* The parent watchdog's Windows branch (`OpenProcess`) is written but could only be read, not run, on this Linux machine; SIGTERM semantics on Windows differ too, and
  the signal tests are skipped there.
