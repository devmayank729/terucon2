import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';
import express from 'express';
import { RateLimiter } from '../../server/lib/rateLimit.js';
import { limitGroup, OWNER_COOKIE, studioShield } from '../../server/lib/studioShield.js';
import { request } from '../helpers/http.js';

// The shield in front of the studio, with an in-memory room store and a stand-in for the studio behind it. What it must do: give
// each browser only its own rooms, count the routes that cost money, and touch nothing else.

function fakeStore({ ready = true } = {}) {
  const owners = new Map(); // id -> owner
  const rooms = new Map(); // id -> summary (a room can exist with no owner: an older room)
  return {
    owners,
    rooms,
    ready: () => ready,
    ownerOf: async (id) => owners.get(id) ?? null,
    roomExists: async (id) => rooms.has(id),
    claim: async (id, owner) => {
      if (owners.has(id)) return false;
      owners.set(id, owner);
      return true;
    },
    release: async (id) => void owners.delete(id),
    listOwned: async (owner) => [...owners].filter(([, o]) => o === owner).map(([id]) => rooms.get(id) ?? { id }),
  };
}

let clock = 1_000_000;
const limits = { ai: 3, vision: 3, pipeline: 3, check: 2, rooms: 5, perAddress: 2 };
const store = fakeStore();
const shield = studioShield({ store, limits: () => limits, now: () => clock });
let server;
let port;
const reached = [];

