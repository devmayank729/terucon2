# Capture from a phone

Added 2026-11-04. **Not a target of the quotation** (`Terucon_AI_tool.pdf` has no phone-capture, QR or WhatsApp-intake item): it is foundation work for the
photo intake of C1 (Design Studio), C3 (Inspiration) and C4 (Finder). `TARGETS.md` records it as such and no status or count changed.

## What a person sees

1. On the **Design Studio, Inspiration and Finder** pages a button "Photos from phone" stands above TeruBot's. The first visit shows a one-line hint.
2. The panel offers two ways to get photos taken by somebody holding a phone:
   - **Show a QR code.** The code holds a link. Any phone camera opens it in its browser (no app).
   - **Send on WhatsApp.** Type a number; the link goes to it (see "WhatsApp" below for what that means today).
3. The phone opens **/capture**: a page with only one job. The person gives a name (needed) and, if they want, phone, address and which part of the
   building; presses **Use my current location** (the real position of that phone, with its accuracy, and a map link); takes photos **inside the page**
   with "Take photos" (a live camera view: the phone's camera app is not opened, so a reload while it is open cannot lose a photo) or chooses several with "Choose from gallery"; puts labels on each
   (Room, Cabin, Wall, Floor, Ceiling, Door, Window, Exterior, Other, or their own) and a note; presses **Send**.
4. On the laptop a **pop-up** says "3 new photos from Ravi" on whichever page the requester is on, and the panel lists the photos under the page they asked
   from, with name, phone, address, place and a map link. Each photo can be **moved** to the Design Studio, Inspiration or the Finder (the page the person
   is already on takes it without a reload where it can), downloaded or deleted.

## How it is built

| Part | File |
|---|---|
| Settings (`CAPTURE_*`, `WHATSAPP_*`) | `server/capture/config.js`, `.env.example` section 10 |
| Storage: three collections (`terucon_capture_sessions`, `_photos`, `_files`), in memory or MongoDB | `server/capture/db.js` |
| The logic: links, uploads, reads, deletes, limits, WhatsApp | `server/capture/service.js` |
| Everything a stranger's phone can send, checked | `server/capture/validate.js` |
| Hidden camera data taken out of a photo | `server/capture/strip.js` |
| WhatsApp Cloud API client and `wa.me` links | `server/capture/whatsapp.js` |
| The routes (the API table is in the project overview) | `server/capture/routes.js`, `server/routes/capture.js` |
| The phone page | `pages/capture.html`, `site/capture/*` |
| The requester's side | `site/brand/capture.js`, `site/brand/capture.css` (loaded lazily by `site/brand/chrome.js`, only where needed) |
| QR code | `site/brand/qrcode-generator.js` (MIT, unchanged; source and hash in `site/vendor/README.md`) |

## Decisions, and why

- **The key to a link is in the part of the address after `#`.** A browser never sends that part to a server, so it is not in Render's request logs, and the
  phone's `Referer` is switched off. It is sent as the `X-Capture-Token` header. A test reads every request the phone page makes and fails if the key is in an address.
- **A link only adds photos.** It cannot read a photo back, list anything, or reach the requester's account. It is 192 random bits, ends by itself (default 2 hours),
  takes a limited number of photos (default 30), and can be ended by the requester at once. Wrong keys are slowed (30 in 10 minutes per address, then 429).
- **The phone page sends no cookie** (`credentials: 'omit'`): it works for somebody with no account, and the requester's session is never exposed to it. A test proves
  it with a decoy cookie and the real outgoing headers.
- **The address in a link is configured, not guessed.** `CAPTURE_PUBLIC_URL`, else Render's own `RENDER_EXTERNAL_URL`. A `Host` header is believed only on this
  computer, where the panel says a phone cannot open that address. Anywhere else with nothing configured, making a link answers 503 and says what to set.
- **Photos are kept in MongoDB, in the same database as the studio's rooms, not in a bucket.** Reasons: one store means one thing to test; deleting a record deletes
  its picture, so the retention rule (`CAPTURE_KEEP_DAYS`, a TTL index on every record) and "delete this photo" cannot leave pictures behind; and the bucket's service account
  is documented as able to read and create objects only (`server/catalogue/gcsSigner.js`), so deleting from it was not known to work. The cost: a photo is stored as text
  (+33 %), so the server takes at most 6 MB (`CAPTURE_MAX_PHOTO_MB`; MongoDB's document limit is 16 MB) and the phone page makes photos about 1 MB before sending. A
  Cloud Storage store can be put behind the same calls later; the routes would not change.
- **Hidden data is removed twice.** The phone page draws every photo again on a canvas (which also turns it the right way up), and the server removes Exif/GPS/XMP/text
  blocks from JPEG, PNG and WebP before keeping it (the second layer is for a photo the browser could not redraw and for anybody calling the route without the page).
  The location that is shared is only what the button read.
- **A retried upload changes nothing.** A photo's id is `<link>_<id the phone made>`; MongoDB's own `_id` uniqueness refuses a second copy, and the place counter goes up
  only when a new photo is really going in (and is put back if the write fails). Six copies sent at the same moment make one photo.
- **The requester sees only their own.** Every read is filtered by the owner (the signed-in account; with sign-in off, the browser's owner id, as for the studio's rooms).
  A photo of another account, and one that does not exist, give the same 404. Photos are sent with `nosniff`, a `sandbox` policy and `private` caching. Deleting an account deletes its photos.
- **Details given by the phone are shown as text.** Every string is cut, stripped of control and line-break characters, and drawn with `textContent`; a phone number is
  `tel:` only after it has been reduced to `+digits`. The same cleaning makes the text safe for a WhatsApp template variable.

## What "stays in the page" does and does not cover

Only **"Take photos"** keeps the person in the page. **"Choose from gallery"** opens the phone's own picker, and on iOS and Android that picker can itself offer "Take Photo" / "Camera": that entry belongs to the phone, hands the screen to the camera app, and carries the old risk (a phone short of memory can reload the tab, and a photo taken that way is lost if the page reloads before it comes back). This page cannot remove that entry (a `capture` attribute is deliberately not used, so the picker is not *forced* to the camera app). What is protected: every photo that has reached the page waits in the browser (IndexedDB) until the server has it, through a reload or a lost connection, and the page says to use "Take photos" for new ones. Not tested on a real phone.

## WhatsApp: two separate things, and what each needs

1. **Sending the link to a number.**
   - *Today, with nothing set up:* the panel builds `https://wa.me/<number>?text=<message>`. It opens WhatsApp (the app, or WhatsApp Web) on the **requester's own device** with
     that chat and message ready; the requester presses send. This works now and needs no account. The server never relays it, so it cannot message anybody on its own.
   - *With the WhatsApp Business Cloud API* (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_LINK`): the server sends the approved template, limited per account (10 an hour),
     per number (twice a day) and per link (three times). The `wa.me` address is in the answer as the fallback if Meta refuses.
2. **Telling the requester when a photo arrives by WhatsApp.** Only possible through the Cloud API with an approved template (`WHATSAPP_TEMPLATE_PHOTO`). The live site signs people in
   with Google, so accounts have no phone number: the requester types their own WhatsApp number in the panel (it is shown back masked). One message goes for the first photo and one summary
   when the phone says it is done, never one per photo. The pop-up and the list on the page work with or without this.

To use the Cloud API you need (all outside this repository): a Meta business account, a WhatsApp Business phone number, an access token, and two templates approved by Meta. The text to
submit (a variable may not be the first or last thing in the body):

- `WHATSAPP_TEMPLATE_PHOTO`: `Terucon: {{1}} sent {{2}} photo(s) for your {{3}} request. Open the site to see them.`
- `WHATSAPP_TEMPLATE_LINK`: `Hi, {{1}} from Terucon asked you to add photos of a space. Open this link on your phone to take or choose them: {{2}} (works for {{3}} minutes).`

**Cost:** the quotation (`Terucon_AI_tool.pdf`, "What's Not Included") puts "WhatsApp Business API messaging" outside the Rs. 2,00,000: it is billed separately at actual cost, so every message the server sends through the Cloud API is a per-use charge from Meta that falls on Terucon, not part of this build. The `wa.me` way costs nothing. The request is Meta's documented one (`POST https://graph.facebook.com/<version>/<phone number id>/messages`, `type: "template"`). **It has not been run against Meta's servers from here:**
it is tested against a fake that checks the exact request body and headers. "Accepted" by Meta is not proof that a phone received the message.

## Trying it on a real phone

A phone can open **https** addresses only for the camera and the location to work (browsers allow both only on secure addresses and on `localhost`). So: on the live site it works as soon
as the site is deployed; on a development computer either put a tunnel in front of it (for example `cloudflared tunnel --url http://localhost:8080` or ngrok) and set `CAPTURE_PUBLIC_URL`
to the tunnel's `https://` address, or open the phone page on the same computer. The panel warns whenever the link starts with an address a phone cannot open.

## What was checked, and what was not

Checked (see `tests/js/capture-service.test.js` and the `capture:` tests of `tests/e2e/run.mjs`):

- Server: who may do what, retried and simultaneous uploads, the photo limit, expiry and ending, bad files, size and pixel limits, hidden-data removal on JPEG/PNG/WebP (and on a real photo from `media/`), owner-only reads,
  deleting a photo, a link, and an account, the exact WhatsApp requests, limits, and refusal handling, and that the token and the WhatsApp token never reach an answer or the log. Against the in-memory database.
- Real Chrome (headless, with a fake camera and an emulated position): a QR code is drawn and the link carries its key after the `#`; the whole journey (in-page camera, gallery, labels, location, send, pop-up, photos with details, move
  to Inspiration, which opens its crop screen); photos survive a reload; no connection and a failing upload are reported in words and a second send works exactly once; blocked location, unreadable format, bad and closed links;
  the headers and policy of the phone page; where the launcher is and is not loaded; the cookie and token leak checks (with a mutation test, run once by hand, that made the cookie check fail).
- **By hand, once (2026-11-04, not repeatable from the repository):** the QR code the page drew was screenshotted and decoded with Apple's Vision framework (`VNDetectBarcodesRequest`, a scratch script that is not kept here); the decoded text was exactly the link shown beside it. The tests in the repository only check that a code is drawn and that the link has the right shape. Scanning it with a real phone is still to do.

**Not checked: a real phone (iOS Safari, Android Chrome), a browser built into another app (WhatsApp's own), HEIC from an iPhone, a real MongoDB (the in-memory stand-in answers the same calls; a contract test
against a real database, `tests/js/capture-store-contract.test.js`, runs when `CAPTURE_TEST_MONGODB_URI` is set and has not been run), Cloud Storage (not used), the WhatsApp Business API, and the live Render site.**
