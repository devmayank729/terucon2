import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { request } from '../helpers/http.js';
import { makeProjectRoot, setStudioEnv } from '../helpers/studio.js';

// "Mounted in the website" must not change how the studio behaves. Identical files do not prove that: a website that wraps the
// studio can add or replace headers, drop ETags or change error bodies. So the studio is run twice, from the same files:
//   alone  - `node server/index.js`, the way it was built to run (its own process, its own port)
//   mounted - inside the website (createApp with the studio), in this process
// and the same requests go to both. Status, headers and body must be equal, apart from what can not be (the date, cookies).
// Addresses the website deliberately answers itself (/, /studio, its own /api routes, and the Coming soon page for a miss) are
// not compared; everything the studio answers is.

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const STUDIO = { STUDIO_PASSCODE: 'letmein', SESSION_SECRET: 'parity-secret' };
setStudioEnv(STUDIO);
const project = makeProjectRoot();

// alone
const alonePort = await freePort();
const alone = spawn(process.execPath, [path.join(project.studioDir, 'server', 'index.js')], {
  cwd: project.studioDir,
  env: { PATH: process.env.PATH, HOME: project.base ?? project.root, PORT: String(alonePort), MONGODB_URI: 'mongodb://127.0.0.1:1/parity', MODEL_SERVICE_URL: 'http://127.0.0.1:1', ...STUDIO },
});
let aloneLog = '';
alone.stdout.on('data', (d) => (aloneLog += d));
alone.stderr.on('data', (d) => (aloneLog += d));

// mounted
const { createApp } = await import('../../app.js');
const app = createApp({ root: project.root, environ: { STUDIO_REQUIRE_PASSCODE: 'on' }, swatchroom: true, log: { info() {}, warn() {}, error() {}, raw() {} } });
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const mountedPort = server.address().port;

for (let i = 0; i < 100; i += 1) {
  try { if ((await request(alonePort, { path: '/api/session' })).status === 200) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 100));
}

test.after(async () => {
  alone.kill('SIGTERM');
  await new Promise((resolve) => (alone.exitCode !== null ? resolve() : alone.once('exit', resolve)));
  await new Promise((resolve) => (server.closeAllConnections(), server.close(resolve)));
  await app.locals.terucon.close();
  project.remove();
});

// the anti-framing and HTTPS headers are the website's (server/middleware/headers.js); the studio on its own sends none
const IGNORE = new Set(['date', 'set-cookie', 'connection', 'keep-alive', 'x-frame-options', 'content-security-policy', 'strict-transport-security']);
const normal = (r) => ({
  status: r.status,
  headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => !IGNORE.has(k)).sort(([a], [b]) => a.localeCompare(b))),
  body: r.buffer.toString('latin1'),
});
const both = async (options) => [normal(await request(alonePort, options)), normal(await request(mountedPort, options))];
const same = async (what, options) => {
  const [a, m] = await both(options);
  assert.deepEqual(m.headers, a.headers, `${what}: headers differ (alone first)`);
  assert.equal(m.status, a.status, `${what}: status`);
  assert.equal(m.body, a.body, `${what}: body`);
  return a;
};
const signIn = async (port) => {
  const r = await request(port, { method: 'POST', path: '/api/session', body: { passcode: STUDIO.STUDIO_PASSCODE } });
  assert.equal(r.status, 200);
  return r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
};

test('the studio\'s own files come with the same status, headers and bytes', async () => {
  for (const p of ['/js/swatchroom-app.js', '/js/views/studio.js', '/css/swatchroom.css', '/css/fonts.css', '/fonts/zodiak-300.woff2', '/textures/brick.png', '/favicon.svg', '/admin', '/admin.html']) {
    await same(p, { path: p });
  }
});

test('the studio\'s API answers the same: the session, the passcode refusals, the wake-up, a raw photo upload', async () => {
  const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
  const unsigned = (await both({ path: '/api/session' })).map((r) => ({ ...r, body: r.body }));
  assert.deepEqual(unsigned[1], unsigned[0], 'GET /api/session');
  await same('unsigned GET /api/vision/warmup', { path: '/api/vision/warmup' });
  await same('unsigned GET /api/rooms', { path: '/api/rooms' });
  await same('unsigned GET a room file', { path: '/api/rooms/room-test0001/files/photo' });
  await same('unsigned POST /api/ai/generate', { method: 'POST', path: '/api/ai/generate', body: {} });
  await same('wrong passcode', { method: 'POST', path: '/api/session', body: { passcode: 'nope' } });

  const [cookieAlone, cookieMounted] = [await signIn(alonePort), await signIn(mountedPort)];
  const withCookie = async (what, options) => {
    const a = normal(await request(alonePort, { ...options, headers: { ...options.headers, Cookie: cookieAlone } }));
    const m = normal(await request(mountedPort, { ...options, headers: { ...options.headers, Cookie: cookieMounted } }));
    assert.deepEqual(m.headers, a.headers, `${what}: headers differ (alone first)`);
    assert.equal(m.status, a.status, `${what}: status`);
    assert.equal(m.body, a.body, `${what}: body`);
  };
  await withCookie('signed-in GET /api/session', { path: '/api/session' });
  await withCookie('signed-in GET /api/vision/warmup', { path: '/api/vision/warmup' });
  await withCookie('POST /api/pipeline/warmup (not a scan)', { method: 'POST', path: '/api/pipeline/warmup', body: { reason: 'page' } });
  await withCookie('raw photo to /api/vision/segment', { method: 'POST', path: '/api/vision/segment?model=b5-quant', headers: { 'Content-Type': 'image/jpeg' }, body: photo });
  await withCookie('an unknown studio API path', { path: '/api/rooms/zzz/unknown/path/x' });
  await withCookie('an unknown studio API method', { method: 'PATCH', path: '/api/session', body: {} });
});

test('the standalone run really was the studio on its own (so the comparison means something)', () => {
  assert.match(aloneLog, /Swatchroom is running on http:\/\/localhost:\d+/);
});
