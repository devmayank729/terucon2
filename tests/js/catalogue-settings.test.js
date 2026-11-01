import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { catalogueConfig, describeCatalogue } from '../../server/catalogue/config.js';
import { describe as describeSettings, loadSettings, SettingsManager } from '../../server/config/settings.js';
import { startTestApp } from '../helpers/app.js';

// The catalogue's settings: read from .env like every other setting, re-read when it changes, validated, described in the banner without a
// secret, and the admin-managed limits with their bounds.

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-catalogue-settings-'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function settingsFrom(text, environ = {}) {
  const file = path.join(dir, `${Math.random().toString(36).slice(2)}.env`);
  fs.writeFileSync(file, text);
  return loadSettings(file, environ, dir);
}

const KEY = 'sk-modal-key-aaaaaaaaaaaaaaaa';
const FULL = `CATALOGUE_MODAL_SEARCH_URL=https://acme--terucon-catalogue-search-api.modal.run/
CATALOGUE_MODAL_INGEST_URL=https://acme--terucon-catalogue-ingest-api.modal.run
CATALOGUE_MODAL_KEY=${KEY}
CATALOGUE_MODAL_PROXY_KEY=wk-proxy-key-0123456789
CATALOGUE_MODAL_PROXY_SECRET=ws-proxy-secret-0123456789
CATALOGUE_MODAL_TIMEOUT_MS=45000
CATALOGUE_GCS_BUCKET=terucon-catalogue-prod
CATALOGUE_GCS_PREFIX=catalogue
CATALOGUE_GCS_KEY_FILE=keys/catalogue-signer.json
CATALOGUE_SEARCH_PROFILE=Balanced
`;

describe('what is read', () => {
  test('nothing set: the feature is on but not set up, with no warning and a banner line that says what is missing', () => {
    const s = settingsFrom('');
    assert.deepEqual(s.warnings, []);
    assert.equal(s.catalogue.enabled, true);
    assert.deepEqual(s.catalogue.modal, { searchUrl: '', ingestUrl: '', timeoutMs: 60000, proxy: false });
    assert.deepEqual(s.catalogue.gcs, { bucket: '', prefix: 'catalogue/', keyFile: '', problem: '' });
    assert.equal(s.catalogue.profile, 'fast');
    const lines = describeSettings(s).filter((l) => l.startsWith('Catalogue search'));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /not set up.*colour demo.*CATALOGUE_MODAL_SEARCH_URL, CATALOGUE_MODAL_KEY, CATALOGUE_GCS_BUCKET, CATALOGUE_GCS_KEY_FILE/);
  });

  test('everything set: normalised values, and the banner names hosts and the bucket but no secret', () => {
    const s = settingsFrom(FULL);
    assert.deepEqual(s.warnings, []);
    assert.deepEqual(s.catalogue.modal, { searchUrl: 'https://acme--terucon-catalogue-search-api.modal.run', ingestUrl: 'https://acme--terucon-catalogue-ingest-api.modal.run', timeoutMs: 45000, proxy: true });
    assert.deepEqual(s.catalogue.gcs, { bucket: 'terucon-catalogue-prod', prefix: 'catalogue/', keyFile: path.join(dir, 'keys', 'catalogue-signer.json'), problem: '' });
    assert.equal(s.catalogue.profile, 'balanced');
    const cfg = catalogueConfig(s);
    assert.deepEqual([cfg.key, cfg.proxyKey, cfg.proxySecret], [KEY, 'wk-proxy-key-0123456789', 'ws-proxy-secret-0123456789']);
    const banner = describeSettings(s).join('\n');
    assert.match(banner, /Catalogue search: on; search app acme--terucon-catalogue-search-api\.modal\.run, ingest app acme--terucon-catalogue-ingest-api\.modal\.run, pictures from bucket terucon-catalogue-prod under catalogue\/, profile balanced, Modal proxy auth on/);
    for (const secret of [KEY, 'wk-proxy-key-0123456789', 'ws-proxy-secret-0123456789']) {
      assert.equal(banner.includes(secret), false);
      assert.equal(JSON.stringify(s).includes(secret), false, 'secrets do not show when the settings are listed or turned into JSON');
      assert.equal(JSON.stringify({ ...s }).includes(secret), false);
      assert.equal(s.warnings.join().includes(secret), false);
    }
    assert.equal('catalogueSecrets' in s, true);
    assert.equal(Object.keys(s).includes('catalogueSecrets'), false);
  });

  test('half set up is "not ready" and lists exactly what is missing; off is off', () => {
    const half = describeCatalogue(settingsFrom(`CATALOGUE_MODAL_SEARCH_URL=https://a.modal.run\nCATALOGUE_MODAL_KEY=${KEY}\n`)).join('\n');
    assert.match(half, /NOT READY.*missing in \.env: CATALOGUE_GCS_BUCKET, CATALOGUE_GCS_KEY_FILE\)/);
    assert.equal(half.includes('CATALOGUE_MODAL_KEY,'), false);
    const noIngest = describeCatalogue(settingsFrom(`${FULL.replace(/CATALOGUE_MODAL_INGEST_URL=.*\n/, '')}`)).join('\n');
    assert.match(noIngest, /ingest app NOT SET \(admin uploads need CATALOGUE_MODAL_INGEST_URL\)/);
    for (const off of ['off', 'OFF', 'no', 'false', '0']) {
      const s = settingsFrom(`${FULL}CATALOGUE=${off}\n`);
      assert.equal(s.catalogue.enabled, false, off);
      assert.deepEqual(describeCatalogue(s), ['Catalogue search: off (CATALOGUE=off); the shop keeps its colour demo']);
    }
    assert.equal(settingsFrom('CATALOGUE=on\n').catalogue.enabled, true);
    const junk = settingsFrom('CATALOGUE=maybe\n');
    assert.equal(junk.catalogue.enabled, true);
    assert.deepEqual(junk.warnings, ['CATALOGUE=maybe is not on or off: the catalogue stays on.']);
  });
});

