# Swatchroom upgrade: what was done, what is running, what you still have to do

Written 2026-10-26. Nothing described here is committed or deployed: it is all in your working tree
(82 changed or new paths). No `modal deploy` / `modal run` was ever executed, no live Modal endpoint was called, and the
repo's `.env` (live Atlas / Modal / Vertex) was never used to start anything for testing.

Longer, file-by-file detail is in `ARCHITECTURE.md`; deployment detail is in `DEPLOY.md`.

---

## 1. Your three observations, answered

| You saw | Why | What changed / what you must do |
| --- | --- | --- |
| **SegFormer-B4 is still used locally** | The code now asks the Python service for `b5-quant`, but the service must be **started from this checkout**. When I looked, **no Python service was running at all** (nothing on `127.0.0.1:8001`), so I cannot tell which of three things you saw: (a) an **old service process** (the old code silently treated the unknown name `b5-quant` as B4; fixed in `python/scene.py`), (b) the **first-run B5 download** (the cache shows a B5 download running 12:47-12:54 today, probably the new service preloading; until it finishes the first scan waits or is answered by B4), or (c) the **new fallback**: if B5 cannot be downloaded or loaded the service answers with B4 and prints why in the Python terminal. Look at that terminal and at the owner dot's "Last scan" line (it says "B5 could not load" in case (c)). With the repo's own `python/.venv` (Python 3.9, torch 2.8) the new service answers `b5-quant` with **real SegFormer-B5, fp32 on Apple's MPS, 2.9 s for a 1920 px photo** (measured). B5's weights (339 MB) are now in your local Hugging Face cache. | **Restart the service from this checkout:** `cd python && .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8001` (the repo's own venv; `npm run models` uses whichever uvicorn is first on your PATH), wait until `http://127.0.0.1:8001/health` lists `...segformer-b5...` under `sceneLoaded` (about 45 s), then reload the studio tab (hard refresh). New: the server now **prints at start** whether the service is reachable, whether it is an old build, and which model it will use; the owner dot's "Last scan" line names the model that actually answered ("SegFormer-B5 (fp32, mps)"), and says "B5 could not load" if it fell back to B4. |
| **OneFormer is never called** | Two things have to be true and neither is: (1) **`ONEFORMER_URL` (and `ANALYZE_URL`) are not in your `.env`** (only the three old `SAM3_URL` / `MOGE2_URL` / `MARIGOLD_URL` are), so the browser never starts the OneFormer side of the race; (2) **OneFormer does not exist on Modal yet**: your deployed `/Users/mayank/XTRA/modalDeployment/vision_stack.py` is still the old three-model file. I did not deploy, because a deploy builds images on Modal and changes what you pay for. | Deploy the new blueprint, then put the two URLs in `.env` (steps in section 4). I can run the deploy for you if you say so. New: the server start-up message says "ONEFORMER_URL is not set ... OneFormer is never called", and the owner dot lists **OneFormer** and **Room analysis** as "not set up: add ONEFORMER_URL to .env". |
| **The WebGL preview is not visible** | I could not reproduce "never visible": in a real-GPU browser (Apple M5, Metal) the preview is visible on the page, desktop and phone, WebGPU and WebGL2, for landscape, portrait, 12 MP and EXIF-rotated photos. But testing with **real MoGe-2 depth and real Marigold shading** (generated locally for the test photo) found a real bug: after the room analysis arrives, a surface whose fitted plane scored below 0.45 got **no preview at all, silently**. The biggest wall (a wall with a TV niche) scored **0.425**; furniture, curtains and windows have no fitted plane. Only the floor, ceiling and some walls previewed. | **Fixed:** walls, floors and ceilings with a weak fit now fall back to the outline-based estimate (shown, approximate) instead of nothing; the threshold default is 0.3 (was 0.45) and your saved settings are migrated. Re-checked with the real data: every wall, the floor and the ceiling now preview. **Still by design:** furniture, curtains and windows are not planes, so picking a finish for them shows no instant preview; the "Render" button (Gemini) does those. |

If after restarting the service and hard-refreshing you still do not see it, look at the browser console and the
owner dot (open `/admin` once, sign in, open the studio) and tell me what the card says; I could not see your browser.

---

## 2. What was built (the six workstreams)

1. **OneFormer on Modal + local B5.** `modalBlueprint.py`: `/v1/parse` with `/v1/oneformer` alias and `/healthz`;
   `server/lib/remoteModels/oneformer.js`; `server/lib/ade20k.js` translates the ten class names where OneFormer and
   SegFormer disagree ("tv" vs "television receiver"...). Local: `python/scene.py` serves SegFormer-B5 (`?model=b5-quant`,
   default), INT8 only where a timed pass shows it is faster (x86; Apple Silicon stays fp32 because torch's ARM INT8
   measured 30-40x slower), fp16 on CUDA. New: if B5 cannot load, B4 answers and says so (`fellBackFrom`); B5 is only
   loaded where the memory limit is at least `SCENE_B5_MIN_GB` (3), because B4 alone peaked at 1.6 GB.
2. **Splash + 10 s gate + race.** "Powered by Terucon India" splash, strict 10 s gate that records `modalIsWarm`;
   `segmentRace.js` runs local B5 and OneFormer together when Modal is cold, remote first when warm; the late HD scan is
   offered as "HD Surface Scan Ready (Higher Accuracy) - Tap to Apply" (auto-applied when nothing was edited yet).
3. **Instant preview (WebGPU / WebGL2).** Canvas follows the screen (DPR, at most 2048 px); every surface is a homography
   from its fitted plane, or from its outline before the room is analysed; 5-tap joint-bilateral edges; shading divided by the
   surface median (clamped 0.35-1.65); specular from Marigold's residual; mip-mapped textures; LRU texture cache with
   prefetch so a pick draws on the next frame; never starts a Gemini render. A real decoding bug was fixed on the way
   (Marigold's PNGs are max-normalised gamma 2.2; the old code read them as linear).
4. **SAM 3 / SlimSAM.** SAM masks are stored per photo version and reused for tap-to-calibrate, rug / furniture /
   picture carve-outs, wall-plane splits (OneFormer's panoptic output cannot separate wall planes) and refits; calibrated masks
   grow 0.2% for the Gemini mask.
5. **Geometry into the AI render.** Surface size in metres, normal, distance and field of view go into the Gemini brief;
   the live preview is blended at 35% into the guide image.
6. **Mobile.** iOS canvas cap 2560 px (3072 on other phones) with canvases released after use; touch magnifier
   (2.5x, 70 px above the finger, hold 220 ms or drag; a longer 650 ms press adds a surface to the selection).

## 3. Modal cost design (your hard rule: wake Modal as little as possible)

- `VisionAll`: MoGe-2, Marigold (lighting only), SAM 3 and OneFormer in **one** container behind one URL
  (`/v1/analyze` returns one zip). One photo = one cold start and one idle tail, instead of up to four pools.
  `VISION_LAYOUT=both|combined|split`; default `both` keeps your old URLs working (five classes deployed,
  `min_containers` 0 everywhere).
- "Is Modal warm?" is answered from the server's own record of its last Modal call; `/api/vision/warmup` never calls Modal.
  Nothing wakes on page load; only a scan asks for a wake-up. The admin dashboard no longer pings every pool every 30 s
  (it has an explicit Probe button).
- Measured in the isolated browser harness: a whole session = one cold start, one `/v1/oneformer`, one `/v1/analyze`,
  zero `/healthz`, also after the HD swap, plane splits, refits, taps and calibrations.
- The new server also works against the OLD Modal deployment (tested): separate pools, at most 8 SAM prompts, no OneFormer.
  So the server can be deployed before Modal is redeployed.

## 4. What you have to do

```bash
# 1. restart the local scan service from this checkout, wait for B5 to appear in /health
cd python && .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8001      # the repo's own venv; `npm run models` uses whatever uvicorn is first on PATH
curl -s http://127.0.0.1:8001/health        # sceneLoaded must list segformer-b5..., defaultModel must be b5-quant

# 2. restart the Node server (it prints what it will do at start: look for the [models] lines)
npm start                                    # then hard-refresh the studio tab (settings migrate automatically)

# 3. OneFormer + single-call analysis: deploy the new Modal file (costs money to build; I did NOT run this)
cd /Users/mayank/XTRA/modalDeployment
cp vision_stack.py vision_stack.py.bak
cp /Users/mayank/XTRA/terucon_swatchroom_demo/swarchroom-v5/swatchroom/modalBlueprint.py vision_stack.py
modal deploy vision_stack.py
# 4. put the two URLs printed by the deploy (the vision-all app) into .env, restart npm start:
#    ONEFORMER_URL=<.../v1/oneformer>   ANALYZE_URL=<.../v1/analyze>   (keys: see .env.example)
```

If `ANALYZE_URL` stays unset, every scanned photo still wakes the three separate pools. On Render's 2 GB plan the service
answers with B4 (memory guard); choose a 4 GB plan for B5.

## 5. Verification (what was actually run)

| What | Result |
| --- | --- |
| `npm test` | 12 Node suites and the 2 Python suites pass (Python suites need a venv with torch/transformers/fastapi/modal/httpx, otherwise they SKIP; run with `PYTHON=<venv python> npm test`) |
| Isolated browser harness (in-memory MongoDB, fake Modal, real server, Chrome on a real Apple GPU, phone and desktop) | scenarios A-F pass: cold Modal with OneFormer first; local first then HD banner/auto-swap; provisional -> fused preview with zero blank frames; the 10 s gate; warm + slow OneFormer; the new server against the old Modal deployment |
| Real data end to end (real B5 scan, real MoGe-2 depth, real Marigold shading, test photo, run on this Mac) | found and fixed the weak-fit bug above; all walls/floor/ceiling preview afterwards |
| Real B5 through your venv's service | 2.9 s per 1920 px photo on MPS; answers `b5-quant` with B5 |
| Finish swap latency (texture in memory) | renderer work about 0.1-0.2 ms (command submission); pointer-down to first changed frame 31-49 ms (the studio batches the pick into the next animation frame). "Under 16 ms" holds for the renderer, not for tap-to-pixels |

The harness lives in the Claude session scratchpad
(`/private/tmp/claude-501/-Users-mayank-XTRA-terucon-swatchroom-demo-swarchroom-v5-swatchroom/aa53a449-04a1-466f-94b7-1333568e7026/scratchpad/harness`),
not in the repo, so it will disappear with the temp directory.

## 6. Not verified (honest limits)

- No real Modal deploy or GPU run; real **SAM 3** output (gated weights) was never seen, only MoGe-2 and Marigold were run for real.
  OneFormer's real output has never been seen.
- B5 on a Linux CPU / Render (speed, memory); INT8 on x86; the 3 GB memory threshold is a cautious guess.
- A real iPhone / iOS Safari; any browser other than Chrome.
- Gemini render quality with the new brief and guide image (no Gemini call was made).
- Your actual browser session: I could not see it. If something still looks wrong, send the owner-dot card text and the console.

## 7. Where I departed from your spec

- The Modal route is `/v1/parse`, with `/v1/oneformer` as an alias.
- The landing-page "ping" is replaced by a passive check (an active probe exists behind `VISION_ACTIVE_WARMUP=on`).
- OneFormer's panoptic output cannot split wall planes, so wall splits come from SAM 3 + depth.
- Long-press multi-select moved from 480 to 650 ms (the magnifier starts at 220 ms).
- INT8 is skipped on ARM.
- Instant preview for furniture / curtains / windows is not provided (not planes); those go through the AI render.

## 8. Changed and new files (all uncommitted)

New: `ARCHITECTURE.md`, `UPGRADE_SUMMARY.md`; client `public/js/lib/{geometryFacts,hdSwap,morph,occlusion,planeSplit,platform,previewScene,samCalibrate,samLayer,segmentRace,startupGate}.js`,
`public/js/lib/fastrender/{geometry,lru,provisional,sizing,textureStore}.js`, `public/js/views/splash.js`; server
`server/lib/{ade20k,bootReport,planeSplit,samLayer,sceneNormalize,wake,warmth}.js`, `server/lib/remoteModels/{analyze,oneformer}.js`;
tests `tests/{fastrender,render_bridge,sam,startup_race}.test.js`, `tests/{modal_blueprint,scene_service}.test.py`, `tests/fixtures/`,
`server/lib/{planeSplit,vision}.test.js`, `scripts/run-python-tests.js`.
Changed: `modalBlueprint.py`, `python/{app,scene,pick}.py`, `server/{config,index}.js`, `server/lib/{coldStart,fusion.worker,healthChecks,pack,pipelineRunner}.js`,
`server/lib/remoteModels/{marigold,sam3}.js`, `server/routes/{admin,pipeline,session,vision}.js`, the studio client (`swatchroom-app.js`, `views/{stage,studio,dialogs}.js`,
`lib/{detect,vision,render,prompts,framing,images,settings,ownerSummary}.js`, `views/ownerDot.js`, fast-render renderer and shaders, `workers/scene.worker.js`, `core/api.js`, CSS),
`.env.example`, `render.yaml`, `DEPLOY.md`, `README.md`, `package.json`.

Stray files you may want to delete: `/Users/mayank/XTRA/modalDeployment/0` and `/Users/mayank/XTRA/modalDeployment/3+,` (empty, created Oct 25; I did not touch them).
