/**
 * The reference photograph of a catalogue design, attached to the studio's render request (targets C1, A1).
 *
 * The studio sends Gemini a photo, a mask and a text brief (swatchroom/public/js/lib/render.js); it has no way to send a picture of the material, and
 * swatchroom/ is a verbatim copy that is not edited. A catalogue design offered in the studio (site/catalogue-ui/studio-finishes.js) carries a marker in its brief,
 * `[[terucon-design:TIPL-SB804]]`. This middleware sits in front of the studio's own /api/ai/generate: for a render request with that marker it
 *   - looks the design up (MongoDB), fetches its photograph (Cloud Storage), and appends it to `parts` as the last image;
 *   - adds four rules about how to use it to the system prompt, and a line to the brief (server/catalogue/studioFinishes.js);
 *   - takes the marker out of the text.
 * Everything else about the request is left alone, and the studio's route then does what it always does. If anything is missing (no database, no
 * picture, an unknown design) the marker is simply taken out and the render goes ahead with the text brief alone, as it would have without this file.
 *
 * It reads the body itself, with the studio's own limit, and the studio's parser then finds the request already read (body-parser skips a finished request:
 * checked by tests/js/studio-reference.test.js against the real studio route). Any other request, and any request with no marker, passes untouched.
 */
import express from 'express';
import { MARKER_RE, stripMarker, withReference } from '../catalogue/studioFinishes.js';

/**
 * @param {object} options
 * @param {() => ReturnType<typeof import('../catalogue/designs.js').createDesigns> | null} options.designs the designs store (ctx.catalogue.designs), read on every request
 * @param {string} options.limit the studio's body limit for this route
 * @param {{info: Function, warn: Function}} [options.log]
 */
export function studioReference({ designs, limit, log }) {
  const parse = express.json({ limit });
  return function studioReferenceMiddleware(req, res, next) {
    if (req.method !== 'POST' || req.path !== '/api/ai/generate') return next();
    parse(req, res, (error) => {
      if (error) return next(error);
      attach(req.body).then(() => next(), next);
    });
  };

  async function attach(body) {
    if (!body || typeof body !== 'object' || body.task !== 'image' || typeof body.brief !== 'string') return;
    const found = MARKER_RE.exec(body.brief);
    if (!found) return;
    const productId = found[1];
    try {
      const store = designs();
      const design = store ? await store.get(productId.toLowerCase()) : null;
      const picture = design ? await store.image(design.id, 'card') : null;
      if (!design || !picture || !Array.isArray(body.parts) || typeof body.systemPrompt !== 'string') {
        log?.warn(`studio  ${productId}: no reference photograph attached (${!design ? 'the design is not in the catalogue' : !picture ? 'the picture could not be read' : 'the request has no parts'}); the render goes ahead with the text brief`);
        body.brief = stripMarker(body.brief);
        return;
      }
      const out = withReference(design, picture, body);
      body.parts = out.parts;
      body.brief = out.brief;
      body.systemPrompt = out.systemPrompt;
      log?.info(`studio  ${productId}: reference photograph attached as Image ${out.imageNumber} (${Math.round(picture.bytes.length / 1024)} KB)`);
    } catch (error) {
      log?.warn(`studio  ${productId}: no reference photograph attached (${String(error?.name ?? 'error').slice(0, 40)}); the render goes ahead with the text brief`);
      body.brief = stripMarker(body.brief);
    }
  }
}
