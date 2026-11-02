#!/usr/bin/env node
// Turn the four Claude Design "bundles" in pages/ into a real built site in dist/.
//
// A bundle (pages/home.html, materials, studio, dashboard) is one HTML file that carries every font, photo and script as base64,
// the page as one JSON string, and a bootstrap that unpacks all of it in the browser before anything can paint. Every page
// therefore re-downloads (and re-decodes) the same fonts and runtime, and nothing can be cached, compressed or fetched in parallel.
// This tool does the unpacking once, at build time:
//
//   dist/manifest.json                    {version, builtAt, pages:{key:{file, etag}}, assets:{"assets/<file>":{bytes, br, gz}}}
//   dist/pages/<key>.html (+ .br, .gz)    the real page: plain <link>/<script src>/<img src> to /assets/..., no bundle markup
//   dist/assets/<name>-<hash12>.<ext>     content-hashed (serve with "immutable"), shared by every page, one copy per content
//
//   node tools/build-dist.js                  build everything into dist/
//   node tools/build-dist.js --check          build in memory and say whether dist/ is current (exit 1 if not; writes nothing)
//   node tools/build-dist.js --if-missing     build only when dist/manifest.json is missing or damaged (a deploy runs this)
//   --out DIR   write somewhere else than <root>/dist     --root DIR   another project root     --quiet
//
// What the bootstrap did in the browser and what replaces it here:
//   * every uuid in the template becomes "/assets/<name>-<hash12>.<ext>" (also inside JS strings and CSS), and
//     `window.__resources = {id: url}` is injected right after <head>, because the page's own scripts read it (facade2d, facade3d,
//     swatchroomApp, the dashboard's "m-..." thumbnails, ...). `window.__resourceBlobs` is NOT recreated: the runtime's
//     bundledBlob() returns null when it is missing and every caller then falls back to a normal URL/fetch (checked in the code).
//     Nothing in any template reads __resourceBlobs.
//   * no integrity=/crossorigin= stripping: none of the four templates has either, and the files are same-origin now.
//   * the scripts keep their order. The page runtime and React are `defer`red (so the loader can paint before ~200 KB of JS is
//     parsed) and x-dc is hidden by a stylesheet until the runtime has replaced it.
//   * nested pages (__bundler/page_order, about:blank#uuid iframes): none of the four pages uses them; if one ever does, the
//     build stops and names the page rather than ship something that cannot work.
//
// Fonts: every @font-face keeps only its woff2 source (the bundles carry ttf+woff+woff2 of each face) and the faces used above
// the fold are preloaded. The dead <link rel=preconnect href=https://api.fontshare.com> is removed (the fonts are embedded).
//
// Third-party scripts, all served from this site (site/vendor/, see its README):
//   * React 18.3.1 + ReactDOM: the runtime's loadReactUmd() returns at once when window.React and window.ReactDOM exist, so the
//     two UMD files are simply loaded first. Their sha384 is checked against REACT_SRI / REACT_DOM_SRI read out of the runtime
//     itself. The bundles' `__resources` entries for the two unpkg addresses are dropped, so no unpkg address is in any page.
//   * three.js: the home page's 3D façade does `import('https://unpkg.com/three@0.184.0/build/three.module.js')` at run time.
//     The address inside that script (the emitted asset only, never the vendored file) is rewritten to the local copy, and the
//     module's own `./three.core.min.js` import to the hashed copy of the core.
//
// Shell: site/brand/head.html goes inside <head> and site/brand/loader.html is the first thing in <body>; either is skipped when
// absent (re-run the build to pick it up). The loader is told to leave by an inline script that watches for the runtime's mount
// node (#dc-root) to receive its first child (React's first commit) and then waits two animation frames.
//
// Images: site/optimized/index.json (written by tools/optimize-images.mjs) maps the sha256 of a source image to resized WebP
// variants. A hit swaps the file, adds srcset/sizes to plain <img> and uses the best variant up to 1280 px everywhere else
// (CSS, JS strings, __resources). A miss keeps the original; a missing or broken index is not an error.
//
// <img>: the page's own pictures get loading="lazy" decoding="async" (the one hero image per page that PAGE_HINTS names gets
// fetchpriority="high" and a preload instead), written IN FRONT of src: the runtime passes attributes to React in order, and React sets
// them one by one, so a src written before loading="lazy" starts an eager download. Logos under /brand/ are left as written.
// <path d="{{ ... }}"> becomes sc-camel-d (the runtime reads it as d) so Chrome does not log an SVG error for each template path.
//
// Output is deterministic: the same inputs give byte-identical files (builtAt is kept from the previous manifest when nothing
// changed, or taken from SOURCE_DATE_EPOCH / the `builtAt` option). Nothing is written outside the output folder.
//
// Node built-ins only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bundle, gzipLikePython } from './bundle.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_VERSION = 1;
/** Bump when the transformation changes in a way that must invalidate an existing dist/ (`--if-missing` ignores it, `--check` does not need it). */
const BUILD_REVISION = 1;

export class DistError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DistError';
  }
}

