import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { request, waitFor } from '../helpers/http.js';
import { startMockModal } from '../helpers/mockModal.js';
import { PROJECT_ROOT, makeProjectRoot, setStudioEnv } from '../helpers/studio.js';

// The website with the Design Studio mounted in it, as a visitor meets it: the real studio code (from a copy of
// swatchroom/server with no .env), the real browser files, mock GPU pools in place of Modal, no database, no Google, and no
// local model service. Nothing real is reachable from here.

const oneformer = await startMockModal({ key: 'key-oneformer', bootMs: 150 });
const analyze = await startMockModal({ key: 'key-analyze', bootMs: 150 });
setStudioEnv({
  ONEFORMER_URL: `${oneformer.url}/v1/parse`,
  ONEFORMER_KEY: 'key-oneformer',
  ANALYZE_URL: `${analyze.url}/v1/analyze`,
  ANALYZE_KEY: 'key-analyze',
  STUDIO_PASSCODE: 'letmein',
  STUDIO_REQUIRE_PASSCODE: 'on', // the website switches the passcode off unless asked; these tests are about the passcode
});
delete process.env.PORT;
delete process.env.HOST;

const project = makeProjectRoot();
// The studio configures itself from its own .env, read into process.env when it loads. These two lines must NOT become the
// website's port and host (see "the studio's .env never becomes the website's settings" below).
fs.writeFileSync(path.join(project.studioDir, '.env'), 'PORT=3999\nHOST=0.0.0.0\n');

const { createApp } = await import('../../app.js');
const lines = [];
const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m), raw: (m) => lines.push(m) };
const app = createApp({ root: project.root, swatchroom: true, log }); // no `environ`: the website takes its own snapshot
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const need = createRequire(path.join(project.studioDir, 'server', 'index.js'));
need('mongoose').set('bufferCommands', false); // no database here: fail at once instead of waiting 10 s

test.after(async () => {
  await new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
  await app.locals.terucon.close();
  await oneformer.close();
  await analyze.close();
  project.remove();
});

