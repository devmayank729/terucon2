/**
 * The sign-in API (everything under /api/auth/, except the admin's, which is server/routes/authAdmin.js).
 *
 *   GET  /api/auth/config            what the sign-in page may offer (which ways in are open, the Google client id)
 *   GET  /api/auth/me                who is signed in
 *   POST /api/auth/start             {identifier}  send a code to an e-mail address or mobile number (same answer for members and strangers)
 *   POST /api/auth/verify            {challengeId, code, next?}  check the code: signs in (and makes the account the first time)
 *   POST /api/auth/google/nonce      a one-use value for Google's token, tied to this browser by a cookie
 *   POST /api/auth/google            {credential, next?}  sign in with a Google ID token (One Tap)
 *   POST /api/auth/profile           {name, firm, individual, email?, phone?}  the sign-up form / profile page
 *   POST /api/auth/firm-hint         {email?}  a firm name to suggest
 *   POST /api/auth/contact/start     {kind, value}  send a code to a new e-mail address / number to add or change it
 *   POST /api/auth/contact/confirm   {challengeId, code}
 *   POST /api/auth/logout            end this browser's session
 *   POST /api/auth/logout-all        end every session of the account
 *   POST /api/auth/delete/start      send a code to confirm deleting the account
 *   POST /api/auth/delete/confirm    {challengeId, code, confirm: true}  delete the account and everything saved under it
 *
 * Every one of them: JSON only, no caching, same-site only (the guards plus a Sec-Fetch-Site check), counted against a per-address
 * ceiling, and answering with the project's error shape plus a `reason` the page can act on.
 */
import express from 'express';
import { cookieValues, StoreUnavailableError } from '../auth/index.js';
import { sha256, randomToken } from '../auth/crypto.js';
import { classifyIdentifier, maskEmail, maskPhone, normalizeEmail } from '../auth/identifiers.js';
import { errorBody } from '../lib/errors.js';

const NONCE_COOKIE = 'terucon_gn';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const json = express.json({ limit: '8kb', strict: true });

function refuse(res, status, reason, message, extra = {}) {
  const body = errorBody(status, message);
  body.error.reason = reason;
  Object.assign(body.error, extra);
  if (extra.retryAfter) res.set('Retry-After', String(extra.retryAfter));
  res.status(status).set('Cache-Control', 'no-store').json(body);
}

/** The fields of a JSON body that are text, by name. Anything else (nested objects, arrays, numbers) is ignored, never trusted. */
function fields(req, names) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const out = {};
  for (const name of names) if (Object.hasOwn(body, name)) out[name] = body[name];
  return out;
}
const text = (value, max = 500) => (typeof value === 'string' && value.length <= max ? value : '');

