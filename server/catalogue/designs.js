/**
 * The designs of the live catalogue as products, with their pictures (targets A1, C1, C4, C5).
 *
 * Everything here comes from the catalogue's own storage and nothing is kept on this server's disk:
 *   - the DATA from MongoDB: the items of every live catalogue that carries a product id (TIPL-SB804), grouped by that id (a design printed on two
 *     pages is one product), with the name, the dominant colour, the page numbers, and, when they exist, the two fields this file reads and the
 *     catalogue engine never writes (so a re-ingest of the PDF cannot wipe them, catalogue/terucon_catalogue/mongo.py PUBLISHER_OWNED):
 *       shopImage   {key, width, height, bytes, sha256}   a 800 px wide picture of the design, an object of the bucket (tools/publish-shop-images.js)
 *       studio      {look, colours, pattern, grain, scale, sheen, relief, render, model, generatedAt}   what Gemini saw in that picture
 *                   (tools/describe-designs.js), appearance only, never a specification
 *   - the PICTURES from Google Cloud Storage: signed with the catalogue's own key (server/catalogue/gcsSigner.js), fetched when somebody asks, kept
 *     in memory only (a few MB in all: 68 thumbnails of 35-50 KB and 63 pictures of about 130 KB), never written to disk.
 *
 * Nothing here is a price, a size or a specification: those are the shop's (server/lib/shopLink.js) and are samples until the price list is loaded.
 */
import crypto from 'node:crypto';
import { isStoreDown } from './db.js';
import { isSafeKey } from './gcsSigner.js';

/** A catalogue product id: TIPL-SB804, TIPL-CMT6001. The same rule as server/lib/shopLink.js. */
export const PRODUCT_ID = /^TIPL-[A-Z]{2,4}\d{2,5}$/;
/** The shop's slug of a product id: tipl-sb804. */
export const slugOf = (productId) => String(productId).toLowerCase();
export const SLUG = /^tipl-[a-z]{2,4}\d{2,5}$/;

/** The object keys this module will fetch: the engine's thumbnails and the shop pictures. (The 2 MB crops are never served to a page.) */
const READ_PREFIXES = ['thumbs/', 'cards/'];
const LIST_TTL_MS = 60 * 1000;
const FAIL_TTL_MS = 5 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const CACHE_BYTES = 32 * 1024 * 1024;
const MISS_TTL_MS = 10 * 1000;

const SHEENS = ['matte', 'satin', 'semi-gloss', 'gloss', 'metallic'];
const GRAINS = ['none', 'vertical', 'horizontal', 'diagonal', 'random'];
const SCALES = ['fine', 'medium', 'large'];
const RELIEFS = ['flat', 'fine texture', 'pronounced texture', 'embossed'];
export const STUDIO_ENUMS = Object.freeze({ sheen: SHEENS, grain: GRAINS, scale: SCALES, relief: RELIEFS });

