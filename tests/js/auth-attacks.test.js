import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { after, before, describe } from 'node:test';
import { studioShield } from '../../server/lib/studioShield.js';
import { PROJECT_ROOT } from '../helpers/tempRoot.js';
import { startTestApp } from '../helpers/app.js';
import { captureProviders, SECRET } from '../helpers/authKit.js';
import { rawRequest, request } from '../helpers/http.js';
import { signInVia } from '../helpers/signIn.js';
import { makeProjectRoot, setStudioEnv } from '../helpers/studio.js';

// A security pass written as an attacker would: every attack below was actually sent to the running server, and each one is
// kept as a test so the next change cannot quietly bring the hole back. Attacks that found something are marked FOUND, with what
// it was; the rest are checks that the obvious doors are shut.
//
//   FOUND 1  /API/rooms, /Api/ai/... reached the Design Studio around the rate limits, room ownership and the JSON / Origin guards
//            (the studio's router ignores capitals, every protection in front of it did not). Fixed: server/middleware/canonical.js.
//   FOUND 2  the SMTP client refused the very text the code e-mail is made of (CRLF line breaks); caught by the tests, never shipped.
//   FOUND 3  after "Unlock" an address was still held by the wait between codes; fixed in server/routes/authAdmin.js.

let visitor = 0;
const nextIp = () => `10.210.${Math.floor(visitor / 250)}.${(visitor += 1) % 250}`;
const post = (app, p, body, headers = {}) => app.request(p, { method: 'POST', body, headers: { 'X-Forwarded-For': nextIp(), ...headers } });

// ------------------------------------------------------------------------------------------------ the studio, mounted
setStudioEnv({ STUDIO_LIMIT_ROOMS: '3', STUDIO_LIMIT_ADDRESS_FACTOR: '1' });
delete process.env.PORT;
delete process.env.HOST;
const project = makeProjectRoot();
const { createApp } = await import('../../app.js');
const { createAuthDb } = await import('../../server/auth/db.js');
const studioCapture = captureProviders();
const studioApp = createApp({ root: project.root, swatchroom: true, log: { info() {}, warn() {}, error() {}, raw() {} }, auth: { db: createAuthDb({}), providers: studioCapture.providers, secret: SECRET } });
const studioServer = http.createServer(studioApp);
await new Promise((resolve) => studioServer.listen(0, '127.0.0.1', resolve));
const studioPort = studioServer.address().port;
createRequire(path.join(project.studioDir, 'server', 'index.js'))('mongoose').set('bufferCommands', false);
after(async () => {
  await new Promise((resolve) => (studioServer.closeAllConnections(), studioServer.close(resolve)));
  await studioApp.locals.terucon.close();
  project.remove();
});
const studio = (p, o = {}) => request(studioPort, { path: p, ...o });
const studioMember = async (options) => signInVia(studio, studioCapture, options);

describe('FOUND 1: the studio\'s routes in other capitals', () => {
  test('/API, /Api, /aPI ... never reach the studio: no rate-limit bypass, no JSON/Origin guard bypass', async () => {
    const m = await studioMember();
    const results = {};
    for (const prefix of ['/api', '/API', '/Api', '/aPI', '/apI', '/APi']) {
      const statuses = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await studio(`${prefix}/rooms/room-attack0001`, { method: 'PUT', headers: m.headers, body: { name: 'x' } })).status);
      results[prefix] = statuses;
    }
    assert.ok(results['/api'].includes(429), 'the real prefix is rate limited (three writes an hour here)');
    for (const prefix of ['/API', '/Api', '/aPI', '/apI', '/APi']) assert.deepEqual(results[prefix], [404, 404, 404, 404, 404], prefix);
    // the cross-site write that the guards refuse on /api/ must not get through on /API/ either
    for (const p of ['/api/rooms/room-evil0001', '/API/rooms/room-evil0001', '/Api/ai/generate', '/API/vision/segment', '/API/pipeline/analyze', '/API/check', '/API/admin/login']) {
      const r = await studio(p, { method: 'POST', headers: { ...m.headers, 'Content-Type': 'text/plain', Origin: 'https://evil.example' }, body: '{"x":1}' });
      assert.ok([403, 404, 415].includes(r.status), `${p} -> ${r.status}`);
      assert.doesNotMatch(r.text, /Cannot call|rooms\.findOne|mongoose|database/i, `${p}: the studio did not answer`);
    }
  });

  test('other spellings of the same path never matched the studio at all: double slash, dot segments, encoded letters, a trailing dot', async () => {
    const m = await studioMember();
    for (const p of ['//api/rooms', '/api/../api/rooms', '/%61pi/rooms', '/%41PI/rooms', '/api%2Frooms', '/api/%2e%2e/api/rooms', '/./api/rooms', '/api./rooms', '/api;x=1/rooms', '/ap%69/rooms']) {
      const r = await studio(p, { headers: m.headers });
      assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.doesNotMatch(r.text, /rooms":\[|Cannot call/, p);
    }
  });
});

