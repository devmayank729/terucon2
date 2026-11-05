import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stale, markupOf } from '../../site/brand/build-loader.mjs';
import { ROOT } from '../../tools/build-dist.js';

// The page loader (site/brand/loader.html), its style sheet (loader.css), the click-to-studio module (transition.js) and the studio's
// release script (studio-entry.js). The browser behaviour is in tests/e2e/run.mjs (the "motion" block); these are the things that can
// drift apart without a browser noticing.

const brand = (name) => fs.readFileSync(path.join(ROOT, 'site', 'brand', name), 'utf8');
const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'site.json'), 'utf8'));
const loaderScript = () => /<script>([\s\S]*?)<\/script>\s*$/.exec(brand('loader.html'))[1];

test('loader.html carries loader.css and transition.js carries the loader markup (run node site/brand/build-loader.mjs when this fails)', () => {
  assert.deepEqual(stale(), []);
});

test('the markup transition.js puts on a page is the loader\'s own, with the same mark, line-work and curtain', () => {
  const js = brand('transition.js');
  const m = /var MARKUP = ("(?:[^"\\]|\\.)*");/.exec(js);
  assert.ok(m, 'MARKUP is in transition.js');
  const markup = JSON.parse(m[1]);
  assert.equal(markup, markupOf(brand('loader.html')));
  for (const part of ['id="tc-loader"', 'tc-ld-mark', 'tc-ld-art', 'tc-ld-led-art', 'tc-ld-scan', 'tc-ld-curtain', 'tc-ld-status', 'tc-ld-retry']) assert.ok(markup.includes(part), part);
  assert.ok(!/<script|style=/.test(markup), 'no script and no style attribute in the markup (strict Content-Security-Policy)');
});

test('the scripts are plain JavaScript that parses, and use no camelCase name before an "=" (the exported pages\' runtime rewrites those in inline scripts)', () => {
  const scripts = { 'loader.html script': loaderScript(), 'transition.js': brand('transition.js'), 'studio-entry.js': brand('studio-entry.js') };
  const hazard = /(\s)([a-z]+[A-Z][A-Za-z0-9]*)(\s*=)/g;
  for (const [name, code] of Object.entries(scripts)) {
    assert.doesNotThrow(() => new vm.Script(code, { filename: name }), name);
  }
  // the two that are inlined into pages must be safe; transition.js is a separate file the browser loads, so it is not rewritten
  for (const name of ['loader.html script', 'studio-entry.js']) {
    const code = scripts[name].split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.deepEqual([...code.matchAll(hazard)].map((x) => x[2]), [], `${name}: rename these to lower case`);
  }
});

