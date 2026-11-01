import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { createGcsSigner, isSafeKey, quoteObjectName, quoteParam, signUrlV4, v4Timestamp } from '../../server/catalogue/gcsSigner.js';

// The Cloud Storage "V4 signed URL" maker. Google's own SDK (google-cloud-storage 3.17.1) is the ORACLE: tests/fixtures/gen-gcs-v4-vectors.py
// makes URLs with a throw-away key and a fixed clock, and every one of them must be reproduced here byte for byte (RSA PKCS#1 v1.5 with
// SHA-256 has no randomness). That Google's servers accept the signatures, and the x-goog-content-length-range header in a signed upload, is
// NOT something this repository can check.

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/gcs-v4-vectors.json', import.meta.url), 'utf8'));
const der = Buffer.from(fixture.throwAwayKey.pkcs8DerBase64, 'base64');
const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
const clientEmail = fixture.throwAwayKey.clientEmail;
const PREFIX = 'catalogue/';

let dir;
let keyFile;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-signer-'));
  keyFile = path.join(dir, 'signer.json');
  fs.writeFileSync(keyFile, JSON.stringify({ type: 'service_account', project_id: 'terucon-test', private_key_id: 'throwaway', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: clientEmail }));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const signerAt = (nowMs, overrides = {}) => createGcsSigner({ config: () => ({ bucket: fixture.bucket, prefix: PREFIX, keyFile, gcsProblem: '', ...overrides.config }), now: () => nowMs, log: overrides.log, readFile: overrides.readFile, stat: overrides.stat });

describe('the oracle: Google\'s SDK', () => {
  test('the fixture is what it says: a throw-away key (not a PEM) and a good number of vectors', () => {
    assert.ok(fixture.vectors.length >= 15);
    assert.equal(fixture.versions['google-cloud-storage'], '3.17.1');
    assert.equal(JSON.stringify(fixture).includes('PRIVATE KEY'), false, 'no PEM block in the repository');
    assert.equal(privateKey.asymmetricKeyType, 'rsa');
    assert.deepEqual(new Set(fixture.vectors.map((v) => v.method)), new Set(['GET', 'PUT']));
    assert.ok(fixture.vectors.some((v) => v.objectName.includes(' ')) && fixture.vectors.some((v) => /[^\x00-\x7f]/.test(v.objectName)) && fixture.vectors.some((v) => v.objectName.includes('!')) && fixture.vectors.some((v) => v.objectName.includes('//')));
  });

  for (const v of fixture.vectors) {
    test(`reproduces the SDK byte for byte: ${v.name}`, () => {
      const headers = { ...(v.contentType ? { 'content-type': v.contentType } : {}), ...v.headers };
      const { url } = signUrlV4({ privateKey, clientEmail, bucket: fixture.bucket, objectName: v.objectName, method: v.method, headers, expiresS: v.expiresS, nowMs: v.nowMs });
      assert.equal(url, v.url);
    });
  }

  test('the signer (prefix, key file, clock) makes the SDK\'s URLs for every key it is willing to sign', () => {
    let viaSigner = 0;
    for (const v of fixture.vectors) {
      if (!v.objectName.startsWith(PREFIX)) continue;
      const key = v.objectName.slice(PREFIX.length);
      if (!isSafeKey(key)) continue;
      const signer = signerAt(v.nowMs);
      if (v.method === 'GET') {
        assert.equal(signer.signGet(key, { expiresS: v.expiresS }), v.url, v.name);
      } else if (v.headers['x-goog-content-length-range'] && !v.headers['X-Goog-Meta-Note']) {
        const max = Number(v.headers['x-goog-content-length-range'].split(',')[1]);
        const put = signer.signPut(key, { contentType: v.contentType, maxBytes: max, expiresS: v.expiresS });
        assert.equal(put.url, v.url, v.name);
        assert.deepEqual(put.headers, { 'Content-Type': v.contentType, 'x-goog-content-length-range': `0,${max}` });
        assert.equal(put.expiresAt, v.nowMs + v.expiresS * 1000);
      } else continue;
      viaSigner += 1;
    }
    assert.ok(viaSigner >= 6, `${viaSigner} vectors went through the signer`);
  });

  test('a stable signing time: the same picture has the same address all window long, one hour of life from the first minute', () => {
    const crop = fixture.vectors.find((v) => v.name.startsWith('a crop'));
    const key = crop.objectName.slice(PREFIX.length);
    const atStart = signerAt(crop.nowMs).signGet(key, { expiresS: 4500, stableS: 900 });
    const later = signerAt(crop.nowMs + 14 * 60 * 1000 + 59_000).signGet(key, { expiresS: 4500, stableS: 900 });
    const next = signerAt(crop.nowMs + 15 * 60 * 1000).signGet(key, { expiresS: 4500, stableS: 900 });
    assert.equal(atStart, crop.url, 'at the start of the window it is the SDK\'s URL');
    assert.equal(later, atStart, 'the same URL until the window ends, so the browser can cache the picture');
    assert.notEqual(next, atStart);
    assert.match(next, /X-Goog-Date=20261101T121500Z/);
    assert.match(later, /X-Goog-Expires=4500/);
  });
});

