/**
 * "Capture from a phone": the web routes.
 *
 *   The person who asks for photos (signed in; with sign-in off, the studio's per-browser owner id):
 *   GET    /api/capture/config                 what is switched on (WhatsApp sends, a link address a phone can open)
 *   POST   /api/capture/sessions               {service, note?}                       -> {session, reachable}   a new link
 *   GET    /api/capture/sessions/:id           -> {session}
 *   POST   /api/capture/sessions/:id/close     end the link now
 *   DELETE /api/capture/sessions/:id           delete the link and every photo that came through it
 *   PUT    /api/capture/sessions/:id/alert     {phone|null}                           tell me on WhatsApp when a photo arrives
 *   POST   /api/capture/sessions/:id/whatsapp  {phone}                                -> {mode: 'sent'|'link', waLink, to}
 *   GET    /api/capture/inbox?after=<ms>       -> {now, sessions, photos}             the links and the photos that came in
 *   GET    /api/capture/photos/:id/file        the photo itself (?download=1 to save it)
 *   DELETE /api/capture/photos/:id
 *
 *   The person with the link (nothing but the token, in the X-Capture-Token header; never in a URL the server sees):
 *   GET    /api/capture/s/info                 what the link is for
 *   PUT    /api/capture/s/details              {name, phone?, address?, place?, location?}
 *   POST   /api/capture/s/photos               the photo itself (image/jpeg, image/png or image/webp). X-Photo-Id: 32 hex, made by the phone
 *                                              (the same one on a retry); X-Photo-Meta: base64url JSON {tags, note}
 *   POST   /api/capture/s/done                 "I have sent everything"
 *
 *   GET    /capture-ui/assets/:name            the browser code of the phone page (site/capture/), a fixed list of names
 *
 * The page the phone opens is /capture (site/site.json, pages/capture.html). Every answer is no-store.
 */
import express from 'express';
import path from 'node:path';
import { StoreUnavailableError } from '../auth/index.js';
import { drainRequest } from '../catalogue/errors.js';
import { errorBody } from '../lib/errors.js';
import { OWNER_COOKIE } from '../lib/studioShield.js';
import { randomId } from '../auth/crypto.js';
import { CaptureError, PHOTO_ID } from './validate.js';

/** The browser files of the phone page, by the name they are served under. Nothing else in the folder is ever served. */
export const ASSETS = ['capture-page.js', 'camera.js', 'resize.js', 'queue.js', 'capture-page.css'];
const OWNER_ID = /^[a-f0-9]{32}$/;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const TOKEN_HEADER = 'x-capture-token';

const json = express.json({ limit: '8kb', strict: true });
const runMiddleware = (middleware, req, res) => new Promise((resolve, reject) => middleware(req, res, (error) => (error ? reject(error) : resolve())));

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/** Send a CaptureError (or a few well-known errors) as the site's JSON. @returns {boolean} whether it was one of those */
export function sendCaptureError(res, error) {
  let e = error;
  if (error instanceof StoreUnavailableError) e = new CaptureError(503, 'store-down', 'Photos cannot be saved or read right now. Please try again in a minute.');
  else if (error?.type === 'entity.too.large') e = new CaptureError(413, 'too-large', 'That is too large.');
  else if (error?.type && error.status >= 400 && error.status < 500) e = new CaptureError(400, 'bad-request', 'The request was not understood.');
  if (!(e instanceof CaptureError)) return false;
  const body = errorBody(e.status, e.message);
  body.error.reason = e.reason;
  if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
  res.status(e.status).set('Cache-Control', 'no-store').json(body);
  return true;
}

