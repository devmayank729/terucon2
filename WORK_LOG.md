# Work log

A running record of the work done in this project, newest entry first. For every task it says **what was asked**, **what exactly was done** (in order, with the files and the commands), **what was checked and what was not**, and ends with **what I did** in a few plain lines. Only facts from the session's own commands and results; where something is not known, it says so.

This file is not `TARGETS.md` (that tracks the quotation's targets and their status) and not `WORK_REPORT.md` / `SESSION_OVERVIEW.md` (one-off reports of earlier sessions). Nothing in here is committed until you say so.

---

## 2026-11-03: What the Design Studio calls, and why (one verified document)

**Asked:** "what is the exact architecture? means how many calls it made to whom? suppose I upload a photo it make a call to oneformer, and in what scenerio the MoGe, SAM and all are called? and what if the photo is loaded from history then what happen? and why it take noticable time to load the selected design on the object? it freshly call moge and all or why? and sometime suppose I tap on floor and tap a design it get loaded like 2D and after sometimes it feels ki yes this is 3d otherwise it looks bad? what is the reason? give me a proper doc which give me detail about this AI design studio (if any .md file is already there copy them and add more answer to all the questions, given all the answer should be verified properly nothings should be pre-asumed or false claim", plus a console screenshot and "why it is showing too much calls? even though one times it was already completed?".

**Serves:** C1 (the Design Studio), and in passing F1a and I3 (read-only). No target status or count changes.

### What exactly I did, in order

1. Read `TARGETS.md`, `CLAUDE.md`, my memory notes (the studio is a verbatim copy: never edit `swatchroom/`; facts only; never print env values) and this file. Listed every `.md` in the repo: six belong to the studio (`swatchroom/{ARCHITECTURE,modal-latency-audit,swatchflow,DEPLOY,UPGRADE_SUMMARY,README}.md`).
2. Read the code that answers each question: the browser's scan, polling, history, calibration, version and render code (`studio.js`, `stage.js`, `detect.js`, `segmentRace.js`, `previewScene.js`, `fastrender/*`, `startupGate.js`, `swatchroom-app.js`), the server's routes and runner (`routes/{pipeline,vision,ai,rooms,session}.js`, `lib/{pipelineRunner,jobs,wake,warmth,fusionStore}.js`, `remoteModels/*`, `google/vertex.js`, `config.js`, the two models), and the website's own wake-up (`server/lib/swatchroom.js`, `server/routes/studio.js`, `site/patches/snippets/warmup.js`). Read all six existing guides.
3. Decoded the two job ids in your screenshot (they hold the creation time in base 36): `job-mw0nvkma-…` = 2026-11-03T12:25:49.090Z, `job-mw0nw8kd-…` = 12:26:20.125Z, 31.0 s apart.
4. Did a **names-only** check of both `.env` files (which model URLs are set, and only the Modal function label of each address, never a value): all five set, on five different Modal services; `ANALYZE_URL` set, so the three separate pools are not used by the pipeline.
5. Asked the advisor tool to review my plan. Its points that I followed: do not copy the old guides as if still true (they got a corrections table); run the real route and runner with stubs, with the addresses pointed at a closed local port **before** the config loads and `fetch` blocked; check the "history", "render version" and "reopen" cases; do not guess which action started the second job.
6. Wrote `docs/design-studio-checks/verify_pipeline.cjs` (loads the real `routes/pipeline.js` and `lib/pipelineRunner.js`; stubs the database models, storage, `fusionStore`, `fusion.runFitRegions` and the four model adapters) and `verify_preview.mjs` (loads the real `previewScene.js` and `fastrender/tiers.js`). **My first run gave wrong counts:** jobs queued by the route tests kept running in the background into the next test (it showed `analyze: 1` in a case that should have been 0). I fixed it by stubbing the runner during the route tests and re-ran everything; a later run also found a fifth route case (a second request during the local fitting stage creates a second job).
7. Wrote the document (`docs/DESIGN_STUDIO_ARCHITECTURE.md`): sections 1 to 11, then the six guides as appendices, copied by a script. Checked every `file:line` range I cited against the files (about a dozen ranges were off by a few lines and were corrected), and proved by script that each appendix equals its source once the heading shift is undone.
8. Copied the two scripts into `docs/design-studio-checks/` with project-relative paths and re-ran them from there (same results). Added both to `docs/overview/catalog/files.json` (my first tag, "Test", is not in the allowed list; used "Dev" and "Run"), rebuilt the overview, updated `TARGETS.md` (C1 "Remaining", the header line, the change log) and rebuilt the overview again.

### Files changed

- New: `docs/DESIGN_STUDIO_ARCHITECTURE.md`, `docs/design-studio-checks/verify_pipeline.cjs`, `docs/design-studio-checks/verify_preview.mjs`
- Edited: `docs/overview/catalog/files.json` (two entries), `TARGETS.md` (C1 Remaining, header, change log), `WORK_LOG.md` (this entry), and the file `node tools/build-overview.js` regenerates (`docs/PROJECT_OVERVIEW.html`)
- **Nothing under `swatchroom/` was touched; nothing committed.**

### Checked

- The call counts, the route's decisions and the runner's behaviour for five route cases and four runner cases (see section 4 of the document), by running the real code with stubs; 0 `fetch` attempts in the whole run.
- The estimate-versus-real-fit selection rule and the confidence bands, by running the real `previewScene.js` and `tiers.js` (the outline estimator itself is a stand-in).
- The six appendices are identical to their sources (script).
- Every cited line range.

### Not checked

- Anything live: no Modal, Gemini, MongoDB, PostHog or Render call.
- **Any browser behaviour.** I did not open the studio. So the client-side findings (a render version keeps the preview on the estimate; reopening the open room can skip the reload) are from reading the code, not reproduced.
- Which action started the second job in your screenshot, and whether the screenshot came from your Mac or from Render.
- Your Render settings (only your Mac's `.env` layout was read), and any latency (none measured).

### Noticed, left alone

- The older guides contradict the code in several places (poll interval, number of `ensureFusion` triggers, "nothing wakes on page load", the "0-byte" `modalBlueprint.py`); they are tabulated in section 10 of the document, not edited.
- The website wakes two different Modal services on page open, so "one cold start, one idle tail" does not hold with the current `.env` layout.
- Three possible gaps in the studio's 3D-data handling are in `TARGETS.md` under C1 "Remaining". They belong in your separate Swatchroom project, not in the copy here.

### What I did (summary)

I read the Design Studio's code end to end for the questions you asked, ran its real pipeline route and runner with every outside call stubbed to count what would be called, and wrote one document with the answers (each tagged by how it was checked) and your six existing guides copied in as appendices. The short version: a new photo costs two Modal requests (OneFormer for the scan, one combined MoGe-2 + Marigold + SAM 3 request for depth), one Gemini request and one local request; tapping, picking a finish and the repeated console lines never call Modal. The second job in your screenshot was a local-only refit. Opening a room whose saved current version is a render does call Modal again, and after a render the preview can stay on the estimate; both are from reading the code and still need a browser check.

---

## 2026-11-03: Sign-in page showed a huge Google logo for a moment, then shrank

**Asked:** "as soon as user land on login page, it show a very big google logo and after that it get adjusted. I know that is the time it take to load the css but I don't want that bad experience for that, resolve it properly", and from now on to keep a `.md` file of what exactly I did, ending with a summary.

**Serves:** F5 (modern frontend). The sign-in page is foundation work, not a quoted feature; no target status or count changes.

### What I found (the cause was not the one you guessed)

- It is not a slow stylesheet. Google's `gsi/style` file is 696 bytes and only styles the One Tap pop-up, not the button.
- Google's script first draws a **placeholder button on our page** (an `<svg viewBox="0 0 48 48">` with no width or height), and a moment later puts the real button in an iframe beside it. The placeholder's styles are an inline `<style>` element that Google's script injects. Our strict Content-Security-Policy (which the rest of the site depends on) refuses it: the browser logs "Applying inline style violates the following Content Security Policy directive 'style-src ...'" and the element never becomes a style sheet. So the placeholder stays unstyled and its logo fills the card: **309 x 309 px**, until the iframe replaces it (about 1.5 s on this Mac's fast connection; I did not time the old page on a slow connection).
- On your live site Google is the **only** way in (`/api/auth/config`: e-mail false, SMS false, Google true), so this is the whole sign-in screen.

### What exactly I did, in order

1. Read `TARGETS.md` (F5 and "Foundation work") and `CLAUDE.md`, as the project rules ask. Read `pages/login.html` end to end, `server/lib/csp.js`, `server/auth/config.js` and the Google nonce route.
2. **Reproduced it** with a scratch script (kept in the session's scratchpad, not in the project): the project's dev stack with Google switched on, headless Chrome, sampling the button every 50 ms. Result: a 309 x 309 logo inside a button box 309 x 356 px. Screenshots matched your description.
3. Tried to blame the stylesheet by holding `gsi/style` back for 2.5 s and then not at all: the logo was 309 px in both cases. That showed my first idea was wrong. I fetched Google's `gsi/style` and read it (696 bytes, One Tap only), read the console's CSP messages, and listed the page's style sheets: Google's button styles are an inline `<style>` that is in the page but not applied.
4. **Looked at your live site** with its real client id, read-only: loaded `https://terucon-vp0y.onrender.com/login` in headless Chrome and sampled, no clicks, nothing submitted. Same sequence: giant placeholder, then a 329 x 44 iframe button. I later measured the old page's card itself (390 px wide): it is 86 px tall, jumps to 398 px, then 438 px when the placeholder is drawn, and drops back to 86 px when the real button replaces it, so the content below the button jumped about 350 px twice.
5. Asked the advisor tool to review my plan before I wrote code. Its points that I followed: do **not** loosen the CSP or pin Google's style hash (Google's script is not versioned, so a hash would break silently); reserve the button's slot; hide the placeholder with the page's own CSS; and add a real failure path, because with Google as the only way in a button hidden forever would leave nobody able to sign in.
6. **Changed `pages/login.html`** (CSS, markup and script; no change to the CSP, to the server or to any other page):
   - A quiet placeholder pill (`.gskel`, 40 px, same width as the real button) inside a fixed 44 px slot (`.gslot`), so the card never changes height. The real button container starts hidden (`visibility:hidden`) and is only revealed when the iframe's `load` event has fired. A small CSS backstop caps any logo in that container at 24 px.
   - The reveal hides everything beside Google's iframe (Google leaves its placeholder next to the frame when it refuses the page's address; I saw that on localhost, where the unstyled placeholder showed through until I hid it).
   - Speed: the nonce request and Google's script now load **in parallel** instead of one after the other (one round trip less). No new request to Google that was not made before.
   - If the button takes longer than 12 s it says "Google sign-in is taking longer than usual. Try again" and still shows the button if it arrives later. If Google's script cannot be loaded at all: when Google is the only way in, the page says so in words with a "Try again" button instead of an empty card; when e-mail or SMS codes are also on, only the Google block goes away and the form stays.
   - A first version revealed the button 2.5 s after the frame appeared even if it had not loaded; the held-frame runs showed that exposes a blank frame on a slow connection, so I removed it.
