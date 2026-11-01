import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPinterestImporter, ImportError, onlyPictures, parseBoardUrl } from '../../server/lib/pinterestImport.js';

// The first, Pinterest-only importer (server/lib/pinterestImport.js). It is no longer used: server/lib/inspiration/ replaced it and these
// are the tests that were left that still describe it. Nothing here reaches Pinterest. Remove both together when you say so.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOOD = 'https://www.pinterest.com/some_one/kitchen-ideas/';
const PIN = (n) => `https://i.pinimg.com/originals/ab/cd/${n}.jpg`;

test('only a board address is accepted, and it is rebuilt from its parts', () => {
  assert.equal(parseBoardUrl(GOOD), GOOD);
  assert.equal(parseBoardUrl('  https://in.pinterest.com/some_one/kitchen-ideas?utm=1#x  '), GOOD);
  assert.equal(parseBoardUrl('https://pinterest.com/some_one/kitchen-ideas/living-room/'), 'https://www.pinterest.com/some_one/kitchen-ideas/living-room/');
  assert.equal(parseBoardUrl('https://www.pinterest.com/some%20one/caf%C3%A9-ideas/'), 'https://www.pinterest.com/some%20one/caf%C3%A9-ideas/');
});

test('everything else is refused: other sites, look-alikes, pins, profiles, odd addresses', () => {
  const refused = [
    '', undefined, null, 42, {},
    'http://www.pinterest.com/a/b/', // not https
    'https://evil.example/a/b/',
    'https://pinterest.com.evil.example/a/b/',
    'https://evilpinterest.com/a/b/',
    'https://www.pinterest.com@evil.example/a/b/',
    'https://user:pw@www.pinterest.com/a/b/',
    'https://www.pinterest.com:8443/a/b/',
    'https://pin.it/abc123', // short links redirect: not followed
    'https://www.pinterest.com/pin/12345/', // a pin is not a board
    'https://www.pinterest.com/ideas/kitchen/',
    'https://www.pinterest.com/some_one/', // a profile
    'https://www.pinterest.com/',
    'https://www.pinterest.com/a/b/c/d/',
    'https://www.pinterest.com/a/%2e%2e/',
    'https://www.pinterest.com/a/..%2f..%2fetc/',
    'https://www.pinterest.com/-a/b/', // would look like an option
    'https://www.pinterest.com/a/b%00/',
    'https://www.pinterest.com/a/b;rm/',
    `https://www.pinterest.com/a/${'x'.repeat(400)}/`,
    'file:///etc/passwd',
    'javascript:alert(1)',
  ];
  for (const input of refused) assert.equal(parseBoardUrl(input), null, String(input));
});

test('only https pinimg.com pictures come back out, once each, at most the limit', () => {
  const list = [PIN(1), PIN(1), PIN(2), 'http://i.pinimg.com/x.jpg', 'https://evil.example/x.jpg', 'https://pinimg.com.evil.example/x.jpg', 'https://u:p@i.pinimg.com/x.jpg', 'https://i.pinimg.com:444/x.jpg', 'not a url', 7, null, PIN(3)];
  assert.deepEqual(onlyPictures(list, 10), [PIN(1), PIN(2), PIN(3)]);
  assert.deepEqual(onlyPictures(list, 2), [PIN(1), PIN(2)]);
  assert.deepEqual(onlyPictures('nope', 5), []);
});

/** An importer whose program is a function: `answers` is what the program prints, in order. */
function importerWith(answers, extra = {}) {
  const calls = [];
  const python = process.execPath;
  const script = fileURLToPath(import.meta.url);
  const exec = (file, args, options, done) => {
    calls.push({ file, args, options });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) return done(next, '');
    done(null, typeof next === 'string' ? next : JSON.stringify(next));
  };
  let clock = 1000;
  const importer = createPinterestImporter({ settings: () => ({ enabled: true, python, script, limit: 5, timeoutMs: 20000, ...extra }), exec, now: () => clock });
  return { importer, calls, tick: (ms) => (clock += ms) };
}
const who = { account: 'acct1', address: '1.2.3.4' };
const reasonOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ImportError, String(error));
    return `${error.reason}/${error.status}`;
  }
  return 'no error';
};

test('the program is started without a shell, with the rebuilt address, a bare environment and a time limit', async () => {
  const { importer, calls } = importerWith([{ ok: true, images: [PIN(1), 'https://evil.example/x.jpg', PIN(2)] }]);
  process.env.TERUCON_TEST_SECRET = 'must-not-leak';
  const out = await importer.list(`${GOOD}?x=1`, who);
  delete process.env.TERUCON_TEST_SECRET;
  assert.deepEqual(out, { board: GOOD, images: [PIN(1), PIN(2)], cached: false });
  const [{ args, options }] = calls;
  assert.deepEqual(args.slice(1), [GOOD, '5', '15']); // 20 s allowed, the program stops itself at 15
  assert.equal(options.timeout, 20000);
  assert.ok(options.maxBuffer <= 1024 * 1024);
  assert.deepEqual(Object.keys(options.env).sort(), ['LANG', 'PATH']);
  assert.equal(options.shell, undefined);
  importer.close();
});

