// GET /assets/* (dist/assets) and GET /brand/*, /favicon.ico, /site.webmanifest (site/brand): types, cache policy, precompressed copies,
// a fixed list of extensions, and no way out of the folder. dist/ is the fake one of server-delivery-helpers.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import zlib from 'node:zlib';
import { startTestApp } from '../helpers/app.js';
import { PROJECT_ROOT } from '../helpers/tempRoot.js';
import { ASSETS, writeFixtureDist } from './server-delivery-helpers.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';

describe('/assets: the built site\'s files', () => {
  let app;
  before(async () => {
    app = await startTestApp();
    writeFixtureDist(app.root);
  });
  after(() => app.stop());

  const get = (name, headers) => app.get(`/assets/${name}`, headers);

  test('a hashed file lives for a year and is immutable; the type is the original\'s', async () => {
    for (const [name, asset] of Object.entries(ASSETS)) {
      if (name === 'plain.js') continue;
      const r = await get(name);
      assert.equal(r.status, 200, name);
      assert.equal(r.headers['cache-control'], IMMUTABLE, name);
      assert.ok(r.headers['content-type'].startsWith(asset.type), `${name}: ${r.headers['content-type']}`);
      assert.deepEqual(r.buffer, asset.body, name);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', name);
    }
  });

  test('brotli, else gzip, else the plain file, by Accept-Encoding; Content-Type and Content-Length are the served copy\'s', async () => {
    const asset = ASSETS['app-0123456789ab.js'];
    const br = await get('app-0123456789ab.js', { 'Accept-Encoding': 'gzip, deflate, br' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.match(br.headers['content-type'], /^text\/javascript/);
    assert.equal(Number(br.headers['content-length']), br.buffer.length);
    assert.deepEqual(zlib.brotliDecompressSync(br.buffer), asset.body);
    assert.equal(br.headers['cache-control'], IMMUTABLE);
    assert.deepEqual(br.headers.vary.split(/\s*,\s*/), ['Accept-Encoding']);

    const gz = await get('app-0123456789ab.js', { 'Accept-Encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.deepEqual(zlib.gunzipSync(gz.buffer), asset.body);

    const plain = await get('app-0123456789ab.js');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.deepEqual(plain.buffer, asset.body);
    assert.deepEqual(plain.headers.vary.split(/\s*,\s*/), ['Accept-Encoding'], 'the plain copy says the answer depends on the header too');

    assert.ok(br.buffer.length < gz.buffer.length && gz.buffer.length < plain.buffer.length, `${br.buffer.length} < ${gz.buffer.length} < ${plain.buffer.length}`);
  });

  test('a file with only a gzip copy gets that to a browser that takes both', async () => {
    const r = await get('only-gzip-abcdef012345.css', { 'Accept-Encoding': 'br, gzip' });
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.match(r.headers['content-type'], /^text\/css/);
    assert.deepEqual(zlib.gunzipSync(r.buffer), ASSETS['only-gzip-abcdef012345.css'].body);
  });

  test('a file the manifest does not list is found on disk, with its copies, and (no hash in the name) is revalidated, not frozen', async () => {
    const r = await get('plain.js', { 'Accept-Encoding': 'gzip' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.equal(r.headers['cache-control'], 'public, no-cache');
    const again = await get('plain.js', { 'If-None-Match': (await get('plain.js')).headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.headers['cache-control'], 'public, no-cache');
  });

  test('a text file with no precompressed copy is compressed on the fly for a browser that takes it (it has a weak validator, which stays true)', async () => {
    const r = await get('no-copies-0a1b2c3d4e5f.json', { 'Accept-Encoding': 'br' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'br');
    assert.match(r.headers.etag, /^W\//);
    assert.deepEqual(zlib.brotliDecompressSync(r.buffer), ASSETS['no-copies-0a1b2c3d4e5f.json'].body);
  });

  test('images, fonts and video are never compressed and carry no Vary; video and images take Range', async () => {
    for (const name of ['logo-111111111111.png', 'font-222222222222.woff2', 'clip-333333333333.mp4']) {
      const r = await get(name, { 'Accept-Encoding': 'br, gzip' });
      assert.equal(r.headers['content-encoding'], undefined, name);
      assert.equal(r.headers.vary, undefined, name);
      assert.equal(r.headers['accept-ranges'], 'bytes', name);
    }
    const part = await get('clip-333333333333.mp4', { Range: 'bytes=10-19' });
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], 'bytes 10-19/5000');
    assert.deepEqual(part.buffer, ASSETS['clip-333333333333.mp4'].body.subarray(10, 20));
    assert.equal(part.headers['cache-control'], IMMUTABLE);
  });

  test('a Range request for a precompressed file is answered whole: a byte range of a coded body is useless', async () => {
    const r = await get('app-0123456789ab.js', { 'Accept-Encoding': 'br', Range: 'bytes=0-9' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'br');
    assert.equal(r.headers['content-range'], undefined);
    assert.equal(r.headers['accept-ranges'], undefined);
  });

  test('conditional requests: 304 and the cache policy stays', async () => {
    const first = await get('logo-111111111111.png');
    assert.ok(first.headers.etag && first.headers['last-modified']);
    const r = await get('logo-111111111111.png', { 'If-None-Match': first.headers.etag });
    assert.equal(r.status, 304);
    assert.equal(r.headers['cache-control'], IMMUTABLE);
    assert.equal((await get('logo-111111111111.png', { 'If-Modified-Since': first.headers['last-modified'] })).status, 304);
  });

  test('HEAD', async () => {
    const r = await app.request('/assets/app-0123456789ab.js', { method: 'HEAD', headers: { 'Accept-Encoding': 'br' } });
    assert.equal(r.status, 200);
    assert.equal(r.buffer.length, 0);
    assert.equal(r.headers['content-encoding'], 'br');
    assert.equal(r.headers['cache-control'], IMMUTABLE);
    assert.ok(Number(r.headers['content-length']) > 0);
  });

  test('only GET and HEAD: a POST is not a file', async () => {
    const r = await app.post('/assets/app-0123456789ab.js', {});
    assert.ok(r.status >= 400 && r.status < 500, String(r.status));
  });

  describe('nothing outside dist/assets, nothing that is not on the list', () => {
    const urls = [
      '/assets/../manifest.json', '/assets/..%2fmanifest.json', '/assets/%2e%2e/manifest.json', '/assets/%2e%2e%2fmanifest.json', '/assets/%2E%2E%2Fsecret.txt',
      '/assets/sub/..%2f..%2fsecret.txt', '/assets/..%5csecret.txt', '/assets/..\\secret.txt', '/assets/%5c..%5csecret.txt', '/assets/app-0123456789ab.js/../../secret.txt',
      '/assets/....//secret.txt', '/assets/%2e%2e%2f%2e%2e%2f.env', '/assets/..%252fsecret.txt',
      '/assets/.secret-555555555555.js', '/assets/sub/.hidden.js', '/assets//app-0123456789ab.js', '/assets/./app-0123456789ab.js',
      '/assets/app-0123456789ab.js.br', '/assets/app-0123456789ab.js.gz', '/assets/page-444444444444.html', '/assets/manifest.json.br',
      '/assets/app-0123456789ab.js%00.png', '/assets/app-0123456789ab.js%00', '/assets/notes.md', '/assets/x.py', '/assets/x.map', '/assets/x.exe',
      '/assets/', '/assets', '/assets/sub/', '/assets/..', '/assets/%2e%2e', '/assets/app-0123456789ab.JS.br',
    ];
    for (const url of urls) {
      test(`GET ${url} is a 404 that leaks nothing`, async () => {
        const r = await app.request(url, { headers: { Accept: 'text/html' } });
        assert.equal(r.status, 404);
        assert.ok(!/DECOY|secret|fixture/i.test(r.text.replace(/secret outside/g, '')), r.text);
        assert.equal(r.headers['content-encoding'], undefined);
      });
    }
  });

  test('a miss is a plain 404 in the website\'s error shape, never cached, and not the Coming soon page even for a browser', async () => {
    for (const url of ['/assets/nothing-here-0123456789ab.js', '/assets/nothing', '/assets/sub/nothing.css']) {
      const r = await app.get(url, { Accept: 'text/html,application/xhtml+xml' });
      assert.equal(r.status, 404, url);
      assert.match(r.headers['content-type'], /^application\/json/, url);
      assert.deepEqual(r.json(), { error: { code: 404, status: 'NOT_FOUND', message: 'No such file.' } }, url);
      assert.equal(r.headers['cache-control'], 'no-store', url);
      assert.ok(!/Coming soon/i.test(r.text), url);
    }
    // while an address that is a page nobody built still gets the branded page
    const page = await app.get('/careers', { Accept: 'text/html' });
    assert.equal(page.status, 404);
    assert.match(page.text, /Coming soon/);
  });

  test('"/assets" collides with nothing the studio serves: the studio has no assets folder and no such route', () => {
    const studio = path.join(PROJECT_ROOT, 'swatchroom');
    if (!fs.existsSync(path.join(studio, 'server', 'index.js'))) return;
    assert.ok(!fs.existsSync(path.join(studio, 'public', 'assets')), 'its static folder has no assets/ in it');
    assert.ok(!fs.existsSync(path.join(studio, 'public', 'brand')));
    const source = fs.readFileSync(path.join(studio, 'server', 'index.js'), 'utf8');
    assert.ok(!/["'`]\/(assets|brand)\b/.test(source), 'and its server has no route of that name');
  });
});

describe('/brand, /favicon.ico and /site.webmanifest', () => {
  let app;
  const CACHE = 'public, max-age=86400, stale-while-revalidate=604800';
  before(async () => {
    app = await startTestApp();
    const brand = path.join(app.root, 'site', 'brand');
    const put = (name, content) => {
      fs.mkdirSync(path.dirname(path.join(brand, name)), { recursive: true });
      fs.writeFileSync(path.join(brand, name), content);
    };
    put('brand.css', ':root{--x:1}\n'.repeat(300));
    put('dock.js', 'console.log(1);\n'.repeat(200));
    put('logo-full-640.webp', Buffer.from(Array.from({ length: 900 }, (_, i) => i % 255)));
    put('logo-full-640.png', Buffer.from(Array.from({ length: 900 }, (_, i) => i % 253)));
    put('og-image.jpg', Buffer.from(Array.from({ length: 900 }, (_, i) => i % 249)));
    put('mark.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    put('sub/deep.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    put('data.json', '{"a":1}');
    put('loader.html', '<!doctype html><title>snippet</title><script>DECOY</script>');
    put('head.html', '<meta name="x">');
    put('dock.md', '# notes DECOY');
    put('.hidden.css', 'DECOY');
    put('notes.txt', 'DECOY');
  });
  after(() => app.stop());

  test('files of the list are served with a day of freshness and a week of stale-while-revalidate, and validators', async () => {
    const types = { 'brand.css': /^text\/css/, 'dock.js': /^text\/javascript/, 'logo-full-640.webp': /^image\/webp$/, 'logo-full-640.png': /^image\/png$/, 'og-image.jpg': /^image\/jpeg$/, 'mark.svg': /^image\/svg\+xml/, 'sub/deep.svg': /^image\/svg\+xml/, 'data.json': /^application\/json/ };
    for (const [name, type] of Object.entries(types)) {
      const r = await app.get(`/brand/${name}`);
      assert.equal(r.status, 200, name);
      assert.match(r.headers['content-type'], type, name);
      assert.equal(r.headers['cache-control'], CACHE, name);
      assert.ok(r.headers.etag && r.headers['last-modified'], name);
    }
    const first = await app.get('/brand/brand.css');
    assert.equal((await app.get('/brand/brand.css', { 'If-None-Match': first.headers.etag })).status, 304);
    const head = await app.request('/brand/brand.css', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.buffer.length, 0);
  });

  test('the text types are compressed on the way out (the compression middleware), the images are not', async () => {
    const css = await app.get('/brand/brand.css', { 'Accept-Encoding': 'br' });
    assert.equal(css.headers['content-encoding'], 'br');
    assert.equal(zlib.brotliDecompressSync(css.buffer).toString(), ':root{--x:1}\n'.repeat(300));
    assert.equal(css.headers['cache-control'], CACHE);
    const png = await app.get('/brand/logo-full-640.png', { 'Accept-Encoding': 'br' });
    assert.equal(png.headers['content-encoding'], undefined);
    const range = await app.get('/brand/brand.css', { 'Accept-Encoding': 'br', Range: 'bytes=0-99' });
    assert.equal(range.status, 206);
    assert.equal(range.headers['content-encoding'], undefined, 'a byte range is never compressed');
    assert.equal(range.buffer.length, 100);
  });

  test('HTML, notes, hidden files and anything not on the list are not served; neither is anything outside the folder', async () => {
    const urls = ['/brand/loader.html', '/brand/head.html', '/brand/dock.md', '/brand/notes.txt', '/brand/.hidden.css', '/brand/sub/.x.css', '/brand/nope.css', '/brand/',
      '/brand', '/brand/sub', '/brand/../site.json', '/brand/..%2fsite.json', '/brand/%2e%2e/site.json', '/brand/%2e%2e%2f%2e%2e%2f.env', '/brand/..%5c..%5c.env', '/brand/brand.css%00.html',
      '/brand/brand.css/../../../.env', '/brand//brand.css', '/BRAND/brand.css'];
    for (const url of urls) {
      const r = await app.request(url, { headers: { Accept: 'text/html' } });
      assert.ok(r.status === 404 || r.status === 301, `${url}: ${r.status}`);
      assert.ok(!r.text.includes('DECOY'), url);
      assert.ok(!/Coming soon/.test(r.text) || r.status === 301, url);
    }
    const miss = await app.get('/brand/nope.css', { Accept: 'text/html' });
    assert.deepEqual(miss.json(), { error: { code: 404, status: 'NOT_FOUND', message: 'No such file.' } });
    assert.equal(miss.headers['cache-control'], 'no-store');
  });

  test('/favicon.ico: the brand file once it exists, a quiet 204 until then', async () => {
    const before = await app.get('/favicon.ico');
    assert.equal(before.status, 204);
    assert.equal(before.text, '');
    const icon = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
    fs.writeFileSync(path.join(app.root, 'site', 'brand', 'favicon.ico'), icon);
    const r = await app.get('/favicon.ico');
    assert.equal(r.status, 200);
    assert.deepEqual(r.buffer, icon);
    assert.match(r.headers['content-type'], /^image\/(vnd\.microsoft\.icon|x-icon)/);
    assert.equal(r.headers['cache-control'], CACHE);
    assert.equal((await app.get('/brand/favicon.ico')).status, 200);
  });

  test('/site.webmanifest is application/manifest+json (404 until the brand file exists)', async () => {
    assert.equal((await app.get('/site.webmanifest')).status, 404);
    fs.writeFileSync(path.join(app.root, 'site', 'brand', 'site.webmanifest'), JSON.stringify({ name: 'Terucon', icons: [] }));
    const r = await app.get('/site.webmanifest');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/manifest\+json/);
    assert.equal(r.headers['cache-control'], CACHE);
    assert.deepEqual(r.json(), { name: 'Terucon', icons: [] });
    assert.equal((await app.get('/brand/site.webmanifest')).status, 200);
  });

  test('without a site/brand folder at all: /brand is a 404, /favicon.ico a 204', async () => {
    const bare = await startTestApp();
    try {
      assert.equal((await bare.get('/brand/brand.css')).status, 404);
      assert.equal((await bare.get('/favicon.ico')).status, 204);
    } finally {
      await bare.stop();
    }
  });
});
