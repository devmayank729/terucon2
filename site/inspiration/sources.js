/**
 * Inspiration import (target C3): where a picture can come from, and how to tell from a pasted address.
 *
 * ONE file, used twice. The browser loads it to decide, the moment something is pasted, whether to ask "import this photo?"
 * and what to call it. The server imports the same file and decides again, from the text it is sent: the browser is never
 * trusted. It has no imports and uses no browser or Node API, so both can load it, and tests/js/inspiration-sources.test.js
 * runs it in Node.
 *
 * Every address ends up as one of five kinds (`type`):
 *   source       a site gallery-dl understands: it is asked for the picture(s), with that site's own options (`options`)
 *   direct       a link to the picture file itself: fetched as it is
 *   page         any other web page: its main picture (og:image and friends) is used. Approximate, and said so
 *   login        a site that shows nothing without a sign-in (Instagram, Facebook, X): refused with a plain message
 *   unsupported  a page of a known site that is not a picture or a collection of pictures (a profile): refused with a message
 *
 * Adding a site is adding an entry to SOURCES: its hosts, the shapes of its addresses, the gallery-dl options that give the best
 * picture, and the hosts its pictures come from (`cdn`). Each shape names the gallery-dl extractor the address must reach;
 * tests/js/inspiration-gallery-contract.test.js asks the installed gallery-dl, offline, whether it does.
 */

/** File endings that are pictures a browser can decode and the studio can take. SVG and HEIC are left out on purpose. */
export const PICTURE_ENDING = /\.(?:jpe?g|png|webp|gif|avif)$/i;

const MAX_ADDRESS = 2000;

const strictSegment = /^[\p{L}\p{N}_.\-@ ]{1,100}$/u;
/** For sites whose names hold punctuation (Wikimedia file names have brackets, commas, quotes). Still no control characters or slashes. */
const looseSegment = /^[^\u0000-\u001f\u007f\\]{1,250}$/u;

/** The decoded path parts of an address, or null when one is not plain text (a stray %, a control character, "..", a leading "-"). */
function partsOf(pathname, loose = false) {
  const segment = loose ? looseSegment : strictSegment;
  const out = [];
  for (const raw of pathname.split('/').filter(Boolean)) {
    let plain;
    try {
      plain = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!segment.test(plain) || plain.startsWith('-') || /^\.+$/.test(plain)) return null;
    out.push(plain);
  }
  return out;
}

const enc = encodeURIComponent;
/** A user name in an address: Flickr ids look like 12345678@N05, and gallery-dl matches the plain @. */
const encName = (text) => enc(text).replace(/%40/g, '@');

/** Pinterest's own pages, not a person's name: /pin/123/ is not "user pin, board 123". */
const PINTEREST_RESERVED = new Set(['pin', 'ideas', 'search', 'topics', 'today', 'business', 'explore', 'settings', 'login', 'news_hub', 'videos', 'shop', 'oauth', 'resource', '_', 'about', 'help', 'policy', 'create', 'discover', 'password', 'signup', 'following', 'followers']);
/** Pages of a person's profile that are not boards. */
const PINTEREST_PROFILE_PAGES = new Set(['pins', '_created', '_saved', '_shop', '_tools', 'boards', 'following', 'followers', 'likes']);

const PROFILE = (site) => `That is a ${site} profile, not a picture. Paste the address of one picture or one collection instead.`;

/**
 * @typedef {object} Shape
 * @property {string} name what it is, for people and logs
 * @property {'photo' | 'collection' | 'none'} kind photo: one picture; collection: several (the person picks one); none: refused
 * @property {RegExp} [host] replaces the source's `hosts` for this shape
 * @property {(parts: string[], url: URL) => string | null} build the canonical address rebuilt from its parts, or null when this is not that shape
 * @property {string} [extractor] the gallery-dl extractor ("category:subcategory") the canonical address must reach
 * @property {string[]} [follows] a short link only: the extractors of the one address it may lead to (a pin or a board)
 * @property {string} [message] kind "none": what to tell the person
 * @property {string} example an address of this shape (tests)
 */

/**
 * @typedef {object} Source
 * @property {string} id
 * @property {string} label what people call it
 * @property {RegExp[]} hosts
 * @property {boolean} [loose] address parts may hold punctuation (see looseSegment)
 * @property {boolean} [firstOnly] a single-picture address gives its first picture only (the rest are other versions of it)
 * @property {Shape[]} shapes tried in order, the first that builds an address wins
 * @property {string[]} cdn where this site's pictures are served from ("*.pinimg.com"): a picture from anywhere else is dropped
 * @property {Record<string, unknown>} options gallery-dl extractor options (gallery-dl.conf, "extractor" > this site): see python/gallery_resolve.py
 * @property {string} [thumbs] how to pick a small picture for the chooser: a key of THUMBS in python/gallery_resolve.py
 */

