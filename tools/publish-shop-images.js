#!/usr/bin/env node
// Put the shop pictures of the catalogue designs where they belong: in the catalogue's Cloud Storage bucket, with a pointer in MongoDB (targets A1, C1).
//
//   node tools/publish-shop-images.js                     DRY RUN: says what it would do, writes nothing
//   node tools/publish-shop-images.js --apply             upload, check, record
//   node tools/publish-shop-images.js --undo <backup>     take the records out again (the objects are left in the bucket: see "Undo")
//
// Until now each design's 800 px picture was a file of this project (media/materials/tipl-*.jpg, 8 MB, copied into every deploy). They belong with the
// catalogue's other pictures. For each design of catalogue/data/superbond-colour-shop.json this
//   1. reads the picture (media/materials/<id>.jpg) and its sha256,
//   2. uploads it to <CATALOGUE_GCS_PREFIX>cards/<catalogue>/<itemId>.jpg through a signed PUT (the same signing key the website uses; no SDK, nothing else),
//   3. downloads it again through a signed GET and compares the bytes (an upload nobody read back is not a fact),
//   4. records it on the design's first page's MongoDB item as `shopImage: {key, width, height, bytes, sha256, uploadedAt}`.
// `shopImage` is a field of its own, NOT inside `images`: the catalogue engine rewrites `images` whenever the PDF is ingested again
// (catalogue/terucon_catalogue/mongo.py PUBLISHER_OWNED), it never touches a field it does not know.
//
// Undo. Before anything is written a backup is saved to catalogue/data/backups/shop-images-<catalogue>-<date>.json (what each item had: nothing). --undo
// removes `shopImage` from those items. The uploaded objects stay in the bucket (the tool has no signed DELETE; they are 8 MB and nothing points at
// them once the records are gone; delete the prefix cards/<catalogue>/ in the Cloud Console if you want them gone).
//
// Secrets: .env is read in memory only; nothing of it is printed. The signing key is CATALOGUE_GCS_KEY_JSON; a key pasted into CATALOGUE_GCS_KEY_FILE (a
// mistake the .env of 2026-11-04 has) is recognised, used from memory and reported by name only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createGcsSigner } from '../server/catalogue/gcsSigner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const DATA = path.join(ROOT, 'catalogue/data/superbond-colour-shop.json');
const BACKUPS = path.join(ROOT, 'catalogue/data/backups');
const MAX_BYTES = 6 * 1024 * 1024;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const undoIndex = args.indexOf('--undo');
const undoFile = undoIndex >= 0 ? args[undoIndex + 1] : null;

