#!/usr/bin/env node
/**
 * The landing page's pictures: responsive WebP copies, made from the designer's masters and committed in site/landing/img/.
 *
 *   node tools/optimize-landing.mjs [--src <folder>]   make or refresh every copy (needs `cwebp` on the PATH)
 *   node tools/optimize-landing.mjs --check            verify the committed copies (no encoder needed; this is what `npm test` runs)
 *
 * Why it is a separate, committed step: the Docker image has no image encoder (same reason as site/optimized/), so the copies are made
 * here and shipped as they are. The page builder (server/lib/landing/) reads site/landing/img/index.json and nothing else; it never
 * looks at the masters.
 *
 * Masters: the designer's folder `Terucon_landingPage_2/images/` (the default --src). Only ever scaled DOWN: a master is never enlarged, and a
 * width equal to the master's is a plain copy (no second lossy pass). A copy is named <id>-<width>-<hash12>.webp, the hash being that of
 * the file itself, so the page may serve it for a year (`immutable`): a new picture has a new name.
 *
 * Optional pictures (they are not in the folder yet, 2026-11-10): images/projects/<slug>.webp (real site photos, the "Signature work"
 * section), images/clients/<slug>.png (client logos) and terubot.png. Drop one in the folder, run this tool, and the page shows it:
 * the builder falls back to a text card / a monogram / a drawn face for each one that has no entry in index.json, so nothing 404s.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site/landing/img');
const INDEX = path.join(OUT, 'index.json');
const DEFAULT_SRC = path.join(ROOT, 'Terucon_landingPage_2/images');

/** id -> {src (relative to the masters folder), widths, q}. The ids are what site/landing/content.json and the renderer refer to. */
export function specs() {
  const list = [];
  const add = (id, src, widths, q = 74, extra = {}) => list.push({ id, src, widths, q, ...extra });
  for (let i = 1; i <= 4; i += 1) {
    add(`hero-0${i}`, `hero/hero-0${i}.webp`, [960, 1440, 1920], 74);
    add(`hero-0${i}-m`, `hero/hero-0${i}-m.webp`, [480, 800, 900], 70);
  }
  for (const slug of ['01-acp-facades', '02-commercial-interiors', '03-false-ceiling-gypsum', '04-flooring', '05-civil-painting', '06-fabrication-glazing']) {
    add(`disc-${slug}`, `disciplines/${slug}.webp`, [480, 720, 1200], 74);
  }
  for (const code of ['cmt6001', 'cmt6002', 'cmt6003', 'cmt6004', 'cmt6007', 'cmt6008']) add(`shade-${code}`, `shades/${code}.webp`, [240, 480], 78);
  for (const slug of ['stone-bronze', 'teak-terracotta', 'lime-oak', 'dark-monolith']) add(`studio-${slug}`, `studio/${slug}.webp`, [320, 640, 1000, 1600], 74);
  for (const slug of ['cladding-choices', 'fitout-14-weeks', 'retail-rollout']) add(`journal-${slug}`, `journal/${slug}.webp`, [480, 800, 1200], 74);
  add('firm-material-desk', 'firm/material-desk.webp', [640, 1000, 1600], 74);
  add('film-poster', 'film-poster.webp', [960, 1440, 1920], 72);
  add('logo', 'logo-trim.webp', [264, 380], 82, { alpha: true });
  // optional, only when the file exists in the masters folder
  for (const slug of ['decathlon-whitefield', 'smart-bazaar-gonikoppa', 'trends', 'style-union', 'office-fitout', 'meeting-space']) {
    add(`project-${slug}`, `projects/${slug}`, [480, 800, 1200], 74, { optional: true, exts: ['.webp', '.jpg', '.jpeg', '.png'] });
  }
  for (const slug of ['decathlon', 'dmart', 'gap', 'smart-bazaar', 'trends', 'bmore', 'style-union']) {
    add(`client-${slug}`, `clients/${slug}.png`, [160, 320], 85, { optional: true, alpha: true });
  }
  add('terubot', '../terubot.png', [96], 85, { optional: true, alpha: true });
  return list;
}

const sha12 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);

/** Pixel size of a PNG, JPEG or WebP, read from the file header. */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  throw new Error('not a PNG, JPEG or WebP file');
}

