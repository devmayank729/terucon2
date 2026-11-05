import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { FetchError } from '../../server/lib/inspiration/safeFetch.js';
import { defaultShop, shopBlockFor, withShop } from '../../server/lib/shopLink.js';
import { linkIn, parseUpload, photoFromLink } from '../../server/lib/terubot/photo.js';
import { readBox } from '../../server/lib/terubot/tools.js';
import { createFakeSigner, makeJpeg, makeMemoryDb, makePng, seedCatalogue, SEED_ITEM_IDS, startFakeCatalogueModal } from '../helpers/fakeCatalogueModal.js';
import { startBotApp } from '../helpers/terubotApp.js';

// A photo in a TeruBot conversation (targets C4, C5, A1): attached, or fetched for a pasted link; the model sees it; "what is the left wall?" becomes
// a catalogue search of that region and cards of the shop products with the same id. Google, Modal and the network are scripts and fakes.

const b64 = (buffer) => buffer.toString('base64');
const JPEG = makeJpeg({ width: 900, height: 600 });
const [A, B, C] = SEED_ITEM_IDS;
const TIPL = { [A]: { productId: 'TIPL-SB804', label: 'Emperador Dark' }, [B]: { productId: 'TIPL-SB825', label: 'Williams Grey' }, [C]: { productId: 'TIPL-SB8001', label: 'Marmoris Stain' } };

describe('the shop link (a catalogue id is a shop product id)', () => {
  const shop = defaultShop();
  test('TIPL-SB804 is the shop product tipl-sb804, with its listed price and a link to its page', () => {
    const block = shopBlockFor(shop, 'TIPL-SB804');
    assert.equal(block.id, 'tipl-sb804');
    assert.equal(block.name, 'Emperador Dark (SB804)');
    assert.match(block.priceText, /^₹[\d,]+ \/ sheet$/);
    assert.equal(block.href, `/materials#/p/tipl-sb804?v=${encodeURIComponent(block.variantId)}`);
    assert.equal(block.sample, true);
    assert.match(block.note, /Sample price/);
  });

  test('anything that is not a catalogue id of a shop product gets null: another prefix, a shop product id, junk, a made-up code', () => {
    for (const bad of [null, undefined, '', 'SB804', 'tipl-sb804', 'TIPL-NOPE9999', 'TIPL-SB804; DROP', 'superbond-fr-metallic', 42, {}]) assert.equal(shopBlockFor(shop, bad), null, String(bad));
  });

  test('withShop adds a block to each item and leaves the rest of the answer as it was', () => {
    const answer = { ok: true, catalogue: 'c', items: [{ productId: 'TIPL-SB804', title: 'a' }, { productId: null, title: 'b' }] };
    const out = withShop(answer, shop);
    assert.equal(out.items[0].shop.id, 'tipl-sb804');
    assert.equal(out.items[1].shop, null);
    assert.equal(out.catalogue, 'c');
    assert.equal(answer.items[0].shop, undefined, 'the input is not changed');
    assert.equal(withShop(null, shop), null);
  });
});

describe('a photo that is sent', () => {
  test('a real JPEG, PNG or WebP is accepted; its bytes are checked, not its label', () => {
    const jpeg = parseUpload({ type: 'image/jpeg', data: b64(JPEG) });
    assert.equal(jpeg.type, 'image/jpeg');
    assert.equal(jpeg.width, 900);
    assert.ok(Buffer.isBuffer(jpeg.bytes));
    assert.equal(parseUpload({ type: 'image/png', data: b64(makePng()) }).type, 'image/png');
    assert.equal(parseUpload(undefined), null);
    assert.equal(parseUpload(null), null);
  });

  test('everything else is a 400 with a reason: wrong shape, wrong type, not base64, a lie about the type, a cut-off file, too big', () => {
    const bad = (image, pattern) => assert.throws(() => parseUpload(image), (e) => e.name === 'BadRequest' && pattern.test(e.message), JSON.stringify(image).slice(0, 60));
    bad('x', /A photo is/);
    bad([], /A photo is/);
    bad({ type: 'image/gif', data: b64(JPEG) }, /A photo is/);
    bad({ type: 'image/jpeg', data: '' }, /A photo is/);
    bad({ type: 'image/jpeg', data: '***not base64***' }, /too large or not valid/);
    bad({ type: 'image/png', data: b64(JPEG) }, /not the type/);
    bad({ type: 'image/jpeg', data: b64(makeJpeg({ cut: true })) }, /cut off/);
    bad({ type: 'image/jpeg', data: b64(Buffer.concat([JPEG, Buffer.alloc(4.2 * 1024 * 1024)])) }, /too large/);
    bad({ type: 'image/jpeg', data: b64(Buffer.from('<html>not a picture</html>')) }, /not a JPEG/);
  });
});

