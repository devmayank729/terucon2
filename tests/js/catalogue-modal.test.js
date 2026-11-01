import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { waitFor } from '../helpers/http.js';
import { makeJpeg, SEED_ITEM_IDS, startCatalogueApp } from '../helpers/fakeCatalogueModal.js';

// The conversation with Modal: how its answers and failures become the site's, the cap on searches in flight, the hourly limits (and the
// admin changing them), the wake-up call, and the keys. Modal is a local fake that can be told to misbehave.

const clockAt = (t = 1_800_000_000_000) => {
  const clock = { t };
  clock.now = () => clock.t;
  return clock;
};
const setting = (c, patch) => c.app.app.locals.terucon.auth.settings.update(patch);

describe('how Modal\'s answers become ours', () => {
  const cases = [
    ['a refused key', { status: 401, reason: 'unauthorized' }, 503, 'modal-unavailable'],
    ['a forbidden key', { status: 403, reason: 'forbidden' }, 503, 'modal-unavailable'],
    ['a release that is not in storage', { status: 409, reason: 'release-missing' }, 409, 'release-missing'],
    ['a release the encoder cannot use', { status: 409, reason: 'feature-version-mismatch' }, 409, 'feature-version-mismatch'],
    ['a photo Modal cannot decode', { status: 400, reason: 'bad-image' }, 400, 'bad-image'],
    ['a photo Modal finds too large', { status: 413, reason: 'too-large' }, 413, 'too-large'],
    ['a full GPU queue, with a wait', { status: 503, reason: 'busy', retryAfter: 9 }, 503, 'busy', '9'],
    ['too many requests', { status: 429, reason: 'busy' }, 503, 'busy', '5'],
    ['an absurd wait is not believed', { status: 503, reason: 'busy', retryAfter: 100000 }, 503, 'busy', '5'],
    ['a server error', { status: 500, reason: 'internal' }, 503, 'modal-unavailable'],
    ['a route that is not there', { status: 404, reason: 'not-found' }, 503, 'modal-unavailable'],
    ['a complaint we do not know', { status: 400, reason: 'something-new' }, 503, 'modal-unavailable'],
    ['an answer that is not JSON', { raw: '<html>oops</html>' }, 503, 'modal-unavailable'],
    ['an answer with no results', { body: { ok: true } }, 503, 'modal-unavailable'],
    ['a connection that is dropped', { destroy: true }, 503, 'modal-unavailable'],
  ];

  test('each failure has its own status and reason, for photos and for words', async () => {
    const c = await startCatalogueApp();
    try {
      for (const [what, behaviour, status, reason, retry] of cases) {
        for (const [kind, send] of [['photo', () => c.photo()], ['text', () => c.text({ text: 'oak' })]]) {
          c.fake.next(kind === 'photo' ? 'search' : 'search-text', behaviour);
          const r = await send();
          assert.equal(r.status, status, `${what} (${kind})`);
          assert.equal(r.json().error.reason, reason, `${what} (${kind})`);
          assert.equal(r.headers['retry-after'], retry, `${what} (${kind}): Retry-After`);
          assert.equal(r.headers['cache-control'], 'no-store');
          assert.equal(r.text.includes(c.fake.key), false);
        }
      }
    } finally {
      await c.stop();
    }
  });

  test('a refused key is logged once, in words that do not repeat the key, and the visitor is told nothing about it', async () => {
    const c = await startCatalogueApp();
    try {
      for (let i = 0; i < 3; i += 1) {
        c.fake.next('search', { status: 401, reason: 'unauthorized' });
        const r = await c.photo();
        assert.equal(r.json().error.reason, 'modal-unavailable');
        assert.doesNotMatch(r.json().error.message, /key|401|403|token|bearer|auth/i);
      }
      const lines = c.app.log.lines.filter((l) => /refused our key/.test(l));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].includes(c.fake.key), false);
    } finally {
      await c.stop();
    }
  });

  test('a wrong key in .env is the same story, and the key is sent as a bearer token to the one address only', async () => {
    const c = await startCatalogueApp({ env: { CATALOGUE_MODAL_KEY: 'a-wrong-key-123456' } });
    try {
      const r = await c.photo();
      assert.equal(r.status, 503);
      assert.equal(r.json().error.reason, 'modal-unavailable');
      assert.equal(c.fake.of('search')[0].authorized, false);
    } finally {
      await c.stop();
    }
  });

  test('the Modal proxy key and secret are sent when both are set, and only then', async () => {
    const proxy = { key: 'proxy-key-abcdefghij', secret: 'proxy-secret-klmnopqrst' };
    const c = await startCatalogueApp({ modal: { proxy } });
    try {
      assert.equal((await c.photo()).status, 200);
      assert.equal(c.fake.of('search')[0].sentProxyHeaders, true);
      c.app.writeEnv(c.fake.env({ CATALOGUE_MODAL_PROXY_SECRET: '' }));
      assert.match(c.app.app.locals.terucon.settings().warnings.join('\n'), /PROXY_KEY and CATALOGUE_MODAL_PROXY_SECRET go together/);
      const r = await c.photo();
      assert.equal(r.status, 503, 'the fake wants both');
      assert.equal(c.fake.of('search')[1].sentProxyHeaders, false);
    } finally {
      await c.stop();
    }
  });
});

