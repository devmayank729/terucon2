/**
 * The Design Studio as a throw-away folder for tests: its real server code and its real browser files, but never its
 * .env or its keys, so a test can not reach your database, Modal or Google. The studio reads its settings from the process
 * environment once, when it is first loaded, so a test file sets them (setStudioEnv) before it loads the studio; each test
 * file runs in its own process, so one file's settings never leak into another's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// every variable the studio's config.js reads, by prefix: a developer's own shell must not change a test
const STUDIO_ENV = /^(MONGODB_|GOOGLE_|VERTEX_|MODEL_(SERVICE|DEVICE)|SAM3_|MOGE2_|MARIGOLD_|ONEFORMER_|ANALYZE_|VISION_|MODAL_|PIPELINE_|STORAGE_|GCS_|STUDIO_|SESSION_|SECURE_COOKIES|TRUST_PROXY|ADMIN_|POSTHOG_|TERUCON_PAGE|ROOM_LIMIT|AI_BODY_LIMIT|FILE_BODY_LIMIT)/;

/** Remove every studio variable from the environment, then set `values`. Call before the studio is loaded. */
export function setStudioEnv(values = {}) {
  for (const name of Object.keys(process.env)) if (STUDIO_ENV.test(name)) delete process.env[name];
  Object.assign(process.env, {
    // nothing reachable: no database, no local model service, no Google key
    MONGODB_URI: 'mongodb://127.0.0.1:1/terucon-test',
    MODEL_SERVICE_URL: 'http://127.0.0.1:1',
    SESSION_SECRET: 'test-session-secret',
    ...values,
  });
}

/**
 * A whole throw-away project: the real site map, a one-line stand-in for each page (the real Coming soon page), an empty
 * media folder, and the studio folder from makeStudioDir() at <root>/swatchroom. For tests of the server around the studio.
 * @returns {{root: string, studioDir: string, remove: () => void}}
 */
export function makeProjectRoot() {
  const fixture = makeStudioDir();
  const root = fixture.base;
  fs.mkdirSync(path.join(root, 'site'));
  fs.copyFileSync(path.join(PROJECT_ROOT, 'site', 'site.json'), path.join(root, 'site', 'site.json'));
  const site = JSON.parse(fs.readFileSync(path.join(root, 'site', 'site.json'), 'utf8'));
  fs.mkdirSync(path.join(root, 'pages'));
  for (const [key, spec] of Object.entries(site.pages)) {
    fs.writeFileSync(path.join(root, spec.file), `<!doctype html><title>${key}</title><p>page ${key}</p>`);
  }
  fs.copyFileSync(path.join(PROJECT_ROOT, 'pages', 'coming-soon.html'), path.join(root, 'pages', 'coming-soon.html'));
  fs.mkdirSync(path.join(root, 'media'));
  return { root, studioDir: fixture.dir, remove: fixture.remove };
}

/**
 * @returns {{base: string, dir: string, remove: () => void}} `dir` is the studio folder (pass it to loadSwatchroom, or use
 *   `base` as a project root with `swatchroom/` inside)
 */
export function makeStudioDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'terucon-studio-test-'));
  const dir = path.join(base, 'swatchroom');
  fs.mkdirSync(dir);
  fs.cpSync(path.join(PROJECT_ROOT, 'swatchroom', 'server'), path.join(dir, 'server'), { recursive: true });
  fs.copyFileSync(path.join(PROJECT_ROOT, 'swatchroom', 'package.json'), path.join(dir, 'package.json')); // routes/session.js reads its version
  fs.symlinkSync(path.join(PROJECT_ROOT, 'swatchroom', 'public'), path.join(dir, 'public'), 'dir');
  fs.symlinkSync(path.join(PROJECT_ROOT, 'node_modules'), path.join(base, 'node_modules'), 'dir');
  return {
    base,
    dir,
    remove() {
      for (const link of [path.join(dir, 'public'), path.join(base, 'node_modules')]) {
        try {
          if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
        } catch {
          /* already gone */
        }
      }
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}
