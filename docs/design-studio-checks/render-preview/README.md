# Render-preview check: the studio's instant preview, before and after the overlay

The website serves improved copies of 8 of the Design Studio's instant-preview files (`site/overlays/studio/`, see
`docs/DESIGN_STUDIO_ARCHITECTURE.md`, section 12). This folder is how to see, in a real browser, what they change, and to check that
the website really serves and draws them. It reads the studio's files, the overlay, `media/` and the studio's textures and writes
nothing into the project (pictures and the Chrome profile go to a new folder under the system's temp directory). It calls no live
service and needs no network.

## The one command

```
node docs/design-studio-checks/render-preview/run-all.mjs            (under a minute)
    --out DIR       where the pictures go (default: a new temp folder)
    --grids DIR     also copy the four GRID-*.jpg there
    PORT=8801       the port of the check's own little server (default: any free one)
```

Needs Google Chrome (set `CHROME_PATH` if it is somewhere unusual), `npm install` at the top of the project (for `pngjs`) and
`cd tests/e2e && npm install` (for `puppeteer-core`, which the browser tests use too).

It draws four hand-masked photo surfaces (lobby floor, clinic floor, lobby wall, clinic wall) four ways each, with the real WebGL2
backend: the studio's own code (`real`) or the overlay's (`overlay`), on the studio's own estimate geometry or on a hand-built plane.
It prints the light measurements and the WebGL2-against-WebGPU difference, and writes `GRID-<scene>-<surface>.jpg` and the pictures.

The same four grids, made by this command, are in [`images/`](images/).

## What the pictures are

Each `GRID-*.jpg` is 2 x 2. Left is `REAL` (the studio's own preview code), right is `OVERLAY` (what the website now serves).

| | what the geometry is |
|---|---|
| top row, "estimate geometry" | what a photo gets in the first seconds, before the room analysis is back: `provisional.js` run on the masks (the studio's own function, not hand-written) |
| bottom row, "hand-built plane" | a stand-in for a good fit: a floor, or a head-on wall, in the picture of a camera 1.4 to 1.6 m up. It is NOT a real fit; the real fused fit needs the live GPU services and was not available |

Things to look for: the shadows and sunbeams of the room stay on the new finish (and are not flattened), the finish takes the colour
of the light a little, the far floor stays sharp, a wall's bricks stand level, and the edge against the furniture is not a staircase.
The old finish's pattern can show faintly through a strong pattern (`oldpattern=checker` in `render.mjs` shows the worst case).

## What the numbers are (`light`, per surface, on the painted pixels)

* `corrLogLight`: how closely the render's light follows the photo's own light across the surface (1 = the same pattern of sun and shade).
* `sunShadeRatioP90_P10_*`: the ratio of the brightest tenth to the darkest tenth of the surface, in the photo and in the render.
* `RG_*`, `BG_*`: red/green and blue/green of the surface's average linear colour in the photo and in the render. The new finish is a
  different material from the old floor, so these are NOT targets; they only show which way the light colour moves the finish (warmer:
  red up, blue down). Of all the changes, the light colour is the one least certain: it is applied at 30% of the photo's mean colour
  because 60% overshot (peach floors) on both photos.
* `WebGL2 vs WebGPU`: the pixel difference between the two backends on the same scene (0 to 1 levels of 255 where both run; "skipped" where
  this browser has no WebGPU).

Measured on 2026-11-05 on one computer (Apple M5, Chrome, WebGL2 and WebGPU both available):

| surface | `corrLogLight` real -> overlay | sun/shade, photo / real / overlay | WebGL2 vs WebGPU, overlay: largest difference |
|---|---|---|---|
| lobby floor (oak) | 0.796 -> 0.958 | 3.44 / 2.62 / 2.76 | 1 of 255 (real: 0) |
| clinic floor (oak) | 0.912 -> 0.983 | 4.52 / 3.98 / 4.33 | 1 (real: 0) |
| lobby wall (brick) | 0.478 -> 0.821 | 2.18 / 2.39 / 2.19 | 0 (real: 0) |
| clinic wall (limewash) | 0.502 -> 0.861 | 1.70 / 1.55 / 1.63 | 1 (real: 0) |

`buildProvisionalScene()` (the estimate, run once per scan) took about 9 ms with the studio's own code and 27 to 34 ms with the
overlay's in Chrome on that computer, on the 1024 px scan of these two photos. Not measured on a phone.

## The other commands

```
node docs/design-studio-checks/render-preview/site-check.mjs         (about half a minute)
```
Starts the real website the way the browser tests do (`tests/dev/stack.mjs`: mock GPU services, no database, no Google key) twice, with
`STUDIO_PREVIEW_OVERLAY=on` and `=off`. For each: fetches the 14 module addresses and compares their bytes with `site/overlays/studio/manifest.json`;
opens `/design-studio` in Chrome and lists the preview files it loads at start-up; draws the eight scenes (4 surfaces x 2 geometries) from the modules
the WEBSITE serves and compares each picture, pixel for pixel, with the same scene drawn by the check's own server (on: must equal `overlay`;
off: must equal `real`; and on must differ from off). Exit code 1 if anything fails.

```
node docs/design-studio-checks/render-preview/render.mjs OUT.png root=overlay scene=clinic surface=wall tex=limewash geom=estimate
```
One picture, to try a texture, a camera pitch (`pitch=10`), a pixel ratio (`dpr=2`) or WebGPU (`backend=webgpu`). The keys are listed at the top of the file.

## Files

| file | what |
|---|---|
| `run-all.mjs` | the one command |
| `site-check.mjs` | the same pictures from the running website, on and off |
| `render.mjs` | one picture |
| `lib.mjs` | the small server, Chrome, the pixel comparison, the light measurements, the grids |
| `harness/index.html`, `harness/run.js` | the page: the photo, the masks, the scan, the scene, the real backend, the read-back |
| `harness/scenes.json` | the photos (`media/p02-lobby.jpg`, `media/p04-clinic.jpg`: PNG data under a .jpg name) and the hand-drawn masks, as polygons |
| `images/GRID-*.jpg` | the four grids, as made by `run-all.mjs` |

## What this does not show

* A real fused fit. The masks are hand-drawn polygons on two generated-looking photos, not a scan model's output, and the planes are hand-built.
* Any GPU other than the one it was run on, a phone, or WebGPU on anything but that Apple M5. The WebGL2 and WebGPU pictures were identical to within one level there.
* The studio's own interface around the preview. `tests/e2e/run.mjs` proves the studio still starts with the overlay, not that a preview is drawn
  in it (no browser test draws one: the scan needs the live models).
