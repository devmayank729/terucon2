/** The JSON API: health and the site map. */
import { sendError } from '../lib/errors.js';

/**
 * Registers API routes and remembers their methods, so that a known path with the wrong method answers
 * 405 (with Allow) and an unknown one 404, both as JSON. Every /api response is marked no-store.
 *
 * `leaveTo(path)` names the /api paths that belong to something mounted after these routes (the Design Studio's own API):
 * they get none of this (no no-store, no 404 / 405), so the studio answers exactly as it does on its own. tests/js/
 * server-studio-parity.test.js compares the two.
 */
export function createApiRegistry(app, leaveTo = () => false) {
  const methods = new Map();
  app.use('/api', (req, res, next) => {
    if (!leaveTo(req.baseUrl + req.path)) res.set('Cache-Control', 'no-store');
    next();
  });
  const register = (method, route, handlers) => {
    const allowed = methods.get(route) ?? new Set();
    allowed.add(method);
    if (method === 'GET') allowed.add('HEAD');
    methods.set(route, allowed);
    app[method.toLowerCase()](route, ...handlers);
  };
  return {
    get: (route, ...handlers) => register('GET', route, handlers),
    post: (route, ...handlers) => register('POST', route, handlers),
    /** Mount last among the API routes. */
    fallback() {
      app.use('/api', (req, res, next) => {
        if (leaveTo(req.baseUrl + req.path)) return next();
        const allowed = methods.get(req.baseUrl + req.path);
        if (allowed) {
          res.set('Allow', [...allowed].join(', '));
          return sendError(res, 405, `${req.method} is not allowed here. Use ${[...allowed].filter((m) => m !== 'HEAD').join(' or ')}.`);
        }
        return sendError(res, 404, 'No such API route.');
      });
    },
  };
}

export function mountApi(app, ctx) {
  const { api } = ctx;

  // `studio.database` is whether the studio's MongoDB is connected: the studio opens without it (rooms just can not be
  // saved), so it is shown here but never makes `ok` false.
  api.get('/api/health', (req, res) => {
    const studio = ctx.swatchroom ? { running: true, ...ctx.swatchroom.status() } : { running: false };
    res.json({ ok: true, version: ctx.version, studio });
  });

  api.get('/api/site', (req, res) => res.json(ctx.site.publicView()));
}
