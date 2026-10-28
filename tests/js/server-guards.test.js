import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { startTestApp } from '../helpers/app.js';
import { rawRequest } from '../helpers/http.js';

describe('Host guard (the server listens on this machine only)', () => {
  let app;
  before(async () => {
    app = await startTestApp({ env: 'ALLOWED_HOSTS=studio.example.com, Other.Test:8080\n' });
  });
  after(() => app.stop());

  const status = async (host) => (await app.get('/api/health', { Host: host })).status;

  test('our own names pass, with or without a port, in any case', async () => {
    for (const host of ['localhost:8080', 'localhost', 'LOCALHOST:8080', '127.0.0.1:8080', '127.0.0.1', '[::1]:8080', '[::1]']) assert.equal(await status(host), 200, host);
  });

  test('other names are refused with 421 in the usual error shape', async () => {
    for (const host of ['evil.example.com', 'evil.example.com:8080', 'localhost.evil.com', '127.0.0.1.evil.com', 'xlocalhost', '[::2]:8080', '10.0.0.5:8080']) {
      const r = await app.get('/api/health', { Host: host });
      assert.equal(r.status, 421, host);
      assert.deepEqual(r.json(), { error: { code: 421, status: 'INVALID_ARGUMENT', message: 'Unexpected Host header.' } });
      assert.equal(r.headers['x-content-type-options'], 'nosniff', 'refusals carry the security headers too');
      assert.equal(r.headers['cache-control'], 'no-store');
    }
  });

  test('pages are guarded as well as the API', async () => {
    assert.equal((await app.get('/', { Host: 'evil.example.com' })).status, 421);
    assert.equal((await app.get('/media/photo.jpg', { Host: 'evil.example.com' })).status, 421);
  });

  test('ALLOWED_HOSTS names pass (with or without the port, in any case); others do not', async () => {
    assert.equal(await status('studio.example.com'), 200);
    assert.equal(await status('Studio.Example.com:8080'), 200);
    assert.equal(await status('other.test:8080'), 200);
    assert.equal(await status('other.test:9090'), 421, 'a listed host:port only matches that port');
  });

  test('a request without a Host header is refused', async () => {
    assert.equal((await rawRequest(app.port, 'GET /api/health HTTP/1.0\r\n\r\n')).status, 421);
  });
});

describe('bound to all interfaces, any Host is accepted', () => {
  test('HOST=0.0.0.0', async () => {
    const app = await startTestApp({ env: 'HOST=0.0.0.0\n' });
    try {
      assert.equal((await app.get('/api/health', { Host: 'anything.example.org' })).status, 200);
    } finally {
      await app.stop();
    }
  });
});

describe('JSON and origin guard for POST/PUT/PATCH/DELETE under /api/', () => {
  let app;
  before(async () => {
    app = await startTestApp();
  });
  after(() => app.stop());

  // No route answers this path, so a request that gets past the guard ends in the JSON 404.
  const target = '/api/nope';
  const passed = 404;

  test('POST needs application/json', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/vnd.api+json', 'application/jsonx']) {
      const r = await app.post(target, '{}', { 'Content-Type': type });
      assert.equal(r.status, 415, type);
      assert.deepEqual(r.json(), { error: { code: 415, status: 'INVALID_ARGUMENT', message: 'Send application/json.' } });
    }
    const none = await app.request(target, { method: 'POST', body: '{}' });
    assert.equal(none.status, 415, 'no content type at all');
  });

  test('parameters and case in the content type are fine', async () => {
    for (const type of ['application/json; charset=utf-8', 'Application/JSON', ' application/json ;charset=UTF-8']) {
      const r = await app.post(target, '{}', { 'Content-Type': type });
      assert.equal(r.status, passed, type);
    }
  });

  test('PUT, PATCH and DELETE are held to the same rule', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      assert.equal((await app.request('/api/health', { method, body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415, method);
    }
  });

  test('the content type is checked before the body is read: a body that is announced and never sent is still refused at once', async () => {
    const head = `POST ${target} HTTP/1.1\r\nHost: localhost:${app.port}\r\nContent-Type: text/plain\r\nContent-Length: 1000000\r\n\r\n`;
    assert.equal((await rawRequest(app.port, head)).status, 415);
  });

  test('GET is not subject to the content-type rule', async () => {
    assert.equal((await app.get('/api/site')).status, 200);
  });

  test('a cross-origin POST is refused with 403', async () => {
    const r = await app.post(target, '{}', { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json(), { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Cross-origin requests are not allowed.' } });
  });

  test('a same-origin POST passes the guard', async () => {
    const r = await app.post(target, '{}', { 'Content-Type': 'application/json', Origin: `http://localhost:${app.port}` });
    assert.equal(r.status, passed);
  });

  test('Origin is compared as host:port, in any case; "null", other ports and other hosts are refused', async () => {
    const send = (origin) => app.post(target, '{}', { 'Content-Type': 'application/json', Origin: origin });
    assert.equal((await send(`HTTP://LOCALHOST:${app.port}`)).status, passed);
    assert.equal((await send(`http://localhost:${app.port}/some/path?x=1`)).status, passed);
    for (const origin of ['null', 'file://', `http://localhost:${app.port + 1}`, `http://127.0.0.1:${app.port}`, 'localhost', `http://user@localhost:${app.port}`]) {
      assert.equal((await send(origin)).status, 403, origin);
    }
  });

  test('a Host without a port matches an Origin without one (browsers drop the default port)', async () => {
    const r = await app.post(target, '{}', { 'Content-Type': 'application/json', Host: 'localhost', Origin: 'http://localhost' });
    assert.equal(r.status, passed);
  });
});
