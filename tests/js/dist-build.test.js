import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Bundle } from '../../tools/bundle.js';
import { ROOT, DistError, buildDist, checkDist, main, planDist } from '../../tools/build-dist.js';

// tools/build-dist.js turns the four Claude Design bundles in pages/ into a real built site (dist/): plain HTML, shared content-hashed
// assets, precompressed copies. These tests build from the real pages/ into temp folders.

const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'site.json'), 'utf8'));
const KEYS = Object.keys(SITE.pages);
const STAMP = '2026-01-01T00:00:00.000Z';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `terucon-dist-${label}-`));
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/')).sort() : []);
const quiet = () => {};

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const scratch = (label) => {
  const d = tmp(label);
  made.push(d);
  return d;
};

/** A throw-away project root: the real site map and vendored scripts, the real pages and media by link, nothing else unless a test adds it. */
function makeRoot({ brand = false, pages = true } = {}) {
  const root = scratch('root');
  fs.mkdirSync(path.join(root, 'site'));
  fs.copyFileSync(path.join(ROOT, 'site', 'site.json'), path.join(root, 'site', 'site.json'));
  fs.symlinkSync(path.join(ROOT, 'site', 'vendor'), path.join(root, 'site', 'vendor'), 'dir');
  fs.symlinkSync(path.join(ROOT, 'media'), path.join(root, 'media'), 'dir');
  if (brand && fs.existsSync(path.join(ROOT, 'site', 'brand'))) fs.symlinkSync(path.join(ROOT, 'site', 'brand'), path.join(root, 'site', 'brand'), 'dir');
  if (pages) fs.symlinkSync(path.join(ROOT, 'pages'), path.join(root, 'pages'), 'dir');
  return root;
}

let outA;
let outB;
let htmlOf;
before(() => {
  // the real project, twice, into two folders, with a fixed stamp: the second build proves the output does not depend on the run
  outA = scratch('a');
  outB = scratch('b');
  buildDist({ root: ROOT, out: outA, builtAt: STAMP, log: quiet });
  buildDist({ root: ROOT, out: outB, builtAt: STAMP, log: quiet });
  htmlOf = (key) => fs.readFileSync(path.join(outA, 'pages', `${key}.html`), 'utf8');
});

