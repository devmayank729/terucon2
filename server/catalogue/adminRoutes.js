/**
 * The catalogue admin API (target D1): what the admin panel (not built yet), a script or an MCP server calls to create a catalogue, upload a
 * PDF or photos, start and watch the processing, edit items and choose the live release. Plain JSON, like the sign-in's admin API, whose
 * pattern this follows (server/routes/authAdmin.js):
 *
 *   GET   /api/catalogue/admin/overview                                   catalogues, the last 20 jobs, what is set up (does not call Modal)
 *   POST  /api/catalogue/admin/check                                      pings Modal's two apps, the database and the signing key (WAKES the apps: billed)
 *   POST  /api/catalogue/admin/catalogues                                 {id, name, kind, note?}
 *   POST  /api/catalogue/admin/uploads                                    {catalogue, kind: "pdf"|"photos", options?, files: [{name, size, type}]}
 *   POST  /api/catalogue/admin/jobs                                       {jobId}  start it
 *   GET   /api/catalogue/admin/jobs                                       ?status=&catalogue=&limit=   newest first
 *   GET   /api/catalogue/admin/jobs/:id
 *   POST  /api/catalogue/admin/jobs/:id/cancel
 *   GET   /api/catalogue/admin/catalogues/:id/items                       ?status=ok|hidden&q=&limit=&after=
 *   PATCH /api/catalogue/admin/catalogues/:id/items/:itemId               {label?, productId?, status?, attributes?}
 *   GET   /api/catalogue/admin/catalogues/:id/releases
 *   POST  /api/catalogue/admin/catalogues/:id/releases/:releaseId/activate
 *
 * Who may: whoever sends  Authorization: Bearer <AUTH_ADMIN_TOKEN>. With no token set every route answers 404, as if it did not exist; wrong
 * tokens are counted per address in the same counter as the sign-in's admin API (twenty an hour, then refused outright).
 */
import express from 'express';
import { StoreUnavailableError } from '../auth/index.js';
import { sendError } from '../lib/errors.js';
import { CatalogueError, sendCatalogueError } from './errors.js';
import { bad } from './validate.js';

const json = express.json({ limit: '8kb', strict: true });
const jsonUploads = express.json({ limit: '128kb', strict: true });

const runMiddleware = (middleware, req, res) => new Promise((resolve, reject) => middleware(req, res, (error) => (error ? reject(error) : resolve())));

/** One query value that must be a single string (Express gives an array for `?a=1&a=2`), or undefined. */
function one(query, name) {
  const value = query?.[name];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw bad(`"${name}" must be given once.`);
  return value;
}

function limitOf(query, fallback, max) {
  const raw = one(query, 'limit');
  if (raw === undefined) return fallback;
  if (!/^\d{1,4}$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw bad(`"limit" must be a whole number from 1 to ${max}.`);
  return Number(raw);
}

export function mountAdminRoutes(app, ctx, catalogue) {
  const { api } = ctx;
  const auth = ctx.auth;
  const a = catalogue.admin;
  if (!auth) return;

  const admin = (handler, { parse = null, write = false } = {}) => async (req, res, next) => {
    try {
      const access = auth.adminAccess(req);
      if (!access.enabled) return sendError(res, 404, 'No such API route.');
      if (access.tooMany) {
        sendCatalogueError(res, new CatalogueError(429, 'rate-limited', 'Too many wrong tokens from this address.', { retryAfter: access.retryAfter }));
        return;
      }
      if (!access.ok) {
        await auth.events.record('admin.denied', { ip: req.ip, detail: `${req.method} ${req.path}` });
        res.set('WWW-Authenticate', 'Bearer realm="terucon-auth-admin"');
        return sendCatalogueError(res, new CatalogueError(401, 'unauthorized', 'A valid admin token is needed.'));
      }
      const site = req.headers['sec-fetch-site'];
      if (write && site && site !== 'same-origin' && site !== 'none') return sendCatalogueError(res, new CatalogueError(403, 'cross-site', 'Cross-site requests are not allowed.'));
      if (parse) await runMiddleware(parse, req, res);
      return await handler(req, res);
    } catch (error) {
      if (error instanceof CatalogueError) return sendCatalogueError(res, error);
      if (error instanceof StoreUnavailableError) return sendCatalogueError(res, new CatalogueError(503, 'not-ready', 'The catalogue database is not connected right now.'));
      if (error?.type && error.status >= 400 && error.status < 500) return sendCatalogueError(res, new CatalogueError(error.status, error.type === 'entity.too.large' ? 'too-large' : 'bad-request', error.type === 'entity.too.large' ? 'That request is too large.' : 'The request body is not valid JSON.'));
      return next(error);
    }
  };

  const P = '/api/catalogue/admin';
  api.get(`${P}/overview`, admin(async (req, res) => res.json(await a.overview())));
  api.post(`${P}/check`, admin(async (req, res) => res.json(await a.check()), { parse: json, write: true }));
  api.post(`${P}/catalogues`, admin(async (req, res) => res.status(201).json(await a.createCatalogue(req.body, req.ip)), { parse: json, write: true }));
  api.post(`${P}/uploads`, admin(async (req, res) => res.status(201).json(await a.createUpload(req.body, req.ip)), { parse: jsonUploads, write: true }));
  api.post(`${P}/jobs`, admin(async (req, res) => res.status(202).json({ ok: true, job: await a.startJob(req.body, req.ip) }), { parse: json, write: true }));
  api.get(`${P}/jobs`, admin(async (req, res) => res.json(await a.listJobs({ status: one(req.query, 'status'), catalogue: one(req.query, 'catalogue'), limit: limitOf(req.query, 20, 100) }))));
  api.get(`${P}/jobs/:id`, admin(async (req, res) => res.json(await a.getJob(req.params.id))));
  api.post(`${P}/jobs/:id/cancel`, admin(async (req, res) => res.json(await a.cancelJob(req.params.id, req.ip)), { parse: json, write: true }));
  api.get(`${P}/catalogues/:id/items`, admin(async (req, res) => res.json(await a.listItems(req.params.id, { status: one(req.query, 'status'), q: one(req.query, 'q'), limit: limitOf(req.query, 50, 100), after: one(req.query, 'after') }))));
  // the API registry has no PATCH; the path has parameters, so the registry's 405 table could not have matched it anyway
  app.patch(`${P}/catalogues/:id/items/:itemId`, admin(async (req, res) => res.json(await a.patchItem(req.params.id, req.params.itemId, req.body, req.ip)), { parse: json, write: true }));
  api.get(`${P}/catalogues/:id/releases`, admin(async (req, res) => res.json(await a.listReleases(req.params.id))));
  api.post(`${P}/catalogues/:id/releases/:releaseId/activate`, admin(async (req, res) => res.json(await a.activateRelease(req.params.id, req.params.releaseId, req.ip)), { parse: json, write: true }));
}