// ---- the third-party files we host ------------------------------------------------------------------------------------------
const VENDOR_DIR = 'site/vendor';
const REACT = {
  url: 'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  file: 'react.production.min.js',
  sha384: 'sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z',
};
const REACT_DOM = {
  url: 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  file: 'react-dom.production.min.js',
  sha384: 'sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1',
};
const THREE = {
  url: 'https://unpkg.com/three@0.184.0/build/three.module.js',
  module: { file: 'three.module.min.js', sha384: 'sha384-35WaVqXNGvw49+RCXk67Ci9ebo55/5+CfirDbAVSG21KV8/7gO4xwIkhA5ZRcUHc' },
  core: { file: 'three.core.min.js', sha384: 'sha384-/2vXInuUL2LKgd3n86c5RIzG+YC7vk3zYPTknaEkF2H2sauHtaOrS8swZ+MURxU6' },
  coreImport: './three.core.min.js',
};

// ---- above-the-fold decisions per page ---------------------------------------------------------------------------------------
// Measured in Chrome (390x844 touch and 1440x900) on 2026-11-02 from the rendered pages. They are matched by what the markup says
// (a font family and weight, an embedded image's resource id), so a re-export only needs a change here when the hero itself
// changes; a hint that matches nothing is skipped with a note, never an error.
//   fonts: upright faces to <link rel=preload> as [family, weight]      lcp: the one image that gets fetchpriority=high and a preload
const PAGE_HINTS = {
  // home: the hero headline is Zodiak 300 (one word in italic), buttons and menu Switzer 500, the paragraph Switzer 400; the page's
  // largest paint is the hero paragraph, not a picture
  home: { fonts: [['Zodiak', 300], ['Switzer', 400], ['Switzer', 500]], lcp: null },
  // materials: the full-bleed hero photo is the largest element
  materials: { fonts: [['Switzer', 500], ['Zodiak', 300], ['Switzer', 400]], lcp: { resource: 'media/materials/col-monolith.jpg' } },
  studio: { fonts: [['Switzer', 500], ['Zodiak', 300], ['Switzer', 400]], lcp: null },
  dashboard: { fonts: [['Switzer', 600], ['Zodiak', 400], ['Switzer', 500]], lcp: null },
};

const COMPRESSIBLE = new Set(['js', 'css', 'svg', 'json', 'html']);
const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'text/css': 'css',
  'application/json': 'json',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// ---- small helpers -------------------------------------------------------------------------------------------------------------
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha384 = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');
const slug = (s) =>
  String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'asset';
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const readIfExists = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : null);

function brotli(buf) {
  return zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
}

// ---- the content-addressed asset store (one per build, shared by every page) -------------------------------------------------
class AssetStore {
  constructor() {
    this.byContent = new Map(); // `${sha256}.${ext}` -> asset
    this.byFile = new Map(); // file -> asset
  }

  /** Add bytes under a readable name; the same content (same extension) is stored once, whoever asks first names it. */
  add(bytes, { ext, name }) {
    const hash = sha256(bytes);
    const key = `${hash}.${ext}`;
    let a = this.byContent.get(key);
    if (a) return a;
    const file = `${slug(name)}-${hash.slice(0, 12)}.${ext}`;
    if (this.byFile.has(file)) throw new DistError(`two different assets would both be called assets/${file}`);
    a = { file, url: `/assets/${file}`, bytes, ext, hash };
    this.byContent.set(key, a);
    this.byFile.set(file, a);
    return a;
  }
}

// ---- inputs -------------------------------------------------------------------------------------------------------------------
function loadSite(root) {
  const file = path.join(root, 'site', 'site.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new DistError(`cannot read site/site.json in ${root}: ${e.message}`);
  }
}

function loadVendor(root) {
  const read = (spec) => {
    const file = path.join(root, VENDOR_DIR, spec.file);
    const bytes = readIfExists(file);
    if (!bytes) throw new DistError(`${VENDOR_DIR}/${spec.file} is missing (see ${VENDOR_DIR}/README.md for where it comes from)`);
    if (sha384(bytes) !== spec.sha384) {
      throw new DistError(`${VENDOR_DIR}/${spec.file} does not match the sha384 recorded in tools/build-dist.js (${spec.sha384}); it was changed or replaced`);
    }
    return bytes;
  };
  return { react: read(REACT), reactDom: read(REACT_DOM), threeModule: read(THREE.module), threeCore: read(THREE.core) };
}

/** site/optimized/index.json, or null when it is absent or unusable (a build never fails for lack of it). */
function loadOptimized(root, log) {
  const dir = path.join(root, 'site', 'optimized');
  const raw = readIfExists(path.join(dir, 'index.json'));
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw.toString('utf8'));
    if (doc.version !== 1 || !doc.items || typeof doc.items !== 'object') throw new Error('not a version 1 index');
    return { dir, items: doc.items };
  } catch (e) {
    log(`note: site/optimized/index.json ignored (${e.message})`);
    return null;
  }
}

function readBrand(root) {
  const text = (name) => {
    const b = readIfExists(path.join(root, 'site', 'brand', name));
    // the leading explanatory comment of each snippet is for people reading the file, not for every visitor
    return b ? b.toString('utf8').replace(/^\s*(?:<!--[\s\S]*?-->\s*)+/, '').trim() : '';
  };
  return { head: text('head.html'), loader: text('loader.html') };
}

// ---- optimized images --------------------------------------------------------------------------------------------------------
class Optimizer {
  constructor(opt, assets, root, log) {
    this.opt = opt;
    this.assets = assets;
    this.root = root;
    this.log = log;
    this.variantAssets = new Map(); // item key -> [{w, asset}] | null
    this.stats = { hit: 0, miss: 0, missing: 0 };
  }

