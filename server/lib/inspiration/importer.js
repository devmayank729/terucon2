/**
 * Inspiration import (target C3): turn a pasted address into a picture the browser can crop, safely.
 *
 *   resolve(text)   what is this address, and which pictures does it hold?  -> items, each with an opaque token
 *   file(token)     the bytes of one of those pictures, checked                -> {bytes, type, width, height}
 *
 * The browser never names a picture address. It gets tokens; a token stands for one address this server worked out itself, belongs
 * to the account that asked, and expires. So this is not an open proxy: the only way to make the server fetch something is to give it
 * an address that classify() accepts, and what it fetches is what that address (or gallery-dl, for a site we have a profile for)
 * names. Every fetch goes through safeFetch (public addresses only), and every answer through sniffImage (a real picture, within
 * size). The rest of the limits: a few imports an hour per account and per network address, a few at a time, and answers are
 * remembered for ten minutes so a board asked for twice is read once.
 *
 * Three kinds of address (site/inspiration/sources.js): a site gallery-dl has a profile for (read by gallery-dl, python/
 * gallery_resolve.py), a link to a picture file (fetched as it is), and any other web page (its own named main picture, pageImages.js).
 */
import crypto from 'node:crypto';
import { detect, isCdnOf, sourceById, supportedSites } from '../../../site/inspiration/sources.js';
import { RateLimiter } from '../rateLimit.js';
import { failure, ImportError } from './gallery.js';
import { sizeAllowed, sniffImage } from './imageBytes.js';
import { pageImages } from './pageImages.js';
import { createSafeFetch, FetchError } from './safeFetch.js';

export { ImportError };

const TOKEN_TTL_MS = 15 * 60 * 1000;
const RESOLVE_CACHE_MS = 10 * 60 * 1000;
const BYTES_CACHE_MS = 10 * 60 * 1000;
const BYTES_CACHE_TOTAL = 96 * 1024 * 1024;
const MAX_TOKENS = 3000;
const MAX_TOKENS_PER_OWNER = 200;
const RESOLVES_PER_OWNER_PER_HOUR = 30;
const RESOLVES_PER_ADDRESS_PER_HOUR = 90;
const FILES_PER_OWNER_PER_HOUR = 90;
const MAX_AT_ONCE = 3;
const MAX_PAGE_BYTES = 1_500_000;

/** @typedef {{account: string | null, address: string}} Who */

const FETCH_MESSAGES = {
  'bad-address': [400, 'That is not an address we can read.'],
  blocked: [422, 'We can only read public websites.'],
  timeout: [504, 'The site took too long to answer. Please try again.'],
  'too-big': [413, 'That picture is too big to import. Try a smaller one, or upload it after shrinking it.'],
  type: [415, 'That is not a picture.'],
  status: [502, 'The site would not give us that picture. It may be private or removed. You can save it and upload it instead.'],
  redirects: [502, 'That address goes round in circles.'],
  network: [502, 'We could not reach that site just now. Please try again.'],
};

function fromFetch(error) {
  if (error instanceof ImportError) return error;
  if (!(error instanceof FetchError)) throw error;
  if (error.code === 'status' && error.status === 404) return new ImportError('not-found', 404, 'We could not find that. Check the address, and that it is public.');
  if (error.code === 'status' && (error.status === 401 || error.status === 403)) return new ImportError('private', 422, 'That looks private, or it needs a sign-in. Only public pictures can be imported. You can save the picture and upload it instead.');
  const [status, message] = FETCH_MESSAGES[error.code] ?? FETCH_MESSAGES.network;
  return new ImportError(error.code, status, message);
}

/**
 * @param {object} options
 * @param {() => {enabled: boolean, python: string, script: string, limit: number, timeoutMs: number, maxFileBytes: number}} options.settings read on every use
 * @param {ReturnType<import('./gallery.js').createGalleryRunner>} options.gallery
 * @param {ReturnType<typeof createSafeFetch>} [options.fetcher]
 * @param {{warn: Function}} [options.log]
 * @param {() => number} [options.now]
 */
