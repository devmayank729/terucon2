# The site chrome

ONE header on every page and, on a laptop, a collapsible left sidebar with the site's destinations. Phones keep the bottom dock
(`dock.js`). Built by `chrome.js`, styled by `chrome.css`; there is no markup to write.

## Include it

In `<head>`, in this order (a render-blocking stylesheet and a small synchronous script, so there is never a moment without the
header, and the room the page leaves for it exists at the first paint):

```html
<link rel="stylesheet" href="/brand/chrome.css">
<script src="/brand/chrome.js"></script>
```

Hand-written pages carry these two lines themselves (before the dock's two). The four exported pages (landing, shop, studio,
dashboard) get them from `site/brand/head.html`, which `tools/build-dist.js` puts in every built page; their patches
(`site/patches/*.json`, the `chrome-fit` steps) hide the export's own header while `html.tc-chrome-on` is set. Both files are
same-origin and there is no inline code or style, so the strict-CSP pages accept them. `chrome.js` appends its elements to `<html>`
(like `dock.js`), so a page re-rendering `<body>` cannot remove them.

## What it draws

* **The pill** (every page): a dark brown floating bar 10 px below the top edge (60 px high; 54 px under 900 px), the logo at the
  left. **The call to action ("Start a project" with a light circle holding an up-right arrow, linking to `/start-project`) is
  drawn on the landing page only** (changed 2026-11-04: on every other page it crowded the pill; `/start-project` is still linked from the
  landing page's hero and header, and from TeruBot's "Start a project" suggestion). 44 px touch targets, `aria-current="page"` on the current destination, a visible focus ring, no layout shift.
  * **Landing page**: the six links in the middle (Materials, Design Studio with the small "AI" badge, Inspiration, Finder,
    My project, Sign in / Account), the call to action and a Menu button that clicks the export's own Menu button (its overlay is React state).
    The export's scroll-driven chapter label is not drawn.
  * **Every other page**: the page's title after the logo and the account button (initials; "Sign in" when signed out) at the right end.
  * **Shop (`/materials`) only**: Saved and Cart icon buttons left of the account button. They mirror the export's counts (one
    MutationObserver) and forward their clicks to the export's own links. Nothing the export owns is moved.
  * **Under 900 px**: logo (the emblem alone up to 419 px) and account; the landing page has the call to action and its Menu instead of the
    account; the shop keeps Cart. The dock is the destinations.
* **The sidebar** (900 px and wider, not on the landing page, sign-in, coming soon, error, offline): 260 px, cream, small caps
  "TERUCON", a row per destination (24 px line icon, semibold label; the active row a dark rounded pill), a round chevron on its
  right edge that collapses it to a 64 px icon rail (labels stay for screen readers and show as tooltips), and a card at the bottom
  with the signed-in person (name and firm, or e-mail; "Sign in" when signed out). The state is remembered in `localStorage`
  (`tc-side`; `tc-side-project` on `/my-project`); a browser that refuses `localStorage` still works. With nothing remembered it is
  a rail under 1100 px, and on `/my-project` (which has its own rail).

## The one list of destinations

`chrome.js` holds it (`DEST`: label, route, icon, `ai`, and which of the sidebar, the landing pill and the dock show it). The dock
builds its tabs from it, and `tools/check-links.js` reads it (so the connections check knows what JavaScript draws on every page).
To add a destination, add a line to that block and an icon.

## For other fixed things on a page

On `<html>`, always defined:

| Property | Meaning |
|---|---|
| `--tc-hdr-h` | the header's height including its gap above it (70 px; 64 px under 900 px, plus the safe-area inset); 0 without chrome and while the studio is full screen |
| `--tc-side-w` | the sidebar's width now (260 px, 64 px collapsed); 0 under 900 px, on the landing page and on pages without one |
| `--tc-dock-h` | the phone dock's height (`dock.css`) |

Classes on `<html>`: `tc-chrome-on`, `tc-land` (landing page), `tc-over` (the page's own picture fills the top, so the pill floats over
it: landing page and shop), `tc-side-on`, `tc-side-rail`, `tc-p-<page>` (`materials`, `studio`, `project`, ...).
A page's own bottom-right buttons clear the dock with `--tc-dock-h` and the header with `--tc-hdr-h`.

`window.TeruconChrome`: `destinations`, `current`, `whenMe()` (one shared request to `GET /api/auth/me`; `snippets/auth.js` uses it
too), `setSidebarCollapsed(bool)`, `sidebarCollapsed()`. Collapsing or expanding sends a `resize` event: the dashboard and the studio
lay themselves out again from it.

## What a page can say on its `<html>` tag

`data-tc-chrome="off"` (no chrome), `data-tc-sidebar="off"` (header only), `data-tc-title="Finder"` (the title; default: the name of
the destination the page is), `data-tc-account="off"` (no account button and no request for who is signed in).

## Pages with their own layout

* `/design-studio`: the studio measures the header above it (`--swr-top`); with the export's header hidden it measures the room the
  pill takes. The studio's full-screen view (`html.swr-immersive`) hides the chrome, like the dock. `swatchroom/` is not touched.
* `/my-project`: the chrome's sidebar starts as a 64 px rail beside the dashboard's own rail. The dashboard lays itself out from the
  width of the window; its patch gives it the width beside the chrome's sidebar (`window.__tcvw`). The dark top bar is not drawn:
  its dark-mode switch and a text-size button (which opens the old account menu) are in the side rail; the demo project crumb, the
  "Call us" placeholder and the demo avatar and name went with it.
* `/materials`: see Saved and Cart above; the export's menu overlay is no longer reachable from this page (the destinations are in
  the sidebar and the dock).

## Footer band

Hand-written pages share one footer band: `<footer class="tc-foot">` (styled in `chrome.css`).