  /** The item for image bytes, with its variant files loaded into the asset store; null on a miss. */
  lookup(bytes) {
    if (!this.opt || !bytes) return null;
    const key = sha256(bytes);
    if (this.variantAssets.has(key)) return this.variantAssets.get(key);
    const item = this.opt.items[key];
    let result = null;
    if (item && Array.isArray(item.variants) && item.variants.length) {
      const variants = [];
      for (const v of [...item.variants].sort((a, b) => a.w - b.w)) {
        const buf = readIfExists(path.join(this.opt.dir, v.file));
        if (!buf) {
          this.stats.missing += 1;
          this.log(`note: site/optimized/${v.file} is listed in the index but missing: that image keeps its original`);
          variants.length = 0;
          break;
        }
        const ext = path.extname(v.file).slice(1).toLowerCase() || 'webp';
        // written to dist only when a page actually uses it (a variant that only srcset would name is not shipped for a CSS use)
        let asset = null;
        const store = this.assets;
        const name = path.basename(v.file, path.extname(v.file));
        variants.push({
          w: v.w,
          get asset() {
            return (asset ||= store.add(buf, { ext, name }));
          },
        });
      }
      if (variants.length) result = { variants };
    }
    if (result) this.stats.hit += 1;
    else this.stats.miss += 1;
    this.variantAssets.set(key, result);
    return result;
  }

  /** One URL for CSS, JS strings and resource maps: the largest variant up to 1280 px wide (else the smallest). */
  single(entry) {
    const fit = entry.variants.filter((v) => v.w <= 1280);
    return (fit.length ? fit[fit.length - 1] : entry.variants[0]).asset.url;
  }

  srcset(entry) {
    return entry.variants.map((v) => `${v.asset.url} ${v.w}w`).join(', ');
  }
}

