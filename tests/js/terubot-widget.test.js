// TeruBot (site/brand/terubot.{js,css}): what can be checked without a browser. The behaviour in a browser is tested in tests/e2e/run.mjs
// (the "terubot widget" block). Here: the files, who includes them, that nothing builds HTML from a string, the retirement of the two demo
// assistants in the patched pages, and the shop-side bridge (site/patches/snippets/shop-terubot-members.txt) run against a small fake shop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, memoBuild } from './site-helpers.js';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const JS = read('site/brand/terubot.js');
const CSS = read('site/brand/terubot.css');

test('terubot.js parses, and nothing in it turns a string into HTML or code', () => {
  assert.doesNotThrow(() => new vm.Script(JS, { filename: 'terubot.js' }));
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setAttribute(\'style\'', 'srcdoc']) {
    assert.ok(!JS.includes(bad), `terubot.js uses ${bad}`);
  }
  // every server answer goes through textContent; the response text is never assigned to anything else
  assert.ok(/\.textContent = /.test(JS) && /createElementNS/.test(JS));
  assert.ok(!/https?:\/\//.test(JS.replace('http://www.w3.org/2000/svg', '')), 'no address of another site in the script');
  assert.ok(!/@import|url\(\s*['"]?https?:/i.test(CSS), 'no stylesheet or font from another site');
  assert.ok(!/\sstyle\s*=/.test(JS), 'no inline style attribute is written (the strict policy refuses them)');
});

test('the one public API and the contract paths are what the pages and the server expect', () => {
  assert.ok(JS.includes("'/api/terubot/chat'") && JS.includes("'/api/terubot/status'"));
  assert.match(JS, /window\.TeruBot = \{[\s\S]*open:[\s\S]*close:[\s\S]*ask:/);
  assert.ok(JS.includes("'terucon.enquiry.prefill'"), 'the project form reads this key');
  assert.ok(JS.includes('terucon.store.v1.cart') && JS.includes('terucon.store.v1.saved'), 'the shop\'s own storage keys');
  assert.ok(JS.includes('Ask TeruBot'), 'the launcher label');
  assert.ok(CSS.includes('html.swr-immersive .tb-root') && CSS.includes('prefers-reduced-motion') && CSS.includes('--tc-dock-h') && CSS.includes('--tc-hdr-h') && CSS.includes('--tc-side-w'));
});

test('every built page and every hand-written page but the offline and error pages includes the widget', () => {
  const head = read('site/brand/head.html');
  assert.ok(head.includes('<link rel="stylesheet" href="/brand/terubot.css">') && head.includes('<script src="/brand/terubot.js" defer></script>'), 'head.html (the four built pages, by tools/build-dist.js)');
  for (const name of ['inspiration', 'finder', 'account', 'login', 'admin-catalogue', 'coming-soon']) {
    const html = read(`pages/${name}.html`);
    assert.equal(html.split('<script src="/brand/terubot.js" defer></script>').length - 1, 1, `${name}: the script once`);
    assert.equal(html.split('<link rel="stylesheet" href="/brand/terubot.css">').length - 1, 1, `${name}: the stylesheet once`);
  }
  for (const name of ['offline', 'error']) assert.ok(!read(`pages/${name}.html`).includes('terubot'), `${name}.html has no assistant`);
});

test('the shop: Ask Terucon is retired, the mic buttons open TeruBot, and the bridge is in the page', () => {
  const t = memoBuild('route').results.find((r) => r.key === 'materials').bundle.template;
  assert.ok(t.includes('const show = false && '), 'the floating Ask button is never shown');
  assert.ok(!t.includes("=== 'Floating button'"));
  assert.ok(t.includes('openVa = () => { try { if (window.TeruBot) window.TeruBot.open(); } catch (_) {} }'));
  assert.ok(!t.includes('Tell me what you’re building'), 'the demo assistant\'s greeting is gone from the script');
  for (const member of ['tbFind = ', 'tbApplyAll = ', 'tbUndo = ', 'tbMount = ', 'tbReady = ', 'tbSync = ', 'this.tbMount(); this.waitStore(0);', 'this.tbReady(); });', 'componentDidUpdate() {\n    this.tbSync();']) {
    assert.ok(t.includes(member), `the shop page lacks ${member}`);
  }
  assert.ok(t.includes("if (parts.length === 1 && !M[parts[0]] && this.S && this.tbFind)"), 'a /materials#<id> link opens that product');
  assert.equal(t.split('data-import-urls').length - 1, 1, 'only the search box takes a pasted photo address now');
});

test('the dashboard: Saathi is retired and every button that opened it opens TeruBot', () => {
  const spec = JSON.parse(read('site/patches/dashboard.json'));
  assert.ok(!spec.steps.some((s) => s.id === 'fab-lift'), 'the lift of the retired button is gone');
  const t = memoBuild('route').results.find((r) => r.key === 'dashboard').bundle.template;
  for (const gone of ['>Tell Saathi about it<', '>Ask Saathi to help<', '>Ask Saathi about the price<', 'Tell Saathi or Rohan', 'or ask Saathi.', 'aria-label="Ask Saathi — tap and speak" style="position:relative;flex:none;width:62px', "st.tray = true;", '    this.startHint();\n']) {
    assert.ok(!t.includes(gone), `still in the dashboard: ${gone}`);
  }
  assert.ok(t.includes('<sc-if value="{{ saathiRetired }}"><aside role="{{ tr.role }}"') && t.includes('</aside></sc-if>'), 'the tray is never rendered');
  assert.ok(t.includes('<sc-if value="{{ saathiRetired }}" hint-placeholder-val="{{ true }}"><div style="position:fixed;right:clamp(16px,2.4vw,28px);'), 'the round button is never rendered');
  assert.ok(!t.includes('tray: true'), 'nothing can open the tray');
  assert.equal(t.split('window.TeruBot.open(opts)').length - 1, 1);
  for (const opener of ['talk = () => this.openAgent({ mic: true });', 'fabTap = () => this.openAgent();', 'askFloor = () => this.openAgent({ draft:', 'askPrice = () => this.openAgent({ draft:', 'askChange = () => this.openAgent({ draft:', 'talkNext = () => this.openAgent({ draft:']) {
    assert.ok(t.includes(opener), `missing ${opener}`);
  }
  assert.ok(t.includes('>TeruBot</span></div><sc-for list="{{ tabsR }}"'), 'the bottom bar\'s centre button is named TeruBot');
});

// ---- the shop-side bridge, against a fake shop ----------------------------------------------------------------------------------------------
const MEMBERS = read('site/patches/snippets/shop-terubot-members.txt');

function fakeCatalogue() {
  const mk = (id, pid, fid, stock, extra = {}) => ({ id, pid, fid, stock, units: 'sheets', label: fid.toUpperCase() + ' · 4 mm', ...extra });
  const variants = [mk('p1--a-4', 'p1', 'a', 5), mk('p1--b-4', 'p1', 'b', 0), mk('p2--c-4', 'p2', 'c', 0), mk('p2--d-4', 'p2', 'd', 7), mk('p3--e-4', 'p3', 'e', 0)];
  const byV = Object.fromEntries(variants.map((v) => [v.id, v]));
  const byP = {
    p1: { id: 'p1', name: 'Product One', defaultVid: 'p1--a-4', variants: variants.filter((v) => v.pid === 'p1') },
    p2: { id: 'p2', name: 'Product Two', defaultVid: 'p2--c-4', variants: variants.filter((v) => v.pid === 'p2') },
    p3: { id: 'p3', name: 'Product Three', defaultVid: 'p3--e-4', variants: variants.filter((v) => v.pid === 'p3') },
  };
  return { variants, byV, byP };
}

function fakeShop({ pending, now = Date.now() } = {}) {
  const store = new Map();
  if (pending !== undefined) store.set('terucon.terubot.pending', JSON.stringify(pending));
  const events = [];
  const listeners = {};
  const props = [];
  const sandbox = {
    window: { addEventListener: (n, f) => { listeners[n] = f; }, dispatchEvent: (e) => { events.push(e); return true; } },
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), removeItem: (k) => store.delete(k) },
    document: { documentElement: { style: { setProperty: (k, v) => props.push([k, v]) } } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    Date: { now: () => now },
  };
  const make = new Function('window', 'sessionStorage', 'document', 'CustomEvent', 'Date', `return class Shop {
    constructor(c) { this.S = { ...c, persist: { set: (k, v) => { this.saves.push([k, v]); } } }; this.state = { cart: [], saved: [], compare: [], vw: 1440, route: { name: 'shop' } }; this.persisted = null; this.saves = []; this.toasts = []; }
    setState(p) { Object.assign(this.state, p); }
    toast(t) { this.toasts.push(t); }
    barH(name) { const dk = this.state.vw <= 899 ? 58 : 0; if (this.state.vw >= 820) return 20 + dk; return dk + (name === 'shop' ? 88 : 16); } // the patched one (materials.json, bar-height)
    persistCart(c) { this.persisted = c; }
    ${MEMBERS}
  }`);
  const Shop = make(sandbox.window, sandbox.sessionStorage, sandbox.document, sandbox.CustomEvent, sandbox.Date);
  const shop = new Shop(fakeCatalogue());
  return { shop, store, events, listeners, props };
}

test('the bridge: the snippet is a valid set of class members', () => {
  assert.doesNotThrow(() => fakeShop());
});

test('the bridge: a product id, a variant id or a finish id finds a variant; an unknown id finds nothing', () => {
  const { shop } = fakeShop();
  assert.equal(shop.tbFind('p1--a-4').id, 'p1--a-4');
  assert.equal(shop.tbFind('p2').id, 'p2--d-4', 'a product id takes the default variant, or the first one in stock when that one is out');
  assert.equal(shop.tbFind('d').id, 'p2--d-4', 'a finish id');
  assert.equal(shop.tbFind('nothing'), null);
  assert.equal(shop.tbFind(''), null);
});

test('the bridge: cart_add changes the page\'s own cart and saves it, caps at the stock, and says when nothing was added', () => {
  const { shop } = fakeShop();
  const [a] = shop.tbApplyAll([{ op: 'cart_add', id: 'p1', qty: 2 }]);
  assert.equal(a.ok, true);
  assert.deepEqual(shop.state.cart, [{ vid: 'p1--a-4', qty: 2 }]);
  assert.deepEqual(shop.persisted, [{ vid: 'p1--a-4', qty: 2 }], 'persisted by the page\'s own persistCart');
  const [b] = shop.tbApplyAll([{ op: 'cart_add', id: 'p1', qty: 10 }]);
  assert.equal(b.ok, true);
  assert.equal(b.added, 3, '2 in the cart and 5 in stock: 3 more');
  assert.match(b.text, /that is all the stock there is/);
  const [c] = shop.tbApplyAll([{ op: 'cart_add', id: 'p1', qty: 1 }]);
  assert.equal(c.ok, false, 'nothing could be added');
  assert.match(c.text, /already in your cart/);
  const [d] = shop.tbApplyAll([{ op: 'cart_add', id: 'p3', qty: 1 }]);
  assert.equal(d.ok, false);
  assert.match(d.text, /out of stock/);
  const [e] = shop.tbApplyAll([{ op: 'cart_add', id: 'zzz', qty: 1 }]);
  assert.equal(e.ok, false);
  assert.match(e.text, /could not find/);
});

test('the bridge: when the variant id is unknown the product id the server also sends is used', () => {
  const { shop } = fakeShop();
  const [a] = shop.tbApplyAll([{ op: 'saved_add', id: 'p1--gone-4-1x1', pid: 'p1' }]);
  assert.equal(a.ok, true);
  assert.deepEqual(shop.state.saved, [{ pid: 'p1', vid: 'p1--a-4' }]);
  const [b] = shop.tbApplyAll([{ op: 'saved_add', id: 'nope--x', pid: 'nope' }]);
  assert.equal(b.ok, false);
});

test('the bridge: several changes in one go all land (the page state is not read stale between them)', () => {
  const { shop } = fakeShop();
  const out = shop.tbApplyAll([{ op: 'cart_add', id: 'p1', qty: 1 }, { op: 'cart_add', id: 'p2', qty: 2 }, { op: 'cart_add', id: 'p1', qty: 1 }, { op: 'saved_add', id: 'p2' }]);
  assert.ok(out.every((r) => r.ok));
  assert.deepEqual(shop.state.cart, [{ vid: 'p2--d-4', qty: 2 }, { vid: 'p1--a-4', qty: 2 }]);
  assert.deepEqual(shop.state.saved, [{ pid: 'p2', vid: 'p2--d-4' }]);
});

test('the bridge: saved_add and saved_remove do not toggle, and each change can be undone', () => {
  const { shop } = fakeShop();
  const [a1] = shop.tbApplyAll([{ op: 'saved_add', id: 'p1' }]);
  const [a2] = shop.tbApplyAll([{ op: 'saved_add', id: 'p1' }]);
  assert.equal(shop.state.saved.length, 1, 'adding twice does not remove it');
  assert.match(a2.text, /already in your saved list/);
  assert.ok(a1.undo && !a2.undo);
  const [r1] = shop.tbApplyAll([{ op: 'saved_remove', id: 'p1' }]);
  const [r2] = shop.tbApplyAll([{ op: 'saved_remove', id: 'p1' }]);
  assert.equal(shop.state.saved.length, 0, 'removing twice does not add it back');
  assert.match(r2.text, /was not in your saved list/);
  assert.equal(shop.tbUndo(r1.undo).ok, true);
  assert.deepEqual(shop.state.saved, [{ pid: 'p1', vid: 'p1--a-4' }], 'undoing a removal puts it back');
  assert.equal(shop.tbUndo(a1.undo).ok, true);
  assert.equal(shop.state.saved.length, 0);
  const [c] = shop.tbApplyAll([{ op: 'cart_add', id: 'p1', qty: 2 }]);
  shop.tbApplyAll([{ op: 'cart_add', id: 'p1', qty: 1 }]);
  assert.match(shop.tbUndo(c.undo).text, /out of your cart again/);
  assert.deepEqual(shop.state.cart, [{ vid: 'p1--a-4', qty: 1 }], 'only what TeruBot added is taken out');
});

test('the bridge: the terucon:shop event is answered once the catalogue is ready, and not before', () => {
  const { shop, listeners } = fakeShop();
  shop.tbMount();
  const early = { op: 'cart_add', id: 'p1', qty: 1, handled: false };
  listeners['terucon:shop']({ detail: early });
  assert.equal(early.handled, false, 'before the catalogue is ready the page does not answer (TeruBot queues instead)');
  assert.deepEqual(shop.state.cart, []);
  shop._tbReady = true;
  const d = { op: 'cart_add', id: 'p1', qty: 2, handled: false };
  listeners['terucon:shop']({ detail: d });
  assert.equal(d.handled, true);
  assert.equal(d.ok, true);
  assert.match(d.message, /added 2/);
  assert.equal(typeof d.undo, 'function');
  assert.equal(shop.toasts.at(-1).kind, 'added');
  const other = { op: 'unknown', id: 'p1', handled: false };
  listeners['terucon:shop']({ detail: other });
  assert.equal(other.handled, false, 'only the three known operations');
  d.undo();
  assert.deepEqual(shop.state.cart, []);
});

test('the bridge: what was queued on another page is applied after the load, once, and what is stale or malformed is dropped', () => {
  const now = Date.now();
  const pending = [
    { op: 'cart_add', id: 'p1', qty: 2, at: now - 1000 },
    { op: 'saved_add', id: 'p2', at: now - 1000 },
    { op: 'cart_add', id: 'p1', qty: 1, at: now - 3 * 3600 * 1000 }, // older than two hours
    { op: 'cart_add', id: '../x', qty: 1, at: now }, // not an id
    { op: 'delete_everything', id: 'p1', at: now },
    { op: 'cart_add', id: 'nope', qty: 1, at: now - 5 },
  ];
  const { shop, store, events } = fakeShop({ pending, now });
  shop.tbReady();
  assert.equal(store.has('terucon.terubot.pending'), false, 'the queue is emptied first, so it can never apply twice');
  assert.deepEqual(shop.state.cart, [{ vid: 'p1--a-4', qty: 2 }]);
  assert.deepEqual(shop.state.saved, [{ pid: 'p2', vid: 'p2--d-4' }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'terucon:shop-applied');
  assert.deepEqual(events[0].detail.items.map((i) => i.ok), [true, true, false]);
  assert.match(shop.toasts.at(-1).text, /2 changes applied, 1 not possible/);
  const again = fakeShop({ now });
  again.shop.tbReady();
  assert.equal(again.events.length, 0, 'nothing queued, nothing said');
});

test('the bridge: the room under TeruBot\'s button follows the shop\'s own bars', () => {
  const { shop, props } = fakeShop();
  shop.tbSync();
  assert.deepEqual(props.at(-1), ['--tb-bottom', '20px'], 'a laptop: 20 px');
  shop.state.vw = 390; shop.state.route = { name: 'shop' };
  shop.tbSync();
  assert.deepEqual(props.at(-1), ['--tb-bottom', '88px'], 'a phone on the list: above the cart bar (the dock\'s own 58 px is added by terubot.css)');
  shop.state.compare = ['p1'];
  shop.tbSync();
  assert.deepEqual(props.at(-1), ['--tb-bottom', '152px'], 'and above the compare tray');
});
