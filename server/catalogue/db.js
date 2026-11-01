/**
 * Where the catalogue lives: four MongoDB collections, in the same database as the accounts and the studio's rooms, named with the
 * `terucon_` prefix so they can never collide with the studio's. The Python package (catalogue/terucon_catalogue/mongo.py) writes the
 * same collections; the shapes are catalogue/ARCHITECTURE.md section 4.4.
 *
 *   terucon_catalogues          one document per catalogue, with the pointer to its live release
 *   terucon_catalogue_items     one per design / material (the website enriches search results from these)
 *   terucon_catalogue_releases  immutable snapshots of the vectors a search service loads
 *   terucon_catalogue_jobs      uploads and their processing
 *
 * Like server/auth/db.js: with the studio's mongoose connection the real collections are used; without it (tests, a computer with no
 * database) the in-memory stand-in of server/auth/memoryDb.js answers the same calls. The code above this file is written once, against
 * that calling surface, and sticks to the part of it the stand-in supports (flat field names, $set / $unset, $in, $ne, comparisons).
 *
 * The stand-in's `find()` ignores a projection, and MongoDB does not, so the in-memory flavour is wrapped to honour one (also dotted
 * paths such as "images.thumb.key") and the two operators the admin's text filter needs ($or and $regex). A test can pass `observe` to
 * see every read and check that each one has a projection.
 *
 * Indexes are created once per process, the first time a collection is needed, WITHOUT names: MongoDB then gives the default names, so
 * the same key pattern created by the Python package is the same index. If MongoDB refuses one (another definition of the same keys
 * exists, or the account may not create indexes) it is logged once and the catalogue goes on without it: an index only makes a read faster.
 */
import { isDuplicateKey, StoreUnavailableError } from '../auth/db.js';
import { createMemoryDb } from '../auth/memoryDb.js';

export { isDuplicateKey, StoreUnavailableError };

export const COLLECTIONS = ['catalogues', 'catalogue_items', 'catalogue_releases', 'catalogue_jobs'];

/** The same specs the Python package creates (catalogue/ARCHITECTURE.md 4.4). Key patterns and the partial filter must match exactly. */
export const INDEXES = {
  catalogue_items: [
    { keys: { catalogue: 1, status: 1 } },
    { keys: { catalogue: 1, productId: 1 }, options: { partialFilterExpression: { productId: { $type: 'string' } } } },
  ],
  catalogue_jobs: [{ keys: { status: 1, createdAt: 1 } }],
  catalogue_releases: [{ keys: { catalogue: 1, createdAt: 1 } }],
};

const RETRY_INDEXES_MS = 60 * 1000;

// ------------------------------------------------------------------------------------------------ the in-memory flavour

/** Copy `parts` (a dotted path, split) of `src` into `dst`. */
function copyPath(src, dst, parts) {
  const [head, ...rest] = parts;
  if (!Object.hasOwn(src, head)) return;
  if (!rest.length) {
    dst[head] = src[head];
    return;
  }
  const inner = src[head];
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    dst[head] ??= {};
    copyPath(inner, dst[head], rest);
  }
}

/** MongoDB's projection: all included fields (and _id unless it is 0), or everything but the excluded ones. */
export function project(doc, projection) {
  if (!projection) return doc;
  const entries = Object.entries(projection).filter(([name]) => name !== '_id');
  const keepId = projection._id === undefined || Boolean(projection._id);
  if (!entries.length) {
    if (keepId) return doc;
    const { _id, ...rest } = doc;
    return rest;
  }
  const including = entries.every(([, v]) => Boolean(v));
  const excluding = entries.every(([, v]) => !v);
  if (!including && !excluding) throw new Error('catalogue memory db: a projection cannot both include and exclude fields');
  if (excluding) {
    const out = { ...doc };
    for (const [name] of entries) delete out[name];
    if (!keepId) delete out._id;
    return out;
  }
  const out = {};
  if (keepId && Object.hasOwn(doc, '_id')) out._id = doc._id;
  for (const [name] of entries) copyPath(doc, out, name.split('.'));
  return out;
}

const isRegexCondition = (condition) => condition !== null && typeof condition === 'object' && '$regex' in condition;

/** One branch of an $or: {field: value} or {field: {$regex, $options}}. Anything else is refused, as the stand-in refuses what it does not know. */
function branchTest(branch) {
  const tests = Object.entries(branch).map(([field, condition]) => {
    if (isRegexCondition(condition)) {
      const unknown = Object.keys(condition).filter((k) => k !== '$regex' && k !== '$options');
      if (unknown.length) throw new Error(`catalogue memory db: unsupported operator ${unknown[0]}`);
      const pattern = new RegExp(condition.$regex, condition.$options ?? '');
      return (doc) => typeof doc[field] === 'string' && pattern.test(doc[field]);
    }
    if (condition !== null && typeof condition === 'object') throw new Error('catalogue memory db: only equality and $regex are supported inside $or');
    return (doc) => (condition === null ? doc[field] === null || doc[field] === undefined : doc[field] === condition);
  });
  return (doc) => tests.every((test) => test(doc));
}

/** Split a filter into what the stand-in understands and the $or / $regex parts the wrapper checks itself. */
function splitFilter(filter) {
  const plain = {};
  const extras = [];
  for (const [key, condition] of Object.entries(filter ?? {})) {
    if (key === '$or') {
      const branches = condition.map(branchTest);
      extras.push((doc) => branches.some((test) => test(doc)));
    } else if (isRegexCondition(condition)) {
      extras.push(branchTest({ [key]: condition }));
    } else plain[key] = condition;
  }
  return { plain, extras };
}

