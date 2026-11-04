#!/usr/bin/env node
// Read the shop's product data out of the landing/shop exports, so TeruBot (server/lib/terubot/) never works from retyped data.
//
//   node tools/extract-products.js            write server/data/products.json and server/data/enquiry-form.json
//   node tools/extract-products.js --check    say whether those two files match the exports (exit 1 if not; writes nothing)
//
// Where the data lives. pages_original/market_place.html is a self-extracting bundle (tools/bundle.js). One of its scripts is the
// shop's data layer ("window.TeruconStore = {...}", marked FRONTEND DEMO at its top): the catalogue as a list of products with
// finishes, thicknesses and sizes, and the code that turns those into variants and prices (rate x area x finish factor, rounded).
// Re-typing or pattern-matching that list would get the prices wrong, so this tool RUNS the shop's own script in a sandbox
// (node:vm, a stub `window`, a stub `localStorage`, nothing else) and reads the finished `products` and `variants` back, and writes
// the price labels with the shop's own formatter (`fmt.inr`), so a label here is the label the shop shows. The script is found by its
// content, not by its uuid, because the uuid changes when the page is exported again.
//
// What is left out on purpose: the long how-to-install texts, the handling notes, the generation prompts (PHOTO) and the units of
// stock (only the shop's three stock states are kept: a number would pretend to be a count). Everything in the output is a value the
// shop itself shows or searches by.
//
// The enquiry form's choices (the project-type chips, the timeline chips, the "Approx. area" options and the field names) are read
// from pages_original/index.html the same way: they are what an assistant may prefill and nothing else.
//
// Deterministic: the same exports give the same bytes. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bundle } from './bundle.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHOP_EXPORT = 'pages_original/market_place.html';
/** The shop as the site serves it (the export with site/patches/materials.json applied: it also carries the catalogue designs, see tools/build-shop-catalogue.js). */
export const SHOP_BUILT = 'pages/materials.html';
export const HOME_EXPORT = 'pages_original/index.html';
export const PRODUCTS_FILE = 'server/data/products.json';
export const ENQUIRY_FILE = 'server/data/enquiry-form.json';

export class ExtractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExtractError';
  }
}

const DATA_MARK = 'window.TeruconStore =';
const IMAGE_KEY = /^media\/materials\/([A-Za-z0-9._-]+)\.jpg$/;

/** The shop's data script, found by what it contains. */
function findStoreScript(bundle) {
  const found = [];
  for (const uuid of bundle.uuids) {
    if (!/javascript/.test(bundle.mime(uuid))) continue;
    const text = bundle.assetText(uuid);
    if (text.includes(DATA_MARK)) found.push(text);
  }
  if (found.length !== 1) throw new ExtractError(`expected exactly one script that defines window.TeruconStore in ${SHOP_EXPORT}, found ${found.length}`);
  return found[0];
}

/** Run the shop's data script with nothing around it but a stub `window` and `localStorage`. */
function runStore(code) {
  const window = {};
  const sandbox = { window, localStorage: { getItem: () => null, setItem() {} }, setTimeout: () => 0, clearTimeout() {} };
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(code, sandbox, { filename: 'shop-data.js', timeout: 10_000 });
  const store = window.TeruconStore;
  if (!store || !Array.isArray(store.products) || !Array.isArray(store.variants)) throw new ExtractError('the shop script did not define products and variants');
  return store;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

/** @returns {object} the content of server/data/products.json */
export function extractProducts(root = ROOT) {
  const bundle = Bundle.load(path.join(root, SHOP_EXPORT));
  // the data layer is read from the BUILT shop page when there is one, because that is what visitors get (24 own products plus the catalogue designs);
  // a checkout without pages/ falls back to the export itself
  const builtFile = path.join(root, SHOP_BUILT);
  const store = runStore(findStoreScript(fs.existsSync(builtFile) ? Bundle.load(builtFile) : bundle));
  const { inr } = store.fmt;
  // the photographs the export carries: a finish without one is shown as a placeholder by the shop
  const photos = new Set();
  for (const key of Object.keys(bundle.extIds())) {
    const m = IMAGE_KEY.exec(key);
    if (m) photos.add(m[1]);
  }
  // pictures that are files of this project (the catalogue designs': media/materials/tipl-*.jpg) count as photographs too
  const mediaDir = path.join(root, 'media', 'materials');
  if (fs.existsSync(mediaDir)) for (const f of fs.readdirSync(mediaDir)) if (/^[A-Za-z0-9._-]+\.jpg$/.test(f)) photos.add(f.slice(0, -4));
  const imageOf = (name) => (name && photos.has(name) ? `media/materials/${name}.jpg` : null);

  const products = store.products.map((p) => {
    const variants = p.variants.map((v) => ({
      id: v.id,
      finishId: v.fid,
      finish: v.finish,
      colour: v.family,
      surface: v.surface,
      thickness: v.thkLabel || null,
      size: v.sizeLabel || null,
      pack: v.packLabel || null,
      label: v.label,
      price: v.price,
      priceText: `${inr(v.price)} / ${v.unit}`,
      perSqft: v.perSqft ?? null,
      coverM2: v.cover ?? null,
      coverSqft: v.coverSqft ?? null,
      stock: v.stockState,
      sku: v.sku,
      image: imageOf(v.photo ? v.fid : p.img),
    }));
    return {
      id: p.id,
      name: p.name,
      brand: p.brandName,
      category: p.cat,
      code: p.code,
      unit: p.unit,
      units: p.units,
      gst: p.gst,
      tagline: p.tagline,
      description: p.desc,
      applications: plain(p.apps),
      performance: plain(p.perf),
      ...(p.skuOverride ? { catalogueId: p.skuOverride } : {}), // a design of the SuperBond colour catalogue: its product id, the link to catalogue search results
      featured: Boolean(p.featured),
      promoted: Boolean(p.promoted),
      specs: plain(p.specs),
      accessories: (p.acc ?? []).map((a) => a[0]),
      defaultVariant: p.defaultVid,
      minPrice: p.minPrice,
      minPriceText: `${inr(p.minPrice)} / ${p.unit}`,
      searchText: p.text,
      variants,
    };
  });

  const pidOf = new Set(products.map((p) => p.id));
  for (const p of products) for (const a of p.accessories) if (!pidOf.has(a)) throw new ExtractError(`${p.id} lists an accessory ${a} that is not a product`);

  return {
    _comment: `Generated by tools/extract-products.js from ${SHOP_EXPORT}: do not edit by hand. The shop's own data layer is marked FRONTEND DEMO: prices and stock are demo values, not a quote. Re-generate with: node tools/extract-products.js`,
    source: SHOP_EXPORT,
    currency: 'INR',
    sqftPerM2: store.SQFT,
    counts: { products: products.length, variants: store.variants.length },
    categories: store.CATEGORIES.map((c) => ({ id: c.id, name: c.name, short: c.short, blurb: c.blurb })),
    colours: store.COLOURS.map((c) => ({ id: c.id, name: c.name, words: c.words })),
    applications: store.APPS.map((a) => ({ id: a.id, name: a.name, words: a.words })),
    performance: store.PERF.map((x) => ({ id: x.id, name: x.name })),
    surfaces: plain(store.SURFACES),
    brands: store.BRANDS.map((b) => ({ id: b.id, name: b.name })),
    collections: store.COLLECTIONS.map((c) => ({ id: c.id, name: c.name, line: c.line, products: [...new Set(c.spots.map((s) => s[2]))] })),
    products,
  };
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decode = (text) => text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]);

