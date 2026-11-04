#!/usr/bin/env node
// Have Gemini look at each catalogue design's picture and write what it sees (targets C1, A1).
//
//   node tools/describe-designs.js --only TIPL-SB804,TIPL-SB805     PREVIEW: asks Gemini about those designs and prints the answers, writes nothing
//   node tools/describe-designs.js --apply                           asks about every design that has no description yet, then records them
//   node tools/describe-designs.js --apply --redo                    asks about all of them again, replacing what is recorded
//   node tools/describe-designs.js --undo <backup>                   puts back what the records held before a run
//   options: --limit N (the first N), --model gemini-3.8-flash
//
// What it produces, per design (server/catalogue/designs.js `studio`): look (one or two sentences for a customer), colours, pattern, grain direction, scale
// of the pattern (fine, medium, large), sheen, relief, and `render`: a precise visual brief for the image model that paints the design into a client's photo
// (server/catalogue/studioFinishes.js turns these into the studio's finish and the rules for the reference photograph).
//
// What it must not produce, and how that is enforced. Gemini sees ONLY the picture, the printed name and the code. It is told to describe appearance and
// nothing else, and every answer is checked in code: the fields must be present and in their lists, and any text that states a size, a thickness, a
// composition (laminate, veneer, aluminium, stone species ...), a performance (waterproof, fire, scratch ...) or a price is REFUSED and asked for again once;
// a second refusal leaves that design without a description (it keeps its name, code and picture). The words are not checked for being TRUE: nobody has
// checked them against the real material. The shop and the studio call them "what the picture shows"; a person should read them (the run prints all of them).
//
// Writes: the item's `studio` field in MongoDB (a field the catalogue engine never touches) and catalogue/data/superbond-colour-detail.json, an export
// of every recorded description for the shop's build (tools/build-shop-catalogue.js) and for people to read. Before writing, the previous values are saved to
// catalogue/data/backups/describe-designs-<catalogue>-<date>.json.
//
// Cost: one Gemini request per design with a 130-230 KB picture and about 700 tokens back, through the studio's own Google credentials.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createGcsSigner } from '../server/catalogue/gcsSigner.js';
import { readStudio, STUDIO_ENUMS } from '../server/catalogue/designs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const BACKUPS = path.join(ROOT, 'catalogue/data/backups');
const EXPORT = path.join(ROOT, 'catalogue/data/superbond-colour-detail.json');
const CATALOGUE = 'superbond-colour';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const CONCURRENCY = 3;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : null);
const apply = flag('--apply');
const redo = flag('--redo');
const only = value('--only')?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) ?? null;
const limit = Number.parseInt(value('--limit') ?? '', 10) || null;
const model = value('--model') ?? DEFAULT_MODEL;

/** Words that say what a material IS, how big or strong it is, or what it costs: none of which the picture can show. */
export const CLAIMS = /(\b\d+(?:[.,]\d+)?\s?(?:mm|cm|m|metres?|meters?|inch(?:es)?|ft|feet|kg|gsm|%)\b|\b(?:thick|thickness|waterproof|water-?resistant|fire|flame|fireproof|scratch|scratch-?proof|durable|durability|warranty|certified|certification|antibacterial|eco-?friendly|price|priced|cost|cheap|affordable|premium|luxury|laminates?|veneer|aluminium|aluminum|acp|hpl|pvc|plywood|mdf|ceramic|porcelain|granite|limestone|travertine|quartz|vinyl|polymer|resin)\b|\bmade (?:of|from|out of)\b)/i;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    look: { type: 'STRING' },
    colours: { type: 'ARRAY', items: { type: 'STRING' } },
    pattern: { type: 'STRING' },
    grain: { type: 'STRING', enum: STUDIO_ENUMS.grain },
    scale: { type: 'STRING', enum: STUDIO_ENUMS.scale },
    sheen: { type: 'STRING', enum: STUDIO_ENUMS.sheen },
    relief: { type: 'STRING', enum: STUDIO_ENUMS.relief },
    render: { type: 'STRING' },
  },
  required: ['look', 'colours', 'pattern', 'grain', 'scale', 'sheen', 'relief', 'render'],
};

