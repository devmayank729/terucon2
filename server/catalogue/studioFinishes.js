/**
 * The catalogue designs as finishes of the Design Studio, and what the render model is told about them (targets C1, A1).
 *
 * The studio (swatchroom/, a verbatim copy that is never edited) has a list of 103 finishes drawn in code, each with a text brief for the render
 * model; it sends the model the photo, a mask and that text, and nothing else, so a design it cannot draw is only a name and a sentence to it. For
 * a catalogue design this file does two things:
 *
 *   1. `finishOf(design)` is the finish the studio's list gets (a name, a sub-line, a sentence, the brief and a marker, `[[terucon-design:TIPL-SB804]]`),
 *      served by GET /api/catalogue/studio-finishes and added to the studio by site/catalogue-ui/studio-finishes.js.
 *   2. `referenceOf(design, parts, systemPrompt, brief)` is applied by server/lib/studioReference.js to a render request that carries the marker: it
 *      attaches the design's own photograph as one more image and adds four rules about how to use it, so the model sees the real material instead
 *      of imagining one from a name.
 *
 * What the text may say. It comes from the design's printed name and code and from what Gemini SAW in the design's photograph (server/catalogue/designs.js
 * `studio`): colours, pattern, grain, sheen, relief, the scale of the pattern as fine / medium / large. Never a size, a thickness, a composition, a
 * performance or a price: nobody has told us any of those. Whether it renders well is judged by looking at renders (docs/CATALOGUE_STUDIO.md), not claimed here.
 */

/** The studio's surface kinds the designs are offered for. A decorative sheet is wall cladding, a door or cabinet face: not a floor, ceiling or window. */
export const STUDIO_KINDS = Object.freeze(['wall', 'door', 'furniture']);
export const STUDIO_GROUP = 'Terucon catalogue';

export const MARKER_RE = /\[\[terucon-design:(TIPL-[A-Z]{2,4}\d{2,5})\]\]/;
const markerOf = (productId) => `[[terucon-design:${productId}]]`;

const GRAIN_LINE = {
  none: 'The pattern has no fixed direction: do not give it one.',
  vertical: 'The pattern runs vertically in the sample (upright as photographed): keep it vertical on the surface; on a door or a cabinet front it follows the long edge of the panel.',
  horizontal: 'The pattern runs horizontally in the sample (upright as photographed): keep it horizontal on the surface.',
  diagonal: 'The pattern runs on a diagonal in the sample: keep the same slant on the surface.',
  random: 'The pattern wanders in every direction in the sample (random veining): keep it irregular, never in rows.',
};
const SCALE_LINE = {
  fine: 'It is a fine pattern: from across the room it reads as an even surface with a close texture, not as individual features.',
  medium: 'It is a medium-scale pattern: individual features are visible across the room but none dominates the surface.',
  large: 'It is a large-scale pattern: big, bold features (broad veins, wide bands, large marks) that stay clearly visible from across the room.',
};
const SHEEN_LINE = {
  matte: 'Its surface is matte: no mirror reflections, only a soft, even diffusion of the room light.',
  satin: 'Its surface is satin: a low, soft sheen that brightens gently where the room light grazes it.',
  'semi-gloss': 'Its surface is semi-gloss: a clear but soft reflection of the window and lamp light, blurred, never a mirror.',
  gloss: 'Its surface is glossy: it reflects the room, with soft mirrored highlights of windows and lamps that follow the room\'s own light.',
  metallic: 'Its surface is metallic: a directional sheen that changes along the surface with the room light, never a flat grey.',
};
const RELIEF_LINE = {
  flat: 'The surface is flat and smooth to the eye.',
  'fine texture': 'The surface has a fine texture that catches light a little, visible only close up.',
  'pronounced texture': 'The surface has a pronounced texture: a visible grain or roughness that catches the room light and casts tiny shadows.',
  embossed: 'The surface is embossed: raised and recessed relief that casts small shadows and highlights in the room light.',
};

/** How the finish is named in the list: the code, then what it is like, when Gemini has looked at it. */
function subOf(design) {
  const s = design.studio;
  return s ? `${design.code} · ${s.pattern}, ${s.sheen}` : design.code;
}

/** The sentence under the finish's name in the studio (the "about" line), and the title of its tile. Plain text. */
function aboutOf(design) {
  const s = design.studio;
  const head = `${design.name}, Terucon catalogue design ${design.productId}.`;
  return s ? `${head} ${s.look}` : head;
}

/**
 * The brief for the render model, as the studio's own "Details:" line. Everything here also works without the reference photograph (the text
 * alone describes the design), so a render that could not attach the picture is still told what to make.
 */
