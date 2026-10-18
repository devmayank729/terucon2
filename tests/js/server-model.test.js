import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startTestApp } from '../helpers/app.js';
import { SAM_STATE, startFakeModelService } from '../helpers/fakeModelService.js';
import { rawRequest, waitFor } from '../helpers/http.js';

const FAKE_CHILD = fileURLToPath(new URL('../helpers/fakeModelChild.mjs', import.meta.url));
const GOOGLE_ON = 'GEMINI_API_KEY=test-key-not-real\n';
const JSON_TYPE = { 'Content-Type': 'application/json' };
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

describe('the proxy to a running model service (MODEL_SERVICE=external)', () => {
  let fake;
  let app;
  before(async () => {
    fake = await startFakeModelService({ key: 'shared-secret' });
    app = await startTestApp({ env: GOOGLE_ON, model: { mode: 'external', url: fake.url, key: 'shared-secret' } });
  });
  after(async () => {
    await app.stop();
    await fake.stop();
  });

  test('/api/config: the model is ready and sam is the service\'s own status, passed through', async () => {
    const config = (await app.get('/api/config')).json();
    assert.deepEqual(config.model, { mode: 'external', status: 'ready' });
    assert.deepEqual(config.sam, SAM_STATE);
    assert.deepEqual((await app.get('/api/health')).json().model, { mode: 'external', status: 'ready' });
  });

  test('GET /api/sam/health is the service\'s answer, as JSON and never cached', async () => {
    const r = await app.get('/api/sam/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { status: 'ok', model: 'sam2.1-test', backend: 'sam2', device: 'cpu', interactive: true, text_prompts: false, error: '' });
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });

  test('POST /api/segment reaches /segment byte for byte, with the shared key and without the browser\'s credentials', async () => {
    const body = crypto.randomBytes(300_000); // not JSON: a proxy that parsed and re-encoded it would break it
    fake.calls.length = 0;
    const r = await app.post('/api/segment', body, { 'Content-Type': 'application/json', Origin: `http://localhost:${app.port}`, Cookie: 'a=b', Authorization: 'Bearer nope', 'x-api-key': 'nope' });
    assert.equal(r.status, 200);
    const seen = r.json();
    assert.equal(seen.bytes, body.length);
    assert.equal(seen.sha256, sha(body));
    assert.equal(seen.contentType, 'application/json');
    assert.equal(seen.host, `127.0.0.1:${fake.port}`, 'the service sees its own address, not the browser\'s Host');
    assert.deepEqual(seen.forwarded, [], 'Origin, Cookie, Authorization and x-api-key stay behind');
    const call = fake.calls.find((c) => c.url === '/segment');
    assert.equal(call.headers['x-terucon-model-key'], 'shared-secret');
  });

  test('a big body streams through in both directions without being altered (30 MB up, 30 MB back)', async () => {
    const body = crypto.randomBytes(30 * 1024 * 1024);
    const r = await app.post('/api/sam/segment', body, { 'Content-Type': 'application/json' });
    assert.equal(r.status, 200);
    assert.equal(r.buffer.length, body.length);
    assert.equal(sha(r.buffer), sha(body));
  });

  test('the service\'s status and error body come back unchanged', async () => {
    const r = await app.post('/api/sam/refine', { status: 422 });
    assert.equal(r.status, 422);
    assert.deepEqual(r.json(), { error: { code: 422, status: 'FAILED_PRECONDITION', message: 'SAM found nothing at that point.' } });
    const ok = await app.post('/api/sam/refine', { points: [[1, 2]] });
    assert.deepEqual(ok.json(), { mask: 'png', image_id: 'img-1', score: 0.9, model: 'sam2.1-test' });
  });

  test('over-sized requests are refused up front without calling the service', async () => {
    fake.calls.length = 0;
    const r = await rawRequest(app.port, `POST /api/sam/refine HTTP/1.1\r\nHost: localhost:${app.port}\r\nContent-Type: application/json\r\nContent-Length: 94371840\r\n\r\n`);
    assert.equal(r.status, 413);
    assert.match(r.body, /"code":413/);
    assert.ok(!fake.calls.some((c) => c.url === '/sam/refine'));
  });

  test('when the browser goes away the service request is dropped too', async () => {
    fake.abandoned.length = 0;
    const socket = net.connect(app.port, '127.0.0.1');
    const body = JSON.stringify({ hang: true });
    socket.write(`POST /api/sam/refine HTTP/1.1\r\nHost: localhost:${app.port}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    await waitFor(() => fake.calls.some((c) => c.url === '/sam/refine') && fake.server.listening, { what: 'the request to reach the service' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.destroy();
    await waitFor(() => fake.abandoned.length === 1, { what: 'the service to see the request abandoned' });
  });

  test('an answer cut off halfway ends the browser\'s response, and the server carries on', async () => {
    await assert.rejects(app.post('/api/sam/refine', { cut: true }));
    assert.equal((await app.get('/api/health')).status, 200);
  });

  test('the key guard still protects the proxied SAM routes', async () => {
    const guarded = await startTestApp({ env: 'SAM_SERVER_KEY=gpu-box-key\n', model: { mode: 'external', url: fake.url, key: 'shared-secret' } });
    try {
      assert.equal((await guarded.get('/api/sam/health')).status, 401);
      fake.calls.length = 0;
      assert.equal((await guarded.get('/api/sam/health', { Authorization: 'Bearer gpu-box-key' })).status, 200);
      const call = fake.calls.find((c) => c.url === '/sam/health');
      assert.equal(call.headers['x-api-key'], 'gpu-box-key', 'the service gets the configured SAM key, for a service that has no MODEL_SERVICE_KEY');
      assert.equal(call.headers.authorization, undefined, "the browser's own header is not passed on");
    } finally {
      await guarded.stop();
    }
  });
});

describe('/api/segment without Google', () => {
  test('503 FAILED_PRECONDITION with the old message, and the service is not called', async () => {
    const fake = await startFakeModelService();
    const app = await startTestApp({ model: { mode: 'external', url: fake.url } });
    try {
      const r = await app.post('/api/segment', { image: 'x' });
      assert.equal(r.status, 503);
      assert.deepEqual(r.json(), { error: { code: 503, status: 'FAILED_PRECONDITION', message: 'Google Cloud is not configured on this server. Add credentials to .env.' } });
      assert.ok(!fake.calls.some((c) => c.url === '/segment'));
      app.writeEnv('GCP_SERVICE_ACCOUNT_JSON={broken\n');
      assert.match((await app.post('/api/segment', { image: 'x' })).json().error.message, /not valid JSON/, 'the configuration error is shown when there is one');
    } finally {
      await app.stop();
      await fake.stop();
    }
  });
});

describe('the answers when the model service can not be used', () => {
  const segment = (app) => app.post('/api/segment', { image: 'x' });

  async function check(app, { status, messagePattern, mode }) {
    const config = (await app.get('/api/config')).json();
    assert.equal(config.model.mode, mode);
    assert.equal(config.model.status, status);
    const refused = await segment(app);
    assert.equal(refused.status, 503);
    assert.equal(refused.json().error.status, 'UNAVAILABLE');
    assert.match(refused.json().error.message, messagePattern);
    for (const route of ['/api/sam/refine', '/api/sam/segment']) {
      const r = await app.post(route, {});
      assert.equal(r.status, 503, route);
      assert.match(r.json().error.message, messagePattern);
    }
    const health = await app.get('/api/sam/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.json(), { status: 'unavailable', model: '', backend: '', device: '', interactive: false, text_prompts: false, error: health.json().error });
    assert.match(health.json().error, messagePattern);
    return config;
  }

  test('switched off', async () => {
    const app = await startTestApp({ env: GOOGLE_ON + 'SAM_ENABLED=true\n', model: { mode: 'off' } });
    try {
      const config = await check(app, { status: 'off', mode: 'off', messagePattern: /switched off \(MODEL_SERVICE=off\)/ });
      assert.deepEqual(config.sam, { enabled: true, status: 'off', backend: '', model: '', interactive: false, textPrompts: false });
      assert.equal(config.model.error, undefined);
    } finally {
      await app.stop();
    }
  });

  test('still starting', async () => {
    const app = await startTestApp({ env: GOOGLE_ON + 'SAM_ENABLED=true\n', model: { mode: 'auto', command: process.execPath, args: [FAKE_CHILD], startTimeoutMs: 60_000 }, environ: { FAKE_MODE: 'never-ready' }, startModel: true });
    try {
      const config = await check(app, { status: 'starting', mode: 'auto', messagePattern: /still starting\. Try again in a moment/ });
      assert.equal(config.sam.status, 'unavailable');
      assert.equal(config.sam.enabled, true);
    } finally {
      await app.stop();
    }
  });

  test('Python packages missing', { skip: process.platform === 'win32' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-nopy-'));
    const python = path.join(root, 'python');
    fs.writeFileSync(python, '#!/bin/sh\necho \'{"version":[3,12,0],"missing":["cv2","flask"]}\'\n', { mode: 0o755 });
    const app = await startTestApp({ env: GOOGLE_ON, model: { mode: 'auto', python }, startModel: false });
    try {
      fs.mkdirSync(path.join(app.root, 'model', 'terucon_model'), { recursive: true });
      app.app.locals.terucon.model.start();
      await waitFor(async () => (await app.app.locals.terucon.model.status()).status === 'unavailable', { what: 'the interpreter check' });
      const config = await check(app, { status: 'unavailable', mode: 'auto', messagePattern: /packages that are not installed.*\(missing: cv2, flask\).*npm run setup:model.*pip install -r model\/requirements\.txt/ });
      assert.match(config.model.error, /missing: cv2, flask/);
    } finally {
      await app.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('the service is not in this checkout', async () => {
    const app = await startTestApp({ env: GOOGLE_ON, model: { mode: 'auto' }, startModel: true });
    try {
      await waitFor(async () => (await app.app.locals.terucon.model.status()).status === 'unavailable', { what: 'unavailable' });
      await check(app, { status: 'unavailable', mode: 'auto', messagePattern: /model\/terucon_model is missing/ });
    } finally {
      await app.stop();
    }
  });

  test('crashed', async () => {
    const app = await startTestApp({ env: GOOGLE_ON, model: { mode: 'auto', command: process.execPath, args: [FAKE_CHILD], backoffSeconds: [60] }, environ: { FAKE_MODE: 'crash' }, startModel: true });
    try {
      await waitFor(async () => (await app.app.locals.terucon.model.status()).status === 'unavailable', { what: 'the crash' });
      const config = await check(app, { status: 'unavailable', mode: 'auto', messagePattern: /stopped unexpectedly \(exit code 3\)\. Restarting in 60 s/ });
      assert.ok(app.log.lines.some((l) => l.includes('[model] unavailable: The model service stopped unexpectedly')));
      assert.ok(!JSON.stringify(config).includes('about to crash'), 'what the child printed stays in the server window');
    } finally {
      await app.stop();
    }
  });

  test('an external service nobody listens on', async () => {
    const closed = await new Promise((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
    const app = await startTestApp({ env: GOOGLE_ON, model: { mode: 'external', url: `http://127.0.0.1:${closed}` } });
    try {
      await check(app, { status: 'unavailable', mode: 'external', messagePattern: /can not be reached/ });
    } finally {
      await app.stop();
    }
  });

  test('an external service that wants a different key', async () => {
    const fake = await startFakeModelService({ key: 'right' });
    const app = await startTestApp({ env: GOOGLE_ON, model: { mode: 'external', url: fake.url, key: 'wrong' } });
    try {
      await check(app, { status: 'unavailable', mode: 'external', messagePattern: /rejected the key\. MODEL_SERVICE_KEY must be the same on both sides/ });
    } finally {
      await app.stop();
      await fake.stop();
    }
  });

  test('external without an address', async () => {
    const app = await startTestApp({ env: GOOGLE_ON + 'MODEL_SERVICE=external\n', model: {} });
    try {
      const config = await check(app, { status: 'unavailable', mode: 'external', messagePattern: /needs MODEL_SERVICE_URL/ });
      assert.ok(config.warnings.some((w) => w.includes('MODEL_SERVICE_URL')));
    } finally {
      await app.stop();
    }
  });

  test('a service that answers health with an error, or very slowly, counts as unavailable (and /api/config does not wait for it)', async () => {
    const slow = await startFakeModelService({ healthDelayMs: 3000 });
    const app = await startTestApp({ model: { mode: 'external', url: slow.url, probeTimeoutMs: 300 } });
    try {
      const started = Date.now();
      const config = (await app.get('/api/config')).json();
      assert.ok(Date.now() - started < 1500, `/api/config took ${Date.now() - started} ms`);
      assert.equal(config.model.status, 'unavailable');
      assert.match(config.model.error, /not answering/);
    } finally {
      await app.stop();
      await slow.stop();
    }
  });

  test('a service that is not ours (health says 404)', async () => {
    const stranger = http.createServer((req, res) => res.writeHead(404).end());
    await new Promise((resolve) => stranger.listen(0, '127.0.0.1', resolve));
    const app = await startTestApp({ model: { mode: 'external', url: `http://127.0.0.1:${stranger.address().port}` } });
    try {
      assert.match((await app.get('/api/config')).json().model.error, /answered 404 to its health check/);
    } finally {
      await app.stop();
      stranger.closeAllConnections();
      stranger.close();
    }
  });
});

describe('the health check is cached for a moment', () => {
  test('two quick requests make one check; a later one makes another', async () => {
    const fake = await startFakeModelService();
    const app = await startTestApp({ model: { mode: 'external', url: fake.url, probeTtlMs: 400 } });
    try {
      const checks = () => fake.calls.filter((c) => c.url === '/health').length;
      await Promise.all([app.get('/api/config'), app.get('/api/health'), app.get('/api/config')]);
      await app.get('/api/health');
      assert.equal(checks(), 1);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await app.get('/api/health');
      assert.equal(checks(), 2);
    } finally {
      await app.stop();
      await fake.stop();
    }
  });

  test('a service that stops answering is noticed within the cache time', async () => {
    const fake = await startFakeModelService();
    const app = await startTestApp({ model: { mode: 'external', url: fake.url, probeTtlMs: 100 } });
    try {
      assert.equal((await app.get('/api/health')).json().model.status, 'ready');
      await fake.stop();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal((await app.get('/api/health')).json().model.status, 'unavailable');
      assert.equal((await app.post('/api/segment', { image: 'x' })).status, 503);
    } finally {
      await app.stop();
    }
  });
});

describe('MODEL_SERVICE=auto with a (fake) child process, through the real server', () => {
  test('starts, becomes ready, serves the proxy, logs the [model] lines, and the child dies with close()', async () => {
    const pidFile = path.join(os.tmpdir(), `terucon-pid-${process.pid}-${Date.now()}`);
    const app = await startTestApp({
      env: GOOGLE_ON,
      environ: { FAKE_PID_FILE: pidFile, FAKE_SAM: 'off' },
      model: { mode: 'auto', command: process.execPath, args: [FAKE_CHILD] },
      startModel: true,
    });
    const model = app.app.locals.terucon.model;
    try {
      await waitFor(async () => (await model.status()).status === 'ready', { what: 'the child to be ready' });
      const config = (await app.get('/api/config')).json();
      assert.deepEqual(config.model, { mode: 'auto', status: 'ready' });
      assert.equal(config.sam.enabled, false, "the child's own SAM status");
      const seen = (await app.post('/api/segment', Buffer.from('hello'), JSON_TYPE)).json();
      assert.equal(seen.bytes, 5);
      assert.equal((await app.get('/api/sam/health')).json().status, 'ok');
      assert.match(model.url(), /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.ok(app.log.lines.includes('info [model] starting the model service'));
      assert.ok(app.log.lines.some((l) => /^info \[model\] ready at http:\/\/127\.0\.0\.1:\d+ {2}\(SAM: off\)$/.test(l)), app.log.lines.join('\n'));
      assert.ok(app.log.lines.includes('raw [model] hello from stdout'));
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      process.kill(pid, 0);
      await app.close();
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, { what: 'the child to be gone' });
    } finally {
      await app.stop();
      fs.rmSync(pidFile, { force: true });
    }
  });

  test('close() while the child is still starting does not leave it behind', async () => {
    const pidFile = path.join(os.tmpdir(), `terucon-pid2-${process.pid}-${Date.now()}`);
    const app = await startTestApp({ environ: { FAKE_PID_FILE: pidFile, FAKE_MODE: 'never-ready' }, model: { mode: 'auto', command: process.execPath, args: [FAKE_CHILD] }, startModel: true });
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8'), { what: 'the child to start' });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await app.stop();
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, { what: 'the child to be gone' });
    fs.rmSync(pidFile, { force: true });
  });

  test('a key is made up for the child when none is set, and a set one is used', async () => {
    const dump = path.join(os.tmpdir(), `terucon-env-${process.pid}-${Date.now()}.json`);
    const run = async (modelKey) => {
      const app = await startTestApp({ environ: { FAKE_ENV_DUMP: dump }, model: { mode: 'auto', command: process.execPath, args: [FAKE_CHILD], key: modelKey }, startModel: true });
      try {
        await waitFor(async () => (await app.app.locals.terucon.model.status()).status === 'ready');
        return JSON.parse(fs.readFileSync(dump, 'utf8'));
      } finally {
        await app.stop();
      }
    };
    const generated = await run(undefined);
    assert.match(generated.MODEL_SERVICE_KEY, /^[0-9a-f]{48}$/);
    assert.equal(generated.TERUCON_ENV_FILE.endsWith('test.env'), true);
    assert.equal((await run('my-own-key')).MODEL_SERVICE_KEY, 'my-own-key');
    fs.rmSync(dump, { force: true });
  });
});
