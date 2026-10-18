import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { Bundle, BundleError, PatchError, decodeUtf8, gzipLikePython } from '../../tools/bundle.js';
import { PAGE_KEYS, PRISTINE, makeBundleText, runNode, tool } from './site-helpers.js';

const blockText = (text, name) => text.match(new RegExp(`<script type="__bundler/${name}">\\n([\\s\\S]*?)\\n  </script>`))[1];

for (const key of PAGE_KEYS) {
  test(`${key}: the pristine export re-renders byte-identical, also through the template encoder`, () => {
    const original = decodeUtf8(fs.readFileSync(PRISTINE[key]));
    const b = new Bundle(original, PRISTINE[key]);
    assert.equal(b.render(), original, 'untouched');
    // changing the template and changing it back marks it dirty, so render() re-encodes the unchanged template
    b.template = 'x';
    b.template = JSON.parse(blockText(original, 'template'));
    assert.equal(b.render(), original, 're-encoded');
    assert.equal(Bundle.encodeTemplate(b.template), blockText(original, 'template'), 'encoder equals the exporter\'s block');
  });
}

test('assigning an equal template does not touch the file', () => {
  const original = decodeUtf8(fs.readFileSync(PRISTINE.dashboard));
  const b = new Bundle(original);
  b.template = b.template.slice();
  assert.equal(b.render(), original);
});

test('template encoding: JSON with non-ASCII kept, "</" escaped as <\\u002F, controls as \\u00xx', () => {
  assert.equal(Bundle.encodeTemplate('a</script>é₹\u0001\u001f"\\/\t\n'), '"a<\\u002Fscript>é₹\\u0001\\u001f\\"\\\\/\\t\\n"');
  assert.equal(Bundle.encodeTemplate(' \u007f'), '" \u007f"');
  assert.equal(Bundle.encodeTemplate('<'), '"<"');
});

test('a "</script>" inside the template cannot close the host script, and survives the round trip', () => {
  const template = '<div>"quoted"</div><script>var a = "</script>";</script>\n<!-- é₹ -->';
  const text = makeBundleText({ template });
  assert.ok(!blockText(text, 'template').includes('</'), 'no raw "</" inside the block');
  const b = new Bundle(text);
  assert.equal(b.template, template);
  assert.equal(b.render(), text);
});

test('a byte order mark is kept, invalid UTF-8 is refused', () => {
  const text = makeBundleText({ template: 'x', bom: true });
  const file = path.join(os.tmpdir(), `terucon-bom-${process.pid}.html`);
  fs.writeFileSync(file, text, 'utf8');
  try {
    assert.equal(Bundle.load(file).render(), text);
    fs.writeFileSync(file, Buffer.concat([Buffer.from(text), Buffer.from([0xff, 0xfe, 0x41])]));
    assert.throws(() => Bundle.load(file), /encoded data was not valid|invalid/i);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a missing block, an unknown asset and an unknown ext resource are errors', () => {
  assert.throws(() => new Bundle('<html></html>'), (e) => e instanceof BundleError && /block 'manifest' not found/.test(e.message));
  const b = new Bundle(makeBundleText({ template: 't', assets: { u1: { mime: 'text/plain', text: 'hi' } }, ext: [{ id: 'app', uuid: 'u1' }] }));
  assert.equal(b.extUuid('app'), 'u1');
  assert.deepEqual(b.extIds(), { app: 'u1' });
  assert.throws(() => b.extUuid('nope'), BundleError);
  assert.throws(() => b.asset('nope'), BundleError);
  assert.throws(() => b.setAsset('nope', 'x'), BundleError);
});

test('setAsset: only that payload changes; mime and the compression flag are kept', () => {
  const text = makeBundleText({
    template: 'T',
    assets: {
      'aaaaaaaa-0000': { mime: 'application/javascript', compressed: true, text: 'var a = 1; // é\n' },
      'bbbbbbbb-0000': { mime: 'image/png', bytes: Buffer.from([1, 2, 3, 250]) },
      'cccccccc-0000': { mime: 'text/css', compressed: true, text: 'body{}' },
    },
    ext: [{ id: 'app', uuid: 'aaaaaaaa-0000' }],
  });
  const b = new Bundle(text);
  b.setAsset('aaaaaaaa-0000', 'var a = 2; // ₹\n');
  b.setAsset('bbbbbbbb-0000', Buffer.from([9, 9]));
  const out = b.render();
  const again = new Bundle(out);
  assert.equal(again.assetText('aaaaaaaa-0000'), 'var a = 2; // ₹\n');
  assert.deepEqual([...again.asset('bbbbbbbb-0000')], [9, 9]);
  assert.equal(again.assetText('cccccccc-0000'), 'body{}');
  assert.equal(again.isCompressed('aaaaaaaa-0000'), true);
  assert.equal(again.isCompressed('bbbbbbbb-0000'), false);
  assert.equal(again.mime('aaaaaaaa-0000'), 'application/javascript');
  assert.deepEqual(again.uuids, b.uuids);
  assert.equal(blockText(out, 'template'), blockText(text, 'template'));
  assert.equal(blockText(out, 'ext_resources'), blockText(text, 'ext_resources'));
  // everything in the manifest except the two payloads is as before
  const strip = (t) => blockText(t, 'manifest').replace(/"data":"[^"]*"/g, '"data":""');
  assert.equal(strip(out), strip(text));
  assert.equal(blockText(out, 'manifest').match(/"cccccccc-0000":\{[^}]*\}/)[0], blockText(text, 'manifest').match(/"cccccccc-0000":\{[^}]*\}/)[0]);
});

