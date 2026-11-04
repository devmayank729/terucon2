import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripMetadata } from '../../server/capture/strip.js';
import { cleanLocation, cleanTags, normalizePhone } from '../../server/capture/validate.js';
import { startTestApp } from '../helpers/app.js';
import { makeJpeg } from '../helpers/fakeCatalogueModal.js';

// Capture from a phone, through the real server: who may do what, what a retried upload does, what is kept and what is dropped,
// what happens when a link ends, and what is sent to WhatsApp. MongoDB is the in-memory stand-in; Meta's servers are a fake fetch.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = 'https://capture.example';
const ENV = `CAPTURE_PUBLIC_URL=${PUBLIC}\n`;
const WA_ENV = `${ENV}WHATSAPP_TOKEN=test-token-not-real\nWHATSAPP_PHONE_NUMBER_ID=1234567890\nWHATSAPP_TEMPLATE_PHOTO=photo_alert\nWHATSAPP_TEMPLATE_LINK=capture_link\n`;
const hex32 = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const meta = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const JPEG = makeJpeg({ width: 800, height: 600, extra: 3000 });

/** A clock the test moves. */
function clock(start = 1_800_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

/** A stand-in for fetch() towards Meta: records what it is sent, answers like the Cloud API, can be told to refuse. */
function fakeMeta() {
  const sent = [];
  const state = { fail: null };
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    sent.push({ url: String(url), headers: options.headers, body });
    if (state.fail) return new Response(JSON.stringify({ error: { message: state.fail, code: 131030 } }), { status: 400, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.${sent.length}` }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, sent, state };
}

async function withApp(fn, { env = ENV, capture = {} } = {}) {
  const app = await startTestApp({ env, capture });
  try {
    const person = await app.signIn({ name: 'Mayank Rohilla' });
    await fn(app, person);
  } finally {
    await app.stop();
  }
}

const json = (r) => r.json();

/** The requester asks for a link; returns {id, token, link}. */
async function newLink(app, person, body = { service: 'studio' }) {
  const r = await app.post('/api/capture/sessions', body, person.headers);
  assert.equal(r.status, 201, r.text);
  const { session } = json(r);
  return { id: session.id, token: session.link.split('#')[1], link: session.link, session };
}

const asPhone = (token, extra = {}) => ({ 'X-Capture-Token': token, ...extra });
const putDetails = (app, token, details = { name: 'Ravi Kumar' }) => app.request('/api/capture/s/details', { method: 'PUT', headers: asPhone(token), body: details });
const upload = (app, token, bytes = JPEG, { cid = hex32(), tags, note, type = 'image/jpeg' } = {}) =>
  app.request('/api/capture/s/photos', { method: 'POST', headers: asPhone(token, { 'Content-Type': type, 'X-Photo-Id': cid, ...(tags || note ? { 'X-Photo-Meta': meta({ tags, note }) } : {}) }), body: bytes });

describe('who may ask for photos', () => {
  test('every requester route needs a signed-in, finished account', async () => {
    await withApp(async (app) => {
      const unfinished = await app.signIn({ finish: false });
      const routes = [['GET', '/api/capture/config'], ['GET', '/api/capture/inbox'], ['POST', '/api/capture/sessions'], ['GET', `/api/capture/sessions/${hex32()}`], ['GET', `/api/capture/photos/${hex32()}_${hex32()}/file`]];
      for (const [method, route] of routes) {
        const anonymous = await app.request(route, { method, body: method === 'POST' ? { service: 'studio' } : undefined });
        assert.equal(anonymous.status, 401, route);
        assert.equal(anonymous.headers['cache-control'], 'no-store');
        const partial = await app.request(route, { method, headers: unfinished.headers, body: method === 'POST' ? { service: 'studio' } : undefined });
        assert.equal(partial.status, 403, route);
      }
    });
  });

  test('a link is made for one of the three pages, and its address is the configured one with the token after the # sign', async () => {
    await withApp(async (app, person) => {
      assert.equal((await app.post('/api/capture/sessions', { service: 'dashboard' }, person.headers)).status, 400);
      const { session, link } = await newLink(app, person, { service: 'finder', note: '  The reception\u0000 wall  ' });
      assert.match(link, new RegExp(`^${PUBLIC}/capture#[A-Za-z0-9_-]{32}$`));
      assert.equal(session.service, 'finder');
      assert.equal(session.note, 'The reception wall');
      assert.equal(session.open, true);
      assert.equal(session.expiresAt - session.createdAt, 120 * 60_000);
    });
  });

  test('the address of a link is never taken from the Host header of a request that is not on this computer', async () => {
    // no CAPTURE_PUBLIC_URL: a name the caller chose (allowed here only so the request reaches the route) must not become the address of a link
    await withApp(async (app, person) => {
      const r = await app.post('/api/capture/sessions', { service: 'studio' }, { ...person.headers, Host: 'evil.example' });
      assert.equal(r.status, 503);
      assert.equal(json(r).error.reason, 'no-public-url');
      const here = await app.post('/api/capture/sessions', { service: 'studio' }, person.headers);
      assert.equal(here.status, 201, 'on this computer the page\'s own address is used...');
      assert.equal(json(here).reachable, false, '...and the page is told a phone cannot open it');
    }, { env: 'ALLOWED_HOSTS=evil.example\n' });
  });

  test('a person has at most five links open, and cannot make a flood of them', async () => {
    await withApp(async (app, person) => {
      const ids = [];
      for (let i = 0; i < 5; i += 1) ids.push((await newLink(app, person)).id);
      const sixth = await app.post('/api/capture/sessions', { service: 'studio' }, person.headers);
      assert.equal(sixth.status, 409);
      assert.equal(json(sixth).error.reason, 'too-many-open');
      assert.equal((await app.post(`/api/capture/sessions/${ids[0]}/close`, {}, person.headers)).status, 200);
      assert.equal((await app.post('/api/capture/sessions', { service: 'studio' }, person.headers)).status, 201, 'ending one makes room');
    });
    await withApp(async (app, person) => {
      for (let i = 0; i < 3; i += 1) assert.equal((await newLink(app, person)).session.open, true);
      assert.equal((await app.post('/api/capture/sessions', { service: 'studio' }, person.headers)).status, 201);
    }, { env: `${ENV}CAPTURE_LIMIT_SESSIONS=4\n` });
  });

  test('a request from another site is refused', async () => {
    await withApp(async (app, person) => {
      const r = await app.post('/api/capture/sessions', { service: 'studio' }, { ...person.headers, 'Sec-Fetch-Site': 'cross-site' });
      assert.equal(r.status, 403);
      assert.equal(json(r).error.reason, 'cross-site');
    });
  });
});

