/**
 * The pages of site/site.json. Each route serves its file; aliases (the file-name URLs) redirect to the
 * route with 301, and the old design-time names with 302. Everything is looked up by the decoded request
 * path in a Map, so names with spaces ("/Terucon Swatchroom.html") work and nothing is a path pattern.
 * Only files named in site.json are ever read: there is no static folder.
 *
 * A name that differs only by capitals or a trailing slash ("/Materials", "/materials/") redirects to the page, and an
 * address that is no page at all gets the Coming soon page (comingSoon below), so nobody meets a bare "Not found".
 */
import { sendError } from '../lib/errors.js';

/**
 * Middleware that answers the paths in `table` (see SiteMap#table) and passes everything else on.
 * @param {string} root project folder, the base for the files in the table
 * @param {Map<string, object>} table
 * @param {string} buildHint what to run when a file has not been generated yet
 */
export function htmlHandler(root, table, buildHint) {
  // lower-cased name -> the one real name it stands for (null when two names differ only by capitals)
  const lowered = new Map();
  for (const key of table.keys()) lowered.set(key.toLowerCase(), lowered.has(key.toLowerCase()) ? null : key);
  /** The real name for a request path that is not in the table, or null. */
  const nearest = (name) => {
    const bare = name.length > 1 ? name.replace(/\/+$/, '') : name;
    return table.has(bare) ? bare : (lowered.get(bare.toLowerCase()) ?? null);
  };
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let name;
    try {
      name = decodeURIComponent(req.path);
    } catch {
      return next(); // malformed escapes name nothing we serve
    }
    const query = req.url.indexOf('?');
    const search = query === -1 ? '' : req.url.slice(query);
    const action = table.get(name);
    if (!action) {
      const real = nearest(name);
      if (real === null || real === name) return next();
      const target = table.get(real);
      return res.redirect(301, encodeURI(target.redirect ?? real) + search);
    }
    if (action.redirect) {
      return res.redirect(action.status, encodeURI(action.redirect) + search);
    }
    const options = { root, cacheControl: false, headers: { ...action.headers, 'Cache-Control': 'no-cache' } };
    res.sendFile(action.file, options, (err) => {
      if (!err || res.headersSent) return;
      if (err.status === 404 || err.code === 'ENOENT') return sendError(res, 404, `${action.file} has not been generated yet. Run: ${buildHint}`);
      next(err);
    });
  };
}

/**
 * The Coming soon page (site.json docs.comingSoon) for any address that is a page nobody has built yet: a browser asking for
 * HTML at a path with no file extension. It is answered 404, so search engines do not take it for a page. Files that are
 * missing (a path with an extension), /api and /media, and clients that do not want HTML keep their plain 404.
 */
export function comingSoon(ctx) {
  const entry = ctx.site.docs.comingSoon;
  const mediaPrefix = `${ctx.site.media.route}/`;
  return (req, res, next) => {
    if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    if (req.path === '/api' || req.path.startsWith('/api/') || req.path.startsWith(mediaPrefix)) return next();
    if (req.path.split('/').pop().includes('.') || !req.accepts('html')) return next();
    const options = { root: ctx.root, cacheControl: false, headers: { 'Cache-Control': 'no-cache' } };
    res.status(404).sendFile(entry.file, options, (err) => {
      if (!err || res.headersSent) return;
      next(err.status === 404 || err.code === 'ENOENT' ? undefined : err);
    });
  };
}

export function mountPages(app, ctx) {
  app.use(htmlHandler(ctx.root, ctx.site.table('pages'), 'npm run build:site'));
  app.get('/favicon.ico', (req, res) => res.status(204).end());
}