/** @type {Source[]} */
export const SOURCES = [
  {
    id: 'pinterest',
    label: 'Pinterest',
    hosts: [/^(?:[a-z0-9-]+\.)?pinterest\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/],
    shapes: [
      {
        name: 'pin',
        kind: 'photo',
        extractor: 'pinterest:pin',
        example: 'https://in.pinterest.com/pin/1234567890123456/sent/?invite_code=abc',
        build: (parts) => (parts[0] === 'pin' && parts.length >= 2 && /^[A-Za-z0-9_-]{3,100}$/.test(parts[1]) ? `https://www.pinterest.com/pin/${parts[1]}/` : null),
      },
      {
        name: 'board section',
        kind: 'collection',
        extractor: 'pinterest:section',
        example: 'https://www.pinterest.com/some_one/kitchen-ideas/island-lights/',
        build: (parts) => (parts.length === 3 && !PINTEREST_RESERVED.has(parts[0].toLowerCase()) && !PINTEREST_PROFILE_PAGES.has(parts[1]) ? `https://www.pinterest.com/${parts.map(enc).join('/')}/` : null),
      },
      {
        name: 'board',
        kind: 'collection',
        extractor: 'pinterest:board',
        example: 'https://pinterest.co.uk/some_one/kitchen-ideas/',
        build: (parts) => (parts.length === 2 && !PINTEREST_RESERVED.has(parts[0].toLowerCase()) && !PINTEREST_PROFILE_PAGES.has(parts[1]) ? `https://www.pinterest.com/${parts.map(enc).join('/')}/` : null),
      },
      {
        name: 'profile',
        kind: 'none',
        message: PROFILE('Pinterest'),
        example: 'https://www.pinterest.com/some_one/',
        build: (parts) => (parts.length >= 1 && parts.length <= 2 && !PINTEREST_RESERVED.has(parts[0].toLowerCase()) ? 'profile' : null),
      },
    ],
    cdn: ['*.pinimg.com'],
    // One picture per pin, at its original size: a video pin or a story pin gives its cover picture. A board gives its own pins.
    options: { videos: false, stories: false, sections: false },
    thumbs: 'pinterest',
  },
  {
    id: 'pinterest-short',
    label: 'Pinterest',
    hosts: [/^pin\.it$/],
    shapes: [{ name: 'short link', kind: 'photo', extractor: 'pinterest:pinit', follows: ['pinterest:pin', 'pinterest:board'], example: 'https://pin.it/4AbCdEf', build: (parts) => (parts.length === 1 && /^[A-Za-z0-9]{3,24}$/.test(parts[0]) ? `https://pin.it/${parts[0]}` : null) }],
    cdn: ['*.pinimg.com'],
    options: { videos: false, stories: false, sections: false },
    thumbs: 'pinterest',
  },
  {
    id: 'unsplash',
    label: 'Unsplash',
    hosts: [/^(?:www\.)?unsplash\.com$/],
    shapes: [
      { name: 'photo', kind: 'photo', extractor: 'unsplash:image', example: 'https://unsplash.com/photos/a-kitchen-with-a-wooden-island-Ab12Cd34Ef5?utm_source=x', build: (parts) => (parts[0] === 'photos' && parts.length === 2 && /^[A-Za-z0-9_-]{6,120}$/.test(parts[1]) ? `https://unsplash.com/photos/${parts[1]}` : null) },
      { name: 'collection', kind: 'collection', extractor: 'unsplash:collection', example: 'https://unsplash.com/collections/12345678/modern-interiors', build: (parts) => (parts[0] === 'collections' && parts.length >= 2 && /^[A-Za-z0-9_-]{3,40}$/.test(parts[1]) ? `https://unsplash.com/collections/${parts[1]}${parts[2] ? `/${enc(parts[2])}` : ''}` : null) },
    ],
    cdn: ['images.unsplash.com', 'plus.unsplash.com'],
    // "full": the photo at its full size as a JPEG. "raw" is the uncompressed original, often 20 MB and more than the studio takes.
    options: { format: 'full' },
  },
  {
    id: 'pexels',
    label: 'Pexels',
    hosts: [/^(?:www\.)?pexels\.com$/],
    shapes: [
      { name: 'photo', kind: 'photo', extractor: 'pexels:image', example: 'https://www.pexels.com/photo/white-wooden-cabinet-1457842/', build: (parts) => (parts[0] === 'photo' && parts.length === 2 && /^(?:[A-Za-z0-9_-]*-)?\d+$/.test(parts[1]) ? `https://www.pexels.com/photo/${parts[1]}/` : null) },
      { name: 'collection', kind: 'collection', extractor: 'pexels:collection', example: 'https://www.pexels.com/collections/living-rooms-a1b2c3d/', build: (parts) => (parts[0] === 'collections' && parts.length === 2 && /^[A-Za-z0-9_-]{3,120}$/.test(parts[1]) ? `https://www.pexels.com/collections/${parts[1]}/` : null) },
    ],
    cdn: ['images.pexels.com'],
    options: {},
  },
  {
    id: 'flickr',
    label: 'Flickr',
    hosts: [/^(?:www\.|m\.|secure\.)?flickr\.com$/],
    shapes: [
      { name: 'photo', kind: 'photo', extractor: 'flickr:image', example: 'https://www.flickr.com/photos/some_one/53012345678/in/dateposted/', build: (parts) => (parts[0] === 'photos' && parts.length >= 3 && /^\d{5,}$/.test(parts[2]) ? `https://www.flickr.com/photos/${encName(parts[1])}/${parts[2]}/` : null) },
      { name: 'album', kind: 'collection', extractor: 'flickr:album', example: 'https://www.flickr.com/photos/some_one/albums/72177720300000000', build: (parts) => (parts[0] === 'photos' && parts.length === 4 && (parts[2] === 'albums' || parts[2] === 'sets') && /^\d{5,}$/.test(parts[3]) ? `https://www.flickr.com/photos/${encName(parts[1])}/albums/${parts[3]}` : null) },
      { name: 'gallery', kind: 'collection', extractor: 'flickr:gallery', example: 'https://www.flickr.com/photos/some_one/galleries/72157600000000000/', build: (parts) => (parts[0] === 'photos' && parts.length === 4 && parts[2] === 'galleries' && /^\d{5,}$/.test(parts[3]) ? `https://www.flickr.com/photos/${encName(parts[1])}/galleries/${parts[3]}/` : null) },
      { name: 'profile', kind: 'none', message: PROFILE('Flickr'), example: 'https://www.flickr.com/photos/some_one/', build: (parts) => (parts[0] === 'photos' && parts.length <= 2 ? 'profile' : null) },
    ],
    cdn: ['*.staticflickr.com'],
    options: { videos: false },
  },
  {
    id: 'flickr-short',
    label: 'Flickr',
    hosts: [/^flic\.kr$/],
    shapes: [{ name: 'short link', kind: 'photo', extractor: 'flickr:image', example: 'https://flic.kr/p/2abCdE', build: (parts) => (parts[0] === 'p' && parts.length === 2 && /^[A-Za-z1-9]{4,20}$/.test(parts[1]) ? `https://flic.kr/p/${parts[1]}` : null) }],
    cdn: ['*.staticflickr.com'],
    options: { videos: false },
  },
  {
    id: 'behance',
    label: 'Behance',
    hosts: [/^(?:www\.)?behance\.net$/],
    shapes: [
      { name: 'project', kind: 'collection', extractor: 'behance:gallery', example: 'https://www.behance.net/gallery/123456789/Minimal-Apartment', build: (parts) => (parts[0] === 'gallery' && parts.length >= 2 && /^\d{3,}$/.test(parts[1]) ? `https://www.behance.net/gallery/${parts[1]}` : null) },
      { name: 'moodboard', kind: 'none', message: 'That is a Behance collection of projects. Open one project and paste its address.', example: 'https://www.behance.net/collection/123456/Interiors', build: (parts) => ((parts[0] === 'collection' || parts[0] === 'moodboard') && parts.length >= 2 ? 'moodboard' : null) },
      { name: 'profile', kind: 'none', message: PROFILE('Behance'), example: 'https://www.behance.net/some_one', build: (parts) => (parts.length === 1 && !['gallery', 'search', 'collection', 'moodboard', 'joblist', 'galleries'].includes(parts[0].toLowerCase()) ? 'profile' : null) },
    ],
    cdn: ['*.behance.net'],
    // Pictures only: not the project's videos and embedded players.
    options: { modules: ['image', 'mediacollection'] },
  },
  {
    id: 'imgur',
    label: 'Imgur',
    hosts: [/^(?:www\.|m\.)?imgur\.(?:com|io)$/],
    shapes: [
      { name: 'album', kind: 'collection', extractor: 'imgur:album', example: 'https://imgur.com/a/AbCdEfG', build: (parts) => (parts[0] === 'a' && parts.length === 2 && /^(?:[A-Za-z0-9_]+-)?[A-Za-z0-9]{5,7}$/.test(parts[1]) ? `https://imgur.com/a/${parts[1]}` : null) },
      { name: 'gallery post', kind: 'collection', extractor: 'imgur:gallery', example: 'https://imgur.com/gallery/AbCdEfG', build: (parts) => (parts[0] === 'gallery' && parts.length === 2 && /^(?:[A-Za-z0-9_]+-)?[A-Za-z0-9]{5,7}$/.test(parts[1]) ? `https://imgur.com/gallery/${parts[1]}` : null) },
      { name: 'picture', kind: 'photo', extractor: 'imgur:image', example: 'https://imgur.com/AbCdEfG', build: (parts) => (parts.length === 1 && /^[A-Za-z0-9]{7}$/.test(parts[0]) && !['gallery', 'search'].includes(parts[0]) ? `https://imgur.com/${parts[0]}` : null) },
    ],
    cdn: ['i.imgur.com'],
    // Keep animated pictures as pictures (a GIF), not as video files.
    options: { mp4: false },
  },
  {
    id: 'wikimedia',
    label: 'Wikimedia Commons',
    loose: true,
    firstOnly: true, // gallery-dl lists the file's older versions after the current one
    hosts: [/^commons\.wikimedia\.org$/],
    shapes: [{ name: 'file', kind: 'photo', extractor: 'wikimediacommons:file', example: 'https://commons.wikimedia.org/wiki/File:Example.jpg', build: (parts) => (parts[0] === 'wiki' && parts.length === 2 && /^File:.{1,200}$/.test(parts[1]) ? `https://commons.wikimedia.org/wiki/${enc(parts[1]).replace(/%3A/i, ':')}` : null) }],
    cdn: ['upload.wikimedia.org'],
    options: {},
  },
];

