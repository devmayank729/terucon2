// The one test that starts the REAL Python model service (model/terucon_model) as the website would.
// Temp env file, explicit environment, no network: Google is never contacted. Skipped when the package or
// its Python dependencies are not there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { startServer } from '../../app.js';
import { findPython } from '../../server/model/python.js';
import { collectLog } from '../helpers/app.js';
import { request, waitFor } from '../helpers/http.js';
import { PROJECT_ROOT } from '../helpers/tempRoot.js';

const KEY = 'integration-test-key';
const python = fs.existsSync(path.join(PROJECT_ROOT, 'model', 'terucon_model', '__init__.py')) ? await findPython({ root: PROJECT_ROOT }) : { error: 'model/terucon_model is not there' };

describe('the real Python model service behind the website', { skip: python.error }, () => {
  let dir;
  let running;
  let log;
  const api = (p, options) => request(running.port, { path: p, ...options });
  const modelUrl = () => running.app.locals.terucon.model.url();

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-integration-'));
    const envPath = path.join(dir, 'test.env');
    fs.writeFileSync(envPath, 'GEMINI_API_KEY=not-a-real-key\n'); // "configured", so /api/segment is passed on; Google is not reached
    log = collectLog();
    running = await startServer({
      root: PROJECT_ROOT,
      envPath,
      environ: {},
      model: { mode: 'auto', key: KEY, startTimeoutMs: 90_000 },
      log,
      port: 0,
      host: '127.0.0.1',
    });
    await waitFor(async () => (await running.app.locals.terucon.model.status()).status === 'ready', { timeoutMs: 90_000, what: 'the Python service to become ready' });
  });
  after(async () => {
    await running?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('/api/config shows the model ready and SAM as the service reports it (off by default)', async () => {
    const config = (await api('/api/config')).json();
    assert.deepEqual(config.model, { mode: 'auto', status: 'ready' });
    assert.equal(config.sam.enabled, false);
    assert.equal(config.sam.status, 'off');
    assert.equal(config.google.mode, 'api-key');
    assert.ok(!JSON.stringify(config).includes('not-a-real-key'));
    assert.ok(!JSON.stringify(config).includes(KEY));
  });

  test('/api/sam/health is the service\'s SAM contract body', async () => {
    const r = await api('/api/sam/health');
    assert.equal(r.status, 200);
    const body = r.json();
    for (const field of ['status', 'model', 'backend', 'device', 'interactive', 'text_prompts', 'error']) assert.ok(field in body, field);
    assert.equal(body.interactive, false);
  });

  test('/api/segment is streamed to the service, which answers in the project\'s error shape', async () => {
    const r = await api('/api/segment', { method: 'POST', body: { image: '' } });
    assert.equal(r.status, 400);
    assert.equal(r.json().error.code, 400);
    assert.match(r.json().error.message, /base64/);
    const sam = await api('/api/sam/refine', { method: 'POST', body: { image_id: 'nope' } });
    assert.equal(sam.status, 503, 'SAM is off, so the service says so');
    assert.ok(sam.json().error.message.length > 0);
  });

  test('the service itself refuses a missing or wrong key with 401, and a foreign Host with 421', async () => {
    const url = new URL(modelUrl());
    const port = Number(url.port);
    const direct = (headers) => request(port, { path: '/health', headers: { Host: `127.0.0.1:${port}`, ...headers } });
    for (const headers of [{}, { 'X-Terucon-Model-Key': 'wrong' }, { 'X-Terucon-Model-Key': KEY + 'x' }]) {
      const r = await direct(headers);
      assert.equal(r.status, 401, JSON.stringify(headers));
      assert.equal(r.json().error.status, 'UNAUTHENTICATED');
    }
    const good = await direct({ 'X-Terucon-Model-Key': KEY });
    assert.equal(good.status, 200);
    assert.equal(good.json().service, 'terucon-model');
    assert.equal((await direct({ 'X-Terucon-Model-Key': KEY, Host: 'evil.example.com' })).status, 421);
    const text = await request(port, { path: '/segment', method: 'POST', body: '{}', headers: { Host: `127.0.0.1:${port}`, 'X-Terucon-Model-Key': KEY, 'Content-Type': 'text/plain' } });
    assert.equal(text.status, 415);
  });

  test('the [model] lines are logged, and close() takes the service down', async () => {
    assert.ok(log.lines.some((l) => /^info \[model\] ready at http:\/\/127\.0\.0\.1:\d+/.test(l)), log.lines.join('\n'));
    assert.ok(log.lines.some((l) => l.startsWith('raw [model] ')), 'the service\'s own output is passed on');
    const url = new URL(modelUrl());
    await running.close();
    await waitFor(async () => {
      try {
        await request(Number(url.port), { path: '/health', headers: { Host: `127.0.0.1:${url.port}` } });
        return false;
      } catch {
        return true;
      }
    }, { what: 'the service to stop listening' });
  });
});
