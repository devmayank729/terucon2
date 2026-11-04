/**
 * Catalogue search (targets C3, C4, C7, C5; the admin's upload is D1): find materials in a real catalogue by photo, colour or words.
 *
 *   GET  /api/catalogue/status         {enabled, ready, reasons, default, catalogues, limits, profile}   cheap, remembered 10 seconds
 *   POST /api/catalogue/warm           202 {ok: true}   wake the search service; nobody waits for it
 *   POST /api/catalogue/search         the body is the photo itself (image/jpeg, image/png or image/webp, at most 6 MB)
 *                                      ?catalogue=&mode=look|colour&k=1..20&point=x,y&radius=&box=x0,y0,x1,y1&category=&finish=
 *   POST /api/catalogue/search-text    {text, catalogue?, k?, category?, finish?}
 *
 * All four need a signed-in, finished account (the same rule as /api/inspiration/*), unless sign-in is switched off for the whole site; then
 * they are limited by the visitor's address alone. With the feature off or not set up, every one but `status` answers 503 `catalogue-off`
 * and the rest of the site is untouched.
 *
 * The admin routes (/api/catalogue/admin/*) are in server/catalogue/adminRoutes.js, mounted from here. The work is in server/catalogue/;
 * the contract is catalogue/ARCHITECTURE.md section 7.
 */
import express from 'express';
import { StoreUnavailableError } from '../auth/index.js';
import { readBody } from '../catalogue/body.js';
import { MAX_PHOTO_BYTES } from '../catalogue/config.js';
import { CatalogueError, drainRequest, sendCatalogueError } from '../catalogue/errors.js';
import { mountAdminRoutes } from '../catalogue/adminRoutes.js';
import { createCatalogue } from '../catalogue/index.js';
import { baseType, judgePhoto, parseSearchParams, parseTextBody, PHOTO_TYPES } from '../catalogue/validate.js';
import { defaultShop, withShop } from '../lib/shopLink.js';

/** A photo that has not arrived in this long is given up on (a phone upload of 400 KB takes a second or two). */
const BODY_DEADLINE_MS = 20 * 1000;
const json = express.json({ limit: '4kb', strict: true });

/** Run an Express middleware as a promise. */
const runMiddleware = (middleware, req, res) => new Promise((resolve, reject) => middleware(req, res, (error) => (error ? reject(error) : resolve())));

export function mountCatalogue(app, ctx) {
  const { api, log } = ctx;
  // `catalogueOverrides` (createApp's `catalogue` option) is for tests: a fake Modal client, a catalogue database, a signer, a clock
  const { modal, db, signer, now } = ctx.catalogueOverrides ?? {};
  const catalogue = createCatalogue({ settings: ctx.settings, auth: ctx.auth, mongoose: ctx.swatchroom?.mongoose() ?? null, log, now, overrides: { modal, db, signer } });
  ctx.catalogue = catalogue;
  const svc = catalogue.service;
  /** Each result also says what the shop lists for it (a design of the catalogue is a shop product under the same id, server/lib/shopLink.js). */
  const shopOf = (answer) => withShop(answer, ctx.shopOverride ?? defaultShop());

  /** Who is asking, or a CatalogueError to send. The same rule as server/routes/inspiration.js. */
  async function who(req) {
    let account = null;
    if (ctx.auth.required()) {
      let found;
      try {
        found = await ctx.auth.resolve(req);
      } catch (error) {
        if (error instanceof StoreUnavailableError) throw new CatalogueError(503, 'not-ready', 'Sign-in is not available right now. Please try again in a minute.');
        throw error;
      }
      if (!found) throw new CatalogueError(401, 'unauthorized', 'Please sign in to search the catalogue.');
      if (!found.user.profileComplete) throw new CatalogueError(403, 'unauthorized', 'Please finish your details first.');
      account = found.user.ownerId;
    }
    return { account, address: req.ip ?? 'unknown' };
  }

  /** Wrap a client route: same-site check, who is asking, the body parser if there is one, then the handler. Errors become the site's JSON. */
  const guarded = (handler, { write = true, parse = null } = {}) => async (req, res, next) => {
    try {
      const site = req.headers['sec-fetch-site'];
      if (write && site && site !== 'same-origin' && site !== 'none') throw new CatalogueError(403, 'cross-site', 'Cross-site requests are not allowed.');
      const asker = await who(req);
      if (parse) await runMiddleware(parse, req, res);
      return await handler(req, res, asker);
    } catch (error) {
      const refusal = error instanceof CatalogueError ? error : error?.type && error.status >= 400 && error.status < 500 ? new CatalogueError(error.status, error.type === 'entity.too.large' ? 'too-large' : 'bad-request', error.type === 'entity.too.large' ? 'That request is too large.' : 'The request was not understood.') : null;
      if (!refusal) return next(error);
      await drainRequest(req); // a client still sending (too big, busy, refused) is let finish first, so it sees why instead of a reset connection
      return sendCatalogueError(res, refusal);
    }
  };

  api.get('/api/catalogue/status', guarded(async (req, res) => res.json(await svc.status()), { write: false }));

  api.post(
    '/api/catalogue/warm',
    guarded(
      async (req, res, asker) => {
        svc.assertEnabled();
        const verdict = svc.check('warm', asker);
        if (!verdict.ok) throw verdict.error;
        svc.record('warm', asker);
        await svc.warm();
        res.status(202).json({ ok: true });
      },
      { parse: json },
    ),
  );

  api.post(
    '/api/catalogue/search',
    guarded(async (req, res, asker) => {
      const params = parseSearchParams(req.query);
      // the JSON rule of the guards lets JSON through; a photo search is only ever a photo
      const type = baseType(req.headers['content-type']);
      if (!PHOTO_TYPES.includes(type)) throw new CatalogueError(415, 'bad-request', 'Send the photo itself, as image/jpeg, image/png or image/webp.');
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) throw new CatalogueError(413, 'too-large', `The photo is too large (at most ${Math.floor(MAX_PHOTO_BYTES / 1024 / 1024)} MB).`);
      const live = await svc.prepare(params);
      const verdict = svc.check('search', asker);
      if (!verdict.ok) throw verdict.error;
      // a place among the searches in flight first (a rush is turned away here, counting nothing), then the hit is counted, then the body is read
      const release = svc.tryAcquire();
      if (!release) throw new CatalogueError(503, 'busy', 'The search is busy right now. Please try again in a moment.', { retryAfter: 3 });
      try {
        svc.record('search', asker);
        const bytes = await readBody(req, { limit: MAX_PHOTO_BYTES, deadlineMs: BODY_DEADLINE_MS });
        const photo = judgePhoto(bytes, type);
        res.json(shopOf(await svc.searchPhoto({ live, params, bytes, type: photo.type })));
      } finally {
        release();
      }
    }),
  );

  api.post(
    '/api/catalogue/search-text',
    guarded(
      async (req, res, asker) => {
        const body = parseTextBody(req.body);
        const live = await svc.prepare(body);
        const verdict = svc.check('text', asker);
        if (!verdict.ok) throw verdict.error;
        const release = svc.tryAcquire();
        if (!release) throw new CatalogueError(503, 'busy', 'The search is busy right now. Please try again in a moment.', { retryAfter: 3 });
        try {
          svc.record('text', asker);
          res.json(shopOf(await svc.searchText({ live, body })));
        } finally {
          release();
        }
      },
      { parse: json },
    ),
  );

  mountAdminRoutes(app, ctx, catalogue);
}