7. **Added three browser tests** to `tests/e2e/run.mjs` (`sign-in page: ...`). They run offline: Google's script and frame are replaced by stand-ins that do what the real ones did (unstyled placeholder first, frame later, placeholder left in place). They check: no logo wider than 24 px is ever visible, the pill shows while loading, the card does not move, the real button replaces the pill (at 390 and 1440 px); the slow note and "Try again"; and the two failure cases. I also added an `E2E_ONLY="<text>"` filter to that file so a few tests can run without the whole suite.
8. **Checked that the tests catch the bug:** temporarily put the old `pages/login.html` (from git `HEAD`) back, ran the three tests (0 of 3 passed; the first says "a 309px Google logo was visible at 390px"), and restored my version (compared byte for byte).
9. Ran the full JavaScript tests and the full browser suite (results below).
10. After a review of my own claims, re-measured two things I had stated loosely: the old page's real `.card` height (86 px, then 398 px, then 438 px, then 86 px), and a screencast of the reveal on the live origin to look for an empty button slot (none; see Checked). Corrected the numbers in this file and in `TARGETS.md`.
11. Created this file, added it to `docs/overview/catalog/files.json`, updated `TARGETS.md` (F5, the "Last updated" line, the change log) and rebuilt the project overview (`node tools/build-overview.js`).