test('one cycle is defined once in code and the style sheet agrees: CYCLE_MS = --cyc, MIN_CYCLES = 2, the loop wraps at the composed state', () => {
  const code = loaderScript();
  const cycle = Number(/CYCLE_MS=(\d+)/.exec(code)[1]);
  assert.equal(Number(/MIN_CYCLES=(\d+)/.exec(code)[1]), 2, 'the studio shows the animation at least twice');
  assert.match(brand('loader.css'), new RegExp(`--cyc:${cycle}ms`), 'the style sheet\'s default cycle is the script\'s CYCLE_MS');
  // the composed hold (mark fully visible) is what the cycle starts and ends on, so the loop has no restart flash
  const css = brand('loader.css');
  const mk = /@keyframes tc-mk\{([^]*?)\}\}/.exec(css)[1];
  assert.match(mk, /^0%,8%\{opacity:1/, 'the cycle starts composed');
  assert.match(mk, /68%,100%\{opacity:1/, 'and ends composed');
  assert.ok(Number(/COMPOSED_FROM=([\d.]+)/.exec(code)[1]) >= 0.66 - 1e-9, 'a release is only aligned to a moment the mark is composed');
});

test('transition.js and the loader agree on how long the curtain takes to close, and on the studio\'s addresses (site.json)', () => {
  const t = brand('transition.js');
  assert.equal(/CLOSE_MS = (\d+)/.exec(t)[1], /CLOSE_MS=(\d+)/.exec(loaderScript())[1]);
  assert.ok(Number(/NAV_AFTER_MS = (\d+)/.exec(t)[1]) < Number(/CLOSE_MS = (\d+)/.exec(t)[1]), 'it navigates once the curtain is all but closed');
  assert.ok(Number(/SAFETY_MS = (\d+)/.exec(t)[1]) <= 1500, 'navigation starts within 1.5 s whatever happens');
  const list = JSON.parse(/var STUDIO = (\[[^\]]*\]);/.exec(t)[1].replace(/'/g, '"'));
  const want = [SITE.pages.studio.route, ...SITE.pages.studio.aliases].map((p) => p.toLowerCase()).sort();
  assert.deepEqual([...list].sort(), want);
});

test('every built page loads transition.js once (site/brand/head.html), and a link to the studio is taken over only for the main button without modifiers', () => {
  assert.equal((brand('head.html').match(/<script src="\/brand\/transition\.js" defer><\/script>/g) || []).length, 1);
  const t = brand('transition.js');
  for (const part of ['e.button !== 0', 'e.metaKey', 'e.ctrlKey', 'e.shiftKey', 'e.altKey', "target !== '_self'", "hasAttribute('download')", 'persisted']) assert.ok(t.includes(part), part);
});

// ---- loader.js: the same loader for the hand-written pages (generated; see the header of site/brand/build-loader.mjs) ----------------------------------------
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const LOADER_PAGES = ['account', 'admin-catalogue', 'coming-soon', 'finder', 'inspiration', 'login', 'start-project'];

test('loader.js is generated from loader.html: its markup is the loader\'s own, its script is the loader\'s own script, and it leaves a page that already has the loader alone', () => {
  const js = brand('loader.js');
  assert.doesNotThrow(() => new vm.Script(js, { filename: 'loader.js' }));
  assert.ok(/^\/\* GENERATED by site\/brand\/build-loader\.mjs/.test(js), 'it says it is generated');
  const m = /var MARKUP = ("(?:[^"\\]|\\.)*");/.exec(js);
  assert.ok(m, 'MARKUP is in loader.js');
  assert.equal(JSON.parse(m[1]), markupOf(brand('loader.html')));
  const squash = (t) => t.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  assert.ok(squash(js).includes(squash(loaderScript())), 'the loader\'s own script is inside loader.js, unchanged');
  assert.ok(js.includes("w.TeruconLoader || d.getElementById('tc-loader')"), 'a page that carries the loader inline is left alone');
  assert.ok(js.includes('w.TeruconLoader.done()') && js.includes('DOMContentLoaded') && js.includes('fonts.ready') && js.includes('requestAnimationFrame'), 'it lets the loader go when the page is parsed, the fonts are in and two frames are painted');
  assert.ok(js.includes('setTimeout(go, 1200)'), 'a font is never a reason to hold a page back for more than 1.2 s');
  assert.ok(!/style=|setAttribute\('style'|https?:\/\//.test(js), 'no inline style and no address of another site (strict Content-Security-Policy)');
  assert.ok(Buffer.byteLength(js) < 16 * 1024, 'it is a render-blocking script: it stays small');
});

test('every hand-written page that has a header carries the loader first in <head> (loader.css, then loader.js, before the chrome); the built pages carry it inline; the error and offline pages have none', () => {
  for (const name of LOADER_PAGES) {
    const html = read(`pages/${name}.html`);
    const css = html.indexOf('<link rel="stylesheet" href="/brand/loader.css">');
    const script = html.indexOf('<script src="/brand/loader.js"></script>');
    const chrome = html.indexOf('<link rel="stylesheet" href="/brand/chrome.css">');
    assert.equal(html.split('/brand/loader.js').length - 1, 1, `${name}: loader.js once`);
    assert.equal(html.split('/brand/loader.css').length - 1, 1, `${name}: loader.css once`);
    assert.ok(css > 0 && script > css && chrome > script, `${name}: loader.css, then loader.js, then the chrome`);
    assert.ok(script < html.indexOf('</head>') && !html.slice(0, script).includes('<script src='), `${name}: loader.js is the first script of <head>`);
    assert.ok(!/ defer| async/.test(html.slice(script, script + 60)), `${name}: loader.js is not deferred (the loader must be the first thing painted)`);
  }
  for (const name of ['offline', 'error']) assert.ok(!/brand\/loader\./.test(read(`pages/${name}.html`)), `${name}.html has no loader`);
  assert.ok(!brand('head.html').includes('loader.js'), 'the built pages carry the loader inline (tools/build-dist.js), not through loader.js');
});

test('studio-entry.js: the release conditions, the cap and the status line are what the brief says', () => {
  const s = brand('studio-entry.js');
  assert.match(s, /CAP_MS = 10000/);
  assert.match(s, /still waking its models; you can start now/);
  assert.match(s, /\.sr-studio, \.sr-gate/);
  assert.match(s, /\/api\/vision\/warmup/);
  assert.match(s, /#swr-skin|getElementById\('swr-skin'\)/);
  assert.match(s, /\.sr-loading \.sr-form-error/);
  assert.match(s, /loader\.hold\(\)/, 'once the studio is up the loader\'s own fail timer is cancelled (waiting for the GPU is not a failure)');
  assert.match(loaderScript(), /hold:hold/);
});

test('loader.css animates only transform and opacity (plus the one-off background step the exit has always had); no filters, blurs or layout properties', () => {
  const css = brand('loader.css');
  assert.doesNotMatch(css, /backdrop-filter|filter\s*:|blur\(/);
  // every keyframes block lists only these properties
  const allowed = new Set(['transform', 'opacity', 'animation-timing-function', 'background-color']);
  for (const m of css.matchAll(/@keyframes ([\w-]+)\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    const props = new Set([...m[2].matchAll(/[{;]\s*([a-z-]+)\s*:/g)].map((x) => x[1]).concat([...m[2].matchAll(/\{([a-z-]+):/g)].map((x) => x[1])));
    for (const p of props) assert.ok(allowed.has(p), `@keyframes ${m[1]} animates ${p}`);
  }
  assert.match(css, /prefers-reduced-motion:reduce/);
});
