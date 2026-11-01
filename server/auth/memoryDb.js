/**
 * A small in-memory stand-in for the part of the MongoDB driver's collection API that the sign-in code uses. The sign-in code
 * is written once, against that API, so production runs the same query documents on the real driver (server/auth/db.js) and
 * tests and local runs use this. It is deliberately strict: anything outside the subset below throws, so the code cannot
 * quietly come to depend on something MongoDB would do differently.
 *
 * Supported
 *   filters   field equality (null matches a missing field, as in MongoDB), $eq $ne $gt $gte $lt $lte $in $nin $exists $type
 *             (string, number, bool, date). Comparisons only match values of the same type, as in MongoDB. Flat field names only.
 *   updates   $set $unset $inc $setOnInsert, with upsert
 *   indexes   unique (also partial: the filter {field: true} or {field: {$type: 'string'}}), and TTL on a Date field
 *             (expireAfterSeconds: 0). TTL is swept lazily here; MongoDB sweeps about once a minute, so the code never relies on it:
 *             every query that matters also checks an expiry time.
 *   methods   insertOne findOne find().sort().limit().toArray() updateOne updateMany findOneAndUpdate deleteOne deleteMany countDocuments
 *
 * Every method returns a promise but does its work in one synchronous step, so each call is atomic, like a single MongoDB operation.
 */
import { randomId } from './crypto.js';

export function duplicateKeyError(index) {
  const error = new Error(`E11000 duplicate key error collection: index: ${index}`);
  error.code = 11000;
  error.keyPattern = { [index]: 1 };
  return error;
}

const OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$type']);
const isOperatorObject = (value) => value !== null && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value) && Object.keys(value).some((k) => k.startsWith('$'));

function typeName(value) {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return 'date';
  if (typeof value === 'boolean') return 'bool';
  return typeof value; // string, number, object
}

