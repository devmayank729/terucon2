/**
 * The sign-in settings the admin panel will manage: rate limits, one-time-code rules, session lifetimes, which ways to sign in are
 * open, the country allow-list for text messages, and how a new account is sent to the CRM.
 *
 * Every setting is declared once, in SCHEMA, with its type, its default and hard bounds. The bounds are the point: an admin
 * form (or a script holding the admin token) can never save a limit of 0 or of a billion, an empty allow-list that
 * turns every country on, or a value of the wrong type. A value that breaks its rule is refused with a sentence that names the
 * setting; nothing is half-saved.
 *
 * What is NOT a setting: secrets and anything that decides whether the site is safe to run at all (AUTH_SECRET, provider
 * credentials, AUTH_REQUIRED, the admin token). Those live in the environment (.env) only, so a stolen admin token cannot turn
 * the lock off or read a key.
 *
 * Stored as one document (`terucon_settings`, _id "main") holding only the values that differ from the defaults, as JSON text with
 * a version number, so two admins saving at once cannot silently overwrite each other (the second is told to reload).
 */
import { LIMIT_DEFAULTS as CATALOGUE_LIMITS } from '../catalogue/config.js';
import { LIMIT_DEFAULTS } from '../config/settings.js';
import { findAndUpdate, isDuplicateKey } from './db.js';

const COUNTRY_CODE = /^[1-9]\d{0,3}$/;
const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;

/** @typedef {{key: string, group: string, label: string, help: string, type: 'bool' | 'int' | 'enum' | 'text' | 'list' | 'field', default: any, min?: number, max?: number, unit?: string, options?: string[], item?: 'country' | 'domain', maxItems?: number}} Setting */

