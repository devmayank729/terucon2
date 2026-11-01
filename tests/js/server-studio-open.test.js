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
const { createAuthDb } = await import('../../server/auth/db.js');
const { captureProviders, SECRET } = await import('../helpers/authKit.js');
const { signInVia } = await import('../helpers/signIn.js');
const capture = captureProviders();
const lines = [];
const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m), raw: (m) => lines.push(m) };
const app = createApp({ root: project.root, swatchroom: true, log, auth: { db: createAuthDb({}), providers: capture.providers, secret: SECRET } });
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
createRequire(path.join(project.studioDir, 'server', 'index.js'))('mongoose').set('bufferCommands', false); // no database: fail at once

test.after(async () => {
  await new Promise((resolve) => (server.closeAllConnections(), server.close(resolve)));
  await app.locals.terucon.close();
  project.remove();
});

// the studio's passcode is off, but its costly routes need a signed-in account (the website's sign-in): this is that account
const member = await signInVia((p, o = {}) => request(port, { path: p, ...o }), capture);
const get = (p, headers = {}) => request(port, { path: p, headers: { ...member.headers, ...headers, Cookie: [member.cookie, headers.Cookie].filter(Boolean).join('; ') } });

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
  // the account is the owner now, whatever browser cookie it carries: three writes in a row, the limit is two
  const put = () => request(port, { method: 'PUT', path: '/api/rooms/room-test0001', headers: member.headers, body: { name: 'x' } });
  assert.notEqual((await put()).status, 429);
  assert.notEqual((await put()).status, 429);
  const blocked = await put();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json().code, 'rate-limit');
});

test('the admin can change the studio\'s limits: a saved value wins over STUDIO_LIMIT_* in .env, at once, and a reset goes back to .env', async () => {
  const auth = app.locals.terucon.auth;
  const put = () => request(port, { method: 'PUT', path: '/api/rooms/room-test0001', headers: member.headers, body: { name: 'x' } });
  // the earlier test used up the 2 that .env allows and was refused the third; the admin raises the limit to 5
  await auth.settings.update({ 'studio.limit.rooms': 5 });
  const refused = [];
  for (let i = 0; i < 5; i += 1) refused.push((await put()).status === 429);
  assert.deepEqual(refused, [false, false, false, true, true], 'three more are let through, then the new limit holds');
  const described = await auth.settings.describe();
  assert.equal(described.values['studio.limit.rooms'], 5);
  assert.equal(described.defaults['studio.limit.rooms'], 2, 'the starting value is what .env says, not the built-in 600');
  await auth.settings.update({ 'studio.limit.rooms': null });
  assert.equal((await auth.settings.describe()).values['studio.limit.rooms'], 2);
  assert.equal((await put()).status, 429, 'back to .env\'s 2: the hour\'s writes are already used up');
  await assert.rejects(auth.settings.update({ 'studio.limit.rooms': 0 }), /between 1 and/);
});

test('with no database the rooms list is the studio\'s own answer, not an empty list that hides the problem', async () => {
  const r = await get('/api/rooms', { Cookie: 'terucon_owner=' + 'd'.repeat(32) });
  assert.notEqual(r.status, 200);
});

test('the banner says plainly that the passcode is off', async () => {
  const { describe } = await import('../../server/config/settings.js');
  assert.ok(describe(app.locals.terucon.settings()).some((l) => /Studio passcode: off/.test(l)));
});
