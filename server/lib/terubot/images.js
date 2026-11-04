/**
 * The address of a material's photograph.
 *
 * The shop's photographs are not files under media/materials/ (the export carries them inside the page). In the built site
 * (tools/build-dist.js) each one is a hashed file under /assets/ - `acp-bronze-6642282c-640-137387533307.webp` - so the address has to be
 * looked up in dist/manifest.json. Without a built site (a fresh checkout, the tests) there is no such file and the answer is '' (a card
 * without a picture), never an address that would 404.
 *
 * Preference: an optimised copy at least 480 px wide (the smallest of those), else the widest optimised copy, else the original.
 */
import fs from 'node:fs';
import path from 'node:path';

const RECHECK_MS = 5000;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {{dir: string} | null} dist the object createDist() returns (only `dir` is used)
 * @param {{mediaDir?: string | null}} [options] `mediaDir`: the folder media/materials. A photograph that is a file there (the catalogue designs'
 *   pictures, tools/build-shop-catalogue.js) is served from /media/materials/<name>.jpg, which needs no built site.
 */
export function createImageResolver(dist, { mediaDir = null } = {}) {
  let checkedAt = 0;
  let stamp = '';
  let names = []; // asset paths under assets/
  const cache = new Map();

  function load() {
    if (!dist?.dir) return;
    if (checkedAt && Date.now() - checkedAt < RECHECK_MS) return;
    checkedAt = Date.now();
    const file = path.join(dist.dir, 'manifest.json');
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      names = [];
      stamp = '';
      cache.clear();
      return;
    }
    const next = `${st.mtimeMs}:${st.size}`;
    if (next === stamp) return;
    stamp = next;
    cache.clear();
    try {
      names = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).assets ?? {});
    } catch {
      names = [];
    }
  }

  /** @param {string | null | undefined} image the variant's `image`: "media/materials/<name>.jpg" or null */
  function urlFor(image) {
    const name = /^media\/materials\/([A-Za-z0-9._-]+)\.jpg$/.exec(image ?? '')?.[1];
    if (!name) return '';
    load();
    if (cache.has(name)) return cache.get(name);
    if (mediaDir && fs.existsSync(path.join(mediaDir, `${name}.jpg`))) {
      cache.set(name, `/media/materials/${name}.jpg`);
      return cache.get(name);
    }
    const optimised = new RegExp(`^assets/${escape(name)}-[0-9a-f]{8}-(\\d+)-[0-9a-f]{12}\\.webp$`);
    const original = new RegExp(`^assets/${escape(name)}-[0-9a-f]{12}\\.(?:jpg|jpeg|png|webp)$`);
    const copies = names.map((n) => ({ n, w: Number(optimised.exec(n)?.[1] ?? 0) })).filter((c) => c.w > 0);
    const enough = copies.filter((c) => c.w >= 480).sort((a, b) => a.w - b.w)[0];
    const widest = [...copies].sort((a, b) => b.w - a.w)[0];
    const picked = enough?.n ?? widest?.n ?? names.find((n) => original.test(n));
    const url = picked ? `/${picked}` : '';
    if (cache.size > 500) cache.clear();
    cache.set(name, url);
    return url;
  }

  return { urlFor, forVariant: (variant) => urlFor(variant?.image) };
}
