import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bundle } from '../../tools/bundle.js';
import { buildSite } from '../../tools/build-site.js';
import { checkPages, checkTemplate, collectLinks, loadSite, makeResolver } from '../../tools/check-links.js';
import { PAGE_KEYS, ROOT, SITE, makeTempRoot, memoBuild, removeTempRoot, runNode, tool } from './site-helpers.js';

const templates = (style) => Object.fromEntries(memoBuild(style).results.map((r) => [r.key, r.bundle.template]));
const problemsOf = (key, template, style = 'route') => checkTemplate(key, template, SITE, { root: ROOT }).problems;
const kinds = (problems) => problems.map((p) => p.check);

for (const style of ['route', 'file']) {
  test(`link style ${style}: the built pages pass all three checks`, () => {
    const r = checkPages({ templates: templates(style), linkStyle: style });
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
    for (const key of PAGE_KEYS) assert.ok(r.pages[key].links > 5, `${key} has links`);
  });
}

test('the connections matrix of site.json holds for the built pages (the dashboard\'s links are found anywhere in its template)', () => {
  const r = checkPages({ templates: templates('route') });
  for (const [key, wanted] of Object.entries(SITE.connections)) {
    if (key.startsWith('_')) continue;
    for (const w of wanted) assert.ok(r.pages[key].linkedPages.includes(w), `${key} should link to ${w}; it links to ${r.pages[key].linkedPages}`);
  }
  assert.deepEqual(r.pages.dashboard.linkedPages, ['home', 'materials', 'studio']);
});

test('the pristine exports fail the check (they link to design-time names and lack the entry points), the built pages do not', () => {
  const pristine = Object.fromEntries(PAGE_KEYS.map((k) => [k, Bundle.load(path.join(ROOT, SITE.pages[k].source)).template]));
  const r = checkPages({ templates: pristine });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.check === 'names' && /\.dc\.html/.test(p.message)));
  assert.ok(r.problems.some((p) => p.check === 'links'));
  assert.ok(r.problems.some((p) => p.check === 'connections'));
});

test('collectLinks: href and src, fragments and queries stripped, templated and anchor-only links skipped', () => {
  const t = `<a href="/materials#/shop">a</a><img src='media/x.jpg'><a href="/design-studio?x=1#y">b</a><a href="#top">c</a><a href="{{ url }}">d</a><a href="?q=1">e</a><a href="/Terucon%20Swatchroom.html">f</a><link href="https://x.org/a.css">`;
  assert.deepEqual(collectLinks(t), ['/materials', 'media/x.jpg', '/design-studio', '/Terucon Swatchroom.html', 'https://x.org/a.css']);
});

