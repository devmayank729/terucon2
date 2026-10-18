/**
 * Photos, videos and fonts from the media folder: only the extensions site.json allows, never a hidden
 * file, never anything outside the folder. Range requests work (the videos need them).
 */
import path from 'node:path';
import { notFound } from '../middleware/errorHandler.js';

const BAD_SEGMENT = /[\\/\0]/;

export function mountMedia(app, ctx) {
  const { route, dir, maxAgeSeconds, extensions } = ctx.site.media;
  const mediaRoot = path.join(ctx.root, dir);

  // Express 5 gives a wildcard as an array of decoded segments, so "%2F" arrives as a "/" inside one segment.
  app.get(`${route}/*name`, (req, res, next) => {
    const segments = req.params.name;
    const unsafe = segments.some((part) => part === '' || part.startsWith('.') || BAD_SEGMENT.test(part));
    if (unsafe || !extensions.has(path.extname(segments.at(-1)).toLowerCase())) return notFound(req, res);
    const relative = segments.join('/');
    if (!path.resolve(mediaRoot, relative).startsWith(mediaRoot + path.sep)) return notFound(req, res);
    res.sendFile(relative, { root: mediaRoot, maxAge: maxAgeSeconds * 1000 }, (err) => {
      if (!err || res.headersSent) return;
      if (err.status === 404 || err.code === 'ENOENT' || err.code === 'EISDIR') return notFound(req, res);
      next(err);
    });
  });
}