export function createImporter({ settings, gallery, fetcher = createSafeFetch(), log, now = Date.now }) {
  const perOwner = new RateLimiter({ windowMs: 3600000, now });
  const perAddress = new RateLimiter({ windowMs: 3600000, now });
  const filesPerOwner = new RateLimiter({ windowMs: 3600000, now });
  const tokens = new Map(); // token -> {owner, url, sourceId, expires, title}
  const resolved = new Map(); // canonical address -> {until, answer}
  const bytesCache = new Map(); // token -> {until, size, value}
  let bytesTotal = 0;
  let running = 0;

  const ownerOf = ({ account, address }) => (account ? `u:${account}` : `ip:${address}`);

  function forget(token) {
    const hit = bytesCache.get(token);
    if (hit) {
      bytesTotal -= hit.size;
      bytesCache.delete(token);
    }
  }
  function sweep() {
    const t = now();
    for (const [token, entry] of tokens) {
      if (entry.expires < t) {
        tokens.delete(token);
        forget(token);
      }
    }
    for (const [token, hit] of bytesCache) if (hit.until < t) forget(token);
    for (const [key, hit] of resolved) if (hit.until < t) resolved.delete(key);
  }

  function issue(owner, item, sourceId) {
    sweep();
    const mine = [...tokens].filter(([, e]) => e.owner === owner);
    for (const [old] of mine.slice(0, Math.max(0, mine.length - (MAX_TOKENS_PER_OWNER - 1)))) {
      tokens.delete(old);
      forget(old);
    }
    while (tokens.size >= MAX_TOKENS) {
      const oldest = tokens.keys().next().value;
      tokens.delete(oldest);
      forget(oldest);
    }
    const token = crypto.randomBytes(18).toString('base64url');
    tokens.set(token, { owner, url: item.url, sourceId, expires: now() + TOKEN_TTL_MS });
    return token;
  }

  function checkRate(who, owner) {
    for (const [limiter, key, limit] of [[perOwner, owner, RESOLVES_PER_OWNER_PER_HOUR], [perAddress, `ip:${who.address}`, RESOLVES_PER_ADDRESS_PER_HOUR]]) {
      const room = limiter.check(key, limit);
      if (!room.ok) throw new ImportError('rate', 429, 'You have imported a lot of links in the last hour. Please try again later.', room.retryAfter);
    }
    perOwner.record(owner);
    perAddress.record(`ip:${who.address}`);
  }

  async function slot(work) {
    if (running >= MAX_AT_ONCE) throw new ImportError('busy', 503, 'Other imports are running. Please try again in a minute.', 30);
    running += 1;
    try {
      return await work();
    } finally {
      running -= 1;
    }
  }

  const maxFile = () => settings().maxFileBytes;
  /** What to read for a content type: a picture up to the file limit, a page up to MAX_PAGE_BYTES, nothing else. */
  const limitFor = (type) => (type.startsWith('image/') || type === 'application/octet-stream' || type === 'binary/octet-stream' ? maxFile() : /^(?:text\/html|application\/xhtml\+xml)$/.test(type) ? MAX_PAGE_BYTES : 0);

  /** Check bytes and keep them for the file route. */
  function accept(token, body) {
    const looked = sniffImage(body);
    if (!looked) throw new ImportError('not-an-image', 415, 'That is not a picture we can open. Pictures must be JPEG, PNG, WebP, GIF or AVIF.');
    if (!sizeAllowed(looked)) throw new ImportError('too-big', 413, 'That picture is too large to import. Try a smaller one.');
    const value = { bytes: body, type: looked.type, width: looked.width, height: looked.height };
    forget(token);
    if (body.length <= BYTES_CACHE_TOTAL / 4) {
      while (bytesTotal + body.length > BYTES_CACHE_TOTAL && bytesCache.size) forget(bytesCache.keys().next().value);
      bytesCache.set(token, { until: now() + BYTES_CACHE_MS, size: body.length, value });
      bytesTotal += body.length;
    }
    return value;
  }

  /** The items for an address: a site gallery-dl reads, a picture link, or a page. Not yet tokens. */
  async function items(found) {
    if (found.type === 'source') {
      const source = sourceById(found.source.id);
      if (!gallery.ready()) throw new ImportError('not-set-up', 503, 'Importing from links is not set up on this server yet.');
      const answer = await slot(() => gallery.run({ url: found.url, sourceId: source.id, extractor: found.extractor, follows: found.follows, options: source.options, thumbs: source.thumbs, firstOnly: found.kind === 'photo' && source.firstOnly }));
      const list = found.kind === 'photo' && source.firstOnly ? answer.items.slice(0, 1) : answer.items;
      return { title: answer.title, approximate: false, items: list.map((i) => ({ url: i.url, width: i.width, height: i.height, title: i.title, preview: i.thumb ?? i.url })) };
    }
    if (found.type === 'direct') return { title: '', approximate: false, items: [{ url: found.url, width: null, height: null, title: '', preview: null }] };
    // any other page: it may also turn out to be a picture (an address with no file ending), which is then used as it is
    const got = await slot(() => fetcher.get(found.url, { accept: 'text/html,application/xhtml+xml,image/*;q=0.9', maxBytes: limitFor }).catch((e) => {
      throw fromFetch(e);
    }));
    if (got.contentType.startsWith('image/') || got.contentType.endsWith('octet-stream')) return { title: '', approximate: false, items: [{ url: got.finalUrl, width: null, height: null, title: '', preview: null, bytes: got.body }] };
    const page = pageImages(got.body.toString('utf8'), got.finalUrl);
    if (!page.images.length) throw new ImportError('empty', 404, 'That page does not name a main picture. Open the picture itself and paste its address, or upload it.');
    // one picture: the page's own choice. (More would need previews, and a preview from a site we do not know is not loaded for you.)
    return { title: page.title, approximate: true, items: [{ url: page.images[0], width: null, height: null, title: page.title, preview: null }] };
  }

  return {
    sites: supportedSites,

    status() {
      const cfg = settings();
      return { enabled: cfg.enabled, ready: cfg.enabled && gallery.ready(), sites: supportedSites(), maxFileMb: Math.floor(cfg.maxFileBytes / 1048576) };
    },

    /**
     * @param {string} text what the person pasted or typed
     * @param {Who} who
     */
    async resolve(text, who) {
      const cfg = settings();
      if (!cfg.enabled) throw new ImportError('off', 503, 'Importing from links is switched off.');
      const found = detect(String(text ?? '').slice(0, 4000));
      if (!found) throw new ImportError('bad-address', 400, 'Paste the address of a photo, a Pinterest pin or board, or a web page with a picture.');
      if (found.type === 'login') throw new ImportError('login', 422, found.message);
      if (found.type === 'unsupported') throw new ImportError('unsupported', 422, found.message);
      const owner = ownerOf(who);
      sweep();
      let answer = resolved.get(found.url)?.answer;
      if (!answer) {
        checkRate(who, owner);
        answer = await items(found);
        // remembered without any picture bytes (a page that was itself a picture): those live in bytesCache, under their token
        resolved.set(found.url, { until: now() + RESOLVE_CACHE_MS, answer: { ...answer, items: answer.items.map(({ bytes, ...rest }) => rest) } });
        if (resolved.size > 200) resolved.delete(resolved.keys().next().value);
      }
      const sourceId = found.type === 'source' ? found.source.id : null;
      const out = answer.items.map((item) => {
        const token = issue(owner, item, sourceId);
        if (item.bytes) accept(token, item.bytes); // an address that turned out to be a picture was already downloaded
        return { token, preview: item.preview, width: item.width, height: item.height, title: item.title };
      });
      return {
        type: found.type,
        kind: out.length > 1 ? 'collection' : 'photo', // by what was found: a short link may lead to a board, a pin may be a carousel
        source: found.source ?? { id: found.type, label: found.host.replace(/^www\./, '') },
        shape: found.shape ?? null,
        title: answer.title,
        approximate: answer.approximate,
        items: out,
      };
    },

    /**
     * @param {string} token
     * @param {Who} who
     * @returns {Promise<{bytes: Buffer, type: string, width: number | null, height: number | null}>}
     */
    async file(token, who) {
      sweep();
      const owner = ownerOf(who);
      const entry = typeof token === 'string' && token.length <= 64 ? tokens.get(token) : undefined;
      if (!entry || entry.owner !== owner) throw new ImportError('expired', 410, 'This import has expired. Paste the address again.');
      const hit = bytesCache.get(token);
      if (hit) return hit.value;
      const room = filesPerOwner.check(owner, FILES_PER_OWNER_PER_HOUR);
      if (!room.ok) throw new ImportError('rate', 429, 'You have imported a lot of pictures in the last hour. Please try again later.', room.retryAfter);
      const host = new URL(entry.url).hostname;
      // a site we have a profile for is only ever read from its own picture hosts, even if its answer said otherwise
      if (entry.sourceId && !isCdnOf(entry.sourceId, host)) {
        log?.warn(`inspiration  refused a picture host outside the list for ${entry.sourceId}: ${host}`);
        throw failure('failed');
      }
      filesPerOwner.record(owner);
      const got = await slot(() => fetcher.get(entry.url, { accept: 'image/*', maxBytes: (type) => (type.startsWith('image/') || type.endsWith('octet-stream') ? maxFile() : 0) }).catch((e) => {
        throw fromFetch(e);
      }));
      return accept(token, got.body);
    },

    close() {
      perOwner.close();
      perAddress.close();
      filesPerOwner.close();
    },
  };
}
