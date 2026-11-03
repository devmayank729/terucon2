import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { startTestApp } from '../helpers/app.js';

// Every page asks GET /api/auth/me once (the header's account button). It counts in a bucket of its own, with five times the room of
// the general sign-in ceiling, so a household or an office behind one address cannot lock itself out of the pages by opening them.

let app;
before(async () => {
  app = await startTestApp();
});
after(() => app.stop());

test('one address may ask who is signed in far more than 120 times a minute, and is still limited at last', async () => {
  const ip = { 'X-Forwarded-For': '10.210.0.1' };
  let refused = 0;
  let firstRefusal = 0;
  for (let i = 1; i <= 620; i += 1) {
    const r = await app.request('/api/auth/me', { headers: ip });
    if (r.status === 429) {
      refused += 1;
      firstRefusal ||= i;
    } else assert.equal(r.status, 200, `request ${i}`);
  }
  assert.equal(firstRefusal, 601, 'the 601st in a minute is the first refused (5 x the general 120)');
  assert.equal(refused, 20);
});

test('the general ceiling of the other sign-in routes is unchanged (the bucket is separate)', async () => {
  const ip = { 'X-Forwarded-For': '10.210.0.2' };
  for (let i = 0; i < 130; i += 1) await app.request('/api/auth/me', { headers: ip });
  const r = await app.request('/api/auth/config', { headers: ip });
  assert.equal(r.status, 200, 'asking who is signed in does not use up the room of the other routes');
});
