# Terucon — photo & asset brief

Every placeholder on the page shows an ID (H1, D3, P2…) and the exact file path. Drop a file at that path and it appears automatically — no code change needed.

## Assets you supply (not generated)

| File | Spec | Notes |
|---|---|---|
| `logo.png` | Transparent PNG, ~352×88 px (2× of 176×44) | Dark version. Footer auto-turns it white (Tweak: Footer logo → Original to disable). |
| `terubot.png` | Square PNG, 192×192 px | Shown in a circle at 48 px. |
| `images/clients/<slug>.png` | Transparent PNG, ~320×120 px, max 15 KB | `decathlon` `dmart` `gap` `smart-bazaar` `trends` `bmore` `style-union`. Shown greyscale, full colour on hover. Name appears under each logo; a monogram shows if the logo is missing. |
| `images/og-cover.jpg` | 1200×630 JPG | Social share card — crop of H1 plus the logo. |

## Export rules (these matter for a 96+ PageSpeed score)

- WebP, quality 72–78, sRGB, metadata stripped (Squoosh or `cwebp -q 75`).
- Hero desktop images ≤ 220 KB, hero mobile ≤ 110 KB, everything else ≤ 150 KB.
- Use exactly the pixel sizes below. Larger files waste bandwidth; smaller ones look soft.
- If you replace a photo later, **rename the file**: `/images/*` is cached for a year.

## Style suffix — add to every prompt

> Editorial architectural photography, photorealistic, full-frame camera, tilt-shift lens, verticals perfectly corrected, soft natural light, warm neutral palette of sand, ivory, bronze and charcoal, crisp material texture, clean composition with generous negative space, no text, no logos, no watermark, no people.

**Negative prompt:** warped lines, curved verticals, CGI look, plastic surfaces, oversaturated, HDR halos, lens flare, blur, readable signage, text, people, extra objects.

---

## Hero carousel — 4 slides × 2 crops

- Desktop `images/hero/hero-0N.webp` — **1920×1080 (16:9)**
- Mobile `images/hero/hero-0N-m.webp` — **900×1350 (2:3)**, same scene re-framed vertically

Keep the bottom 40% of each frame calm and slightly darker, because the headline sits there. Put the subject in the upper two-thirds.

**H1 · Façades** — Contemporary four-storey commercial building in Bengaluru at blue hour. Façade clad in champagne-bronze aluminium composite panels with crisp shadow-gap joints and slim vertical fins. Warm interior light glows through floor-to-ceiling glazing. Wet, reflective forecourt, a few palms at the edges, low three-quarter angle, deep-blue sky.

**H2 · Workplaces** — Bright open-plan corporate office floor. Seamless white gypsum ceiling with linear recessed light slots, charcoal carpet tiles, frameless glass meeting rooms with fine black aluminium frames, oak-veneer wall panelling. Soft daylight from full-height windows overlooking the city. Empty and immaculate, one-point perspective at eye level.

**H3 · Retail** — Large-format modern lifestyle store interior. Polished light-grey concrete-look floor, white suspended ceiling with long linear LED lines, minimal fixtures in light oak and matte black, a wide aisle leading the eye to the back wall. Bright even light, no brand names, no readable signage, wide-angle at eye level.

**H4 · Receptions** — Premium corporate reception. Monolithic travertine desk, fluted oak wall panelling, brushed-bronze trims, sculpted gypsum ceiling with warm cove lighting, terrazzo floor, one large sculptural plant. Late-afternoon light, symmetrical composition.

## Disciplines — `images/disciplines/…` — 1200×1500 (4:5)

**D1 · `01-acp-facades.webp`** — Abstract close-up of a façade in bronze-metallic ACP panels with precise 10 mm shadow-gap joints and crisply folded edges. Raking afternoon sun casts strong geometric shadows, with a sliver of blue sky in one corner.

**D2 · `02-commercial-interiors.webp`** — Corner of a finished modern office: glass-partition meeting room, sand-coloured acoustic felt wall panel, oak table, black task chairs, linear pendant. Calm, premium daylight.

**D3 · `03-false-ceiling-gypsum.webp`** — Worm's-eye view of a sculpted white gypsum ceiling with layered coffers and hidden warm cove LED light. Perfectly smooth jointless finish, minimal recessed downlights, strong graphic lines.

**D4 · `04-flooring.webp`** — Low-angle detail where charcoal carpet tiles meet light oak-look SPC planks, joined by a slim brushed-metal transition strip. Grazing daylight brings out the texture, shallow depth of field.

