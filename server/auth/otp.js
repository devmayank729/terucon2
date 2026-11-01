/**
 * One-time codes: asking for one and using one.
 *
 * A code belongs to a challenge. The challenge records what the code is for (`purpose`: sign in, confirm a contact detail, delete
 * the account), the address or number it was sent to, how many guesses are left and whether it has been used. The code itself
 * is stored only as an HMAC keyed with AUTH_SECRET and bound to the challenge id and the purpose, so a code for one thing cannot be
 * used for another, and a copy of the database is no help to someone guessing offline.
 *
 * Why the limits are shaped the way they are
 *   - Asking for a code gives the same answer for an address that has an account and one that has none. Nothing here looks an
 *     account up, so the form cannot be used to find out who is registered.
 *   - A guess is counted before it is checked, in the same database step that tests the ceiling. Sixty requests sent at the same
 *     instant get five guesses between them, not sixty.
 *   - A right code is spent in one conditional step too: two requests holding the same right code make one sign-in, not two.
 *   - Wrong guesses are also counted per address or number across all its codes. Asking for a fresh code does not give a fresh
 *     allowance, and after too many the address is locked for a while.
 *   - Codes sent per address or number are capped per hour, and the whole site's daily number of e-mails and texts is capped, so
 *     the form cannot be used to flood somebody's inbox or to run up a text-message bill (including toward premium numbers).
 */
import { hmac, randomCode, randomId, safeEqual } from './crypto.js';
import { findAndUpdate } from './db.js';
import { isDisposable, maskEmail, maskPhone, phoneCountryAllowed } from './identifiers.js';
import { WINDOWS } from './limits.js';

export const CODE_LENGTH = 6;
export const PURPOSES = new Set(['login', 'verify-contact', 'delete']);
const CHALLENGE_ID = /^[a-f0-9]{32}$/;
const CODE_PATTERN = new RegExp(`^\\d{${CODE_LENGTH}}$`);

const MESSAGES = {
  'channel-unavailable-email': 'Sign-in by e-mail is not available right now.',
  'channel-unavailable-sms': 'Text-message codes are not available right now. Please use your e-mail address.',
  'country-not-supported': 'We cannot send text messages to that country yet. Please use your e-mail address.',
  'email-not-allowed': 'Please use a permanent e-mail address, not a temporary inbox.',
  'invalid-code': 'That code did not work. Please request a new one.',
  expired: 'That code has expired. Please request a new one.',
  'too-many-attempts': 'Too many wrong tries for that code. Please request a new one.',
  'send-failed': 'We could not send the code. Please try again in a minute.',
  'daily-cap': 'We cannot send more codes right now. Please try again later.',
};

const minutes = (seconds) => Math.max(1, Math.ceil(seconds / 60));
const wait = (seconds) => `${minutes(seconds)} minute${minutes(seconds) === 1 ? '' : 's'}`;

const fail = (status, reason, message, extra = {}) => ({ ok: false, status, reason, message: message ?? MESSAGES[reason], ...extra });

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./db.js').createAuthDb>} deps.db
 * @param {{get: () => Promise<any>}} deps.settings
 * @param {import('./limits.js').AuthLimits} deps.limits
 * @param {ReturnType<typeof import('./events.js').createEvents>} deps.events
 * @param {string} deps.secret AUTH_SECRET
 * @param {() => {email: any, sms: any}} deps.providers
 * @param {() => number} [deps.now]
 */
