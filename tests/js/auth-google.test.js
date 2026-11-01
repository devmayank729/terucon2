import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createGoogleVerifier } from '../../server/auth/google.js';

// Checking Google's ID token. The tests mint their own tokens with their own key and hand the verifier that key as "Google's",
// then attack the verifier the way a forger would.

const CLIENT = '1234567890-abc.apps.googleusercontent.com';
const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const pair = (bits = 2048) => crypto.generateKeyPairSync('rsa', { modulusLength: bits });
const main = pair();
const other = pair();
const small = pair(1024);
const jwkOf = (kp, kid) => ({ ...kp.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });

let clock = 1_800_000_000_000;
const seconds = () => Math.floor(clock / 1000);
const good = (extra = {}) => ({ iss: 'https://accounts.google.com', aud: CLIENT, sub: '110169484474386276334', email: 'Priya@AB-Constructions.co.in', email_verified: true, name: 'Priya Sharma', hd: 'ab-constructions.co.in', iat: seconds() - 10, exp: seconds() + 3000, nonce: 'n-1', ...extra });

function mint(claims = good(), { kp = main, kid = 'k1', alg = 'RS256', header } = {}) {
  const head = b64(header ?? { alg, kid, typ: 'JWT' });
  const body = b64(claims);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), kp.privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

function verifier({ keys = [jwkOf(main, 'k1')], fetches } = {}) {
  let n = 0;
  const v = createGoogleVerifier({
    clientId: CLIENT,
    now: () => clock,
    fetchKeys: async () => {
      n += 1;
      fetches?.push(n);
      if (keys === null) throw new Error('offline');
      return { keys, maxAgeMs: 3600_000 };
    },
  });
  return v;
}

