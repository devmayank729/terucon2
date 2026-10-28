import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { startMockModal } from '../helpers/mockModal.js';
import { makeStudioDir, setStudioEnv } from '../helpers/studio.js';

// The cold start, with the swatchroom's own code (its wake-up, its warmth record, the clock the studio's start-up gate reads)
// and mock GPU pools in place of Modal. Nothing real is called: the studio folder has no .env.

const oneformer = await startMockModal({ key: 'key-oneformer', bootMs: 250 });
const analyze = await startMockModal({ key: 'key-analyze', bootMs: 250 });
setStudioEnv({
  ONEFORMER_URL: `${oneformer.url}/v1/parse`,
  ONEFORMER_KEY: 'key-oneformer',
  ANALYZE_URL: `${analyze.url}/v1/analyze`,
  ANALYZE_KEY: 'key-analyze',
  // the three separate pipeline URLs are set too: with ANALYZE_URL set the pipeline must not wake them
  SAM3_URL: 'http://127.0.0.1:2/v1/segment',
  MOGE2_URL: 'http://127.0.0.1:2/v1/geometry',
  MARIGOLD_URL: 'http://127.0.0.1:2/v1/decompose',
  STUDIO_PASSCODE: 'letmein',
});
const fixture = makeStudioDir();
const { loadSwatchroom } = await import('../../server/lib/swatchroom.js');
const log = { info() {}, warn() {} };
const studio = loadSwatchroom({ dir: fixture.dir, log, requirePasscode: true });
const need = createRequire(path.join(fixture.dir, 'server', 'index.js'));
const warmth = need('./lib/warmth.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.after(async () => {
  await studio.close();
  await oneformer.close();
  await analyze.close();
  fixture.remove();
});

test('before anything happens the studio\'s own record says the scan pool is not warm', () => {
  const s = warmth.status();
  assert.equal(s.configured, true);
  assert.equal(s.warm, false);
  assert.equal(s.state, 'unknown');
});

test('warm() starts the scan pool AND the room-analysis pool, once each, and nothing else', async () => {
  const started = studio.warm();
  assert.deepEqual([...started].sort(), ['analyze', 'oneformer']);
  // the record the start-up gate reads says "starting" while the pools boot, not "cold"
  const during = warmth.status();
  assert.equal(during.warm, false);
  assert.equal(during.state, 'waking');
  assert.equal(during.pools.analyze.state, 'waking');
  // a second ask while they boot starts nothing and sends nothing
  assert.deepEqual(studio.warm(), []);
  await sleep(700);
  assert.deepEqual(oneformer.hits.map((h) => h.path), ['/healthz']);
  assert.deepEqual(analyze.hits.map((h) => h.path), ['/healthz']);
  assert.ok(oneformer.hits[0].authorized && analyze.hits[0].authorized, 'each pool was asked with its own key');
});

test('after the pools answer, the studio\'s start-up gate sees a warm pool, and asking again costs nothing', () => {
  const s = warmth.status();
  assert.equal(s.warm, true, 'GET /api/vision/warmup would say warm');
  assert.equal(s.state, 'warm');
  assert.equal(s.pools.analyze.warm, true);
  assert.deepEqual(studio.warm(), []);
  assert.equal(oneformer.hits.length, 1);
  assert.equal(analyze.hits.length, 1);
});

test('the separate SAM 3 / MoGe-2 / Marigold pools are left alone when the combined analysis pool is set', () => {
  // they point at a closed port: had warm() touched them, the studio's record for them would not be "unknown"
  const s = warmth.status();
  for (const pool of ['sam3', 'moge2', 'marigold']) assert.equal(s.pools[pool].state, 'unknown', pool);
});
