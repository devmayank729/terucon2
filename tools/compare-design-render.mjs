#!/usr/bin/env node
// Does the reference photograph make a render match the design? A live A/B/C test with the studio's own Gemini path (targets C1, A1).
//
//   node tools/compare-design-render.mjs --photo room.jpg --polygon "945,98;1255,6;1255,295;1122,295;1122,432;945,432" --designs TIPL-SB804,TIPL-SB008 [--out DIR] [--model gemini-3.1-flash-image]
//
// --polygon is the surface to change, in the photo's own pixels. For each design it makes three renders of the SAME photo and surface, changing only what the model
// is told, exactly as the studio would send it (public/js/lib/prompts.js renderBrief + RENDER_SYSTEM_PROMPT, the studio's server/google/vertex.js):
//   A  name and colour only       what a catalogue entry would be with no description and no picture
//   B  the Gemini description     text only, no picture
//   C  description + photograph   what the studio does now (server/catalogue/studioFinishes.js withReference)
// and writes ab-<code>-A/B/C images plus the design's own picture to --out, for a person to look at. It costs real Gemini image requests (about 25 s each; a quota
// error means wait a minute). Whether C looks right is judged by eye, not by this script. Needs .env (Google key, MongoDB, bucket) and Chrome for the mask.
//
// Result of the first run (2026-11-04): docs/design-studio-checks/catalogue-reference/.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const SP = path.resolve(arg('--out', process.cwd()));
fs.mkdirSync(SP, { recursive: true });
const require = createRequire(ROOT + '/package.json');
const puppeteer = createRequire(ROOT + '/tests/e2e/package.json')('puppeteer-core');
const { RENDER_SYSTEM_PROMPT, renderBrief } = await import(ROOT + '/swatchroom/public/js/lib/prompts.js');
const { briefOf, withReference, stripMarker } = await import(ROOT + '/server/catalogue/studioFinishes.js');
const vertex = require(ROOT + '/swatchroom/server/google/vertex.js');
const studioConfig = require(ROOT + '/swatchroom/server/config.js');
const dotenv = require('dotenv');
const { createGcsSigner } = await import(ROOT + '/server/catalogue/gcsSigner.js');

const photoFile = path.resolve(arg('--photo', ''));
if (!fs.existsSync(photoFile)) throw new Error('--photo <a JPEG of a room> is needed');
const size = (await import('node:child_process')).execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', photoFile]).toString(); // macOS
const W = Number(/pixelWidth: (\d+)/.exec(size)[1]), H = Number(/pixelHeight: (\d+)/.exec(size)[1]);
const polygon = arg('--polygon', '').split(';').filter(Boolean).map((p) => p.split(',').map(Number)).map(([x, y]) => [Math.round(x / W * 1000), Math.round(y / H * 1000)]);
if (polygon.length < 3) throw new Error('--polygon "x,y;x,y;x,y..." (the surface, in the photo\'s pixels) is needed');