describe('the pieces', () => {
  test('the encoding is Python\'s quote(), not encodeURIComponent', () => {
    assert.equal(quoteObjectName("a b/c!d*e'f(g)h~i_j-k.l+m&n=o?p#q%r,s;t:u@v$w/é日🧱"), 'a%20b/c%21d%2Ae%27f%28g%29h~i_j-k.l%2Bm%26n%3Do%3Fp%23q%25r%2Cs%3Bt%3Au%40v%24w/%C3%A9%E6%97%A5%F0%9F%A7%B1');
    assert.equal(quoteParam('a/b c~d'), 'a%2Fb%20c~d');
    assert.equal(encodeURIComponent("!*'()"), "!*'()", 'which is exactly why encodeURIComponent is not used');
    assert.equal(quoteObjectName("!*'()"), '%21%2A%27%28%29');
  });

  test('the timestamp and the expiry limits', () => {
    assert.equal(v4Timestamp(Date.UTC(2026, 10, 1, 12, 0, 0)), '20261101T120000Z');
    assert.equal(v4Timestamp(Date.UTC(2026, 11, 31, 23, 59, 59, 999)), '20261231T235959Z');
    for (const expiresS of [0, -1, 1.5, 604801, '3600', NaN, undefined]) {
      assert.throws(() => signUrlV4({ privateKey, clientEmail, bucket: 'b', objectName: 'o', expiresS, nowMs: 0 }), RangeError, String(expiresS));
    }
    assert.doesNotThrow(() => signUrlV4({ privateKey, clientEmail, bucket: 'b', objectName: 'o', expiresS: 604800, nowMs: 0 }));
  });

  test('only keys the site chose are signed: relative, plain characters, no ".." and no hidden files', () => {
    const signer = signerAt(fixture.vectors[0].nowMs);
    for (const ok of ['thumbs/c/a.jpg', 'uploads/job-20261101120000-abc123/my_file-1.pdf', 'a', 'x/y.z']) {
      assert.equal(isSafeKey(ok), true, ok);
      assert.doesNotThrow(() => signer.signGet(ok), ok);
    }
    for (const bad of ['', '/abs', '../x', 'a/../b', 'a//b', './x', 'a/./b', '.hidden', 'a/.hidden', 'has space', 'tab\t', 'new\nline', 'q?x', 'h#x', 'é', 'x'.repeat(302), null, undefined, 7, ['a']]) {
      assert.equal(isSafeKey(bad), false, JSON.stringify(bad));
      assert.throws(() => signer.signGet(bad), /not allowed/, JSON.stringify(bad));
    }
  });

  test('an upload address is for exactly one key, one content type and one size range, under the prefix once', () => {
    const signer = signerAt(Date.UTC(2026, 10, 1, 12));
    const put = signer.signPut('uploads/job-20261101120000-abc123/catalogue.pdf', { contentType: 'application/pdf', maxBytes: 314572800 });
    const url = new URL(put.url);
    assert.equal(url.host, 'storage.googleapis.com');
    assert.equal(url.pathname, `/${fixture.bucket}/catalogue/uploads/job-20261101120000-abc123/catalogue.pdf`, 'the prefix is added exactly once');
    assert.equal(url.searchParams.get('X-Goog-SignedHeaders'), 'content-type;host;x-goog-content-length-range');
    assert.equal(url.searchParams.get('X-Goog-Expires'), '7200');
    assert.equal(url.searchParams.get('X-Goog-Algorithm'), 'GOOG4-RSA-SHA256');
    assert.match(url.searchParams.get('X-Goog-Credential'), new RegExp(`^${clientEmail.replace(/[.]/g, '\\.')}/20261101/auto/storage/goog4_request$`));
    assert.match(url.searchParams.get('X-Goog-Signature'), /^[0-9a-f]{512}$/);
    assert.deepEqual(put.headers, { 'Content-Type': 'application/pdf', 'x-goog-content-length-range': '0,314572800' });
    for (const bad of [{ contentType: 'application/pdf' }, { maxBytes: 5 }, { contentType: 'not a type', maxBytes: 5 }, { contentType: 'application/pdf', maxBytes: 0 }, { contentType: 'application/pdf', maxBytes: 1.5 }, { contentType: 'application/pdf\r\nX: y', maxBytes: 5 }]) {
      assert.throws(() => signer.signPut('uploads/a.pdf', bad), /needed/, JSON.stringify(bad));
    }
    // the read address has no such headers
    assert.equal(new URL(signer.signGet('thumbs/c/a.jpg')).searchParams.get('X-Goog-SignedHeaders'), 'host');
  });
});