export function createOtp({ db, settings, limits, events, secret, providers, now = Date.now, log }) {
  if (!secret) throw new Error('createOtp needs a secret');
  const seal = (id, purpose, code) => hmac(secret, `otp|${id}|${purpose}|${code}`);
  const lastCapLog = new Map();

  /**
   * Send a code.
   * @param {object} o
   * @param {{kind: 'email' | 'phone', key: string, rateKey: string, domain?: string}} o.identifier a classified identifier
   * @param {'login' | 'verify-contact' | 'delete'} o.purpose
   * @param {string} o.ip
   * @param {string} [o.userId] whom the code is for (required for purposes other than "login")
   */
  async function start({ identifier, purpose, ip, userId = null }) {
    if (!PURPOSES.has(purpose)) throw new Error(`unknown purpose ${purpose}`);
    const cfg = await settings.get();
    const channel = identifier.kind === 'email' ? 'email' : 'sms';
    const sender = providers()[channel];
    const who = identifier.kind === 'email' ? maskEmail(identifier.key) : maskPhone(identifier.key);

    if (!sender.ready || !cfg.channels[channel]) return fail(503, `channel-unavailable-${channel}`);
    if (channel === 'sms' && !phoneCountryAllowed(identifier.key, cfg.sms.allowedCountryCodes)) return fail(400, 'country-not-supported');
    if (channel === 'email') {
      const blockedByAdmin = cfg.email.blockedDomains.some((d) => identifier.domain === d || identifier.domain.endsWith(`.${d}`));
      if (blockedByAdmin || (cfg.email.blockDisposable && isDisposable(identifier.domain))) return fail(400, 'email-not-allowed');
    }

    const ipVerdict = limits.ip('otp-start', ip, cfg.limits.otpStartPerIpPerHour, 'hour');
    if (!ipVerdict.ok) {
      await events.record('otp.rate-limited', { ip, who, detail: 'per network address' });
      return fail(429, 'rate-limited', `Too many codes were requested from your network. Please wait ${wait(ipVerdict.retryAfter)} and try again.`, { retryAfter: ipVerdict.retryAfter });
    }

    const lockWindow = cfg.limits.lockMinutes * 60 * 1000;
    const lock = await limits.locked('otp-fail', identifier.rateKey, cfg.limits.failuresBeforeLock, lockWindow);
    if (lock.locked) {
      await events.record('otp.locked', { ip, who, detail: 'start refused' });
      return fail(429, 'locked', `Too many wrong codes were entered for ${who}. Please wait ${wait(lock.retryAfter)} and try again.`, { retryAfter: lock.retryAfter });
    }

    // the cooldown between two codes to the same address or number, for the same purpose (a person who has just signed in must
    // still be able to ask for the code that confirms deleting the account); the hourly cap below counts them all together
    const cooldownMs = cfg.otp.resendCooldownSeconds * 1000;
    const coolKey = `${purpose}|${identifier.rateKey}`;
    const recent = await limits.count('otp-cool', coolKey, cooldownMs);
    if (recent.used > 0) {
      const retryAfter = Math.max(1, Math.ceil(((recent.oldest ?? now()) + cooldownMs - now()) / 1000));
      return fail(429, 'cooldown', `A code was just sent. You can ask for another in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`, { retryAfter });
    }

    const perHour = await limits.consume('otp-send', identifier.rateKey, cfg.limits.otpStartPerIdentifierPerHour, WINDOWS.HOUR);
    if (!perHour.ok) {
      await events.record('otp.rate-limited', { ip, who, detail: 'per address or number' });
      return fail(429, 'rate-limited', `Too many codes were sent to ${who}. Please wait ${wait(perHour.retryAfter)} and try again.`, { retryAfter: perHour.retryAfter });
    }

    const cap = await limits.consume('cap', channel, channel === 'sms' ? cfg.limits.smsPerDay : cfg.limits.emailPerDay, WINDOWS.DAY);
    if (!cap.ok) {
      if (now() - (lastCapLog.get(channel) ?? 0) > 10 * 60 * 1000) {
        lastCapLog.set(channel, now());
        await events.record('otp.cap-hit', { ip, detail: `the daily ${channel} limit was reached` });
      }
      return fail(503, 'daily-cap');
    }

    const cool = await limits.record('otp-cool', coolKey, cooldownMs);
    const code = randomCode(CODE_LENGTH);
    const id = randomId();
    const t = now();
    const expiresAt = t + cfg.otp.ttlMinutes * 60 * 1000;
    const challenges = await db.col('challenges');
    await challenges.insertOne({
      _id: id,
      purpose,
      channel,
      idKind: identifier.kind,
      idKey: identifier.key,
      idRateKey: identifier.rateKey,
      userId,
      codeHash: seal(id, purpose, code),
      attempts: 0,
      maxAttempts: cfg.otp.maxAttempts,
      used: false,
      createdAt: t,
      expiresAt,
      purgeAt: new Date(expiresAt + 60 * 60 * 1000),
    });

    try {
      await sender.send({ to: identifier.key, code, ttlMinutes: cfg.otp.ttlMinutes, purpose });
    } catch (error) {
      await challenges.deleteOne({ _id: id });
      await limits.refund(perHour.id); // a failed send should not use up the person's allowance, nor the site's
      await limits.refund(cap.id);
      await limits.refund(cool);
      await events.record('send.failed', { ip, who, detail: `${channel}: ${error.message}` });
      return fail(502, 'send-failed');
    }
    await events.record('otp.sent', { ip, who, detail: `${purpose} by ${channel}` });
    return {
      ok: true,
      challengeId: id,
      channel,
      to: who,
      resendIn: cfg.otp.resendCooldownSeconds,
      expiresIn: cfg.otp.ttlMinutes * 60,
      codeLength: CODE_LENGTH,
    };
  }

  /**
   * Check a code.
   * @returns {Promise<{ok: true, challenge: {id: string, purpose: string, idKind: string, idKey: string, idRateKey: string, userId: string | null}} | {ok: false, status: number, reason: string, message: string}>}
   */
  async function verify({ challengeId, code, purpose, ip, userId = null }) {
    const cfg = await settings.get();
    const ipVerdict = limits.ip('otp-verify', ip, cfg.limits.otpVerifyPerIpPerHour, 'hour');
    if (!ipVerdict.ok) return fail(429, 'rate-limited', `Too many attempts from your network. Please wait ${wait(ipVerdict.retryAfter)} and try again.`, { retryAfter: ipVerdict.retryAfter });

    const typed = typeof code === 'string' ? code.replace(/[\s-]/g, '') : '';
    if (typeof challengeId !== 'string' || !CHALLENGE_ID.test(challengeId) || !CODE_PATTERN.test(typed)) return fail(400, 'invalid-code');

    const challenges = await db.col('challenges');
    const challenge = await challenges.findOne({ _id: challengeId });
    if (!challenge || challenge.purpose !== purpose || (challenge.userId ?? null) !== (userId ?? null)) return fail(400, 'invalid-code');
    if (challenge.used) return fail(400, 'invalid-code');
    if (challenge.expiresAt <= now()) return fail(400, 'expired');

    const lockWindow = cfg.limits.lockMinutes * 60 * 1000;
    const lock = await limits.locked('otp-fail', challenge.idRateKey, cfg.limits.failuresBeforeLock, lockWindow);
    if (lock.locked) {
      await events.record('otp.locked', { ip, detail: 'verify refused' });
      return fail(429, 'locked', `Too many wrong codes. Please wait ${wait(lock.retryAfter)} and try again.`, { retryAfter: lock.retryAfter });
    }

    // spend one guess; the ceiling is tested in the same step, so concurrent guesses cannot exceed it
    const counted = await findAndUpdate(
      challenges,
      { _id: challengeId, used: false, expiresAt: { $gt: now() }, attempts: { $lt: challenge.maxAttempts } },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    if (!counted) return fail(400, challenge.attempts >= challenge.maxAttempts ? 'too-many-attempts' : 'invalid-code');

    if (!safeEqual(counted.codeHash, seal(challengeId, purpose, typed))) {
      await limits.record('otp-fail', challenge.idRateKey, lockWindow);
      await events.record('otp.wrong', { ip, detail: `${purpose}, guess ${counted.attempts} of ${counted.maxAttempts}` });
      const left = counted.maxAttempts - counted.attempts;
      return fail(400, left > 0 ? 'wrong-code' : 'too-many-attempts', left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : MESSAGES['too-many-attempts'], { attemptsLeft: left });
    }

    // the right code: spend it. Of several requests holding the same right code, exactly one gets past this step
    const spent = await findAndUpdate(challenges, { _id: challengeId, used: false }, { $set: { used: true, usedAt: now() } }, { returnDocument: 'after' });
    if (!spent) return fail(400, 'invalid-code');
    await limits.clear('otp-fail', challenge.idRateKey);
    return { ok: true, challenge: { id: challengeId, purpose, idKind: challenge.idKind, idKey: challenge.idKey, idRateKey: challenge.idRateKey, userId: challenge.userId ?? null } };
  }

  return { start, verify, codeLength: CODE_LENGTH };
}