// ---- one page ------------------------------------------------------------------------------------------------------------------
function splitTopLevel(list) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const c of list) {
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Keep only the woff2 source of every @font-face; returns the new text and the faces found. */
function rewriteFontFaces(template, mimeOf) {
  const faces = [];
  const out = template.replace(/@font-face\s*\{[^{}]*\}/g, (block) => {
    const family = /font-family\s*:\s*(['"]?)([^;'"]+)\1/.exec(block)?.[2].trim() || 'font';
    const weight = /font-weight\s*:\s*([^;}]+)/.exec(block)?.[1].trim() || '400';
    const style = /font-style\s*:\s*([^;}]+)/.exec(block)?.[1].trim() || 'normal';
    const src = /src\s*:\s*([^;]+);/.exec(block);
    if (!src) return block;
    const entries = splitTopLevel(src[1]).map((e) => e.trim());
    const woff2 =
      entries.find((e) => /format\(\s*['"]?woff2['"]?\s*\)/i.test(e)) ||
      entries.find((e) => {
        UUID_RE.lastIndex = 0;
        const u = e.match(UUID_RE)?.[0];
        return u && mimeOf(u) === 'font/woff2';
      });
    if (!woff2) return block;
    UUID_RE.lastIndex = 0;
    const uuid = woff2.match(UUID_RE)?.[0];
    if (uuid) faces.push({ family, weight, style, uuid });
    let next = block.replace(src[0], () => `src: ${woff2};`);
    if (!/font-display\s*:/.test(next)) next = next.replace(/\}\s*$/, '  font-display: swap;\n}');
    return next;
  });
  return { text: out, faces };
}

const attrRe = (name) => new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
const getAttr = (tag, name) => {
  const m = attrRe(name).exec(tag);
  return m ? (m[1] ?? m[2]) : null;
};
const IMG_TAG_RE = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

/** A sizes value from what the markup says about the picture's width; 100vw when it does not say. */
function sizesFor(tag) {
  const style = getAttr(tag, 'style') || '';
  const m = /(?<![\w-])width\s*:\s*(\d+)px/.exec(style);
  return m ? `${m[1]}px` : '100vw';
}

function titleOf(template) {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(template)?.[1].trim() || '';
}

/** The inline script that tells the loader to leave once React has put the app on screen. */
const READY_SCRIPT = `<script>
// Tells the loader (site/brand/loader.html) to leave once the page runtime has put the app on screen: #dc-root is the node the
// runtime replaces <x-dc> with, and it receives its first child when React makes its first commit; two animation frames later it
// has been painted. The loader has its own 12 s safety net if this never fires.
(function () {
  var fired = false;
  function leave() {
    if (fired) return;
    fired = true;
    if (mo) mo.disconnect();
    var go = function () { try { window.TeruconLoader && window.TeruconLoader.done(); } catch (e) {} };
    if (window.requestAnimationFrame) requestAnimationFrame(function () { requestAnimationFrame(go); }); else setTimeout(go, 50);
  }
  function check() {
    var root = document.getElementById('dc-root');
    if (root && root.firstElementChild) leave();
  }
  var mo = window.MutationObserver ? new MutationObserver(check) : null;
  if (mo) mo.observe(document.documentElement, { childList: true, subtree: true });
  else setInterval(check, 100);
  check();
})();
</script>`;

function buildPage({ key, page, bundle, ctx, log }) {
  const where = `page '${key}' (${page.file})`;
  const fail = (msg) => {
    throw new DistError(`${where}: ${msg}`);
  };
  let template = bundle.template;
  if (typeof template !== 'string' || !template.includes('<head')) fail('the bundle template has no <head>');
  if (bundle.pageOrder.length) fail('this bundle has nested pages (__bundler/page_order); tools/build-dist.js does not support them');
  if (/about:blank#[0-9a-f]{8}-/.test(template)) fail('this page has about:blank#uuid frames (nested bundle pages); tools/build-dist.js does not support them');

  const manifestUuids = new Set(bundle.uuids);
  const mimeOf = (u) => (manifestUuids.has(u) ? bundle.mime(u) : null);
  const extIds = bundle.extIds(); // id -> uuid
  const idOfUuid = new Map();
  for (const [id, uuid] of Object.entries(extIds)) if (!idOfUuid.has(uuid)) idOfUuid.set(uuid, id);

  // 1. fonts: woff2 only
  const fonts = rewriteFontFaces(template, mimeOf);
  template = fonts.text;
  // 2. the dead preconnect
  template = template.replace(/[ \t]*<link\b[^>]*api\.fontshare\.com[^>]*>[ \t]*\n?/gi, '');

  // 3. which uuids are still referenced (fonts dropped above are not), plus every ext resource
  const used = new Set();
  for (const m of template.matchAll(UUID_RE)) if (manifestUuids.has(m[0])) used.add(m[0]);
  for (const u of Object.values(extIds)) if (manifestUuids.has(u)) used.add(u);

  // names: fonts from their @font-face, everything else from the resource id, else from the page
  const nameOf = new Map();
  for (const f of fonts.faces) nameOf.set(f.uuid, `${f.family}-${f.weight}${/italic|oblique/i.test(f.style) ? '-italic' : ''}`);
  let unnamed = 0;

  // 4. emit each used asset into the store (JS gets its third-party addresses rewritten; images may be swapped for variants)
  const urlOf = new Map(); // uuid -> url used in the page
  const optEntryOf = new Map(); // uuid -> optimizer entry (images that have variants)
  const emitted = new Map();
  for (const uuid of [...used].sort()) {
    const mime = bundle.mime(uuid);
    const ext = EXT_BY_MIME[mime] || 'bin';
    let bytes = bundle.asset(uuid);
    const id = idOfUuid.get(uuid);
    if (id === REACT.url || id === REACT_DOM.url) continue; // replaced by the vendored copy below
    let name = nameOf.get(uuid) || (id && !/^https?:/.test(id) ? path.basename(id) : '');
    if (ext === 'js') {
      const text = bytes.toString('utf8');
      if (/\bdc-runtime\b|__dcBoot/.test(text)) name ||= 'dc-runtime';
      else if (/smoothWheel/.test(text) && /lerp/.test(text)) name ||= 'lenis';
      if (text.includes(THREE.url)) {
        const local = ctx.threeUrl();
        bytes = Buffer.from(text.split(THREE.url).join(local), 'utf8');
        log(`        - ${key}: ${id || uuid.slice(0, 8)}: three.js import rewritten to ${local}`);
      }
      const leftover = /loadReactUmd/.test(text) ? null : bytes.toString('utf8').match(/https?:\/\/(?:unpkg\.com|cdn\.[a-z.]+|cdnjs\.[a-z.]+|fonts\.googleapis\.com)[^'"\s)]*/g);
      if (leftover) ctx.thirdParty.push(`${where}: ${id || uuid} still names ${[...new Set(leftover)].join(', ')}`);
    }
    if (!name) name = ext === 'js' ? `${key}-script` : ext === 'jpg' || ext === 'png' || ext === 'webp' ? `${key}-image-${(unnamed += 1)}` : `${key}-${ext}-${(unnamed += 1)}`;
    if (mime === 'image/jpeg' || mime === 'image/png') {
      const entry = ctx.optimizer.lookup(bytes);
      if (entry) optEntryOf.set(uuid, entry);
    }
    if (optEntryOf.has(uuid)) {
      // the resized copies replace the original: it is not written to dist at all
      urlOf.set(uuid, ctx.optimizer.single(optEntryOf.get(uuid)));
      continue;
    }
    const a = ctx.assets.add(bytes, { ext, name });
    emitted.set(uuid, a);
    urlOf.set(uuid, a.url);
  }
  if (used.size && !emitted.size) fail('no asset could be emitted');

  // 5. <img> tags: lazy/async, the one hero image eager and high priority, srcset where variants exist.
  // ORDER MATTERS: the runtime hands the attributes to React in the order they are written, and React sets them one by one, so an
  // image whose `src` comes before `loading="lazy"` has already started downloading (eagerly) when `loading` is set. The page's
  // own markup has `src` first on several images (the four direction photos on the home page, for one). So loading, decoding and
  // fetchpriority are always moved in front of src and srcset.
  const lcp = resolveLcp(PAGE_HINTS[key]?.lcp, { extIds, template, ctx, log, key });
  let lcpTag = null;
  const dropAttr = (t, n) => t.replace(new RegExp(`\\s${n}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'i'), '');
  template = template.replace(IMG_TAG_RE, (tag) => {
    const src = getAttr(tag, 'src');
    if (src === null) return tag;
    // only the page's own pictures (embedded, /media/, or filled in by the template); the logos and icons under /brand/ are small, on
    // screen at once, and stay as written
    if (!(manifestUuids.has(src) || /^\/?media\//.test(src) || src.includes('{{'))) return tag;
    const isLcp = lcp && (src === lcp.uuid || src === lcp.media);
    const front = [];
    let out = tag;
    if (isLcp) {
      out = dropAttr(out, 'loading');
      front.push('fetchpriority="high"');
    } else {
      front.push(`loading="${getAttr(tag, 'loading') || 'lazy'}"`);
      out = dropAttr(out, 'loading');
    }
    front.push(`decoding="${getAttr(tag, 'decoding') || 'async'}"`);
    out = dropAttr(out, 'decoding');
    let entry = null;
    if (manifestUuids.has(src)) entry = optEntryOf.get(src);
    else if (/^\/?media\/[^"'{}]+\.(?:jpe?g|png)$/i.test(src)) entry = ctx.mediaEntry(src);
    if (entry && !attrRe('srcset').test(tag)) {
      const best = ctx.optimizer.single(entry);
      const set = ctx.optimizer.srcset(entry);
      const sizes = sizesFor(tag);
      out = out.replace(attrRe('src'), `src="${best}" srcset="${escAttr(set)}" sizes="${escAttr(sizes)}"`);
      if (isLcp) lcpTag = { href: best, srcset: set, sizes };
    } else if (isLcp) {
      lcpTag = { href: manifestUuids.has(src) ? null : src, uuid: manifestUuids.has(src) ? src : null };
    }
    return out.replace(/^<img\b/i, `<img ${front.join(' ')}`);
  });

  // 5b. <path d="{{ expr }}"> in the live document makes Chrome log "attribute d: Expected moveto path command" once per path (the
  // bundle's DOMParser document never did). The runtime reads `sc-camel-<name>` attributes as <name> (kebabToCamel), so spell it that way.
  template = template.replace(/<path\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => tag.replace(/(\s)d(\s*=\s*["']\{\{)/, '$1sc-camel-d$2'));

  // 6. remaining /media/<picture> references (data-src, data-poster, CSS url(), JS strings) -> the best variant, else untouched.
  // Only a path that is a whole quoted string or url(...) is swapped: the page also prints "media/t01-shell.jpg" as visible
  // placeholder text, and that text must stay as it is.
  if (ctx.optimizer.opt) {
    template = template.replace(/(?<=["'(`])(\/?)(media\/[A-Za-z0-9_.\/-]+\.(?:jpe?g|png))(?=["')`])/g, (m, _slash, rel) => {
      const entry = ctx.mediaEntry(rel);
      return entry ? ctx.optimizer.single(entry) : m;
    });
  }

  // 7. uuids -> urls (the bootstrap's split/join, longest keys do not matter: uuids have a fixed length)
  template = template.replace(UUID_RE, (u) => urlOf.get(u) ?? u);

  // 8. the head: resources, preloads, brand shell
  const resources = {};
  // (the bundles' entries for the two unpkg addresses are left out: window.React and window.ReactDOM exist before the runtime
  // runs, and its loadReactUmd() returns at once when they do; no unpkg address is left in the page)
  for (const [id, uuid] of Object.entries(extIds)) if (id !== REACT.url && id !== REACT_DOM.url && urlOf.has(uuid)) resources[id] = urlOf.get(uuid);
  const resourcesScript = `<script>window.__resources=${JSON.stringify(resources).replace(/<\//g, '<\\/')};</script>`;

  // the page runtime: found by content, it is the only emitted asset that defines loadReactUmd
  const runtime = [...emitted.values()].find((a) => a.ext === 'js' && /loadReactUmd/.test(a.bytes.toString('utf8')));
  if (!runtime) fail('the page runtime (the script that defines loadReactUmd) was not found among the page assets');
  const wanted = /REACT_SRI = "([^"]+)"/.exec(runtime.bytes.toString('utf8'))?.[1];
  const wantedDom = /REACT_DOM_SRI = "([^"]+)"/.exec(runtime.bytes.toString('utf8'))?.[1];
  if (wanted && wanted !== REACT.sha384) fail(`the runtime expects React ${wanted} but site/vendor holds ${REACT.sha384}`);
  if (wantedDom && wantedDom !== REACT_DOM.sha384) fail(`the runtime expects ReactDOM ${wantedDom} but site/vendor holds ${REACT_DOM.sha384}`);

  // the runtime's own <script src> becomes deferred (it is in <head>), and React is loaded just before it
  const runtimeTag = new RegExp(`<script\\b([^>]*\\bsrc="${runtime.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*)></script>`);
  if (!runtimeTag.test(template)) fail('the runtime <script src> tag was not found in the template');
  const headEnd = template.search(/<\/head>/i);
  const runtimeAt = template.search(runtimeTag);
  if (headEnd === -1 || runtimeAt === -1 || runtimeAt > headEnd) fail('the runtime <script src> is not inside <head>');
  const reactScripts = `<script defer src="${ctx.vendor.reactUrl}"></script>\n<script defer src="${ctx.vendor.reactDomUrl}"></script>`;
  template = template.replace(runtimeTag, (m, attrs) => `${reactScripts}\n<script defer${attrs}></script>`);

  const pageTitle = titleOf(template);
  const description = page.metaDescription || page.description || '';
  const tags = [];
  tags.push('<meta charset="utf-8">');
  if (pageTitle) tags.push(`<title>${pageTitle}</title>`);
  const brand = ctx.brand;
  const brandHas = (re) => re.test(brand.head);
  if (description && !brandHas(/name=["']description["']/i)) tags.push(`<meta name="description" content="${escAttr(description)}">`);
  const og = [
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', ctx.site.name || 'Terucon'],
    ['property', 'og:title', pageTitle ? pageTitle.replace(/&amp;/g, '&') : ''],
    ['property', 'og:description', description],
    ['property', 'og:image', '/brand/og-image.jpg'],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', pageTitle ? pageTitle.replace(/&amp;/g, '&') : ''],
    ['name', 'twitter:description', description],
    ['name', 'twitter:image', '/brand/og-image.jpg'],
  ];
  for (const [kind, name, value] of og) {
    if (!value) continue;
    if (brand.head && new RegExp(`${kind}=["']${name}["']`, 'i').test(brand.head)) continue;
    tags.push(`<meta ${kind}="${name}" content="${escAttr(value)}">`);
  }
  if (brand.head) tags.push(brand.head);

  // preloads: the runtime and React (found by the parser at once; listed first so the order of fetches is explicit), the faces
  // used above the fold, and the hero picture
  const pre = [
    `<link rel="preload" as="script" href="${ctx.vendor.reactUrl}">`,
    `<link rel="preload" as="script" href="${ctx.vendor.reactDomUrl}">`,
    `<link rel="preload" as="script" href="${runtime.url}">`,
  ];
  for (const [family, weight] of PAGE_HINTS[key]?.fonts || []) {
    const want = { family, weight };
    const face = fonts.faces.find((f) => f.family === want.family && String(f.weight) === String(want.weight) && !/italic|oblique/i.test(f.style));
    if (!face || !emitted.has(face.uuid)) {
      log(`note: ${where}: the font ${want.family} ${want.weight} to preload is not in this page`);
      continue;
    }
    pre.push(`<link rel="preload" as="font" type="font/woff2" crossorigin href="${emitted.get(face.uuid).url}">`);
  }
  if (lcpTag) {
    if (lcpTag.srcset) pre.push(`<link rel="preload" as="image" href="${escAttr(lcpTag.href)}" imagesrcset="${escAttr(lcpTag.srcset)}" imagesizes="${escAttr(lcpTag.sizes)}" fetchpriority="high">`);
    else {
      const href = lcpTag.uuid ? urlOf.get(lcpTag.uuid) : lcpTag.href;
      if (href) pre.push(`<link rel="preload" as="image" href="${escAttr(href)}" fetchpriority="high">`);
    }
  }
  tags.push(...pre);
  tags.push('<style>x-dc{display:none!important}</style>');
  tags.push(resourcesScript);
  tags.push(READY_SCRIPT);

  // the template's own <meta charset> is replaced by ours (first in <head>)
  const headOpen = /<head\b[^>]*>/i.exec(template);
  const headAt = headOpen.index + headOpen[0].length;
  const headPart = template.slice(headAt, template.search(/<\/head>/i)).replace(/\s*<meta\s+charset=[^>]*>/i, '');
  template = template.slice(0, headAt) + '\n' + tags.join('\n') + headPart + template.slice(template.search(/<\/head>/i));

  // <html lang>
  template = template.replace(/<html\b([^>]*)>/i, (m, attrs) => (/\blang\s*=/.test(attrs) ? m : `<html lang="en"${attrs}>`));
  // the loader: the very first thing in <body>
  if (brand.loader) {
    const bodyOpen = /<body\b[^>]*>/i.exec(template);
    if (!bodyOpen) fail('the template has no <body>');
    const at = bodyOpen.index + bodyOpen[0].length;
    template = template.slice(0, at) + '\n' + brand.loader + '\n' + template.slice(at);
  }

  if (/__bundler/.test(template)) fail('bundle markup is still present after the build');
  return { html: Buffer.from(template, 'utf8'), emitted: emitted.size };
}

/** The hero picture of a page, as the string its <img src> holds before uuids are replaced (a uuid or a media path). */
function resolveLcp(hint, { extIds, template, ctx, log, key }) {
  if (!hint) return null;
  if (hint.resource) {
    const uuid = extIds[hint.resource];
    if (uuid && template.includes(uuid)) return { uuid };
    log(`note: page '${key}': the hero image ${hint.resource} to prioritise is not in this page`);
    return null;
  }
  if (hint.media) {
    if (template.includes(hint.media)) return { media: hint.media };
    log(`note: page '${key}': the hero image ${hint.media} to prioritise is not in this page`);
  }
  return null;
}

// ---- the whole build -----------------------------------------------------------------------------------------------------------
/**
 * Build every page into memory: {files: Map<relative path, Buffer>, manifest, notes}. `compress: false` skips the .br/.gz
 * siblings (used by --check, which compares the primary files only).
 */
export function planDist({ root = ROOT, log = () => {}, compress = true } = {}) {
  const site = loadSite(root);
  const keys = Object.keys(site.pages || {});
  if (!keys.length) throw new DistError('site/site.json lists no pages');
  const vendorBytes = loadVendor(root);
  const assets = new AssetStore();
  const reactAsset = assets.add(vendorBytes.react, { ext: 'js', name: 'react-production-min' });
  const reactDomAsset = assets.add(vendorBytes.reactDom, { ext: 'js', name: 'react-dom-production-min' });
  // three.js is added to dist only when some page's script asks for it (the home page's 3D façade): the core first, so the module
  // can name it by its hashed address
  let threeModuleUrl = null;
  const threeUrl = () => {
    if (threeModuleUrl) return threeModuleUrl;
    const coreAsset = assets.add(vendorBytes.threeCore, { ext: 'js', name: 'three-core-min' });
    const moduleText = vendorBytes.threeModule.toString('utf8');
    if (!moduleText.includes(`"${THREE.coreImport}"`)) throw new DistError(`${VENDOR_DIR}/${THREE.module.file} no longer imports ${THREE.coreImport}`);
    const moduleAsset = assets.add(Buffer.from(moduleText.split(`"${THREE.coreImport}"`).join(`"${coreAsset.url}"`), 'utf8'), { ext: 'js', name: 'three-module-min' });
    threeModuleUrl = moduleAsset.url;
    return threeModuleUrl;
  };

  const optimizer = new Optimizer(loadOptimized(root, log), assets, root, log);
  const mediaCache = new Map();
  const ctx = {
    site,
    assets,
    optimizer,
    brand: readBrand(root),
    vendor: { reactUrl: reactAsset.url, reactDomUrl: reactDomAsset.url },
    threeUrl,
    thirdParty: [],
    /** The optimizer entry for a `media/...` picture of the project, by the hash of the file itself. */
    mediaEntry(rel) {
      if (!optimizer.opt) return null;
      const clean = rel.replace(/^\//, '');
      if (!mediaCache.has(clean)) {
        const file = path.join(root, clean);
        mediaCache.set(clean, fs.existsSync(file) && file.startsWith(path.join(root, 'media') + path.sep) ? optimizer.lookup(fs.readFileSync(file)) : null);
      }
      return mediaCache.get(clean);
    },
  };

  const pages = {};
  const pageFiles = new Map();
  const notes = [];
  const pageLog = (m) => notes.push(m);
  for (const key of keys) {
    const page = site.pages[key];
    const file = path.join(root, page.file);
    let bundle;
    try {
      bundle = Bundle.load(file);
    } catch (e) {
      throw new DistError(`page '${key}' (${page.file}): cannot read as a bundle: ${e.message}`);
    }
    let built;
    try {
      built = buildPage({ key, page, bundle, ctx, log: pageLog });
    } catch (e) {
      if (e instanceof DistError) throw e;
      throw new DistError(`page '${key}' (${page.file}): ${e.stack || e.message}`);
    }
    pageFiles.set(`pages/${key}.html`, built.html);
    pages[key] = { file: `pages/${key}.html`, etag: sha256(built.html).slice(0, 16) };
  }
  if (ctx.thirdParty.length) throw new DistError('a third-party address is still referenced by a script:\n  ' + ctx.thirdParty.join('\n  '));

  const files = new Map();
  const manifestAssets = {};
  const withSiblings = (rel, bytes, compressible) => {
    files.set(rel, bytes);
    let br = false;
    let gz = false;
    if (compress && compressible) {
      const b = brotli(bytes);
      if (b.length < bytes.length) {
        files.set(`${rel}.br`, b);
        br = true;
      }
      const g = gzipLikePython(bytes);
      if (g.length < bytes.length) {
        files.set(`${rel}.gz`, g);
        gz = true;
      }
    }
    return { br, gz };
  };
  for (const [rel, bytes] of [...pageFiles].sort(([a], [b]) => (a < b ? -1 : 1))) withSiblings(rel, bytes, true);
  for (const a of [...assets.byFile.values()].sort((x, y) => (x.file < y.file ? -1 : 1))) {
    const s = withSiblings(`assets/${a.file}`, a.bytes, COMPRESSIBLE.has(a.ext));
    manifestAssets[`assets/${a.file}`] = { bytes: a.bytes.length, br: s.br, gz: s.gz };
  }
  return {
    files,
    pages,
    assets: manifestAssets,
    notes,
    stats: { images: optimizer.stats },
  };
}

function stableBuiltAt(out, plan, given) {
  if (given) return new Date(given).toISOString();
  if (process.env.SOURCE_DATE_EPOCH && /^\d+$/.test(process.env.SOURCE_DATE_EPOCH)) return new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString();
  // nothing changed since the last build: keep its stamp, so a re-run leaves every byte as it was
  try {
    const old = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    if (old.version === MANIFEST_VERSION && JSON.stringify(old.pages) === JSON.stringify(plan.pages) && JSON.stringify(old.assets) === JSON.stringify(plan.assets) && old.builtAt) return old.builtAt;
  } catch {
    /* no previous manifest */
  }
  return new Date().toISOString();
}

function manifestText(plan, builtAt) {
  return JSON.stringify({ version: MANIFEST_VERSION, builtAt, pages: plan.pages, assets: plan.assets }, null, 2) + '\n';
}

function walk(dir, base = dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, acc);
    else acc.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return acc;
}

/** Write the plan into `out`: new and changed files first, the manifest last, then files the plan no longer has are removed. */
export function writeDist({ out, plan, builtAt }) {
  if (fs.existsSync(out)) {
    const entries = fs.readdirSync(out);
    const ours = entries.length === 0 || entries.includes('manifest.json');
    if (!ours) throw new DistError(`${out} exists, is not empty and has no manifest.json from this tool; refusing to write into it`);
  }
  fs.mkdirSync(out, { recursive: true });
  const stamp = stableBuiltAt(out, plan, builtAt);
  const all = new Map(plan.files);
  all.set('manifest.json', Buffer.from(manifestText(plan, stamp), 'utf8'));
  let written = 0;
  const put = (rel, bytes) => {
    const target = path.join(out, rel);
    const current = readIfExists(target);
    if (current && current.length === bytes.length && current.equals(bytes)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, target);
    written += 1;
  };
  for (const [rel, bytes] of all) if (rel !== 'manifest.json') put(rel, bytes);
  put('manifest.json', all.get('manifest.json'));
  let removed = 0;
  for (const rel of walk(out)) {
    if (!all.has(rel)) {
      fs.rmSync(path.join(out, rel), { force: true });
      removed += 1;
    }
  }
  for (const dir of ['assets', 'pages']) {
    // drop empty folders left behind
    try {
      if (fs.existsSync(path.join(out, dir)) && !fs.readdirSync(path.join(out, dir)).length) fs.rmdirSync(path.join(out, dir));
    } catch {
      /* ignore */
    }
  }
  return { written, removed, builtAt: stamp };
}

/** Is `out` what a build of the current inputs would write? Compares every primary file; compressed siblings must exist where the manifest says. */
export function checkDist({ root = ROOT, out = path.join(root, 'dist'), log = () => {} } = {}) {
  const problems = [];
  const manifestFile = path.join(out, 'manifest.json');
  const raw = readIfExists(manifestFile);
  if (!raw) return { ok: false, problems: [`${path.relative(root, out) || out}/manifest.json does not exist`] };
  let onDisk;
  try {
    onDisk = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return { ok: false, problems: [`manifest.json is not valid JSON: ${e.message}`] };
  }
  if (onDisk.version !== MANIFEST_VERSION) problems.push(`manifest.json has version ${onDisk.version}, expected ${MANIFEST_VERSION}`);
  const plan = planDist({ root, log, compress: false });
  for (const [rel, bytes] of plan.files) {
    const cur = readIfExists(path.join(out, rel));
    if (!cur) problems.push(`missing: ${rel}`);
    else if (!cur.equals(bytes)) problems.push(`out of date: ${rel}`);
  }
  for (const [key, p] of Object.entries(plan.pages)) {
    if (!onDisk.pages?.[key] || onDisk.pages[key].etag !== p.etag) problems.push(`manifest: page '${key}' etag differs`);
  }
  const wanted = new Set(plan.files.keys());
  for (const rel of walk(out)) {
    if (rel === 'manifest.json' || rel.endsWith('.br') || rel.endsWith('.gz')) continue;
    if (!wanted.has(rel)) problems.push(`stale: ${rel}`);
  }
  for (const [rel, info] of Object.entries(onDisk.assets || {})) {
    if (info.br && !fs.existsSync(path.join(out, rel + '.br'))) problems.push(`missing: ${rel}.br`);
    if (info.gz && !fs.existsSync(path.join(out, rel + '.gz'))) problems.push(`missing: ${rel}.gz`);
  }
  return { ok: problems.length === 0, problems };
}

/** Build and write. Returns a summary. */
export function buildDist({ root = ROOT, out = path.join(root, 'dist'), builtAt, log = () => {} } = {}) {
  const plan = planDist({ root, log });
  const result = writeDist({ out, plan, builtAt });
  return { ...result, plan };
}

// ---- command line ----------------------------------------------------------------------------------------------------------------
const USAGE =
  'usage: node tools/build-dist.js [--check] [--if-missing] [--out DIR] [--root DIR] [--quiet]\n\n' +
  'Unpacks the Claude Design bundles in pages/ into dist/ (real HTML, content-hashed assets, brotli and gzip copies). See the top of this file.';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--if-missing') args.ifMissing = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--out') args.out = argv[(i += 1)];
    else if (a === '--root') args.root = argv[(i += 1)];
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (('out' in args && !args.out) || ('root' in args && !args.root)) throw new Error('--out and --root need a folder');
  return args;
}

const kb = (n) => `${(n / 1024).toFixed(n > 10240 ? 0 : 1)} KB`;

export function main(argv, { log = console.log } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    log(USAGE);
    return 0;
  }
  const root = path.resolve(args.root || ROOT);
  const out = path.resolve(args.out || path.join(root, 'dist'));
  const say = args.quiet ? () => {} : log;
  try {
    if (args.check) {
      const r = checkDist({ root, out, log: say });
      if (r.ok) {
        say(`dist is current (${path.relative(root, out) || out})`);
        return 0;
      }
      console.error(`dist is NOT current: ${r.problems.slice(0, 12).join('; ')}${r.problems.length > 12 ? `; and ${r.problems.length - 12} more` : ''}\nrun: node tools/build-dist.js`);
      return 1;
    }
    if (args.ifMissing) {
      const raw = readIfExists(path.join(out, 'manifest.json'));
      if (raw) {
        try {
          const m = JSON.parse(raw.toString('utf8'));
          const gone = Object.values(m.pages || {}).map((p) => p.file).concat(Object.keys(m.assets || {})).filter((rel) => !fs.existsSync(path.join(out, rel)));
          if (m.version === MANIFEST_VERSION && !gone.length && Object.keys(m.pages || {}).length) {
            say('dist is present; not rebuilt');
            return 0;
          }
        } catch {
          /* damaged: rebuild */
        }
      }
    }
    const t0 = Date.now();
    const r = buildDist({ root, out, log: say });
    for (const n of r.plan.notes) say(`  ${n}`);
    for (const [k, p] of Object.entries(r.plan.pages)) {
      const html = r.plan.files.get(p.file);
      const br = r.plan.files.get(`${p.file}.br`);
      say(`OK    dist/${p.file}  ${kb(html.length)}${br ? `  (${kb(br.length)} brotli)` : ''}  etag ${p.etag}`);
    }
    const total = Object.values(r.plan.assets).reduce((n, a) => n + a.bytes, 0);
    const imgs = r.plan.stats.images;
    say(`${Object.keys(r.plan.assets).length} assets, ${kb(total)} before compression; ${r.written} files written, ${r.removed} removed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    if (imgs.hit || imgs.miss || imgs.missing) say(`optimized images: ${imgs.hit} swapped, ${imgs.miss} not in the index (originals kept)`);
    return 0;
  } catch (e) {
    if (e instanceof DistError) {
      console.error(`build-dist failed: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
