# Page patches

The four pages are Claude Design exports: self-extracting HTML bundles with a minified React app inside.
They are kept untouched: the landing page, shop and dashboard in `pages_original/`, the Design Studio page in
`swatchroom/terucon/Swatchroom.html` (the studio's own export, in which the studio itself is a small loader for
`/js/swatchroom-app.js`). `node tools/build-site.js` (`npm run build:site`) turns them into
`pages/home.html`, `materials.html`, `studio.html` and `dashboard.html` by applying the patch file of each page.
Everything that makes a page different from its export is in this folder, as data:

| File | What |
|---|---|
| `<key>.json` | the ordered steps for one page (`home`, `materials`, `studio`, `dashboard`; the keys of `site/site.json`) |
| `snippets/*.js` | larger pieces of injected JavaScript, as real files you can read and lint |
| `../components.json` | the HTML of the navigation entries (header link, menu card, footer links) |
| `../site.json` | pages, source and output files, routes, `linkStyle`, `legacy_names` (not edited here) |

If you export a page again from Claude Design, drop it into `pages_original/` under the same name and run
`npm run build:site` (the studio's page: re-export it with `npm run terucon-page -w swatchroom -- path/to/export.html`
from the project folder with an absolute path (the script runs inside `swatchroom/`), which swaps the studio for its loader,
then build). If an anchor no longer matches exactly once the build fails and names the page, the step and the
anchor; nothing is written. Fix the step (or retire it), rebuild, check the result in a browser, then
`node tools/build-site.js --write-golden` to record the new digests used by `tests/js/site-golden.test.js`.

## A patch file

```json
{
  "page": "materials",
  "steps": [
    { "id": "relink", "op": "relink", "why": "…", "expect": 18 },
    { "id": "header-project", "op": "insertAfter", "why": "header: My project link",
      "anchor": "Saved<span …>{{ savedN }}</span></a>",
      "insert": ["\n      ", {"component": "headerLink", "entry": "project"}] }
  ]
}
```

`page` must equal the file name. Every step has a unique `id` (among its siblings) and a human `why`; unknown fields
are an error (typos fail instead of being ignored); keys starting with `_` are comments. Steps run in order.

### Targets

A top-level step edits the page template by default. `"target": "asset:<name>"` edits the decompressed asset that the
bundle's `ext_resources` calls `<name>` (for the Design Studio page that is `swatchroomApp`, which today is only a
loader, so no patch uses this). The text is decoded, edited by all steps, and written back once (gzip level 9, same
mime type and flag). Nested steps (inside `group` or `inJsString`) work on the text of their parent and take no `target`.

### Operations

| `op` | Fields | Effect |
|---|---|---|
| `relink` | `expect`? | rewrite the design-time names of `legacy_names` (`Design Studio.dc.html`, …) to the pages' links, also in their `%20` form. `#fragment` and `?query` are kept. Only names not preceded by a word character, `%`, `.` or `-`, and followed by `#`, `?`, a quote, a backtick, whitespace or `)`. `expect` fails the step when the number of links differs. |
| `replace` | `anchor`, `with` | replace the anchor, which must occur **exactly once** |
| `insertAfter` / `insertBefore` | `anchor`, `insert` | insert next to the anchor, which must occur exactly once |
| `replaceAll` | `anchor`, `with`, `count` | replace every occurrence; there must be exactly `count` |
| `insertAfterLeadingComment` | `insert` | insert after the `*/` that closes the comment the text starts with (the app's banner) |
| `checkSyntax` | `name` | parse the current text with `node --check` as a module; use a `.mjs` name (`app.mjs`, `worker.mjs`) because the injected runtime uses top-level `await` |
| `group` | `steps` | run the nested steps on the step's target (a way to give a set of steps one target and one name) |
| `inJsString` | `open`, `steps` | `open` is text that ends with the opening quote of a JS string literal and occurs once, e.g. `var Cn='`. The literal is decoded, the nested steps edit its value, and it is written back as a JSON-style `"…"` literal with `</` escaped as `<\/`. Used for the in-browser worker, which the app keeps as a string. |

"Exactly once" counts non-overlapping occurrences. Text is spliced by position, so `$` in a replacement is just a `$`.
A step fails with `[studio/app/engine-dispatcher] <why>: anchor matched 0 times (expected exactly 1): "…"` (or `2 times`).

### Replacement text (`with`, `insert`)

A string, or a list of parts that are joined. A part is

* a string, used as is;
* `{"file": "snippets/name.js"}` the content of that file under `site/patches/`, verbatim. `"chomp": true` drops one
  trailing newline (editors add one; use it when the snippet continues in the next part);
* `{"component": "headerLink", "entry": "project", ...params}` the HTML of a component (below).

Strings are literal: `{{ savedN }}` and friends in anchors or replacements belong to the page and are never
expanded. Only component bodies have placeholders.

### Components (`site/components.json`)

`components` maps a name to an HTML body. `entries` maps a name to default parameters, so the same entry (for example
`project`: page `dashboard`, label "My project", and the card's eyebrow, title and blurb) is reused by the header link,
the menu card and the footer link. A step can override any parameter (`"label": "Shop materials"`).

* `{{name}}` is replaced by the parameter `name` (a missing value is an error);
* `{{#name}}…{{/name}}` is kept only when the parameter is `true` (`"mobileHide": true`);
* `{{target}}` is the link to the page given as parameter `page`, plus the optional `fragment`, in the current link style:
  `route` gives `/materials`, `file` gives the file name `materials.html`. A literal `"target"` parameter overrides it;
* `{{link:KEY}}` is the link to page `KEY` (for components that need a second page);
* a parameter given in a step that the body does not use is an error (catches typos). Values are inserted as HTML, unescaped.

### Snippets

`snippets/warmup.js` is the browser script that the `home` and `studio` patches put in the page head
(`["<script>", {"file": "snippets/warmup.js", "chomp": true}, "</script>\n"]`): it asks the website to wake the
Design Studio's GPU services as soon as the page opens (`POST /api/studio/warmup`, `server/routes/studio.js`), at most
once a minute per tab, and never waits for the answer. It is plain JavaScript that parses on its own
(`tests/js/site-patches.test.js` checks that).

## What each patch does

* `home`, `materials`, `studio`: relink the design-time names; add the missing entry points (Materials and "My project" on
  the landing page; "My project" on the other two) to the header, the menu overlay and the footer; on `home` and `materials`
  switch off the design-review "media guides" pill and retarget its dead link to `#`.
* `home` also: a "Try it with your photo" button in the hero, next to "Start a project" (the shared `heroPill` component and
  the `studio` entry of `site/components.json`), so the studio is one tap away on a phone without opening the menu; and the
  wake-up script.
* `studio` also: the footer line (the export says photos and key stay in the browser; the studio saves rooms on the server),
  and the wake-up script. The studio inside the page is not patched.
* `dashboard`: the relink, and the Design Studio link in "My design" is named "Open the Design Studio" (the export says "Open the full design studio (for advanced users)").
