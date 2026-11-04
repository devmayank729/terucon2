# TeruBot, the one assistant of the site

A launcher labelled "Ask TeruBot" at the bottom right of every page and a chat panel behind it (a docked card of about 380 px on a laptop,
a bottom sheet above the phone dock on a phone). It replaces the two demo assistants that used to exist: "Ask Terucon" on the shop and
"Ask Saathi" on My project. Built by `terubot.js`, styled by `terubot.css`; there is no markup to write. The server side is
`POST /api/terubot/chat` and `GET /api/terubot/status` (`server/routes/terubot.js`); the browser treats everything it returns as untrusted.

## Include it (hand-written pages, strict CSP)

```html
<link rel="stylesheet" href="/brand/terubot.css">
<script src="/brand/terubot.js" defer></script>
```

Same-origin files, no inline code, no inline `style=""`, no external host (`style-src 'self'`, `script-src 'self'`, `connect-src 'self'` are enough).
The four built pages (landing, shop, studio, My project) get the two lines from `site/brand/head.html` (`tools/build-dist.js`); the offline and
error pages have none. Opt a page out with `<html data-terubot="off">` or `<meta name="terubot" content="off">`.

## What happens at page load, and when it opens

Page load builds the launcher only (one button, no request). The panel is built the first time it opens; the first open asks
`GET /api/terubot/status` once (it can be asked again with "Check again"). If TeruBot sent the visitor to this page (see "navigate" below) the
conversation opens again by itself; after an ordinary page change the chat is kept but the panel stays closed. **Exception: the project form
(`/start-project`, also `/start-project/` and with a query).** There the chat never opens by itself, whichever action took the visitor there (a
plain `navigate`, the "Start a project" suggestion, or `prefill_enquiry`), because it would sit on top of the very form they came to read and fill
in; the launcher is there and the conversation is one tap away (`FORM_PAGES`, `leave()` and `mount()` in `terubot.js`; fixed 2026-11-04, before
that only `prefill_enquiry` was excepted).

`window.TeruBot = { open(opts), close(), ask(text), isOpen() }`. `opts` is optional: `{ draft: "text" }` types a draft into the box without sending it,
`{ mic: true }` starts voice input. `ask(text)` opens the panel and sends.

## Where it sits, and the variables it reads

Bottom right, 20 px from the edges, `z-index` 46 (the panel 85). Hidden while the studio works full screen (`html.swr-immersive`), when printing, and
when a page opts out. All variables are optional; TeruBot never assumes a value:

| Variable | Meaning | Set by |
|---|---|---|
| `--tc-dock-h` | height of the phone dock (0 without one); the launcher and the sheet sit above it | `dock.css` |
| `--tc-hdr-h` | height of a site header, so the panel keeps clear of it (fallback 64 px) | the shared header |
| `--tc-side-w` | width of a left sidebar, so the panel keeps clear of it (fallback 0) | the shared header/sidebar |
| `--tb-bottom` | extra room a page needs under the launcher (default 20 px; 16 px on a phone) | the shop sets it from its own bars (`tbSync` in the shop patch) |

Pages that cannot set a variable are handled in `terubot.css`: the Design Studio (`.is-studio`) lifts the launcher above its Share button,
zoom control and status line. On a phone the sheet is `bottom: var(--tc-dock-h) + env(safe-area-inset-bottom)`, with a scrim; while the
on-screen keyboard is up it sits on top of the keyboard (`visualViewport`, not tested on a real phone).

My project below 720 px has its own bottom bar whose centre button ("TeruBot") opens the assistant, so the floating launcher is hidden there
(`terubot-room` in `site/patches/dashboard.json`).

## What it sends

Only this, and only to `/api/terubot/chat`:

```json
{ "messages": [ {"role":"user|assistant","text":"..."} ],
  "context": { "path":"/materials", "title":"...", "cart":[{"id":"<variant id>","qty":2}], "saved":["<variant id>"], "viewport":"desktop|phone" } }
```

Last 12 messages, 2000 characters each; failed attempts, the greeting and the "Done:" lines are not part of it. `cart` and `saved` are read from the shop's
own `localStorage` keys (`terucon.store.v1.cart` = `[{vid, qty}]`, `terucon.store.v1.saved` = `[{pid, vid}]`): variant ids. No cookies, e-mail or photos.

