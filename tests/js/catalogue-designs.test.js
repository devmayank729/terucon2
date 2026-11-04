import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { createDesigns, readStudio, slugOf } from '../../server/catalogue/designs.js';
import { createFakeSigner, makeJpeg, makeMemoryDb, seedCatalogue, startCatalogueApp } from '../helpers/fakeCatalogueModal.js';

// The designs of the catalogue as products with their pictures (targets A1, C1): the data from MongoDB (here the in-memory stand-in), the pictures from
// Cloud Storage (here a fake fetch that records what it was asked), through the real server. Nothing is a file of the server.

const GOOD = { look: 'A dark brown surface with a web of fine off-white veins.', colours: ['espresso brown', 'warm off-white'], pattern: 'marble-like veining', grain: 'random', scale: 'medium', sheen: 'gloss', relief: 'flat', render: 'Paint a dark brown ground with a dense web of fine, branching off-white veins.', model: 'gemini-test', generatedAt: 1793000000000 };
const IDS = ['a1b2c3d4e5f6-p0001-i00', 'a1b2c3d4e5f6-p0002-i00', 'a1b2c3d4e5f6-p0003-i00', 'a1b2c3d4e5f6-p0004-i00'];
const CARD = makeJpeg({ width: 800, height: 1220, extra: 5000 });
const THUMB = makeJpeg({ width: 320, height: 480, extra: 800 });

/** Items: page 1 and 2 are one design (SB804, the card is on page 1), page 3 is SB805 with no card, page 4 has no product id. */
const overrides = {
  [IDS[0]]: { label: 'Emperador Dark', productId: 'TIPL-SB804', attributes: { code: 'SB804', printedName: 'EMPERADOR DARK' }, shopImage: { key: `cards/demo-materials/${IDS[0]}.jpg`, width: 800, height: 1220, bytes: CARD.length, sha256: 'ab'.repeat(32) }, studio: GOOD },
  [IDS[1]]: { label: 'Emperador Dark', productId: 'TIPL-SB804', attributes: { code: 'SB804' } },
  [IDS[2]]: { label: null, productId: 'TIPL-SB805', attributes: { code: 'SB805', printedName: 'SAND WAVE' } },
  [IDS[3]]: { label: 'Cover', productId: null },
};

