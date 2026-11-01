import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGalleryRunner, ImportError } from '../../server/lib/inspiration/gallery.js';
import { createImporter } from '../../server/lib/inspiration/importer.js';
import { FetchError } from '../../server/lib/inspiration/safeFetch.js';
import { loadSettings } from '../../server/config/settings.js';

// Inspiration import (C3): resolve an address to tokens, fetch a token to bytes. gallery-dl and the network are replaced by fakes.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const u16 = (n) => Buffer.from([(n >> 8) & 255, n & 255]);
const jpeg = (w = 1200, h = 800) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), u16(16), Buffer.alloc(14), Buffer.from([0xff, 0xc0]), u16(17), Buffer.from([8]), u16(h), u16(w), Buffer.alloc(20)]);
const PIN = (n) => `https://i.pinimg.com/originals/ab/cd/${n}.jpg`;
const BOARD = 'https://www.pinterest.com/some_one/kitchen-ideas/';
const ME = { account: 'acct1', address: '1.2.3.4' };
const OTHER = { account: 'acct2', address: '5.6.7.8' };

function fakeFetcher(table) {
  const calls = [];
  return {
    calls,
    async get(url, options) {
      calls.push(url);
      const hit = table[url] ?? table['*'];
      if (!hit) throw new FetchError('status', 'The site answered 404.', 404);
      if (hit instanceof Error) throw hit;
      const type = hit.type ?? 'image/jpeg';
      if (options.maxBytes(type) <= 0) throw new FetchError('type', 'That is not a picture or a web page.');
      return { body: hit.body, contentType: type, finalUrl: hit.finalUrl ?? url };
    },
  };
}
function fakeGallery(answer) {
  const calls = [];
  return {
    calls,
    ready: () => true,
    async run(job) {
      calls.push(job);
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(job) : answer;
    },
  };
}
const make = ({ fetcher = fakeFetcher({}), gallery = fakeGallery({ title: '', extractor: 'x', items: [] }), settings = {}, clock } = {}) => {
  let now = 1_000_000;
  const importer = createImporter({ settings: () => ({ enabled: true, python: 'p', script: 's', limit: 5, timeoutMs: 20000, maxFileBytes: 1_000_000, ...settings }), gallery, fetcher, now: () => (clock ? clock.now : now) });
  return importer;
};
const code = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ImportError, String(error));
    return `${error.reason}/${error.status}`;
  }
  return 'no error';
};

test('a link to a picture: resolved to a token, fetched once, checked, and kept for repeat requests', async () => {
  const fetcher = fakeFetcher({ 'https://example.com/a.jpg': { body: jpeg(3000, 2000) } });
  const importer = make({ fetcher });
  const out = await importer.resolve('here: https://example.com/a.jpg', ME);
  assert.equal(out.type, 'direct');
  assert.equal(out.kind, 'photo');
  assert.equal(out.source.label, 'example.com');
  assert.equal(out.items.length, 1);
  assert.match(out.items[0].token, /^[A-Za-z0-9_-]{24}$/);
  assert.ok(!JSON.stringify(out).includes('https://example.com/a.jpg'), 'the answer never carries the picture address');
  assert.equal(fetcher.calls.length, 0, 'nothing fetched until the picture is asked for');
  const file = await importer.file(out.items[0].token, ME);
  assert.deepEqual([file.type, file.width, file.height], ['image/jpeg', 3000, 2000]);
  assert.deepEqual((await importer.file(out.items[0].token, ME)).bytes, file.bytes);
  assert.equal(fetcher.calls.length, 1, 'the second request came from memory');
  importer.close();
});

test('a board: gallery-dl is asked for that one extractor with the site\'s options; the answer is tokens and previews, never addresses', async () => {
  const gallery = fakeGallery({ title: 'Kitchen ideas', extractor: 'pinterest:board', items: [1, 2, 3].map((n) => ({ url: PIN(n), width: 1000, height: 1500, title: `pin ${n}`, thumb: `https://i.pinimg.com/474x/ab/cd/${n}.jpg` })) });
  const importer = make({ gallery });
  const out = await importer.resolve(`${BOARD}?utm=1`, ME);
  assert.equal(gallery.calls.length, 1);
  assert.deepEqual(gallery.calls[0], { url: BOARD, sourceId: 'pinterest', extractor: 'pinterest:board', follows: [], options: { videos: false, stories: false, sections: false }, thumbs: 'pinterest', firstOnly: false });
  assert.equal(out.kind, 'collection');
  assert.equal(out.title, 'Kitchen ideas');
  assert.equal(out.items.length, 3);
  assert.equal(out.items[0].preview, 'https://i.pinimg.com/474x/ab/cd/1.jpg');
  assert.deepEqual(Object.keys(out.items[0]).sort(), ['height', 'preview', 'title', 'token', 'width']);
  assert.ok(!JSON.stringify(out).includes('originals'));
  // asked again: answered from memory, with fresh tokens of its own
  const again = await importer.resolve(BOARD, ME);
  assert.equal(gallery.calls.length, 1);
  assert.notEqual(again.items[0].token, out.items[0].token);
  importer.close();
});

