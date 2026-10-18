/** The JSON API: health, config, the site map, and the Google (Vertex / Gemini) proxy. */
import express from 'express';
import { sendError } from '../lib/errors.js';
import { generateContent } from '../lib/vertex.js';
import { publicSettings } from '../config/settings.js';

const BODY_LIMIT = '80mb';

/**
 * Registers API routes and remembers their methods, so that a known path with the wrong method answers
 * 405 (with Allow) and an unknown one 404, both as JSON. Every /api response is marked no-store.
 */
export function createApiRegistry(app) {
  const methods = new Map();
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
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
      app.use('/api', (req, res) => {
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

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function mountApi(app, ctx) {
  const { api, log } = ctx;

  api.get('/api/health', async (req, res) => {
    const s = ctx.settings();
    const model = await ctx.model.status();
    res.json({ ok: true, version: ctx.version, google: s.google.configured, mode: s.google.mode, model: { mode: model.mode, status: model.status } });
  });

  api.get('/api/config', async (req, res) => {
    const model = await ctx.model.status();
    res.json(publicSettings(ctx.settings(), model.status === 'ready' ? model.health?.sam : undefined, model));
  });

  api.get('/api/site', (req, res) => res.json(ctx.site.publicView()));

  api.post('/api/vertex/generate', express.json({ limit: BODY_LIMIT }), async (req, res) => {
    const s = ctx.settings();
    const payload = req.body;
    const location = payload?.location;
    if (!isObject(payload) || !isObject(payload.body) || typeof payload.model !== 'string' || (location != null && typeof location !== 'string')) {
      return sendError(res, 400, 'Expected JSON {model, location?, body}.');
    }
    const started = performance.now();
    const { status, data, info } = await generateContent(s, ctx.auth(), payload.model, payload.body, location, ctx.vertexOptions);
    const took = ((performance.now() - started) / 1000).toFixed(1);
    const model = payload.model.padEnd(28);
    if (status === 200) {
      log.info(`google  ${model} ok    ${took}s${info.attempts > 1 ? ` (${info.attempts} attempts)` : ''}`);
    } else {
      const message = isObject(data) && isObject(data.error) ? String(data.error.message ?? '').slice(0, 160) : '';
      log.warn(`google  ${model} ${status}  ${took}s  ${message}`);
    }
    res.set('X-Terucon-Attempts', String(info.attempts ?? 1)).status(status).json(data);
  });
}
