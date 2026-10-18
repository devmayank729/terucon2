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

describe('bound to all interfaces, any Host is accepted (the banner warns about that)', () => {
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

  const generate = { model: 'gemini-x', body: {} };

  test('POST needs application/json', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/vnd.api+json', 'application/jsonx']) {
      const r = await app.post('/api/vertex/generate', '{}', { 'Content-Type': type });
      assert.equal(r.status, 415, type);
      assert.deepEqual(r.json(), { error: { code: 415, status: 'INVALID_ARGUMENT', message: 'Send application/json.' } });
    }
    const none = await app.request('/api/vertex/generate', { method: 'POST', body: '{}' });
    assert.equal(none.status, 415, 'no content type at all');
  });

  test('parameters and case in the content type are fine', async () => {
    for (const type of ['application/json; charset=utf-8', 'Application/JSON', ' application/json ;charset=UTF-8']) {
      const r = await app.post('/api/vertex/generate', JSON.stringify(generate), { 'Content-Type': type });
      assert.equal(r.status, 503, type); // past the guard, then "not configured"
    }
  });

  test('PUT, PATCH and DELETE are held to the same rule', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      assert.equal((await app.request('/api/health', { method, body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415, method);
    }
  });

  test('the content type is checked before the body is read: broken JSON with the wrong type is 415, with the right type 400', async () => {
    assert.equal((await app.post('/api/vertex/generate', '{nope', { 'Content-Type': 'text/plain' })).status, 415);
    const bad = await app.post('/api/vertex/generate', '{nope', { 'Content-Type': 'application/json' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json(), { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The request body is not valid JSON.' } });
  });

  test('GET is not subject to the content-type rule', async () => {
    assert.equal((await app.get('/api/config')).status, 200);
  });

  test('a cross-origin POST is refused with 403', async () => {
    const r = await app.post('/api/vertex/generate', JSON.stringify(generate), { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json(), { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Cross-origin requests are not allowed.' } });
  });

  test('a same-origin POST passes the guard (and is then told Google is not configured)', async () => {
    const r = await app.post('/api/vertex/generate', JSON.stringify(generate), { 'Content-Type': 'application/json', Origin: `http://localhost:${app.port}` });
    assert.equal(r.status, 503);
    assert.match(r.json().error.message, /not configured/);
    assert.equal(r.json().error.status, 'FAILED_PRECONDITION');
  });

  test('Origin is compared as host:port, in any case; "null", other ports and other hosts are refused', async () => {
    const send = (origin) => app.post('/api/vertex/generate', JSON.stringify(generate), { 'Content-Type': 'application/json', Origin: origin });
    assert.equal((await send(`HTTP://LOCALHOST:${app.port}`)).status, 503);
    assert.equal((await send(`http://localhost:${app.port}/some/path?x=1`)).status, 503);
    for (const origin of ['null', 'file://', `http://localhost:${app.port + 1}`, `http://127.0.0.1:${app.port}`, 'localhost', `http://user@localhost:${app.port}`]) {
      assert.equal((await send(origin)).status, 403, origin);
    }
  });

  test('a Host without a port matches an Origin without one (browsers drop the default port)', async () => {
    const r = await app.post('/api/vertex/generate', JSON.stringify(generate), { 'Content-Type': 'application/json', Host: 'localhost', Origin: 'http://localhost' });
    assert.equal(r.status, 503);
  });

  test('a body over the 80 MB limit is a JSON 413', async () => {
    const r = await app.request('/api/vertex/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: Buffer.alloc(80 * 1024 * 1024 + 1, 0x20) });
    assert.equal(r.status, 413);
    assert.deepEqual(r.json(), { error: { code: 413, status: 'INVALID_ARGUMENT', message: 'The request is too large (the limit is 80 MB).' } });
  });
});

describe('SAM key (SAM_SERVER_KEY)', () => {
  let app;
  before(async () => {
    app = await startTestApp({ env: 'SAM_SERVER_KEY=s3cret-key\n' });
  });
  after(() => app.stop());

  test('/api/sam/* needs the key, as x-api-key or as a bearer token', async () => {
    const none = await app.get('/api/sam/health');
    assert.equal(none.status, 401);
    assert.deepEqual(none.json(), { error: { code: 401, status: 'UNAUTHENTICATED', message: 'This SAM server needs its key (SAM_SERVER_KEY).' } });
    assert.equal((await app.get('/api/sam/health', { 'x-api-key': 's3cret-key' })).status, 200);
    assert.equal((await app.get('/api/sam/health', { Authorization: 'Bearer s3cret-key' })).status, 200);
    assert.equal((await app.get('/api/sam/health', { 'x-api-key': ' s3cret-key ' })).status, 200, 'surrounding spaces are ignored');
  });

  test('wrong keys are refused: shorter, longer, same length, wrong scheme', async () => {
    for (const headers of [{ 'x-api-key': 's3cret' }, { 'x-api-key': 's3cret-key-and-more' }, { 'x-api-key': 'x3cret-key' }, { Authorization: 'Basic s3cret-key' }, { Authorization: 'Bearer ' }]) {
      assert.equal((await app.get('/api/sam/health', headers)).status, 401, JSON.stringify(headers));
    }
  });

  test('the key check comes before the content-type check, and applies to POST', async () => {
    assert.equal((await app.post('/api/sam/refine', 'x', { 'Content-Type': 'text/plain' })).status, 401);
    assert.equal((await app.post('/api/sam/refine', '{}', { 'Content-Type': 'text/plain', 'x-api-key': 's3cret-key' })).status, 415);
  });

  test('an encoded slash does not slip past the key check', async () => {
    const r = await app.get('/api/sam%2Fhealth');
    assert.ok([401, 404].includes(r.status), String(r.status));
    assert.notEqual(r.status, 200);
  });

  test('other routes do not need the key', async () => {
    assert.equal((await app.get('/api/health')).status, 200);
    assert.equal((await app.get('/api/config')).status, 200);
    assert.equal((await app.get('/')).status, 200);
  });
});

describe('without SAM_SERVER_KEY /api/sam/* is open', () => {
  test('no key needed', async () => {
    const app = await startTestApp();
    try {
      assert.equal((await app.get('/api/sam/health')).status, 200);
    } finally {
      await app.stop();
    }
  });
});
