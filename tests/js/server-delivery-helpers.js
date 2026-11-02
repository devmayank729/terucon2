/**
 * A small fake dist/ for the delivery tests: the layout tools/build-dist.js writes (see server/lib/delivery.js), made of a few
 * hand-written files with real brotli and gzip copies, so the tests can decode what the server sends and compare it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const brotli = (buffer) => zlib.brotliCompressSync(buffer);
const gzip = (buffer) => zlib.gzipSync(buffer);

/** Text long enough that compression pays (and that the 1 KB threshold of the compression middleware does not skip). */
export const filler = (label, bytes = 4000) => `/* ${label} */\n` + 'body { margin: 0 } .terucon-fixture { color: #1F150A }\n'.repeat(Math.ceil(bytes / 55));

export const ETAGS = { home: 'a1b2c3d4e5f60718', materials: '0123456789abcdef' };

/** The assets of the fixture: name -> {body, br, gz, type}. All names are content-hashed except `plain.js`. */
export const ASSETS = {
  'app-0123456789ab.js': { body: Buffer.from(filler('app', 6000)), br: true, gz: true, type: 'text/javascript' },
  'only-gzip-abcdef012345.css': { body: Buffer.from(filler('only-gzip', 3000)), br: false, gz: true, type: 'text/css' },
  'no-copies-0a1b2c3d4e5f.json': { body: Buffer.from(JSON.stringify({ fixture: 'x'.repeat(2000) })), br: false, gz: false, type: 'application/json' },
  'logo-111111111111.png': { body: Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 251)), br: false, gz: false, type: 'image/png' },
  'font-222222222222.woff2': { body: Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 13) % 253)), br: false, gz: false, type: 'font/woff2' },
  'plain.js': { body: Buffer.from(filler('plain', 2500)), br: false, gz: true, type: 'text/javascript' },
  'clip-333333333333.mp4': { body: Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 199)), br: false, gz: false, type: 'video/mp4' },
};

/** The text of the dist page of a site.json key. */
export const pageText = (key) => `<!doctype html><title>built ${key}</title><link rel="stylesheet" href="/assets/app-0123456789ab.js">\n${filler(`page ${key}`, 5000)}`;

const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/**
 * Write dist/ under `root`.
 * @param {string} root
 * @param {{pages?: string[], manifest?: boolean, brokenManifest?: boolean, onlyPlainPages?: boolean}} [options]
 *   `pages`: the site.json keys to build (default home and materials); `manifest: false` leaves the manifest out;
 *   `onlyPlainPages`: no .br / .gz copies of the pages
 */
export function writeFixtureDist(root, { pages = ['home', 'materials'], manifest = true, brokenManifest = false, onlyPlainPages = false } = {}) {
  const dist = path.join(root, 'dist');
  const manifestPages = {};
  for (const key of pages) {
    const body = Buffer.from(pageText(key));
    write(path.join(dist, 'pages', `${key}.html`), body);
    if (!onlyPlainPages) {
      write(path.join(dist, 'pages', `${key}.html.br`), brotli(body));
      write(path.join(dist, 'pages', `${key}.html.gz`), gzip(body));
    }
    manifestPages[key] = { file: `pages/${key}.html`, etag: ETAGS[key] ?? createHash('sha256').update(body).digest('hex').slice(0, 16) };
  }
  const manifestAssets = {};
  for (const [name, asset] of Object.entries(ASSETS)) {
    write(path.join(dist, 'assets', name), asset.body);
    if (asset.br) write(path.join(dist, 'assets', `${name}.br`), brotli(asset.body));
    if (asset.gz) write(path.join(dist, 'assets', `${name}.gz`), gzip(asset.body));
    if (name !== 'plain.js') manifestAssets[`assets/${name}`] = { bytes: asset.body.length, br: asset.br, gz: asset.gz }; // plain.js is on disk only: found by looking
  }
  // things that must never be served from dist/assets
  write(path.join(dist, 'assets', 'page-444444444444.html'), '<!doctype html><title>no</title>');
  write(path.join(dist, 'assets', '.secret-555555555555.js'), 'secret');
  write(path.join(dist, 'secret.txt'), 'DECOY secret outside assets/');
  if (brokenManifest) write(path.join(dist, 'manifest.json'), '{ not json');
  else if (manifest) write(path.join(dist, 'manifest.json'), JSON.stringify({ version: 1, builtAt: '2026-11-02T00:00:00.000Z', pages: manifestPages, assets: manifestAssets }));
  return dist;
}