function loadEnv() {
  const dotenv = require('dotenv');
  const env = dotenv.parse(fs.readFileSync(path.join(ROOT, '.env')));
  const text = (env.CATALOGUE_GCS_KEY_JSON || env.CATALOGUE_GCS_KEY_FILE || '').trim();
  const inline = text.startsWith('{') || (text && !text.includes('/') && /^[A-Za-z0-9+/=_-]{200,}$/.test(text));
  return {
    bucket: env.CATALOGUE_GCS_BUCKET,
    prefix: (env.CATALOGUE_GCS_PREFIX || 'catalogue/').replace(/\/?$/, '/'),
    keyJson: inline ? text : '',
    keyFile: inline ? '' : text ? path.resolve(ROOT, text) : '',
    mongo: env.MONGODB_URI,
    keyWas: env.CATALOGUE_GCS_KEY_JSON ? 'CATALOGUE_GCS_KEY_JSON' : inline ? 'CATALOGUE_GCS_KEY_FILE (the key text is in the file variable: it should be in CATALOGUE_GCS_KEY_JSON)' : 'CATALOGUE_GCS_KEY_FILE (a path)',
  };
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function main() {
  const cfg = loadEnv();
  if (!cfg.bucket || !cfg.mongo || (!cfg.keyJson && !cfg.keyFile)) throw new Error('.env needs CATALOGUE_GCS_BUCKET, MONGODB_URI and the signing key (CATALOGUE_GCS_KEY_JSON).');
  const signer = createGcsSigner({ config: () => ({ bucket: cfg.bucket, prefix: cfg.prefix, keyJson: cfg.keyJson, keyFile: cfg.keyFile }) });
  const ready = signer.ready();
  if (!ready.ok) throw new Error(`the signing key is not usable: ${ready.problem}`);
  console.log(`bucket ${cfg.bucket}, prefix ${cfg.prefix}, signing as ${ready.clientEmail} (key from ${cfg.keyWas})`);

  const mongoose = require('mongoose');
  await mongoose.connect(cfg.mongo, { serverSelectionTimeoutMS: 20000 });
  try {
    const items = mongoose.connection.db.collection('terucon_catalogue_items');
    if (undoFile) return await undo(items, path.resolve(ROOT, undoFile));

    const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const catalogue = data.catalogue;
    const plan = [];
    const problems = [];
    for (const product of data.products) {
      const file = path.join(ROOT, product.image);
      if (!fs.existsSync(file)) {
        problems.push(`${product.id}: ${product.image} is not on disk`);
        continue;
      }
      const doc = await items.findOne({ catalogue, productId: product.id, 'source.page': product.pages[0] }, { projection: { itemId: 1, status: 1, shopImage: 1 } });
      if (!doc || doc.status !== 'ok') {
        problems.push(`${product.id}: no visible item on page ${product.pages[0]}`);
        continue;
      }
      const bytes = fs.readFileSync(file);
      if (bytes.length > MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        problems.push(`${product.id}: ${product.image} is not a JPEG of at most ${MAX_BYTES} bytes`);
        continue;
      }
      plan.push({ product, doc, bytes, key: `cards/${catalogue}/${doc.itemId}.jpg`, sha: sha256(bytes), had: doc.shopImage ?? null });
    }
    console.log(`${plan.length} pictures ready, ${problems.length} problems${apply ? '' : ' (DRY RUN: nothing is written; add --apply)'}`);
    for (const p of problems) console.log('  problem:', p);
    if (problems.length) throw new Error('fix the problems above first');
    const already = plan.filter((p) => p.had?.sha256 === p.sha).length;
    console.log(`${already} of them are already recorded with the same bytes`);
    if (!apply) return;

    fs.mkdirSync(BACKUPS, { recursive: true });
    const backup = path.join(BACKUPS, `shop-images-${catalogue}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}.json`); // one file per run
    fs.writeFileSync(backup, JSON.stringify({ catalogue, writtenAt: new Date().toISOString(), note: 'what each item had before tools/publish-shop-images.js: undo with --undo <this file>', items: plan.map((p) => ({ _id: p.doc._id, shopImage: p.had, key: p.key })) }, null, 1));
    console.log('backup written:', path.relative(ROOT, backup));

    let done = 0;
    for (const p of plan) {
      const put = signer.signPut(p.key, { contentType: 'image/jpeg', maxBytes: MAX_BYTES });
      const up = await fetch(put.url, { method: 'PUT', headers: put.headers, body: p.bytes });
      if (!up.ok) throw new Error(`${p.product.id}: upload answered ${up.status}`);
      const back = await fetch(signer.signGet(p.key, { expiresS: 120 }));
      const got = Buffer.from(await back.arrayBuffer());
      if (!back.ok || sha256(got) !== p.sha) throw new Error(`${p.product.id}: the bytes read back from the bucket are not the bytes uploaded`);
      await items.updateOne({ _id: p.doc._id }, { $set: { shopImage: { key: p.key, width: p.product.width, height: p.product.height, bytes: p.bytes.length, sha256: p.sha, uploadedAt: Date.now() } } });
      done += 1;
      if (done % 10 === 0 || done === plan.length) console.log(`  ${done}/${plan.length} uploaded, read back and recorded`);
    }
    console.log('done.');
  } finally {
    await mongoose.disconnect();
  }
}

async function undo(items, file) {
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  for (const entry of backup.items) {
    const update = entry.shopImage ? { $set: { shopImage: entry.shopImage } } : { $unset: { shopImage: '' } };
    const r = await items.updateOne({ _id: entry._id }, update);
    n += r.modifiedCount;
  }
  console.log(`undone: ${n} items changed back (${backup.items.length} in the backup). The objects under cards/ stay in the bucket.`);
}

main().catch((error) => {
  console.error('FAILED:', String(error?.message ?? error).replace(/(\w[\w+.-]*:\/\/)[^\s/@]+@/g, '$1***@'));
  process.exit(1);
});
