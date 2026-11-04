# Work log

A running record of the work done in this project, newest entry first. For every task it says **what was asked**, **what exactly was done** (in order, with the files and the commands), **what was checked and what was not**, and ends with **what I did** in a few plain lines. Only facts from the session's own commands and results; where something is not known, it says so.

This file is not `TARGETS.md` (that tracks the quotation's targets and their status) and not `WORK_REPORT.md` / `SESSION_OVERVIEW.md` (one-off reports of earlier sessions). Nothing in here is committed until you say so.

---

## 2026-11-04 (third session): the catalogue in the AI Design Studio, pictures from Cloud Storage and MongoDB, Gemini details and a better render prompt, TeruBot the same everywhere

**Asked:** (1) the catalogue is not in the AI Design Studio (only a few built-in finishes are): put it there, properly, with its photos; (2) the photos must not live on the server: fetch them from GCP and MongoDB; (3) use Gemini to add a little more detail about each product, and make the render prompt so good that texture and design come out right; (4) TeruBot is not the same everywhere (Talk is missing in the AI visualizer): make it constant.

**Serves:** C1 (render), A1 (shop), D1 (catalogue data), C4 (Finder pictures), C5 and C9 (TeruBot), F5. No status or count changed.

**How I read (1):** "pre-rendered photos" = the studio's built-in finishes (drawn in code, 28 MB of generated textures under `swatchroom/public/textures`); the catalogue's 63 real photographs are what was missing. I added the catalogue to the studio next to them and left the built-in ones as they are. If you meant the other direction (the built-in finishes into the catalogue), tell me.

**Why this was bigger than it looks:** `swatchroom/` is a verbatim copy that is not edited, so everything had to be done from outside it: a replacement loader for the studio page, a script that adds finishes to the studio's own list while it is not yet running, a server step in front of the studio's render route, and CSS for TeruBot above the studio's full-screen view. The picture change touched the shop, TeruBot, the Finder and the build tools. Three things went beyond the ask and can be dropped: the A/B render check with the real image model (6 renders), the browser test that compares TeruBot on nine pages, and the document `docs/CATALOGUE_STUDIO.md`.

### What exactly I did, in order

1. Read `TARGETS.md`, `CLAUDE.md`, my notes, `swatchroom/public/js/lib/{render,prompts,ai}.js`, `swatchroom/server/routes/ai.js`, `server/google/vertex.js`, `public/js/data/catalog.js`, `views/finishes.js`, `views/swatch.js`, the website's `app.js`, `server/catalogue/*`, `server/routes/media.js`, `site/brand/terubot.{js,css,md}`. **Findings:** the studio sends Gemini a photo, a mask, a guide image and a text brief and **no picture of the material**, so a design it cannot draw was only a name and a sentence to the model; the studio's finish cards are code-drawn SVG with no picture type; `findItemKind`'s check drops a selected finish whose kind is not the clicked surface's; the studio builds its index of finishes once, on first use; the studio and Finder pages sent `Permissions-Policy: microphone=()` (the studio's own header, copied into `site/site.json`), which hid TeruBot's dictation and Talk; the studio's full-screen view puts its host at `z-index: 90`, above TeruBot's launcher (46) and panel (85), and TeruBot's CSS also switched itself off there.
2. **TeruBot (point 4).** `site/site.json`: `microphone=(self)` for the studio and the Finder. `site/brand/terubot.css`: TeruBot raised above the studio's full-screen view (launcher and scrim 95, panel 96); on a phone the launcher is a 44 px round button under the studio's top bar (checked against the bottom sheet in screenshots at 390 and 360 px; the first screenshot showed the launcher was *behind* the studio, which is how I found the z-index). Tests: updated the two that asserted the old behaviour (`tests/js/server-delivery-pages.test.js`, `tests/e2e/run.mjs` voice and full-screen assertions); new browser tests: one opens nine pages and compares the launcher, panel, Talk, dictation, attach, New chat and Close (**it fails with the old header**: I put the old header back, ran it, saw `talk:false, dictation:false` on the studio, restored the file from a saved copy and checked both lines), one for the studio's full-screen view on a phone. Docs: `site/brand/terubot.md`.
3. **Pictures (point 2).** Read one live item (read-only): the engine had already stored a 320 px thumbnail and a 2 MB crop per page in the bucket, plus an older Gemini caption (38 of 68 came out as "laminate": not trusted). New `server/catalogue/designs.js` (designs from MongoDB, grouped by product id; pictures from the bucket through the existing signer, kept in memory only, 32 MB at most), new `server/routes/catalogueMedia.js` (answers `/media/materials/tipl-*.jpg`, registered in `server/routes/media.js` before the static route). Because the address did not change, the shop, TeruBot and the Finder needed no change except `server/lib/terubot/images.js` and `server/lib/shopLink.js` (thumbnail for cards) and `tools/extract-products.js` (a design's picture is recognised by its id, not by a file on disk; `products.json` byte-identical after the change). New `tools/publish-shop-images.js` (dry run by default, backup, read-back check, undo): **live run: 63 pictures uploaded to `cards/superbond-colour/` in your bucket, each downloaded again and compared by sha256, `shopImage` recorded on 63 MongoDB items.** Then a live check of the real server code against the real services (the first picture 2.4 s including the connection, 1 ms from memory; `?w=320`; 304; 404 for an unknown design; 63 finishes listed). Then deleted the 63 local files from `media/materials/` (tracked in git, identical to HEAD, verified first).
4. **Gemini details (point 3, first half).** New `tools/describe-designs.js` (calls the studio's own Vertex module; dry run by default). The prompt tells Gemini to describe appearance only, never what it is made of, its size, performance or price, and to ignore the photograph's lighting; every answer is checked in code. Preview on six designs first and compared three of them with their pictures by eye (they matched). **Two corrections from that:** my filter refused "copper" and "bronze" (a copper-look design talks about copper as a colour): now metals may be named as colours, "made of" may not; and Gemini baked the photo's own lighting gradient into the instruction: the prompt now says to describe the material, not the photograph. A transient "could not reach Vertex AI" error is retried once. **Live run: 63 of 63 described and recorded** (`studio` on each item, an export to `catalogue/data/superbond-colour-detail.json`). **A mistake of mine:** the second run overwrote the first run's backup file (the name had only a date). I rebuilt a truthful backup (no item had `studio` before today) and made every backup name unique. I read all 63 descriptions: they follow the pictures; `STC9050 "Twilight Black"` is described as rust-orange because its picture is (see "Noticed").
5. **Shop text.** `tools/build-shop-catalogue.js` reads the export and puts the sentence into each product's description and four rows (colours, pattern, sheen, surface) into its specification table, labelled as AI-written from the picture; rebuilt the snippet, the pages, `server/data/products.json` (so TeruBot reads them), `dist/` and the page golden.
6. **Studio group (point 1).** `server/catalogue/studioFinishes.js` (the finish for the list, the brief, the four reference rules, the code that adds the photograph to a request), `GET /api/catalogue/studio-finishes` in `server/routes/catalogue.js` (an empty list with a state, never an error, when the catalogue is off or down), `site/catalogue-ui/studio-finishes.js` (adds the group to the studio's own list, per surface kind, and puts the photo on the card), a patch step `catalogue-loader` (`site/patches/studio.json`, `site/patches/snippets/studio-loader.js`) that replaces the studio's one-line loader. **A mistake of mine caught by the browser test:** my first loader used `import("/catalogue-ui/…")`, which cannot resolve in the blob address the loader runs from (the original uses `new URL(…, window.location.href)` for that reason); the error was swallowed by my own fallback and the studio opened without the group. Fixed; the test now asserts an absolute address.
7. **Render prompt and reference (point 3, second half).** `server/lib/studioReference.js` in front of the studio's `/api/ai/generate` (mounted in `app.js` after the shield, before the studio): it reads the body with the studio's own limit (`aiBodyLimit` added to `server/lib/swatchroom.js`), and for a render with the marker `[[terucon-design:TIPL-SB804]]` appends the design's 800 px picture as the last image, adds four rules to the system prompt (numbered from the number of images actually sent: Image 4, or Image 3 for the lite model), adds a line to the brief and removes the marker; anything missing leaves the render going on the text brief alone. **Checked against the real studio route** (body-parser skips a request that is already read: the test sees four images arrive at Google's request builder).
8. **A/B check with the real image model** (the studio's own `renderBrief`, system prompt and `imageBodies`; one clinic photo, one wall, the same mask): A name and colour only, B Gemini description without the picture, C description plus the picture. Two designs (marble, teak). Built side-by-side crops with the real sample; C was closest in both (details in `docs/CATALOGUE_STUDIO.md`). A quota error stopped the first teak runs; I reran them one at a time. Kept the evidence in `docs/design-studio-checks/catalogue-reference/` and the script as `tools/compare-design-render.mjs`.
9. **Tests.** Updated on purpose: `site-patches` (the loader is now patched, the snippet list, one anchor that now occurs twice), `terubot-data` (a design's picture is no longer a file), the overview's API catalogue (two routes). New: `tests/js/catalogue-designs.test.js` (14), `tests/js/studio-reference.test.js` (14), 3 browser tests (studio group, TeruBot on nine pages, the studio full screen on a phone). Results below.
10. Docs: `docs/CATALOGUE_STUDIO.md` (new), `catalogue/ARCHITECTURE.md` 4.4 (the two new fields), `site/brand/terubot.md`; `TARGETS.md`; this file; rebuilt the overview; a memory note.

### Files changed

New: `server/catalogue/designs.js`, `server/catalogue/studioFinishes.js`, `server/lib/studioReference.js`, `server/routes/catalogueMedia.js`, `site/catalogue-ui/studio-finishes.js`, `site/patches/snippets/studio-loader.js`, `tools/publish-shop-images.js`, `tools/describe-designs.js`, `tools/compare-design-render.mjs`, `catalogue/data/superbond-colour-detail.json`, four backups in `catalogue/data/backups/`, `docs/CATALOGUE_STUDIO.md`, `docs/design-studio-checks/catalogue-reference/` (2 images), `tests/js/catalogue-designs.test.js`, `tests/js/studio-reference.test.js`.
Changed: `app.js`, `server/lib/swatchroom.js`, `server/catalogue/index.js`, `server/routes/{catalogue,catalogueUi,media}.js`, `server/lib/shopLink.js`, `server/lib/terubot/images.js`, `site/site.json`, `site/brand/terubot.{css,md}`, `site/patches/studio.json`, `tools/{build-shop-catalogue,extract-products}.js`, `catalogue/ARCHITECTURE.md`, the generated `pages/*.html`, `server/data/products.json`, `site/patches/snippets/shop-catalogue.js`, the golden, `docs/overview/catalog/api.json`, tests, `TARGETS.md`, this file.
Deleted: the 63 `media/materials/tipl-*.jpg` (in git HEAD). **`swatchroom/` was not touched** (the nine files it shows as modified are the ones that were already modified when this session began: the studio panel and preview-reason change you approved earlier).

### Checked

- The full JavaScript run, `node tools/run-tests.js` (it also checks the site build, the links, that the project overview is current and the optimised images): **1047 tests, 1043 passed, 0 failed, 4 skipped** (the same four as before), all steps passing. First run before my fixes: 4 failures, all consequences of my changes (the overview's route list lacked two routes, the studio's loader is now patched, the snippet list, a design's picture is no longer a file); a fifth, a test anchored on `import(new URL(` which now occurs twice in the loader, showed on the second run. All five fixed on purpose, not to turn them green: each assertion now says what is true.
- The full browser run: **86 tests, 85 passed, 1 failed**; the failure was the shop test that expected a design's picture as a file (what point 2 removed). I rewrote it (the shop asks the catalogue route for the picture; with nothing to read, the route answers a quiet tile, `no-store`, never a broken image) and ran it alone: it passes. **I did not repeat the whole browser run after that one test changed.** New browser tests: the studio's catalogue group (five situations: on, off, refused, unreachable, slow), TeruBot compared on nine pages (shown to fail on the old header), the studio's full-screen view on a phone.
- Live, with your `.env` (read in memory, nothing printed): the bucket upload and read-back (63 of 63 by sha256); the real server code serving the pictures through MongoDB and Cloud Storage; 63 Gemini description calls; 6 real image renders.
- Screenshots looked at: the studio on a phone with the launcher and the panel; the real design pictures; the 3-variant montages for two designs.

### Not checked

- The studio's new group in a real browser against the real server (the browser test stubs the finish list and the pictures); a render of the other 61 designs, a door or a cabinet front, a second room; the instant preview (these designs have none, by design).
- A real phone (iPhone Safari, Android) for any of it: the full-screen launcher, Talk, dictation, the studio cards. Talk and dictation in the studio were checked with the same stand-in speech recogniser as everywhere else, not a real microphone.
- Reopening a saved room that has a catalogue finish; an ingest of the PDF again (the fields are meant to survive it); the shop with 63 pictures read through the server on a slow line; Render (it needs `CATALOGUE_GCS_KEY_JSON`; without it every design shows a quiet tile).
- Whether Gemini's descriptions are TRUE. They say what the picture shows; nobody has compared them with the real material.

### Noticed, left alone

- **`TIPL-STC9050` "Twilight Black" has a rust-orange picture.** Either the label was misread when I made the id table by eye, or the catalogue names it so. Look at PDF page 8.
- `.env` still holds the Google signing key's text in `CATALOGUE_GCS_KEY_FILE` (open decision 24): my tools read it from there in memory and say so; Render needs it in `CATALOGUE_GCS_KEY_JSON`.
- The studio's render sometimes spreads a finish past the mask onto a neighbouring object (the reception desk in my test); the studio blends the result back through the mask, so it does not show in the studio, but it is the model ignoring the mask in all three variants.
- My-project below 720 px, the offline and error pages and the project form still differ on purpose (documented in C9).

### What I did (summary)

I put the 63 catalogue designs into the Design Studio's finish list (wall, door, furniture) with their real photos, without changing the studio's own files; when one is rendered, the design's photograph now goes to Gemini as a reference image with four rules about how to use it, and the brief is written from what Gemini saw in the picture. In a before/after check on two designs the render matched the real sample much more closely with the photograph than with name and colour or a description alone (one room, one run each, so it shows the direction, not an accuracy). The design pictures are no longer files on the server: I uploaded the 63 to your bucket, recorded them in MongoDB, and the same shop addresses now read them from there; Gemini also described every design from its picture and the text is in MongoDB, the shop and TeruBot. TeruBot is now the same on every page: Talk and the microphone work in the studio and the Finder, and in the studio's full-screen view (always on a phone) the launcher is no longer hidden under the studio. Nothing is committed or deployed; Render needs the signing key in `CATALOGUE_GCS_KEY_JSON` before the pictures show there.

---

## 2026-11-04 (second session): catalogue ids, shop listing, tap-a-surface, TeruBot with photos and links, My project loader

**Asked:** (1) give every catalogue photo, vector row and record the id printed in `Superbond colour image.pdf`, with a `TIPL-` prefix; (2) list the same catalogue in the marketplace to sell; (3) in the shop, after a photo is chosen, run the models (OneFormer, Gemini ...) to outline it, make it hoverable and tappable, and show the closest catalogue items below; the same for a photo sent to TeruBot ("what material is the left wall?"), with the closest items and their price in the marketplace; (5) make sure everything works; (6) the My project page's loader is still not the same as the others; (7) a pasted link (a Pinterest pin) must be fetched as a photo, sent to Gemini, and offered to the Finder / Design Studio; find and fix bugs. Keep going if the usage limit hits.

**Serves:** D1, A1, C3, C4, C5, C9 (and F5 for the loader).

### Slice 1 (DONE): product ids from the PDF onto the live catalogue

- Read the 69 pages of the PDF (it is 175 MB and has no text layer, so I rendered each label strip at 190 dpi with PyMuPDF in a scratch environment and read the printed code and name by eye). Result: page 1 is the cover (no code), pages 2-69 carry 68 labels with **63 distinct codes**; **five codes are printed on two pages each** (SB005 p17/p64, SB923 p23/p67, SB902 p24/p65, SB915 p29/p61, SB804 p32/p66). Written as `catalogue/data/superbond-colour-ids.json` (spellings exactly as printed: CORTERN, CONFIER, NAXIAN, MARMORIS STEIN, VIRDIAN, ANILE ...; the file's own comment says it was read by eye and should be spot-checked). The PDF's sha256 equals the one the live catalogue was built from.
- New `catalogue/terucon_catalogue/assign_ids.py` + a CLI command `assign-ids` (dry run unless `--apply`, `--backup`, `--undo`) + `catalogue/tests/test_assign_ids.py` (18 tests; I broke the code on purpose and 2 of them failed, then restored it). What it does: sets `productId = TIPL-<code>` (`productIdSource: admin`), `label` (printed name in title case), `attributes` (code, printed name, PDF page, the other page of a repeated code) on each item in MongoDB; hides page 1 (not a material); writes a **new release** whose vectors are byte-identical (checked against the old manifest's sha256) and whose `items.json` carries the product ids (the search de-duplicates on that, so a repeated code shows once); flips the live pointer last. **`itemId`, the picture keys and the vector row ids were deliberately not renamed** (they are the join between pictures, vectors and database and a release is immutable); the TIPL id is the public id on every record.
- **Live run** (your `.env`, read in memory only; the signing key's text was passed in as the right variable name without editing `.env`): full read-only copy of the 69 item documents first (`catalogue/data/backups/live-catalogue-before-ids-2026-11-04.json`), dry run, then `--apply`: release `rel-20261103223526-3b7f28` written to the bucket (12 files), 69 item documents updated, made live; the old release `rel-20261101225013-57cdcb` is the "previous" one. `modal run modal_app.py::prime` then copied the new release onto the Modal volume `terucon-catalogue-cache` (the old one is still there). A second dry run says "0 item documents would change". Undo: `python -m terucon_catalogue assign-ids --catalogue superbond-colour --undo catalogue/data/backups/assign-ids-backup-superbond-colour-2026-11-04.json`.
- **Checked live:** a real photo search through the website's catalogue service (real Modal search app, real MongoDB, real signing): a patch cut from page 32 returned `TIPL-SB804 Emperador Dark` first (page 66 did not appear as a second hit), then SB825, SB829, SB8002, SB8001, SB830, all with signed thumbnails (17 s cold, 1.2 s warm); a patch from page 8 returned `TIPL-STC9050 Twilight Black` first.
- **Found (not changed):** `.env` holds the Google signing key's text in `CATALOGUE_GCS_KEY_FILE` (a variable that expects a file path), so on this Mac the site reports the catalogue as "storage-not-configured" and the Finder cannot show pictures. With the same text in `CATALOGUE_GCS_KEY_JSON` the status is ready. I did not edit your `.env`.

### Slice 2 (DONE): the 63 designs in the shop

- Cut each design's swatch from its first page (`catalogue/tools/make_shop_images.py`, run with PyMuPDF in a scratch environment; the swatch rectangle was measured on all 68 pages and is the same within 2 pt) into `media/materials/tipl-<code>.jpg` (800 px wide, 8 MB for 63) and wrote `catalogue/data/superbond-colour-shop.json`.
- `tools/build-shop-catalogue.js` writes `site/patches/snippets/shop-catalogue.js`, spliced into the shop's data layer by three new steps of `site/patches/materials.json`. The patch engine could not reach that script (the export gives it no name), so `tools/build-site.js` got `target: "asset:content=<text>"`; it also got a `style` field on a step (the cause of the seven red JavaScript tests, see below). `tools/extract-products.js` now reads the data layer from the built shop page (so TeruBot's `server/data/products.json` has 87 products / 209 variants) and counts the pictures that are files. A shop search bug found on the way: a code such as `sb804` matched `sb801` through the plural rule (`server/lib/terubot/shop.js`).
- Prices, size, thickness, weight and uses are **placeholders** copied from the shop's FR Solid sheet and flagged on each product page; the colour family and surface come from the printed name. I did not use the Gemini descriptions (most designs were "laminate").
- Looked at screenshots of the category page and a product page in Chrome. A mistake of mine, caught by the full browser run: my first `res()` patch made every `media/...` photograph address absolute, which broke the export's own later lookup of its embedded pictures (three 404s in the cart test); it is now limited to the `tipl-` pictures.

### Slice 3 (DONE): the shop's "Find it from a photo", for real

- `site/catalogue-ui/surfaces.js` + `surfaces.css` (new; the two names added to `server/routes/catalogueUi.js`), loaded and opened by the `surfaces-assets` / `surfaces-open` steps. OneFormer scan through the studio's own route, connected regions in the browser, hover and tap, a clean patch cut for the search, results with the shop price and View / Add to cart; the shop's own sheet is the fallback. `server/lib/shopLink.js` makes a catalogue result say what the shop lists for it (`item.shop`), added to `/api/catalogue/search` and `/search-text`.
- **Live run** (real server code, sign-in off for this local run only, signing key passed in memory): a lobby photo outlined in 20 s, tap on "Wall" searched in 2 s, designs with prices came back, no page errors. 2 browser tests with stubbed models (one broken on purpose: it failed) and 3 JavaScript tests for the Finder card (`site/catalogue-ui/client.js` now links a result to its shop page with the price).
- **Found and fixed:** `catalogues.counts.items` was written by the publisher as the visible items while the website subtracts the hidden ones again (the live Finder said 67 visible instead of 68). Fixed in `publish.py` and the CLI, `ARCHITECTURE.md` 4.4 says which meaning, one test that pinned the old meaning changed, the live document corrected.

### Slice 4 (DONE): TeruBot with a photo and with a pasted link

- Server: `server/lib/terubot/photo.js` (checks a photo by its bytes; finds a link; fetches its picture with the Inspiration importer), `tools.js` (new tool `find_in_photo(target, box_2d)`, shop cards for catalogue results), `catalogue.js` (photo search through the same gates), `chat.js` / `prompt.js` (the picture goes to Gemini as an inline part; new rules), `server/routes/terubot.js` (photo or token in the body, 6 MB only for a message with a photo, 20 / 40 photos an hour, a turn with a photo may take 50 s and wakes the search while the model looks). Widget: paperclip, paste, drop, shrink to 1280 px, a strip with Finder / Studio / Remove, link pictures by token, `terubot.css`, `terubot.md`.
- Live: the real Gemini answered the left-wall question with the lobby photo in 12 s with cards; the Pinterest pin you pasted was fetched through gallery-dl (747 x 1328) and Gemini answered about it; in Chrome the photo, the answer and the hand-off to the Finder worked. 18 new JavaScript tests, 1 browser test (broken on purpose: it failed).
- The first live try timed out at the old 30 s limit (the search container was asleep): a photo turn now has 50 s and the search is warmed in parallel.

### Slice 5: the My project loader (nothing changed)

Measured the loader on every page, laptop and 390 px phone, with and without a 4x CPU slowdown, by loading and by clicking the real link: same markup, same timing, same quick curtain everywhere but the landing page. I could not reproduce a difference and changed nothing; what I need from you is in `TARGETS.md`, open decision 26.

### Slice 6: bugs and the full run

- The seven JavaScript tests that were red before I started are green: a patch step may now name the link style it belongs to; golden digests rewritten. `npm test` is green except the overview, regenerated at the end.
- Full browser suite: first run 81 of 83 (the 404 above, and a sign-in test that clicked Sign out while the page's loader still covered the button: a race in the test, it failed about half the time in a run of the first 14 tests and passes 5 of 5 once it waits for the loader like a person); second run 82 of 83 (that test); **final run 83 of 83**.

### Files changed

Code: `catalogue/terucon_catalogue/{assign_ids.py (new),cli.py,publish.py}`, `server/lib/shopLink.js` (new), `server/lib/terubot/{photo.js (new),catalogue,chat,images,index,prompt,shop,tools}.js`, `server/routes/{catalogue,catalogueUi,terubot}.js`, `site/catalogue-ui/{surfaces.js,surfaces.css (new),client.js,catalogue-ui.css}`, `site/brand/{terubot.js,terubot.css}`, `site/patches/{materials,home,studio}.json`, `site/patches/snippets/shop-catalogue.js` (generated), `tools/{build-shop-catalogue.js (new),build-site.js,extract-products.js}`, `pages/materials.html` and `server/data/products.json` (rebuilt), `media/materials/tipl-*.jpg` (63 new). Data: `catalogue/data/{superbond-colour-ids.json,superbond-colour-shop.json,backups/}`, `catalogue/tools/make_shop_images.py`. Docs: `TARGETS.md`, `WORK_LOG.md`, `README.md`, `docs/CATALOGUE_SETUP.md`, `catalogue/ARCHITECTURE.md`, `site/brand/terubot.md`, `site/patches/README.md`. Tests: `catalogue/tests/{test_assign_ids.py (new),test_publish.py}`, `tests/js/{terubot-photo,catalogue-shop-card (new),terubot-data,site-patches}.test.js`, `tests/helpers/terubotApp.js`, `tests/e2e/run.mjs` (3 new browser tests, a stub hook), `tests/fixtures/pages-golden.json`. Nothing under `swatchroom/` or `pages_original/` was touched; nothing committed; `.env` not edited.

### Live changes made (outside the repo), all recorded above

MongoDB database `swatchroom`: 69 item documents (id, label, attributes, one hidden), one new release record, the catalogue's live pointer and its counts (twice: the ids, then the counts fix). Bucket `cataloguegcsbucket/catalogue/`: 12 new files under `releases/superbond-colour/rel-20261103223526-3b7f28/`. Modal volume `terucon-catalogue-cache`: that release added. Undo for the ids: the `--undo` command in slice 1. Real services called besides those: the Modal search app, OneFormer on Modal, Gemini on Vertex, Pinterest (one pin) through gallery-dl. A temporary Modal app run (`modal run ... prime`) started and stopped by itself.

### Checked

- Python (light environment without torch): the new 18 tests and every test of publish, mongo, release, service, http, bucket import, ingest pass; the compute-pipeline tests (`test_pipeline.py`, `test_photos.py`, encoders) need torch and were not run there; `test_modal_app.py` not run.
- JavaScript: 1019 tests, 1015 pass, 0 fail, 4 skipped (the same four as before).
- Browser: **83 of 83** (three new tests; one existing test made to wait for the loader).
- Live runs listed in slices 1, 3 and 4.

### Not checked

A real phone or Safari (the in-page camera in the new dialog, the paperclip, touch hover); any accuracy of matching on real photos of physical samples; the shop on a slow phone with 63 more pictures; Render (nothing deployed); sign-in against real services; the admin screen's success path; the printed codes beyond my own two reads (the table needs your spot-check); whether the live Finder works once `CATALOGUE_GCS_KEY_JSON` is set on Render; what the "lazy loader" difference you see is.

### Noticed, left alone

`.env` has the signing key in `CATALOGUE_GCS_KEY_FILE` (open decision 24); the Gemini descriptions of the catalogue are poor (most designs "laminate", colours polluted by the page margin and label) so search relies on the image models; the catalogue's crops include the page margin and printed label (a recompute on swatch-only crops might improve matching: not tried); `docs/overview` and the file-size record are regenerated at the end.

### Time

About one working session spread over a usage-limit pause. Mostly working (reading code, writing, live runs and screenshots); waiting: the full browser suite takes about 8 minutes per run (two runs), Modal cold starts of 15 to 20 s per live search.

### What I did (summary)

Gave every item of the SuperBond catalogue the id printed in its PDF (`TIPL-SB804`) in MongoDB, a new live release and the Modal volume, with a backup and an undo; listed the 63 designs in the shop with those ids and sample prices; rebuilt the shop's photo search so the models outline the photo, a tap on a surface finds the closest designs with their shop price; made TeruBot able to see a photo or fetch a pasted link (your Pinterest pin) and name the closest designs for "the left wall"; fixed a counts bug, a search bug and the seven red tests; ran all of it live once. Not done: real prices (none exist), the My project loader difference (I could not reproduce it), real-phone checks, reading codes automatically for future uploads.

---

## 2026-11-04: TeruBot over the project form, live voice, header button, one loader, shop camera, and C5/C6/C9 re-baselined

**Asked:** (1) in a fresh session: the TeruBot chat panel stays open over the form when it sends a visitor to "Start a project": close it; (2) read `TARGETS.md` and `WORK_LOG.md` for C5, C6 and C9, do what is left, log it; (3) "add the lazy loader for every page, the same one that comes before the Design Studio" and "make pages uniform from the perspective of the lazy loader"; (4) the header's "Start a project" button should not be everywhere (cluttered); (5) TeruBot should be able to hold a live conversation and speak, like talking to a person; (6) in the shop, "Find it from a photo" again fails to upload a photo taken with the camera: do what was done for the Design Studio. You also pasted a handoff saying the Gemini chain works live, the form pre-fills, test races are fixed and the repo is clean.

**Serves:** C5, C6, C9 (status and evidence), C4 and C1 (the shop camera), F5 (header, loader).

### What exactly I did, in order

1. Read `TARGETS.md`, `WORK_LOG.md`, `CLAUDE.md` and my memory notes. **`TARGETS.md` and `WORK_LOG.md` never mention TeruBot** (0 matches), although commit `5f985a4` added about 2,800 lines for it: so I did not treat the handoff's "already done" list as recorded fact. Checked the repo state: `git worktree list` shows only the main worktree (the scratch ones are gone), but the branch `claude/eloquent-pascal-h42d1e` still exists locally and on `origin`, and the tree was not clean (uncommitted edits to `TARGETS.md`, `WORK_LOG.md` and the overview from other sessions; a parallel session added the twenty-eighth update to both files while I worked, so mine is the twenty-ninth).
2. Read `site/brand/terubot.js` (all), `terubot.md`, the server's `site.js`, `tools.js`, `prompt.js`, and the existing TeruBot tests. Ran the existing "terubot: actions" browser test first to be sure the test harness works here (it passed).
3. Asked the advisor tool to review the plan before I wrote code. Points followed: fix the bug test-first and by destination rather than by action; generalise `studio-camera.js` instead of copying it; do not apply the studio's two-cycle hold to every page; build voice client-side; treat C5/C6/C9 as an honest re-baseline; do not delete the leftover branch; do not commit.
4. **TeruBot over the form (test first).** The bug was not on the path the code already handled: `prefill_enquiry` already called `leave('/start-project', false)`, but a plain `navigate` to `/start-project` set the "reopen" flag and the chat reopened on the form. Wrote a browser test (the chip, `?type=Retail`, `/start-project/`, a stale flag, a reload, and a control that the shop still reopens it); it **failed on the old code** (`"open":true`). Fixed it in `site/brand/terubot.js` by destination (`FORM_PAGES`, `isFormPage()`, in `leave()` and again in `mount()`); the test then found a second small flaw (the note read "Done: opening /start-project/." for a trailing slash) and I fixed `placeName()` too. All 12 TeruBot browser tests passed.
5. **Header.** `site/brand/chrome.js` draws "Start a project" only on the landing page. This pushed the file over a 20 KB size guard in `tests/js/site-chrome.test.js` (20,556 bytes); I merged two `if (landing)` blocks and shortened the comment (20,321). Updated the browser tests that assumed the button on every page (the walk, the 1440 px layout test, the Tab order, the phone pill, the shop), `chrome.md`, and the title of one test. Screenshots of the shop at 1440 and 390 px, and of the Finder, were looked at.
6. **Shop camera.** Found by searching the built shop page: the photo sheet has `<input type=file accept=image/* capture=environment>` behind "Take a photo" (`takePhoto` clicks it), the same pattern as the studio. Generalised `site/brand/studio-camera.js` (any `input[type=file][capture]`; the gallery fallback finds the sibling input without `capture`; Escape stops at the camera; the lost-hand-off note no longer mentions the studio's "New photo"; analytics event `camera_handoff_lost` off the studio page). Added step `photo-camera` to `site/patches/materials.json`, rebuilt `pages/materials.html` and `dist/`. Wrote 3 browser tests; ran them against the old shop page (restored from git) and the first **failed** ("timed out waiting for the in-page camera"), then restored. The studio's 3 camera tests still pass.
7. **One loader on every page.** Read `site/brand/{loader.html,loader.css,transition.js,build-loader.mjs}` and `tools/build-dist.js`: only the four built pages had a loader. Extended `site/brand/build-loader.mjs` to generate `site/brand/loader.js` from `loader.html` (markup plus the loader's own script plus a "page is ready" release), included `loader.css` and `loader.js` first in the `<head>` of the seven hand-written pages, left out `error.html` and `offline.html`, and kept the studio's own longer hold and the click-curtain studio-only. **A wrong first screenshot:** I held a stylesheet back to slow the page, which blocks the first paint, so the loader never showed; I redid it with a throttled connection. Added 2 JavaScript tests and 3 browser tests (and adapted one existing one); the uniformity test **failed on the old Finder page** (tested) and on my first version for two harmless differences (the curtain's slats and its `style` attribute, which the loader adds when it opens), which I excluded from the comparison. The Inspiration page's script allow-list test failed because of `loader.js`; I added it.
8. **Live voice ("Talk").** `site/brand/terubot.js`, `terubot.css`, `terubot.md`: a Talk button in the panel header; a loop of listen, send, read aloud, listen (browser speech recognition and speech synthesis); a strip with Skip and End; the microphone never open while speaking; ends on End, close, New chat, hidden tab, leaving the page, three quiet listens and any non-answer; the spoken text is cleaned and limited. **A mistake of mine:** my first splice script aborted on a wrong anchor (nothing was written, by design) and I re-ran it; a later one broke on nested template literals and I moved the test code into plain files. Wrote 3 browser tests with a stand-in recogniser and synthesiser; **broke the code on purpose** (listen while speaking) and the test failed, restored byte for byte; the same run showed my test only read the first spoken piece, so I made it read the whole spoken answer. One test was flaky (clicked the Talk button while the phone sheet was still sliding in): fixed by waiting for the panel to stop moving. Looked at screenshots of the strip on a laptop and at 390 px.
9. **C5, C6, C9.** Read the TeruBot tools and prompt to write what it really does: it has no tool that reads a project or a BOQ and says it cannot give quotes; the studio has no "prefill" anywhere (`grep`), so a design pre-fill needs a change in the separate Swatchroom project. Updated `TARGETS.md`: the three sections, the at-a-glance rows, the counts, "Start here", C4 and C1 (the shop camera), F5 (header, loader), "Open decisions" (item 7), the header line and the change log. **I could not re-read the PDF**: no PDF tool is installed and the PDF viewer plugin did not connect in this terminal session; the promise lines are the ones already in `TARGETS.md`.
10. **Test runs and baselines.** Full JavaScript suite and the full browser suite (results below). Seven JavaScript tests fail: I stashed everything (`git stash push -u`) and ran them on `HEAD` to check: all seven fail there too (`site-golden`, `site-cli`, `site-links`, `site-patches`: see "Open decisions" item 22 in `TARGETS.md`). I did not touch the build engine. Rebuilt the overview (`node tools/build-overview.js`) and added `site/brand/loader.js` to `docs/overview/catalog/files.json`.

### Files changed

- Code (one more edit after the advisor's review: the shop's script address got `?v=20261104`, see `TARGETS.md` C4 for why): `site/brand/terubot.js`, `site/brand/terubot.css`, `site/brand/chrome.js`, `site/brand/studio-camera.js`, `site/brand/build-loader.mjs`; new `site/brand/loader.js` (generated); `site/patches/materials.json`; `pages/{account,admin-catalogue,coming-soon,finder,inspiration,login,start-project}.html` (3 lines each); `pages/materials.html` (rebuilt).
- Docs: `site/brand/terubot.md`, `site/brand/chrome.md`, `README.md` (one phrase: the header pill is on the landing page only), `TARGETS.md`, `WORK_LOG.md` (this entry), `docs/overview/catalog/files.json`, `docs/PROJECT_OVERVIEW.html` (regenerated).
- Tests: `tests/e2e/run.mjs` (new: the form test, 3 shop camera, the loader on every page, the loader.js-unavailable case, 3 live conversation; adapted: the walk, the chrome tests, a motion test, the voice test), `tests/js/brand-loader.test.js` (2 new), `tests/js/inspiration-page.test.js` (allow-list). **Two helper changes that could look like weakening a test, and why they are not:** (a) `tbGo` and `tbOpen` now wait until the page's loader has stopped covering the page (`tbLoaderGone`; not on the studio, whose loader holds for the GPU). The loader now briefly covers the hand-written pages (Finder, Inspiration, account ...), so a click right after `DOMContentLoaded` landed on the loader: three TeruBot tests failed in the first full run ("timed out waiting for the panel to open", "Node is either not clickable", "timed out waiting for bot message 1"). A person cannot click through the loader either; the assertions themselves are unchanged. (b) Two tests clicked `.tb-head .tb-textbtn` meaning "New chat"; Talk is now the header's other `tb-textbtn` and comes first, so they say `.tb-head .tb-textbtn:not(.tb-talk)`.
- **Nothing under `swatchroom/` was touched; nothing committed or deployed.** `dist/` (git-ignored) was rebuilt. Scratch scripts and screenshots are in the session's scratchpad, not in the project. I once wrote a stray file outside the scratchpad by a path typo and deleted that one file straight away.

### Checked

- JavaScript suite: 995 tests, 984 pass, 4 skipped (the same count as in the earlier updates; I did not look at which tests they are this time), 7 fail: all seven fail identically on a clean `HEAD` (stashed run; `site-golden` x4, `site-cli` --write-golden, `site-links` link style file, `site-patches` makeContext). 79 TeruBot unit tests pass.
- Browser suite, final run on the finished code: 80 of 80 browser tests pass.
- Each new browser test was seen failing on the old code or with the code broken on purpose (list in `TARGETS.md`, change log), and the code restored byte for byte afterwards (`cmp`).
- `node tools/build-site.js --check`, `tools/check-links.js`, `site/brand/build-loader.mjs --check`, `tools/build-overview.js --check`.
- The page scripts of the seven loader pages are all served unconditionally (the three page modules are mounted in `app.js` without a switch), so the loader's "taking longer than usual" trap cannot be tripped by a missing optional script in production.
- Screenshots: header, loader frames, live strip (laptop and 390 px), phone header at 390 and 360 px (measured: all controls inside the header, none overlapping, at least 44 px).

### Not checked

- Talk and the shop camera on a real phone, microphone, speaker, or in Safari; what the browser's speech service does with the audio (documented to leave the device in Chrome and Edge; not checked for other browsers); the PDF's text.
- Anything live: no Gemini, Modal, MongoDB, Render or Google call was made by me. The handoff's "Gemini works live" and "the form pre-fills" are taken from you and marked "per you" in `TARGETS.md`.
- The `makeContext defaults` test failure and the two route-style golden digest mismatches (not traced).
- Whether the loader feels right (about a second of curtain on every page load), and how the header looks on the live site.

### Went beyond what you asked (small)

- The `README.md` phrase; the `docs/overview/catalog/files.json` entry for `loader.js` (the working agreement needs it); the generated `site/brand/loader.js` (the way to give the hand-written pages the same loader without copying it); the test-helper changes above; the cache-busting `?v=` on one script address; two small TeruBot fixes the tests found (the note for a trailing slash, and a decimal point such as 2.5 no longer cut a spoken sentence in two). Moving C6 down from Demo to Not done is a judgement, not a request.

### Time

About one hour in all. Most of it was working: reading the code, writing the changes and the tests, and checking screenshots. Waiting: the first full browser run took 7 min 49 s (the final one about the same; one run I stopped myself to apply the advisor's cache fix), the JavaScript suite about 30 s each time.

### Noticed, left alone

- Seven failing JavaScript tests on a clean checkout (above); the cause I traced is one patch step that only works in the route link style.
- The leftover branch `claude/eloquent-pascal-h42d1e` (local and `origin`): not deleted, since I was not asked to.
- `README.md` still describes the enquiry form as being at the end of the landing page (`/#enquire`) and as sending nothing; it is now its own page, `/start-project`, and the enquiry is kept on the server (`POST /api/enquiry`). I changed only the one phrase my change affects.
- The sign-in page lead text still mentions e-mail codes while Google is the only method (noted earlier).

### What I did (summary)

TeruBot no longer opens over the Start a project form: the bug was the plain `navigate` path, not the one the code already handled, and the rule is now by destination. TeruBot has a Talk button for a live spoken conversation (browser speech, nothing new on the server; tested with stand-in speech, never on a real microphone or phone). "Start a project" is in the landing page's header only, every page now opens behind the same Terucon loader, and the shop's "Find it from a photo" uses the same in-page camera as the studio (tested with a fake camera; not on a phone, and your phone may hold an older script, so test in a private tab). In `TARGETS.md`, TeruBot is now written up: C5 and C9 are Partly done and C6 moved down to Not done, which is a judgement you can overrule. Nothing was committed or deployed; seven JavaScript tests were already failing before I started and are still failing.

---

## 2026-11-04: "Sometimes it renders, sometimes not"; why SAM 3, MoGe-2 and Marigold read "no calls yet"; the 404 and the 503 in the console

**Asked:** why the Design Studio's 3D preview (WebGL) "sometimes renders and sometimes not"; why the panel shows "no calls yet" for SAM 3, MoGe-2 and Marigold-IID (pasted: Scene model no calls yet, OneFormer cold start 14 s warm-up, Room analysis cold start 4.7 s warm-up, the other three no calls yet); what the console lines mean (`thumb` 404 on `terucon-vp0y.onrender.com/api/rooms/room-mw0fa3k1-…/files/thu…`, and `api/vision/pick/embed?key=room-mw0my88z-vczm3b:v0:1152x1536` 503); "find the exact problem, then the solution, and keep a record".

**Serves:** C1 and F1a (the Swatchroom live run). No target status or count changed. The real fixes are inside `swatchroom/`, which your standing rule says I never edit; I asked first and you chose "Both fixes", so I made exactly those two (see "What I changed"). Nothing was deployed or committed.

### What I found (each line says how I know)

1. **The three rows can never light up on your server, by design, not by fault.** Your panel shows them as "no calls yet", not "not set up", so all five model addresses are set on the live server. With `ANALYZE_URL` set, one job makes **one** request to the "Room analysis" pool, which runs MoGe-2, Marigold and SAM 3 together; the three separate pools are never called (`swatchroom/server/lib/pipelineRunner.js:40-42` and `:277-288`). **[RAN]** `node docs/design-studio-checks/verify_pipeline.cjs`: a first job on a new photo = 1 `analyze` call and 0 calls to the three separate adapters; and the job reports the three models as running and done *inside the "analyze" call*, but the panel only counts calls per pool, so SAM 3, MoGe-2 and Marigold stay at "no calls yet" forever. The panel's `LABELS` list (`swatchroom/server/lib/coldStart.js:19-26`) has no way to say "ran inside Room analysis".
2. **Why even "Room analysis" did not show an analysis.** It shows its *latest* call only (`coldStart.js` `record()`: `held.last = sample` for every kind), and the scan-time warm-up ping is a call too, so it replaced the earlier analysis. In your screenshot the latest sample is "warm-up · 48 s ago".
3. **Your job `job-mw0niung` ran only `stage: regions`, and that is correct.** The ids carry a time (base 36 of milliseconds): `room-mw0my88z` was created 11:59:53 UTC, which matches the photo name "Camera 20261103115953", and `job-mw0niung` was created 12:15:55 UTC, 16 minutes later. The server only calls the models once per photo version; a rescan of the same photo refits the planes locally. **[RAN]** the same script's "runner A" (geometry for the version already stored, scan saved since): 0 `analyze`, 0 separate calls, 1 plane fit, reported `{"stage":"regions"}` and `fusion` only; none of `sam3/moge2/marigold` is ever reported. This equals your console lines (`running regions` then `done regions`).
4. **The `thumb` 404 is for a different, older room** (`room-mw0fa3k1`, created 08:25 UTC, not your Camera photo): a room in the recent-rooms list that never stored a thumbnail. `swatchroom/public/js/views/empty.js:6-11` already expects this. Harmless; the browser prints the line and the page cannot hide it.
5. **The `pick/embed` 503 is the missing Python service on Render** (already in `TARGETS.md`, twenty-fourth update): `MODEL_SERVICE_URL` on Render points at a local address. It is caused by the tap-time edge correction (`studio.js:1838-1865` `localSamCandidate`), which catches the error, keeps the scan's own outline and stops trying for a while. **It does not block the preview**; it only means a tapped surface's edge is not refined by SlimSAM. (Fix is a Render setting: run `terucon-models`, set `MODEL_SERVICE_URL`; not code.)
6. **Why the 3D preview "sometimes" does not appear. I could not reproduce a GPU fault; I found six situations where the studio decides not to draw, silently.** **[RAN]** `node docs/design-studio-checks/verify_preview.mjs` for 1 to 3, code read for the rest:
   - The surface is a **chair, bed, window, door, curtain or any non-wall/floor/ceiling** surface: the pipeline only fits planes for wall, floor and ceiling (`pipelineRunner.js:56`, `FUSION_KINDS`), so there is no confidence number and the studio sends the work to the AI render only (`tiers.js` `regionTier(NaN)` = gemini-only; the check printed `furniture region: no fit -> false`). Your screenshot's list is mostly this kind (Chair 2, Single bed, Chair 1, window).
   - The finish has **no tileable texture** (motifs, rugs, anything that adds an object): never previewed (`tiers.js` `canFastRenderItem`; check printed `false`).
   - **Several surfaces selected, or the studio busy**: the preview needs exactly one selected surface (`studio.js:2943`).
   - **Before the photo's light is loaded** nothing is drawn (the check printed `null (nothing to draw)` for "analysis not arrived, photo light not loaded").
   - **After a render the preview falls back to the estimate** (the 3D data is only accepted for the version it was computed for: `studio.js:2935`); this is gap (b) already listed in `TARGETS.md` (C1 "Remaining"), found by reading, never reproduced.
   - **A real GPU failure** is possible but silent: `swatchroom/public/js/lib/fastrender/device.js` returns "no renderer" if neither WebGPU nor WebGL2 works, and `stage.js` `ensureFastRenderer` swallows the error. I did **not** see one. Two lines in the DevTools Console on the device where it failed settle it: `!!navigator.gpu` and `!!document.createElement('canvas').getContext('webgl2')`. If the second prints `false`, that device has no WebGL2 and every surface goes to the AI render.
   - One thing I **ruled out**: a wall with low fit confidence no longer loses its preview (it falls back to the outline estimate, `previewScene.js`; default low threshold is 0.3 in `settings.js:107`, an old 0.45 is migrated down at `:166`). The 0.425 case in the architecture document is already fixed.
   - Separate from WebGL: on your live site the **Render** button (Gemini) needs a Google key that, as of the eighteenth update, Render does not have in a form the studio reads; if that is still so, "Render" fails every time, which can look like "sometimes".

### What exactly I did, in order

1. Read `TARGETS.md`, `CLAUDE.md`, the memory rules (never edit `swatchroom/`, keep this log, facts only) and the work log's last entries.
2. Read `pipelineRunner.js` (the combined-analysis switch, `askModels`, `runGeometry`), `routes/pipeline.js` (when a job is queued), `coldStart.js`, `ownerSummary.js` (the panel's text), `remoteModels/analyze.js`, `fastrender/device.js`, `fastrender/tiers.js`, `previewScene.js`, `settings.js` thresholds, and the studio's `ensureFusion`, `pollFusionJob`, the preview gating, and `localSamCandidate` (the 503's caller).
3. Decoded the time inside the room and job ids with `node` (base 36 to UTC) to line the console, the panel and the photo name up.
4. Re-ran the two existing check scripts (`docs/design-studio-checks/verify_pipeline.cjs`, `verify_preview.mjs`); the first blocks every network call (0 attempts left the machine).
5. Asked the advisor to review my reading before I wrote anything; its points I followed: rule out the "no plane / no texture" cases before blaming the GPU; check that the 503 cannot block the preview; give a two-line GPU test instead of guessing; do not change `swatchroom/` or fake panel data from the website's side; record and ask.
6. Wrote the findings into this entry and `TARGETS.md` before changing any code, then asked you (one question, three options). You answered "Both fixes".
7. **Fix 1, the panel** (`swatchroom/server/lib/coldStart.js`, `swatchroom/public/js/lib/ownerSummary.js`): the registry now also keeps `lastWork` (the last call that was not a warm-up ping) per service, and the snapshot gives SAM 3, MoGe-2 and Marigold a `runsInside` field naming Room analysis, with that service's last real analysis, only while the combined analysis is on (same condition as `pipelineRunner.useCombinedAnalysis()`, read when asked). Their own `last` stays empty: no call is invented for them. The panel now reads, for example, "runs inside Room analysis (one request, not on its own) · last analysis warm, processing 3.2 s · 4 min ago", or "… · no analysis since this server started"; and a service whose latest call is a warm-up (Room analysis, OneFormer) gets "last analysis …" / "last scan …" appended, or "no analysis yet".
8. **Fix 2, the preview reason** (new `swatchroom/public/js/lib/fastrender/previewReason.js`, pure; wired in `views/studio.js`, `views/stage.js`, `views/dialogs.js`): when a surface and a finish are chosen and the preview is not drawn, the studio now knows which rule applied (settings off, several surfaces, render running, no GPU renderer, photo not ready, finish without texture, surface without a 3D fit, fit too weak). It prints one console line per change (`[swatchroom] model in use: instant preview not drawn {why, surface, kind}`) and shows the sentence in Settings > Render ("Instant preview for the selected surface: …"). `stage.js` now remembers when neither WebGPU nor WebGL2 could be created (`fastRendererFailed`) and logs a console warning, where it used to fail without a word. **The rules that decide whether to draw were not changed**: `tiers.js` and the drawing code are untouched; a unit test checks the reason is "none" exactly when `canUseFastRender` says yes.
9. Tests added: 2 in `swatchroom/server/lib/coldStart.test.js`, 2 in `swatchroom/tests/owner.test.js`, 3 in `swatchroom/tests/fastrender.test.js`.
10. Saved the changes as a patch for your original project: `docs/design-studio-checks/studio-panel-and-preview-reason.patch` (9 files). A dry run of `git apply --check -p2` in `/Users/mayank/XTRA/terucon_swatchroom_demo/swarchroom-v5/swatchroom` printed no error; I did not apply it there.
11. Updated `TARGETS.md` and rebuilt the overview.

### Files changed

- Under `swatchroom/` (with your word): `server/lib/coldStart.js`, `public/js/lib/ownerSummary.js`, `public/js/views/studio.js`, `public/js/views/stage.js`, `public/js/views/dialogs.js`, new `public/js/lib/fastrender/previewReason.js`, and the three test files named above.
- New: `docs/design-studio-checks/studio-panel-and-preview-reason.patch`.
- `WORK_LOG.md` (this entry), `TARGETS.md` (header, change log) and the file `node tools/build-overview.js` regenerates (`docs/PROJECT_OVERVIEW.html`). **Nothing committed.** **Your original project at `terucon_swatchroom_demo` was not touched, so until you apply the patch there, the next re-copy of it would erase these edits.**

### Checked

- Items 1 to 3 and the first three bullets of item 6 by running the real route, runner and pure preview modules with stubs, no live service.
- **The fixes:** the studio's own JavaScript tests, each group: coldstart 21/21, owner 15/15, fastrender 28/28 and fusion, npy, adapters, outlines, vision, splits, startup, sam, bridge all passing. The website's `npm test`: 1,019 JavaScript tests, 1,015 passed, 0 failed, 4 skipped (the same 4 as before). `npm test -- --e2e`: 83 of 83 browser tests passed; those load the real studio page, so the new import and the new code in the studio's draw pass ran without error in its empty state.
- With the three model addresses set (pointing nowhere; nothing is called), the real registry marks SAM 3, MoGe-2 and Marigold `runsInside: analyze` and nothing else; with `ANALYZE_URL` empty, none.
- I did not run the new tests against the old code to see them fail.

### Not checked

- **I did not open the studio in a browser** for this question, so which of the six cases happened on your screen is not known to me. I did not see your Render logs, so I cannot confirm that the first analysis of `room-mw0my88z` really ran remotely: the room's saved `fusion.geometry.modelVersions.via` should read `"analyze"`, and Render's log should have a line `[pipeline] room-mw0my88z analysed in …ms { analyze: 'remote', … }` from about 11:59 UTC.
- No GPU test on your device or on a phone.
- **The new Settings line and console line were never seen in a browser with a real scan**: no test here picks a surface and a finish in the live studio, so the wording on screen and the once-per-change logging are checked only through the pure module and by reading the code. Please try it: select a chair, pick any finish, open Settings > Render.
- The panel's new wording was checked in unit tests and on the snapshot object, not on the screen.

### What is left for you

- Apply the patch to your original project (`cd …/swatchroom && git apply -p2 <this repo>/docs/design-studio-checks/studio-panel-and-preview-reason.patch`, or copy the nine files), then commit here and redeploy; the live site shows the old panel until then.
- Run the two-line GPU test on the device where the preview failed (`!!navigator.gpu` and `!!document.createElement('canvas').getContext('webgl2')` in DevTools). After the redeploy, Settings > Render and the console will say it for you.
- The `pick/embed` 503: run the `terucon-models` service on Render and set `MODEL_SERVICE_URL`. Not code.

### Noticed, left alone

- `docs/DESIGN_STUDIO_ARCHITECTURE.md` line 891 still mentions the 0.425 wall with no preview as an open finding; the studio no longer does that (see 6). I did not edit the document.

### What I did (summary)

I traced both questions to the code and re-ran the two check scripts. The three model rows say "no calls yet" because your server uses the single combined analysis, which the panel does not know how to show, and because a rescan of the same photo only refits locally; nothing is broken there. The preview does not "sometimes fail" at random: I found six situations where the studio silently draws nothing (mostly chairs, beds and windows, which get no instant preview at all) and gave you a two-line GPU test for the one case I could not rule out. The 404 is an old room's missing thumbnail and the 503 is the Python service missing on Render; neither stops the preview. You allowed edits in `swatchroom/`, so the panel now says "runs inside Room analysis" with the last real analysis (a warm-up no longer hides it), and the studio now tells you in Settings and in the console why it did not draw a preview. I did not change when a preview is drawn. Tests pass; I have not seen the new lines on a real screen, nothing is deployed, and your original project still needs the patch.

---

## 2026-11-03 (follow-up 2026-11-04): Studio status panel: why SAM 3, MoGe-2 and Marigold say "not called", and what "Model service (Python)" is

**Asked:** you pasted the Design Studio's model-status panel (Google OK, "Model service (Python)" not reachable at `http://127.0.0.1:8001`, OneFormer and "Room analysis" warm, SAM 3 / MoGe-2 / Marigold "not called since this server started", MongoDB connected with 31 rooms) and asked: "check what is saying haven't called to MoGe, SAM and Marigold ? why ? even that was required to make it working for swatchroom or AI design studio, so please think and tell what exact issue is there ? and what it is saying about model services are un-available ? what ?". On 2026-11-04 you then sent `source /Users/mayank/XTRA/terucon/python/.venv/bin/activate`.

**Serves:** C1 and F1a (the Swatchroom live run, "Start here" step 1), read-only. No target status or count changed.

### What exactly I did, in order

1. Read `TARGETS.md` and `CLAUDE.md`; searched the repo for the panel's exact texts. They come from `swatchroom/server/lib/healthChecks.js`, called by `swatchroom/server/routes/admin.js`. (One search failed on a shell glob and was re-run with the pattern quoted.)
2. Read `healthChecks.js`, `admin.js` lines 70-130, `server/lib/warmth.js`, and `server/lib/pipelineRunner.js` (the `useCombinedAnalysis()` switch at lines 40-42 and `askModels()` at 277-300), the model entries of `server/config.js`, `server/routes/vision.js` and `server/lib/bootReport.js`, and the head of `swatchroom/python/app.py`.
3. A **names-only** look at `swatchroom/.env` and the root `.env`: which model variables are set (hosts masked, keys hidden), and the comment lines of the model section with every line containing `=` filtered out. No value was printed.
4. Searched `swatchroom/` for `SAM31` (the `.env` comment names it as the Pick tool's address): no match anywhere, so that name is stale. Checked that the browser's Pick calls (`public/js/lib/vision.js`) go to `/vision/pick/*`, which the server forwards only to the local Python service.
5. Wrote the explanation, added a change-log line to `TARGETS.md` (twenty-second update), ran `node tools/build-overview.js`.
6. **Follow-up, 2026-11-04.** Your `source …/python/.venv/bin/activate` points at the *website's* venv. I did not activate anything (my shell does not keep state, and it was not needed); I compared the two venvs by asking each one's own interpreter which modules it can find (`python -I`, importing nothing): root `python/.venv` has `gallery_dl` and none of `uvicorn`, `fastapi`, `torch`, `transformers`; `swatchroom/python/.venv` has all four and no `gallery_dl`. Both are Python 3.9.6. Parsed `app.py`, `pick.py` and `scene.py` with `ast.parse` under the studio venv's 3.9.6 (no write into `swatchroom/`): all three parse; a search for 3.10-only syntax found none.
7. Updated the matching `TARGETS.md` line (C1 "Remaining"), added the twenty-seventh change-log line (at the top of the log: by then other updates had taken numbers 23 to 26, so my first label "twenty-third" was wrong and was renumbered), rebuilt the overview.

### Files changed

- Edited: `TARGETS.md` (header, C1 "Remaining" line, two change-log lines), `WORK_LOG.md` (this entry), and the file `node tools/build-overview.js` regenerates (`docs/PROJECT_OVERVIEW.html`).
- **Nothing under `swatchroom/` was touched; nothing committed.**

### Checked

- From the code: with `ANALYZE_URL` set the pipeline makes one request to one pool for SAM 3 + MoGe-2 + Marigold, so the three separate pools are never called and "not called since this server started" is the expected state for them; the panel is passive on purpose (the Probe button bills a GPU).
- From the code: "Model service (Python)" is the local service in `swatchroom/python/` (SegFormer-B5 scan, SlimSAM Pick); `127.0.0.1:8001` is the default `MODEL_SERVICE_URL`.
- Which venv holds the packages the service needs (above), and that its three files parse on 3.9.6.

### Not checked

- I did not run the server, press Probe, call any service, start the Python service, import its modules or load a model. Whether it starts under Python 3.9.6 (the studio README asks for 3.10+) is unknown.
- That OneFormer and the room analysis succeeded ~75 s before your paste, that Google issued a token and that MongoDB holds 31 rooms are taken from your paste. I do not know whether it came from your Mac or from Render (`127.0.0.1` suggests your Mac).
- Installed package versions in the studio venv against `swatchroom/python/requirements.txt` (only presence was checked).

### Noticed, left alone

- The stale `SAM31_URL` name in a comment of both `.env` files.
- Root `python/.venv` and `swatchroom/python/.venv` are different environments with similar names; activating the root one and running `uvicorn` would fail.

### What I did (summary)

I traced the panel's wording to the code. SAM 3, MoGe-2 and Marigold read "not called" because your `.env` sends them as one combined request (the "Room analysis" line, which was warm), so those three lines are normal. "Model service (Python) not reachable" means the local Python service (the on-machine scan and the Pick tool) was simply not started. Then, when you activated the root `python/.venv`, I checked it: that one belongs to the website's link importer and cannot run the service; the right one is `swatchroom/python/.venv`. I changed only `TARGETS.md` and this log; nothing was started.

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
