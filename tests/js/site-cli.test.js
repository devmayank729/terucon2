import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bundle } from '../../tools/bundle.js';
import { PAGE_KEYS, ROOT, SITE, makeTempRoot, removeTempRoot, runNode, tool } from './site-helpers.js';

const build = (root, ...args) => runNode([tool('build-site.js'), '--root', root, ...args]);
const pageFile = (root, key) => path.join(root, SITE.pages[key].file);
const exists = (root, key) => fs.existsSync(pageFile(root, key));
const mtimes = (root) => Object.fromEntries(PAGE_KEYS.filter((k) => exists(root, k)).map((k) => [k, fs.statSync(pageFile(root, k)).mtimeMs]));
const withRoot = (fn) => async () => {
  const root = makeTempRoot();
  try {
    await fn(root);
  } finally {
    removeTempRoot(root);
  }
};

test('default: builds the four pages, prints OK and the applied steps, runs the link check', withRoot((root) => {
  const r = build(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const k of PAGE_KEYS) {
    assert.ok(exists(root, k));
    assert.match(r.stdout, new RegExp(`^OK {4}${SITE.pages[k].file.replace('.', '\\.')}$`, 'm'));
  }
  assert.match(r.stdout, /^ {8}- relink: .* \(5 links\)$/m);
  assert.match(r.stdout, /^ {8}- app\/server-runtime: /m);
  assert.match(r.stdout, /Link check: every same-site link .* \(link style: route\)\./);
  // the output is a bundle that decodes and has the route links
  assert.match(Bundle.load(pageFile(root, 'studio')).template, /href="\/my-project"/);
  // no temp files left behind
  assert.deepEqual(fs.readdirSync(path.join(root, 'pages')).sort(), PAGE_KEYS.map((k) => path.basename(SITE.pages[k].file)).sort());
}));

test('--check patches in memory and writes nothing, but still fails on a bad patch', withRoot((root) => {
  const ok = build(root, '--check');
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /OK {4}pages\/home\.html/);
  assert.equal(fs.existsSync(path.join(root, 'pages')), false);
  const file = path.join(root, 'site', 'patches', 'home.json');
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  spec.steps.find((s) => s.id === 'menu-cards').anchor = 'text that is not in the export';
  fs.writeFileSync(file, JSON.stringify(spec));
  const bad = build(root, '--check');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL {2}pages\/home\.html\n {6}\[home\/menu-cards\] menu: Materials and My project cards: anchor matched 0 times \(expected exactly 1\): "text that is not in the export"/);
  assert.match(bad.stdout, /Build FAILED: no page was written\./);
}));

test('a failing build writes nothing, not even the pages that built fine, and leaves older pages as they were', withRoot((root) => {
  assert.equal(build(root).status, 0);
  const before = Object.fromEntries(PAGE_KEYS.map((k) => [k, fs.readFileSync(pageFile(root, k))]));
  const file = path.join(root, 'site', 'patches', 'dashboard.json');
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  spec.steps[0].expect = 99;
  fs.writeFileSync(file, JSON.stringify(spec));
  const r = build(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL {2}pages\/dashboard\.html\n {6}\[dashboard\/relink\] .*expected 99 links to rewrite, found 8/);
  for (const k of PAGE_KEYS) assert.ok(fs.readFileSync(pageFile(root, k)).equals(before[k]), k);
}));

test('--only builds one page', withRoot((root) => {
  const r = build(root, '--only', 'dashboard');
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(PAGE_KEYS.filter((k) => exists(root, k)), ['dashboard']);
  assert.doesNotMatch(r.stdout, /pages\/home\.html/);
  // the link check does not trip over links to pages that were not part of this run
  assert.match(r.stdout, /Link check: every same-site link/);
  assert.equal(build(root, '--only=studio').status, 0);
  assert.ok(exists(root, 'studio'));
  const unknown = build(root, '--only', 'nope');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown page "nope"/);
}));