test('a good token gives the verified profile, with the e-mail cleaned and the workspace domain', async () => {
  const r = await verifier().verify(mint(), { nonce: 'n-1' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.profile, { sub: '110169484474386276334', email: 'priya@ab-constructions.co.in', name: 'Priya Sharma', hd: 'ab-constructions.co.in' });
});

test('the string "true" counts as a verified e-mail (how some tokens spell it), anything else does not', async () => {
  const v = verifier();
  assert.equal((await v.verify(mint(good({ email_verified: 'true' })), { nonce: 'n-1' })).ok, true);
  for (const bad of [false, 'false', undefined, 1, 'yes', null]) {
    const r = await v.verify(mint(good({ email_verified: bad })), { nonce: 'n-1' });
    assert.equal(r.reason, 'email-unverified', JSON.stringify(bad));
  }
});

test('the token must be for this site, from Google, and current', async () => {
  const v = verifier();
  const cases = [
    [good({ aud: 'someone-elses-client.apps.googleusercontent.com' }), 'wrong-audience'],
    [good({ aud: [CLIENT] }), 'wrong-audience'],
    [good({ aud: undefined }), 'wrong-audience'],
    [good({ iss: 'https://evil.example' }), 'wrong-issuer'],
    [good({ iss: 'accounts.google.com.evil.example' }), 'wrong-issuer'],
    [good({ iss: undefined }), 'wrong-issuer'],
    [good({ exp: seconds() - 120 }), 'expired'],
    [good({ exp: undefined }), 'expired'],
    [good({ exp: 'soon' }), 'expired'],
    [good({ iat: seconds() + 3600, exp: seconds() + 7200 }), 'not-yet-valid'],
    [good({ iat: seconds() - 10, exp: seconds() + 10 * 24 * 3600 }), 'expired'],
    [good({ sub: undefined }), 'malformed'],
    [good({ sub: '' }), 'malformed'],
    [good({ email: undefined }), 'no-email'],
    [good({ email: 'not an address' }), 'no-email'],
    [good({ email: 'a@b.co\r\nBcc: x@y.co' }), 'no-email'],
  ];
  for (const [claims, reason] of cases) assert.equal((await v.verify(mint(claims), { nonce: 'n-1' })).reason, reason, JSON.stringify(claims).slice(0, 80));
  assert.equal((await v.verify(mint(good({ exp: seconds() - 10 })), { nonce: 'n-1' })).ok, true, 'a few seconds of clock difference is forgiven');
});

test('the nonce must be the one this browser was given', async () => {
  const v = verifier();
  assert.equal((await v.verify(mint(good({ nonce: 'other' })), { nonce: 'n-1' })).reason, 'wrong-nonce');
  assert.equal((await v.verify(mint(good({ nonce: undefined })), { nonce: 'n-1' })).reason, 'wrong-nonce');
  assert.equal((await v.verify(mint(good({ nonce: ['n-1'] })), { nonce: 'n-1' })).reason, 'wrong-nonce');
});

test('forgeries: alg none, HS256 signed with the public key, a different algorithm, another key, a tampered body', async () => {
  const v = verifier();
  const claims = good();
  // alg none: header says no signature is needed
  const none = `${b64({ alg: 'none', kid: 'k1' })}.${b64(claims)}.`;
  assert.notEqual((await v.verify(none, { nonce: 'n-1' })).ok, true);
  const noneWithSig = `${b64({ alg: 'none', kid: 'k1' })}.${b64(claims)}.${b64('x')}`;
  assert.equal((await v.verify(noneWithSig, { nonce: 'n-1' })).reason, 'bad-algorithm');
  // the key-confusion attack: HS256 with the RSA public key (as PEM) as the HMAC secret
  const pem = main.publicKey.export({ type: 'spki', format: 'pem' });
  const head = b64({ alg: 'HS256', kid: 'k1', typ: 'JWT' });
  const body = b64(claims);
  const mac = crypto.createHmac('sha256', pem).update(`${head}.${body}`).digest('base64url');
  assert.equal((await v.verify(`${head}.${body}.${mac}`, { nonce: 'n-1' })).reason, 'bad-algorithm');
  for (const alg of ['RS384', 'RS512', 'ES256', 'PS256', 'rs256', 'RS256 ']) assert.equal((await v.verify(mint(claims, { alg }), { nonce: 'n-1' })).reason, 'bad-algorithm', alg);
  // signed with a key that is not Google's, under Google's key id
  assert.equal((await v.verify(mint(claims, { kp: other }), { nonce: 'n-1' })).reason, 'bad-signature');
  // a body changed after signing
  const [h, , s] = mint(claims).split('.');
  assert.equal((await v.verify(`${h}.${b64(good({ email: 'ceo@victim.example' }))}.${s}`, { nonce: 'n-1' })).reason, 'bad-signature');
  // a truncated or padded signature
  const full = mint(claims);
  assert.equal((await v.verify(full.slice(0, -4), { nonce: 'n-1' })).reason, 'bad-signature');
});

test('keys: an unknown key id, a weak key, and Google unreachable', async () => {
  assert.equal((await verifier().verify(mint(good(), { kid: 'nope' }), { nonce: 'n-1' })).reason, 'unknown-key');
  const weak = verifier({ keys: [jwkOf(small, 'weak')] });
  assert.equal((await weak.verify(mint(good(), { kp: small, kid: 'weak' }), { nonce: 'n-1' })).ok, false, 'a 1024-bit key is not accepted');
  const offline = verifier({ keys: null });
  assert.equal((await offline.verify(mint(), { nonce: 'n-1' })).reason, 'keys-unavailable');
});

test('Google\'s key set is fetched once and kept; a new key id is looked for once a minute, not on every bad token', async () => {
  const fetches = [];
  const v = verifier({ fetches });
  await v.verify(mint(), { nonce: 'n-1' });
  await v.verify(mint(), { nonce: 'n-1' });
  assert.equal(fetches.length, 1, 'kept');
  for (let i = 0; i < 20; i += 1) await v.verify(mint(good(), { kid: `forged-${i}` }), { nonce: 'n-1' });
  assert.equal(fetches.length, 1, 'twenty tokens with unknown key ids did not hammer Google');
  clock += 61_000;
  await v.verify(mint(good(), { kid: 'forged-after' }), { nonce: 'n-1' });
  assert.equal(fetches.length, 2, 'after a minute one more look is allowed');
  clock -= 61_000;
});

test('rubbish never throws and is never accepted', async () => {
  const v = verifier();
  const rubbish = [undefined, null, 5, {}, [], '', 'a', 'a.b', 'a.b.c.d', '..', 'a..c', '.b.c', '!!!.###.$$$', 'x'.repeat(5000), `${b64([1, 2])}.${b64({})}.${b64('s')}`, `${b64({ alg: 'RS256' })}.${b64({})}.${b64('s')}`, `${b64('"string"')}.${b64('null')}.${b64('s')}`];
  for (const bad of rubbish) {
    const r = await v.verify(bad, { nonce: 'n-1' });
    assert.equal(r.ok, false, String(bad).slice(0, 40));
  }
});

test('a workspace domain that is not a domain is dropped, not trusted', async () => {
  const v = verifier();
  const r = await v.verify(mint(good({ hd: '<script>alert(1)</script>' })), { nonce: 'n-1' });
  assert.equal(r.ok, true);
  assert.equal(r.profile.hd, null);
});
