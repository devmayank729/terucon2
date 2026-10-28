import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { startMockModal } from '../helpers/mockModal.js';
import { makeStudioDir, setStudioEnv } from '../helpers/studio.js';

// A wake-up that fails must look like one. The studio's own wake-up (lib/wake.js) records ANY answer to /healthz as a success,
// a 401 from a wrong key or a 404 from a stale address included; the website runs it on every cold visit now, so without
// server/lib/swatchroom.js's check a wrong key would show the service as warm for five minutes (the start-up gate and the
// owner's dot both read that record). Here the scan pool is given the wrong key; the analysis pool is fine.

const oneformer = await startMockModal({ key: 'the-real-key', bootMs: 50 });
const analyze = await startMockModal({ key: 'key-analyze', bootMs: 50 });
setStudioEnv({
  ONEFORMER_URL: `${oneformer.url}/v1/parse`,
  ONEFORMER_KEY: 'a-wrong-key',
  ANALYZE_URL: `${analyze.url}/v1/analyze`,
  ANALYZE_KEY: 'key-analyze',
});
const fixture = makeStudioDir();
const { loadSwatchroom } = await import('../../server/lib/swatchroom.js');
const studio = loadSwatchroom({ dir: fixture.dir, log: { info() {}, warn() {} } });
const need = createRequire(path.join(fixture.dir, 'server', 'index.js'));
const warmth = need('./lib/warmth.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(' '));

test.after(async () => {
  console.warn = realWarn;
  await studio.close();
  await oneformer.close();
  await analyze.close();
  fixture.remove();
});

test('a pool that answers 401 is not warm; the one that answers 200 is', async () => {
  assert.deepEqual([...studio.warm()].sort(), ['analyze', 'oneformer']);
  await sleep(400);
  const s = warmth.status();
  assert.equal(s.pools.analyze.warm, true);
  assert.equal(s.pools.oneformer.warm, false, 'a refused /healthz must not count as warm');
  assert.equal(s.warm, false, 'the scan pool decides the start-up gate');
  assert.equal(s.state, 'unknown', 'never reached it, as far as the record goes');
  assert.ok(warnings.some((w) => /Warm-up ping to oneformer failed: \/healthz answered 401/.test(w)), warnings.join('\n'));
});

test('the next visit tries the failed pool again, and only that one', async () => {
  const before = { oneformer: oneformer.hits.length, analyze: analyze.hits.length };
  assert.deepEqual(studio.warm(), ['oneformer']);
  await sleep(300);
  assert.equal(oneformer.hits.length, before.oneformer + 1);
  assert.equal(analyze.hits.length, before.analyze, 'the warm pool is left alone');
  assert.equal(warmth.status().warm, false);
});
