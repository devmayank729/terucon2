# site/optimized: responsive WebP copies of the site's photos

The four bundled pages (home, materials, studio, dashboard) carry about 46 MB of JPEGs between them: twenty 1.6-3.2 MB originals under `media/` plus 59 smaller JPEGs embedded in the page bundles. This folder holds smaller WebP copies of every one of them, in several widths. `tools/build-dist.js` reads `index.json` at build time and swaps them in. A source with no entry here simply keeps its original; a build never fails for lack of a copy.

**The files are committed on purpose.** The Docker image has no image encoder (no cwebp, sharp or ImageMagick), so the WebP files cannot be made at deploy time. Everything here was made once, on a machine with Chrome, and is plain data at deploy time.

## Regenerate

```
node tools/optimize-images.mjs            # encode what is new or out of date, update index.json
node tools/optimize-images.mjs --check    # exit 1 if index.json is stale or a file is missing (plain Node: no Chrome)
node tools/optimize-images.mjs --force    # encode everything again
node tools/optimize-images.mjs --prune    # also delete files that index.json no longer lists
node tools/optimize-images.mjs --report   # coverage only: sources, missing files, unused files; changes nothing
node tools/optimize-images.mjs --only m06-plaster,acp-bone   # just these names
```

Encoding needs the Google Chrome app (path `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, or set `CHROME_PATH`) and `puppeteer-core` from `tests/e2e/node_modules`. The tool opens Chrome headless, decodes each source with `createImageBitmap`, scales it down with high-quality smoothing (halving steps while the next half is still at least the target width, then one last step), and encodes with `OffscreenCanvas.convertToBlob({type: 'image/webp', quality})`. Nothing is downloaded and no npm dependency was added.

Run it again whenever a photo in `media/` or an embedded image is added or replaced, then commit the new files. A re-run that changes nothing writes the same bytes (checked: `--force` reproduces the committed files exactly, with the same Chrome build, 156.0.8078.76).

## index.json

```
{ "version": 1, "items": { "<sha256 hex of the SOURCE image bytes>": {
    "source": "media/m06-plaster.jpg" | "bundle:home:<uuid>",
    "name": "m06-plaster",          // extra, informational: the stem used in the file names
    "width": 1122, "height": 1402,  // source size
    "quality": 0.88,                // extra, informational: the WebP quality the files were encoded at
    "variants": [ {"w": 640, "h": 800, "file": "m06-plaster-c03669ad-640.webp", "bytes": 112006}, ... ] } } }
```

- **The key is the sha256 of the exact source bytes.** For `media/<file>` that is `fs.readFileSync(file)`. For an image inside a bundle it is what `Bundle.asset(uuid)` returns in `tools/bundle.js` (the base64 decoded and, where the manifest says `compressed`, gunzipped). Two bundles holding the same photo (the dashboard re-embeds 21 of the materials images) give the same key, so they share one entry; `source` names the first one found.
- `variants` are in ascending width, never wider than the source, never wider than 1920.
- File names are `<name>-<first 8 hex of the source sha>-<width>.webp`. The name changes whenever the picture changes, so the files can be cached for a year.
- `name` and `quality` are additions to the agreed format. A reader that only uses `source`, `width`, `height` and `variants` can ignore them.
- The file is written with items sorted by name and a fixed field order, so a change shows up as a small diff.

## Which widths

`640`, `1280`, `1920`, each only if the source is at least that wide (never scaled up). A source narrower than 640 would keep one variant at its own width (none today). When a source falls well between steps (wider than 1.25 times the largest standard width that fits) it also gets a variant at its own width, so the full resolution is not thrown away: the 1122 px macros get `640` and `1122`; the 1672 px "T" pictures get `640`, `1280` and `1672`. Current set: 51 sources have only `640` (the 640x800 swatches), 18 have `640/1280`, 6 have `640/1122`, 4 have `640/1280/1672`. Nothing in the project is wider than 1672, so no `1920` exists yet.

## What is covered

79 distinct images, 111 files, 7.9 MB in total, from 46.0 MB of sources:

| Origin | Images | Originals | 640 px variants | Largest variants |
|---|---|---|---|---|
| `media/*.jpg` (home) | 20 | 41.3 MB | 1.0 MB | 3.8 MB |
| materials swatches (640x800) | 51 | 3.0 MB | 1.6 MB | 1.6 MB |
| materials collection pictures (1400x1052) | 4 | 0.8 MB | 0.1 MB | 0.4 MB |
| home bundle thumbnails (1447x1087) | 4 | 0.9 MB | 0.1 MB | 0.5 MB |

Per page (every image that page uses): home 24 images, 42.2 MB originals, 1.2 MB at 640, 3.9 MB at the largest variant up to 1280; materials 55, 3.8 MB originals, 1.7 MB at 640; dashboard 21, 1.9 MB originals, 0.7 MB at 640.

Sources are: every `image/jpeg` or `image/png` in the manifest of `pages/{home,materials,studio,dashboard}.html` (studio has none), plus every `media/<file>.jpg|png` that a page template or `site/patches/**` names as `media/...` or `/media/...`. The brand logos (`media/Terucon_logo.png`, `media/image*.png`) and the videos are never touched. The home template names photos in three ways: `<img src>`, `data-src` (strips and direction cards) and `data-poster` (video poster).

## Quality choices

WebP quality is per image, set by rules in `tools/optimize-images.mjs` (`QUALITY_RULES`), so `--force` reproduces it:

- **0.85 (default)**: the busy photographs (`p01 p02 p04 s02 s03 s04 t01-t04`, the 1400x1052 collection pictures, the home thumbnails).
- **0.88**: the two video posters (`a01-hero`, `v02-craft`: dark gradients, painted first, and their JPEGs are already blocky), the night and dusk scenes (`p03-showroom`, `s05-monolith`), the six material macros (`m01`-`m06`: the grain and trowel marks are the subject), and the 51 swatches (flat and faintly grained: at 0.80 the grain is smoothed into 16-pixel patches).
- **0.80 was rejected** as the default: with the contrast stretched about 5 times, smooth skies, water and dark walls (`s05-monolith`, `t03-surfaces`, `p04-clinic`) showed soft rectangular patches; 0.85 is clean at that stretch on the busy photographs. At normal contrast 0.80 was already hard to tell from the original.
- Chrome writes **lossless** WebP at exactly 1.0, so nothing uses 1.0.
- Canvas WebP is always 4:2:0 chroma, and Chrome converts colour to sRGB when it decodes (the three sources checked with `sips` were sRGB or untagged; the others were not checked).

Checked by eye on: a01-hero, v02-craft, s05-monolith, p03-showroom, p02-lobby, p04-clinic, t01-shell, t02-services, t03-surfaces, m02-terracotta, m06-plaster, hd-linen, acp-espresso, iacp-white, gl-clear, st-gran-honed (original against WebP at 1:1 and with the contrast boosted). For ten of them (a01-hero, s05-monolith, p03-showroom, p04-clinic, t02-services, m02-terracotta, m06-plaster, hd-linen, acp-espresso, st-gran-honed) the comparison used the committed files themselves; for the rest it used test encodes at the same quality. The other 63 images were encoded with the same settings and not looked at one by one.

## Gaps and unused files

- `media/materials/fx-mill.jpg` does not exist. The dashboard builds `media/materials/<id>.jpg` at run time and falls back to it when `window.__resources['m-<id>']` is missing; `fx-mill` is the only one of its 18 material ids with no embedded photo. The folder `media/materials/` does not exist at all. Once the bundle bootstrap is gone, that `m-<id>` lookup is the only thing that supplies the swatches.
- Every `media/*.jpg` is named by the home template: none is unused. `media/image.png` and `media/image copy.png` (identical files, 2.1 MB each) are named by nothing; they are left alone.
- `media/a01-hero.jpg`, the hero poster, shows a small four-pointed sparkle mark at the bottom right (visible in the original too).

## The two videos

They cannot be re-encoded on this machine (no ffmpeg), and are not touched. Both are already 1280x720 H.264, 10 seconds long, with a 128 kbps audio track, and already have the index at the front of the file (`moov` before `mdat`, read from the file), so the saving from re-encoding comes from a lower video bitrate and from dropping the audio, which the page never plays (the `<video>` elements are created muted). Spotlight reports about 3.8 Mbps for the hero and 2.0 Mbps for the craft film.

Where they are used (`pages/home.html`, home template):

- `media/a01-hero.mp4` (4.8 MB): the full-screen hero at the top of the home page, with `media/a01-hero.jpg` as its poster.
- `media/v02-craft.mp4` (2.6 MB): the craft section further down, with `media/v02-craft.jpg` as its poster.

Both are created by script with `preload = 'auto'`, `autoplay`, `muted`, `loop`, so a phone starts downloading them as soon as the page runs. To make smaller copies on a computer with ffmpeg, run from the project folder (720p stays 720p; CRF 28 is a good start, lower the number if the dark scenes look blocky; the result goes next to the original so nothing is overwritten):

```
ffmpeg -i media/a01-hero.mp4 -vf "scale=-2:'min(720,ih)'" -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart -an media/a01-hero.small.mp4
ffmpeg -i media/v02-craft.mp4 -vf "scale=-2:'min(720,ih)'" -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart -an media/v02-craft.small.mp4
```

Look at both, then replace the originals (keep the same file names, the page refers to them by name). The resulting sizes are not known until it is run. A shorter `-t` or a lower frame rate (`-r 24`) would shrink them further.
