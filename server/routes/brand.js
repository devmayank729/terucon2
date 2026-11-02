/**
 * The brand files: GET /brand/<name> from site/brand/ (logos, icons, brand.css, the mobile dock, ...), plus the two addresses
 * browsers ask for by themselves, /favicon.ico and /site.webmanifest.
 *
 * Only a fixed list of extensions is served: never HTML (site/brand/ also holds snippets the build inlines into pages, not
 * pages), never a hidden file, never anything outside the folder. The files are not content-hashed, so they are fresh for a day
 * and may be served stale for a week while the browser checks for a new copy in the background; they have validators
 * (ETag, Last-Modified) so that check is cheap. Compression of the text types is the compression middleware's job.
 */
import path from 'node:path';
import { sendError } from '../lib/errors.js';

export const BRAND_ROUTE = '/brand';
export const BRAND_DIR = path.join('site', 'brand');
export const BRAND_CACHE = 'public, max-age=86400, stale-while-revalidate=604800';

/** The extensions served from /brand. og-image.jpg is the Open Graph picture; .webmanifest is the app manifest. */
export const BRAND_EXTENSIONS = new Set(['.css', '.js', '.svg', '.png', '.webp', '.jpg', '.jpeg', '.ico', '.json', '.webmanifest']);

const BAD_SEGMENT = /[\\/\0]/;

export function mountBrand(app, ctx) {
  const root = path.join(ctx.root, BRAND_DIR);
  const options = { root, dotfiles: 'deny', cacheControl: false, headers: { 'Cache-Control': BRAND_CACHE } };

  app.get(`${BRAND_ROUTE}/*name`, (req, res, next) => {
    const segments = req.params.name;
    const unsafe = segments.some((part) => part === '' || part.startsWith('.') || BAD_SEGMENT.test(part));
    if (unsafe || !BRAND_EXTENSIONS.has(path.extname(segments.at(-1)).toLowerCase())) return sendError(res, 404, 'No such file.');
    const relative = segments.join('/');
    if (!path.resolve(root, relative).startsWith(root + path.sep)) return sendError(res, 404, 'No such file.');
    res.sendFile(relative, options, (err) => {
      if (!err || res.headersSent) return;
      if (err.status === 404 || err.code === 'ENOENT' || err.code === 'EISDIR') return sendError(res, 404, 'No such file.');
      next(err);
    });
  });

  // Browsers ask for these two without being told. Until the brand files exist the favicon is an empty, quiet 204, as it always was.
  app.get('/favicon.ico', (req, res, next) => {
    res.sendFile('favicon.ico', options, (err) => {
      if (!err || res.headersSent) return;
      if (err.status === 404 || err.code === 'ENOENT') return res.status(204).end();
      next(err);
    });
  });

  app.get('/site.webmanifest', (req, res, next) => {
    res.sendFile('site.webmanifest', { ...options, headers: { ...options.headers, 'Content-Type': 'application/manifest+json; charset=utf-8' } }, (err) => {
      if (!err || res.headersSent) return;
      if (err.status === 404 || err.code === 'ENOENT') return sendError(res, 404, 'No such file.');
      next(err);
    });
  });
}
