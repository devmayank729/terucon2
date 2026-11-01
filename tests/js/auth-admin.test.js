import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { startTestApp } from '../helpers/app.js';

// The admin API the future admin panel will call: rate limits and the rest of the sign-in settings, the security log, the CRM queue.

const TOKEN = 'admin-token-'.padEnd(48, 'z');
const as = (token = TOKEN, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
let visitor = 0;
const ip = () => ({ 'X-Forwarded-For': `10.120.${Math.floor(visitor / 250)}.${(visitor += 1) % 250}` });

describe('with no admin token set, the admin API does not exist', () => {
  let app;
  before(async () => {
    app = await startTestApp();
  });
  after(() => app.stop());

  test('every route answers 404, with or without a token, and reveals nothing', async () => {
    for (const [method, path] of [['GET', '/api/auth/admin/settings'], ['PUT', '/api/auth/admin/settings'], ['GET', '/api/auth/admin/events'], ['GET', '/api/auth/admin/status'], ['POST', '/api/auth/admin/unlock'], ['POST', '/api/auth/admin/crm/flush'], ['POST', '/api/auth/admin/crm/retry'], ['POST', '/api/auth/admin/crm/backfill']]) {
      for (const headers of [{}, as(TOKEN), as('')]) {
        const r = await app.request(path, { method, headers: { ...headers, ...ip() }, body: method === 'GET' ? undefined : {} });
        assert.equal(r.status, 404, `${method} ${path}`);
        assert.equal(r.json().error.message, 'No such API route.');
      }
    }
    assert.match(app.app.locals.terucon.auth.status().adminApi === false ? 'off' : 'on', /off/);
  });
});

describe('with an admin token', () => {
  let app;
  before(async () => {
    app = await startTestApp({ environ: { AUTH_ADMIN_TOKEN: TOKEN } });
  });
  after(() => app.stop());

  test('the token is needed, and only the exact token works', async () => {
    const wrong = ['', 'x', TOKEN.slice(1), `${TOKEN}x`, TOKEN.toUpperCase(), `Bearer ${TOKEN}`];
    for (const token of wrong) {
      const r = await app.get('/api/auth/admin/settings', { ...as(token), ...ip() });
      assert.equal(r.status, 401, JSON.stringify(token));
      assert.match(r.headers['www-authenticate'], /^Bearer/);
      assert.equal(r.json().error.reason, 'unauthorized');
    }
    for (const headers of [{}, { Authorization: TOKEN }, { Authorization: `Basic ${Buffer.from(`admin:${TOKEN}`).toString('base64')}` }, { Authorization: `bearer ${TOKEN}` }, { Authorization: `Token ${TOKEN}` }, { 'X-Admin-Token': TOKEN }, { Cookie: `token=${TOKEN}` }]) {
      assert.equal((await app.get('/api/auth/admin/settings', { ...headers, ...ip() })).status, 401, JSON.stringify(headers).slice(0, 40));
    }
    assert.equal((await app.get(`/api/auth/admin/settings?token=${TOKEN}&access_token=${TOKEN}`, ip())).status, 401, 'never in the address');
    assert.equal((await app.get('/api/auth/admin/settings', { ...as(), ...ip() })).status, 200);
  });

  test('twenty wrong tokens an hour from one address, and that address is shut out, even with the right one', async () => {
    const mine = { 'X-Forwarded-For': '198.51.100.77' };
    let last;
    for (let i = 0; i < 22; i += 1) last = await app.get('/api/auth/admin/settings', { ...as(`guess-${i}`), ...mine });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers['retry-after']) > 0);
    assert.equal((await app.get('/api/auth/admin/settings', { ...as(), ...mine })).status, 429, 'brute force does not get a free pass at the end');
    assert.equal((await app.get('/api/auth/admin/settings', { ...as(), 'X-Forwarded-For': '198.51.100.78' })).status, 200, 'other addresses are unaffected');
    const log = (await app.get('/api/auth/admin/events?limit=500', { ...as(), ...ip() })).json().events;
    assert.ok(log.filter((e) => e.type === 'admin.denied').length >= 20, 'the attempts are in the security log');
    assert.equal(log.some((e) => JSON.stringify(e).includes(TOKEN)), false, 'the token is never logged');
  });

  test('settings: described for a form, saved with bounds, effective at once, and refused when wrong', async () => {
    const got = (await app.get('/api/auth/admin/settings', { ...as(), ...ip() })).json();
    assert.equal(got.values['limits.otpStartPerIpPerHour'], 15);
    assert.equal(got.defaults['limits.otpStartPerIpPerHour'], 15);
    const entry = got.schema.find((s) => s.key === 'limits.otpStartPerIpPerHour');
    assert.deepEqual([entry.type, entry.min, entry.max, entry.unit], ['int', 1, 200, 'per hour']);
    assert.ok(entry.label && entry.help && entry.group);
    assert.deepEqual(JSON.stringify(got).includes(TOKEN), false);

    const put = (settings, headers = {}) => app.request('/api/auth/admin/settings', { method: 'PUT', body: { settings }, headers: { ...as(), ...ip(), ...headers } });
    const saved = await put({ 'limits.otpStartPerIpPerHour': 3 });
    assert.equal(saved.status, 200);
    assert.equal(saved.json().values['limits.otpStartPerIpPerHour'], 3);
    assert.deepEqual(saved.json().changed, ['limits.otpStartPerIpPerHour']);

    // it governs the very next request
    const same = { 'X-Forwarded-For': '192.0.2.50' };
    const starts = [];
    for (let i = 0; i < 5; i += 1) starts.push((await app.request('/api/auth/start', { method: 'POST', body: { identifier: `limit${i}@x.example` }, headers: same })).status);
    assert.deepEqual(starts, [200, 200, 200, 429, 429]);

    const bad = await put({ 'limits.otpStartPerIpPerHour': 0, 'otp.ttlMinutes': 'long', nonsense: 1 });
    assert.equal(bad.status, 400);
    assert.equal(bad.json().error.problems.length, 3);
    assert.equal((await put({ 'limits.otpStartPerIpPerHour': 10_000_000 })).status, 400);
    for (const body of [{}, { settings: [] }, { settings: 'x' }, { settings: null }, [], '"x"', '12', 'null']) {
      const r = await app.request('/api/auth/admin/settings', { method: 'PUT', body, headers: { ...as(), ...ip(), 'Content-Type': 'application/json' } });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    const proto = await app.request('/api/auth/admin/settings', { method: 'PUT', body: '{"settings": {"__proto__": {"polluted": true}}}', headers: { ...as(), ...ip(), 'Content-Type': 'application/json' } });
    assert.equal(proto.status, 400);
    assert.equal({}.polluted, undefined);
    const back = await put({ 'limits.otpStartPerIpPerHour': null });
    assert.equal(back.json().values['limits.otpStartPerIpPerHour'], 15);
    assert.deepEqual(back.json().changed, []);

    const events = (await app.get('/api/auth/admin/events', { ...as(), ...ip() })).json().events;
    assert.ok(events.some((e) => e.type === 'settings.changed' && e.detail.includes('limits.otpStartPerIpPerHour')));
  });

  test('turning a way in off takes effect at once, and the sign-in page stops offering it', async () => {
    const put = (settings) => app.request('/api/auth/admin/settings', { method: 'PUT', body: { settings }, headers: { ...as(), ...ip() } });
    assert.equal((await app.get('/api/auth/config')).json().channels.sms, true);
    await put({ 'channels.sms': false });
    assert.equal((await app.get('/api/auth/config')).json().channels.sms, false);
    const r = await app.request('/api/auth/start', { method: 'POST', body: { identifier: '98765 43210' }, headers: ip() });
    assert.equal(r.status, 503);
    assert.equal(r.json().error.reason, 'channel-unavailable-sms');
    await put({ 'channels.sms': null, 'sms.allowedCountryCodes': ['44'] });
    const refused = await app.request('/api/auth/start', { method: 'POST', body: { identifier: '98765 43210' }, headers: ip() });
    assert.equal(refused.json().error.reason, 'country-not-supported');
    await put({ 'sms.allowedCountryCodes': null });
  });

  test('status: is it ready, what is missing, how many accounts and sessions, what the CRM queue holds', async () => {
    await app.signIn();
    const status = (await app.get('/api/auth/admin/status', { ...as(), ...ip() })).json();
    assert.equal(status.ready, true);
    assert.equal(status.adminApi, true);
    assert.equal(status.store, 'memory');
    assert.ok(status.accounts.total >= 1);
    assert.ok(status.sessions >= 1);
    assert.equal(status.crm.credentials, false);
    assert.match(status.crm.problem, /ZOHO_REFRESH_TOKEN/);
    assert.ok(status.crmQueue.pending >= 1, 'a finished sign-up waits for Zoho');
    assert.equal(JSON.stringify(status).includes('s3cret'), false);
  });

  test('unlock: an address locked for too many wrong codes can be let back in', async () => {
    const email = 'locked-out@x.example';
    const auth = app.app.locals.terucon.auth;
    await auth.settings.update({ 'limits.failuresBeforeLock': 3 });
    const start = () => app.request('/api/auth/start', { method: 'POST', body: { identifier: email }, headers: ip() });
    const first = await start();
    const wrong = app.capture.codeFor(email) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i += 1) await app.request('/api/auth/verify', { method: 'POST', body: { challengeId: first.json().challengeId, code: wrong }, headers: ip() });
    assert.equal((await start()).json().error.reason, 'locked');
    const open = await app.request('/api/auth/admin/unlock', { method: 'POST', body: { identifier: ` ${email.toUpperCase()} ` }, headers: { ...as(), ...ip() } });
    assert.equal(open.status, 200);
    assert.equal((await start()).status, 200);
    assert.equal((await app.request('/api/auth/admin/unlock', { method: 'POST', body: { identifier: 'junk' }, headers: { ...as(), ...ip() } })).status, 400);
    await auth.settings.update({ 'limits.failuresBeforeLock': null });
  });

  test('events: newest first, paged, with no codes, tokens or full addresses in them', async () => {
    await app.signIn();
    const page = (await app.get('/api/auth/admin/events?limit=5', { ...as(), ...ip() })).json().events;
    assert.equal(page.length, 5);
    assert.ok(page[0].t >= page[4].t);
    const older = (await app.get(`/api/auth/admin/events?limit=5&before=${page[4].t}`, { ...as(), ...ip() })).json().events;
    assert.ok(older.every((e) => e.t < page[4].t));
    const everything = JSON.stringify((await app.get('/api/auth/admin/events?limit=500', { ...as(), ...ip() })).json());
    for (const code of app.capture.sent.map((m) => m.code)) assert.equal(everything.includes(`"${code}"`), false, 'no code in the log');
    for (const to of new Set(app.capture.sent.map((m) => m.to))) assert.equal(everything.includes(to), false, `the address ${to} is not in the log, only its masked form`);
    assert.equal((await app.get('/api/auth/admin/events?limit=abc&before=zzz', { ...as(), ...ip() })).status, 200);
  });

  test('the CRM controls answer, and need the token', async () => {
    for (const path of ['/api/auth/admin/crm/flush', '/api/auth/admin/crm/retry', '/api/auth/admin/crm/backfill']) {
      assert.equal((await app.request(path, { method: 'POST', body: {}, headers: ip() })).status, 401, path);
      const ok = await app.request(path, { method: 'POST', body: {}, headers: { ...as(), ...ip() } });
      assert.equal(ok.status, 200, path);
    }
    const flush = (await app.request('/api/auth/admin/crm/flush', { method: 'POST', body: {}, headers: { ...as(), ...ip() } })).json();
    assert.equal(flush.waiting, true, 'no Zoho credentials yet: it waits');
  });

  test('the usual web rules still apply: JSON only, same site only, right method', async () => {
    const put = (headers, body = '{"settings":{}}') => app.request('/api/auth/admin/settings', { method: 'PUT', body, headers: { ...as(), ...ip(), ...headers } });
    assert.equal((await put({ 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await put({ 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status, 403, 'a page on another site cannot drive the admin API, even holding the token');
    assert.equal((await put({ 'Content-Type': 'application/json' }, '{"settings":')).status, 400);
    assert.equal((await app.request('/api/auth/admin/settings', { method: 'POST', body: {}, headers: { ...as(), ...ip() } })).status, 405);
    assert.equal((await app.request('/api/auth/admin/status', { method: 'DELETE', headers: { ...as(), ...ip(), 'Content-Type': 'application/json' } })).status, 405);
    const big = await app.request('/api/auth/admin/settings', { method: 'PUT', body: JSON.stringify({ settings: { 'crm.leadSource': 'x'.repeat(40_000) } }), headers: { ...as(), ...ip(), 'Content-Type': 'application/json' } });
    assert.equal(big.status, 413);
  });
});
