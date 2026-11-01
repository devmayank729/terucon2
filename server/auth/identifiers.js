/**
 * What a person types, turned into something the rest of the sign-in code can trust: an e-mail address, a mobile number, a name,
 * a firm. Everything here is pure (no network, no storage) and strict on purpose: an address or number that does not pass is
 * refused, not repaired, because these values end up in e-mails, text messages, the CRM and rate-limit keys.
 *
 * Two keys exist for an e-mail address:
 *   value / key  the address as written, lower-cased and NFC-normalised: what an account is looked up by.
 *   rateKey      the mailbox it really delivers to (plus-tags removed; Gmail's dots ignored): what a limit is counted by, so
 *                a+1@gmail.com, a+2@gmail.com ... cannot be used to send one inbox an unlimited number of codes.
 */
import { domainToASCII } from 'node:url';

// ------------------------------------------------------------------------------------------------------------- e-mail

// The first character must be a letter, digit or underscore: an address that starts with = + - or @ turns into a formula when
// the sales team exports a CRM list to a spreadsheet.
const LOCAL_PART = /^[a-z0-9_][a-z0-9!#$%&'*+/=?^_`{|}~-]*(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
// anything that has no business in an address, and that could break a header, a URL or a log line
const FORBIDDEN_IN_ADDRESS = /[\s<>(),;:\\"[\]\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * @param {unknown} raw
 * @returns {{value: string, local: string, domain: string, rateKey: string} | null} null when it is not a plain address
 */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string' || raw.length > 400) return null;
  const text = raw.normalize('NFKC').trim().toLowerCase();
  if (text.length < 6 || text.length > 254 || FORBIDDEN_IN_ADDRESS.test(text)) return null;
  const at = text.indexOf('@');
  if (at < 1 || at !== text.lastIndexOf('@')) return null;
  const local = text.slice(0, at);
  const domain = domainToASCII(text.slice(at + 1));
  if (local.length > 64 || !LOCAL_PART.test(local)) return null;
  if (!domain || domain.length > 253) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label)) || !TLD.test(labels[labels.length - 1])) return null;
  return { value: `${local}@${domain}`, local, domain, rateKey: emailRateKey(local, domain) };
}

/** The mailbox an address really delivers to. */
export function emailRateKey(local, domain) {
  let box = local.split('+')[0];
  let host = domain;
  if (host === 'gmail.com' || host === 'googlemail.com') {
    box = box.replace(/\./g, '');
    host = 'gmail.com';
  }
  return `${box || local}@${host}`;
}

/** "r•••••@terucon.com": enough for a person to recognise their own address, not enough for anybody else. */
export function maskEmail(email) {
  const at = email.indexOf('@');
  if (at < 1) return '';
  return `${email[0]}•••••${email.slice(at)}`;
}

const FREE_MAIL = new Set(
  (
    'gmail.com googlemail.com yahoo.com yahoo.in yahoo.co.in yahoo.co.uk ymail.com rocketmail.com outlook.com outlook.in hotmail.com hotmail.co.uk ' +
    'live.com live.in msn.com icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me zoho.com zohomail.com zohomail.in gmx.com gmx.net gmx.de ' +
    'mail.com yandex.com yandex.ru rediffmail.com rediff.com fastmail.com tutanota.com tuta.io hey.com qq.com 163.com 126.com naver.com ' +
    'hushmail.com inbox.com lycos.com sify.com in.com email.com mail.ru bk.ru inbox.ru list.ru web.de t-online.de orange.fr free.fr'
  ).split(' '),
);
const FREE_MAIL_FAMILY = /^(?:yahoo|hotmail|outlook|live|msn|gmx)\.[a-z]{2,3}(?:\.[a-z]{2})?$/;

// Throw-away inbox services. Not complete (no list can be): the admin can add more in settings (email.blockedDomains).
const DISPOSABLE = new Set(
  (
    'mailinator.com guerrillamail.com guerrillamail.net guerrillamailblock.com sharklasers.com grr.la 10minutemail.com 10minutemail.net tempmail.com ' +
    'temp-mail.org temp-mail.io tempmail.net tempr.email throwawaymail.com trashmail.com trashmail.net yopmail.com yopmail.net getnada.com ' +
    'dispostable.com maildrop.cc fakeinbox.com mintemail.com mailnesia.com spamgourmet.com emailondeck.com mohmal.com discard.email moakt.com ' +
    'burnermail.io mailtemp.info tmpmail.org tmpmail.net fakemail.net minuteinbox.com spam4.me'
  ).split(' '),
);

/** A mailbox anybody can open for free (gmail.com, outlook.in ...): the domain says nothing about the person's firm. */
export function isFreeMail(domain) {
  return FREE_MAIL.has(domain) || FREE_MAIL_FAMILY.test(domain);
}

export function isDisposable(domain, extra = []) {
  return DISPOSABLE.has(domain) || extra.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}

// ---------------------------------------------------------------------------------------------------------------- phone