describe('the studio\'s costly and private routes need a signed-in, finished account', () => {
  const gated = [
    ['GET', '/api/rooms'], ['PUT', '/api/rooms/room-test0001'], ['DELETE', '/api/rooms/room-test0001'], ['GET', '/api/rooms/room-test0001/files/photo'],
    ['POST', '/api/ai/generate'], ['POST', '/api/vision/segment?model=b5-quant'], ['GET', '/api/vision/warmup'], ['POST', '/api/pipeline/analyze'], ['POST', '/api/pipeline/warmup'], ['POST', '/api/check'],
  ];
  const call = (method, p, headers = {}) => studio(p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });

  test('without an account every one is refused before the studio sees it', async () => {
    for (const [method, p] of gated) {
      const r = await call(method, p);
      assert.equal(r.status, 401, `${method} ${p}`);
      assert.deepEqual(r.json(), { error: 'Please sign in to use the Design Studio.', code: 'auth-required' });
      assert.equal(r.headers['cache-control'], 'no-store');
    }
  });

  test('a cookie that is not a session, or a planted pair, or the studio\'s own owner cookie, does not help', async () => {
    const m = await studioMember();
    const token = m.cookie.split('=')[1];
    for (const Cookie of ['terucon_owner=' + 'a'.repeat(32), 'swr_session=x; swr_admin=y', `terucon_session=${token.slice(1)}`, `terucon_session=${token}; terucon_session=${'Z'.repeat(43)}`, `terucon_session=${'Z'.repeat(43)}`]) {
      assert.equal((await call('GET', '/api/rooms', { Cookie })).status, 401, Cookie.slice(0, 50));
    }
  });

  test('an account that has not finished the form gets 403, not the studio', async () => {
    const half = await studioMember({ finish: false });
    for (const [method, p] of gated.slice(0, 5)) {
      const r = await call(method, p, half.headers);
      assert.equal(r.status, 403, p);
      assert.equal(r.json().code, 'profile-incomplete');
    }
  });

  test('the parts that are meant to be public stay public: the studio\'s start-up check, the wake-up, its admin page', async () => {
    assert.equal((await studio('/api/session')).status, 200);
    assert.equal((await studio('/api/studio/warmup', { method: 'POST', body: { from: 'landing' } })).status, 200);
    assert.match((await studio('/admin')).text, /<title>/i);
    const admin = await studio('/api/admin/status');
    assert.deepEqual([admin.status, admin.json().error], [401, 'Sign in to the admin dashboard first.'], 'the studio\'s admin keeps its own sign-in, which is not the website\'s');
  });

  test('a signed-in member reaches the studio (it answers its own way: no database in this test)', async () => {
    const m = await studioMember();
    const r = await call('GET', '/api/rooms', m.headers);
    assert.notEqual(r.status, 401);
    assert.notEqual(r.status, 403);
  });
});

