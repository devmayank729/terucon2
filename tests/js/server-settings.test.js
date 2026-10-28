import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { describe as describeSettings, loadSettings, SettingsManager } from '../../server/config/settings.js';

const cases = JSON.parse(fs.readFileSync(new URL('../fixtures/env-cases.json', import.meta.url), 'utf8'));
let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-settings-'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Settings from env-file text. The environment is explicit (empty unless given), so nothing real leaks in. */
function settingsFrom(text, environ = {}) {
  const file = path.join(dir, `${Math.random().toString(36).slice(2)}.env`);
  fs.writeFileSync(file, text);
  return loadSettings(file, environ, dir);
}

/** The normalised view the shared fixture talks about. */
function view(s) {
  return { host: s.host, port: s.port, allowedHosts: s.allowedHosts, warnings: s.warnings };
}

describe('shared settings cases (tests/fixtures/env-cases.json)', () => {
  for (const c of cases.settings) {
    test(c.name, () => {
      const v = view(settingsFrom(c.envFile, c.environ));
      for (const [dotted, want] of Object.entries(c.expect)) {
        const got = dotted.split('.').reduce((o, p) => o?.[p], v);
        if (want !== null && typeof want === 'object' && 'contains' in want) assert.ok(String(got).includes(want.contains), `${dotted}: ${JSON.stringify(got)} should contain ${want.contains}`);
        else if (want !== null && typeof want === 'object' && 'anyContains' in want) assert.ok(got.some((x) => x.includes(want.anyContains)), `${dotted}: ${JSON.stringify(got)}`);
        else assert.deepEqual(got, want, dotted);
      }
    });
  }
});

describe('numbers', () => {
  test('PORT is read as a number: blanks and hex are not numbers, decimals and exponents are', () => {
    assert.equal(settingsFrom('PORT=\n').port, 8080);
    assert.equal(settingsFrom('PORT=0x10\n').port, 8080);
    assert.equal(settingsFrom('PORT=abc\n').port, 8080);
    assert.equal(settingsFrom('PORT=1e3\n').port, 1000);
    assert.equal(settingsFrom('PORT=2000.9\n').port, 2000);
    assert.equal(settingsFrom('PORT=-5\n').port, 0);
  });

  test('PORT: default 8080, a port is kept, 0 means "pick one" (tests), too big is clamped, junk falls back', () => {
    assert.equal(settingsFrom('').port, 8080);
    assert.equal(settingsFrom('PORT=9000\n').port, 9000);
    assert.equal(settingsFrom('PORT=0\n').port, 0);
    assert.equal(settingsFrom('PORT=99999\n').port, 65535);
    assert.equal(settingsFrom('PORT=http\n').port, 8080);
  });

  test('host and allowed hosts', () => {
    const s = settingsFrom('HOST=0.0.0.0\nALLOWED_HOSTS= Studio.Example.com , other.test \n');
    assert.equal(s.host, '0.0.0.0');
    assert.deepEqual(s.allowedHosts, ['studio.example.com', 'other.test']);
  });
});

// What the old Design Studio backend kept in the settings: Google credentials, model names, segmentation, SAM, the model service.
const REMOVED_FIELDS = ['google', 'models', 'segmentationEngine', 'edgeRefine', 'edgeMethod', 'analysisMaxSide', 'sam', 'model', 'allowCustomGoogleEndpoints', 'vertexApiBase'];

