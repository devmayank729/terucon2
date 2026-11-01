/**
 * Suggesting a firm name for a business e-mail address.
 *
 *   off      never suggest anything
 *   domain   guess from the domain only:  priya@ab-constructions.co.in  ->  "Ab Constructions"
 *   website  also read the name the firm gives itself (its home page's title / site-name), which is usually better than the guess
 *
 * Reading a website on behalf of a visitor is the dangerous part: the visitor chooses the address, so a careless version lets
 * them make the server fetch internal addresses (cloud metadata, the database, the admin pages): server-side request forgery.
 * So this is deliberately narrow:
 *   - only https, only port 443, only the e-mail's own domain (or its www. twin) and at most two redirects within that domain;
 *   - the name is resolved ONCE, inside the connection itself (a custom `lookup`), and refused unless every address it
 *     resolves to is a public one, so there is no gap between "checked" and "connected" for a changing DNS answer to slip
 *     through (DNS rebinding). Loopback, private, link-local (including the 169.254.169.254 metadata address), carrier-grade NAT,
 *     multicast, reserved and documentation ranges are refused, in IPv6 and IPv4-mapped forms too;
 *   - 4 seconds in total, 128 KB read at most, HTML only, no cookies sent, nothing it receives is ever followed or executed;
 *   - answers (and failures) are remembered, so the same domain is not fetched again and again;
 *   - it is only called for someone who has already proved an e-mail address or phone number with a code, and it is rate limited.
 * What comes back is a few words of text that are cleaned like anything typed, offered as a suggestion, and shown with
 * textContent: never as markup.
 */
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { cleanFirm, firmFromDomain, squash } from './identifiers.js';

const MAX_BYTES = 128 * 1024;
const TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 2;
const CACHE_MS = 24 * 60 * 60 * 1000;
const FAIL_CACHE_MS = 60 * 60 * 1000;
const CACHE_MAX = 1000;

const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:2::', 48], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked.addSubnet(net6, prefix, 'ipv6');

/** Whether a resolved address is one the open internet owns. Anything it cannot read is not public. */
export function isPublicAddress(address) {
  if (typeof address !== 'string') return false;
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 4) return !blocked.check(address, 'ipv4');
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:7f00:1): judge the IPv4 inside
  const mapped = /^(?:0{0,4}:){0,4}:?ffff:(.+)$/i.exec(address) ?? /^::ffff:(.+)$/i.exec(address);
  if (mapped) {
    const rest = mapped[1];
    if (net.isIPv4(rest)) return !blocked.check(rest, 'ipv4');
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return !blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
    }
    return false;
  }
  return !blocked.check(address, 'ipv6');
}

/** A `lookup` for http(s) agents that only ever hands back public addresses. */
export function safeLookup({ resolve = dns.lookup, isPublic = isPublicAddress } = {}) {
  return (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const all = typeof options === 'object' && options?.all;
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return done(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      if (!list.length || !list.every((a) => isPublic(a.address))) {
        const refused = new Error(`blocked: ${hostname} does not resolve to a public address`);
        refused.code = 'EBLOCKED';
        return done(refused);
      }
      return all ? done(null, list) : done(null, list[0].address, list[0].family);
    });
  };
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const decode = (text) => text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m]).replace(/&#(\d{1,5});/g, (_, n) => (Number(n) < 0xd800 ? String.fromCodePoint(Number(n)) : ' '));
const stripTags = (text) => decode(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The names a page gives itself, best first: site name, application name, then the pieces of its title. */
export function namesFromHtml(html) {
  const head = html.slice(0, MAX_BYTES);
  const meta = (attr, value) => {
    const tag = new RegExp(`<meta\\s[^>]*${attr}\\s*=\\s*["']${value}["'][^>]*>`, 'i').exec(head)?.[0];
    const content = tag && /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    return content ? stripTags(content[1] ?? content[2]) : null;
  };
  const found = [meta('property', 'og:site_name'), meta('name', 'application-name')];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  if (title) {
    const whole = stripTags(title);
    found.push(...whole.split(/\s+[|–—·»-]\s+|\s*[|·»]\s*|:\s+/u));
    found.push(whole);
  }
  return found.filter(Boolean);
}

/**
 * Choose the name that looks like the firm: one that contains the domain's own word ("terucon" in "Terucon India Private Limited"),
 * the shortest such; else the site name if there is one; else nothing (the caller falls back to the guess from the domain).
 */
export function pickFirmName(candidates, domain) {
  const label = squash(firmFromDomain(domain) ?? '');
  const cleaned = candidates.map((c) => cleanFirm(c)).filter(Boolean);
  if (label.length >= 3) {
    const matching = cleaned.filter((c) => squash(c).includes(label)).sort((a, b) => a.length - b.length);
    if (matching[0]) return matching[0];
  }
  return null;
}

function fetchPage({ host, path = '/', agent, port = 443, timeoutMs = TIMEOUT_MS, request = https.request }) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = request(
      { host, port, path, method: 'GET', agent, servername: host, headers: { Host: host, 'User-Agent': 'TeruconFirmLookup/1.0 (+one request for the name of a firm)', Accept: 'text/html', 'Accept-Encoding': 'identity', Connection: 'close' } },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return done(resolve, { redirect: res.headers.location ?? null });
        }
        if (res.statusCode !== 200 || !/\btext\/html\b/i.test(res.headers['content-type'] ?? '')) {
          res.resume();
          return done(reject, new Error(`not a page (${res.statusCode})`));
        }
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          chunks.push(chunk);
          if (size >= MAX_BYTES) {
            req.destroy();
            done(resolve, { html: Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8') });
          }
        });
        res.on('end', () => done(resolve, { html: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (error) => done(reject, error));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new Error('timeout'));
    }, timeoutMs);
    req.on('error', (error) => done(reject, error));
    req.end();
  });
}

