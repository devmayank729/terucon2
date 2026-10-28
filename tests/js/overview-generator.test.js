// tools/build-overview.js: the facts it scans and the five checks that keep the catalog and the project in agreement.
// Everything here runs on small throw-away projects (overview-helpers.js), so it does not depend on the real tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import {
  bestEntry, checkEnv, checkPrivacy, checkRoutes, collect, compileEntries, countTests, globToRegExp, isIgnoredName, normalizeRoute,
  parseEnvExample, readExpressRoutes, run, scanTree, siteRoutePaths, specificity, walkStack,
} from '../../tools/build-overview.js';
import { makeProject, ROOT, runCli } from './overview-helpers.js';

const checks = (problems) => problems.map((p) => `${p.check}: ${p.message}`);

describe('globs and which description a file gets', () => {
  test('*, **, ? and {a,b} mean what they say', () => {
    const m = (glob, path_) => globToRegExp(glob).test(path_);
    assert.ok(m('server/*.js', 'server/a.js'));
    assert.ok(!m('server/*.js', 'server/lib/a.js'), '* stops at a slash');
    assert.ok(m('server/**', 'server/lib/a.js'));
    assert.ok(m('**/a.js', 'a.js'));
    assert.ok(m('**/a.js', 'x/y/a.js'));
    assert.ok(m('docs/*.{html,css}', 'docs/x.css'));
    assert.ok(!m('docs/*.{html,css}', 'docs/x.js'));
    assert.ok(m('a?.txt', 'ab.txt'));
    assert.ok(!m('a?.txt', 'a/.txt'));
    assert.ok(m('media/01_setup (1).py', 'media/01_setup (1).py'), 'brackets and dots in a name are literal');
    assert.ok(!m('a.js', 'ab.js'), 'a dot is a dot');
  });

  test('an exact path beats any glob, and a longer literal beats a shorter one', () => {
    const entries = compileEntries([
      { match: 'server/**', desc: 'any' },
      { match: 'server/routes/*.js', desc: 'routes' },
      { match: 'server/routes/pages.js', desc: 'exact' },
      { match: '**', desc: 'everything' },
    ]);
    assert.equal(bestEntry('server/routes/pages.js', entries).entry.desc, 'exact');
    assert.equal(bestEntry('server/routes/api.js', entries).entry.desc, 'routes');
    assert.equal(bestEntry('server/lib/x.js', entries).entry.desc, 'any');
    assert.equal(bestEntry('README.md', entries).entry.desc, 'everything');
    assert.ok(specificity('a/b.js') > specificity('a/*.js'));
    assert.ok(specificity('a/*.js') > specificity('a/**'));
  });
});