/** @type {Setting[]} */
export const SCHEMA = [
  // ---- who can get in
  { key: 'signup.open', group: 'Access', label: 'New accounts', help: 'Off: only people who already have an account can sign in. Nobody new can sign up.', type: 'bool', default: true },
  { key: 'signup.requireFirm', group: 'Access', label: 'Ask for a firm', help: 'On: the sign-up form needs a firm name unless the person says they are an individual.', type: 'bool', default: true },
  { key: 'signup.confirmSecondContact', group: 'Access', label: 'Confirm the second contact detail at sign-up', help: 'On: someone who signs up with an e-mail address must confirm the mobile number they give with a code (and the other way round), when that way of sending codes is available. This is what lets them sign in with either one later. Off: it is only saved, and only the confirmed one can sign in until they confirm the other on their account page; signing in with the unconfirmed one would start a second, empty account.', type: 'bool', default: true },
  { key: 'channels.email', group: 'Access', label: 'Sign in with an e-mail code', help: 'Off: nobody can use e-mail codes (even when an e-mail service is set up).', type: 'bool', default: true },
  { key: 'channels.sms', group: 'Access', label: 'Sign in with a text-message code', help: 'Off: nobody can use text-message codes (even when an SMS service is set up).', type: 'bool', default: true },
  { key: 'channels.google', group: 'Access', label: 'Sign in with Google', help: 'Off: hides Google One Tap and the Google button.', type: 'bool', default: true },
  { key: 'email.blockDisposable', group: 'Access', label: 'Refuse throw-away e-mail addresses', help: 'Blocks well-known disposable inbox services (mailinator and similar).', type: 'bool', default: true },
  { key: 'email.blockedDomains', group: 'Access', label: 'Also refuse these e-mail domains', help: 'Domains without the @ sign, e.g. spam.example. Their sub-domains are refused too.', type: 'list', item: 'domain', maxItems: 200, default: [] },
  { key: 'sms.allowedCountryCodes', group: 'Access', label: 'Countries that may get text messages', help: 'Calling codes without the +, e.g. 91 for India. Keep this short: text messages to unexpected countries are how fraudsters run up a bill. Empty means no text messages.', type: 'list', item: 'country', maxItems: 40, default: ['91'] },

  // ---- one-time codes
  { key: 'otp.ttlMinutes', group: 'One-time codes', label: 'A code works for', unit: 'minutes', help: 'How long a code can be used after it is sent.', type: 'int', min: 2, max: 30, default: 10 },
  { key: 'otp.maxAttempts', group: 'One-time codes', label: 'Wrong guesses allowed per code', help: 'After this many wrong guesses the code is dead and a new one must be requested.', type: 'int', min: 3, max: 10, default: 5 },
  { key: 'otp.resendCooldownSeconds', group: 'One-time codes', label: 'Wait before a new code', unit: 'seconds', help: 'The shortest gap between two codes to the same address or number.', type: 'int', min: 15, max: 300, default: 45 },

  // ---- limits
  { key: 'limits.otpStartPerIdentifierPerHour', group: 'Rate limits', label: 'Codes per address or number', unit: 'per hour', help: 'How many codes one e-mail address or phone number can be sent in an hour (plus-tags and Gmail dots count as the same address).', type: 'int', min: 1, max: 20, default: 5 },
  { key: 'limits.otpStartPerIpPerHour', group: 'Rate limits', label: 'Codes requested from one network address', unit: 'per hour', help: 'Per visitor address (IPv6 counted per /64). An office or a phone network shares one address, so do not set this too low.', type: 'int', min: 1, max: 200, default: 15 },
  { key: 'limits.otpVerifyPerIpPerHour', group: 'Rate limits', label: 'Code entries from one network address', unit: 'per hour', help: 'How many times one address may submit a code.', type: 'int', min: 5, max: 500, default: 60 },
  { key: 'limits.failuresBeforeLock', group: 'Rate limits', label: 'Wrong codes before an address or number is locked', help: 'Counted across all codes for the same address or number.', type: 'int', min: 3, max: 50, default: 10 },
  { key: 'limits.lockMinutes', group: 'Rate limits', label: 'Length of that lock', unit: 'minutes', help: 'Also the window the wrong codes are counted in.', type: 'int', min: 1, max: 1440, default: 30 },
  { key: 'limits.googlePerIpPerHour', group: 'Rate limits', label: 'Google sign-ins from one network address', unit: 'per hour', help: '', type: 'int', min: 1, max: 500, default: 30 },
  { key: 'limits.signupsPerIpPerDay', group: 'Rate limits', label: 'New accounts from one network address', unit: 'per day', help: '', type: 'int', min: 1, max: 200, default: 10 },
  { key: 'limits.profileChangesPerUserPerHour', group: 'Rate limits', label: 'Profile changes per person', unit: 'per hour', help: '', type: 'int', min: 1, max: 200, default: 30 },
  { key: 'limits.firmLookupsPerIpPerHour', group: 'Rate limits', label: 'Firm-name look-ups from one network address', unit: 'per hour', help: 'Each look-up may open the firm\'s website, so keep this low.', type: 'int', min: 1, max: 100, default: 10 },
  { key: 'limits.deleteRequestsPerUserPerDay', group: 'Rate limits', label: 'Delete-account codes per person', unit: 'per day', help: '', type: 'int', min: 1, max: 20, default: 3 },
  { key: 'limits.apiPerIpPerMinute', group: 'Rate limits', label: 'Any sign-in request from one network address', unit: 'per minute', help: 'A general ceiling on top of the specific limits above.', type: 'int', min: 10, max: 2000, default: 120 },
  { key: 'limits.smsPerDay', group: 'Rate limits', label: 'Text messages in total', unit: 'per day', help: 'A hard ceiling for the whole site. When it is reached nobody gets a text message until tomorrow. 0 sends none.', type: 'int', min: 0, max: 100000, default: 300 },
  { key: 'limits.emailPerDay', group: 'Rate limits', label: 'Code e-mails in total', unit: 'per day', help: 'A hard ceiling for the whole site. 0 sends none.', type: 'int', min: 0, max: 1000000, default: 1000 },

  // ---- the Design Studio's own rate limits (server/lib/studioShield.js): what is in .env (STUDIO_LIMIT_*) is the starting value, a value saved here wins
  { key: 'studio.limit.ai', group: 'Design Studio limits', label: 'Gemini calls (renders, outlines) per account', unit: 'per hour', help: 'Each account; its network address gets this times the factor below. Starts from STUDIO_LIMIT_AI in .env.', type: 'int', min: 1, max: 1000000, default: LIMIT_DEFAULTS.ai },
  { key: 'studio.limit.vision', group: 'Design Studio limits', label: 'Photo scans per account', unit: 'per hour', help: 'Starts from STUDIO_LIMIT_VISION in .env.', type: 'int', min: 1, max: 1000000, default: LIMIT_DEFAULTS.vision },
  { key: 'studio.limit.pipeline', group: 'Design Studio limits', label: 'Room analyses and their wake-ups per account', unit: 'per hour', help: 'Starts from STUDIO_LIMIT_PIPELINE in .env.', type: 'int', min: 1, max: 1000000, default: LIMIT_DEFAULTS.pipeline },
  { key: 'studio.limit.check', group: 'Design Studio limits', label: 'Settings > Check runs per account', unit: 'per hour', help: 'Starts from STUDIO_LIMIT_CHECK in .env.', type: 'int', min: 1, max: 1000000, default: LIMIT_DEFAULTS.check },
  { key: 'studio.limit.rooms', group: 'Design Studio limits', label: 'Saving and deleting rooms and their files per account', unit: 'per hour', help: 'Autosave is frequent, so keep this high. Starts from STUDIO_LIMIT_ROOMS in .env.', type: 'int', min: 1, max: 1000000, default: LIMIT_DEFAULTS.rooms },
  { key: 'studio.limit.addressFactor', group: 'Design Studio limits', label: 'Network address allowance, as a multiple of the above', help: 'An office or a phone network shares one address, so an address gets this many accounts\' worth. Starts from STUDIO_LIMIT_ADDRESS_FACTOR in .env.', type: 'int', min: 1, max: 100, default: LIMIT_DEFAULTS.perAddress },

  // ---- catalogue search (server/catalogue/): per-account limits, like the Design Studio's, and how many searches the GPU service takes at once
  { key: 'catalogue.limit.searchPerHour', group: 'Catalogue search', label: 'Photo searches per account', unit: 'per hour', help: 'Each account; its network address gets this times the factor below. Every photo search can wake and use the GPU service, which is billed. A starting value, not a measured one.', type: 'int', min: 1, max: 100000, default: CATALOGUE_LIMITS.searchPerHour },
  { key: 'catalogue.limit.textPerHour', group: 'Catalogue search', label: 'Text searches per account', unit: 'per hour', help: 'Each account; its network address gets this times the factor below.', type: 'int', min: 1, max: 100000, default: CATALOGUE_LIMITS.textPerHour },
  { key: 'catalogue.limit.warmPerHour', group: 'Catalogue search', label: 'Wake-up requests per account', unit: 'per hour', help: 'The shop asks the search service to wake up when a visitor opens the photo search. Whatever this says, the site sends Modal at most one wake-up a minute.', type: 'int', min: 1, max: 100000, default: CATALOGUE_LIMITS.warmPerHour },
  { key: 'catalogue.limit.addressFactor', group: 'Catalogue search', label: 'Network address allowance, as a multiple of the above', help: 'An office or a phone network shares one address, so an address gets this many accounts\' worth.', type: 'int', min: 1, max: 100, default: CATALOGUE_LIMITS.perAddress },
  { key: 'catalogue.maxConcurrent', group: 'Catalogue search', label: 'Searches running at once', help: 'The most searches this website sends to the search service at the same moment. More get a "busy, try again" answer without reaching the service, so a rush cannot pile work on the GPU.', type: 'int', min: 1, max: 32, default: CATALOGUE_LIMITS.maxConcurrent },

  // ---- sessions
  { key: 'session.idleDays', group: 'Sessions', label: 'Sign out after being away for', unit: 'days', help: 'A browser that has not been used for this long has to sign in again.', type: 'int', min: 1, max: 90, default: 14 },
  { key: 'session.maxDays', group: 'Sessions', label: 'Always sign out after', unit: 'days', help: 'The longest a single sign-in can last, however often it is used.', type: 'int', min: 1, max: 365, default: 30 },
  { key: 'session.incompleteAccountDays', group: 'Sessions', label: 'Remove accounts that never finished the sign-up form after', unit: 'days', help: 'Someone who verified an address but never filled in the form.', type: 'int', min: 1, max: 90, default: 7 },

  // ---- firm names
  { key: 'firm.lookup', group: 'Firm name', label: 'Suggesting the firm from a business e-mail', help: 'off: never suggest. domain: guess from the e-mail domain only. website: also read the name from the firm\'s own website (the server opens https://their-domain).', type: 'enum', options: ['off', 'domain', 'website'], default: 'website' },

  // ---- CRM
  { key: 'crm.enabled', group: 'CRM (Zoho)', label: 'Send new sign-ups to the CRM', help: 'Off: nothing is queued or sent. Needs the Zoho credentials in .env before anything leaves the server.', type: 'bool', default: true },
  { key: 'crm.module', group: 'CRM (Zoho)', label: 'Zoho module', help: 'Leads or Contacts.', type: 'enum', options: ['Leads', 'Contacts'], default: 'Leads' },
  { key: 'crm.leadSource', group: 'CRM (Zoho)', label: 'Lead source text', help: 'Written into the CRM\'s Lead Source field.', type: 'text', max: 60, default: 'Terucon website sign-up' },
  { key: 'crm.companyWhenNoFirm', group: 'CRM (Zoho)', label: 'Company text for people with no firm', help: 'Zoho Leads normally insists on a Company; this is sent for someone who signed up as an individual.', type: 'text', max: 60, default: 'Individual' },
  { key: 'crm.deleteOnAccountDelete', group: 'CRM (Zoho)', label: 'Delete the CRM record when someone deletes their account', help: 'Off: the CRM record stays (it is the sales team\'s record); its pending update is dropped. On: the Zoho record is deleted too.', type: 'bool', default: false },
  { key: 'crm.field.firstName', group: 'CRM (Zoho)', label: 'Zoho field: first name', help: 'API name of the field. Empty: not sent.', type: 'field', default: 'First_Name' },
  { key: 'crm.field.lastName', group: 'CRM (Zoho)', label: 'Zoho field: last name', help: 'Zoho requires a last name; it is always sent, to this field.', type: 'field', default: 'Last_Name', required: true },
  { key: 'crm.field.email', group: 'CRM (Zoho)', label: 'Zoho field: e-mail', help: 'Empty: not sent.', type: 'field', default: 'Email' },
  { key: 'crm.field.phone', group: 'CRM (Zoho)', label: 'Zoho field: phone', help: 'Empty: not sent.', type: 'field', default: 'Mobile' },
  { key: 'crm.field.company', group: 'CRM (Zoho)', label: 'Zoho field: company', help: 'Empty: not sent.', type: 'field', default: 'Company' },
  { key: 'crm.field.leadSource', group: 'CRM (Zoho)', label: 'Zoho field: lead source', help: 'Empty: not sent.', type: 'field', default: 'Lead_Source' },
  { key: 'crm.field.description', group: 'CRM (Zoho)', label: 'Zoho field: notes', help: 'Gets a line saying which of the e-mail and phone were verified. Empty: not sent.', type: 'field', default: 'Description' },
];