function encode(srcFile, width, height, q, alpha, outFile) {
  const args = ['-quiet', '-q', String(q), '-m', '6', '-mt'];
  if (alpha) args.push('-alpha_q', '90');
  if (width) args.push('-resize', String(width), String(height));
  args.push(srcFile, '-o', outFile);
  execFileSync('cwebp', args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

function make({ src = DEFAULT_SRC, log = console.log } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const index = {};
  const keep = new Set();
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'landing-img-'));
  try {
    for (const spec of specs()) {
      let master = path.join(src, spec.src);
      if (spec.exts) master = spec.exts.map((e) => master + e).find((f) => fs.existsSync(f)) || '';
      if (!master || !fs.existsSync(master)) {
        if (spec.optional) { log(`  - ${spec.id}: no master (optional): the page falls back`); continue; }
        throw new Error(`master missing: ${path.join(src, spec.src)} (use --src <folder>)`);
      }
      const bytes = fs.readFileSync(master);
      const size = imageSize(bytes);
      const variants = [];
      for (const w of spec.widths) {
        if (w > size.w) continue; // never enlarge
        const h = Math.round((size.h * w) / size.w);
        const isWebp = bytes.toString('ascii', 8, 12) === 'WEBP';
        let out;
        if (w === size.w && isWebp) out = bytes; // the master itself: no second lossy pass
        else {
          const file = path.join(tmp, `${spec.id}-${w}.webp`);
          encode(master, w === size.w ? 0 : w, h, spec.q, spec.alpha, file);
          out = fs.readFileSync(file);
        }
        const name = `${spec.id}-${w}-${sha12(out)}.webp`;
        fs.writeFileSync(path.join(OUT, name), out);
        keep.add(name);
        variants.push({ w, h, file: name, bytes: out.length });
      }
      if (!variants.length) throw new Error(`${spec.id}: the master (${size.w} px wide) is narrower than every width asked for`);
      index[spec.id] = { w: size.w, h: size.h, variants };
      log(`  ${spec.id}: ${variants.map((v) => `${v.w}w ${(v.bytes / 1024).toFixed(0)}K`).join('  ')}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  fs.writeFileSync(INDEX, `${JSON.stringify(index, null, 1)}\n`);
  for (const f of fs.readdirSync(OUT)) if (f !== 'index.json' && !keep.has(f)) fs.rmSync(path.join(OUT, f)); // a replaced picture leaves no stale file
  const total = Object.values(index).flatMap((e) => e.variants).reduce((n, v) => n + v.bytes, 0);
  log(`${Object.keys(index).length} pictures, ${keep.size} files, ${(total / 1048576).toFixed(2)} MB in site/landing/img/`);
}

/** Every file index.json names is there with the hash in its name, and nothing else is in the folder. */
export function check({ dir = OUT } = {}) {
  const problems = [];
  let index;
  try {
    index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  } catch (error) {
    return [`site/landing/img/index.json: ${error.message}`];
  }
  const named = new Set(['index.json']);
  for (const [id, entry] of Object.entries(index)) {
    for (const v of entry.variants || []) {
      named.add(v.file);
      let bytes;
      try {
        bytes = fs.readFileSync(path.join(dir, v.file));
      } catch {
        problems.push(`${id}: ${v.file} is missing`);
        continue;
      }
      if (!v.file.includes(`-${sha12(bytes)}.`)) problems.push(`${id}: ${v.file} does not match its own hash (changed after it was made)`);
      if (bytes.length !== v.bytes) problems.push(`${id}: ${v.file} is ${bytes.length} bytes, the index says ${v.bytes}`);
      try {
        const size = imageSize(bytes);
        if (size.w !== v.w) problems.push(`${id}: ${v.file} is ${size.w} px wide, the index says ${v.w}`);
      } catch (error) {
        problems.push(`${id}: ${v.file}: ${error.message}`);
      }
    }
  }
  for (const f of fs.readdirSync(dir)) if (!named.has(f)) problems.push(`${f} is in the folder but not in index.json`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    const problems = check();
    if (problems.length) {
      console.error(`landing pictures are not current:\n  ${problems.join('\n  ')}\nRun: node tools/optimize-landing.mjs`);
      process.exit(1);
    }
    console.log('landing pictures are current');
  } else {
    const at = args.indexOf('--src');
    make({ src: at > -1 ? path.resolve(args[at + 1]) : DEFAULT_SRC });
  }
}