export function mountCaptureRoutes(app, ctx, capture) {
  const { api } = ctx;
  const { service } = capture;
  const cfg = () => capture.config();

  const assetRoot = path.join(ctx.root, 'site', 'capture');
  app.get('/capture-ui/assets/:name', (req, res, next) => {
    if (!ASSETS.includes(req.params.name)) return next();
    res.sendFile(req.params.name, { root: assetRoot, dotfiles: 'deny', cacheControl: false, headers: { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } }, (err) => {
      if (err && !res.headersSent) next(err.status === 404 ? undefined : err);
    });
  });

  /** The page's own address (scheme and host), for a link made on this computer. A Host header is never believed for anything else (service.linkBase). */
  const originOf = (req) => `${req.protocol}://${req.get('host') ?? ''}`;

  /** Who is asking: the signed-in account, or (sign-in off) the browser's owner id. Throws a CaptureError when nobody may. */
  async function who(req, res) {
    if (!cfg().enabled) throw new CaptureError(503, 'capture-off', 'Capture from a phone is switched off on this server.');
    let found = null;
    try {
      found = await ctx.auth.resolve(req);
    } catch (error) {
      if (error instanceof StoreUnavailableError) throw new CaptureError(503, 'auth-unavailable', 'Sign-in is not available right now. Please try again in a minute.');
      throw error;
    }
    if (ctx.auth.required()) {
      if (!found) throw new CaptureError(401, 'unauthorized', 'Please sign in to ask for photos.');
      if (!found.user.profileComplete) throw new CaptureError(403, 'profile-incomplete', 'Please finish your details first.');
    }
    if (found) return { owner: found.user.ownerId, name: found.user.name ?? '' };
    // sign-in is switched off for the whole site: the browser is the owner, as for the studio's rooms (server/lib/studioShield.js)
    let owner = cookieValue(req, OWNER_COOKIE);
    if (!OWNER_ID.test(owner)) {
      owner = randomId();
      res.cookie(OWNER_COOKIE, owner, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 400 * 24 * 3600 * 1000 });
    }
    return { owner, name: '' };
  }

  /** A page of another site may not make us do things. (guards.js already refuses a cross-origin Origin; this covers a browser that sends only Sec-Fetch-Site.) */
  function sameSite(req) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new CaptureError(403, 'cross-site', 'Cross-site requests are not allowed.');
  }

  const handle = (fn, { write = false, parse = null } = {}) => async (req, res, next) => {
    try {
      if (write) sameSite(req);
      if (parse) await runMiddleware(parse, req, res);
      await fn(req, res);
    } catch (error) {
      // a phone that is still sending (a photo too big, a link that ended mid-upload) is let finish first, so it reads why instead of a reset connection
      await drainRequest(req);
      if (!sendCaptureError(res, error)) next(error);
    }
  };

  /** The link's token from its header; the service treats a missing or odd one as an unknown link. */
  const tokenOf = (req) => String(req.headers[TOKEN_HEADER] ?? '');

  // ------------------------------------------------------------------------------------------------ the requester
  api.get('/api/capture/config', handle(async (req, res) => {
    const asker = await who(req, res);
    const wa = capture.whatsapp.state();
    let link = { ok: true, reachable: true };
    try {
      link = { ok: true, reachable: service.linkBase(originOf(req)).reachable };
    } catch {
      link = { ok: false, reachable: false };
    }
    const c = cfg();
    res.json({ enabled: true, signedIn: Boolean(asker.owner), whatsapp: { serverSends: wa.linkMessages && c.limitWhatsapp > 0, alerts: wa.photoAlerts, defaultCountryCode: c.defaultCountryCode }, link, limits: { sessionMinutes: c.sessionMinutes, maxPhotos: c.maxPhotos, keepDays: c.keepDays } });
  }));

  api.post('/api/capture/sessions', handle(async (req, res) => {
    const asker = await who(req, res);
    res.status(201).json(await service.createSession(asker.owner, { service: req.body?.service, note: req.body?.note, requesterName: asker.name }, originOf(req)));
  }, { write: true, parse: json }));

  api.get('/api/capture/sessions/:id', handle(async (req, res) => {
    const asker = await who(req, res);
    res.json(await service.getSession(asker.owner, req.params.id, originOf(req)));
  }));

  api.post('/api/capture/sessions/:id/close', handle(async (req, res) => {
    const asker = await who(req, res);
    res.json(await service.closeSession(asker.owner, req.params.id));
  }, { write: true, parse: json }));

  api.delete('/api/capture/sessions/:id', handle(async (req, res) => {
    const asker = await who(req, res);
    res.json(await service.deleteSession(asker.owner, req.params.id));
  }, { write: true }));

  api.put('/api/capture/sessions/:id/alert', handle(async (req, res) => {
    const asker = await who(req, res);
    res.json(await service.setAlert(asker.owner, req.params.id, req.body?.phone ?? null));
  }, { write: true, parse: json }));

  api.post('/api/capture/sessions/:id/whatsapp', handle(async (req, res) => {
    const asker = await who(req, res);
    res.json(await service.sendLink(asker.owner, req.params.id, { phone: req.body?.phone, requesterName: asker.name }, originOf(req)));
  }, { write: true, parse: json }));

  api.get('/api/capture/inbox', handle(async (req, res) => {
    const asker = await who(req, res);
    const after = Number(req.query.after);
    res.json(await service.inbox(asker.owner, { after: Number.isFinite(after) && after > 0 ? Math.trunc(after) : 0 }, originOf(req)));
  }));

  api.get('/api/capture/photos/:id/file', handle(async (req, res) => {
    const asker = await who(req, res);
    if (!PHOTO_ID.test(req.params.id)) throw new CaptureError(404, 'not-found', 'That photo does not exist.');
    const photo = await service.photoFile(asker.owner, req.params.id);
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[photo.type];
    res.set({
      'Content-Type': photo.type,
      'Content-Length': String(photo.bytes.length),
      // private to this browser, and short: a photo that was deleted is not kept around for long
      'Cache-Control': 'private, max-age=300',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="terucon-photo.${extension}"`,
    });
    res.end(photo.bytes);
  }));

  api.delete('/api/capture/photos/:id', handle(async (req, res) => {
    const asker = await who(req, res);
    res.json(await service.deletePhoto(asker.owner, req.params.id));
  }, { write: true }));

  // ------------------------------------------------------------------------------------------------ the person with the link
  /** The capture routes of the phone page are open to anyone holding a link, but only while the feature is on. */
  const open = (fn, options) =>
    handle(async (req, res) => {
      if (!cfg().enabled) throw new CaptureError(503, 'capture-off', 'Capture from a phone is switched off on this server.');
      await fn(req, res);
    }, options);

  api.get('/api/capture/s/info', open(async (req, res) => {
    res.json(await service.info(tokenOf(req), req.ip));
  }));

  api.put('/api/capture/s/details', open(async (req, res) => {
    res.json(await service.saveCapturer(tokenOf(req), req.body, req.ip));
  }, { parse: json }));

  api.post('/api/capture/s/photos', open(async (req, res) => {
    const c = cfg();
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!PHOTO_TYPES.has(type)) throw new CaptureError(415, 'bad-image', 'Send the photo as image/jpeg, image/png or image/webp.');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > c.maxPhotoBytes) {
      throw new CaptureError(413, 'too-large', `That photo is larger than ${Math.round(c.maxPhotoBytes / 1048576)} MB.`);
    }
    await runMiddleware(express.raw({ type: () => true, limit: c.maxPhotoBytes }), req, res);
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const answer = await service.addPhoto(tokenOf(req), { cid: String(req.headers['x-photo-id'] ?? ''), meta: String(req.headers['x-photo-meta'] ?? ''), bytes }, req.ip);
    res.status(answer.duplicate ? 200 : 201).json(answer);
  }));

  api.post('/api/capture/s/done', open(async (req, res) => {
    res.json(await service.done(tokenOf(req), req.ip));
  }));

}
