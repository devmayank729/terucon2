import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// What git commits and what Docker copies, checked from the outside. Everything else in the suite looks at files on disk, which
// is exactly why this one exists: an unanchored rule such as "models/" in .gitignore (meant for the old service's weights)
// quietly keeps swatchroom/server/models/ out of every commit, the files are all there on the machine that made them, and the
// first clone or deploy then dies on `Cannot find module '../models/Room'`.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const isRepo = git('rev-parse', '--is-inside-work-tree').stdout?.trim() === 'true';
const skip = !isRepo && 'not a git checkout';

// the only things under swatchroom/ that git may leave out: the studio's secrets and local caches (what its own .gitignore says)
const MAY_BE_IGNORED = [
  /^swatchroom\/\.env$/,
  /^swatchroom\/keys\//,
  /(^|\/)__pycache__\//,
  /\.pyc$/,
  /(^|\/)\.DS_Store$/,
  /^swatchroom\/node_modules\//,
  /^swatchroom\/python\/\.venv\//,
  /^swatchroom\/tests\/shots-/,
  /^swatchroom\/tests\/sa\.json$/,
  /^swatchroom\/tests\/[^/]+\.jpg$/,
  /\.log$/,
];

test('everything in swatchroom/ except its secrets and caches would be committed', { skip }, () => {
  const ignored = git('ls-files', '--others', '--ignored', '--exclude-standard', '--', 'swatchroom').stdout.split('\n').filter(Boolean);
  const dropped = ignored.filter((file) => !MAY_BE_IGNORED.some((re) => re.test(file)));
  assert.deepEqual(dropped, [], 'git would silently leave these out of a commit (an ignore rule is too broad):\n  ' + dropped.join('\n  '));
});

test('the studio\'s source folders that older rules of this repo would have hidden are tracked-able', { skip }, () => {
  for (const file of ['swatchroom/server/models/Room.js', 'swatchroom/public/js/data/catalog.js', 'swatchroom/server/lib/wake.js', 'swatchroom/terucon/Swatchroom.html', 'swatchroom/tests/.env.test', 'swatchroom/.env.example']) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
    assert.equal(git('check-ignore', '-q', file).status, 1, `${file} is ignored by git`);
  }
});

test('secrets are ignored by git: the website\'s .env, the studio\'s .env and its keys', { skip }, () => {
  for (const file of ['.env', 'swatchroom/.env', 'swatchroom/keys/swatchroom-key.json', 'swatchroom/keys/any-name.json', 'service-account.json']) {
    assert.equal(git('check-ignore', '-q', file).status, 0, `${file} is NOT ignored: it could be committed`);
  }
});

test('the Docker image leaves the studio\'s secrets out as well as the website\'s', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const rule of ['**/.env', '**/.env.*', '!**/.env.example', '**/*-key.json', '**/keys/', '**/node_modules', '**/.venv']) {
    assert.ok(lines.includes(rule), `.dockerignore lacks ${rule}: root-relative patterns do not cover swatchroom/`);
  }
});

test('the Dockerfile installs the studio\'s packages too: its package.json is copied before npm ci', () => {
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.ok(docker.indexOf('COPY swatchroom/package.json') !== -1 && docker.indexOf('COPY swatchroom/package.json') < docker.indexOf('npm ci'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.workspaces, ['swatchroom']);
});
