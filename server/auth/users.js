/**
 * Accounts.
 *
 * The rule everything here serves: **only a verified e-mail address, a verified phone number or a Google account id can sign
 * anybody in, and each of them belongs to at most one account.**
 *
 * An address or number somebody merely typed into a form is a *claim*, kept apart from the verified ones (`emailClaim` /
 * `phoneClaim` against `emailKey` / `phoneKey`). A claim is never used to find an account at sign-in and is not unique, so typing
 * another person's address gives no power over their account: when the real owner later proves it with a code, they get an
 * account of their own and the claim is simply removed from the other one. This closes the "pre-account takeover" trap, where an
 * attacker signs up with a victim's address first and waits for the victim to arrive.
 *
 * A verified contact detail is changed only by proving the new one with a code (`attachVerified`), never by editing the form, so
 * nobody can lock themselves or anybody else out by typing.
 */
import { randomId } from './crypto.js';
import { findAndUpdate, isDuplicateKey } from './db.js';
import { cleanFirm, cleanName, firmFromDomain, normalizeEmail, normalizePhone } from './identifiers.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * The rules that decide when the sign-up form is finished.
 *   requireFirm  a firm (or "individual") is needed
 *   confirm      {email, phone}: for each, whether that way of sending a code is available. Where it is, the second contact detail must
 *                be CONFIRMED with a code before the form counts as finished, because only a confirmed detail can sign anybody in. A
 *                number that was only typed would not: signing in with it later would start a second, empty account.
 * A boolean is the older form of the same thing (requireFirm only).
 */
function readRules(rules) {
  const given = typeof rules === 'boolean' ? { requireFirm: rules } : (rules ?? {});
  return { requireFirm: given.requireFirm ?? true, confirm: given.confirm ?? {} };
}

/** What the browser may know about an account. Never an internal id, the owner id or the Google id. */
export function publicView(user, rules = {}) {
  const needs = missingFields(user, rules);
  return {
    name: user.name ?? '',
    firm: user.firm ?? '',
    individual: Boolean(user.individual),
    email: user.email ?? '',
    emailVerified: Boolean(user.emailKey),
    phone: user.phone ?? '',
    phoneVerified: Boolean(user.phoneKey),
    googleLinked: Boolean(user.googleSub),
    profileComplete: needs.length === 0,
    needs,
  };
}

