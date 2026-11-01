/**
 * The picture a web page names for itself, for an address that is not on a site we have a profile for (a designer's portfolio, a
 * magazine article, a shop page). The page states its main picture so that links to it can show a preview: `og:image` (Open
 * Graph), `twitter:image`, a `<link rel="image_src">`, or the `image` of its JSON-LD data. That is all this reads; it does not
 * guess from the page's other pictures. It is the page's chosen picture, usually a good one and not always the full-size one, which is why
 * the answer is marked approximate and the person can still crop or pick another.
 *
 * Nothing here fetches anything. The page text comes in, candidate addresses go out (absolute, https, at most MAX), and each
 * is fetched later through safeFetch like any other address.
 */

const MAX_CANDIDATES = 6;
const MAX_JSON_LD = 120_000;

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&#x2f;': '/', '&#47;': '/', '&nbsp;': ' ' };
const decode = (text) => String(text).replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#x2f|#47);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m).replace(/&#(\d{1,5});/g, (_, n) => (Number(n) < 0xd800 ? String.fromCodePoint(Number(n)) : ' '));

/** The value of one attribute of one tag, or null. Handles "double", 'single' and unquoted values. */
function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3]).trim() : null;
}

function* tags(html, name) {
  for (const m of html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))) yield m[0];
}

/** Every `image` value in a JSON-LD value: a string, a list, or an object with `url`, anywhere inside (depth-limited). */
function ldImages(value, out, depth = 0) {
  if (depth > 6 || out.length >= MAX_CANDIDATES) return;
  if (Array.isArray(value)) return value.forEach((v) => ldImages(v, out, depth + 1));
  if (!value || typeof value !== 'object') return;
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'image' || key === 'thumbnailUrl') {
      const items = Array.isArray(inner) ? inner : [inner];
      for (const item of items) {
        if (typeof item === 'string') out.push(item);
        else if (item && typeof item === 'object' && typeof item.url === 'string') out.push(item.url);
      }
    } else if (key === '@graph' || typeof inner === 'object') ldImages(inner, out, depth + 1);
  }
}

/** Make one address absolute against the page and keep it only if it is https (http is upgraded: browsers do the same). */
function absolute(text, base) {
  if (!text || /^(?:data|blob|javascript|file):/i.test(text.trim())) return null;
  try {
    const url = new URL(text.trim(), base);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2000) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

const IMAGE_META = ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'];

/**
 * @param {string} html the page (the start of it is enough; the caller limits how much is read)
 * @param {string} pageUrl the address the page was finally fetched from, for relative addresses
 * @returns {{title: string, images: string[]}}
 */
export function pageImages(html, pageUrl) {
  const text = String(html ?? '');
  const found = [];
  const meta = new Map();
  for (const tag of tags(text, 'meta')) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase();
    const content = attr(tag, 'content');
    if (key && content && !meta.has(key)) meta.set(key, content);
    if (IMAGE_META.includes(key) && content) found.push([IMAGE_META.indexOf(key), content]);
  }
  for (const tag of tags(text, 'link')) {
    if (/\bimage_src\b/i.test(attr(tag, 'rel') ?? '')) {
      const href = attr(tag, 'href');
      if (href) found.push([IMAGE_META.length, href]);
    }
  }
  const ld = [];
  for (const m of text.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (m[1].length > MAX_JSON_LD) continue;
    try {
      ldImages(JSON.parse(m[1].trim()), ld);
    } catch {
      // not valid JSON: skip this block
    }
  }
  for (const address of ld) found.push([IMAGE_META.length + 1, address]);

  // the page's own Open Graph picture first, then Twitter's, then the rest; each address once
  const images = [];
  for (const [, address] of found.sort((a, b) => a[0] - b[0])) {
    const abs = absolute(address, pageUrl);
    if (abs && !images.includes(abs)) images.push(abs);
    if (images.length >= MAX_CANDIDATES) break;
  }
  const rawTitle = meta.get('og:title') ?? meta.get('twitter:title') ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? '';
  const title = decode(rawTitle.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 140);
  return { title, images };
}
