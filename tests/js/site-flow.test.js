import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bundle } from '../../tools/bundle.js';
import { collectLinks, makeResolver } from '../../tools/check-links.js';
import { ROOT, SITE, memoBuild } from './site-helpers.js';

// The path a visitor takes: landing page -> Design Studio (Swatchroom) -> the rest of the site, and a page that does not
// exist yet. These tests look at the built pages and the site map, not at a running server.

const built = (key) => memoBuild('route').results.find((r) => r.key === key).bundle;

test('the Design Studio page is built from the swatchroom\'s own export, on the route every CTA points at', () => {
  const studio = SITE.pages.studio;
  assert.equal(studio.source, 'swatchroom/terucon/Swatchroom.html');
  assert.equal(studio.route, '/design-studio');
  assert.ok(fs.existsSync(path.join(ROOT, studio.source)), 'the export is in the swatchroom folder');
  for (const alias of ['/studio', '/swatchroom']) assert.ok(studio.aliases.includes(alias), `${alias} leads to the studio page`);
  assert.deepEqual(Object.keys(studio.headers), ['Permissions-Policy'], 'the old cross-origin isolation headers are gone');
  assert.ok(!fs.existsSync(path.join(ROOT, 'pages_original', 'Swatchroom.html')), 'the old studio export is gone');
});

test('the studio wake-up is on the landing page and the studio page, and nowhere else', () => {
  for (const key of Object.keys(SITE.pages)) {
    const has = built(key).template.includes('/api/studio/warmup');
    assert.equal(has, key === 'home' || key === 'studio', `${key}: ${has ? 'wakes' : 'does not wake'} the studio`);
  }
  // it is a script in the page head, so it runs the moment the page opens, and it never blocks the page
  for (const key of ['home', 'studio']) {
    const t = built(key).template;
    assert.ok(t.indexOf('/api/studio/warmup') < t.indexOf('</helmet>'), `${key}: in the <helmet>`);
    assert.match(t, /keepalive: true/, `${key}: survives the visitor leaving the page`);
  }
});

test('the landing page offers the studio next to "Start a project", without opening the menu', () => {
  const t = built('home').template;
  const start = t.indexOf('>Start a project</a>');
  const pill = t.indexOf('Try it with your photo');
  const work = t.indexOf('>See the work</a>');
  assert.ok(start > 0 && pill > start && work > pill, 'hero order: Start a project, Try it with your photo, See the work');
  assert.match(t.slice(t.lastIndexOf('<a ', pill), pill), /^<a href="\/design-studio"/);
});

test('the Coming soon page: registered, themed, and every link on it leads somewhere that exists', () => {
  const doc = SITE.docs.comingSoon;
  assert.equal(doc.route, '/coming-soon');
  const html = fs.readFileSync(path.join(ROOT, doc.file), 'utf8');
  assert.match(html, /<title>Coming soon/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(html, /\{\{|\}\}/, 'no template placeholders');
  const resolve = makeResolver(SITE, ROOT);
  const targets = collectLinks(html);
  assert.ok(targets.length >= 5);
  const pages = new Set();
  for (const target of targets) {
    if (/^\/css\/|^\/favicon\.svg$/.test(target)) continue; // served with the studio's files
    const r = resolve(target);
    if (r.kind === 'external') {
      assert.match(target, /^mailto:hello@teruconindia\.com$/, `the only outside link is the email address the other pages use (${target})`);
      continue;
    }
    assert.ok(r.kind === 'route' || r.kind === 'alias', `${target} -> ${r.kind}`);
    pages.add(r.page);
  }
  for (const key of ['home', 'materials', 'studio', 'dashboard']) assert.ok(pages.has(key), `links to ${key}`);
});

test('every page can be reached from the landing page, and every page leads back to it', () => {
  const links = (key) => new Set(collectLinks(built(key).template).map((t) => makeResolver(SITE, ROOT)(t).page).filter(Boolean));
  const keys = Object.keys(SITE.pages);
  for (const key of keys.filter((k) => k !== 'home')) {
    assert.ok(links('home').has(key), `the landing page links to ${key}`);
    assert.ok(links(key).has('home'), `${key} links back to the landing page`);
  }
});

test('the dashboard names its Design Studio link in plain words', () => {
  const t = built('dashboard').template;
  assert.ok(t.includes('>Open the Design Studio</a>'));
  assert.ok(!/advanced users/i.test(t), 'the export\'s "for advanced users" wording is gone');
  assert.match(t.slice(t.lastIndexOf('<a ', t.indexOf('>Open the Design Studio</a>')), t.indexOf('>Open the Design Studio</a>')), /href="\/design-studio"/);
});

test('the studio shell\'s footer no longer claims the photos stay in the browser', () => {
  const t = built('studio').template;
  assert.ok(!/stay in this browser|your own Google Cloud project/.test(t));
});

test('the pristine studio export is the swatchroom\'s: the same page as before with a loader instead of the minified studio', () => {
  const b = Bundle.load(path.join(ROOT, SITE.pages.studio.source));
  const app = b.assetText(b.extUuid('swatchroomApp'));
  assert.ok(app.length < 1000, 'a small loader, not a 1 MB app');
  assert.match(app, /\/js\/swatchroom-app\.js/);
});