/** Sites that show nothing without signing in. We do not sign in for anyone: the message sends them to upload the picture. */
export const LOGIN_SITES = [
  { id: 'instagram', label: 'Instagram', hosts: [/^(?:www\.)?instagram\.com$/, /^instagr\.am$/] },
  { id: 'facebook', label: 'Facebook', hosts: [/^(?:[a-z0-9-]+\.)?facebook\.com$/, /^fb\.(?:com|watch)$/] },
  { id: 'x', label: 'X (Twitter)', hosts: [/^(?:www\.|mobile\.)?(?:twitter|x)\.com$/] },
];

export const LOGIN_MESSAGE = (label) => `${label} only shows its pictures to people who are signed in, so we cannot fetch this one for you. Save the picture to your phone or computer and upload it here instead.`;

/** "*.pinimg.com" or "images.unsplash.com" -> a test for a host name. */
export function hostMatcher(patterns) {
  const tests = patterns.map((p) => {
    const text = p.toLowerCase();
    if (text.startsWith('*.')) {
      const tail = text.slice(1); // ".pinimg.com"
      return (host) => host.length > tail.length && host.endsWith(tail);
    }
    return (host) => host === text;
  });
  return (host) => tests.some((t) => t(String(host ?? '').toLowerCase()));
}

const cdnTests = new Map(SOURCES.map((s) => [s.id, hostMatcher(s.cdn)]));