test('resolver: routes, aliases (also with %20), docs and media files are known; the page files only in file style', () => {
  const resolve = makeResolver(SITE, ROOT, 'route');
  for (const ok of ['/', '/materials', '/design-studio', '/my-project', '/index.html', '/materials.html', '/market_place_1.html', '/design-studio.html', '/my-project.html', '/Terucon Swatchroom.html', '/Terucon Client Dashboard v3.html', '/project-overview', '/docs/PROJECT_OVERVIEW.html']) {
    assert.notEqual(resolve(ok).kind, 'unknown', ok);
    assert.notEqual(resolve(ok).kind, 'missing-media', ok);
  }
  assert.equal(resolve('/').page, 'home');
  assert.equal(resolve('/design-studio').page, 'studio');
  assert.equal(resolve('Terucon Swatchroom.html').page, 'studio');
  const media = fs.readdirSync(path.join(ROOT, 'media')).find((f) => /\.jpg$/.test(f));
  assert.equal(resolve(`media/${media}`).kind, 'media');
  assert.equal(resolve(`/media/${media}`).kind, 'media');
  // the server serves none of these names: pages/ is never served, and home/studio/dashboard.html are neither routes nor aliases
  for (const bad of ['/nowhere', 'nowhere.html', '/Design Studio.dc.html', '/design-studio/extra', '/materials/', 'home.html', '/home.html', 'studio.html', 'dashboard.html', 'pages/studio.html', '/pages/home.html', './dashboard.html']) {
    assert.equal(resolve(bad).kind, 'unknown', `route style: ${bad}`);
  }
  for (const bad of ['media/not-there.jpg', '/media/../.env', 'media/../package.json', 'media/a/../../package.json']) assert.equal(resolve(bad).kind, 'missing-media', bad);
  for (const ext of ['https://example.org/', 'http://x', 'mailto:a@b.c', 'tel:+1', 'data:image/png;base64,AAAA', 'blob:xyz', 'javascript:void(0)', '//cdn.example/x.js', 'about:blank']) assert.equal(resolve(ext).kind, 'external', ext);
  assert.equal(resolve('6465a1d6-6114-48b4-978b-710eaa98fa98').kind, 'asset');

  const file = makeResolver(SITE, ROOT, 'file');
  for (const ok of ['home.html', 'materials.html', 'studio.html', 'dashboard.html', 'pages/studio.html', './dashboard.html', '/materials', '/', '/index.html']) assert.notEqual(file(ok).kind, 'unknown', `file style: ${ok}`);
  assert.equal(file('studio.html').page, 'studio');
  assert.equal(file('nowhere.html').kind, 'unknown');
  assert.equal(makeResolver(SITE, ROOT)('home.html').kind, 'unknown', 'defaults to linkStyle of site.json (route)');
});

test('a deliberately broken template is reported by check, page and message', () => {
  const home = templates('route').home;
  const broken = (extra) => problemsOf('home', home + extra);

  assert.deepEqual(kinds(broken('')), []);
  assert.match(broken('<a href="/nowhere">x</a>')[0].message, /unknown page "\/nowhere"/);
  assert.match(broken('<a href="Design Studio.dc.html">x</a>').map((p) => p.message).join('\n'), /unknown page "Design Studio\.dc\.html"/);
  assert.match(broken('<img src="media/not-there.jpg">')[0].message, /missing media file media\/not-there\.jpg/);
  assert.match(broken('<img src="/media/../.env">')[0].message, /missing media file/);

  const names = broken('<a href="#">Media%20Brief.dc.html</a>');
  assert.deepEqual(kinds(names), ['names', 'names']);
  assert.match(names[0].message, /leftover design-time name ".dc.html"/);
  assert.deepEqual(kinds(broken(' Terucon%20Home%20v2.html')), ['names']);
  assert.deepEqual(kinds(broken(' Terucon%20landing%20page.html')), ['names']);
  assert.match(broken(' Terucon%20Home%20v2.html')[0].message, /"Terucon%20Home%20v2\.html"/);
  assert.deepEqual(kinds(broken(' "Terucon landing page.html"')), ['names']);

  const noProject = problemsOf('home', home.split('/my-project').join('/materials'));
  assert.deepEqual(kinds(noProject), ['connections']);
  assert.match(noProject[0].message, /does not link to 'dashboard' \(\/my-project\)/);

  const external = broken('<a href="https://example.org/x">x</a><a href="mailto:a@b.c">m</a><a href="tel:+1">t</a><img src="data:image/gif;base64,R0lGOD">');
  assert.deepEqual(external, []);
  const accepted = broken('<a href="/index.html">1</a><a href="/Terucon Swatchroom.html">2</a><a href="/materials#/shop">3</a><a href="/design-studio?x=1">4</a><a href="/my-project.html">5</a>');
  assert.deepEqual(accepted, []);
  // file names are links only in the file style
  assert.match(broken('<a href="home.html">x</a>')[0].message, /unknown page "home\.html"/);
  assert.match(broken('<a href="pages/studio.html">x</a>')[0].message, /unknown page "pages\/studio\.html"/);
  const asFile = checkTemplate('home', home + '<a href="home.html">x</a><a href="pages/studio.html#a">y</a>', SITE, { root: ROOT, resolve: makeResolver(SITE, ROOT, 'file') });
  assert.deepEqual(asFile.problems, []);
});

