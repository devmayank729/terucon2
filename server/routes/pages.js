/**
 * The pages of site/site.json. Each route serves its file; aliases (the file-name URLs) redirect to the
 * route with 301, and the old design-time names with 302. Everything is looked up by the decoded request
 * path in a Map, so names with spaces ("/Terucon Swatchroom.html") work and nothing is a path pattern.
 * Only files named in site.json are ever read: there is no static folder.
 */
import { sendError } from '../lib/errors.js';

/**
 * Middleware that answers the paths in `table` (see SiteMap#table) and passes everything else on.
 * @param {string} root project folder, the base for the files in the table
 * @param {Map<string, object>} table
 * @param {string} buildHint what to run when a file has not been generated yet
 */
export function htmlHandler(root, table, buildHint) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let name;
    try {
      name = decodeURIComponent(req.path);
    } catch {
      return next(); // malformed escapes name nothing we serve
    }
    const action = table.get(name);
    if (!action) return next();
    if (action.redirect) {
      const query = req.url.indexOf('?');
      return res.redirect(action.status, encodeURI(action.redirect) + (query === -1 ? '' : req.url.slice(query)));
    }
    const options = { root, cacheControl: false, headers: { ...action.headers, 'Cache-Control': 'no-cache' } };
    res.sendFile(action.file, options, (err) => {
      if (!err || res.headersSent) return;
      if (err.status === 404 || err.code === 'ENOENT') return sendError(res, 404, `${action.file} has not been generated yet. Run: ${buildHint}`);
      next(err);
    });
  };
}

export function mountPages(app, ctx) {
  app.use(htmlHandler(ctx.root, ctx.site.table('pages'), 'npm run build:site'));
  app.get('/favicon.ico', (req, res) => res.status(204).end());
}