describe('the real pages, built', () => {
  test('every page of site.json is built and the manifest says so', () => {
    const m = JSON.parse(fs.readFileSync(path.join(outA, 'manifest.json'), 'utf8'));
    assert.equal(m.version, 1);
    assert.equal(m.builtAt, STAMP);
    assert.deepEqual(Object.keys(m.pages), KEYS);
    for (const key of KEYS) {
      const file = path.join(outA, m.pages[key].file);
      assert.equal(m.pages[key].file, `pages/${key}.html`);
      assert.equal(m.pages[key].etag, sha256(fs.readFileSync(file)).slice(0, 16), `${key}: etag is the first 16 hex of the page's sha256`);
      assert.match(m.pages[key].etag, /^[0-9a-f]{16}$/);
    }
  });

  test('no bundle markup is left, and no page names unpkg.com', () => {
    for (const key of KEYS) {
      const html = htmlOf(key);
      assert.ok(!html.includes('__bundler'), `${key}: __bundler`);
      assert.ok(!html.includes('unpkg.com'), `${key}: unpkg.com`);
      assert.ok(!/<script[^>]*type=["']__bundler/.test(html), `${key}: bundle script block`);
      assert.ok(html.startsWith('<!DOCTYPE html>'), `${key}: doctype first, so the page is not in quirks mode`);
      assert.match(html, /<html lang="en"/);
    }
  });

  test('no data: URL over 2 KB in any page (everything big is a file)', () => {
    for (const key of KEYS) {
      for (const m of htmlOf(key).matchAll(/data:[a-z]+\/[a-z0-9.+-]+[;,][^"'\s)]*/gi)) assert.ok(m[0].length <= 2048, `${key}: a data: URL of ${m[0].length} characters starts ${m[0].slice(0, 40)}`);
    }
  });

  test('every /assets/ address in a page or a script exists in the output, and nothing in assets/ is unused', () => {
    const files = new Set(walk(outA));
    const named = new Set();
    for (const rel of files) {
      if (!/^(pages\/[^/]+\.html|assets\/[^/]+\.(?:js|css))$/.test(rel)) continue;
      const text = fs.readFileSync(path.join(outA, rel), 'utf8');
      for (const m of text.matchAll(/(?<![A-Za-z0-9_.\/-])\/assets\/([A-Za-z0-9._-]+\.[A-Za-z0-9]+)/g)) {  // (not /inspiration/assets/..., which the site serves itself)
        assert.ok(files.has(`assets/${m[1]}`), `${rel} refers to /assets/${m[1]}, which is not in dist`);
        named.add(`assets/${m[1]}`);
      }
    }
    // the images __resources and CSS name are covered above; assets only reached from a page through a map are named in it too
    const orphans = [...files].filter((f) => f.startsWith('assets/') && !/\.(?:br|gz)$/.test(f) && !named.has(f));
    assert.deepEqual(orphans, [], 'assets that no page or script refers to');
  });

  test('assets are content-hashed: the 12 hex characters in the name are the start of the file\'s sha256', () => {
    for (const rel of walk(outA)) {
      if (!rel.startsWith('assets/') || /\.(?:br|gz)$/.test(rel)) continue;
      const m = /-([0-9a-f]{12})\.[a-z0-9]+$/.exec(rel);
      assert.ok(m, `${rel} has no 12-hex hash in its name`);
      const bytes = fs.readFileSync(path.join(outA, rel));
      // the vendored three.js module is rewritten (it names the hashed core), so its hash is of the rewritten file: still of its own bytes
      assert.equal(sha256(bytes).slice(0, 12), m[1], rel);
    }
  });

  test('the manifest lists every asset with its size and which compressed copies exist', () => {
    const m = JSON.parse(fs.readFileSync(path.join(outA, 'manifest.json'), 'utf8'));
    const files = new Set(walk(outA));
    const assets = [...files].filter((f) => f.startsWith('assets/') && !/\.(?:br|gz)$/.test(f));
    assert.deepEqual(Object.keys(m.assets).sort(), assets);
    for (const [rel, info] of Object.entries(m.assets)) {
      assert.equal(info.bytes, fs.statSync(path.join(outA, rel)).size, rel);
      assert.equal(info.br, files.has(`${rel}.br`), `${rel}: br flag`);
      assert.equal(info.gz, files.has(`${rel}.gz`), `${rel}: gz flag`);
    }
  });

  test('only woff2 fonts: every @font-face has one woff2 source, with font-display swap, and no ttf or woff file is shipped', () => {
    const all = walk(outA);
    assert.deepEqual(all.filter((f) => /\.(?:ttf|woff|otf|eot)(?:\.|$)/.test(f)), []);
    for (const key of KEYS) {
      const html = htmlOf(key);
      const faces = html.match(/@font-face\s*\{[^{}]*\}/g) || [];
      assert.ok(faces.length > 0, `${key}: has @font-face rules`);
      for (const face of faces) {
        assert.equal((face.match(/url\(/g) || []).length, 1, `${key}: one source in ${face.replace(/\s+/g, ' ').slice(0, 120)}`);
        assert.match(face, /url\("?\/assets\/[a-z0-9-]+-[0-9a-f]{12}\.woff2"?\)\s*format\('woff2'\)/, key);
        assert.match(face, /font-display:\s*swap/, key);
      }
      assert.ok(!/\.(?:ttf|woff)(?!2)\b/.test(html.replace(/\.woff2/g, '')), `${key}: no ttf/woff address`);
    }
  });

  test('the dead preconnect to fontshare is gone; the preloaded fonts are woff2 files that exist', () => {
    const files = new Set(walk(outA));
    for (const key of KEYS) {
      const html = htmlOf(key);
      assert.ok(!/fontshare/.test(html), `${key}: fontshare`);
      const pre = [...html.matchAll(/<link rel="preload" as="font"([^>]*)>/g)];
      assert.ok(pre.length >= 2 && pre.length <= 3, `${key}: 2 or 3 font preloads, found ${pre.length}`);
      for (const [, attrs] of pre) {
        assert.match(attrs, /type="font\/woff2"/);
        assert.match(attrs, /\bcrossorigin\b/);
        const href = /href="([^"]+)"/.exec(attrs)[1];
        assert.ok(files.has(href.replace(/^\//, '')), `${key}: ${href}`);
        assert.ok(href.endsWith('.woff2'));
      }
    }
  });

  test('React and three.js are hosted here: the UMD files load first, the runtime after them, nothing else names a CDN', () => {
    for (const key of KEYS) {
      const html = htmlOf(key);
      const scripts = [...html.matchAll(/<script defer src="(\/assets\/[^"]+)"><\/script>/g)].map((m) => m[1]);
      assert.equal(scripts.length, 3, `${key}: React, ReactDOM and the runtime are the three deferred scripts`);
      assert.match(scripts[0], /^\/assets\/react-production-min-[0-9a-f]{12}\.js$/);
      assert.match(scripts[1], /^\/assets\/react-dom-production-min-[0-9a-f]{12}\.js$/);
      assert.match(scripts[2], /^\/assets\/dc-runtime-[0-9a-f]{12}\.js$/);
      assert.match(html, /<script>window\.__resources=\{/, `${key}: __resources is injected`);
      assert.ok(html.indexOf('window.__resources=') < html.indexOf(`<script defer src="${scripts[0]}"`), `${key}: __resources comes before the first script`);
    }
    // the home page's 3D façade imported three.js from unpkg: the emitted script names our copy and the copy names the hashed core
    const home = fs.readFileSync(path.join(outA, 'pages', 'home.html'), 'utf8');
    const facade = walk(outA).find((f) => /^assets\/facade3d-[0-9a-f]{12}\.js$/.test(f));
    assert.ok(facade, 'the façade script is in dist');
    const text = fs.readFileSync(path.join(outA, facade), 'utf8');
    assert.ok(!text.includes('unpkg.com'));
    const mod = /THREE_URL = '(\/assets\/three-module-min-[0-9a-f]{12}\.js)'/.exec(text);
    assert.ok(mod, 'THREE_URL points at the local module');
    assert.match(fs.readFileSync(path.join(outA, mod[1]), 'utf8'), /from"\/assets\/three-core-min-[0-9a-f]{12}\.js"/);
    assert.ok(home.includes('/assets/facade3d-'));
  });

  test('page descriptions and social tags are relative: no invented domain', () => {
    for (const key of KEYS) {
      const html = htmlOf(key);
      assert.match(html, /<meta name="description" content="[^"]+">/);
      assert.match(html, /<meta property="og:image" content="\/brand\/og-image\.jpg">/);
      assert.match(html, /<meta property="og:title" content="[^"]+">/);
      assert.match(html, /<title>[^<]+<\/title>/);
      assert.ok(!/(?:og:url|og:image|twitter:image)" content="https?:/.test(html), `${key}: absolute social address`);
    }
  });

  test('the images below the fold are lazy and decoded off the main thread, always in front of src (React sets attributes in order)', () => {
    for (const key of KEYS) {
      for (const [tag] of htmlOf(key).matchAll(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
        if (/src="\/brand\//.test(tag)) continue;
        const src = tag.search(/\ssrc=/);
        const loading = tag.search(/\sloading=/);
        if (loading !== -1) assert.ok(loading < src, `${key}: loading after src in ${tag.slice(0, 160)}`);
        if (/fetchpriority="high"/.test(tag)) assert.ok(tag.search(/\sfetchpriority=/) < src);
        else assert.ok(loading !== -1, `${key}: an image without loading=: ${tag.slice(0, 160)}`);
        const set = tag.search(/\ssrcset=/);
        if (set !== -1) assert.ok(set > loading, `${key}: srcset before loading in ${tag.slice(0, 160)}`);
      }
    }
  });

  test('at most one of the page\'s own pictures is fetchpriority=high (the hero, with its preload); the loader\'s logo is the brand\'s', () => {
    for (const key of KEYS) {
      const tags = (htmlOf(key).match(/<(?:img|link)\b[^>]*fetchpriority="high"[^>]*>/g) || []).filter((t) => !t.includes('tc-ld-mark'));
      assert.ok(tags.length <= 2, `${key}: ${tags.length} high-priority tags (the <img> and its preload)`);
      assert.equal(tags.filter((t) => t.startsWith('<img')).length, tags.filter((t) => t.startsWith('<img')).length > 0 ? 1 : 0, key);
    }
  });

  test('the loader hook: a script that calls TeruconLoader.done() when #dc-root has its first child', () => {
    for (const key of KEYS) {
      const html = htmlOf(key);
      assert.match(html, /TeruconLoader\.done\(\)/);
      assert.match(html, /getElementById\('dc-root'\)/);
      if (fs.existsSync(path.join(ROOT, 'site', 'brand', 'loader.html'))) {
        assert.match(html, /<body[^>]*>\s*<style>[\s\S]{0,40}#tc-loader|<body[^>]*>\s*<noscript>|<body[^>]*>\s*<div id="tc-loader"/, `${key}: the loader is the first thing in <body>`);
      }
    }
  });

  test('two builds from the same inputs are byte-identical, file for file', () => {
    const a = walk(outA);
    assert.deepEqual(walk(outB), a);
    for (const rel of a) assert.ok(fs.readFileSync(path.join(outA, rel)).equals(fs.readFileSync(path.join(outB, rel))), `${rel} differs between two builds`);
  });

  test('every .br and .gz decodes back to its source; woff2 and pictures are not compressed again', () => {
    let checked = 0;
    for (const rel of walk(outA)) {
      if (!/\.(?:br|gz)$/.test(rel)) continue;
      const source = rel.replace(/\.(?:br|gz)$/, '');
      assert.ok(/\.(?:js|css|svg|json|html)$/.test(source), `${rel}: only text types get a compressed copy`);
      const want = fs.readFileSync(path.join(outA, source));
      const got = rel.endsWith('.br') ? zlib.brotliDecompressSync(fs.readFileSync(path.join(outA, rel))) : zlib.gunzipSync(fs.readFileSync(path.join(outA, rel)));
      assert.ok(got.equals(want), `${rel} does not decode to ${source}`);
      assert.ok(fs.statSync(path.join(outA, rel)).size < want.length, `${rel} is not smaller than its source`);
      checked += 1;
    }
    assert.ok(checked >= KEYS.length * 2, 'at least a .br and a .gz for every page');
    for (const key of KEYS) for (const ext of ['br', 'gz']) assert.ok(fs.existsSync(path.join(outA, 'pages', `${key}.html.${ext}`)), `${key}.html.${ext}`);
  });

  test('a page is far smaller than its bundle, and no page carries a base64 asset', () => {
    for (const key of KEYS) {
      const bundle = fs.statSync(path.join(ROOT, SITE.pages[key].file)).size;
      const html = fs.statSync(path.join(outA, 'pages', `${key}.html`)).size;
      assert.ok(html < bundle / 3, `${key}: ${html} bytes against a ${bundle} byte bundle`);
      assert.ok(!/[A-Za-z0-9+/]{4000}/.test(htmlOf(key)), `${key}: a long base64-looking run`);
    }
  });
});

describe('--check and --if-missing', () => {
  test('a freshly built folder is current; changing a file, or removing one, is noticed', () => {
    const out = scratch('check');
    buildDist({ root: ROOT, out, builtAt: STAMP, log: quiet });
    assert.deepEqual(checkDist({ root: ROOT, out }).problems, []);
    const page = path.join(out, 'pages', 'studio.html');
    fs.appendFileSync(page, '<!-- edited -->');
    const edited = checkDist({ root: ROOT, out });
    assert.equal(edited.ok, false);
    assert.ok(edited.problems.some((p) => /studio\.html/.test(p)), edited.problems.join('; '));
    fs.writeFileSync(page, fs.readFileSync(path.join(outA, 'pages', 'studio.html')));
    const asset = walk(out).find((f) => f.startsWith('assets/') && f.endsWith('.js') && !f.endsWith('.br'));
    fs.rmSync(path.join(out, asset));
    assert.ok(checkDist({ root: ROOT, out }).problems.some((p) => p.includes(asset)));
    assert.equal(checkDist({ root: ROOT, out: path.join(out, 'nowhere') }).ok, false);
  });

  test('the command line: --check exits 1 when stale, --if-missing builds once and then leaves dist alone', () => {
    const out = path.join(scratch('cli'), 'dist');
    const lines = [];
    const log = (m) => lines.push(m);
    assert.equal(main(['--check', '--out', out, '--quiet'], { log }), 1);
    assert.equal(main(['--if-missing', '--out', out, '--quiet'], { log }), 0);
    assert.ok(fs.existsSync(path.join(out, 'manifest.json')));
    const before = fs.statSync(path.join(out, 'manifest.json')).mtimeMs;
    assert.equal(main(['--if-missing', '--out', out], { log }), 0);
    assert.ok(lines.some((l) => /not rebuilt/.test(l)));
    assert.equal(fs.statSync(path.join(out, 'manifest.json')).mtimeMs, before, 'manifest untouched');
    assert.equal(main(['--check', '--out', out, '--quiet'], { log }), 0);
    fs.rmSync(path.join(out, 'pages', 'home.html'));
    assert.equal(main(['--if-missing', '--out', out, '--quiet'], { log }), 0, 'a damaged dist is rebuilt');
    assert.ok(fs.existsSync(path.join(out, 'pages', 'home.html')));
    assert.equal(main(['--nonsense'], { log }), 2);
  });

  test('a rebuild with nothing changed rewrites nothing and keeps builtAt (so two runs in the same folder are identical)', () => {
    const out = scratch('rebuild');
    const first = buildDist({ root: ROOT, out, log: quiet });
    const bytes = fs.readFileSync(path.join(out, 'manifest.json'));
    const second = buildDist({ root: ROOT, out, log: quiet });
    assert.equal(second.written, 0);
    assert.equal(second.removed, 0);
    assert.equal(second.builtAt, first.builtAt);
    assert.ok(fs.readFileSync(path.join(out, 'manifest.json')).equals(bytes));
  });

  test('it refuses to write into a folder that is not an earlier dist', () => {
    const out = scratch('foreign');
    fs.writeFileSync(path.join(out, 'important.txt'), 'mine');
    assert.throws(() => buildDist({ root: ROOT, out, log: quiet }), (e) => e instanceof DistError && /refusing/.test(e.message));
    assert.equal(fs.readFileSync(path.join(out, 'important.txt'), 'utf8'), 'mine');
  });

  test('stale files from an earlier build are removed, and nothing outside the output folder is written', () => {
    const root = makeRoot();
    const out = path.join(scratch('stale'), 'dist');
    buildDist({ root, out, log: quiet });
    fs.writeFileSync(path.join(out, 'assets', 'old-0123456789ab.js'), 'x');
    const r = buildDist({ root, out, log: quiet });
    assert.equal(r.removed, 1);
    assert.ok(!fs.existsSync(path.join(out, 'assets', 'old-0123456789ab.js')));
    assert.deepEqual(fs.readdirSync(path.dirname(out)), ['dist'], 'only dist/ appeared next to it');
    assert.deepEqual(fs.readdirSync(root).sort(), ['media', 'pages', 'site'], 'the project root is untouched');
  });
});

describe('inputs the build must cope with', () => {
  test('a page that is not a bundle stops the build and the message names the page', () => {
    const root = makeRoot({ pages: false });
    fs.mkdirSync(path.join(root, 'pages'));
    for (const key of KEYS) fs.writeFileSync(path.join(root, SITE.pages[key].file), key === 'materials' ? '<html><body>plain</body></html>' : fs.readFileSync(path.join(ROOT, SITE.pages[key].file)));
    assert.throws(() => planDist({ root }), (e) => e instanceof DistError && /page 'materials' \(pages\/materials\.html\)/.test(e.message));
  });

  test('a missing or changed vendored script stops the build and names the file', () => {
    const root = makeRoot();
    fs.rmSync(path.join(root, 'site', 'vendor'));
    fs.cpSync(path.join(ROOT, 'site', 'vendor'), path.join(root, 'site', 'vendor'), { recursive: true });
    fs.appendFileSync(path.join(root, 'site', 'vendor', 'react.production.min.js'), '\n');
    assert.throws(() => planDist({ root }), (e) => e instanceof DistError && /react\.production\.min\.js does not match/.test(e.message));
    fs.rmSync(path.join(root, 'site', 'vendor', 'react.production.min.js'));
    assert.throws(() => planDist({ root }), (e) => e instanceof DistError && /react\.production\.min\.js is missing/.test(e.message));
  });

  test('an optimized-image index that is absent, broken, or lists a missing file never fails the build', () => {
    const root = makeRoot();
    const base = planDist({ root });
    assert.equal(base.stats.images.hit, 0);
    fs.mkdirSync(path.join(root, 'site', 'optimized'));
    fs.writeFileSync(path.join(root, 'site', 'optimized', 'index.json'), '{ not json');
    const broken = planDist({ root });
    assert.deepEqual([...broken.files.keys()], [...base.files.keys()]);
    // an index that names a file nobody wrote: that image keeps its original
    const bundle = Bundle.load(path.join(ROOT, SITE.pages.materials.file));
    const uuid = bundle.extIds()['media/materials/col-monolith.jpg'];
    assert.ok(uuid, 'the materials page carries its hero picture');
    const key = sha256(bundle.asset(uuid));
    fs.writeFileSync(path.join(root, 'site', 'optimized', 'index.json'), JSON.stringify({ version: 1, items: { [key]: { variants: [{ w: 640, h: 400, file: 'nope-640.webp', bytes: 1 }] } } }));
    const missing = planDist({ root, log: quiet });
    assert.equal(missing.stats.images.hit, 0);
    assert.ok([...missing.files.keys()].some((f) => f.startsWith('assets/col-monolith-')), 'the original is kept');
  });

  test('optimized images: the original is replaced by the variants, srcset/sizes are added, /media/ strings are swapped, text is not', () => {
    const root = makeRoot();
    const opt = path.join(root, 'site', 'optimized');
    fs.mkdirSync(opt);
    const items = {};
    const variants = (name, widths) => widths.map((w) => ({ w, h: Math.round(w / 1.5), file: `${name}-${w}.webp`, bytes: 10 + w }));
    const addItem = (bytes, name, widths) => {
      for (const v of variants(name, widths)) fs.writeFileSync(path.join(opt, v.file), `${name}:${v.w}`);
      items[sha256(bytes)] = { source: name, width: 3000, height: 2000, variants: variants(name, widths) };
    };
    // an embedded picture (the materials hero) and a /media/ picture the home page refers to by address
    const materials = Bundle.load(path.join(ROOT, SITE.pages.materials.file));
    const heroUuid = materials.extIds()['media/materials/col-monolith.jpg'];
    addItem(materials.asset(heroUuid), 'hero', [640, 1280, 1920]);
    const home = Bundle.load(path.join(ROOT, SITE.pages.home.file));
    const mediaRel = [...home.template.matchAll(/(?<=["'(`])\/?(media\/[A-Za-z0-9_.\/-]+\.jpg)(?=["')`])/g)].map((m) => m[1]).find((rel) => fs.existsSync(path.join(ROOT, rel)));
    assert.ok(mediaRel, 'the home page refers to at least one /media/ picture');
    addItem(fs.readFileSync(path.join(ROOT, mediaRel)), 'mediapic', [480, 960]);
    fs.writeFileSync(path.join(opt, 'index.json'), JSON.stringify({ version: 1, items }));

    const plan = planDist({ root, log: quiet });
    const text = (key) => plan.files.get(`pages/${key}.html`).toString('utf8');
    const names = [...plan.files.keys()];
    assert.ok(names.some((f) => /^assets\/hero-640-[0-9a-f]{12}\.webp$/.test(f)) && names.some((f) => /^assets\/hero-1920-[0-9a-f]{12}\.webp$/.test(f)));
    assert.ok(!names.some((f) => /^assets\/col-monolith-/.test(f)), 'the original hero JPEG is not shipped');
    const m = text('materials');
    const hero = /<img\b[^>]*fetchpriority="high"[^>]*>/.exec(m)?.[0];
    assert.ok(hero, 'the hero is the high-priority image');
    assert.match(hero, /srcset="\/assets\/hero-640-[0-9a-f]{12}\.webp 640w, \/assets\/hero-1280-[0-9a-f]{12}\.webp 1280w, \/assets\/hero-1920-[0-9a-f]{12}\.webp 1920w"/);
    assert.match(hero, /src="\/assets\/hero-1280-[0-9a-f]{12}\.webp"/, 'the plain src is the best variant up to 1280 px');
    assert.ok(!/loading="lazy"/.test(hero));
    assert.match(m, /<link rel="preload" as="image" href="\/assets\/hero-1280-[0-9a-f]{12}\.webp" imagesrcset="[^"]*640w/, 'the hero is preloaded with its srcset');
    const h = text('home');
    assert.match(h, /["'(`]\/assets\/mediapic-960-[0-9a-f]{12}\.webp["')`]/, 'the /media/ address is swapped for the 960 px variant');
    assert.ok(!new RegExp(`["'(\`]/?${mediaRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["')\`]`).test(h), 'no quoted /media/ address of that picture is left');
    // printed placeholder text that merely mentions the path is left as it is
    assert.ok(h.includes(`>${mediaRel}`) || !home.template.includes(`>${mediaRel}`), 'visible text is not rewritten');
    assert.equal(plan.stats.images.hit, 2);
  });

  test('the brand shell is injected when it exists: head tags inside <head>, the loader first in <body>', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'site', 'brand'));
    fs.writeFileSync(path.join(root, 'site', 'brand', 'head.html'), '<!-- note for people -->\n<meta name="theme-color" content="#1F150A">\n<meta property="og:type" content="website">');
    fs.writeFileSync(path.join(root, 'site', 'brand', 'loader.html'), '<!-- note -->\n<div id="tc-loader">loading</div>');
    const html = planDist({ root, log: quiet }).files.get('pages/home.html').toString('utf8');
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    assert.ok(head.includes('<meta name="theme-color" content="#1F150A">'));
    assert.equal((html.match(/property="og:type"/g) || []).length, 1, 'a tag head.html already has is not added twice');
    assert.ok(!html.includes('note for people'), 'the explanatory comment is dropped');
    assert.match(html, /<body[^>]*>\s*<div id="tc-loader">loading<\/div>/);
    // and absent: skipped without a word
    const bare = planDist({ root: makeRoot(), log: quiet }).files.get('pages/home.html').toString('utf8');
    assert.ok(!bare.includes('tc-loader'));
  });

  test('nested pages are refused, not shipped half-working', () => {
    const root = makeRoot({ pages: false });
    fs.mkdirSync(path.join(root, 'pages'));
    for (const key of KEYS) {
      const file = path.join(ROOT, SITE.pages[key].file);
      let text = fs.readFileSync(file, 'utf8');
      if (key === 'studio') text = text.replace(/(<script type="__bundler\/page_order">\n)[\s\S]*?(\n  <\/script>)/, '$1["00000000-0000-4000-8000-000000000000"]$2');
      fs.writeFileSync(path.join(root, SITE.pages[key].file), text);
    }
    assert.throws(() => planDist({ root }), (e) => e instanceof DistError && /page 'studio'.*nested pages/.test(e.message));
  });
});