test('setAsset on a real page: gzip level 9, no timestamp, unknown OS; the other assets are untouched', () => {
  const original = decodeUtf8(fs.readFileSync(PRISTINE.studio));
  const b = new Bundle(original);
  const app = b.extUuid('swatchroomApp');
  const before = Object.fromEntries(b.uuids.map((u) => [u, b.asset(u).toString('base64')]));
  const next = b.assetText(app).replace('Swatchroom (Terucon edition)', 'Swatchroom (Terucon edition, test)');
  b.setAsset(app, next);
  const reparsed = new Bundle(b.render());
  assert.equal(reparsed.assetText(app), next);
  for (const u of reparsed.uuids) if (u !== app) assert.equal(reparsed.asset(u).toString('base64'), before[u], u);
  const gz = Buffer.from(reparsed._manifest[app].data, 'base64');
  assert.deepEqual([...gz.subarray(0, 4)], [0x1f, 0x8b, 8, 0]);
  assert.deepEqual([...gz.subarray(4, 8)], [0, 0, 0, 0], 'mtime 0');
  assert.equal(gz[8], 2, 'XFL: best compression');
  assert.equal(gz[9], 255, 'OS: unknown (same as Python, whatever the platform)');
  assert.deepEqual(zlib.gunzipSync(gz), Buffer.from(next));
  assert.deepEqual(gzipLikePython(Buffer.from('abc')), gzipLikePython(Buffer.from('abc')), 'deterministic');
});

test('the manifest surgery is not fooled by $ patterns or other uuids that share a prefix', () => {
  const text = makeBundleText({
    template: 'T',
    assets: { 'abc-1': { mime: 'text/plain', text: 'one' }, 'abc-12': { mime: 'text/plain', text: 'two' } },
  });
  const b = new Bundle(text);
  b.setAsset('abc-1', '$& $1 $$ $`');
  const again = new Bundle(b.render());
  assert.equal(again.assetText('abc-1'), '$& $1 $$ $`');
  assert.equal(again.assetText('abc-12'), 'two');
});

test('CLI roundtrip: OK for the pristine exports, FAIL (exit 1) for a template the encoder would write differently', () => {
  const ok = runNode([tool('bundle.js'), 'roundtrip', ...Object.values(PRISTINE)]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal((ok.stdout.match(/^OK /gm) || []).length, PAGE_KEYS.length);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-rt-'));
  try {
    const odd = path.join(dir, 'odd.html');
    // "<\/b>" is valid JSON for "</b>" but the exporter would have written "</b>"
    fs.writeFileSync(odd, makeBundleText({ template: 'a</b>' }).replace('<\\u002Fb>', '<\\/b>'));
    const bad = runNode([tool('bundle.js'), 'roundtrip', odd]);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /FAIL .*odd\.html.*template re-encoded=false/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI unpack: template, assets and an index with the logical names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-unpack-'));
  try {
    const r = runNode([tool('bundle.js'), 'unpack', PRISTINE.studio, dir]);
    assert.equal(r.status, 0, r.stderr);
    const b = Bundle.load(PRISTINE.studio);
    assert.equal(fs.readFileSync(path.join(dir, 'template.html'), 'utf8'), b.template);
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    const app = b.extUuid('swatchroomApp');
    assert.equal(index[app].ext, 'swatchroomApp');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'assets', app + '.js')), b.asset(app));
    assert.equal(Object.keys(index).length, b.uuids.length);
    assert.equal(runNode([tool('bundle.js')]).status, 2, 'no arguments: usage, exit 2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PatchError is its own error type', () => {
  const e = new PatchError('x');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'PatchError');
});
