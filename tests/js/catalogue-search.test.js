import assert from 'node:assert/strict';
import http from 'node:http';
import test, { describe } from 'node:test';
import { StoreUnavailableError } from '../../server/catalogue/db.js';
import { startTestApp } from '../helpers/app.js';
import { createFakeSigner, makeJpeg, makePng, makeWebp, SEED_CATALOGUE, SEED_ITEM_IDS, SEED_RELEASE, seedCatalogue, startCatalogueApp } from '../helpers/fakeCatalogueModal.js';

// Catalogue search (targets C3, C4, C7, C5) through the real server: who may ask, what a search returns and how it is enriched, what is
// refused before Modal is asked anything. Modal is a local fake (tests/helpers/fakeCatalogueModal.js); the database is the in-memory stand-in.

const ids = SEED_ITEM_IDS;
const searches = (c) => c.fake.of('search').length;

describe('status', () => {
  test('anonymous and unfinished visitors are turned away like everywhere else', async () => {
    const c = await startCatalogueApp();
    try {
      const unfinished = await c.app.signIn({ finish: false });
      const anonymous = await c.status({ as: null });
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.json().error.reason, 'unauthorized');
      assert.equal(anonymous.headers['cache-control'], 'no-store');
      assert.equal((await c.status({ as: unfinished })).status, 403);
      for (const [path, body] of [['/api/catalogue/warm', {}], ['/api/catalogue/search-text', { text: 'oak' }]]) {
        assert.equal((await c.app.post(path, body)).status, 401, path);
        assert.equal((await c.app.post(path, body, unfinished.headers)).status, 403, path);
      }
      assert.equal((await c.photo(makeJpeg(), { as: null })).status, 401);
      assert.equal((await c.photo(makeJpeg(), { as: unfinished })).status, 403);
      assert.equal(searches(c), 0);
    } finally {
      await c.stop();
    }
  });

  test('not set up at all: enabled is false, the reason is named, and nothing else about the site changes', async () => {
    const app = await startTestApp();
    try {
      assert.deepEqual(app.app.locals.terucon.settings().warnings, [], 'an unconfigured catalogue is not a warning');
      const me = await app.signIn();
      const status = await app.get('/api/catalogue/status', me.headers);
      assert.equal(status.status, 200);
      assert.deepEqual(status.json(), { enabled: false, ready: false, reasons: ['modal-not-configured'], default: null, catalogues: [], limits: { maxPhotoBytes: 6 * 1024 * 1024, maxSide: 1024 }, profile: 'balanced' });
      for (const [method, path, body] of [['POST', '/api/catalogue/warm', {}], ['POST', '/api/catalogue/search-text', { text: 'oak' }]]) {
        const r = await app.request(path, { method, headers: me.headers, body });
        assert.equal(r.status, 503, path);
        assert.equal(r.json().error.reason, 'catalogue-off');
      }
      const photo = await app.request('/api/catalogue/search', { method: 'POST', headers: { ...me.headers, 'Content-Type': 'image/jpeg' }, body: makeJpeg() });
      assert.equal(photo.status, 503);
      assert.equal(photo.json().error.reason, 'catalogue-off');
      // the rest of the site is as it was
      const health = await app.get('/api/health');
      assert.deepEqual(Object.keys(health.json()), ['ok', 'version', 'studio', 'auth']);
      assert.equal((await app.get('/api/site')).status, 200);
      assert.equal((await app.get('/api/inspiration/status', me.headers)).status, 200);
      assert.equal((await app.get('/materials', me.headers)).status, 200);
    } finally {
      await app.stop();
    }
  });

  test('every state has its reason: off, no key, no signing key, database down, nothing live, ready', async () => {
    const off = await startCatalogueApp({ rawEnv: 'CATALOGUE=off\n' });
    try {
      assert.deepEqual((await off.status()).json().reasons, ['off']);
      assert.equal((await off.status()).json().enabled, false);
      assert.equal((await off.photo()).json().error.reason, 'catalogue-off');
    } finally {
      await off.stop();
    }

    const noKey = await startCatalogueApp({ env: { CATALOGUE_MODAL_KEY: '' } });
    try {
      assert.deepEqual((await noKey.status()).json().reasons, ['modal-not-configured']);
    } finally {
      await noKey.stop();
    }

    const noSigner = await startCatalogueApp({ signer: createFakeSigner({ ok: false }) });
    try {
      const s = (await noSigner.status()).json();
      assert.deepEqual([s.enabled, s.ready, s.reasons], [true, false, ['storage-not-configured']]);
      const r = await noSigner.photo();
      assert.equal(r.status, 503);
      assert.equal(r.json().error.reason, 'not-ready');
      assert.equal(searches(noSigner), 0);
    } finally {
      await noSigner.stop();
    }

    const down = { connected: () => false, kind: 'memory', ready: async () => { throw new StoreUnavailableError(); }, col: async () => { throw new StoreUnavailableError('The catalogue database is not connected.'); } };
    const noDb = await startCatalogueApp({ db: down });
    try {
      const s = (await noDb.status()).json();
      assert.deepEqual([s.enabled, s.ready, s.reasons, s.catalogues], [true, false, ['database-unavailable'], []]);
      const r = await noDb.photo();
      assert.equal(r.status, 503);
      assert.equal(r.json().error.reason, 'not-ready');
      assert.equal(searches(noDb), 0);
    } finally {
      await noDb.stop();
    }

    const empty = await startCatalogueApp({ seed: false });
    try {
      assert.deepEqual((await empty.status()).json().reasons, ['no-live-catalogue']);
      assert.equal((await empty.photo()).json().error.reason, 'no-live-catalogue');
      assert.equal((await empty.photo()).status, 503);
    } finally {
      await empty.stop();
    }

    const notLive = await startCatalogueApp({ seed: { live: false } });
    try {
      assert.deepEqual((await notLive.status()).json().reasons, ['no-live-catalogue']);
    } finally {
      await notLive.stop();
    }

    const ready = await startCatalogueApp({ seed: { hidden: [ids[0], ids[1]] } });
    try {
      const s = (await ready.status()).json();
      assert.deepEqual([s.enabled, s.ready, s.reasons, s.default, s.profile], [true, true, [], SEED_CATALOGUE, 'balanced']);
      assert.deepEqual(s.catalogues, [{ id: SEED_CATALOGUE, name: 'Demo materials', kind: 'materials', items: 10 }], 'hidden designs are not counted');
      assert.deepEqual(s.limits, { maxPhotoBytes: 6 * 1024 * 1024, maxSide: 1024 });
    } finally {
      await ready.stop();
    }
  });

  test('it is remembered for 10 seconds and follows .env at once', async () => {
    const clock = { t: 1_800_000_000_000 };
    const c = await startCatalogueApp({ seed: false, now: () => clock.t });
    try {
      assert.deepEqual((await c.status()).json().reasons, ['no-live-catalogue']);
      await seedCatalogue(c.db);
      assert.deepEqual((await c.status()).json().reasons, ['no-live-catalogue'], 'a catalogue that just went live is not seen for up to 10 seconds');
      clock.t += 11_000;
      assert.equal((await c.status()).json().ready, true);
      const before = c.reads.length;
      await c.status();
      await c.status();
      assert.equal(c.reads.length, before, 'cached: no database read');
      c.app.writeEnv(c.fake.env({ CATALOGUE: 'off' }));
      assert.deepEqual((await c.status()).json().reasons, ['off'], 'a changed .env is seen on the next request');
      c.app.writeEnv(c.fake.env({ CATALOGUE_SEARCH_PROFILE: 'full' }));
      assert.equal((await c.status()).json().profile, 'full');
    } finally {
      await c.stop();
    }
  });
});