## What it accepts back (and how it is shown)

`reply` goes in with `textContent` (nothing in the file builds HTML from a string). Cards (`kind: "material"` only, at most 6) need a same-origin `href`; the
picture must be a same-origin image path or empty (an empty or failing picture shows a plain tile). Actions are taken from a fixed list; any other type, a
`navigate.to` that is not a path of this site (scheme, `//`, backslash) or that points at `/api/...` is dropped. One trip (navigate, open_studio or
prefill_enquiry) per answer, done after the other actions. Errors: `{error: "text"}` and the guards' `{error: {code, status, message}}` are both read; 429 uses
`retryAfterSec` or the `Retry-After` header and holds the send button back for that time; `aiOn: false` and an unreachable server are said in words.

## What each action does (every one leaves a "Done:" line; what can be undone has Undo)

| Action | Effect |
|---|---|
| `navigate {to}` | writes the chat to `sessionStorage`, then `location.assign(to)`. The Back button returns. A hash-only change on the same page (`/materials#/cart`) does not reload. |
| `open_studio` | same, to `/design-studio` |
| `prefill_enquiry {fields}` | stores the non-empty fields under `sessionStorage["terucon.enquiry.prefill"]` and goes to `/start-project` |
| `cart_add {id, qty}`, `saved_add {id, pid}`, `saved_remove {id, pid}` | see below |

`terucon.enquiry.prefill` (read and removed by `/start-project`):

```json
{ "v": 1, "source": "terubot", "at": 1793720000000,
  "fields": { "type": "Façade / elevation", "name": "...", "phone": "...", "email": "...", "city": "...", "area": "...", "timeline": "3–6 months", "message": "..." } }
```

Only the keys that have a value are present (the nine possible keys are `type, name, company, phone, email, city, area, timeline, message`); a missing key means "leave that box alone".

### The shop's cart and saved list

The shop keeps both in its own React state and persists them in `localStorage`, validated against a catalogue only the shop page has. So:

* **On the shop page:** TeruBot dispatches `window` event `terucon:shop` with `detail {op, id, pid, qty}`; the shop's patch (`site/patches/snippets/shop-terubot-members.txt`,
  step `terubot-bridge` in `materials.json`) answers by setting `detail.handled/ok/label/message/undo` and changes its own state and storage. `id` is a variant id (a
  product id or finish id is accepted too). Adding to the cart caps at the stock; saving an item twice, or removing one that is not saved, never toggles.
* **From any other page:** the change is queued in `sessionStorage["terucon.terubot.pending"]` (`[{op, id, pid, qty, at, ref}]`, expires after 2 hours) and the chat
  says "Not done yet: ... when you open the shop". The shop applies the queue once its catalogue is loaded (after the saved cart is read, so nothing overwrites it),
  shows its own toast and dispatches `terucon:shop-applied` (`detail.items = [{ok, text}]`), which becomes "Done: ..." lines in the chat. "New chat" drops the queue.

A card links to `/materials#/p/<pid>?v=<vid>`; the shop also understands a bare `/materials#<variant, product or finish id>`.

## Live conversation ("Talk")

A **Talk** button in the panel header starts a spoken conversation, like a call: TeruBot says hello (in a fresh chat), **listens**, sends what it heard
as an ordinary message, **reads the answer aloud**, and listens again. Controls: a strip above the form says "Listening…", "Thinking…" or
"Speaking…"; **Skip** (while it speaks) stops the voice and listens at once; **End** (or Talk again) stops everything.

* **How:** the browser's own speech recognition (`en-IN`) and speech synthesis; nothing new on the server, no extra cost, and nothing but the text
  reaches TeruBot (as with typing). The voice is the device's: an Indian-English voice first, then British, US, Australian, then any English one.
* **Never both at once:** the microphone is shut while TeruBot speaks (it would hear itself) and opens a moment after the voice stops. There is no
  barge-in by voice; tap Skip.
* **What is read out:** the first few sentences (about 420 characters, then "The rest is on your screen."), with addresses, site paths, markdown and
  bullets removed, rupees and units in words ("₹1,200 per sq ft" is said "1,200 rupees per square foot"). Cards and notes are on screen only.