describe('the phone: details, photos, retries, limits', () => {
  test('the whole journey: info, details, a photo with labels, a retry that changes nothing, and the requester sees it', async () => {
    await withApp(async (app, person) => {
      const { id, token } = await newLink(app, person, { service: 'inspiration', note: 'Front cabin please' });
      const info = await app.request('/api/capture/s/info', { headers: asPhone(token) });
      assert.equal(info.status, 200);
      assert.deepEqual({ service: json(info).service, requester: json(info).requester, note: json(info).note, remaining: json(info).remaining }, { service: 'inspiration', requester: 'Mayank', note: 'Front cabin please', remaining: 30 }, 'the phone is told the requester\'s first name only');
      assert.equal(json(info).detailsSaved, false);
      assert.ok(!('capturer' in json(info)), 'a link holder is not shown anyone\'s details');

      assert.equal((await upload(app, token)).status, 409, 'no name yet: refused');
      assert.equal(json(await upload(app, token)).error.reason, 'details-needed');

      const location = { lat: 28.613939, lng: 77.209021, accuracy: 18.4, at: Date.now() };
      const saved = await putDetails(app, token, { name: '  Ravi   Kumar ', phone: '98765 43210', address: 'Plot 4,\nSector 9', place: 'Cabin B', location });
      assert.equal(saved.status, 200, saved.text);
      assert.deepEqual(json(saved).capturer, { name: 'Ravi Kumar', phone: '+919876543210', address: 'Plot 4, Sector 9', place: 'Cabin B', location: { lat: 28.613939, lng: 77.209021, accuracy: 18, at: location.at } });

      const cid = hex32();
      const first = await upload(app, token, JPEG, { cid, tags: ['Room', 'cabin', 'ROOM', '<script>', ''], note: 'north wall' });
      assert.equal(first.status, 201, first.text);
      assert.deepEqual(json(first).photo.tags, ['Room', 'cabin'], 'repeats and anything that is not a label are dropped');
      assert.equal(json(first).duplicate, false);
      const again = await upload(app, token, JPEG, { cid });
      assert.equal(again.status, 200, 'the same photo sent again (a retry) is accepted and changes nothing');
      assert.equal(json(again).duplicate, true);
      assert.equal(json(again).photo.id, json(first).photo.id);

      const inbox = json(await app.get('/api/capture/inbox', person.headers));
      assert.equal(inbox.photos.length, 1);
      assert.equal(inbox.sessions[0].photoCount, 1, 'the retry did not use a second place');
      assert.equal(inbox.sessions[0].capturer.name, 'Ravi Kumar');
      assert.equal(inbox.photos[0].session, id);
      assert.equal(inbox.photos[0].service, 'inspiration');
      assert.equal(inbox.photos[0].note, 'north wall');
      assert.ok(!JSON.stringify(inbox).includes(token) || inbox.sessions[0].link.endsWith(token), 'the token appears only inside the requester\'s own link');

      const file = await app.get(`/api/capture/photos/${inbox.photos[0].id}/file`, person.headers);
      assert.equal(file.status, 200);
      assert.equal(file.headers['content-type'], 'image/jpeg');
      assert.equal(file.headers['x-content-type-options'], 'nosniff');
      assert.match(file.headers['content-security-policy'], /sandbox/);
      assert.match(file.headers['cache-control'], /^private/);
      assert.deepEqual(file.buffer, JPEG, 'the bytes are what was sent (this photo carried no metadata to drop)');
      assert.match((await app.get(`/api/capture/photos/${inbox.photos[0].id}/file?download=1`, person.headers)).headers['content-disposition'], /^attachment/);
    });
  });

  test('nobody but the requester can see a photo or a link; the phone cannot read anything back', async () => {
    await withApp(async (app, person) => {
      const { id, token } = await newLink(app, person);
      await putDetails(app, token);
      const photo = json(await upload(app, token)).photo;
      const stranger = await app.signIn({ name: 'Other Person' });
      assert.equal((await app.get(`/api/capture/photos/${photo.id}/file`, stranger.headers)).status, 404);
      assert.equal((await app.get(`/api/capture/sessions/${id}`, stranger.headers)).status, 404);
      assert.equal((await app.request(`/api/capture/photos/${photo.id}`, { method: 'DELETE', headers: { ...stranger.headers, 'Content-Type': 'application/json' } })).status, 404);
      assert.equal((await app.post(`/api/capture/sessions/${id}/close`, {}, stranger.headers)).status, 404);
      const theirs = json(await app.get('/api/capture/inbox', stranger.headers));
      assert.deepEqual([theirs.sessions.length, theirs.photos.length], [0, 0]);
      // the token opens the phone routes only: it is no key to the requester's routes
      assert.equal((await app.get('/api/capture/inbox', asPhone(token))).status, 401);
      assert.equal((await app.get(`/api/capture/photos/${photo.id}/file`, asPhone(token))).status, 401);
    });
  });

  test('only a JPEG, PNG or WebP that really is one is taken; its size, count and type are checked', async () => {
    await withApp(async (app, person) => {
      const { token } = await newLink(app, person);
      await putDetails(app, token);
      assert.equal((await upload(app, token, Buffer.from('<html><script>alert(1)</script></html>'), { type: 'image/jpeg' })).status, 415, 'html named as a jpeg');
      assert.equal((await upload(app, token, Buffer.from('GIF89a' + 'x'.repeat(40)), { type: 'image/jpeg' })).status, 415, 'a gif is not taken');
      assert.equal((await upload(app, token, JPEG, { type: 'text/plain' })).status, 415, 'the type is checked before the body');
      assert.equal((await upload(app, token, JPEG, { cid: 'nope' })).status, 400);
      assert.equal((await upload(app, token, Buffer.alloc(0))).status, 400);
      assert.equal((await upload(app, token, makeJpeg({ width: 30000, height: 30000 }))).status, 413, 'a small file that unpacks to a huge picture');
      assert.equal((await upload(app, token, Buffer.concat([JPEG.subarray(0, 40)]))).status, 400, 'a cut-short jpeg');
      const big = makeJpeg({ extra: 7 * 1024 * 1024 });
      assert.equal((await upload(app, token, big)).status, 413);
      assert.equal((await app.request('/api/capture/s/photos', { method: 'POST', headers: asPhone(token, { 'Content-Type': 'image/jpeg', 'X-Photo-Id': hex32(), 'X-Photo-Meta': '%%%' }), body: JPEG })).status, 400, 'a garbled label header');
      assert.equal(json(await app.get('/api/capture/inbox', person.headers)).sessions[0].photoCount, 0, 'nothing refused used up a place');
      const png = fs.readFileSync(path.join(ROOT, 'media', 'Terucon_logo.png'));
      assert.equal((await upload(app, token, png, { type: 'image/png' })).status, 201, 'a real png');
      const jpg = fs.readFileSync(path.join(ROOT, 'media', 'a01-hero.jpg'));
      assert.equal((await upload(app, token, jpg)).status, 201, 'a real jpeg from the repository');
    });
  });

  test('a link takes the number of photos it was made for, and no more', async () => {
    await withApp(async (app, person) => {
      const { token } = await newLink(app, person);
      await putDetails(app, token);
      assert.equal((await upload(app, token)).status, 201);
      assert.equal((await upload(app, token)).status, 201);
      const third = await upload(app, token);
      assert.equal(third.status, 409);
      assert.equal(json(third).error.reason, 'full');
      assert.equal(json(await app.get('/api/capture/inbox', person.headers)).sessions[0].photoCount, 2);
    }, { env: `${ENV}CAPTURE_MAX_PHOTOS=2\n` });
  });

  test('two copies of one photo arriving at the same moment make one photo and use one place', async () => {
    await withApp(async (app, person) => {
      const { token } = await newLink(app, person);
      await putDetails(app, token);
      const cid = hex32();
      const answers = await Promise.all(Array.from({ length: 6 }, () => upload(app, token, JPEG, { cid })));
      for (const a of answers) assert.ok([200, 201, 409].includes(a.status), String(a.status) + a.text);
      for (const a of answers.filter((x) => x.status === 409)) assert.equal(json(a).error.reason, 'in-progress');
      const retry = await upload(app, token, JPEG, { cid });
      assert.equal(retry.status, 200);
      const inbox = json(await app.get('/api/capture/inbox', person.headers));
      assert.equal(inbox.photos.length, 1);
      assert.equal(inbox.sessions[0].photoCount, 1);
    });
  });

  test('a link ends by itself, and when the requester ends it', async () => {
    const now = clock();
    await withApp(async (app, person) => {
      const { id, token } = await newLink(app, person);
      await putDetails(app, token);
      assert.equal((await upload(app, token)).status, 201);
      now.advance(119 * 60_000);
      assert.equal((await upload(app, token)).status, 201, 'one minute left');
      now.advance(2 * 60_000);
      const late = await upload(app, token);
      assert.equal(late.status, 410);
      assert.equal(json(late).error.reason, 'expired');
      assert.equal((await app.request('/api/capture/s/info', { headers: asPhone(token) })).status, 410);
      const view = json(await app.get(`/api/capture/sessions/${id}`, person.headers)).session;
      assert.equal(view.open, false);
      assert.ok(!('link' in view), 'a link that has ended is not shown again');
      assert.equal(json(await app.get('/api/capture/inbox', person.headers)).photos.length, 2, 'the photos stay for the requester');

      const second = await newLink(app, person);
      await putDetails(app, second.token);
      await app.post(`/api/capture/sessions/${second.id}/close`, {}, person.headers);
      const closed = await upload(app, second.token);
      assert.equal(closed.status, 410);
      assert.equal(json(closed).error.reason, 'closed');
    }, { capture: { now } });
  });

  test('guessing links is slowed down; a wrong token and a link that never existed look the same', async () => {
    await withApp(async (app, person) => {
      await newLink(app, person);
      const guess = () => app.request('/api/capture/s/info', { headers: asPhone('A'.repeat(32)) });
      const first = await guess();
      assert.equal(first.status, 404);
      assert.equal(json(first).error.reason, 'unknown-link');
      assert.equal((await app.request('/api/capture/s/info', { headers: asPhone('short') })).status, 404);
      assert.equal((await app.request('/api/capture/s/info')).status, 404, 'no token at all');
      let last;
      for (let i = 0; i < 40; i += 1) last = await guess();
      assert.equal(last.status, 429);
      assert.ok(Number(last.headers['retry-after']) >= 1);
    });
  });

  test('the phone\'s details are checked: a name is needed, a phone number must be a number, a location must be real and recent', async () => {
    await withApp(async (app, person) => {
      const { token } = await newLink(app, person);
      const refused = async (details, reason) => {
        const r = await putDetails(app, token, details);
        assert.equal(r.status, 400, JSON.stringify(details));
        assert.equal(json(r).error.reason, reason);
      };
      await refused({}, 'bad-name');
      await refused({ name: 'R' }, 'bad-name');
      await refused({ name: '12345' }, 'bad-name');
      await refused({ name: 'Ravi', phone: 'call me maybe' }, 'bad-phone');
      await refused({ name: 'Ravi', location: { lat: 91, lng: 0, at: Date.now() } }, 'bad-location');
      await refused({ name: 'Ravi', location: { lat: 'x', lng: 0, at: Date.now() } }, 'bad-location');
      await refused({ name: 'Ravi', location: { lat: 10, lng: 10, at: Date.now() - 3 * 24 * 3600_000 } }, 'stale-location');
      await refused({ name: 'Ravi', location: { lat: 10, lng: 10, at: Date.now() + 3600_000 } }, 'stale-location');
      assert.equal((await app.request('/api/capture/s/details', { method: 'PUT', headers: asPhone(token, { 'Content-Type': 'text/plain' }), body: 'x' })).status, 415);
      const ok = await putDetails(app, token, { name: 'Ravi', phone: '', address: '', location: null });
      assert.equal(ok.status, 200);
      assert.equal(json(ok).capturer.location, null, 'a location is optional');
    });
  });

  test('the exemption that lets a photo through the JSON rule is exactly one route and three types', async () => {
    await withApp(async (app) => {
      assert.equal((await app.request('/api/nope', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: JPEG })).status, 415);
      assert.equal((await app.request('/api/capture/s/details', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: JPEG })).status, 415);
      assert.equal((await app.request('/api/capture/s/photos', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: JPEG })).status, 415);
      assert.equal((await app.request('/api/capture/s/photos', { method: 'POST', headers: { 'Content-Type': 'image/gif' }, body: JPEG })).status, 415);
      assert.equal((await app.request('/api/capture/s/photos', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', Origin: 'https://evil.example' }, body: JPEG })).status, 403, 'the same-site rule still applies');
    });
  });
});

