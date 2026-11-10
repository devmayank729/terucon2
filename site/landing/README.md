# The landing page (the website's "/")

The designer's landing page v2 (`Terucon_landingPage_2/Terucon Landing v2.dc.html`, handed over 2026-11-09), rebuilt as a plain, fast page and
served at `/` by the website itself. The designer's file is a React canvas: a 68 KB runtime (`support.js`) and React with ReactDOM (about 140 KB, fetched from unpkg) render
the whole page in the browser, so nothing is on screen until those scripts have loaded and run. This folder is the production version: the same design, the same
words and the same pictures, as HTML that is complete when it arrives.

Measured, this Mac, Chrome 150 ms / 1.6 Mbit/s / 4x CPU slowdown / phone viewport / empty cache (a local server, not Render; one machine):

| | before (the landing page of the site until 2026-11-10) | now |
|---|---|---|
| Largest contentful paint | about 4.1 s | about 0.4 s |
| First contentful paint | about 0.6 s | about 0.4 s |
| Layout shift | 0.007 | 0 |
| Transferred / requests | 738 KB / 30 | 302 KB / 11 |

Lighthouse 13.6 (its own mobile and desktop settings, headless Chrome 157), local server: performance, accessibility, best practices and SEO all 100 in
eight mobile runs and one desktop run. The designer's own file scored performance 85 (first and largest paint 3.3 s) under the same settings.
**That is the lab on this Mac. The number pagespeed.web.dev shows is measured on the deployed address, from Google's servers, and depends on the host's
response time: it was not measured, because nothing is deployed.**

## How it is made

`server/lib/landing/` builds the page in memory when the server starts (no build step to run) and `server/routes/landing.js` serves it.

| File | What it is |
|---|---|
| `page.html` | The body, with `{{markers}}` for the repeated parts. No inline styles, no inline handlers. |
| `landing.css` | The whole stylesheet. Inlined (minified) into `<head>`: nothing blocks the first paint. |
| `landing.js` | All behaviour, one deferred file. The page is complete without it. |
| `content.json` | The words and lists. Edit here, restart the server. |
| `config.json` | Phone, e-mail, studio path, `siteUrl`, film address, font-size adjustments. |
| `fonts/` | Geist, Geist Mono, Instrument Serif (SIL OFL), self-hosted. No request to Google. |
| `img/` | Responsive WebP copies and `index.json`. Made by `node tools/optimize-landing.mjs`. |

What the server does with it: the page as one HTML document with a strong ETag, its brotli and gzip bodies made once at start-up (`no-cache`, so a
visit costs a 304 once the browser has it); `/lp/<name>` for everything else, each file named by a hash of its content and sent
`public, max-age=31536000, immutable`. After a change, restart the server (or deploy): the page is built when it starts.

What the page does, beyond what the design had: the enquiry form saves the enquiry on this site (`POST /api/enquiry`, shown to the admin) and does
**not** open WhatsApp (your decision, 2026-11-10); the assistant button loads the site's real TeruBot on the first tap; PostHog and the Design Studio's
early wake-up (the two snippets of `site/patches/snippets/`) start after the visitor's first touch, click, key or scroll (or after 15 s), so a crawler or
a speed test neither loads PostHog nor wakes a GPU; the platform links (Materials, Design Studio, Inspiration, Finder, My project, Sign in) are in the
phone menu and the footer.

## Things you will want to do

**Add the real project photos** (the six in "Signature work"), **the client logos** (the strip under the hero) **or TeruBot's face**: the design
asked for them (`Terucon_landingPage_2/Photo Prompts.md`) but they were not delivered, so the page shows a text card, a monogram and a drawn face
and never asks for a file that is missing. Put `images/projects/<slug>.webp` (1600x1200; real photos of the real sites, not generated), `images/clients/<slug>.png`
(transparent, about 320x120) or `terubot.png` (192x192) into `Terucon_landingPage_2/` as the brief says, run `node tools/optimize-landing.mjs`
(needs `cwebp`), commit `site/landing/img/`, restart. The slugs are in `content.json` and `tools/optimize-landing.mjs`.

**Attach the domain**: put the address in `config.json` as `siteUrl` (for example `"https://terucon.in"`). The canonical address, `og:url` and the
addresses in the structured data turn on. Link previews also need an `og:image`, which is not there yet (decided 2026-11-10: no absolute address until the
domain is known).

**Add the film**: put its address in `config.json` as `filmUrl`. It is loaded only when the section is near the screen, muted, with the poster until it plays.

**Go back to the earlier landing page**: `LANDING=classic` in `.env`; the file is read again when it changes, so no restart is needed locally. On Render the variable is set in the dashboard: that is the real environment, which the server reads when it starts, so the service has to restart for the change to take effect (how fast Render does that on saving a variable was not verified).

**Change a font**: re-measure `fontAdjust` in `config.json` (the width of the web font against the system font that stands in for it while it loads; the
numbers keep the headline from re-wrapping when the font arrives).

## Budgets and tests

`tests/js/landing.test.js` fails when the page grows past its budgets (page, script, first screen), asks another site for anything, has a picture without
alt or size, uses an inline style or handler, links to an address that is not a route of the site map, or when a picture in `img/` no longer matches its hash.
The browser tests (`tests/e2e/run.mjs`, "new landing page") drive it in Chrome.

## Known limits

- The journal notes' links go to `#journal`, as in the design: there are no article pages.
- Pages that exist only on the company's current website (the shade catalogue, the portfolio, the brochure PDF) keep their `terucon.in` addresses.
- The plain WhatsApp contact links (contact list, footer, shade tiles, due-diligence button) are still in the page: your answer was about the form. They are
  `wa.me` links built from `config.json`'s phone number.
- Not verified: Safari and Firefox, a real phone, Render, pagespeed.web.dev. `<details name>` (the exclusive accordions) needs Chrome 120, Safari 17.2 or Firefox 130;
  older browsers still open and close every item, they just allow more than one open.
