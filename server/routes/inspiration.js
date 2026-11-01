/**
 * Inspiration import (target C3): paste an address, get a picture to crop and send to the Design Studio.
 *
 *   GET  /api/inspiration/status        {enabled, ready, sites, maxFileMb}
 *   POST /api/inspiration/resolve       {input}  ->  {type, kind, source, title, approximate, items: [{token, preview, width, height, title}]}
 *   GET  /api/inspiration/file/:token   the picture itself (JPEG, PNG, WebP, GIF or AVIF, checked), to crop in the browser
 *   GET  /inspiration/assets/:name      the browser modules and style (site/inspiration/), a fixed list of names
 *
 * The three API routes need a signed-in, finished account (the same rule as the Design Studio's costly routes, server/auth/index.js
 * apiGate), unless sign-in is switched off for the whole site; then they are limited by the visitor's address alone. The work and
 * its safety checks are in server/lib/inspiration/.
 */
import express from 'express';
import path from 'node:path';
import { StoreUnavailableError } from '../auth/index.js';
import { sendError } from '../lib/errors.js';
import { createGalleryRunner } from '../lib/inspiration/gallery.js';
import { createImporter, ImportError } from '../lib/inspiration/importer.js';

/** The browser files, by the name they are served under. Nothing else in the folder is ever served. */
export const ASSETS = ['sources.js', 'dom.js', 'api.js', 'geometry.js', 'cropper.js', 'ui.js', 'handoff.js', 'flow.js', 'index.js', 'feed.js', 'page.js', 'import.css'];

export function mountInspiration(app, ctx) {
  const { api, log } = ctx;
  // `inspirationOverrides` (createApp's `inspiration` option) is for tests: a fake picture fetcher and a fake gallery-dl runner
  const { gallery = createGalleryRunner({ settings: () => ctx.settings().inspiration, log }), fetcher } = ctx.inspirationOverrides ?? {};
  const importer = createImporter({ settings: () => ctx.settings().inspiration, gallery, fetcher, log });
  ctx.inspiration = importer;

  const assetRoot = path.join(ctx.root, 'site', 'inspiration');
  app.get('/inspiration/assets/:name', (req, res, next) => {
    if (!ASSETS.includes(req.params.name)) return next();
    res.sendFile(req.params.name, { root: assetRoot, dotfiles: 'deny', cacheControl: false, headers: { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } }, (err) => {
      if (err && !res.headersSent) next(err.status === 404 ? undefined : err);
    });
  });

  /** Who is asking, or a sent answer and null. */
  async function who(req, res) {
    let account = null;
    if (ctx.auth.required()) {
      let found;
      try {
        found = await ctx.auth.resolve(req);
      } catch (error) {
        if (error instanceof StoreUnavailableError) return void sendError(res, 503, 'Sign-in is not available right now. Please try again in a minute.');
        throw error;
      }
      if (!found) return void sendError(res, 401, 'Please sign in to import a picture.');
      if (!found.user.profileComplete) return void sendError(res, 403, 'Please finish your details first.');
      account = found.user.ownerId;
    }
    return { account, address: req.ip ?? 'unknown' };
  }

  /** The error body of the site, with the short `reason` the page acts on. */
  function fail(res, error) {
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    res.status(error.status).set('Cache-Control', 'no-store').json({ error: { code: error.status, status: error.status === 502 ? 'UNAVAILABLE' : error.status === 429 ? 'RESOURCE_EXHAUSTED' : 'INVALID_ARGUMENT', message: error.message, reason: error.reason } });
  }

  api.get('/api/inspiration/status', async (req, res, next) => {
    try {
      if (!(await who(req, res))) return;
      res.json(importer.status());
    } catch (error) {
      next(error);
    }
  });

  api.post('/api/inspiration/resolve', express.json({ limit: '8kb' }), async (req, res, next) => {
    try {
      const asker = await who(req, res);
      if (!asker) return;
      res.json(await importer.resolve(req.body?.input, asker));
    } catch (error) {
      if (error instanceof ImportError) return fail(res, error);
      next(error);
    }
  });

  api.get('/api/inspiration/file/:token', async (req, res, next) => {
    try {
      const asker = await who(req, res);
      if (!asker) return;
      const picture = await importer.file(req.params.token, asker);
      res.set({
        'Content-Type': picture.type,
        'Content-Length': String(picture.bytes.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline; filename="inspiration"',
        'Cross-Origin-Resource-Policy': 'same-origin',
        ...(picture.width && picture.height ? { 'X-Picture-Size': `${picture.width}x${picture.height}` } : {}),
      });
      res.end(picture.bytes);
    } catch (error) {
      if (error instanceof ImportError) return fail(res, error);
      next(error);
    }
  });
}