/**
 * @param {object} [options]
 * @param {typeof dns.lookup} [options.resolve] DNS (tests replace it)
 * @param {(address: string) => boolean} [options.isPublic] (tests may allow loopback to reach a local test server)
 * @param {object} [options.agentOptions] extra https.Agent options (tests trust their own certificate)
 * @param {number} [options.port] 443; only tests change it
 * @param {number} [options.timeoutMs] 4000; only tests change it
 * @param {() => number} [options.now]
 */
export function createFirmLookup({ resolve, isPublic, agentOptions = {}, port = 443, timeoutMs = TIMEOUT_MS, now = Date.now } = {}) {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 4, lookup: safeLookup({ resolve, isPublic }), ...agentOptions });
  const cache = new Map();

  async function readSite(domain) {
    let host = domain;
    let path = '/';
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const result = await fetchPage({ host, path, agent, port, timeoutMs });
      if (result.html) return result.html;
      if (!result.redirect) return null;
      let target;
      try {
        target = new URL(result.redirect, `https://${host}${path}`);
      } catch {
        return null;
      }
      // only on to the same site: the domain itself or its www. twin, over https
      const same = target.hostname === domain || target.hostname === `www.${domain}` || `www.${target.hostname}` === domain;
      if (target.protocol !== 'https:' || !same || (target.port && target.port !== '443') || target.username || target.password) return null;
      host = target.hostname;
      path = `${target.pathname}${target.search}`.slice(0, 300) || '/';
    }
    return null;
  }

  /**
   * @param {string} domain the e-mail's domain (lower-case ASCII, already checked by normalizeEmail)
   * @param {'off' | 'domain' | 'website'} mode
   * @param {string[]} [blockedDomains] domains the admin has banned (never suggested)
   * @returns {Promise<{name: string | null, source: 'website' | 'domain' | null}>}
   */
  async function suggest(domain, mode, blockedDomains = []) {
    const guess = mode === 'off' ? null : firmFromDomain(domain, blockedDomains);
    if (mode === 'off' || !guess) return { name: null, source: null };
    if (mode === 'domain') return { name: guess, source: 'domain' };

    const cached = cache.get(domain);
    if (cached && cached.until > now()) return cached.value;
    let value = { name: guess, source: 'domain' };
    try {
      const html = (await readSite(domain)) ?? (await readSite(`www.${domain}`).catch(() => null));
      const picked = html ? pickFirmName(namesFromHtml(html), domain) : null;
      if (picked) value = { name: picked, source: 'website' };
    } catch {
      // the site is down, slow, refused, or not ours to read: the guess from the domain stands
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(domain, { value, until: now() + (value.source === 'website' ? CACHE_MS : FAIL_CACHE_MS) });
    return value;
  }

  return { suggest, close: () => agent.destroy() };
}
