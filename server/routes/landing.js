/**
 * The landing page: GET / (and /index.html, which redirects there) and its files under /lp/ (server/lib/landing/ builds them in memory
 * when the server starts, from site/landing/).
 *
 *   /              Cache-Control: no-cache, a strong ETag per body (br / gzip / plain differ), 304 on a match; the brotli and gzip bodies were
 *                  made once at start-up, so a request only picks one (Vary: Accept-Encoding).
 *   /lp/<name>     the picture, font and script files. Every name carries a hash of the file (site/landing/img names come from
 *                  tools/optimize-landing.mjs, the rest from the builder), so each is `public, max-age=31536000, immutable`: a changed file has a new
 *                  name, and so has every page that uses it. Scripts are served in the coding the browser accepts (precompressed);
 *                  pictures and fonts are already compressed. A name that is not in the build is a plain 404: never the Coming soon page.
 *
 * Mounted before the site map's pages (routes/pages.js), so "/" is this page. When site/landing/ is not in the project (a test folder, an
 * older checkout) or cannot be built, nothing is mounted and "/" stays the site map's own landing page; a build failure is logged as an error.
 * LANDING=classic in .env (the file is read again when it changes: no restart) makes both addresses fall through to the site map's own page: the way back. A LANDING set in the real environment (Render's dashboard) is read when the server starts, so changing it there needs the service to restart.
 */
import path from 'node:path';
import { chooseEncoding } from '../lib/delivery.js';
import { sendError } from '../lib/errors.js';
import { buildLanding, LANDING_DIR } from '../lib/landing/index.js';

export const LANDING_ASSET_CACHE = 'public, max-age=31536000, immutable';
export const LANDING_PAGE_CACHE = 'no-cache';

/** @returns {ReturnType<typeof buildLanding>} the build (also on ctx.landing), or null when nothing was mounted */
export function mountLanding(app, ctx) {
  let landing = null;
  try {
    landing = buildLanding({ root: ctx.root, log: ctx.log });
  } catch (error) {
    ctx.log.error?.(`landing  site/landing/ could not be built, so "/" stays the old landing page: ${error.message}`);
    return null;
  }
  if (!landing) return null;
  ctx.landing = landing;
  const { report } = landing;
  ctx.log.info?.(`landing  built: page ${(report.htmlBytes / 1024).toFixed(1)} KB (br ${(landing.htmlBr.length / 1024).toFixed(1)} KB), ${report.assets} files under ${landing.assetBase}`);

  app.get('/', (req, res, next) => {
    if (ctx.settings().landing === 'classic') return next(); // LANDING=classic: the site map's own landing page answers (routes/pages.js)
    const encoding = chooseEncoding(req.headers['accept-encoding'], { br: true, gzip: true });
    const body = encoding === 'br' ? landing.htmlBr : encoding === 'gzip' ? landing.htmlGz : landing.html;
    res.vary('Accept-Encoding');
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': LANDING_PAGE_CACHE,
      ETag: `"${landing.etag}${encoding === 'br' ? '-br' : encoding === 'gzip' ? '-gz' : ''}"`,
    });
    if (encoding !== 'identity') res.set('Content-Encoding', encoding);
    res.locals.skipCompression = true; // already the final bytes (and the compression middleware must not touch a strong ETag's body)
    if (req.fresh) return res.status(304).end();
    res.set('Content-Length', String(body.length));
    return res.end(body);
  });

  app.get('/index.html', (req, res, next) => {
    if (ctx.settings().landing === 'classic') return next();
    const query = req.url.indexOf('?');
    res.redirect(301, `/${query === -1 ? '' : req.url.slice(query)}`);
  });

  // the folder itself is nothing: a plain 404, like every miss under the prefix
  app.get([landing.assetBase, landing.assetBase.slice(0, -1)], (req, res) => sendError(res, 404, 'No such file.'));

  const imgDir = path.join(ctx.root, LANDING_DIR, 'img');
  app.get(`${landing.assetBase}:name`, (req, res, next) => {
    const asset = landing.assets.get(req.params.name);
    if (!asset) return sendError(res, 404, 'No such file.');
    const headers = { 'Cache-Control': LANDING_ASSET_CACHE, 'Content-Type': asset.type };
    if (asset.file) {
      // a picture: straight from disk (its name is in the build's table, so it cannot be a path of the visitor's choosing)
      return res.sendFile(path.basename(asset.file), { root: imgDir, cacheControl: false, headers }, (err) => {
        if (!err || res.headersSent) return undefined;
        return err.status === 404 || err.code === 'ENOENT' ? sendError(res, 404, 'No such file.') : next(err);
      });
    }
    res.set(headers);
    if (asset.br) {
      const encoding = chooseEncoding(req.headers['accept-encoding'], { br: true, gzip: true });
      res.vary('Accept-Encoding');
      if (encoding !== 'identity') res.set('Content-Encoding', encoding);
      res.locals.skipCompression = true;
      const body = encoding === 'br' ? asset.br : encoding === 'gzip' ? asset.gz : asset.body;
      res.set('Content-Length', String(body.length));
      return res.end(body);
    }
    res.locals.skipCompression = true; // fonts: already compressed
    res.set('Content-Length', String(asset.body.length));
    return res.end(asset.body);
  });
  return landing;
}
