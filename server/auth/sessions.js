/**
 * Sessions: what a signed-in browser carries.
 *
 * The cookie holds a random 256-bit token. The database holds only its SHA-256 (so a copy of the database cannot be replayed as
 * a cookie), the person it belongs to, when it was made and when it was last used. A session ends at the first of: it is
 * revoked (sign out, sign out everywhere, account deleted), it has not been used for `session.idleDays`, or it is
 * `session.maxDays` old. Both limits are read from the settings at the moment of use, so an admin who shortens them
 * shortens sessions that already exist.
 *
 * A signed-in request does not hit the database every time: the answer is remembered for 15 seconds in this process. Signing out
 * or deleting the account forgets it at once in this process; another server instance would notice within those 15 seconds.
 */
import { randomToken, sha256 } from './crypto.js';
import { ipKey } from './limits.js';

const DAY = 24 * 60 * 60 * 1000;
const CACHE_MS = 15 * 1000;
const CACHE_MAX = 5000;
const TOUCH_MS = 10 * 60 * 1000; // lastSeenAt is rewritten at most this often
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./db.js').createAuthDb>} deps.db
 * @param {{get: () => Promise<any>}} deps.settings
 * @param {() => number} [deps.now]
 */
export function createSessions({ db, settings, now = Date.now }) {
  const cache = new Map(); // session id -> {checkedAt, session}

  const remember = (session) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(session.id, { checkedAt: now(), session });
  };

  /** Make a session. Returns the token (shown once, put in the cookie) and how long the cookie should live. */
  async function create({ userId, ip, userAgent }) {
    const cfg = await settings.get();
    const token = randomToken(32);
    const t = now();
    const absoluteExpiresAt = t + cfg.session.maxDays * DAY;
    const col = await db.col('sessions');
    await col.insertOne({
      _id: sha256(token),
      userId,
      createdAt: t,
      lastSeenAt: t,
      absoluteExpiresAt,
      ipKey: ipKey(ip),
      ua: String(userAgent ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 160),
      purgeAt: new Date(absoluteExpiresAt),
    });
    return { token, maxAgeMs: absoluteExpiresAt - t };
  }

  /** The live session for a cookie token, or null. */
  async function resolve(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const id = sha256(token);
    const t = now();
    const hit = cache.get(id);
    if (hit && t - hit.checkedAt < CACHE_MS) return hit.session;
    cache.delete(id);

    const col = await db.col('sessions');
    const doc = await col.findOne({ _id: id });
    if (!doc) return null;
    const cfg = await settings.get();
    if (doc.absoluteExpiresAt <= t || doc.createdAt + cfg.session.maxDays * DAY <= t || doc.lastSeenAt + cfg.session.idleDays * DAY <= t) {
      await col.deleteOne({ _id: id });
      return null;
    }
    let lastSeenAt = doc.lastSeenAt;
    if (t - lastSeenAt > TOUCH_MS) {
      lastSeenAt = t;
      await col.updateOne({ _id: id }, { $set: { lastSeenAt } });
    }
    const session = { id, userId: doc.userId, createdAt: doc.createdAt, lastSeenAt };
    remember(session);
    return session;
  }

  async function revoke(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return;
    const id = sha256(token);
    cache.delete(id);
    await (await db.col('sessions')).deleteOne({ _id: id });
  }

  /** End every session of a person, optionally keeping the one that asked (so "sign out everywhere else" works). */
  async function revokeAll(userId, { exceptToken } = {}) {
    const keep = exceptToken && TOKEN.test(exceptToken) ? sha256(exceptToken) : null;
    for (const [id, entry] of cache) if (entry.session.userId === userId && id !== keep) cache.delete(id);
    const filter = keep ? { userId, _id: { $ne: keep } } : { userId };
    const { deletedCount } = await (await db.col('sessions')).deleteMany(filter);
    return deletedCount;
  }

  async function countFor(userId) {
    return (await db.col('sessions')).countDocuments({ userId });
  }

  return { create, resolve, revoke, revokeAll, countFor, forgetCache: () => cache.clear() };
}