const get = (path_, headers = {}) => request(port, { path: path_, headers });
const cookieOf = (r) => (r.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');

async function signIn() {
  const r = await request(port, { method: 'POST', path: '/api/session', body: { passcode: 'letmein' } });
  assert.equal(r.status, 200, r.text);
  return [cookieOf(r)].filter(Boolean).join('; ');
}

test('the studio\'s .env never becomes the website\'s settings', () => {
  assert.equal(process.env.PORT, '3999', 'the studio did read its .env into the process environment');
  assert.equal(process.env.HOST, '0.0.0.0');
  const s = app.locals.terucon.settings();
  assert.equal(s.port, 8080);
  assert.equal(s.host, '127.0.0.1');
});

test('the website keeps its own pages; /studio and /swatchroom lead to the studio page', async () => {
  assert.match((await get('/')).text, /<title>home<\/title>/, 'the landing page, not the studio\'s own page');
  assert.match((await get('/design-studio')).text, /<title>studio<\/title>/);
  assert.match((await get('/materials')).text, /<title>materials<\/title>/);
  for (const from of ['/studio', '/swatchroom', '/index.html']) {
    const r = await get(from);
    assert.equal(r.status, 301, from);
  }
  assert.equal((await get('/studio')).headers.location, '/design-studio');
  assert.equal((await get('/swatchroom')).headers.location, '/design-studio');
  assert.equal((await get('/Terucon%20Swatchroom.html')).headers.location, '/design-studio');
});

test('the studio\'s own files are served at the addresses its page asks for', async () => {
  const js = await get('/js/swatchroom-app.js');
  assert.equal(js.status, 200);
  assert.match(js.text, /customElements\.define\("swatchroom-app"/);
  assert.match((await get('/css/swatchroom.css')).headers['content-type'], /text\/css/);
  assert.match((await get('/css/fonts.css')).text, /Zodiak/);
  assert.equal((await get('/fonts/zodiak-300.woff2')).status, 200);
  assert.equal((await get('/textures/brick.png')).status, 200);
  assert.equal((await get('/favicon.svg')).status, 200);
  assert.match((await get('/admin')).text, /<title>/i, 'the owner\'s dashboard page');
  // the page loader the Terucon page uses points at exactly this file
  const built = fs.readFileSync(path.join(PROJECT_ROOT, 'swatchroom', 'terucon', 'Swatchroom.html'), 'utf8');
  assert.ok(built.length > 0);
});

test('the studio\'s API answers, behind its own passcode', async () => {
  const session = (await get('/api/session')).json();
  assert.equal(session.passcodeRequired, true);
  assert.equal(session.signedIn, false);
  const blocked = await get('/api/vision/warmup');
  assert.equal(blocked.status, 401);
  assert.equal(blocked.json().code, 'passcode');
  const cookie = await signIn();
  const status = await get('/api/vision/warmup', { Cookie: cookie });
  assert.equal(status.status, 200);
  assert.equal(status.json().configured, true);
  assert.equal(status.json().mode, 'passive');
  assert.equal((await get('/api/no-such-thing', { Cookie: cookie })).status, 404);
});

test('photos go through the website\'s guards: raw image bytes are not refused (no 415), a foreign Origin still is', async () => {
  const cookie = await signIn();
  const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
  for (const type of ['image/jpeg', 'application/octet-stream']) {
    const r = await request(port, { method: 'POST', path: '/api/vision/segment?model=b5-quant', headers: { 'Content-Type': type, Cookie: cookie }, body: photo });
    // it got as far as the studio's own forwarding, which reports that no local model service runs here
    assert.equal(r.status, 503, `${type}: ${r.text}`);
    assert.match(r.json().error, /model service is not running/);
  }
  const put = await request(port, { method: 'PUT', path: '/api/rooms/room-test0001/files/photo', headers: { 'Content-Type': 'image/jpeg', Cookie: cookie }, body: photo });
  assert.notEqual(put.status, 415, 'saving a photo to a room is not a JSON request');
  const foreign = await request(port, { method: 'POST', path: '/api/vision/segment?model=b5-quant', headers: { 'Content-Type': 'image/jpeg', Cookie: cookie, Origin: 'https://evil.example' }, body: photo });
  assert.equal(foreign.status, 403);
  assert.match(foreign.json().error.message, /Cross-origin/);
  const same = await request(port, { method: 'POST', path: '/api/vision/segment?model=b5-quant', headers: { 'Content-Type': 'image/jpeg', Cookie: cookie, Origin: `http://localhost:${port}` }, body: photo });
  assert.equal(same.status, 503, 'a same-site Origin (the studio page calling its own server) passes');
});

test('the website\'s own API keeps its rules and its own error shape, with the studio mounted', async () => {
  const text = await request(port, { method: 'POST', path: '/api/studio/warmup', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(text.status, 415, 'JSON only');
  const wrong = await request(port, { method: 'POST', path: '/api/health', body: {} });
  assert.equal(wrong.status, 405, 'not the studio\'s "enter the passcode first"');
  assert.equal(wrong.headers.allow, 'GET, HEAD');
  const unknown = await get('/api/nothing-at-all');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json().error.status, 'NOT_FOUND', 'the website\'s error shape, not the studio\'s');
  assert.equal((await get('/api/site')).status, 200);
});

test('the landing page wake-up needs no passcode, starts the scan and analysis pools once, and the studio\'s gate then sees them warm', async () => {
  const before = (await get('/api/vision/warmup', { Cookie: await signIn() })).json();
  assert.equal(before.warm, false);

  // a visitor who has not entered the passcode: the website's route, not the studio's
  const first = await request(port, { method: 'POST', path: '/api/studio/warmup', body: { from: 'landing' } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json(), { warming: 2 });
  assert.ok(lines.some((l) => /studio {2}warm-up from the landing page: starting .*oneformer/.test(l)), lines.join('\n'));

  const cookie = await signIn();
  const waking = (await get('/api/vision/warmup', { Cookie: cookie })).json();
  assert.equal(waking.state, 'waking', 'while the pools boot the studio knows they are starting');
  assert.equal(waking.warm, false);

  // asking again while they boot, from the studio page this time: nothing new is started
  const again = await request(port, { method: 'POST', path: '/api/studio/warmup', body: { from: 'studio' } });
  assert.deepEqual(again.json(), { warming: 0 });

  const warm = await waitFor(async () => {
    const s = (await get('/api/vision/warmup', { Cookie: cookie })).json();
    return s.warm ? s : null;
  }, { what: 'the pools to count as warm' });
  assert.equal(warm.state, 'warm');
  assert.equal(warm.pools.oneformer.warm, true);
  assert.equal(warm.pools.analyze.warm, true);

  // and a visitor arriving later in the same warm window starts nothing
  assert.deepEqual((await request(port, { method: 'POST', path: '/api/studio/warmup', body: { from: 'landing' } })).json(), { warming: 0 });
  assert.deepEqual(oneformer.hits.map((h) => h.path), ['/healthz']);
  assert.deepEqual(analyze.hits.map((h) => h.path), ['/healthz']);
  assert.ok(oneformer.hits.every((h) => h.authorized) && analyze.hits.every((h) => h.authorized));
});

test('/api/health shows that the studio is running, and never turns "not ok" because its database is down', async () => {
  const health = (await get('/api/health')).json();
  assert.equal(health.ok, true);
  assert.deepEqual(health.studio, { running: true, database: false });
});

test('the studio\'s API prefixes are exactly the ones its server answers', () => {
  // read from the studio's own source: what it mounts under /api/<name>, and the first part of the routes of the routers it
  // mounts at /api itself
  const dir = path.join(PROJECT_ROOT, 'swatchroom', 'server');
  const index = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
  const expected = new Set();
  for (const [, prefix, file] of index.matchAll(/app\.use\(\s*"(\/api[^"]*)",\s*require\("\.\/routes\/(\w+)"\)/g)) {
    if (prefix !== '/api') {
      expected.add(prefix);
      continue;
    }
    const routes = fs.readFileSync(path.join(dir, 'routes', `${file}.js`), 'utf8');
    for (const [, first] of routes.matchAll(/router\.(?:get|post|put|patch|delete)\(\s*"\/([a-z]+)/g)) expected.add(`/api/${first}`);
  }
  assert.ok(expected.size >= 7, [...expected].join(','));
  assert.deepEqual([...app.locals.terucon.studio.apiPrefixes].sort(), [...expected].sort());
});

test('an unknown address still gets the Coming soon page, and the studio\'s misses are not mistaken for pages', async () => {
  const page = await get('/careers', { Accept: 'text/html' });
  assert.equal(page.status, 404);
  assert.match(page.text, /Coming soon/);
  assert.equal((await get('/js/no-such-file.js', { Accept: 'text/html' })).status, 404);
  assert.doesNotMatch((await get('/js/no-such-file.js', { Accept: 'text/html' })).text, /Coming soon/);
});