describe('the scanner', () => {
  test('lists files with lines and sizes, in a stable order, and skips what git ignores', () => {
    const p = makeProject({ files: { '.env': 'SECRET=real\n', 'node_modules/x/index.js': 'x', 'src/__pycache__/b.cpython-313.pyc': 'x', '.git/HEAD': 'ref', 'key.pem': 'x', 'service-account-1.json': '{}', 'media/a.jpg': 'jpegbytes' } });
    try {
      const scan = scanTree(p.root);
      const paths = scan.files.map((f) => f.path);
      assert.deepEqual(paths, [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'plain code-unit order');
      for (const hidden of ['.env', 'node_modules/x/index.js', 'src/__pycache__/b.cpython-313.pyc', '.git/HEAD', 'key.pem', 'service-account-1.json']) assert.ok(!paths.includes(hidden), hidden);
      assert.ok(paths.includes('.env.example'), '.env.example is a project file');
      const a = scan.files.find((f) => f.path === 'src/a.js');
      assert.equal(a.lines, 1);
      assert.equal(a.lang, 'JavaScript');
      assert.equal(scan.files.find((f) => f.path === 'src/b.py').lang, 'Python');
      const jpg = scan.files.find((f) => f.path === 'media/a.jpg');
      assert.equal(jpg.lines, null);
      assert.equal(jpg.lang, 'Media');
      assert.ok(!scan.dirs.some((d) => /node_modules|__pycache__|\.git/.test(d)));
    } finally { p.cleanup(); }
  });

  test('a private file is never opened, so it cannot be counted or leaked', { skip: process.getuid?.() === 0 && 'root can read anything' }, () => {
    const p = makeProject();
    try {
      p.write('.env', 'GCP_SERVICE_ACCOUNT_JSON=secret\n');
      fs.chmodSync(path.join(p.root, '.env'), 0o000);
      p.write('.env.local', 'x');
      fs.chmodSync(path.join(p.root, '.env.local'), 0o000);
      assert.doesNotThrow(() => scanTree(p.root));
      assert.ok(!scanTree(p.root).files.some((f) => f.path.startsWith('.env.') && f.path !== '.env.example'));
    } finally {
      fs.chmodSync(path.join(p.root, '.env'), 0o600);
      fs.chmodSync(path.join(p.root, '.env.local'), 0o600);
      p.cleanup();
    }
  });

  test('isIgnoredName mirrors .gitignore', () => {
    for (const n of ['.env', '.env.production', 'a.pem', 'x-key.json', 'service-account.json', 'a.pyc', '.DS_Store']) assert.equal(isIgnoredName(n, false), true, n);
    for (const n of ['.env.example', 'app.js', 'README.md', 'envfile.js']) assert.equal(isIgnoredName(n, false), false, n);
    for (const n of ['node_modules', '.git', '__pycache__', '.venv', 'models', 'data']) assert.equal(isIgnoredName(n, true), true, n);
    assert.equal(isIgnoredName('model', true), false, 'only models/ is ignored, not model/');
  });

  test('extra ignores from the catalog apply to files and folders', () => {
    const p = makeProject({ files: { 'old/x.py': 'x', 'legacy.txt': 'x' } });
    try {
      const scan = scanTree(p.root, ['old/**', 'legacy.txt']);
      assert.ok(!scan.files.some((f) => f.path.startsWith('old/') || f.path === 'legacy.txt'));
      assert.ok(!scan.dirs.includes('old'));
    } finally { p.cleanup(); }
  });
});

describe('check 1 and 2: every file is described, every entry matches something', () => {
  test('a file that is not in the catalog is reported by name', async () => {
    const p = makeProject({ files: { 'src/new-thing.js': 'export {};\n' } });
    try {
      const { problems } = await collect(p.root, { skipRoutes: true, skipLinks: true });
      assert.deepEqual(checks(problems), ['1: file not described in the catalog: src/new-thing.js']);
    } finally { p.cleanup(); }
  });

  test('a catalog entry that matches no file is reported (a ghost)', async () => {
    const p = makeProject({ catalog: (c) => c.files.files.push({ match: 'src/gone.js', owner: 'website', tags: ['Edit'], desc: 'Was here.' }) });
    try {
      const { problems } = await collect(p.root, { skipRoutes: true, skipLinks: true });
      assert.deepEqual(checks(problems), ['2: catalog entry matches no file: src/gone.js']);
    } finally { p.cleanup(); }
  });

  test('a glob that matches nothing is a ghost too, but a virtual entry is allowed to be absent', async () => {
    const p = makeProject({ catalog: (c) => c.files.files.push({ match: 'src/**/*.ts', owner: 'website', tags: ['Edit'], desc: 'No TypeScript.' }, { match: '.env', owner: 'private', tags: ['Private'], virtual: true, desc: 'Yours.' }) });
    try {
      const { problems } = await collect(p.root, { skipRoutes: true, skipLinks: true });
      assert.deepEqual(checks(problems), ['2: catalog entry matches no file: src/**/*.ts']);
    } finally { p.cleanup(); }
  });

  test('a provisional ghost is a warning, and --strict makes it an error', async () => {
    const p = makeProject({ catalog: (c) => {
      c.files.files.push({ match: 'server/**', owner: 'website', tags: ['Edit'], desc: 'Not written yet.' });
      c.meta.provisional = [{ glob: 'server/**', reason: 'being written' }];
    } });
    try {
      const soft = await collect(p.root, { skipRoutes: true, skipLinks: true });
      assert.deepEqual(soft.problems, []);
      assert.ok(soft.warnings.some((w) => /provisional.*server\/\*\*/.test(w)), soft.warnings.join('|'));
      const hard = await collect(p.root, { skipRoutes: true, skipLinks: true, strict: true });
      assert.deepEqual(checks(hard.problems), ['2: catalog entry matches no file: server/**']);
    } finally { p.cleanup(); }
  });

  test('a top-level folder without a description is reported, and so is a described folder that does not exist', async () => {
    const p = makeProject({ files: { 'extra/x.js': 'x' }, catalog: (c) => { c.files.dirs['ghost/'] = 'Nothing here.'; c.files.files.push({ match: 'extra/x.js', owner: 'website', tags: ['Edit'], desc: 'x' }); } });
    try {
      const { problems } = await collect(p.root, { skipRoutes: true, skipLinks: true });
      const list = checks(problems);
      assert.ok(list.includes('1: top-level directory not described in the catalog: extra/'), list.join('\n'));
      assert.ok(list.includes('2: catalog directory does not exist: ghost/'), list.join('\n'));
    } finally { p.cleanup(); }
  });

  test('everything the catalog points at must exist: diagram files, flow files, and the named function', async () => {
    const p = makeProject({ catalog: (c) => {
      c.architecture.nodes[0].files.push('src/missing.js');
      c.flows.flows[0].steps.push({ title: 'Two', text: 't', nodes: ['a'], edges: [], file: 'src/a.js', fn: 'notThere' });
      c.flows.flows[0].steps.push({ title: 'Three', text: 't', nodes: ['a'], edges: [], file: 'src/ghost.js' });
    } });
    try {
      const { problems } = await collect(p.root, { skipRoutes: true, skipLinks: true });
      const list = checks(problems);
      assert.equal(list.length, 3, list.join('\n'));
      assert.ok(list.some((l) => /architecture node "a".*src\/missing\.js/.test(l)));
      assert.ok(list.some((l) => /flow "f" step 2 names notThere, which is not in src\/a\.js/.test(l)));
      assert.ok(list.some((l) => /flow "f" step 3.*src\/ghost\.js/.test(l)));
    } finally { p.cleanup(); }
  });

  test('a function is found by whole word, in JavaScript or Python', async () => {
    const p = makeProject({ catalog: (c) => { c.flows.flows[0].steps.push({ title: 'Py', text: 't', nodes: ['a'], edges: [], file: 'src/b.py', fn: 'hi' }, { title: 'Prefix', text: 't', nodes: ['a'], edges: [], file: 'src/a.js', fn: 'hell' }); } });
    try {
      const { problems } = await collect(p.root, { skipRoutes: true, skipLinks: true });
      assert.deepEqual(checks(problems), ['2: flow "f" step 3 names hell, which is not in src/a.js']);
    } finally { p.cleanup(); }
  });

  test('the catalog format is checked: unknown owner, unknown tag, unknown node, missing field', async () => {
    const p = makeProject({ catalog: (c) => {
      c.files.files[0].owner = 'nobody';
      c.files.files[1].tags = ['Nope'];
      c.architecture.edges[0].to = 'zzz';
      delete c.api.routes[0].summary;
    } });
    try {
      const { problems } = await collect(p.root, { skipRoutes: true, skipLinks: true });
      const list = checks(problems).join('\n');
      assert.match(list, /unknown owner "nobody"/);
      assert.match(list, /unknown tag "Nope"/);
      assert.match(list, /edge e: unknown node zzz/);
      assert.match(list, /api route GET \/api\/x is missing "summary"/);
    } finally { p.cleanup(); }
  });

  test('npm scripts: a script nobody described, and a description of a script that is gone', async () => {
    const p = makeProject({ catalog: (c) => { c.commands.npm.push({ script: 'gone', group: 'run', desc: 'x' }); } });
    try {
      p.write('package.json', { name: 'mini', version: '1.2.3', scripts: { start: 'x', test: 'x', 'build:thing': 'x' } });
      const { problems } = await collect(p.root, { skipRoutes: true, skipLinks: true });
      const list = checks(problems);
      assert.ok(list.some((l) => /^1: npm script "build:thing" is not described/.test(l)), list.join('\n'));
      assert.ok(list.some((l) => /^2: catalog describes npm script "gone"/.test(l)), list.join('\n'));
    } finally { p.cleanup(); }
  });
});

describe('check 4: the variable table and .env.example', () => {
  test('names are read from assignments, including commented examples, once each', () => {
    const text = [
      '# =====', '#  Section 1', '# A sentence with SOME_THING=value inside is not an assignment', 'HOST=127.0.0.1', 'PORT=8080',
      '# ALLOWED_HOSTS=studio.example.com', '#   pip install -r requirements.txt', "GCP_SERVICE_ACCOUNT_JSON='{\"a\":1}'", '#      GCP_SERVICE_ACCOUNT_JSON=\'{"type":"service_account"}\'',
      '  INDENTED=1', 'lowercase=1', '# 3. Set SAM_BACKEND=sam3 and the paths', '', 'EMPTY=',
    ].join('\n');
    assert.deepEqual(parseEnvExample(text), ['HOST', 'PORT', 'ALLOWED_HOSTS', 'GCP_SERVICE_ACCOUNT_JSON', 'INDENTED', 'EMPTY']);
  });

  const v = (name, extra = {}) => ({ name, ...extra });

  test('everything in .env.example must be described', () => {
    assert.deepEqual(checks(checkEnv([v('HOST')], ['HOST', 'PORT'])), ['4: PORT is in .env.example but not described in the catalog']);
  });

  test('everything described must be in .env.example, unless the entry says why not', () => {
    assert.deepEqual(checks(checkEnv([v('HOST'), v('NEW_ONE')], ['HOST'])), ['4: NEW_ONE is described in the catalog but missing from .env.example (add it there, or give the entry a "notInExample" reason)']);
    assert.deepEqual(checkEnv([v('HOST'), v('TEST_ONLY', { notInExample: 'tests only' })], ['HOST']), []);
  });

  test('a stale notInExample flag is reported, and so is a variable described twice', () => {
    assert.match(checks(checkEnv([v('HOST', { notInExample: 'x' })], ['HOST']))[0], /HOST is in \.env\.example, but the catalog says it is not/);
    assert.match(checks(checkEnv([v('HOST'), v('HOST')], ['HOST']))[0], /described twice: HOST/);
  });

  test('through collect(): a variable added to .env.example is caught', async () => {
    const p = makeProject();
    try {
      p.write('.env.example', 'HOST=1\nPORT=2\nSECRET=\nBRAND_NEW=3\n');
      const { problems } = await collect(p.root, { skipRoutes: true, skipLinks: true });
      assert.deepEqual(checks(problems), ['4: BRAND_NEW is in .env.example but not described in the catalog']);
    } finally { p.cleanup(); }
  });

  test('the real catalog and the real .env.example agree', async () => {
    const { problems } = await collect(ROOT, { skipRoutes: true, skipLinks: true });
    assert.deepEqual(checks(problems.filter((p) => p.check === 4)), []);
  });
});

describe('check 3: routes', () => {
  const r = (method, path_, owner = 'JS', extra = {}) => ({ method, path: path_, owner, ...extra });

  test('normalizeRoute trims a trailing slash and upper-cases the method', () => {
    assert.equal(normalizeRoute('get', '/api/x/'), 'GET /api/x');
    assert.equal(normalizeRoute('GET', '/'), 'GET /');
  });

  test('a catalog route the app does not register is a problem; so is a registered route the catalog does not know', () => {
    const catalog = [r('GET', '/api/health'), r('POST', '/api/save')];
    assert.deepEqual(checkRoutes(catalog, [r('GET', '/api/health'), r('POST', '/api/save')]), []);
    assert.deepEqual(checks(checkRoutes(catalog, [r('GET', '/api/health')])), ['3: catalog route POST /api/save (JS) is not registered by the Express app (app.js)']);
    assert.deepEqual(checks(checkRoutes(catalog, [r('GET', '/api/health'), r('POST', '/api/save'), r('GET', '/api/secret')])), ['3: the Express app (app.js) registers GET /api/secret, which the catalog does not describe']);
  });

  test('the method counts', () => {
    assert.equal(checkRoutes([r('POST', '/api/x')], [r('GET', '/api/x')]).length, 2);
  });

  test('catch-all handlers are not "routes", derived rows are not compared, and ALL covers a method', () => {
    const catalog = [r('GET', '/{page}', 'JS', { derived: true }), r('GET', '/media/*name'), r('GET', '/api/x')];
    const actual = [r('GET', '/media/*name'), r('GET', '/{*splat}'), r('ALL', '/api/x'), r('GET', '/*rest'), r('GET', '*')];
    assert.deepEqual(checks(checkRoutes(catalog, actual)), []);
  });

  test('without the registered routes (the app could not be read) nothing is compared, but the catalog is still checked against itself', () => {
    assert.deepEqual(checkRoutes([r('GET', '/api/a')], null), []);
    assert.match(checks(checkRoutes([r('GET', '/a'), r('GET', '/a')], null))[0], /described twice/);
  });

  test('a route listed twice is reported, and a siteRef must agree with site.json', () => {
    assert.match(checks(checkRoutes([r('GET', '/a'), r('GET', '/a')], null))[0], /described twice in the catalog: GET \/a/);
    const site = { pages: {}, docs: { overview: { route: '/project-overview', aliases: [] } } };
    assert.deepEqual(checkRoutes([r('GET', '/project-overview', 'JS', { derived: true, siteRef: 'docs.overview.route' })], null, site), []);
    assert.match(checks(checkRoutes([r('GET', '/overview', 'JS', { derived: true, siteRef: 'docs.overview.route' })], null, site))[0], /should be \/project-overview/);
  });

  test('siteRoutePaths lists routes, aliases, legacy names and docs', () => {
    const site = { pages: { home: { route: '/', aliases: ['/index.html'] } }, legacy_names: { 'Old Name.html': 'home' }, docs: { o: { route: '/project-overview', aliases: ['/docs/X.html'] } } };
    assert.deepEqual(siteRoutePaths(site).sort(), ['/', '/Old Name.html', '/docs/X.html', '/index.html', '/project-overview']);
  });

  test('walkStack reads Express 5 routes, including routers mounted at a prefix', async () => {
    const p = makeProject();
    try {
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(p.root, 'node_modules'), 'dir');
      p.write('app.js', [
        "import express from 'express';",
        'export function createApp() {',
        '  const app = express();',
        '  const api = express.Router();',
        "  api.get('/health', (q, s) => s.end());",
        "  api.post('/items', (q, s) => s.end());",
        '  const admin = express.Router();',
        "  admin.get('/health', (q, s) => s.end());",
        "  api.use('/admin', admin);",
        "  app.use('/api', api);",
        "  app.get('/media/*name', (q, s) => s.end());",
        "  app.get('/', (q, s) => s.end());",
        "  app.get(['/a', '/b'], (q, s) => s.end());",
        "  app.all('/anything', (q, s) => s.end());",
        "  app.use((q, s) => s.status(404).end());",
        '  app.locals.terucon = { close: async () => { globalThis.__closed = true; } };',
        '  return app;',
        '}',
      ].join('\n'));
      const { routes, warning } = await readExpressRoutes(p.root);
      assert.equal(warning, undefined);
      const got = routes.map((x) => `${x.method} ${x.path}`).sort();
      assert.deepEqual(got, ['ALL /anything', 'GET /', 'GET /a', 'GET /api/admin/health', 'GET /api/health', 'GET /b', 'GET /media/*name', 'POST /api/items'].sort());
      assert.equal(globalThis.__closed, true, 'the app is closed again');
    } finally { p.cleanup(); }
  });

  test('walkStack on a hand-made stack and an unknown mount path', () => {
    const route = (path_, methods) => ({ route: { path: path_, methods } });
    const router = { name: 'router', handle: { stack: [route('/x', { get: true, head: true })] } };
    assert.deepEqual(walkStack([route('/a', { post: true }), router], () => '/m'), [{ method: 'POST', path: '/a' }, { method: 'GET', path: '/m/x' }]);
    assert.deepEqual(walkStack([router], () => '?'), [{ method: 'GET', path: '/?/x' }]);
  });

  test('without an app the check degrades to a warning, and a broken app does too', async () => {
    const p = makeProject();
    // The clock stands still, so every import below gets the same millisecond: each one must still be a fresh module, or the
    // second import of app.js would be answered with the failure of the first.
    const realNow = Date.now;
    try {
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(p.root, 'node_modules'), 'dir');
      Date.now = () => 1_700_000_000_000;
      assert.match((await readExpressRoutes(p.root)).warning, /app\.js does not exist yet/);
      p.write('app.js', 'throw new Error("boom");\n');
      assert.match((await readExpressRoutes(p.root)).warning, /could not be started for the route check \(boom\)/);
      p.write('app.js', 'export const x = 1;\n');
      assert.match((await readExpressRoutes(p.root)).warning, /does not export createApp/);
      const { problems, warnings } = await collect(p.root, { skipLinks: true });
      assert.deepEqual(checks(problems), ['1: file not described in the catalog: app.js'], 'no route problem, only a warning');
      assert.ok(warnings.some((w) => /createApp/.test(w)));
    } finally {
      Date.now = realNow;
      p.cleanup();
    }
  });

  test('the real catalog agrees with the real Express app', async () => {
    const { problems } = await collect(ROOT, { skipLinks: true });
    assert.deepEqual(checks(problems.filter((x) => x.check === 3)), []);
  });
});

