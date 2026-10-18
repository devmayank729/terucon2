// A regression guard that needs nothing outside the repository: rebuild in memory and compare the sha256 of every decoded
// template and every decompressed asset with tests/fixtures/pages-golden.json (written by `node tools/build-site.js --write-golden`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bundle } from '../../tools/bundle.js';
import { GOLDEN_FILE, digestBundle, goldenDocument } from '../../tools/build-site.js';
import { PAGE_KEYS, ROOT, SITE, memoBuild } from './site-helpers.js';

const golden = JSON.parse(fs.readFileSync(path.join(ROOT, GOLDEN_FILE), 'utf8'));
const HINT = '\nIf the change is intended: review the pages, then run `node tools/build-site.js --write-golden` and commit tests/fixtures/pages-golden.json.';

test('the golden file lists every page with its templates and assets', () => {
  assert.equal(golden.format, 1);
  assert.deepEqual(Object.keys(golden.pages), PAGE_KEYS);
  for (const [key, page] of Object.entries(golden.pages)) {
    assert.deepEqual(Object.keys(page.templates).sort(), ['file', 'route'], key);
    assert.ok(Object.keys(page.assets).length >= 20, key);
    for (const sha of [...Object.values(page.templates), ...Object.values(page.assets)]) assert.match(sha, /^[0-9a-f]{64}$/);
  }
});

for (const style of ['route', 'file']) {
  test(`link style ${style}: a rebuild in memory has the golden digests`, () => {
    for (const r of memoBuild(style).results) {
      const got = digestBundle(r.bundle);
      const want = golden.pages[r.key];
      assert.equal(got.template, want.templates[style], `${r.key}: the decoded template changed${HINT}`);
      const changed = Object.keys(want.assets).filter((u) => got.assets[u] !== want.assets[u]);
      assert.deepEqual(changed, [], `${r.key}: these assets changed${HINT}`);
      assert.deepEqual(Object.keys(got.assets), Object.keys(want.assets), `${r.key}: the set (and order) of assets changed${HINT}`);
    }
  });
}

test('goldenDocument() reproduces the checked-in file', () => {
  const fresh = goldenDocument();
  assert.deepEqual(fresh, golden);
});

test('the built pages in pages/ (when present) have the golden digests for the linkStyle of site.json', { skip: !PAGE_KEYS.every((k) => fs.existsSync(path.join(ROOT, SITE.pages[k].file))) && 'pages/ not built' }, () => {
  for (const key of PAGE_KEYS) {
    const got = digestBundle(Bundle.load(path.join(ROOT, SITE.pages[key].file)));
    const want = golden.pages[key];
    assert.equal(got.template, want.templates[SITE.linkStyle], `${key}: ${SITE.pages[key].file} is out of date, run npm run build:site`);
    assert.deepEqual(got.assets, want.assets, `${key}: ${SITE.pages[key].file} assets are out of date, run npm run build:site`);
  }
});