describe('keeping and deleting', () => {
  test('the requester can delete a photo, or a whole link with its photos; deleting an account deletes the photos', async () => {
    await withApp(async (app, person) => {
      const a = await newLink(app, person);
      await putDetails(app, a.token);
      const one = json(await upload(app, a.token)).photo;
      const two = json(await upload(app, a.token)).photo;
      const gone = await app.request(`/api/capture/photos/${one.id}`, { method: 'DELETE', headers: { ...person.headers, 'Content-Type': 'application/json' } });
      assert.equal(gone.status, 200);
      assert.equal((await app.get(`/api/capture/photos/${one.id}/file`, person.headers)).status, 404);
      assert.equal((await app.get(`/api/capture/photos/${two.id}/file`, person.headers)).status, 200);
      const wiped = await app.request(`/api/capture/sessions/${a.id}`, { method: 'DELETE', headers: { ...person.headers, 'Content-Type': 'application/json' } });
      assert.equal(json(wiped).deleted, 1);
      assert.equal((await app.get(`/api/capture/photos/${two.id}/file`, person.headers)).status, 404);
      assert.equal((await upload(app, a.token)).status, 404, 'the link is gone with it');

    });
  });

  test('deleting the account deletes the photos that were sent to it, and a failure keeps the account', async () => {
    const app = await startTestApp({ env: ENV });
    try {
      const person = await app.signIn({ email: 'photos-bye@example.com', name: 'Mayank Rohilla' });
      const stays = await app.signIn({ email: 'photos-stay@example.com', name: 'Someone Else' });
      const mine = await newLink(app, person);
      const theirs = await newLink(app, stays);
      for (const l of [mine, theirs]) {
        await putDetails(app, l.token);
        await upload(app, l.token);
      }
      const files = await app.app.locals.terucon.capture.db.col('capture_files');
      assert.equal(await files.countDocuments({}), 2);
      const started = await app.post('/api/auth/delete/start', {}, person.headers);
      const code = app.capture.codeFor('photos-bye@example.com');
      const gone = await app.post('/api/auth/delete/confirm', { challengeId: started.json().challengeId, code, confirm: true }, person.headers);
      assert.equal(gone.status, 200, gone.text);
      assert.equal(await files.countDocuments({}), 1, 'only the other account\'s photo is left');
      assert.equal(json(await app.get('/api/capture/inbox', stays.headers)).photos.length, 1);
    } finally {
      await app.stop();
    }
  });

  test('deleting everything of an owner removes the photos, their files and the links', async () => {
    await withApp(async (app, person) => {
      const link = await newLink(app, person);
      await putDetails(app, link.token);
      const photo = json(await upload(app, link.token)).photo;
      const col = await app.app.locals.terucon.capture.db.col('capture_files');
      assert.ok(await col.findOne({ _id: photo.id }), 'the picture is in the database');
      const ownerId = (await (await app.app.locals.terucon.capture.db.col('capture_sessions')).findOne({ _id: link.id })).owner;
      assert.equal(await app.app.locals.terucon.capture.service.deleteAllOf(ownerId), 1);
      assert.equal(await col.findOne({ _id: photo.id }), null, 'and now it is not');
      assert.equal(json(await app.get('/api/capture/inbox', person.headers)).sessions.length, 0);
    });
  });
});