describe('test counts', () => {
  test('node:test, unittest and await test( are counted per suite', () => {
    const p = makeProject({ files: {
      'tests/js/b.test.js': "test('a', () => {});\n  it('b', () => {});\ntest.skip('c', () => {});\n// test('commented', () => {});\nconst x = `test(`;\n",
      'scripts/test_x.py': 'class A:\n    def test_one(self): ...\n    def helper(self): ...\n    async def test_two(self): ...\n',
      'tests/e2e/run.mjs': "await test('one', async () => {});\nawait test('two', async () => {});\n",
    } });
    try {
      const files = scanTree(p.root).files;
      const out = countTests(p.root, [
        { id: 'js', counter: 'node-test', files: ['tests/js/*.test.js'] },
        { id: 'py', counter: 'py-def', files: ['scripts/test_*.py'] },
        { id: 'e2e', counter: 'await-test', files: ['tests/e2e/run.mjs'] },
      ], files);
      assert.deepEqual(out.map((s) => [s.id, s.count]), [['js', 2 + 3], ['py', 2], ['e2e', 2]]);
      assert.deepEqual(out[0].perFile, [{ path: 'tests/js/a.test.js', count: 2 }, { path: 'tests/js/b.test.js', count: 3 }]);
      assert.throws(() => countTests(p.root, [{ id: 'x', counter: 'nope', files: [] }], files), /unknown counter/);
    } finally { p.cleanup(); }
  });
});