test('a board asked for twice is answered from memory for ten minutes', async () => {
  const { importer, calls, tick } = importerWith([{ ok: true, images: [PIN(1)] }]);
  assert.equal((await importer.list(GOOD, who)).cached, false);
  assert.equal((await importer.list(GOOD, who)).cached, true);
  assert.equal(calls.length, 1);
  tick(11 * 60 * 1000);
  assert.equal((await importer.list(GOOD, who)).cached, false);
  assert.equal(calls.length, 2);
  importer.close();
});

test('what the program says goes out as a plain answer, and a broken program is "not set up", never its text', async () => {
  const cases = [
    [{ ok: false, reason: 'not-found' }, 'not-found/404'],
    [{ ok: false, reason: 'blocked' }, 'blocked/502'],
    [{ ok: false, reason: 'empty' }, 'empty/404'],
    [{ ok: false, reason: 'timeout' }, 'timeout/504'],
    [{ ok: false, reason: 'something-new' }, 'failed/502'],
    [{ ok: false, reason: 'not-installed' }, 'not-set-up/503'],
    [{ ok: true, images: ['https://evil.example/x.jpg'] }, 'empty/404'],
    ['Traceback (most recent call last): secret path /home/x', 'failed/502'],
    [Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), 'not-set-up/503'],
    [Object.assign(new Error('timed out'), { killed: true }), 'timeout/504'],
  ];
  for (const [answer, expected] of cases) {
    const { importer } = importerWith([answer]);
    assert.equal(await reasonOf(importer.list(GOOD, who)), expected, JSON.stringify(answer));
    importer.close();
  }
});

test('a bad address, a switched-off importer and a missing program are refused before anything starts', async () => {
  const { importer, calls } = importerWith([{ ok: true, images: [PIN(1)] }]);
  assert.equal(await reasonOf(importer.list('https://evil.example/a/b/', who)), 'bad-address/400');
  assert.equal(calls.length, 0);
  importer.close();
  const off = importerWith([{ ok: true, images: [PIN(1)] }], { enabled: false });
  assert.equal(await reasonOf(off.importer.list(GOOD, who)), 'off/503');
  off.importer.close();
  const missing = importerWith([{ ok: true, images: [PIN(1)] }], { python: path.join(os.tmpdir(), 'no-such-python') });
  assert.equal(await reasonOf(missing.importer.list(GOOD, who)), 'not-set-up/503');
  assert.equal(missing.importer.ready(), false);
  assert.equal(missing.calls.length, 0);
  missing.importer.close();
});

test('an account gets ten new boards an hour; the answer says when to come back', async () => {
  const { importer, calls } = importerWith([{ ok: true, images: [PIN(1)] }]);
  for (let n = 0; n < 10; n += 1) await importer.list(`https://www.pinterest.com/u/board-${n}/`, who);
  let error;
  try {
    await importer.list('https://www.pinterest.com/u/board-10/', who);
  } catch (e) {
    error = e;
  }
  assert.equal(`${error.reason}/${error.status}`, 'rate/429');
  assert.ok(error.retryAfter > 0);
  assert.equal(calls.length, 10);
  // another account is not held up by it
  assert.equal((await importer.list('https://www.pinterest.com/u/board-10/', { account: 'acct2', address: '5.6.7.8' })).cached, false);
  importer.close();
});

test('at most two imports run at once', async () => {
  const waiting = [];
  const exec = (file, args, options, done) => waiting.push(() => done(null, JSON.stringify({ ok: true, images: [PIN(1)] })));
  const importer = createPinterestImporter({ settings: () => ({ enabled: true, python: process.execPath, script: fileURLToPath(import.meta.url), limit: 5, timeoutMs: 20000 }), exec });
  const a = importer.list('https://www.pinterest.com/u/one/', { account: 'a1', address: '1.1.1.1' });
  const b = importer.list('https://www.pinterest.com/u/two/', { account: 'a2', address: '1.1.1.2' });
  assert.equal(await reasonOf(importer.list('https://www.pinterest.com/u/three/', { account: 'a3', address: '1.1.1.3' })), 'busy/503');
  waiting.forEach((finish) => finish());
  await Promise.all([a, b]);
  assert.equal((await Promise.all([importer.list('https://www.pinterest.com/u/three/', { account: 'a3', address: '1.1.1.3' }), Promise.resolve(waiting.at(-1)?.())]))[0].cached, false);
  importer.close();
});
