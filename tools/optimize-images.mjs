#!/usr/bin/env node
// Make responsive WebP copies of every photo the four bundled pages use.
//
//   node tools/optimize-images.mjs            encode what is missing or out of date (needs Chrome)
//   node tools/optimize-images.mjs --check    exit 1 if site/optimized/index.json is stale or a file is missing
//                                             (plain Node: no Chrome, no puppeteer)
//   node tools/optimize-images.mjs --force    encode everything again
//   node tools/optimize-images.mjs --prune    also delete files in site/optimized/ that index.json no longer lists
//   node tools/optimize-images.mjs --report   only print coverage (sources, dead files, missing files), change nothing
//   node tools/optimize-images.mjs --only NAME[,NAME]   limit the encode to these names (index entries of the others are kept)
//
// There is no image encoder on the machines this project is built on (no cwebp, sharp, magick), so the encoding is done
// by the Chrome that is installed: each source is decoded with createImageBitmap, scaled down in halving steps with
// high-quality smoothing, and encoded with OffscreenCanvas.convertToBlob({type: 'image/webp', quality}). The OUTPUTS are
// committed (site/optimized/), because the Docker image has no encoder: tools/build-dist.js only reads index.json.
// Format and rules: site/optimized/README.md.
//
// What counts as a source (each is hashed once: the key in index.json is the sha256 of the SOURCE bytes):
//   1. every image/jpeg or image/png asset in the manifest of pages/{home,materials,studio,dashboard}.html;
//   2. every media/<file>.jpg|png named by the page templates or by site/patches/** as "media/..." or "/media/...".
// Not sources: the brand logos (media/Terucon_logo.png, media/image*.png) and the videos.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bundle } from './bundle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = path.join(ROOT, 'site', 'optimized');
export const INDEX_FILE = path.join(OUT_DIR, 'index.json');
const MEDIA_DIR = path.join(ROOT, 'media');
const PAGES = ['home', 'materials', 'studio', 'dashboard'];
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PUPPETEER = path.join(ROOT, 'tests', 'e2e', 'node_modules', 'puppeteer-core', 'lib', 'esm', 'puppeteer', 'puppeteer-core.js');

/** Never touched: the brand artwork (BRAND makes its own derivatives under site/brand/) and anything that is not a photo. */
const NOT_PHOTOS = /^(Terucon_logo|image[^/]*)\.png$/i;

// ---- sizes and quality -------------------------------------------------------------------------------------------------
/** Widths made for every source that is at least this wide; never larger than the source (no upscaling). */
export const WIDTHS = [640, 1280, 1920];
export const MAX_WIDTH = 1920;
/** A source narrower than the next step but wider than this factor times the biggest standard step also gets a variant at its own width. */
const NATIVE_FACTOR = 1.25;

/**
 * WebP quality (0..1) per image. Chrome switches to LOSSLESS at exactly 1, so the highest value used here is below 1.
 * 0.85 is the default for photographs. At 0.80 the smooth regions (dusk sky, water, plaster, dark walls) turn into
 * soft 16-pixel patches when the contrast is stretched 5x, so 0.80 was rejected; 0.85 is clean at that stretch for the
 * busy pictures. The first matching rule below wins; the reasons are in site/optimized/README.md ("Quality choices").
 */
export const DEFAULT_QUALITY = 0.85;
export const QUALITY_RULES = [
  // the two hero/craft posters: dark gradients, painted first; their JPEGs are already blocky, so do not add to it
  [/^(a01-hero|v02-craft)$/, 0.88],
  // night/dusk scenes with large smooth skies and dark walls
  [/^(p03-showroom|s05-monolith)$/, 0.88],
  // material macros: the grain and trowel marks are the subject
  [/^m0[1-6]-/, 0.88],
  // the 640x800 swatches: flat and faintly grained; low quality smooths the grain into 16-pixel patches
  [/^(acp|iacp|hc|hd|gl|lp|mc|sp|st|trc)-/, 0.88],
];
export function qualityFor(name) {
  for (const [re, q] of QUALITY_RULES) if (re.test(name)) return q;
  return DEFAULT_QUALITY;
}