describe('a slow Modal', () => {
  test('no answer in time is a cold start ("warming", ask again in 5 seconds) until Modal has answered lately; then it is a slow search', async () => {
    const clock = clockAt();
    const c = await startCatalogueApp({ now: clock.now, rawEnv: 'CATALOGUE_MODAL_TIMEOUT_MS=300\n' });
    try {
      c.fake.next('search', { hang: true });
      const t0 = Date.now();
      const cold = await c.photo();
      assert.ok(Date.now() - t0 < 5000);
      assert.equal(cold.status, 503);
      assert.equal(cold.json().error.reason, 'warming');
      assert.equal(cold.headers['retry-after'], '5');
      assert.equal((await c.photo()).status, 200, 'it was starting: now it answers');
      c.fake.next('search', { hang: true });
      const slow = await c.photo();
      assert.equal(slow.status, 504);
      assert.equal(slow.json().error.reason, 'modal-timeout');
      clock.t += 6 * 60 * 1000;
      c.fake.next('search', { hang: true });
      assert.equal((await c.photo()).json().error.reason, 'warming', 'five quiet minutes later it may have gone to sleep');
    } finally {
      await c.stop();
    }
  });

  test('a connection that is refused is "not available", straight away', async () => {
    const c = await startCatalogueApp({ env: { CATALOGUE_MODAL_SEARCH_URL: 'http://127.0.0.1:1' } });
    try {
      const t0 = Date.now();
      const r = await c.photo();
      assert.ok(Date.now() - t0 < 5000);
      assert.equal(r.status, 503);
      assert.equal(r.json().error.reason, 'modal-unavailable');
      assert.equal(r.headers['retry-after'], undefined);
    } finally {
      await c.stop();
    }
  });
});

describe('the cap on searches in flight', () => {
  test('beyond catalogue.maxConcurrent a search is told "busy" without reaching Modal, and Modal sees only the cap', async () => {
    const c = await startCatalogueApp();
    try {
      await setting(c, { 'catalogue.maxConcurrent': 2 });
      c.fake.hold();
      const finished = [];
      const sent = Array.from({ length: 5 }, () => c.photo().then((r) => (finished.push(r), r)));
      await c.fake.waitForInFlight(2);
      await waitFor(() => finished.length === 3, { what: 'the three turned away' });
      for (const r of finished) {
        assert.equal(r.status, 503);
        assert.equal(r.json().error.reason, 'busy');
        assert.ok(Number(r.headers['retry-after']) >= 1);
      }
      assert.equal(c.fake.of('search').length, 2, 'Modal heard of two');
      c.fake.release();
      const all = await Promise.all(sent);
      assert.equal(all.filter((r) => r.status === 200).length, 2);
      assert.equal(c.fake.maxInFlight(), 2);
      assert.equal(c.app.app.locals.terucon.catalogue.service.inFlight(), 0, 'every place was given back');
      // raising the cap applies at once
      await setting(c, { 'catalogue.maxConcurrent': 4 });
      c.fake.hold();
      const more = Array.from({ length: 4 }, () => c.photo());
      await c.fake.waitForInFlight(4);
      c.fake.release();
      assert.ok((await Promise.all(more)).every((r) => r.status === 200));
    } finally {
      await c.stop();
    }
  });

  test('a search that was turned away as busy does not use up the visitor\'s hour', async () => {
    const c = await startCatalogueApp();
    try {
      await setting(c, { 'catalogue.maxConcurrent': 1, 'catalogue.limit.searchPerHour': 2, 'catalogue.limit.addressFactor': 100 });
      c.fake.hold();
      const first = c.photo();
      await c.fake.waitForInFlight(1);
      assert.equal((await c.photo()).json().error.reason, 'busy');
      c.fake.release();
      assert.equal((await first).status, 200);
      assert.equal((await c.photo()).status, 200, 'the second counted search');
      assert.equal((await c.photo()).status, 429, 'two have been counted, the busy one was not');
    } finally {
      await c.stop();
    }
  });
});