before(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(shield);
  // the studio behind it: answers every call, and says it was reached
  app.use((req, res) => {
    reached.push(`${req.method} ${req.path}`);
    if (req.method === 'PUT' && req.path.startsWith('/api/rooms/')) store.rooms.set(req.path.split('/')[3], { id: req.path.split('/')[3] });
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

/** A browser: keeps its cookie, and can claim to come from an address. */
function browser(address = '10.0.0.1') {
  let cookie = '';
  return {
    async call(method, path, options = {}) {
      const r = await request(port, { method, path, headers: { 'X-Forwarded-For': address, ...(cookie && { Cookie: cookie }), ...options.headers }, body: options.body });
      for (const line of r.headers['set-cookie'] ?? []) if (line.startsWith(OWNER_COOKIE + '=')) cookie = line.split(';')[0];
      return r;
    },
    get cookie() {
      return cookie;
    },
  };
}

test('which requests are counted: what costs money or writes, never a read', () => {
  assert.equal(limitGroup('POST', '/api/ai/generate'), 'ai');
  assert.equal(limitGroup('POST', '/api/vision/segment'), 'vision');
  assert.equal(limitGroup('POST', '/api/pipeline/analyze'), 'pipeline');
  assert.equal(limitGroup('POST', '/api/check'), 'check');
  assert.equal(limitGroup('PUT', '/api/rooms/room-abcd/files/photo'), 'rooms');
  assert.equal(limitGroup('DELETE', '/api/rooms/room-abcd'), 'rooms');
  for (const [method, path] of [['GET', '/api/rooms'], ['GET', '/api/pipeline/jobs/x'], ['GET', '/api/vision/warmup'], ['GET', '/api/session'], ['POST', '/api/session'], ['POST', '/api/aiXYZ'], ['POST', '/api/admin/login']]) {
    assert.equal(limitGroup(method, path), null, `${method} ${path}`);
  }
});

test('a browser gets a private owner cookie that JavaScript cannot read', async () => {
  const b = browser();
  const r = await b.call('GET', '/api/session');
  const line = r.headers['set-cookie'].find((c) => c.startsWith(OWNER_COOKIE + '='));
  assert.match(line, /^terucon_owner=[a-f0-9]{32};/);
  assert.match(line, /HttpOnly/i);
  assert.match(line, /SameSite=Lax/i);
  const again = await b.call('GET', '/api/session');
  assert.equal(again.headers['set-cookie']?.some((c) => c.startsWith(OWNER_COOKIE)) ?? false, false, 'a browser that has one keeps it');
});

test('a forged or malformed owner cookie is replaced, not trusted', async () => {
  const r = await request(port, { path: '/api/session', headers: { Cookie: `${OWNER_COOKIE}=../../etc` } });
  assert.match(r.headers['set-cookie'].join(), /terucon_owner=[a-f0-9]{32}/);
});

test('each browser sees only its own rooms: list, open, change, delete', async () => {
  const alice = browser('10.1.0.1');
  const bob = browser('10.1.0.2');
  assert.equal((await alice.call('PUT', '/api/rooms/room-alice01', { body: { name: 'Mine' } })).status, 200);
  assert.equal(store.owners.get('room-alice01') != null, true);

  const mine = (await alice.call('GET', '/api/rooms')).json();
  assert.deepEqual(mine.rooms.map((r) => r.id), ['room-alice01']);
  assert.deepEqual((await bob.call('GET', '/api/rooms')).json().rooms, [], 'the list is empty for somebody else');

  reached.length = 0;
  for (const [method, path] of [['GET', '/api/rooms/room-alice01'], ['GET', '/api/rooms/room-alice01/files/photo'], ['PUT', '/api/rooms/room-alice01'], ['DELETE', '/api/rooms/room-alice01'], ['PUT', '/api/rooms/room-alice01/files/photo']]) {
    const r = await bob.call(method, path, method === 'PUT' ? { body: {} } : {});
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.deepEqual(r.json(), { error: 'That room is not saved here.' }, 'the studio\'s own words for a room that is not there');
  }
  assert.deepEqual(reached, [], 'none of those reached the studio');
  assert.equal((await alice.call('GET', '/api/rooms/room-alice01')).status, 200);
  assert.equal(store.owners.get('room-alice01') != null, true, 'still there');

  assert.equal((await alice.call('DELETE', '/api/rooms/room-alice01')).status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(store.owners.has('room-alice01'), false, 'deleting a room frees its record');
});

test('two browsers saving the same new room id at once: one wins, the other is refused', async () => {
  const a = browser('10.2.0.1');
  const b = browser('10.2.0.2');
  const [ra, rb] = await Promise.all([a.call('PUT', '/api/rooms/room-race001', { body: {} }), b.call('PUT', '/api/rooms/room-race001', { body: {} })]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 404]);
});

test('a room saved before the shield existed has no owner and is hidden from everybody', async () => {
  store.rooms.set('room-old00001', { id: 'room-old00001' });
  const b = browser('10.3.0.1');
  assert.equal((await b.call('GET', '/api/rooms/room-old00001')).status, 404);
  assert.equal((await b.call('PUT', '/api/rooms/room-old00001', { body: {} })).status, 404, 'cannot take it over either');
  assert.equal((await b.call('DELETE', '/api/rooms/room-old00001')).status, 404);
  assert.deepEqual((await b.call('GET', '/api/rooms')).json().rooms, []);
  assert.equal(store.rooms.has('room-old00001'), true, 'and it is untouched');
});

test('a room id the studio would refuse goes to the studio, which says so itself', async () => {
  reached.length = 0;
  const b = browser('10.4.0.1');
  assert.equal((await b.call('GET', '/api/rooms/NOT_AN_ID')).status, 200);
  assert.deepEqual(reached, ['GET /api/rooms/NOT_AN_ID']);
});

test('every costly route is limited per browser, with Retry-After and a plain message; reads are free', async () => {
  const b = browser('10.5.0.1');
  for (let i = 0; i < limits.ai; i += 1) assert.equal((await b.call('POST', '/api/ai/generate', { body: {} })).status, 200);
  const blocked = await b.call('POST', '/api/ai/generate', { body: {} });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal(blocked.json().code, 'rate-limit');
  assert.match(blocked.json().error, /wait a few minutes/i);
  assert.equal((await b.call('POST', '/api/vision/segment', { body: {} })).status, 200, 'another group is counted on its own');
  for (let i = 0; i < 20; i += 1) assert.equal((await b.call('GET', '/api/pipeline/jobs/abc')).status, 200);
  clock += 3600001;
  assert.equal((await b.call('POST', '/api/ai/generate', { body: {} })).status, 200, 'an hour later it is allowed again');
});

test('clearing cookies does not help: the address has its own, looser limit', async () => {
  const address = '10.6.0.1';
  let refused = 0;
  for (let i = 0; i < limits.ai * limits.perAddress + 2; i += 1) {
    const fresh = browser(address); // a new browser (no cookie) every time
    if ((await fresh.call('POST', '/api/ai/generate', { body: {} })).status === 429) refused += 1;
  }
  assert.equal(refused, 2);
  assert.equal((await browser('10.6.0.2').call('POST', '/api/ai/generate', { body: {} })).status, 200, 'another address is not affected');
});

test('what is not the studio\'s API is not touched', async () => {
  const r = await request(port, { path: '/design-studio' });
  assert.equal(r.headers['set-cookie'], undefined);
});

test('without a database the shield steps aside (the studio cannot save or list rooms then either)', async () => {
  const quiet = fakeStore({ ready: false });
  const down = studioShield({ store: quiet, limits: () => limits });
  const app = express();
  app.use(down);
  app.use((req, res) => res.json({ studio: true }));
  const s = http.createServer(app);
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  try {
    const r = await request(s.address().port, { path: '/api/rooms' });
    assert.deepEqual(r.json(), { studio: true });
  } finally {
    down.close();
    await new Promise((resolve) => (s.closeAllConnections(), s.close(resolve)));
  }
});

test('RateLimiter: counts inside a window, reports when to come back, forgets old keys', () => {
  let t = 0;
  const limiter = new RateLimiter({ windowMs: 1000, now: () => t });
  try {
    limiter.record('k');
    limiter.record('k');
    assert.deepEqual(limiter.check('k', 2), { ok: false, retryAfter: 1 });
    assert.equal(limiter.check('k', 3).ok, true);
    t = 1001;
    assert.equal(limiter.check('k', 1).ok, true);
    assert.equal(limiter.size, 0);
  } finally {
    limiter.close();
  }
});
