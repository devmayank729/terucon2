/**
 * What the server serves from dist/ (tools/build-dist.js writes it) and how it negotiates the content coding.
 *
 * dist/ layout (the contract with tools/build-dist.js):
 *   dist/manifest.json   {version: 1, builtAt, pages: {<site.json page key>: {file: "pages/home.html", etag: "<16 hex>"}},
 *                         assets: {"assets/<name>-<hash12>.<ext>": {bytes, br, gz}}}
 *   dist/pages/<key>.html  (+ .html.br, .html.gz next to it)
 *   dist/assets/<name>-<hash12>.<ext>  (+ .br / .gz for the text types)
 *
 * dist/ is optional. When the manifest is missing or unreadable, `page()` answers null for every key and the pages are served
 * from pages/*.html exactly as before (a fresh checkout and the tests have no dist/). The manifest is looked at again at most
 * once a second, so a rebuilt dist/ is picked up without a restart and a half-written one is never trusted: a page is used
 * only when its file is really there.
 */
import fs from 'node:fs';
import path from 'node:path';

const RECHECK_MS = 1000;
/** What a page tag may contain: it ends up inside a quoted ETag header. */
const SAFE_TAG = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Which of `br` / `gzip` the client accepts and prefers, honouring q-values ("br;q=0" refuses it, "*" speaks for the rest).
 * The server's own preference, br before gzip, only breaks a tie: Chrome sends "gzip, deflate, br" and wants br.
 * @param {string | undefined} header the Accept-Encoding request header
 * @param {{br?: boolean, gzip?: boolean}} [have] the codings the server can offer for this file (default: both)
 * @returns {'br' | 'gzip' | 'identity'}
 */
