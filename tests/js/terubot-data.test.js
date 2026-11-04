import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { extractEnquiryForm, extractProducts, staleFiles } from '../../tools/extract-products.js';
import { checkEnquiryFields, finalActions, sanitizeAction } from '../../server/lib/terubot/actions.js';
import { loadForm } from '../../server/lib/terubot/index.js';
import { createImageResolver } from '../../server/lib/terubot/images.js';
import { loadShop } from '../../server/lib/terubot/shop.js';
import { checkDestination, destinations, siteGuide } from '../../server/lib/terubot/site.js';
import { SiteMap } from '../../server/lib/siteMap.js';
import { PROJECT_ROOT } from '../helpers/tempRoot.js';

const shop = loadShop();
const form = loadForm();
const site = SiteMap.load(PROJECT_ROOT);
const deps = { site, shop, form };
const BRONZE = 'superbond-fr-metallic--acp-bronze-4-1220x2440';

describe('the product data is read from the shop export, not typed in', () => {
  test('server/data matches a fresh extraction from pages_original (run: node tools/extract-products.js)', () => {
    assert.deepEqual(staleFiles(), []);
    const onDisk = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'server/data/products.json'), 'utf8'));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(extractProducts())), 'products.json equals the extraction');
    const form = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'server/data/enquiry-form.json'), 'utf8'));
    assert.deepEqual(form, JSON.parse(JSON.stringify(extractEnquiryForm())), 'enquiry-form.json equals the extraction');
  });

  test('it is the shop that TARGETS.md describes: 24 own products and the 63 SuperBond colour designs; ids are unique and every photo exists', () => {
    assert.deepEqual(shop.counts, { products: 87, variants: 209 });
    assert.equal(shop.products.length, 87);
    const ids = shop.products.flatMap((p) => p.variants.map((v) => v.id));
    assert.equal(ids.length, 209);
    assert.equal(new Set(ids).size, 209);
    for (const p of shop.products) {
      assert.ok(p.variants.length >= 1 && shop.categories.some((c) => c.id === p.category), p.id);
      for (const v of p.variants) {
        assert.match(v.priceText, /^₹[\d,]+ \/ [a-z]+$/, v.id);
        assert.ok(['in', 'low', 'out'].includes(v.stock));
        assert.ok(Number.isInteger(v.price) && v.price > 0);
      }
    }
    assert.equal(shop.byVariant.get(BRONZE).variant.priceText, '₹6,960 / sheet');
  });

  test('the catalogue designs are shop products under their catalogue id (TIPL-SB804 is tipl-sb804), with a picture that is NOT a file (it is read from Cloud Storage through MongoDB)', () => {
    const designs = shop.products.filter((p) => p.catalogueId);
    assert.equal(designs.length, 63);
    assert.equal(new Set(designs.map((p) => p.catalogueId)).size, 63);
    for (const p of designs) {
      assert.match(p.catalogueId, /^TIPL-[A-Z]{2,4}\d{2,5}$/);
      assert.equal(p.id, p.catalogueId.toLowerCase(), 'the id is the link');
      assert.equal(p.category, 'colour');
      assert.equal(p.brand, 'SuperBond');
      assert.equal(p.variants.length, 1);
      assert.equal(p.variants[0].sku, p.catalogueId, 'the SKU is the catalogue id');
      // the address a design's picture is asked for under (server/routes/catalogueMedia.js reads it from the bucket); no file of it is kept on the server
      assert.equal(p.variants[0].image, `media/materials/${p.id}.jpg`, `${p.id}: the picture's address`);
      assert.ok(!fs.existsSync(path.join(PROJECT_ROOT, p.variants[0].image)), `${p.id}: ${p.variants[0].image} must not be a file of this server`);
    }
    const sb804 = shop.byProduct.get('tipl-sb804');
    assert.equal(sb804.name, 'Emperador Dark (SB804)');
    assert.match(sb804.specs.find(([k]) => k === 'Size and price')[1], /Sample values/, 'the page says the size and price are samples');
    assert.equal(shop.search({ query: 'emperador dark' }).results[0].product.id, 'tipl-sb804');
    assert.equal(shop.search({ query: 'SB804' }).results[0].product.id, 'tipl-sb804');
    assert.equal(shop.search({ query: 'TIPL-SB804' }).results[0].product.id, 'tipl-sb804');
  });

  test('the form\'s choices are the ones the landing page offers', () => {
    assert.deepEqual(form.types, ['Façade / elevation', 'Office interior', 'Materials supply', 'Turnkey build']);
    assert.deepEqual(form.timelines, ['Within 3 months', '3–6 months', 'Later', 'Exploring']);
    assert.equal(form.areas.length, 5);
    assert.ok(!form.areas.includes('Select'));
    assert.deepEqual(form.fields, ['name', 'company', 'phone', 'email', 'city', 'area', 'message']);
  });
});