class ViewCursor {
  #base;
  #filter;
  #projection;
  #sort = null;
  #limit = 0;
  constructor(base, filter, projection) {
    this.#base = base;
    this.#filter = filter;
    this.#projection = projection;
  }
  sort(spec) {
    this.#sort = spec ?? null;
    return this;
  }
  limit(n) {
    this.#limit = n > 0 ? n : 0;
    return this;
  }
  async toArray() {
    const { plain, extras } = splitFilter(this.#filter);
    let cursor = this.#base.find(plain);
    if (this.#sort) cursor = cursor.sort(this.#sort);
    if (this.#limit && !extras.length) cursor = cursor.limit(this.#limit);
    let docs = await cursor.toArray();
    if (extras.length) docs = docs.filter((doc) => extras.every((test) => test(doc)));
    if (this.#limit) docs = docs.slice(0, this.#limit);
    return docs.map((doc) => project(doc, this.#projection));
  }
}

/** The stand-in's collection, answering a projection and $or / $regex, and telling `observe` about reads. */
function memoryView(name, base, observe) {
  const view = {
    createIndex: (keys, options) => base.createIndex(keys, options),
    insertOne: (doc) => base.insertOne(doc),
    updateOne: (filter, update, options) => base.updateOne(filter, update, options),
    updateMany: (filter, update) => base.updateMany(filter, update),
    findOneAndUpdate: (filter, update, options) => base.findOneAndUpdate(filter, update, options),
    deleteOne: (filter) => base.deleteOne(filter),
    deleteMany: (filter) => base.deleteMany(filter),
    async countDocuments(filter = {}) {
      observe?.({ op: 'count', collection: name, filter });
      return (await new ViewCursor(base, filter, null).toArray()).length;
    },
    async findOne(filter = {}, options = {}) {
      observe?.({ op: 'findOne', collection: name, filter, options });
      const [first] = await new ViewCursor(base, filter, options.projection).sort(options.sort).limit(1).toArray();
      return first ?? null;
    },
    find(filter = {}, options = {}) {
      observe?.({ op: 'find', collection: name, filter, options });
      return new ViewCursor(base, filter, options.projection);
    },
  };
  return view;
}

// ------------------------------------------------------------------------------------------------------------ the store

/**
 * @param {object} [options]
 * @param {import('mongoose').Mongoose | null} [options.mongoose] the studio's mongoose; left out, the in-memory store is used
 * @param {string} [options.prefix]
 * @param {ReturnType<typeof createMemoryDb>} [options.memory]
 * @param {() => number} [options.now]
 * @param {{warn: Function}} [options.log]
 * @param {(event: {op: string, collection: string, filter: object, options?: object}) => void} [options.observe] in-memory flavour only: sees every read
 */
export function createCatalogueDb({ mongoose = null, prefix = 'terucon_', memory, now = Date.now, log, observe } = {}) {
  const mem = memory ?? (mongoose ? null : createMemoryDb({ now }));
  const views = new Map();
  const raw = (name) => {
    if (mongoose) return mongoose.connection.db.collection(prefix + name);
    if (!views.has(name)) views.set(name, memoryView(name, mem.collection(name), observe));
    return views.get(name);
  };
  const connected = () => (mongoose ? mongoose.connection.readyState === 1 : true);
  const loggedAt = new Map();
  const warnOnce = (key, message) => {
    if (now() - (loggedAt.get(key) ?? -Infinity) < 10 * 60 * 1000) return;
    loggedAt.set(key, now());
    log?.warn(message);
  };

  let indexes = null;
  let retryAt = 0;
  async function ready() {
    if (!connected()) throw new StoreUnavailableError('The catalogue database is not connected.');
    if (!indexes && now() >= retryAt) {
      indexes = (async () => {
        let transient = false;
        for (const [name, list] of Object.entries(INDEXES)) {
          for (const { keys, options } of list) {
            try {
              await raw(name).createIndex(keys, options);
            } catch (error) {
              // 85 / 86: the same keys exist with another name or options (the Python package made them): fine, and not worth a retry
              if (error?.code !== 85 && error?.code !== 86) transient = true;
              warnOnce(`index:${name}:${JSON.stringify(keys)}`, `catalogue  could not create the index ${JSON.stringify(keys)} on ${name} (${error?.codeName ?? error?.code ?? 'error'}): going on without it`);
            }
          }
        }
        if (transient) {
          indexes = null;
          retryAt = now() + RETRY_INDEXES_MS;
        }
      })();
    }
    await indexes;
  }

  return {
    /** 'mongo' or 'memory' */
    kind: mongoose ? 'mongo' : 'memory',
    connected,
    ready,
    /** The collection `name` (one of COLLECTIONS) once the store is up; throws StoreUnavailableError otherwise. */
    async col(name) {
      if (!COLLECTIONS.includes(name)) throw new Error(`catalogue db: unknown collection ${name}`);
      await ready();
      return raw(name);
    },
  };
}

/** True when an error means "the database is not reachable" (ours, or the driver's network and selection errors). */
export const isStoreDown = (error) => error instanceof StoreUnavailableError || /^Mongo(?:Network|ServerSelection|NotConnected|Topology)/.test(error?.name ?? '') || error?.name === 'MongooseError';