/** Widths for a source of width `w`: 640/1280/1920 that fit, plus the source's own width when it falls well between steps. */
export function planWidths(w) {
  const std = WIDTHS.filter((x) => x <= w);
  if (!std.length) return [w]; // narrower than 640: one variant at the source width
  const top = std[std.length - 1];
  if (w > top * NATIVE_FACTOR && w <= MAX_WIDTH) std.push(w);
  return std;
}

// ---- finding the sources -----------------------------------------------------------------------------------------------
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MEDIA_REF = /(?<![A-Za-z0-9_.-])\/?media\/((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:jpe?g|png))/gi;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/**
 * Everything the pages use. Returns
 *   sources   [{sha, name, source, mime, bytes: Buffer, alpha}]   one per distinct byte content, first seen wins
 *   duplicates [{sha, name, source}]                                same bytes found again (informational)
 *   mediaRefs  Map<"media/x.jpg", [where...]>                       every raster media URL in templates/patches
 *   missing    ["media/x.jpg" ...]                                  referenced but not on disk
 *   deadMedia  ["media/x.png" ...]                                  raster files in media/ nothing references (logos excluded)
 *   gaps       [string ...]                                         references built at run time that have no file
 */
export function collectSources({ root = ROOT } = {}) {
  const sources = new Map();
  const duplicates = [];
  const mediaRefs = new Map();
  const gaps = [];

  const add = (name, source, mime, bytes) => {
    const sha = sha256(bytes);
    if (sources.has(sha)) {
      duplicates.push({ sha, name, source });
      return;
    }
    const alpha = mime === 'image/png' && pngHasAlpha(bytes);
    sources.set(sha, { sha, name, source, mime, bytes, alpha });
  };
  const note = (file, where) => {
    const key = `media/${file}`;
    if (!mediaRefs.has(key)) mediaRefs.set(key, []);
    const list = mediaRefs.get(key);
    if (!list.includes(where)) list.push(where);
  };

  // 1. images embedded in the page bundles; 2a. media/ URLs in their templates
  for (const page of PAGES) {
    const file = path.join(root, 'pages', `${page}.html`);
    if (!fs.existsSync(file)) continue;
    const b = Bundle.load(file);
    const extName = new Map();
    for (const e of b._ext) {
      const m = /^media\/(?:[A-Za-z0-9_-]+\/)*([A-Za-z0-9_.-]+)\.(?:jpe?g|png)$/i.exec(e.id);
      if (m) extName.set(e.uuid, m[1]);
    }
    for (const uuid of b.uuids) {
      const mime = b.mime(uuid);
      if (mime !== 'image/jpeg' && mime !== 'image/png') continue;
      add(extName.get(uuid) || `${page}-${uuid.slice(0, 8)}`, `bundle:${page}:${uuid}`, mime, b.asset(uuid));
    }
    for (const m of b.template.matchAll(MEDIA_REF)) note(m[1], `pages/${page}.html`);
    gaps.push(...computedGaps(page, b));
  }

  // 2b. media/ URLs in the patches (site/patches/**; the README there is documentation, not a patch)
  const patchDir = path.join(root, 'site', 'patches');
  if (fs.existsSync(patchDir)) {
    for (const p of walk(patchDir)) {
      if (/README\.md$/i.test(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(MEDIA_REF)) note(m[1], path.relative(root, p));
    }
  }

  // media/ files named by the above
  const missing = [];
  const mediaDir = path.join(root, 'media');
  for (const [key, where] of [...mediaRefs].sort()) {
    const rel = key.slice('media/'.length);
    if (NOT_PHOTOS.test(path.basename(rel))) continue;
    const file = path.join(mediaDir, rel);
    if (!fs.existsSync(file)) {
      missing.push(`${key} (named in ${where.join(', ')})`);
      continue;
    }
    const ext = path.extname(rel).toLowerCase();
    add(path.basename(rel, ext), key, ext === '.png' ? 'image/png' : 'image/jpeg', fs.readFileSync(file));
  }

  const deadMedia = fs.existsSync(mediaDir)
    ? fs
        .readdirSync(mediaDir)
        .filter((f) => /\.(jpe?g|png)$/i.test(f) && !NOT_PHOTOS.test(f) && !mediaRefs.has(`media/${f}`))
        .map((f) => `media/${f}`)
    : [];

  // Same name for different bytes would give two files with the same stem; the sha8 in the file name keeps them apart.
  return {
    sources: [...sources.values()].sort((a, b) => a.name.localeCompare(b.name) || a.sha.localeCompare(b.sha)),
    duplicates,
    mediaRefs,
    missing,
    deadMedia,
    gaps,
  };
}

/**
 * The dashboard builds `media/materials/<id>.jpg` at run time (IMGR(fid + '.jpg') falls back to that path when
 * window.__resources has no 'm-<id>'). Names that are used but have no embedded photo and no file are gaps.
 */
function computedGaps(page, bundle) {
  const out = [];
  const ids = new Set(bundle._ext.map((e) => e.id));
  const t = bundle.template;
  if (!/const\s+IMGR\s*=/.test(t)) return out;
  const fids = new Set([...t.matchAll(/\bM\(\s*'[^']+'\s*,\s*'([^']+)'/g)].map((m) => m[1]));
  for (const fid of [...fids].sort()) {
    if (ids.has(`m-${fid}`) || ids.has(`media/materials/${fid}.jpg`)) continue;
    if (fs.existsSync(path.join(ROOT, 'media', 'materials', `${fid}.jpg`))) continue;
    out.push(`media/materials/${fid}.jpg: used by pages/${page}.html (IMGR('${fid}.jpg')) but neither embedded as 'm-${fid}' nor on disk`);
  }
  return out;
}

/** PNG colour type 4/6 or a tRNS chunk means the picture has transparency. */
function pngHasAlpha(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return false;
  const colourType = buf[25];
  if (colourType === 4 || colourType === 6) return true;
  return buf.includes(Buffer.from('tRNS'));
}

// ---- index.json --------------------------------------------------------------------------------------------------------
export function readIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (j && j.version === 1 && j.items) return j;
  } catch {
    // missing or unreadable: start empty
  }
  return { version: 1, items: {} };
}

/** Deterministic: items ordered by name then sha, fixed field order, so a re-run that changes nothing changes no byte. */
export function writeIndex(index) {
  const entries = Object.entries(index.items).sort(
    ([ka, a], [kb, b]) => (a.name || '').localeCompare(b.name || '') || ka.localeCompare(kb)
  );
  const items = {};
  for (const [sha, it] of entries) {
    items[sha] = {
      source: it.source,
      name: it.name,
      width: it.width,
      height: it.height,
      quality: it.quality,
      variants: [...it.variants]
        .sort((a, b) => a.w - b.w)
        .map((v) => ({ w: v.w, h: v.h, file: v.file, bytes: v.bytes })),
    };
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = `${INDEX_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, items }, null, 2)}\n`);
  fs.renameSync(tmp, INDEX_FILE);
}

export const variantFile = (name, sha, w) => `${name}-${sha.slice(0, 8)}-${w}.webp`;

/** Problems with one index item, using only the file system (no decoding). */
function itemProblems(src, item, listedFiles) {
  const out = [];
  if (!item) return [`${src.name} (${src.source}): not in index.json`];
  const want = qualityFor(src.name);
  if (item.quality !== want) out.push(`${src.name}: encoded at quality ${item.quality}, the tool now says ${want}`);
  if (!item.variants?.length) out.push(`${src.name}: no variants`);
  let prev = 0;
  for (const v of item.variants || []) {
    listedFiles.add(v.file);
    if (v.w <= prev) out.push(`${src.name}: variants not in ascending width order`);
    prev = v.w;
    if (v.w > item.width) out.push(`${src.name}: variant ${v.w} is wider than the source (${item.width})`);
    if (v.w > MAX_WIDTH) out.push(`${src.name}: variant ${v.w} is wider than ${MAX_WIDTH}`);
    const f = path.join(OUT_DIR, v.file);
    if (!fs.existsSync(f)) out.push(`${src.name}: file missing: ${v.file}`);
    else {
      const st = fs.statSync(f);
      if (st.size !== v.bytes) out.push(`${src.name}: ${v.file} is ${st.size} bytes, index.json says ${v.bytes}`);
      const head = Buffer.alloc(12);
      const fd = fs.openSync(f, 'r');
      fs.readSync(fd, head, 0, 12, 0);
      fs.closeSync(fd);
      if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WEBP') out.push(`${src.name}: ${v.file} is not a WebP file`);
    }
  }
  const planned = planWidths(item.width).join(',');
  const have = (item.variants || []).map((v) => v.w).join(',');
  if (planned !== have) out.push(`${src.name}: widths are ${have}, the rules now give ${planned}`);
  return out;
}

export function check(found = collectSources()) {
  const index = readIndex();
  const problems = [];
  const listedFiles = new Set();
  const seen = new Set();
  for (const src of found.sources) {
    seen.add(src.sha);
    problems.push(...itemProblems(src, index.items[src.sha], listedFiles));
  }
  for (const [sha, it] of Object.entries(index.items)) {
    if (!seen.has(sha)) {
      problems.push(`${it.name} (${it.source}): in index.json but no page uses these bytes any more (run with --prune)`);
      for (const v of it.variants || []) listedFiles.add(v.file);
    }
  }
  const onDisk = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.webp')) : [];
  for (const f of onDisk) if (!listedFiles.has(f)) problems.push(`${f}: on disk but not in index.json (run with --prune)`);
  for (const m of found.missing) problems.push(`referenced but not on disk: ${m}`);
  return problems;
}

// ---- encoding in Chrome ------------------------------------------------------------------------------------------------
/** Runs inside the page: decode the picture once and keep the bitmap for the encode calls that follow. */
const LOAD_IN_PAGE = async (b64, mime) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bin], { type: mime }));
  window.__bmp = bmp;
  return { width: bmp.width, height: bmp.height };
};

