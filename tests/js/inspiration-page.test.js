import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pageCsp } from '../../server/lib/csp.js';
import { SiteMap } from '../../server/lib/siteMap.js';
import { allCdnHosts } from '../../site/inspiration/sources.js';

// Inspiration import (C3): the hand-written Inspiration page runs under a strict Content-Security-Policy built from the page itself.
// These checks keep the page inside what that policy allows, so a change that would only break in a browser breaks here.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'pages', 'inspiration.html'), 'utf8');

test('the page has no inline script, no inline style attribute and no event-handler attribute (the strict policy would refuse them)', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1);
  for (const [, attrs, body] of scripts) {
    // the site's own modules, and the phone dock's one script (site/brand/dock.js: same-origin, no inline code)
    assert.match(attrs, /\bsrc="(?:\/inspiration\/assets\/[a-z]+|\/brand\/dock)\.js"/, 'every script is one of the site\'s own modules');
    assert.equal(body.trim(), '', 'no inline script text');
  }
  assert.ok(!/\sstyle\s*=/i.test(html), 'an inline style="" attribute would be blocked');
  assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/<style[\s\S]*?<\/style>/gi, '')), 'an on...="" handler attribute would be blocked');
  assert.ok(!/<link[^>]+href="https?:/i.test(html), 'no stylesheet from another site');
});

test('the policy built from the page: its own style by hash, its own scripts, blob: and the picture hosts for pictures, nothing else', () => {
  const policy = pageCsp(html, { images: allCdnHosts() });
  const part = (name) => policy.split('; ').find((p) => p.startsWith(`${name} `)) ?? '';
  assert.match(part('default-src'), /^default-src 'none'$/);
  assert.match(part('script-src'), /^script-src 'self'$/, 'only scripts from this site (and no inline one)');
  assert.match(part('style-src'), /^style-src 'self' 'sha256-[A-Za-z0-9+/=]+'$/);
  assert.match(part('img-src'), /^img-src 'self' data: blob: https:\/\/\*\.pinimg\.com /);
  for (const host of ['images.unsplash.com', 'images.pexels.com', 'upload.wikimedia.org', 'i.imgur.com', '*.staticflickr.com', '*.behance.net']) assert.ok(part('img-src').includes(`https://${host}`), host);
  assert.ok(!/https:(?!\/\/)/.test(policy) && !part('img-src').includes(' https: '), 'never "any https picture"');
  assert.match(part('connect-src'), /^connect-src 'self'$/);
  assert.match(part('frame-ancestors'), /'self'/);
  assert.ok(!policy.includes('unsafe-inline') && !policy.includes('unsafe-eval'));
  // the page without the option keeps the older, stricter picture rule
  assert.match(pageCsp(html).split('; ').find((p) => p.startsWith('img-src')), /^img-src 'self' data:$/);
});

test('the page is in the site map for members only, with the picture policy, and its aliases lead to it', () => {
  const site = SiteMap.load(ROOT);
  const entry = site.docs.inspiration;
  assert.equal(entry.route, '/inspiration');
  assert.equal(entry.access, 'signed-in');
  assert.equal(entry.csp, 'strict+images');
  const table = site.table('docs');
  assert.ok(table.get('/inspiration'));
  assert.ok(table.get('/import'));
  // the link checker reads this from site.json; the route (server/routes/inspiration.js) serves the same place
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'site.json'), 'utf8'));
  const assets = raw.assets.find((a) => a.route === '/inspiration/assets');
  assert.deepEqual([assets?.route, assets?.dir], ['/inspiration/assets', 'site/inspiration']);
});

test('every module the page and the other pages load is a file in the folder, and no module imports one that is not', () => {
  const dir = path.join(ROOT, 'site', 'inspiration');
  const files = new Set(fs.readdirSync(dir));
  for (const name of files) {
    if (!name.endsWith('.js')) continue;
    for (const [, spec] of fs.readFileSync(path.join(dir, name), 'utf8').matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.ok(spec.startsWith('./'), `${name} imports ${spec}: only this folder's own files`);
      assert.ok(files.has(spec.slice(2)), `${name} imports ${spec}, which is not in site/inspiration/`);
    }
  }
  for (const m of html.matchAll(/src="\/inspiration\/assets\/([^"]+)"/g)) assert.ok(files.has(m[1]), m[1]);
});

test('the browser files that run on the server and in the browser use no browser or Node API', () => {
  const text = fs.readFileSync(path.join(ROOT, 'site', 'inspiration', 'sources.js'), 'utf8');
  for (const word of ['document.', 'window.', 'localStorage', 'require(', 'process.', 'fetch(']) assert.ok(!text.includes(word), `sources.js uses ${word}`);
  assert.ok(!/^\s*import\s/m.test(text), 'sources.js imports nothing');
  const geometry = fs.readFileSync(path.join(ROOT, 'site', 'inspiration', 'geometry.js'), 'utf8');
  assert.ok(!/document\.|window\./.test(geometry), 'geometry.js has no page in it');
});

test('every page that loads the import module marks its boxes the same way, and nothing else sets a box', () => {
  const dir = path.join(ROOT, 'site', 'patches');
  const materials = JSON.parse(fs.readFileSync(path.join(dir, 'materials.json'), 'utf8'));
  const marks = materials.steps.filter((s) => /^import-/.test(s.id));
  assert.deepEqual(marks.map((s) => s.id).sort(), ['import-assistant-box', 'import-script', 'import-search-box']);
  for (const step of marks.filter((s) => s.with)) assert.ok(step.with.includes('data-import-urls=""'));
  const studio = JSON.parse(fs.readFileSync(path.join(dir, 'studio.json'), 'utf8'));
  assert.ok(studio.steps.some((s) => s.id === 'import-feed' && s.insert.join('').includes('/inspiration/assets/feed.js')));
});