### Files changed

- `pages/login.html` (the fix)
- `tests/e2e/run.mjs` (3 new tests, the `E2E_ONLY` filter)
- `WORK_LOG.md` (new, this file) and `docs/overview/catalog/files.json` (one line for it)
- `TARGETS.md` (F5 paragraph, header line, change log) and the files `node tools/build-overview.js` regenerates

### Checked

- **Live origin, real Google, edited page** (my edited HTML substituted for the live `/login` in headless Chrome, so the real button and real client id were used; not the deployed file): no logo from Google's placeholder was visible in the page at any moment (widest visible logo in the page: **0 px** in every run; the real button's own G sits inside Google's frame, which that check cannot see); the card height stayed constant (86 px at 390 px wide, 106 px at 1440); the real button appeared after its frame loaded, in the same spot and size as the pill. Runs: no throttle; Slow-4G with the frame held 3 s; desktop 1440 px; frame held 15 s (the note showed at about 12 s, then the button still landed and the note went away); Google's script blocked (clear message and "Try again").
- **Local dev stack with Google's real script**: the same, and the placeholder is hidden even when Google leaves it beside a frame it will not show.
- **Full browser suite:** 41 of 41 passed (the 38 that already existed plus the 3 new ones). On the way, my first version of the "slow" test failed because of a mistake in the test (it released the held frame before the second frame had been requested); I fixed the test, not the page.
- **JavaScript tests:** 879 tests, 875 passed, 0 failed, 4 skipped, in each of 6 runs. Of the 4 skipped, 1 needs a real MongoDB (`AUTH_TEST_MONGODB_URI`) and 3 compare against a reference build from an earlier Python tool that is not on this machine (the skip message names a path from another computer). One earlier run of the same suite had 1 failure (see "Noticed").
- **Is there a blank moment when the pill is swapped for the button?** I recorded a screencast of the reveal on the live origin (no throttle, then Slow-4G) and classified the button slot in every frame: pill, then the pill still showing while the real button fades in over about 250 ms, then the real button (77% white interior with its text and G). No frame showed the slot empty (plain card colour). One live run per condition; my classifier is a colour check, and I looked at one crossfade frame by eye.

