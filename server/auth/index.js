/**
 * Sign-in for the Terucon website: accounts, e-mail / text-message / Google sign-in, sessions, the gate in front of every page
 * but the landing page, and the queue that sends new sign-ups to Zoho CRM. This file puts the parts together; the parts are in
 * this folder, the web routes in server/routes/auth.js and server/routes/authAdmin.js.
 *
 * Failing closed. If the sign-in cannot work safely it does not work, and says why (in the start-up banner, in /api/health as
 * coarse reason codes, and on the sign-in page in plain words) instead of letting people in or pretending:
 *   - no AUTH_SECRET (outside development)            -> nobody can sign in
 *   - no way to send a code and no Google client id   -> nobody can sign in
 *   - the "console" code senders outside development  -> refused
 *   - the account database not connected              -> nobody can sign in until it is
 * "Development" means the server listens on this computer only and NODE_ENV is not "production".
 */
import { randomToken, safeEqual, sha256 } from './crypto.js';
import { authConfig, isLoopbackHost } from './config.js';
import { createCrmOutbox, createZohoClient } from './crm.js';
import { createAuthDb, StoreUnavailableError } from './db.js';
import { createEvents } from './events.js';
import { createFirmLookup } from './firm.js';
import { createGoogleVerifier } from './google.js';
import { AuthLimits } from './limits.js';
import { createOtp } from './otp.js';
import { createProviders } from './providers/index.js';
import { createSessions } from './sessions.js';
import { AuthSettings } from './settings.js';
import { createUsers, publicView } from './users.js';

export { StoreUnavailableError };

const KEY = Symbol('terucon.auth');
const USER_CACHE_MS = 15 * 1000;
const HOUR = 60 * 60 * 1000;
/** The Design Studio routes that cost money or hold people's photos: they need a signed-in, finished account. */
export const GATED_API = ['/api/ai', '/api/rooms', '/api/vision', '/api/pipeline', '/api/check'];

/** All values of the cookie called `name` in a Cookie header (more than one is a sign of cookie tossing). */
export function cookieValues(header, name) {
  const values = [];
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) values.push(part.slice(i + 1).trim());
  }
  return values;
}

/**
 * @param {object} options
 * @param {() => object} options.settings the website's settings (server/config/settings.js), read on every use so .env edits apply
 * @param {import('mongoose').Mongoose | null} [options.mongoose] the studio's mongoose, for the account database
 * @param {string[]} options.nextRoutes where a person may be sent after signing in (exact routes)
 * @param {{info: Function, warn: Function, error: Function}} options.log
 * @param {() => number} [options.now]
 * @param {object} [options.overrides] tests: db, providers, google, firm, zoho, secret
 */
