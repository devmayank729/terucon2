#!/usr/bin/env node
// The Design Studio's instant-preview overlay (site/overlays/studio/) is a set of improved copies of some of swatchroom/'s own browser
// files. manifest.json beside them records, as SHA-256:
//   upstream  every file of swatchroom/public/js/lib/fastrender/ (the overlaid ones AND the ones they import: sizing, tiers, lru, ...)
//             plus js/lib/previewScene.js, exactly as they were when the overlay was merged with them
//   overlay   the overlay's own files
// tests/js/studio-overlay.test.js fails when swatchroom/ no longer matches `upstream` (the studio was re-copied from the user's own
// project with a newer preview: the overlay must be merged with it again, or it would silently overwrite their change).
//
//   node tools/studio-overlay-manifest.js           write manifest.json from what is on disk NOW (after you have re-merged the overlay)
//   node tools/studio-overlay-manifest.js --check   say what differs and exit 1 if anything does (what the test does)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMMAND = 'node tools/studio-overlay-manifest.js';
export const MANIFEST_COMMENT =
  'Written by tools/studio-overlay-manifest.js; checked by tests/js/studio-overlay.test.js. upstream = SHA-256 of the studio files the overlay was merged with ' +
  '(swatchroom/public/<path>: all of js/lib/fastrender/ and js/lib/previewScene.js, because the overlaid files depend on the interfaces of the others); ' +
  'overlay = SHA-256 of the files in site/overlays/studio/<path>, which are served at /<path>. Do not edit by hand.';

/** Every file below `dir` (relative, forward slashes, sorted); names that start with a dot (.DS_Store, ...) are not files of the studio or of the overlay. */
function walk(dir) {
  const out = [];
  const go = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) go(full);
      else if (entry.isFile()) out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(dir)) go(dir);
  return out.sort();
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The studio's files the overlay depends on, relative to swatchroom/public. */
export function upstreamFiles(root = ROOT) {
  const publicDir = path.join(root, 'swatchroom', 'public');
  const files = walk(path.join(publicDir, 'js', 'lib', 'fastrender')).map((f) => `js/lib/fastrender/${f}`);
  files.push('js/lib/previewScene.js');
  return files.filter((f) => fs.existsSync(path.join(publicDir, f))).sort();
}

/** What the manifest would say for the files on disk now: { upstream: {path: sha256}, overlay: {path: sha256} }. */
export function currentHashes(root = ROOT) {
  const publicDir = path.join(root, 'swatchroom', 'public');
  const overlayDir = path.join(root, 'site', 'overlays', 'studio');
  const upstream = {};
  for (const f of upstreamFiles(root)) upstream[f] = sha256(path.join(publicDir, f));
  const overlay = {};
  for (const f of walk(overlayDir).filter((name) => name !== 'manifest.json')) overlay[f] = sha256(path.join(overlayDir, f));
  return { upstream, overlay };
}

export function readManifest(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'site', 'overlays', 'studio', 'manifest.json'), 'utf8'));
}

/**
 * Compare the manifest with the disk. -> a list of plain sentences, empty when everything matches.
 * Each sentence starts with what changed, and says what to do and which command to run.
 */
export function problems(root = ROOT, manifest = readManifest(root)) {
  const now = currentHashes(root);
  const out = [];
  const overlaid = new Set(Object.keys(manifest.overlay));
  for (const [file, hash] of Object.entries(manifest.upstream)) {
    if (!(file in now.upstream)) {
      out.push(`upstream removed ${file}: re-merge the overlay (site/overlays/studio/) with the studio's new files, then update the manifest with ${COMMAND}`);
    } else if (now.upstream[file] !== hash) {
      out.push(`upstream changed ${file}${overlaid.has(file) ? ' (an overlaid file: its improvements must be merged into the studio\'s new version)' : ' (not overlaid, but the overlaid files depend on its interfaces)'}: re-merge the overlay, then update the manifest with ${COMMAND}`);
    }
  }
  for (const file of Object.keys(now.upstream)) {
    if (!(file in manifest.upstream)) out.push(`upstream added ${file}: check whether the overlaid files should use it, then update the manifest with ${COMMAND}`);
  }
  for (const [file, hash] of Object.entries(manifest.overlay)) {
    if (!(file in now.overlay)) out.push(`the overlay file ${file} is missing from site/overlays/studio/: restore it, or update the manifest with ${COMMAND}`);
    else if (now.overlay[file] !== hash) out.push(`the overlay file ${file} was edited after the manifest was written: if that was intended, update the manifest with ${COMMAND}`);
  }
  for (const file of Object.keys(now.overlay)) {
    if (!(file in manifest.overlay)) out.push(`the overlay has a new file ${file} that the manifest does not list: update the manifest with ${COMMAND}`);
  }
  return out;
}

export function buildManifest(root = ROOT) {
  const { upstream, overlay } = currentHashes(root);
  return { _comment: MANIFEST_COMMENT, upstream, overlay };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.join(ROOT, 'site', 'overlays', 'studio', 'manifest.json');
  if (process.argv.includes('--check')) {
    const found = problems();
    if (found.length) {
      console.error(found.map((line) => `  - ${line}`).join('\n'));
      process.exit(1);
    }
    console.log(`The overlay manifest matches the studio and the overlay (${Object.keys(readManifest().upstream).length} studio files, ${Object.keys(readManifest().overlay).length} overlay files).`);
  } else {
    const manifest = buildManifest();
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Wrote ${path.relative(ROOT, file)}: ${Object.keys(manifest.upstream).length} studio files, ${Object.keys(manifest.overlay).length} overlay files.`);
  }
}