describe('looking things up', () => {
  test('ids: a variant id, a product id (its default variant) or a finish id; nothing else', () => {
    assert.equal(shop.resolve(BRONZE).variant.id, BRONZE);
    assert.equal(shop.resolve(' ' + BRONZE.toUpperCase() + ' ').variant.id, BRONZE);
    assert.equal(shop.resolve('superbond-fr-metallic').product.id, 'superbond-fr-metallic');
    assert.equal(shop.resolve('acp-bronze').variant.finishId, 'acp-bronze');
    for (const bad of ['', 'nope', '../etc/passwd', 42, null, undefined, {}, 'x'.repeat(500), '__proto__', 'constructor']) assert.equal(shop.resolve(bad), null, String(bad));
  });

  test('search: words, filters, budget, sorting', () => {
    const bronze = shop.search({ query: 'bronze ACP for a facade' });
    assert.equal(bronze.results[0].variant.id, BRONZE);
    const cheap = shop.search({ category: 'stone', sort: 'price_asc', limit: 8 });
    const prices = cheap.results.map((r) => r.variant.price);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
    assert.ok(shop.search({ query: 'teak under 15000', maxPrice: 15000 }).results.every((r) => r.matching.every((v) => v.price <= 15000)), 'the budget filters variants');
    assert.equal(shop.search({ query: 'teak', maxPrice: 100 }).results.length, 0);
    assert.equal(shop.search({ query: 'zzzzqqq' }).unmatched, true);
    assert.ok(shop.search({ colour: 'white', inStockOnly: true, limit: 8 }).results.every((r) => r.variant.stock !== 'out'));
    assert.equal(shop.search({ limit: 1000 }).results.length, 8, 'at most 8 results');
  });

  test('a card has the contract\'s fields, the shop\'s own price text and a link the shop understands', () => {
    const { product, variant } = shop.resolve(BRONZE);
    const c = shop.card(product, variant, () => '/assets/x.webp');
    assert.equal(c.kind, 'material');
    assert.equal(c.price, variant.priceText);
    assert.equal(c.image, '/assets/x.webp');
    assert.equal(c.href, `/materials#/p/${product.id}?v=${BRONZE}`);
    assert.equal(checkDestination(c.href, site, { hasProduct: (id) => shop.byProduct.has(id) }).ok, true, 'the href passes the navigation check');
  });

  test('the quantity works as the shop does it: ceil(area x (1 + waste) / cover)', () => {
    const { product, variant } = shop.resolve(BRONZE);
    const e = shop.estimate(product, variant, 480, 10);
    assert.equal(e.units, Math.ceil((480 / 10.7639) * 1.1 / (1.22 * 2.44) - 1e-9));
    assert.equal(e.units, 17);
    assert.equal(shop.estimate(...Object.values(shop.resolve('terracotta-baguette')).slice(0, 2), 100).ok, false, 'a piece-counted item has no area estimate');
  });

  test('photo addresses come from the built site\'s manifest; with no build there is none', () => {
    const none = createImageResolver({ dir: path.join(PROJECT_ROOT, 'no-such-dist') });
    assert.equal(none.urlFor('media/materials/acp-bronze.jpg'), '');
    assert.equal(none.urlFor(null), '');
    assert.equal(none.urlFor('../../etc/passwd'), '');
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'terubot-dist-'));
    try {
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ assets: { 'assets/acp-bronze-6642282c-320-aaaaaaaaaaaa.webp': {}, 'assets/acp-bronze-6642282c-640-137387533307.webp': {}, 'assets/acp-bronze-6642282c-1280-bbbbbbbbbbbb.webp': {}, 'assets/acp-bronze-extra-6642282c-640-cccccccccccc.webp': {} } }));
      assert.equal(createImageResolver({ dir }).urlFor('media/materials/acp-bronze.jpg'), '/assets/acp-bronze-6642282c-640-137387533307.webp', 'the smallest copy of at least 480 px');
      assert.equal(createImageResolver({ dir }).urlFor('media/materials/kota.jpg'), '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('navigation: only routes of the site map', () => {
  const ok = (to) => checkDestination(to, site, { hasProduct: (id) => shop.byProduct.has(id) });

  test('what is allowed', () => {
    for (const to of ['/', '/materials', '/finder', '/design-studio', '/my-project', '/login', '/account', '/inspiration', '/finder?q=bronze', '/materials#/shop?q=bronze%20acp', '/materials#/cart', '/materials#/saved', '/materials#/p/kota-stone', `/materials#/p/superbond-fr-metallic?v=${BRONZE}`]) assert.deepEqual(ok(to), { ok: true, to }, to);
  });

  test('what is refused: other schemes, other sites, other paths, hostile queries', () => {
    const hostile = [
      'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>', 'https://evil.example', 'http://localhost:8080/materials', '//evil.example', '/\\evil.example', '/materials/../admin', '/materials/', '/Materials',
      '/api/admin/settings', '/admin/catalogue', '/project-overview', '/coming-soon', '/.env', '/materials?x=<script>', '/materials?next=javascript:alert(1)', '/materials?q=a b', '/materials?q=%0d%0aSet-Cookie:x', '/materials?q=%3Cscript%3E',
      '/finder#/shop', '/materials#javascript:alert(1)', '/materials#/p/no-such-product', '/materials#/p/x?v=a;b', '/materials#/admin', `/materials?${'a'.repeat(200)}`, '/' + 'a'.repeat(400), '', '   ', null, undefined, 5, {}, [], '/materials\n/finder', '/materials\u0000', '/finder\t',
    ];
    for (const to of hostile) assert.equal(ok(to).ok, false, JSON.stringify(to));
  });

  test('the pages that are not for visitors are not destinations; the guide lists the rest with who can open them', () => {
    const routes = [...destinations(site).keys()];
    assert.ok(routes.includes('/materials') && routes.includes('/finder'));
    for (const r of ['/admin/catalogue', '/project-overview', '/coming-soon']) assert.ok(!routes.includes(r), r);
    const guide = siteGuide(site);
    assert.equal(guide.length, routes.length);
    const dash = guide.find((g) => g.route === '/my-project');
    assert.match(dash.note, /DEMO/);
    assert.match(guide.find((g) => g.route === '/materials').note, /not charged or dispatched/);
    assert.equal(guide.find((g) => g.route === '/').whoCanOpenIt, 'everybody');
    assert.match(guide.find((g) => g.route === '/finder').whoCanOpenIt, /signed in/);
    assert.deepEqual(siteGuide(site, { route: '/finder' }).map((g) => g.route), ['/finder']);
  });
});

