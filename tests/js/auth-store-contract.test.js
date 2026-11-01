import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { createAuthDb, findAndUpdate, isDuplicateKey } from '../../server/auth/db.js';
import { randomId } from '../../server/auth/crypto.js';

// The calling surface the sign-in code needs from its database, checked against every store that has to provide it.
//
//   - the in-memory stand-in always runs;
//   - a real MongoDB runs too when AUTH_TEST_MONGODB_URI is set, in a throw-away database that is dropped afterwards:
//         AUTH_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm run test:js
//     (the studio's mongoose is used; nothing outside that one database is read or written).
// The production store has not been run against a live MongoDB by whoever wrote it: this file is how to do that in one command.

function contract(label, open) {
  describe(label, () => {
    let db;
    let close;
    test.before(async () => {
      ({ db, close } = await open());
    });
    test.after(async () => close?.());

    test('a duplicate _id is refused with MongoDB\'s duplicate-key code', async () => {
      const col = await db.col('hits');
      const _id = randomId();
      await col.insertOne({ _id, k: 'a', t: 1 });
      await assert.rejects(col.insertOne({ _id, k: 'b', t: 2 }), isDuplicateKey);
    });

    test('a unique index covers verified values only: any number of accounts may lack the field, no two may share it', async () => {
      const users = await db.col('users');
      const base = () => ({ _id: randomId(), ownerId: randomId(), createdAt: 1 });
      await users.insertOne({ ...base(), name: 'no email 1' });
      await users.insertOne({ ...base(), name: 'no email 2' });
      await users.insertOne({ ...base(), emailKey: 'a@x.com' });
      await assert.rejects(users.insertOne({ ...base(), emailKey: 'a@x.com' }), isDuplicateKey);
      const other = { ...base(), emailClaim: 'a@x.com' }; // an unproved claim is not unique
      await users.insertOne(other);
      await users.insertOne({ ...base(), emailClaim: 'a@x.com' });
      // moving a claim to a verified value that is taken must fail too
      await assert.rejects(users.updateOne({ _id: other._id }, { $set: { emailKey: 'a@x.com' }, $unset: { emailClaim: '' } }), isDuplicateKey);
      await users.insertOne({ ...base(), googleSub: 'sub-1' });
      await assert.rejects(users.insertOne({ ...base(), googleSub: 'sub-1' }), isDuplicateKey);
      const fresh = await users.updateOne({ _id: other._id }, { $set: { emailKey: 'b@x.com' }, $unset: { emailClaim: '' } });
      assert.equal(fresh.matchedCount, 1);
      const reread = await users.findOne({ _id: other._id });
      assert.equal(reread.emailKey, 'b@x.com');
      assert.equal('emailClaim' in reread, false, '$unset removes the field');
    });

    test('filters: equality, null matches a missing field, ranges only compare like with like, $ne / $in / $exists / $type', async () => {
      const col = await db.col('hits');
      const tag = randomId();
      const rows = [
        { k: tag, t: 1, kind: 'a', at: new Date(1000) },
        { k: tag, t: 2, kind: 'b', at: new Date(2000) },
        { k: tag, t: 3, kind: 'c' },
        { k: tag, t: 'three', kind: 'd' },
      ];
      for (const row of rows) await col.insertOne(row);
      const kinds = async (filter) => (await col.find({ k: tag, ...filter }).sort({ kind: 1 }).toArray()).map((d) => d.kind);
      assert.deepEqual(await kinds({}), ['a', 'b', 'c', 'd']);
      assert.deepEqual(await kinds({ t: { $gt: 1 } }), ['b', 'c'], 'a string is not greater than a number');
      assert.deepEqual(await kinds({ t: { $gte: 2, $lte: 3 } }), ['b', 'c']);
      assert.deepEqual(await kinds({ t: { $lt: 3 } }), ['a', 'b']);
      assert.deepEqual(await kinds({ at: { $gt: new Date(1500) } }), ['b']);
      assert.deepEqual(await kinds({ at: null }), ['c', 'd'], 'null matches a missing field');
      assert.deepEqual(await kinds({ at: { $exists: false } }), ['c', 'd']);
      assert.deepEqual(await kinds({ at: { $exists: true } }), ['a', 'b']);
      assert.deepEqual(await kinds({ kind: { $ne: 'a' } }), ['b', 'c', 'd']);
      assert.deepEqual(await kinds({ at: { $ne: new Date(1000) } }), ['b', 'c', 'd'], '$ne matches documents that lack the field');
      assert.deepEqual(await kinds({ kind: { $in: ['a', 'd', 'zzz'] } }), ['a', 'd']);
      assert.deepEqual(await kinds({ kind: { $nin: ['a', 'd'] } }), ['b', 'c']);
      assert.deepEqual(await kinds({ t: { $type: 'string' } }), ['d']);
      assert.equal(await col.countDocuments({ k: tag, t: { $type: 'number' } }), 3);
      assert.deepEqual((await col.find({ k: tag }).sort({ kind: -1 }).limit(2).toArray()).map((d) => d.kind), ['d', 'c'], 'sort and limit');
      assert.equal((await col.findOne({ k: tag }, { sort: { kind: -1 } })).kind, 'd');
      assert.equal(await col.findOne({ k: 'nothing-like-this' }), null);
    });

    test('updates: $set $unset $inc, upsert with $setOnInsert, and the counts they report', async () => {
      const col = await db.col('settings');
      const _id = randomId();
      const first = await col.updateOne({ _id }, { $set: { a: 1 }, $setOnInsert: { born: 'now' }, $inc: { n: 5 } }, { upsert: true });
      assert.equal(first.upsertedCount, 1);
      const second = await col.updateOne({ _id }, { $set: { a: 2 }, $setOnInsert: { born: 'again' }, $inc: { n: 5 } }, { upsert: true });
      assert.equal(second.upsertedCount, 0);
      assert.equal(second.matchedCount, 1);
      assert.deepEqual(await col.findOne({ _id }), { _id, a: 2, born: 'now', n: 10 });
      assert.equal((await col.updateOne({ _id: randomId() }, { $set: { a: 1 } })).matchedCount, 0, 'no upsert, no match');
      const many = await col.updateMany({ _id }, { $unset: { a: '' } });
      assert.equal(many.matchedCount, 1);
      assert.equal('a' in (await col.findOne({ _id })), false);
      assert.equal((await col.deleteOne({ _id })).deletedCount, 1);
      assert.equal((await col.deleteOne({ _id })).deletedCount, 0);
    });

    test('findOneAndUpdate: before / after, null when nothing matches, upsert, and the document only', async () => {
      const col = await db.col('settings');
      const _id = randomId();
      await col.insertOne({ _id, n: 1 });
      const before = await findAndUpdate(col, { _id }, { $inc: { n: 1 } });
      assert.equal(before.n, 1, 'returns the document as it was by default');
      const after = await findAndUpdate(col, { _id }, { $inc: { n: 1 } }, { returnDocument: 'after' });
      assert.equal(after.n, 3);
      assert.equal(await findAndUpdate(col, { _id, n: 99 }, { $set: { n: 0 } }, { returnDocument: 'after' }), null);
      const made = await findAndUpdate(col, { _id: randomId() }, { $set: { x: 1 } }, { upsert: true, returnDocument: 'after' });
      assert.equal(made.x, 1);
    });

    test('a conditional update is atomic: of 40 parallel "use this code once" calls exactly one wins', async () => {
      const col = await db.col('challenges');
      const _id = randomId();
      await col.insertOne({ _id, used: false, idKey: 'x', purpose: 'login', createdAt: 1 });
      const results = await Promise.all(Array.from({ length: 40 }, () => findAndUpdate(col, { _id, used: false }, { $set: { used: true } }, { returnDocument: 'after' })));
      assert.equal(results.filter(Boolean).length, 1);
    });

    test('an attempt counter with a ceiling is atomic: of 60 parallel guesses exactly 5 are let through', async () => {
      const col = await db.col('challenges');
      const _id = randomId();
      await col.insertOne({ _id, used: false, attempts: 0, idKey: 'y', purpose: 'login', createdAt: 1 });
      const results = await Promise.all(Array.from({ length: 60 }, () => findAndUpdate(col, { _id, used: false, attempts: { $lt: 5 } }, { $inc: { attempts: 1 } }, { returnDocument: 'after' })));
      assert.equal(results.filter(Boolean).length, 5);
      assert.equal((await col.findOne({ _id })).attempts, 5);
    });

    test('deleteMany reports how many it removed, and counting follows', async () => {
      const col = await db.col('hits');
      const k = randomId();
      for (let t = 0; t < 7; t += 1) await col.insertOne({ k, t });
      assert.equal(await col.countDocuments({ k }), 7);
      assert.equal((await col.deleteMany({ k, t: { $lt: 3 } })).deletedCount, 3);
      assert.equal(await col.countDocuments({ k }), 4);
      assert.equal((await col.deleteMany({ k })).deletedCount, 4);
    });

    test('dates survive a round trip, and are compared as dates', async () => {
      const col = await db.col('hits');
      const _id = randomId();
      const when = new Date(Date.now() + 86400000);
      await col.insertOne({ _id, k: 'date-test', t: 1, purgeAt: when });
      const got = await col.findOne({ _id });
      assert.ok(got.purgeAt instanceof Date);
      assert.equal(got.purgeAt.getTime(), when.getTime());
      assert.equal(await col.countDocuments({ _id, purgeAt: { $gt: new Date() } }), 1);
    });
  });
}

contract('in-memory store', async () => ({ db: createAuthDb({}) }));

const uri = process.env.AUTH_TEST_MONGODB_URI;
if (uri) {
  contract('real MongoDB (AUTH_TEST_MONGODB_URI)', async () => {
    const { default: mongoose } = await import('mongoose');
    const name = `terucon_authtest_${randomId().slice(0, 10)}`;
    const connection = await mongoose.createConnection(uri, { dbName: name, serverSelectionTimeoutMS: 5000 }).asPromise();
    // the store takes a mongoose-like object whose .connection has .readyState and .db
    const db = createAuthDb({ mongoose: { connection }, prefix: 'terucon_' });
    return {
      db,
      close: async () => {
        await connection.dropDatabase();
        await connection.close();
      },
    };
  });
} else {
  test('real MongoDB: skipped (set AUTH_TEST_MONGODB_URI to run the same checks against one)', { skip: true }, () => {});
}