export function mountAuthRoutes(app, ctx) {
  const { api, log } = ctx;
  const auth = ctx.auth;
  if (!auth) return;

  /** Wrap a handler: a down database is a 503, never a 500 or an open door; the per-address ceiling and same-site check come first. */
  const route = (handler, { session = false, write = true } = {}) => async (req, res, next) => {
    try {
      const site = req.headers['sec-fetch-site'];
      if (write && site && site !== 'same-origin' && site !== 'none') return refuse(res, 403, 'cross-site', 'Cross-site requests are not allowed.');
      const cfg = await auth.settings.get();
      const ceiling = auth.limits.ip('auth-api', req.ip, cfg.limits.apiPerIpPerMinute, 'minute');
      if (!ceiling.ok) return refuse(res, 429, 'rate-limited', 'Too many requests. Please slow down a little.', { retryAfter: ceiling.retryAfter });
      let current = null;
      if (session) {
        current = await auth.resolve(req);
        if (!current) return refuse(res, 401, 'auth-required', 'Please sign in first.');
      }
      return await handler(req, res, cfg, current);
    } catch (error) {
      if (error instanceof StoreUnavailableError) return refuse(res, 503, 'unavailable', 'Sign-in is not available right now. Please try again in a minute.');
      return next(error);
    }
  };

  const notReady = (res) => {
    const st = auth.status();
    return refuse(res, 503, 'not-ready', st.ready ? 'Sign-in is not available right now.' : 'Sign-in is not set up on this site yet.');
  };

  // ---------------------------------------------------------------------------------------------------- read
  api.get('/api/auth/config', route(async (req, res) => res.json(await auth.publicConfig()), { write: false }));

  api.get(
    '/api/auth/me',
    route(async (req, res) => {
      const current = await auth.resolve(req);
      if (!current) return res.json({ authenticated: false });
      return res.json({ authenticated: true, user: auth.publicView(current.user, await auth.rules()) });
    }, { write: false }),
  );

  // -------------------------------------------------------------------------------------------- e-mail / phone code
  api.post(
    '/api/auth/start',
    json,
    route(async (req, res) => {
      const otp = auth.otp();
      if (!otp || !auth.status().ready) return notReady(res);
      const { identifier } = fields(req, ['identifier']);
      const id = classifyIdentifier(text(identifier, 320));
      if (id.error) {
        const message = id.error === 'invalid-phone' ? 'Please enter a 10-digit mobile number, or an e-mail address.' : id.error === 'invalid-email' ? 'Please enter a valid e-mail address.' : 'Please enter your e-mail address or mobile number.';
        return refuse(res, 400, 'invalid-identifier', message);
      }
      const result = await otp.start({ identifier: id, purpose: 'login', ip: req.ip });
      if (!result.ok) return refuse(res, result.status, result.reason, result.message, result.retryAfter ? { retryAfter: result.retryAfter } : {});
      const { ok, ...rest } = result;
      return res.json({ ok, ...rest });
    }),
  );

  /** What to say after someone is in. The redirect is always a route of this site (never what the browser sent). */
  const welcome = async (res, user, created, next) => res.json({ ok: true, created, needsProfile: !user.profileComplete, redirectTo: auth.safeNext(next), user: auth.publicView(user, await auth.rules()) });

  api.post(
    '/api/auth/verify',
    json,
    route(async (req, res, cfg) => {
      const otp = auth.otp();
      if (!otp || !auth.status().ready) return notReady(res);
      const { challengeId, code, next } = fields(req, ['challengeId', 'code', 'next']);
      const checked = await otp.verify({ challengeId: text(challengeId, 64), code: text(code, 16), purpose: 'login', ip: req.ip });
      if (!checked.ok) return refuse(res, checked.status, checked.reason, checked.message, { ...(checked.retryAfter && { retryAfter: checked.retryAfter }), ...(checked.attemptsLeft !== undefined && { attemptsLeft: checked.attemptsLeft }) });

      const { idKind, idKey } = checked.challenge;
      const existing = await auth.users.findByVerified(idKind, idKey);
      if (!existing) {
        if (!cfg.signup.open) return refuse(res, 403, 'signup-closed', 'New accounts are not being opened right now.');
        const slot = auth.limits.ip('signup', req.ip, cfg.limits.signupsPerIpPerDay, 'day');
        if (!slot.ok) {
          await auth.events.record('signup.blocked', { ip: req.ip, detail: 'too many new accounts from one address' });
          return refuse(res, 429, 'rate-limited', 'Too many accounts were created from your network today. Please try again tomorrow.', { retryAfter: slot.retryAfter });
        }
      }
      const { user, created } = await auth.users.signInOrCreate(idKind, idKey, { signupOpen: cfg.signup.open });
      if (!user) return refuse(res, 403, 'signup-closed', 'New accounts are not being opened right now.');
      await auth.startSession(req, res, user);
      await auth.events.record(created ? 'signup.ok' : 'signin.ok', { userId: user._id, ip: req.ip, detail: `code by ${idKind}` });
      return welcome(res, user, created, next);
    }),
  );

  // ------------------------------------------------------------------------------------------------------- Google
  api.post(
    '/api/auth/google/nonce',
    json,
    route(async (req, res, cfg) => {
      if (!auth.google()) return refuse(res, 503, 'channel-unavailable-google', 'Google sign-in is not available right now.');
      const slot = auth.limits.ip('google', req.ip, cfg.limits.googlePerIpPerHour * 3, 'hour');
      if (!slot.ok) return refuse(res, 429, 'rate-limited', 'Too many attempts. Please try again later.', { retryAfter: slot.retryAfter });
      const secret = randomToken(24);
      const { secure } = auth.cookieSpec(req);
      res.cookie(NONCE_COOKIE, secret, { httpOnly: true, sameSite: 'strict', secure, path: '/api/auth', maxAge: 10 * 60 * 1000 });
      return res.json({ nonce: sha256(secret) });
    }),
  );

  api.post(
    '/api/auth/google',
    json,
    route(async (req, res, cfg) => {
      const verifier = auth.google();
      if (!verifier || !cfg.channels.google || !auth.status().ready) return refuse(res, 503, 'channel-unavailable-google', 'Google sign-in is not available right now.');
      const slot = auth.limits.ip('google', req.ip, cfg.limits.googlePerIpPerHour, 'hour');
      if (!slot.ok) return refuse(res, 429, 'rate-limited', 'Too many attempts. Please try again later.', { retryAfter: slot.retryAfter });
      const { credential, next } = fields(req, ['credential', 'next']);
      // the nonce secret is single use: gone from the browser whatever happens next
      const planted = cookieValues(req.headers.cookie, NONCE_COOKIE);
      res.clearCookie(NONCE_COOKIE, { httpOnly: true, sameSite: 'strict', secure: auth.cookieSpec(req).secure, path: '/api/auth' });
      if (planted.length !== 1) return refuse(res, 400, 'wrong-nonce', 'That Google sign-in did not start here. Please try again.');
      const verified = await verifier.verify(text(credential, 4096), { nonce: sha256(planted[0]) });
      if (!verified.ok) {
        await auth.events.record('google.rejected', { ip: req.ip, detail: verified.reason });
        return refuse(res, 401, `google-${verified.reason}`, verified.message);
      }
      const { profile } = verified;
      const known = (await auth.users.findByGoogleSub(profile.sub)) ?? (await auth.users.findByVerified('email', profile.email));
      if (!known) {
        if (!cfg.signup.open) return refuse(res, 403, 'signup-closed', 'New accounts are not being opened right now.');
        const newSlot = auth.limits.ip('signup', req.ip, cfg.limits.signupsPerIpPerDay, 'day');
        if (!newSlot.ok) return refuse(res, 429, 'rate-limited', 'Too many accounts were created from your network today. Please try again tomorrow.', { retryAfter: newSlot.retryAfter });
      }
      const result = await auth.users.signInOrCreateGoogle(profile, { signupOpen: cfg.signup.open });
      if (result.conflict) return refuse(res, 409, 'google-conflict', 'That e-mail address is already linked to a different Google account. Please sign in with an e-mail code instead.');
      if (!result.user) return refuse(res, 403, 'signup-closed', 'New accounts are not being opened right now.');
      await auth.startSession(req, res, result.user);
      await auth.events.record(result.created ? 'signup.ok' : 'signin.ok', { userId: result.user._id, ip: req.ip, detail: 'google' });
      return welcome(res, result.user, result.created, next);
    }),
  );

  // ------------------------------------------------------------------------------------------------------- profile
  api.post(
    '/api/auth/profile',
    json,
    route(async (req, res, cfg, current) => {
      const slot = await auth.limits.consume('profile', current.user._id, cfg.limits.profileChangesPerUserPerHour, HOUR);
      if (!slot.ok) return refuse(res, 429, 'rate-limited', 'You have changed your details a lot in the last hour. Please try again later.', { retryAfter: slot.retryAfter });
      const input = fields(req, ['name', 'firm', 'individual', 'email', 'phone']);
      const clean = {};
      for (const key of ['name', 'firm']) if (key in input) clean[key] = text(input[key], 200);
      if ('email' in input) clean.email = text(input.email, 320);
      if ('phone' in input) clean.phone = text(input.phone, 60);
      if ('individual' in input) clean.individual = input.individual === true;
      const rules = await auth.rules();
      const saved = await auth.users.saveProfile(current.user, clean, rules);
      if (!saved.ok) return refuse(res, 400, 'invalid-profile', saved.message, saved.field ? { field: saved.field } : {});
      auth.forgetUser(current.user._id);
      if (saved.user.profileComplete) await auth.crm.enqueue(saved.user._id);
      await auth.events.record(saved.becameComplete ? 'profile.completed' : 'profile.saved', { userId: saved.user._id, ip: req.ip });
      return res.json({ ok: true, user: auth.publicView(saved.user, rules) });
    }, { session: true }),
  );

  api.post(
    '/api/auth/firm-hint',
    json,
    route(async (req, res, cfg, current) => {
      const ipSlot = auth.limits.ip('firm-hint', req.ip, cfg.limits.firmLookupsPerIpPerHour, 'hour');
      if (!ipSlot.ok) return refuse(res, 429, 'rate-limited', 'Too many look-ups. Please try again later.', { retryAfter: ipSlot.retryAfter });
      const userSlot = await auth.limits.consume('firm-hint', current.user._id, 12, DAY);
      if (!userSlot.ok) return refuse(res, 429, 'rate-limited', 'Too many look-ups today.', { retryAfter: userSlot.retryAfter });
      const { email } = fields(req, ['email']);
      const typed = email ? normalizeEmail(text(email, 320)) : null;
      const domain = typed?.domain ?? auth.users.firmHint(current.user, cfg.email.blockedDomains).domain;
      if (!domain) return res.json({ name: null, source: null, domain: null });
      const found = await auth.firm.suggest(domain, cfg.firm.lookup, cfg.email.blockedDomains);
      return res.json({ ...found, domain: found.name ? domain : null });
    }, { session: true }),
  );

  // -------------------------------------------------------------------------- adding / changing a contact detail
  api.post(
    '/api/auth/contact/start',
    json,
    route(async (req, res, cfg, current) => {
      const otp = auth.otp();
      if (!otp || !auth.status().ready) return notReady(res);
      const { kind, value } = fields(req, ['kind', 'value']);
      const id = classifyIdentifier(text(value, 320));
      if (id.error || id.kind !== (kind === 'email' ? 'email' : 'phone')) return refuse(res, 400, 'invalid-identifier', kind === 'email' ? 'Please enter a valid e-mail address.' : 'Please enter a 10-digit mobile number.');
      const result = await otp.start({ identifier: id, purpose: 'verify-contact', ip: req.ip, userId: current.user._id });
      if (!result.ok) return refuse(res, result.status, result.reason, result.message, result.retryAfter ? { retryAfter: result.retryAfter } : {});
      const { ok, ...rest } = result;
      return res.json({ ok, ...rest });
    }, { session: true }),
  );

  api.post(
    '/api/auth/contact/confirm',
    json,
    route(async (req, res, cfg, current) => {
      const { challengeId, code } = fields(req, ['challengeId', 'code']);
      const checked = await auth.otp().verify({ challengeId: text(challengeId, 64), code: text(code, 16), purpose: 'verify-contact', ip: req.ip, userId: current.user._id });
      if (!checked.ok) return refuse(res, checked.status, checked.reason, checked.message, { ...(checked.retryAfter && { retryAfter: checked.retryAfter }), ...(checked.attemptsLeft !== undefined && { attemptsLeft: checked.attemptsLeft }) });
      const done = await auth.users.attachVerified(current.user._id, checked.challenge.idKind, checked.challenge.idKey);
      if (!done.ok) {
        if (done.reason === 'taken') return refuse(res, 409, 'contact-taken', `That ${checked.challenge.idKind === 'email' ? 'e-mail address' : 'mobile number'} already belongs to another account. Sign in with it instead.`);
        return refuse(res, 404, 'missing', 'Your account could not be found.');
      }
      auth.forgetUser(current.user._id);
      const rules = await auth.rules();
      const refreshed = (await auth.users.setComplete(current.user._id, rules))?.user ?? done.user;
      if (refreshed.profileComplete) await auth.crm.enqueue(refreshed._id);
      await auth.events.record('contact.verified', { userId: refreshed._id, ip: req.ip, detail: checked.challenge.idKind });
      return res.json({ ok: true, user: auth.publicView(refreshed, rules) });
    }, { session: true }),
  );

  // --------------------------------------------------------------------------------------------- logout, delete
  api.post(
    '/api/auth/logout',
    json,
    route(async (req, res) => {
      const current = await auth.resolve(req).catch(() => null);
      await auth.endSession(req, res);
      if (current) await auth.events.record('signout', { userId: current.user._id, ip: req.ip });
      return res.json({ ok: true });
    }),
  );

  api.post(
    '/api/auth/logout-all',
    json,
    route(async (req, res, cfg, current) => {
      await auth.endSession(req, res, { everywhere: true, userId: current.user._id });
      await auth.events.record('signout.everywhere', { userId: current.user._id, ip: req.ip });
      return res.json({ ok: true });
    }, { session: true }),
  );

  api.post(
    '/api/auth/delete/start',
    json,
    route(async (req, res, cfg, current) => {
      const otp = auth.otp();
      if (!otp || !auth.status().ready) return notReady(res);
      const slot = await auth.limits.consume('delete-request', current.user._id, cfg.limits.deleteRequestsPerUserPerDay, DAY);
      if (!slot.ok) return refuse(res, 429, 'rate-limited', 'Too many delete requests today. Please try again tomorrow.', { retryAfter: slot.retryAfter });
      // the code goes to a contact detail that was verified, preferring e-mail: never to something that was only typed in
      const user = current.user;
      const raw = user.emailKey ?? user.phoneKey;
      const id = raw ? classifyIdentifier(raw) : { error: 'none' };
      if (id.error) return refuse(res, 409, 'no-verified-contact', 'Verify an e-mail address or a mobile number first, then try again.');
      const result = await otp.start({ identifier: id, purpose: 'delete', ip: req.ip, userId: user._id });
      if (!result.ok) {
        await auth.limits.refund(slot.id);
        return refuse(res, result.status, result.reason, result.message, result.retryAfter ? { retryAfter: result.retryAfter } : {});
      }
      const { ok, ...rest } = result;
      return res.json({ ok, ...rest, to: id.kind === 'email' ? maskEmail(id.key) : maskPhone(id.key) });
    }, { session: true }),
  );

  api.post(
    '/api/auth/delete/confirm',
    json,
    route(async (req, res, cfg, current) => {
      const { challengeId, code, confirm } = fields(req, ['challengeId', 'code', 'confirm']);
      if (confirm !== true) return refuse(res, 400, 'not-confirmed', 'Please confirm that you want to delete your account.');
      const checked = await auth.otp().verify({ challengeId: text(challengeId, 64), code: text(code, 16), purpose: 'delete', ip: req.ip, userId: current.user._id });
      if (!checked.ok) return refuse(res, checked.status, checked.reason, checked.message, { ...(checked.retryAfter && { retryAfter: checked.retryAfter }), ...(checked.attemptsLeft !== undefined && { attemptsLeft: checked.attemptsLeft }) });
      const user = current.user;
      // 1. the Design Studio rooms and photos saved under this account. If this fails the account stays, so the person can try again.
      try {
        const rooms = ctx.swatchroom?.roomStore();
        if (rooms?.ready()) await rooms.deleteAllOf(user.ownerId);
      } catch (error) {
        log.error(`auth  could not delete the studio rooms of a deleted account: ${String(error.message).slice(0, 160)}`);
        return refuse(res, 500, 'delete-failed', 'We could not delete your saved rooms just now, so your account was kept. Please try again in a minute.');
      }
      // 2. what is waiting to go to the CRM (and, if the admin chose, the CRM record itself)
      await auth.crm.forget(user);
      // 3. the account, its sessions and its codes
      await auth.sessions.revokeAll(user._id);
      const challenges = await auth.db.col('challenges');
      await challenges.deleteMany({ userId: user._id });
      for (const key of [user.emailKey, user.phoneKey, user.emailClaim, user.phoneClaim].filter(Boolean)) await challenges.deleteMany({ idKey: key });
      await auth.users.remove(user._id);
      auth.forgetUser(user._id);
      await auth.endSession(req, res);
      await auth.events.record('account.deleted', { userId: user._id, ip: req.ip });
      return res.json({ ok: true });
    }, { session: true }),
  );
}
