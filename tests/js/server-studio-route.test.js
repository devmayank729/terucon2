import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createApp } from '../../app.js';
import { createApiRegistry } from '../../server/routes/api.js';
import { mountStudioRoutes } from '../../server/routes/studio.js';
import { request } from '../helpers/http.js';
import { makeTempRoot } from '../helpers/tempRoot.js';

// POST /api/studio/warmup, on its own: what it decides, with a stand-in for the studio (the real one is in server-studio.test.js).

/** A bare app with just this route, a settings stub and a studio stub that records what it was asked. */
async function routeApp({ studio, warmup = true }) {
  const lines = [];
  const app = express();
  const ctx = { log: { info: (m) => lines.push(m) }, settings: () => ({ studio: { warmup } }), swatchroom: studio };
  ctx.api = createApiRegistry(app);
  mountStudioRoutes(app, ctx);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    lines,
    post: (body, headers) => request(server.address().port, { method: 'POST', path: '/api/studio/warmup', body, headers }),
    stop: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))),
  };
}

test('it starts what the studio says it started, and answers with only a count', async () => {
  const asked = [];
  const t = await routeApp({ studio: { warm: () => (asked.push(1), ['oneformer', 'analyze']) } });
  try {
    const r = await t.post({ from: 'landing' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { warming: 2 }, 'no pool names or addresses leave the server');
    assert.equal(asked.length, 1);
    assert.match(t.lines.join('\n'), /warm-up from the landing page: starting oneformer, analyze/);
  } finally {
    await t.stop();
  }
});

test('nothing to start is not logged and not an error', async () => {
  const t = await routeApp({ studio: { warm: () => [] } });
  try {
    assert.deepEqual((await t.post({ from: 'studio' })).json(), { warming: 0 });
    assert.deepEqual(t.lines, []);
  } finally {
    await t.stop();
  }
});

test('only the two pages that send it are named in the log; anything else is "other"', async () => {
  const t = await routeApp({ studio: { warm: () => ['analyze'] } });
  try {
    await t.post({ from: 'studio' });
    await t.post({ from: 'a<script>' });
    await t.post({});
    assert.match(t.lines[0], /from the studio page/);
    assert.match(t.lines[1], /from the other page/);
    assert.match(t.lines[2], /from the other page/);
    assert.ok(t.lines.every((l) => !l.includes('<script>')), 'what the browser sends is never copied into the log');
  } finally {
    await t.stop();
  }
});

test('STUDIO_WARMUP=off: it answers, and starts nothing', async () => {
  const t = await routeApp({ warmup: false, studio: { warm: () => assert.fail('must not wake anything') } });
  try {
    assert.deepEqual((await t.post({ from: 'landing' })).json(), { warming: 0, reason: 'switched-off' });
  } finally {
    await t.stop();
  }
});

test('without the studio it answers politely instead of failing', async () => {
  const t = await routeApp({ studio: null });
  try {
    assert.deepEqual((await t.post({ from: 'landing' })).json(), { warming: 0, reason: 'studio-not-running' });
  } finally {
    await t.stop();
  }
});

test('the real app, built without the studio (the default): the route answers, and none of the studio is there', async () => {
  const temp = makeTempRoot();
  const app = createApp({ root: temp.root, envPath: temp.envPath, environ: {}, log: { info() {}, warn() {}, error() {}, raw() {} } });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.deepEqual((await request(port, { method: 'POST', path: '/api/studio/warmup', body: { from: 'landing' } })).json(), { warming: 0, reason: 'studio-not-running' });
    assert.equal((await request(port, { path: '/js/swatchroom-app.js' })).status, 404);
    const session = await request(port, { path: '/api/session' });
    assert.equal(session.status, 404);
    assert.equal(session.json().error.status, 'NOT_FOUND', 'the website\'s own error shape');
    assert.equal(app.locals.terucon.studio, null);
    assert.deepEqual((await request(port, { path: '/api/health' })).json().studio, { running: false });
  } finally {
    await new Promise((resolve) => (server.closeAllConnections(), server.close(resolve)));
    temp.cleanup();
  }
});
