# Targets and progress: AI Design Visualization Suite

**Target document:** `Terucon_AI_tool.pdf`, quotation TIPL-PROP-02 (Rev. 2), 17 Sep 2026, Mayank Rohilla (BoardAlgo) for Terucon India Private Limited. It supersedes the quotation of 1 Sep 2026.

**This file is the working copy of that PDF**: every target in it, one by one, what exists in the repo, and what is left. If the two ever disagree, the PDF wins: fix this file.

**Last updated:** 2026-11-01 (tenth update: reconciled the ninth and eighth updates below, closed the project-overview gap both left open, confirmed the full test suite is clean; before it, the ninth update: built the Finder page for C4/C5/C7 — `site/catalogue-ui/finder.js`, camera/point-to-find/colour/words, against the real search API, plus the shop banner and the Inspiration hand-off's new "Find similar materials" — verified in a real Chrome browser; before it, the eighth update: built the catalogue admin screen for D1 — `site/catalogue-ui/admin.js`, against the existing `pages/admin-catalogue.html` and the real admin API — hand-verified against the route code plus one live Chrome test of the token gate; before that, the seventh update: smoke-tested the owner's CLI, `catalogue/terucon_catalogue/cli.py`, by hand — it had no test file of its own; before that, the sixth update: the catalogue retrieval engine — compute, publish, search and the admin API, serving C3, C4, C5, C7 and D1 — assessed, fixed and verified; before that, the fifth update: a read-only finding on C1's instant preview; before that, the fourth update: the inspiration import, C3: paste a link, crop, send to the Design Studio)

| From the PDF | |
|---|---|
| Price | Rs. 2,00,000 for the full scope |
| Payment | Rs. 25,000 billed every 15-day cycle at minimum, "contingent on visible progress in that cycle"; a closing Rs. 25,000 on final delivery and sign-off. A cycle with materially short progress is "discussed and adjusted". |
| Timeline | "Work begins" on the first payment cycle (the date is not recorded in this repo). Development and R&D about 2 months; the whole product about 3 months. |

## How this file is kept (read this first)

1. **Before any task**, read this file and say which target(s) the task serves.
2. **After the task**, update it: the target's status and evidence, its "Remaining" list, the counts, the "Start here" order if it changed, and a dated line in the change log at the bottom. Say what was verified and what was not.
3. **Count only what is real.** A screen on hard-coded data, or a button that only changes its own state, is *Demo screen only*, never *Done*. *Done* means real logic that has run at least against mocks; it says so when nothing has run against live services.
4. **Evidence is a file path** (and line where useful) that someone can open. No evidence, no tick.
5. **One exception: work done outside this repo** (training, accounts, deals) can only be ticked on your word. It is marked **"per you"** with the date, and the evidence still to attach is listed beside it.

| Icon | Status | Meaning |
|---|---|---|
| ✅ | **Done** | Real logic behind it, working in the code and tests. |
| 🟡 | **Partly done** | Real logic, but part of what the PDF promises is missing. |
| 🔵 | **Demo screen only** | A screen on hard-coded or fake data: it looks right, nothing real is behind it. |
| ⬜ | **Not done** | No code. |
| ⏳ | **Later** | Only applies after deploy or go-live. |

---

## Where we stand

Every promise in the PDF, grouped (34 items; the hover-editing row that the PDF lists twice is counted once):

| Group | ✅ Done | 🟡 Partly | 🔵 Demo only | ⬜ Not done | ⏳ Later | Total |
|---|---|---|---|---|---|---|
| Core suite | 0 | 3 | 4 | 2 | 0 | 9 |
| Additional features | 1 | 2 | 2 | 4 | 1 | 10 |
| Approach commitments | 1 | 1 | 0 | 4 | 0 | 6 |
| Admin panel | 0 | 1 | 0 | 4 | 0 | 5 |
| MCP | 0 | 0 | 0 | 1 | 0 | 1 |
| Included in the price | 0 | 2 | 0 | 0 | 1 | 3 |
| **All** | **2** | **9** | **6** | **15** | **2** | **34** |

The PDF's two feature tables alone (18 items that can be judged today): 1 done, 5 partly, 6 demo, 6 not done (C3 moved from not done to partly done on 2026-10-31; C4 moved from demo to partly done on 2026-11-01). The fine-tuning item sits under "Approach commitments".

Nothing marked Done or Partly done has run against live Gemini, Modal, MongoDB, PostHog, Zoho, an e-mail or SMS service, or Google sign-in. The one exception is the inspiration import (C3), which did run live through the real gallery-dl and Chrome against Wikimedia Commons, a plain picture link and an ordinary web page, but never against Pinterest. The catalogue retrieval engine (D1, and the building block behind C3/C4/C5/C7) has real logic that runs against mocks only (764 Python tests, 0 failed; the website's own tests for it among the 710 JavaScript tests) — never against a real PDF, a real Modal GPU, a real GCS bucket or a real MongoDB, and never on Terucon's own materials (no real catalogue PDF or price list has reached this repo). D1's admin screen (added 2026-11-01) has run live in a real browser against the real server for its token gate only (one Chrome test); the rest of it — actually creating a catalogue, uploading, a job finishing, editing an item, activating a release — has only been checked by hand against the route code, never run, because the dev stack it runs against has no admin token or catalogue backend configured. The Finder page (C4, also added 2026-11-01) has run live in a real browser too — the camera (with a fake device), the mode switch, point-to-find, the catalogue-off notice — but every search it would run is still against mocks at the server, since the same real catalogue is missing. The integration-heavy items (WhatsApp, voice and calls, payments, MCP, admin panel) are Not done, and the CRM is only Partly done (see I2), so effort-weighted progress is lower than these counts suggest.

## Start here (my suggested order: change it if Terucon's priorities differ)

The order follows what each step unlocks. Most of what is left needs the same thing underneath: **real prices, and a saved project with a BOQ**.

| # | Do this | Moves | Why this first | Needs from you / Terucon |
|---|---|---|---|---|
| 1 | **Run the Swatchroom live once** (real Gemini, Modal, MongoDB) and write down what happens | C1, F1a | Nothing here has ever run against the live services; the README says "the first real run is the real test". Everything below builds on it, and it shows what the fine-tuning does in practice. | Your keys are already in `swatchroom/.env`; GPUs cost money while awake |
| 2 | **Real prices in one catalogue, then price on hover** | C1, A2, A1 | The PDF's first priority is hover editing and rendering, and price-on-hover is the part that is missing. BOQ rates, the shop, admin pricing and the quote chat all need real prices. | Terucon's product list and price list |
| 3 | **Quick wins:** PostHog key and replay on; change the `/admin` password; connect the enquiry form to the CRM (the Zoho queue now exists); replace the placeholder phone and WhatsApp numbers; **switch sign-in on for real** (a mail or SMS service, a Google client id, `AUTH_SECRET`, Zoho credentials) | A10, I2 | Small jobs; they finish A10, close two live risks (a default admin password, enquiries that go nowhere) and make the sign-in and CRM work against real services for the first time. | PostHog key; a new password; the real numbers; the sign-in and Zoho credentials listed under "Ask for these now" |
| 4 | **Project + BOQ store:** save a project with its BOQ lines (item, unit, quantity, rate, amount) and a supervisor review step | A2, F2 | Admin, orders, actual-vs-virtual, the quote chat and WhatsApp quotes all need a saved project and BOQ to work on. | — |
| 5 | **Admin panel basics:** edit rates, upload designs, set brand order | D1, D2, D4, A5 | Built on the store from step 4 for D2/D4/A5. **D1 no longer waits on this at all** (2026-11-01: a full upload/job/item/release API exists, and now a screen for it too, see its section below) — only a live run against real services and Terucon's own catalogue remains. It also has to exist before MCP can. | — |
| 6 | **Marketplace backend:** products, stock, orders, payment gateway, orders visible in admin | A1, D3, A8 | The shop is a demo today and its orders live in the visitor's browser. | A payment gateway; your decision on the 50% order (A8) |

**After that**
- **Quote lifecycle:** actual vs. virtual with an audit trail (A3, F4, D5); WhatsApp quote delivery and approval (C8).
- **Assistants, once real BOQs exist:** ask-your-quote (C6, F3), brief parser (C5), chat / voice / calls (C9).
- **More AI features:** colour-match (C7), point-and-identify (C4), matching an imported inspiration photo to catalogue materials (C3: the import itself is built, the matching is not), collaborative mode (C2).
- **Elevation (A4) with exterior fine-tuning (F1b):** the least certain R&D in the quote; consider a small early spike to see how hard it is.
- **MCP (E1):** last of the build; it needs the admin panel and the store.
- **Go-live:** deploy (I3), domain (I1), CRM (I2); the 6 months of support (A9) start.

**Ask Terucon (or find, yourself) for these now.** They depend on other people and block later steps: **for sign-in and the CRM: an SMTP login and a sender address on a domain you control (e-mail codes), an SMS gateway (Twilio, or the one Terucon uses, for text codes), a Google OAuth client id with this site's address as an authorised origin (One Tap), the Zoho data centre, client id, client secret and refresh token, and a decision on which CRM it is (the quotation says Vyapar, you asked for Zoho)**; the price list and catalogue (as a real PDF or photos — the only copy the notebook ever ran on lives on your Kaggle input, not in this repo); **for the catalogue engine (D1) to run at all: a GCS bucket and a service-account key, a MongoDB connection string, and Modal deployed with its own secrets (`catalogue/ARCHITECTURE.md` section 8)**; the paint partner and palette (C7); labour training content (A6); installation and usage content (A11); a WhatsApp Business account and number (C8); a decision on a telephony provider (C9); Vyapar API access (I2); the domain (I1); a payment gateway (A1, A8).

**Can start any time, independent of everything else:** the labour training pages (A6) once the content arrives, and the installation guide content (A11).

---

## All targets at a glance

| ID | Target | Status | Next step | Needs |
|---|---|---|---|---|
| **Core suite** | | | | |
| C1 | AI render + hover editing (the PDF's "Hover Editing & Rendering" is the same item) | 🟡 Partly done | Price on hover; first live run | Terucon prices |
| C2 | Collaborative decision mode | 🔵 Demo screen only | Real multi-person projects + AI scoring | — |
| C3 | Inspiration import (Pinterest / upload) | 🟡 Partly done | Match to the catalogue; a live Pinterest run | Real catalogue; a real public pin or board address |
| C4 | Point-and-identify material | 🟡 Partly done | A real catalogue to search; live pricing | Catalogue PDF / price list |
| C5 | Voice / text brief parser | 🔵 Demo screen only | LLM parser that pre-fills a studio design | — |
| C6 | Ask-your-quote assistant | 🔵 Demo screen only | LLM grounded in a real BOQ | Store from step 4 |
| C7 | Colour-match from any photo | ⬜ Not done | Photo to palette match | Paint partner + palette |
| C8 | WhatsApp quote delivery & approval | 🔵 Demo screen only | WhatsApp Business API send + approval | Business account, real number |
| C9 | Human-like chat & voice assistant, incoming calls | ⬜ Not done | Chat bot first, then telephony | Telephony provider |
| **Additional features** | | | | |
| A1 | Materials marketplace | 🔵 Demo screen only | Backend for products, stock, orders; payments | Catalogue, prices, gateway |
| A2 | Structured BOQ | 🟡 Partly done | Real rates; save per project | Price list |
| A3 | Actual vs. virtual quotation | ⬜ Not done | Store both, show the difference | — |
| A4 | Elevation (exterior) support | ⬜ Not done | Façade scan + exterior catalogue | Exterior finishes list |
| A5 | Brand priority controls | ⬜ Not done | Admin sets brand order | Brand list |
| A6 | Labour training program | ⬜ Not done | Registration + content pages | Training content |
| A8 | Milestone payment flow | 🔵 Demo screen only | Gateway + milestone state | Decide the 50% order |
| A9 | 6 months post-launch support | ⏳ Later | Starts at go-live | — |
| A10 | PostHog analytics + session recording | ✅ Done | Add the key; switch replay on | PostHog key |
| A11 | Product / installation guide | 🟡 Partly done | Real content per material | Terucon content |
| **Approach commitments** | | | | |
| F1a | Fine-tuning for the Swatchroom | ✅ Done (per you) | Attach the evidence note | A short note |
| F1b | Fine-tuning for exterior / elevation finishes | ⬜ Not done | With A4 | Exterior finishes |
| F2 | Supervisor review before a client sees anything | ⬜ Not done | Review step in the BOQ flow | — |
| F3 | Chat restricted to each project's own quote | ⬜ Not done | With C6 | — |
| F4 | Audit trail on adjustments | ⬜ Not done | With A3 | — |
| F5 | Modern, professional frontend | 🟡 Partly done | Design the missing screens; get sign-off | Terucon sign-off |
| **Admin panel** | | | | |
| D1 | Upload and manage designs | 🟡 Partly done | Run the screen against a real catalogue and real services | Catalogue PDF / price list; GCP + Modal + MongoDB credentials |
| D2 | Edit pricing and BOQ rates | ⬜ Not done | — | — |
| D3 | View marketplace orders | ⬜ Not done | — | — |
| D4 | Control brand display order | ⬜ Not done | — | — |
| D5 | Track virtual vs. actual per project | ⬜ Not done | — | — |
| **MCP** | | | | |
| E1 | Talk to the admin panel through Claude (MCP) | ⬜ Not done | After the admin panel | — |
| **Included in the price** | | | | |
| I1 | Domain registration and setup | ⏳ Later | At deploy | Domain choice |
| I2 | CRM integration (the PDF: "as of now Vyapar"; built: Zoho, per you) | 🟡 Partly done | Run it against a live Zoho; connect the enquiry form | Zoho credentials; the CRM decision |
| I3 | Render hosting ($50 credit) | 🟡 Partly done | Files written; deploy at go-live | — |

---

# Details, one target at a time

## A. Core suite (9 features)

### C1. AI dream render + hover editing (also the PDF's "Hover Editing & Rendering — core priority")
**Promised:** upload a site photo, choose materials, see the space transformed; hover any surface to see its price and swap just that one material. First build priority.
**Status: 🟡 Partly done**
**Exists:** the Design Studio ("Swatchroom", `swatchroom/`, a separate project copied in unchanged, mounted at `/design-studio`): photo → surface scan → hover / tap to select → pick a finish → Gemini (Vertex AI) renders it into the photo, only the chosen surface changes. Hover highlight `swatchroom/public/js/views/stage.js:1257`; versions, before/after and design-board export; a browser-side fast-render module `swatchroom/public/js/lib/fastrender/`; 103 finishes in 7 surface kinds (`swatchroom/public/js/data/catalog.js`).
**Remaining:**
- [ ] Show the **price** on hover. The hover card shows category, name, description and quantity only (`stage.js:2005-2059`).
- [ ] Put **prices** in the catalogue. There are none; the rate defaults to 0 (`swatchroom/public/js/views/studio.js:2394`).
- [ ] Connect the studio's finishes to Terucon's real products. The studio's 103 finishes and the shop's 24 products share no brands or IDs.
- [ ] **The instant (browser-side) preview covers only wall, floor and ceiling surfaces; windows, doors, furniture and "other" never get it and fall back to the AI render only (found 2026-10-31, read-only, no code changed).** Why, from the code: the server's plane fit takes only those three kinds (`swatchroom/server/lib/pipelineRunner.js:56,77`), the browser's own outline estimate takes only those three (`swatchroom/public/js/lib/fastrender/provisional.js:295`, `swatchroom/public/js/lib/previewScene.js:45`), so for any other surface `fusionRegions[id]` is undefined, the confidence is NaN, `regionTier` returns "gemini-only" and `canUseFastRender` is false (`swatchroom/public/js/views/studio.js:2943-2956`, `swatchroom/public/js/lib/fastrender/tiers.js:12-46`). A second, separate limit: catalogue items of type motif, rug or panel have no texture and never use it, on any surface (deliberate, per the comment at `swatchroom/public/js/data/catalog.js:1399-1410`); counts without a texture: wall 8 of 38, floor 4 of 20, ceiling 10 of 16, window 7 of 11, door 5 of 5, furniture 1 of 10, other 1 of 3. **Nothing logs the skip**: the fast-render files have one `console.error` (a WebGPU error) and the stage swallows a failed renderer start silently (`swatchroom/public/js/views/stage.js:466-469`). `swatchroom/` is a verbatim copy, so a change belongs upstream.
- [ ] Run it against live Gemini, Modal and MongoDB (never done; README "What could not be verified here").
- [ ] The local Python scan models were not run from `swatchroom/python/.venv` (it exists; its paths say Python 3.9, the studio README asks for 3.10+).

### C2. Collaborative decision mode
**Promised:** several stakeholders each pick materials; the AI recommends options that score well against everyone's picks.
**Status: 🔵 Demo screen only**
**Exists:** the "My project" dashboard (`/my-project`, `pages_original/dashboard.html`) plays a scripted decision flow on a hard-coded demo project (Rao Dental Studio: "You liked Jaisalmer. Arjun liked Kota. Kavya hasn't picked yet", "Remind Kavya").
**Remaining:**
- [x] Real accounts (2026-10-30, see "Foundation work: sign-in and accounts"). Still missing: invites for several people on one project.
- [ ] Store each person's picks.
- [ ] The AI recommendation that scores options against everyone's picks.
- [ ] Tie it to real studio designs; persist it.

### C3. Inspiration import
**Promised:** bring in a Pinterest board or upload inspiration photos; the AI matches them to real catalogue materials.
**Status: 🟡 Partly done** (2026-10-31): the importing, cropping and hand-over are built and tested; the matching to the catalogue is not.
**Exists:** a visitor pastes an address into the shop's search box, the shop assistant's box or the new **Inspiration** page (`/inspiration`); a popup asks "Import this photo?"; on yes the picture is fetched and a crop screen opens (shapes 1:1 to 9:16, turn, mirror, zoom and pan, a box with eight handles that keeps a locked shape, keyboard and touch); the cropped JPEG (at most 4096 px, 3072 on a phone, never enlarged) opens in the Design Studio as a new photo through the studio's own photo input, so the studio runs its normal flow. A photo from the device (button or drag-and-drop) joins at the crop. Which kind of address it is: one registry (`site/inspiration/sources.js`) used by the browser and re-checked by the server: Pinterest (pin, board, board section, `pin.it`), Unsplash, Pexels, Flickr, Behance, Imgur and Wikimedia Commons are read by **gallery-dl** (`python/gallery_resolve.py`, pinned in `python/requirements.txt`) with each site's own options; a link to a picture file is fetched as it is; any other web page gives its own named main picture (marked approximate); Instagram, Facebook and X get a plain "needs a sign-in, upload it instead". Safety: one-use tokens bound to the account (the browser never names a picture address), public addresses only checked as the connection is made, redirects re-checked, size and pixel limits, pictures judged by their bytes (`server/lib/inspiration/`), 30 addresses an hour per account. Evidence: `site/inspiration/` (browser), `server/lib/inspiration/`, `server/routes/inspiration.js`, `python/gallery_resolve.py`, `pages/inspiration.html`, patches `site/patches/materials.json` (`import-*` steps) and `studio.json` (`import-feed`); README "Inspiration import".
**Verified (2026-10-31):** 73 new JavaScript tests (`tests/js/inspiration-*.test.js`: the registry, crop arithmetic with randomised drags, picture recognition, the safe fetcher against a local HTTPS server, the importer and its limits, the routes through the real server, the page's strict policy, the resolver script against a pretend gallery_dl, and the contract with the installed gallery-dl 1.32.18: every address shape reaches the intended extractor and every option we set is read by it, offline); 6 Chrome tests (paste question under the strict policy with no violations, upload to crop to the studio receiving exactly the cropped size, a board with its picker, the shop's search box and assistant box, failure screens, a phone); and a **live run** through the real server, real gallery-dl and Chrome against Wikimedia Commons (a file page: 172 x 178, its true size, current version only), a plain picture link and an ordinary web page (en.wikipedia.org, its main picture, 1280 x 960).
**Not verified:** any **live Pinterest** (I did not have a real public pin or board address, and I will not scrape Pinterest to find one; Pinterest's metadata shape comes from gallery-dl's own code); Unsplash, Pexels, Flickr, Behance and Imgur only against gallery-dl's code, not a live address; the `Dockerfile`'s new Python step (not built); HEIC photos (most browsers cannot open them: the upload path says so).
**Remaining:**
- [x] Pinterest import: pins, boards, sections, `pin.it` links (in code and tests; never live).
- [x] Upload your own inspiration photos; crop; send to the Design Studio.
- [ ] **AI matching to real catalogue materials.** The retrieval engine this needs now exists and is tested (`POST /api/catalogue/search-text`, `catalogue/ARCHITECTURE.md`; see D1 below), but nothing calls it yet from the import's hand-over, and there is still no real catalogue to match against (see C1, A1).
- [ ] A live Pinterest run: `python/.venv/bin/python python/gallery_resolve.py '{"url":"<a real pin>","allow":["pinterest:pin"],"options":{"videos":false,"stories":false},"limit":3,"seconds":40}'`, then the same in the browser; and one real address each for the other sites.
- [ ] Build the image once (the Dockerfile now installs Python and gallery-dl).
- [ ] Decide about Instagram, Facebook and X (they need a sign-in; none is attempted for anyone).
- [ ] Remove the first, Pinterest-only importer (`server/lib/pinterestImport.js`, `python/pinterest_board.py`, `tests/js/inspiration-pinterest.test.js`): unused, kept until you say so.

### C4. Point-and-identify material
**Promised:** point the camera at any material and find its closest catalogue match with live pricing.
**Status: 🟡 Partly done** (2026-11-01, raised from Demo screen only) — a real, working page now does this; the shop's own demo is untouched, and there is still no real catalogue, so nothing it finds today is Terucon's own material, and there is no pricing at all.
**Exists:** a new page, `/finder` (`pages/finder.html`, `site/catalogue-ui/finder.js`, same theme as `pages/inspiration.html`): a mode switch (Photo / Colour / Words), a camera (`getUserMedia`) or upload, a draggable reticle sized to the server's own default search radius for point-to-find, and a plain word search — all calling the real `POST /api/catalogue/search` / `search-text` (`server/routes/catalogue.js`, `catalogue/ARCHITECTURE.md` section 7: point-to-find `point=`/`box=`, colour-only `mode=colour`, text search), rendering real results (signed thumbnail URLs, never a score shown as a percentage). The shop's existing "Photo match · preview" demo (`pages_original/market_place.html`, `method: 'colour-on-device'`, colour only, shop products only) is unchanged, but now carries a banner inside it linking to the Finder (`site/patches/materials.json`). The Inspiration import can also send a cropped photo straight to the Finder ("Find similar materials", alongside "Use in Design Studio": `site/inspiration/{ui,flow,handoff}.js`) — see C3.
**Verified (2026-11-01):** `node --check` on `finder.js`; a real Chrome browser (`tests/e2e/run.mjs`, 5 new tests, run three times for stability): the page opens under its own strict CSP with no violations, the mode tabs toggle correctly, an honest notice disables every button when the catalogue is off (true of the dev stack used here, and of this site until D1's live run happens), upload → drag the reticle → "search whole photo" → "retake" all behave as shown, and — using Puppeteer's fake camera device — "Use camera" produces a real video stream with the reticle and photo actions appearing. Every field and status code the page depends on was cross-checked against `server/catalogue/validate.js` and `service.js`, not guessed.
**Not verified:** any search against a real, ingested catalogue (the dev stack's catalogue is off by default, and no real Modal/GCS/MongoDB exists in this environment — see D1's "A live run"); the fine-tuning claim behind the `dino`/`siglip`/`vertex_mm` signals (F1a).
**Remaining:**
- [ ] A real catalogue to search (D1: upload Terucon's materials and make a release live) — until then, `/finder` has nothing real to find.
- [ ] Wire the shop's own camera/photo search to the real endpoint too, in place of the colour-on-device demo (today the shop only links out to `/finder`; it does not call the API itself).
- [ ] Live pricing (needs real prices, see C1/A2).

### C5. Voice / text brief parser
**Promised:** the client describes the vision; the app pre-fills a matching design.
**Status: 🔵 Demo screen only**
**Exists:** the shop assistant parses text (sizes, area, budget, colour words) with regular expressions and has browser voice input; it searches shop products and is flagged `demo: true`.
**Remaining:**
- [ ] A language-model parser.
- [ ] Pre-fill a **design** in the studio (surfaces and finishes), not only a product search.
- [ ] Voice input in the studio.
- Note: a real text-search building block exists and is now reachable by a visitor, just not from here or as a brief parser: the Finder page's "Words" mode (see C4) searches it directly. Pre-filling a **studio design** from a described brief is still unbuilt.

### C6. Ask-your-quote assistant
**Promised:** a chat assistant that answers questions about the client's own quotation, grounded strictly in their BOQ numbers.
**Status: 🔵 Demo screen only**
**Exists:** the dashboard chat is scripted (pattern-matched replies) over the hard-coded demo project; it is not an LLM and not tied to a BOQ.
**Remaining:**
- [ ] LLM chat grounded only in one project's real BOQ (see F3).
- [ ] A real project and BOQ store to ground it in (see A2, A3).

### C7. Colour-match from any photo
**Promised:** upload any photo and get matching wall colours from the paint partner's palette.
**Status: ⬜ Not done**
**Exists:** the studio has a custom-colour paint tool (`customPaint` in `catalog.js`) that could receive a colour; the shop's photo search (C4) is the closest existing thing and it matches shop products, not paint.
**Remaining:**
- [ ] Extract colours from a photo.
- [ ] Match them to the paint partner's palette. **The partner and palette are not named anywhere in the repo: needed from you.**
- Note: the Finder page's "Colour" mode (see C4) already does colour-only matching against whatever catalogue is live, reachable by a visitor today; it is generic (not paint-specific) and there is no paint catalogue to point it at.

### C8. WhatsApp quote delivery & approval
**Promised:** quotations are sent and approved over WhatsApp instead of email.
**Status: 🔵 Demo screen only**
**Exists:** the dashboard's "Send this price to my WhatsApp" only sets `waSent: true` and shows "Sent ✓"; nothing is sent. Its WhatsApp links use the placeholder number `910000000000`. The studio shares through the device's share sheet (`swatchroom/public/js/lib/share.js`), which is manual.
**Remaining:**
- [ ] WhatsApp Business API account and message templates (messaging cost is billed separately, see section G).
- [ ] Send the quote; receive and record the client's approval.
- [ ] Real WhatsApp number in place of the placeholder.

### C9. Human-like chat & voice assistant, including incoming calls
**Promised:** a real-time bot that talks to clients like a person, including taking incoming calls.
**Status: ⬜ Not done**
**Remaining:**
- [ ] Real-time chat bot.
- [ ] Voice and incoming-call handling (telephony provider; call cost billed separately).
- [ ] Restrict it to each project's own data (F3); hand over to the team.

---

## B. Additional features requested by Terucon (the PDF's second table)

### A1. Materials marketplace
**Promised:** browse and buy materials directly from renders and BOQ; orders tracked in the admin panel.
**Status: 🔵 Demo screen only**
**Exists:** `/materials`: 24 products, 146 variants, 3 brand labels, cart, checkout, order confirmation, PIN-code delivery check. Its own data layer says "FRONTEND DEMO": payment returns `demo-not-charged`, orders are stored in the visitor's browser (`localStorage`), prices, stock, delivery and GST are demo values, and every brand except SuperBond is a placeholder (`pages_original/market_place.html`).
**Remaining:**
- [ ] A backend for products, stock and orders.
- [ ] Real catalogue, real prices, real brands.
- [ ] A payment gateway (fees billed separately).
- [ ] Order tracking in the admin panel (D3).
- [ ] "Buy from renders and BOQ": link studio finishes and BOQ lines to shop products.

### A2. Structured Bill of Quantities
**Promised:** every estimate breaks into item, unit, quantity, rate, amount.
**Status: 🟡 Partly done**
**Exists:** the studio's materials dialog (`swatchroom/public/js/views/dialogs.js:1202-1330`): Product, Surface, Area, Quantity, Amount, a total, and CSV export with a Rate column (`swatchroom/public/js/lib/products.js:526-547`). Quantities come from rules in `swatchroom/public/js/data/takeoff.js` (paint litres, panels, rolls, boxes, adhesive).
**Remaining:**
- [ ] Fixed columns item / unit / quantity / rate / amount.
- [ ] Rates from Terucon's price list. Today the amount stays blank until someone types a rate.
- [ ] Rates editable by admin (D2).
- [ ] Stored per project; routed through supervisor review (F2). The quantities are estimates from one photo.

### A3. Actual vs. virtual quotation
**Promised:** track the AI estimate against the measurement-verified final bill; the difference is visible to admin and client.
**Status: ⬜ Not done**
**Exists:** only a static story on the dashboard (measurement visit → final price → advance).
**Remaining:**
- [ ] Store the virtual (AI) and the actual (measured) quotation per project.
- [ ] Show the difference to admin and client.
- [ ] Full audit trail of every adjustment (F4).

### A4. Elevation (exterior design) support
**Promised:** the same hover-editing and material-swap experience for building exteriors and façades.
**Status: ⬜ Not done**
**Exists:** the studio's surface kinds are interior only: wall, floor, ceiling, window, door, furniture, other (`catalog.js`). The shop sells façade materials; that is the marketplace, not exterior rendering.
**Remaining:**
- [ ] Façade scan / segmentation.
- [ ] Exterior finish catalogue.
- [ ] Hover and swap on exteriors; fine-tune on exterior finishes (F1b).

### A5. Brand priority controls
**Promised:** admin sets which brands appear first in the BOQ and marketplace, without changing pricing.
**Status: ⬜ Not done**
**Exists:** the shop ranks with hard-coded `featured` / `promoted` flags in its data.
**Remaining:**
- [ ] Admin control of brand order (D4), applied to the BOQ and the marketplace.

### A6. Labour training program
**Promised:** extra pages so labour can register and access training content.
**Status: ⬜ Not done**
**Remaining:**
- [ ] Registration pages.
- [ ] Training content access. The content has to come from Terucon.

### A7. Hover Editing & Rendering — core priority
Same engine as **C1**; tracked there.

### A8. Milestone-based payment flow
**Promised:** customers pay 50% upfront; the final bill adjusts once real measurements are taken.
**Status: 🔵 Demo screen only**
**Exists:** the dashboard tells the story ("You pay nothing now… pay half as an advance… the rest after fitting"). There is no payment behind it.
**Remaining:**
- [ ] A payment gateway and per-project milestone state.
- [ ] The final-bill adjustment (A3).
- [ ] **Decide the order.** The demo has the 50% paid *after* the client approves the measured final price. The PDF says 50% *upfront*, with the final bill adjusted after measurement.

### A9. 6 months of post-launch support
**Status: ⏳ Later** (starts at go-live; bug fixes and reasonable support for new feature requests).

### A10. Session recording & analytics (PostHog)
**Promised:** PostHog gives the admin team session recordings and usage analytics.
**Status: ✅ Done** (in code and tests; never run against a real PostHog project)
**Exists:** one script on all five pages (`site/patches/snippets/analytics.js`), `GET /api/analytics` (`server/routes/analytics.js`), the studio's own server events; session replay with all text masked; Do Not Track respected; silent on localhost.
**Remaining:**
- [ ] Put the real `POSTHOG_KEY` in `.env`.
- [ ] Switch session replay on in the PostHog project.
- [ ] Confirm real events arrive.
- [ ] Decide on a cookie notice (not shown by the site).

### A11. Product / installation guide per material
**Promised:** each material carries usage, installation method, adhesives, accessories and technical specs.
**Status: 🟡 Partly done**
**Exists:** the studio has install and care notes per category plus adhesive quantities (`takeoff.js`, `products.js`); the shop's products have `specs`, `install`, accessories and `handling` fields and an "Installation guidance" section, with demo content.
**Remaining:**
- [ ] Real usage / installation / adhesive / accessory / spec content for each Terucon material (from Terucon).
- [ ] Show it where a material is chosen in the studio, not only in the shop.

---

## C. Approach commitments

### F1a. Fine-tuning for the Swatchroom
**Promised (PDF):** "The rendering engine requires model fine-tuning against your actual catalogue so materials shown … match what gets installed, not a generic approximation." The PDF also calls it "a meaningful part of this investment".
**Status: ✅ Done (per you, 2026-10-30)**: you told me the fine-tuning is done for the Swatchroom.
**What this repo can and cannot show.** It cannot confirm it. The repo has no training code, training data or custom weights, and everything it is configured to load is a published model: SegFormer `nvidia/segformer-b2/b4/b5-finetuned-ade` (`swatchroom/python/scene.py:30-32`); OneFormer `shi-labs/oneformer_ade20k_swin_large`, SAM 3 `facebook/sam3`, MoGe-2 `Ruicheng/moge-2-vitl-normal` and Marigold `prs-eth/marigold-iid-*` (`swatchroom/modalBlueprint.py:201-217`); and Google's Gemini image models, picked by name, for the renders (`swatchroom/public/js/lib/settings.js:7-24`). I also searched `/Users/mayank/XTRA` (`modal/`, `modalDeployment/`, `terucon_swatchroom_demo/`) for training scripts, notebooks, weights and datasets and found none for this project.
**Evidence still to attach** (a short note is enough, here or in a doc): which model(s) were tuned; on what data and how much; when; where the tuned result runs or is stored (a Modal app, a Hugging Face repo, or settings and prompts in the studio); how it was checked.

### F1b. Fine-tuning for exterior / elevation finishes
**Promised (PDF):** the fine-tuning covers "both interior materials and exterior/elevation finishes".
**Status: ⬜ Not done** (as far as I can tell: the Swatchroom has no exterior mode, see A4). If the tuning you did already covered exterior finishes, tell me and I will tick this.

### F2. Supervisor review
**Status: ⬜ Not done.** Every AI estimate, BOQ line item and render should go through the existing Admin / Supervisor review step before a client sees it.

### F3. Chat restricted to the project's own quote
**Status: ⬜ Not done.** See C6.

### F4. Audit trail on actual-vs-virtual adjustments
**Status: ⬜ Not done.** See A3.

### F5. Modern, professionally designed frontend
**Status: 🟡 Partly done.** The four pages exist as Claude Design exports (`pages_original/`, studio export `swatchroom/terucon/Swatchroom.html`). The screens for the admin panel, labour training and the rest do not exist yet, and Terucon's sign-off on the visual direction ("finalized together before build") is not recorded here.

## D. Admin panel (the PDF's "Scope Clarity": a focused panel, not an ERP)

- [ ] **D1.** Upload and manage designs (interior and elevation). **🟡 Partly done** (2026-11-01) — a real backend and a screen; not yet run against a real catalogue or real services. See below.
- [ ] **D2.** Edit pricing and BOQ rates. Not done.
- [ ] **D3.** View incoming marketplace orders. Not done.
- [ ] **D4.** Control brand display sequencing. Not done.
- [ ] **D5.** Track virtual vs. actual quotations per project. Not done.

**What exists besides:** the sign-in admin API (`/api/auth/admin/*`, `server/routes/authAdmin.js`): settings with bounds (rate limits and more), the security log, status, unlock, the CRM queue, behind `AUTH_ADMIN_TOKEN`. It is groundwork, not an admin panel: no screen, and none of D2 to D5 (D1's own backend is below). **And something else:** the studio's `/admin` is an operations view (model and service status, live visitors, generation log; `swatchroom/public/js/admin/admin.js:156-174`). Its sign-in password is **still the studio's built-in default** (checked 2026-10-30), so anyone who knows the default can sign in. Change `ADMIN_PASSWORD` before the site is online.

### D1. Upload and manage designs — the catalogue retrieval engine
**Promised:** the admin uploads catalogue designs (interior and elevation) for the suite to use.
**Status: 🟡 Partly done** (2026-11-01; the screen was added later the same day). Real logic, tested against mocks; the admin screen now exists too, hand-verified against the real route code plus one live Chrome test of its token gate — but neither the API nor the screen has ever been driven against a real Modal/GCS/MongoDB backend or Terucon's own catalogue.
**Exists:** a full compute → bundle → publish → search pipeline, ported from the owner's prototype notebook (`terucon-cat-1.ipynb`) and documented as a contract in `catalogue/ARCHITECTURE.md`:
- **Python package** `catalogue/terucon_catalogue/` (PDF/photo extraction, the `dino`/`siglip`/colour/Vertex/Gemini-caption encoders, the publisher, the search service, a Modal app `catalogue/modal_app.py`) plus `catalogue/requirements.txt`, `requirements-dev.txt` and `pyproject.toml` (added 2026-11-01; they did not exist before, so nobody could set up a matching environment from the repo alone). Excluded from the website's Docker image (`.dockerignore`), as the contract requires.
- **Website gateway** `server/catalogue/` (`server/routes/catalogue.js`, mounted in `app.js`): client routes `GET /api/catalogue/status`, `POST /api/catalogue/warm`, `POST /api/catalogue/search` (photo, point-to-find, colour mode), `POST /api/catalogue/search-text`; admin routes `server/catalogue/adminRoutes.js` under `/api/catalogue/admin/*` — create a catalogue, upload a PDF or photos (signs GCS PUT URLs, never touches the file itself), start/cancel a job, list/edit items (label, product code, visibility, free-form attributes), list releases and activate one (with rollback). Behind `AUTH_ADMIN_TOKEN`, same pattern as the sign-in admin API.
- Product identity is nullable throughout, as the data demands: the notebook's own run on the real catalogue PDF found no text layer, so none of its 69 items could be matched to a product code (see `catalogue/ARCHITECTURE.md` section 1); the schema, the admin edit screen's "clear the code" behaviour, and the search response all carry `productId: null` rather than inventing one.
- **The admin screen** (2026-11-01): `site/catalogue-ui/admin.js`, a single plain ES module (no build step, no dependency) bound to the ids already in `pages/admin-catalogue.html`. The admin token (`AUTH_ADMIN_TOKEN`, pasted in on the page, kept only in memory and this tab's `sessionStorage`, never `localStorage`) gates everything below it: connecting calls `GET /overview` and tells a 404 ("no admin token is configured at all") apart from a 401 ("that token was not accepted"). Once connected: the overview's catalogues/jobs/configured pills; create a catalogue; choose files and "Sign and upload" (`POST /uploads` once for the whole batch, then the browser `PUT`s each file straight to its signed Cloud Storage address with exactly the headers the server returned — never through this website — updating each row chosen → signing → uploading → done/failed; "Start processing" only appears once every file has uploaded, and calls `POST /jobs`); the jobs list (`GET /jobs`, Start/Cancel buttons by status, a progress bar, a click-to-expand log via `GET /jobs/:id`); items by catalogue with a text filter (debounced 300 ms) and "Show more" paging, an Edit panel (label, product code, a JSON attributes textarea, Hide/Show) that `PATCH`es only the changed fields, clearing a field to `null` to match the API's "falls back to the PDF's code, or nothing" rule, and a plain-English error if the attributes textarea is not valid JSON or not a plain object; releases by catalogue with Live/Previous tags and an Activate button. One small `api()` helper is reused for every call (bearer header, the site's `{error:{code,status,message,reason}}` body turned into a readable message).
**Verified (2026-11-01):** `catalogue/` was an untested checkout (no dependency was installed in this container); after installing the pinned stack (`torch`, `transformers`, `PyMuPDF`, `opencv-python-headless`, `google-genai`, plus `scipy`, `torchvision`, `pandas`, `mongomock`, `modal`, `pytest`, `httpx` — now in `requirements.txt`/`requirements-dev.txt`), `pytest` runs **764 tests, 0 failed, 0 skipped**, including the notebook-oracle parity suite and `tests/test_release_reader_with_writer.py` (the search side reading a release the real publisher just wrote — the exact PY-C → PY-B handoff). Fixed along the way: `server/catalogue/validate.js`'s `safeNameParts` did not strip accents (`normalize('NFKC')` keeps them precomposed), so an accented upload filename fell through to its generic fallback instead of transliterating — now `NFKD` + strip combining marks first. Fixed 7 bugs surfaced by `tests/js/catalogue-admin.test.js` (then 29/29 passing; some were test bugs — an unescaped space or `../` in a raw HTTP path, a Content-Type the test forgot to set, an injection-safety check run after the test had salted the very label it was checking — not implementation bugs; three were real: the "signing key not usable" message, and the accent-stripping bug above). `npm test` (site build, links, the project overview, 710 JavaScript tests) is clean; the project overview's catalog did not yet describe `catalogue/`, `terucon-cat-1.ipynb` or the 16 new API routes — fixed in `docs/overview/catalog/`. Spot-checked the NODE ↔ PY-B contract: the Modal paths (`/healthz`, `/v1/search`, `/v1/search-text`, `/v1/ingest`, `/v1/ingest/cancel`) and the `409 release-missing` / `409 feature-version-mismatch` reason slugs match exactly between `server/catalogue/modalClient.js` and `catalogue/terucon_catalogue/{http_app,release_reader,search}.py`.
**Not verified:** no real PDF, photo, Modal GPU, GCS bucket or MongoDB was used anywhere in this (nothing in this repo has Terucon's actual catalogue, and this container has no Modal/GCP/Mongo credentials); the Modal app has never been deployed; the admin's write events reach the sign-in security log in the fake server, not a real one.
**Verified (2026-11-01, second pass): the owner's "compute on Kaggle/locally, then just publish" path (`catalogue/terucon_catalogue/cli.py`), which had no test file of its own** (every other module does; `cli.py`'s own argparse layer was untested). Ran the real command line, not just its inner functions: `python -m terucon_catalogue --help` and all 9 subcommands' `--help` parse cleanly; built a synthetic bundle with the test suite's own factory and ran the real `verify` command on it end to end (`Checked ...: 5 items. No problems. It can be published.`); ran `publish --bundle ... --catalogue demo-cat --dry-run` against that bundle with `CATALOGUE_LOCAL_STORE` (a folder standing in for GCS, a real option the CLI documents) and no `MONGODB_URI` — it stopped cleanly with `UsageError: No MongoDB connection string. Set MONGODB_URI (for example mongodb+srv://***@cluster.example.net/terucon).`, which is the right thing to say with nothing more configured than that. **Still not verified:** `publish`/`import-bundle`/`activate`/`releases`/`catalogues` against a real MongoDB (needs `MONGODB_URI`, which this container does not have); `compute`/`ingest` at all (they call the real DINOv2/SigLIP/Vertex/Gemini code, which this session's rules forbid running against real weights or real Google services); a real finished Kaggle run's `state.sqlite` + `crops/` folder (only ever tried on a synthetic one).
**Verified (2026-11-01, third pass): the admin screen.** `node --check site/catalogue-ui/admin.js` (it is a browser module; this only confirms syntax). Every call it makes was cross-checked by reading `server/catalogue/adminRoutes.js`, `server/catalogue/admin.js`, `server/catalogue/validate.js` and `server/catalogue/gcsSigner.js` line by line (exact fields, status codes, error reasons, the `uploads[i].url` / `uploads[i].headers` shape for the direct-to-GCS `PUT`), and against `tests/js/catalogue-admin.test.js`'s request/response shapes in practice. One Chrome end-to-end test was added (`tests/e2e/run.mjs`, "Catalogue admin: with no AUTH_ADMIN_TOKEN configured..."): it opens `/admin/catalogue` for real in Chrome against `tests/dev/stack.mjs`, checks the page's CSP (`script-src 'self'`, `connect-src 'self' https://storage.googleapis.com`), types a token, clicks Connect, and confirms the page says plainly that no admin token is configured (not "wrong token"), never reveals `#admin-sections`, and never keeps the rejected token in `sessionStorage`. Ran twice; passed both times (`npm run test:e2e`'s own report: 18/21, the other 3 failures pre-existing and unrelated — `https://unpkg.com` not answering, see the Tests note below). Ran `npm test` (JavaScript tests + build + links + the project overview) afterward: no new failure; the one pre-existing failure ("project overview is current" / "check 3: routes") is unchanged by this work (see "Open decisions" and the note at the top of this section) and is someone else's to close.
**Not verified** (could not be, from here, without the things this needs from you — see "A live run" below): connecting with a *real* `AUTH_ADMIN_TOKEN` and driving an actual catalogue through it — create, upload, sign, `PUT` to Cloud Storage, start a job, watch it finish, edit an item, activate a release. `tests/dev/stack.mjs` (the dev stack the Chrome tests share) sets up no `AUTH_ADMIN_TOKEN` and no catalogue backend (Modal/GCS/MongoDB) at all, only the studio's own mock GPU services; wiring that in is a real piece of work on its own (new env vars, a catalogue-admin token, fake Modal `search`/`ingest` apps, a fake GCS signer, reachable from a page the real website serves) and was left out rather than rushed, per this file's own rule 3 — the node:test suite already does this (`tests/helpers/fakeCatalogueModal.js`) at the HTTP level, just not through a real browser. Also not verified: the behaviour of a real signed `PUT` against real Cloud Storage from a browser (CORS on the actual bucket is Google's and the admin's to configure, not this code's).
**Remaining:**
- [ ] **A live run**: a real catalogue PDF/photos (Terucon's), Modal deployed (`modal deploy`), a GCS bucket, a MongoDB. Needed from you (see "Ask Terucon" below). Once you have those, `import-bundle --bundle <your Kaggle output> --catalogue <id> --source-pdf <pdf> --activate` is the one command that takes a finished Kaggle run straight into MongoDB + GCS, no GPU needed on the machine running it.
- [ ] A Chrome test of the screen's *success* path (create a catalogue, upload, a job that finishes, edit an item, activate a release) — needs the dev stack above wired up first.
- [x] Wire the browser side to this engine (2026-11-01): the Finder page now does (see C4); the shop's own camera search and the inspiration hand-off's hook also now reach it (see C3, C4). Still open: C5 (a studio brief parser, not just a search box) and C7 (a paint-specific palette).
- [ ] A test file for `cli.py` itself (every other module has one; this session only smoke-tested it by hand, see above).
- [ ] `catalogue/ARCHITECTURE.md`'s own "deliberately not here" list stays open: no OCR reading of a printed label, no Nano Banana rendering, no near-duplicate page merging.

## E. MCP: "talk to your system like you'd talk to a person"

### E1. MCP server for the admin panel
**Status: ⬜ Not done.** No MCP server in the repo.
- [ ] An MCP server that lets Claude check orders, update a price, pull up a design and review a BOQ. It needs the admin panel and a backend to talk to (D, A1, A2).

## F. What's included in the price

- **I1. Domain registration and setup: ⏳ Later.** Not code; nothing in the repo; happens at deploy.
- **I2. CRM integration: 🟡 Partly done.** **The PDF says** "CRM integration, provided your CRM supports standard API access: as of now Vyapar". **You asked for Zoho CRM (2026-10-30, per you)**; the PDF's wording ("your CRM", "as of now") allows the change, but the CRM Terucon really uses is for you and them to confirm. **Exists:** a finished sign-up (name, e-mail, phone, firm, with which of them were verified) is queued and sent to Zoho CRM by a background loop: token kept and refreshed once, upsert by e-mail into Leads (`Last_Name` and `Company` always filled), later changes update the same record, retries with growing delays, jobs wait (nothing lost) until the Zoho credentials are in `.env`, deletion purges what waits and can delete the Zoho record (off by default). Field names, module and the lead source are settings the admin API changes (`server/auth/crm.js`, `server/auth/settings.js`, `tests/js/auth-crm.test.js`: 11 tests against a pretend Zoho). **Verified:** the code against a pretend Zoho, whose calls follow Zoho's own pages for refresh, upsert, update and mandatory fields (read 2026-10-30). **Not verified:** any live Zoho; the delete call (written from memory: its docs page could not be read); that the org's layout does not require other fields. **Remaining:** [ ] a live run with real credentials; [ ] connect the landing page's enquiry form (still sends nothing); [ ] Vyapar, if Terucon still wants it (nothing built); [ ] decide what deleting an account should do in the CRM (default: the sales team's record stays).
- **I3. $50 Render hosting credit: 🟡 Partly done.** `render.yaml` and `Dockerfile` are written and have never been deployed. `render.yaml` asks for `plan: standard` for the `terucon-models` service; check that against the credit (current Render prices not checked).
- **PostHog** is the PDF's fourth "included" item: see A10.

## G. Not included in the price (billed separately at actual cost, per the PDF)

LLM / AI model usage, image generation, vision and segmentation calls, WhatsApp Business API messaging, voice and calling costs, payment gateway fees. Related: the landing page wakes the GPU services on every visit, and a started GPU is billed until idle (README "Cold start").

---

## Foundation work (real, but not a quoted feature, so not counted above)

- The website: four pages (landing, Materials, My project, Design Studio) on one Express server (`app.js`, `server/`), the site as data (`site/`), build and check tooling (`tools/`).
- The Design Studio mounted in the same process without editing it (`server/lib/swatchroom.js`).
- The studio opened with its passcode off, protected by per-browser rooms and per-hour rate limits (`server/lib/studioShield.js`).
- The landing page wakes the GPU services early (`POST /api/studio/warmup`); a Coming soon page for unknown addresses.
- A project overview page (`/project-overview`), run guides, a Render blueprint and a Dockerfile.
- **Sign-in and accounts (2026-10-30; not a quoted feature, so not counted above, but I2 and C2 lean on it).** Every page but the landing page, and the studio's costly and private API, need an account: e-mail or mobile number and a one-time code, or Google One Tap. New people fill in name, the other contact detail and firm (a firm name is suggested from a business e-mail, editable). Account page: details, confirm or change a contact, sign out (here or everywhere), delete account (fresh code; also deletes saved studio rooms). Rate limits, code rules, session lifetimes, open ways in and more are settings with hard bounds in the database, changed through an admin API for the future panel. Studio rooms now belong to the account, not the browser. Evidence: `server/auth/`, `server/routes/auth.js`, `server/routes/authAdmin.js`, `pages/login.html`, `pages/account.html`, `README.md` "Sign-in, accounts and the CRM". The second contact detail (phone for someone who signed up by e-mail, and the other way round) is confirmed with a code before the sign-up counts as finished, so either one signs the same account in later. The Design Studio's own rate limits are admin-managed too (the admin's value wins over `STUDIO_LIMIT_*`). On your own computer nothing needs setting up: codes are printed in the terminal. **Verified:** 554 JavaScript tests (550 pass, 0 fail, 4 skipped; run 2026-10-30), 14 Chrome tests (all pass, run 2026-10-30, including the whole sign-in flow in a real browser), and a security pass kept as `tests/js/auth-attacks.test.js` (38 attacks). **A real hole was found and fixed**: `/API/rooms/...` (other capitals) slid past the studio's rate limits, room ownership and the JSON / Origin guards (`server/middleware/canonical.js`). **Not verified:** no live mail server, SMS gateway, Google, Zoho or MongoDB (pretend servers, with real TLS for SMTP, and an in-memory stand-in for the database; `AUTH_TEST_MONGODB_URI=... npm run test:js` runs the same database checks against a real MongoDB); Google One Tap in a browser (needs the client id); no sign-in e-mail or text has been sent anywhere.
- Tests: 636 JavaScript tests, 632 pass, 0 fail, 4 skipped (run 2026-10-31), plus 20 Chrome tests (all 20 passed in the last of several runs on 2026-10-31; in others the existing landing-page tests failed because the exported pages load React from `https://unpkg.com` at run time and the network did not answer, or because one assertion looked 0.1 s after a page's intro animation ended: that wait is now polled, see the change log). They test wiring, pages, links, guards and the sign-in against mock services, not the quoted features, except the inspiration import (C3), which also ran live (see C3).

## Open decisions and gaps that need you

1. The enquiry form sends nothing: choose a destination (email, CRM or WhatsApp).
2. Placeholders on the pages: phone `+91 00000 00000`, WhatsApp `910000000000`, generic LinkedIn and Instagram links.
3. `/admin` still has the default password.
4. The tool has several names: "Swatchroom", "Design Studio", "Try it with your photo".
5. Waking GPUs on every landing visit costs money: set a spending limit on the Modal side, or `STUDIO_WARMUP=off`.
6. The payment order in A8 (50% upfront vs. after the measured price).
7. The paint partner and palette for C7.
8. The date of the first payment cycle (the timeline counts from it).
9. Render plan vs. the $50 credit (I3).
10. The evidence note for the fine-tuning (F1a), and whether it also covered exterior finishes (F1b).
11. **Which CRM**: the quotation says "as of now Vyapar"; Zoho is built (I2). Confirm with Terucon.
12. **Credentials for sign-in and the CRM** (see "Ask for these now"). Until they are in `.env` the sign-in page says it is not available on a real server (it fails closed), and sign-ups wait in the CRM queue.
13. **Countries allowed for text-message codes: `91` (India) only**, my starting choice, changeable in the admin API; text messages to other countries are how toll fraud runs up a bill.
14. **The sign-up page's wording** ("Terucon keeps these details and its team may contact you about your project") describes what the code does; whether it is enough under India's data-protection law, and a privacy page to link to, are for you and Terucon. I did not write legal text.
15. **Deleting an account deletes the saved Design Studio rooms and photos, but not the CRM record** (the sales team's record; a setting changes that). Rooms saved before sign-in existed belong to a browser cookie and are now hidden.
16. **`/project-overview` is public** and lists routes, settings names and files; consider restricting it. **`POST /api/studio/warmup` is public** (by design, for the landing page), so a bot can keep the GPUs billing; consider a limit. I did not change either.
17. **The dashboard's header still shows the demo person "Meera"**; its profile menu now leads to the account page.
18. **A text message per sign-up.** Confirming the second contact detail means one extra code (an SMS for someone who signs up by e-mail), which costs money; `signup.confirmSecondContact` in the admin API turns it off (then a typed number is only saved, and signing in with it would start a second account, so the page says so).
19. **MSG91 is not supported directly** (its API pages could not be read): use `AUTH_SMS_PROVIDER=webhook` to reach it, or tell me and I will read its docs.
20. **Inspiration import (2026-10-31):** (a) a real public Pinterest pin or board address, to run it live once (C3); (b) whether to remove the unused first importer (`server/lib/pinterestImport.js`, `python/pinterest_board.py`: I could not delete them, an untracked file with no git copy, so they stay until you say); (c) Instagram, Facebook and X are refused with an "upload instead" message, by design; (d) **the exported pages load React from `https://unpkg.com` when a visitor opens them** (found while running the browser tests): if that CDN is slow or down the landing page, shop and dashboard do not start; consider serving it from the site.

## Work history (from `git log`)

| Date | Commit | |
|---|---|---|
| 2026-09-23 | `fd79a15`, `5d50f16` | first commit; 2nd commit |
| 2026-09-25 | `cb72a6b`, `48f7886` | market place added; new market place added |
| 2026-10-01 | `001b70a` | marketplace upgraded |
| 2026-10-18 | `5548254` | swatchroom added version 1 (a separate project copied in) |
| 2026-10-28 | `c35115b`, `a8071ce` | merged swatchroom and main website; merged and passcode removed |
| 2026-11-01 | `618a59d` | updated for ccc (the catalogue retrieval engine, its website gateway, sign-in, inspiration import and this file arrived in the checked-out tree in this one commit) |

## Change log (newest first)

- **2026-11-01 (tenth update): reconciled the two updates below (they ran in parallel, as separate tasks) and closed the one gap both deliberately left open.** No feature work; this is the orchestration pass. Updated this file's own counts and C4/C5/C7 cross-references to agree with each other (the ninth update below moved C4; the eighth update's own text, written before that landed, still called D1's "Wire C3/C4/C5/C7..." item fully open — fixed). Catalogued `pages/finder.html`, `pages/admin-catalogue.html`, `site/catalogue-ui/{client,finder,admin}.js`, `catalogue-ui.css` and the `GET /catalogue-ui/assets/:name` route in `docs/overview/catalog/` (the gap both updates below correctly left alone, since it needed every file to exist first) and regenerated `docs/PROJECT_OVERVIEW.html`. **Verified:** `npm test` (site build, links, the project overview, JavaScript tests) is clean, no failures; `node tests/e2e/run.mjs` run once more after both updates' files were in place: 22/25, the same 3 pre-existing `unpkg.com`-network failures as every run in this session, nothing new.

- **2026-11-01 (ninth update): the Finder page (C4, C5's words mode, C7's colour mode) — the client side of the browser wave, built in parallel with the eighth update below.** Served: C4 (🔵 Demo screen only → 🟡 Partly done); C5 and C7 noted, status unchanged (their own promises — a studio brief parser, a paint palette — are still unbuilt). Built: `pages/finder.html` (already existed from this session's own scaffolding) given its behaviour, `site/catalogue-ui/finder.js` — status/warm on load with an honest disabled state when the catalogue is off, a Photo/Colour/Words mode switch, a camera with a draggable point-to-find reticle sized to the server's own default radius, upload with EXIF-safe resizing, a "search whole photo" option, word search, and the Inspiration hand-off's `?import=<id>` pickup (`take()` from `site/inspiration/handoff.js`, dropped into the viewfinder exactly like an upload). The shop's own "Photo match · preview" demo and the Inspiration crop screen both now point here too (see C3's and C4's own entries for what changed there). **Verified:** `node --check` on the file; a real Chrome browser, five new tests in `tests/e2e/run.mjs` (appended, run three times for stability): the page's own CSP (`strict+catalogue`) with no violations, mode-tab switching, the catalogue-off notice disabling every control, the upload/reticle/retake flow, and — with Puppeteer's fake camera device (`--use-fake-device-for-media-stream`, now on the shared browser launch) — a real video stream with the reticle appearing. Every field, status code and query-parameter rule it depends on was cross-checked against `server/catalogue/validate.js` and `service.js`, not guessed. `npm test` after: no new failure beyond the one already-known, pre-existing gap (the overview catalog, closed below once both this and the eighth update's files existed). **Not verified, and said so rather than guessed:** any search against a real, ingested catalogue — the dev stack's catalogue is off by default and this environment has no Modal/GCS/MongoDB credentials (see D1's "A live run"); the point-to-find reticle's screen-fraction-to-image-fraction mapping was reasoned through, not measured against a real photo with a real catalogue. **A note on running two agents on the same file at once:** this update and the eighth (admin screen) update both appended tests to `tests/e2e/run.mjs` concurrently; a `git stash` one of them used to isolate a pre-existing failure collided with the other's mid-flight edit to the same file and had to be reconciled by hand. Nothing was lost (confirmed here afterward: all tests from both updates are present, the file parses, and the full suite — 22/25, the usual 3 pre-existing `unpkg.com` failures — passes), but it is worth recording as a real risk of running agents in parallel against a shared file, not just a theoretical one.

- **2026-11-01 (eighth update): the catalogue admin screen (D1).** You asked for the browser side of D1: create a catalogue, upload a PDF or photos, watch the job, edit an item's label/code/visibility, choose the live release. Served: D1 (stays 🟡 Partly done — the API already existed; a live run is still needed). Built: `site/catalogue-ui/admin.js`, one plain ES module with no build step and no dependency, bound to the ids already in `pages/admin-catalogue.html` (that file and `catalogue-ui.css` were not changed). Read first, and relied on as ground truth rather than guessed at: `server/catalogue/adminRoutes.js`, `server/catalogue/admin.js`, `server/catalogue/validate.js`, `server/catalogue/gcsSigner.js`, `catalogue/ARCHITECTURE.md` section 7, and `tests/js/catalogue-admin.test.js`'s request/response shapes. **Verified:** `node --check` on the file; every API call and its error shapes cross-checked against the route code and the test file; `npm run test:e2e` run twice (18/21; the other 3 are pre-existing `unpkg.com`-network failures unrelated to this work, confirmed by rerunning); `npm test` run after, with no new failure beyond the one pre-existing, already-known gap ("project overview is current" / "check 3: routes" — `pages/admin-catalogue.html` and the catalogue-ui browser files, including this new one, are not yet catalogued in `docs/overview/catalog/`; left alone, as asked, for whoever is already handling it). One Chrome end-to-end test was added to `tests/e2e/run.mjs` (appended only; nothing existing was restructured): with no `AUTH_ADMIN_TOKEN` configured (true of the shared dev stack), any token must say so plainly, never reveal the admin sections, and never be remembered — all three held up in a real browser against the real server. **Not verified, and said so rather than guessed:** connecting with a *real* admin token and driving an actual catalogue through the screen (create → upload → sign → direct-to-GCS `PUT` → start a job → watch it → edit an item → activate a release). `tests/dev/stack.mjs` configures no `AUTH_ADMIN_TOKEN` and no catalogue backend (Modal/GCS/MongoDB) at all; wiring one in is a real task of its own (new dev-stack env vars, fake Modal `search`/`ingest` apps, a fake GCS signer) and was deliberately left out rather than rushed through — this file's rule 3 exists for exactly that trap. Also not verified: a real signed `PUT` against a real Cloud Storage bucket from a browser (its CORS setup is Google's / the admin's to configure). **Decisions made along the way, and why:** reused the page's existing `.notice`/`.tag`/`.table-list`/`.progress` CSS classes for every state (including success messages, by toggling `notice good`/`notice bad`/`notice info`) rather than adding markup, since the page already has one status element per card; mapped the spec's "ok/bad" tag pills to the CSS's actual modifiers, `tag ok` / `tag failed` (catalogue-ui.css has no `.tag.bad`); on a partial upload failure, left "Sign and upload" enabled so the whole batch can be retried as a new job, since the real API has no per-file retry of an existing job. **Did not touch:** `pages/admin-catalogue.html`, `catalogue-ui.css`, anything under `server/catalogue/` or `catalogue/`, or `docs/overview/` — all out of this task's boundaries by design.

- **2026-11-01 (seventh update): smoke-tested the owner's CLI by hand.** You asked whether the catalogue system actually works end to end, including "the option to store the data directly to the respective locations" by computing on Kaggle or locally. That command line (`catalogue/terucon_catalogue/cli.py`, 636 lines) was the one module in `catalogue/` with no test file of its own (`tests/test_cli.py` does not exist; its inner functions are tested through `test_publish.py` etc., but the argparse wiring and the real entry point were not). Served: D1 (no status change — this only adds verification, already Partly done). **Verified:** `python -m terucon_catalogue --help` and all 9 subcommands' `--help`; built a synthetic bundle with the test suite's own factory and ran the real `verify` subcommand on it end to end ("Checked ...: 5 items. No problems. It can be published."); ran `publish --dry-run` against that bundle with `CATALOGUE_LOCAL_STORE` (a local folder standing in for GCS) and no `MONGODB_URI` configured, and it stopped cleanly asking for one, rather than crashing or writing anything. **Not verified:** the database-writing commands (`publish`, `import-bundle`, `activate`, `releases`, `catalogues`) against a real MongoDB (no `MONGODB_URI` in this container); `compute`/`ingest` at all (they need the real DINOv2/SigLIP/Vertex/Gemini code, which this session's own rules say not to run against real weights or Google services); a real Kaggle `state.sqlite` + `crops/` folder (only a synthetic one was available). Also answered, in chat, which platform hosts which part of the system (Modal: compute + a release cache; GCS: durable files and releases; MongoDB: metadata; the website: gateway only) — not new code, so not repeated here.

- **2026-11-01 (sixth update): the catalogue retrieval engine (D1, and the shared backend behind C3/C4/C5/C7) — resumed, fixed and verified, not newly built.** You asked me to resume three interrupted agents (PY-A compute, PY-C publisher/CLI, NODE gateway) from their on-disk progress, run cross-component tests, then build the browser wave (a finder page, the inspiration matching hook, a shop overlay, the admin upload page). Served: D1 (⬜ Not done → 🟡 Partly done); noted on C3, C4, C5, C7 without changing their status (the user-facing pages are unchanged). **What I found:** the three agents' work was not where the brief said it was (NODE already wired into `app.js`; PY-A/PY-C's modules all present) — a single commit, `618a59d` "updated for ccc", had already landed a complete catalogue package (`catalogue/terucon_catalogue/`, `catalogue/modal_app.py`, 9,125 lines) with 9,008 lines of its own tests, plus the website gateway (`server/catalogue/`) and its own JS tests, all *before this session started*. So there was nothing left to "resume" in the sense the brief described; the real work was assessing what was actually there and fixing what was wrong. **What I did:**
  1. `npm install` (node_modules was not installed in this container) and ran `npm test`: 23 then 8 then, after fixes, 0 of 710 JavaScript tests failing, plus the project overview's own check.
  2. Found and fixed 7 bugs in `tests/js/catalogue-admin.test.js` (not `npm test`-visible until step 1): three were real — the "signing key not usable" error message didn't match what the test (reasonably) wanted it to say ("Run the admin check"); `server/catalogue/validate.js`'s `safeNameParts` did not strip accents from an uploaded file's name (`ünïcode — name.jpg` should become `unicode_name.jpg`; it became `n_code_name.jpg`) because `normalize('NFKC')` keeps accented letters precomposed instead of decomposing them — fixed with `normalize('NFKD')` + stripping combining marks first. Four were test bugs, left over from whoever wrote them: an unescaped literal space inside a raw HTTP path (`BAD SLUG`, `not an id`) and an unescaped `/` inside a `:releaseId` path segment (`../x`), both of which Node's own HTTP client or Express's router rejects before the code under test ever runs; a `Content-Type` header the test forgot to set on one malformed-JSON check (every other such check in the codebase sets it); and a regex-injection safety loop that ran *after* the same test had deliberately put literal `(`/`[` characters into one item's label for a different assertion, so two of its own "this must not match" checks failed against data it had itself salted. Fixed by reordering that one loop to run first, against the clean seed data.
  3. The project overview's catalog (`docs/overview/catalog/`) did not describe `catalogue/` (29 files), `terucon-cat-1.ipynb`, or any of the 16 `/api/catalogue/*` routes `app.js` registers — a real gap against this file's own rule 6, silently failing `npm test`'s "project overview is current" step. Added a `catalogue` owner, a `catalogue/**` glob entry (the same pattern `swatchroom/**` uses) and the 16 routes to `api.json` (request/response/errors drawn from the actual route code and `catalogue/ARCHITECTURE.md`, not invented); regenerated `docs/PROJECT_OVERVIEW.html`.
  4. `catalogue/` had **no way to install its own dependencies** — `catalogue/ARCHITECTURE.md` names `../requirements*.txt` and `../pyproject.toml` as part of what PY-C owns, and neither existed. Built a Python 3.12 venv from scratch in this container and, through trial and error against real `pip` (not memory), worked out the actual needed set: the pinned stack the architecture names (`torch==2.11.0`, `transformers==5.16.1`, `pymupdf==2.0`, `opencv-python-headless==4.14.0.94`, `google-genai==2.12.1`) plus `scipy`, `torchvision`, `google-cloud-storage`, `pymongo`, `fastapi`, `numpy`, `pillow`, `pydantic`, `tenacity`, `google-auth`, `huggingface_hub`, `safetensors`, `requests` (all also in `modal_app.py`'s own image, so this cross-checks it) at runtime, plus `pytest`, `mongomock`, `httpx`, `modal`, `pandas` for the tests alone. Wrote `catalogue/requirements.txt`, `catalogue/requirements-dev.txt` and `catalogue/pyproject.toml` (the package installs as `terucon_catalogue`, version matches `__init__.py`).
  5. Ran `pytest` in that environment: **764 tests, 0 failed, 0 skipped** (an earlier pass had 9 collection errors and a further 17 skips for the missing packages above). This is a real, substantial test suite: the notebook-oracle parity tests (`tests/nb_oracle.py`, running the notebook's own stored definitions), `tests/test_pipeline_real_encoders.py` (the real `EncoderBank` on tiny from-scratch DINOv2/SigLIP models, not mocks), and `tests/test_release_reader_with_writer.py` (the search side, PY-B, reading a release the real publisher, PY-C, just wrote — the one cross-component path you specifically asked me to check).
  6. Checked the other cross-component path, NODE ↔ PY-B, by reading both sides rather than only trusting that each passes its own tests against its own fakes: the HTTP paths (`/healthz`, `/v1/search`, `/v1/search-text`, `/v1/ingest`, `/v1/ingest/cancel`) and the `409 release-missing` / `409 feature-version-mismatch` reason slugs are byte-identical between `server/catalogue/modalClient.js` and `catalogue/terucon_catalogue/{http_app,release_reader,search}.py`.
  **Verified:** all of the above — the exact commands are in this file's own evidence trail (`npm test`; `pytest` from `catalogue/` with the new `requirements*.txt` installed). **Not verified, and said so above rather than guessed at:** anything against a real PDF, a real Modal GPU, a real GCS bucket, a real MongoDB, or Terucon's own catalogue (none of this container's credentials or files include them); the Modal app has never been `modal deploy`ed.
  **I deliberately did not build the browser wave** (finder page, inspiration matching hook, shop overlay, admin upload page) **this session.** Each is a real, separate frontend task (a camera UI with point-to-find, a crop-to-search hand-over, a shop results overlay, and a full admin screen for the API above) that deserves its own pass rather than four rushed, under-tested pages layered on top of a backend that itself needed the fixes above; rule 3 of this file ("a screen on hard-coded data... is Demo screen only, never Done") is exactly the trap I'd have built four new examples of. D1's section above lays out what the screen needs from the API that already exists. **Changed outside the ask, and why:** `tests/js/catalogue-admin.test.js` (the four test-bug fixes above — needed so `npm test` could tell real from illusory failures); `docs/overview/catalog/{files,meta,api}.json` and `docs/PROJECT_OVERVIEW.html` (rule 6).

- **2026-10-31 (fifth update): why the instant preview works on walls, floors and ceilings only (C1). A read-only investigation: no code changed, no status or count changed, "Start here" unchanged.** Served: C1 (a new "Remaining" bullet). **Verified:** the code paths above read line by line; the studio's real decision functions (`tiers.js`, `provisional.js`, `previewScene.js`, `catalog.js`, unmodified) run in Node on a made-up scan (not a photo): wall, floor and ceiling pass, window, door, furniture and "other" fail before the pipeline has run (the browser's own estimate) and also in a **simulated** "pipeline succeeded" case, whose fitted entries I wrote by hand for wall, floor and ceiling at confidence 0.95 to match the server filter (that case is not the server's output); the server's own `regionsFromScan` (its source lines copied verbatim and run, not the whole module) given all seven kinds with pixels returns only wall, floor and ceiling; every file read is older than the running `node app.js` (started 17:36) and the live server on port 8080 serves `provisional.js`, `tiers.js`, `previewScene.js` and `studio.js` byte-identical to the disk copies; the `paint-chalk` and `boucle` texture files are served (HTTP 200). **Not verified:** the user's own session (which objects were tried, the browser's WebGPU / WebGL2, whether their room's analysis finished); the terminal logs of `node app.js` and the scan service (they print to `ttys005` and `ttys001`, not to a file, and cannot be read from here).
- **2026-10-31 (fourth update): the inspiration import (C3).** Served: C3 (⬜ Not done to 🟡 Partly done), F5 in passing (a new, themed page). Built: paste an address into the shop's search box, its assistant or the Inspiration page and a popup asks "Import this photo?"; one registry of sites decides what the address is (Pinterest pins, boards, sections and `pin.it`; Unsplash, Pexels, Flickr, Behance, Imgur, Wikimedia Commons through gallery-dl with each site's own options; a picture link; any web page's named main picture; Instagram, Facebook and X refused with an upload offer); a crop screen; the cropped photo opens in the Design Studio through the studio's own photo input (nothing in `swatchroom/` changed). The earlier, uncommitted Pinterest-only importer, which this file did not record, was generalised and replaced (its files stay, unused). **Verified:** `npm test` (site build, links, overview, JavaScript tests: 632 pass, 0 fail, 4 skipped), 73 of them new; the contract with the real gallery-dl 1.32.18 (offline); 6 new Chrome tests (20 in all; see the Tests line about the existing landing tests that depend on unpkg.com and timing); a live run through the real server, gallery-dl and Chrome against Wikimedia Commons, a picture link and a web page. The safe fetcher was attacked with a local HTTPS server (private and internal addresses, IP literals, redirects to them, endless and slow bodies, wrong types). Two real bugs were found and fixed before delivery: a locked-shape corner drag could break the shape (found by the randomised crop test), and a `pin.it` short link would have been refused because the resolver checked the pin or board it leads to against an allow list that only held the short link's own extractor (found by reading gallery-dl's source; now an explicit `follow` list, tested). **Not verified:** any live Pinterest; live runs of the other gallery-dl sites; the Dockerfile's new Python step (not built); HEIC. **Changed outside the ask, and why:** `tests/e2e/run.mjs` (the hero-link check of the existing phone test now polls up to 8 s instead of sleeping 2.5 s: it looked 0.1 s after the intro animation ended and failed on a busy machine; and an `E2E_STACK=1` switch that prints stack traces), `tests/dev/stack.mjs` (an opt-in `importer` option), `tools/check-links.js` and `site/site.json` (a declared `assets` folder, so a script tag naming a file that does not exist fails the build), `server/lib/csp.js` and `siteMap.js` (a `strict+images` policy for the Inspiration page: `blob:` and each site's picture hosts only), `app.js` and `tests/helpers/app.js` (a test seam for a fake fetcher), `Dockerfile` (Python and gallery-dl), `.env.example` and the overview catalogs, `pages/account.html` (a nav link), and the golden digests of the four built pages (their patches gained nav links and script tags). Two actions were refused by the harness and not retried: fetching Pinterest's and Unsplash's home pages with a browser-like user agent to find sample addresses, and deleting the two superseded untracked files.

- **2026-10-30 (third update): sign-in, accounts and the Zoho CRM connector.** Served: I2 (CRM, now 🟡 Partly done: Zoho, per you, instead of the PDF's Vyapar), C2 (accounts exist; invites do not), the admin groundwork under D (an API, no panel; D1 to D5 stay Not done). Built: sign-in with e-mail or mobile one-time codes and Google One Tap; sign-up form with a firm name suggested from a business e-mail; account page with sign out and delete account; rate limits and other rules as bounded settings with an admin API; a Zoho CRM queue that waits for credentials; the gate on every page but the landing page and on the studio's costly API; studio rooms owned by the account. Found and fixed a real hole: `/API/rooms/...` bypassed the studio's rate limits, room ownership and Origin guard. **Verified:** `npm test` JavaScript step (554 tests, 550 pass, 0 fail, 4 skipped), 14 Chrome tests (all pass), the sign-in flow in Chrome on desktop and phone sizes, 38 written attacks, the SMTP client against a pretend mail server with real TLS and STARTTLS, Google's token against forgeries, the firm look-up's SSRF defences, Zoho against a pretend Zoho. **Not verified:** any live mail, SMS, Google, Zoho or MongoDB; a real MongoDB was never available here (the download of a MongoDB server was blocked, so the database layer ran on an in-memory stand-in; the same checks run against a real one with `AUTH_TEST_MONGODB_URI`); Google One Tap in a browser; the Zoho delete call (from memory). Also: the exported pages' runtime rewrites camelCase names before `=` inside scripts (found when my first snippet broke the landing page); a guard test now catches it. After a review the same day: fixed a flaw where signing in with the *other* contact detail (typed at sign-up, never confirmed) would have started a second, empty account: the second contact is now confirmed with a code at sign-up (both directions tested); `npm start` now works on your own computer with no setup (codes printed in the terminal); `render.yaml` carries the sign-in and Zoho variables; the studio's own limits are admin-managed. Changed outside the ask, and why: studio rooms by account (so deleting an account can delete them), `PUT` in the API registry (the admin settings), a `docs` entry type with `access` and `csp` in `site/site.json`, header and menu links on the pages (the only way to reach the account page), and the dev stack and Chrome tests (they had to sign in).

- **2026-10-30 (second update):** Fine-tuning for the Swatchroom marked ✅ Done *per you* (F1a), with the evidence still to attach; exterior fine-tuning split out as F1b (Not done). Status words changed to Done / Partly done / Demo screen only / Not done / Later, with icons. Added "Where we stand" (counts by group, 34 items), "Start here" (suggested order, what to ask Terucon for now) and "All targets at a glance". Verified: I searched `swatchroom/` and `/Users/mayank/XTRA` (`modal/`, `modalDeployment/`, `terucon_swatchroom_demo/`) for fine-tuning evidence and found none; the models the code loads are all published ones. Not verified: the fine-tuning itself (your word only), anything against live services.
- **2026-10-30:** File created from a read of the code against the PDF. Verified: code read for every item above; JavaScript tests run (369 run, 366 pass, 0 fail, 3 skipped); the admin password check. Not verified: anything against live Gemini, Modal, MongoDB or PostHog; the Python models; the Chrome tests. Also added: `CLAUDE.md` (so this file is read before and updated after every task) and catalog entries for `TARGETS.md`, `CLAUDE.md` and `Terucon_AI_tool.pdf` in `docs/overview/catalog/files.json`.
