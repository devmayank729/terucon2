/**
 * The few cryptographic helpers the sign-in code uses, in one place so every secret is handled the same way:
 *   - tokens (session cookies, tickets) are 256 random bits; only their SHA-256 is stored, so a leaked database cannot be replayed;
 *   - one-time codes are only ever stored as an HMAC keyed with AUTH_SECRET, because a bare hash of a six-digit code falls to an
 *     offline brute force in a millisecond;
 *   - every comparison of a secret is constant time.
 */
import crypto from 'node:crypto';

/** A random URL-safe token. 32 bytes (256 bits) by default. */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** A random id for a record: 128 bits as 32 lowercase hex characters (the same shape as the studio's owner ids). */
export const randomId = () => crypto.randomBytes(16).toString('hex');

/** SHA-256 of a string, URL-safe base64. For values that already carry 128+ bits of randomness. */
export const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('base64url');

/** HMAC-SHA-256 of `data` under `secret`, URL-safe base64. */
export const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(String(data)).digest('base64url');

/**
 * Constant-time equality for two strings of any length. Both sides are hashed first, so a different length cannot be
 * told apart by timing, and timingSafeEqual never throws on a length mismatch.
 */
export function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

/** A uniformly random numeric code of `length` digits, zeros kept ("004217"). crypto.randomInt has no modulo bias. */
export function randomCode(length = 6) {
  const max = 10 ** length;
  return String(crypto.randomInt(0, max)).padStart(length, '0');
}
