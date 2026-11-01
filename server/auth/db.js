/**
 * Where accounts, sessions, one-time codes, rate-limit counters, the security log, the admin's settings and the CRM queue live.
 *
 * Production: the studio's own MongoDB connection (the same mongoose, the same database), in collections whose names start with
 * `terucon_` so they can never collide with the studio's. Tests and local runs without a database: the in-memory stand-in
 * (server/auth/memoryDb.js), which answers the same calls. The code above this file is written once against that calling surface.
 *
 * Nothing is created until the connection is up. Indexes are created once per process, the first time a collection is needed; the
 * unique ones are what make "one verified e-mail address, one account" true even when two requests race.
 */
import { createMemoryDb } from './memoryDb.js';

export class StoreUnavailableError extends Error {
  constructor(message = 'The account database is not connected.') {
    super(message);
    this.name = 'StoreUnavailableError';
    this.status = 503;
  }
}

const ttl = { keys: { purgeAt: 1 }, options: { name: 'purge', expireAfterSeconds: 0 } };

/**
 * Field notes, so the shape of a user is written down once.
 *   users      emailKey / phoneKey exist only while that e-mail / number is VERIFIED (they are what the unique indexes and every
 *              sign-in look-up use). emailClaim / phoneClaim hold an address or number somebody typed but has not proved: they are
 *              never used to sign in and are not unique, so typing another person's address gives no power over their account.
 *   sessions   _id is the SHA-256 of the cookie's token.
 *   challenges one-time codes; the code itself is only stored as an HMAC.
 *   hits       one record per counted event ("this e-mail was sent a code"), counted over a window to enforce a limit.
 */
export const INDEXES = {
  users: [
    { keys: { emailKey: 1 }, options: { name: 'verified_email', unique: true, partialFilterExpression: { emailKey: { $type: 'string' } } } },
    { keys: { phoneKey: 1 }, options: { name: 'verified_phone', unique: true, partialFilterExpression: { phoneKey: { $type: 'string' } } } },
    { keys: { googleSub: 1 }, options: { name: 'google_sub', unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } } },
    { keys: { ownerId: 1 }, options: { name: 'owner', unique: true } },
    { keys: { emailClaim: 1 }, options: { name: 'email_claim' } },
    { keys: { phoneClaim: 1 }, options: { name: 'phone_claim' } },
    { keys: { profileComplete: 1, createdAt: 1 }, options: { name: 'incomplete' } },
  ],
  sessions: [{ keys: { userId: 1 }, options: { name: 'user' } }, ttl],
  challenges: [{ keys: { idKey: 1, purpose: 1, createdAt: -1 }, options: { name: 'identifier' } }, ttl],
  hits: [{ keys: { k: 1, t: 1 }, options: { name: 'counted' } }, ttl],
  events: [{ keys: { t: -1 }, options: { name: 'recent' } }, ttl],
  settings: [],
  outbox: [{ keys: { status: 1, nextAt: 1 }, options: { name: 'due' } }, { keys: { userId: 1 }, options: { name: 'user' } }],
};

/**
 * @param {object} [options]
 * @param {import('mongoose').Mongoose | null} [options.mongoose] the studio's mongoose; left out, the in-memory store is used
 * @param {string} [options.prefix] collection name prefix
 * @param {ReturnType<typeof createMemoryDb>} [options.memory]
 * @param {() => number} [options.now] clock for the in-memory store's expiry
 */
export function createAuthDb({ mongoose = null, prefix = 'terucon_', memory, now } = {}) {
  const mem = memory ?? (mongoose ? null : createMemoryDb({ now }));
  const raw = (name) => (mongoose ? mongoose.connection.db.collection(prefix + name) : mem.collection(name));
  const connected = () => (mongoose ? mongoose.connection.readyState === 1 : true);
  let indexes = null;

  async function ready() {
    if (!connected()) throw new StoreUnavailableError();
    indexes ??= (async () => {
      for (const [name, list] of Object.entries(INDEXES)) for (const { keys, options } of list) await raw(name).createIndex(keys, options);
    })().catch((error) => {
      indexes = null; // try again on the next request
      throw error;
    });
    await indexes;
  }

  return {
    /** 'mongo' or 'memory' */
    kind: mongoose ? 'mongo' : 'memory',
    connected,
    ready,
    /** The collection `name`, once the store is up (throws StoreUnavailableError otherwise). */
    async col(name) {
      await ready();
      return raw(name);
    },
  };
}

/** findOneAndUpdate across driver versions: older ones wrap the document in {value}, current ones return it. */
export async function findAndUpdate(collection, filter, update, options = {}) {
  const result = await collection.findOneAndUpdate(filter, update, options);
  if (result && typeof result === 'object' && 'value' in result && 'ok' in result) return result.value;
  return result;
}

/** True for MongoDB's duplicate-key error (11000), which is how a unique index says "somebody got there first". */
export const isDuplicateKey = (error) => error?.code === 11000;
