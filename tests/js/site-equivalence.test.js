// The JS build against the reference builds of the old Python tool (tools/build_site.py, patch_swatchroom.py, bundle.py).
// Those builds live outside the repository; the test skips when they are not there. The permanent regression guard is
// site-golden.test.js, whose digests were checked against these builds when they were written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bundle } from '../../tools/bundle.js';
import { buildSite } from '../../tools/build-site.js';
import { OLD_FILE_NAMES, PAGE_KEYS } from './site-helpers.js';

const REF = process.env.TERUCON_REF_BUILDS || '/tmp/claude-1000/-home-mayank-Desktop-HUSTLE-Terucon-2/a07de236-3341-4124-bdf8-828996ea1916/scratchpad';
// the one deliberate difference in an asset: the comment banner of the injected studio runtime
const OLD_BANNER = '(added by tools/patch_swatchroom.py)';
const NEW_BANNER = '(added by the site build, site/patches/studio.json)';

for (const style of ['route', 'file']) {
  const refDir = path.join(REF, `ref-final-${style}`);
  const skip = fs.existsSync(path.join(refDir, OLD_FILE_NAMES.home)) ? false : `reference build ${refDir} not present`;

  test(`link style ${style}: decoded templates and every decompressed asset equal the old Python build`, { skip }, () => {
    // the reference used the old flat file names for its file links, so the build is given the same names
    const built = buildSite({ linkStyle: style, linkNames: style === 'file' ? OLD_FILE_NAMES : undefined, check: true });
    assert.ok(built.ok, JSON.stringify(built.problems));
    for (const key of PAGE_KEYS) {
      const mine = built.results.find((r) => r.key === key).bundle;
      const ref = Bundle.load(path.join(refDir, OLD_FILE_NAMES[key]));
      assert.deepEqual(mine.uuids, ref.uuids, `${key}: asset order`);
      assert.deepEqual(mine.extIds(), ref.extIds(), `${key}: ext resources`);
      assert.equal(mine.template, ref.template, `${key}: template text`);
      const banner = key === 'studio' ? mine.extUuid('swatchroomApp') : null;
      for (const u of ref.uuids) {
        assert.equal(mine.mime(u), ref.mime(u), `${key} ${u}: mime`);
        assert.equal(mine.isCompressed(u), ref.isCompressed(u), `${key} ${u}: compression flag`);
        let expected = ref.asset(u);
        if (u === banner) {
          const text = ref.assetText(u);
          assert.equal(text.split(OLD_BANNER).length, 2, 'the reference has the old banner exactly once');
          expected = Buffer.from(text.replace(OLD_BANNER, () => NEW_BANNER), 'utf8');
        }
        assert.ok(mine.asset(u).equals(expected), `${key} ${u}: decompressed bytes differ`);
      }
    }
  });
}

test('the comparison is not vacuous: a route build differs from the file-style reference', { skip: !fs.existsSync(path.join(REF, 'ref-final-file', OLD_FILE_NAMES.home)) }, () => {
  const built = buildSite({ linkStyle: 'route', check: true });
  const mine = built.results.find((r) => r.key === 'dashboard').bundle;
  const ref = Bundle.load(path.join(REF, 'ref-final-file', OLD_FILE_NAMES.dashboard));
  assert.notEqual(mine.template, ref.template);
});