describe('WhatsApp', () => {
  test('without a business account, "send on WhatsApp" gives the requester a wa.me message to send from their own phone', async () => {
    await withApp(async (app, person) => {
      const config = json(await app.get('/api/capture/config', person.headers));
      assert.deepEqual([config.whatsapp.serverSends, config.whatsapp.alerts], [false, false]);
      const { id, link } = await newLink(app, person);
      const r = await app.post(`/api/capture/sessions/${id}/whatsapp`, { phone: '+91 98765-43210' }, person.headers);
      assert.equal(r.status, 200, r.text);
      assert.equal(json(r).mode, 'link');
      assert.equal(json(r).to, '+91••••••3210');
      const url = new URL(json(r).waLink);
      assert.equal(url.origin + url.pathname, 'https://wa.me/919876543210');
      assert.ok(url.searchParams.get('text').includes(link), 'the message carries the link');
      assert.equal((await app.post(`/api/capture/sessions/${id}/whatsapp`, { phone: '12' }, person.headers)).status, 400);
      assert.equal((await app.post(`/api/capture/sessions/${id}/whatsapp`, { phone: 'abc' }, person.headers)).status, 400);
      const alert = await app.request(`/api/capture/sessions/${id}/alert`, { method: 'PUT', headers: person.headers, body: { phone: '9876543210' } });
      assert.equal(alert.status, 503, 'an alert needs the business account, and says so instead of pretending');
      assert.equal(json(alert).error.reason, 'whatsapp-off');
    });
  });

  test('with a business account the server sends Meta\'s template request, and tells the requester when a photo arrives', async () => {
    const meta = fakeMeta();
    await withApp(async (app, person) => {
      const config = json(await app.get('/api/capture/config', person.headers));
      assert.deepEqual([config.whatsapp.serverSends, config.whatsapp.alerts], [true, true]);
      const { id, link, token } = await newLink(app, person);

      const sent = await app.post(`/api/capture/sessions/${id}/whatsapp`, { phone: '98765 43210' }, person.headers);
      assert.equal(sent.status, 200, sent.text);
      assert.equal(json(sent).mode, 'sent');
      assert.ok(json(sent).waLink.startsWith('https://wa.me/919876543210'), 'the wa.me address is still there as a fallback');
      const request = meta.sent[0];
      assert.equal(request.url, 'https://graph.facebook.com/v23.0/1234567890/messages');
      assert.equal(request.headers.Authorization, 'Bearer test-token-not-real');
      assert.deepEqual(request.body.template.name, 'capture_link');
      assert.deepEqual(request.body, {
        messaging_product: 'whatsapp',
        to: '919876543210',
        type: 'template',
        template: { name: 'capture_link', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Mayank' }, { type: 'text', text: link }, { type: 'text', text: '120' }] }] },
      });
      assert.equal((await app.post(`/api/capture/sessions/${id}/whatsapp`, { phone: '98765 43210' }, person.headers)).status, 200, 'a second try to the same number is allowed...');
      const third = await app.post(`/api/capture/sessions/${id}/whatsapp`, { phone: '98765 43210' }, person.headers);
      assert.equal(third.status, 429, '...a third is not: one number is messaged twice a day at most');
      assert.equal(meta.sent.filter((m) => m.body.template.name === 'capture_link').length, 2);

      // the alert
      const set = await app.request(`/api/capture/sessions/${id}/alert`, { method: 'PUT', headers: person.headers, body: { phone: '+91 91234 56789' } });
      assert.equal(set.status, 200, set.text);
      assert.equal(json(set).alert.to, '+91••••••6789', 'only a masked number is ever shown back');
      await putDetails(app, token, { name: 'Ravi Kumar' });
      await upload(app, token);
      await new Promise((r) => setTimeout(r, 30));
      const alerts = meta.sent.filter((s) => s.body.template.name === 'photo_alert');
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].body.to, '919123456789');
      assert.deepEqual(alerts[0].body.template.components[0].parameters.map((p) => p.text), ['Ravi Kumar', '1', 'Design Studio']);
      await upload(app, token);
      await upload(app, token);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(meta.sent.filter((s) => s.body.template.name === 'photo_alert').length, 1, 'one alert for the first photo, not one for each');
      assert.equal((await app.request('/api/capture/s/done', { method: 'POST', headers: asPhone(token), body: {} })).status, 200);
      await new Promise((r) => setTimeout(r, 30));
      const summary = meta.sent.filter((s) => s.body.template.name === 'photo_alert');
      assert.equal(summary.length, 2, 'and one when the phone says it is done');
      assert.equal(summary[1].body.template.components[0].parameters[1].text, '3');
      await app.request('/api/capture/s/done', { method: 'POST', headers: asPhone(token), body: {} });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(meta.sent.filter((s) => s.body.template.name === 'photo_alert').length, 2, 'saying done twice sends nothing more');
      const view = json(await app.get('/api/capture/inbox', person.headers)).sessions[0];
      assert.deepEqual(view.alert, { to: '+91••••••6789', status: 'sent' });
      assert.ok(!JSON.stringify(view).includes('919123456789'), 'the number is not in any answer');
    }, { env: WA_ENV, capture: { fetch: meta.fetch } });
  });

  test('when WhatsApp refuses, the requester is told and the fallback is offered; an alert that fails is shown as failed', async () => {
    const meta = fakeMeta();
    meta.state.fail = '(#131030) Recipient phone number not in allowed list';
    await withApp(async (app, person) => {
      const { id, token } = await newLink(app, person);
      const sent = await app.post(`/api/capture/sessions/${id}/whatsapp`, { phone: '9876543210' }, person.headers);
      assert.equal(sent.status, 502);
      assert.equal(json(sent).error.reason, 'whatsapp-failed');
      assert.ok(!sent.text.includes('test-token-not-real'), 'the token is never in an answer');
      await app.request(`/api/capture/sessions/${id}/alert`, { method: 'PUT', headers: person.headers, body: { phone: '9123456789' } });
      await putDetails(app, token);
      assert.equal((await upload(app, token)).status, 201, 'a failing alert never fails the upload');
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(json(await app.get('/api/capture/inbox', person.headers)).sessions[0].alert.status, 'failed');
      assert.ok(!app.log.lines.join('\n').includes('test-token-not-real'), 'and nothing secret reached the log');
    }, { env: WA_ENV, capture: { fetch: meta.fetch } });
  });

  test('the server stops sending after the hourly limit', async () => {
    const meta = fakeMeta();
    await withApp(async (app, person) => {
      const { id } = await newLink(app, person);
      assert.equal((await app.post(`/api/capture/sessions/${id}/whatsapp`, { phone: '9000000001' }, person.headers)).status, 200);
      assert.equal((await app.post(`/api/capture/sessions/${id}/whatsapp`, { phone: '9000000002' }, person.headers)).status, 200);
      const over = await app.post(`/api/capture/sessions/${id}/whatsapp`, { phone: '9000000003' }, person.headers);
      assert.equal(over.status, 429);
      assert.equal(meta.sent.length, 2);
    }, { env: `${WA_ENV}CAPTURE_LIMIT_WHATSAPP=2\n`, capture: { fetch: meta.fetch } });
  });
});

