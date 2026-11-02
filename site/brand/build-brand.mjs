#!/usr/bin/env node
// Builds the logo derivatives in site/brand/ from the master artwork media/Terucon_logo.png.
//
//   node site/brand/build-brand.mjs [--out DIR] [--no-clean] [--master FILE]
//
// There is no image encoder on the build machine, so the installed Google Chrome does the pixel
// work (decode, crop, halving-step resize, WebP/PNG/JPEG encode through OffscreenCanvas) and Node
// writes the bytes. Needs puppeteer-core (it lives in tests/e2e/node_modules) and Chrome
// (CHROME_PATH to override the macOS default). Safe to re-run: every output is rewritten.
//
// Outputs (all under --out, default site/brand/):
//   logo-full-{320,640,1200}.webp, logo-full-640.png     the whole lockup, tight crop
//   logo-header-{160,320,480}.webp                       emblem + TERUCON wordmark, one line
//   logo-mark-{128,256,512}.webp, logo-mark-256.png      the emblem only, tight crop
//   favicon.ico (16/32/48 PNGs), favicon-32.png           transparent
//   apple-touch-icon.png (180), icon-192.png, icon-512.png, icon-maskable-512.png   on #1F150A
//   og-image.jpg (1200x630)
//   site.webmanifest
//
// The logo is cropped from the real artwork; nothing is retyped in a font.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const OUT = path.resolve(opt('--out', here));
const MASTER = path.resolve(opt('--master', path.join(root, 'media', 'Terucon_logo.png')));
const CLEAN = !args.includes('--no-clean');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const puppeteer = (await import(pathToFileURL(path.join(root, 'tests/e2e/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js')))).default;

fs.mkdirSync(OUT, { recursive: true });

