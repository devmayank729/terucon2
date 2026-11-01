import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ASSETS } from '../../server/routes/inspiration.js';
import { FetchError } from '../../server/lib/inspiration/safeFetch.js';
import { startTestApp } from '../helpers/app.js';

// Inspiration import (C3) through the real server: who may ask, what the answers look like, what is served as a browser module.
// gallery-dl and the network are replaced by fakes (the test seam of createApp's `inspiration` option).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const u16 = (n) => Buffer.from([(n >> 8) & 255, n & 255]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), u16(16), Buffer.alloc(14), Buffer.from([0xff, 0xc0]), u16(17), Buffer.from([8]), u16(800), u16(1200), Buffer.alloc(20)]);
const BOARD = 'https://www.pinterest.com/some_one/kitchen-ideas/';
const PIN = (n) => `https://i.pinimg.com/originals/ab/cd/${n}.jpg`;

function fakes() {
  const fetched = [];
  const gallery = {
    ready: () => true,
    async run(job) {
      return { title: 'Kitchen ideas', extractor: job.extractor, items: [1, 2].map((n) => ({ url: PIN(n), width: 1000, height: 1500, title: `pin ${n}`, thumb: `https://i.pinimg.com/474x/ab/cd/${n}.jpg` })) };
    },
  };
  const fetcher = {
    async get(url, options) {
      fetched.push(url);
      if (url.includes('/gone')) throw new FetchError('status', 'x', 404);
      return { body: JPEG, contentType: 'image/jpeg', finalUrl: url };
    },
  };
  return { gallery, fetcher, fetched };
}

async function withApp(fn, options = {}) {
  const f = fakes();
  const app = await startTestApp({ inspiration: { gallery: f.gallery, fetcher: f.fetcher }, ...options });
  try {
    await fn(app, f);
  } finally {
    await app.stop();
  }
}

test('every inspiration route needs a signed-in, finished account', async () => {
  await withApp(async (app) => {
    const unfinished = await app.signIn({ finish: false });
    for (const [method, route] of [['GET', '/api/inspiration/status'], ['POST', '/api/inspiration/resolve'], ['GET', '/api/inspiration/file/abc']]) {
      const anonymous = method === 'GET' ? await app.get(route) : await app.post(route, { input: BOARD });
      assert.equal(anonymous.status, 401, route);
      assert.equal(anonymous.headers['cache-control'], 'no-store');
      const partial = method === 'GET' ? await app.get(route, unfinished.headers) : await app.post(route, { input: BOARD }, unfinished.headers);
      assert.equal(partial.status, 403, route);
    }
  });
});

test('status lists what can be read; resolve answers with tokens; the file route gives the checked picture', async () => {
  await withApp(async (app, f) => {
    const me = await app.signIn();
    const status = await app.get('/api/inspiration/status', me.headers);
    assert.equal(status.status, 200);
    assert.equal(status.json().enabled, true);
    assert.ok(status.json().sites.some((s) => s.label === 'Pinterest'));
    assert.equal(status.headers['cache-control'], 'no-store');

    const r = await app.post('/api/inspiration/resolve', { input: `have a look: ${BOARD}` }, me.headers);
    assert.equal(r.status, 200, r.text);
    const body = r.json();
    assert.equal(body.kind, 'collection');
    assert.equal(body.source.label, 'Pinterest');
    assert.equal(body.items.length, 2);
    assert.ok(!r.text.includes('originals'), 'the answer never carries the picture address');
    assert.equal(r.headers['cache-control'], 'no-store');

    const file = await app.get(`/api/inspiration/file/${body.items[1].token}`, me.headers);
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-type'], 'image/jpeg');
    assert.equal(file.headers['x-content-type-options'], 'nosniff');
    assert.equal(file.headers['cache-control'], 'private, no-store');
    assert.equal(file.headers['x-picture-size'], '1200x800');
    assert.deepEqual(file.buffer, JPEG);
    assert.deepEqual(f.fetched, [PIN(2)]);

    // somebody else's token, and a token that was never issued
    const you = await app.signIn();
    assert.equal((await app.get(`/api/inspiration/file/${body.items[0].token}`, you.headers)).status, 410);
    assert.equal((await app.get('/api/inspiration/file/not-a-token', me.headers)).status, 410);
  });
});

