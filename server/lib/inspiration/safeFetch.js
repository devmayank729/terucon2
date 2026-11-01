/**
 * Fetching an address a visitor chose, without letting them reach anything of ours.
 *
 * The visitor picks the address, so a careless fetch lets them make the server open internal addresses (the cloud metadata
 * address, the database, the admin pages): server-side request forgery. The rules, all of them checked here and none left to the
 * caller (the same defences as the firm look-up, server/auth/firm.js, whose address checks this uses):
 *   - https only, port 443 only, no user:password in the address, and a real host name: an IP address, "localhost" and internal
 *     names are refused before anything is looked up;
 *   - the name is resolved ONCE, inside the connection itself (safeLookup), and refused unless every address is a public one, so
 *     there is no gap between "checked" and "connected" for a changing DNS answer to slip through (DNS rebinding);
 *   - a redirect is followed by hand, at most MAX_REDIRECTS times, and every hop goes through all the rules again (a public
 *     address that redirects to an internal one is stopped at the second hop);
 *   - nothing is read past the byte limit and nothing is read slower than the time limit; compression is not asked for;
 *   - no cookies and no credentials are sent, and we say who we are: the user agent names this program honestly.
 * What comes back is bytes and a type. The caller decides what it is (imageBytes.js looks at the bytes themselves).
 */
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { isPublicAddress, safeLookup } from '../../auth/firm.js';

export const MAX_REDIRECTS = 3;
export const USER_AGENT = 'TeruconInspirationImport/1.0 (fetches one picture a signed-in visitor asked for)';

/** A fetch that failed, with a short code for the caller to turn into words. */
export class FetchError extends Error {
  constructor(code, message, status) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }
}

const INTERNAL_NAME = /(?:^|\.)(?:localhost|local|internal|lan|home|corp|intranet|home\.arpa)$/;

/** The address as a URL we are willing to connect to, or a FetchError('bad-address' | 'blocked'). */
export function checkTarget(text, { port = 443 } = {}) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new FetchError('bad-address', 'That is not a web address.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new FetchError('bad-address', 'Only https addresses without a sign-in are read.');
  if (url.port && Number(url.port) !== port) throw new FetchError('bad-address', 'Only the standard web port is read.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.startsWith('[') || net.isIP(host) || INTERNAL_NAME.test(host)) throw new FetchError('blocked', 'That address is not a public website.');
  return url;
}

/**
 * @param {object} [options]
 * @param {typeof dns.lookup} [options.resolve] DNS (tests replace it)
 * @param {(address: string) => boolean} [options.isPublic] (tests may allow loopback to reach a local test server)
 * @param {object} [options.agentOptions] extra https.Agent options (tests trust their own certificate)
 * @param {number} [options.port] 443; only tests change it
 * @param {number} [options.timeoutMs] the whole request, 15 s
 * @param {typeof https.request} [options.request] tests
 */
export function createSafeFetch({ resolve = dns.lookup, isPublic = isPublicAddress, agentOptions = {}, port = 443, timeoutMs = 15000, request = https.request } = {}) {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 6, lookup: safeLookup({ resolve, isPublic }), ...agentOptions });

  /** One request, no redirects followed. */
  function once(url, { accept, maxBytes }) {
    return new Promise((resolveOnce, reject) => {
      let finished = false;
      const done = (fn, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        fn(value);
      };
      const req = request(
        {
          host: url.hostname,
          port,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          agent,
          servername: url.hostname,
          headers: { Host: url.host, 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Encoding': 'identity', Connection: 'close' },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            res.resume();
            return done(resolveOnce, { redirect: res.headers.location ?? null });
          }
          if (status !== 200) {
            res.resume();
            return done(reject, new FetchError('status', `The site answered ${status}.`, status));
          }
          const contentType = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          const limit = maxBytes(contentType);
          if (limit <= 0) {
            res.resume();
            return done(reject, new FetchError('type', 'That is not a picture or a web page.'));
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > limit) {
            req.destroy();
            return done(reject, new FetchError('too-big', 'That file is too big.'));
          }
          let size = 0;
          const chunks = [];
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
              req.destroy();
              return done(reject, new FetchError('too-big', 'That file is too big.'));
            }
            chunks.push(chunk);
          });
          res.on('end', () => done(resolveOnce, { body: Buffer.concat(chunks), contentType }));
          res.on('error', (error) => done(reject, new FetchError('network', error.message)));
          res.on('aborted', () => done(reject, new FetchError('network', 'The connection dropped.')));
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        done(reject, new FetchError('timeout', 'The site took too long to answer.'));
      }, timeoutMs);
      req.on('error', (error) => done(reject, error.code === 'EBLOCKED' ? new FetchError('blocked', 'That address is not a public website.') : new FetchError('network', error.message)));
      req.end();
    });
  }

  return {
    /**
     * @param {string} address
     * @param {object} options
     * @param {string} options.accept the Accept header
     * @param {(contentType: string) => number} options.maxBytes the most to read for a content type; 0 or less refuses that type
     * @returns {Promise<{body: Buffer, contentType: string, finalUrl: string}>}
     */
    async get(address, { accept, maxBytes }) {
      let url = checkTarget(address, { port });
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const result = await once(url, { accept, maxBytes });
        if (!result.redirect) return { body: result.body, contentType: result.contentType, finalUrl: url.href };
        if (hop === MAX_REDIRECTS) break;
        let next;
        try {
          next = new URL(result.redirect, url);
        } catch {
          throw new FetchError('bad-address', 'The site sent us somewhere that is not an address.');
        }
        url = checkTarget(next.href, { port }); // the next hop goes through every rule again
      }
      throw new FetchError('redirects', 'The address sends us round in circles.');
    },
  };
}