test('a short link is passed on with what it may lead to, and one that leads to a board shows the picker', async () => {
  const gallery = fakeGallery({ title: 'Kitchen', extractor: 'pinterest:pinit', items: [1, 2, 3].map((n) => ({ url: PIN(n), width: 1, height: 1, title: '' })) });
  const importer = make({ gallery });
  const out = await importer.resolve('https://pin.it/4AbCdEf', ME);
  assert.deepEqual(gallery.calls[0].follows, ['pinterest:pin', 'pinterest:board']);
  assert.equal(gallery.calls[0].extractor, 'pinterest:pinit');
  assert.equal(out.kind, 'collection', 'the short link led to a board: the person chooses');
  importer.close();
});

test('a token belongs to the account that asked and means nothing to anyone else', async () => {
  const fetcher = fakeFetcher({ '*': { body: jpeg() } });
  const importer = make({ fetcher });
  const out = await importer.resolve('https://example.com/a.jpg', ME);
  const token = out.items[0].token;
  assert.equal(await code(importer.file(token, OTHER)), 'expired/410');
  assert.equal(await code(importer.file(token, { account: null, address: '1.2.3.4' })), 'expired/410');
  for (const bad of ['', 'nope', undefined, null, 42, 'x'.repeat(100), '../../etc/passwd', 'https://example.com/a.jpg']) assert.equal(await code(importer.file(bad, ME)), 'expired/410', String(bad));
  assert.equal(fetcher.calls.length, 0);
  assert.equal((await importer.file(token, ME)).type, 'image/jpeg');
  importer.close();
});

test('tokens expire after fifteen minutes', async () => {
  const clock = { now: 1_000_000 };
  const importer = make({ fetcher: fakeFetcher({ '*': { body: jpeg() } }), clock });
  const out = await importer.resolve('https://example.com/a.jpg', ME);
  clock.now += 14 * 60 * 1000;
  assert.equal((await importer.file(out.items[0].token, ME)).type, 'image/jpeg');
  clock.now += 2 * 60 * 1000;
  assert.equal(await code(importer.file(out.items[0].token, ME)), 'expired/410');
  importer.close();
});

test('a site with a profile is only read from its own picture hosts, even if gallery-dl\'s answer says otherwise', async () => {
  const fetcher = fakeFetcher({ '*': { body: jpeg() } });
  const gallery = fakeGallery({ title: '', extractor: 'pinterest:pin', items: [{ url: 'https://evil.example/x.jpg', width: null, height: null, title: '', thumb: undefined }] });
  const importer = make({ fetcher, gallery });
  const out = await importer.resolve('https://www.pinterest.com/pin/123456/', ME);
  assert.equal(await code(importer.file(out.items[0].token, ME)), 'failed/502');
  assert.equal(fetcher.calls.length, 0, 'nothing was fetched from the other host');
  importer.close();
});

test('Wikimedia: a single file address keeps the current version only', async () => {
  const gallery = fakeGallery({ title: 'File:X.jpg', extractor: 'wikimediacommons:file', items: [1, 2, 3].map((n) => ({ url: `https://upload.wikimedia.org/wikipedia/commons/${n}/X.jpg`, width: 10, height: 10, title: 't' })) });
  const importer = make({ gallery });
  const out = await importer.resolve('https://commons.wikimedia.org/wiki/File:X.jpg', ME);
  assert.equal(gallery.calls[0].firstOnly, true);
  assert.equal(out.items.length, 1);
  assert.equal(out.kind, 'photo');
  importer.close();
});

