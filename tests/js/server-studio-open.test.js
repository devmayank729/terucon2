import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { request } from '../helpers/http.js';
import { makeProjectRoot, setStudioEnv } from '../helpers/studio.js';

// The website with the studio mounted and no STUDIO_REQUIRE_PASSCODE: the studio's passcode is off even though the studio's own
// settings (the environment and its .env) still hold one, and the shield stands in front of it.

setStudioEnv({ STUDIO_PASSCODE: 'letmein', STUDIO_LIMIT_ROOMS: '2', STUDIO_LIMIT_ADDRESS_FACTOR: '1' });
delete process.env.PORT;
delete process.env.HOST;
const project = makeProjectRoot();
fs.writeFileSync(path.join(project.studioDir, '.env'), 'STUDIO_PASSCODE=from-the-studios-own-env-file\n');

const { createApp } = await import('../../app.js');
const lines = [];
const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m), raw: (m) => lines.push(m) };
const app = createApp({ root: project.root, swatchroom: true, log });
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
createRequire(path.join(project.studioDir, 'server', 'index.js'))('mongoose').set('bufferCommands', false); // no database: fail at once

test.after(async () => {
  await new Promise((resolve) => (server.closeAllConnections(), server.close(resolve)));
  await app.locals.terucon.close();
  project.remove();
});

const get = (p, headers = {}) => request(port, { path: p, headers });

test('the studio does not ask for a passcode, whatever its own settings say', async () => {
  assert.equal(app.locals.terucon.requirePasscode, false);
  const session = (await get('/api/session')).json();
  assert.equal(session.passcodeRequired, false);
  assert.equal(session.signedIn, true);
  assert.notEqual((await get('/api/vision/warmup')).status, 401, 'a route that used to need the passcode');
  const login = await request(port, { method: 'POST', path: '/api/session', body: { passcode: 'letmein' } });
  assert.deepEqual(login.json(), { signedIn: true });
});

test('every browser is given a private owner cookie, and the site cannot be shown inside another site', async () => {
  const r = await get('/api/session');
  assert.match(r.headers['set-cookie'].join(';'), /terucon_owner=[a-f0-9]{32}; .*HttpOnly/i);
  const page = await get('/design-studio');
  assert.equal(page.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(page.headers['content-security-policy'], "frame-ancestors 'self'");
  assert.equal(page.headers['strict-transport-security'], undefined, 'HSTS only on HTTPS');
});

test('the shield\'s limits come from STUDIO_LIMIT_* and stop a flood on a write route', async () => {
  const cookie = 'terucon_owner=' + 'c'.repeat(32);
  const put = () => request(port, { method: 'PUT', path: '/api/rooms/room-test0001', headers: { Cookie: cookie }, body: { name: 'x' } });
  assert.notEqual((await put()).status, 429);
  assert.notEqual((await put()).status, 429);
  const blocked = await put();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json().code, 'rate-limit');
});

test('with no database the rooms list is the studio\'s own answer, not an empty list that hides the problem', async () => {
  const r = await get('/api/rooms', { Cookie: 'terucon_owner=' + 'd'.repeat(32) });
  assert.notEqual(r.status, 200);
});

test('the banner says plainly that the passcode is off', async () => {
  const { describe } = await import('../../server/config/settings.js');
  assert.ok(describe(app.locals.terucon.settings()).some((l) => /Studio passcode: off/.test(l)));
});
