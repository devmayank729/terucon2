// Shared by tests/js/site-*.test.js. Not a test file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bundle } from '../../tools/bundle.js';
import { buildSite } from '../../tools/build-site.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'site.json'), 'utf8'));
export const PAGE_KEYS = Object.keys(SITE.pages);
export const PRISTINE = Object.fromEntries(PAGE_KEYS.map((k) => [k, path.join(ROOT, SITE.pages[k].source)]));

/** The old flat file names, for the build that is compared with the old Python tool's file-style output. */
export const OLD_FILE_NAMES = {
  home: 'index.html',
  materials: 'market_place_1.html',
  studio: 'Terucon Swatchroom.html',
  dashboard: 'Terucon Client Dashboard v3.html',
};

const memo = new Map();
/** One in-memory build per link style and test file (a build gzips and syntax-checks a 1 MB module). */
export function memoBuild(style = 'route', extra = {}) {
  const key = style + JSON.stringify(extra);
  if (!memo.has(key)) {
    const built = buildSite({ linkStyle: style, check: true, ...extra });
    if (!built.ok) throw new Error('site build failed:\n' + built.results.filter((r) => !r.ok).map((r) => `${r.key}: ${r.error}`).join('\n') + JSON.stringify(built.problems));
    memo.set(key, built);
  }
  return memo.get(key);
}

/** A bundle in the exporter's layout, for the edge cases the real pages do not have. */
export function makeBundleText({ template, assets = {}, ext = [], bom = false }) {
  const manifest = {};
  for (const [uuid, a] of Object.entries(assets)) {
    const raw = Buffer.from(a.text ?? a.bytes);
    manifest[uuid] = { mime: a.mime, compressed: Boolean(a.compressed), data: (a.compressed ? zlib.gzipSync(raw) : raw).toString('base64') };
  }
  return (
    (bom ? '﻿' : '') +
    '<!DOCTYPE html>\n<html><body>\n<p>loader</p>\n' +
    `<script type="__bundler/manifest">\n${JSON.stringify(manifest)}\n  </script>\n` +
    `<script type="__bundler/ext_resources">\n${JSON.stringify(ext)}\n  </script>\n` +
    `<script type="__bundler/template">\n${Bundle.encodeTemplate(template)}\n  </script>\n</body></html>\n`
  );
}

/** A throw-away project root: its own copy of site/ (patches can be damaged), links to the real sources and media. */
export function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-site-test-'));
  fs.cpSync(path.join(ROOT, 'site'), path.join(dir, 'site'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'pages_original'), path.join(dir, 'pages_original'), 'dir');
  fs.symlinkSync(path.join(ROOT, 'media'), path.join(dir, 'media'), 'dir');
  return dir;
}

/** Remove a temp root without ever following its links into the real project. */
export function removeTempRoot(dir) {
  for (const link of ['pages_original', 'media']) {
    try {
      if (fs.lstatSync(path.join(dir, link)).isSymbolicLink()) fs.unlinkSync(path.join(dir, link));
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

export function runNode(args, { cwd = ROOT, env = {} } = {}) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 180000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const tool = (name) => path.join(ROOT, 'tools', name);
