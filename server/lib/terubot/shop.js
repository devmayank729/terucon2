/**
 * The shop's products as TeruBot sees them: search, look-up, cards, and the quantity arithmetic.
 *
 * The data is server/data/products.json, written by tools/extract-products.js from the shop's own export (nothing here is typed in by
 * hand, and a test fails when the file stops matching the export). Prices and stock states are what the shop shows; the shop's own
 * data layer calls them demo values, so the assistant presents them as "the shop's listed price", never as a quote.
 *
 * Ids. The shop keeps its cart by VARIANT id (`superbond-fr-metallic--acp-bronze-4-1220x2440`: a product, one finish, a thickness and a
 * size) and its saved list by product id. A finish id such as `acp-bronze` (the name of the photograph) is not enough to say what to
 * put in a cart: fixings share finish ids, and a finish comes in several sizes. So every id TeruBot hands out is a variant id, and an id
 * it is given may be a variant id, a product id (its default variant) or a finish id (the first variant with that finish).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));

/** Words that carry no meaning in a search ("show me some bronze sheets for my facade"), and the words of a budget ("under 15000"), which the price filters take care of. */
const STOP = new Set(
  ('a an the and or for of to in on at with my our i we me need want some show find looking look get buy please any is are it that this those these can you do does something like good best which what by per ' +
    'under below above over than less more around about between within up upto rs inr rupees rupee budget price priced cost costs cheap cheaper cheapest expensive affordable').split(' '),
);
const NORMALISE = [
  [/aluminum/g, 'aluminium'],
  [/gr[ae]y/g, 'grey'],
  [/colou?r/g, 'colour'],
  [/terra ?cott?a/g, 'terracotta'],
  [/micro ?-?cement/g, 'micro-cement'],
  [/louvers?/g, 'louvre'],
  [/jaa?li/g, 'jaali'],
  [/[×*]/g, 'x'],
  [/(\d)\s*x\s*(\d)/g, '$1x$2'],
  [/(\d)\s+mm\b/g, '$1mm'],
];