describe('the whole run', () => {
  test('--check on a consistent project that has no page yet says the page is missing, and writes nothing', async () => {
    const p = makeProject();
    try {
      const res = await runCli(run, p.root, ['--check', '--no-routes', '--no-links', '--no-git']);
      assert.equal(res.code, 1);
      assert.match(res.err, /docs\/PROJECT_OVERVIEW\.html is stale/);
      assert.equal(fs.existsSync(path.join(p.root, 'docs/PROJECT_OVERVIEW.html')), false, '--check never writes');
    } finally { p.cleanup(); }
  });

  test('the failure list is readable: grouped, one line each, and says what to do', async () => {
    const p = makeProject({ files: { 'src/new.js': 'x' }, catalog: (c) => c.files.files.push({ match: 'src/gone.js', owner: 'website', tags: ['Edit'], desc: 'x' }) });
    try {
      p.write('.env.example', 'HOST=1\nBRAND_NEW=2\n');
      const res = await runCli(run, p.root, ['--check', '--no-routes', '--no-links', '--no-git']);
      assert.equal(res.code, 1);
      assert.match(res.err, /\d+ problems? with the project overview/);
      assert.match(res.err, /undocumented\n\s+- file not described in the catalog: src\/new\.js/);
      assert.match(res.err, /ghost entries\n\s+- catalog entry matches no file: src\/gone\.js/);
      assert.match(res.err, /environment variables\n(?:\s+- .*\n)*\s+- BRAND_NEW is in \.env\.example but not described/);
      assert.match(res.err, /node tools\/build-overview\.js/);
    } finally { p.cleanup(); }
  });

  test('the privacy check: a file git ignores must not have been scanned', { skip: spawnGit(ROOT, ['--version']).status !== 0 && 'git is not installed' }, async () => {
    const p = makeProject();
    try {
      const git = (...args) => { const r = spawnGit(p.root, args); assert.equal(r.status, 0, r.stderr); };
      git('init', '-q');
      p.write('.gitignore', 'src/b.py\n');
      const scan = scanTree(p.root);
      const found = checkPrivacy(p.root, scan).map((x) => x.message);
      assert.ok(found.some((m) => /scanner read src\/b\.py, which git ignores/.test(m)), found.join('\n'));
    } finally { p.cleanup(); }
  });

  test('the first build, with no page yet, passes the privacy check in a git repository and writes the page', { skip: spawnGit(ROOT, ['--version']).status !== 0 && 'git is not installed' }, async () => {
    const p = makeProject();
    try {
      assert.equal(spawnGit(p.root, ['init', '-q']).status, 0);
      assert.ok(!fs.existsSync(path.join(p.root, 'docs/PROJECT_OVERVIEW.html')));
      const res = await runCli(run, p.root, ['--no-routes', '--no-links']);
      assert.equal(res.code, 0, res.err);
      assert.ok(fs.existsSync(path.join(p.root, 'docs/PROJECT_OVERVIEW.html')));
      const again = await runCli(run, p.root, ['--check', '--no-routes', '--no-links']);
      assert.equal(again.code, 0, again.err);
    } finally { p.cleanup(); }
  });
});

function spawnGit(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
}