export function chooseEncoding(header, have = { br: true, gzip: true }) {
  if (!header) return 'identity';
  const q = new Map();
  for (const part of String(header).split(',')) {
    const [rawName, ...params] = part.toLowerCase().split(';');
    const name = rawName.trim();
    if (!name) continue;
    let weight = 1;
    for (const param of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param);
      if (m) weight = Number.isFinite(Number(m[1])) ? Number(m[1]) : 0;
    }
    q.set(name === 'x-gzip' ? 'gzip' : name, weight);
  }
  const weightOf = (coding) => q.get(coding) ?? q.get('*') ?? 0;
  let best = 'identity';
  let bestWeight = 0;
  for (const coding of ['br', 'gzip']) {
    if (!have[coding]) continue;
    const weight = weightOf(coding);
    if (weight > bestWeight) {
      best = coding;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * Send one file of dist/ in the content coding chosen for this request. The precompressed copy sits next to the file (".br" /
 * ".gz"); Content-Type is the original's, never the copy's. The response says it was negotiated (`Vary: Accept-Encoding`) and is
 * marked so the compression middleware leaves it alone (server/middleware/compress.js) when it carries a strong ETag or a coding.
 *
 * @param {import('express').Response} res
 * @param {object} o
 * @param {string} o.root folder the file is relative to
 * @param {string} o.relative the uncompressed file, relative to `root`
 * @param {'br' | 'gzip' | 'identity'} o.encoding
 * @param {string} o.type the full Content-Type of the uncompressed file
 * @param {string} [o.etag] a complete validator ("\"abc\""); left out, the file's own weak ETag and Last-Modified are used
 * @param {Record<string, string>} [o.headers] more headers (Cache-Control, ...); Vary is appended to, not replaced
 * @param {boolean} [o.vary] add Vary: Accept-Encoding (the file has, or may have, other codings)
 * @param {boolean} [o.ranges] answer Range requests (never for an encoded body: a byte range of it is useless to a client)
 * @returns {Promise<boolean>} false when the file is not there (nothing was sent and the headers set here are taken back), true otherwise
 */
export function sendVariant(res, { root, relative, encoding, type, etag, headers = {}, vary = true, ranges = false }) {
  const suffix = encoding === 'br' ? '.br' : encoding === 'gzip' ? '.gz' : '';
  const mine = ['Content-Type', 'Content-Encoding', 'ETag'];
  res.set(headers);
  if (vary) res.vary('Accept-Encoding');
  res.set('Content-Type', type);
  if (etag) res.set('ETag', etag);
  if (encoding !== 'identity') res.set('Content-Encoding', encoding);
  // A strong ETag names these exact bytes and a coded body is already final: the compression middleware must not transform either.
  if (etag || encoding !== 'identity') res.locals.skipCompression = true;
  const options = { root, cacheControl: false, etag: !etag, lastModified: !etag, acceptRanges: ranges && encoding === 'identity', headers: {} };
  return new Promise((resolve, reject) => {
    res.sendFile(relative + suffix, options, (err) => {
      if (!err || res.headersSent) return resolve(true);
      if (err.status === 404 || err.code === 'ENOENT' || err.code === 'EISDIR') {
        for (const name of mine) res.removeHeader(name);
        return resolve(false);
      }
      return reject(err);
    });
  });
}

const exists = async (file) => {
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch {
    return false;
  }
};

/**
 * @param {string} root the project folder; dist/ is <root>/dist
 * @param {{warn?: Function, info?: Function}} [log]
 * @param {{recheckMs?: number}} [options] how often the manifest is looked at again (default 1 s; tests use 0)
 */
export function createDist(root, log = {}, { recheckMs = RECHECK_MS } = {}) {
  const dir = path.join(root, 'dist');
  const manifestFile = path.join(dir, 'manifest.json');
  let state = null; // {stamp, builtAt, pages: Map, assets: Map} or null when there is no usable dist
  let stamp = '';
  let checkedAt = 0;
  let warned = '';
  const probed = new Map(); // asset path -> {br, gz}, for files the manifest does not list (found on disk)

  /** The page entries whose files are really there. */
  function loadPages(manifest) {
    const pages = new Map();
    for (const [key, entry] of Object.entries(manifest.pages ?? {})) {
      const file = entry?.file;
      const ok =
        typeof file === 'string' && /^pages\/[^\\\0]+\.html$/.test(file) && !file.split('/').includes('..') && !file.split('/').some((p) => p.startsWith('.')) &&
        typeof entry.etag === 'string' && SAFE_TAG.test(entry.etag);
      if (!ok) continue;
      const stat = (suffix) => {
        try {
          const s = fs.statSync(path.join(dir, file + suffix));
          return s.isFile() && s.size > 0;
        } catch {
          return false;
        }
      };
      if (!stat('')) continue; // the page itself is missing: this key is served from pages/
      pages.set(key, { file, etag: entry.etag, br: stat('.br') ? file + '.br' : null, gz: stat('.gz') ? file + '.gz' : null });
    }
    return pages;
  }

  function reload() {
    checkedAt = Date.now();
    let stat;
    try {
      stat = fs.statSync(manifestFile);
    } catch {
      state = null;
      stamp = '';
      return state;
    }
    const nowStamp = `${stat.mtimeMs}:${stat.size}`;
    if (state && nowStamp === stamp) return state;
    stamp = nowStamp;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (manifest?.version !== 1 || typeof manifest.pages !== 'object' || manifest.pages === null) throw new Error('not a version 1 manifest');
      state = { builtAt: String(manifest.builtAt ?? ''), builtMs: stat.mtimeMs, pages: loadPages(manifest), assets: new Map(Object.entries(manifest.assets ?? {})) };
      probed.clear();
      warned = '';
    } catch (error) {
      state = null;
      // once per broken manifest, not once per request
      if (warned !== nowStamp) log.warn?.(`dist  dist/manifest.json is unusable (${error.message}); the pages are served from pages/ until it is rebuilt: npm run build:dist`);
      warned = nowStamp;
    }
    return state;
  }

  function current() {
    return checkedAt && Date.now() - checkedAt < recheckMs ? state : reload();
  }

  return {
    /** <root>/dist */
    dir,
    assetsDir: path.join(dir, 'assets'),

    /** @returns {{file: string, etag: string, br: string | null, gz: string | null} | null} paths relative to dir; null: serve pages/<file> instead */
    page(key) {
      return current()?.pages.get(key) ?? null;
    },

    /**
     * Which precompressed siblings an asset has. The manifest says for the files it lists; a file it does not list is looked at on disk.
     * @param {string} relative path under dist/assets, e.g. "app-0123456789ab.js"
     * @returns {Promise<{br: boolean, gz: boolean}>}
     */
    async assetCodings(relative) {
      const listed = current()?.assets.get(`assets/${relative}`);
      if (listed) return { br: listed.br === true && (await exists(path.join(dir, 'assets', relative + '.br'))), gz: listed.gz === true && (await exists(path.join(dir, 'assets', relative + '.gz'))) };
      const known = probed.get(relative);
      if (known) return known;
      const found = { br: await exists(path.join(dir, 'assets', relative + '.br')), gz: await exists(path.join(dir, 'assets', relative + '.gz')) };
      if (probed.size < 5000) probed.set(relative, found);
      return found;
    },

    /** What the start-up banner says: whether dist/ is in use, when it was built, how many pages and files. */
    status() {
      const s = current();
      return s ? { enabled: true, builtAt: s.builtAt, builtMs: s.builtMs, pages: [...s.pages.keys()], assets: s.assets.size } : { enabled: false, builtAt: '', builtMs: 0, pages: [], assets: 0 };
    },
  };
}