const BY_KEY = new Map(SCHEMA.map((setting) => [setting.key, setting]));
export const DEFAULTS = Object.freeze(Object.fromEntries(SCHEMA.map((s) => [s.key, s.default])));

/**
 * Check one value against its rule.
 * @returns {{ok: true, value: any} | {ok: false, error: string}}
 */
export function checkValue(setting, raw) {
  const fail = (error) => ({ ok: false, error: `${setting.label} (${setting.key}): ${error}` });
  switch (setting.type) {
    case 'bool':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : fail('must be true or false.');
    case 'int':
      if (!Number.isInteger(raw)) return fail('must be a whole number.');
      if (raw < setting.min || raw > setting.max) return fail(`must be between ${setting.min} and ${setting.max}.`);
      return { ok: true, value: raw };
    case 'enum':
      return setting.options.includes(raw) ? { ok: true, value: raw } : fail(`must be one of: ${setting.options.join(', ')}.`);
    case 'text':
      if (typeof raw !== 'string') return fail('must be text.');
      if (raw.length > setting.max || /[\p{Cc}\p{Cf}<>]/u.test(raw)) return fail(`must be plain text of at most ${setting.max} characters.`);
      return { ok: true, value: raw.trim() };
    case 'field':
      if (typeof raw !== 'string') return fail('must be text.');
      if (raw !== '' && !FIELD_NAME.test(raw)) return fail('must be a Zoho API field name (letters, digits and underscores, starting with a letter), or empty.');
      if (setting.required && raw === '') return fail('cannot be empty.');
      return { ok: true, value: raw };
    case 'list': {
      if (!Array.isArray(raw)) return fail('must be a list.');
      if (raw.length > setting.maxItems) return fail(`can have at most ${setting.maxItems} entries.`);
      const pattern = setting.item === 'country' ? COUNTRY_CODE : DOMAIN;
      const seen = new Set();
      for (const item of raw) {
        if (typeof item !== 'string') return fail('every entry must be text.');
        const clean = item.trim().toLowerCase();
        if (!pattern.test(clean)) return fail(setting.item === 'country' ? `"${String(item).slice(0, 12)}" is not a calling code (digits only, no +).` : `"${String(item).slice(0, 40)}" is not a domain name.`);
        seen.add(clean);
      }
      return { ok: true, value: [...seen] };
    }
    default:
      return fail('has an unknown type.');
  }
}

