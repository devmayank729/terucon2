/**
 * A throw-away project folder for the server tests: site/site.json (the real one), a tiny page per route, a
 * docs page, some media, and decoys at every path the server must never serve. Nothing in it is real.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Paths (relative to the temp root) that hold something that must never be reachable over HTTP. */
export const DECOYS = [
  '.env',
  '.env.example',
  'app.js',
  'package.json',
  'server/secret.js',
  'site/notes.txt',
  'model/terucon_model.py',
  'tools/build.js',
  'tests/secret.test.js',
  'node_modules/pkg/index.js',
  'pages_original/index.html',
  '.git/config',
  'docs/notes.md',
];

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * @param {{prefix?: string}} [options]
 * @returns {{root: string, envPath: string, page: (key: string) => string, cleanup: () => void}}
 */
export function makeTempRoot({ prefix = 'terucon-test-' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const siteJson = path.join(PROJECT_ROOT, 'site', 'site.json');
  write(path.join(root, 'site', 'site.json'), fs.readFileSync(siteJson));
  const site = JSON.parse(fs.readFileSync(siteJson, 'utf8'));
  const page = (key) => `<!doctype html><title>${key}</title><p>page ${key}</p>`;
  for (const [key, spec] of Object.entries(site.pages)) write(path.join(root, spec.file), page(key));
  for (const spec of Object.values(site.docs)) write(path.join(root, spec.file), '<!doctype html><title>overview</title>');
  write(path.join(root, 'media', 'photo.jpg'), Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251)));
  write(path.join(root, 'media', 'clip.mp4'), 'not really a video');
  write(path.join(root, 'media', 'sub', 'deep.png'), 'png');
  write(path.join(root, 'media', 'script.py'), 'print("no")');
  write(path.join(root, 'media', 'notebook.ipynb'), '{}');
  write(path.join(root, 'media', '.hidden.jpg'), 'hidden');
  for (const decoy of DECOYS) write(path.join(root, decoy), `DECOY ${decoy}`);
  const envPath = path.join(root, 'test.env');
  fs.writeFileSync(envPath, '');
  return { root, envPath, page, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