/** @returns {object} the content of server/data/enquiry-form.json */
export function extractEnquiryForm(root = ROOT) {
  const bundle = Bundle.load(path.join(root, HOME_EXPORT));
  const html = bundle.template;
  const formAt = html.indexOf('<form data-enquiry');
  const formEnd = formAt === -1 ? -1 : html.indexOf('</form>', formAt);
  if (formAt === -1 || formEnd === -1) throw new ExtractError(`the enquiry form (<form data-enquiry) was not found in ${HOME_EXPORT}`);
  const form = html.slice(formAt, formEnd);
  const chips = (kind) => [...form.matchAll(new RegExp(`data-chip="${kind}"\\s+data-value="([^"]+)"`, 'g'))].map((m) => decode(m[1]));
  const fields = [...new Set([...form.matchAll(/<(?:input|textarea|sc-raw-select)\b[^>]*?\bname="([a-z]+)"/g)].map((m) => m[1]))];
  const select = /<sc-raw-select\b[^>]*\bname="area"[^>]*>([\s\S]*?)<\/sc-raw-select>/.exec(form);
  // the first option is the empty "Select" placeholder (value=""): not a choice
  const areas = select ? [...select[1].matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].filter((m) => !/\bvalue=""/.test(m[1])).map((m) => decode(m[2]).trim()).filter(Boolean) : [];
  const out = { types: chips('type'), timelines: chips('timeline'), areas, fields };
  for (const [name, list] of Object.entries(out)) if (!list.length) throw new ExtractError(`no ${name} found in the enquiry form of ${HOME_EXPORT}`);
  return {
    _comment: `Generated by tools/extract-products.js from ${HOME_EXPORT}: do not edit by hand. The choices the landing page's enquiry form offers. Re-generate with: node tools/extract-products.js`,
    source: HOME_EXPORT,
    ...out,
  };
}

const text = (data) => JSON.stringify(data, null, 1) + '\n';

/** @returns {{file: string, content: string}[]} what should be on disk */
export function expectedFiles(root = ROOT) {
  return [
    { file: PRODUCTS_FILE, content: text(extractProducts(root)) },
    { file: ENQUIRY_FILE, content: text(extractEnquiryForm(root)) },
  ];
}

/** The files whose content differs from what the exports give (or that are missing). */
export function staleFiles(root = ROOT) {
  const stale = [];
  for (const { file, content } of expectedFiles(root)) {
    let have = null;
    try {
      have = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      // missing counts as stale
    }
    if (have !== content) stale.push(file);
  }
  return stale;
}

function main(argv) {
  if (argv.includes('--check')) {
    const stale = staleFiles();
    if (stale.length) {
      console.log(`Out of date: ${stale.join(', ')}. Run: node tools/extract-products.js`);
      return 1;
    }
    console.log('server/data matches the exports.');
    return 0;
  }
  for (const { file, content } of expectedFiles()) {
    fs.mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, file), content, 'utf8');
    console.log(`wrote ${file} (${content.length} bytes)`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