/**
 * Validate a patch ({key: value, key: null to go back to the default}) as a whole.
 * @returns {{ok: true, set: Record<string, any>, reset: string[]} | {ok: false, errors: string[]}}
 */
export function checkPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, errors: ['Send an object of settings.'] };
  const errors = [];
  const set = {};
  const reset = [];
  for (const [key, raw] of Object.entries(patch)) {
    const setting = BY_KEY.get(key);
    if (!setting) {
      errors.push(`"${key.slice(0, 60)}" is not a setting.`);
      continue;
    }
    if (raw === null) {
      reset.push(key);
      continue;
    }
    const checked = checkValue(setting, raw);
    if (checked.ok) set[key] = checked.value;
    else errors.push(checked.error);
  }
  return errors.length ? { ok: false, errors } : { ok: true, set, reset };
}

/** Rules that span more than one setting. Returns a sentence, or null. */
export function checkTogether(values) {
  if (values['session.idleDays'] > values['session.maxDays']) return 'Sessions: "sign out after being away" cannot be longer than "always sign out after".';
  return null;
}

/** {'otp.ttlMinutes': 10} -> {otp: {ttlMinutes: 10}} */
export function nest(flat) {
  const out = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let node = out;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts[parts.length - 1]] = value;
  }
  return out;
}

