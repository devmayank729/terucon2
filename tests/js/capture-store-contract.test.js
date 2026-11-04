import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { randomId } from '../../server/auth/crypto.js';
import { CAPTURE_DEFAULTS } from '../../server/capture/config.js';
import { createCaptureDb, INDEXES, isDuplicateKey } from '../../server/capture/db.js';
import { createCaptureService } from '../../server/capture/service.js';
import { makeJpeg } from '../helpers/fakeCatalogueModal.js';

// What "capture from a phone" needs from its database, checked against every store that has to provide it.
//
//   - the in-memory stand-in always runs;
//   - a real MongoDB runs too when CAPTURE_TEST_MONGODB_URI is set, in a throw-away database that is dropped afterwards:
//         CAPTURE_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm run test:js
//     (the studio's mongoose is used; nothing outside that one database is read or written).
// The production store has NOT been run against a live MongoDB by whoever wrote it: this file is how to do that in one command. The things that
// differ between the stand-in and a real MongoDB are the ones that matter here: a unique index on the link's key, "$lt" in the filter of the photo
// counter (what makes the limit hold when uploads arrive at once), the duplicate-key code on a photo's _id, "$in" deletes, and the TTL index on purgeAt.

const CONFIG = { ...CAPTURE_DEFAULTS, maxPhotos: 3, publicUrl: 'https://capture.example', whatsappToken: '' };
const NO_WHATSAPP = { state: () => ({ cloud: false, photoAlerts: false, linkMessages: false }), async sendTemplate() { throw new Error('not used'); } };
const JPEG = makeJpeg({ width: 640, height: 480, extra: 2000 });
const hex32 = () => randomId();

