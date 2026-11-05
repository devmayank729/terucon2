/**
 * Everything a stranger's phone can send us, checked here and nowhere else. The phone page is untrusted: a value that is not
 * exactly what it should be is refused (or cut to size), never passed on. All text is stored and sent as plain text; the pages
 * show it with textContent, so nothing here has to be "escaped for HTML", but control characters and look-alike line breaks go,
 * because the same text is put into a WhatsApp message where a new line or a tab is not allowed in a variable.
 */

export const SERVICES = ['studio', 'inspiration', 'finder'];
export const SERVICE_LABELS = { studio: 'Design Studio', inspiration: 'Inspiration', finder: 'Finder' };

export class CaptureError extends Error {
  /** @param {number} status @param {string} reason a short slug the pages act on @param {string} message plain language @param {{retryAfter?: number}} [extra] */
  constructor(status, reason, message, { retryAfter } = {}) {
    super(message);
    this.name = 'CaptureError';
    this.status = status;
    this.reason = reason;
    if (retryAfter) this.retryAfter = Math.max(1, Math.ceil(retryAfter));
  }
}

const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'gu');

/** A one-line piece of text of at most `max` characters, or '' (not a string counts as ''). */
export function cleanLine(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.normalize('NFC').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return [...text].slice(0, max).join('').trim();
}

export function cleanName(value) {
  const text = cleanLine(value, 80);
  if ([...text].length < 2 || !/\p{L}/u.test(text)) throw new CaptureError(400, 'bad-name', 'Please enter your name (at least two letters).');
  return text;
}

/** Digits of a phone number, with the country code. '98765 43210' -> '919876543210' (default 91); '+44 20 7946 0958' -> '442079460958'. null when it cannot be a number. */
export function normalizePhone(value, defaultCountryCode = '91') {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!text || text.length > 40 || /[^\d\s+().-]/.test(text)) return null;
  const plus = text.startsWith('+');
  let digits = text.replace(/\D/g, '');
  if (!digits) return null;
  if (!plus) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0')) digits = defaultCountryCode + digits.slice(1);
    else if (digits.length <= 10) digits = defaultCountryCode + digits;
  }
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) return null;
  return digits;
}

/** An optional phone number for the capturer's details: '' (none) or '+<digits>'. */
export function cleanPhone(value, defaultCountryCode) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return '';
  const digits = normalizePhone(value, defaultCountryCode);
  if (!digits) throw new CaptureError(400, 'bad-phone', 'That phone number does not look right. Enter it with the country code, for example +91 98765 43210.');
  return `+${digits}`;
}

const TAG = /^[\p{L}\p{N}][\p{L}\p{N} &/._-]{0,29}$/u;

/** Up to 8 short labels such as "room" or "cabin". Anything that is not a label is dropped, repeats too. */
export function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value.slice(0, 20)) {
    const tag = cleanLine(item, 30);
    if (!TAG.test(tag) || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length === 8) break;
  }
  return out;
}

/** The place a phone says it is at. Only a number inside the real ranges, taken not long ago. */
export function cleanLocation(value, now = Date.now()) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new CaptureError(400, 'bad-location', 'The location was not understood.');
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  const accuracy = value.accuracy === undefined || value.accuracy === null ? null : Number(value.accuracy);
  const at = Number(value.at);
  const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (accuracy === null || (Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 1_000_000)) && Number.isFinite(at);
  if (!ok) throw new CaptureError(400, 'bad-location', 'The location was not understood.');
  if (at > now + 5 * 60_000 || at < now - 24 * 3_600_000) throw new CaptureError(400, 'stale-location', 'That location is out of date. Tap the location button again.');
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, accuracy: accuracy === null ? null : Math.round(accuracy), at: Math.round(at) };
}

/** The details of the person taking the photos. Name is required; the rest may be empty. */
export function cleanCapturer(input, { defaultCountryCode, now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CaptureError(400, 'bad-details', 'Your details were not understood.');
  return {
    name: cleanName(input.name),
    phone: cleanPhone(input.phone, defaultCountryCode),
    address: cleanLine(input.address, 300),
    place: cleanLine(input.place, 120),
    location: cleanLocation(input.location, now),
  };
}

/** What the phone says about one photo: {tags, note}. Bad input is dropped, not refused: the photo itself matters more. */
export function cleanPhotoMeta(raw) {
  let meta = {};
  if (typeof raw === 'string' && raw) {
    if (raw.length > 2000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) throw new CaptureError(400, 'bad-meta', 'The photo details were not understood.');
    try {
      meta = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      throw new CaptureError(400, 'bad-meta', 'The photo details were not understood.');
    }
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
  return { tags: cleanTags(meta.tags), note: cleanLine(meta.note, 200) };
}

export const ID_32 = /^[a-f0-9]{32}$/;
export const PHOTO_ID = /^[a-f0-9]{32}_[a-f0-9]{32}$/;
export const TOKEN = /^[A-Za-z0-9_-]{32}$/;

/** A name of a person as shown in a message (first word only, so a message never carries more of a name than needed). */
export function firstName(value) {
  const text = cleanLine(value, 80);
  return text.split(' ')[0] || '';
}