// mask + guide through Chrome's canvas
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const photoB64 = fs.readFileSync(photoFile).toString('base64');
const made = await page.evaluate(async (b64, poly, w, h) => {
  const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode();
  const path = (ctx) => { ctx.beginPath(); poly.forEach(([x, y], i) => { const px = x / 1000 * w, py = y / 1000 * h; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.closePath(); };
  const m = document.createElement('canvas'); m.width = w; m.height = h; const mc = m.getContext('2d'); mc.fillStyle = '#000'; mc.fillRect(0, 0, w, h); mc.fillStyle = '#fff'; path(mc); mc.fill(); mc.lineWidth = 5; mc.strokeStyle = '#fff'; mc.stroke();
  const g = document.createElement('canvas'); g.width = w; g.height = h; const gc = g.getContext('2d'); gc.drawImage(img, 0, 0, w, h); gc.fillStyle = 'rgba(255,0,200,0.22)'; path(gc); gc.fill(); gc.lineWidth = 3; gc.strokeStyle = '#ff00c8'; gc.stroke();
  return { mask: m.toDataURL('image/png').split(',')[1], guide: g.toDataURL('image/jpeg', 0.9).split(',')[1] };
}, photoB64, polygon, W, H);
await browser.close();
fs.writeFileSync(SP + '/ab-mask.png', Buffer.from(made.mask, 'base64'));
fs.writeFileSync(SP + '/ab-guide.jpg', Buffer.from(made.guide, 'base64'));

// the designs: names, codes, colours from the shop data; Gemini's description from the export; the picture from the bucket through the real signer
const shop = Object.fromEntries(JSON.parse(fs.readFileSync(ROOT + '/catalogue/data/superbond-colour-shop.json', 'utf8')).products.map((p) => [p.id, p]));
const detail = JSON.parse(fs.readFileSync(ROOT + '/catalogue/data/superbond-colour-detail.json', 'utf8')).designs;
const env = dotenv.parse(fs.readFileSync(ROOT + '/.env'));
const signer = createGcsSigner({ config: () => ({ bucket: env.CATALOGUE_GCS_BUCKET, prefix: 'catalogue/', keyJson: (env.CATALOGUE_GCS_KEY_FILE || '').trim(), keyFile: '' }) });
const mongoose = require('mongoose'); await mongoose.connect(env.MONGODB_URI);
const items = mongoose.connection.db.collection('terucon_catalogue_items');

async function designOf(productId) {
  const p = shop[productId];
  const doc = await items.findOne({ productId, 'shopImage.key': { $type: 'string' } }, { projection: { shopImage: 1 } });
  const r = await fetch(signer.signGet(doc.shopImage.key, { expiresS: 120 }));
  return { design: { id: productId.toLowerCase(), productId, code: p.code, name: p.printedName.split(/\s+/).map((w) => w[0] + w.slice(1).toLowerCase()).join(' '), hex: p.meanHex, studio: detail[productId] }, picture: { bytes: Buffer.from(await r.arrayBuffer()), type: 'image/jpeg' } };
}

const model = arg('--model', 'gemini-3.1-flash-image');
const location = studioConfig.google.location || 'global';
const box = { ymin: Math.min(...polygon.map((p) => p[1])), xmin: Math.min(...polygon.map((p) => p[0])), ymax: Math.max(...polygon.map((p) => p[1])), xmax: Math.max(...polygon.map((p) => p[0])) };
const baseParts = () => [{ inlineData: { mimeType: 'image/jpeg', data: photoB64 } }, { inlineData: { mimeType: 'image/png', data: made.mask } }, { inlineData: { mimeType: 'image/jpeg', data: made.guide } }];

function briefFor(prompt, name, sub) {
  return renderBrief({ width: W, height: H, crop: false, guide: true, geometry: null, label: 'Wall', kind: 'wall', partCount: 1, box, polygon, areaShare: Math.abs(polygon.reduce((a, [x, y], i) => a + (x * polygon[(i + 1) % polygon.length][1] - polygon[(i + 1) % polygon.length][0] * y), 0)) / 2 / 1e6, centerX: (box.xmin + box.xmax) / 2, centerY: (box.ymin + box.ymax) / 2, item: { mode: 'surface', name, sub, prompt }, style: '', notes: '' });
}

async function render(label, body, outName) {
  const t0 = Date.now();
  const answer = await vertex.callModel({ model, location, signal: AbortSignal.timeout(180000) }, (m) => vertex.imageBodies(m, body.parts, body.brief, body.systemPrompt, '3:2', '2K'));
  const parts = answer.response?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData || p.inline_data);
  const d = img && (img.inlineData || img.inline_data);
  if (!d) { console.log(label, 'NO IMAGE:', parts.map((p) => (p.text || '').slice(0, 120)).join(' | ')); return; }
  fs.writeFileSync(`${SP}/${outName}.${(d.mimeType || d.mime_type || 'image/png').includes('jpeg') ? 'jpg' : 'png'}`, Buffer.from(d.data, 'base64'));
  console.log(label, 'ok', answer.model, ((Date.now() - t0) / 1000).toFixed(1) + 's', outName);
}

const ids = arg('--designs', 'TIPL-SB804').split(',');
for (const productId of ids) {
  const { design, picture } = await designOf(productId);
  const tag = design.code.toLowerCase();
  // A: what a catalogue entry would be with no description and no picture
  const aPrompt = `Apply the Terucon catalogue design "${design.name}" (code ${design.code}) to the surface. Its dominant colour is close to ${design.hex}.`;
  // B: the Gemini description as text only (marker removed, no picture)
  const bPrompt = stripMarker(briefOf(design));
  // C: description + marker, then the server's step: picture + rules
  const cBriefText = briefFor(briefOf(design), design.name, `${design.code}`);
  const c = withReference(design, picture, { parts: baseParts(), brief: cBriefText, systemPrompt: RENDER_SYSTEM_PROMPT });
  console.log('C picture is Image', c.imageNumber, '; brief ends:', c.brief.slice(-170).replace(/\n/g, ' / '));
  const jobs = [
    ['A', { parts: baseParts(), brief: briefFor(aPrompt, design.name, design.code), systemPrompt: RENDER_SYSTEM_PROMPT }, `ab-${tag}-A-name-only`],
    ['B', { parts: baseParts(), brief: briefFor(bPrompt, design.name, design.code), systemPrompt: RENDER_SYSTEM_PROMPT }, `ab-${tag}-B-text-only`],
    ['C', { parts: c.parts, brief: c.brief, systemPrompt: c.systemPrompt }, `ab-${tag}-C-reference`],
  ];
  for (const [label, body, out] of jobs.filter(([l]) => !process.env.ONLY || process.env.ONLY.includes(l))) { await render(`${productId} ${label}`, body, out).catch((e) => console.log(productId, label, 'FAILED', String(e.message).slice(0, 200))); await new Promise((r) => setTimeout(r, 4000)); }
  fs.writeFileSync(`${SP}/ab-${tag}-reference.jpg`, picture.bytes);
}
await mongoose.disconnect();