/** A source by id. */
export function sourceById(id) {
  return SOURCES.find((s) => s.id === id) ?? null;
}

/** Every host pattern pictures may be served from ("*.pinimg.com"), for a page's Content-Security-Policy. */
export function allCdnHosts() {
  return [...new Set(SOURCES.flatMap((s) => s.cdn))];
}

/** Whether `host` is a place the source's pictures are served from. */
export function isCdnOf(sourceId, host) {
  return cdnTests.get(sourceId)?.(host) ?? false;
}

/** Every address in some text, in order. Trailing punctuation that belongs to the sentence, not the address, is dropped. */
export function findAddresses(text) {
  const out = [];
  const raw = String(text ?? '');
  for (const m of raw.matchAll(/https?:\/\/[^\s<>"`]+/gi)) {
    let address = m[0].replace(/[.,;:!?)\]}>'"]+$/, '');
    if (address.length > MAX_ADDRESS) address = address.slice(0, MAX_ADDRESS);
    out.push(address);
  }
  if (!out.length) {
    // "www.pinterest.com/pin/123" or "pin.it/abc" with no https:// in front, but only when that is all that was pasted
    const bare = raw.trim();
    if (bare && !/\s/.test(bare) && bare.length <= MAX_ADDRESS && /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?\/\S+$/i.test(bare)) out.push(`https://${bare.replace(/[.,;:!?)\]}>'"]+$/, '')}`);
  }
  return out;
}

/**
 * What one address is. Returns null when it is not something we can act on at all (not http(s), has a sign-in, a port, an IP address).
 * @param {string} address
 * @returns {null | {type: 'source' | 'direct' | 'page' | 'login' | 'unsupported', kind: 'photo' | 'collection' | 'none', url: string, host: string, source?: {id: string, label: string}, shape?: string, extractor?: string, message?: string}}
 */
export function classify(address) {
  let url;
  try {
    url = new URL(String(address ?? '').trim());
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.href.length > MAX_ADDRESS) return null;
  if (url.port && url.port !== '443' && url.port !== '80') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // an IP address or an internal name is never something to import from
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || /\.(?:local|localhost|internal|lan|home|corp|intranet|arpa)$/.test(host)) return null;

  for (const login of LOGIN_SITES) {
    if (login.hosts.some((re) => re.test(host))) return { type: 'login', kind: 'none', url: url.href, host, source: { id: login.id, label: login.label }, message: LOGIN_MESSAGE(login.label) };
  }
  for (const source of SOURCES) {
    if (!source.hosts.some((re) => re.test(host))) continue;
    const parts = partsOf(url.pathname, source.loose);
    if (parts) {
      for (const shape of source.shapes) {
        const built = shape.build(parts, url);
        if (!built) continue;
        const info = { source: { id: source.id, label: source.label }, shape: shape.name, host };
        if (shape.kind === 'none') return { type: 'unsupported', kind: 'none', url: url.href, message: shape.message, ...info };
        return { type: 'source', kind: shape.kind, url: built, extractor: shape.extractor, follows: shape.follows ?? [], ...info };
      }
    }
    // a known site, but not an address of a picture or collection we know how to read. Not the page's "main picture": on these
    // sites that would be an unrelated image.
    if (PICTURE_ENDING.test(url.pathname)) break;
    return { type: 'unsupported', kind: 'none', url: url.href, host, source: { id: source.id, label: source.label }, message: `That ${source.label} address is not a single picture or a collection we can read. Paste the address of a photo, a pin or a board.` };
  }
  if (PICTURE_ENDING.test(url.pathname)) {
    url.protocol = 'https:';
    url.port = '';
    url.hash = '';
    return { type: 'direct', kind: 'photo', url: url.href, host };
  }
  url.protocol = 'https:';
  url.port = '';
  url.hash = '';
  return { type: 'page', kind: 'photo', url: url.href, host };
}