describe('what is read', () => {
  test('the file, the host, the port and the allowed hosts, and the list of warnings', () => {
    const s = settingsFrom('');
    for (const field of ['envPath', 'envFileFound', 'host', 'port', 'allowedHosts', 'warnings']) assert.ok(field in s, field);
    assert.equal(s.envFileFound, true);
    assert.deepEqual(s.warnings, []);
  });

  test('the variables of the old Design Studio backend are ignored, without a warning', () => {
    const s = settingsFrom('GEMINI_API_KEY=abc123\nGCP_SERVICE_ACCOUNT_JSON={not json\nSEGMENTATION_ENGINE=bogus\nSAM_ENABLED=true\nSAM_SERVER_KEY=s3cret\nMODEL_SERVICE=cloud\nPORT=7000\n');
    for (const field of REMOVED_FIELDS) assert.ok(!(field in s), `${field} is gone from the settings`);
    assert.equal(s.port, 7000);
    assert.deepEqual(s.warnings, []);
  });

  test('the env file is the one asked for, and a missing file is reported but is not an error', () => {
    const file = path.join(dir, 'not-there.env');
    const s = loadSettings(file, {}, dir);
    assert.equal(s.envPath, file);
    assert.equal(s.envFileFound, false);
    assert.equal(s.port, 8080);
    assert.equal(loadSettings(undefined, {}, dir).envPath, path.join(dir, '.env'), 'without a file name: <root>/.env');
  });

  test('describe() gives the banner a list of lines', () => {
    const lines = describeSettings(settingsFrom('HOST=0.0.0.0\nPORT=1234\nALLOWED_HOSTS=a.test\n'));
    assert.ok(Array.isArray(lines));
    assert.ok(lines.every((line) => typeof line === 'string'));
  });
});

describe('SettingsManager', () => {
  test('editing the env file is picked up without a restart, and the version counts reloads', () => {
    const file = path.join(dir, 'reload.env');
    fs.writeFileSync(file, '');
    const manager = new SettingsManager(file, {}, dir);
    assert.equal(manager.get().port, 8080);
    assert.equal(manager.version, 1);
    assert.equal(manager.get(), manager.get(), 'unchanged file: same object');
    assert.equal(manager.version, 1);
    fs.writeFileSync(file, 'PORT=9000\n');
    assert.equal(manager.get().port, 9000);
    assert.equal(manager.version, 2);
  });

  test('the file appearing and disappearing is noticed too', () => {
    const file = path.join(dir, 'later.env');
    const manager = new SettingsManager(file, {}, dir);
    assert.equal(manager.get().envFileFound, false);
    fs.writeFileSync(file, 'ALLOWED_HOSTS=studio.example.com\n');
    assert.deepEqual(manager.get().allowedHosts, ['studio.example.com']);
    assert.equal(manager.get().envFileFound, true);
    fs.rmSync(file);
    assert.deepEqual(manager.get().allowedHosts, []);
    assert.equal(manager.get().envFileFound, false);
  });

  test('the real environment still wins over a file that changes', () => {
    const file = path.join(dir, 'wins.env');
    fs.writeFileSync(file, 'PORT=9000\n');
    const manager = new SettingsManager(file, { PORT: '9100' }, dir);
    assert.equal(manager.get().port, 9100);
    fs.writeFileSync(file, 'PORT=9001\nHOST=0.0.0.0\n');
    assert.equal(manager.get().port, 9100);
    assert.equal(manager.get().host, '0.0.0.0');
  });
});

describe('the Design Studio wake-up switch (STUDIO_WARMUP)', () => {
  test('on by default: the landing page wakes the studio unless told not to', () => {
    assert.equal(settingsFrom('').studio.warmup, true);
    assert.equal(settingsFrom('STUDIO_WARMUP=\n').studio.warmup, true, 'blank means the default');
  });

  test('the usual spellings of off switch it off, and the real environment wins over the file', () => {
    for (const off of ['off', 'OFF', 'false', '0', 'no', 'n']) assert.equal(settingsFrom(`STUDIO_WARMUP=${off}\n`).studio.warmup, false, off);
    for (const on of ['on', 'true', '1', 'yes', 'y']) assert.equal(settingsFrom(`STUDIO_WARMUP=${on}\n`).studio.warmup, true, on);
    assert.equal(settingsFrom('STUDIO_WARMUP=on\n', { STUDIO_WARMUP: 'off' }).studio.warmup, false);
  });

  test('something that is not a yes or a no keeps the default, so a typo can not switch the feature off', () => {
    assert.equal(settingsFrom('STUDIO_WARMUP=maybe\n').studio.warmup, true);
  });

  test('the banner says which it is', () => {
    assert.match(describeSettings(settingsFrom('')).join('\n'), /landing page and the studio page wake/);
    assert.match(describeSettings(settingsFrom('STUDIO_WARMUP=off\n')).join('\n'), /only when a photo is scanned/);
  });
});
