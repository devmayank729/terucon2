/**
 * The "Start a project" form (pages/start-project.html, and the landing page's own enquiry form).
 *
 *   POST /api/enquiry   {type, name, company, phone, email, city, area, timeline, message, website?}
 *                       -> 201 {ok: true, reference: "TR-XXXXXX"}   or a JSON error with a `field` to point at
 *
 * Open to everybody (somebody who is only asking has no account), so the protection is in the route: JSON only and same-site (the
 * guards, plus a Sec-Fetch-Site check here), a per-address ceiling (5 an hour, 20 a day), the size caps and the fixed lists of
 * server/lib/enquiry.js, and a hidden field a person never fills in ("website": a bot that does gets the same thank-you and nothing is
 * kept). An enquiry is kept in the account database; if that is down the visitor is told so (never a silent loss).
 *
 * It is NOT sent to Zoho (see server/lib/enquiry.js). The admin reads them with GET /api/auth/admin/enquiries (server/routes/authAdmin.js).
 */
import express from 'express';
import { StoreUnavailableError } from '../auth/index.js';
import { createEnquiryStore, newReference, readEnquiry } from '../lib/enquiry.js';
import { errorBody } from '../lib/errors.js';

const json = express.json({ limit: '16kb', strict: true });
const PER_HOUR = 5;
const PER_DAY = 20;

function refuse(res, status, message, extra = {}) {
  const body = errorBody(status, message);
  Object.assign(body.error, extra);
  if (extra.retryAfter) res.set('Retry-After', String(extra.retryAfter));
  res.status(status).set('Cache-Control', 'no-store').json(body);
}

export function mountEnquiry(app, ctx) {
  const { api, log } = ctx;
  const auth = ctx.auth;
  if (!auth) return;
  ctx.enquiries = createEnquiryStore({ db: auth.db, log });

  api.post('/api/enquiry', json, async (req, res, next) => {
    try {
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return refuse(res, 403, 'Cross-site requests are not allowed.');
      const hour = auth.limits.ip('enquiry-hour', req.ip, PER_HOUR, 'hour');
      if (!hour.ok) return refuse(res, 429, 'You have sent a few enquiries already. Please try again later, or call us.', { retryAfter: hour.retryAfter });
      const day = auth.limits.ip('enquiry-day', req.ip, PER_DAY, 'day');
      if (!day.ok) return refuse(res, 429, 'You have sent a few enquiries already. Please try again tomorrow, or call us.', { retryAfter: day.retryAfter });

      // the hidden field: only a program fills it in. Same answer as a real one, nothing kept.
      if (typeof req.body?.website === 'string' && req.body.website.trim()) return res.status(201).set('Cache-Control', 'no-store').json({ ok: true, reference: newReference() });

      const read = readEnquiry(req.body);
      if (!read.ok) return refuse(res, 400, read.message, { field: read.field });

      let ownerId = null;
      try {
        ownerId = (await auth.resolve(req))?.user?.ownerId ?? null;
      } catch (error) {
        if (!(error instanceof StoreUnavailableError)) throw error; // not being able to tell who it is must not stop the enquiry
      }
      const reference = await ctx.enquiries.add(read.enquiry, { ownerId, source: read.source });
      return res.status(201).set('Cache-Control', 'no-store').json({ ok: true, reference });
    } catch (error) {
      if (error instanceof StoreUnavailableError) return refuse(res, 503, 'We could not save your enquiry just now. Please try again in a minute, or call us.');
      return next(error);
    }
  });
}