describe('rooms belong to the account, not the browser', () => {
  // the shield with an in-memory room store, as in server-shield.test.js, plus an account behind each request
  const owners = new Map();
  const rooms = new Map();
  const store = {
    ready: () => true,
    ownerOf: async (id) => owners.get(id) ?? null,
    roomExists: async (id) => rooms.has(id),
    claim: async (id, owner) => (owners.has(id) ? false : (owners.set(id, owner), true)),
    release: async (id) => void owners.delete(id),
    listOwned: async (owner) => [...owners].filter(([, o]) => o === owner).map(([id]) => ({ id })),
  };
  const shield = studioShield({ store, limits: () => ({ ai: 5, vision: 5, pipeline: 5, check: 5, rooms: 50, perAddress: 5 }) , identify: (req) => req.headers['x-account'] || null });
  let server;
  let port;
  before(async () => {
    const app = express();
    app.set('trust proxy', true);
    app.use(shield);
    app.use((req, res) => {
      if (req.method === 'PUT') rooms.set(req.path.split('/')[3], true);
      res.json({ studio: true });
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  after(async () => {
    shield.close();
    await new Promise((resolve) => (server.closeAllConnections(), server.close(resolve)));
  });

  test('two people on one shared computer (the same browser cookie) never see each other\'s rooms', async () => {
    const sharedCookie = 'terucon_owner=' + 'e'.repeat(32);
    const a = 'a'.repeat(32);
    const b = 'b'.repeat(32);
    const as = (account, extra = {}) => ({ Cookie: sharedCookie, 'X-Account': account, ...extra });
    assert.equal((await request(port, { method: 'PUT', path: '/api/rooms/room-alice0001', headers: as(a), body: { name: 'A' } })).status, 200);
    assert.deepEqual((await request(port, { path: '/api/rooms', headers: as(a) })).json().rooms.map((r) => r.id), ['room-alice0001']);
    assert.deepEqual((await request(port, { path: '/api/rooms', headers: as(b) })).json().rooms, [], 'the next person at the same computer sees nothing of the first');
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const r = await request(port, { method, path: '/api/rooms/room-alice0001', headers: as(b), body: method === 'PUT' ? {} : undefined });
      assert.equal(r.status, 404, method);
    }
    assert.equal((await request(port, { path: '/api/rooms/room-alice0001', headers: as(a) })).status, 200, 'and the owner still has it, on any computer');
    assert.equal(owners.get('room-alice0001'), a, 'the account id is the owner, not the cookie');
    assert.equal((await request(port, { path: '/api/session', headers: as(a) })).headers['set-cookie'], undefined, 'no browser id is issued for an account');
  });

  test('rate limits follow the account, so clearing cookies does not reset them', async () => {
    const c = 'c'.repeat(32);
    const statuses = [];
    for (let i = 0; i < 8; i += 1) statuses.push((await request(port, { method: 'POST', path: '/api/ai/generate', headers: { 'X-Account': c, Cookie: `terucon_owner=${String(i).repeat(32).slice(0, 32)}`, 'X-Forwarded-For': `10.250.0.${i}` }, body: {} })).status);
    assert.deepEqual(statuses.filter((s) => s === 429).length, 3, 'five an hour, however many browsers and addresses it comes from');
  });
});

// ---------------------------------------------------------------------------------------------- the website's own API
describe('attacks on the sign-in itself', () => {
  let app;
  before(async () => {
    app = await startTestApp({ environ: { AUTH_ADMIN_TOKEN: 'admin-token-'.padEnd(48, 'q') } });
  });
  after(() => app.stop());

  test('brute force: a hundred parallel guesses at one code are five guesses; the right code is then dead', async () => {
    const email = 'brute@force.example';
    const started = await post(app, '/api/auth/start', { identifier: email });
    const right = app.capture.codeFor(email);
    const wrongs = Array.from({ length: 100 }, (_, i) => String(100000 + i * 7919 + (right === String(100000 + i * 7919) ? 1 : 0)).slice(0, 6));
    const answers = await Promise.all(wrongs.map((code) => post(app, '/api/auth/verify', { challengeId: started.json().challengeId, code })));
    assert.equal(answers.filter((r) => r.json().error.reason === 'wrong-code' || r.json().error.attemptsLeft === 0).length <= 5, true);
    const late = await post(app, '/api/auth/verify', { challengeId: started.json().challengeId, code: right });
    assert.equal(late.status, 400, 'the right code is no use after the guesses are spent');
    assert.equal(late.headers['set-cookie'], undefined);
  });

  test('brute force across fresh codes: the address is locked after ten wrong ones, however many codes were asked for', async () => {
    const email = 'brute2@force.example';
    await app.app.locals.terucon.auth.settings.update({ 'otp.resendCooldownSeconds': 15, 'limits.otpStartPerIdentifierPerHour': 20, 'limits.otpStartPerIpPerHour': 200 });
    let wrong = 0;
    let lockedAt = 0;
    for (let round = 0; round < 6 && !lockedAt; round += 1) {
      const s = await post(app, '/api/auth/start', { identifier: email }, { 'X-Forwarded-For': '203.0.113.200' });
      if (s.status !== 200) break;
      for (let i = 0; i < 5; i += 1) {
        const r = await post(app, '/api/auth/verify', { challengeId: s.json().challengeId, code: app.capture.codeFor(email) === '123456' ? '654321' : '123456' }, { 'X-Forwarded-For': '203.0.113.200' });
        if (r.json().error.reason === 'locked') { lockedAt = wrong; break; }
        wrong += 1;
      }
      await new Promise((r) => setTimeout(r, 15));
      await app.app.locals.terucon.auth.limits.clear('otp-cool', `login|${email}`); // skip the wait between codes: it is not what is being tested
    }
    assert.equal(wrong, 10);
    assert.ok(lockedAt >= 10 || wrong === 10);
    const again = await post(app, '/api/auth/start', { identifier: email }, { 'X-Forwarded-For': '203.0.113.200' });
    assert.equal(again.json().error.reason, 'locked');
    await app.app.locals.terucon.auth.settings.update({ 'otp.resendCooldownSeconds': null, 'limits.otpStartPerIdentifierPerHour': null, 'limits.otpStartPerIpPerHour': null });
  });

  test('two parallel sign-ins with the same right code: one session, not two', async () => {
    const email = 'twin@race.example';
    const s = await post(app, '/api/auth/start', { identifier: email });
    const code = app.capture.codeFor(email);
    const results = await Promise.all(Array.from({ length: 20 }, () => post(app, '/api/auth/verify', { challengeId: s.json().challengeId, code })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    const users = await app.app.locals.terucon.auth.db.col('users');
    assert.equal(await users.countDocuments({ emailKey: email }), 1);
  });

  test('twenty people verifying the same new address at once make one account', async () => {
    const { users } = app.app.locals.terucon.auth;
    const made = await Promise.all(Array.from({ length: 20 }, () => users.signInOrCreate('email', 'race@one.example')));
    assert.equal(new Set(made.map((m) => m.user._id)).size, 1);
    assert.equal(made.filter((m) => m.created).length, 1);
  });

  test('a code for one thing is no use for another: sign-in, confirm a contact, delete', async () => {
    const m = await app.signIn({ email: 'purposes@x.example' });
    const del = await post(app, '/api/auth/delete/start', {}, m.headers);
    const delCode = app.capture.codeFor('purposes@x.example');
    const asLogin = await post(app, '/api/auth/verify', { challengeId: del.json().challengeId, code: delCode });
    assert.equal(asLogin.status, 400);
    const asContact = await post(app, '/api/auth/contact/confirm', { challengeId: del.json().challengeId, code: delCode }, m.headers);
    assert.equal(asContact.status, 400);
    assert.equal((await app.get('/api/auth/me', { Cookie: m.cookie })).json().authenticated, true, 'nothing was deleted');
  });

  test('session fixation: a session cookie the attacker chose before sign-in is never the one the person ends up with', async () => {
    const planted = 'terucon_session=' + 'F'.repeat(43);
    const email = 'fixation@x.example';
    const s = await post(app, '/api/auth/start', { identifier: email }, { Cookie: planted });
    const r = await post(app, '/api/auth/verify', { challengeId: s.json().challengeId, code: app.capture.codeFor(email) }, { Cookie: planted });
    assert.equal(r.status, 200);
    const fresh = r.headers['set-cookie'].find((c) => c.startsWith('terucon_session=')).split(';')[0];
    assert.notEqual(fresh, planted);
    assert.equal((await app.get('/api/auth/me', { Cookie: planted })).json().authenticated, false, 'the planted value is worth nothing');
    assert.equal((await app.get('/api/auth/me', { Cookie: fresh })).json().authenticated, true);
  });

  test('cross-site requests: a page on another site cannot sign anybody in or out, or change anything', async () => {
    const m = await app.signIn();
    for (const [p, body] of [['/api/auth/logout', {}], ['/api/auth/logout-all', {}], ['/api/auth/profile', { name: 'Hacked' }], ['/api/auth/delete/start', {}], ['/api/auth/start', { identifier: 'a@x.example' }], ['/api/auth/google/nonce', {}]]) {
      const evil = await post(app, p, body, { ...m.headers, Origin: 'https://evil.example' });
      assert.equal(evil.status, 403, `${p} with a foreign Origin`);
      const fetchMeta = await post(app, p, body, { ...m.headers, 'Sec-Fetch-Site': 'cross-site' });
      assert.equal(fetchMeta.status, 403, `${p} with Sec-Fetch-Site: cross-site`);
      const sameSite = await post(app, p, body, { ...m.headers, 'Sec-Fetch-Site': 'same-site' });
      assert.equal(sameSite.status, 403, `${p}: a sibling sub-domain is not this site either`);
      const form = await app.request(p, { method: 'POST', body: 'name=Hacked', headers: { ...m.headers, 'Content-Type': 'application/x-www-form-urlencoded', ...{ 'X-Forwarded-For': nextIp() } } });
      assert.equal(form.status, 415, `${p}: an HTML form cannot post JSON`);
      const plain = await app.request(p, { method: 'POST', body: '{"name":"Hacked"}', headers: { ...m.headers, 'Content-Type': 'text/plain', 'X-Forwarded-For': nextIp() } });
      assert.equal(plain.status, 415, `${p}: text/plain is the other thing a form can send`);
    }
    assert.equal((await app.get('/api/auth/me', { Cookie: m.cookie })).json().user.name, 'Test Visitor', 'nothing changed');
    assert.equal((await post(app, '/api/auth/logout', {}, { ...m.headers, 'Sec-Fetch-Site': 'same-origin' })).status, 200, 'the page itself is let through');
  });

  test('a GET can never change anything: the state-changing routes are POST only', async () => {
    const m = await app.signIn();
    for (const p of ['/api/auth/logout', '/api/auth/logout-all', '/api/auth/delete/start', '/api/auth/delete/confirm', '/api/auth/profile', '/api/auth/verify', '/api/auth/start']) {
      const r = await app.get(p, m.headers);
      assert.equal(r.status, 405, p);
    }
    assert.equal((await app.get('/api/auth/me', { Cookie: m.cookie })).json().authenticated, true);
  });

  test('NoSQL and type confusion: objects and arrays where text belongs are refused, and nothing is looked up with them', async () => {
    await app.app.locals.terucon.auth.settings.update({ 'limits.profileChangesPerUserPerHour': 200 });
    const m = await app.signIn();
    const evil = [{ $ne: null }, { $gt: '' }, { $regex: '.*' }, { $where: 'sleep(5000)' }, ['a@x.example'], 7, true, null];
    for (const v of evil) {
      assert.equal((await post(app, '/api/auth/start', { identifier: v })).status, 400, `identifier ${JSON.stringify(v)}`);
      const verify = await post(app, '/api/auth/verify', { challengeId: v, code: v });
      assert.equal(verify.status, 400, `verify ${JSON.stringify(v)}`);
      const google = await post(app, '/api/auth/google', { credential: v });
      assert.ok([400, 401, 503].includes(google.status), `google ${JSON.stringify(v)}: ${google.status}`);
      for (const field of ['name', 'firm', 'email', 'phone']) {
        const r = await post(app, '/api/auth/profile', { [field]: v }, m.headers);
        assert.ok([200, 400].includes(r.status), `profile.${field} ${JSON.stringify(v)} -> ${r.status}`);
      }
      assert.equal((await post(app, '/api/auth/contact/start', { kind: v, value: v }, m.headers)).status, 400);
      assert.equal((await post(app, '/api/auth/delete/confirm', { challengeId: v, code: v, confirm: true }, m.headers)).status, 400);
    }
    const me = (await app.get('/api/auth/me', { Cookie: m.cookie })).json().user;
    assert.equal(me.name, 'Test Visitor', 'the profile was not overwritten with an operator object');
    assert.equal(typeof me.firm, 'string');
    await app.app.locals.terucon.auth.settings.update({ 'limits.profileChangesPerUserPerHour': null });
  });

  test('prototype pollution: __proto__ and constructor keys in any body change nothing', async () => {
    const m = await app.signIn();
    const bodies = ['{"__proto__": {"isAdmin": true, "ready": true}}', '{"constructor": {"prototype": {"isAdmin": true}}}', '{"identifier": "a@x.example", "__proto__": {"x": 1}}', '{"name": "Bob", "firm": "F", "phone": "9876543210", "__proto__": {"profileComplete": true}}'];
    for (const p of ['/api/auth/start', '/api/auth/verify', '/api/auth/profile', '/api/auth/google', '/api/auth/contact/start', '/api/auth/delete/start', '/api/auth/logout']) {
      for (const body of bodies) {
        const r = await app.request(p, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp(), ...m.headers } });
        assert.notEqual(r.status, 500, `${p} ${body.slice(0, 30)} -> ${r.status}`); // 503 is fine: Google is not set up in this app
      }
    }
    assert.equal({}.isAdmin, undefined);
    assert.equal({}.ready, undefined);
    assert.equal({}.profileComplete, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'x'), false);
  });

  test('bodies that are too big, not JSON, or lying about their length are refused without a crash', async () => {
    const m = await app.signIn();
    const big = await app.request('/api/auth/start', { method: 'POST', body: JSON.stringify({ identifier: 'a'.repeat(20_000) }), headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() } });
    assert.equal(big.status, 413);
    for (const body of ['{', '{"identifier":', 'identifier=a@x.example', '\u0000\u0001', '[[[[[[[[[[[[[[[[[[[[', '{"a":'.repeat(500)]) {
      const r = await app.request('/api/auth/start', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() } });
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 30));
    }
    const lying = await rawRequest(app.port, `POST /api/auth/start HTTP/1.1\r\nHost: localhost:${app.port}\r\nContent-Type: application/json\r\nContent-Length: 500\r\nConnection: close\r\n\r\n{"identifier":"a@x.example"}`, { settleMs: 400 });
    assert.ok(!lying.status || lying.status >= 400 || lying.raw === '', 'a body shorter than it claims is not treated as complete');
    assert.equal((await app.get('/api/auth/me', { Cookie: m.cookie })).status, 200, 'and the server is still up');
  });

  test('HTML and script in what a person types is refused at the door, so no later page can show it as markup', async () => {
    const m = await app.signIn({ finish: false });
    const sanitized = await post(app, '/api/auth/profile', { name: String.fromCharCode(0x202e) + 'Bob Das', firm: 'Zero' + String.fromCharCode(0x200b) + 'Width Ltd', phone: '9876543210' }, m.headers);
    assert.equal(sanitized.status, 200);
    assert.deepEqual([sanitized.json().user.name, sanitized.json().user.firm], ['Bob Das', 'Zero Width Ltd'], 'direction marks and zero-width characters are removed, not kept');
    const payloads = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', '<svg/onload=alert(1)>', "javascript:alert(1)", '${7*7}', '{{7*7}}', '`$(id)`', '<!--', 'a' + String.fromCharCode(0) + 'b', '=cmd|calc!A1', '@SUM(1+1)', '+1+1', '-2+3'];
    for (const payload of payloads) {
      for (const field of ['name', 'firm']) {
        const r = await post(app, '/api/auth/profile', { name: field === 'name' ? payload : 'Bob Das', firm: field === 'firm' ? payload : 'Fine Firm', phone: '9876543210' }, m.headers);
        assert.equal(r.status, 400, `${field}: ${JSON.stringify(payload)}`);
      }
    }
    const ok = await post(app, '/api/auth/profile', { name: "Anne-Marie O'Neil", firm: 'Sharma & Sons (P) Ltd.', phone: '9876543210' }, m.headers);
    assert.equal(ok.status, 200, 'ordinary punctuation is fine');
    const body = JSON.stringify(ok.json());
    assert.doesNotMatch(body, /[<>]/, 'nothing in an answer can be read as a tag');
  });

  test('spreadsheet formulas: nothing that starts with = + - @ is stored, so a CRM export cannot run one', async () => {
    const m = await app.signIn({ finish: false });
    for (const payload of ['=1+1', '+1', '-1', '@x', '\t=1', '=HYPERLINK("http://evil.example")']) {
      for (const [field, extra] of [['name', { firm: 'F' }], ['firm', { name: 'Bob' }]]) {
        const r = await post(app, '/api/auth/profile', { phone: '9876543210', ...extra, [field]: payload }, m.headers);
        assert.equal(r.status, 400, `${field}: ${JSON.stringify(payload)}`);
      }
    }
    for (const address of ['=cmd@x.example', '+a@x.example', '-a@x.example', '@a@x.example']) {
      assert.equal((await post(app, '/api/auth/start', { identifier: address })).status, 400, address);
    }
  });

  test('every answer from the sign-in API is uncacheable, and none gives away how it is built', async () => {
    const m = await app.signIn();
    const probes = [['GET', '/api/auth/config'], ['GET', '/api/auth/me'], ['POST', '/api/auth/start', { identifier: 'a@x.example' }], ['POST', '/api/auth/start', { identifier: 'x' }], ['GET', '/api/auth/nope'], ['GET', '/api/auth/me?x=' + 'a'.repeat(100)], ['POST', '/api/auth/profile', {}], ['PUT', '/api/auth/admin/settings', {}]];
    for (const [method, p, body] of probes) {
      const r = await app.request(p, { method, body, headers: { ...m.headers, 'X-Forwarded-For': nextIp() } });
      assert.equal(r.headers['cache-control'], 'no-store', `${method} ${p}`);
      assert.equal(r.headers['x-powered-by'], undefined);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.doesNotMatch(r.text, /node_modules|at \w+ \(|\.js:\d+|Error:|mongoose|stack/i, `${method} ${p}: no internals`);
    }
  });

  test('what the public may read says nothing secret: /api/health, /api/site, /api/auth/config', async () => {
    const everything = [await app.get('/api/health'), await app.get('/api/site'), await app.get('/api/auth/config')].map((r) => r.text).join('\n');
    for (const secret of [SECRET, 'admin-token-', 'smtp', 'refresh', 'client_secret', 'AUTH_SECRET']) assert.equal(everything.includes(secret), false, secret);
    assert.equal((await app.get('/api/health')).json().auth.reasons.every((r) => ['no-secret', 'no-channel', 'no-database'].includes(r)), true);
  });

  test('spoofed X-Forwarded-For: when no proxy is trusted, rotating it does not dodge a limit', async () => {
    const strict = await startTestApp({ environ: { TRUST_PROXY: '0' } });
    try {
      let refused = 0;
      for (let i = 0; i < 20; i += 1) {
        const r = await strict.request('/api/auth/start', { method: 'POST', body: { identifier: `spoof${i}@x.example` }, headers: { 'X-Forwarded-For': `${i + 1}.${i + 2}.${i + 3}.${i + 4}` } });
        if (r.status === 429) refused += 1;
      }
      assert.equal(refused, 5, 'fifteen codes an hour from the one real address, however many addresses were claimed');
    } finally {
      await strict.stop();
    }
  });

  test('one mailbox, many spellings: the same limits apply to all of them', async () => {
    const spellings = ['Victim@Mail.Example', ' victim@mail.example', 'victim+1@mail.example', 'victim+promo@MAIL.example', 'VICTIM@mail.example '];
    const results = [];
    for (const s of spellings) results.push((await post(app, '/api/auth/start', { identifier: s })).status);
    assert.deepEqual(results, [200, 429, 429, 429, 429], 'the first sends; the rest are the same mailbox within the wait');
    assert.equal(app.capture.sent.filter((m) => m.to.endsWith('@mail.example')).length, 1);
  });

  test('SMS pumping: a text to another country, to a number in a premium range, or past the daily ceiling is refused before anything is sent', async () => {
    const before = app.capture.sent.filter((m) => m.channel === 'sms').length;
    for (const number of ['+44 7911 123456', '+1 900 555 0100', '+882 1234 5678', '+675 7000 0000', '+91 1800 123 4567', '+91 5987654321']) {
      const r = await post(app, '/api/auth/start', { identifier: number });
      assert.ok([400].includes(r.status), `${number} -> ${r.status}`);
    }
    assert.equal(app.capture.sent.filter((m) => m.channel === 'sms').length, before, 'not one text message was sent');
    const auth = app.app.locals.terucon.auth;
    const usedToday = (await auth.limits.count('cap', 'sms', 24 * 60 * 60 * 1000)).used; // the earlier tests sent some
    await auth.settings.update({ 'limits.smsPerDay': usedToday + 2, 'limits.otpStartPerIpPerHour': 200 });
    try {
      const statuses = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await post(app, '/api/auth/start', { identifier: `98765000${10 + i}` })).status);
      assert.deepEqual(statuses, [200, 200, 503, 503, 503], 'the site-wide daily ceiling holds');
    } finally {
      await auth.settings.update({ 'limits.smsPerDay': null, 'limits.otpStartPerIpPerHour': null });
    }
  });

  test('pre-account takeover: typing a victim\'s address into your own sign-up gives you nothing of theirs', async () => {
    // she signs up by phone (proving a number that is hers) and types the victim's address as her e-mail
    const begun = await post(app, '/api/auth/start', { identifier: '9876500099' });
    const proved = await post(app, '/api/auth/verify', { challengeId: begun.json().challengeId, code: app.capture.codeFor('+919876500099') });
    const attacker = { cookie: proved.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ') };
    attacker.headers = { Cookie: attacker.cookie };
    const typed = await post(app, '/api/auth/profile', { name: 'Mallory Kumar', firm: 'Evil Ltd', email: 'victim@bank.example' }, attacker.headers);
    assert.equal(typed.status, 200);
    assert.deepEqual([typed.json().user.email, typed.json().user.emailVerified], ['victim@bank.example', false], 'it is only something she typed: unconfirmed, and not a way to sign in');
    assert.equal(typed.json().user.profileComplete, false, 'and her sign-up is not finished while the address is unconfirmed: she cannot get in with somebody else\'s address on it');
    assert.ok(typed.json().user.needs.includes('email-confirm'));
    assert.equal((await app.get('/materials', attacker.headers)).status, 302, 'the members\' pages stay shut to her');
    assert.equal((await app.get('/api/rooms', attacker.headers)).status, 404, 'and the studio\'s API is not hers either');
    const asHerEmail = await post(app, '/api/auth/start', { identifier: 'victim@bank.example' });
    assert.equal(asHerEmail.status, 200);
    // the victim arrives and signs in with their own address (the code that was just sent goes to them, not to her)
    const v = await post(app, '/api/auth/verify', { challengeId: asHerEmail.json().challengeId, code: app.capture.codeFor('victim@bank.example') });
    assert.equal(v.json().created, true, 'a new, empty account of their own');
    assert.equal(v.json().user.name, '', 'not Mallory\'s details');
    const victimCookie = v.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
    assert.notEqual(victimCookie, attacker.cookie);
    const mallory = (await app.get('/api/auth/me', { Cookie: attacker.cookie })).json().user;
    assert.equal(mallory.email, '', 'her claim to the victim\'s address is gone');
    // and she cannot confirm it either: the code goes to the victim
    const confirm = await post(app, '/api/auth/contact/start', { kind: 'email', value: 'victim@bank.example' }, attacker.headers);
    assert.equal(confirm.status, 200, 'she is let ask, the answer is the same for everybody');
    const guessed = await post(app, '/api/auth/contact/confirm', { challengeId: confirm.json().challengeId, code: '123456' }, attacker.headers);
    assert.equal(guessed.status, 400);
  });

  test('account enumeration: the sign-in form, the code check and the profile say nothing about who is registered before the code is proved', async () => {
    const known = 'known@enum.example';
    await app.signIn({ email: known });
    const ask = async (address) => post(app, '/api/auth/start', { identifier: address }, { 'X-Forwarded-For': '192.0.2.99' });
    await app.app.locals.terucon.auth.settings.update({ 'otp.resendCooldownSeconds': 15, 'limits.otpStartPerIpPerHour': 200 });
    await app.app.locals.terucon.auth.limits.clear('otp-cool', `login|${known}`);
    const a = await ask(known);
    const b = await ask('unknown@enum.example');
    assert.equal(a.status, b.status);
    assert.deepEqual(Object.keys(a.json()).sort(), Object.keys(b.json()).sort());
    // a wrong code looks the same for both
    const wa = await post(app, '/api/auth/verify', { challengeId: a.json().challengeId, code: '000000' === app.capture.codeFor(known) ? '111111' : '000000' });
    const wb = await post(app, '/api/auth/verify', { challengeId: b.json().challengeId, code: '000000' === app.capture.codeFor('unknown@enum.example') ? '111111' : '000000' });
    assert.deepEqual([wa.status, wa.json().error.reason], [wb.status, wb.json().error.reason]);
    // adding a contact that belongs to someone else is answered exactly as adding a free one
    const me = await app.signIn();
    const taken = await post(app, '/api/auth/contact/start', { kind: 'email', value: known }, me.headers);
    const free = await post(app, '/api/auth/contact/start', { kind: 'email', value: 'brand-new@enum.example' }, me.headers);
    assert.equal(taken.status, free.status);
    assert.deepEqual(Object.keys(taken.json()).sort(), Object.keys(free.json()).sort());
    const typed = await post(app, '/api/auth/profile', { phone: '9876511111', email: known }, (await app.signIn({ finish: false })).headers);
    assert.equal(typed.status, 200, 'typing a registered address into the sign-up form is accepted without comment');
    await app.app.locals.terucon.auth.settings.update({ 'otp.resendCooldownSeconds': null, 'limits.otpStartPerIpPerHour': null });
  });

  test('stealing a session is not enough to delete the account or take it over: deleting needs a fresh code to the confirmed address', async () => {
    const m = await app.signIn({ email: 'stolen@x.example' });
    const stolen = { Cookie: m.cookie };
    assert.equal((await post(app, '/api/auth/delete/confirm', { challengeId: '0'.repeat(32), code: '123456', confirm: true }, stolen)).status, 400);
    const start = await post(app, '/api/auth/delete/start', {}, stolen);
    assert.equal(start.json().to, 's•••••@x.example', 'the code goes to the owner\'s address, which the thief cannot read');
    assert.equal((await post(app, '/api/auth/delete/confirm', { challengeId: start.json().challengeId, code: '000000', confirm: true }, stolen)).status, 400);
    assert.equal((await app.get('/api/auth/me', { Cookie: m.cookie })).json().authenticated, true);
  });

  test('an old session cannot be revived: after deletion the same cookie is nothing, and the address can start again as a stranger', async () => {
    const m = await app.signIn({ email: 'phoenix@x.example' });
    const s = await post(app, '/api/auth/delete/start', {}, m.headers);
    await post(app, '/api/auth/delete/confirm', { challengeId: s.json().challengeId, code: app.capture.codeFor('phoenix@x.example'), confirm: true }, m.headers);
    assert.equal((await app.get('/api/auth/me', { Cookie: m.cookie })).json().authenticated, false);
    assert.equal((await app.get('/materials', { Cookie: m.cookie })).status, 302);
    await app.app.locals.terucon.auth.limits.clear('otp-cool', 'login|phoenix@x.example');
    const again = await post(app, '/api/auth/start', { identifier: 'phoenix@x.example' });
    const v = await post(app, '/api/auth/verify', { challengeId: again.json().challengeId, code: app.capture.codeFor('phoenix@x.example') });
    assert.equal(v.json().created, true);
    assert.equal(v.json().user.name, '', 'none of the old details came back');
  });

  test('the admin API: no token, no door; a session cookie of a member is not an admin token', async () => {
    const m = await app.signIn();
    for (const headers of [m.headers, { Authorization: `Bearer ${m.cookie.split('=')[1]}` }, { Authorization: 'Bearer ' }, {}]) {
      const r = await app.get('/api/auth/admin/settings', { ...headers, 'X-Forwarded-For': nextIp() });
      assert.equal(r.status, 401);
    }
  });

  test('the Host header cannot be used to make the server point somewhere else: nothing in an e-mail, a redirect or a cookie uses it', async () => {
    const email = 'host@x.example';
    const r = await app.request('/api/auth/start', { method: 'POST', body: { identifier: email }, headers: { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-For': nextIp() } });
    assert.equal(r.status, 421, 'a Host that is not this server\'s is refused outright');
    assert.equal(app.capture.sent.some((m) => m.to === email), false);
    const ok = await post(app, '/api/auth/start', { identifier: email }, { 'X-Forwarded-Host': 'evil.example' });
    assert.equal(ok.status, 200);
    assert.doesNotMatch(JSON.stringify(app.capture.sent.at(-1)), /evil\.example/, 'the code message carries no link, and no host');
    const redirect = await app.get('/materials', { 'X-Forwarded-Host': 'evil.example', Host: `localhost:${app.port}` });
    assert.equal(redirect.headers.location.startsWith('/login'), true, 'redirects are relative');
  });

  test('clickjacking: the sign-in and account pages cannot be put in another site\'s frame', async () => {
    const m = await app.signIn();
    for (const [p, headers] of [['/login', {}], ['/account', m.headers]]) {
      const r = await app.get(p, headers);
      assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
      assert.match(r.headers['content-security-policy'], /frame-ancestors 'self'/);
    }
  });

  test('HTTPS: HSTS is sent on a secure request, the cookie is __Host- and Secure, and the plain-HTTP cookie name is not accepted there', async () => {
    const secure = { 'X-Forwarded-Proto': 'https' };
    const r = await app.get('/login', secure);
    assert.match(r.headers['strict-transport-security'], /max-age=\d+/);
    const email = 'https@x.example';
    const s = await post(app, '/api/auth/start', { identifier: email }, secure);
    const v = await post(app, '/api/auth/verify', { challengeId: s.json().challengeId, code: app.capture.codeFor(email) }, secure);
    const line = v.headers['set-cookie'].find((c) => c.includes('terucon_session='));
    assert.match(line, /^__Host-terucon_session=/);
    assert.match(line, /; Secure/);
    const token = line.split(';')[0].split('=')[1];
    assert.equal((await app.get('/api/auth/me', { ...secure, Cookie: `__Host-terucon_session=${token}` })).json().authenticated, true);
    assert.equal((await app.get('/api/auth/me', { ...secure, Cookie: `terucon_session=${token}` })).json().authenticated, false, 'on HTTPS a cookie without the __Host- prefix is one somebody planted');
  });
});

// --------------------------------------------------------------------------------------------- the source itself
describe('the source of the sign-in', () => {
  const files = () => {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|html|json)$/.test(entry.name)) out.push(full);
      }
    };
    walk(path.join(PROJECT_ROOT, 'server', 'auth'));
    for (const f of ['server/routes/auth.js', 'server/routes/authAdmin.js', 'server/lib/csp.js', 'server/middleware/canonical.js', 'pages/login.html', 'pages/account.html', 'site/patches/snippets/auth.js']) out.push(path.join(PROJECT_ROOT, f));
    return out;
  };

  test('no hidden or direction-changing characters in the code that guards the site ("Trojan Source")', () => {
    for (const file of files()) {
      const text = fs.readFileSync(file, 'utf8');
      const bad = [...text].filter((c) => /[\p{Cf}\p{Zl}\p{Zp}]/u.test(c) || c === String.fromCharCode(0)); // format (zero-width, direction marks, soft hyphen, BOM), line/paragraph separators, NUL
      assert.deepEqual(bad.map((c) => c.codePointAt(0).toString(16)), [], path.relative(PROJECT_ROOT, file));
    }
  });

  test('no secret is written into the code, and nothing here reads one from a request', () => {
    for (const file of files().filter((f) => f.endsWith('.js'))) {
      const text = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|sk_live_|xox[baprs]-|ghp_[A-Za-z0-9]{20}/, path.relative(PROJECT_ROOT, file));
      assert.doesNotMatch(text, /Math\.random\(\)/, `${path.relative(PROJECT_ROOT, file)}: security values come from node:crypto, never Math.random`);
      assert.doesNotMatch(text, /\beval\(|new Function\(|child_process/, path.relative(PROJECT_ROOT, file));
    }
  });

  test('every comparison of a secret is constant time, and codes and tokens come from the random generator', () => {
    const otp = fs.readFileSync(path.join(PROJECT_ROOT, 'server/auth/otp.js'), 'utf8');
    assert.match(otp, /safeEqual\(counted\.codeHash/);
    assert.doesNotMatch(otp, /codeHash\s*===|===\s*counted\.codeHash/);
    const crypto_ = fs.readFileSync(path.join(PROJECT_ROOT, 'server/auth/crypto.js'), 'utf8');
    assert.match(crypto_, /crypto\.randomInt/);
    assert.match(crypto_, /crypto\.randomBytes/);
    assert.match(crypto_, /timingSafeEqual/);
    void crypto;
  });
});
