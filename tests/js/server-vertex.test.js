import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';
import { loadSettings } from '../../server/config/settings.js';
import { GoogleAuth } from '../../server/lib/googleAuth.js';
import { RequestTimeoutError, httpRequest } from '../../server/lib/httpClient.js';
import { endpoint, generateContent } from '../../server/lib/vertex.js';
import { startTestApp } from '../helpers/app.js';
import { MockGoogle, makeServiceAccount, textResponse } from '../helpers/mockGoogle.js';

const busy = { error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } };
const quota = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'q' } };
const JSON_TYPE = { 'Content-Type': 'application/json' };
const SA_FILE = (info) => `GCP_SERVICE_ACCOUNT_JSON='${JSON.stringify(info)}'\n`;

describe('the Vertex proxy (POST /api/vertex/generate) against a mock Google', () => {
  let mock;
  let info;
  let app;
  let sleeps;

  /** Server wired to the mock; `extra` overrides createApp's vertex / auth options. */
  async function start(extra = {}) {
    sleeps = [];
    app = await startTestApp({
      environ: { GCP_SERVICE_ACCOUNT_JSON: JSON.stringify(info), TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS: '1', TERUCON_VERTEX_API_BASE: mock.base },
      vertex: { sleep: async (ms) => sleeps.push(ms), ...extra.vertex },
      auth: extra.auth,
    });
  }

  beforeEach(async () => {
    const made = makeServiceAccount('placeholder');
    mock = new MockGoogle(made.publicKey);
    await mock.start();
    info = made.info;
    info.token_uri = mock.tokenUrl;
  });
  afterEach(async () => {
    await app?.stop();
    app = undefined;
    await mock.stop();
  });

  const call = (model = 'gemini-x-1', body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, location) =>
    app.post('/api/vertex/generate', { model, body, ...(location ? { location } : {}) });

  test('happy path: a valid RS256 JWT is signed, and the body is forwarded with a bearer token', async () => {
    await start();
    const r = await call();
    assert.equal(r.status, 200);
    assert.equal(r.json().candidates[0].content.parts[0].text, 'ok');
    assert.equal(r.headers['x-terucon-attempts'], '1');
    assert.equal(r.headers['cache-control'], 'no-store');
    const token = mock.tokenCalls[0];
    assert.equal(token.signatureOk, true);
    assert.equal(token.grantType, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.deepEqual(token.header, { alg: 'RS256', typ: 'JWT', kid: info.private_key_id });
    assert.equal(token.payload.iss, info.client_email);
    assert.equal(token.payload.aud, mock.tokenUrl);
    assert.ok(token.payload.scope.includes('cloud-platform'));
    assert.equal(token.payload.exp - token.payload.iat, 3600);
    assert.ok(Math.abs(token.payload.iat - Date.now() / 1000) < 30);
    const sent = mock.generateCalls[0];
    assert.ok(sent.path.includes('/projects/terucon-test-project/locations/global/publishers/google/models/gemini-x-1:generateContent'), sent.path);
    assert.equal(sent.body.contents[0].parts[0].text, 'hi');
    assert.ok(sent.headers.authorization.startsWith('Bearer mock-token-'));
    assert.equal(sent.headers['content-type'], 'application/json');
  });

  test('the token is cached across requests', async () => {
    await start();
    await call();
    await call();
    assert.equal(mock.tokenCalls.length, 1);
    assert.equal(mock.generateCalls.length, 2);
  });

  test('concurrent first requests share one token fetch', async () => {
    await start();
    const replies = await Promise.all([1, 2, 3, 4, 5].map(() => call()));
    assert.deepEqual(replies.map((r) => r.status), [200, 200, 200, 200, 200]);
    assert.equal(mock.tokenCalls.length, 1);
  });

  test('the location goes into the path', async () => {
    await start();
    await call('gemini-x-1', undefined, 'asia-south1');
    assert.ok(mock.generateCalls[0].path.includes('/locations/asia-south1/'));
  });

  test('big bodies and big answers pass through', async () => {
    await start();
    const image = 'A'.repeat(6 * 1024 * 1024);
    mock.defaultHandler = async (model, body) => [200, textResponse(String(body.contents[0].parts[0].inlineData.data.length))];
    const r = await call('gemini-x-1', { contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: image } }] }] });
    assert.equal(r.status, 200);
    assert.equal(r.json().candidates[0].content.parts[0].text, String(image.length));
  });

  test("Google's error status and body pass through unchanged, and a 404 is final", async () => {
    await start();
    const err = { error: { code: 404, status: 'NOT_FOUND', message: 'Publisher Model `projects/x/models/gemini-x-1` was not found.' } };
    mock.script['gemini-x-1'] = [[404, err]];
    const r = await call();
    assert.equal(r.status, 404);
    assert.deepEqual(r.json(), err);
    assert.equal(mock.generateCalls.length, 1);
  });

  test('400 is not retried', async () => {
    await start();
    mock.script['gemini-x-1'] = [[400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad' } }]];
    assert.equal((await call()).status, 400);
    assert.equal(mock.generateCalls.length, 1);
  });

  test('transient errors are retried, then succeed (X-Terucon-Attempts says how many tries)', async () => {
    await start();
    mock.script['gemini-x-1'] = [[503, busy], [429, quota]];
    const r = await call();
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-terucon-attempts'], '3');
  });

  test('500, 502 and 504 are retried too', async () => {
    await start();
    mock.script['gemini-x-1'] = [[500, busy], [502, busy], [504, busy]];
    const r = await call();
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-terucon-attempts'], '4');
  });

  test('it gives up after four attempts and returns the last error', async () => {
    await start();
    mock.script['gemini-x-1'] = Array.from({ length: 10 }, () => [503, busy]);
    const r = await call();
    assert.equal(r.status, 503);
    assert.deepEqual(r.json(), busy);
    assert.equal(mock.generateCalls.length, 4);
    assert.equal(r.headers['x-terucon-attempts'], '4');
    assert.equal(sleeps.length, 3, 'no sleep after the last attempt');
  });

  test('back-off doubles with a little jitter: ~1 s, ~2 s, ~4 s', async () => {
    await start();
    mock.script['gemini-x-1'] = Array.from({ length: 10 }, () => [503, busy]);
    await call();
    sleeps.forEach((ms, i) => {
      const base = 1000 * 2 ** i;
      assert.ok(ms >= base * 0.8 && ms <= base * 1.2, `sleep ${i} was ${ms}`);
    });
  });

  test('Retry-After is honoured, and capped at 20 seconds', async () => {
    await start();
    mock.script['gemini-x-1'] = [[429, quota, { 'Retry-After': '7' }], [429, quota, { 'Retry-After': '120' }], [429, quota, { 'Retry-After': '0' }]];
    assert.equal((await call()).status, 200);
    assert.deepEqual(sleeps, [7000, 20_000, 0]);
  });

  test('a Retry-After that is not a number (or is negative) falls back to the back-off', async () => {
    await start();
    mock.script['gemini-x-1'] = [[429, quota, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }], [429, quota, { 'Retry-After': '' }], [429, quota, { 'Retry-After': '-5' }]];
    await call();
    assert.equal(sleeps.length, 3);
    assert.ok(sleeps[0] >= 800 && sleeps[0] <= 1200);
    assert.ok(sleeps[1] >= 1600 && sleeps[1] <= 2400);
    assert.equal(sleeps[2], 0, 'a negative wait is no wait');
  });

  test('401 from Google refreshes the token once; the retry does not count as an attempt', async () => {
    await start();
    mock.script['gemini-x-1'] = [[401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'expired' } }]];
    const r = await call();
    assert.equal(r.status, 200);
    assert.equal(mock.tokenCalls.length, 2);
    assert.equal(r.headers['x-terucon-attempts'], '1');
    assert.ok(mock.generateCalls[1].headers.authorization.endsWith('mock-token-2'));
  });

  test('a second 401 is final', async () => {
    await start();
    const unauthenticated = { error: { code: 401, status: 'UNAUTHENTICATED', message: 'no' } };
    mock.script['gemini-x-1'] = [[401, unauthenticated], [401, unauthenticated]];
    const r = await call();
    assert.equal(r.status, 401);
    assert.equal(mock.tokenCalls.length, 2);
  });

  test('a rejected key gives a readable 401', async () => {
    await start();
    mock.tokenFail = [400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }];
    const r = await call();
    assert.equal(r.status, 401);
    assert.equal(r.json().error.status, 'UNAUTHENTICATED');
    assert.match(r.json().error.message, /deleted or disabled/);
    assert.equal(mock.generateCalls.length, 0);
  });

  test('clock skew is explained', async () => {
    await start();
    mock.tokenFail = [400, { error: 'invalid_grant', error_description: 'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe.' }];
    const r = await call();
    assert.equal(r.status, 401);
    assert.match(r.json().error.message, /clock/);
  });

  test('other token errors are passed on in words', async () => {
    await start();
    mock.tokenFail = [400, { error: 'invalid_grant', error_description: 'Account disabled.' }];
    assert.match((await call()).json().error.message, /Google rejected this service account \(Account disabled\.\)/);
    mock.tokenFail = [400, { error: 'invalid_scope' }];
    assert.match((await call()).json().error.message, /permission scope/);
    mock.tokenFail = [500, 'not even json'];
    assert.match((await call()).json().error.message, /Token request failed: http_500\./);
  });

  test('Google unreachable for the sign-in is a 503 with advice', async () => {
    await start();
    const closed = await new Promise((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
    info.token_uri = `http://127.0.0.1:${closed}/token`;
    await app.stop();
    app = await startTestApp({
      environ: { GCP_SERVICE_ACCOUNT_JSON: JSON.stringify(info), TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS: '1', TERUCON_VERTEX_API_BASE: mock.base },
      vertex: { sleep: async () => {} },
    });
    const r = await call();
    assert.equal(r.status, 503);
    assert.equal(r.json().error.status, 'UNAVAILABLE');
    assert.match(r.json().error.message, /Could not reach Google to sign in/);
  });

  test('a call Google never answers is not retried and reports a timeout (504 DEADLINE_EXCEEDED)', async () => {
    await start({ vertex: { readTimeoutMs: 400 } });
    mock.defaultHandler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return [200, textResponse('too late')];
    };
    const started = Date.now();
    const r = await call();
    const took = Date.now() - started;
    assert.equal(r.status, 504);
    assert.equal(r.json().error.status, 'DEADLINE_EXCEEDED');
    assert.match(r.json().error.message, /did not answer/);
    assert.ok(took < 1400, `it waited ${took} ms: more than one attempt`);
    assert.equal(mock.generateCalls.length, 1);
    assert.equal(r.headers['x-terucon-attempts'], '1');
  });

  test('a slow answer that keeps sending bytes is not a timeout (the limit is per silence, not per call)', async () => {
    const server = (await import('node:http')).createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const parts = ['{"a":', '"b', 'cd"}'];
      let i = 0;
      const tick = setInterval(() => {
        if (i < parts.length) res.write(parts[i++]);
        else {
          clearInterval(tick);
          res.end();
        }
      }, 150);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await httpRequest(`http://127.0.0.1:${server.address().port}/`, { readTimeoutMs: 300 });
      assert.deepEqual(res.json(), { a: 'bcd' });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  test('a connect timeout is retried, then reported as 504 "could not connect"', async () => {
    await start();
    let calls = 0;
    const flaky = async (url, options) => {
      calls += 1;
      if (calls <= 2) throw new RequestTimeoutError('connect');
      return httpRequest(url, options);
    };
    const settings = loadSettings(app.envPath, { GCP_SERVICE_ACCOUNT_JSON: JSON.stringify(info), TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS: '1', TERUCON_VERTEX_API_BASE: mock.base });
    const ok = await generateContent(settings, new GoogleAuth(settings.google), 'gemini-x-1', { contents: [] }, undefined, { sleep: async () => {}, request: flaky });
    assert.equal(ok.status, 200);
    assert.equal(ok.info.attempts, 3);
    calls = -100;
    const never = async () => {
      throw new RequestTimeoutError('connect');
    };
    const down = await generateContent(settings, new GoogleAuth(settings.google), 'gemini-x-1', { contents: [] }, undefined, { sleep: async () => {}, request: never });
    assert.equal(down.status, 504);
    assert.match(down.data.error.message, /Could not connect to Google in time/);
    assert.equal(down.info.attempts, 4);
  });

  test('the connect timer really fires on a slow connection, and not on a reused or fast one', async () => {
    const server = (await import('node:http')).createServer((req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const slowLookup = (host, options, callback) => setTimeout(() => callback(null, '127.0.0.1', 4), 600);
      await assert.rejects(httpRequest(`http://localhost:${port}/`, { connectTimeoutMs: 150, lookup: slowLookup }), (err) => err instanceof RequestTimeoutError && err.phase === 'connect');
      const fast = await httpRequest(`http://127.0.0.1:${port}/`, { connectTimeoutMs: 150 });
      assert.equal(fast.text(), 'ok');
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  test('a refused connection is retried and reported as 503 "could not reach Google"', async () => {
    const closed = await new Promise((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
    await app?.stop();
    app = await startTestApp({
      environ: { GCP_SERVICE_ACCOUNT_JSON: JSON.stringify(info), TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS: '1', TERUCON_VERTEX_API_BASE: `http://127.0.0.1:${closed}` },
      vertex: { sleep: async (ms) => sleeps.push(ms) },
    });
    sleeps = [];
    const r = await call();
    assert.equal(r.status, 503);
    assert.match(r.json().error.message, /Could not reach Google/);
    assert.equal(r.headers['x-terucon-attempts'], '4');
    assert.equal(sleeps.length, 3);
  });

  test('the total wait is capped even when every attempt fails slowly', async () => {
    await start();
    mock.script['gemini-x-1'] = Array.from({ length: 10 }, () => [503, busy]);
    const settings = loadSettings(app.envPath, { GCP_SERVICE_ACCOUNT_JSON: JSON.stringify(info), TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS: '1', TERUCON_VERTEX_API_BASE: mock.base });
    let now = 0;
    const waited = [];
    const result = await generateContent(settings, new GoogleAuth(settings.google), 'gemini-x-1', { contents: [] }, undefined, {
      sleep: async (ms) => {
        waited.push(ms);
        now += 200_000; // each back-off "takes" 200 s
      },
      clock: () => now,
    });
    assert.equal(result.status, 503);
    assert.ok(result.info.attempts <= 2, `the 330 s cap should stop it long before 4 attempts, it made ${result.info.attempts}`);
    assert.ok(mock.generateCalls.length <= 2);
  });

  test('a bad model name, location or body is rejected before any network call', async () => {
    await start();
    assert.equal((await call('../../etc/passwd')).status, 400);
    assert.equal((await call('ab')).status, 400, 'too short');
    assert.equal((await call('x'.repeat(81))).status, 400, 'too long');
    assert.equal((await call('gemini-x-1', undefined, 'Not A Location!')).status, 400);
    assert.equal((await app.post('/api/vertex/generate', { model: 'gemini-x', body: 'nope' })).status, 400);
    assert.equal((await app.post('/api/vertex/generate', { model: 'gemini-x', body: [] })).status, 400);
    assert.equal((await app.post('/api/vertex/generate', { body: {} })).status, 400);
    assert.equal((await app.post('/api/vertex/generate', { model: 5, body: {} })).status, 400);
    assert.equal((await app.post('/api/vertex/generate', { model: 'gemini-x', body: {}, location: 5 })).status, 400);
    assert.equal((await app.post('/api/vertex/generate', '[1,2]', JSON_TYPE)).status, 400);
    assert.equal((await app.post('/api/vertex/generate', '', JSON_TYPE)).status, 400);
    assert.equal((await app.post('/api/vertex/generate', 'null', JSON_TYPE)).status, 400);
    assert.deepEqual(mock.generateCalls, []);
    assert.deepEqual(mock.tokenCalls, []);
    const r = await app.post('/api/vertex/generate', { model: 'gemini-x', body: 'nope' });
    assert.deepEqual(r.json(), { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Expected JSON {model, location?, body}.' } });
  });

  test('a reply that is not JSON becomes a readable error (5xx ones are retried first)', async () => {
    await start();
    const html = `<html>${'Bad gateway '.repeat(60)}</html>`;
    mock.script['gemini-x-1'] = [[502, html], [502, html], [502, html], [502, html]];
    const r = await call();
    assert.equal(r.status, 502);
    assert.equal(r.json().error.code, 502);
    assert.equal(r.json().error.status, 'UNKNOWN');
    assert.equal(r.json().error.message, html.slice(0, 300));
    assert.equal(mock.generateCalls.length, 4);
    mock.script['gemini-x-1'] = [[502, html]];
    const recovered = await call();
    assert.equal(recovered.status, 200);
    assert.equal(recovered.headers['x-terucon-attempts'], '2');
  });

  test('/api/config reports the state without secrets', async () => {
    await start();
    const r = await app.get('/api/config');
    const data = r.json();
    assert.equal(data.google.configured, true);
    assert.equal(data.google.mode, 'vertex');
    assert.equal(data.google.clientEmail, info.client_email);
    assert.equal(data.google.projectId, 'terucon-test-project');
    for (const secret of ['PRIVATE KEY', info.private_key_id, info.private_key.slice(40, 80), mock.base]) assert.ok(!r.text.includes(secret), secret);
  });

  test('one log line per call: model padded to 28, ok/status, seconds', async () => {
    await start();
    mock.script['gemini-x-1'] = [[503, busy]];
    await call();
    await call('gemini-missing-2');
    mock.script['gemini-x-1'] = [[404, { error: { code: 404, status: 'NOT_FOUND', message: 'no such model here' } }]];
    await call();
    const lines = app.log.lines.filter((l) => l.includes('google  '));
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^info google {2}gemini-x-1 {19}ok {4}\d+\.\ds \(2 attempts\)$/);
    assert.match(lines[1], /^info google {2}gemini-missing-2 {13}ok {4}\d+\.\ds$/);
    assert.match(lines[2], /^warn google {2}gemini-x-1 {19}404 {2}\d+\.\ds {2}no such model here$/);
  });
});

describe('when Google is not configured', () => {
  test('the proxy says so (503 FAILED_PRECONDITION) and never calls out', async () => {
    const app = await startTestApp();
    try {
      const r = await app.post('/api/vertex/generate', { model: 'gemini-x-1', body: {} });
      assert.equal(r.status, 503);
      assert.equal(r.json().error.status, 'FAILED_PRECONDITION');
      assert.match(r.json().error.message, /not configured/);
      assert.equal(r.headers['x-terucon-attempts'], '0');
    } finally {
      await app.stop();
    }
  });
});

describe('.env hot reload', () => {
  test('editing the file is picked up without a restart', async () => {
    const app = await startTestApp();
    try {
      assert.equal((await app.get('/api/config')).json().google.configured, false);
      app.writeEnv('GEMINI_API_KEY=abc\n');
      const config = (await app.get('/api/config')).json();
      assert.equal(config.google.configured, true);
      assert.equal(config.google.mode, 'api-key');
      assert.equal((await app.get('/api/health')).json().mode, 'api-key');
    } finally {
      await app.stop();
    }
  });

  test('a new service account in the file gets a fresh token source', async () => {
    const first = makeServiceAccount('placeholder');
    const mock = new MockGoogle(first.publicKey);
    await mock.start();
    first.info.token_uri = mock.tokenUrl;
    const app = await startTestApp({
      env: SA_FILE(first.info),
      environ: { TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS: '1', TERUCON_VERTEX_API_BASE: mock.base },
      vertex: { sleep: async () => {} },
    });
    try {
      assert.equal((await app.post('/api/vertex/generate', { model: 'gemini-x-1', body: {} })).status, 200);
      assert.equal(mock.tokenCalls.length, 1);
      const second = makeServiceAccount(mock.tokenUrl, 'second-project-7', 'other@second-project-7.iam.gserviceaccount.com');
      app.writeEnv(SA_FILE(second.info) + 'TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS=1\n');
      assert.equal((await app.post('/api/vertex/generate', { model: 'gemini-x-1', body: {} })).status, 200);
      assert.equal(mock.tokenCalls.length, 2, 'the old token was not reused for the new account');
      assert.equal(mock.tokenCalls[1].payload.iss, 'other@second-project-7.iam.gserviceaccount.com');
      assert.ok(mock.generateCalls[1].path.includes('/projects/second-project-7/'));
    } finally {
      await app.stop();
      await mock.stop();
    }
  });
});

describe('API-key mode', () => {
  test('the key goes in a header to the Gemini API, never in the URL', () => {
    const s = loadSettings(path.join(fs.realpathSync('.'), 'no-such.env'), { GEMINI_API_KEY: 'KEY-123' });
    const { url, kind } = endpoint(s, 'gemini-x-1', undefined);
    assert.equal(kind, 'api-key');
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x-1:generateContent');
    assert.ok(!url.includes('KEY-123'));
  });

  test('Vertex URLs: global has no region prefix, other locations do; a custom base only when allowed', () => {
    const vertex = (extra) => loadSettings(path.join(fs.realpathSync('.'), 'no-such.env'), { GCP_SERVICE_ACCOUNT_JSON: JSON.stringify(makeServiceAccount('https://oauth2.googleapis.com/token', 'my-project-123').info), ...extra });
    assert.equal(endpoint(vertex({}), 'gemini-x-1').url, 'https://aiplatform.googleapis.com/v1/projects/my-project-123/locations/global/publishers/google/models/gemini-x-1:generateContent');
    assert.equal(endpoint(vertex({}), 'gemini-x-1', 'asia-south1').url, 'https://asia-south1-aiplatform.googleapis.com/v1/projects/my-project-123/locations/asia-south1/publishers/google/models/gemini-x-1:generateContent');
    assert.equal(endpoint(vertex({ GOOGLE_CLOUD_LOCATION: 'us-central1' }), 'gemini-x-1').url.split('/v1/')[0], 'https://us-central1-aiplatform.googleapis.com');
    assert.ok(endpoint(vertex({ TERUCON_VERTEX_API_BASE: 'http://127.0.0.1:1' }), 'gemini-x-1').url.startsWith('https://aiplatform.googleapis.com/'), 'ignored without the allow switch');
    assert.ok(endpoint(vertex({ TERUCON_VERTEX_API_BASE: 'http://127.0.0.1:1/', TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS: 'yes' }), 'gemini-x-1').url.startsWith('http://127.0.0.1:1/v1/projects/'));
  });

  test('end to end: x-goog-api-key reaches the mock, no token is requested', async () => {
    const mock = new MockGoogle();
    await mock.start();
    mock.expectApiKey = 'KEY-123';
    const app = await startTestApp({ environ: { GEMINI_API_KEY: 'KEY-123', TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS: '1', TERUCON_VERTEX_API_BASE: mock.base } });
    try {
      const r = await app.post('/api/vertex/generate', { model: 'gemini-x-1', body: { contents: [] } });
      assert.equal(r.status, 200);
      assert.equal(mock.tokenCalls.length, 0);
      assert.equal(mock.generateCalls[0].path, '/v1beta/models/gemini-x-1:generateContent');
      assert.equal(mock.generateCalls[0].headers['x-goog-api-key'], 'KEY-123');
      assert.equal(mock.generateCalls[0].headers.authorization, undefined);
    } finally {
      await app.stop();
      await mock.stop();
    }
  });

  test('a 401 in api-key mode is not retried with a refreshed token (there is none)', async () => {
    const mock = new MockGoogle();
    await mock.start();
    mock.expectApiKey = 'RIGHT';
    const app = await startTestApp({ environ: { GEMINI_API_KEY: 'WRONG', TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS: '1', TERUCON_VERTEX_API_BASE: mock.base } });
    try {
      const r = await app.post('/api/vertex/generate', { model: 'gemini-x-1', body: {} });
      assert.equal(r.status, 403);
      assert.equal(mock.generateCalls.length, 1);
    } finally {
      await app.stop();
      await mock.stop();
    }
  });
});
