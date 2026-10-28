#!/usr/bin/env node
// npm test: every check that needs no credentials, in order, with one summary at the end (the overview's browser test uses Chrome
// when it is installed and skips itself otherwise; the full browser suite is --e2e).
//
//   npm test                 site build check, link check, overview check, JavaScript tests
//   npm test -- --e2e        also the browser tests (Chrome)
//   npm test -- --only js    run one step (build, links, overview, js, e2e)
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const onlyAt = args.indexOf('--only');
const only = onlyAt > -1 ? args[onlyAt + 1] : '';
const withE2e = args.includes('--e2e') || only === 'e2e';

/** Every tests/js/*.test.js, by name. `node --test tests/js/` does not look inside a folder on Node 21 and later, so the files are named one by one. */
function jsTestFiles() {
  return readdirSync(path.join(root, 'tests/js')).filter((name) => name.endsWith('.test.js')).sort().map((name) => `tests/js/${name}`);
}

function run(label, cmd, argv, cwd = root) {
  return new Promise((resolve) => {
    console.log(`\n== ${label}\n   $ ${[cmd, ...argv].join(' ')}`);
    const t0 = Date.now();
    const child = spawn(cmd, argv, { cwd, stdio: 'inherit', env: process.env });
    child.on('error', (e) => resolve({ label, ok: false, note: String(e.message), secs: 0 }));
    child.on('exit', (code) => resolve({ label, ok: code === 0, note: code === 0 ? '' : `exit ${code}`, secs: (Date.now() - t0) / 1000 }));
  });
}

const node = process.execPath;
const steps = [
  { id: 'build', label: 'site patches apply to the pristine exports', go: () => run('site build (check only)', node, ['tools/build-site.js', '--check']) },
  { id: 'links', label: 'every page links where the site map says', go: () => run('links between pages', node, ['tools/check-links.js']) },
  { id: 'overview', label: 'the project overview matches the tree', go: () => run('project overview is current', node, ['tools/build-overview.js', '--check']) },
  { id: 'js', label: 'JavaScript tests (server, build, overview)', go: () => run('JavaScript tests', node, ['--test', ...jsTestFiles()]) },
  ...(withE2e ? [{ id: 'e2e', label: 'browser tests', go: () => run('browser tests (Chrome)', node, ['tests/e2e/run.mjs']) }] : []),
];

const chosen = only ? steps.filter((s) => s.id === only) : steps;
if (!chosen.length) {
  console.error(`No step called "${only}". Steps: ${steps.map((s) => s.id).join(', ')}`);
  process.exit(2);
}
const results = [];
for (const s of chosen) results.push(await s.go());

console.log('\n== Summary');
for (const r of results) console.log(`   ${r.ok ? 'ok  ' : 'FAIL'}  ${r.label}${r.secs ? `  (${r.secs.toFixed(1)}s)` : ''}${r.note ? `  - ${r.note}` : ''}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} steps failed.` : '\nAll steps passed.');
process.exit(failed.length ? 1 : 0);
