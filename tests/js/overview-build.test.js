// Generating the page: deterministic, safe to embed, and the committed page is recognised as stale when it is.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { collect, embedJson, isStale, OUTPUT, renderHtml, run, stripTimestamp } from '../../tools/build-overview.js';
import { makeProject, ROOT, runCli } from './overview-helpers.js';

const DATA_RE = /<script type="application\/json" id="overview-data">([\s\S]*?)<\/script>/;
const FLAGS = ['--no-routes', '--no-links', '--no-git'];

const build = async (root, generatedAt) => {
  const { data, problems } = await collect(root, { skipRoutes: true, skipLinks: true });
  assert.deepEqual(problems, [], 'the project must be consistent to be rendered');
  return { data, html: renderHtml(root, data, { generatedAt }) };
};

describe('generation', () => {
  test('two runs differ only in the timestamp', async () => {
    const p = makeProject();
    try {
      const a = await build(p.root, '2026-01-01T00:00:00.000Z');
      const b = await build(p.root, '2027-02-02T12:34:56.789Z');
      assert.notEqual(a.html, b.html);
      assert.equal(stripTimestamp(a.html), stripTimestamp(b.html));
      assert.equal(isStale(a.html, b.html), false);
      assert.equal((a.html.match(/2026-01-01/g) || []).length, 1, 'the time appears in exactly one place');
    } finally { p.cleanup(); }
  });

  test('the same real project renders to the same page twice (apart from the time)', async () => {
    const first = await collect(ROOT, { skipRoutes: true, skipLinks: true });
    const second = await collect(ROOT, { skipRoutes: true, skipLinks: true });
    assert.deepEqual(first.problems.filter((x) => x.check !== 5), second.problems.filter((x) => x.check !== 5));
    // another agent may touch a file between the two scans: compare the parts that do not depend on file contents
    assert.deepEqual(first.data.architecture, second.data.architecture);
    assert.deepEqual(first.data.flows, second.data.flows);
    assert.deepEqual(first.data.env, second.data.env);
    assert.deepEqual(first.data.api.routes.map((r) => `${r.method} ${r.path}`), second.data.api.routes.map((r) => `${r.method} ${r.path}`));
  });

  test('the files in the page are in code-unit order, and the page describes itself without metrics', async () => {
    const p = makeProject();
    try {
      const { data } = await build(p.root);
      const paths = data.files.map((f) => f.path);
      assert.deepEqual(paths, [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      p.write(OUTPUT, 'x'.repeat(5000));
      const again = await build(p.root);
      const self = again.data.files.find((f) => f.path === OUTPUT);
      assert.equal(self.self, true);
      assert.equal(self.bytes, null, 'its own size would change every time it is written');
      assert.equal(self.lines, null);
      assert.equal(again.data.stats.files, data.stats.files, 'and it is not in the totals');
    } finally { p.cleanup(); }
  });

  test('the scoreboard counts hand-written code only: generated and exported files are left out', async () => {
    const p = makeProject({ files: { 'pages/home.html': '<p>a</p>\n'.repeat(500), 'package-lock.json': '{}\n'.repeat(900) }, catalog: (c) => {
      c.files.dirs['pages/'] = 'Built.';
      c.files.files.push({ match: 'pages/*.html', owner: 'site-data', tags: ['Generated'], desc: 'Built.' }, { match: 'package-lock.json', owner: 'tooling', tags: ['Generated'], desc: 'Lock.' });
    } });
    try {
      const { data } = await build(p.root);
      assert.equal(data.byLang.HTML.lines - data.byLang.HTML.authoredLines, 500, 'the built page is counted as lines, but not as authored lines');
      assert.equal(data.scoreboard.js, data.byLang.JavaScript.authoredLines);
      assert.equal(data.scoreboard.py, 2, 'src/b.py is two lines');
      assert.equal(data.byLang.JSON.lines - data.byLang.JSON.authoredLines, 900, 'the lock file is counted as lines but not as authored');
      assert.ok(data.scoreboard.jsShare > 0.9 && data.scoreboard.jsShare < 1);
    } finally { p.cleanup(); }
  });
});

describe('embedding', () => {
  test('the embedded JSON round-trips exactly', async () => {
    const p = makeProject();
    try {
      const { data, html } = await build(p.root);
      const embedded = html.match(DATA_RE)[1];
      assert.deepEqual(JSON.parse(embedded), JSON.parse(JSON.stringify(data)));
    } finally { p.cleanup(); }
  });

  test('text from the catalog cannot close the script or open a comment', async () => {
    const hostile = '</script><script>alert(1)</script><!-- <img src=x onerror=alert(2)> & \u2028 \u2029 "quotes" \\ backslash {{SCRIPT}} {{STYLE}}';
    const p = makeProject({ catalog: (c) => {
      c.files.files[0].desc = hostile;
      c.meta.hero.lead = hostile;
      c.meta.title = hostile;
      c.api.routes[0].summary = hostile;
      c.env.vars[0].effect = hostile;
    } });
    try {
      const { data, html } = await build(p.root);
      const template = fs.readFileSync(path.join(p.root, 'docs/overview/template.html'), 'utf8');
      const closers = (s) => (s.match(/<\/script/gi) || []).length;
      assert.equal(closers(html), closers(template), 'no extra </script in the page');
      assert.equal((html.match(/<script[\s>]/gi) || []).length, (template.match(/<script[\s>]/gi) || []).length, 'no extra <script');
      assert.ok(!html.includes('<!-- <img'), 'no raw comment opener');
      const embedded = html.match(DATA_RE)[1];
      assert.ok(!/[<>&\u2028\u2029]/.test(embedded), 'the data holds no raw <, >, & or line separator');
      const back = JSON.parse(embedded);
      assert.equal(back.files.find((f) => f.path === 'package.json').desc, hostile, 'and still reads back exactly');
      assert.equal(back.meta.hero.lead, hostile);
      assert.equal(back.meta.title, hostile);
      assert.match(html, /<title>&lt;\/script&gt;&lt;script&gt;alert\(1\)/, 'the title is escaped as text');
      assert.ok(!html.includes('alert(2)>'), 'the hostile img tag never appears as markup');
      assert.deepEqual(back, JSON.parse(JSON.stringify(data)));
    } finally { p.cleanup(); }
  });

  test('embedJson escapes the characters that matter, and nothing else changes', () => {
    const value = { a: '</script>', b: '<!--', c: 'x & y', d: '\u2028\u2029', e: 'plain ünïcode', n: [1, null, true] };
    const text = embedJson(value);
    assert.ok(!/[<>&\u2028\u2029]/.test(text));
    assert.deepEqual(JSON.parse(text), value);
    assert.match(text, /plain ünïcode/, 'ordinary non-ASCII stays readable');
  });

  test('a value that looks like a template slot is not substituted twice', async () => {
    const p = makeProject({ catalog: (c) => { c.meta.hero.lead = 'before {{SCRIPT}} after'; } });
    try {
      const { html } = await build(p.root);
      assert.match(html.match(DATA_RE)[1], /before \{\{SCRIPT\}\} after/);
      assert.ok(!html.includes('\u0000'));
    } finally { p.cleanup(); }
  });

  test('a script that would end the inline script is refused, and a missing slot is explained', async () => {
    const p = makeProject();
    try {
      const { data } = await collect(p.root, { skipRoutes: true, skipLinks: true });
      p.write('docs/overview/overview.js', 'var s = "</script>";');
      assert.throws(() => renderHtml(p.root, data), /contains "<\/script"/);
      p.write('docs/overview/overview.js', '// ok');
      p.write('docs/overview/template.html', '<html>{{TITLE}}</html>');
      assert.throws(() => renderHtml(p.root, data), /has no \{\{GENERATED\}\} slot/);
    } finally { p.cleanup(); }
  });
});

describe('stale detection and writing', () => {
  test('stripTimestamp touches only the generated meta tag', () => {
    const html = '<meta name="generated" content="2026-01-01T00:00:00Z"><p>2026-01-01T00:00:00Z</p>';
    assert.equal(stripTimestamp(html), '<meta name="generated" content=""><p>2026-01-01T00:00:00Z</p>');
  });

  test('write, check, change a file, check again, rewrite', async () => {
    const p = makeProject();
    try {
      const page = path.join(p.root, OUTPUT);
      let res = await runCli(run, p.root, FLAGS);
      assert.equal(res.code, 0, res.err);
      assert.match(res.out, /wrote docs\/PROJECT_OVERVIEW\.html/);
      assert.ok(fs.existsSync(page));

      res = await runCli(run, p.root, ['--check', ...FLAGS]);
      assert.equal(res.code, 0, res.err);
      assert.match(res.out, /^overview ok: /);

      // a plain re-run changes nothing, not even the timestamp
      const before = fs.readFileSync(page, 'utf8');
      const mtime = fs.statSync(page).mtimeMs;
      await new Promise((r) => setTimeout(r, 15));
      res = await runCli(run, p.root, FLAGS);
      assert.match(res.out, /is up to date/);
      assert.equal(fs.readFileSync(page, 'utf8'), before);
      assert.equal(fs.statSync(page).mtimeMs, mtime);

      // a file changes: the page is stale
      p.write('src/a.js', 'export function hello() { return 1; }\nexport const more = 2;\n');
      res = await runCli(run, p.root, ['--check', ...FLAGS]);
      assert.equal(res.code, 1);
      assert.match(res.err, /generated page\n\s+- docs\/PROJECT_OVERVIEW\.html is stale/);
      assert.equal(fs.readFileSync(page, 'utf8'), before, '--check wrote nothing');

      res = await runCli(run, p.root, FLAGS);
      assert.equal(res.code, 0);
      assert.notEqual(fs.readFileSync(page, 'utf8'), before);
      res = await runCli(run, p.root, ['--check', ...FLAGS]);
      assert.equal(res.code, 0, res.err);

      // an edit to the authored text makes it stale too
      const file = path.join(p.root, 'docs/overview/catalog/meta.json');
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      meta.hero.lead = 'A different lead.';
      fs.writeFileSync(file, JSON.stringify(meta));
      assert.equal((await runCli(run, p.root, ['--check', ...FLAGS])).code, 1);
    } finally { p.cleanup(); }
  });

  test('a problem stops the write: nothing is generated from an inconsistent project', async () => {
    const p = makeProject({ files: { 'src/undescribed.js': 'x' } });
    try {
      const res = await runCli(run, p.root, FLAGS);
      assert.equal(res.code, 1);
      assert.ok(!fs.existsSync(path.join(p.root, OUTPUT)));
    } finally { p.cleanup(); }
  });

  test('the committed page of the real project is a valid page', () => {
    const html = fs.readFileSync(path.join(ROOT, OUTPUT), 'utf8');
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<meta name="generated" content="\d{4}-\d\d-\d\dT/);
    const data = JSON.parse(html.match(DATA_RE)[1]);
    assert.equal(data.schema, 1);
    assert.ok(data.files.length > 50);
  });
});
