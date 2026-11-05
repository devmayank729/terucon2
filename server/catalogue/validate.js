/**
 * Everything the catalogue search accepts from the outside is judged here, by strict patterns and by the bytes themselves: search
 * parameters, a text query, a query photo, and what an admin may change on an item. Nothing in the other modules trusts a string
 * that did not come through this file (or through a pattern from it).
 *
 * A bad value is a CatalogueError with status 400 and reason `bad-request` (or `bad-image` / `too-large` for a photo); the message
 * names the thing that was wrong and never repeats more than a few characters of what was sent.
 */
import { sniffImage } from '../lib/inspiration/imageBytes.js';
import { MAX_PHOTO_BYTES } from './config.js';
import { CatalogueError } from './errors.js';

export const SLUG = /^[a-z0-9][a-z0-9-]{1,38}$/;
export const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const RELEASE_ID = /^rel-\d{14}-[0-9a-f]{6}$/;
export const JOB_ID = /^job-\d{14}-[0-9a-f]{6}$/;
export const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,39}$/;
export const HEX_COLOUR = /^#?[0-9a-fA-F]{6}$/;
export const PHOTO_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
export const CATALOGUE_KINDS = Object.freeze(['materials', 'paint', 'exterior', 'other']);

export const K_DEFAULT = 8;
export const K_MAX = 20;
/** A query photo is at most this many pixels, whatever its bytes. The browser sends at most 1024 on the long side. */
export const MAX_PIXELS = 25_000_000;
export const MAX_SIDE = 10_000;
export const TEXT_MAX = 300;

const FILTER_WORD = /^[A-Za-z0-9][A-Za-z0-9 _&/.+-]{0,39}$/;
const UNIT = /^(?:\d+\.?\d*|\.\d+)$/;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const ATTRIBUTE_KEY = /^[A-Za-z][A-Za-z0-9_ -]{0,39}$/;
const FORBIDDEN_KEYS = new Set(['constructor', 'prototype', 'proto']);

export const bad = (message, reason = 'bad-request', status = 400) => new CatalogueError(status, reason, message);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One query value that must be a single, non-empty string (Express gives an array for `?k=1&k=2`). */
function single(query, name) {
  const value = query?.[name];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw bad(`"${name}" must be given once.`);
  return value;
}

const unit = (text) => {
  if (!UNIT.test(text)) return null;
  const n = Number(text);
  return n >= 0 && n <= 1 ? Number(n.toFixed(6)) : null;
};

/** A list such as "wood, stone" or ["wood", "stone"]: at most 8 words of letters, digits and a few signs. */
function wordList(raw, name) {
  if (raw === undefined || raw === null || raw === '') return [];
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
  if (!parts) throw bad(`"${name}" must be a list of words.`);
  const words = [];
  for (const part of parts) {
    if (typeof part !== 'string') throw bad(`"${name}" must be a list of words.`);
    const word = part.trim().replace(/\s+/g, ' ');
    if (!word) continue;
    if (!FILTER_WORD.test(word)) throw bad(`"${name}" has a word that is not allowed.`);
    if (!words.includes(word)) words.push(word);
  }
  if (words.length > 8) throw bad(`"${name}" can have at most 8 words.`);
  return words;
}

function kOf(raw, fromQuery) {
  if (raw === undefined) return K_DEFAULT;
  const n = fromQuery ? (/^\d{1,3}$/.test(raw) ? Number(raw) : NaN) : raw;
  if (!Number.isInteger(n) || n < 1 || n > K_MAX) throw bad(`"k" must be a whole number from 1 to ${K_MAX}.`);
  return n;
}

function slugOf(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !SLUG.test(raw)) throw bad('"catalogue" is not a catalogue name.');
  return raw;
}

/**
 * The query string of POST /api/catalogue/search. Unknown names are ignored (never forwarded).
 * `patch=1` (or true) says the photo is already a patch somebody cut out of a bigger picture (the Finder and the shop do that for a tapped surface):
 * it is then searched exactly as it is, the way a `box` of the whole picture is, instead of the whole-photo path that looks for a card and
 * otherwise crops 20 % off every edge (catalogue/ARCHITECTURE.md section 5.1). `patch=0` is the same as leaving it out.
 * @returns {{catalogue?: string, mode: 'look' | 'colour', k: number, point?: [number, number], radius?: number, box?: number[], patch?: boolean, category: string[], finish: string[]}}
 */
