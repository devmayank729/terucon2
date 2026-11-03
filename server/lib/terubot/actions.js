/**
 * The actions TeruBot may hand to the browser, and the one place that decides whether an action is allowed.
 *
 * An action is an instruction the visitor's browser carries out (go to a page, put something in the cart, fill the enquiry form). It is
 * never trusted because a model produced it: every action a tool builds, and every action in the final answer, goes through
 * `sanitizeAction`, which rebuilds it from scratch out of validated parts (so an extra key, a hostile string or an unknown id cannot
 * ride along). Nothing here deletes, pays, changes an account or sends a message: that is not in the list, and a type that is not in the
 * list is refused.
 *
 *   {type: 'navigate', to}                    a route of the site map (with an optional short query, or a shop hash): site.js
 *   {type: 'open_studio'}                     the Design Studio
 *   {type: 'cart_add', id, qty}               id: a variant id of the shop; qty: a whole number 1..99
 *   {type: 'saved_add', id, pid}              id: a variant id; pid: its product id (the shop keeps its saved list by product)
 *   {type: 'saved_remove', id, pid}
 *   {type: 'prefill_enquiry', fields}         the enquiry form's fields, each empty or a valid value; the form's chips only for type/timeline/area
 */
import { checkDestination } from './site.js';

export const MAX_QTY = 99;
/** The keys of `prefill_enquiry.fields`, in the order of the contract. */
export const ENQUIRY_KEYS = ['type', 'name', 'company', 'phone', 'email', 'city', 'area', 'timeline', 'message'];
const MAX_LENGTH = { name: 80, company: 120, phone: 20, email: 120, city: 80, message: 1000 };