export function createAuth({ settings: websiteSettings, mongoose = null, nextRoutes, log, now = Date.now, overrides = {} }) {
  const cfgNow = () => authConfig(websiteSettings());
  const first = cfgNow();
  const useMongo = overrides.db ? false : first.store === 'mongo' || (first.store === 'auto' && Boolean(mongoose));
  const db = overrides.db ?? createAuthDb({ mongoose: useMongo ? mongoose : null, now });
  // the Design Studio's rate limits start from what .env says (STUDIO_LIMIT_*); a value the admin saves wins
  const envStudioLimits = () => {
    const l = websiteSettings().studio.limits;
    return { 'studio.limit.ai': l.ai, 'studio.limit.vision': l.vision, 'studio.limit.pipeline': l.pipeline, 'studio.limit.check': l.check, 'studio.limit.rooms': l.rooms, 'studio.limit.addressFactor': l.perAddress };
  };
  const settings = new AuthSettings({ db, now, base: envStudioLimits });
  const limits = new AuthLimits({ db, now });
  const events = createEvents({ db, log, now });
  const sessions = createSessions({ db, settings, now });
  const users = createUsers({ db, now, onChanged: (id) => userCache.delete(id) });
  const developmentSecret = randomToken(32);
  const nextAllowed = new Set(nextRoutes);
  const userCache = new Map(); // account id -> {user, at}: the last read of an account, for a few seconds (declared here: users.js tells it about changes)

  const devAllowed = () => {
    const s = websiteSettings();
    return isLoopbackHost(s.host) && s.nodeEnv !== 'production';
  };
  const secretNow = () => overrides.secret ?? (cfgNow().secret || (devAllowed() ? developmentSecret : ''));

  // ---- things that follow the settings (.env can change while the server runs)
  const memo = new WeakMap();
  const forSettings = (make) => {
    const key = websiteSettings();
    if (!memo.has(key)) memo.set(key, {});
    const slot = memo.get(key);
    return (name, build) => (slot[name] ??= build());
  };
  const providersNow = () => overrides.providers ?? forSettings()('providers', () => createProviders(cfgNow().providers, { log, devAllowed: devAllowed() }));
  const zohoNow = () => overrides.zoho ?? forSettings()('zoho', () => createZohoClient(cfgNow().zoho));
  const googleNow = () => {
    if (overrides.google) return overrides.google;
    const id = cfgNow().googleClientId;
    return id ? forSettings()('google', () => createGoogleVerifier({ clientId: id })) : null;
  };
  let otpCache = { secret: null, otp: null };
  const otpNow = () => {
    const secret = secretNow();
    if (!secret) return null;
    if (otpCache.secret !== secret) otpCache = { secret, otp: createOtp({ db, settings, limits, events, secret, providers: () => providersNow(), now, log }) };
    return otpCache.otp;
  };
  const firm = overrides.firm ?? createFirmLookup({ now });
  const crm = createCrmOutbox({ db, settings, users, events, zoho: zohoNow, enabled: first.crm !== 'off', log, now });

  // ---- is it safe to run?
  function status() {
    const cfg = cfgNow();
    const providers = providersNow();
    const problems = [...(overrides.providers ? [] : providers.problems)];
    const secretOk = Boolean(secretNow());
    if (!secretOk) problems.push('AUTH_SECRET is not set (32 or more random characters in .env): nobody can sign in.');
    const channels = { email: providers.email.ready, sms: providers.sms.ready, google: Boolean(googleNow()) };
    if (!channels.email && !channels.sms && !channels.google) problems.push('No way to sign in is set up: add an e-mail service (AUTH_EMAIL_PROVIDER), a text-message service (AUTH_SMS_PROVIDER) or AUTH_GOOGLE_CLIENT_ID to .env.');
    const storeUp = db.connected();
    if (!storeUp) problems.push('The account database (MongoDB) is not connected yet.');
    const ready = secretOk && (channels.email || channels.sms || channels.google) && storeUp;
    const reasons = [];
    if (!secretOk) reasons.push('no-secret');
    if (!channels.email && !channels.sms && !channels.google) reasons.push('no-channel');
    if (!storeUp) reasons.push('no-database');
    return {
      ready,
      gate: cfg.required,
      store: db.kind,
      channels,
      reasons,
      problems,
      developmentSecret: !cfg.secret && secretOk && !overrides.secret,
      // codes are printed in the server window instead of being sent (development on this computer only)
      developmentCodes: Boolean(providers.email.dev || providers.sms.dev),
      adminApi: Boolean(cfg.adminToken),
      crm: { mode: first.crm, credentials: zohoNow().ready, problem: first.crm === 'off' || zohoNow().ready ? null : zohoNow().problem },
    };
  }

  /** What the sign-in page needs to know before it draws itself. Nothing secret. */
  async function publicConfig() {
    const st = status();
    const cfg = await settings.get().catch(() => null);
    const toggles = cfg?.channels ?? { email: true, sms: true, google: true };
    const confirm = cfg ? (await rules()).confirm : {};
    return {
      ready: st.ready && Boolean(cfg),
      channels: { email: st.channels.email && toggles.email, sms: st.channels.sms && toggles.sms, google: st.channels.google && toggles.google },
      googleClientId: st.channels.google && toggles.google ? cfgNow().googleClientId : '',
      codeLength: 6,
      resendSeconds: cfg?.otp.resendCooldownSeconds ?? 45,
      signupOpen: cfg?.signup.open ?? true,
      requireFirm: cfg?.signup.requireFirm ?? true,
      // for which of e-mail / phone the second contact detail is confirmed with a code at sign-up (the page says so, and asks for the code)
      confirm: { email: Boolean(confirm.email), phone: Boolean(confirm.phone) },
      smsCountryCodes: cfg?.sms.allowedCountryCodes ?? [],
      // the places a person may be sent to after signing in: the page checks its `?next=` against this (the server checks again)
      routes: [...nextAllowed],
      crmDeletes: Boolean(cfg?.crm.enabled && cfg?.crm.deleteOnAccountDelete),
    };
  }

  /**
   * When the sign-up form counts as finished: a firm if asked for, and the second contact detail CONFIRMED wherever that way of
   * sending a code is open (see users.js). Passed to everything that saves, completes or shows an account.
   */
  async function rules() {
    const cfg = await settings.get();
    const st = status();
    const on = cfg.signup.confirmSecondContact;
    return { requireFirm: cfg.signup.requireFirm, confirm: on ? { email: st.channels.email && cfg.channels.email, phone: st.channels.sms && cfg.channels.sms } : {} };
  }

  /** Only a route of this site, written exactly as the site map writes it. Anything else (an address, a scheme, `//x`, `/\x`) is the home page. */
  const safeNext = (raw) => (typeof raw === 'string' && nextAllowed.has(raw) ? raw : '/');

  // ---- who is asking?
  async function cachedUser(id) {
    const hit = userCache.get(id);
    if (hit && now() - hit.at < USER_CACHE_MS) return hit.user;
    const user = await users.byId(id);
    if (user) {
      if (userCache.size > 5000) userCache.delete(userCache.keys().next().value);
      userCache.set(id, { user, at: now() });
    } else userCache.delete(id);
    return user;
  }
  const forgetUser = (id) => userCache.delete(id);

  const cookieSpec = (req) => {
    const secure = cfgNow().cookieSecure === 'on' || (cfgNow().cookieSecure === 'auto' && req.secure);
    return { secure, name: secure ? '__Host-terucon_session' : 'terucon_session' };
  };
  const sessionToken = (req) => {
    const values = cookieValues(req.headers.cookie, cookieSpec(req).name);
    return values.length === 1 ? values[0] : null; // two cookies of this name: one of them was planted, so neither is trusted
  };

  /** @returns {Promise<{user: object, session: object, token: string} | null>} throws StoreUnavailableError when the database is down */
  function resolve(req) {
    req[KEY] ??= (async () => {
      const token = sessionToken(req);
      if (!token) return null;
      const session = await sessions.resolve(token);
      if (!session) return null;
      const user = await cachedUser(session.userId);
      if (!user) {
        await sessions.revoke(token);
        return null;
      }
      return { user, session, token };
    })();
    return req[KEY];
  }

  /** Sign this browser in as `user`: a brand-new session (never one the browser brought along), in a cookie only the server can read. */
  async function startSession(req, res, user) {
    const old = sessionToken(req);
    if (old) await sessions.revoke(old).catch(() => {});
    const { token, maxAgeMs } = await sessions.create({ userId: user._id, ip: req.ip, userAgent: req.headers['user-agent'] });
    const { secure, name } = cookieSpec(req);
    res.cookie(name, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: maxAgeMs });
    req[KEY] = Promise.resolve({ user, session: { userId: user._id }, token });
    return token;
  }

  function clearCookies(req, res) {
    const { secure, name } = cookieSpec(req);
    res.clearCookie(name, { httpOnly: true, sameSite: 'lax', secure, path: '/' });
    res.clearCookie('terucon_owner', { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' }); // the studio's per-browser id: the next visitor gets their own
  }

  async function endSession(req, res, { everywhere = false, userId } = {}) {
    const token = sessionToken(req);
    if (token) await sessions.revoke(token);
    if (everywhere && userId) await sessions.revokeAll(userId);
    req[KEY] = Promise.resolve(null);
    clearCookies(req, res);
  }

  // ---- the gates
  const homeFor = (route) => `/login?next=${encodeURIComponent(safeNext(route))}`;

  /**
   * For a page: null when the visitor may have it, else what to do. Used by the page handler (server/routes/pages.js) after it
   * has decoded the path, so no spelling of the address can get past it.
   * @returns {Promise<null | {redirect: string} | {unavailable: true}>}
   */
  async function pageGate(req, action) {
    if (action.access !== 'signed-in' || !cfgNow().required) return null;
    let a;
    try {
      a = await resolve(req);
    } catch (error) {
      if (error instanceof StoreUnavailableError) return { unavailable: true };
      throw error;
    }
    if (!a) return { redirect: homeFor(action.route) };
    if (!a.user.profileComplete) return { redirect: `${homeFor(action.route)}&step=profile` };
    return null;
  }

  /** Express middleware in front of the Design Studio's API: the costly and private routes need a signed-in, finished account. */
  function apiGate(req, res, next) {
    const path = req.path;
    if (!cfgNow().required || !GATED_API.some((p) => path === p || path.startsWith(`${p}/`))) return next();
    const refuse = (status, code, error) => res.status(status).set('Cache-Control', 'no-store').json({ error, code });
    resolve(req)
      .then((a) => {
        if (!a) return refuse(401, 'auth-required', 'Please sign in to use the Design Studio.');
        if (!a.user.profileComplete) return refuse(403, 'profile-incomplete', 'Please finish your details first.');
        req.terucon = { ...req.terucon, user: a.user };
        return next();
      })
      .catch((error) => (error instanceof StoreUnavailableError ? refuse(503, 'auth-unavailable', 'Sign-in is not available right now. Please try again in a minute.') : next(error)));
  }

  // ---- the admin's token
  function adminAccess(req) {
    const token = cfgNow().adminToken;
    if (!token) return { enabled: false };
    const room = limits.ipPeek('admin-fail', req.ip, 20, 'hour'); // guessing the token is slow: twenty wrong tries an hour per address
    if (!room.ok) return { enabled: true, ok: false, tooMany: true, retryAfter: room.retryAfter };
    const header = String(req.headers.authorization ?? '');
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const ok = given.length > 0 && safeEqual(sha256(given), sha256(token));
    if (!ok) limits.ipRecord('admin-fail', req.ip, 'hour');
    return { enabled: true, ok };
  }

  // ---- background work
  let janitor = null;
  async function sweep() {
    try {
      const cfg = await settings.get();
      const removed = await users.removeIncompleteOlderThan(cfg.session.incompleteAccountDays);
      if (removed) log?.info(`auth  removed ${removed} account${removed === 1 ? '' : 's'} that never finished the sign-up form`);
    } catch {
      // the database may not be up yet; the next sweep tries again
    }
  }

  return {
    db,
    settings,
    limits,
    events,
    sessions,
    users,
    crm,
    firm,
    publicView,
    rules,
    status,
    publicConfig,
    safeNext,
    otp: otpNow,
    providers: providersNow,
    google: googleNow,
    resolve,
    forgetUser,
    startSession,
    endSession,
    clearCookies,
    cookieSpec,
    pageGate,
    apiGate,
    adminAccess,
    required: () => cfgNow().required,
    /** The studio's limits now: the admin's saved value, else .env. Synchronous, for the rate limiter. */
    studioLimits() {
      const env = websiteSettings().studio.limits;
      const saved = settings.saved();
      return {
        ai: saved['studio.limit.ai'] ?? env.ai,
        vision: saved['studio.limit.vision'] ?? env.vision,
        pipeline: saved['studio.limit.pipeline'] ?? env.pipeline,
        check: saved['studio.limit.check'] ?? env.check,
        rooms: saved['studio.limit.rooms'] ?? env.rooms,
        perAddress: saved['studio.limit.addressFactor'] ?? env.perAddress,
      };
    },
    start() {
      settings.get().catch(() => {}); // load the saved settings now, so the first request already follows them
      crm.start();
      janitor ??= setInterval(sweep, HOUR);
      janitor.unref?.();
      setTimeout(sweep, 60 * 1000).unref?.();
    },
    close() {
      crm.stop();
      clearInterval(janitor);
      janitor = null;
      limits.close();
      firm.close?.();
    },
  };
}