const HEX = /^#[0-9a-fA-F]{6}$/;
const clean = (value, max) => (typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const oneOf = (value, list) => (typeof value === 'string' && list.includes(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null);

/** 'EMPERADOR DARK' -> 'Emperador Dark' (words of one or two letters stay as printed). The same rule as tools/build-shop-catalogue.js. */
export function displayName(printed) {
  return String(printed ?? '').split(/\s+/).filter(Boolean).map((w) => (w.length <= 2 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase())).join(' ');
}

/**
 * What Gemini wrote about a design, checked field by field. Returns null unless every field a reader needs is present and sane: a half-filled
 * record is not shown (the design then has only its name, code and picture). Text is plain text, length-capped, never HTML.
 */
export function readStudio(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const look = clean(raw.look, 320);
  const render = clean(raw.render, 700);
  const pattern = clean(raw.pattern, 60);
  const sheen = oneOf(raw.sheen, SHEENS);
  const grain = oneOf(raw.grain, GRAINS);
  const scale = oneOf(raw.scale, SCALES);
  const relief = oneOf(raw.relief, RELIEFS);
  const colours = (Array.isArray(raw.colours) ? raw.colours : []).map((c) => clean(c, 30)).filter(Boolean).slice(0, 4);
  if (!look || !render || !pattern || !sheen || !grain || !scale || !relief || !colours.length) return null;
  return { look, render, pattern, sheen, grain, scale, relief, colours, model: clean(raw.model, 80) || null, generatedAt: Number.isFinite(raw.generatedAt) ? raw.generatedAt : null };
}

const ITEM_PROJECTION = Object.freeze({
  catalogue: 1,
  itemId: 1,
  status: 1,
  label: 1,
  productId: 1,
  dominantHex: 1,
  'source.page': 1,
  'attributes.code': 1,
  'attributes.printedName': 1,
  'images.thumb.key': 1,
  'images.thumb.bytes': 1,
  shopImage: 1,
  studio: 1,
});

/**
 * @param {object} options
 * @param {ReturnType<import('./db.js').createCatalogueDb>} options.db
 * @param {{signGet: Function, ready: Function}} options.signer
 * @param {{info: Function, warn: Function}} [options.log]
 * @param {() => number} [options.now]
 * @param {typeof fetch} [options.fetchImpl] tests
 */
export function createDesigns({ db, signer, log, now = Date.now, fetchImpl = (...args) => fetch(...args) }) {
  const warned = new Map();
  const warnOnce = (key, message) => {
    if (now() - (warned.get(key) ?? -Infinity) < 10 * 60 * 1000) return;
    warned.set(key, now());
    log?.warn(message);
  };

  // ------------------------------------------------------------------------------------------------ the data
  let listed = null; // {at, value | error, pending}
  async function load() {
    const catalogues = await db.col('catalogues');
    const live = (await catalogues.find({ activeRelease: { $ne: null } }, { projection: { kind: 1 } }).toArray()).filter((c) => c.kind === 'materials').map((c) => c._id);
    if (!live.length) return [];
    const items = await db.col('catalogue_items');
    const docs = (await items.find({ catalogue: { $in: live }, status: 'ok' }, { projection: ITEM_PROJECTION }).toArray()).filter((d) => PRODUCT_ID.test(String(d.productId ?? '')));
    const byProduct = new Map();
    for (const doc of docs) {
      if (!byProduct.has(doc.productId)) byProduct.set(doc.productId, []);
      byProduct.get(doc.productId).push(doc);
    }
    const designs = [];
    for (const [productId, group] of byProduct) {
      group.sort((a, b) => (a.source?.page ?? 1e9) - (b.source?.page ?? 1e9));
      // the page whose picture is the shop's one (it carries `shopImage`), else the first page
      const primary = group.find((d) => d.shopImage?.key) ?? group[0];
      const code = clean(primary.attributes?.code, 20) || productId.replace(/^TIPL-/, '');
      const hex = (Array.isArray(primary.dominantHex) ? primary.dominantHex : []).find((h) => HEX.test(h)) ?? null;
      const shopKey = isReadable(primary.shopImage?.key) ? primary.shopImage.key : null;
      const thumbKey = isReadable(primary.images?.thumb?.key) ? primary.images.thumb.key : null;
      designs.push({
        id: slugOf(productId),
        productId,
        code,
        name: clean(primary.label, 80) || displayName(primary.attributes?.printedName) || code,
        catalogue: primary.catalogue,
        itemId: primary.itemId,
        pages: group.map((d) => d.source?.page).filter(Number.isInteger),
        hex: hex ? hex.toLowerCase() : null,
        shopKey,
        thumbKey,
        shopTag: shopKey ? String(primary.shopImage.sha256 ?? '').slice(0, 12) || null : null,
        studio: readStudio(primary.studio),
      });
    }
    designs.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    return designs;
  }

  /** The designs of the live catalogues, remembered for a minute (5 seconds after a failure). Throws when the database is down. */
  async function list() {
    const t = now();
    if (listed?.pending) return listed.pending;
    if (listed && t - listed.at < (listed.error ? FAIL_TTL_MS : LIST_TTL_MS)) {
      if (listed.error) throw listed.error;
      return listed.value;
    }
    const entry = { at: t, value: null, error: null, pending: null };
    entry.pending = load()
      .then((value) => {
        entry.value = value;
        return value;
      })
      .catch((error) => {
        entry.error = error;
        if (!isStoreDown(error)) warnOnce('list', `catalogue  reading the designs failed (${String(error?.name ?? 'error').slice(0, 40)})`);
        throw error;
      })
      .finally(() => {
        entry.pending = null;
        entry.at = now();
      });
    listed = entry;
    return entry.pending;
  }

  async function get(slug) {
    if (!SLUG.test(String(slug ?? ''))) return null;
    return (await list()).find((d) => d.id === slug) ?? null;
  }

  // ------------------------------------------------------------------------------------------------ the pictures
  const cache = new Map(); // key -> {bytes, type, tag}, in the order of use
  let cached = 0;
  const missing = new Map(); // key -> when it failed
  function remember(key, entry) {
    cache.set(key, entry);
    cached += entry.bytes.length;
    while (cached > CACHE_BYTES && cache.size > 1) {
      const oldest = cache.keys().next().value;
      cached -= cache.get(oldest).bytes.length;
      cache.delete(oldest);
    }
  }

  /** The bytes of one object of the bucket (thumbs/ or cards/ only), from memory when they are there. Null when it cannot be had. */
  async function fetchObject(key) {
    if (!isReadable(key)) return null;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit); // most recently used last
      return hit;
    }
    if (now() - (missing.get(key) ?? -Infinity) < MISS_TTL_MS) return null;
    let url;
    try {
      url = signer.signGet(key, { expiresS: 300 });
    } catch {
      warnOnce('sign', 'catalogue  a picture could not be signed (is the signing key usable? Admin > check)');
      return null;
    }
    try {
      const answer = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const type = String(answer.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!answer.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new Error(`status ${answer.status}`);
      const declared = Number(answer.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw new Error('too large');
      const bytes = Buffer.from(await answer.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('size');
      const entry = { bytes, type, tag: crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 16) };
      remember(key, entry);
      return entry;
    } catch (error) {
      missing.set(key, now());
      warnOnce(`fetch:${key}`, `catalogue  a picture could not be read from the bucket (${String(error?.message ?? 'error').slice(0, 60)}): ${key}`);
      return null;
    }
  }

  /**
   * One design's picture. size "thumb" is the 320 px thumbnail, "card" the 800 px picture (the thumbnail when a design has no card yet).
   * @returns {Promise<{bytes: Buffer, type: string, tag: string} | null>} null: unknown design, or the bucket did not give it
   */
  async function image(slug, size = 'card') {
    const design = await get(slug);
    if (!design) return null;
    const keys = size === 'thumb' ? [design.thumbKey, design.shopKey] : [design.shopKey, design.thumbKey];
    for (const key of keys) {
      if (!key) continue;
      const found = await fetchObject(key);
      if (found) return found;
    }
    return null;
  }

  return { list, get, image, fetchObject, forget: () => (listed = null), stats: () => ({ cachedBytes: cached, cachedObjects: cache.size }) };
}

function isReadable(key) {
  return typeof key === 'string' && isSafeKey(key) && READ_PREFIXES.some((p) => key.startsWith(p));
}
