/**
 * The landing page (the website's "/"): built in memory from site/landing/ when the server starts.
 *
 *   site/landing/page.html     the page's body, with {{markers}}      server/lib/landing/render.js fills the markers
 *   site/landing/landing.css   inlined, minified, into <head>: the first paint waits for no stylesheet
 *   site/landing/landing.js    one deferred file, hashed
 *   site/landing/fonts/*.woff2 three self-hosted fonts (no request to Google), hashed; only the body font is preloaded
 *   site/landing/img/          responsive WebP copies made by tools/optimize-landing.mjs (the file names carry their own hash)
 *   site/landing/content.json, config.json   the words, and the settings (address, phone, whether a domain is known)
 *
 * What comes out: the page as one HTML document with a strong ETag and its brotli and gzip bodies made once (not per request), and a
 * table of addresses under assetBase ("/lp/") for server/routes/landing.js to serve with `Cache-Control: immutable`.
 *
 * Deterministic: the same files give the same bytes (the year in the footer is the one thing that changes; landing.js keeps it current).
 * Nothing here reads the network, a database or the settings: `GET /` costs a Map lookup.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { esc, jsonLd, sections, structuredData } from './render.js';

export const LANDING_DIR = path.join('site', 'landing');
export const SNIPPETS_DIR = path.join('site', 'patches', 'snippets');

const sha = (buf, n = 12) => createHash('sha256').update(buf).digest('hex').slice(0, n);
const brotli = (buf) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
const gzip = (buf) => zlib.gzipSync(buf, { level: 9 });
const read = (file) => fs.readFileSync(file);
const readText = (file) => fs.readFileSync(file, 'utf8');

export class LandingError extends Error {}

/**
 * CSS, made smaller without changing what it says: comments out, runs of white space shrunk, no space around { } ; , > or after a colon,
 * no ; before }. Quoted strings are left alone. (+ and - keep their spaces: calc() needs them.)
 */
export function minifyCss(css) {
  // pass 1: drop comments, keeping strings whole (a quote inside a comment is not a string)
  let bare = '';
  for (let i = 0; i < css.length; ) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch) j += css[j] === '\\' ? 2 : 1;
      bare += css.slice(i, j + 1);
      i = j + 1;
    } else {
      bare += ch;
      i += 1;
    }
  }
  // pass 2: white space, outside strings only
  return bare
    .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)
    .map((p, i) =>
      i % 2
        ? p
        : p
            .replace(/\s+/g, ' ')
            .replace(/\s*([{};,>])\s*/g, '$1')
            .replace(/:\s+/g, ':')
            .replace(/;}/g, '}'),
    )
    .join('')
    .trim();
}

/** JavaScript with the full-line comments and the indentation taken out. Nothing else is touched (no renaming, no joining of lines). */
export function trimJs(js) {
  return js
    .split('\n')
    .map((l) => l.replace(/^\s+/, ''))
    .filter((l) => l && !l.startsWith('//'))
    .join('\n');
}

/** The first hero picture, named in <head> (before the long inline stylesheet) so the browser starts it at once; the two links match the <picture>'s srcset and sizes, so it is fetched once. */
function heroPreload(c) {
  const set = (id) => c.img[id].variants.map((v) => `${c.url(v.file)} ${v.w}w`).join(', ');
  const largest = (id) => c.url(c.img[id].variants.at(-1).file);
  const one = (id, media) => `<link rel="preload" as="image" href="${largest(id)}" imagesrcset="${set(id)}" imagesizes="100vw" media="${media}" fetchpriority="high">`;
  return [one('hero-01', '(orientation: landscape)'), one('hero-01-m', '(orientation: portrait)')].join('\n');
}

function head(c, { css, fontPreload }) {
  const { cfg } = c;
  const site = cfg.siteUrl ? cfg.siteUrl.replace(/\/$/, '') : '';
  const title = 'Terucon India — ACP Façades, Commercial Interiors & Turnkey Execution | Bengaluru';
  const desc = 'Terucon India Private Limited delivers ACP cladding, façades, commercial interiors, false ceilings, flooring, civil, painting, fabrication and glazing — one accountable team across Bengaluru and Karnataka.';
  const ogTitle = 'Terucon India — Façades, Commercial Interiors & Turnkey Execution';
  const ogDesc = 'ACP façades, commercial interiors and turnkey project execution — one accountable team from material selection to final handover.';
  return [
    '<!doctype html>',
    '<html lang="en-IN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    ...(site ? [`<link rel="canonical" href="${esc(site)}/">`] : []),
    '<meta name="theme-color" content="#1F150A">',
    '<meta name="color-scheme" content="only light">',
    '<meta name="robots" content="index,follow,max-image-preview:large">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Terucon India">',
    '<meta property="og:locale" content="en_IN">',
    ...(site ? [`<meta property="og:url" content="${esc(site)}/">`] : []),
    `<meta property="og:title" content="${esc(ogTitle)}">`,
    `<meta property="og:description" content="${esc(ogDesc)}">`,
    '<meta name="twitter:card" content="summary">',
    '<link rel="icon" href="/favicon.ico" sizes="any">',
    '<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">',
    '<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    heroPreload(c),
    fontPreload,
    `<style>${css}</style>`,
    `<script type="application/ld+json">${jsonLd(structuredData(c))}</script>`,
    '</head>',
    '<body>',
  ].join('\n');
}

/**
 * Build the landing page.
 * @param {{root: string, now?: () => Date, log?: {info?: Function, warn?: Function}}} o
 * @returns {null | {html: Buffer, htmlBr: Buffer, htmlGz: Buffer, etag: string, assetBase: string, assets: Map<string, object>, report: object}}
 *   null when the project has no site/landing/page.html (an older checkout or a test folder): the website then serves its own landing page.
 */