export function briefOf(design) {
  const s = design.studio;
  const lines = [`Apply the Terucon catalogue design "${design.name}" (code ${design.code}) to the surface.`];
  if (s) {
    lines.push(`How it looks: ${s.look}`);
    lines.push(`Colours: ${s.colours.join(', ')}. Pattern: ${s.pattern}. ${s.render}`);
    lines.push(GRAIN_LINE[s.grain], SCALE_LINE[s.scale], SHEEN_LINE[s.sheen], RELIEF_LINE[s.relief]);
  } else if (design.hex) {
    lines.push(`Its dominant colour is close to ${design.hex}. Take its pattern and finish exactly from the reference photograph.`);
  } else {
    lines.push('Take its colour, pattern and finish exactly from the reference photograph.');
  }
  lines.push(markerOf(design.productId));
  return lines.join(' ');
}

// The real-world size of one sheet of the design (2026-11-04: the same placeholder A1 already flags on the shop's product
// pages, "Size and price: Sample values until the price list is loaded" - 1220 x 2440 mm. Reused here, not re-guessed, so
// the one open question (open decision 23, TARGETS.md) has one answer everywhere it appears. It only sets how often the
// instant preview's texture repeats across a wall; a wrong number does not break the preview, just its scale.
const SHEET_WIDTH_M = 1.22;
const SHEET_HEIGHT_M = 2.44;

/**
 * The finish's texture for the studio's instant (browser-side) preview: a seamlessly-tileable crop of the design's own
 * photograph (server/lib/tileTexture.js, served by server/routes/catalogueMedia.js's `?tile=1`), at the sheet's own real
 * size. Without this the design still works, it just always renders with the AI (swatchroom/public/js/lib/fastrender/tiers.js
 * canFastRenderItem: no `texture.url`, no fast path) - true until 2026-11-04, see TARGETS.md C1.
 */
function textureOf(design) {
  return { url: `/media/materials/${design.id}.jpg?tile=1`, tileWidthM: SHEET_WIDTH_M, tileHeightM: SHEET_HEIGHT_M };
}

/** The finish as the studio's list needs it (the same fields as swatchroom/public/js/data/catalog.js, plus the picture). */
export function finishOf(design) {
  return {
    id: design.id,
    code: design.code,
    productId: design.productId,
    name: design.name,
    sub: subOf(design),
    about: aboutOf(design),
    prompt: briefOf(design),
    hex: design.hex,
    image: `/media/materials/${design.id}.jpg?w=320`,
    texture: textureOf(design),
    described: Boolean(design.studio),
  };
}

/** The studio's finish list for a set of designs: what GET /api/catalogue/studio-finishes answers. */
export function studioFinishes(designs) {
  return { group: STUDIO_GROUP, kinds: STUDIO_KINDS, finishes: designs.map(finishOf) };
}

/** The rules added to the studio's own list (it numbers them 1 to 10) when a reference photograph is attached as image number `n`. */
export function referenceRules(design, n) {
  return [
    '',
    `Image ${n} (a material reference, when sent): a straight-on photograph of the exact material to fit, the catalogue design "${design.name}" (${design.code}). It is the ground truth for the design.`,
    `11. Reproduce what Image ${n} shows: its colours, its pattern or grain (the shape, density and direction of its marks), its sheen and its surface relief. Do not recolour it, simplify it, tidy it into a different pattern or invent features it does not have.`,
    `12. Image ${n} is a sample photograph, not a picture to paste. Do not copy its frame, its edges, any label or text, or its lighting. Lay the material on the target surface the way a fitted installation of it would look: following the plane and perspective of the surface, lit by the light of Image 1 (direction, falloff, shadows and reflections come from the room, never from the sample).`,
    '13. Scale the pattern from the room (rule 8): features must be a believable size on this surface; never stretch the sample to fill the surface and never shrink it into noise. Continue the pattern across the whole surface naturally, with no visible repeat of a tile and no seam, unless the brief asks for joints.',
    `14. Keep the sample's sheen and relief as the camera would see them at this distance: matte stays flat, gloss reflects the room softly, a textured or embossed surface keeps its fine light-and-shadow texture. Colour must stay true to Image ${n} after the room's light is applied.`,
  ].join('\n');
}

/**
 * Add the reference photograph to one render request (the body the studio sent to /api/ai/generate).
 * @param {object} design a design of server/catalogue/designs.js
 * @param {{bytes: Buffer, type: string}} picture its photograph
 * @param {{parts: object[], brief: string, systemPrompt: string}} body
 * @returns {{parts: object[], brief: string, systemPrompt: string, imageNumber: number}} the body with the picture as the last image
 */
export function withReference(design, picture, body) {
  const imageNumber = body.parts.filter((p) => p && typeof p === 'object' && p.inlineData).length + 1;
  const parts = [...body.parts, { inlineData: { mimeType: picture.type, data: picture.bytes.toString('base64') } }];
  const brief = `${stripMarker(body.brief)}\n\nMaterial reference: Image ${imageNumber} is the sample photograph of "${design.name}" (${design.code}); follow rules 11 to 14 for it.`;
  return { parts, brief, systemPrompt: `${body.systemPrompt}\n${referenceRules(design, imageNumber)}`, imageNumber };
}

/** The text without the marker (and the one space before it); nothing else in it is touched. */
export const stripMarker = (text) => String(text ?? '').replace(new RegExp(` ?${MARKER_RE.source}`, 'g'), '');