/**
 * Runs inside the page. For each width draws the loaded picture scaled down (halving steps while the next half is still
 * at least the target, then one last step; never upscaled) and encodes it as WebP.
 */
const ENCODE_IN_PAGE = async (widths, quality, hasAlpha) => {
  const bmp = window.__bmp;
  const make = (w, h) => {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d', { alpha: hasAlpha });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    return [c, g];
  };
  const variants = [];
  for (const w of widths) {
    if (w > bmp.width) continue;
    const h = Math.max(1, Math.round((bmp.height * w) / bmp.width));
    let cur = bmp;
    let cw = bmp.width;
    let ch = bmp.height;
    while (cw / 2 >= w * 1.0001 && cw > 1) {
      const nw = Math.round(cw / 2);
      const nh = Math.round(ch / 2);
      const [c, g] = make(nw, nh);
      g.drawImage(cur, 0, 0, nw, nh);
      cur = c;
      cw = nw;
      ch = nh;
    }
    const [c, g] = make(w, h);
    g.drawImage(cur, 0, 0, w, h);
    const blob = await c.convertToBlob({ type: 'image/webp', quality });
    if (blob.type !== 'image/webp') throw new Error(`Chrome returned ${blob.type} instead of image/webp`);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    variants.push({ w, h, b64: btoa(s) });
  }
  return variants;
};