export function parseSearchParams(query) {
  const out = { catalogue: slugOf(single(query, 'catalogue')), mode: 'look', k: kOf(single(query, 'k'), true), category: [], finish: [] };
  const mode = single(query, 'mode');
  if (mode !== undefined) {
    if (mode !== 'look' && mode !== 'colour') throw bad('"mode" must be look or colour.');
    out.mode = mode;
  }
  const point = single(query, 'point');
  const radius = single(query, 'radius');
  const box = single(query, 'box');
  if (point !== undefined && box !== undefined) throw bad('Send "point" or "box", not both.');
  if (radius !== undefined && point === undefined) throw bad('"radius" goes with "point".');
  if (point !== undefined) {
    const parts = point.split(',');
    const [x, y] = parts.map(unit);
    if (parts.length !== 2 || x === null || y === null) throw bad('"point" must be x,y with both between 0 and 1.');
    out.point = [x, y];
  }
  if (radius !== undefined) {
    const r = UNIT.test(radius) ? Number(Number(radius).toFixed(6)) : NaN;
    if (!(r > 0 && r <= 0.5)) throw bad('"radius" must be more than 0 and at most 0.5.');
    out.radius = r;
  }
  if (box !== undefined) {
    const parts = box.split(',');
    const [x0, y0, x1, y1] = parts.map(unit);
    if (parts.length !== 4 || [x0, y0, x1, y1].includes(null) || x1 - x0 < 0.01 || y1 - y0 < 0.01) throw bad('"box" must be x0,y0,x1,y1 between 0 and 1, with x1 > x0 and y1 > y0.');
    out.box = [x0, y0, x1, y1];
  }
  const patch = single(query, 'patch');
  if (patch !== undefined) {
    const v = patch.toLowerCase();
    if (v !== '1' && v !== '0' && v !== 'true' && v !== 'false') throw bad('"patch" must be 1 or 0.');
    out.patch = v === '1' || v === 'true';
    if (out.patch && (point !== undefined || box !== undefined)) throw bad('"patch" goes with a photo that has no "point" or "box".');
  }
  out.category = wordList(single(query, 'category'), 'category');
  out.finish = wordList(single(query, 'finish'), 'finish');
  return out;
}

/** The body of POST /api/catalogue/search-text. */
export function parseTextBody(body) {
  if (!isPlainObject(body)) throw bad('Send {"text": "what you are looking for"}.');
  if (typeof body.text !== 'string' || body.text.length > 4000) throw bad('"text" must be what you are looking for, in words.');
  const text = body.text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw bad('"text" is empty.');
  if (text.length > TEXT_MAX) throw bad(`"text" can be at most ${TEXT_MAX} characters.`);
  return {
    text,
    catalogue: body.catalogue === undefined || body.catalogue === null ? undefined : slugOf(body.catalogue),
    k: kOf(body.k === null ? undefined : body.k, false),
    category: wordList(body.category, 'category'),
    finish: wordList(body.finish, 'finish'),
  };
}

/** "image/jpeg; charset=x" -> "image/jpeg" */
export const baseType = (header) => String(header ?? '').split(';')[0].trim().toLowerCase();

/** Whether the end of the file is where its format says the end is: a quick way to refuse a photo that was cut off on the way. */
function endsProperly(type, b) {
  if (type === 'image/jpeg') {
    let end = b.length;
    while (end > 2 && b[end - 1] === 0) end -= 1;
    return b[end - 2] === 0xff && b[end - 1] === 0xd9;
  }
  if (type === 'image/png') return b.subarray(Math.max(0, b.length - 32)).includes('IEND', 0, 'latin1');
  if (type === 'image/webp') return b.readUInt32LE(4) + 8 <= b.length;
  return false;
}

/**
 * Decide from the bytes alone whether a body is a photo we will send on: JPEG, PNG or WebP (not GIF or AVIF), the type the request
 * said, a size we could read in its header and can afford, and not cut off. Done before Modal is asked anything, so garbage never
 * costs a GPU call.
 * @param {Buffer} bytes
 * @param {string} declaredType the request's Content-Type (without parameters)
 */
export function judgePhoto(bytes, declaredType, { maxBytes = MAX_PHOTO_BYTES } = {}) {
  if (!bytes.length) throw bad('The photo is empty.', 'bad-image');
  if (bytes.length > maxBytes) throw bad(`The photo is too large (at most ${Math.floor(maxBytes / 1024 / 1024)} MB).`, 'too-large', 413);
  const found = sniffImage(bytes);
  if (!found || !PHOTO_TYPES.includes(found.type)) throw bad('That is not a JPEG, PNG or WebP photo.', 'bad-image');
  if (found.type !== declaredType) throw bad('The photo is not the type it was sent as.', 'bad-image');
  if (!found.width || !found.height) throw bad('We could not read the size of that photo.', 'bad-image');
  if (found.width > MAX_SIDE || found.height > MAX_SIDE || found.width * found.height > MAX_PIXELS) throw bad('That photo has too many pixels. Please send a smaller one.', 'too-large', 413);
  if (!endsProperly(found.type, bytes)) throw bad('That photo looks cut off. Please try again.', 'bad-image');
  return { type: found.type, width: found.width, height: found.height };
}