describe('a photo search', () => {
  test('returns the catalogue items in Modal\'s order, with titles, signed pictures and raw scores', async () => {
    const c = await startCatalogueApp();
    try {
      const r = await c.photo(makeJpeg(), { query: 'k=4' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.headers['cache-control'], 'no-store');
      const body = r.json();
      assert.deepEqual([body.ok, body.catalogue, body.release, body.mode], [true, SEED_CATALOGUE, SEED_RELEASE, 'look']);
      assert.deepEqual(body.items.map((i) => i.itemId), ids.slice(0, 4));
      assert.deepEqual(body.items.map((i) => i.rank), [1, 2, 3, 4]);
      // title rule: the admin's label, else the AI's description (marked), else "Catalogue page N"
      assert.deepEqual(body.items.slice(0, 3).map((i) => [i.title, i.titleSource]), [['Emperor Dark', 'label'], ['Warm oak laminate', 'caption'], ['Catalogue page 3', 'page']]);
      const first = body.items[0];
      assert.deepEqual([first.productId, first.productIdSource, first.catalogue], ['SB804', 'admin', SEED_CATALOGUE]);
      assert.deepEqual(first.source, { name: 'Superbond colour image.pdf', page: 1 });
      assert.deepEqual(first.dominantHex, ['#8a6a4a', '#d9c3a0']);
      assert.equal(first.image.thumbUrl, `https://signed.example/get/thumbs/${SEED_CATALOGUE}/${ids[0]}.jpg?expires=4500&sig=fake`);
      assert.equal(first.image.fullUrl, `https://signed.example/get/crops/${SEED_CATALOGUE}/${ids[0]}.png?expires=4500&sig=fake`);
      assert.deepEqual([first.image.width, first.image.height], [541, 812], 'the crop\'s size');
      assert.deepEqual(first.scores.signals.dino_image, { sim: 0.71, rank: 1 });
      assert.ok(first.scores.final > body.items[3].scores.final, 'best first');
      assert.deepEqual(first.attributes, {});
      assert.deepEqual(Object.keys(body.query).sort(), ['dominantHex', 'preprocessing', 'profile', 'signals', 'timingsMs']);
      assert.deepEqual([body.query.preprocessing, body.query.profile, body.query.signals], ['center_crop', 'balanced', ['dino_image', 'siglip_image', 'color_image']]);
      assert.equal(typeof body.query.timingsMs.total, 'number');
      assert.deepEqual(body.warnings, []);
      assert.equal(JSON.stringify(body).includes('%'), false, 'a score is never turned into a percentage');
      assert.ok(!('rrfScore' in first) && !('linearScore' in first));
      // only crops and thumbs are ever signed, with the stable window and one hour of life
      assert.ok(c.signer.calls.every((s) => /^(crops|thumbs)\//.test(s.key) && s.expiresS === 4500 && s.stableS === 900));
    } finally {
      await c.stop();
    }
  });

  test('Modal is asked for k + 15 results of the live release, with the settings\' profile and what the visitor chose', async () => {
    const c = await startCatalogueApp({ rawEnv: 'CATALOGUE_SEARCH_PROFILE=balanced\n' });
    try {
      assert.equal((await c.photo(makeJpeg(), { query: 'k=3' })).status, 200);
      assert.equal((await c.photo(makeJpeg(), { query: 'k=20&mode=colour&category=laminate,%20paint&finish=matte&box=0.1,0.2,0.6,0.7' })).status, 200);
      assert.equal((await c.photo(makeJpeg(), { query: 'point=0.5,0.25&radius=0.2' })).status, 200);
      assert.equal((await c.photo(makeJpeg())).status, 200);
      const [a, b, p, d] = c.fake.of('search');
      assert.deepEqual(a.query, { catalogue: SEED_CATALOGUE, release: SEED_RELEASE, mode: 'look', profile: 'balanced', k: '18' });
      assert.deepEqual(b.query, { catalogue: SEED_CATALOGUE, release: SEED_RELEASE, mode: 'colour', profile: 'balanced', k: '35', category: 'laminate,paint', finish: 'matte', box: '0.1,0.2,0.6,0.7' });
      assert.deepEqual([p.query.point, p.query.radius, p.query.box], ['0.5,0.25', '0.2', undefined]);
      assert.equal(d.query.k, '23', 'the default is 8 results');
      assert.ok(c.fake.requests.every((r) => r.authorized && r.contentType === 'image/jpeg'));
      const colour = await c.photo(makeJpeg(), { query: 'mode=colour&k=1' });
      assert.deepEqual(Object.keys(colour.json().items[0].scores.signals), ['color_image']);
    } finally {
      await c.stop();
    }
  });

  test('a patch somebody already cut out is searched as it is: Modal gets the box of the whole picture, never the whole-photo path', async () => {
    const c = await startCatalogueApp();
    try {
      assert.equal((await c.photo(makeJpeg({ width: 300, height: 220 }), { query: 'patch=1&k=3' })).status, 200);
      assert.equal((await c.photo(makeJpeg(), { query: 'patch=true&mode=colour' })).status, 200);
      assert.equal((await c.photo(makeJpeg(), { query: 'patch=0' })).status, 200);
      assert.equal((await c.photo(makeJpeg())).status, 200);
      assert.equal((await c.photo(makeJpeg(), { query: 'point=0.5,0.25&patch=0' })).status, 200);
      assert.equal((await c.photo(makeJpeg(), { query: 'box=0.1,0.2,0.6,0.7' })).status, 200);
      const [asPatch, asPatchColour, no, plain, pointed, boxed] = c.fake.of('search');
      assert.deepEqual([asPatch.query.box, asPatchColour.query.box], ['0,0,1,1', '0,0,1,1']);
      assert.equal(asPatchColour.query.mode, 'colour');
      assert.deepEqual([no.query.box, plain.query.box, pointed.query.box], [undefined, undefined, undefined], 'patch=0 and no patch at all are the whole-photo path, as before');
      assert.deepEqual([pointed.query.point, boxed.query.box], ['0.5,0.25', '0.1,0.2,0.6,0.7'], 'a point or a box of its own is passed on untouched');
      assert.ok(!('patch' in asPatch.query), 'the word "patch" is ours: Modal is only ever told the box');
      assert.equal((await c.photo(makeJpeg(), { query: 'patch=1' })).json().query.preprocessing, 'region');
    } finally {
      await c.stop();
    }
  });

  test('"patch" must be 1 or 0, and cannot be given together with a point or a box', async () => {
    const c = await startCatalogueApp();
    try {
      for (const query of ['patch=yes', 'patch=2', 'patch=1&patch=0', 'patch=1&point=0.5,0.5', 'patch=1&box=0.1,0.1,0.9,0.9']) {
        const r = await c.photo(makeJpeg(), { query });
        assert.equal(r.status, 400, query);
        assert.equal(r.json().error.reason, 'bad-request', query);
      }
      assert.equal(searches(c), 0, 'nothing reached Modal');
    } finally {
      await c.stop();
    }
  });

  test('a design that has its card picture shows that, not the page thumbnail with its margin and label', async () => {
    const card = (id) => ({ shopImage: { key: `cards/${SEED_CATALOGUE}/${id}.jpg`, width: 800, height: 1220, bytes: 90000, sha256: 'ab'.repeat(32) } });
    const c = await startCatalogueApp({ seed: { overrides: { [ids[0]]: card(ids[0]), [ids[2]]: { shopImage: { key: '../crops/evil.png', width: 800, height: 1220 } } } } });
    try {
      const body = (await c.photo(makeJpeg(), { query: 'k=3' })).json();
      const [first, second, third] = body.items;
      assert.equal(first.image.thumbUrl, `https://signed.example/get/cards/${SEED_CATALOGUE}/${ids[0]}.jpg?expires=4500&sig=fake`);
      assert.deepEqual([first.image.width, first.image.height], [800, 1220], 'the picture shown, so the card keeps its shape');
      assert.equal(first.image.fullUrl, `https://signed.example/get/crops/${SEED_CATALOGUE}/${ids[0]}.png?expires=4500&sig=fake`, 'the link to the full page is still the page');
      assert.equal(second.image.thumbUrl, `https://signed.example/get/thumbs/${SEED_CATALOGUE}/${ids[1]}.jpg?expires=4500&sig=fake`, 'no card picture: the thumbnail, as before');
      assert.deepEqual([second.image.width, second.image.height], [541, 812]);
      assert.equal(third.image.thumbUrl, `https://signed.example/get/thumbs/${SEED_CATALOGUE}/${ids[2]}.jpg?expires=4500&sig=fake`, 'an unsafe key is never signed: the thumbnail');
      assert.ok(c.signer.calls.every((s) => /^(crops|thumbs|cards)\//.test(s.key) && !s.key.includes('..')));
    } finally {
      await c.stop();
    }
  });

  test('designs an admin has hidden are dropped, the order is kept and the list is trimmed to k', async () => {
    const c = await startCatalogueApp({ seed: { hidden: [ids[1], ids[2]] } });
    try {
      const body = (await c.photo(makeJpeg(), { query: 'k=3' })).json();
      assert.deepEqual(body.items.map((i) => i.itemId), [ids[0], ids[3], ids[4]], 'hidden designs are not shown and the page is not left short');
      assert.deepEqual(body.items.map((i) => i.rank), [1, 2, 3], 'ranks count what is shown');
      assert.equal(c.fake.of('search')[0].query.k, '18', 'that is what the extra 15 results are for');
      // an edit shows at once: nothing about an item is remembered between searches
      const items = await c.db.col('catalogue_items');
      await items.updateOne({ _id: `${SEED_CATALOGUE}|${ids[0]}` }, { $set: { label: 'Renamed today' } });
      assert.equal((await c.photo(makeJpeg(), { query: 'k=1' })).json().items[0].title, 'Renamed today');
      await items.updateOne({ _id: `${SEED_CATALOGUE}|${ids[0]}` }, { $set: { status: 'hidden' } });
      assert.equal((await c.photo(makeJpeg(), { query: 'k=1' })).json().items[0].itemId, ids[3]);
    } finally {
      await c.stop();
    }
  });

  test('what Modal returns but the database does not know is skipped, and counted in the log', async () => {
    const c = await startCatalogueApp();
    try {
      c.fake.setItemIds([ids[0], 'ffffffffffff-p0099-i00', 'not an id!', ids[1], '../../etc/passwd', ids[2]]);
      const body = (await c.photo(makeJpeg(), { query: 'k=5' })).json();
      assert.deepEqual(body.items.map((i) => i.itemId), [ids[0], ids[1], ids[2]]);
      assert.match(c.app.log.lines.join('\n'), /3 shown, 0 hidden, 3 unknown to the database/);
    } finally {
      await c.stop();
    }
  });

  test('every database read has a projection and the items come from one query', async () => {
    const c = await startCatalogueApp();
    try {
      c.reads.length = 0;
      await c.photo(makeJpeg(), { query: 'k=5' });
      assert.ok(c.reads.length >= 2);
      for (const read of c.reads) assert.ok(read.options?.projection, `${read.op} ${read.collection} has a projection`);
      const itemReads = c.reads.filter((r) => r.collection === 'catalogue_items');
      assert.equal(itemReads.length, 1);
      assert.deepEqual(Object.keys(itemReads[0].filter), ['_id']);
      assert.equal(c.fake.of('search')[0].query.k, '20');
      assert.equal(itemReads[0].filter._id.$in.length, 12, 'every id Modal returned (the fake has twelve) is read in the one query');
      assert.ok(!('description' in itemReads[0].options.projection) && !('source' in itemReads[0].options.projection), 'only what a result shows');
      // the catalogue's pointer is looked up with three fields and remembered, so a second search does not read it again
      const pointer = c.reads.find((r) => r.collection === 'catalogues' && r.op === 'findOne');
      assert.deepEqual(Object.keys(pointer.options.projection).sort(), ['activeRelease', 'kind', 'name']);
      c.reads.length = 0;
      await c.photo(makeJpeg(), { query: 'k=5' });
      assert.equal(c.reads.filter((r) => r.collection === 'catalogues').length, 0);
    } finally {
      await c.stop();
    }
  });

  test('a named catalogue is searched; an unknown one is not; the default prefers materials', async () => {
    const c = await startCatalogueApp();
    try {
      await seedCatalogue(c.db, { catalogue: 'paint-shades', name: 'Paint shades', kind: 'paint', release: 'rel-20261102120000-def456', ids: ['aaaaaaaaaaaa-p0001-i00'], createdAt: 1_792_000_000_000 });
      c.app.writeEnv(c.fake.env({ CATALOGUE_SEARCH_PROFILE: 'fast' })); // a changed .env also makes the 10-second memory start afresh
      const status = (await c.status()).json();
      assert.deepEqual(status.catalogues.map((x) => x.id), ['paint-shades', SEED_CATALOGUE], 'oldest first');
      assert.equal(status.default, SEED_CATALOGUE, 'the default is the first materials catalogue, not just the oldest');
      const paint = (await c.photo(makeJpeg(), { query: 'catalogue=paint-shades&k=1' })).json();
      assert.deepEqual([paint.catalogue, paint.release], ['paint-shades', 'rel-20261102120000-def456']);
      assert.equal(paint.items.length, 0, 'the fake answers with ids of the other catalogue: unknown here, skipped');
      const missing = await c.photo(makeJpeg(), { query: 'catalogue=nope-nothing' });
      assert.equal(missing.status, 404);
      assert.equal(missing.json().error.reason, 'no-live-catalogue');
    } finally {
      await c.stop();
    }
  });

  test('png and webp photos are accepted as they are', async () => {
    const c = await startCatalogueApp();
    try {
      assert.equal((await c.photo(makePng(), { type: 'image/png' })).status, 200);
      assert.equal((await c.photo(makeWebp(), { type: 'image/webp' })).status, 200);
      assert.deepEqual(c.fake.of('search').map((r) => r.contentType), ['image/png', 'image/webp']);
    } finally {
      await c.stop();
    }
  });
});

describe('a text search', () => {
  test('goes to Modal as JSON and comes back the same way a photo search does', async () => {
    const c = await startCatalogueApp();
    try {
      const r = await c.text({ text: '  warm   oak\twith a satin finish ', k: 3, category: ['laminate'], finish: 'matte, satin' });
      assert.equal(r.status, 200, r.text);
      const body = r.json();
      assert.deepEqual(body.items.map((i) => i.itemId), ids.slice(0, 3));
      assert.deepEqual([body.query.preprocessing, body.query.signals], ['text', ['siglip_text', 'text_query']]);
      const sent = c.fake.of('search-text')[0];
      assert.deepEqual(sent.json, { catalogue: SEED_CATALOGUE, release: SEED_RELEASE, text: 'warm oak with a satin finish', k: 18, category: 'laminate', finish: 'matte,satin' });
      assert.equal(sent.contentType, 'application/json');
    } finally {
      await c.stop();
    }
  });

  test('the text and the numbers are checked first; Modal is not asked about nonsense', async () => {
    const c = await startCatalogueApp();
    try {
      const bad = [{}, { text: '' }, { text: '   ' }, { text: 7 }, { text: 'x'.repeat(301) }, { text: 'oak', k: 0 }, { text: 'oak', k: 21 }, { text: 'oak', k: '5' }, { text: 'oak', catalogue: 'NOT A SLUG' }, { text: 'oak', category: { $ne: 1 } }, { text: 'oak', finish: ['<b>'] }, []];
      for (const body of bad) {
        const r = await c.text(body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.json().error.reason, 'bad-request');
      }
      assert.equal((await c.app.post('/api/catalogue/search-text', 'text=oak', { ...c.me.headers, 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await c.app.request('/api/catalogue/search-text', { method: 'POST', headers: { ...c.me.headers, 'Content-Type': 'application/json' }, body: '"oak"' })).status, 400, 'a JSON string is not a query');
      const big = await c.app.request('/api/catalogue/search-text', { method: 'POST', headers: { ...c.me.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(5000) }) });
      assert.equal(big.status, 413);
      assert.equal(big.json().error.reason, 'too-large');
      assert.equal((await c.app.request('/api/catalogue/search-text', { method: 'POST', headers: { ...c.me.headers, 'Content-Type': 'application/json' }, body: '{"text":' })).status, 400);
      assert.equal(c.fake.of('search-text').length, 0);
      const control = await c.text({ text: 'oak\u0000‮ wood' });
      assert.equal(control.status, 200);
      assert.equal(c.fake.of('search-text')[0].json.text, 'oak wood', 'control characters are stripped');
    } finally {
      await c.stop();
    }
  });
});

describe('what is refused before Modal is asked anything', () => {
  test('a body that is not a usable photo', async () => {
    const c = await startCatalogueApp();
    try {
      const cases = [
        ['text with a picture\'s name', Buffer.from('this is not a picture at all, it is just a long enough sentence'), 'image/jpeg', 400, 'bad-image'],
        ['an empty body', Buffer.alloc(0), 'image/jpeg', 400, 'bad-image'],
        ['a GIF', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(30)]), 'image/jpeg', 400, 'bad-image'],
        ['a PNG sent as a JPEG', makePng(), 'image/jpeg', 400, 'bad-image'],
        ['a JPEG cut off in its header', makeJpeg().subarray(0, 14), 'image/jpeg', 400, 'bad-image'],
        ['a JPEG cut off in its data', makeJpeg({ cut: true }), 'image/jpeg', 400, 'bad-image'],
        ['a PNG cut off', makePng({ cut: true }), 'image/png', 400, 'bad-image'],
        ['a WebP cut off', makeWebp({ cut: true }), 'image/webp', 400, 'bad-image'],
        ['a JPEG too many pixels wide', makeJpeg({ width: 20000, height: 100 }), 'image/jpeg', 413, 'too-large'],
        ['a PNG of a billion pixels', makePng({ width: 30000, height: 30000 }), 'image/png', 413, 'too-large'],
      ];
      for (const [what, body, type, status, reason] of cases) {
        const r = await c.photo(body, { type });
        assert.equal(r.status, status, what);
        assert.equal(r.json().error.reason, reason, what);
      }
      assert.equal(searches(c), 0, 'not one of them reached Modal');
      assert.equal(c.fake.requests.length, 0);
    } finally {
      await c.stop();
    }
  });

  test('a wrong content type: the guards stop other types, the route stops JSON', async () => {
    const c = await startCatalogueApp();
    try {
      for (const type of ['text/plain', 'image/gif', 'image/avif', 'application/octet-stream', 'image/svg+xml', 'multipart/form-data']) {
        const r = await c.photo(makeJpeg(), { type });
        assert.equal(r.status, 415, type);
      }
      const none = await c.app.request('/api/catalogue/search', { method: 'POST', headers: c.me.headers, body: makeJpeg() });
      assert.equal(none.status, 415, 'no content type at all');
      const json = await c.photo(Buffer.from('{"x":1}'), { type: 'application/json' });
      assert.equal(json.status, 415);
      assert.equal(json.json().error.reason, 'bad-request');
      assert.equal(c.fake.requests.length, 0);
    } finally {
      await c.stop();
    }
  });

  test('a body over 6 MB is refused at its first word, or aborted as it arrives, and Modal never hears of it', async () => {
    const c = await startCatalogueApp();
    try {
      const declared = await c.photo(Buffer.concat([makeJpeg(), Buffer.alloc(7 * 1024 * 1024)]));
      assert.equal(declared.status, 413);
      assert.equal(declared.json().error.reason, 'too-large');
      // no Content-Length: the bytes are counted as they come
      const chunked = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: c.app.port, method: 'POST', path: '/api/catalogue/search', headers: { Host: `localhost:${c.app.port}`, 'Transfer-Encoding': 'chunked', 'Content-Type': 'image/jpeg', ...c.me.headers } }, (res) => {
          const parts = [];
          res.on('data', (d) => parts.push(d));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString()) }));
        });
        req.on('error', reject);
        const piece = Buffer.alloc(64 * 1024, 0x41);
        let sent = 0;
        const pump = () => {
          while (sent < 7 * 1024 * 1024) {
            sent += piece.length;
            if (!req.write(piece)) return void req.once('drain', pump);
          }
          req.end();
        };
        pump();
      });
      assert.equal(chunked.status, 413);
      assert.equal(chunked.body.error.reason, 'too-large');
      assert.equal(c.fake.requests.length, 0, 'the fake saw nothing');
      assert.equal((await c.photo(makeJpeg())).status, 200, 'and the server is still fine');
    } finally {
      await c.stop();
    }
  });

  test('parameters are strict: one value each, in range, in the right shape', async () => {
    const c = await startCatalogueApp();
    try {
      const bad = ['k=0', 'k=21', 'k=-1', 'k=abc', 'k=1.5', 'k=1&k=2', 'mode=other', 'mode=look&mode=colour', 'point=2,0.5', 'point=0.5', 'point=a,b', 'point=0.5,0.5,0.5', 'radius=0.2', 'point=0.5,0.5&radius=0.9', 'point=0.5,0.5&radius=0', 'point=0.5,0.5&box=0,0,1,1', 'box=0.5,0.5,0.4,0.9', 'box=0,0,1', 'box=0,0,0.005,1', 'catalogue=UPPER', 'catalogue=a', 'catalogue=a/../b', `category=${Array.from({ length: 9 }, (_, i) => `w${i}`).join(',')}`, 'category=%3Cb%3E', 'finish=a;b'];
      for (const query of bad) {
        const r = await c.photo(makeJpeg(), { query });
        assert.equal(r.status, 400, query);
        assert.equal(r.json().error.reason, 'bad-request', query);
      }
      assert.equal(searches(c), 0);
      const ok = await c.photo(makeJpeg(), { query: 'unknown=whatever&k=2&catalogue=' });
      assert.equal(ok.status, 200, 'names we do not know are ignored, an empty value is no value');
      assert.deepEqual(Object.keys(c.fake.of('search')[0].query).sort(), ['catalogue', 'k', 'mode', 'profile', 'release']);
    } finally {
      await c.stop();
    }
  });
});