describe('the pieces', () => {
  test('phone numbers become digits with a country code, or nothing', () => {
    assert.equal(normalizePhone('98765 43210', '91'), '919876543210');
    assert.equal(normalizePhone('098765 43210', '91'), '919876543210');
    assert.equal(normalizePhone('+44 20 7946 0958', '91'), '442079460958');
    assert.equal(normalizePhone('0044 20 7946 0958', '91'), '442079460958');
    assert.equal(normalizePhone('+91 (98765) 43210', '91'), '919876543210');
    for (const bad of ['', '12', 'abc', '+0123456789', '1'.repeat(16), '98765x43210', null, {}, '+']) assert.equal(normalizePhone(bad, '91'), null, String(bad));
  });

  test('labels and locations are cut down to what is allowed', () => {
    assert.deepEqual(cleanTags(['Room', ' cabin ', 'ROOM', 'a'.repeat(40), '<b>', 'Wall & floor', 5, null]), ['Room', 'cabin', 'a'.repeat(30), 'Wall & floor'], 'a long label is cut to 30 characters; repeats, markup and non-text are dropped');
    assert.deepEqual(cleanTags('x'), []);
    assert.equal(cleanTags(Array.from({ length: 20 }, (_, i) => `tag${i}`)).length, 8);
    const now = 1_800_000_000_000;
    assert.deepEqual(cleanLocation({ lat: 12.3456789, lng: -45.6789012, accuracy: 3.6, at: now }, now), { lat: 12.345679, lng: -45.678901, accuracy: 4, at: now });
    assert.equal(cleanLocation(undefined), null);
    assert.throws(() => cleanLocation({ lat: 0, lng: 181, at: now }, now), /not understood/);
  });
});