test('any other page: its own named picture is used, and the answer says it is approximate', async () => {
  const html = '<title>Modern kitchen</title><meta property="og:image" content="/img/hero.jpg">';
  const fetcher = fakeFetcher({ 'https://www.houzz.com/photos/modern': { body: Buffer.from(html), type: 'text/html' }, 'https://www.houzz.com/img/hero.jpg': { body: jpeg(1600, 900) } });
  const importer = make({ fetcher });
  const out = await importer.resolve('https://www.houzz.com/photos/modern', ME);
  assert.equal(out.type, 'page');
  assert.equal(out.approximate, true);
  assert.equal(out.title, 'Modern kitchen');
  assert.equal(out.items.length, 1);
  assert.deepEqual([(await importer.file(out.items[0].token, ME)).width], [1600]);
  assert.deepEqual(fetcher.calls, ['https://www.houzz.com/photos/modern', 'https://www.houzz.com/img/hero.jpg']);
  // a page without a named picture
  const bare = make({ fetcher: fakeFetcher({ '*': { body: Buffer.from('<p>hi</p>'), type: 'text/html' } }) });
  assert.equal(await code(bare.resolve('https://example.com/x', ME)), 'empty/404');
  importer.close();
  bare.close();
});

test('an address with no file ending that turns out to be a picture is used as it is, already downloaded', async () => {
  const fetcher = fakeFetcher({ 'https://images.example.com/photo-123': { body: jpeg(800, 600) } });
  const importer = make({ fetcher });
  const out = await importer.resolve('https://images.example.com/photo-123', ME);
  assert.equal(fetcher.calls.length, 1);
  assert.equal((await importer.file(out.items[0].token, ME)).width, 800);
  assert.equal(fetcher.calls.length, 1, 'the file route did not fetch it again');
  importer.close();
});

test('refused before anything is fetched: login sites, unsupported pages, junk, switched off, not set up', async () => {
  const fetcher = fakeFetcher({});
  const gallery = fakeGallery({ title: '', extractor: 'x', items: [] });
  const importer = make({ fetcher, gallery });
  assert.equal(await code(importer.resolve('https://www.instagram.com/p/AbC123/', ME)), 'login/422');
  assert.equal(await code(importer.resolve('https://www.pinterest.com/some_one/', ME)), 'unsupported/422');
  assert.equal(await code(importer.resolve('hello there', ME)), 'bad-address/400');
  assert.equal(await code(importer.resolve('https://127.0.0.1/a.jpg', ME)), 'bad-address/400');
  assert.equal(await code(importer.resolve(undefined, ME)), 'bad-address/400');
  assert.equal(fetcher.calls.length + gallery.calls.length, 0);
  importer.close();
  assert.equal(await code(make({ settings: { enabled: false } }).resolve('https://example.com/a.jpg', ME)), 'off/503');
  const missing = make({ gallery: { ready: () => false, run: async () => assert.fail('must not run') } });
  assert.equal(await code(missing.resolve(BOARD, ME)), 'not-set-up/503');
  assert.equal(missing.status().ready, false);
  missing.close();
});

