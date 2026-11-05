/**
 * Photos, videos and fonts from the media folder: only the extensions site.json allows, never a hidden
 * file, never anything outside the folder. Range requests work (the videos need them).
 *
 * Cache: a week (`public, max-age=604800`). These files are NOT content-hashed (an edited photo keeps its name), so they are
 * not `immutable` and not cached for a year; a week keeps repeat visits off the network (the photos and the two videos are
 * most of what the landing page weighs) and a replaced file shows up within it. They carry ETag and Last-Modified, so a
 * browser that does ask gets a 304. Files in dist/assets/ (the built pages' own images) are hashed and live for a year instead
 * (server/routes/assets.js). The older `media.maxAgeSeconds` of site.json is no longer read: the policy table is in the code.
 * Compression: none, the types served here (jpg, png, webp, mp4, woff2) are already compressed; svg is handled by the
 * compression middleware.
 */
import path from 'node:path';
import { notFound } from '../middleware/errorHandler.js';
import { catalogueImageHandler } from './catalogueMedia.js';

const BAD_SEGMENT = /[\\/\0]/;

/** Seconds. See the comment at the top. */
export const MEDIA_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function mountMedia(app, ctx) {
  const { route, dir, extensions } = ctx.site.media;
  const mediaRoot = path.join(ctx.root, dir);

  // the pictures of the catalogue designs are not files: they are read from Cloud Storage through MongoDB (server/routes/catalogueMedia.js)
  app.get(`${route}/materials/:file`, catalogueImageHandler(ctx));

  // Express 5 gives a wildcard as an array of decoded segments, so "%2F" arrives as a "/" inside one segment.
  app.get(`${route}/*name`, (req, res, next) => {
    const segments = req.params.name;
    const unsafe = segments.some((part) => part === '' || part.startsWith('.') || BAD_SEGMENT.test(part));
    if (unsafe || !extensions.has(path.extname(segments.at(-1)).toLowerCase())) return notFound(req, res);
    const relative = segments.join('/');
    if (!path.resolve(mediaRoot, relative).startsWith(mediaRoot + path.sep)) return notFound(req, res);
    res.sendFile(relative, { root: mediaRoot, maxAge: MEDIA_MAX_AGE_SECONDS * 1000 }, (err) => {
      if (!err || res.headersSent) return;
      if (err.status === 404 || err.code === 'ENOENT' || err.code === 'EISDIR') return notFound(req, res);
      next(err);
    });
  });
}