// Everything inside this function runs in Chrome.
async function inBrowser(masterB64, o) {
  const BG = '#1F150A';
  const img = new Image();
  img.src = 'data:image/png;base64,' + masterB64;
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;

  const mk = (w, h) => {
    const c = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    const x = c.getContext('2d', { willReadFrequently: false });
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    return [c, x];
  };

  // 1. master + cleanup -------------------------------------------------------------------
  const [master, mctx] = mk(W, H);
  mctx.drawImage(img, 0, 0);
  const stats = { cleared: 0, neutralised: 0 };
  if (o.clean) {
    const id = mctx.getImageData(0, 0, W, H); const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a === 0) continue;
      if (a <= 3) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; stats.cleared++; continue; }
      if (a < 32) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (Math.max(r, g, b) - Math.min(r, g, b) > 60) {
          const l = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
          d[i] = d[i + 1] = d[i + 2] = l; stats.neutralised++;
        }
      }
    }
    mctx.putImageData(id, 0, 0);
  }

  // 2. boxes from row/column projections of solid pixels (alpha > 128) --------------------
  const solid = mctx.getImageData(0, 0, W, H).data;
  const rowCount = new Uint32Array(H);
  for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) if (solid[(y * W + x) * 4 + 3] > 128) n++; rowCount[y] = n; }
  const bands = []; let start = -1;
  for (let y = 0; y <= H; y++) {
    const on = y < H && rowCount[y] >= 4;
    if (on && start < 0) start = y;
    if (!on && start >= 0) { if (y - start > 6) bands.push([start, y - 1]); start = -1; }
  }
  const colRange = (y0, y1) => {
    let x0 = W, x1 = -1;
    for (let x = 0; x < W; x++) { let n = 0; for (let y = y0; y <= y1; y++) if (solid[(y * W + x) * 4 + 3] > 128) n++; if (n >= 2) { if (x < x0) x0 = x; if (x > x1) x1 = x; } }
    return [x0, x1];
  };
  // emblem = the first band; wordmark = the first tall band after the emblem; rest = INDIA / tagline
  const emblemBand = bands[0];
  const wordBand = bands.find((b, i) => i > 0 && (b[1] - b[0]) > 100);
  const lowerBand = bands[bands.length - 1];
  const [ex0, ex1] = colRange(emblemBand[0], emblemBand[1]);
  const [wx0, wx1] = colRange(wordBand[0], wordBand[1]);
  const [fx0, fx1] = colRange(emblemBand[0], lowerBand[1]);
  const box = {
    emblem: { x: ex0, y: emblemBand[0], w: ex1 - ex0 + 1, h: emblemBand[1] - emblemBand[0] + 1 },
    word: { x: wx0, y: wordBand[0], w: wx1 - wx0 + 1, h: wordBand[1] - wordBand[0] + 1 },
    full: { x: fx0, y: emblemBand[0], w: fx1 - fx0 + 1, h: lowerBand[1] - emblemBand[0] + 1 }
  };
  const PAD = 10; // keeps the soft shadow around the letters
  const pad = (b, p) => ({ x: Math.max(0, b.x - p), y: Math.max(0, b.y - p), w: Math.min(W, b.x + b.w + p) - Math.max(0, b.x - p), h: Math.min(H, b.y + b.h + p) - Math.max(0, b.y - p) });

  // 3. helpers ----------------------------------------------------------------------------
  const crop = (src, b) => { const [c, x] = mk(b.w, b.h); x.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h); return c; };
  // resize to width w in halving steps so thin LED strips do not alias
  const resizeW = (src, w) => {
    const h = Math.max(1, Math.round(src.height * w / src.width));
    let cur = src;
    while (cur.width > w) {
      const nw = Math.max(w, Math.ceil(cur.width / 2));
      const nh = nw === w ? h : Math.max(1, Math.round(cur.height * nw / cur.width));
      const [c, x] = mk(nw, nh); x.drawImage(cur, 0, 0, cur.width, cur.height, 0, 0, nw, nh); cur = c;
    }
    if (cur.width < w) { const [c, x] = mk(w, h); x.drawImage(cur, 0, 0, w, h); cur = c; }
    return cur;
  };
  const toB64 = async (canvas, type, quality) => {
    const blob = await canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };

  const emblem = crop(master, pad(box.emblem, PAD));
  const word = crop(master, pad(box.word, PAD));
  const full = crop(master, pad(box.full, PAD));

  // 4. header lockup: emblem + wordmark side by side, drawn from the two real crops ---------
  // wordmark at native size; emblem scaled so the wordmark's letters are o.headerRatio of the emblem height
  const eH = Math.round(word.height / o.headerRatio);
  const eW = Math.round(emblem.width * eH / emblem.height);
  const gap = Math.round(eH * 0.06);
  const [hdr, hx] = mk(eW + gap + word.width, Math.max(eH, word.height));
  const emblemScaled = resizeW(emblem, eW);
  hx.drawImage(emblemScaled, 0, Math.round((hdr.height - eH) / 2));
  hx.drawImage(word, eW + gap, Math.round((hdr.height - word.height) / 2) + o.wordDy);

  const out = {};
  const meta = { boxes: box, header: { w: hdr.width, h: hdr.height }, emblem: { w: emblem.width, h: emblem.height }, full: { w: full.width, h: full.height }, word: { w: word.width, h: word.height }, clean: stats };
  const Q = o.q;

  for (const w of [320, 640, 1200]) out[`logo-full-${w}.webp`] = await toB64(resizeW(full, w), 'image/webp', Q.full);
  out['logo-full-640.png'] = await toB64(resizeW(full, 640), 'image/png');
  for (const w of [160, 320, 480]) out[`logo-header-${w}.webp`] = await toB64(resizeW(hdr, w), 'image/webp', Q.header);
  for (const w of [128, 256, 512]) out[`logo-mark-${w}.webp`] = await toB64(resizeW(emblem, w), 'image/webp', Q.mark);
  out['logo-mark-256.png'] = await toB64(resizeW(emblem, 256), 'image/png');

  // 5. icons ------------------------------------------------------------------------------
  const markBig = resizeW(emblem, 640);
  const icon = async (size, frac, bg) => {
    const [c, x] = mk(size, size);
    if (bg) { x.fillStyle = bg; x.fillRect(0, 0, size, size); }
    const mw = Math.round(size * frac);
    const m = resizeW(markBig, mw);
    x.drawImage(m, Math.round((size - m.width) / 2), Math.round((size - m.height) / 2));
    return c;
  };
  out['apple-touch-icon.png'] = await toB64(await icon(180, 0.78, BG), 'image/png');
  out['icon-192.png'] = await toB64(await icon(192, 0.78, BG), 'image/png');
  out['icon-512.png'] = await toB64(await icon(512, 0.78, BG), 'image/png');
  out['icon-maskable-512.png'] = await toB64(await icon(512, 0.64, BG), 'image/png'); // mark diagonal inside the central 80% circle
  out['favicon-32.png'] = await toB64(await icon(32, 0.94, null), 'image/png');
  for (const s of [16, 48]) out[`_ico-${s}.png`] = await toB64(await icon(s, s === 16 ? 0.94 : 0.94, null), 'image/png');
  out['_ico-32.png'] = out['favicon-32.png'];

  // 6. social preview 1200x630 --------------------------------------------------------------
  {
    const [c, x] = mk(1200, 630);
    x.fillStyle = BG; x.fillRect(0, 0, 1200, 630);
    const g = x.createRadialGradient(600, 285, 20, 600, 285, 520);
    g.addColorStop(0, 'rgba(214,150,70,0.20)'); g.addColorStop(0.55, 'rgba(214,150,70,0.06)'); g.addColorStop(1, 'rgba(214,150,70,0)');
    x.fillStyle = g; x.fillRect(0, 0, 1200, 630);
    const lh = 470, lw = Math.round(full.width * lh / full.height);
    const L = resizeW(full, lw);
    x.drawImage(L, Math.round((1200 - L.width) / 2), Math.round((630 - L.height) / 2));
    out['og-image.jpg'] = await toB64(c, 'image/jpeg', Q.og);
  }
  return { out, meta };
}