describe('a link in a message', () => {
  test('the first address the importer can read is found; a sign-in-only site is explained; no address is null', () => {
    assert.deepEqual(linkIn('look at https://in.pinterest.com/pin/328410997812212699/ please'), { address: 'https://in.pinterest.com/pin/328410997812212699/' });
    assert.deepEqual(linkIn('https://example.com/wall.jpg and https://in.pinterest.com/pin/328410997812212699/'), { address: 'https://example.com/wall.jpg' });
    assert.match(linkIn('https://www.instagram.com/p/xyz/').refused, /Instagram only shows its pictures to people who are signed in/);
    assert.equal(linkIn('what is brushed bronze?'), null);
    assert.equal(linkIn(undefined), null);
  });

  const who = { account: 'u1', address: '203.0.113.9' };
  const importer = ({ resolve, file }) => ({ resolve: resolve ?? (async () => ({ kind: 'photo', source: { label: 'Pinterest' }, title: 'Warm stone wall', approximate: false, items: [{ token: 't1' }] })), file: file ?? (async () => ({ bytes: JPEG, type: 'image/jpeg' })) });

  test('the picture comes back with its source named; the page title is for the screen, never for the model', async () => {
    const got = await photoFromLink({ address: 'https://in.pinterest.com/pin/328410997812212699/', who, importer: importer({}) });
    assert.equal(got.photo.host, 'Pinterest');
    assert.equal(got.photo.token, 't1');
    assert.equal(got.photo.title, 'Warm stone wall');
    assert.equal(got.photo.width, 900);
  });

  test('every way it can fail is a plain sentence, never a thrown error', async () => {
    const run = (imp) => photoFromLink({ address: 'https://example.com/x.jpg', who, importer: imp });
    const gone = Object.assign(new Error('We could not find that. Check the address, and that it is public.'), { status: 404 });
    assert.match((await run(importer({ resolve: async () => { throw gone; } }))).failed, /could not find that/);
    assert.match((await run(importer({ file: async () => { throw gone; } }))).failed, /could not find that/);
    assert.match((await run(importer({ resolve: async () => ({ items: [] }) }))).failed, /no picture at that link/);
    assert.match((await run(importer({ file: async () => ({ bytes: JPEG, type: 'image/gif' }) }))).failed, /GIF.*cannot read/);
    assert.match((await run(importer({ file: async () => ({ bytes: Buffer.concat([JPEG, Buffer.alloc(4.5 * 1024 * 1024)]), type: 'image/jpeg' }) }))).failed, /too large/);
    assert.match((await run(null)).failed, /not set up/);
    await assert.rejects(run(importer({ resolve: async () => { throw new TypeError('a bug is not hidden'); } })), TypeError);
  });
});

describe('the region box', () => {
  test('[ymin, xmin, ymax, xmax] on 0..1000 becomes [x0, y0, x1, y1] as fractions, kept inside the photo', () => {
    assert.deepEqual(readBox([100, 0, 900, 400]), [0, 0.1, 0.4, 0.9]);
    assert.deepEqual(readBox([-50, -50, 1200, 1200]), [0, 0, 1, 1]);
    assert.deepEqual(readBox([0, 0, 1000, 1000]), [0, 0, 1, 1]);
  });
  test('a box that is not four numbers, or too thin, is refused', () => {
    for (const bad of [null, 'x', [1, 2, 3], [1, 2, 3, 4, 5], ['a', 0, 5, 5], [0, 0, NaN, 9], [0, 0, 10, 10], [500, 100, 500, 900], [0, 500, 900, 500]]) assert.equal(readBox(bad), null, JSON.stringify(bad));
  });
});

/** A site with the fake catalogue, a signed-in visitor, and a scripted Gemini. */
async function withPhotoApp(script, fn, { inspiration, ...more } = {}) {
  const modal = await startFakeCatalogueModal();
  const { db } = makeMemoryDb();
  await seedCatalogue(db, { overrides: TIPL });
  const app = await startBotApp({ script, env: modal.env(), catalogue: { db, signer: createFakeSigner() }, inspiration, ...more });
  try {
    const me = await app.signIn();
    await fn({ app, modal, me });
  } finally {
    await app.stop();
    await modal.close();
  }
}

