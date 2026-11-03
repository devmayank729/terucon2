/**
 * The sign-in's admin API: what the admin panel (not built yet) will call to manage rate limits and the rest of the sign-in
 * settings, read the security log and look after the CRM queue. It is a plain JSON API so the panel, a script or an MCP
 * server can all use it.
 *
 *   GET  /api/auth/admin/settings      every setting with its value, default, bounds and a label (enough to draw a form)
 *   PUT  /api/auth/admin/settings      {settings: {"limits.otpStartPerIpPerHour": 20, "crm.module": null}}  null puts one back to its default
 *   GET  /api/auth/admin/events        ?limit=100&before=<ms>  the security log, newest first
 *   GET  /api/auth/admin/status        is sign-in ready, what is missing, counts, the CRM queue
 *   GET  /api/auth/admin/enquiries     ?limit=50&before=<ms>  the "Start a project" enquiries, newest first (server/lib/enquiry.js)
 *   POST /api/auth/admin/unlock        {identifier}  lift the lock on an e-mail address or number
 *   POST /api/auth/admin/crm/flush     deliver what is waiting to Zoho now
 *   POST /api/auth/admin/crm/retry     put failed CRM jobs back in the queue
 *   POST /api/auth/admin/crm/backfill  queue finished accounts that were never sent
 *
 * Who may: whoever sends  Authorization: Bearer <AUTH_ADMIN_TOKEN>  (32 or more characters, from .env, never stored in the
 * database, so a stolen database or a stolen admin session cannot read or reuse it). With no token set the whole API answers
 * 404, as if it were not there. Wrong tokens are counted per address and, after twenty an hour, refused outright.
 */
import express from 'express';
import { StoreUnavailableError } from '../auth/index.js';
import { classifyIdentifier } from '../auth/identifiers.js';
import { SettingsConflictError, SettingsInvalidError } from '../auth/settings.js';
import { errorBody, sendError } from '../lib/errors.js';

const json = express.json({ limit: '32kb', strict: true });

function refuse(res, status, reason, message, extra = {}) {
  const body = errorBody(status, message);
  body.error.reason = reason;
  Object.assign(body.error, extra);
  res.status(status).set('Cache-Control', 'no-store').json(body);
}

export function mountAuthAdmin(app, ctx) {
  const { api } = ctx;
  const auth = ctx.auth;
  if (!auth) return;

  const admin = (handler) => async (req, res, next) => {
    try {
      const access = auth.adminAccess(req);
      if (!access.enabled) return sendError(res, 404, 'No such API route.');
      if (access.tooMany) {
        res.set('Retry-After', String(access.retryAfter));
        return refuse(res, 429, 'rate-limited', 'Too many wrong tokens from this address.', { retryAfter: access.retryAfter });
      }
      if (!access.ok) {
        await auth.events.record('admin.denied', { ip: req.ip, detail: `${req.method} ${req.path}` });
        res.set('WWW-Authenticate', 'Bearer realm="terucon-auth-admin"');
        return refuse(res, 401, 'unauthorized', 'A valid admin token is needed.');
      }
      return await handler(req, res);
    } catch (error) {
      if (error instanceof SettingsInvalidError) return refuse(res, 400, 'invalid-settings', error.message, { problems: error.errors });
      if (error instanceof SettingsConflictError) return refuse(res, 409, 'conflict', error.message);
      if (error instanceof StoreUnavailableError) return refuse(res, 503, 'unavailable', 'The account database is not connected.');
      return next(error);
    }
  };

  api.get('/api/auth/admin/settings', admin(async (req, res) => res.json(await auth.settings.describe())));

  api.put(
    '/api/auth/admin/settings',
    json,
    admin(async (req, res) => {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const patch = body.settings;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return refuse(res, 400, 'invalid-settings', 'Send {"settings": {"name": value}}.');
      const saved = await auth.settings.update(patch);
      await auth.events.record('settings.changed', { ip: req.ip, detail: Object.keys(patch).slice(0, 20).join(', ') });
      return res.json(saved);
    }),
  );

  api.get(
    '/api/auth/admin/events',
    admin(async (req, res) => {
      const before = Number(req.query.before);
      res.json({ events: await auth.events.recent({ limit: Number(req.query.limit) || 100, before: Number.isFinite(before) && before > 0 ? before : undefined }) });
    }),
  );

  api.get(
    '/api/auth/admin/status',
    admin(async (req, res) => {
      const users = await auth.db.col('users');
      const sessions = await auth.db.col('sessions');
      res.json({
        ...auth.status(),
        accounts: { total: await users.countDocuments({}), unfinished: await users.countDocuments({ profileComplete: false }) },
        sessions: await sessions.countDocuments({}),
        crmQueue: await auth.crm.stats(),
      });
    }),
  );

  api.get(
    '/api/auth/admin/enquiries',
    admin(async (req, res) => {
      if (!ctx.enquiries) return refuse(res, 503, 'unavailable', 'Enquiries are not available.');
      const before = Number(req.query.before);
      res.json({ enquiries: await ctx.enquiries.recent({ limit: Number(req.query.limit) || 50, before: Number.isFinite(before) && before > 0 ? before : undefined }) });
    }),
  );

  api.post(
    '/api/auth/admin/unlock',
    json,
    admin(async (req, res) => {
      const id = classifyIdentifier(typeof req.body?.identifier === 'string' ? req.body.identifier.slice(0, 320) : '');
      if (id.error) return refuse(res, 400, 'invalid-identifier', 'Send {"identifier": "an e-mail address or a mobile number"}.');
      await auth.limits.clear('otp-fail', id.rateKey);
      await auth.limits.clear('otp-send', id.rateKey);
      for (const purpose of ['login', 'verify-contact', 'delete']) await auth.limits.clear('otp-cool', `${purpose}|${id.rateKey}`);
      await auth.events.record('admin.unlocked', { ip: req.ip, detail: id.kind });
      res.json({ ok: true });
    }),
  );

  api.post('/api/auth/admin/crm/flush', json, admin(async (req, res) => res.json({ ...(await auth.crm.tick({ max: 50 })), queue: await auth.crm.stats() })));
  api.post('/api/auth/admin/crm/retry', json, admin(async (req, res) => res.json({ requeued: await auth.crm.retryFailed() })));
  api.post('/api/auth/admin/crm/backfill', json, admin(async (req, res) => res.json({ queued: await auth.crm.backfill() })));
}