test('errors carry a short reason the page acts on, and show nothing of the machinery', async () => {
  await withApp(async (app) => {
    const me = await app.signIn();
    const login = await app.post('/api/inspiration/resolve', { input: 'https://www.instagram.com/p/AbC123/' }, me.headers);
    assert.equal(login.status, 422);
    assert.equal(login.json().error.reason, 'login');
    assert.match(login.json().error.message, /upload/i);
    const junk = await app.post('/api/inspiration/resolve', { input: 'kitchen ideas' }, me.headers);
    assert.equal(junk.status, 400);
    assert.equal(junk.json().error.reason, 'bad-address');
    assert.equal((await app.post('/api/inspiration/resolve', {}, me.headers)).status, 400);
    const gone = await app.post('/api/inspiration/resolve', { input: 'https://example.com/gone.jpg' }, me.headers);
    const token = gone.json().items[0].token;
    const file = await app.get(`/api/inspiration/file/${token}`, me.headers);
    assert.equal(file.status, 404);
    assert.equal(file.json().error.reason, 'not-found');
  });
});

test('the usual guards apply: JSON only, same origin only, the right method, no odd capitals', async () => {
  await withApp(async (app) => {
    const me = await app.signIn();
    assert.equal((await app.post('/api/inspiration/resolve', 'input=x', { ...me.headers, 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await app.post('/api/inspiration/resolve', { input: BOARD }, { ...me.headers, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await app.get('/api/inspiration/resolve', me.headers)).status, 405);
    assert.equal((await app.post('/api/inspiration/status', {}, me.headers)).status, 405);
    assert.equal((await app.request('/API/inspiration/status', { headers: me.headers })).status, 404);
  });
});

test('switched off, it says so; with the program missing, it says it is not set up', async () => {
  const app = await startTestApp({ env: 'IMPORTER_PYTHON=/no/such/python\n' });
  try {
    const me = await app.signIn();
    const missing = await app.post('/api/inspiration/resolve', { input: BOARD }, me.headers);
    assert.equal(missing.status, 503);
    assert.equal(missing.json().error.reason, 'not-set-up');
    assert.equal((await app.get('/api/inspiration/status', me.headers)).json().ready, false);
    app.writeEnv('INSPIRATION_IMPORT=off\n');
    assert.equal((await app.post('/api/inspiration/resolve', { input: BOARD }, me.headers)).json().error.reason, 'off');
  } finally {
    await app.stop();
  }
});

test('the browser modules are served from a fixed list of names, with the right type, and nothing else in the folder is', async () => {
  await withApp(async (app) => {
    fs.cpSync(path.join(ROOT, 'site', 'inspiration'), path.join(app.root, 'site', 'inspiration'), { recursive: true });
    fs.writeFileSync(path.join(app.root, 'site', 'inspiration', 'notes.txt'), 'private notes');
    for (const name of ASSETS) {
      if (!fs.existsSync(path.join(ROOT, 'site', 'inspiration', name))) continue; // written later in this change: the list is checked against the folder below
      const r = await app.get(`/inspiration/assets/${name}`);
      assert.equal(r.status, 200, name);
      assert.match(r.headers['content-type'], name.endsWith('.css') ? /text\/css/ : /javascript/, name);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    }
    for (const bad of ['notes.txt', '..%2Fsources.js', '%2e%2e/site.json', 'SOURCES.JS', 'sources.js%00', 'nope.js']) {
      const r = await app.get(`/inspiration/assets/${bad}`);
      assert.notEqual(r.status, 200, bad);
      assert.ok(!r.text.includes('private notes'), bad);
    }
  });
});

test('the list of served names is exactly the files of the folder', () => {
  const files = fs.readdirSync(path.join(ROOT, 'site', 'inspiration')).filter((n) => !n.startsWith('.')).sort();
  assert.deepEqual(files, [...ASSETS].sort(), 'a new browser file needs its name in ASSETS (server/routes/inspiration.js), and an old name should go');
});
