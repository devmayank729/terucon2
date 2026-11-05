/**
 * Where "capture from a phone" keeps its records: three MongoDB collections in the same database as the accounts and the studio's rooms,
 * named with the `terucon_` prefix so they can never collide with the studio's. Like server/auth/db.js: with the studio's mongoose
 * connection the real collections are used; without it (tests, a computer with no database) the in-memory stand-in answers the same calls.
 *
 *   terucon_capture_sessions   one per link: who asked (owner), for which page, the token in the link, the capturer's details, counters
 *   terucon_capture_photos     one per photo: its labels, size and time. Small, so lists never load picture bytes.
 *   terucon_capture_files      the picture itself (base64 text), under the same id as its photo. Kept apart so a list of photos is cheap.
 *
 * Every record has `purgeAt`, a date; a TTL index deletes the record then (MongoDB checks about once a minute). Because the picture is
 * in the database, not in a bucket, deleting the record deletes the picture: nothing can be left behind. Code that matters (is this link
 * still open?) never relies on the sweep: it compares the times itself.
 *
 * The stand-in supports only one-field unique indexes and flat names, so a photo's id is `<session id>_<id the phone chose>`: the
 * database's own `_id` uniqueness is what makes a retried upload harmless.
 */
import { isDuplicateKey, StoreUnavailableError } from '../auth/db.js';
import { createMemoryDb } from '../auth/memoryDb.js';

export { isDuplicateKey, StoreUnavailableError };

const ttl = { keys: { purgeAt: 1 }, options: { expireAfterSeconds: 0 } };

export const INDEXES = {
  capture_sessions: [{ keys: { token: 1 }, options: { unique: true } }, { keys: { owner: 1, createdAt: -1 } }, ttl],
  capture_photos: [{ keys: { owner: 1, createdAt: 1 } }, { keys: { session: 1 } }, ttl],
  capture_files: [ttl],
};

/**
 * @param {object} [options]
 * @param {import('mongoose').Mongoose | null} [options.mongoose] the studio's mongoose; left out, the in-memory store is used
 * @param {string} [options.prefix]
 * @param {ReturnType<typeof createMemoryDb>} [options.memory]
 * @param {() => number} [options.now] clock for the in-memory store's expiry
 * @param {{warn: Function}} [options.log]
 */
export function createCaptureDb({ mongoose = null, prefix = 'terucon_', memory, now = Date.now, log } = {}) {
  const mem = memory ?? (mongoose ? null : createMemoryDb({ now }));
  const raw = (name) => (mongoose ? mongoose.connection.db.collection(prefix + name) : mem.collection(name));
  const connected = () => (mongoose ? mongoose.connection.readyState === 1 : true);
  let indexes = null;

  async function ready() {
    if (!connected()) throw new StoreUnavailableError('The photo database is not connected.');
    indexes ??= (async () => {
      for (const [name, list] of Object.entries(INDEXES)) {
        for (const { keys, options } of list) {
          try {
            await raw(name).createIndex(keys, options);
          } catch (error) {
            // An index only makes a read faster, except the TTL (photos would then stay until someone deletes them) and the token's
            // uniqueness (two links could share a token; a 192-bit random token makes that impossible in practice).
            log?.warn(`capture  could not create an index on ${name} (${Object.keys(keys).join(', ')}): ${String(error?.message ?? error).slice(0, 160)}`);
          }
        }
      }
    })().catch((error) => {
      indexes = null;
      throw error;
    });
    await indexes;
  }

  return {
    kind: mongoose ? 'mongo' : 'memory',
    connected,
    ready,
    /** The collection `name` (capture_sessions, capture_photos, capture_files), once the store is up; throws StoreUnavailableError otherwise. */
    async col(name) {
      await ready();
      return raw(name);
    },
  };
}
