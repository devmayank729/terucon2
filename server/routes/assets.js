/**
 * The built site's files: GET /assets/<name>-<hash12>.<ext> from dist/assets/ (tools/build-dist.js writes them).
 *
 * The names carry a hash of the content, so a file never changes under its name: it is served for a year and marked
 * `immutable` (a browser that has it never asks again; a changed file has a new name, and so does every page that uses it).
 * A name without such a hash (should the build ever emit one) is only revalidated, never frozen.
 *
 * The precompressed copies next to a file (".br", ".gz") are chosen by the Accept-Encoding of the request, br before gzip, and
 * sent with the original's Content-Type, Content-Encoding and `Vary: Accept-Encoding`. They are not addresses of their own.
 *
 * Only a fixed list of extensions is served, never HTML, never a hidden file, never anything outside dist/assets. A miss is a
 * plain 404 in the website's error shape (no Coming soon page: a stylesheet that is gone is not a page nobody has built).
 */
import path from 'node:path';
import { chooseEncoding, sendVariant } from '../lib/delivery.js';
import { sendError } from '../lib/errors.js';

export const ASSETS_ROUTE = '/assets';

/** Extension -> Content-Type. Anything not listed is not served. Compressed copies (.br, .gz) are deliberately absent. */
export const ASSET_TYPES = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/vnd.microsoft.icon'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
]);

/** Types worth a `Vary: Accept-Encoding` (they may have a compressed copy); images, fonts and video are already compressed. */
const TEXT_TYPES = new Set(['.js', '.mjs', '.css', '.json', '.svg', '.txt']);

const BAD_SEGMENT = /[\\/\0]/;
/** "<name>-<12 hex>.<ext>": the content hash tools/build-dist.js puts in every file name. */
const HASHED = /-[0-9a-f]{12}\.[A-Za-z0-9]+$/;

export const ASSET_CACHE = 'public, max-age=31536000, immutable';
const UNHASHED_CACHE = 'public, no-cache';

export function mountAssets(app, ctx) {
  const { dist } = ctx;
  const root = dist.assetsDir;

  // Express 5 gives a wildcard as an array of decoded segments, so "%2F" arrives as a "/" inside one segment.
  app.get(`${ASSETS_ROUTE}/*name`, async (req, res, next) => {
    const segments = req.params.name;
    const unsafe = segments.some((part) => part === '' || part.startsWith('.') || BAD_SEGMENT.test(part));
    const name = segments.at(-1);
    const extension = path.extname(name).toLowerCase();
    if (unsafe || !ASSET_TYPES.has(extension)) return missing(res);
    const relative = segments.join('/');
    if (!path.resolve(root, relative).startsWith(root + path.sep)) return missing(res);
    try {
      const text = TEXT_TYPES.has(extension);
      const have = text ? await dist.assetCodings(relative) : { br: false, gz: false };
      const encoding = chooseEncoding(req.headers['accept-encoding'], { br: have.br, gzip: have.gz });
      const sent = await sendVariant(res, {
        root,
        relative,
        encoding,
        type: ASSET_TYPES.get(extension),
        headers: { 'Cache-Control': HASHED.test(name) ? ASSET_CACHE : UNHASHED_CACHE },
        vary: have.br || have.gz,
        ranges: true,
      });
      if (!sent) return missing(res);
      return undefined;
    } catch (error) {
      return next(error);
    }
  });
}

function missing(res) {
  sendError(res, 404, 'No such file.');
}
