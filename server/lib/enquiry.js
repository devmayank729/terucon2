/**
 * "Start a project": what a visitor may send, how it is checked, and where it is kept.
 *
 * The form is the one the landing page always had (what is planned, where, how big, when, how to reach the person), now a page of its
 * own (pages/start-project.html) and a real route (server/routes/enquiry.js). An enquiry is kept in the account database's
 * `enquiries` collection (MongoDB when the studio's database is connected, in memory otherwise: a restart loses those).
 *
 * It does NOT reach Zoho yet: the CRM queue (server/auth/crm.js) is keyed to accounts and an enquiry may come from somebody with no
 * account. Until that is built the admin reads enquiries through GET /api/auth/admin/enquiries.
 *
 * Nothing here trusts the browser: every field is read by name, cut to a length, and the three that offer a fixed list (type, area,
 * timeline) must be one of the values the form offers (the same values as the landing page's chips and drop-down).
 */
import { randomBytes } from 'node:crypto';

/** The values the form offers, in the order it shows them. The landing page's own form uses the same words. */
export const ENQUIRY_TYPES = ['Façade / elevation', 'Office interior', 'Materials supply', 'Turnkey build'];
export const ENQUIRY_TIMELINES = ['Within 3 months', '3–6 months', 'Later this year', 'Just exploring'];
export const ENQUIRY_AREAS = ['Under 2,000 sq ft', '2,000 – 10,000 sq ft', '10,000 – 50,000 sq ft', '50,000+ sq ft', 'Façade only / not sure'];

/** The landing page's old chips sent "Later" and "Exploring" as their values; they mean the last two of the list above. */
const TIMELINE_ALIASES = new Map([
  ['Later', 'Later this year'],
  ['Exploring', 'Just exploring'],
]);

const LIMITS = { name: 120, company: 160, phone: 32, email: 254, city: 120, message: 2000 };

/** One-line text: control characters become spaces, runs of white space shrink to one, the ends are trimmed. */
function line(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Free text: line breaks stay (at most two in a row), other control characters go. */
function paragraph(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:".]{2,}$/;

/** A phone number as people type it: digits with spaces, dashes, brackets and a leading +. Needs 7 to 15 digits. */
function phoneOf(value) {
  const text = line(value, LIMITS.phone);
  if (!text) return { value: '', ok: true };
  if (!/^[+\d(][\d\s().-]*$/.test(text)) return { value: text, ok: false };
  const digits = text.replace(/\D/g, '');
  return { value: text, ok: digits.length >= 7 && digits.length <= 15 };
}

function oneOf(value, list, aliases) {
  const text = line(value, 80);
  if (!text) return '';
  const mapped = aliases?.get(text) ?? text;
  return list.includes(mapped) ? mapped : null;
}

/**
 * Read one enquiry out of a JSON body.
 * @param {unknown} body
 * @returns {{ok: true, enquiry: object} | {ok: false, field: string, message: string}}
 */
export function readEnquiry(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const name = line(input.name, LIMITS.name);
  const email = line(input.email, LIMITS.email);
  const phone = phoneOf(input.phone);
  const type = oneOf(input.type, ENQUIRY_TYPES);
  const area = oneOf(input.area, ENQUIRY_AREAS);
  const timeline = oneOf(input.timeline, ENQUIRY_TIMELINES, TIMELINE_ALIASES);
  if (type === null) return { ok: false, field: 'type', message: 'Please choose one of the project types shown.' };
  if (area === null) return { ok: false, field: 'area', message: 'Please choose one of the sizes shown.' };
  if (timeline === null) return { ok: false, field: 'timeline', message: 'Please choose one of the timelines shown.' };
  if (!name) return { ok: false, field: 'name', message: 'Please add your name.' };
  if (!phone.value && !email) return { ok: false, field: 'phone', message: 'Please add a phone number or an e-mail address so we can reach you.' };
  if (!phone.ok) return { ok: false, field: 'phone', message: 'That phone number does not look right. Use digits, with the country code if it is not in India.' };
  if (email && !EMAIL.test(email)) return { ok: false, field: 'email', message: 'That e-mail address does not look right.' };
  return {
    ok: true,
    // where the form was: the page's own form or the landing page's (a fixed list, never the visitor's own words)
    source: input.source === 'landing' ? 'landing' : 'start-project',
    enquiry: {
      type,
      name,
      company: line(input.company, LIMITS.company),
      phone: phone.value,
      email,
      city: line(input.city, LIMITS.city),
      area,
      timeline,
      message: paragraph(input.message, LIMITS.message),
    },
  };
}

/** A short reference the visitor can quote on the phone: TR-, then six characters without look-alikes (no 0/O, 1/I). */
export function newReference() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  return 'TR-' + [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/**
 * The store behind the route.
 * @param {{db: {col: (name: string) => Promise<any>}, now?: () => number, log?: {info: Function}}} options
 */
export function createEnquiryStore({ db, now = Date.now, log }) {
  return {
    /**
     * Keep one enquiry. `ownerId` is the signed-in account's owner id when the visitor was signed in (so it can be matched to the
     * account later), otherwise null. Retries with a new reference in the (very unlikely) case two are the same.
     */
    async add(enquiry, { ownerId = null, source = 'start-project' } = {}) {
      const col = await db.col('enquiries');
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const reference = newReference();
        try {
          await col.insertOne({ _id: reference, createdAt: now(), status: 'new', source, ownerId, ...enquiry });
          log?.info(`enquiry ${reference} kept (${enquiry.type || 'no type'}, ${enquiry.phone ? 'phone' : ''}${enquiry.phone && enquiry.email ? '+' : ''}${enquiry.email ? 'e-mail' : ''})`);
          return reference;
        } catch (error) {
          if (error?.code !== 11000) throw error;
        }
      }
      throw new Error('could not make a unique enquiry reference');
    },

    /** Newest first. `before` is a time in ms: only older ones. */
    async recent({ limit = 50, before } = {}) {
      const col = await db.col('enquiries');
      const filter = before ? { createdAt: { $lt: before } } : {};
      return col.find(filter).sort({ createdAt: -1 }).limit(Math.min(Math.max(1, limit), 200)).toArray();
    },
  };
}