function contract(label, open) {
  describe(label, () => {
    let db;
    let close;
    let service;
    test.before(async () => {
      ({ db, close } = await open());
      service = createCaptureService({ db, config: () => CONFIG, whatsapp: NO_WHATSAPP, log: { info() {}, warn() {} } });
    });
    test.after(async () => {
      service?.close();
      await close?.();
    });

    const link = async (owner = hex32()) => {
      const made = await service.createSession(owner, { service: 'studio', note: '', requesterName: 'Mayank Rohilla' });
      const token = made.session.link.split('#')[1];
      await service.saveCapturer(token, { name: 'Ravi Kumar' }, '10.0.0.1');
      return { owner, id: made.session.id, token };
    };
    const send = (token, cid = hex32()) => service.addPhoto(token, { cid, meta: '', bytes: JPEG }, '10.0.0.1');

    test('the key of a link is unique: a second link cannot have it, and an unknown key finds nothing', async () => {
      const col = await db.col('capture_sessions');
      const a = await link();
      const doc = await col.findOne({ _id: a.id });
      await assert.rejects(col.insertOne({ ...doc, _id: hex32() }), isDuplicateKey);
      await assert.rejects(service.info('A'.repeat(32), '10.0.0.2'), (e) => e.status === 404);
    });

    test('a photo\'s id is unique: the same photo twice is one photo; six at once are one photo and one place used', async () => {
      const a = await link();
      const cid = hex32();
      const first = await send(a.token, cid);
      assert.equal(first.duplicate, false);
      assert.equal((await send(a.token, cid)).duplicate, true);
      const cid2 = hex32();
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => send(a.token, cid2)));
      for (const r of results) assert.ok(r.status === 'fulfilled' || r.reason?.reason === 'in-progress', String(r.reason?.message));
      const inbox = await service.inbox(a.owner, {});
      assert.equal(inbox.photos.length, 2, 'two different photos');
      assert.equal(inbox.sessions.find((s) => s.id === a.id).photoCount, 2, 'two places used, not eight');
    });

    test('a picture a crash left behind does not block its photo for ever; one that is still being written is respected', async () => {
      const a = await link();
      const files = await db.col('capture_files');
      const purgeAt = new Date(Date.now() + 3600_000);
      // still being written (made a moment ago, no photo record yet): the second copy is told to come back
      const young = hex32();
      await files.insertOne({ _id: `${a.id}_${young}`, data: 'AAAA', createdAt: Date.now(), purgeAt });
      await assert.rejects(send(a.token, young), (e) => e.reason === 'in-progress');
      // left behind long ago: taken over, and the photo is stored with the right bytes
      const old = hex32();
      await files.insertOne({ _id: `${a.id}_${old}`, data: 'AAAA', createdAt: Date.now() - 5 * 60_000, purgeAt });
      const stored = await send(a.token, old);
      assert.equal(stored.duplicate, false);
      assert.deepEqual((await service.photoFile(a.owner, stored.photo.id)).bytes, JPEG);
      assert.equal((await service.inbox(a.owner, {})).sessions.find((s) => s.id === a.id).photoCount, 1, 'one place used');
    });

    test('the limit holds when many photos arrive at once: exactly maxPhotos are kept, the rest are told the link is full, and the counter is right', async () => {
      const a = await link();
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => send(a.token)));
      const kept = results.filter((r) => r.status === 'fulfilled');
      const full = results.filter((r) => r.status === 'rejected' && r.reason?.reason === 'full');
      assert.equal(kept.length, 3);
      assert.equal(kept.length + full.length, 10, 'every other upload was refused as full: ' + results.map((r) => r.reason?.reason ?? 'ok').join());
      const inbox = await service.inbox(a.owner, {});
      assert.equal(inbox.photos.length, 3);
      assert.equal(inbox.sessions.find((s) => s.id === a.id).photoCount, 3);
      assert.equal(await (await db.col('capture_files')).countDocuments({ _id: { $in: inbox.photos.map((p) => p.id) } }), 3, 'each photo has its picture');
    });

    test('a picture comes back byte for byte (stored as text), and only for its owner', async () => {
      const a = await link();
      const photo = (await send(a.token)).photo;
      const got = await service.photoFile(a.owner, photo.id);
      assert.deepEqual(got.bytes, JPEG);
      await assert.rejects(service.photoFile(hex32(), photo.id), (e) => e.status === 404);
    });

    test('the inbox: newest links first, photos in order, and "at or after" returns the newest one again (the page keeps the ids it has shown)', async () => {
      const owner = hex32();
      const a = await link(owner);
      const p1 = (await send(a.token)).photo;
      await new Promise((r) => setTimeout(r, 5));
      const p2 = (await send(a.token)).photo;
      const all = await service.inbox(owner, {});
      assert.deepEqual(all.photos.map((p) => p.id), [p1.id, p2.id]);
      const after = await service.inbox(owner, { after: p2.createdAt });
      assert.ok(after.photos.some((p) => p.id === p2.id) && !after.photos.some((p) => p.id === p1.id));
    });

    test('deleting: one photo (and its picture), a link with its photos, everything of an owner', async () => {
      const owner = hex32();
      const a = await link(owner);
      const b = await link(owner);
      const p1 = (await send(a.token)).photo;
      const p2 = (await send(a.token)).photo;
      const p3 = (await send(b.token)).photo;
      const files = await db.col('capture_files');
      await service.deletePhoto(owner, p1.id);
      assert.equal(await files.findOne({ _id: p1.id }), null);
      assert.equal((await service.deleteSession(owner, a.id)).deleted, 1);
      assert.equal(await files.findOne({ _id: p2.id }), null);
      assert.ok(await files.findOne({ _id: p3.id }), 'the other link\'s photo is untouched');
      assert.equal(await service.deleteAllOf(owner), 1);
      assert.equal(await files.findOne({ _id: p3.id }), null);
      assert.equal((await service.inbox(owner, {})).sessions.length, 0);
    });

    test('every record carries purgeAt, and the TTL index that makes the database delete it exists', async () => {
      const a = await link();
      const photo = (await send(a.token)).photo;
      for (const [name, id] of [['capture_sessions', a.id], ['capture_photos', photo.id], ['capture_files', photo.id]]) {
        const doc = await (await db.col(name)).findOne({ _id: id });
        assert.ok(doc.purgeAt instanceof Date && doc.purgeAt.getTime() > Date.now() + 29 * 24 * 3600_000, `${name}: purgeAt is a date about ${CONFIG.keepDays} days away`);
      }
      assert.ok(INDEXES.capture_sessions.some((i) => i.options?.expireAfterSeconds === 0 && i.keys.purgeAt), 'the TTL is declared');
      const col = await db.col('capture_photos');
      if (typeof col.indexes === 'function') {
        // only a real MongoDB can list its indexes: the TTL must really be there
        const indexes = await col.indexes();
        assert.ok(indexes.some((i) => i.key?.purgeAt === 1 && i.expireAfterSeconds === 0), 'the database has the TTL index: ' + JSON.stringify(indexes.map((i) => i.name)));
      }
    });
  });
}

contract('in-memory store', async () => ({ db: createCaptureDb({}) }));

const uri = process.env.CAPTURE_TEST_MONGODB_URI;
if (uri) {
  contract('real MongoDB (CAPTURE_TEST_MONGODB_URI)', async () => {
    const { default: mongoose } = await import('mongoose');
    const name = `terucon_capturetest_${randomId().slice(0, 10)}`;
    const connection = await mongoose.createConnection(uri, { dbName: name, serverSelectionTimeoutMS: 5000 }).asPromise();
    const db = createCaptureDb({ mongoose: { connection }, prefix: 'terucon_' });
    return {
      db,
      close: async () => {
        await connection.dropDatabase();
        await connection.close();
      },
    };
  });
} else {
  test('real MongoDB: skipped (set CAPTURE_TEST_MONGODB_URI to run the same checks against one)', { skip: true }, () => {});
}
