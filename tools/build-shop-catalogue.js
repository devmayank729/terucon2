#!/usr/bin/env node
// List the catalogue designs in the shop (target A1): write site/patches/snippets/shop-catalogue.js, the piece of code that the `catalogue-products` step of
// site/patches/materials.json splices into the shop's data layer (window.TeruconStore) next to its own 24 products.
//
//   node tools/build-shop-catalogue.js            write the snippet
//   node tools/build-shop-catalogue.js --check    exit 1 if the snippet on disk is not what the data gives (writes nothing)
//
// Input: catalogue/data/superbond-colour-shop.json (written by catalogue/tools/make_shop_images.py from the id table and the PDF: id, printed code and
// name, catalogue pages, picture, the picture's mean colour). One design = one product = one finish = one variant. The product id is the catalogue's product id
// in lower case (TIPL-SB804 -> tipl-sb804): that is the only link between a catalogue search result and a shop product (server/lib/terubot/catalogue.js).
//
// What is real and what is a placeholder, so nobody mistakes the one for the other:
//   real         the id, the printed code and name, the pages, the picture (cut from the catalogue's own page), the mean colour of that picture.
//   from the name  the colour family and the surface (wood-grain, metallic, textured), by words in the printed name (teak, oak, copper ...). The Gemini
//                descriptions in the database were not used: most designs came out as 'laminate'.
//   PLACEHOLDER  size (1220 x 2440 mm, 4 mm), the rate per sq ft and the weight: copied from the shop's own SuperBond FR Solid sheet, the nearest listed SuperBond
//                product, because Terucon's price list is not loaded. The product page says so ("Size and price"). The shop's own data layer already calls
//                its prices demo values; these are no better. Replace RATE and WEIGHT here (or per design in the data file) when the real list arrives.
//   PLACEHOLDER  the uses (interior, joinery, partitions): the same as the shop's decorative laminate. Nothing is known about where each design may be used.
//
// Also read when it exists: catalogue/data/superbond-colour-detail.json (written by tools/describe-designs.js: what Gemini SAW in each design's picture: a sentence
// on its look, its colours, pattern, sheen and surface). It goes into the product's description and its specification table, labelled as AI-written from the
// picture. It is appearance only: nothing in it says what the design is made of, how big or strong it is, or what it costs.
//
// The pictures are not files: /media/materials/tipl-sb804.jpg is read from Cloud Storage through MongoDB (server/routes/catalogueMedia.js; tools/publish-shop-images.js).
//
// Node built-ins only. Deterministic: the same data gives the same bytes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_FILE = 'catalogue/data/superbond-colour-shop.json';
export const SNIPPET_FILE = 'site/patches/snippets/shop-catalogue.js';
export const CATEGORY_ID = 'colour';
export const RATE_PER_SQFT = 188; // the shop's FR Solid, 4 mm: PLACEHOLDER
export const WEIGHT_PER_M2 = 7.6; // the same sheet's kg per m2: PLACEHOLDER
export const SAMPLE_SIZE = [1220, 2440];
export const SAMPLE_THICKNESS = 4;

const WOOD = /\b(teak|oak|walnut|wood|ebony|mahogany|timber)\b/i;
const METAL = /\b(metal|copper|titanium|mercury)\b/i;

/** '#a1b2c3' -> [h 0-360, s 0-1, l 0-1] */
export function hsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  return [h, s, l];
}

/** The shop's colour family (brown, wood, earth, sand, white, grey, green) for a design: wood by its printed name, else from the picture's mean colour. */
export function colourFamily(printedName, meanHex) {
  if (WOOD.test(printedName)) return 'wood';
  const [h, s, l] = hsl(meanHex);
  if (l > 0.82 && s < 0.2) return 'white';
  if (s < 0.1) return l > 0.82 ? 'white' : 'grey';
  if (h >= 60 && h < 190) return 'green';
  if (h < 60 || h >= 330) {
    if (s > 0.45 && l < 0.6 && h < 30) return 'earth';
    if (l < 0.3) return 'brown';
    if (l > 0.6) return 'sand';
    return s > 0.3 ? 'earth' : 'brown';
  }
  return 'grey';
}

export function surfaceOf(printedName) {
  if (WOOD.test(printedName)) return 'woodgrain';
  if (METAL.test(printedName)) return 'metallic';
  return 'textured';
}

/** 'EMPERADOR DARK' -> 'Emperador Dark'; words of one or two letters stay as printed (TX). The same rule as catalogue/terucon_catalogue/assign_ids.py. */
export function displayName(printed) {
  return printed.split(/\s+/).filter(Boolean).map((w) => (w.length <= 2 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase())).join(' ');
}

// `<` is written as \u003c so that no text can ever close the <script> this is spliced into
const q = (s) => JSON.stringify(s).replace(/</g, '\\u003c');
export const DETAIL_FILE = 'catalogue/data/superbond-colour-detail.json';