/** Opens Chrome once; returns {load(src), encode(src, widths, quality), close()}. puppeteer-core is loaded only here. */
export async function openEncoder() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_PATH)`);
  if (!fs.existsSync(PUPPETEER)) throw new Error(`puppeteer-core not found at ${PUPPETEER} (run npm install in tests/e2e)`);
  const { default: puppeteer } = await import(pathToFileURL(PUPPETEER).href);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('about:blank');
  return {
    /** decode a source; returns its size (EXIF orientation applied) */
    load: (src) => page.evaluate(LOAD_IN_PAGE, src.bytes.toString('base64'), src.mime),
    /** encode the loaded source at these widths; returns [{w, h, b64}] */
    encode: (src, widths, quality) => page.evaluate(ENCODE_IN_PAGE, widths, quality, src.alpha),
    page,
    close: () => browser.close(),
  };
}

// ---- main --------------------------------------------------------------------------------------------------------------
const fmtKB = (n) => `${(n / 1024).toFixed(0)} KB`;

function printCoverage(found) {
  console.log(`${found.sources.length} distinct images (${found.duplicates.length} more with the same bytes as one already listed)`);
  const by = {};
  for (const s of found.sources) {
    const k = s.source.startsWith('bundle:') ? s.source.split(':')[1] : 'media/';
    by[k] = (by[k] || 0) + 1;
  }
  console.log(`  by origin: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (found.duplicates.length) console.log(`  same bytes as another entry: ${found.duplicates.map((d) => d.source.replace('bundle:', '')).length} (all in ${[...new Set(found.duplicates.map((d) => d.source.split(':')[1]))].join(', ')})`);
  console.log(`referenced media/ photos: ${[...found.mediaRefs.keys()].filter((k) => !NOT_PHOTOS.test(path.basename(k))).length}`);
  if (found.missing.length) console.log(`MISSING files:\n  ${found.missing.join('\n  ')}`);
  if (found.deadMedia.length) console.log(`raster files in media/ that no page or patch names:\n  ${found.deadMedia.join('\n  ')}`);
  if (found.gaps.length) console.log(`run-time references with no file:\n  ${found.gaps.join('\n  ')}`);
}

