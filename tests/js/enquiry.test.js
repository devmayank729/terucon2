import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { ENQUIRY_AREAS, ENQUIRY_TIMELINES, ENQUIRY_TYPES, newReference, readEnquiry } from '../../server/lib/enquiry.js';
import { startTestApp } from '../helpers/app.js';

// "Start a project": what a visitor may send (server/lib/enquiry.js), the route (server/routes/enquiry.js), the admin's list of them.

const TOKEN = 'admin-token-'.padEnd(48, 'z');
let visitor = 0;
const ip = () => ({ 'X-Forwarded-For': `10.150.${Math.floor(visitor / 250)}.${(visitor += 1) % 250}` });
const good = { type: 'Office interior', name: 'Asha Rao', company: 'Rao Dental', phone: '+91 98765 43210', email: 'asha@example.com', city: 'Bengaluru', area: '2,000 – 10,000 sq ft', timeline: '3–6 months', message: 'Ground floor reception.' };

describe('readEnquiry', () => {
  test('a full, good enquiry comes out unchanged', () => {
    const r = readEnquiry(good);
    assert.equal(r.ok, true);
    assert.deepEqual(r.enquiry, good);
    assert.equal(r.source, 'start-project');
  });

  test('only a name and one way to reach the person are needed; the rest may be empty', () => {
    assert.equal(readEnquiry({ name: 'A', phone: '9876543210' }).ok, true);
    assert.equal(readEnquiry({ name: 'A', email: 'a@b.co' }).ok, true);
    const none = readEnquiry({ name: 'A' });
    assert.deepEqual([none.ok, none.field], [false, 'phone']);
    const noName = readEnquiry({ phone: '9876543210' });
    assert.deepEqual([noName.ok, noName.field], [false, 'name']);
  });

  test('the three fixed lists accept only the values the form offers (and the landing page\'s two old chip words)', () => {
    for (const type of ENQUIRY_TYPES) assert.equal(readEnquiry({ ...good, type }).ok, true, type);
    for (const timeline of ENQUIRY_TIMELINES) assert.equal(readEnquiry({ ...good, timeline }).ok, true, timeline);
    for (const area of ENQUIRY_AREAS) assert.equal(readEnquiry({ ...good, area }).ok, true, area);
    assert.equal(readEnquiry({ ...good, timeline: 'Later' }).enquiry.timeline, 'Later this year');
    assert.equal(readEnquiry({ ...good, timeline: 'Exploring' }).enquiry.timeline, 'Just exploring');
    for (const [field, value] of [['type', 'Hack'], ['area', '1 sq ft'], ['timeline', 'yesterday']]) {
      const r = readEnquiry({ ...good, [field]: value });
      assert.deepEqual([r.ok, r.field], [false, field]);
    }
    assert.equal(readEnquiry({ ...good, type: '', area: '', timeline: '' }).ok, true, 'empty means "not chosen"');
  });

  test('phone numbers and e-mail addresses are checked', () => {
    for (const phone of ['abc', '12', '1'.repeat(16), '98765<script>']) assert.equal(readEnquiry({ ...good, phone }).field, 'phone', phone);
    for (const email of ['nope', 'a@b', 'a b@c.co', '<a@b.co>']) assert.equal(readEnquiry({ ...good, email }).field, 'email', email);
    assert.equal(readEnquiry({ ...good, phone: '(080) 2345-6789' }).ok, true);
  });

  test('everything is cut to length, control characters go, other types are ignored', () => {
    const s = readEnquiry({ ...good, name: 'N'.repeat(500), message: 'm'.repeat(9000), company: 'a\u0000b\nc', city: 42 });
    assert.equal(s.enquiry.name.length, 120);
    assert.equal(s.enquiry.message.length, 2000);
    assert.equal(s.enquiry.company, 'a b c');
    assert.equal(s.enquiry.city, '');
    assert.equal(readEnquiry({ ...good, area: ['x'] }).enquiry.area, '', 'a list is not a value: ignored, like not chosen');
    for (const body of [null, undefined, 'x', 7, [], [good]]) assert.equal(readEnquiry(body).ok, false);
  });

  test('where the form was is one of two fixed words', () => {
    assert.equal(readEnquiry({ ...good, source: 'landing' }).source, 'landing');
    assert.equal(readEnquiry({ ...good, source: '<b>x</b>' }).source, 'start-project');
  });

  test('references are TR- and six characters without look-alikes, and differ', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const ref = newReference();
      assert.match(ref, /^TR-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
      seen.add(ref);
    }
    assert.ok(seen.size > 190);
  });
});