// --- ICO container holding PNG images (Vista+ format, accepted by every current browser) ----
function buildIco(pngs) {
  const n = pngs.length;
  const head = Buffer.alloc(6 + 16 * n);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(n, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const p = 6 + 16 * i;
    head[p] = size >= 256 ? 0 : size; head[p + 1] = size >= 256 ? 0 : size; head[p + 2] = 0; head[p + 3] = 0;
    head.writeUInt16LE(1, p + 4); head.writeUInt16LE(32, p + 6);
    head.writeUInt32LE(data.length, p + 8); head.writeUInt32LE(offset, p + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const masterB64 = fs.readFileSync(MASTER).toString('base64');
  const params = {
    clean: CLEAN,
    headerRatio: Number(process.env.HEADER_RATIO || 0.5), // wordmark letter height / emblem height
    wordDy: Number(process.env.WORD_DY || 0),
    q: { full: 0.84, header: 0.9, mark: 0.9, og: 0.82 }
  };
  const { out, meta } = await page.evaluate(inBrowser, masterB64, params);
  const written = [];
  for (const [name, b64] of Object.entries(out)) {
    if (name.startsWith('_ico-')) continue;
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(path.join(OUT, name), buf);
    written.push([name, buf.length]);
  }
  const ico = buildIco([16, 32, 48].map((s) => ({ size: s, data: Buffer.from(out[`_ico-${s}.png`], 'base64') })));
  fs.writeFileSync(path.join(OUT, 'favicon.ico'), ico);
  written.push(['favicon.ico', ico.length]);

  const manifest = {
    name: 'Terucon India',
    short_name: 'Terucon',
    start_url: '/',
    display: 'standalone',
    theme_color: '#1F150A',
    background_color: '#1F150A',
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };
  const mbuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'site.webmanifest'), mbuf);
  written.push(['site.webmanifest', mbuf.length]);

  console.log('master', path.relative(root, MASTER), 'clean:', CLEAN, JSON.stringify(meta.clean));
  console.log('boxes', JSON.stringify(meta.boxes));
  console.log('header canvas', meta.header.w + 'x' + meta.header.h, 'emblem', meta.emblem.w + 'x' + meta.emblem.h, 'full', meta.full.w + 'x' + meta.full.h);
  for (const [n, b] of written.sort()) console.log(String(b).padStart(8), n);
} finally {
  await browser.close();
}
