/**
 * The checks every request passes before any route sees it, in this order:
 *   1. Host: when the server listens on this machine only, refuse host names that are not ours (DNS rebinding).
 *   2. The SAM key, when SAM_SERVER_KEY is set, for /api/sam/*.
 *   3. For POST/PUT/PATCH/DELETE under /api/: the body must be JSON (decided before any body is read),
 *      and a browser Origin must be this site.
 */
import crypto from 'node:crypto';
import { sendError } from '../lib/errors.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const sha256 = (text) => crypto.createHash('sha256').update(text).digest();

/** Constant-time string comparison (hashing first makes the lengths equal). */
export function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

/** "localhost:8080" -> "localhost"; "[::1]:8080" -> "[::1]" */
function hostnameOf(host) {
  if (host.startsWith('[')) return host.split(']')[0] + ']';
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/** The "host:port" part of an Origin, lowercased; '' when there is none ("null", file://). */
function originNetloc(origin) {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(origin);
  return match ? match[1].toLowerCase() : '';
}

function isSamPath(rawPath) {
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // keep the raw path
  }
  return rawPath.startsWith('/api/sam/') || decoded.startsWith('/api/sam/');
}

/** @param {{settings: () => object}} ctx */
export function guards(ctx) {
  return (req, res, next) => {
    const s = ctx.settings();
    const host = (req.headers.host ?? '').toLowerCase();
    if (s.host !== '0.0.0.0' && s.host !== '::') {
      const hostname = hostnameOf(host);
      if (!LOCAL_HOSTS.has(hostname) && !s.allowedHosts.includes(hostname) && !s.allowedHosts.includes(host)) {
        return sendError(res, 421, 'Unexpected Host header.');
      }
    }
    const key = s.sam.serverKey;
    if (key && isSamPath(req.path)) {
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const sent = String(req.headers['x-api-key'] || bearer).trim();
      if (!safeEqual(sent, key)) return sendError(res, 401, 'This SAM server needs its key (SAM_SERVER_KEY).', 'UNAUTHENTICATED');
    }
    if (req.path.startsWith('/api/') && WRITE_METHODS.has(req.method)) {
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') return sendError(res, 415, 'Send application/json.');
      const origin = req.headers.origin;
      if (origin && originNetloc(origin) !== host) return sendError(res, 403, 'Cross-origin requests are not allowed.');
    }
    next();
  };
}