function sameValue(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** -1, 0, 1, or null when the two values are not comparable (different types), as in MongoDB. */
function compare(a, b) {
  const ta = typeName(a);
  if (ta !== typeName(b) || !['string', 'number', 'date'].includes(ta)) return null;
  const x = ta === 'date' ? a.getTime() : a;
  const y = ta === 'date' ? b.getTime() : b;
  return x < y ? -1 : x > y ? 1 : 0;
}

function assertFlat(key) {
  if (key.includes('.')) throw new Error(`memoryDb: dotted field names are not supported (${key})`);
}

function matchesCondition(value, condition) {
  if (!isOperatorObject(condition)) return condition === null ? value === null || value === undefined : sameValue(value, condition);
  for (const [op, operand] of Object.entries(condition)) {
    if (!OPERATORS.has(op)) throw new Error(`memoryDb: unsupported operator ${op}`);
    switch (op) {
      case '$eq': if (!matchesCondition(value, operand)) return false; break;
      case '$ne': if (matchesCondition(value, operand)) return false; break;
      case '$gt': { const c = compare(value, operand); if (c === null || c <= 0) return false; break; }
      case '$gte': { const c = compare(value, operand); if (c === null || c < 0) return false; break; }
      case '$lt': { const c = compare(value, operand); if (c === null || c >= 0) return false; break; }
      case '$lte': { const c = compare(value, operand); if (c === null || c > 0) return false; break; }
      case '$in': if (!operand.some((candidate) => matchesCondition(value, candidate))) return false; break;
      case '$nin': if (operand.some((candidate) => matchesCondition(value, candidate))) return false; break;
      case '$exists': if ((value !== undefined) !== Boolean(operand)) return false; break;
      case '$type': if (typeName(value) !== operand) return false; break;
      default: break;
    }
  }
  return true;
}

function matches(doc, filter = {}) {
  for (const [key, condition] of Object.entries(filter)) {
    if (key.startsWith('$')) throw new Error(`memoryDb: unsupported top-level operator ${key}`);
    assertFlat(key);
    if (!matchesCondition(doc[key], condition)) return false;
  }
  return true;
}

function applyUpdate(doc, update, inserting) {
  const known = new Set(['$set', '$unset', '$inc', '$setOnInsert']);
  for (const op of Object.keys(update)) if (!known.has(op)) throw new Error(`memoryDb: unsupported update operator ${op}`);
  for (const [key, value] of Object.entries(update.$set ?? {})) {
    assertFlat(key);
    if (key === '_id') throw new Error('memoryDb: _id cannot be changed');
    doc[key] = structuredClone(value);
  }
  for (const key of Object.keys(update.$unset ?? {})) {
    assertFlat(key);
    delete doc[key];
  }
  for (const [key, amount] of Object.entries(update.$inc ?? {})) {
    assertFlat(key);
    if (doc[key] !== undefined && typeof doc[key] !== 'number') throw new Error(`memoryDb: $inc on a non-number (${key})`);
    doc[key] = (doc[key] ?? 0) + amount;
  }
  if (inserting) for (const [key, value] of Object.entries(update.$setOnInsert ?? {})) doc[key] = structuredClone(value);
}

class Cursor {
  #collection;
  #filter;
  #sort = null;
  #limit = Infinity;
  constructor(collection, filter) {
    this.#collection = collection;
    this.#filter = filter;
  }
  sort(spec) {
    this.#sort = spec;
    return this;
  }
  limit(n) {
    this.#limit = n > 0 ? n : Infinity;
    return this;
  }
  async toArray() {
    return this.#collection._select(this.#filter, this.#sort).slice(0, this.#limit).map((doc) => structuredClone(doc));
  }
}

class MemoryCollection {
  #name;
  #now;
  #docs = new Map();
  #unique = [];
  #ttlFields = [];
  #lastSweep = 0;

  constructor(name, now) {
    this.#name = name;
    this.#now = now;
  }

  async createIndex(keys, options = {}) {
    const fields = Object.keys(keys);
    if (fields.length !== 1) {
      // a compound index only makes a real database faster; there is nothing to enforce here
      if (options.unique || options.expireAfterSeconds !== undefined) throw new Error('memoryDb: unique and TTL indexes must be on one field');
      return options.name ?? fields.map((f) => `${f}_1`).join('_');
    }
    const [field] = fields;
    if (options.expireAfterSeconds !== undefined) {
      if (options.expireAfterSeconds !== 0) throw new Error('memoryDb: TTL indexes with a delay are not supported');
      this.#ttlFields.push(field);
    }
    if (options.unique) {
      const partial = options.partialFilterExpression;
      this.#unique.push({ field, name: options.name ?? field, applies: (doc) => doc[field] !== undefined && doc[field] !== null && (!partial || matches(doc, partial)) });
    }
    return options.name ?? `${field}_1`;
  }

  #sweep() {
    const now = this.#now();
    if (!this.#ttlFields.length || now - this.#lastSweep < 250) return;
    this.#lastSweep = now;
    for (const [id, doc] of this.#docs) {
      if (this.#ttlFields.some((field) => doc[field] instanceof Date && doc[field].getTime() <= now)) this.#docs.delete(id);
    }
  }

  _select(filter, sort) {
    this.#sweep();
    const found = [...this.#docs.values()].filter((doc) => matches(doc, filter));
    if (sort) {
      const entries = Object.entries(sort);
      found.sort((a, b) => {
        for (const [field, direction] of entries) {
          const c = compare(a[field], b[field]);
          if (c) return c * direction;
          if (c === null && a[field] !== b[field]) return (a[field] === undefined ? -1 : 1) * direction; // missing sorts first, as in MongoDB
        }
        return 0;
      });
    }
    return found;
  }

  #checkUnique(candidate, ownId) {
    for (const index of this.#unique) {
      if (!index.applies(candidate)) continue;
      for (const other of this.#docs.values()) {
        if (other._id !== ownId && index.applies(other) && other[index.field] === candidate[index.field]) throw duplicateKeyError(index.name);
      }
    }
  }

  #store(doc, previousId) {
    if (previousId === undefined && this.#docs.has(doc._id)) throw duplicateKeyError('_id_');
    this.#checkUnique(doc, doc._id);
    this.#docs.set(doc._id, doc);
  }

  async insertOne(input) {
    this.#sweep();
    const doc = structuredClone(input);
    doc._id ??= randomId();
    this.#store(doc);
    return { acknowledged: true, insertedId: doc._id };
  }

  async findOne(filter = {}, options = {}) {
    const [first] = this._select(filter, options.sort);
    return first ? structuredClone(first) : null;
  }

  find(filter = {}) {
    return new Cursor(this, filter);
  }

  async countDocuments(filter = {}) {
    return this._select(filter, null).length;
  }

  #upsertBase(filter) {
    const base = {};
    for (const [key, condition] of Object.entries(filter)) {
      assertFlat(key);
      if (!isOperatorObject(condition)) base[key] = structuredClone(condition);
      else if ('$eq' in condition) base[key] = structuredClone(condition.$eq);
    }
    return base;
  }

  #update(filter, update, { upsert = false, many = false, sort = null } = {}) {
    const hits = this._select(filter, sort);
    const targets = many ? hits : hits.slice(0, 1);
    if (!targets.length) {
      if (!upsert) return { matched: [], inserted: null };
      const doc = this.#upsertBase(filter);
      applyUpdate(doc, update, true);
      doc._id ??= randomId();
      this.#store(doc);
      return { matched: [], inserted: doc, before: null };
    }
    const changed = [];
    for (const doc of targets) {
      const before = structuredClone(doc);
      const next = structuredClone(doc);
      applyUpdate(next, update, false);
      this.#checkUnique(next, next._id);
      this.#docs.set(next._id, next);
      changed.push({ before, after: next });
    }
    return { matched: changed, inserted: null };
  }

  async updateOne(filter, update, options = {}) {
    const r = this.#update(filter, update, { upsert: options.upsert });
    return { acknowledged: true, matchedCount: r.matched.length, modifiedCount: r.matched.length, upsertedCount: r.inserted ? 1 : 0, upsertedId: r.inserted?._id ?? null };
  }

  async updateMany(filter, update) {
    const r = this.#update(filter, update, { many: true });
    return { acknowledged: true, matchedCount: r.matched.length, modifiedCount: r.matched.length, upsertedCount: 0, upsertedId: null };
  }

  /** Like the driver's default (no result metadata): the document, or null. `returnDocument` is 'before' unless said otherwise, as in MongoDB. */
  async findOneAndUpdate(filter, update, options = {}) {
    const r = this.#update(filter, update, { upsert: options.upsert, sort: options.sort });
    const after = options.returnDocument === 'after';
    if (r.inserted) return after ? structuredClone(r.inserted) : null;
    if (!r.matched.length) return null;
    return structuredClone(after ? r.matched[0].after : r.matched[0].before);
  }

  async deleteOne(filter) {
    const [first] = this._select(filter, null);
    if (first) this.#docs.delete(first._id);
    return { acknowledged: true, deletedCount: first ? 1 : 0 };
  }

  async deleteMany(filter = {}) {
    const hits = this._select(filter, null);
    for (const doc of hits) this.#docs.delete(doc._id);
    return { acknowledged: true, deletedCount: hits.length };
  }

  get name() {
    return this.#name;
  }
}

/** @param {{now?: () => number}} [options] */
export function createMemoryDb({ now = Date.now } = {}) {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new MemoryCollection(name, now));
      return collections.get(name);
    },
  };
}