/** Lower case, accents removed (façade -> facade), British spellings, punctuation to spaces. */
export function normalise(text) {
  let s = String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const [from, to] of NORMALISE) s = s.replace(from, to);
  return s.replace(/[^a-z0-9\-. ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const wordsOf = (text) => normalise(text).split(/[^a-z0-9-]+/).filter(Boolean);
// a bare number is a quantity or a price ("15000"), not a word of the catalogue: the price filters and the estimate tool take care of those
const tokensOf = (text) => normalise(text).split(' ').map((t) => t.replace(/^[.-]+|[.-]+$/g, '')).filter((t) => t.length > 1 && !STOP.has(t) && !/^[\d.,]+$/.test(t));
/** A word of the text starts with the token (or with the token less a plural "s" for longer tokens: a catalogue code such as sb804 is not a plural of sb80). */
const hits = (words, token) => words.some((w) => w.startsWith(token) || (token.length > 4 && token.endsWith('s') && w.startsWith(token.slice(0, -1))));

/** The three states the shop shows (it keeps a count behind them; the count is not shared). */
export const STOCK_TEXT = { in: 'in stock', low: 'low stock', out: 'out of stock' };

/** @param {string} [dir] the folder with products.json (tests pass another) */
export function loadShop(dir = DATA_DIR) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'products.json'), 'utf8'));
  const categories = new Map(raw.categories.map((c) => [c.id, c]));
  const colours = new Map(raw.colours.map((c) => [c.id, c]));
  const applications = new Map(raw.applications.map((a) => [a.id, a]));
  const performance = new Map(raw.performance.map((x) => [x.id, x]));
  const products = raw.products;
  const byProduct = new Map();
  const byVariant = new Map();
  const byFinish = new Map();
  const vocabulary = new Set();

  for (const p of products) {
    byProduct.set(p.id, p);
    p.words = wordsOf(`${p.name} ${p.searchText}`);
    p.nameWords = wordsOf(p.name);
    for (const w of p.words) vocabulary.add(w);
    for (const v of p.variants) {
      v.productId = p.id;
      byVariant.set(v.id, { product: p, variant: v });
      if (!byFinish.has(v.finishId)) byFinish.set(v.finishId, []);
      byFinish.get(v.finishId).push({ product: p, variant: v });
      const colour = colours.get(v.colour);
      v.words = wordsOf(`${v.finish} ${colour?.words ?? ''} ${v.surface} ${raw.surfaces[v.surface] ?? ''} ${v.thickness ?? ''} ${v.size ?? ''} ${v.label}`);
      v.finishWords = wordsOf(v.finish);
      for (const w of v.words) vocabulary.add(w);
    }
  }
  const known = (token) => {
    for (const w of vocabulary) if (w.startsWith(token) || (token.length > 4 && token.endsWith('s') && w.startsWith(token.slice(0, -1)))) return true;
    return false;
  };

  const inStock = (v) => v.stock !== 'out';
  /** The variant to show for a product when nothing more specific was asked: the default one if it is in stock, else the first in stock. */
  const defaultVariantOf = (p) => {
    const d = p.variants.find((v) => v.id === p.defaultVariant) ?? p.variants[0];
    return inStock(d) ? d : (p.variants.find(inStock) ?? d);
  };

  /**
   * An id from a model, a browser or a visitor -> {product, variant}, or null. Variant id first, then product id, then finish id.
   * Case and surrounding space are forgiven; nothing else is.
   */
  function resolve(id) {
    if (typeof id !== 'string') return null;
    const key = id.trim().toLowerCase();
    if (!key || key.length > 120) return null;
    const direct = byVariant.get(key);
    if (direct) return direct;
    const product = byProduct.get(key);
    if (product) return { product, variant: defaultVariantOf(product) };
    const finish = byFinish.get(key);
    if (finish) return finish.find((x) => inStock(x.variant)) ?? finish[0];
    return null;
  }

  const finishCount = (p) => new Set(p.variants.map((v) => v.finishId)).size;
  /** "FR Façade ACP, Metallic - Brushed Bronze": the product, and the finish when the product comes in several. */
  const nameOf = (p, v) => (finishCount(p) > 1 ? `${p.name} - ${v.finish}` : p.name);

  /** What the model is told about one variant. */
  const variantView = (v) => ({
    id: v.id,
    label: v.label,
    finish: v.finish,
    price: v.priceText,
    availability: STOCK_TEXT[v.stock],
    ...(v.coverSqft ? { coverageSqftPerUnit: v.coverSqft } : {}),
    ...(v.perSqft ? { pricePerSqft: `₹${v.perSqft}` } : {}),
  });

  const priceRange = (variants, unit) => {
    const prices = variants.map((v) => v.price);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const first = variants.find((v) => v.price === lo).priceText;
    return lo === hi ? first : `${first.split(' / ')[0]} to ${variants.find((v) => v.price === hi).priceText}`;
  };

  /**
   * @param {object} q
   * @param {string} [q.query] words
   * @param {string} [q.category] a category id
   * @param {string} [q.colour] a colour id
   * @param {string} [q.application] an application id
   * @param {string} [q.performance] a performance id
   * @param {number} [q.minPrice] rupees, per unit, as listed
   * @param {number} [q.maxPrice]
   * @param {boolean} [q.inStockOnly]
   * @param {'relevance' | 'price_asc' | 'price_desc'} [q.sort]
   * @param {number} [q.limit] 1..8
   */
  function search({ query = '', category, colour, application, performance: perf, minPrice, maxPrice, inStockOnly = false, sort = 'relevance', limit = 4 } = {}) {
    const all = tokensOf(query);
    const tokens = all.filter(known);
    const ignored = all.filter((t) => !known(t));
    const filters = { category, colour, application, performance: perf, minPrice, maxPrice, inStockOnly };
    if (all.length && !tokens.length) return { results: [], total: 0, ignoredWords: ignored, filters, unmatched: true };

    const hitsList = [];
    for (const p of products) {
      if (category && p.category !== category) continue;
      if (application && !p.applications.includes(application)) continue;
      if (perf && !p.performance.includes(perf)) continue;
      let score = 0;
      let ok = true;
      for (const t of tokens) {
        const inName = hits(p.nameWords, t);
        const inProduct = hits(p.words, t);
        const inFinish = p.variants.some((v) => hits(v.finishWords, t));
        const inVariant = inFinish || p.variants.some((v) => hits(v.words, t));
        if (!inProduct && !inVariant) {
          ok = false;
          break;
        }
        score += (inName ? 6 : 0) + (inProduct ? 2 : 0) + (inFinish ? 5 : inVariant ? 2 : 0);
      }
      if (!ok) continue;
      const matching = p.variants.filter((v) => (!colour || v.colour === colour) && (minPrice === undefined || v.price >= minPrice) && (maxPrice === undefined || v.price <= maxPrice) && (!inStockOnly || inStock(v)));
      if (!matching.length) continue;
      if (p.category === 'fixings' && category !== 'fixings' && !tokens.some((t) => hits(wordsOf(`${p.name} fixing fixings accessory accessories`), t))) score -= 4;
      score += (p.promoted ? 0.6 : 0) + (p.featured ? 0.4 : 0);
      // the variant to show: the best match for the words, in stock, the default one, else the cheapest
      const rank = (v) => tokens.reduce((s, t) => s + (hits(v.finishWords, t) ? 3 : hits(v.words, t) ? 1 : 0), 0);
      const best = [...matching].sort((a, b) => rank(b) - rank(a) || Number(inStock(b)) - Number(inStock(a)) || Number(b.id === p.defaultVariant) - Number(a.id === p.defaultVariant) || a.price - b.price)[0];
      hitsList.push({ product: p, variant: best, matching, score });
    }
    const order = {
      relevance: (a, b) => b.score - a.score || a.variant.price - b.variant.price,
      price_asc: (a, b) => a.variant.price - b.variant.price || b.score - a.score,
      price_desc: (a, b) => b.variant.price - a.variant.price || b.score - a.score,
    }[sort] ?? ((a, b) => b.score - a.score);
    hitsList.sort(order);
    const n = Math.max(1, Math.min(8, Math.trunc(limit) || 4));
    return {
      results: hitsList.slice(0, n).map((h) => ({ product: h.product, variant: h.variant, matching: h.matching })),
      total: hitsList.length,
      ignoredWords: ignored,
      filters,
      unmatched: false,
    };
  }

  /** The search result as the model reads it. */
  function resultView({ product: p, variant: v, matching }) {
    return {
      id: v.id,
      productId: p.id,
      name: nameOf(p, v),
      category: categories.get(p.category)?.name ?? p.category,
      brand: p.brand,
      tagline: p.tagline,
      showing: variantView(v),
      priceRange: priceRange(matching, p.unit),
      variantsMatching: matching.length,
      variantsTotal: p.variants.length,
    };
  }

  /** The whole product as the model reads it (every variant, in a compact form). */
  function productView(p, focus) {
    return {
      productId: p.id,
      name: p.name,
      category: categories.get(p.category)?.name ?? p.category,
      brand: p.brand,
      sold: `per ${p.unit}`,
      tagline: p.tagline,
      description: p.description,
      usedFor: p.applications.map((a) => applications.get(a)?.name ?? a),
      performance: p.performance.map((x) => performance.get(x)?.name ?? x),
      specs: Object.fromEntries(p.specs.map(([k, v]) => [k, v])),
      gstRate: `${Math.round(p.gst * 100)}%`,
      accessories: p.accessories.map((a) => ({ productId: a, name: byProduct.get(a)?.name ?? a })),
      focusVariant: focus ? variantView(focus) : undefined,
      variants: p.variants.map(variantView),
    };
  }

  /** The card the widget draws. `imageUrl(variant)` is the address of the photograph or '' (see images.js). */
  function card(p, v, imageUrl = () => '') {
    return {
      kind: 'material',
      id: v.id,
      name: nameOf(p, v),
      price: v.priceText,
      image: imageUrl(v) || '',
      href: `/materials#/p/${p.id}?v=${encodeURIComponent(v.id)}`,
      pid: p.id,
      vid: v.id,
      fid: v.finishId,
      variant: v.label,
    };
  }

  /**
   * How many units cover an area, the way the shop works it out: ceil(area x (1 + waste) / cover of one unit). Only for items sold by
   * area; the others have to be counted.
   * @returns {{ok: true, ...} | {ok: false, error: string}}
   */
  function estimate(p, v, areaSqft, wastePercent = 10) {
    if (!v.coverM2) return { ok: false, error: `${p.name} is not sold by area, so an area cannot be turned into a number of units. Count the pieces instead.` };
    const waste = Math.max(0, Math.min(50, wastePercent)) / 100;
    const m2 = areaSqft / raw.sqftPerM2;
    const units = Math.ceil((m2 * (1 + waste)) / v.coverM2 - 1e-9);
    const subtotal = units * v.price;
    return {
      ok: true,
      variant: variantView(v),
      areaSqft,
      wastePercent: Math.round(waste * 100),
      units,
      unit: units === 1 ? p.unit : p.units,
      coversSqft: Math.round(units * v.coverM2 * raw.sqftPerM2),
      subtotalBeforeGst: `₹${subtotal.toLocaleString('en-IN')}`,
      note: "Worked out from the shop's listed price; GST, delivery and fixings are not included. This is not a quote.",
    };
  }

  return {
    source: raw.source,
    counts: raw.counts,
    products,
    categories: raw.categories,
    colours: raw.colours,
    applications: raw.applications,
    performance: raw.performance,
    collections: raw.collections,
    resolve,
    search,
    resultView,
    productView,
    variantView,
    card,
    estimate,
    nameOf,
    inStock,
    byProduct,
    byVariant,
  };
}

/** @typedef {ReturnType<typeof loadShop>} Shop */
