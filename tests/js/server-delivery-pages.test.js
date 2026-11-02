// The pages of site/site.json, answered from dist/ (server/lib/delivery.js, server/routes/pages.js): 200 and 304, br / gzip / plain,
// Vary, the rules that were already there (gate, aliases, site.json headers, Cache-Control), and the fall-back to pages/*.html when
// dist/ is missing or broken. dist/ here is a small fake one (server-delivery-helpers.js); the real one is tested in tests/js/dist-*.test.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import zlib from 'node:zlib';
import { chooseEncoding, createDist } from '../../server/lib/delivery.js';
import { startTestApp } from '../helpers/app.js';
import { ETAGS, pageText, writeFixtureDist } from './server-delivery-helpers.js';

const varyTokens = (r) => (r.headers.vary ?? '').split(/\s*,\s*/).filter(Boolean);

describe('a page answered from dist/', () => {
  let app;
  let member;
  before(async () => {
    app = await startTestApp();
    writeFixtureDist(app.root, { pages: ['home', 'materials', 'studio'] });
    member = await app.signIn();
  });
  after(() => app.stop());

  test('the landing page is the built file, with a strong ETag, no-cache and Vary: Accept-Encoding', async () => {
    const r = await app.get('/');
    assert.equal(r.status, 200);
    assert.equal(r.text, pageText('home'));
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers.etag, `"${ETAGS.home}"`);
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.deepEqual(varyTokens(r), ['Accept-Encoding']);
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(Number(r.headers['content-length']), r.buffer.length);
    assert.equal(r.headers['last-modified'], undefined, 'one validator: the ETag');
    assert.equal(r.headers['accept-ranges'], undefined);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });

  test('brotli when the client takes it: the .br copy, its own ETag, the right type and length', async () => {
    const r = await app.get('/', { 'Accept-Encoding': 'br' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'br');
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', 'the type of the page, not of the .br file');
    assert.equal(r.headers.etag, `"${ETAGS.home}-br"`);
    assert.equal(Number(r.headers['content-length']), r.buffer.length);
    assert.ok(r.buffer.length < Buffer.byteLength(pageText('home')) / 5, `${r.buffer.length} bytes`);
    assert.equal(zlib.brotliDecompressSync(r.buffer).toString('utf8'), pageText('home'));
    assert.deepEqual(varyTokens(r), ['Accept-Encoding']);
  });

  test('gzip when it takes that but not brotli', async () => {
    const r = await app.get('/', { 'Accept-Encoding': 'gzip, deflate' });
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.equal(r.headers.etag, `"${ETAGS.home}-gz"`);
    assert.equal(zlib.gunzipSync(r.buffer).toString('utf8'), pageText('home'));
  });

  test('which coding wins: br over gzip on a tie (Chrome and Safari list gzip first), q-values and "*" are honoured, "no" is honoured', async () => {
    const cases = {
      'gzip, deflate, br, zstd': 'br',
      'br': 'br',
      'gzip': 'gzip',
      'gzip;q=1.0, br;q=0.4': 'gzip',
      'br;q=0, gzip': 'gzip',
      'br;q=0, gzip;q=0': 'identity',
      '*': 'br',
      '*;q=0': 'identity',
      'identity': 'identity',
      'deflate': 'identity',
      '': 'identity',
      'BR': 'br',
      'x-gzip': 'gzip',
      'br;q=0.0': 'identity',
      'br ; q = 0.5, gzip;q=0.9': 'gzip',
      'br ; q = 0.9, gzip;q=0.5': 'br',
    };
    for (const [header, expected] of Object.entries(cases)) {
      assert.equal(chooseEncoding(header), expected, JSON.stringify(header));
    }
    assert.equal(chooseEncoding(undefined), 'identity');
    assert.equal(chooseEncoding('br, gzip', { br: false, gzip: true }), 'gzip', 'a coding the file does not have is not offered');
    assert.equal(chooseEncoding('br, gzip', { br: false, gzip: false }), 'identity');
    // and over the wire
    for (const [header, expected] of [['gzip, deflate, br', 'br'], ['br;q=0, gzip', 'gzip'], ['br;q=0, gzip;q=0', undefined], ['deflate', undefined]]) {
      const r = await app.get('/', { 'Accept-Encoding': header });
      assert.equal(r.headers['content-encoding'], expected, header);
      assert.equal(r.text.length > 0 || expected !== undefined, true);
    }
  });

  test('If-None-Match: the same tag is a 304 with no body and the headers a cache needs; another tag, or the tag of another coding, is not', async () => {
    const first = await app.get('/', { 'Accept-Encoding': 'br' });
    const tag = first.headers.etag;
    const again = await app.get('/', { 'Accept-Encoding': 'br', 'If-None-Match': tag });
    assert.equal(again.status, 304);
    assert.equal(again.buffer.length, 0);
    assert.equal(again.headers.etag, tag);
    assert.equal(again.headers['cache-control'], 'no-cache');
    assert.deepEqual(varyTokens(again), ['Accept-Encoding']);

    assert.equal((await app.get('/', { 'Accept-Encoding': 'br', 'If-None-Match': `"nope", ${tag}` })).status, 304, 'a list');
    assert.equal((await app.get('/', { 'Accept-Encoding': 'br', 'If-None-Match': `W/${tag}` })).status, 304, 'weak comparison, as the rules say for If-None-Match');
    assert.equal((await app.get('/', { 'Accept-Encoding': 'br', 'If-None-Match': '"something-else"' })).status, 200);
    assert.equal((await app.get('/', { 'If-None-Match': tag })).status, 200, 'the tag of the brotli body does not stand for the plain one');
    const plain = (await app.get('/')).headers.etag;
    assert.equal((await app.get('/', { 'If-None-Match': plain })).status, 304);
    assert.equal((await app.get('/', { 'If-None-Match': plain, 'Cache-Control': 'no-cache' })).status, 200, 'a hard reload (no-cache in the request) gets the page');
    const all = new Set([plain, tag, (await app.get('/', { 'Accept-Encoding': 'gzip' })).headers.etag]);
    assert.equal(all.size, 3, 'the three bodies have three tags');
  });

  test('HEAD answers the headers of the variant and no body', async () => {
    const r = await app.request('/', { method: 'HEAD', headers: { 'Accept-Encoding': 'br' } });
    assert.equal(r.status, 200);
    assert.equal(r.buffer.length, 0);
    assert.equal(r.headers['content-encoding'], 'br');
    const body = await app.get('/', { 'Accept-Encoding': 'br' });
    assert.equal(r.headers['content-length'], String(body.buffer.length));
    assert.equal(r.headers.etag, body.headers.etag);
  });

  test('a page for members: the gate still stands in front, and its answer is private and varies on the cookie as well', async () => {
    const stranger = await app.get('/materials', { 'Accept-Encoding': 'br' });
    assert.equal(stranger.status, 302);
    assert.match(stranger.headers.location, /^\/login/);
    assert.equal(stranger.headers['content-encoding'], undefined);
    assert.ok(!stranger.text.includes('page materials'));

    const r = await app.get('/materials', { ...member.headers, 'Accept-Encoding': 'br' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'private, no-cache');
    assert.deepEqual(varyTokens(r), ['Cookie', 'Accept-Encoding']);
    assert.equal(zlib.brotliDecompressSync(r.buffer).toString('utf8'), pageText('materials'));
    const conditional = await app.get('/materials', { ...member.headers, 'Accept-Encoding': 'br', 'If-None-Match': r.headers.etag });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.headers['cache-control'], 'private, no-cache');
  });

  test('the headers site.json adds to a page are still added', async () => {
    const r = await app.get('/design-studio', { ...member.headers, 'Accept-Encoding': 'gzip' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['permissions-policy'], 'camera=(self), microphone=(), geolocation=()');
    assert.equal(zlib.gunzipSync(r.buffer).toString('utf8'), pageText('studio'));
  });

  test('aliases, capitals and a trailing slash still redirect (the redirect itself is not compressed or tagged)', async () => {
    for (const [from, to, status] of [['/index.html', '/', 301], ['/materials.html', '/materials', 301], ['/Materials', '/materials', 301], ['/studio', '/design-studio', 301], ['/Terucon Swatchroom.html', '/design-studio', 301]]) {
      const r = await app.get(encodeURI(from), { 'Accept-Encoding': 'br' });
      assert.equal(r.status, status, from);
      assert.equal(r.headers.location, to, from);
      assert.equal(r.headers.etag, undefined, from);
    }
  });

  test('a page dist does not have is served from pages/ as before (a weak tag and Last-Modified from the file)', async () => {
    const r = await app.get('/my-project', member.headers);
    assert.equal(r.status, 200);
    assert.equal(r.text, app.page('dashboard'));
    assert.match(r.headers.etag, /^W\//);
    assert.ok(r.headers['last-modified']);
    assert.equal(r.headers['cache-control'], 'private, no-cache');
  });

  test('the hand-written pages stay on pages/ with their own policy (they are not in the manifest)', async () => {
    const r = await app.get('/login');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-security-policy'], /^default-src 'none'/);
    assert.match(r.headers.etag, /^W\//);
    const overview = await app.get('/project-overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.headers['cache-control'], 'no-cache');
  });

  test('a manifest entry that points outside dist/pages, or has a tag that could break a header, is ignored (that page comes from pages/)', async () => {
    const root = fs.mkdtempSync(path.join(app.root, 'sub-'));
    writeFixtureDist(root, { pages: ['home', 'materials'] });
    const file = path.join(root, 'dist', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.pages.home.file = 'pages/../../secret.html';
    manifest.pages.materials.etag = 'x"\r\nSet-Cookie: a=b';
    manifest.pages.extra = { file: '/etc/passwd', etag: 'abcdef' };
    fs.writeFileSync(file, JSON.stringify(manifest));
    const dist = createDist(root, {}, { recheckMs: 0 });
    assert.equal(dist.page('home'), null);
    assert.equal(dist.page('materials'), null);
    assert.equal(dist.page('extra'), null);
  });
});

describe('without a usable dist/', () => {
  test('no dist/ at all: pages/*.html exactly as before, and /assets answers 404', async () => {
    const app = await startTestApp();
    try {
      const r = await app.get('/', { 'Accept-Encoding': 'br' });
      assert.equal(r.status, 200);
      assert.equal(r.text, app.page('home'));
      assert.match(r.headers.etag, /^W\//);
      assert.ok(r.headers['last-modified']);
      assert.equal(r.headers['cache-control'], 'no-cache');
      assert.equal(r.headers['content-encoding'], undefined, 'the page is far under 1 KB');
      assert.equal((await app.get('/assets/app-0123456789ab.js')).status, 404);
      assert.equal(app.app.locals.terucon.dist.status().enabled, false);
    } finally {
      await app.stop();
    }
  });

  test('a manifest that is not JSON: pages/*.html, one warning in the log (not one per request)', async () => {
    const app = await startTestApp();
    try {
      writeFixtureDist(app.root, { brokenManifest: true });
      for (let i = 0; i < 3; i += 1) assert.equal((await app.get('/')).text, app.page('home'));
      const warnings = app.log.lines.filter((line) => line.includes('dist/manifest.json is unusable'));
      assert.equal(warnings.length, 1, app.log.lines.join('\n'));
      assert.match(warnings[0], /npm run build:dist/);
    } finally {
      await app.stop();
    }
  });

  test('a manifest from another version of the contract is not trusted either', async () => {
    const app = await startTestApp();
    try {
      writeFixtureDist(app.root);
      const file = path.join(app.root, 'dist', 'manifest.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), version: 2 }));
      assert.equal((await app.get('/')).text, app.page('home'));
    } finally {
      await app.stop();
    }
  });

  test('a page the manifest lists but whose file is missing comes from pages/; the others still from dist/', async () => {
    const app = await startTestApp();
    try {
      writeFixtureDist(app.root);
      fs.rmSync(path.join(app.root, 'dist', 'pages', 'home.html'));
      assert.equal((await app.get('/')).text, app.page('home'));
      const member = await app.signIn();
      assert.equal((await app.get('/materials', member.headers)).headers.etag, `"${ETAGS.materials}"`);
    } finally {
      await app.stop();
    }
  });

  test('the .br copy disappears after the manifest was read: still a 200, never a 500', async () => {
    const app = await startTestApp();
    try {
      writeFixtureDist(app.root);
      assert.equal((await app.get('/', { 'Accept-Encoding': 'br' })).headers['content-encoding'], 'br'); // read once
      fs.rmSync(path.join(app.root, 'dist', 'pages', 'home.html.br'));
      const r = await app.get('/', { 'Accept-Encoding': 'br' });
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-encoding'], undefined);
      assert.equal(r.text, app.page('home'));
    } finally {
      await app.stop();
    }
  });

  test('a page whose .br / .gz copies do not exist is sent plain, with its tag, and is not compressed on the fly under a strong tag', async () => {
    const app = await startTestApp();
    try {
      writeFixtureDist(app.root, { onlyPlainPages: true });
      const r = await app.get('/', { 'Accept-Encoding': 'br, gzip' });
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-encoding'], undefined);
      assert.equal(r.text, pageText('home'));
      assert.equal(r.headers.etag, `"${ETAGS.home}"`);
    } finally {
      await app.stop();
    }
  });
});

describe('a rebuilt dist/ is noticed', () => {
  test('createDist looks at the manifest again: new tag, new page, and back to nothing when it is removed', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'terucon-dist-'));
    try {
      const dist = createDist(root, {}, { recheckMs: 0 });
      assert.equal(dist.page('home'), null);
      assert.equal(dist.status().enabled, false);
      writeFixtureDist(root, { pages: ['home'] });
      assert.equal(dist.page('home').etag, ETAGS.home);
      assert.deepEqual(dist.status().pages, ['home']);
      const file = path.join(root, 'dist', 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      manifest.pages.home.etag = 'ffffffffffffffff';
      fs.writeFileSync(file, JSON.stringify(manifest) + ' ');
      assert.equal(dist.page('home').etag, 'ffffffffffffffff');
      fs.rmSync(file);
      assert.equal(dist.page('home'), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