describe('what is refused', () => {
  test('addresses: https, or http on this computer; no user name, password, query or fragment; trailing slashes are dropped', () => {
    const url = (value) => settingsFrom(`CATALOGUE_MODAL_SEARCH_URL=${value}\n`);
    for (const [value, want] of [['https://a.modal.run', 'https://a.modal.run'], ['https://a.modal.run///', 'https://a.modal.run'], ['https://a.modal.run:8443/api/', 'https://a.modal.run:8443/api'], ['http://127.0.0.1:4010', 'http://127.0.0.1:4010'], ['http://127.0.0.1:4010/', 'http://127.0.0.1:4010'], ['http://[::1]:4010', 'http://[::1]:4010']]) {
      const s = url(value);
      assert.equal(s.catalogue.modal.searchUrl, want, value);
      assert.deepEqual(s.warnings, [], value);
    }
    for (const value of ['http://a.modal.run', 'http://localhost:8000', 'http://192.168.1.5', 'ftp://a.modal.run', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw-secret@a.modal.run', 'https://user@a.modal.run', 'https://a.modal.run?token=abc-secret', 'https://a.modal.run#frag-secret', 'not an address', '//a.modal.run']) {
      const s = url(value);
      assert.equal(s.catalogue.modal.searchUrl, '', value);
      assert.equal(s.warnings.length, 1, value);
      assert.match(s.warnings[0], /^CATALOGUE_MODAL_SEARCH_URL /);
      for (const piece of ['pw-secret', 'token=abc-secret', 'frag-secret']) if (value.includes(piece)) assert.equal(s.warnings[0].includes(piece), false, 'a warning never repeats a password or token');
    }
    const ingest = settingsFrom('CATALOGUE_MODAL_INGEST_URL=http://example.com\n');
    assert.equal(ingest.catalogue.modal.ingestUrl, '');
    assert.match(ingest.warnings[0], /^CATALOGUE_MODAL_INGEST_URL /);
  });

  test('keys: visible characters only, no spaces, long enough; the proxy pair goes together', () => {
    for (const bad of ['short', 'has a space in it', 'tab\tinside-the-key', 'x'.repeat(513), 'ünicode-key-123456']) {
      const s = settingsFrom(`CATALOGUE_MODAL_KEY=${bad}\n`);
      assert.equal(catalogueConfig(s).key, '', JSON.stringify(bad));
      assert.match(s.warnings[0], /^CATALOGUE_MODAL_KEY /);
      assert.equal(s.warnings.join().includes(bad), false);
    }
    const one = settingsFrom('CATALOGUE_MODAL_PROXY_KEY=wk-proxy-key-0123456789\n');
    assert.deepEqual(one.warnings, ['CATALOGUE_MODAL_PROXY_KEY and CATALOGUE_MODAL_PROXY_SECRET go together: neither is sent until both are set.']);
    assert.equal(one.catalogue.modal.proxy, false);
    assert.equal(catalogueConfig(one).proxyKey, '');
  });

  test('numbers, names and folders', () => {
    const timeout = (v) => settingsFrom(`CATALOGUE_MODAL_TIMEOUT_MS=${v}\n`).catalogue.modal.timeoutMs;
    assert.deepEqual(['', 'abc', '0x10', '10', '1500', '99999999'].map(timeout), [60000, 60000, 60000, 200, 1500, 300000]);
    assert.equal(settingsFrom('CATALOGUE_SEARCH_PROFILE=full\n').catalogue.profile, 'full');
    const profile = settingsFrom('CATALOGUE_SEARCH_PROFILE=turbo\n');
    assert.equal(profile.catalogue.profile, 'fast');
    assert.match(profile.warnings[0], /CATALOGUE_SEARCH_PROFILE=turbo is not one of fast, balanced, full/);

    const bucket = settingsFrom('CATALOGUE_GCS_BUCKET=Not_A_Bucket\n');
    assert.equal(bucket.catalogue.gcs.bucket, '');
    assert.equal(bucket.catalogue.gcs.problem, 'bucket');
    assert.match(bucket.warnings[0], /^CATALOGUE_GCS_BUCKET /);
    const prefix = (v) => settingsFrom(`CATALOGUE_GCS_PREFIX=${v}\n`);
    for (const [value, want] of [['', 'catalogue/'], ['catalogue/', 'catalogue/'], ['tc', 'tc/'], ['a/b', 'a/b/'], ['v1.2_x-y/', 'v1.2_x-y/']]) assert.equal(prefix(value).catalogue.gcs.prefix, want, value);
    for (const value of ['../x', '/abs', 'a//b', 'a/../b', './x', 'with space', 'x?y', 'x#y', 'a/./b']) {
      const s = prefix(value);
      assert.equal(s.catalogue.gcs.problem, 'prefix', value);
      assert.match(s.warnings[0], /^CATALOGUE_GCS_PREFIX /, value);
    }
    assert.equal(settingsFrom('CATALOGUE_GCS_KEY_FILE=/etc/keys/signer.json\n').catalogue.gcs.keyFile, '/etc/keys/signer.json');
  });

  test('the real environment wins over the file, and a changed file is picked up without a restart', () => {
    const file = path.join(dir, 'reload.env');
    fs.writeFileSync(file, `CATALOGUE_MODAL_SEARCH_URL=https://one.modal.run\nCATALOGUE_MODAL_KEY=${KEY}\n`);
    const manager = new SettingsManager(file, { CATALOGUE_SEARCH_PROFILE: 'full' }, dir);
    assert.equal(manager.get().catalogue.modal.searchUrl, 'https://one.modal.run');
    fs.writeFileSync(file, `CATALOGUE_MODAL_SEARCH_URL=https://two.modal.run\nCATALOGUE_MODAL_KEY=${KEY}x\nCATALOGUE_SEARCH_PROFILE=fast\n`);
    const next = manager.get();
    assert.equal(next.catalogue.modal.searchUrl, 'https://two.modal.run');
    assert.equal(catalogueConfig(next).key, `${KEY}x`);
    assert.equal(next.catalogue.profile, 'full', 'a variable set in the real environment wins');
  });
});

describe('the limits the admin manages', () => {
  const TOKEN = 'catalogue-admin-token-'.padEnd(48, 'z');
  const as = { Authorization: `Bearer ${TOKEN}` };

  test('they are in the admin settings with bounds, units and a group, start at the chosen values, and an out-of-bounds value is refused', async () => {
    const app = await startTestApp({ environ: { AUTH_ADMIN_TOKEN: TOKEN } });
    try {
      const got = (await app.get('/api/auth/admin/settings', as)).json();
      const entry = (key) => got.schema.find((s) => s.key === key);
      const expected = { 'catalogue.limit.searchPerHour': [60, 1, 100000, 'per hour'], 'catalogue.limit.textPerHour': [120, 1, 100000, 'per hour'], 'catalogue.limit.warmPerHour': [30, 1, 100000, 'per hour'], 'catalogue.limit.addressFactor': [4, 1, 100, undefined], 'catalogue.maxConcurrent': [6, 1, 32, undefined] };
      for (const [key, [def, min, max, unit]] of Object.entries(expected)) {
        assert.deepEqual([got.values[key], entry(key).default, entry(key).min, entry(key).max, entry(key).unit, entry(key).group, entry(key).type], [def, def, min, max, unit, 'Catalogue search', 'int'], key);
        assert.ok(entry(key).label && entry(key).help, key);
      }
      const put = (settings) => app.request('/api/auth/admin/settings', { method: 'PUT', body: { settings }, headers: as });
      const saved = await put({ 'catalogue.limit.searchPerHour': 10, 'catalogue.maxConcurrent': 3 });
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.json().changed.sort(), ['catalogue.limit.searchPerHour', 'catalogue.maxConcurrent']);
      assert.deepEqual(app.app.locals.terucon.catalogue.service.limits(), { searchPerHour: 10, textPerHour: 120, warmPerHour: 30, perAddress: 4, maxConcurrent: 3 }, 'the service follows the saved values at once');
      for (const bad of [{ 'catalogue.limit.searchPerHour': 0 }, { 'catalogue.limit.searchPerHour': 100001 }, { 'catalogue.maxConcurrent': 33 }, { 'catalogue.maxConcurrent': 'many' }, { 'catalogue.limit.addressFactor': 1.5 }, { 'catalogue.nonsense': 1 }]) {
        assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await put({ 'catalogue.limit.searchPerHour': null, 'catalogue.maxConcurrent': null })).json().values['catalogue.maxConcurrent'], 6);
      assert.equal(app.app.locals.terucon.catalogue.service.limits().searchPerHour, 60);
    } finally {
      await app.stop();
    }
  });
});