describe('actions: rebuilt from validated parts, the rest refused', () => {
  const ok = (a) => sanitizeAction(a, deps);

  test('good ones', () => {
    assert.deepEqual(ok({ type: 'navigate', to: '/finder', extra: 'x' }), { ok: true, action: { type: 'navigate', to: '/finder' } });
    assert.deepEqual(ok({ type: 'open_studio', to: 'https://evil.example' }), { ok: true, action: { type: 'open_studio' } });
    assert.deepEqual(ok({ type: 'cart_add', id: BRONZE, qty: 3, price: 0 }), { ok: true, action: { type: 'cart_add', id: BRONZE, qty: 3 } });
    assert.deepEqual(ok({ type: 'cart_add', id: 'acp-bronze', qty: '2' }).action, { type: 'cart_add', id: BRONZE, qty: 2 }, 'a finish id becomes the variant id');
    assert.deepEqual(ok({ type: 'saved_add', id: BRONZE }).action, { type: 'saved_add', id: BRONZE, pid: 'superbond-fr-metallic' });
    assert.deepEqual(ok({ type: 'saved_remove', id: 'kota-stone' }).action.pid, 'kota-stone');
  });

  test('hostile ones: unknown ids, quantities out of range, types that are not in the list, junk', () => {
    for (const a of [
      { type: 'cart_add', id: 'nope', qty: 1 }, { type: 'cart_add', id: BRONZE, qty: 10000 }, { type: 'cart_add', id: BRONZE, qty: 100 }, { type: 'cart_add', id: BRONZE, qty: 0 }, { type: 'cart_add', id: BRONZE, qty: -1 },
      { type: 'cart_add', id: BRONZE, qty: 1.5 }, { type: 'cart_add', id: BRONZE, qty: '1e3' }, { type: 'cart_add', id: BRONZE, qty: NaN }, { type: 'cart_add', id: BRONZE, qty: [1] }, { type: 'cart_add', id: { $ne: 1 }, qty: 1 },
      { type: 'saved_add', id: '../x' }, { type: 'navigate', to: 'javascript:alert(1)' }, { type: 'navigate', to: 'https://evil.example/materials' }, { type: 'navigate' },
      { type: 'delete_account' }, { type: 'checkout' }, { type: 'pay', amount: 1 }, { type: 'send_message', to: 'a@b.c' }, { type: 'eval', code: '1' }, { type: '__proto__' }, { type: 'toString' }, { type: 5 }, {}, null, 'navigate', [], 7,
      { type: 'prefill_enquiry', fields: {} }, { type: 'prefill_enquiry' }, { type: 'prefill_enquiry', fields: 'x' }, { type: 'prefill_enquiry', fields: { type: 'Spy on competitors' } },
    ]) assert.equal(ok(a).ok, false, JSON.stringify(a));
    assert.equal(ok({ type: 'cart_add', id: BRONZE, qty: 99 }).ok, true);
    const out = [...shop.byVariant.values()].find((x) => x.variant.stock === 'out');
    assert.ok(out, 'the data has at least one variant the shop shows as out of stock');
    assert.equal(ok({ type: 'cart_add', id: out.variant.id, qty: 1 }).ok, false, 'the shop refuses it too');
  });

  test('the enquiry form: only its own keys, its own chips, sane lengths, no markup', () => {
    const r = checkEnquiryFields({ type: 'facade / ELEVATION', timeline: '3-6 months', area: '50,000+ sq ft', name: '  Asha <b>Rao</b>\u0007 ', email: 'asha@example.com', phone: '+91 98765 43210', city: 'Bengaluru', company: 'x'.repeat(500), message: 'Line one\nLine two <script>', admin: 'yes', __proto__: { x: 1 } }, form);
    assert.deepEqual(r.problems, []);
    assert.equal(r.fields.type, 'Façade / elevation');
    assert.equal(r.fields.timeline, '3–6 months');
    assert.equal(r.fields.area, '50,000+ sq ft');
    assert.equal(r.fields.name, 'Asha bRao/b');
    assert.equal(r.fields.company.length, 120);
    assert.equal(r.fields.message, 'Line one\nLine two script');
    assert.deepEqual(Object.keys(r.fields), ['type', 'name', 'company', 'phone', 'email', 'city', 'area', 'timeline', 'message']);
    assert.ok(!('admin' in r.fields));
    const bad = checkEnquiryFields({ type: 'Spy', timeline: 'Yesterday', area: 'huge', email: 'not-an-email', phone: 'abc', name: 5, message: 'ok' }, form);
    assert.equal(bad.fields.type + bad.fields.timeline + bad.fields.area + bad.fields.email + bad.fields.phone + bad.fields.name, '');
    assert.equal(bad.fields.message, 'ok');
    assert.equal(bad.problems.length, 6);
    assert.equal(checkEnquiryFields({ message: 'm'.repeat(5000) }, form).fields.message.length, 1000);
  });

  test('a reply\'s actions are capped, de-duplicated, merged and re-checked; a move to another page goes last and only one', () => {
    const many = [
      { type: 'navigate', to: '/finder' }, { type: 'navigate', to: '/materials' }, { type: 'open_studio' },
      ...Array.from({ length: 9 }, () => ({ type: 'cart_add', id: BRONZE, qty: 1 })),
      { type: 'cart_add', id: 'kota-stone', qty: 2 }, { type: 'cart_add', id: 'jaisalmer-limestone', qty: 2 }, { type: 'cart_add', id: 'gwalior-sandstone', qty: 2 }, { type: 'cart_add', id: 'sadarahalli-granite', qty: 2 }, { type: 'cart_add', id: 'lime-plaster', qty: 2 },
      { type: 'prefill_enquiry', fields: { name: 'A' } }, { type: 'prefill_enquiry', fields: { city: 'B' } }, { type: 'drop_tables' },
    ];
    const out = finalActions(many, deps);
    assert.ok(out.length <= 8);
    assert.equal(out.filter((a) => a.type === 'navigate' || a.type === 'open_studio').length, 1);
    assert.equal(out.at(-1).type, 'navigate');
    assert.equal(out.at(-1).to, '/finder');
    assert.ok(out.filter((a) => a.type === 'cart_add').length <= 5);
    assert.equal(out.filter((a) => a.type === 'prefill_enquiry').length <= 1, true);
    assert.deepEqual(finalActions('not a list', deps), []);
  });
});
