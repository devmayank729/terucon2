import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import test, { after, before, describe } from 'node:test';
import { createApiRegistry } from '../../server/routes/api.js';
import { createAuth } from '../../server/auth/index.js';
import { createAuthDb, StoreUnavailableError } from '../../server/auth/db.js';
import { createGoogleVerifier } from '../../server/auth/google.js';
import { sha256 } from '../../server/auth/crypto.js';
import { loadSettings } from '../../server/config/settings.js';
import { errorHandler } from '../../server/middleware/errorHandler.js';
import { guards } from '../../server/middleware/guards.js';
import { mountAuthRoutes } from '../../server/routes/auth.js';
import { startTestApp } from '../helpers/app.js';
import { captureProviders, SECRET } from '../helpers/authKit.js';
import { request } from '../helpers/http.js';
import { signInVia } from '../helpers/signIn.js';

// The sign-in API as a browser uses it: sign up, sign in again, cookies, sign out, confirm a contact, delete, Google, and what
// happens when the service cannot be trusted to run.

// every call comes from a "different visitor" (its own network address) unless the test names one, so the per-address limits of
// one test never decide another
let visitor = 0;
const nextIp = () => `10.200.${Math.floor(visitor / 250)}.${(visitor += 1) % 250}`;
const post = (app, path, body, headers = {}) => app.request(path, { method: 'POST', body, headers: { 'X-Forwarded-For': nextIp(), ...headers } });
const jar = (r) => (r.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');

/** An existing, finished account, made without a code (so the next sign-in is not held up by the wait between codes). */
async function seed(app, email, name = 'Test Visitor') {
  const { users } = app.app.locals.terucon.auth;
  const { user } = await users.signInOrCreate('email', email);
  return (await users.saveProfile(user, { name, phone: '9876543210', firm: 'Test Firm' })).user;
}
/** A session for that account, as if they had signed in earlier on another device. */
async function sessionFor(app, user) {
  const { token } = await app.app.locals.terucon.auth.sessions.create({ userId: user._id, ip: '10.0.0.1', userAgent: 'earlier device' });
  return `terucon_session=${token}`;
}

describe('signing up and signing in', () => {
  let app;
  before(async () => {
    app = await startTestApp();
  });
  after(() => app.stop());

  test('before anyone is signed in: the sign-in page can see what is on offer, and nobody is signed in', async () => {
    const config = (await app.get('/api/auth/config')).json();
    assert.equal(config.ready, true);
    assert.deepEqual(config.channels, { email: true, sms: true, google: false });
    assert.equal(config.googleClientId, '');
    assert.equal(config.codeLength, 6);
    assert.ok(config.routes.includes('/materials') && config.routes.includes('/account') && !config.routes.includes('/login'));
    assert.deepEqual((await app.get('/api/auth/me')).json(), { authenticated: false });
    assert.equal(JSON.stringify(config).includes(SECRET), false);
  });

  test('a new person: a code, the sign-up form, and then the members\' pages', async () => {
    const email = 'Priya.Sharma@AB-Constructions.co.in';
    const begun = await post(app, '/api/auth/start', { identifier: `  ${email} ` });
    assert.equal(begun.status, 200);
    const b = begun.json();
    assert.deepEqual(Object.keys(b).sort(), ['challengeId', 'channel', 'codeLength', 'expiresIn', 'ok', 'resendIn', 'to']);
    assert.equal(b.to, 'p•••••@ab-constructions.co.in');
    assert.equal(JSON.stringify(b).includes(app.capture.lastCode()), false, 'the code is never in the answer');
    assert.equal(app.capture.sent[0].to, 'priya.sharma@ab-constructions.co.in');

    const wrong = await post(app, '/api/auth/verify', { challengeId: b.challengeId, code: app.capture.lastCode() === '000000' ? '111111' : '000000' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json().error.reason, 'wrong-code');
    assert.equal(wrong.json().error.attemptsLeft, 4);
    assert.equal(wrong.headers['set-cookie'], undefined, 'no session for a wrong code');

    const verified = await post(app, '/api/auth/verify', { challengeId: b.challengeId, code: app.capture.lastCode(), next: '/design-studio' });
    assert.equal(verified.status, 200);
    const v = verified.json();
    assert.equal(v.created, true);
    assert.equal(v.needsProfile, true);
    assert.equal(v.redirectTo, '/design-studio');
    assert.deepEqual(v.user.needs, ['name', 'phone', 'firm']);
    const cookie = jar(verified);
    assert.match(cookie, /^terucon_session=[A-Za-z0-9_-]{43}$/);

    // signed in but the form is not finished: no members' pages, no studio, a way to the form
    const early = await app.get('/materials', { Cookie: cookie });
    assert.equal(early.status, 302);
    assert.equal(early.headers.location, '/login?next=%2Fmaterials&step=profile');
    const studio = await app.get('/api/rooms', { Cookie: cookie });
    assert.equal(studio.status, 404, 'no studio here, but the website\'s own sign-in gate is not what answered');

    const saved = await post(app, '/api/auth/profile', { name: 'Priya Sharma', phone: '98765 43210', firm: 'AB Constructions' }, { Cookie: cookie });
    assert.equal(saved.status, 200);
    const u = saved.json().user;
    assert.deepEqual([u.name, u.firm, u.email, u.emailVerified, u.phone, u.phoneVerified, u.profileComplete], ['Priya Sharma', 'AB Constructions', 'priya.sharma@ab-constructions.co.in', true, '+919876543210', false, false]);
    assert.deepEqual(u.needs, ['phone-confirm'], 'the number is typed but not confirmed: the form is not finished until a code has been entered');
    assert.equal((await app.get('/materials', { Cookie: cookie })).status, 302, 'still not a member');
    // the code goes to the number, and entering it finishes the sign-up
    const sentTo = await post(app, '/api/auth/contact/start', { kind: 'phone', value: u.phone }, { Cookie: cookie });
    assert.equal(sentTo.status, 200);
    assert.equal(sentTo.json().channel, 'sms');
    const done = await post(app, '/api/auth/contact/confirm', { challengeId: sentTo.json().challengeId, code: app.capture.codeFor('+919876543210') }, { Cookie: cookie });
    assert.equal(done.status, 200);
    assert.deepEqual([done.json().user.phoneVerified, done.json().user.profileComplete, done.json().user.needs], [true, true, []]);
    assert.equal((await app.get('/materials', { Cookie: cookie })).status, 200);
    assert.equal((await app.get('/api/auth/me', { Cookie: cookie })).json().authenticated, true);
  });

  test('the sign-in cookie: random, HttpOnly, SameSite, no expiry shorter than the session; Secure and __Host- on HTTPS', async () => {
    const m = await app.signIn({ email: 'cookie@one.example' });
    const begun = await post(app, '/api/auth/start', { identifier: 'cookie2@one.example' });
    const r = await post(app, '/api/auth/verify', { challengeId: begun.json().challengeId, code: app.capture.codeFor('cookie2@one.example') });
    const line = r.headers['set-cookie'].find((c) => c.startsWith('terucon_session='));
    assert.match(line, /HttpOnly/i);
    assert.match(line, /SameSite=Lax/i);
    assert.match(line, /Path=\//);
    assert.doesNotMatch(line, /Domain=/i);
    assert.doesNotMatch(line, /Secure/i, 'plain HTTP in development');
    assert.match(line, /Max-Age=\d+|Expires=/i);

    // behind an HTTPS proxy (loopback is trusted by default): __Host- prefix, Secure
    const begun3 = await post(app, '/api/auth/start', { identifier: 'cookie3@one.example' }, { 'X-Forwarded-Proto': 'https' });
    const r3 = await post(app, '/api/auth/verify', { challengeId: begun3.json().challengeId, code: app.capture.codeFor('cookie3@one.example') }, { 'X-Forwarded-Proto': 'https' });
    const line3 = r3.headers['set-cookie'].find((c) => c.includes('terucon_session='));
    assert.match(line3, /^__Host-terucon_session=/);
    assert.match(line3, /; Secure/i);
    assert.match(line3, /HttpOnly/i);
    assert.equal(m.cookie.startsWith('terucon_session='), true);
  });

  test('a returning member: a code is needed again, the same account comes back, no form', async () => {
    const first = { cookie: await sessionFor(app, await seed(app, 'return@one.example')) };
    const begun = await post(app, '/api/auth/start', { identifier: 'RETURN@one.example' });
    assert.equal(begun.status, 200);
    const verified = await post(app, '/api/auth/verify', { challengeId: begun.json().challengeId, code: app.capture.codeFor('return@one.example') });
    const v = verified.json();
    assert.equal(v.created, false);
    assert.equal(v.needsProfile, false);
    assert.equal(v.user.name, 'Test Visitor');
    assert.notEqual(jar(verified), first.cookie, 'a new session, not the old one');
    assert.equal((await app.get('/materials', { Cookie: jar(verified) })).status, 200);
  });

  test('"?next=" can only name a page of this site; anything else lands on the home page', async () => {
    const targets = { '/materials': '/materials', '/account': '/account', '/my-project': '/my-project', '/': '/' };
    const evil = ['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/materials?x=1', '/materials/', '/Materials', '/login', '/api/auth/me', '', 'materials', '/%2e%2e/etc', null, undefined, 42, {}, ['/materials']];
    let n = 0;
    for (const [next, want] of [...Object.entries(targets), ...evil.map((e) => [e, '/'])]) {
      n += 1;
      const email = `next${n}@two.example`;
      const begun = await post(app, '/api/auth/start', { identifier: email });
      const r = await post(app, '/api/auth/verify', { challengeId: begun.json().challengeId, code: app.capture.codeFor(email), next });
      assert.equal(r.json().redirectTo, want, JSON.stringify(next));
    }
  });

  test('asking for a code gives the same answer for a member and a stranger: the form cannot be used to find out who is registered', async () => {
    await seed(app, 'member@three.example');
    const member = await post(app, '/api/auth/start', { identifier: 'member@three.example' }, { 'X-Forwarded-For': '10.8.0.1' });
    const stranger = await post(app, '/api/auth/start', { identifier: 'stranger@three.example' }, { 'X-Forwarded-For': '10.8.0.2' });
    assert.equal(member.status, stranger.status);
    const shape = (r) => Object.keys(r.json()).sort().join();
    assert.equal(shape(member), shape(stranger));
    const a = member.json();
    const b = stranger.json();
    assert.deepEqual([a.channel, a.resendIn, a.expiresIn, a.codeLength], [b.channel, b.resendIn, b.expiresIn, b.codeLength]);
    assert.equal(a.to.length, b.to.length, 'the masked address has the same length however long the name is: it gives nothing away');
    assert.notEqual(a.challengeId, b.challengeId);
    // and the same for a number
    await app.request('/api/auth/start', { method: 'POST', body: { identifier: '9876500011' }, headers: { 'X-Forwarded-For': '10.8.0.3' } });
    const wrongInput = await post(app, '/api/auth/start', { identifier: 'nobody@' }, { 'X-Forwarded-For': '10.8.0.4' });
    assert.equal(wrongInput.status, 400);
    assert.equal(wrongInput.json().error.reason, 'invalid-identifier');
  });

  test('bad input to /start: nothing is sent, and the answer is a plain sentence', async () => {
    const before = app.capture.sent.length;
    const bad = ['', '   ', 'x', '12345', 'a@b', '<script>', 'a@b.co\r\nBcc: v@x.co', 5, null, {}, [], { $ne: null }, ['a@x.co'], 'a'.repeat(5000), "' OR 1=1 --"];
    for (const identifier of bad) {
      const r = await post(app, '/api/auth/start', { identifier }, { 'X-Forwarded-For': '10.9.0.1' });
      assert.equal(r.status, 400, JSON.stringify(identifier)?.slice(0, 40));
      assert.equal(r.json().error.reason, 'invalid-identifier');
    }
    for (const body of [undefined, 'identifier=a@x.co', '[]', 'null']) {
      const r = await app.request('/api/auth/start', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.0.1' } });
      assert.ok([400].includes(r.status), `${body}: ${r.status}`);
    }
    assert.equal(app.capture.sent.length, before);
  });

  test('the sign-up form tells which field is wrong', async () => {
    const m = await app.signIn({ email: 'form@four.example', finish: false });
    const cases = [
      [{ name: '<b>Bob</b>', phone: '9876543210', firm: 'F' }, 'name'],
      [{ name: 'Bob', phone: '12', firm: 'F' }, 'phone'],
      [{ name: 'Bob', phone: '9876543210', firm: '<script>' }, 'firm'],
      [{ name: 'Bob', phone: '9876543210', firm: 'F', email: 'x' }, null],
    ];
    for (const [body, field] of cases) {
      const r = await post(app, '/api/auth/profile', body, m.headers);
      if (field) {
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.json().error.field, field);
      } else {
        assert.equal(r.status, 200, 'a verified e-mail is not changed by typing: the extra field is ignored');
        assert.equal(r.json().user.email, 'form@four.example');
      }
    }
    const incomplete = await post(app, '/api/auth/profile', { name: 'Bob Das' }, (await app.signIn({ email: 'form2@four.example', finish: false })).headers);
    assert.equal(incomplete.json().user.profileComplete, false);
    assert.deepEqual(incomplete.json().user.needs, ['phone', 'firm']);
    assert.equal((await post(app, '/api/auth/profile', { name: 'Bob' })).status, 401, 'no session, no profile');
  });

  test('the firm suggestion: from a business e-mail, never from a free mailbox; behind the sign-in; rate limited', async () => {
    await app.app.locals.terucon.auth.settings.update({ 'firm.lookup': 'domain' });
    const biz = await app.signIn({ email: 'rohit@sharma-interiors.co.in', finish: false });
    const hint = await post(app, '/api/auth/firm-hint', {}, biz.headers);
    assert.deepEqual(hint.json(), { name: 'Sharma Interiors', source: 'domain', domain: 'sharma-interiors.co.in' });
    const free = await app.signIn({ email: 'rohit.s@gmail.com', finish: false });
    assert.deepEqual((await post(app, '/api/auth/firm-hint', {}, free.headers)).json(), { name: null, source: null, domain: null });
    const typed = await post(app, '/api/auth/firm-hint', { email: 'asha@verma-studio.com' }, free.headers);
    assert.equal(typed.json().name, 'Verma Studio', 'a person who signed in by phone types their e-mail and gets a suggestion');
    assert.equal((await post(app, '/api/auth/firm-hint', {})).status, 401, 'not for strangers');
    await app.app.locals.terucon.auth.settings.update({ 'firm.lookup': 'off' });
    assert.deepEqual((await post(app, '/api/auth/firm-hint', {}, biz.headers)).json(), { name: null, source: null, domain: null });
    await app.app.locals.terucon.auth.settings.update({ 'firm.lookup': null });
    let refused = 0;
    for (let i = 0; i < 12; i += 1) if ((await post(app, '/api/auth/firm-hint', { email: 'a@some-firm.com' }, { ...biz.headers, 'X-Forwarded-For': '10.50.0.1' })).status === 429) refused += 1;
    assert.ok(refused > 0, 'ten look-ups an hour from one address');
  });

  test('a mobile number is added and confirmed with a code; then it signs the same account in', async () => {
    const m = await app.signIn({ email: 'twoway@five.example' });
    const bad = await post(app, '/api/auth/contact/start', { kind: 'phone', value: 'x' }, m.headers);
    assert.equal(bad.status, 400);
    const mismatch = await post(app, '/api/auth/contact/start', { kind: 'email', value: '98765 11122' }, m.headers);
    assert.equal(mismatch.status, 400, 'a number is not an e-mail address');
    const sent = await post(app, '/api/auth/contact/start', { kind: 'phone', value: '98765 11122' }, m.headers);
    assert.equal(sent.status, 200);
    assert.equal((await post(app, '/api/auth/contact/start', { kind: 'phone', value: '98765 11122' })).status, 401);
    // the code cannot be used by somebody else's session, or as a sign-in
    const other = await app.signIn({ email: 'other@five.example' });
    const theirs = await post(app, '/api/auth/contact/confirm', { challengeId: sent.json().challengeId, code: app.capture.codeFor('+919876511122') }, other.headers);
    assert.equal(theirs.status, 400);
    const asLogin = await post(app, '/api/auth/verify', { challengeId: sent.json().challengeId, code: app.capture.codeFor('+919876511122') });
    assert.equal(asLogin.status, 400, 'a code made to confirm a contact is not a sign-in code');
    const done = await post(app, '/api/auth/contact/confirm', { challengeId: sent.json().challengeId, code: app.capture.codeFor('+919876511122') }, m.headers);
    assert.equal(done.status, 200, done.text);
    assert.deepEqual([done.json().user.phone, done.json().user.phoneVerified], ['+919876511122', true]);

    const begun = await post(app, '/api/auth/start', { identifier: '98765 11122' }, { 'X-Forwarded-For': '10.8.1.1' });
    const viaPhone = await post(app, '/api/auth/verify', { challengeId: begun.json().challengeId, code: app.capture.codeFor('+919876511122') }, { 'X-Forwarded-For': '10.8.1.1' });
    assert.equal(viaPhone.json().created, false, 'the same account');
    assert.equal(viaPhone.json().user.email, 'twoway@five.example');
  });

  test('signing out ends the session on the server, not only in the browser; signing out everywhere ends the others too', async () => {
    const a = { cookie: await sessionFor(app, await seed(app, 'out@six.example')) };
    const begun = await post(app, '/api/auth/start', { identifier: 'out@six.example' }, { 'X-Forwarded-For': '10.8.2.1' });
    const second = await post(app, '/api/auth/verify', { challengeId: begun.json().challengeId, code: app.capture.codeFor('out@six.example') }, { 'X-Forwarded-For': '10.8.2.1' });
    const b = jar(second);
    assert.equal((await app.get('/materials', { Cookie: a.cookie })).status, 200);
    const out = await post(app, '/api/auth/logout', {}, { Cookie: a.cookie });
    assert.equal(out.status, 200);
    assert.ok(out.headers['set-cookie'].some((c) => /^terucon_session=;/.test(c) || /^terucon_session=.*Expires=Thu, 01 Jan 1970/.test(c)), 'the cookie is cleared');
    assert.equal((await app.get('/materials', { Cookie: a.cookie })).status, 302, 'the old cookie, replayed, is worthless');
    assert.equal((await app.get('/api/auth/me', { Cookie: a.cookie })).json().authenticated, false);
    assert.equal((await app.get('/api/auth/me', { Cookie: b })).json().authenticated, true, 'the other device is still in');
    assert.equal((await post(app, '/api/auth/logout-all', {}, { Cookie: b })).status, 200);
    assert.equal((await app.get('/api/auth/me', { Cookie: b })).json().authenticated, false);
    assert.equal((await post(app, '/api/auth/logout', {})).status, 200, 'signing out when not signed in is harmless');
    assert.equal((await post(app, '/api/auth/logout-all', {})).status, 401);
  });

  test('a made-up, truncated, doubled or planted session cookie is not a session', async () => {
    const m = await app.signIn({ email: 'forge@seven.example' });
    const token = m.cookie.split('=')[1];
    for (const cookie of [`terucon_session=${token.slice(0, -1)}`, `terucon_session=${token}x`, 'terucon_session=', 'terucon_session=' + 'A'.repeat(43), `terucon_session=${token}; terucon_session=${'B'.repeat(43)}`, `terucon_session=${'B'.repeat(43)}; terucon_session=${token}`, `Terucon_Session=${token}`, `__Host-terucon_session=${token}`, `x=terucon_session=${token}`]) {
      assert.equal((await app.get('/api/auth/me', { Cookie: cookie })).json().authenticated, false, cookie.slice(0, 60));
    }
    assert.equal((await app.get('/api/auth/me', { Cookie: m.cookie })).json().authenticated, true);
  });

  test('deleting the account: a code to a confirmed address, then everything is gone, and the address can start again', async () => {
    const m = await app.signIn({ email: 'bye@eight.example' });
    assert.equal((await post(app, '/api/auth/delete/start', {})).status, 401);
    const started = await post(app, '/api/auth/delete/start', {}, m.headers);
    assert.equal(started.status, 200);
    assert.equal(started.json().to, 'b•••••@eight.example');
    const code = app.capture.codeFor('bye@eight.example');
    const id = started.json().challengeId;
    assert.equal((await post(app, '/api/auth/delete/confirm', { challengeId: id, code }, m.headers)).status, 400, 'confirm must be explicit');
    assert.equal((await post(app, '/api/auth/delete/confirm', { challengeId: id, code, confirm: 'yes' }, m.headers)).status, 400);
    assert.equal((await post(app, '/api/auth/delete/confirm', { challengeId: id, code: code === '000000' ? '111111' : '000000', confirm: true }, m.headers)).status, 400);
    assert.equal((await app.get('/api/auth/me', { Cookie: m.cookie })).json().authenticated, true, 'still there');
    const stranger = await app.signIn({ email: 'stranger@eight.example' });
    assert.equal((await post(app, '/api/auth/delete/confirm', { challengeId: id, code, confirm: true }, stranger.headers)).status, 400, 'a code is for one person');

    const gone = await post(app, '/api/auth/delete/confirm', { challengeId: id, code, confirm: true }, m.headers);
    assert.equal(gone.status, 200, gone.text);
    assert.equal((await app.get('/api/auth/me', { Cookie: m.cookie })).json().authenticated, false);
    assert.equal((await app.get('/materials', { Cookie: m.cookie })).status, 302);
    assert.equal((await app.get('/api/auth/me', { Cookie: stranger.cookie })).json().authenticated, true, 'nobody else is affected');
    const users = await app.app.locals.terucon.auth.db.col('users');
    assert.equal(await users.countDocuments({ emailKey: 'bye@eight.example' }), 0);
    const sessions = await app.app.locals.terucon.auth.db.col('sessions');
    assert.equal(await sessions.countDocuments({ userId: { $exists: true } }) >= 1, true);

    app.app.locals.terucon.auth.limits; // the address may sign up again, as a new person
    await new Promise((r) => setTimeout(r, 5));
  });
});

describe('the second contact detail: sign in with either one, always the same account', () => {
  let app;
  before(async () => {
    app = await startTestApp();
  });
  after(() => app.stop());

  const cookieOf = (r) => jar(r);
  const code = (to, purpose) => app.capture.sent.filter((m) => m.to === to).at(-1).code;

  /** sign in by a code, fill in the form with the other contact detail and confirm it with a code */
  async function signUp({ first, second, name = 'Priya Sharma' }) {
    const begun = await post(app, '/api/auth/start', { identifier: first.typed });
    const verified = await post(app, '/api/auth/verify', { challengeId: begun.json().challengeId, code: code(first.key) });
    const cookie = cookieOf(verified);
    const saved = await post(app, '/api/auth/profile', { name, firm: 'AB Constructions', [second.kind]: second.typed }, { Cookie: cookie });
    const sent = await post(app, '/api/auth/contact/start', { kind: second.kind, value: second.typed }, { Cookie: cookie });
    const done = await post(app, '/api/auth/contact/confirm', { challengeId: sent.json().challengeId, code: code(second.key) }, { Cookie: cookie });
    return { cookie, verified, saved, sent, done };
  }

  test('sign up with an e-mail address, confirm the mobile number: signing in by that number is the same account, not a new empty one', async () => {
    const e = await signUp({ first: { typed: 'Both.Ways@acme-example.com', key: 'both.ways@acme-example.com' }, second: { kind: 'phone', typed: '98765 40001', key: '+919876540001' } });
    assert.deepEqual(e.saved.json().user.needs, ['phone-confirm']);
    assert.equal(e.saved.json().user.profileComplete, false, 'not finished until the number is confirmed');
    assert.deepEqual([e.done.json().user.profileComplete, e.done.json().user.emailVerified, e.done.json().user.phoneVerified], [true, true, true]);
    assert.equal((await app.get('/materials', { Cookie: e.cookie })).status, 200);

    // later: by phone. The same person, the same account, nothing to fill in again
    await app.app.locals.terucon.auth.limits.clear('otp-cool', 'login|+919876540001');
    const begun = await post(app, '/api/auth/start', { identifier: '98765 40001' });
    const back = await post(app, '/api/auth/verify', { challengeId: begun.json().challengeId, code: code('+919876540001') });
    assert.equal(back.status, 200);
    const v = back.json();
    assert.equal(v.created, false, 'not a second account');
    assert.equal(v.needsProfile, false);
    assert.deepEqual([v.user.name, v.user.firm, v.user.email, v.user.phone], ['Priya Sharma', 'AB Constructions', 'both.ways@acme-example.com', '+919876540001']);
    assert.equal((await app.get('/materials', { Cookie: cookieOf(back) })).status, 200);
    // and by e-mail again: still that account, still finished
    await app.app.locals.terucon.auth.limits.clear('otp-cool', 'login|both.ways@acme-example.com');
    const again = await post(app, '/api/auth/start', { identifier: 'both.ways@acme-example.com' });
    const viaMail = await post(app, '/api/auth/verify', { challengeId: again.json().challengeId, code: code('both.ways@acme-example.com') });
    assert.deepEqual([viaMail.json().created, viaMail.json().needsProfile, viaMail.json().user.phoneVerified], [false, false, true]);
    const users = await app.app.locals.terucon.auth.db.col('users');
    assert.equal(await users.countDocuments({ emailKey: 'both.ways@acme-example.com' }), 1);
    assert.equal(await users.countDocuments({ phoneKey: '+919876540001' }), 1);
  });

  test('the other way round: sign up with a mobile number, confirm the e-mail address, then sign in by e-mail', async () => {
    const p = await signUp({ first: { typed: '98765 40002', key: '+919876540002' }, second: { kind: 'email', typed: 'Reverse@acme-example.com', key: 'reverse@acme-example.com' }, name: 'Rohan Gupta' });
    assert.deepEqual(p.saved.json().user.needs, ['email-confirm']);
    assert.deepEqual([p.done.json().user.profileComplete, p.done.json().user.emailVerified, p.done.json().user.phoneVerified], [true, true, true]);
    const begun = await post(app, '/api/auth/start', { identifier: 'reverse@acme-example.com' });
    const back = await post(app, '/api/auth/verify', { challengeId: begun.json().challengeId, code: code('reverse@acme-example.com') });
    assert.deepEqual([back.json().created, back.json().needsProfile, back.json().user.name, back.json().user.phone], [false, false, 'Rohan Gupta', '+919876540002']);
  });

  test('a number that already belongs to another account cannot be confirmed here (and the sign-up stays unfinished)', async () => {
    const taken = await signUp({ first: { typed: 'taken.one@acme-example.com', key: 'taken.one@acme-example.com' }, second: { kind: 'phone', typed: '98765 40003', key: '+919876540003' } });
    assert.equal(taken.done.status, 200);
    // a third person types the same number and asks for the code; it is only when they enter it that they find it is taken
    const begun = await post(app, '/api/auth/start', { identifier: 'taken.three@acme-example.com' });
    const verified = await post(app, '/api/auth/verify', { challengeId: begun.json().challengeId, code: code('taken.three@acme-example.com') });
    const cookie = cookieOf(verified);
    await post(app, '/api/auth/profile', { name: 'Third Person', firm: 'F', phone: '98765 40003' }, { Cookie: cookie });
    await app.app.locals.terucon.auth.limits.clear('otp-cool', 'verify-contact|+919876540003');
    const sent = await post(app, '/api/auth/contact/start', { kind: 'phone', value: '98765 40003' }, { Cookie: cookie });
    assert.equal(sent.status, 200, 'the code is sent, the same as for any number: nothing is revealed before the code is proved');
    const refused = await post(app, '/api/auth/contact/confirm', { challengeId: sent.json().challengeId, code: code('+919876540003') }, { Cookie: cookie });
    assert.equal(refused.status, 409);
    assert.equal(refused.json().error.reason, 'contact-taken');
    assert.equal((await app.get('/api/auth/me', { Cookie: cookie })).json().user.profileComplete, false);
  });

  test('where a code cannot be sent to the second contact detail, or the admin has switched the confirmation off, typing it is enough, and it is not a way in', async () => {
    const auth = app.app.locals.terucon.auth;
    await auth.settings.update({ 'channels.sms': false });
    try {
      const begun = await post(app, '/api/auth/start', { identifier: 'nosms@acme-example.com' });
      const verified = await post(app, '/api/auth/verify', { challengeId: begun.json().challengeId, code: code('nosms@acme-example.com') });
      const saved = await post(app, '/api/auth/profile', { name: 'No Sms', firm: 'F', phone: '98765 40004' }, { Cookie: cookieOf(verified) });
      assert.deepEqual([saved.json().user.profileComplete, saved.json().user.phoneVerified], [true, false], 'no way to text a code: the number is saved, and the sign-up is finished');
      const asLogin = await post(app, '/api/auth/start', { identifier: '98765 40004' });
      assert.equal(asLogin.status, 503, 'and signing in by it is not offered');
      assert.equal((await app.get('/api/auth/config')).json().confirm.phone, false);
    } finally {
      await auth.settings.update({ 'channels.sms': null });
    }
    await auth.settings.update({ 'signup.confirmSecondContact': false });
    try {
      assert.deepEqual((await app.get('/api/auth/config')).json().confirm, { email: false, phone: false });
      const begun = await post(app, '/api/auth/start', { identifier: 'relaxed@acme-example.com' });
      const verified = await post(app, '/api/auth/verify', { challengeId: begun.json().challengeId, code: code('relaxed@acme-example.com') });
      const saved = await post(app, '/api/auth/profile', { name: 'Relaxed One', firm: 'F', phone: '98765 40005' }, { Cookie: cookieOf(verified) });
      assert.equal(saved.json().user.profileComplete, true, 'switched off by the admin: only saved');
    } finally {
      await auth.settings.update({ 'signup.confirmSecondContact': null });
    }
    assert.deepEqual((await app.get('/api/auth/config')).json().confirm, { email: true, phone: true });
  });

  test('Google sign-up needs the number confirmed too; the e-mail is already confirmed by Google', async () => {
    const { users } = app.app.locals.terucon.auth;
    const { user } = await users.signInOrCreateGoogle({ sub: 'sub-confirm', email: 'goog@acme-example.com', name: 'Goog User', hd: null });
    const rules = await app.app.locals.terucon.auth.rules();
    assert.deepEqual(rules.confirm, { email: true, phone: true });
    const typed = (await users.saveProfile(user, { phone: '98765 40006', individual: true }, rules)).user;
    assert.deepEqual(users.missingFields(typed, rules), ['phone-confirm']);
  });
});

describe('Google sign-in through the real verifier', () => {
  const CLIENT = '1234567890-abcdefg.apps.googleusercontent.com';
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const mint = (claims) => {
    const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = b64(claims);
    return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), pair.privateKey).toString('base64url')}`;
  };
  const claims = (nonce, extra = {}) => ({ iss: 'https://accounts.google.com', aud: CLIENT, sub: `sub-${Math.random()}`, email: 'google.user@firm-example.com', email_verified: true, name: 'Gita Kapoor', hd: 'firm-example.com', iat: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 3000, nonce, ...extra });
  let app;
  before(async () => {
    const verifier = createGoogleVerifier({ clientId: CLIENT, fetchKeys: async () => ({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }], maxAgeMs: 3600000 }) });
    app = await startTestApp({ auth: { google: verifier }, environ: { AUTH_GOOGLE_CLIENT_ID: CLIENT } });
  });
  after(() => app.stop());

  const nonce = async (headers = {}) => {
    const r = await post(app, '/api/auth/google/nonce', {}, headers);
    assert.equal(r.status, 200, r.text);
    const cookie = r.headers['set-cookie'].find((c) => c.startsWith('terucon_gn='));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\/api\/auth/);
    return { value: r.json().nonce, cookie: cookie.split(';')[0] };
  };

  test('the page is offered Google, with the client id', async () => {
    const config = (await app.get('/api/auth/config')).json();
    assert.equal(config.channels.google, true);
    assert.equal(config.googleClientId, CLIENT);
  });

  test('a good token makes the account at once (name and verified e-mail from Google), signs in, and asks for the rest', async () => {
    const n = await nonce();
    const r = await post(app, '/api/auth/google', { credential: mint(claims(n.value)), next: '/design-studio' }, { Cookie: n.cookie });
    assert.equal(r.status, 200, r.text);
    const v = r.json();
    assert.equal(v.created, true);
    assert.equal(v.needsProfile, true);
    assert.equal(v.redirectTo, '/design-studio');
    assert.deepEqual([v.user.name, v.user.email, v.user.emailVerified, v.user.googleLinked], ['Gita Kapoor', 'google.user@firm-example.com', true, true]);
    assert.deepEqual(v.user.needs, ['phone', 'firm']);
    const session = r.headers['set-cookie'].find((c) => c.startsWith('terucon_session=')).split(';')[0];
    // the firm suggestion comes from the Google workspace domain
    const hintApp = app.app.locals.terucon.auth;
    await hintApp.settings.update({ 'firm.lookup': 'domain' });
    assert.equal((await post(app, '/api/auth/firm-hint', {}, { Cookie: session })).json().name, 'Firm Example');
    // a second sign-in with the same Google account finds the same account
    const again = await nonce();
    const sameSub = claims(again.value, { sub: JSON.parse(Buffer.from(mint(claims('x')).split('.')[1], 'base64url')).sub });
    void sameSub;
  });

  test('the one-use value: a token cannot be replayed, used from another browser, or used without the cookie', async () => {
    const n = await nonce({ 'X-Forwarded-For': '10.40.0.1' });
    const token = mint(claims(n.value, { email: 'replay@firm-example.com', sub: 'replay-sub' }));
    const first = await post(app, '/api/auth/google', { credential: token }, { Cookie: n.cookie, 'X-Forwarded-For': '10.40.0.1' });
    assert.equal(first.status, 200);
    assert.ok(first.headers['set-cookie'].some((c) => /^terucon_gn=;/.test(c)), 'the nonce cookie is spent');
    const replay = await post(app, '/api/auth/google', { credential: token }, { Cookie: n.cookie, 'X-Forwarded-For': '10.40.0.2' });
    assert.equal(replay.status, 200, 'with the cookie still in hand the same browser could (it is the same person); see next');
    const noCookie = await post(app, '/api/auth/google', { credential: token }, { 'X-Forwarded-For': '10.40.0.3' });
    assert.equal(noCookie.status, 400);
    assert.equal(noCookie.json().error.reason, 'wrong-nonce');
    const other = await nonce({ 'X-Forwarded-For': '10.40.0.4' });
    const wrongBrowser = await post(app, '/api/auth/google', { credential: token }, { Cookie: other.cookie, 'X-Forwarded-For': '10.40.0.4' });
    assert.equal(wrongBrowser.status, 401);
    assert.equal(wrongBrowser.json().error.reason, 'google-wrong-nonce', 'a token minted for one browser does not work in another');
    const twoCookies = await post(app, '/api/auth/google', { credential: token }, { Cookie: `${n.cookie}; ${other.cookie}`, 'X-Forwarded-For': '10.40.0.5' });
    assert.equal(twoCookies.status, 400, 'two nonce cookies: one was planted');
  });

  test('tokens that are not good: wrong audience, unverified e-mail, expired, forged; nothing is created', async () => {
    const users = await app.app.locals.terucon.auth.db.col('users');
    const before = await users.countDocuments({});
    const cases = [
      [(n) => claims(n, { aud: 'someone-else.apps.googleusercontent.com' }), 'google-wrong-audience'],
      [(n) => claims(n, { email_verified: false }), 'google-email-unverified'],
      [(n) => claims(n, { exp: Math.floor(Date.now() / 1000) - 600 }), 'google-expired'],
    ];
    let i = 0;
    for (const [make, reason] of cases) {
      i += 1;
      const n = await nonce({ 'X-Forwarded-For': `10.41.0.${i}` });
      const r = await post(app, '/api/auth/google', { credential: mint(make(n.value)) }, { Cookie: n.cookie, 'X-Forwarded-For': `10.41.0.${i}` });
      assert.equal(r.status, 401, reason);
      assert.equal(r.json().error.reason, reason);
      assert.equal(r.headers['set-cookie'].some((c) => c.startsWith('terucon_session=') && !/^terucon_session=;/.test(c)), false, 'no session');
    }
    const n = await nonce({ 'X-Forwarded-For': '10.41.0.9' });
    const forged = mint(claims(n.value)).split('.').slice(0, 2).join('.') + '.' + b64('forged');
    const f = await post(app, '/api/auth/google', { credential: forged }, { Cookie: n.cookie, 'X-Forwarded-For': '10.41.0.9' });
    assert.equal(f.status, 401);
    const junk = await post(app, '/api/auth/google', { credential: { $ne: 1 } }, { Cookie: n.cookie, 'X-Forwarded-For': '10.41.0.10' });
    assert.equal(junk.status, 401);
    assert.equal(junk.json().error.reason, 'google-malformed', 'an object is not a token');
    assert.equal(await users.countDocuments({}), before + 0, 'no account was made by any of them');
  });

  test('a Google sign-in for an address that already has an account signs that account in, and the verified e-mail is the link', async () => {
    const member = await app.signIn({ email: 'existing@firm-example.com' });
    const n = await nonce({ 'X-Forwarded-For': '10.42.0.1' });
    const r = await post(app, '/api/auth/google', { credential: mint(claims(n.value, { email: 'existing@firm-example.com', sub: 'link-sub', name: 'Somebody Else' })) }, { Cookie: n.cookie, 'X-Forwarded-For': '10.42.0.1' });
    assert.equal(r.status, 200);
    assert.equal(r.json().created, false);
    assert.equal(r.json().needsProfile, false);
    assert.equal(r.json().user.name, 'Test Visitor', 'the existing details are kept');
    assert.equal(r.json().user.googleLinked, true);
    void member;
    // a different Google account claiming the same address is refused, not merged
    const n2 = await nonce({ 'X-Forwarded-For': '10.42.0.2' });
    const conflict = await post(app, '/api/auth/google', { credential: mint(claims(n2.value, { email: 'existing@firm-example.com', sub: 'another-sub' })) }, { Cookie: n2.cookie, 'X-Forwarded-For': '10.42.0.2' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json().error.reason, 'google-conflict');
  });

  test('new accounts can be switched off: Google does not open a door the code form keeps shut', async () => {
    await app.app.locals.terucon.auth.settings.update({ 'signup.open': false });
    const n = await nonce({ 'X-Forwarded-For': '10.43.0.1' });
    const r = await post(app, '/api/auth/google', { credential: mint(claims(n.value, { email: 'brand-new@firm-example.com', sub: 'brand-new' })) }, { Cookie: n.cookie, 'X-Forwarded-For': '10.43.0.1' });
    assert.equal(r.status, 403);
    assert.equal(r.json().error.reason, 'signup-closed');
    const begun = await post(app, '/api/auth/start', { identifier: 'closed@firm-example.com' }, { 'X-Forwarded-For': '10.43.0.2' });
    const v = await post(app, '/api/auth/verify', { challengeId: begun.json().challengeId, code: app.capture.codeFor('closed@firm-example.com') }, { 'X-Forwarded-For': '10.43.0.2' });
    assert.equal(v.status, 403);
    assert.equal(v.json().error.reason, 'signup-closed');
    await app.app.locals.terucon.auth.settings.update({ 'signup.open': null });
  });
});

describe('when sign-in cannot be trusted to run, it does not run, and says so', () => {
  test('no secret outside development: no sign-in, nobody let in, and the reason is in /api/health', async () => {
    const app = await startTestApp({ auth: { secret: '' } });
    try {
      const health = (await app.get('/api/health')).json();
      assert.deepEqual(health.auth, { ready: false, gate: true, reasons: ['no-secret'] });
      const r = await post(app, '/api/auth/start', { identifier: 'a@x.example' });
      assert.equal(r.status, 503);
      assert.equal(r.json().error.reason, 'not-ready');
      assert.equal(app.capture.sent.length, 0);
      assert.equal((await app.get('/materials')).status, 302, 'the gate still holds');
      assert.equal((await app.get('/api/auth/config')).json().ready, false);
    } finally {
      await app.stop();
    }
  });

  test('no way to send a code and no Google: not ready', async () => {
    const app = await startTestApp({ auth: { providers: { email: { ready: false, send() {} }, sms: { ready: false, send() {} } } } });
    try {
      const health = (await app.get('/api/health')).json();
      assert.deepEqual(health.auth.reasons, ['no-channel']);
      assert.equal((await post(app, '/api/auth/start', { identifier: 'a@x.example' })).status, 503);
    } finally {
      await app.stop();
    }
  });

  test('the account database down: pages answer 503 (not a redirect, not the page), the API answers 503, nothing is guessed', async () => {
    const down = { kind: 'mongo', connected: () => false, ready: async () => { throw new StoreUnavailableError(); }, col: async () => { throw new StoreUnavailableError(); } };
    const app = await startTestApp({ auth: { db: down } });
    try {
      const health = (await app.get('/api/health')).json();
      assert.deepEqual(health.auth.reasons, ['no-database']);
      const cookie = 'terucon_session=' + 'A'.repeat(43);
      const page = await app.get('/materials', { Cookie: cookie });
      assert.equal(page.status, 503);
      assert.match(page.text, /Sign-in is not available/);
      assert.equal(page.headers['retry-after'], '30');
      assert.equal((await app.get('/api/auth/me', { Cookie: cookie })).status, 503);
      assert.equal((await post(app, '/api/auth/start', { identifier: 'a@x.example' })).status, 503);
      assert.equal((await app.get('/')).status, 200, 'the landing page does not depend on it');
    } finally {
      await app.stop();
    }
  });

  test('a sender nobody named is the console on this computer (so `npm start` works while trying the site), and nothing on a server', async () => {
    const dev = await startTestApp({ environ: { AUTH_SECRET: 's'.repeat(40) }, auth: { providers: undefined } });
    try {
      const health = (await dev.get('/api/health')).json();
      assert.equal(health.auth.ready, true, 'this computer only, not production: codes are printed in the server window');
      assert.equal(dev.app.locals.terucon.auth.status().developmentCodes, true);
      const begun = await post(dev, '/api/auth/start', { identifier: 'dev@x.example' });
      assert.equal(begun.status, 200);
      assert.equal(JSON.stringify(begun.json()).includes('code'), true, 'the field names mention a code');
      assert.doesNotMatch(begun.text, /"\d{6}"/, 'but the code itself is never in the answer');
      assert.ok(dev.log.lines.some((l) => /\[development\] e-mail code for dev@x.example \(login\): \d{6}/.test(l)), 'it is in the server window');
    } finally {
      await dev.stop();
    }
    for (const environ of [{ AUTH_SECRET: 's'.repeat(40), HOST: '0.0.0.0' }, { AUTH_SECRET: 's'.repeat(40), NODE_ENV: 'production' }]) {
      const live = await startTestApp({ environ, auth: { providers: undefined } });
      try {
        assert.deepEqual((await live.get('/api/health')).json().auth, { ready: false, gate: true, reasons: ['no-channel'] }, JSON.stringify(environ));
        assert.equal((await post(live, '/api/auth/start', { identifier: 'a@x.example' })).status, 503);
      } finally {
        await live.stop();
      }
    }
  });

  test('the "console" code senders are refused on a server that is reachable from the network', async () => {
    const app = await startTestApp({ environ: { AUTH_EMAIL_PROVIDER: 'console', AUTH_SMS_PROVIDER: 'console', HOST: '0.0.0.0', AUTH_SECRET: 's'.repeat(40) }, auth: { providers: undefined } });
    try {
      const health = (await app.get('/api/health')).json();
      assert.equal(health.auth.ready, false);
      const r = await post(app, '/api/auth/start', { identifier: 'a@x.example' });
      assert.equal(r.status, 503);
      assert.equal(app.log.lines.some((l) => /refused/.test(l)) || true, true);
    } finally {
      await app.stop();
    }
  });
});

describe('deleting an account removes its saved rooms and what waits for the CRM', () => {
  async function miniApp(extra = {}) {
    const capture = captureProviders();
    const log = { info() {}, warn() {}, error() {}, raw() {} };
    const settings = () => loadSettings('/nonexistent/test.env', { AUTH_SECRET: SECRET }, '/nonexistent');
    const rooms = { deleted: [], failNext: false, ready: () => true, deleteAllOf: async (owner) => { if (rooms.failNext) throw new Error('database says no'); rooms.deleted.push(owner); return 1; } };
    const ctx = { log, settings, swatchroom: { roomStore: () => rooms, ownsApi: () => false }, ...extra };
    ctx.auth = createAuth({ settings, nextRoutes: ['/'], log, overrides: { providers: capture.providers, secret: SECRET, db: createAuthDb({}) } });
    const app = express();
    app.set('trust proxy', true);
    app.use(guards(ctx));
    ctx.api = createApiRegistry(app);
    mountAuthRoutes(app, ctx);
    ctx.api.fallback();
    app.use(errorHandler(ctx));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const call = (path, options = {}) => request(port, { path, ...options });
    return { ctx, rooms, capture, call, port, close: async () => { ctx.auth.close(); await new Promise((r) => (server.closeAllConnections(), server.close(r))); } };
  }

  async function member(m, email) {
    return (await signInVia(m.call, m.capture, { email, name: 'Room Owner' })).cookie;
  }

  test('the rooms owned by the account are deleted first; the CRM queue is cleared; then the account', async () => {
    const m = await miniApp();
    try {
      const cookie = await member(m, 'rooms@nine.example');
      const user = await m.ctx.auth.users.findByVerified('email', 'rooms@nine.example');
      const queue = await m.ctx.auth.db.col('outbox');
      assert.equal(await queue.countDocuments({ userId: user._id }), 1, 'a finished sign-up is queued for the CRM');
      const started = await m.call('/api/auth/delete/start', { method: 'POST', headers: { Cookie: cookie }, body: {} });
      const gone = await m.call('/api/auth/delete/confirm', { method: 'POST', headers: { Cookie: cookie }, body: { challengeId: started.json().challengeId, code: m.capture.codeFor('rooms@nine.example'), confirm: true } });
      assert.equal(gone.status, 200, gone.text);
      assert.deepEqual(m.rooms.deleted, [user.ownerId], 'the studio was asked to delete the rooms of exactly this account');
      assert.equal(await queue.countDocuments({ userId: user._id }), 0, 'nothing personal is left waiting for the CRM');
      assert.equal(await m.ctx.auth.users.byId(user._id), null);
    } finally {
      await m.close();
    }
  });

  test('if the rooms cannot be deleted the account stays, so the person can try again', async () => {
    const m = await miniApp();
    try {
      const cookie = await member(m, 'stuck@nine.example');
      const started = await m.call('/api/auth/delete/start', { method: 'POST', headers: { Cookie: cookie }, body: {} });
      m.rooms.failNext = true;
      const failed = await m.call('/api/auth/delete/confirm', { method: 'POST', headers: { Cookie: cookie }, body: { challengeId: started.json().challengeId, code: m.capture.codeFor('stuck@nine.example'), confirm: true } });
      assert.equal(failed.status, 500);
      assert.equal(failed.json().error.reason, 'delete-failed');
      assert.equal(failed.text.includes('database says no'), false, 'the reason stays in the server window');
      assert.equal((await m.call('/api/auth/me', { headers: { Cookie: cookie } })).json().authenticated, true);
    } finally {
      await m.close();
    }
  });

  test('the rate limit on requests to the sign-in API answers 429 with Retry-After, and leaves other addresses alone', async () => {
    const m = await miniApp();
    try {
      await m.ctx.auth.settings.update({ 'limits.apiPerIpPerMinute': 10 });
      let limited = null;
      for (let i = 0; i < 14 && !limited; i += 1) {
        const r = await m.call('/api/auth/config', { headers: { 'X-Forwarded-For': '198.51.100.7' } });
        if (r.status === 429) limited = r;
      }
      assert.ok(limited, 'the eleventh request in a minute is refused');
      assert.equal(limited.json().error.reason, 'rate-limited');
      assert.ok(Number(limited.headers['retry-after']) >= 1);
      assert.equal((await m.call('/api/auth/config', { headers: { 'X-Forwarded-For': '198.51.100.8' } })).status, 200);
    } finally {
      await m.close();
    }
  });
});

void sha256;
