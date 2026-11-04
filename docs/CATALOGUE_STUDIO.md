# Catalogue designs in the Design Studio, and where their pictures live

Written 2026-11-04. Targets: C1 (AI render), A1 (shop), C4 (finder). Everything below is in the website; **nothing under `swatchroom/` was changed** (it is a verbatim copy of your separate project).

## What a visitor gets

1. **In the Design Studio**, when a wall, a door or a piece of furniture is selected, the finish list starts with a group **"Terucon catalogue"**: the 63 SuperBond designs, each card showing the design's real photograph, its name and code (`SB804 · marble-like veining, gloss`). Picking one renders it into the visitor's photo like any other finish.
2. **In the shop**, the same designs, with pictures read from Cloud Storage and a short description of how each looks.
3. **In TeruBot and the Finder**, the same pictures and descriptions (TeruBot reads the description when it talks about a design).

## Where things are stored (nothing on the web server's disk)

| What | Where | Written by |
|---|---|---|
| Name, printed code, product id (`TIPL-SB804`), dominant colour, page | MongoDB `terucon_catalogue_items` | the catalogue engine (earlier sessions) |
| The 320 px thumbnail of each page | bucket `thumbs/<catalogue>/<itemId>.jpg` | the catalogue engine |
| The 800 px picture of each design | bucket `cards/<catalogue>/<itemId>.jpg`; the record is `shopImage` on the item | `node tools/publish-shop-images.js --apply` (done 2026-11-04: 63 pictures, each read back and compared byte for byte) |
| What Gemini saw in each picture | MongoDB, field `studio` on the item; an export for the shop build: `catalogue/data/superbond-colour-detail.json` | `node tools/describe-designs.js --apply` (done 2026-11-04: 63 of 63) |

`shopImage` and `studio` are fields of their own, **not** inside `images`: the catalogue engine rewrites `images` whenever the PDF is ingested again (`catalogue/terucon_catalogue/mongo.py`, `PUBLISHER_OWNED`) and never touches a field it does not know. A re-ingest therefore keeps both.

The 63 files that used to sit in `media/materials/` (8 MB, copied into every deploy) are gone from the server. `/media/materials/tipl-sb804.jpg` is now answered by `server/routes/catalogueMedia.js`: it finds the design in MongoDB, signs a five-minute address for the object, reads it from Cloud Storage and sends it (`Cache-Control: public, max-age=3600, stale-while-revalidate=86400`, an ETag, 304 on a repeat). The bytes are kept in the server's **memory** only (at most 32 MB, about 12 MB for the whole catalogue), never on disk. Only a design that MongoDB lists is answered (a 404 for any other id), so it is not a way to read the bucket. If the bucket, the signing key or the database does not answer, the shop shows a quiet tile in the design's colour with its code (never cached; header `X-Terucon-Picture: unavailable`) instead of a broken image. Because the address did not change, nothing in the shop, TeruBot or the Finder had to change.

## How a design reaches the studio

```
studio page (signed in)
  loader (site/patches/snippets/studio-loader.js, step "catalogue-loader" of site/patches/studio.json; replaces the studio's one-line loader)
    -> GET /api/catalogue/studio-finishes               designs from MongoDB, each with its brief               (waits at most 4 s)
    -> site/catalogue-ui/studio-finishes.js             adds the group "Terucon catalogue" to the studio's own CATALOG (wall, door, furniture), first in the list
    -> starts /js/swatchroom-app.js                      whatever happened above; with the catalogue off the studio is exactly as before
  while the studio runs: an observer puts the design's photograph on its card (the studio draws cards in code and has no picture type)

a render (the studio's own POST /api/ai/generate)
  -> server/lib/studioReference.js                       in front of the studio's route; sees the marker [[terucon-design:TIPL-SB804]] in the brief
       fetches the design's 800 px picture, adds it to the request as the LAST image, adds four rules (11 to 14) about how to use it to the system prompt,
       adds one line to the brief, removes the marker. Anything missing (design, picture, database): the marker is removed and the render goes ahead on the text alone.
  -> the studio's route -> Gemini (the model chain, retries and key are the studio's, unchanged)
```

Each surface kind gets its own item id (`tipl-sb804` for a wall, `tipl-sb804-door`, `tipl-sb804-furniture`): the studio forgets a selected finish whose kind is not the clicked surface's (`itemFitsKind`), so one id for three kinds would be dropped on a door. The items carry **no `texture`**: the instant in-browser preview needs a tileable texture, a photograph of a sheet is not one, and these are rendered by the AI (as motifs and rugs already are).

**Which surfaces?** Wall, door and furniture (cabinet faces): a decorative sheet. Not floor, ceiling or window. That is my choice, nothing in the repo says where the designs may be used; change `STUDIO_KINDS` in `server/catalogue/studioFinishes.js`.

## The prompt

Two parts: the **brief** (what to make) and the **rules** (how to use the photograph). Both are in `server/catalogue/studioFinishes.js`.

