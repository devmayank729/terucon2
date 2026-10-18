#!/usr/bin/env node
// npm test: every check that needs no credentials, in order, with one summary at the end (the overview's browser test uses Chrome
// when it is installed and skips itself otherwise; the full browser suite is --e2e).
//
//   npm test                 site build check, link check, overview check, JavaScript tests, Python model tests
//   npm test -- --e2e        also the browser tests (Chrome; starts the real site against a mock Google)
//   npm test -- --strict     a missing Python environment is a failure, not a skip
//   npm test -- --only js    run one step (build, links, overview, js, python, e2e)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const onlyAt = args.indexOf('--only');
const only = onlyAt > -1 ? args[onlyAt + 1] : '';
const withE2e = args.includes('--e2e') || only === 'e2e';

const PROBE = 'import flask, numpy, PIL, cv2, requests, google.auth, cryptography';

/** The Python the model service would use: PYTHON, then a virtualenv in model/ or the root, then python3 / python. */
function findPython() {
  const win = process.platform === 'win32';
  const venv = (dir) => path.join(root, dir, win ? 'Scripts/python.exe' : 'bin/python');
  const candidates = [process.env.PYTHON, venv('model/.venv'), venv('.venv'), 'python3', 'python'].filter(Boolean);
  for (const c of candidates) {
    if (path.isAbsolute(c) && !existsSync(c)) continue;
    const r = spawnSync(c, ['-c', PROBE], { encoding: 'utf8' });
    if (r.status === 0) return { cmd: c };
    if (r.error === undefined && !path.isAbsolute(c)) return { cmd: null, why: `${c} is missing a package: ${(r.stderr || '').trim().split('\n').pop()}` };
  }
  return { cmd: null, why: 'no Python was found' };
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
  { id: 'js', label: 'JavaScript tests (server, build, overview)', go: () => run('JavaScript tests', node, ['--test', 'tests/js/']) },
  {
    id: 'python',
    label: 'Python model-service tests',
    go: async () => {
      const py = findPython();
      if (!py.cmd) {
        const msg = `${py.why}. Install the model service's packages: npm run setup:model`;
        console.log(`\n== Python model tests\n   ${strict ? 'FAILED' : 'SKIPPED'}: ${msg}`);
        return { label: 'Python model tests', ok: !strict, skipped: !strict, note: msg, secs: 0 };
      }
      return run('Python model tests', py.cmd, ['-m', 'unittest', 'discover', '-s', 'model/tests', '-t', 'model']);
    },
  },
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
for (const r of results) console.log(`   ${r.skipped ? 'skip' : r.ok ? 'ok  ' : 'FAIL'}  ${r.label}${r.secs ? `  (${r.secs.toFixed(1)}s)` : ''}${r.note ? `  - ${r.note}` : ''}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} steps failed.` : '\nAll steps passed.');
process.exit(failed.length ? 1 : 0);