test('what comes back is judged by its bytes: HTML, SVG, HEIC and oversize pictures are refused whatever they were called', async () => {
  const cases = {
    'https://example.com/html.jpg': { body: Buffer.from('<!doctype html><script>alert(1)</script>') },
    'https://example.com/svg.png': { body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
    'https://example.com/huge.jpg': { body: jpeg(20000, 20000) },
  };
  const importer = make({ fetcher: fakeFetcher(cases) });
  const expected = { 'html.jpg': 'not-an-image/415', 'svg.png': 'not-an-image/415', 'huge.jpg': 'too-big/413' };
  for (const [name, outcome] of Object.entries(expected)) {
    const out = await importer.resolve(`https://example.com/${name}`, ME);
    assert.equal(await code(importer.file(out.items[0].token, ME)), outcome, name);
  }
  importer.close();
});

test('what the other site says is turned into plain answers', async () => {
  const table = {
    'https://example.com/404.jpg': new FetchError('status', 'x', 404),
    'https://example.com/403.jpg': new FetchError('status', 'x', 403),
    'https://example.com/500.jpg': new FetchError('status', 'x', 500),
    'https://example.com/slow.jpg': new FetchError('timeout', 'x'),
    'https://example.com/big.jpg': new FetchError('too-big', 'x'),
    'https://example.com/net.jpg': new FetchError('network', 'ECONNRESET at 10.0.0.1:443'),
    'https://example.com/blocked.jpg': new FetchError('blocked', 'x'),
  };
  const importer = make({ fetcher: fakeFetcher(table) });
  const expected = { '404': 'not-found/404', '403': 'private/422', '500': 'status/502', slow: 'timeout/504', big: 'too-big/413', net: 'network/502', blocked: 'blocked/422' };
  for (const [name, outcome] of Object.entries(expected)) {
    const out = await importer.resolve(`https://example.com/${name}.jpg`, ME);
    try {
      await importer.file(out.items[0].token, ME);
      assert.fail('no error');
    } catch (error) {
      assert.equal(`${error.reason}/${error.status}`, outcome, name);
      assert.ok(!/10\.0\.0\.1|ECONNRESET/.test(error.message), 'the network error text is not passed on');
    }
  }
  importer.close();
});

test('limits: thirty addresses an hour per account, a few at a time, and the answer says when to come back', async () => {
  const importer = make({ fetcher: fakeFetcher({ '*': { body: jpeg() } }) });
  for (let n = 0; n < 30; n += 1) await importer.resolve(`https://example.com/${n}.jpg`, ME);
  let error;
  try {
    await importer.resolve('https://example.com/31.jpg', ME);
  } catch (e) {
    error = e;
  }
  assert.equal(`${error.reason}/${error.status}`, 'rate/429');
  assert.ok(error.retryAfter > 0);
  // the same address again is free (answered from memory); another account has its own allowance, per-address limit aside
  assert.equal((await importer.resolve('https://example.com/3.jpg', ME)).items.length, 1);
  assert.equal((await importer.resolve('https://example.com/31.jpg', OTHER)).items.length, 1);
  importer.close();

  const waiting = [];
  const gallery = { ready: () => true, run: () => new Promise((resolve) => waiting.push(() => resolve({ title: '', extractor: 'x', items: [{ url: PIN(1), width: 1, height: 1, title: '' }] }))) };
  const busy = make({ gallery });
  const a = busy.resolve('https://www.pinterest.com/pin/111111/', { account: 'a', address: '9.9.9.1' });
  const b = busy.resolve('https://www.pinterest.com/pin/222222/', { account: 'b', address: '9.9.9.2' });
  const c = busy.resolve('https://www.pinterest.com/pin/333333/', { account: 'c', address: '9.9.9.3' });
  assert.equal(await code(busy.resolve('https://www.pinterest.com/pin/444444/', { account: 'd', address: '9.9.9.4' })), 'busy/503');
  waiting.forEach((finish) => finish());
  await Promise.all([a, b, c]);
  busy.close();
});

// ---- the gallery-dl runner (python/gallery_resolve.py is replaced by a function)

const settings = { enabled: true, python: process.execPath, script: fileURLToPath(import.meta.url), limit: 3, timeoutMs: 20000 };
const JOB = { url: BOARD, sourceId: 'pinterest', extractor: 'pinterest:board', options: { videos: false }, thumbs: 'pinterest' };
function runner(answer, extra = {}) {
  const calls = [];
  const warnings = [];
  const exec = (file, args, options, done) => {
    calls.push({ file, args, options });
    if (answer instanceof Error) return done(answer, '');
    done(null, typeof answer === 'string' ? answer : JSON.stringify(answer));
  };
  return { calls, warnings, gallery: createGalleryRunner({ settings: () => ({ ...settings, ...extra }), exec, log: { warn: (m) => warnings.push(m) } }) };
}

test('the program is started without a shell, with one JSON request, a bare environment and a time limit', async () => {
  const { gallery, calls } = runner({ ok: true, extractor: 'pinterest:board', title: 'T', items: [{ url: PIN(1), width: 10, height: 20, title: 'a' }] });
  process.env.TERUCON_TEST_SECRET = 'must-not-leak';
  await gallery.run(JOB);
  delete process.env.TERUCON_TEST_SECRET;
  const [{ args, options, file }] = calls;
  assert.equal(file, process.execPath);
  assert.equal(args.length, 2);
  assert.deepEqual(JSON.parse(args[1]), { url: BOARD, allow: ['pinterest:board'], follow: [], options: { videos: false }, thumbs: 'pinterest', limit: 3, seconds: 15 });
  assert.equal(options.timeout, 20000);
  assert.ok(options.maxBuffer <= 4 * 1024 * 1024);
  assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'PATH']);
  assert.notEqual(options.env.HOME, process.env.HOME, 'a private home folder, not the server\'s own');
  assert.equal(options.shell, undefined);
});

