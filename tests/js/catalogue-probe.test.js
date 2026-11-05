import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { createModalClient } from '../../server/catalogue/modalClient.js';
import { runJobs } from '../../tools/catalogue-probe.mjs';
import { FAKE_KEY, SEED_RELEASE, makeJpeg, startFakeCatalogueModal } from '../helpers/fakeCatalogueModal.js';

// tools/catalogue-probe.mjs sends photos to the search app and keeps the raw answers (catalogue/ARCHITECTURE.md section 5.1). Run against the fake Modal.

async function withProbe(fn) {
  const fake = await startFakeCatalogueModal();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  const modal = createModalClient({ target: () => ({ searchUrl: fake.searchUrl, ingestUrl: fake.ingestUrl, timeoutMs: 5000, key: FAKE_KEY, proxyKey: '', proxySecret: '' }), log: { warn() {}, info() {} } });
  const lines = [];
  try {
    fs.writeFileSync(path.join(dir, 'a.jpg'), makeJpeg());
    return await fn({ fake, dir, modal, lines, print: (l) => lines.push(l), out: path.join(dir, 'answers') });
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('the probe', () => {
  test('sends each job as the search app is meant to be asked, keeps the raw answer, and says what it did', async () => {
    await withProbe(async ({ fake, dir, modal, lines, print, out }) => {
      const jobs = [
        { name: 'patch', file: 'a.jpg', query: { profile: 'balanced', k: 60, box: [0, 0, 1, 1] } },
        { name: 'whole', file: 'a.jpg', query: {} },
        { name: 'words', text: 'light oak wood laminate', query: { k: 40 } },
      ];
      const r = await runJobs({ jobs, dir, out, modal, release: SEED_RELEASE, print });
      assert.deepEqual([r.calls, r.saved, r.failed], [3, ['patch', 'whole', 'words'], []]);
      const [patch, whole] = fake.of('search');
      assert.deepEqual(patch.query, { catalogue: 'superbond-colour', release: SEED_RELEASE, mode: 'look', profile: 'balanced', k: '60', box: '0,0,1,1' });
      assert.deepEqual([whole.query.profile, whole.query.k, whole.query.box], ['full', '60', undefined], 'the defaults: the fullest profile and every row, so one answer can be re-fused');
      assert.deepEqual(fake.of('search-text')[0].json, { catalogue: 'superbond-colour', release: SEED_RELEASE, text: 'light oak wood laminate', k: 40 });
      const saved = JSON.parse(fs.readFileSync(path.join(out, 'patch.json'), 'utf8'));
      assert.deepEqual([saved.job.name, saved.answer.ok, saved.answer.results.length > 0], ['patch', true, true]);
      assert.match(lines.join('\n'), /patch \d+ ms region \d+ results, first .* 0 warnings/);
      assert.equal(lines.join('\n').includes(FAKE_KEY), false, 'the key is never printed');
      assert.equal(lines.at(-1), 'live calls made: 3');
    });
  });

  test('an answer already kept is not asked for again, unless --again', async () => {
    await withProbe(async ({ fake, dir, modal, print, out }) => {
      const jobs = [{ name: 'one', file: 'a.jpg', query: {} }];
      await runJobs({ jobs, dir, out, modal, release: SEED_RELEASE, print });
      const second = await runJobs({ jobs, dir, out, modal, release: SEED_RELEASE, print });
      assert.deepEqual([second.calls, second.skipped], [0, ['one']]);
      const third = await runJobs({ jobs, dir, out, modal, release: SEED_RELEASE, print, again: true });
      assert.equal(third.calls, 1);
      assert.equal(fake.of('search').length, 2);
    });
  });

  test('a busy or waking search app is asked again (at most 3 times), anything else is a failure that does not stop the rest', async () => {
    await withProbe(async ({ fake, dir, modal, lines, print, out }) => {
      const sleeps = [];
      const sleep = async (ms) => sleeps.push(ms);
      fake.next('search', { status: 503, reason: 'busy', retryAfter: 2 });
      fake.next('search', { status: 503, reason: 'busy', retryAfter: 2 });
      const patient = await runJobs({ jobs: [{ name: 'patient', file: 'a.jpg', query: {} }], dir, out, modal, release: SEED_RELEASE, print, sleep });
      assert.deepEqual([patient.calls, patient.saved, sleeps], [3, ['patient'], [2000, 2000]], 'it waited as long as the service asked, then the third try was answered');

      fake.next('search', { status: 503, reason: 'busy', retryAfter: 1 });
      fake.next('search', { status: 503, reason: 'busy', retryAfter: 1 });
      fake.next('search', { status: 503, reason: 'busy', retryAfter: 1 });
      const hopeless = await runJobs({ jobs: [{ name: 'hopeless', file: 'a.jpg', query: {} }], dir, out, modal, release: SEED_RELEASE, print, sleep });
      assert.deepEqual([hopeless.calls, hopeless.failed], [3, ['hopeless']], 'three tries and no more');

      fake.next('search', { status: 400, reason: 'bad-image' });
      const rest = await runJobs({ jobs: [{ name: 'refused', file: 'a.jpg', query: {} }, { name: 'after', file: 'a.jpg', query: {} }], dir, out, modal, release: SEED_RELEASE, print, sleep });
      assert.deepEqual([rest.calls, rest.failed, rest.saved], [2, ['refused'], ['after']], 'a refusal is not retried, and the next job still runs');
      assert.match(lines.join('\n'), /FAILED refused/);
      assert.equal(fs.existsSync(path.join(out, 'refused.json')), false);
    });
  });

  test('a job without a plain name, or a photo of another kind, is refused before anything is sent', async () => {
    await withProbe(async ({ fake, dir, modal, print, out }) => {
      await assert.rejects(() => runJobs({ jobs: [{ name: '../escape', file: 'a.jpg' }], dir, out, modal, release: SEED_RELEASE, print }), /plain name/);
      const r = await runJobs({ jobs: [{ name: 'gif', file: 'a.gif' }], dir, out, modal, release: SEED_RELEASE, print });
      assert.deepEqual(r.failed, ['gif']);
      assert.equal(fake.of('search').length, 0);
      assert.equal(fs.existsSync(path.join(dir, '..', 'escape.json')), false);
    });
  });
});
