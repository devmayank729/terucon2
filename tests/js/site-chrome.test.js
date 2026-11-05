import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkTemplate, loadChrome, makeResolver } from '../../tools/check-links.js';
import { ROOT, SITE } from './site-helpers.js';

// The site chrome (site/brand/chrome.{js,css}): one header and, on a laptop, a sidebar, on every page. The browser side is tested in
// tests/e2e/run.mjs ("chrome: ..."); these checks keep its single list of destinations, its files and the pages that include it honest.

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const CHROME = loadChrome(ROOT);
const HAND_WRITTEN = ['inspiration', 'finder', 'account', 'login', 'admin-catalogue', 'coming-soon', 'error', 'offline'];

test('chrome.js has ONE list of destinations, valid JSON, every route of it is a page or document of the site', () => {
  assert.equal(CHROME.error, null, CHROME.error);
  const list = CHROME.destinations;
  assert.deepEqual(list.map((d) => d.key), ['home', 'materials', 'studio', 'inspiration', 'finder', 'project', 'account']);
  assert.equal(new Set(list.map((d) => d.href)).size, list.length, 'a route is listed twice');
  const resolve = makeResolver(SITE, ROOT);
  for (const d of list) {
    assert.ok(d.label && typeof d.ai === 'boolean' && Array.isArray(d.paths), `${d.key}: label, ai flag and paths`);
    assert.ok(['route', 'doc'].includes(resolve(d.href).kind), `${d.key}: ${d.href} is not a route of the site`);
    for (const p of d.paths) assert.ok(p === p.toLowerCase(), `${d.key}: path ${p} must be lower case (it is compared with the lower-cased location)`);
  }
  assert.deepEqual(list.filter((d) => d.ai).map((d) => d.key), ['studio'], 'only the Design Studio carries the AI badge');
  assert.deepEqual(list.filter((d) => d.dock).map((d) => d.key), ['materials', 'studio', 'inspiration', 'finder', 'project'], 'the dock keeps its five destinations');
  assert.deepEqual(list.filter((d) => d.nav).map((d) => d.key), ['materials', 'studio', 'inspiration', 'finder', 'project', 'account'], 'the landing pill: the five and Sign in / Account');
  assert.deepEqual(list.filter((d) => d.side).map((d) => d.key), list.map((d) => d.key), 'the sidebar: Home, Materials, Design Studio, Inspiration, Finder, My project, Account');
  // every page of the site map is reachable from the chrome
  for (const [key, page] of Object.entries(SITE.pages)) assert.ok(list.some((d) => resolve(d.href).page === key), `${key} (${page.route}) is not in the chrome's list`);
});

test('the dock has no list of its own: it builds its tabs from the chrome\'s', () => {
  const dock = read('site', 'brand', 'dock.js');
  assert.match(dock, /window\.TeruconChrome/);
  assert.doesNotMatch(dock, /var ITEMS = \[/, 'dock.js lists destinations again');
  assert.doesNotMatch(dock, /href: '\/materials'/);
});

test('site/brand/head.html puts the chrome in every built page: the stylesheet, then the synchronous script (no defer, no async)', () => {
  const head = read('site', 'brand', 'head.html');
  assert.equal((head.match(/\/brand\/chrome\.css/g) || []).length, 1);
  assert.equal((head.match(/\/brand\/chrome\.js/g) || []).length, 1);
  assert.match(head, /<link rel="stylesheet" href="\/brand\/chrome\.css">\s*<script src="\/brand\/chrome\.js"><\/script>/);
  assert.equal(CHROME.inHead, true);
});

test('the patches hide the exports\' own headers only while the chrome is on (a page that loads without chrome.js keeps its header)', () => {
  for (const [key, selector] of [['home', '[data-nav]'], ['materials', '[data-nav]'], ['studio', '[data-nav]'], ['dashboard', 'header[data-screen-label=\\"Top bar\\"]']]) {
    const raw = read('site', 'patches', `${key}.json`);
    assert.ok(raw.includes(`html.tc-chrome-on ${selector} { display: none !important; }`), `${key}: the hide rule is not gated on html.tc-chrome-on`);
    assert.doesNotMatch(raw, /(?<!html\.tc-chrome-on )(?<!\w)(?:header)?\[data-(?:nav|screen-label=[^\]]*)\] \{ display: none/, `${key}: an ungated rule hides the header`);
  }
});

test('the chrome animates only transform, opacity and colours; reduced motion switches it all off; the layout numbers are constants', () => {
  const css = read('site', 'brand', 'chrome.css');
  const allowed = new Set(['color', 'background-color', 'opacity', 'transform', 'none']);
  for (const m of css.matchAll(/transition:\s*([^;}]+)[;}]/g)) {
    for (const part of m[1].replace(/\([^)]*\)/g, '').split(',')) assert.ok(allowed.has(part.trim().split(/\s+/)[0]), `a transition on ${part.trim()}`);
  }
  assert.doesNotMatch(css, /animation\s*:/, 'no keyframe animation');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /--tc-hdr-h: 0px;/);
  assert.match(css, /--tc-side-w: 0px;/);
  assert.match(css, /html\.tc-side-on \{ --tc-side-w: 260px; \}/);
  assert.match(css, /html\.tc-side-on\.tc-side-rail \{ --tc-side-w: 64px; \}/);
  assert.match(css, /html\.swr-immersive \.tc-hdr/, 'the chrome steps aside while the studio is full screen');
});