export function buildLanding({ root, now = () => new Date(), log = {} }) {
  const dir = path.join(root, LANDING_DIR);
  if (!fs.existsSync(path.join(dir, 'page.html'))) return null;

  const cfg = JSON.parse(readText(path.join(dir, 'config.json')));
  const content = JSON.parse(readText(path.join(dir, 'content.json')));
  const imgIndexFile = path.join(dir, 'img', 'index.json');
  const img = fs.existsSync(imgIndexFile) ? JSON.parse(readText(imgIndexFile)) : {};
  const base = cfg.assetBase || '/lp/';
  if (!/^\/[A-Za-z0-9_-]+\/$/.test(base)) throw new LandingError(`config.json assetBase must look like "/lp/", not ${JSON.stringify(base)}`);
  for (const id of ['hero-01', 'hero-01-m', 'hero-02', 'hero-02-m', 'hero-03', 'hero-03-m', 'hero-04', 'hero-04-m']) {
    if (!img[id]) throw new LandingError(`site/landing/img/index.json has no "${id}": the first screen cannot be built (run node tools/optimize-landing.mjs)`);
  }

  /** @type {Map<string, {type: string, file?: string, body?: Buffer, br?: Buffer, gz?: Buffer}>} */
  const assets = new Map();
  const TYPES = { '.webp': 'image/webp', '.woff2': 'font/woff2', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const addBody = (stem, ext, body, compress) => {
    const name = `${stem}-${sha(body)}${ext}`;
    assets.set(name, { type: TYPES[ext], body, ...(compress && { br: brotli(body), gz: gzip(body) }) });
    return name;
  };

  // pictures: served from disk under the names the index already carries (they contain their own hash)
  for (const entry of Object.values(img)) {
    for (const v of entry.variants) {
      const file = path.join(dir, 'img', v.file);
      if (!fs.existsSync(file)) throw new LandingError(`site/landing/img/${v.file} is in index.json but not on disk (run node tools/optimize-landing.mjs)`);
      assets.set(v.file, { type: TYPES['.webp'], file });
    }
  }
  // fonts
  const fonts = {};
  for (const [key, file] of [['GEIST', 'geist-latin-var.woff2'], ['MONO', 'geist-mono-latin-400.woff2'], ['SERIF', 'instrument-serif-latin-400-italic.woff2']]) {
    fonts[key] = addBody(file.replace(/\.woff2$/, ''), '.woff2', read(path.join(dir, 'fonts', file)), false);
  }
  const url = (name) => `${base}${name}`;

  // css, inlined
  const adjust = cfg.fontAdjust || {};
  let css = readText(path.join(dir, 'landing.css'))
    .replaceAll('__F_GEIST__', url(fonts.GEIST))
    .replaceAll('__F_MONO__', url(fonts.MONO))
    .replaceAll('__F_SERIF__', url(fonts.SERIF))
    .replaceAll('__ADJ_GEIST__', adjust.geist || '100%')
    .replaceAll('__ADJ_GEIST5__', adjust.geist5 || adjust.geist || '100%')
    .replaceAll('__ADJ_MONO__', adjust.mono || '100%')
    .replaceAll('__ADJ_SERIF__', adjust.serif || '100%');
  if (/__[A-Z_]+__/.test(css)) throw new LandingError(`landing.css still has a placeholder: ${css.match(/__[A-Z_]+__/)[0]}`);
  css = minifyCss(css);

  // script, and the one that waits for a real visitor (warm-up + analytics, the site's existing snippets: one file, one request)
  const js = addBody('landing', '.js', Buffer.from(trimJs(readText(path.join(dir, 'landing.js'))), 'utf8'), true);
  const snippetFiles = ['warmup.js', 'analytics.js'].map((f) => path.join(root, SNIPPETS_DIR, f)).filter((f) => fs.existsSync(f));
  if (snippetFiles.length < 2) log.warn?.('landing  site/patches/snippets/{warmup,analytics}.js not both found: the page loads without them');
  const later = snippetFiles.length ? addBody('later', '.js', Buffer.from(snippetFiles.map((f) => `;${readText(f)}`).join('\n'), 'utf8'), true) : null;

  const year = now().getUTCFullYear();
  const c = { cfg, content, img, url, year };
  const values = sections(c);
  let body = readText(path.join(dir, 'page.html')).replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (m, key) => {
    if (!(key in values)) throw new LandingError(`site/landing/page.html has {{${key}}} and render.js does not make it`);
    return values[key];
  });
  const missing = body.match(/\{\{[^}]*\}\}/);
  if (missing) throw new LandingError(`unreplaced marker ${missing[0]} in the page`);

  const fontPreload = `<link rel="preload" as="font" type="font/woff2" href="${url(fonts.GEIST)}" crossorigin>`;
  const html = Buffer.from(`${head(c, { css, fontPreload })}\n${body}\n<script src="${url(js)}" defer${later ? ` data-later="${url(later)}"` : ''}></script>\n</body>\n</html>\n`, 'utf8');
  const etag = sha(html, 16);

  // what the page asks for must exist: every /lp/ address in the HTML, and (in the CSS) the fonts
  const asked = new Set([...html.toString('utf8').matchAll(new RegExp(`${base}([A-Za-z0-9._-]+)`, 'g'))].map((m) => m[1]));
  for (const name of asked) if (!assets.has(name)) throw new LandingError(`the page asks for ${base}${name}, which is not built`);

  return {
    html,
    htmlBr: brotli(html),
    htmlGz: gzip(html),
    etag,
    assetBase: base,
    assets,
    report: { htmlBytes: html.length, cssBytes: css.length, jsBytes: assets.get(js).body.length, assets: assets.size, preloaded: [url(fonts.GEIST)], asked: asked.size },
  };
}