/** A stand-in for fetch() that answers by the object key in the signed address and keeps every address it was asked for. */
function fakeBucket(objects = {}) {
  const asked = [];
  const fetch = async (url) => {
    const key = String(url).replace(/^https:\/\/signed\.example\/get\//, '').split('?')[0];
    asked.push(key);
    const found = objects[key];
    if (!found) return new Response('no', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(found.body, { status: 200, headers: { 'content-type': found.type ?? 'image/jpeg' } });
  };
  return { fetch, asked };
}

async function store(opts = {}) {
  const { db } = makeMemoryDb();
  await seedCatalogue(db, { ids: IDS, overrides, ...(opts.seed ?? {}) });
  const signer = createFakeSigner();
  let t = 1_000_000;
  const bucket = fakeBucket(opts.objects ?? { [`cards/demo-materials/${IDS[0]}.jpg`]: { body: CARD }, [`thumbs/demo-materials/${IDS[0]}.jpg`]: { body: THUMB }, [`thumbs/demo-materials/${IDS[2]}.jpg`]: { body: THUMB } });
  const designs = createDesigns({ db, signer, now: () => t, fetchImpl: opts.fetch ?? bucket.fetch, log: { warn() {}, info() {} } });
  return { designs, signer, bucket, db, advance: (ms) => (t += ms) };
}

describe('readStudio: what Gemini wrote about a design is checked before anything shows it', () => {
  test('a complete record is kept, text is trimmed, and a missing or foreign value rejects the whole record', () => {
    assert.equal(readStudio(GOOD).sheen, 'gloss');
    assert.equal(readStudio({ ...GOOD, look: '  A  dark\u0000 surface.  ' }).look, 'A dark surface.');
    for (const bad of [null, [], 'x', { ...GOOD, look: '' }, { ...GOOD, render: undefined }, { ...GOOD, sheen: 'shiny' }, { ...GOOD, grain: 'up' }, { ...GOOD, scale: 'huge' }, { ...GOOD, relief: 'bumpy' }, { ...GOOD, colours: [] }, { ...GOOD, pattern: '' }]) {
      assert.equal(readStudio(bad), null, JSON.stringify(bad)?.slice(0, 60));
    }
    assert.equal(readStudio({ ...GOOD, colours: ['a', 'b', 'c', 'd', 'e', 'f'] }).colours.length, 4);
  });
});

describe('the designs, from MongoDB', () => {
  test('one product per product id: the page with the picture is the primary, hidden items and items without an id are left out', async () => {
    const { designs } = await store({ seed: { hidden: [IDS[2]] } });
    const list = await designs.list();
    assert.deepEqual(list.map((d) => d.productId), ['TIPL-SB804'], 'SB805 is hidden, the cover has no id');
    const sb804 = list[0];
    assert.equal(sb804.id, 'tipl-sb804');
    assert.equal(sb804.name, 'Emperador Dark');
    assert.equal(sb804.code, 'SB804');
    assert.deepEqual(sb804.pages, [1, 2], 'both pages are the one design');
    assert.equal(sb804.itemId, IDS[0], 'the page that carries the picture');
    assert.equal(sb804.hex, '#8a6a4a');
    assert.equal(sb804.studio.pattern, 'marble-like veining');
    assert.equal(slugOf('TIPL-SB804'), 'tipl-sb804');
  });

  test('a design with no description or no card still exists: it is its name, code and thumbnail', async () => {
    const { designs } = await store();
    const sb805 = (await designs.list()).find((d) => d.productId === 'TIPL-SB805');
    assert.equal(sb805.studio, null);
    assert.equal(sb805.shopKey, null);
    assert.equal(sb805.name, 'Sand Wave', 'the printed name, in capitals and lower case');
    assert.equal(await designs.get('tipl-nope1'), null);
    assert.equal(await designs.get('../etc'), null, 'only a slug is looked up');
  });

  test('a catalogue that is not live, or is not a materials catalogue, gives nothing', async () => {
    assert.deepEqual(await (await store({ seed: { live: false } })).designs.list(), []);
    assert.deepEqual(await (await store({ seed: { kind: 'paint' } })).designs.list(), []);
  });

  test('the list is remembered for a minute and a failure is remembered for five seconds', async () => {
    const t = await store();
    let reads = 0;
    const real = t.db.col.bind(t.db);
    t.db.col = async (name) => (name === 'catalogue_items' ? (reads += 1, real(name)) : real(name));
    await t.designs.list();
    await t.designs.list();
    assert.equal(reads, 1);
    t.advance(61_000);
    await t.designs.list();
    assert.equal(reads, 2);
  });
});

describe('the pictures, from Cloud Storage', () => {
  test('the card is read from cards/, the thumbnail from thumbs/, and the crop (2 MB) is never read', async () => {
    const t = await store();
    const card = await t.designs.image('tipl-sb804', 'card');
    assert.equal(card.type, 'image/jpeg');
    assert.ok(card.bytes.equals(CARD));
    assert.match(card.tag, /^[0-9a-f]{16}$/);
    const thumb = await t.designs.image('tipl-sb804', 'thumb');
    assert.ok(thumb.bytes.equals(THUMB));
    assert.deepEqual(t.bucket.asked, [`cards/demo-materials/${IDS[0]}.jpg`, `thumbs/demo-materials/${IDS[0]}.jpg`]);
    assert.ok(t.signer.calls.every((c) => c.method === 'GET' && /^(cards|thumbs)\//.test(c.key)), 'only keys of the two prefixes were signed: ' + JSON.stringify(t.signer.calls.map((c) => c.key)));
    assert.ok(t.signer.calls.every((c) => c.expiresS <= 300), 'an address that works for five minutes at most');
  });

  test('a design with no card of its own gives its thumbnail; an unknown design gives nothing and asks the bucket nothing', async () => {
    const t = await store();
    assert.ok((await t.designs.image('tipl-sb805', 'card')).bytes.equals(THUMB));
    assert.equal(await t.designs.image('tipl-zz9999', 'card'), null);
    assert.deepEqual(t.bucket.asked, [`thumbs/demo-materials/${IDS[2]}.jpg`]);
  });

  test('a picture read once is kept in memory; a failed one is not asked for again for ten seconds', async () => {
    const t = await store({ objects: {} });
    assert.equal(await t.designs.image('tipl-sb804', 'card'), null, 'the bucket has nothing');
    const first = t.bucket.asked.length;
    assert.equal(await t.designs.image('tipl-sb804', 'card'), null);
    assert.equal(t.bucket.asked.length, first, 'not asked again at once');
    t.advance(11_000);
    await t.designs.image('tipl-sb804', 'card');
    assert.ok(t.bucket.asked.length > first, 'asked again after ten seconds');
    const ok = await store();
    await ok.designs.image('tipl-sb804', 'card');
    await ok.designs.image('tipl-sb804', 'card');
    assert.equal(ok.bucket.asked.length, 1, 'the second read came from memory');
    assert.ok(ok.designs.stats().cachedBytes > 0 && ok.designs.stats().cachedBytes < 1024 * 1024);
  });

  test('what is not a picture, or is too large, or cannot be signed, is not served', async () => {
    const html = await store({ objects: { [`cards/demo-materials/${IDS[0]}.jpg`]: { body: '<html>', type: 'text/html' } } });
    assert.equal(await html.designs.image('tipl-sb804', 'card'), null);
    const big = await store({ fetch: async () => new Response('x', { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(7 * 1024 * 1024) } }) });
    assert.equal(await big.designs.image('tipl-sb804', 'card'), null);
    const nosign = await store();
    nosign.signer.ok = false;
    assert.equal(await nosign.designs.image('tipl-sb804', 'card'), null);
    assert.equal(await nosign.designs.fetchObject('crops/demo-materials/x.png'), null, 'a crop is not an object this module reads');
    assert.equal(await nosign.designs.fetchObject('../secret'), null);
  });
});

describe('through the real server', () => {
  const objects = (extra = {}) => ({ [`cards/demo-materials/${IDS[0]}.jpg`]: { body: CARD }, [`thumbs/demo-materials/${IDS[0]}.jpg`]: { body: THUMB }, [`thumbs/demo-materials/${IDS[2]}.jpg`]: { body: THUMB }, ...extra });

  test('/media/materials/tipl-sb804.jpg is the picture from the bucket, with a validator, a short cache and a 304', async () => {
    const bucket = fakeBucket(objects());
    const c = await startCatalogueApp({ seed: { ids: IDS, overrides }, fetch: bucket.fetch });
    try {
      const r = await c.app.get('/media/materials/tipl-sb804.jpg');
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'image/jpeg');
      assert.ok(r.buffer.equals(CARD));
      assert.match(r.headers['cache-control'], /^public, max-age=3600, stale-while-revalidate=86400$/);
      assert.ok(r.headers.etag);
      assert.equal((await c.app.get('/media/materials/tipl-sb804.jpg', { 'If-None-Match': r.headers.etag })).status, 304);
      const thumb = await c.app.get('/media/materials/tipl-sb804.jpg?w=320');
      assert.ok(thumb.buffer.equals(THUMB), '?w=320 is the thumbnail');
      assert.equal((await c.app.get('/media/materials/tipl-sb804.jpg?w=5000')).buffer.length, CARD.length, 'a large ?w= is the card');
      assert.equal(bucket.asked.filter((k) => k.startsWith('cards/')).length, 1, 'the card was read from the bucket once and then from memory');
      // no sign-in is needed: these were public files
      assert.equal((await c.app.get('/media/materials/tipl-sb805.jpg')).status, 200);
    } finally {
      await c.stop();
    }
  });

  test('a design the catalogue does not list is a 404; a name that is not a design falls through to the media folder', async () => {
    const c = await startCatalogueApp({ seed: { ids: IDS, overrides }, fetch: fakeBucket(objects()).fetch });
    try {
      assert.equal((await c.app.get('/media/materials/tipl-zz9999.jpg')).status, 404);
      assert.equal((await c.app.get('/media/materials/fx-mill.jpg')).status, 404, 'the media folder answers the other names');
      assert.equal((await c.app.get('/media/materials/tipl-sb804.png')).status, 404);
      assert.equal((await c.app.get('/media/materials/..%2F..%2F.env')).status, 404);
    } finally {
      await c.stop();
    }
  });

  test('a picture the bucket does not give is a quiet tile that is never cached; so is a catalogue that lists nothing', async () => {
    const empty = await startCatalogueApp({ seed: { ids: IDS, overrides }, fetch: fakeBucket({}).fetch });
    try {
      const r = await empty.app.get('/media/materials/tipl-sb804.jpg');
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'image/svg+xml; charset=utf-8');
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['x-terucon-picture'], 'unavailable');
      assert.match(r.text, /SB804/);
      assert.match(r.text, /#8a6a4a/, 'in the design\'s own colour');
    } finally {
      await empty.stop();
    }
    const none = await startCatalogueApp({ seed: null, fetch: fakeBucket({}).fetch });
    try {
      const r = await none.app.get('/media/materials/tipl-sb804.jpg');
      assert.equal(r.status, 200, 'no catalogue: a tile, not a broken image');
      assert.equal(r.headers['x-terucon-picture'], 'unavailable');
      assert.match(r.text, /SB804/);
    } finally {
      await none.stop();
    }
  });

  test('/api/catalogue/studio-finishes: signed in only; each design is a finish with a brief that ends in its marker', async () => {
    const c = await startCatalogueApp({ seed: { ids: IDS, overrides }, fetch: fakeBucket(objects()).fetch });
    try {
      assert.equal((await c.app.get('/api/catalogue/studio-finishes')).status, 401);
      const r = await c.app.get('/api/catalogue/studio-finishes', c.me.headers);
      assert.equal(r.status, 200);
      const body = r.json();
      assert.equal(body.state, 'ok');
      assert.equal(body.group, 'Terucon catalogue');
      assert.deepEqual(body.kinds, ['wall', 'door', 'furniture']);
      assert.deepEqual(body.finishes.map((f) => f.productId), ['TIPL-SB804', 'TIPL-SB805']);
      const [sb804, sb805] = body.finishes;
      assert.equal(sb804.id, 'tipl-sb804');
      assert.equal(sb804.image, '/media/materials/tipl-sb804.jpg?w=320');
      assert.equal(sb804.described, true);
      assert.match(sb804.sub, /^SB804 · marble-like veining, gloss$/);
      assert.match(sb804.about, /Terucon catalogue design TIPL-SB804\. A dark brown surface/);
      assert.match(sb804.prompt, /\[\[terucon-design:TIPL-SB804\]\]$/);
      assert.equal(sb805.described, false);
      assert.match(sb805.prompt, /reference photograph/);
      assert.match(sb805.prompt, /\[\[terucon-design:TIPL-SB805\]\]$/);
      assert.equal(r.headers['cache-control'], 'no-store');
    } finally {
      await c.stop();
    }
  });

  test('with the catalogue off or its database away the list is empty and says why: never an error for the studio to log', async () => {
    const off = await startCatalogueApp({ rawEnv: 'CATALOGUE=off\n', seed: null });
    try {
      const r = await off.app.get('/api/catalogue/studio-finishes', off.me.headers);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json().finishes, []);
      assert.equal(r.json().state, 'off');
    } finally {
      await off.stop();
    }
  });
});
