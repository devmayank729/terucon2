import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { analyticsFor } from '../../server/routes/analytics.js';
import { Bundle } from '../../tools/bundle.js';
import { loadSettings } from '../../server/config/settings.js';
import { startTestApp } from '../helpers/app.js';
import { ROOT } from './site-helpers.js';

const KEY = 'phc_' + 'a'.repeat(30);
const OTHER = 'phc_' + 'b'.repeat(30);

function ctx(env, studio) {
  const settings = loadSettings(path.join(ROOT, 'does-not-exist.env'), env, ROOT);
  return { settings: () => settings, swatchroom: studio ? { analytics: () => studio } : null };
}

test('no key anywhere: analytics is off', () => {
  assert.deepEqual(analyticsFor(ctx({}), 'terucon.example'), { enabled: false });
  assert.deepEqual(analyticsFor(ctx({}, { key: '', host: 'https://us.i.posthog.com' }), 'terucon.example'), { enabled: false });
});

test('the website\'s own key, or else the studio\'s, so pages and studio share one project', () => {
  assert.deepEqual(analyticsFor(ctx({ POSTHOG_KEY: KEY }), 'terucon.example'), { enabled: true, key: KEY, host: 'https://us.i.posthog.com', replay: true });
  const studio = { key: OTHER, host: 'https://eu.i.posthog.com' };
  assert.deepEqual(analyticsFor(ctx({}, studio), 'terucon.example'), { enabled: true, key: OTHER, host: 'https://eu.i.posthog.com', replay: true });
  assert.equal(analyticsFor(ctx({ POSTHOG_KEY: KEY }, studio), 'terucon.example').key, KEY, 'the website\'s wins');
});

test('replay can be switched off', () => {
  assert.equal(analyticsFor(ctx({ POSTHOG_KEY: KEY, POSTHOG_REPLAY: 'off' }), 'terucon.example').replay, false);
});

test('a malformed key or host switches analytics off instead of reaching a stranger', () => {
  assert.equal(analyticsFor(ctx({ POSTHOG_KEY: 'not a key' }), 'terucon.example').enabled, false);
  assert.equal(analyticsFor(ctx({ POSTHOG_KEY: KEY, POSTHOG_HOST: 'http://evil.example' }), 'terucon.example').enabled, false);
  assert.equal(analyticsFor(ctx({ POSTHOG_KEY: KEY, POSTHOG_HOST: 'https://evil.example/path?x' }), 'terucon.example').enabled, false);
  assert.equal(analyticsFor(ctx({}, { key: 'junk', host: 'https://us.i.posthog.com' }), 'terucon.example').enabled, false);
  const warned = loadSettings(path.join(ROOT, 'nope.env'), { POSTHOG_KEY: 'junk' }, ROOT).warnings;
  assert.ok(warned.some((w) => /POSTHOG_KEY/.test(w)));
});

test('opened on this computer only, nothing is sent unless POSTHOG_ON_LOCALHOST=on', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(analyticsFor(ctx({ POSTHOG_KEY: KEY }), host).enabled, false, host);
  assert.equal(analyticsFor(ctx({ POSTHOG_KEY: KEY, POSTHOG_ON_LOCALHOST: 'on' }), 'localhost').enabled, true);
});

test('GET /api/analytics: JSON, never cached, and POST is refused like any other API route', async () => {
  const app = await startTestApp({ environ: { POSTHOG_KEY: KEY, POSTHOG_ON_LOCALHOST: 'on', ALLOWED_HOSTS: 'terucon.example' } });
  try {
    const r = await app.get('/api/analytics');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /application\/json/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.json().key, KEY);
    assert.equal((await app.post('/api/analytics', {})).status, 405);
  } finally {
    await app.stop();
  }
  const off = await startTestApp();
  try {
    assert.deepEqual((await off.get('/api/analytics')).json(), { enabled: false });
  } finally {
    await off.stop();
  }
});

test('every page asks for analytics through the one snippet, and no key is written into any page', () => {
  const snippet = fs.readFileSync(path.join(ROOT, 'site', 'patches', 'snippets', 'analytics.js'), 'utf8');
  for (const file of ['home', 'materials', 'studio', 'dashboard', 'coming-soon']) {
    const html = fs.readFileSync(path.join(ROOT, 'pages', `${file}.html`), 'utf8');
    if (file === 'coming-soon') assert.ok(html.includes(snippet), 'the Coming soon page carries the same snippet as the built pages');
    else assert.ok(Bundle.load(path.join(ROOT, 'pages', `${file}.html`)).template.includes(snippet.trimEnd()), `${file} carries the analytics snippet`);
    assert.ok(!/phc_[A-Za-z0-9]{20,}/.test(html), `${file} holds no project key`);
  }
  assert.match(snippet, /\/api\/analytics/);
  assert.match(snippet, /doNotTrack/);
  assert.match(snippet, /maskAllInputs: true/);
  assert.match(snippet, /autocapture: false/);
});