**D5 · `05-civil-painting.webp`** — Freshly finished warm off-white matte wall meeting a textured lime-plaster feature wall. A single paint roller rests on a clean tray on a dust sheet. Soft side light shows a flawless surface.

**D6 · `06-fabrication-glazing.webp`** — Slim black aluminium curtain-wall glazing on a commercial building, seen from below at an angle. Mullion-and-transom grid reflecting sky and trees, precise silicone joints, graphic composition.

## Material library — `images/shades/cmt600N.webp` — 1000×1000 (1:1)

**Use real photos of the physical samples where you can.** The colours are guessed from the shade names and must match the product. If you generate them, use this base prompt:

> Macro product shot of one square aluminium composite panel sample lying flat on a seamless warm-grey backdrop, soft diffused top light, slight bevel showing the three-layer core at the front edge, finish: ___

- **S1 CMT6001 Metafrazo Texture** — textured metallic silver-grey with a fine fractured pattern
- **S2 CMT6002 Cortern Brown** — matte corten-steel brown with subtle mottling
- **S3 CMT6003 Abstract Metal** — brushed metal with swirling grey tones
- **S4 CMT6004 Lustrous Grey** — high-gloss graphite grey
- **S5 CMT6007 Arcadian Ochre** — warm matte ochre-yellow
- **S6 CMT6008 Saprophyte Rust** — weathered deep rust orange-brown

## Signature work — `images/projects/…` — 1600×1200 (4:3)

**These must be real photos of the real sites.** AI images captioned as a named client's store would misrepresent your work. Shot direction: blue hour or bright overcast light, tripod, verticals straight, site cleared of clutter and staff, client signage only where the client allows it.

- **P1 `decathlon-whitefield.webp`** (featured; framed 16:11, so keep the subject centred) — storefront façade at dusk, three-quarter view
- **P2 `smart-bazaar-gonikoppa.webp`** — full building elevation, daytime
- **P3 `trends.webp`** — interior, wide shot from the entrance
- **P4 `style-union.webp`** — interior showing the finished ceiling and flooring
- **P5 `office-fitout.webp`** — open office, wide
- **P6 `meeting-space.webp`** — conference room, symmetrical

## AI Design Studio — `images/studio/…` — 1600×1200 (4:3)

All four images must show the **same room from the same camera**. Generate A1 first, then make A2–A4 with image-to-image (same seed, strength around 0.55) and change only the materials.

**Base:** Mid-size corporate reception seen straight on from the entrance. Reception desk centred, feature wall behind it, ceiling and floor both visible, eye level, symmetrical, soft daylight from the left, photoreal interior.

- **A1 `stone-bronze.webp`** — honed beige limestone desk and wall cladding, brushed-bronze trims, warm white light
- **A2 `teak-terracotta.webp`** — fluted teak-veneer wall, terracotta-tile desk front, warm amber light
- **A3 `lime-oak.webp`** — textured lime-plaster walls, pale oak desk, linen tones, airy daylight
- **A4 `dark-monolith.webp`** — charcoal ACP wall cladding, black stone monolith desk, a single warm spotlight, moody

## The Firm — `images/firm/material-desk.webp` — 1600×1280 (5:4)

**F1** — Top-down flat lay on a dark oak table: ACP swatches in bronze, graphite and ochre, a travertine sample, an oak veneer chip, a folded architectural drawing with dimension lines, a brass scale ruler and a pencil. Soft window light from the left, editorial still life.

## Journal — `images/journal/…` — 1500×1000 (3:2)

**J1 `cladding-choices.webp`** — Three façade cladding samples side by side on a site mock-up wall (bronze ACP, dark HPL, terracotta baguettes) under a bright overcast sky, surfaces wet from the monsoon.

**J2 `fitout-14-weeks.webp`** — Commercial office floor in the middle of fit-out. Exposed ceiling services, gypsum ceiling grid partly installed, aluminium partition studs, a scissor lift. Clean, organised site in morning light.

**J3 `retail-rollout.webp`** — Single-storey modern retail storefront in a small Karnataka town at dusk. Clean ACP fascia with a blank signage band, shopfront glazing glowing warm, coconut palms and street in frame, no readable text.

## Closing banner — `images/film-poster.webp` — 1920×1200 (16:10)

**FP** — Twilight view from inside a finished top-floor office looking across the Bengaluru skyline. Floor-to-ceiling glass, warm interior lights reflected in the glass, empty room, lower 40% of the frame darker for the headline.