/**
 * The first address in `text` that is worth acting on.
 * @param {string} text what was pasted or typed
 * @param {{ownHost?: string}} [options] `ownHost`: this site's own host name, whose addresses are never imported
 */
export function detect(text, { ownHost } = {}) {
  for (const address of findAddresses(text)) {
    const found = classify(address);
    if (!found) continue;
    if (ownHost && found.host === String(ownHost).toLowerCase().replace(/:\d+$/, '')) continue;
    return found;
  }
  return null;
}

/** The sites we read for people, for the dedicated page: [{id, label, kinds}] with the Pinterest and Flickr short-link entries folded in. */
export function supportedSites() {
  const byLabel = new Map();
  for (const source of SOURCES) {
    const entry = byLabel.get(source.label) ?? { id: source.id, label: source.label, kinds: new Set() };
    for (const shape of source.shapes) if (shape.kind !== 'none') entry.kinds.add(shape.kind);
    byLabel.set(source.label, entry);
  }
  return [...byLabel.values()].map((e) => ({ id: e.id, label: e.label, kinds: [...e.kinds] }));
}

/** A short phrase for what an address is, for the question "Do you want to import ...?" */
export function describeFound(found) {
  if (!found) return '';
  const label = found.source?.label;
  if (found.type === 'source') {
    if (found.kind === 'collection') {
      const noun = `${label} ${found.shape}`;
      return `${/^[AEIOU]/i.test(noun) ? 'an' : 'a'} ${noun}`;
    }
    return `a photo from ${label}`;
  }
  if (found.type === 'direct') return `a photo from ${found.host.replace(/^www\./, '')}`;
  if (found.type === 'page') return `the main picture of a page on ${found.host.replace(/^www\./, '')}`;
  return '';
}