/** Caps per reply: a reply that tries to do more than this is cut, not obeyed. */
export const LIMITS = { actions: 8, cartAdds: 5, saves: 5 };

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Free text from a person or a model for a form field: no control or direction-changing characters, no angle brackets, one line of single spaces. */
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Text for the visitor to read (a message): like cleanText but keeps line breaks. */
export function cleanBlock(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, (c) => (c === '\u2028' || c === '\u2029' ? '\n' : ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/** Case, accents and the kind of dash do not matter when a person's words are matched to one of the form's chips. */
export const foldChoice = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/\s*([-/])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** The form's own spelling of a choice, or null. @param {string[]} options */
export function pickChoice(value, options) {
  const wanted = foldChoice(value);
  if (!wanted) return null;
  return options.find((o) => foldChoice(o) === wanted) ?? null;
}

/**
 * Validate the fields of a prefill. Unknown keys are dropped; a value that is not valid is dropped and named in `problems`.
 * @param {unknown} input
 * @param {{types: string[], timelines: string[], areas: string[]}} form the choices the landing page's form offers (server/data/enquiry-form.json)
 * @returns {{fields: Record<string, string>, problems: string[]}}
 */
export function checkEnquiryFields(input, form) {
  const fields = Object.fromEntries(ENQUIRY_KEYS.map((k) => [k, '']));
  const problems = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { fields, problems: ['fields must be an object'] };
  for (const key of ENQUIRY_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string') {
      problems.push(`${key}: must be text`);
      continue;
    }
    if (key === 'type' || key === 'timeline' || key === 'area') {
      const options = { type: form.types, timeline: form.timelines, area: form.areas }[key];
      const picked = pickChoice(raw, options);
      if (picked) fields[key] = picked;
      else problems.push(`${key}: must be one of ${options.map((o) => `"${o}"`).join(', ')}`);
      continue;
    }
    const text = key === 'message' ? cleanBlock(raw, MAX_LENGTH.message).replace(/[<>]/g, '') : cleanText(raw, MAX_LENGTH[key]);
    if (!text) continue;
    if (key === 'email' && !/^[^\s@"']{1,64}@[^\s@"']{1,255}\.[A-Za-z]{2,24}$/.test(text)) {
      problems.push('email: not a valid e-mail address');
      continue;
    }
    if (key === 'phone') {
      if (!/^[+0-9 ()-]{6,20}$/.test(text) || text.replace(/\D/g, '').length < 6) {
        problems.push('phone: not a valid phone number');
        continue;
      }
    }
    fields[key] = text;
  }
  return { fields, problems };
}

/** A whole number, as a number or as a string of digits; null for anything else. */
export function wholeNumber(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * @typedef {object} Deps
 * @property {*} site the SiteMap
 * @property {import('./shop.js').Shop} shop
 * @property {{types: string[], timelines: string[], areas: string[]}} form
 */

/**
 * Rebuild one action from validated parts, or say why it is refused.
 * @param {unknown} action
 * @param {Deps} deps
 * @returns {{ok: true, action: object} | {ok: false, error: string}}
 */
export function sanitizeAction(action, { site, shop, form }) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return { ok: false, error: 'not an action' };
  switch (action.type) {
    case 'navigate': {
      const checked = checkDestination(action.to, site, { hasProduct: (id) => shop.byProduct.has(id) });
      return checked.ok ? { ok: true, action: { type: 'navigate', to: checked.to } } : { ok: false, error: checked.error };
    }
    case 'open_studio':
      return { ok: true, action: { type: 'open_studio' } };
    case 'cart_add': {
      const found = shop.resolve(action.id);
      if (!found) return { ok: false, error: 'unknown material id' };
      const qty = wholeNumber(action.qty ?? 1);
      if (qty === null || qty < 1 || qty > MAX_QTY) return { ok: false, error: `qty must be a whole number from 1 to ${MAX_QTY}` };
      if (!shop.inStock(found.variant)) return { ok: false, error: 'that variant is out of stock in the shop' };
      return { ok: true, action: { type: 'cart_add', id: found.variant.id, qty } };
    }
    case 'saved_add':
    case 'saved_remove': {
      const found = shop.resolve(action.id ?? action.pid);
      if (!found) return { ok: false, error: 'unknown material id' };
      return { ok: true, action: { type: action.type, id: found.variant.id, pid: found.product.id } };
    }
    case 'prefill_enquiry': {
      const { fields, problems } = checkEnquiryFields(action.fields, form);
      if (!Object.values(fields).some(Boolean)) return { ok: false, error: problems.length ? problems.join('; ') : 'no field to fill' };
      return { ok: true, action: { type: 'prefill_enquiry', fields } };
    }
    default:
      return { ok: false, error: 'that action is not allowed' };
  }
}

/**
 * The final list for a reply: every action re-checked, duplicates removed, the caps applied, at most one move to another page (the
 * first), and several prefills merged into one.
 * @param {unknown[]} actions
 * @param {Deps} deps
 */
export function finalActions(actions, deps) {
  const out = [];
  let moves = 0;
  let adds = 0;
  let saves = 0;
  let prefill = null;
  for (const raw of Array.isArray(actions) ? actions : []) {
    const checked = sanitizeAction(raw, deps);
    if (!checked.ok) continue;
    const a = checked.action;
    if (a.type === 'navigate' || a.type === 'open_studio') {
      if (moves++ >= 1) continue;
    } else if (a.type === 'cart_add') {
      if (adds++ >= LIMITS.cartAdds) continue;
    } else if (a.type === 'saved_add' || a.type === 'saved_remove') {
      if (saves++ >= LIMITS.saves) continue;
    } else if (a.type === 'prefill_enquiry') {
      if (prefill) {
        for (const k of ENQUIRY_KEYS) if (a.fields[k]) prefill.fields[k] = a.fields[k];
        continue;
      }
      prefill = a;
    }
    if (out.some((x) => JSON.stringify(x) === JSON.stringify(a))) continue;
    out.push(a);
    if (out.length >= LIMITS.actions) break;
  }
  // a move to another page goes last, so the browser has done the rest before it leaves
  return [...out.filter((a) => a.type !== 'navigate' && a.type !== 'open_studio'), ...out.filter((a) => a.type === 'navigate' || a.type === 'open_studio')];
}
