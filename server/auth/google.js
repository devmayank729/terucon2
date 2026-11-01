/**
 * Google sign-in (One Tap and the Sign in with Google button): checking the ID token Google hands the browser.
 *
 * Google's own guidance (https://developers.google.com/identity/gsi/web/guides/verify-google-id-token) is to verify the signature
 * with Google's published keys (https://www.googleapis.com/oauth2/v3/certs), then check the issuer, the audience (our client id),
 * the expiry, and to use the stable `sub`, never the e-mail address, as the identifier. This module does exactly that with
 * node:crypto and no library, and is strict where a sloppy verifier is attacked:
 *
 *   - only RS256 is accepted, with a key found by `kid` in Google's key set. "alg": "none" and the old trick of signing with
 *     HS256 using the public key as the secret are refused before any key is looked at;
 *   - keys smaller than 2048 bits are refused;
 *   - `aud` must be our client id exactly, `iss` must be Google's, `exp` must be in the future, `iat` not in the future, and the
 *     token may not claim to live longer than a day;
 *   - the e-mail must be present, well formed and `email_verified` true (the string "true" is how some tokens spell it);
 *   - the `nonce` must match the one this browser was given (single use, bound to the browser by a cookie: server/routes/auth.js),
 *     so a token stolen from one browser cannot be replayed from another.
 */
import crypto from 'node:crypto';
import { safeEqual } from './crypto.js';
import { cleanName, normalizeEmail } from './identifiers.js';

export const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const MIN_REFETCH_MS = 60 * 1000;
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const REASONS = {
  malformed: 'That Google sign-in could not be read.',
  'bad-algorithm': 'That Google sign-in is not valid.',
  'unknown-key': 'That Google sign-in could not be checked.',
  'bad-signature': 'That Google sign-in is not valid.',
  'wrong-audience': 'That Google sign-in was made for another site.',
  'wrong-issuer': 'That Google sign-in is not valid.',
  expired: 'That Google sign-in has expired. Please try again.',
  'not-yet-valid': 'That Google sign-in is not valid yet. Check your clock.',
  'no-email': 'Your Google account did not share a usable e-mail address.',
  'email-unverified': 'Google has not verified that e-mail address.',
  'wrong-nonce': 'That Google sign-in did not start here. Please try again.',
  'keys-unavailable': 'Google could not be reached to check the sign-in. Please try again.',
};

const failure = (reason) => ({ ok: false, reason, message: REASONS[reason] });

function decodeJson(segment) {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The default way to get Google's keys. Returns {keys: [...jwk], maxAgeMs}. Injected in tests. */
export async function fetchGoogleKeys() {
  const response = await fetch(GOOGLE_KEYS_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Google's key set answered ${response.status}`);
  const body = await response.json();
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1]);
  return { keys: Array.isArray(body?.keys) ? body.keys : [], maxAgeMs: Number.isFinite(maxAge) ? maxAge * 1000 : 3600 * 1000 };
}

/**
 * @param {object} options
 * @param {string} options.clientId the OAuth client id (AUTH_GOOGLE_CLIENT_ID)
 * @param {() => Promise<{keys: object[], maxAgeMs: number}>} [options.fetchKeys]
 * @param {() => number} [options.now]
 */
export function createGoogleVerifier({ clientId, fetchKeys = fetchGoogleKeys, now = Date.now }) {
  let keys = new Map(); // kid -> KeyObject
  let freshUntil = 0;
  let lastFetch = 0;
  let loading = null;

  async function refresh() {
    loading ??= (async () => {
      try {
        lastFetch = now();
        const { keys: jwks, maxAgeMs } = await fetchKeys();
        const next = new Map();
        for (const jwk of jwks) {
          if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) continue;
          try {
            const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
            if ((key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048) next.set(jwk.kid, key);
          } catch {
            // a key that does not parse is skipped
          }
        }
        if (next.size) {
          keys = next;
          freshUntil = now() + Math.min(Math.max(maxAgeMs, 5 * 60 * 1000), 24 * 60 * 60 * 1000);
        }
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  async function keyFor(kid) {
    if (now() >= freshUntil) await refresh().catch(() => {});
    if (!keys.has(kid) && now() - lastFetch > MIN_REFETCH_MS) await refresh().catch(() => {}); // Google rotated: look once more, not on every bad token
    return keys.get(kid) ?? null;
  }

  /**
   * @param {unknown} credential the JWT from the browser
   * @param {{nonce?: string}} [expect] the nonce this browser was given
   * @returns {Promise<{ok: true, profile: {sub: string, email: string, name: string | null, hd: string | null}} | {ok: false, reason: string, message: string}>}
   */
  async function verify(credential, { nonce } = {}) {
    if (typeof credential !== 'string' || credential.length > 4096) return failure('malformed');
    const parts = credential.split('.');
    if (parts.length !== 3 || !parts.every((p) => p && SEGMENT.test(p))) return failure('malformed');
    const [head, body, signature] = parts;
    const header = decodeJson(head);
    const claims = decodeJson(body);
    if (!header || !claims) return failure('malformed');
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 128) return failure('bad-algorithm');

    const key = await keyFor(header.kid);
    if (!key) return failure(keys.size ? 'unknown-key' : 'keys-unavailable');
    let signed = false;
    try {
      signed = crypto.verify('RSA-SHA256', Buffer.from(`${head}.${body}`), key, Buffer.from(signature, 'base64url'));
    } catch {
      signed = false;
    }
    if (!signed) return failure('bad-signature');

    // from here the token is Google's; now is it meant for us, and still good?
    if (typeof claims.iss !== 'string' || !ISSUERS.has(claims.iss)) return failure('wrong-issuer');
    if (typeof claims.aud !== 'string' || !safeEqual(claims.aud, clientId)) return failure('wrong-audience');
    const t = now();
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= t - 30 * 1000) return failure('expired');
    if (!Number.isFinite(claims.iat) || claims.iat * 1000 > t + 60 * 1000) return failure('not-yet-valid');
    if (claims.exp - claims.iat > 24 * 60 * 60) return failure('expired');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) return failure('malformed');
    const email = normalizeEmail(claims.email);
    if (!email) return failure('no-email');
    if (claims.email_verified !== true && claims.email_verified !== 'true') return failure('email-unverified');
    if (nonce !== undefined && !(typeof claims.nonce === 'string' && safeEqual(claims.nonce, nonce))) return failure('wrong-nonce');

    return {
      ok: true,
      profile: {
        sub: claims.sub,
        email: email.value,
        name: cleanName(claims.name) ?? cleanName([claims.given_name, claims.family_name].filter(Boolean).join(' ')),
        hd: typeof claims.hd === 'string' && DOMAIN.test(claims.hd.toLowerCase()) ? claims.hd.toLowerCase() : null,
      },
    };
  }

  return { verify };
}