* **It ends** on End, on closing the panel, on New chat, on a hidden tab, on leaving the page, after three quiet listens in a row, and on any answer
  that is not an answer (too many messages, sign in, the AI is off, the server cannot be reached): the chat says why. **An answer that opens another
  page is not read out and ends it:** a new page starts without the microphone or a turn to speak (iPhone Safari allows speech only inside a tap), so
  the visitor taps Talk again there.
* **Where it shows:** only where the browser has both speech recognition and speech synthesis and the page allows the microphone. The Design Studio
  and the Finder send `Permissions-Policy: microphone=()`, so there Talk is hidden (typing works; so does nothing spoken).
* **Privacy:** in Chrome and Edge the browser's speech recognition sends the audio to the browser maker's online speech service to turn it into
  text (how that API is documented to work); other browsers differ and were not checked here. The microphone is open only between the Talk tap and End.
  The site's privacy text was not checked: it should say this before launch.
* **What it is not:** a studio-quality voice, a phone call, or a model that hears (TeruBot answers the text of what was heard). A neural voice
  (Gemini Live / a text-to-speech service) would be a separate, billed upgrade behind the same buttons.

## Photos and links (2026-11-04)

A visitor can show TeruBot a picture and ask about it ("what material is used in the left wall of this photo?").

* **Attach:** the paperclip button next to the microphone, a paste (Ctrl/Cmd+V of an image) or a drop on the panel. The picture is shrunk in the browser (longest side 1280 px, JPEG, about 200-350 KB) and sent as `image: {type, data}` (base64) with the message; a strip above the box shows it, with **Finder** / **Studio** (hand it to the Finder or the Design Studio with the same one-time hand-over the Inspiration page uses, `site/inspiration/handoff.js`) and **Remove**. The picture goes with every message of the conversation until it is removed or "New chat". It is not kept in the tab (only "Photo attached" is).
* **Paste a link** (a Pinterest pin or board, a web page, a picture address): the server fetches the picture itself with the Inspiration importer (`server/lib/inspiration/`, gallery-dl for the sites it has a profile for) and attaches it. The answer carries `attachment: {kind: 'link', token, host, title}`; the widget shows the picture's thumbnail and sends `image: {token}` with the next messages (the importer keeps the file for a few minutes). A link that cannot be read (private, removed, needs a sign-in, too big) becomes a plain note to the model, so it says why instead of "I cannot open links".
* **What the model does:** it sees the picture (an inline part of the visitor's last message) and has a tool, `find_in_photo(target, box_2d)`: it says which surface it means and gives its box (`[ymin, xmin, ymax, xmax]` on 0..1000); the server searches the real catalogue with that region of the photo (the catalogue's own `box` search) and gives back the closest designs. A design whose catalogue id (TIPL-SB804) is also a shop product (`server/lib/shopLink.js`) becomes a card with its picture, its listed price and a link to its page.
* **Limits:** signed-in only (the photo goes to a model and to a search); 20 new photos or links an hour per account and 40 per address, on top of the message limit; 4 MB of picture at most; a turn with a photo may take up to 50 s (the search container can be asleep). The 401/429 answers are shown in the chat.
* **Not done here:** the whole conversation is still text; the picture is not read aloud in Talk; an image from a link is capped at the first picture of a board.

## Keyboard, focus, motion

The panel is `role="dialog"` (`aria-modal` on a phone), the list is `role="log"` with `aria-live="polite"` (switched off while an old chat is drawn), Escape closes,
Tab and Shift+Tab stay inside, focus returns to what opened it, keys typed inside never reach the page's own shortcuts. Controls are at least 44 px; the box is
16 px (iOS). `prefers-reduced-motion` switches off the pulse, the slide and the typing dots. The microphone button (dictation: one thing said, one message sent) uses the browser's speech recognition
(`en-IN`), sends what was heard, and is hidden where there is none and where the page forbids the microphone (the studio and the Finder send
`Permissions-Policy: microphone=()`). Talk (above) is the continuous version. `prefers-reduced-motion` also stills the orb in the live strip.

## Storage keys

| Key | Where | What |
|---|---|---|
| `terucon.terubot.v1` | sessionStorage | the conversation of this tab (last 60 messages) and the "reopen" flag |
| `terucon.terubot.pending` | sessionStorage | changes waiting for the shop |
| `terucon.enquiry.prefill` | sessionStorage | the project form's fields |