test('only https pictures on the site\'s own hosts come out, once each, within the limit; names are cleaned', async () => {
  const { gallery, warnings } = runner({
    ok: true,
    extractor: 'pinterest:board',
    title: 'Kitchen\u0007 ideas',
    items: [
      { url: PIN(1), width: 10, height: 20, title: 'ok\nline' },
      { url: PIN(1), width: 10, height: 20, title: 'duplicate' },
      { url: 'http://i.pinimg.com/x.jpg' },
      { url: 'https://evil.example/x.jpg' },
      { url: 'https://i.pinimg.com.evil.example/x.jpg' },
      { url: 'https://u:p@i.pinimg.com/x.jpg' },
      { url: 'https://i.pinimg.com:444/x.jpg' },
      { url: 'text:hello' },
      { url: PIN(2), width: -5, height: 'big', title: 5, thumb: 'https://evil.example/t.jpg' },
      { url: PIN(3), thumb: 'https://i.pinimg.com/474x/t.jpg' },
      { url: PIN(4) },
      { url: PIN(5) },
    ],
  });
  const out = await gallery.run(JOB);
  assert.deepEqual(out.items.map((i) => i.url), [PIN(1), PIN(2), PIN(3)]);
  assert.equal(out.title, 'Kitchen ideas');
  assert.equal(out.items[0].title, 'ok line');
  assert.deepEqual([out.items[1].width, out.items[1].height, out.items[1].title], [null, null, '']);
  assert.equal(out.items[1].thumb, undefined, 'a thumbnail on another host is dropped');
  assert.equal(out.items[2].thumb, 'https://i.pinimg.com/474x/t.jpg');
  assert.ok(warnings.some((w) => /outside its list/.test(w)), 'a wrong host list is visible in the log');
});

test('what the program says goes out as a plain answer, and a broken program is "not set up", never its text', async () => {
  const cases = [
    [{ ok: false, reason: 'not-found' }, 'not-found/404'],
    [{ ok: false, reason: 'private' }, 'private/422'],
    [{ ok: false, reason: 'blocked' }, 'blocked/502'],
    [{ ok: false, reason: 'empty' }, 'empty/404'],
    [{ ok: false, reason: 'timeout' }, 'timeout/504'],
    [{ ok: false, reason: 'unsupported' }, 'unsupported/422'],
    [{ ok: false, reason: 'something-new' }, 'failed/502'],
    [{ ok: false, reason: 'not-installed' }, 'not-set-up/503'],
    [{ ok: true, items: [{ url: 'https://evil.example/x.jpg' }] }, 'empty/404'],
    [{ ok: true, items: 'nope' }, 'empty/404'],
    ['Traceback (most recent call last): secret path /home/x', 'failed/502'],
    [Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), 'not-set-up/503'],
    [Object.assign(new Error('timed out'), { killed: true }), 'timeout/504'],
  ];
  for (const [answer, expected] of cases) {
    const { gallery } = runner(answer);
    assert.equal(await code(gallery.run(JOB)), expected, JSON.stringify(answer));
  }
});

test('a single-picture address asks for one picture', async () => {
  const { gallery, calls } = runner({ ok: true, items: [{ url: 'https://upload.wikimedia.org/a.jpg' }, { url: 'https://upload.wikimedia.org/b.jpg' }] });
  const out = await gallery.run({ url: 'https://commons.wikimedia.org/wiki/File:X.jpg', sourceId: 'wikimedia', extractor: 'wikimediacommons:file', options: {}, firstOnly: true });
  assert.equal(JSON.parse(calls[0].args[1]).limit, 1);
  assert.equal(out.items.length, 1);
});

test('the settings default to the website\'s own python/ folder and are bounded', () => {
  const none = loadSettings(path.join(ROOT, 'no-such.env'), {}, ROOT).inspiration;
  assert.equal(none.enabled, true);
  assert.equal(none.python, path.join(ROOT, 'python/.venv/bin/python'));
  assert.equal(none.script, path.join(ROOT, 'python/gallery_resolve.py'));
  assert.equal(none.limit, 40);
  assert.equal(none.timeoutMs, 60000);
  assert.equal(none.maxFileBytes, 25 * 1024 * 1024);
  const set = loadSettings(path.join(ROOT, 'no-such.env'), { INSPIRATION_IMPORT: 'off', INSPIRATION_LIMIT: '100000', INSPIRATION_TIMEOUT_SECONDS: '1', INSPIRATION_MAX_FILE_MB: '9999' }, ROOT).inspiration;
  assert.equal(set.enabled, false);
  assert.equal(set.limit, 100);
  assert.equal(set.timeoutMs, 10000);
  assert.equal(set.maxFileBytes, 50 * 1024 * 1024);
});