export function promptFor(name, code, complaint = '') {
  return [
    `You are writing product-sheet text for a decorative surface catalogue used by interior designers. The attached photograph is ONE material sample, photographed straight on: the catalogue design "${name}" (code ${code}).`,
    '',
    'Describe ONLY what you can SEE in the photograph.',
    '- Never say what it is made of, how big or thick it is, how it performs (durable, waterproof, fireproof, scratch-proof), what it costs, or where it should be used. You do not know any of that.',
    '- You may say what it LOOKS like ("looks like dark marble", "a wood-grain pattern", "copper-coloured", "a brushed-steel look"): a resemblance or a colour is not a composition. Never write "made of".',
    '- Describe the MATERIAL, not the photograph: ignore any lighting gradient, glare, vignette, shadow, edge, border or label that comes from how the picture was taken. The design will be lit by a different room.',
    '- Be specific and honest about the real colours (plain names, for example "deep espresso brown", "warm off-white"), the geometry of the pattern, how dense or sparse the marks are, whether they run in a direction, how glossy the surface looks and whether it looks flat or textured. If something cannot be judged from a photograph, choose the most likely reading from what you can see (for example gloss from the highlights).',
    '',
    'Fields:',
    '- look: one or two plain sentences for a customer, at most 260 characters: the colours, the pattern, the feel of the surface.',
    '- colours: two to four plain colour names, the ones that matter most, strongest first.',
    '- pattern: two to four words naming the pattern (for example "marble-like veining", "wood grain", "brushed lines", "plain colour", "fine speckle", "woven weave", "abstract swirls", "geometric lines").',
    '- grain: "none" when the pattern has no direction, "vertical" or "horizontal" or "diagonal" when it clearly runs one way as photographed upright, "random" when it wanders in every direction.',
    '- scale: how large the marks of the pattern are against the photograph\'s frame: "fine" (marks far smaller than a twentieth of the frame\'s width), "medium", or "large" (bold marks wider than a sixth of the frame).',
    '- sheen: how it reflects light: matte, satin, semi-gloss, gloss, or metallic.',
    '- relief: flat, fine texture, pronounced texture, or embossed.',
    '- render: three to five sentences, at most 650 characters, written for an image model that must paint this exact material onto a wall without seeing the photograph. Say what to draw: where the dark and light areas are and how they blend, how thick, long and dense the veins, grains or marks are and how they branch or run, the contrast between them, any metallic or glossy highlights and the fine texture. Positive instructions only; no sizes in centimetres.',
    complaint ? `\nYour previous answer was refused because ${complaint}. Answer again and keep to what the photograph shows.` : '',
  ].join('\n');
}

function loadEnv() {
  const dotenv = require('dotenv');
  const env = dotenv.parse(fs.readFileSync(path.join(ROOT, '.env')));
  const text = (env.CATALOGUE_GCS_KEY_JSON || env.CATALOGUE_GCS_KEY_FILE || '').trim();
  const inline = text.startsWith('{') || (text && !text.includes('/') && /^[A-Za-z0-9+/=_-]{200,}$/.test(text));
  return { bucket: env.CATALOGUE_GCS_BUCKET, prefix: (env.CATALOGUE_GCS_PREFIX || 'catalogue/').replace(/\/?$/, '/'), keyJson: inline ? text : '', keyFile: inline ? '' : text ? path.resolve(ROOT, text) : '', mongo: env.MONGODB_URI };
}

/** What the answer is refused for, or '' when it is fine. */
export function refusal(answer) {
  const record = readStudio({ ...answer, model: 'x' });
  if (!record) return 'a field is missing or not one of its allowed values';
  // readStudio cuts a long text short; here a long text is refused instead, so a sentence is never left half-written
  if (String(answer.look).length > 320 || String(answer.render).length > 700 || String(answer.pattern).length > 60) return 'a text is longer than allowed (look 260, render 650 characters, pattern four words)';
  const hit = [record.look, record.pattern, record.render, ...record.colours].map((t) => CLAIMS.exec(t)?.[0]).find(Boolean);
  return hit ? `it contains "${hit}", which a photograph cannot show (a size, a material, a performance or a price)` : '';
}

async function describeOne(vertex, location, bytes, name, code) {
  let complaint = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const contents = [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: bytes.toString('base64') } }, { text: promptFor(name, code, complaint) }] }];
    let answer;
    try {
      answer = await vertex.callModel({ model, location, signal: AbortSignal.timeout(90000) }, (m) => vertex.jsonBodies(m, contents, SCHEMA, 2048));
    } catch (error) {
      // a dropped connection or a busy service: once more after a short wait, then the error is the answer
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    const text = (answer.response?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      complaint = 'it was not valid JSON';
      continue;
    }
    const why = refusal(parsed);
    if (!why) return { record: { ...readStudio({ ...parsed, model: answer.model }), model: answer.model, generatedAt: Date.now(), basis: 'photo' }, attempts: attempt };
    complaint = why;
  }
  return { record: null, refused: complaint };
}