describe('what is the left wall? (the chat route, with a photo)', () => {
  const wall = (box = [80, 0, 920, 380]) => [{ calls: [{ name: 'find_in_photo', args: { target: 'left wall', box_2d: box, limit: 3 } }] }, { text: 'The left wall looks like a dark polished stone. The closest is Emperador Dark.' }];

  test('the model SEES the photo; the tool searches that region; the answer carries cards of shop products with their listed prices', async () => {
    await withPhotoApp(wall(), async ({ app, modal, me }) => {
      const r = await app.chat({ messages: [{ role: 'user', text: 'what material is used in the left wall of this photo' }], image: { type: 'image/jpeg', data: b64(JPEG) } }, { as: me });
      assert.equal(r.status, 200, r.text);
      const body = r.json();
      assert.match(body.reply, /Emperador Dark/);
      assert.deepEqual(body.cards.map((c) => c.pid), ['tipl-sb804', 'tipl-sb825', 'tipl-sb8001'], 'a card for each catalogue item that is a shop product, in the order of the search');
      assert.ok(body.cards.every((c) => /^₹[\d,]+ \/ sheet$/.test(c.price) && c.href.startsWith('/materials#/p/tipl-')));
      assert.ok(body.cards.every((c) => !c.image || c.image.startsWith('/media/materials/tipl-')), 'the picture of a design is a file of the site');
      // what the model was given
      const first = app.fake.requests[0];
      const userParts = first.contents.at(-1).parts;
      assert.equal(userParts[0].inlineData.mimeType, 'image/jpeg');
      assert.equal(userParts[0].inlineData.data, b64(JPEG), 'the photo goes in as it came');
      assert.match(userParts[1].text, /Server note: the picture above was attached by the visitor/);
      assert.ok(first.tools.some((t) => t.name === 'find_in_photo'));
      assert.match(first.system, /call find_in_photo/);
      // what the tool did: one search, of the box, through the catalogue's own route
      const searches = modal.of('search');
      assert.equal(searches.length, 1);
      assert.equal(searches[0].query.box, '0,0.08,0.38,0.92', 'the box [80, 0, 920, 380] (ymin, xmin, ymax, xmax of 1000) as x0,y0,x1,y1');
      assert.equal(searches[0].query.mode, 'look');
      assert.equal(searches[0].bodySha256, (await import('node:crypto')).createHash('sha256').update(JPEG).digest('hex'), 'Modal got the photo itself');
      const toolResult = app.fake.lastToolResults().find_in_photo;
      assert.equal(toolResult.target, 'left wall');
      assert.equal(toolResult.items[0].productCode, 'TIPL-SB804');
      assert.match(toolResult.items[0].shop.listedPrice, /^₹/);
      assert.match(toolResult.items[0].shop.priceNote, /Sample price/);
      assert.ok(!JSON.stringify(toolResult).includes('signed.example'), 'no picture address goes to the model');
    });
  });

  test('without a photo the tool does not exist; a box the model got wrong is explained to it', async () => {
    await withPhotoApp([{ text: 'hello' }], async ({ app, me }) => {
      await app.chat({ messages: [{ role: 'user', text: 'hi' }] }, { as: me });
      assert.ok(!app.fake.requests[0].tools.some((t) => t.name === 'find_in_photo'));
      assert.doesNotMatch(app.fake.requests[0].system, /call find_in_photo/);
    });
    await withPhotoApp(wall([500, 100, 500, 900]), async ({ app, modal, me }) => {
      await app.chat({ messages: [{ role: 'user', text: 'the left wall?' }], image: { type: 'image/jpeg', data: b64(JPEG) } }, { as: me });
      assert.match(app.fake.lastToolResults().find_in_photo.error, /box_2d must be four numbers/);
      assert.equal(modal.of('search').length, 0, 'no search for a box that is not a box');
    });
  });

  test('a photo needs an account; a bad photo is a 400 before anything is spent; the 21st new photo of an hour is turned away', async () => {
    await withPhotoApp([{ text: 'hi' }], async ({ app, me }) => {
      const anon = await app.chat({ messages: [{ role: 'user', text: 'what is this?' }], image: { type: 'image/jpeg', data: b64(JPEG) } });
      assert.equal(anon.status, 401);
      assert.match(anon.json().error, /sign in/);
      const bad = await app.chat({ messages: [{ role: 'user', text: 'x' }], image: { type: 'image/jpeg', data: b64(Buffer.from('nope')) } }, { as: me });
      assert.equal(bad.status, 400);
      assert.equal(app.fake.requests.length, 0);
      let last;
      for (let i = 0; i < 21; i += 1) last = await app.chat({ messages: [{ role: 'user', text: 'again' }], image: { type: 'image/jpeg', data: b64(JPEG) } }, { as: me });
      assert.equal(last.status, 429);
      assert.match(last.json().error, /photos in the last hour/);
    });
  });

  test('a message without a photo is still limited to 64 KB, as it always was', async () => {
    await withPhotoApp([{ text: 'hi' }], async ({ app, me }) => {
      const r = await app.chat({ messages: [{ role: 'user', text: 'x' }], context: { title: 'y'.repeat(100_000) } }, { as: me });
      assert.equal(r.status, 400);
      assert.match(r.json().error, /too large/);
    });
  });
});