export async function main(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter((a) => a.startsWith('--') && a !== '--only'));
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt >= 0 ? new Set((argv[onlyAt + 1] || '').split(',').filter(Boolean)) : null;
  const found = collectSources();

  if (flags.has('--report')) {
    printCoverage(found);
    return 0;
  }
  if (flags.has('--check')) {
    const problems = check(found);
    if (problems.length) {
      console.error(`site/optimized is stale (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
      for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
      if (problems.length > 40) console.error(`  ... and ${problems.length - 40} more`);
      console.error('Run: node tools/optimize-images.mjs   (add --force to redo everything)');
      return 1;
    }
    console.log(`site/optimized is current: ${found.sources.length} images, ${Object.values(readIndex().items).reduce((n, i) => n + i.variants.length, 0)} files`);
    return 0;
  }

  const force = flags.has('--force');
  const index = readIndex();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const todo = [];
  for (const src of found.sources) {
    if (only && !only.has(src.name)) continue;
    const listed = new Set();
    const stale = itemProblems(src, index.items[src.sha], listed).length > 0;
    if (force || stale) todo.push(src);
  }
  printCoverage(found);
  console.log(todo.length ? `encoding ${todo.length} of ${found.sources.length}` : 'nothing to encode: every source already has its variants');

  if (todo.length) {
    const enc = await openEncoder();
    try {
      for (const src of todo) {
        const q = qualityFor(src.name);
        const size = await enc.load(src);
        const widths = planWidths(size.width);
        const res = { width: size.width, height: size.height, variants: await enc.encode(src, widths, q) };
        const variants = [];
        for (const v of res.variants) {
          const buf = Buffer.from(v.b64, 'base64');
          const file = variantFile(src.name, src.sha, v.w);
          fs.writeFileSync(path.join(OUT_DIR, file), buf);
          variants.push({ w: v.w, h: v.h, file, bytes: buf.length });
        }
        // a changed quality or width plan leaves files of the old plan behind; they are removed with --prune
        index.items[src.sha] = { source: src.source, name: src.name, width: res.width, height: res.height, quality: q, variants };
        const top = variants[variants.length - 1];
        console.log(
          `  ${src.name.padEnd(26)} ${`${res.width}x${res.height}`.padEnd(10)} q${q.toFixed(2)}  ${fmtKB(src.bytes.length).padStart(7)} -> ${variants
            .map((v) => `${v.w}:${fmtKB(v.bytes)}`)
            .join(' ')}  (${((top.bytes / src.bytes.length) * 100).toFixed(0)}% at ${top.w})`
        );
        writeIndex(index);
      }
    } finally {
      await enc.close();
    }
  }

  if (flags.has('--prune')) {
    const wanted = new Set(found.sources.map((s) => s.sha));
    for (const sha of Object.keys(index.items)) if (!wanted.has(sha) && !only) delete index.items[sha];
    const listed = new Set(Object.values(index.items).flatMap((i) => i.variants.map((v) => v.file)));
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (f.endsWith('.webp') && !listed.has(f)) {
        fs.unlinkSync(path.join(OUT_DIR, f));
        console.log(`  removed ${f}`);
      }
    }
  }
  writeIndex(index);

  const problems = check(found);
  if (problems.length) {
    console.error(`still not current (${problems.length}):`);
    for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
    return 1;
  }
  const items = Object.values(index.items);
  const srcBytes = found.sources.reduce((n, s) => n + s.bytes.length, 0);
  const top = items.reduce((n, i) => n + i.variants[i.variants.length - 1].bytes, 0);
  const small = items.reduce((n, i) => n + i.variants[0].bytes, 0);
  console.log(`done: ${items.length} images, sources ${(srcBytes / 1048576).toFixed(1)} MB -> largest variants ${(top / 1048576).toFixed(1)} MB, smallest variants ${(small / 1048576).toFixed(1)} MB`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.stack || err.message);
      process.exit(1);
    }
  );
}