test('chrome.js: plain, synchronous, no inline style, localStorage only inside try, one request for the account, nothing from another site', () => {
  const js = read('site', 'brand', 'chrome.js');
  assert.doesNotMatch(js, /setAttribute\('style'|\bstyle="/, 'an inline style (the strict policy refuses it)');
  assert.doesNotMatch(js, /https?:\/\//, 'an address of another site');
  // the sidebar preference is read and written (two places); the lazy loader of the phone-capture pop-up (site/brand/capture.js) adds one more, a READ of the
  // note capture.js leaves when a capture link is open, so that the pop-up reaches the person on any page. It must be inside its own try, and it never writes.
  assert.equal((js.match(/localStorage\.(?:get|set)Item/g) || []).length, 3, 'localStorage is touched in three places: the sidebar preference (read, write) and the capture note (read)');
  assert.equal((js.match(/localStorage\.setItem/g) || []).length, 1, 'only the sidebar preference is ever written');
  const note = /try \{\s*var note = JSON\.parse\(localStorage\.getItem\('terucon\.capture\.v1'\)[\s\S]*?\} catch/.exec(js);
  assert.ok(note, 'the capture note is read inside a try that catches (localStorage can throw)');
  for (const m of js.matchAll(/function (readPref|writePref)[\s\S]*?\n  \}/g)) assert.match(m[0], /try \{[\s\S]*catch/, `${m[1]} must catch (localStorage can throw)`);
  assert.equal((js.match(/\/api\/auth\/me/g) || []).length, 1, 'one request for who is signed in');
  assert.doesNotMatch(js, /=>|\bconst\s|\blet\s/, 'plain ES5, like dock.js');
  // 22 KB (it was 20): the lazy loader of the phone-capture pop-up, about 1.2 KB, is the only thing added since the limit was set at 20
  assert.ok(Buffer.byteLength(js) < 22 * 1024, 'the script must stay small');
});

test('the hand-written pages use the chrome: its two lines in <head>, no header or navigation of their own, no inline style, one footer band', () => {
  const bands = new Set();
  for (const name of HAND_WRITTEN) {
    const html = read('pages', `${name}.html`);
    const head = html.slice(0, html.indexOf('</head>'));
    assert.match(head, /<link rel="stylesheet" href="\/brand\/chrome\.css">\s*<script src="\/brand\/chrome\.js"><\/script>/, `${name}: chrome in <head>`);
    if (name !== 'error' && name !== 'offline') assert.ok(head.indexOf('/brand/chrome.js') < head.indexOf('/brand/dock.js'), `${name}: chrome.js before dock.js`);
    assert.doesNotMatch(html, /<header[\s>]|<nav[\s>]/, `${name}: its own header or navigation is back`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${name}: a style attribute (the strict policy refuses it)`);
    assert.doesNotMatch(html, /\sdata-tc-chrome\s*=\s*"off"/, `${name}: no chrome`);
    const footer = /<footer class="tc-foot">[\s\S]*?<\/footer>/.exec(html);
    assert.ok(footer, `${name}: the footer band`);
    bands.add(footer[0]);
    assert.doesNotMatch(html.replace(/<footer class="tc-foot">[\s\S]*?<\/footer>/, ''), /^\s*footer\s*\{/m, `${name}: its own footer rule`);
  }
  assert.equal(bands.size, 1, 'the footer bands differ');
  for (const name of ['login', 'coming-soon', 'error', 'offline']) assert.match(read('pages', `${name}.html`), /<html[^>]* data-tc-sidebar="off"/, `${name}: no sidebar`);
  for (const name of ['login', 'error', 'offline']) assert.match(read('pages', `${name}.html`), /<html[^>]* data-tc-account="off"/, `${name}: no account button and no request for who is signed in`);
});

test('the link check reads the chrome: its destinations connect the pages, the export\'s hidden header does not count, a head without the chrome fails', () => {
  const noLinks = '<main>nothing to click</main>';
  const resolve = makeResolver(SITE, ROOT);
  const run = (template, chrome) => checkTemplate('studio', template, SITE, { root: ROOT, resolve, chrome }).problems.map((p) => `${p.check}: ${p.message}`);
  assert.ok(run(noLinks, null).some((p) => p.startsWith('connections')), 'without the chrome the page is not connected');
  assert.deepEqual(run(noLinks, CHROME), [], 'with the chrome it is');
  const partial = { ...CHROME, destinations: CHROME.destinations.filter((d) => d.key !== 'project') };
  assert.ok(run(noLinks, partial).some((p) => /dashboard/.test(p)), 'a destination dropped from the chrome\'s list breaks the connection');
  const hidden = '<header data-nav=""><a href="/my-project">My project</a></header><main></main>';
  assert.ok(run(hidden, partial).some((p) => /dashboard/.test(p)), 'a link in the export\'s hidden header does not count');
  assert.deepEqual(run('<main><a href="/my-project">My project</a></main>', partial), [], 'a link in the page itself does');
  assert.ok(run(noLinks, { ...CHROME, inHead: false }).some((p) => p.startsWith('chrome') && /head\.html/.test(p)), 'head.html without the chrome fails');
  assert.ok(run(noLinks, { ...CHROME, destinations: [...CHROME.destinations, { key: 'x', label: 'X', href: '/nowhere' }] }).some((p) => /\/nowhere/.test(p)), 'a destination that is not a page fails');
});
