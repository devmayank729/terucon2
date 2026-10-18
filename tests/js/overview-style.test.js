// The overview's look, checked without a browser: contrast in both themes, the dark palette written once and used twice,
// motion and print rules present, and nothing loaded from anywhere but the optional font stylesheet.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { collect, darkTokensCss, renderHtml } from '../../tools/build-overview.js';
import { ROOT } from './overview-helpers.js';

const dir = path.join(ROOT, 'docs/overview');
const css = fs.readFileSync(path.join(dir, 'overview.css'), 'utf8');
const dark = fs.readFileSync(path.join(dir, 'dark-tokens.css'), 'utf8');
const script = fs.readFileSync(path.join(dir, 'overview.js'), 'utf8');

const tokens = (text) => Object.fromEntries([...text.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));
const light = tokens(css.slice(0, css.indexOf('/* @@DARK_TOKENS@@ */')));
const night = { ...light, ...tokens(dark) };

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('colour', () => {
  test('the palette is the Terucon one', () => {
    assert.deepEqual([light.bg, light.card, light.ink, light.muted, light.line, light.accent], ['#efe6d8', '#f8f3ea', '#291c0e', '#6a5646', '#d4c6b2', '#6e473b']);
  });

  // Text pairs must reach WCAG AA (4.5:1). The edge colour is for lines in the diagram, which need 3:1.
  const TEXT = [['ink', 'bg'], ['ink', 'card'], ['ink', 'chip'], ['muted', 'bg'], ['muted', 'card'], ['muted', 'card-2'], ['muted', 'chip'], ['accent', 'bg'], ['accent', 'card'], ['accent', 'accent-soft'], ['accent-ink', 'accent'],
    ['ok', 'card'], ['warn', 'card'], ['bad', 'card'], ['off', 'card'], ['o-website', 'card'], ['o-model', 'card'], ['o-site-data', 'card'], ['o-tooling', 'card'], ['o-tests', 'card'], ['o-docs', 'card'], ['o-private', 'card']];
  for (const [name, palette] of [['light', light], ['dark', night]]) {
    test(`text reaches 4.5:1 in the ${name} theme`, () => {
      const low = TEXT.map(([f, b]) => [f, b, ratio(palette[f], palette[b])]).filter(([, , r]) => r < 4.5);
      assert.deepEqual(low.map(([f, b, r]) => `${f} on ${b}: ${r.toFixed(2)}`), []);
    });
    test(`diagram lines reach 3:1 in the ${name} theme`, () => {
      assert.ok(ratio(palette.edge, palette.card) >= 3, ratio(palette.edge, palette.card).toFixed(2));
    });
  }

  test('the dark theme is its own palette, not the light one inverted', () => {
    assert.notEqual(night.bg, light.bg);
    assert.ok(luminance(night.bg) < 0.05 && luminance(night.ink) > 0.5);
    assert.ok(luminance(night.card) > luminance(night.bg), 'cards sit above the page, as in the light theme');
    for (const k of Object.keys(tokens(dark))) assert.ok(k in light, `--${k} has a light value too`);
  });
});

describe('theme plumbing', () => {
  test('the dark palette is written once and emitted for the system setting and for the toggle', () => {
    const out = darkTokensCss(dark);
    assert.match(out, /@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{/);
    assert.match(out, /:root\[data-theme="dark"\] \{/);
    const blocks = [...out.matchAll(/\{ ((?:--[a-z0-9-]+: [^;]+; )+color-scheme: dark;) \}/g)].map((m) => m[1]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0], blocks[1], 'both blocks hold the same declarations');
    assert.equal((css.match(/--bg: #181109/g) || []).length, 0, 'the dark colours are not repeated in overview.css');
  });

  test('the generated page contains both theme rules and the toggle', async () => {
    const { data } = await collect(ROOT, { skipRoutes: true, skipLinks: true });
    const html = renderHtml(ROOT, data);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /\[data-theme="dark"\]/);
    assert.match(html, /id="theme-toggle"/);
    assert.match(html, /localStorage\.getItem\('terucon-overview-theme'\)/, 'the saved theme is applied from the head, before first paint');
    assert.ok(html.indexOf("getItem('terucon-overview-theme')") < html.indexOf('<style>'), 'and before the styles, so there is no flash');
  });

  test('storage is always wrapped in try/catch', () => {
    for (const m of script.matchAll(/localStorage\.\w+/g)) {
      const before = script.slice(Math.max(0, m.index - 300), m.index);
      assert.match(before, /try\s*\{[^}]*$/, `${m[0]} is not inside a try block`);
    }
    const boot = fs.readFileSync(path.join(dir, 'theme-boot.js'), 'utf8');
    assert.match(boot, /try\s*\{[\s\S]*localStorage[\s\S]*\}\s*catch/);
  });
});

describe('behaviour and loading', () => {
  test('reduced motion and print are handled', () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /scroll-behavior: auto/);
    assert.match(css, /@media print/);
    assert.match(css, /\.focus-visible|:focus-visible/);
    assert.match(script, /prefers-reduced-motion: reduce/);
  });

  test('the page is responsive down to 360px: no fixed widths wider than that outside scroll containers', () => {
    assert.match(css, /@media \(max-width: 440px\)/);
    assert.ok(!/(^|[^-a-z])width:\s*\d{4,}px/m.test(css), 'no huge fixed widths');
    assert.match(fs.readFileSync(path.join(dir, 'template.html'), 'utf8'), /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  });

  test('nothing is loaded from the network except the optional Fontshare stylesheet', async () => {
    const { data } = await collect(ROOT, { skipRoutes: true, skipLinks: true });
    const html = renderHtml(ROOT, data);
    const external = [...html.matchAll(/<(script|link|img|iframe|source|video|audio)\b[^>]*?\b(?:src|href)="(https?:)?\/\/[^"]+"/gi)].map((m) => m[0]);
    assert.equal(external.filter((e) => /^<script/i.test(e)).length, 0, 'no CDN scripts');
    assert.deepEqual(external.filter((e) => !/fontshare/.test(e)), [], 'only the font stylesheet (and its preconnect) leave the page');
    assert.ok(!/@import|url\(\s*["']?https?:/i.test(css), 'no @import or remote url() in the styles');
    assert.match(html, /media="print" onload="this\.media='all'"/, 'the font never blocks rendering');
    assert.match(css, /--serif: Zodiak, "Iowan Old Style"/, 'Zodiak with a system fallback');
    assert.match(css, /--sans: Switzer,/, 'Switzer with a system fallback');
  });

  test('the page script puts text into the page with textContent, never as HTML', () => {
    assert.ok(!/\.innerHTML\s*=/.test(script), 'no innerHTML assignment');
    assert.ok(!/insertAdjacentHTML|document\.write|eval\(|new Function\(/.test(script));
    assert.ok(!/outerHTML\s*=/.test(script));
  });

  test('every section of the page has a heading, a nav entry and a place for its content', () => {
    const template = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
    const ids = [...template.matchAll(/<section class="sec[^"]*" id="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, ['status', 'architecture', 'flows', 'pages', 'api', 'config', 'files', 'boundary', 'tests', 'commands']);
    for (const id of ids) {
      assert.ok(template.includes(`href="#${id}"`), `nav entry for ${id}`);
      assert.ok(template.includes(`aria-labelledby="h-${id}"`), `heading for ${id}`);
    }
    assert.match(template, /<a class="skip" href="#main">/);
    assert.match(template, /<dialog id="kbd-dialog" aria-labelledby="kbd-title">/);
  });
});