/** The public description of every setting, for an admin screen to build its form from. */
export function describeSchema() {
  return SCHEMA.map(({ key, group, label, help, type, default: def, min, max, unit, options, item, maxItems, required }) => ({
    key, group, label, help, type, default: def, ...(min !== undefined && { min }), ...(max !== undefined && { max }), ...(unit && { unit }), ...(options && { options }), ...(item && { item }), ...(maxItems && { maxItems }), ...(required && { required }),
  }));
}

export class SettingsConflictError extends Error {
  constructor() {
    super('The settings were changed by someone else a moment ago. Reload and try again.');
    this.name = 'SettingsConflictError';
    this.status = 409;
  }
}

export class SettingsInvalidError extends Error {
  constructor(errors) {
    super(errors.join(' '));
    this.name = 'SettingsInvalidError';
    this.status = 400;
    this.errors = errors;
  }
}

const ID = 'main';

/**
 * The effective settings (defaults, then the admin's saved overrides), cached for a few seconds so a request costs no database
 * read. A save by this process is visible at once; another instance sees it within `cacheMs`.
 */
export class AuthSettings {
  #db;
  #now;
  #cacheMs;
  #cached = null;

  #base;

  /**
   * @param {object} options
   * @param {ReturnType<typeof import('./db.js').createAuthDb>} options.db
   * @param {() => Record<string, any>} [options.base] starting values that replace the built-in defaults for some settings (what .env says), read every time
   */
  constructor({ db, now = Date.now, cacheMs = 5000, base = () => ({}) }) {
    this.#db = db;
    this.#now = now;
    this.#cacheMs = cacheMs;
    this.#base = base;
  }

