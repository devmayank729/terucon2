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
conversation opens again by itself; after an ordinary page change the chat is kept but the panel stays closed.

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

## Keyboard, focus, motion

The panel is `role="dialog"` (`aria-modal` on a phone), the list is `role="log"` with `aria-live="polite"` (switched off while an old chat is drawn), Escape closes,
Tab and Shift+Tab stay inside, focus returns to what opened it, keys typed inside never reach the page's own shortcuts. Controls are at least 44 px; the box is
16 px (iOS). `prefers-reduced-motion` switches off the pulse, the slide and the typing dots. The microphone button uses the browser's speech recognition
(`en-IN`), sends what was heard, and is hidden where there is none and where the page forbids the microphone (the studio and the Finder send
`Permissions-Policy: microphone=()`).

## Storage keys

| Key | Where | What |
|---|---|---|
| `terucon.terubot.v1` | sessionStorage | the conversation of this tab (last 60 messages) and the "reopen" flag |
| `terucon.terubot.pending` | sessionStorage | changes waiting for the shop |
| `terucon.enquiry.prefill` | sessionStorage | the project form's fields |
