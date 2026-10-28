import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { createApiRegistry } from '../../server/routes/api.js';
import { DECOYS, PROJECT_ROOT } from '../helpers/tempRoot.js';
import { startTestApp } from '../helpers/app.js';
import { rawRequest, request } from '../helpers/http.js';

const site = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'site', 'site.json'), 'utf8'));
const pages = Object.entries(site.pages);

describe('pages, aliases and redirects', () => {
  let app;
  before(async () => {
    app = await startTestApp();
  });
  after(() => app.stop());

  for (const [key, spec] of pages) {
    test(`${spec.route} serves the ${key} page`, async () => {
      const r = await app.get(spec.route);
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /^text\/html/);
      assert.equal(r.text, app.page(key));
      assert.equal(r.headers['cache-control'], 'no-cache');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.equal(r.headers['x-powered-by'], undefined);
    });

    test(`${key}: only the headers site.json lists are added`, async () => {
      const r = await app.get(spec.route);
      for (const [name, value] of Object.entries(spec.headers)) assert.equal(r.headers[name.toLowerCase()], value, name);
      if (!Object.keys(spec.headers).length) {
        assert.equal(r.headers['cross-origin-opener-policy'], undefined);
        assert.equal(r.headers['cross-origin-embedder-policy'], undefined);
      }
    });

    for (const alias of spec.aliases) {
      test(`${alias} redirects (301) to ${spec.route}`, async () => {
        const r = await app.get(encodeURI(alias));
        assert.equal(r.status, 301);
        assert.equal(r.headers.location, spec.route);
      });
    }
  }

  test('conditional requests: ETag and Last-Modified give 304', async () => {
    const first = await app.get('/materials');
    assert.ok(first.headers.etag && first.headers['last-modified']);
    const byTag = await app.get('/materials', { 'If-None-Match': first.headers.etag });
    assert.equal(byTag.status, 304);
    const byDate = await app.get('/materials', { 'If-Modified-Since': first.headers['last-modified'] });
    assert.equal(byDate.status, 304);
  });

  test('HEAD works for pages', async () => {
    const r = await app.request('/materials', { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(r.text, '');
    assert.ok(Number(r.headers['content-length']) > 0);
  });

  test('aliases are compared decoded: "/Terucon%20Swatchroom.html" and "/Terucon%20Client%20Dashboard%20v3.html"', async () => {
    assert.equal((await app.get('/Terucon%20Swatchroom.html')).headers.location, '/design-studio');
    assert.equal((await app.get('/Terucon%20Client%20Dashboard%20v3.html')).headers.location, '/my-project');
    assert.equal((await app.get('/%69ndex.html')).headers.location, '/'); // "i" percent-encoded
  });

  test('a redirect keeps the query string', async () => {
    const r = await app.get('/market_place_1.html?utm_source=mail');
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, '/materials?utm_source=mail');
  });

  test('the old design-time names redirect (302) to the page route', async () => {
    for (const [name, key] of Object.entries(site.legacy_names)) {
      const r = await app.get('/' + encodeURIComponent(name));
      assert.equal(r.status, 302, name);
      assert.equal(r.headers.location, site.pages[key].route, name);
    }
    assert.equal((await app.get('/Design%20Studio.dc.html')).headers.location, '/design-studio');
  });

  test('the project overview is served from docs/, its alias redirects', async () => {
    const overview = site.docs.overview;
    const r = await app.get(overview.route);
    assert.equal(r.status, 200);
    assert.match(r.text, /overview/);
    assert.equal(r.headers['cache-control'], 'no-cache');
    for (const alias of overview.aliases) assert.equal((await app.get(alias)).headers.location, overview.route);
  });

  test('/favicon.ico is empty and quiet', async () => {
    const r = await app.get('/favicon.ico');
    assert.equal(r.status, 204);
    assert.equal(r.text, '');
  });

  test('another capital or a trailing slash leads to the page (301); nothing else is guessed', async () => {
    const same = { '/MATERIALS': '/materials', '/Materials': '/materials', '/materials/': '/materials', '/design-studio/': '/design-studio', '/materials%2f': '/materials', '/Design-Studio': '/design-studio' };
    for (const [p, to] of Object.entries(same)) {
      const r = await app.get(p);
      assert.equal(r.status, 301, p);
      assert.equal(r.headers.location, to, p);
    }
    const q = await app.get('/Materials/?utm=1');
    assert.equal(q.headers.location, '/materials?utm=1', 'the query string is kept');
    // a legacy name in another case still ends at the page, not at the legacy name
    assert.equal((await app.get('/design%20studio.dc.html')).headers.location, '/design-studio');
    // not near any name: unknown, so the Coming soon page (below)
    for (const p of ['//materials', '/material', '/materials/extra']) assert.equal((await app.get(p)).status, 404, p);
  });

  test('malformed percent escapes are refused, not a crash', async () => {
    for (const p of ['/%E0%A4%A', '/%']) assert.equal((await app.get(p)).status, 404, p);
    for (const p of ['/media/%', '/media/%zz.jpg']) {
      const r = await app.get(p);
      assert.equal(r.status, 400, p);
      assert.equal(r.json().error.status, 'INVALID_ARGUMENT');
    }
  });

  test('POST to a page is not served', async () => {
    assert.equal((await app.request('/materials', { method: 'POST' })).status, 404);
  });

  test('a page that does not exist yet gets the Coming soon page, with a 404 status', async () => {
    const browser = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
    for (const p of ['/nothing-here', '/about', '/careers/', '/materials/extra', '/my-project/x/y']) {
      const r = await app.get(p, browser);
      assert.equal(r.status, 404, p);
      assert.match(r.headers['content-type'], /^text\/html/, p);
      assert.match(r.text, /<title>Coming soon<\/title>/, p);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['cache-control'], 'no-cache');
    }
    const head = await app.request('/nothing-here', { method: 'HEAD', headers: browser });
    assert.equal(head.status, 404);
    // asking for it by name is a normal page
    const direct = await app.get('/coming-soon', browser);
    assert.equal(direct.status, 200);
    assert.match(direct.text, /<title>Coming soon<\/title>/);
  });

  test('everything that is not a page keeps a plain 404: files, /media, /api, clients that do not want HTML, other methods', async () => {
    const browser = { Accept: 'text/html' };
    for (const p of ['/missing.js', '/nothing/here.css', '/media/missing.jpg', '/media/sub']) {
      const r = await app.get(p, browser);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.text, /Coming soon/, p);
    }
    assert.equal((await app.get('/api/nothing', browser)).json().error.status, 'NOT_FOUND');
    const json = await app.get('/nothing-here', { Accept: 'application/json' });
    assert.equal(json.status, 404);
    assert.match(json.headers['content-type'], /^text\/plain/);
    assert.equal((await app.request('/nothing-here', { method: 'POST', headers: { ...browser, 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  });
});

describe('a page whose file has not been built yet', () => {
  test('answers 404 and says how to build it, the rest of the site is fine', async () => {
    const app = await startTestApp();
    try {
      fs.rmSync(path.join(app.root, site.pages.materials.file));
      const r = await app.get('/materials');
      assert.equal(r.status, 404);
      assert.equal(r.json().error.status, 'NOT_FOUND');
      assert.match(r.json().error.message, /npm run build:site/);
      assert.equal((await app.get('/')).status, 200);
    } finally {
      await app.stop();
    }
  });
});

describe('nothing else on disk is ever served', () => {
  let app;
  before(async () => {
    app = await startTestApp();
  });
  after(() => app.stop());

  const urls = [
    '/.env', '/.env.example', '/app.js', '/package.json', '/server/secret.js', '/server/config/settings.js', '/site/site.json', '/site/notes.txt',
    '/tools/build.js', '/tools/build-site.js', '/tests/secret.test.js', '/node_modules/pkg/index.js', '/pages/home.html', '/pages/studio.html', '/pages_original/index.html',
    '/.git/config', '/docs/notes.md', '/test.env', '/media/../.env', '/media/%2e%2e/.env', '/media/%2e%2e/%2e%2e/app.js', '/media/sub/../../.env',
    '/media/..%2f.env', '/media/%2e%2e%2f.env', '/media/sub%2f..%2f..%2f.env', '/media/..\\.env', '/media/%5c..%5c.env', '/media/.env', '/media//.env',
  ];
  for (const url of urls) {
    test(`GET ${url} is 404`, async () => {
      const r = await app.request(url); // sent exactly as written: no client normalises the dots away
      assert.equal(r.status, 404);
      assert.ok(!r.text.includes('DECOY'));
    });
  }

  test('every decoy file really exists on disk (so the 404s mean something)', () => {
    for (const decoy of DECOYS) assert.ok(fs.existsSync(path.join(app.root, decoy)), decoy);
  });
});

describe('media', () => {
  let app;
  before(async () => {
    app = await startTestApp();
  });
  after(() => app.stop());

  test('a file is served with its type and a one-hour cache', async () => {
    const r = await app.get('/media/photo.jpg');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/jpeg');
    assert.equal(r.headers['cache-control'], 'public, max-age=3600');
    assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.equal(r.buffer.length, 4096);
    assert.equal((await app.get('/media/sub/deep.png')).status, 200);
    assert.equal((await app.get('/media/clip.mp4')).headers['content-type'], 'video/mp4');
  });

  test('Range requests answer 206 with the slice (videos need this)', async () => {
    const whole = (await app.get('/media/photo.jpg')).buffer;
    const r = await app.get('/media/photo.jpg', { Range: 'bytes=10-19' });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 10-19/4096');
    assert.deepEqual(r.buffer, whole.subarray(10, 20));
    const tail = await app.get('/media/photo.jpg', { Range: 'bytes=-5' });
    assert.equal(tail.status, 206);
    assert.deepEqual(tail.buffer, whole.subarray(4091));
    assert.equal((await app.get('/media/photo.jpg', { Range: 'bytes=999999-' })).status, 416);
  });

  test('conditional requests give 304', async () => {
    const first = await app.get('/media/photo.jpg');
    assert.equal((await app.get('/media/photo.jpg', { 'If-None-Match': first.headers.etag })).status, 304);
  });

  test('only allowed extensions, never hidden files, nothing that is not there', async () => {
    for (const name of ['script.py', 'notebook.ipynb', '.hidden.jpg', 'missing.jpg', 'sub', 'sub/', 'photo.JPG.exe', 'photo', '%00.jpg']) {
      assert.equal((await app.get('/media/' + name)).status, 404, name);
    }
    assert.equal((await app.get('/media/')).status, 404);
    assert.equal((await app.get('/media')).status, 404);
  });

  test('extensions are matched without regard to case', async () => {
    fs.writeFileSync(path.join(app.root, 'media', 'SHOUT.PNG'), 'png');
    assert.equal((await app.get('/media/SHOUT.PNG')).status, 200);
  });

  test('POST is not allowed on media', async () => {
    assert.equal((await app.request('/media/photo.jpg', { method: 'POST' })).status, 404);
  });
});

describe('/api: JSON 404 and 405, no-store, and the small endpoints', () => {
  let app;
  before(async () => {
    app = await startTestApp();
  });
  after(() => app.stop());

  test('unknown API paths are a JSON 404', async () => {
    for (const p of ['/api/nope', '/api/', '/api', '/api/health/', '/api/site/']) {
      const r = await app.get(p);
      assert.equal(r.status, 404, p);
      assert.match(r.headers['content-type'], /^application\/json/);
      assert.deepEqual(r.json(), { error: { code: 404, status: 'NOT_FOUND', message: 'No such API route.' } });
      assert.equal(r.headers['cache-control'], 'no-store');
    }
  });

  test('the routes of the old Design Studio backend are gone', async () => {
    for (const p of ['/api/config', '/api/vertex/generate', '/api/segment', '/api/sam/health', '/api/sam/refine', '/api/sam/segment']) {
      for (const r of [await app.get(p), await app.post(p, {})]) {
        assert.equal(r.status, 404, p);
        assert.deepEqual(r.json(), { error: { code: 404, status: 'NOT_FOUND', message: 'No such API route.' } });
      }
    }
  });

  test('a known path with the wrong method is a JSON 405 with Allow', async () => {
    const post = await app.post('/api/health', {});
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    assert.equal(post.json().error.code, 405);
    assert.equal((await app.request('/api/site', { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })).status, 405);
  });

  test('a route registered for POST only answers GET with 405 and Allow: POST', async () => {
    const mini = express();
    const api = createApiRegistry(mini);
    api.post('/api/only-post', (req, res) => res.json({ ok: true }));
    api.fallback();
    const server = http.createServer(mini);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const get = await request(server.address().port, { path: '/api/only-post' });
      assert.equal(get.status, 405);
      assert.equal(get.headers.allow, 'POST');
      assert.equal(get.headers['cache-control'], 'no-store');
      assert.equal((await request(server.address().port, { method: 'POST', path: '/api/only-post', body: {} })).status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('a POST to an unknown API path with the wrong content type is refused by the guard first', async () => {
    assert.equal((await app.post('/api/nope', 'x', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await app.post('/api/nope', {})).status, 404);
  });

  test('every API answer is no-store', async () => {
    for (const p of ['/api/health', '/api/site', '/api/nope']) assert.equal((await app.get(p)).headers['cache-control'], 'no-store', p);
  });

  test('/api/health says it is up and which version', async () => {
    const r = await app.get('/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { ok: true, version: JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version, studio: { running: false } });
  });

  test('/api/site is the public view: no files, no headers, no private keys', async () => {
    const view = (await app.get('/api/site')).json();
    assert.equal(view.name, site.name);
    assert.deepEqual(view.pages.map((p) => p.key), Object.keys(site.pages));
    assert.deepEqual(Object.keys(view.pages[0]), ['key', 'label', 'nav', 'description', 'route']);
    assert.deepEqual(view.docs.map((d) => d.route), Object.values(site.docs).map((d) => d.route));
    assert.ok(!('_comment' in view.connections));
    assert.deepEqual(view.connections.home, site.connections.home);
    const dumped = JSON.stringify(view);
    for (const spec of Object.values(site.pages)) assert.ok(!dumped.includes(spec.file) && !dumped.includes('Cross-Origin'));
  });
});

describe('Host and request-line oddities', () => {
  let app;
  before(async () => {
    app = await startTestApp();
  });
  after(() => app.stop());

  test('a request that names no Host is refused', async () => {
    const r = await rawRequest(app.port, 'GET /api/health HTTP/1.0\r\n\r\n');
    assert.equal(r.status, 421);
  });

  test('HEAD on the API works like GET', async () => {
    const r = await app.request('/api/health', { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(r.text, '');
  });
});