  async #load() {
    const col = await this.#db.col('settings');
    const doc = await col.findOne({ _id: ID });
    let overrides = {};
    try {
      overrides = doc ? JSON.parse(doc.valuesJson) : {};
    } catch {
      overrides = {};
    }
    // a stored value that no longer passes its rule (a bound was tightened in a new version) is ignored, never used
    const valid = {};
    for (const [key, raw] of Object.entries(overrides)) {
      const setting = BY_KEY.get(key);
      const checked = setting && checkValue(setting, raw);
      if (checked?.ok) valid[key] = checked.value;
    }
    if (checkTogether({ ...DEFAULTS, ...valid })) {
      delete valid['session.idleDays'];
      delete valid['session.maxDays'];
    }
    const starts = { ...DEFAULTS, ...this.#base() };
    return { values: { ...starts, ...valid }, starts, overrides: valid, version: doc?.version ?? 0, updatedAt: doc?.updatedAt ?? null };
  }

  async #state() {
    const now = this.#now();
    if (!this.#cached || now - this.#cached.at > this.#cacheMs) this.#cached = { at: now, ...(await this.#load()) };
    return this.#cached;
  }

  /** The settings as a nested, frozen object: `(await settings.get()).otp.ttlMinutes`. */
  async get() {
    const state = await this.#state();
    state.nested ??= Object.freeze(nest(state.values));
    return state.nested;
  }

  /** Everything an admin screen needs. */
  async describe() {
    const state = await this.#state();
    return { values: { ...state.values }, defaults: { ...state.starts }, changed: Object.keys(state.overrides), version: state.version, updatedAt: state.updatedAt, schema: describeSchema() };
  }

  /**
   * Save a patch. `null` puts a setting back to its default. Rejects with SettingsInvalidError (nothing saved) or
   * SettingsConflictError (somebody else saved first).
   */
  async update(patch) {
    const checked = checkPatch(patch);
    if (!checked.ok) throw new SettingsInvalidError(checked.errors);
    this.#cached = null;
    const state = await this.#state();
    const overrides = { ...state.overrides, ...checked.set };
    for (const key of checked.reset) delete overrides[key];
    for (const [key, value] of Object.entries(overrides)) if (value === DEFAULTS[key] || JSON.stringify(value) === JSON.stringify(DEFAULTS[key])) delete overrides[key];
    const merged = { ...state.starts, ...overrides };
    const together = checkTogether(merged);
    if (together) throw new SettingsInvalidError([together]);

    const col = await this.#db.col('settings');
    const next = { valuesJson: JSON.stringify(overrides), version: state.version + 1, updatedAt: this.#now() };
    if (state.version === 0) {
      try {
        await col.insertOne({ _id: ID, ...next });
      } catch (error) {
        if (isDuplicateKey(error)) throw new SettingsConflictError();
        throw error;
      }
    } else {
      const won = await findAndUpdate(col, { _id: ID, version: state.version }, { $set: next }, { returnDocument: 'after' });
      if (!won) throw new SettingsConflictError();
    }
    this.#cached = null;
    return this.describe();
  }

  /**
   * The values the admin has saved (and only those), read at once from the last load and never waiting for the database: for code that
   * cannot be asynchronous, such as the rate limit in front of the studio. It refreshes itself in the background every few seconds.
   * Before the first load it is empty (the caller then uses .env).
   */
  saved() {
    if (!this.#cached || this.#now() - this.#cached.at > this.#cacheMs) this.#state().catch(() => {});
    return this.#cached?.overrides ?? {};
  }

  forget() {
    this.#cached = null;
  }
}
