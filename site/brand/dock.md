# The mobile dock

A bottom tab bar for phones: the five destinations (Materials, Design Studio, Inspiration, Finder, My project) one tap away
on every page, like the header links on a laptop. Built by `dock.js`, styled by `dock.css`; there is no markup to write.
The five destinations are not listed here: there is ONE list, in `chrome.js` (`window.TeruconChrome.destinations`, the entries with `dock: true`), so a page that includes the dock must include `/brand/chrome.js` first (see `chrome.md`); without it there is no dock.

## Include it (hand-written pages, strict CSP)

In `<head>` (or anywhere in the page; the script waits for `<body>`):

```html
<link rel="stylesheet" href="/brand/chrome.css">
<script src="/brand/chrome.js"></script>
<link rel="stylesheet" href="/brand/dock.css">
<script src="/brand/dock.js" defer></script>
```

Nothing else. All four files are same-origin, so `style-src 'self'` and `script-src 'self'` allow them; there is no inline code, no
external host, no `style=""` attribute (the script only sets properties through the DOM). The bundled pages get the dock's two
lines from `site/patches/*.json` and the chrome's two from `site/brand/head.html`.

## What it does

* Only at widths up to 899 px; above that `display: none` (nothing to undo on a laptop).
* Five links, plain labels, inline SVG icons, each at least 44 px tall and a fifth of the width. The bar is 58 px plus the
  phone's home-bar inset (`env(safe-area-inset-bottom)`); dark warm brown with a thin hairline on top and a light backdrop blur.
* The current page is marked `aria-current="page"` (matched from `location.pathname`, with the old names `/studio`,
  `/import`, `/point-to-find` too) and shown in the amber of the logo's LED strip with a short lit strip on the bar's top edge.
  The landing page and the account pages mark nothing.
* It sets `html.tc-dock-on` and adds room at the end of the page (`body::after`, dark, the height of the bar plus the inset), so
  it never covers the last lines or the footer, and the page needs no change. A page whose `<body>` is only a fixed-height
  frame (the exported pages: their content overflows it, so `body::after` would sit mid-page) switches that off with
  `body::after { display: none !important; }` and pads its own root element instead:
  `padding-bottom: calc(var(--tc-dock-h) + env(safe-area-inset-bottom, 0px))` (see the `<style>` in `site/patches/*.json`).
* It slides away while a text field has focus after the visitor touched or typed (the on-screen keyboard is up), and comes back when focus leaves it. A box the page focuses by itself at load (the sign-in page) does not hide it; a keyboard that really opens shrinks the visual viewport, which does. Checkboxes,
  radios, buttons and file inputs do not count.
* It is a child of `<html>` (not of `<body>`), `position: fixed`, `z-index: 40`: no layout shift when it appears, a page's own
  re-render of `<body>` cannot remove it, and a page's modals (usually 60 and above) and full-screen views cover it.
* The Design Studio's working view on a phone takes the whole screen (the studio adds `html.swr-immersive` and covers the page):
  there the bar is `display: none`. The way back is the studio's own "..." menu, "Exit full screen" (checked in a browser).

## For pages that have their own bottom controls

`--tc-dock-h` is 58 px while the bar is on screen and 0 otherwise. Put a fixed control above the bar with
`bottom: calc(var(--tc-dock-h, 0px) + 12px + env(safe-area-inset-bottom))` (keep the page's own `env()` term: the variable
does not include the inset).

## Opt out, hide, show

* `<html data-tc-dock="off">` or `<meta name="tc-dock" content="off">`: the bar is not built.
* `window.TeruconDock.hide()` / `.show()`: for a page that wants the bar out of the way for a while.
* `window.TeruconDock.items`: the five destinations, if a page needs the list (the full list is `window.TeruconChrome.destinations`).

## Where it is not used

My project (`/my-project`) has its own bottom bar (Home, Design, Price, Menu) and a Saathi helper, so the dock is not added
there; its Menu panel has a "Terucon website" section with Home, Materials, Design Studio, Inspiration and Finder instead
(`site/patches/dashboard.json`).

## Label wording

"Design Studio" is shown as "Studio" on phones narrower than 390 px (360, 375, 380): the full word in bold does not fit a
fifth of the width. The link's accessible name stays "Design Studio".