describe('metadata is taken out of the photo before it is stored', () => {
  const u16 = (n) => Buffer.from([(n >> 8) & 255, n & 255]);
  const segment = (marker, body) => Buffer.concat([Buffer.from([0xff, marker]), u16(body.length + 2), body]);

  test('a JPEG loses its Exif/GPS, XMP and comment blocks and keeps its picture, and what is appended after the end marker is cut', () => {
    const base = makeJpeg({ width: 640, height: 480, extra: 500 });
    const exif = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('GPSLatitude=28.6139;Make=SecretPhone')]));
    const xmp = segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>owner=Someone</x:xmpmeta>'));
    const comment = segment(0xfe, Buffer.from('taken at home'));
    const icc = segment(0xe2, Buffer.from('ICC_PROFILE\0\0\0keep-me'));
    const withMeta = Buffer.concat([base.subarray(0, 2), exif, xmp, comment, icc, base.subarray(2), Buffer.from('MOTION-PHOTO-VIDEO')]);
    const clean = stripMetadata(withMeta, 'image/jpeg');
    assert.ok(clean);
    const text = clean.toString('latin1');
    for (const gone of ['GPSLatitude', 'SecretPhone', 'xmpmeta', 'taken at home', 'MOTION-PHOTO']) assert.ok(!text.includes(gone), `${gone} is gone`);
    assert.ok(text.includes('JFIF') && text.includes('keep-me'), 'the JFIF header and the colour profile stay');
    assert.deepEqual(clean.subarray(-2), Buffer.from([0xff, 0xd9]));
    assert.ok(clean.length < withMeta.length);
  });

  test('a real photo from the repository comes out as the same picture, smaller or equal, still a JPEG', () => {
    const real = fs.readFileSync(path.join(ROOT, 'media', 'a01-hero.jpg'));
    const clean = stripMetadata(real, 'image/jpeg');
    assert.ok(clean && clean.length <= real.length);
    assert.deepEqual(clean.subarray(0, 2), Buffer.from([0xff, 0xd8]));
    assert.deepEqual(clean.subarray(-2), Buffer.from([0xff, 0xd9]));
  });

  test('a PNG loses its text and Exif blocks; a WebP loses EXIF and XMP and its flags', () => {
    const png = fs.readFileSync(path.join(ROOT, 'media', 'Terucon_logo.png'));
    const chunk = (type, data) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, 'latin1');
      return Buffer.concat([head, data, Buffer.alloc(4)]);
    };
    const at = 8 + 12 + png.readUInt32BE(8); // after IHDR
    const dirty = Buffer.concat([png.subarray(0, at), chunk('tEXt', Buffer.from('Author\0Someone Private')), chunk('eXIf', Buffer.from('GPSLongitude')), png.subarray(at)]);
    const clean = stripMetadata(dirty, 'image/png');
    assert.ok(clean);
    assert.ok(!clean.toString('latin1').includes('Someone Private') && !clean.toString('latin1').includes('GPSLongitude'));
    assert.equal(clean.length, png.length, 'the same file as before the blocks were added');

    const riff = (chunks) => {
      const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
      const head = Buffer.alloc(8);
      head.write('RIFF', 0, 'latin1');
      head.writeUInt32LE(body.length, 4);
      return Buffer.concat([head, body]);
    };
    const wchunk = (type, data) => {
      const head = Buffer.alloc(8);
      head.write(type, 0, 'latin1');
      head.writeUInt32LE(data.length, 4);
      return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const vp8x = Buffer.concat([Buffer.from([0x08 | 0x04 | 0x10, 0, 0, 0]), Buffer.from([0x1f, 0x03, 0x00, 0xdf, 0x01, 0x00])]);
    const vp8l = Buffer.concat([Buffer.from([0x2f]), Buffer.alloc(11, 1)]);
    const dirtyWebp = riff([wchunk('VP8X', vp8x), wchunk('VP8L', vp8l), wchunk('EXIF', Buffer.from('GPSLatitude=1')), wchunk('XMP ', Buffer.from('owner=Someone'))]);
    const cleanWebp = stripMetadata(dirtyWebp, 'image/webp');
    assert.ok(cleanWebp);
    const t = cleanWebp.toString('latin1');
    assert.ok(!t.includes('GPSLatitude') && !t.includes('owner=Someone') && !t.includes('EXIF') && !t.includes('XMP '));
    assert.equal(cleanWebp[20] & (0x08 | 0x04), 0, 'the EXIF and XMP flags are cleared');
    assert.equal(cleanWebp[20] & 0x10, 0x10, 'the other flags are kept');
    assert.equal(cleanWebp.readUInt32LE(4) + 8, cleanWebp.length, 'the size in the header is right');
  });

  test('damaged files are refused, not stored', () => {
    assert.equal(stripMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2, 3, 4, 5, 6]), 'image/jpeg'), null);
    assert.equal(stripMetadata(Buffer.concat([makeJpeg({ cut: true })]), 'image/jpeg'), null);
    assert.equal(stripMetadata(fs.readFileSync(path.join(ROOT, 'media', 'Terucon_logo.png')).subarray(0, 100), 'image/png'), null);
    assert.equal(stripMetadata(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8L'), 'image/webp'), null);
    assert.equal(stripMetadata(Buffer.from('hello'), 'image/gif'), null);
  });
});