### Not checked

- **The fix is not on the live site.** Nothing was committed or deployed. Your live site shows the old behaviour until you commit and redeploy. The real-Google success path was proven only by substituting the page in Chrome, so confirm on the live site once after the deploy.
- A real phone, Safari (iPhone), Firefox, an in-app browser. Chrome headless only.
- That the `load` event of Google's frame fires on every browser the way it does in Chrome. If it did not, the page would show the "taking longer" note with "Try again" after 12 s rather than a broken button; I did not test that browser.


### Noticed, left alone

- On that page the heading's font (Zodiak) swaps from a fallback a moment after load. It is separate from the logo and I did not change it.
- On the live site Google is the only sign-in method, yet the page's lead text still reads "Use your e-mail address or mobile number. We will send you a one-time code, so there is no password to remember." That is wrong for the live configuration (you can see it in the screenshots). I did not change it; it is a wording decision for you (also listed under F5 "Remaining" in `TARGETS.md`).
- Google's own console lines ("Not signed in with the identity provider", FedCM messages, "origin is not allowed" on localhost) come from Google, not from us.
- In the first batch of JavaScript test runs one run had 1 failure that I did not capture; six later runs of the same suite had 0 failures. I did not find which test it was.

### What I did (summary)

I found that the big Google logo was not a slow stylesheet: it was Google's own placeholder button, which our security policy leaves unstyled until Google's real button arrives. I did not weaken the security policy. Instead the sign-in page now holds the button's place with a quiet pill of the same size, never shows Google's placeholder, and reveals the real button only when it has loaded, with no jump in the layout. If Google is slow or cannot load, the page now says so and offers "Try again" instead of leaving an empty card. I proved it against your live site's real Google button, added three offline browser tests that fail on the old page and pass on the new one, and kept this log. Nothing is committed or deployed yet.
