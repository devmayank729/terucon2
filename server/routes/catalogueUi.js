/**
 * The browser code of the catalogue's client-facing and admin pages (targets C3, C4, C5, C7, D1): the finder page
 * (camera / point-to-find / colour-match / text search) and the admin catalogue screen. The inspiration import's
 * "find similar materials" hook and the shop's link to the Finder need no script of their own (site/inspiration/
 * handoff.js and a plain patch-inserted link, respectively). Plain static files, served the same way
 * server/routes/inspiration.js serves site/inspiration/: a fixed list of names, nothing else in the folder.
 *
 *   GET /catalogue-ui/assets/:name
 *
 * The actual API these files call (status/warm/search/search-text, and the admin API) is server/catalogue/, mounted
 * by server/routes/catalogue.js; this route only serves the code, never a secret or a signed URL.
 */
import path from 'node:path';

/** The browser files, by the name they are served under. Nothing else in the folder is ever served. */
export const ASSETS = ['client.js', 'finder.js', 'admin.js', 'catalogue-ui.css'];

export function mountCatalogueUi(app, ctx) {
  const assetRoot = path.join(ctx.root, 'site', 'catalogue-ui');
  app.get('/catalogue-ui/assets/:name', (req, res, next) => {
    if (!ASSETS.includes(req.params.name)) return next();
    res.sendFile(req.params.name, { root: assetRoot, dotfiles: 'deny', cacheControl: false, headers: { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } }, (err) => {
      if (err && !res.headersSent) next(err.status === 404 ? undefined : err);
    });
  });
}