describe('the key file', () => {
  test('it is read once, on first use, and the parsed key is kept', () => {
    let reads = 0;
    const read = (file, enc) => (reads += 1, fs.readFileSync(file, enc));
    const signer = signerAt(Date.UTC(2026, 10, 1, 12), { readFile: read });
    assert.equal(reads, 0, 'nothing is read until a URL is signed');
    for (let i = 0; i < 50; i += 1) signer.signGet(`thumbs/c/${i}.jpg`);
    assert.equal(reads, 1);
    assert.deepEqual(signer.ready(), { ok: true, problem: '', clientEmail });
    assert.equal(reads, 1);
  });

  test('a changed file is noticed after a while; a missing one is retried after a few seconds', () => {
    const clock = { t: Date.UTC(2026, 10, 1, 12) };
    const file = path.join(dir, 'moving.json');
    let reads = 0;
    const make = () => createGcsSigner({ config: () => ({ bucket: 'b', prefix: PREFIX, keyFile: file, gcsProblem: '' }), now: () => clock.t, readFile: (f, e) => (reads += 1, fs.readFileSync(f, e)) });
    const signer = make();
    assert.equal(signer.ready().ok, false, 'no such file');
    assert.match(signer.ready().problem, /key file cannot be read/);
    fs.copyFileSync(keyFile, file);
    assert.equal(signer.ready().ok, false, 'a failure is remembered for a moment');
    clock.t += 11_000;
    assert.equal(signer.ready().ok, true);
    const first = reads;
    clock.t += 5_000;
    signer.ready();
    assert.equal(reads, first);
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    fs.writeFileSync(file, JSON.stringify({ type: 'service_account', client_email: 'rotated@terucon-test.iam.gserviceaccount.com', private_key: other.export({ type: 'pkcs8', format: 'pem' }) }));
    clock.t += 31_000;
    assert.equal(signer.ready().clientEmail, 'rotated@terucon-test.iam.gserviceaccount.com', 'a rotated key is picked up without a restart');
  });

  test('every way the key can be wrong is named, and nothing from the file is ever in a message or a log', () => {
    const bad = {
      'not JSON': 'this is not json {',
      'no client_email': JSON.stringify({ type: 'service_account', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
      'a user credential': JSON.stringify({ type: 'authorized_user', client_email: 'a@b.c', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
      'no private key': JSON.stringify({ type: 'service_account', client_email: clientEmail }),
      'a broken private key': JSON.stringify({ type: 'service_account', client_email: clientEmail, private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' }),
      'an elliptic-curve key': JSON.stringify({ type: 'service_account', client_email: clientEmail, private_key: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
    };
    for (const [what, content] of Object.entries(bad)) {
      const file = path.join(dir, `bad-${what.replace(/\W/g, '-')}.json`);
      fs.writeFileSync(file, content);
      const lines = [];
      const signer = createGcsSigner({ config: () => ({ bucket: 'b', prefix: PREFIX, keyFile: file, gcsProblem: '' }), log: { warn: (m) => lines.push(m) } });
      const ready = signer.ready();
      assert.equal(ready.ok, false, what);
      assert.ok(ready.problem.length > 10, what);
      assert.throws(() => signer.signGet('thumbs/c/a.jpg'), (error) => !/BEGIN|MII|AAAA|private_key/.test(error.message) && error.message === ready.problem, what);
      assert.equal(signer.selfTest().ok, false, what);
      assert.equal(lines.some((l) => /BEGIN|MII|AAAA/.test(l)), false, what);
    }
  });

  test('not configured: the bucket and the key file are named, a bad bucket or prefix is refused', () => {
    const problem = (config) => createGcsSigner({ config: () => ({ bucket: '', prefix: PREFIX, keyFile: '', gcsProblem: '', ...config }) }).ready().problem;
    assert.match(problem({}), /CATALOGUE_GCS_BUCKET is not set/);
    assert.match(problem({ bucket: 'b' }), /CATALOGUE_GCS_KEY_FILE is not set/);
    assert.match(problem({ bucket: 'b', keyFile, gcsProblem: 'bucket' }), /not a bucket name/);
    assert.match(problem({ bucket: 'b', keyFile, gcsProblem: 'prefix' }), /CATALOGUE_GCS_PREFIX is not usable/);
  });

  test('the self-test signs and checks the signature with the key\'s public half; it bills nothing and says Google was not asked', () => {
    const result = signerAt(Date.UTC(2026, 10, 1, 12)).selfTest();
    assert.equal(result.ok, true);
    assert.match(result.detail, new RegExp(`${clientEmail.replace(/[.]/g, '\\.')}.*Google accepts the signature was not tested`));
  });
});