describe('logs', () => {
  test('no photo, key, address of a picture or session appears in any line the server writes', async () => {
    const proxy = { key: 'proxy-key-abcdefghij', secret: 'proxy-secret-klmnopqrst' };
    const c = await startCatalogueApp({ modal: { proxy } });
    try {
      const marker = 'PHOTO-MARKER-XYZ-0123456789';
      const photo = Buffer.concat([makeJpeg({ cut: true }), Buffer.from(marker), Buffer.from([0xff, 0xd9])]);
      assert.equal((await c.photo(photo)).status, 200);
      assert.equal((await c.text({ text: 'a secret sentence about oak' })).status, 200);
      c.fake.next('search', { status: 401, reason: 'unauthorized' });
      assert.equal((await c.photo(photo)).status, 503);
      await c.photo(makeJpeg({ cut: true }));
      const logs = c.app.log.lines.join('\n');
      const cookie = c.me.cookie.split('=')[1];
      for (const secret of [marker, Buffer.from(marker).toString('base64'), Buffer.from(marker).toString('hex'), 'a secret sentence about oak', c.fake.key, proxy.key, proxy.secret, cookie, 'signed.example', 'sig=fake']) assert.equal(logs.includes(secret), false, `the logs must not contain ${secret.slice(0, 12)}...`);
      assert.match(logs, /catalogue  search demo-materials/);
      assert.match(logs, /refused our key/);
    } finally {
      await c.stop();
    }
  });
});