* The brief names the design and says, from what Gemini saw in the picture: how it looks, its colours, its pattern, **which way the pattern runs**, **how large the marks are** (fine, medium, large), **how it reflects light** (matte to metallic), **how the surface feels** (flat to embossed), and a short instruction written for an image model (`render`). Without a Gemini description it says the colour and that the pattern and finish are to be taken exactly from the reference photograph.
* The photograph is Image 4 (Image 3 for the lite model, which sends no guide image: the number is counted from the images actually sent). Rules added to the studio's own ten:
  11. reproduce what the photograph shows (colours, the shape, density and direction of the marks, sheen, relief); do not recolour, simplify or invent;
  12. it is a sample, not a picture to paste: no frame, label or text, and **not its lighting**: the room's light decides direction, falloff, shadows and reflections;
  13. scale the pattern from the room (rule 8), never stretch the sample over the surface, never shrink it to noise, no visible repeat or seam;
  14. keep the sheen and relief as the camera would see them at this distance; colour stays true to the photograph after the room's light is applied.

### What Gemini is allowed to write (`tools/describe-designs.js`)

Gemini sees the picture, the printed name and the code, and is told to describe **appearance only**: never what the design is made of, its size or thickness, how it performs, its price or where it should be used, and to ignore the photograph's own lighting. Every answer is checked in code: the fields must be present and in their lists, texts must not be too long, and any text that states a measurement with a unit, a material (laminate, veneer, aluminium, stone species...), a performance (waterproof, fire, scratch...) or a price is refused and asked for again once. A metal named as a colour or a look ("copper-coloured") is allowed; "made of" is not. **The words are not checked for being true**: they say what the picture shows. They appear in the shop as "Written by AI from the catalogue picture: it describes how the design looks." Please read them (`catalogue/data/superbond-colour-detail.json`, all 63).

### The evidence (one room, one run per variant)

`tools/compare-design-render.mjs` renders the same photo, the same wall and the same design three ways. Results of 2026-11-04 on a clinic photo (real Gemini image model, the studio's own path): `docs/design-studio-checks/catalogue-reference/`.

| | A: name and colour only | B: Gemini description, no picture | C: description + the photograph (what the studio does now) |
|---|---|---|---|
| Emperador Dark (SB804) | smoky polished stone with a few broad veins and a mirror reflection | closer, but large dark cells and smoky patches, garbled text-like marks near a plant | dense, fine, branching off-white veins on a dark brown-black ground with a few brighter streaks: the character of the real sample |
| Burmese Teak (SB008) | pale blonde wood, wrong colour | pale honey wood with joints, still too pale | deep amber-brown with fine vertical grain and small dark knots, like the sample |

That is two designs, one room, one run each; image generation varies from run to run. It shows the direction clearly; it is not a measured accuracy and it does not say every design renders well.

## Undo

* Pictures: `node tools/publish-shop-images.js --undo catalogue/data/backups/shop-images-superbond-colour-<stamp>.json` removes `shopImage` from the items (the objects under `cards/` stay in the bucket; delete that prefix in the Cloud Console if you want them gone). Without a card the shop shows the 320 px thumbnails.
* Descriptions: `node tools/describe-designs.js --undo catalogue/data/backups/describe-designs-superbond-colour-2026-11-04-all-first-two-runs.json` unsets `studio` on every item that has one (the first run's own backup was overwritten by the second run, because backup names then had only a date; I rebuilt this file afterwards from the fact that no item had a `studio` field before today, and made every later backup name unique to the second, so a later run's backup is `describe-designs-superbond-colour-<date>T<time>.json`).
* The pictures as files: `git checkout -- media/materials` brings back the 63 local files (they are in the last commit). Nothing reads them any more.
* The studio group: remove the `catalogue-loader` step from `site/patches/studio.json`, then `node tools/build-site.js && node tools/build-dist.js`. Or set `CATALOGUE=off`: the list then answers empty and the studio is as it was.

## Things to know

* **The shop's descriptions are baked in at build time** (`node tools/describe-designs.js`, then `node tools/build-shop-catalogue.js`, `node tools/build-site.js`, `node tools/extract-products.js`, `node tools/build-dist.js`): the shop page is built from an export, its data layer is not loaded from the database. The pictures and the studio's finish list are live (a new design an admin uploads appears in the studio without a rebuild once it has a product id; its description and card picture come from the two tools above).
* A new design needs `tools/publish-shop-images.js` (the card) and `tools/describe-designs.js` (the description); both skip nothing silently and print what they did. The card tool reads the pictures from `media/materials/` (the files made by `catalogue/tools/make_shop_images.py` from the PDF): regenerate them before running it for a new catalogue.
* **Spot-check:** Gemini describes what the picture shows. `TIPL-STC9050` is printed "Twilight Black" but its picture is a rust-orange mottled surface: either the label was misread when the id table was made (by eye, 2026-11-04) or the catalogue names it so. Look at page 8 of the PDF.
* Not checked: renders of all 63 designs; any phone; the instant preview for these designs (there is none, by design); the studio's saved-room reopen with a catalogue finish (the loader holds the studio until the finishes are in its list, which is what makes `findItem` find them, but I did not reopen a saved room); what happens when the PDF is ingested again (the field choice is meant to survive it; not run).
