/**
 * The security log: who tried what, as one record per event, kept for 90 days. It is what the admin panel will show when someone
 * asks "why can't I get in?" or "is somebody attacking the sign-in?".
 *
 * Never in an event: a one-time code, a session token, a full e-mail address or phone number (only the masked form), a password
 * or a key. A free-text detail is stripped of control characters and cut short, so an attacker's input cannot forge a log line.
 */
import { randomId } from './crypto.js';

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// the events worth a line in the server's own log (the rest are only kept in the database)
const LOUD = new Set(['otp.locked', 'otp.cap-hit', 'signin.blocked', 'admin.denied', 'google.rejected', 'send.failed', 'account.deleted', 'settings.changed', 'crm.failed']);

const oneLine = (text, max) => String(text ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').slice(0, max);

/**
 * @param {{db: ReturnType<typeof import('./db.js').createAuthDb>, log?: {info: Function, warn: Function}, now?: () => number}} options
 */
export function createEvents({ db, log, now = Date.now }) {
  return {
    /** Never throws: a broken log must not break a sign-in. */
    async record(type, { userId, ip, who, detail } = {}) {
      const t = now();
      try {
        const col = await db.col('events');
        await col.insertOne({
          _id: randomId(),
          t,
          type: oneLine(type, 40),
          ...(userId && { userId: oneLine(userId, 40) }),
          ...(ip && { ip: oneLine(ip, 60) }),
          ...(who && { who: oneLine(who, 80) }),
          ...(detail && { detail: oneLine(detail, 200) }),
          purgeAt: new Date(t + RETENTION_MS),
        });
      } catch (error) {
        log?.warn(`auth  could not write the security log: ${oneLine(error.message, 120)}`);
      }
      if (LOUD.has(type)) log?.warn(`auth  ${oneLine(type, 40)}${who ? ` ${oneLine(who, 80)}` : ''}${ip ? ` from ${oneLine(ip, 60)}` : ''}${detail ? `: ${oneLine(detail, 120)}` : ''}`);
    },

    /** Newest first. `before` is a time (ms) to page back from. */
    async recent({ limit = 100, before } = {}) {
      const col = await db.col('events');
      const filter = before ? { t: { $lt: Number(before) } } : {};
      const rows = await col.find(filter).sort({ t: -1 }).limit(Math.min(Math.max(1, Number(limit) || 100), 500)).toArray();
      return rows.map(({ _id, purgeAt, ...event }) => ({ id: _id, ...event }));
    },
  };
}
