/**
 * How often TeruBot may be used, and how many chats may run at once. Every chat message costs Google money (up to a handful of model
 * calls), and the landing page is public, so the ceilings are per hour in three buckets:
 *
 *   account    one signed-in account                              TERUBOT_LIMIT_ACCOUNT    (default 60)
 *   address    one network address, signed in or not              TERUBOT_LIMIT_ADDRESS    (default 120; an office or a phone network shares one)
 *   anonymous  one network address, for visitors NOT signed in    TERUBOT_LIMIT_ANONYMOUS  (default 20)
 *
 * A request must pass every bucket that applies to it, and only then counts in all of them. In memory (server/lib/rateLimit.js), so a
 * restart clears it. A global cap on chats in flight keeps a burst from queueing up unbounded model calls.
 */
import { RateLimiter } from '../rateLimit.js';

const HOUR = 3600000;
/** Chats being answered at the same moment, whoever asks. */
export const MAX_IN_FLIGHT = 16;

/**
 * @param {object} options
 * @param {() => {limitAccount: number, limitAddress: number, limitAnonymous: number}} options.limits current ceilings (read on every use)
 * @param {() => number} [options.now]
 */
export function createLimits({ limits, now = Date.now }) {
  const limiter = new RateLimiter({ windowMs: HOUR, now });
  let inFlight = 0;

  /** The buckets a request belongs to: [key, ceiling][] */
  function buckets({ account, address }) {
    const max = limits();
    const list = [[`ip:${address ?? 'unknown'}`, max.limitAddress]];
    if (account) list.unshift([`acct:${account}`, max.limitAccount]);
    else list.push([`anon:${address ?? 'unknown'}`, max.limitAnonymous]);
    return list;
  }

  return {
    /**
     * Take one use for this asker if every bucket has room.
     * @returns {{ok: true} | {ok: false, retryAfterSec: number, bucket: string}}
     */
    take(asker) {
      const list = buckets(asker);
      for (const [key, ceiling] of list) {
        const verdict = limiter.check(key, ceiling);
        if (!verdict.ok) return { ok: false, retryAfterSec: verdict.retryAfter, bucket: key.split(':')[0] };
      }
      for (const [key] of list) limiter.record(key);
      return { ok: true };
    },

    /** A place among the chats in flight, or null; give it back with the returned function. */
    enter() {
      if (inFlight >= MAX_IN_FLIGHT) return null;
      inFlight += 1;
      let left = false;
      return () => {
        if (!left) {
          left = true;
          inFlight -= 1;
        }
      };
    },

    inFlight: () => inFlight,
    close: () => limiter.close(),
  };
}