describe('a pasted link (the Pinterest pin of the bug report)', () => {
  const PIN = 'https://in.pinterest.com/pin/328410997812212699/';
  const fakes = (over = {}) => ({
    gallery: { ready: () => true, async run(job) { return { title: 'Stone wall', extractor: job.extractor, items: [{ url: 'https://i.pinimg.com/originals/ab/cd/1.jpg', width: 900, height: 600, title: 'wall', thumb: 'https://i.pinimg.com/474x/ab/cd/1.jpg' }] }; } },
    fetcher: { async get() { return { body: JPEG, contentType: 'image/jpeg', finalUrl: 'https://i.pinimg.com/originals/ab/cd/1.jpg' }; }, ...over },
  });

  test('the site fetches the picture, the model sees it (it is not told it cannot open links), and the answer says where the picture came from', async () => {
    await withPhotoApp([{ text: 'That is a warm stone wall.' }], async ({ app, me }) => {
      const r = await app.chat({ messages: [{ role: 'user', text: PIN }] }, { as: me });
      assert.equal(r.status, 200, r.text);
      const body = r.json();
      assert.equal(body.attachment.kind, 'link');
      assert.equal(body.attachment.host, 'Pinterest');
      assert.match(body.attachment.token, /^[A-Za-z0-9_-]{20,}$/);
      const parts = app.fake.requests[0].contents.at(-1).parts;
      assert.equal(parts[0].inlineData.data, b64(JPEG));
      assert.match(parts[1].text, /fetched by the site from a link the visitor pasted \(Pinterest\)/);
      assert.doesNotMatch(parts[1].text, /Warm|Stone wall/, 'the title of a web page is not given to the model');
      assert.match(app.fake.requests[0].system, /Never say you cannot open links/);
    }, { inspiration: fakes() });
  });

  test('a follow-up question keeps the photo by its token, for as long as the importer holds it', async () => {
    await withPhotoApp([{ text: 'one' }, { text: 'two' }], async ({ app, me }) => {
      const first = (await app.chat({ messages: [{ role: 'user', text: PIN }] }, { as: me })).json();
      const next = await app.chat({ messages: [{ role: 'user', text: PIN }, { role: 'assistant', text: 'one' }, { role: 'user', text: 'and the floor?' }], image: { token: first.attachment.token } }, { as: me });
      assert.equal(next.status, 200, next.text);
      assert.equal(app.fake.requests.at(-1).contents.at(-1).parts[0].inlineData.data, b64(JPEG));
      const gone = await app.chat({ messages: [{ role: 'user', text: 'still there?' }], image: { token: 'no-such-token-0123456789' } }, { as: me });
      assert.equal(gone.status, 200);
      assert.match(app.fake.requests.at(-1).contents.at(-1).parts[0].text, /no longer available/);
    }, { inspiration: fakes() });
  });

  test('a picture that cannot be fetched becomes a plain note for the model, with the reason; the chat still answers', async () => {
    const f = fakes({ async get() { throw new FetchError('status', 'x', 403); } });
    await withPhotoApp([{ text: 'I could not get that picture.' }], async ({ app, me }) => {
      const r = await app.chat({ messages: [{ role: 'user', text: PIN }] }, { as: me });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json().attachment, undefined);
      const note = app.fake.requests[0].contents.at(-1).parts[0].text;
      assert.match(note, /no picture could be taken from it/);
      assert.match(note, /Never say you cannot open links/);
    }, { inspiration: f });
  });

  test('Instagram needs a sign-in: the reason goes to the model without any fetch', async () => {
    await withPhotoApp([{ text: 'Please upload it.' }], async ({ app, me }) => {
      const r = await app.chat({ messages: [{ role: 'user', text: 'https://www.instagram.com/p/xyz/' }] }, { as: me });
      assert.equal(r.status, 200);
      assert.match(app.fake.requests[0].contents.at(-1).parts[0].text, /Instagram only shows its pictures to people who are signed in/);
    }, { inspiration: fakes() });
  });
});