test('checkPages: a missing page file is a problem; `keys` limits the pages; `checks` limits the checks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-links-'));
  try {
    const r = checkPages({ dir });
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, PAGE_KEYS.length);
    assert.match(r.problems[0].message, /page file not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const t = { ...templates('route'), home: templates('route').home + '<a href="/nowhere">x</a>' };
  assert.equal(checkPages({ templates: t }).ok, false);
  assert.equal(checkPages({ templates: t, keys: ['materials'] }).ok, true);
  assert.equal(checkPages({ templates: t, checks: ['names'] }).ok, true);
});

test('CLI check-links: exit 0 and a readable report on good pages, exit 1 with --json problems on broken ones', () => {
  const root = makeTempRoot();
  try {
    const build = runNode([tool('build-site.js'), '--root', root]);
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const good = runNode([tool('check-links.js'), '--root', root]);
    assert.equal(runNode([tool('check-links.js'), '--root', root, '--link-style', 'zip']).status, 2);
    assert.equal(good.status, 0, good.stdout);
    assert.equal((good.stdout.match(/^OK /gm) || []).length, PAGE_KEYS.length);
    assert.equal(JSON.parse(runNode([tool('check-links.js'), '--root', root, '--json']).stdout).ok, true);

    const file = path.join(root, 'pages', 'home.html');
    const b = Bundle.load(file);
    b.template = b.template.split('/my-project').join('/nowhere') + '<a href="Design%20Studio.dc.html">old</a>';
    b.save(file);
    const bad = runNode([tool('check-links.js'), '--root', root]);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /FAIL {2}pages\/home\.html/);
    assert.match(bad.stdout, /\[links\] link to unknown page "\/nowhere"/);
    assert.match(bad.stdout, /\[connections\] does not link to 'dashboard'/);
    assert.match(bad.stdout, /\[names\] leftover design-time name/);
    const json = runNode([tool('check-links.js'), '--root', root, '--json']);
    assert.equal(json.status, 1);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.ok, false);
    assert.deepEqual([...new Set(parsed.problems.map((p) => p.check))].sort(), ['connections', 'links', 'names']);
    assert.ok(parsed.problems.every((p) => p.page === 'home'));
    assert.equal(parsed.pages.materials.problems.length, 0);

    fs.rmSync(path.join(root, 'pages', 'studio.html'));
    const missing = JSON.parse(runNode([tool('check-links.js'), '--root', root, '--json']).stdout);
    assert.equal(missing.pages.studio.exists, false);
  } finally {
    removeTempRoot(root);
  }
});

test('the build\'s own link check catches a media file that does not exist', () => {
  const root = makeTempRoot();
  try {
    // an empty media folder: every media link of the pages is now dangling
    fs.unlinkSync(path.join(root, 'media'));
    fs.mkdirSync(path.join(root, 'media'));
    const built = buildSite({ root, check: true });
    assert.equal(built.results.every((r) => r.ok), true);
    assert.equal(built.ok, false);
    assert.ok(built.problems.length > 10);
    assert.ok(built.problems.every((p) => p.check === 'links' && /missing media file/.test(p.message)));
  } finally {
    removeTempRoot(root);
  }
});

test('the real pages/ (when built) pass the check', { skip: !PAGE_KEYS.every((k) => fs.existsSync(path.join(ROOT, SITE.pages[k].file))) && 'pages/ not built' }, () => {
  const r = checkPages();
  assert.deepEqual(r.problems, []);
  assert.ok(r.ok);
});

test('loadSite reads site/site.json of the given root', () => {
  assert.deepEqual(loadSite(), SITE);
});