// ------------------------------------------------------------------------------------------------------------ admin

/** One line of plain text: no control characters, trimmed; null when blank. */
export function plainLine(value, max, what) {
  if (typeof value !== 'string') throw bad(`${what} must be text.`);
  const text = value.trim();
  if (CONTROL.test(text)) throw bad(`${what} can only have plain text.`);
  if (text.length > max) throw bad(`${what} can be at most ${max} characters.`);
  return text || null;
}

/** The slug of a new catalogue, its name, kind and note. */
export function parseNewCatalogue(body) {
  if (!isPlainObject(body)) throw bad('Send {id, name, kind, note?}.');
  if (typeof body.id !== 'string' || !SLUG.test(body.id)) throw bad('"id" must be 2 to 39 lower-case letters, digits or dashes, starting with a letter or digit.');
  const name = plainLine(body.name, 80, '"name"');
  if (!name) throw bad('"name" is needed.');
  if (!CATALOGUE_KINDS.includes(body.kind)) throw bad(`"kind" must be one of ${CATALOGUE_KINDS.join(', ')}.`);
  const note = body.note === undefined || body.note === null ? null : plainLine(body.note, 300, '"note"');
  return { id: body.id, name, kind: body.kind, note };
}

/**
 * What an admin may change on one item. Returns only the fields present:
 *   {label?: string | null, productId?: string | null, status?: 'ok' | 'hidden', attributes?: object}
 */
export function parseItemPatch(body) {
  if (!isPlainObject(body)) throw bad('Send {label?, productId?, status?, attributes?}.');
  const out = {};
  for (const name of Object.keys(body)) {
    if (!['label', 'productId', 'status', 'attributes'].includes(name)) throw bad(`"${name.slice(0, 30)}" cannot be changed here.`);
  }
  if ('label' in body) out.label = body.label === null ? null : plainLine(body.label, 120, '"label"');
  if ('productId' in body) {
    if (body.productId === null || body.productId === '') out.productId = null;
    else if (typeof body.productId === 'string' && PRODUCT_ID.test(body.productId.trim())) out.productId = body.productId.trim();
    else throw bad('"productId" must be 1 to 40 letters, digits, spaces, dots, dashes, slashes or underscores, starting with a letter or digit.');
  }
  if ('status' in body) {
    if (body.status !== 'ok' && body.status !== 'hidden') throw bad('"status" must be ok or hidden.');
    out.status = body.status;
  }
  if ('attributes' in body) {
    if (!isPlainObject(body.attributes)) throw bad('"attributes" must be an object.');
    const entries = Object.entries(body.attributes);
    if (entries.length > 20) throw bad('"attributes" can have at most 20 entries.');
    const attributes = {};
    for (const [key, value] of entries) {
      if (!ATTRIBUTE_KEY.test(key) || FORBIDDEN_KEYS.has(key.toLowerCase())) throw bad(`An attribute name is not allowed: "${key.slice(0, 20)}".`);
      if (typeof value === 'string') {
        if (value.length > 200 || CONTROL.test(value)) throw bad(`The attribute "${key}" must be plain text of at most 200 characters.`);
        attributes[key] = value;
      } else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' || value === null) attributes[key] = value;
      else throw bad(`The attribute "${key}" must be text, a number, true, false or null.`);
    }
    out.attributes = attributes;
  }
  if (!Object.keys(out).length) throw bad('Nothing to change.');
  return out;
}

/** A name for a file that is safe in an object key: no path, no odd characters. Returns the stem and the extension separately. */
export function safeNameParts(raw) {
  const name = String(raw ?? '').normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC').split(/[\\/]/).pop().replace(/[\p{Cc}\p{Cf}]/gu, '');
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').replace(/_{2,}/g, '_').slice(0, 80).replace(/[._-]+$/, '');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) : '';
  return { stem: stem || 'file', ext };
}

/** An id like job-20261101123045-a1b2c3 or rel-...: the time (UTC) as 14 digits, then `hex` (6 hex characters). */
export function stampedId(prefix, nowMs, hex) {
  const t = new Date(nowMs).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${prefix}-${t}-${hex}`;
}
