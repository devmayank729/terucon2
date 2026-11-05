/**
 * What TeruBot knows about the website's pages (from site/site.json, through the SiteMap) and where it may send a visitor.
 *
 * A destination is only ever a route of the site map, written exactly as the map writes it, with at most a short query, or (for the
 * shop only) a hash the shop itself understands. Never an address, never a scheme, never a path of its own making. The same check runs
 * on what a tool produces and, again, on every action just before it leaves the server (actions.js).
 */

/** Documents that exist in the site map but are not for visitors: the project overview, the admin screen, the "Coming soon" page. */
export const NOT_FOR_VISITORS = new Set(['overview', 'catalogueAdmin', 'comingSoon']);

/** What is true about a page that its description in site.json does not say. Each line is a fact from the shop / dashboard code. */
const NOTES = {
  materials: "A preview of the shop: the prices, availability and delivery it shows are sample values, and an order placed there is not charged or dispatched yet.",
  dashboard: 'A prototype with a DEMO project (sample content). It is not the visitor\'s own project.',
  finder: 'Needs the real catalogue to be switched on; until it is, the page says so.',
  studio: 'The visitor needs to be signed in.',
};

/** The small query a destination may carry: letters, digits and the few marks a search needs. */
const QUERY = /^[A-Za-z0-9_.,~%+=&-]{0,120}$/;
/** The hashes the shop understands (pages_original/market_place.html: parseHash). */
const SHOP_HASH = /^#\/(?:(?:shop|saved|cart|compare|checkout)(?:\?[A-Za-z0-9_.,~%+=&-]{0,160})?|p\/[a-z0-9][a-z0-9-]{0,80}(?:\?v=[a-z0-9][a-z0-9-]{0,110})?|c\/[a-z0-9-]{1,40})$/;
const SHOP_ROUTE = '/materials';

/** @typedef {{key: string, kind: 'page' | 'doc', route: string, label: string, description: string, access: 'public' | 'signed-in'}} Destination */

/** The routes a visitor may be sent to: every page and document of the site map except the ones that are not for visitors. */
export function destinations(site) {
  /** @type {Map<string, Destination>} */
  const map = new Map();
  for (const p of Object.values(site.pages)) map.set(p.route, { key: p.key, kind: 'page', route: p.route, label: p.label, description: p.description, access: p.access });
  for (const d of Object.values(site.docs)) if (!NOT_FOR_VISITORS.has(d.key)) map.set(d.route, { key: d.key, kind: 'doc', route: d.route, label: d.label, description: d.description, access: d.access });
  return map;
}

/**
 * The visitor-facing view of the pages for the `site_guide` tool.
 * @param {*} site the SiteMap
 * @param {{route?: string}} [options] one page only
 */
export function siteGuide(site, { route } = {}) {
  const all = [...destinations(site).values()];
  const pages = all
    .filter((d) => !route || d.route === route)
    .map((d) => ({
      name: d.label,
      route: d.route,
      whatItDoes: d.description,
      whoCanOpenIt: d.access === 'signed-in' ? 'people who are signed in (others are asked to sign in first)' : 'everybody',
      ...(NOTES[d.key] ? { note: NOTES[d.key] } : {}),
    }));
  return pages;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Check a destination.
 * @param {unknown} to
 * @param {*} site the SiteMap
 * @param {{hasProduct?: (productId: string) => boolean}} [options] lets the shop hash name a product only if the product exists
 * @returns {{ok: true, to: string} | {ok: false, error: string}}
 */
export function checkDestination(to, site, { hasProduct = () => true } = {}) {
  if (typeof to !== 'string') return { ok: false, error: 'to must be a route of the site, for example /materials.' };
  if (to.length > 300 || CONTROL.test(to) || /\s/.test(to)) return { ok: false, error: 'That is not a route of this site.' };
  if (!to.startsWith('/') || to.startsWith('//') || to.includes('\\')) return { ok: false, error: 'That is not a route of this site.' };
  const hashAt = to.indexOf('#');
  const beforeHash = hashAt === -1 ? to : to.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : to.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  const route = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? '' : beforeHash.slice(queryAt + 1);
  const known = destinations(site).get(route);
  if (!known) return { ok: false, error: `${route.slice(0, 60)} is not a page of this site. Use site_guide to see the pages.` };
  if (query) {
    if (hash) return { ok: false, error: 'Use either a query or a hash, not both.' };
    if (!QUERY.test(query)) return { ok: false, error: 'The query has characters that are not allowed.' };
    try {
      const decoded = decodeURIComponent(query.replace(/\+/g, ' '));
      if (CONTROL.test(decoded) || /[<>"'`\\]/.test(decoded)) return { ok: false, error: 'The query has characters that are not allowed.' };
    } catch {
      return { ok: false, error: 'The query is not valid.' };
    }
  }
  if (hash) {
    if (route !== SHOP_ROUTE || !SHOP_HASH.test(hash)) return { ok: false, error: 'Only the materials page takes a hash, in the forms #/shop?q=word, #/p/<product>?v=<variant>, #/saved, #/cart and #/compare.' };
    const product = /^#\/p\/([a-z0-9-]+)/.exec(hash)?.[1];
    if (product && !hasProduct(product)) return { ok: false, error: 'That product is not in the shop.' };
    try {
      if (CONTROL.test(decodeURIComponent(hash.replace(/\+/g, ' '))) || /[<>"'`\\]/.test(decodeURIComponent(hash.replace(/\+/g, ' ')))) return { ok: false, error: 'The hash has characters that are not allowed.' };
    } catch {
      return { ok: false, error: 'The hash is not valid.' };
    }
  }
  return { ok: true, to: `${route}${query ? `?${query}` : ''}${hash}` };
}

export const SHOP = SHOP_ROUTE;