export function snippetText(data) {
  const rows = data.products.map((p) => {
    const label = displayName(p.printedName);
    const fid = p.id.toLowerCase();
    const d = data.detail?.[p.id];
    const look = d ? { look: d.look, colours: d.colours.join(', '), pattern: d.pattern, sheen: d.sheen, relief: d.relief } : null;
    return `    [${q(fid)}, ${q(p.id)}, ${q(p.code)}, ${q(p.printedName)}, ${q(label)}, ${q(p.pages)}, ${q(colourFamily(p.printedName, p.meanHex))}, ${q(surfaceOf(p.printedName))}, ${q(p.meanHex)}, ${q(look)}]`;
  });
  const cover = data.products[0].id.toLowerCase();
  return `  // ---------- SuperBond colour catalogue: generated by tools/build-shop-catalogue.js from ${DATA_FILE}. Do not edit by hand. ----------
  // ${data.products.length} designs from the catalogue PDF, one product each. The product id is the catalogue's product id in lower case (TIPL-SB804 -> tipl-sb804).
  // PLACEHOLDERS, not Terucon's: the size (${SAMPLE_SIZE.join(' x ')} mm, ${SAMPLE_THICKNESS} mm), the rate (${RATE_PER_SQFT} per sq ft), the weight and the uses, copied from the shop's own sample sheets.
  CATEGORIES.push({ id: ${q(CATEGORY_ID)}, n: '08', name: 'SuperBond colours', short: 'Colour catalogue', img: ${q(cover)}, blurb: 'The SuperBond colour catalogue (Diamond Edition): wood, stone, metal and texture designs, each with its catalogue code.' });
  [
${rows.join(',\n')}
  ].forEach(row => {
    const [fid, tipl, code, printed, label, pages, family, surface, hex, look] = row;
    F[fid] = [label, family, surface, hex];
    P.push({ id: fid, name: label + ' (' + code + ')', brand: 'superbond', cat: ${q(CATEGORY_ID)}, unit: 'sheet', units: 'sheets', calc: 'area', code: code, gst: .18, skuOverride: tipl,
      tagline: code + ' · ' + tipl + ' · SuperBond colour catalogue',
      desc: 'Design ' + tipl + ' (' + printed + ') from the SuperBond colour catalogue, catalogue page' + (pages.length > 1 ? 's ' + pages.join(' and ') : ' ' + pages[0]) + '. ' + (look ? look.look + ' (Written by AI from the catalogue picture: it describes how the design looks.) ' : '') + 'The size, thickness and price shown are sample values until the price list is loaded.',
      fin: [[fid, 1]], thk: [${SAMPLE_THICKNESS}], sizes: [[${SAMPLE_SIZE.join(', ')}]], rate: { ${SAMPLE_THICKNESS}: ${RATE_PER_SQFT} }, kg: { ${SAMPLE_THICKNESS}: ${WEIGHT_PER_M2} },
      apps: ['interior', 'joinery', 'partitions'], perf: [],
      specs: [['Design code', tipl], ['Printed name', printed], ['Catalogue', 'SuperBond colour catalogue, page' + (pages.length > 1 ? 's ' + pages.join(' and ') : ' ' + pages[0])], ['Size and price', 'Sample values until the price list is loaded']].concat(look ? [['Colours', look.colours], ['Pattern', look.pattern], ['Sheen', look.sheen], ['Surface', look.relief], ['About these four', 'Written by AI from the catalogue picture: how the design looks, not what it is made of.']] : []),
      install: ['Installation guidance for this design is not listed yet.'], acc: [], handling: '' });
  });
`;
}

export function loadData(root = ROOT) {
  const data = JSON.parse(fs.readFileSync(path.join(root, DATA_FILE), 'utf8'));
  if (!Array.isArray(data.products) || !data.products.length) throw new Error(`${DATA_FILE} has no products`);
  const seen = new Set();
  for (const p of data.products) {
    if (!/^TIPL-[A-Z]{2,4}\d{2,5}$/.test(p.id) || seen.has(p.id)) throw new Error(`${DATA_FILE}: bad or repeated product id ${p.id}`);
    seen.add(p.id);
    if (!/^#[0-9a-f]{6}$/.test(p.meanHex) || !Array.isArray(p.pages) || !p.pages.length || !p.printedName) throw new Error(`${DATA_FILE}: ${p.id} is incomplete`);
  }
  const detailFile = path.join(root, DETAIL_FILE);
  data.detail = fs.existsSync(detailFile) ? JSON.parse(fs.readFileSync(detailFile, 'utf8')).designs ?? {} : {};
  for (const [id, d] of Object.entries(data.detail)) {
    if (!seen.has(id)) throw new Error(`${DETAIL_FILE}: ${id} is not a design of ${DATA_FILE}`);
    if (!d || typeof d.look !== 'string' || !Array.isArray(d.colours) || typeof d.pattern !== 'string' || typeof d.sheen !== 'string' || typeof d.relief !== 'string') throw new Error(`${DETAIL_FILE}: ${id} is incomplete`);
  }
  return data;
}

export function expected(root = ROOT) {
  return snippetText(loadData(root));
}

function main(argv) {
  const want = expected();
  const file = path.join(ROOT, SNIPPET_FILE);
  if (argv.includes('--check')) {
    const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (have !== want) {
      console.log(`${SNIPPET_FILE} is out of date. Run: node tools/build-shop-catalogue.js`);
      return 1;
    }
    console.log(`${SNIPPET_FILE} matches ${DATA_FILE}.`);
    return 0;
  }
  fs.writeFileSync(file, want, 'utf8');
  console.log(`wrote ${SNIPPET_FILE} (${want.length} bytes)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