/** The pieces of the sign-up form still empty or unconfirmed: 'name', 'email', 'phone', 'email-confirm', 'phone-confirm', 'firm'. */
export function missingFields(user, rules = {}) {
  const { requireFirm, confirm } = readRules(rules);
  const needs = [];
  if (!user.name) needs.push('name');
  for (const kind of ['email', 'phone']) {
    if (!user[kind]) needs.push(kind);
    else if (!user[`${kind}Key`] && confirm[kind]) needs.push(`${kind}-confirm`);
  }
  if (requireFirm && !user.firm && !user.individual) needs.push('firm');
  return needs;
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./db.js').createAuthDb>} deps.db
 * @param {() => number} [deps.now]
 * @param {(userId: string) => void} [deps.onChanged] told about every account changed behind its owner's back (a claim taken off it), so a cached copy is dropped
 */
export function createUsers({ db, now = Date.now, onChanged }) {
  const users = () => db.col('users');

  async function byId(id) {
    if (typeof id !== 'string') return null;
    return (await users()).findOne({ _id: id });
  }

  async function findByVerified(kind, key) {
    return (await users()).findOne(kind === 'email' ? { emailKey: key } : { phoneKey: key });
  }

  async function findByGoogleSub(sub) {
    return (await users()).findOne({ googleSub: sub });
  }

  /** Remove every unproved claim to this address / number from accounts other than `exceptId`. */
  async function dropClaims(kind, key, exceptId) {
    const col = await users();
    const claim = kind === 'email' ? 'emailClaim' : 'phoneClaim';
    const display = kind === 'email' ? 'email' : 'phone';
    const filter = { [claim]: key, _id: { $ne: exceptId } };
    const affected = await col.find(filter).toArray();
    if (!affected.length) return;
    await col.updateMany(filter, { $unset: { [claim]: '', [display]: '' }, $set: { profileComplete: false, updatedAt: now() } });
    for (const user of affected) onChanged?.(user._id);
  }

  /** A new, unfinished account whose first verified contact detail is `key`. */
  async function createVerified(kind, key) {
    const t = now();
    const doc = {
      _id: randomId(),
      ownerId: randomId(),
      profileComplete: false,
      createdAt: t,
      updatedAt: t,
      lastLoginAt: t,
      ...(kind === 'email' ? { email: key, emailKey: key } : { phone: key, phoneKey: key }),
    };
    const col = await users();
    try {
      await col.insertOne(doc);
    } catch (error) {
      if (isDuplicateKey(error)) return { user: await findByVerified(kind, key), created: false }; // somebody verified it a moment ago
      throw error;
    }
    await dropClaims(kind, key, doc._id);
    return { user: doc, created: true };
  }

  /** After a right code for an address or number: the account that owns it (made on the spot when there is none). */
  async function signInOrCreate(kind, key, { signupOpen = true } = {}) {
    const existing = await findByVerified(kind, key);
    if (existing) {
      await (await users()).updateOne({ _id: existing._id }, { $set: { lastLoginAt: now() } });
      return { user: existing, created: false };
    }
    if (!signupOpen) return { user: null, created: false, closed: true };
    return createVerified(kind, key);
  }

  /**
   * After a verified Google token. Matches by the Google account id, then by the same verified e-mail address (which Google has
   * vouched for), else makes the account on the spot.
   */
  async function signInOrCreateGoogle({ sub, email, name, hd }, { signupOpen = true } = {}) {
    const col = await users();
    const bySub = await findByGoogleSub(sub);
    if (bySub) {
      await col.updateOne({ _id: bySub._id }, { $set: { lastLoginAt: now() } });
      return { user: bySub, created: false };
    }
    const byEmail = await findByVerified('email', email);
    if (byEmail) {
      if (byEmail.googleSub) return { user: null, created: false, conflict: true }; // linked to a different Google account already
      const linked = await findAndUpdate(col, { _id: byEmail._id, googleSub: { $exists: false } }, { $set: { googleSub: sub, lastLoginAt: now(), updatedAt: now(), ...(hd && { googleHd: hd }) } }, { returnDocument: 'after' });
      if (linked) return { user: linked, created: false, linked: true };
      return { user: null, created: false, conflict: true };
    }
    if (!signupOpen) return { user: null, created: false, closed: true };
    const t = now();
    const doc = {
      _id: randomId(),
      ownerId: randomId(),
      email,
      emailKey: email,
      googleSub: sub,
      ...(name && { name }),
      ...(hd && { googleHd: hd }),
      profileComplete: false,
      createdAt: t,
      updatedAt: t,
      lastLoginAt: t,
    };
    try {
      await col.insertOne(doc);
    } catch (error) {
      if (isDuplicateKey(error)) return signInOrCreateGoogle({ sub, email, name, hd }, { signupOpen });
      throw error;
    }
    await dropClaims('email', email, doc._id);
    return { user: doc, created: true };
  }

  /**
   * Save the sign-up form / the profile page. Name and firm can always be changed. An e-mail address or number can be typed in
   * only while the account has no verified one of that kind (it is then kept as an unproved claim); a verified one is changed with
   * attachVerified after a code.
   * @returns {Promise<{ok: true, user: object, becameComplete: boolean} | {ok: false, field: string, message: string}>}
   */
  async function saveProfile(user, input, rules = {}) {
    const set = { updatedAt: now() };
    const unset = {};
    const next = { ...user };

    if (input.name !== undefined) {
      const name = cleanName(input.name);
      if (!name) return { ok: false, field: 'name', message: 'Please enter your name using letters, spaces, dots, hyphens or apostrophes.' };
      set.name = name;
      next.name = name;
    }
    if (input.individual !== undefined || input.firm !== undefined) {
      const individual = Boolean(input.individual);
      if (individual) {
        set.individual = true;
        unset.firm = '';
        delete next.firm;
        next.individual = true;
      } else {
        const firm = input.firm === undefined || input.firm === '' ? null : cleanFirm(input.firm);
        if (input.firm !== undefined && input.firm !== '' && !firm) return { ok: false, field: 'firm', message: 'Please enter the firm name in plain letters, numbers and common punctuation.' };
        if (firm) {
          set.firm = firm;
          next.firm = firm;
        } else {
          unset.firm = '';
          delete next.firm;
        }
        set.individual = false;
        next.individual = false;
      }
    }
    for (const [kind, parse, label] of [['email', normalizeEmail, 'e-mail address'], ['phone', normalizePhone, 'mobile number']]) {
      if (input[kind] === undefined || input[kind] === '') continue;
      const verified = kind === 'email' ? user.emailKey : user.phoneKey;
      if (verified) continue; // a verified detail is changed only with a code
      const parsed = parse(input[kind]);
      const value = kind === 'email' ? parsed?.value : parsed;
      if (!value) return { ok: false, field: kind, message: `Please enter a valid ${label}.` };
      const claim = kind === 'email' ? 'emailClaim' : 'phoneClaim';
      set[claim] = value;
      set[kind] = value;
      next[claim] = value;
      next[kind] = value;
    }

    const complete = missingFields(next, rules).length === 0;
    set.profileComplete = complete;
    const col = await users();
    const update = { $set: set, ...(Object.keys(unset).length && { $unset: unset }) };
    const saved = await findAndUpdate(col, { _id: user._id }, update, { returnDocument: 'after' });
    if (!saved) return { ok: false, field: '', message: 'Your account could not be found.' };
    return { ok: true, user: saved, becameComplete: complete && !user.profileComplete };
  }

  /**
   * A code was just confirmed for `key`: make it this account's verified e-mail / number. Fails with reason "taken" when another
   * account already has it verified. Any unproved claims to it elsewhere are removed.
   */
  async function attachVerified(userId, kind, key) {
    const col = await users();
    const field = kind === 'email' ? 'emailKey' : 'phoneKey';
    const display = kind === 'email' ? 'email' : 'phone';
    const claim = kind === 'email' ? 'emailClaim' : 'phoneClaim';
    try {
      const saved = await findAndUpdate(col, { _id: userId }, { $set: { [field]: key, [display]: key, updatedAt: now() }, $unset: { [claim]: '' } }, { returnDocument: 'after' });
      if (!saved) return { ok: false, reason: 'missing' };
      await dropClaims(kind, key, userId);
      return { ok: true, user: saved };
    } catch (error) {
      if (isDuplicateKey(error)) return { ok: false, reason: 'taken' };
      throw error;
    }
  }

  async function setComplete(userId, rules = {}) {
    const user = await byId(userId);
    if (!user) return null;
    const complete = missingFields(user, rules).length === 0;
    if (complete === Boolean(user.profileComplete)) return { user, becameComplete: false };
    const saved = await findAndUpdate(await users(), { _id: userId }, { $set: { profileComplete: complete, updatedAt: now() } }, { returnDocument: 'after' });
    return { user: saved, becameComplete: complete };
  }

  /** A firm to suggest for this account: from the Google workspace domain, or the verified e-mail's domain. */
  function firmHint(user, extraBlocked = []) {
    const domain = user.googleHd || (user.emailKey ? user.emailKey.split('@')[1] : null) || (user.emailClaim ? user.emailClaim.split('@')[1] : null);
    return domain ? { domain, name: firmFromDomain(domain, extraBlocked) } : { domain: null, name: null };
  }

  async function remove(userId) {
    const col = await users();
    const { deletedCount } = await col.deleteOne({ _id: userId });
    return deletedCount === 1;
  }

  /** Accounts that verified an address but never filled in the form, for the clean-up sweep. */
  async function removeIncompleteOlderThan(days) {
    const col = await users();
    const { deletedCount } = await col.deleteMany({ profileComplete: false, createdAt: { $lt: now() - days * DAY } });
    return deletedCount;
  }

  return { byId, findByVerified, findByGoogleSub, signInOrCreate, signInOrCreateGoogle, saveProfile, attachVerified, setComplete, firmHint, remove, removeIncompleteOlderThan, publicView, missingFields };
}