async function main() {
  if (flag('--undo')) return undo(path.resolve(ROOT, value('--undo')));
  const cfg = loadEnv();
  const signer = createGcsSigner({ config: () => ({ bucket: cfg.bucket, prefix: cfg.prefix, keyJson: cfg.keyJson, keyFile: cfg.keyFile }) });
  if (!signer.ready().ok) throw new Error(`the signing key is not usable: ${signer.ready().problem}`);
  const vertex = require(path.join(ROOT, 'swatchroom/server/google/vertex.js'));
  const studioConfig = require(path.join(ROOT, 'swatchroom/server/config.js'));
  const location = studioConfig.google.location || 'global';

  const mongoose = require('mongoose');
  await mongoose.connect(cfg.mongo, { serverSelectionTimeoutMS: 20000 });
  try {
    const items = mongoose.connection.db.collection('terucon_catalogue_items');
    let docs = await items.find({ catalogue: CATALOGUE, status: 'ok', 'shopImage.key': { $type: 'string' } }, { projection: { itemId: 1, productId: 1, label: 1, attributes: 1, shopImage: 1, studio: 1 } }).toArray();
    docs.sort((a, b) => (a.productId < b.productId ? -1 : 1));
    if (only) docs = docs.filter((d) => only.includes(d.productId));
    else if (!redo) docs = docs.filter((d) => !readStudio(d.studio));
    if (limit) docs = docs.slice(0, limit);
    console.log(`${docs.length} designs to describe with ${model}${apply ? '' : ' (PREVIEW: nothing is written; add --apply)'}`);

    const results = [];
    let next = 0;
    const worker = async () => {
      while (next < docs.length) {
        const doc = docs[next++];
        const code = doc.attributes?.code ?? doc.productId.replace('TIPL-', '');
        try {
          const found = await fetch(signer.signGet(doc.shopImage.key, { expiresS: 120 }));
          if (!found.ok) throw new Error(`picture answered ${found.status}`);
          const bytes = Buffer.from(await found.arrayBuffer());
          const out = await describeOne(vertex, location, bytes, doc.label ?? code, code);
          results.push({ doc, ...out });
          console.log(out.record ? `\n${doc.productId} ${doc.label}  [${out.record.model}, ${out.attempts} ask${out.attempts > 1 ? 's' : ''}]\n  look:    ${out.record.look}\n  colours: ${out.record.colours.join(', ')} | pattern: ${out.record.pattern} | grain: ${out.record.grain} | scale: ${out.record.scale} | sheen: ${out.record.sheen} | relief: ${out.record.relief}\n  render:  ${out.record.render}` : `\n${doc.productId} ${doc.label}: REFUSED twice (${out.refused}); left without a description`);
        } catch (error) {
          results.push({ doc, record: null, refused: String(error?.message ?? error).slice(0, 160) });
          console.log(`\n${doc.productId} ${doc.label}: FAILED (${String(error?.message ?? error).slice(0, 160)})`);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const good = results.filter((r) => r.record);
    console.log(`\n${good.length} described, ${results.length - good.length} not`);
    if (!apply || !good.length) return;

    fs.mkdirSync(BACKUPS, { recursive: true });
    const backup = path.join(BACKUPS, `describe-designs-${CATALOGUE}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}.json`); // one file per run: a second run must never overwrite the first run's backup
    fs.writeFileSync(backup, JSON.stringify({ catalogue: CATALOGUE, writtenAt: new Date().toISOString(), note: 'what each item held in `studio` before tools/describe-designs.js: undo with --undo <this file>', items: good.map((r) => ({ _id: r.doc._id, studio: r.doc.studio ?? null })) }, null, 1));
    console.log('backup written:', path.relative(ROOT, backup));
    for (const r of good) await items.updateOne({ _id: r.doc._id }, { $set: { studio: r.record } });
    // the export: every design that has a valid description now (the ones just written and the ones that were already there)
    const all = await items.find({ catalogue: CATALOGUE, status: 'ok', 'shopImage.key': { $type: 'string' } }, { projection: { productId: 1, studio: 1 } }).toArray();
    const detail = Object.fromEntries(all.sort((a, b) => (a.productId < b.productId ? -1 : 1)).map((d) => [d.productId, readStudio(d.studio)]).filter(([, s]) => s));
    fs.writeFileSync(EXPORT, JSON.stringify({ _comment: 'Written by tools/describe-designs.js from the studio field of the MongoDB items: what Gemini saw in each design\'s picture. Appearance only. Do not edit by hand.', catalogue: CATALOGUE, designs: detail }, null, 1) + '\n');
    console.log(`recorded ${good.length} in MongoDB; export: ${path.relative(ROOT, EXPORT)} (${Object.keys(detail).length} designs)`);
  } finally {
    await mongoose.disconnect();
  }
}

async function undo(file) {
  const cfg = loadEnv();
  const mongoose = require('mongoose');
  await mongoose.connect(cfg.mongo, { serverSelectionTimeoutMS: 20000 });
  try {
    const items = mongoose.connection.db.collection('terucon_catalogue_items');
    const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
    let n = 0;
    for (const entry of backup.items) n += (await items.updateOne({ _id: entry._id }, entry.studio ? { $set: { studio: entry.studio } } : { $unset: { studio: '' } })).modifiedCount;
    console.log(`undone: ${n} items changed back (${backup.items.length} in the backup). Run the tool's export step again or delete ${path.relative(ROOT, EXPORT)} if it should match.`);
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('FAILED:', String(error?.message ?? error).replace(/(\w[\w+.-]*:\/\/)[^\s/@]+@/g, '$1***@'));
    process.exit(1);
  });
}