describe('POST /api/enquiry through the real server', () => {
  let app;
  before(async () => {
    app = await startTestApp({ environ: { AUTH_ADMIN_TOKEN: TOKEN } });
  });
  after(() => app.stop());

  const send = (body, headers = {}) => app.request('/api/enquiry', { method: 'POST', body, headers: { ...ip(), ...headers } });
  const list = async () => (await app.request('/api/auth/admin/enquiries', { headers: { Authorization: `Bearer ${TOKEN}`, ...ip() } })).json().enquiries;

  test('a good enquiry is kept, answered with a reference, and the admin can read it', async () => {
    const r = await send(good);
    assert.equal(r.status, 201);
    assert.equal(r.headers['cache-control'], 'no-store');
    const { ok, reference } = r.json();
    assert.equal(ok, true);
    assert.match(reference, /^TR-[A-Z2-9]{6}$/);
    const kept = (await list()).find((e) => e._id === reference);
    assert.ok(kept, 'listed by the admin API');
    assert.deepEqual({ ...kept, _id: undefined, createdAt: undefined }, { ...good, status: 'new', source: 'start-project', ownerId: null, _id: undefined, createdAt: undefined });
    assert.ok(Number.isFinite(kept.createdAt));
  });

  test('the landing page\'s form is kept as such, with its old chip words understood', async () => {
    const r = await send({ source: 'landing', name: 'Old Chips', email: 'o@c.co', timeline: 'Exploring' });
    assert.equal(r.status, 201);
    const kept = (await list()).find((e) => e._id === r.json().reference);
    assert.equal(kept.source, 'landing');
    assert.equal(kept.timeline, 'Just exploring');
  });

  test('a bad one is a 400 that names the field, and nothing is kept', async () => {
    const before = (await list()).length;
    for (const [body, field] of [[{ ...good, type: 'Hack' }, 'type'], [{ name: 'x' }, 'phone'], [{ ...good, email: 'nope' }, 'email'], [{ ...good, name: '' }, 'name']]) {
      const r = await send(body);
      assert.equal(r.status, 400);
      assert.equal(r.json().error.field, field);
      assert.ok(r.json().error.message.length > 10);
    }
    assert.equal((await list()).length, before);
  });

  test('the hidden field: a program that fills it in gets the same thank-you and nothing is kept', async () => {
    const before = (await list()).length;
    const r = await send({ ...good, website: 'http://spam.example' });
    assert.equal(r.status, 201);
    assert.match(r.json().reference, /^TR-/);
    assert.equal((await list()).length, before);
  });

  test('JSON only, same site only, and not too big', async () => {
    assert.equal((await app.request('/api/enquiry', { method: 'POST', body: 'name=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...ip() } })).status, 415);
    assert.equal((await send(good, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await send(good, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await send({ ...good, message: 'm'.repeat(40000) })).status, 413);
    assert.equal((await app.request('/api/enquiry', { method: 'GET', headers: ip() })).status, 405);
  });

  test('five an hour from one address, then 429 with a retry time', async () => {
    const same = { 'X-Forwarded-For': '10.151.0.9' };
    const answers = [];
    for (let i = 0; i < 6; i += 1) answers.push(await app.request('/api/enquiry', { method: 'POST', body: { ...good, name: `Burst ${i}` }, headers: same }));
    assert.deepEqual(answers.map((r) => r.status), [201, 201, 201, 201, 201, 429]);
    assert.ok(answers[5].json().error.retryAfter > 0);
    assert.ok(answers[5].headers['retry-after']);
  });

  test('somebody who is signed in has the enquiry tied to their account', async () => {
    const who = await app.signIn();
    const r = await send(good, { Cookie: who.cookie });
    assert.equal(r.status, 201);
    const kept = (await list()).find((e) => e._id === r.json().reference);
    assert.match(String(kept.ownerId), /\S/);
    const mine = await app.request('/api/auth/me', { headers: who.headers });
    assert.equal(mine.json().authenticated, true);
  });

  test('the admin list needs the admin token', async () => {
    assert.equal((await app.request('/api/auth/admin/enquiries', { headers: ip() })).status, 401);
    assert.equal((await app.request('/api/auth/admin/enquiries', { headers: { Authorization: 'Bearer wrong', ...ip() } })).status, 401);
  });

  test('the page itself is public, strict, and found by its other names', async () => {
    const page = await app.request('/start-project', { headers: ip() });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.match(page.text, /<title>Start a project/);
    for (const alias of ['/start', '/enquire', '/enquiry', '/contact']) {
      const r = await app.request(alias, { headers: ip() });
      assert.equal(r.status, 301, alias);
      assert.equal(r.headers.location, '/start-project');
    }
  });
});

describe('with the account database down', () => {
  test('the visitor is told, and nothing pretends to have been saved', async () => {
    const down = {
      kind: 'memory',
      connected: () => false,
      ready: async () => { const { StoreUnavailableError } = await import('../../server/auth/db.js'); throw new StoreUnavailableError(); },
      col: async () => { const { StoreUnavailableError } = await import('../../server/auth/db.js'); throw new StoreUnavailableError(); },
    };
    const app = await startTestApp({ auth: { db: down } });
    try {
      const r = await app.request('/api/enquiry', { method: 'POST', body: good, headers: ip() });
      assert.equal(r.status, 503);
      assert.match(r.json().error.message, /could not save/i);
    } finally {
      await app.stop();
    }
  });
});