describe('the hourly limits', () => {
  test('per account: the limit is enforced, answered with Retry-After, and the admin can change it', async () => {
    const clock = clockAt();
    const c = await startCatalogueApp({ now: clock.now });
    try {
      await setting(c, { 'catalogue.limit.searchPerHour': 3, 'catalogue.limit.addressFactor': 100 });
      for (let i = 0; i < 3; i += 1) assert.equal((await c.photo()).status, 200);
      const refused = await c.photo();
      assert.equal(refused.status, 429);
      assert.equal(refused.json().error.reason, 'rate-limited');
      assert.equal(refused.json().error.status, 'RESOURCE_EXHAUSTED');
      assert.ok(Number(refused.headers['retry-after']) > 0 && Number(refused.headers['retry-after']) <= 3600);
      assert.equal(refused.json().error.retryAfter, Number(refused.headers['retry-after']));
      assert.equal(c.fake.of('search').length, 3, 'the refused search never reached Modal');
      const other = await c.app.signIn();
      assert.equal((await c.photo(makeJpeg(), { as: other })).status, 200, 'another account is not affected');
      await setting(c, { 'catalogue.limit.searchPerHour': 5 });
      assert.equal((await c.photo()).status, 200, 'raised: effective at once');
      assert.equal((await c.photo()).status, 200);
      assert.equal((await c.photo()).status, 429);
      await setting(c, { 'catalogue.limit.searchPerHour': 1 });
      assert.equal((await c.photo()).status, 429, 'lowered: effective at once');
      clock.t += 61 * 60 * 1000;
      assert.equal((await c.photo()).status, 200, 'an hour later the window has moved on');
      // an out-of-bounds value is refused by the admin API, not stored
      await assert.rejects(() => setting(c, { 'catalogue.limit.searchPerHour': 0 }), /between 1 and 100000/);
      await assert.rejects(() => setting(c, { 'catalogue.maxConcurrent': 500 }), /between 1 and 32/);
    } finally {
      await c.stop();
    }
  });

  test('per address: several accounts behind one address share limit times the factor', async () => {
    const c = await startCatalogueApp();
    try {
      await setting(c, { 'catalogue.limit.searchPerHour': 2, 'catalogue.limit.addressFactor': 2 });
      const here = { 'X-Forwarded-For': '203.0.113.9' };
      const [a, b, third] = [await c.app.signIn(), await c.app.signIn(), await c.app.signIn()];
      for (let i = 0; i < 2; i += 1) assert.equal((await c.photo(makeJpeg(), { as: a, headers: here })).status, 200);
      assert.equal((await c.photo(makeJpeg(), { as: a, headers: here })).status, 429, 'this account is done');
      for (let i = 0; i < 2; i += 1) assert.equal((await c.photo(makeJpeg(), { as: b, headers: here })).status, 200);
      const full = await c.photo(makeJpeg(), { as: third, headers: here });
      assert.equal(full.status, 429, 'the address has used up 2 x 2, whoever asks');
      assert.equal((await c.photo(makeJpeg(), { as: third, headers: { 'X-Forwarded-For': '198.51.100.20' } })).status, 200, 'the same account from another address');
      assert.equal(c.fake.of('search').length, 5);
    } finally {
      await c.stop();
    }
  });

  test('text searches and wake-ups have limits of their own', async () => {
    const c = await startCatalogueApp();
    try {
      await setting(c, { 'catalogue.limit.textPerHour': 2, 'catalogue.limit.warmPerHour': 2, 'catalogue.limit.addressFactor': 100 });
      assert.deepEqual([await c.text({ text: 'oak' }), await c.text({ text: 'oak' }), await c.text({ text: 'oak' })].map((r) => r.status), [200, 200, 429]);
      assert.equal((await c.photo()).status, 200, 'photo searches are counted apart');
      const warm = () => c.app.post('/api/catalogue/warm', {}, c.me.headers);
      assert.deepEqual([await warm(), await warm(), await warm()].map((r) => r.status), [202, 202, 429]);
    } finally {
      await c.stop();
    }
  });
});