/**
 * A mobile number in E.164 ("+919876543210"), or null. Ten digits starting 6-9 (with or without 0 / 91 / +91) are Indian mobiles;
 * any other country needs its "+" code. Letters and stray characters are refused, not stripped.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizePhone(raw) {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  const text = raw.normalize('NFKC').trim();
  if (!text || /[^\d\s().+-]/.test(text)) return null;
  if ((text.match(/\+/g) ?? []).length > 1 || (text.includes('+') && !text.startsWith('+'))) return null;
  const digits = text.replace(/\D/g, '');
  let e164;
  if (text.startsWith('+')) e164 = `+${digits}`;
  else if (digits.startsWith('00')) e164 = `+${digits.slice(2)}`;
  else if (/^[6-9]\d{9}$/.test(digits)) e164 = `+91${digits}`;
  else if (/^0[6-9]\d{9}$/.test(digits)) e164 = `+91${digits.slice(1)}`;
  else if (/^91[6-9]\d{9}$/.test(digits)) e164 = `+${digits}`;
  else return null;
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return null;
  if (e164.startsWith('+91') && !/^\+91[6-9]\d{9}$/.test(e164)) return null;
  return e164;
}

/** "+91 ••••• ••321": the country and the last digits. */
export function maskPhone(e164) {
  if (!/^\+\d{8,15}$/.test(e164)) return '';
  const cc = e164.startsWith('+91') ? '+91' : e164.slice(0, 3);
  return `${cc} ••••• ••${e164.slice(-3)}`;
}

/** Whether the number's country code is on the allowed list (digits only, e.g. ['91']). An empty list allows nobody. */
export function phoneCountryAllowed(e164, allowedCodes) {
  return allowedCodes.some((code) => e164.startsWith(`+${code}`));
}

// ------------------------------------------------------------------------------------------------------- the identifier

/**
 * The one box on the sign-in page takes an e-mail address or a mobile number; this tells which it is and normalises it.
 * @param {unknown} raw
 * @returns {{kind: 'email', value: string, key: string, rateKey: string, domain: string} | {kind: 'phone', value: string, key: string, rateKey: string} | {error: 'invalid-email' | 'invalid-phone' | 'empty'}}
 */
export function classifyIdentifier(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'empty' };
  if (raw.includes('@')) {
    const email = normalizeEmail(raw);
    return email ? { kind: 'email', value: email.value, key: email.value, rateKey: email.rateKey, domain: email.domain } : { error: 'invalid-email' };
  }
  const phone = normalizePhone(raw);
  return phone ? { kind: 'phone', value: phone, key: phone, rateKey: phone } : { error: 'invalid-phone' };
}

// ----------------------------------------------------------------------------------------------------- names and firms

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu; // control, format (zero-width, direction marks, BOM) and line/paragraph separators

function tidy(raw, max) {
  if (typeof raw !== 'string' || raw.length > max * 4) return null;
  // a control character (NUL, escape ...) is refused; the zero-width and direction marks that hide inside text are swapped for a space
  if (/\p{Cc}/u.test(raw.replace(/[\t\n\r]/g, ' '))) return null;
  const text = raw.normalize('NFKC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return text.length >= 1 && text.length <= max ? text : null;
}

/** A person's name: letters in any script, marks, digits, spaces and . , ' ’ - ( ). Null otherwise. */
export function cleanName(raw) {
  const text = tidy(raw, 80);
  if (!text || !/\p{L}/u.test(text) || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,'’()-]*$/u.test(text)) return null; // starts with a letter or digit (see LOCAL_PART)
  return text;
}

/** A firm's name: a little more punctuation than a person's (& / + @ #), never markup or a link. */
export function cleanFirm(raw) {
  const text = tidy(raw, 100);
  if (!text || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,'’&()/+@#-]*$/u.test(text)) return null; // starts with a letter or digit (see LOCAL_PART)
  if (/\bwww\./i.test(text) || /\/\//.test(text)) return null; // a link is not a firm name (":" is not allowed, so "https:" never gets here)
  return text;
}

/** "Rahul Kumar Sharma" -> {first: 'Rahul Kumar', last: 'Sharma'}; a single word is only a last name (Zoho needs a last name). */
export function splitName(name) {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return { first: '', last: words[0] };
  return { first: words.slice(0, -1).join(' '), last: words[words.length - 1] };
}

// ------------------------------------------------------------------------------------------------------ firm from domain

// second-level labels that are part of the public suffix (terucon.co.in -> "terucon", not "co")
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'firm', 'gen', 'ind', 'nic', 'res', 'ltd', 'plc', 'biz']);

/**
 * A guess at a firm's name from the domain of a business e-mail address: "mail.ab-constructions.co.in" -> "Ab Constructions".
 * It is a suggestion the person can edit, never a fact; null for a free mailbox, a throw-away domain or an address with no name in it.
 * @param {string} domain lower-case, ASCII
 */
export function firmFromDomain(domain, extraBlocked = []) {
  if (!domain || isFreeMail(domain) || isDisposable(domain, extraBlocked)) return null;
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  let rest = labels.slice(0, -1);
  // "co" in "terucon.co.in" is part of the public suffix, but only under a two-letter country code: "firm.example" is a firm called Firm
  if (labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(rest[rest.length - 1])) rest = rest.slice(0, -1); // for "co.in" nothing is left
  if (!rest.length) return null;
  const label = rest[rest.length - 1];
  if (!label || label.startsWith('xn--') || /^\d+$/.test(label)) return null;
  const words = label.split(/[-_]+/).filter(Boolean);
  if (!words.length) return null;
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

/** Letters and digits only, lower-case: how two spellings of a name are compared. */
export const squash = (text) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