test('--link-style overrides site.json: file links name the page files, route links the routes', withRoot((root) => {
  assert.equal(SITE.linkStyle, 'route');
  const r = build(root, '--link-style', 'file', '--only', 'dashboard');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /link style: file/);
  const t = Bundle.load(pageFile(root, 'dashboard')).template;
  assert.match(t, /href="home\.html"/);
  assert.match(t, /href="materials\.html"/);
  assert.match(t, /href="studio\.html"/);
  assert.doesNotMatch(t, /href="\/(materials|design-studio)"/);
  const bad = build(root, '--link-style', 'zip');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--link-style must be one of route, file/);
  // site.json decides when there is no flag
  const site = JSON.parse(fs.readFileSync(path.join(root, 'site', 'site.json'), 'utf8'));
  site.linkStyle = 'file';
  fs.writeFileSync(path.join(root, 'site', 'site.json'), JSON.stringify(site));
  assert.equal(build(root, '--only', 'dashboard').status, 0);
  assert.match(Bundle.load(pageFile(root, 'dashboard')).template, /href="studio\.html"/);
}));

test('--out writes the pages elsewhere and leaves pages/ alone; links are checked against the real media folder', withRoot((root) => {
  const out = path.join(root, 'elsewhere');
  const r = build(root, '--out', out);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(fs.readdirSync(out).sort(), PAGE_KEYS.map((k) => path.basename(SITE.pages[k].file)).sort());
  assert.equal(fs.existsSync(path.join(root, 'pages')), false);
  assert.match(r.stdout, /OK {4}.*elsewhere\/home\.html/);
}));

test('--if-missing: builds only what is missing, and does nothing (not even reading the sources) when nothing is', withRoot((root) => {
  const first = build(root, '--if-missing');
  assert.equal(first.status, 0, first.stdout);
  assert.match(first.stdout, /^building missing pages: pages\/home\.html, pages\/materials\.html, pages\/studio\.html, pages\/dashboard\.html$/m);
  assert.ok(PAGE_KEYS.every((k) => exists(root, k)));
  const times = mtimes(root);

  // nothing missing: silent success, no file touched, and the sources are not needed at all
  fs.unlinkSync(path.join(root, 'pages_original'));
  const t0 = Date.now();
  const again = build(root, '--if-missing');
  const took = Date.now() - t0;
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(again.stdout, '');
  assert.deepEqual(mtimes(root), times);
  assert.ok(took < 5000, `took ${took} ms`);
  fs.symlinkSync(path.join(ROOT, 'pages_original'), path.join(root, 'pages_original'), 'dir');

  // one page missing: only that one is built
  fs.rmSync(pageFile(root, 'studio'));
  const third = build(root, '--if-missing');
  assert.equal(third.status, 0, third.stdout);
  assert.match(third.stdout, /building missing pages: pages\/studio\.html\n/);
  assert.match(third.stdout, /^OK {4}pages\/studio\.html$/m);
  assert.doesNotMatch(third.stdout, /OK {4}pages\/home\.html/);
  const after = mtimes(root);
  assert.equal(after.home, times.home);
  assert.equal(after.materials, times.materials);
  assert.equal(after.dashboard, times.dashboard);
  assert.ok(exists(root, 'studio'));

  // a missing page whose source is missing too fails loudly
  fs.rmSync(pageFile(root, 'home'));
  fs.unlinkSync(path.join(root, 'pages_original'));
  fs.mkdirSync(path.join(root, 'pages_original'));
  const fourth = build(root, '--if-missing');
  assert.equal(fourth.status, 1);
  assert.match(fourth.stdout, /\[home\] missing pristine export/);
}));

test('--write-golden writes tests/fixtures/pages-golden.json with route and file digests for every page', withRoot((root) => {
  const r = build(root, '--write-golden');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const golden = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'pages-golden.json'), 'utf8'));
  assert.deepEqual(Object.keys(golden.pages), PAGE_KEYS);
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'pages-golden.json'), 'utf8'));
  assert.deepEqual(golden, real, 'regenerating from the committed sources reproduces the committed file');
  assert.equal(fs.existsSync(path.join(root, 'pages')), false, 'it writes the fixture only');
}));

test('usage errors: unknown flag and missing value exit 2; --help exits 0', () => {
  const unknown = runNode([tool('build-site.js'), '--frobnicate']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument --frobnicate/);
  const missing = runNode([tool('build-site.js'), '--only']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--only needs a value/);
  const help = runNode([tool('build-site.js'), '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: node tools\/build-site\.js/);
});