describe('waking Modal', () => {
  test('a wake-up is one call to /healthz that nobody waits for; at most one a minute; several at once are one', async () => {
    const clock = clockAt();
    const c = await startCatalogueApp({ now: clock.now });
    try {
      c.fake.next('healthz-search', { delayMs: 300 });
      const burst = await Promise.all([1, 2, 3, 4].map(() => c.app.post('/api/catalogue/warm', {}, c.me.headers)));
      for (const r of burst) {
        assert.equal(r.status, 202);
        assert.deepEqual(r.json(), { ok: true });
      }
      await waitFor(() => c.fake.of('healthz-search').length >= 1, { what: 'the wake-up' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(c.fake.of('healthz-search').length, 1, 'one call for four requests');
      assert.equal((await c.app.post('/api/catalogue/warm', {}, c.me.headers)).status, 202);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(c.fake.of('healthz-search').length, 1, 'less than a minute since the last: Modal is not called again');
      clock.t += 61_000;
      assert.equal((await c.app.post('/api/catalogue/warm', {}, c.me.headers)).status, 202);
      await waitFor(() => c.fake.of('healthz-search').length === 2, { what: 'the next wake-up' });
      assert.equal(c.fake.of('search').length, 0);
      assert.equal(c.fake.of('healthz-ingest').length, 0, 'only the search service is woken');
    } finally {
      await c.stop();
    }
  });

  test('nothing is woken when there is nothing to search, a failing Modal does not matter, and JSON is required', async () => {
    const empty = await startCatalogueApp({ seed: false });
    try {
      assert.equal((await empty.app.post('/api/catalogue/warm', {}, empty.me.headers)).status, 202);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(empty.fake.requests.length, 0, 'no live catalogue: the GPU is not started for nothing');
    } finally {
      await empty.stop();
    }
    const c = await startCatalogueApp();
    try {
      c.fake.next('healthz-search', { destroy: true });
      assert.equal((await c.app.post('/api/catalogue/warm', {}, c.me.headers)).status, 202);
      assert.equal((await c.app.request('/api/catalogue/warm', { method: 'POST', headers: c.me.headers })).status, 415);
      assert.equal((await c.app.get('/api/catalogue/warm', c.me.headers)).status, 405);
    } finally {
      await c.stop();
    }
    const off = await startCatalogueApp({ rawEnv: 'CATALOGUE=off\n' });
    try {
      const r = await off.app.post('/api/catalogue/warm', {}, off.me.headers);
      assert.equal(r.status, 503);
      assert.equal(r.json().error.reason, 'catalogue-off');
    } finally {
      await off.stop();
    }
  });
});

test('the fake is canned: the same ids in the same order, every time', async () => {
  const c = await startCatalogueApp();
  try {
    const a = (await c.photo(makeJpeg(), { query: 'k=12' })).json().items.map((i) => i.itemId);
    const b = (await c.photo(makeJpeg(), { query: 'k=12' })).json().items.map((i) => i.itemId);
    assert.deepEqual(a, SEED_ITEM_IDS);
    assert.deepEqual(b, a);
  } finally {
    await c.stop();
  }
});
