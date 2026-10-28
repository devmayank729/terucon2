/**
 * What stands in front of the Design Studio's API now that its passcode is off (STUDIO_REQUIRE_PASSCODE, server/config/settings.js).
 * It sits in the website, before the studio's app, so nothing inside swatchroom/ is changed. Two protections:
 *
 *   1. Rooms belong to the browser that made them. The studio keeps all rooms in one pile, so without this anyone could list,
 *      open and delete everyone's room photos. Each browser gets a private random id in an HttpOnly cookie (terucon_owner); a room
 *      is claimed by the id that first saved it, and every other browser is told "That room is not saved here." (the studio's own
 *      answer for a room that does not exist, so a stranger cannot even tell a room is there). The room list shows only your own.
 *      Rooms saved before this existed have no owner and are hidden from everybody (they are still in the database).
 *   2. Every route that spends money (Gemini, the scan and room-analysis GPUs) or writes data is rate limited per browser and,
 *      more loosely, per address, so a stranger cannot run up the Google/GPU bill or fill the database.
 *
 * The limits are per hour and in the settings (STUDIO_LIMIT_*). In memory, so a restart clears them. Requests that are not the
 * studio's API are never touched.
 *
 * @typedef {object} RoomStore
 * @property {() => boolean} ready whether the database is connected (when it is not, the studio cannot list or save rooms either)
 * @property {(id: string) => Promise<string | null>} ownerOf
 * @property {(id: string) => Promise<boolean>} roomExists a room record exists (it may have no owner: an older room)
 * @property {(id: string, owner: string) => Promise<boolean>} claim true when `owner` now owns it, false when somebody else got there first
 * @property {(id: string) => Promise<void>} release
 * @property {(owner: string) => Promise<object[]>} listOwned the summaries the studio's list route would give, for this owner's rooms
 */
import crypto from 'node:crypto';
import { RateLimiter } from './rateLimit.js';

export const OWNER_COOKIE = 'terucon_owner';
const OWNER_ID = /^[a-f0-9]{32}$/;
const ROOM_ID = /^room-[a-z0-9-]{4,48}$/; // the studio's own pattern (routes/rooms.js)
const COOKIE_DAYS = 400;
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CACHE_MAX = 5000;
const LOG_EVERY_MS = 10 * 60 * 1000;

/** The group a request is counted in, or null when it is free. Reads (polling a job, reading a photo) are free. */
export function limitGroup(method, path) {
  const under = (prefix) => path === prefix || path.startsWith(prefix + '/');
  if (under('/api/ai') && method === 'POST') return 'ai';
  if (under('/api/vision') && method === 'POST') return 'vision';
  if (under('/api/pipeline') && method === 'POST') return 'pipeline';
  if (path === '/api/check' && method === 'POST') return 'check';
  if (under('/api/rooms') && WRITES.has(method)) return 'rooms';
  return null;
}

const MESSAGES = {
  rooms: 'You are saving rooms very quickly. Please wait a few minutes and try again.',
  default: 'The studio has been used a lot from here in the last hour. Please wait a few minutes and try again.',
};

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/**
 * @param {object} options
 * @param {RoomStore} options.store
 * @param {() => {ai: number, vision: number, pipeline: number, check: number, rooms: number, perAddress: number}} options.limits
 * @param {{warn: Function}} [options.log]
 * @param {() => number} [options.now]
 */
export function studioShield({ store, limits, log, now = Date.now }) {
  const limiter = new RateLimiter({ windowMs: 3600000, now });
  const owners = new Map(); // room id -> owner, only what the database has confirmed (an owner never changes until the room is deleted)
  const logged = new Map();

  const remember = (id, owner) => {
    if (owners.size >= CACHE_MAX) owners.delete(owners.keys().next().value);
    owners.set(id, owner);
  };
  const ownerOf = async (id) => {
    if (owners.has(id)) return owners.get(id);
    const owner = await store.ownerOf(id);
    if (owner) remember(id, owner);
    return owner;
  };
  const notSaved = (res) => res.status(404).set('Cache-Control', 'no-store').json({ error: 'That room is not saved here.' });

  /** true when the request may go on; sends the 429 and returns false otherwise */
  function allow(req, res, group, visitor) {
    const max = limits();
    const perVisitor = max[group];
    const perAddress = perVisitor * max.perAddress;
    const keys = [
      [`v:${visitor}:${group}`, perVisitor],
      [`ip:${req.ip ?? 'unknown'}:${group}`, perAddress],
    ];
    for (const [key, limit] of keys) {
      const verdict = limiter.check(key, limit);
      if (!verdict.ok) {
        const last = logged.get(key) ?? 0;
        if (now() - last > LOG_EVERY_MS) {
          logged.set(key, now());
          log?.warn(`studio  rate limit: ${key.startsWith('ip:') ? 'address ' + req.ip : 'one browser'} used up ${group} (${limit} an hour)`);
        }
        res.status(429).set({ 'Retry-After': String(verdict.retryAfter), 'Cache-Control': 'no-store' }).json({ error: MESSAGES[group] ?? MESSAGES.default, code: 'rate-limit' });
        return false;
      }
    }
    for (const [key] of keys) limiter.record(key);
    return true;
  }

  async function rooms(req, res, next, owner) {
    const match = /^\/api\/rooms(?:\/([^/]+))?(?:\/.*)?$/.exec(req.path);
    if (!match) return next();
    const readOnly = req.method === 'GET' || req.method === 'HEAD';
    const id = match[1];
    if (!id) {
      if (!readOnly) return next(); // the studio's own 404/405
      return res.set('Cache-Control', 'no-store').json({ rooms: await store.listOwned(owner) });
    }
    if (!ROOM_ID.test(id)) return next(); // the studio says "That is not a room id."
    const current = await ownerOf(id);
    if (current) {
      if (current !== owner) return notSaved(res);
    } else if (await store.roomExists(id)) {
      return notSaved(res); // an older room nobody owns: hidden
    } else if (req.method === 'PUT') {
      if (await store.claim(id, owner)) remember(id, owner);
      else if ((await ownerOf(id)) !== owner) return notSaved(res);
    }
    if (req.method === 'DELETE') {
      res.on('finish', () => {
        if (res.statusCode < 300) {
          owners.delete(id);
          store.release(id).catch(() => {});
        }
      });
    }
    return next();
  }

  const middleware = (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    let owner = cookieValue(req, OWNER_COOKIE);
    if (!OWNER_ID.test(owner)) {
      owner = crypto.randomBytes(16).toString('hex');
      res.cookie(OWNER_COOKIE, owner, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: COOKIE_DAYS * 86400000, path: '/' });
    }
    const group = limitGroup(req.method, req.path);
    if (group && !allow(req, res, group, owner)) return;
    if (!req.path.startsWith('/api/rooms') || !store.ready()) return next();
    rooms(req, res, next, owner).catch(next);
  };
  middleware.close = () => limiter.close();
  return middleware;
}
